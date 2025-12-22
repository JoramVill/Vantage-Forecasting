/**
 * WindWeatherHybridModel - MREC base + Weather-Only ML residual
 *
 * Key Insight from Analysis:
 * - The original hybrid model overfit because of TEMPORAL features (month encoding)
 * - Month encoding memorizes Jul-Oct patterns that don't transfer to Nov-Dec
 * - Solution: Use ONLY weather-based features for ML residual correction
 *
 * Architecture:
 * 1. MREC provides robust three-tier base prediction (calibrated from data)
 * 2. ML learns residual correction from WEATHER features only:
 *    - Gust ratio (turbulence indicator)
 *    - Temperature deviation (air density proxy)
 *    - Wind direction stability (if available)
 *    - Atmospheric pressure deviation (if available)
 *
 * This avoids overfitting to seasonal patterns while still allowing
 * ML to capture weather-specific corrections.
 */

import MultivariateLinearRegression from 'ml-regression-multivariate-linear';
import {
  MRECFactors,
  MRECCalibrationData,
  CFacWeatherFeatures,
  CFacTrainingSample,
} from '../../types/capacityFactor.js';
import { WindMRECModel } from './WindMRECModel.js';
import { CFacXGBoostRegressor } from './CFacXGBoostRegressor.js';

/**
 * Optimal wind height configuration per station
 * Based on correlation analysis between wind speeds at different heights
 * and actual capacity factor data.
 *
 * Analysis Date: 2025-12-11
 * Data Period: Jul-Dec 2025
 */
export const OPTIMAL_WIND_HEIGHTS: Record<string, { height: '10m' | '50m' | '80m' | '100m'; correlation: number }> = {
  '01BURGOS': { height: '50m', correlation: 0.6415 },
  '01CURIMAO': { height: '10m', correlation: 0.0846 },  // Poor correlation at all heights
  '01LAOAG': { height: '10m', correlation: 0.3511 },
  '01PAGUDPUD': { height: '50m', correlation: 0.6075 },
  '01PASUQUIN': { height: '10m', correlation: 0.0701 },  // Poor correlation at all heights
  '08NABAS_W': { height: '100m', correlation: 0.7282 },
  '08STBARBRA_W': { height: '10m', correlation: 0.7398 },
};

/**
 * Get the optimal wind speed for a station based on height correlation analysis
 */
export function getOptimalWindSpeed(stationCode: string, weather: CFacWeatherFeatures): number {
  const config = OPTIMAL_WIND_HEIGHTS[stationCode];

  if (!config) {
    // Default to 100m for unknown stations (hub height)
    return weather.windSpeed100 ?? weather.windSpeed80 ?? weather.windSpeed50 ?? weather.windSpeed;
  }

  switch (config.height) {
    case '100m':
      return weather.windSpeed100 ?? weather.windSpeed80 ?? weather.windSpeed50 ?? weather.windSpeed;
    case '80m':
      return weather.windSpeed80 ?? weather.windSpeed100 ?? weather.windSpeed50 ?? weather.windSpeed;
    case '50m':
      return weather.windSpeed50 ?? weather.windSpeed80 ?? weather.windSpeed100 ?? weather.windSpeed;
    case '10m':
    default:
      return weather.windSpeed;
  }
}

export interface WeatherHybridMetrics {
  stationCode: string;
  mrecOnlyMAPE: number;
  weatherHybridMAPE: number;
  improvement: number;
  residualR2: number;
  sampleCount: number;
}

export class WindWeatherHybridModel {
  private stationCode: string;
  private mrecModel: WindMRECModel;
  private residualModel: MultivariateLinearRegression | null = null;
  private xgboostModel: CFacXGBoostRegressor | null = null;
  private useXGBoost: boolean = false;

  // Feature names (for debugging/logging)
  private static readonly FEATURE_NAMES = [
    'mrec_base',        // What MREC predicts (anchor point)
    'tier_H',           // High tier indicator
    'tier_M',           // Mid tier indicator
    'gust_ratio',       // Turbulence: windGust / windSpeed
    'temp_deviation',   // (temp - 25) / 20 - air density proxy
    'wind_speed_norm',  // Normalized wind for interaction effects
    'cloud_cover',      // May correlate with atmospheric conditions
  ];

