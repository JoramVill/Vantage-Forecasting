/**
 * WindShearModel - Wind Shear Power Law Extrapolation for Hub Height Correction
 *
 * Applies wind shear correction to extrapolate wind speed from reference height
 * (typically 10m from weather API) to hub height (80-100m for wind turbines)
 * before applying MREC conversion.
 *
 * Wind Shear Power Law:
 *   v_hub = v_ref × (h_hub / h_ref)^α
 *
 * Where:
 *   - v_ref = reference wind speed (typically 10m from weather API)
 *   - h_ref = reference height (default 10m)
 *   - h_hub = hub height (default 100m for modern wind turbines)
 *   - α = wind shear exponent (0.14 open terrain, 0.20 typical, 0.25 rough terrain)
 *
 * This model improves upon direct MREC by accounting for vertical wind speed
 * profile differences between measurement height and turbine hub height.
 */

import {
  MRECFactors,
  MRECCalibrationData,
  CFacWeatherFeatures,
  CFacTrainingSample,
  StationType,
} from '../../types/capacityFactor.js';
import { WindMRECModel } from './legacy/WindMRECModel.js';

/**
 * Wind shear configuration for a station
 */
export interface WindShearConfig {
  hubHeight: number;        // Hub height in meters (default: 100m)
  refHeight: number;        // Reference height in meters (default: 10m)
  shearExponent: number;    // Shear exponent α (default: 0.20)
}

/**
 * Default wind shear configurations by terrain type
 */
export const WIND_SHEAR_PRESETS = {
  OPEN_TERRAIN: { hubHeight: 100, refHeight: 10, shearExponent: 0.14 },    // Open water, coastal plains
  TYPICAL: { hubHeight: 100, refHeight: 10, shearExponent: 0.20 },         // Mixed terrain (default)
  ROUGH_TERRAIN: { hubHeight: 100, refHeight: 10, shearExponent: 0.25 },   // Forests, urban areas
} as const;

/**
 * Station-specific optimal shear configurations
 * Based on correlation analysis and terrain characteristics
 */
export const OPTIMAL_SHEAR_CONFIGS: Record<string, WindShearConfig> = {
  // Coastal/open terrain stations (lower shear exponent)
  '01BURGOS': { hubHeight: 100, refHeight: 10, shearExponent: 0.14 },       // Coastal Ilocos Norte
  '01PAGUDPUD': { hubHeight: 100, refHeight: 10, shearExponent: 0.14 },     // Coastal Ilocos Norte
  '08NABAS_W': { hubHeight: 100, refHeight: 10, shearExponent: 0.14 },      // Aklan coastal
  '08STBARBRA_W': { hubHeight: 80, refHeight: 10, shearExponent: 0.14 },    // Iloilo coastal (shorter towers)

  // Inland/mixed terrain stations (typical shear)
  '01LAOAG': { hubHeight: 100, refHeight: 10, shearExponent: 0.20 },        // Ilocos Norte inland
  '01CURIMAO': { hubHeight: 100, refHeight: 10, shearExponent: 0.20 },      // Ilocos Norte
  '01PASUQUIN': { hubHeight: 100, refHeight: 10, shearExponent: 0.20 },     // Ilocos Norte
};

/**
 * Training metrics for Wind Shear model
 */
export interface WindShearMetrics {
  stationCode: string;
  mrecOnlyMAPE: number;           // MREC with 10m wind speed
  shearCorrectedMAPE: number;     // MREC with shear-corrected wind speed
  improvement: number;             // Percentage improvement
  optimalHubHeight: number;        // Calibrated hub height
  optimalShearExponent: number;    // Calibrated shear exponent
  sampleCount: number;
}

export class WindShearModel {
  private stationCode: string;
  private mrecModel: WindMRECModel;
  private config: WindShearConfig;

  constructor(
    stationCode: string,
    config: WindShearConfig = WIND_SHEAR_PRESETS.TYPICAL
  ) {
    this.stationCode = stationCode;
    this.mrecModel = new WindMRECModel(stationCode);

    // Use station-specific config if available, otherwise use provided config
    this.config = OPTIMAL_SHEAR_CONFIGS[stationCode] || config;
  }

  /**
   * Get the station code
   */
  getStationCode(): string {
    return this.stationCode;
  }

  /**
   * Get current shear configuration
   */
  getConfig(): WindShearConfig {
    return { ...this.config };
  }

  /**
   * Set shear configuration
   */
  setConfig(config: Partial<WindShearConfig>): void {
    this.config = {
      ...this.config,
      ...config,
    };
  }

  /**
   * Load pre-calibrated MREC factors
   */
  loadMRECFactors(factors: MRECFactors): void {
    this.mrecModel.loadFactors(factors);
  }

  /**
   * Calibrate MREC base model from historical data
   *
   * NOTE: This calibrates MREC using shear-corrected wind speeds
   * so that MREC factors are tuned for hub-height winds.
   */
  calibrate(data: MRECCalibrationData[]): MRECFactors {
    // Apply shear correction to all wind speeds before calibrating MREC
    const correctedData = data.map(sample => ({
      ...sample,
      windSpeed: this.applyShearCorrection(sample.windSpeed),
    }));

    return this.mrecModel.calibrate(correctedData);
  }

  /**
   * Get MREC factors
   */
  getMRECFactors(): MRECFactors | null {
    return this.mrecModel.getFactors();
  }

  /**
   * Apply wind shear power law correction
   *
   * v_hub = v_ref × (h_hub / h_ref)^α
   *
   * @param refWindSpeed - Wind speed at reference height (m/s)
   * @returns Extrapolated wind speed at hub height (m/s)
   */
  private applyShearCorrection(refWindSpeed: number): number {
    const { hubHeight, refHeight, shearExponent } = this.config;

    // Avoid division by zero
    if (refHeight <= 0 || hubHeight <= 0) {
      return refWindSpeed;
    }

    // Apply power law
    const heightRatio = hubHeight / refHeight;
    const hubWindSpeed = refWindSpeed * Math.pow(heightRatio, shearExponent);

    return hubWindSpeed;
  }

  /**
   * Predict capacity factor using shear-corrected wind speed
   *
   * @param weather - Weather features (expects 10m wind speed)
   * @param _datetime - Not used (for interface compatibility)
   * @returns Predicted capacity factor [0, 1]
   */
  predict(weather: CFacWeatherFeatures, _datetime?: Date): number {
    // Get reference wind speed (10m standard)
    const refWindSpeed = weather.windSpeed;

    // Apply shear correction to extrapolate to hub height
    const hubWindSpeed = this.applyShearCorrection(refWindSpeed);

    // Use MREC model with corrected wind speed
    return this.mrecModel.predict(hubWindSpeed);
  }

  /**
   * Get MREC-only prediction (for comparison) without shear correction
   */
  predictMRECOnly(refWindSpeed: number): number {
    return this.mrecModel.predict(refWindSpeed);
  }

  /**
   * Get shear-corrected wind speed (for debugging/analysis)
   */
  getHubWindSpeed(refWindSpeed: number): number {
    return this.applyShearCorrection(refWindSpeed);
  }

  /**
   * Train/calibrate optimal shear parameters from historical data
   *
   * This method searches for optimal hub height and shear exponent
   * by minimizing prediction error against actual capacity factors.
   *
   * @param samples - Training samples with actual capacity factors
   * @returns Training metrics with optimal parameters
   */
  train(samples: CFacTrainingSample[]): WindShearMetrics {
    // Filter samples for this station
    const stationSamples = samples.filter(s => s.stationCode === this.stationCode);

    if (stationSamples.length < 50) {
      console.warn(`Insufficient samples for ${this.stationCode}: ${stationSamples.length}`);
      return {
        stationCode: this.stationCode,
        mrecOnlyMAPE: 0,
        shearCorrectedMAPE: 0,
        improvement: 0,
        optimalHubHeight: this.config.hubHeight,
        optimalShearExponent: this.config.shearExponent,
        sampleCount: stationSamples.length,
      };
    }

    // Evaluate baseline MREC-only (using 10m wind speed)
    let mrecErrorSum = 0;
    let validMrecCount = 0;

    for (const sample of stationSamples) {
      const mrecPred = this.mrecModel.predict(sample.weather.windSpeed);
      const actual = sample.actualCFac;

      if (actual > 0.01) {
        mrecErrorSum += Math.abs((mrecPred - actual) / actual);
        validMrecCount++;
      }
    }

    const mrecOnlyMAPE = validMrecCount > 0 ? (mrecErrorSum / validMrecCount) * 100 : 0;

    // Evaluate current shear-corrected model
    let shearErrorSum = 0;
    let validShearCount = 0;

    for (const sample of stationSamples) {
      const shearPred = this.predict(sample.weather);
      const actual = sample.actualCFac;

      if (actual > 0.01) {
        shearErrorSum += Math.abs((shearPred - actual) / actual);
        validShearCount++;
      }
    }

    const shearCorrectedMAPE = validShearCount > 0 ? (shearErrorSum / validShearCount) * 100 : 0;
    const improvement = mrecOnlyMAPE > 0 ? ((mrecOnlyMAPE - shearCorrectedMAPE) / mrecOnlyMAPE) * 100 : 0;

    return {
      stationCode: this.stationCode,
      mrecOnlyMAPE,
      shearCorrectedMAPE,
      improvement,
      optimalHubHeight: this.config.hubHeight,
      optimalShearExponent: this.config.shearExponent,
      sampleCount: stationSamples.length,
    };
  }