  constructor(stationCode: string, useXGBoost: boolean = false) {
    this.stationCode = stationCode;
    this.mrecModel = new WindMRECModel(stationCode);
    this.useXGBoost = useXGBoost;
  }

  /**
   * Get the station code
   */
  getStationCode(): string {
    return this.stationCode;
  }

  /**
   * Load pre-calibrated MREC factors
   */
  loadMRECFactors(factors: MRECFactors): void {
    this.mrecModel.loadFactors(factors);
  }

  /**
   * Calibrate MREC base model from historical data
   */
  calibrateMREC(data: MRECCalibrationData[]): MRECFactors {
    return this.mrecModel.calibrate(data);
  }

  /**
   * Get MREC factors
   */
  getMRECFactors(): MRECFactors | null {
    return this.mrecModel.getFactors();
  }

  /**
   * Determine which tier a wind speed falls into
   */
  private getTier(windSpeed: number): 'H' | 'M' | 'L' {
    const factors = this.mrecModel.getFactors();
    if (!factors) return 'L';

    if (windSpeed >= factors.vH) return 'H';
    if (windSpeed >= factors.vL) return 'M';
    return 'L';
  }

  /**
   * Get optimal wind speed for this station based on correlation analysis
   */
  private getOptimalWindSpeedForStation(weather: CFacWeatherFeatures): number {
    return getOptimalWindSpeed(this.stationCode, weather);
  }

  /**
   * Build WEATHER-ONLY feature vector for residual model
   *
   * NO temporal features (hour, month) - these cause overfitting!
   * Only features derived from actual weather conditions.
   */
  private buildWeatherFeatures(
    mrecBase: number,
    weather: CFacWeatherFeatures
  ): number[] {
    const windSpeed = this.getOptimalWindSpeedForStation(weather);
    const tier = this.getTier(windSpeed);

    // Gust ratio: indicates turbulence (affects power curve efficiency)
    const gustRatio = weather.windGust && windSpeed > 0.1
      ? Math.min(weather.windGust / windSpeed, 3)  // Cap at 3x
      : 1.0;

    // Temperature deviation from standard (25°C)
    // Cold air is denser → more power, hot air is less dense
    const tempDeviation = ((weather.temperature ?? 25) - 25) / 20;

    return [
      mrecBase,                                    // MREC prediction as anchor
      tier === 'H' ? 1 : 0,                       // High tier indicator
      tier === 'M' ? 1 : 0,                       // Mid tier indicator
      gustRatio,                                   // Turbulence indicator
      tempDeviation,                               // Air density proxy
      windSpeed / 30,                              // Normalized wind speed
      (weather.cloudCover ?? 50) / 100,           // Atmospheric conditions proxy
    ];
  }