  /**
   * Auto-calibrate optimal shear parameters by grid search
   *
   * Searches across typical hub heights (60-120m) and shear exponents (0.1-0.3)
   * to find configuration that minimizes MAPE.
   *
   * @param samples - Training samples with actual capacity factors
   * @returns Best configuration and metrics
   */
  autoCalibrate(samples: CFacTrainingSample[]): WindShearMetrics {
    const stationSamples = samples.filter(s => s.stationCode === this.stationCode);

    if (stationSamples.length < 50) {
      return this.train(samples);
    }

    // Save original config
    const originalConfig = { ...this.config };

    // Grid search parameters
    const hubHeights = [60, 80, 100, 120];
    const shearExponents = [0.10, 0.14, 0.20, 0.25, 0.30];

    let bestMAPE = Infinity;
    let bestConfig = originalConfig;

    // Try all combinations
    for (const hubHeight of hubHeights) {
      for (const shearExponent of shearExponents) {
        this.config = { ...originalConfig, hubHeight, shearExponent };

        // Evaluate this configuration
        let errorSum = 0;
        let validCount = 0;

        for (const sample of stationSamples) {
          const pred = this.predict(sample.weather);
          const actual = sample.actualCFac;

          if (actual > 0.01) {
            errorSum += Math.abs((pred - actual) / actual);
            validCount++;
          }
        }

        const mape = validCount > 0 ? (errorSum / validCount) * 100 : Infinity;

        if (mape < bestMAPE) {
          bestMAPE = mape;
          bestConfig = { ...this.config };
        }
      }
    }

    // Set best configuration
    this.config = bestConfig;

    // Calculate final metrics
    return this.train(samples);
  }

  /**
   * Check if MREC is calibrated
   */
  isMRECCalibrated(): boolean {
    return this.mrecModel.isCalibrated();
  }

  /**
   * Serialize model for storage
   */
  toJSON(): string {
    return JSON.stringify({
      stationCode: this.stationCode,
      config: this.config,
      mrecFactors: this.mrecModel.getFactors(),
    });
  }

  /**
   * Load model from JSON
   */
  fromJSON(json: string): void {
    const data = JSON.parse(json);
    this.stationCode = data.stationCode;
    this.config = data.config;
    if (data.mrecFactors) {
      this.mrecModel.loadFactors(data.mrecFactors);
    }
  }
}

/**
 * Batch train Wind Shear models for all wind stations
 *
 * @param mrecFactors - Pre-calibrated MREC factors for all stations
 * @param samples - Training samples with actual capacity factors
 * @param autoCalibrate - If true, auto-calibrate shear parameters (slower)
 * @param progressCallback - Optional progress callback
 * @returns Map of station code to trained model
 */
export async function trainAllWindShear(
  mrecFactors: MRECFactors[],
  samples: CFacTrainingSample[],
  autoCalibrate: boolean = false,
  progressCallback?: (msg: string) => void
): Promise<Map<string, WindShearModel>> {
  const models = new Map<string, WindShearModel>();

  progressCallback?.(`Training Wind Shear models for ${mrecFactors.length} wind stations`);
  progressCallback?.(`Auto-calibration: ${autoCalibrate ? 'ENABLED (slower)' : 'DISABLED (using preset configs)'}`);

  let totalMrecMAPE = 0;
  let totalShearMAPE = 0;
  let stationCount = 0;

  for (let i = 0; i < mrecFactors.length; i++) {
    const factors = mrecFactors[i];
    progressCallback?.(`  [${i + 1}/${mrecFactors.length}] Training ${factors.stationCode}...`);

    const model = new WindShearModel(factors.stationCode);
    model.loadMRECFactors(factors);

    // Train or auto-calibrate
    const metrics = autoCalibrate
      ? model.autoCalibrate(samples)
      : model.train(samples);

    if (metrics.sampleCount >= 50) {
      totalMrecMAPE += metrics.mrecOnlyMAPE;
      totalShearMAPE += metrics.shearCorrectedMAPE;
      stationCount++;

      const config = model.getConfig();
      progressCallback?.(`    MREC (10m): ${metrics.mrecOnlyMAPE.toFixed(1)}% → Shear-Corrected: ${metrics.shearCorrectedMAPE.toFixed(1)}% (${metrics.improvement > 0 ? '+' : ''}${metrics.improvement.toFixed(1)}%)`);
      progressCallback?.(`    Config: hub=${config.hubHeight}m, α=${config.shearExponent.toFixed(2)}`);
    }

    models.set(factors.stationCode, model);
  }

  if (stationCount > 0) {
    const avgMrecMAPE = totalMrecMAPE / stationCount;
    const avgShearMAPE = totalShearMAPE / stationCount;
    const overallImprovement = ((avgMrecMAPE - avgShearMAPE) / avgMrecMAPE) * 100;

    progressCallback?.(`\nOverall Results (Wind Shear Model):`);
    progressCallback?.(`   MREC-only (10m) avg MAPE:    ${avgMrecMAPE.toFixed(1)}%`);
    progressCallback?.(`   Shear-Corrected avg MAPE:    ${avgShearMAPE.toFixed(1)}%`);
    progressCallback?.(`   Improvement:                 ${overallImprovement.toFixed(1)}%`);
  }

  return models;
}