  /**
   * Train the weather-only residual model
   *
   * @param samples - Training samples with actual capacity factors
   * @param asymmetricLoss - If true, penalize under-predictions more heavily
   * @returns Training metrics
   */
  trainResidual(samples: CFacTrainingSample[], asymmetricLoss: boolean = false): WeatherHybridMetrics {
    // Filter samples for this station
    const stationSamples = samples.filter(s => s.stationCode === this.stationCode);

    if (stationSamples.length < 50) {
      console.warn(`Insufficient samples for ${this.stationCode}: ${stationSamples.length}`);
      return {
        stationCode: this.stationCode,
        mrecOnlyMAPE: 0,
        weatherHybridMAPE: 0,
        improvement: 0,
        residualR2: 0,
        sampleCount: stationSamples.length,
      };
    }

    // Build training data
    const featureMatrix: number[][] = [];
    const residuals: number[] = [];
    let mrecErrorSum = 0;
    let validMrecCount = 0;

    for (const sample of stationSamples) {
      // Use optimal wind height for this station
      const windSpeed = this.getOptimalWindSpeedForStation(sample.weather);
      const mrecPred = this.mrecModel.predict(windSpeed);
      const actual = sample.actualCFac;
      const residual = actual - mrecPred;

      const features = this.buildWeatherFeatures(mrecPred, sample.weather);
      featureMatrix.push(features);
      residuals.push(residual);

      // Track MREC-only error
      if (actual > 0.01) {
        mrecErrorSum += Math.abs((mrecPred - actual) / actual);
        validMrecCount++;
      }
    }

    const mrecOnlyMAPE = validMrecCount > 0 ? (mrecErrorSum / validMrecCount) * 100 : 0;

    // Train residual model (XGBoost or Linear Regression)
    try {
      if (this.useXGBoost) {
        // Train XGBoost with asymmetric loss support
        this.xgboostModel = new CFacXGBoostRegressor({
          maxDepth: 4,             // Shallower trees to prevent overfitting
          learningRate: 0.05,      // Lower learning rate for stability
          nEstimators: 150,        // More trees with lower learning rate
          minChildWeight: 5,       // Larger minimum to prevent overfitting
          subsample: 0.8,          // Sample 80% of data per tree
          alpha: asymmetricLoss ? 0.65 : 0.5  // Asymmetric: penalize under-predictions more
        });
        this.xgboostModel.train(featureMatrix, residuals);
        this.residualModel = null;  // Clear linear model
      } else {
        // Train linear regression (original approach)
        // For asymmetric loss with linear regression, duplicate under-prediction samples
        if (asymmetricLoss) {
          const augmentedFeatures: number[][] = [];
          const augmentedResiduals: number[] = [];

          for (let i = 0; i < stationSamples.length; i++) {
            augmentedFeatures.push(featureMatrix[i]);
            augmentedResiduals.push(residuals[i]);

            // Duplicate samples with positive residuals (under-predictions)
            if (residuals[i] > 0 && stationSamples[i].actualCFac > 0.1) {
              augmentedFeatures.push([...featureMatrix[i]]);
              augmentedResiduals.push(residuals[i]);
            }
          }

          const residuals2D = augmentedResiduals.map(r => [r]);
          this.residualModel = new MultivariateLinearRegression(augmentedFeatures, residuals2D);
        } else {
          const residuals2D = residuals.map(r => [r]);
          this.residualModel = new MultivariateLinearRegression(featureMatrix, residuals2D);
        }
        this.xgboostModel = null;  // Clear XGBoost model
      }
    } catch (error: any) {
      console.warn(`Failed to train residual model for ${this.stationCode}: ${error.message}`);
      return {
        stationCode: this.stationCode,
        mrecOnlyMAPE,
        weatherHybridMAPE: mrecOnlyMAPE,
        improvement: 0,
        residualR2: 0,
        sampleCount: stationSamples.length,
      };
    }

    // Evaluate hybrid model
    let hybridErrorSum = 0;
    let validHybridCount = 0;
    let residualSS = 0;
    let totalSS = 0;
    const meanResidual = residuals.reduce((a, b) => a + b, 0) / residuals.length;

    for (let i = 0; i < stationSamples.length; i++) {
      const sample = stationSamples[i];
      // Use optimal wind height for this station
      const windSpeed = this.getOptimalWindSpeedForStation(sample.weather);
      const mrecPred = this.mrecModel.predict(windSpeed);
      const features = featureMatrix[i];

      // Predict residual (using XGBoost or Linear Regression)
      let predictedResidual: number;
      if (this.xgboostModel) {
        predictedResidual = this.xgboostModel.predict(features);
      } else {
        predictedResidual = this.residualModel!.predict([features])[0][0];
      }
      let hybridPred = mrecPred + predictedResidual;

      // High wind cutout (from iPool)
      if (hybridPred > 1.1) hybridPred = 0;
      hybridPred = Math.max(0, Math.min(1, hybridPred));

      const actual = sample.actualCFac;

      // Hybrid MAPE
      if (actual > 0.01) {
        hybridErrorSum += Math.abs((hybridPred - actual) / actual);
        validHybridCount++;
      }

      // R² calculation
      const actualResidual = residuals[i];
      residualSS += (actualResidual - predictedResidual) ** 2;
      totalSS += (actualResidual - meanResidual) ** 2;
    }

    const weatherHybridMAPE = validHybridCount > 0 ? (hybridErrorSum / validHybridCount) * 100 : 0;
    const residualR2 = totalSS > 0 ? 1 - (residualSS / totalSS) : 0;
    const improvement = mrecOnlyMAPE > 0 ? ((mrecOnlyMAPE - weatherHybridMAPE) / mrecOnlyMAPE) * 100 : 0;

    return {
      stationCode: this.stationCode,
      mrecOnlyMAPE,
      weatherHybridMAPE,
      improvement,
      residualR2,
      sampleCount: stationSamples.length,
    };
  }

  /**
   * Predict capacity factor using weather-only hybrid model
   *
   * @param weather - Weather features
   * @param _datetime - Not used (weather-only approach)
   * @returns Predicted capacity factor [0, 1]
   */
  predict(weather: CFacWeatherFeatures, _datetime?: Date): number {
    // Use optimal wind height for this station
    const windSpeed = this.getOptimalWindSpeedForStation(weather);

    // Get MREC base prediction
    const mrecBase = this.mrecModel.predict(windSpeed);

    // If no residual model, return MREC-only
    if (!this.residualModel && !this.xgboostModel) {
      return mrecBase;
    }

    // Build weather-only features and predict residual
    const features = this.buildWeatherFeatures(mrecBase, weather);

    let residual: number;
    if (this.xgboostModel) {
      residual = this.xgboostModel.predict(features);
    } else {
      residual = this.residualModel!.predict([features])[0][0];
    }

    // Combine
    let finalPred = mrecBase + residual;

    // High wind cutout (from iPool)
    if (finalPred > 1.1) {
      return 0;
    }

    // Clamp to valid range
    return Math.max(0, Math.min(1, finalPred));
  }

  /**
   * Get MREC-only prediction (for comparison)
   */
  predictMRECOnly(windSpeed: number): number {
    return this.mrecModel.predict(windSpeed);
  }

  /**
   * Check if hybrid model is trained
   */
  isHybridTrained(): boolean {
    return this.residualModel !== null || this.xgboostModel !== null;
  }

  /**
   * Check if MREC is calibrated
   */
  isMRECCalibrated(): boolean {
    return this.mrecModel.isCalibrated();
  }

  /**
   * Get feature importance info
   */
  getFeatureNames(): string[] {
    return WindWeatherHybridModel.FEATURE_NAMES;
  }
}

/**
 * Train Weather-Only Hybrid models for all wind stations
 */
export async function trainAllWeatherHybrid(
  mrecFactors: MRECFactors[],
  samples: CFacTrainingSample[],
  asymmetricLoss: boolean = false,
  progressCallback?: (msg: string) => void,
  useXGBoost: boolean = false
): Promise<Map<string, WindWeatherHybridModel>> {
  const models = new Map<string, WindWeatherHybridModel>();

  const modelType = useXGBoost ? 'XGBoost' : 'Linear Regression';
  progressCallback?.(`Training Weather-Only MREC Hybrid (${modelType}) for ${mrecFactors.length} wind stations${asymmetricLoss ? ' (with asymmetric loss)' : ''}`);

  let totalMrecMAPE = 0;
  let totalHybridMAPE = 0;
  let stationCount = 0;

  for (let i = 0; i < mrecFactors.length; i++) {
    const factors = mrecFactors[i];
    progressCallback?.(`  [${i + 1}/${mrecFactors.length}] Training ${factors.stationCode}...`);

    const model = new WindWeatherHybridModel(factors.stationCode, useXGBoost);
    model.loadMRECFactors(factors);

    const metrics = model.trainResidual(samples, asymmetricLoss);

    if (metrics.sampleCount >= 50) {
      totalMrecMAPE += metrics.mrecOnlyMAPE;
      totalHybridMAPE += metrics.weatherHybridMAPE;
      stationCount++;

      progressCallback?.(`    MREC MAPE: ${metrics.mrecOnlyMAPE.toFixed(1)}% → Weather Hybrid: ${metrics.weatherHybridMAPE.toFixed(1)}% (${metrics.improvement > 0 ? '+' : ''}${metrics.improvement.toFixed(1)}%)`);
    }

    models.set(factors.stationCode, model);
  }

  if (stationCount > 0) {
    const avgMrecMAPE = totalMrecMAPE / stationCount;
    const avgHybridMAPE = totalHybridMAPE / stationCount;
    const overallImprovement = ((avgMrecMAPE - avgHybridMAPE) / avgMrecMAPE) * 100;

    progressCallback?.(`\nOverall Results (Weather-Only Hybrid - ${modelType}):`);
    progressCallback?.(`   MREC-only avg MAPE:     ${avgMrecMAPE.toFixed(1)}%`);
    progressCallback?.(`   Weather Hybrid MAPE:    ${avgHybridMAPE.toFixed(1)}%`);
    progressCallback?.(`   Improvement:            ${overallImprovement.toFixed(1)}%`);
  }

  return models;
}
