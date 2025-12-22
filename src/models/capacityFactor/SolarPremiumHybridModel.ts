/**
 * SolarPremiumHybridModel - MREC base + Premium Weather Features
 *
 * Key Insight from Analysis (2025-12-11):
 * - Base solar radiation alone: MAPE 64.4%
 * - With humidity correction: MAPE 52.3% (-18.8%)
 * - With all premium features: MAPE 45.3% (-29.6%)
 *
 * Premium Features Correlations with Actual CF:
 * - Solar radiation: r = 0.785 (strong positive)
 * - UV Index:        r = 0.779 (strong positive - clear sky indicator)
 * - Humidity:        r = -0.423 (strong negative - atmospheric absorption)
 * - Visibility:      r = 0.309 (moderate positive - haze/aerosol indicator)
 * - Cloud cover:     r = -0.243 (moderate negative)
 *
 * Architecture:
 * 1. MREC provides robust three-tier base prediction from irradiance
 * 2. Premium feature corrections applied as multiplicative factors:
 *    - UV Index: Clear-sky scaling (higher UV = better conditions)
 *    - Humidity: Atmospheric absorption adjustment (high humidity = lower output)
 *    - Conditions text: Categorical cloud/rain adjustment
 */

import MultivariateLinearRegression from 'ml-regression-multivariate-linear';
import {
  StationType,
  CFacWeatherFeatures,
  CFacTrainingSample,
} from '../../types/capacityFactor.js';
import { SolarMRECModel, SolarMRECFactors, SolarMRECCalibrationData } from './SolarMRECModel.js';
import { CFacXGBoostRegressor } from './CFacXGBoostRegressor.js';

/**
 * Extended weather features for solar premium model
 */
export interface SolarPremiumWeatherFeatures extends CFacWeatherFeatures {
  uvIndex?: number;
  humidity?: number;
  visibility?: number;
  conditions?: string;
}

export interface SolarPremiumMetrics {
  stationCode: string;
  mrecOnlyMAPE: number;
  premiumMAPE: number;
  improvement: number;
  residualR2: number;
  sampleCount: number;
}

export class SolarPremiumHybridModel {
  private stationCode: string;
  private mrecModel: SolarMRECModel;
  private residualModel: MultivariateLinearRegression | null = null;
  private xgboostModel: CFacXGBoostRegressor | null = null;
  private useXGBoost: boolean = false;

  // Calibrated correction coefficients (simple physics-based adjustments)
  private humidityCoeff = 0.15;     // Humidity reduction factor
  private uvScaleCoeff = 0.25;      // UV enhancement factor
  private conditionsFactors: Record<string, number> = {
    'clear': 1.10,
    'partially cloudy': 0.95,
    'overcast': 0.85,
    'rain': 0.80,
    'default': 1.0
  };

  // Feature names for ML residual model
  private static readonly FEATURE_NAMES = [
    'mrec_base',          // Base MREC prediction
    'tier_H',             // High tier indicator
    'tier_M',             // Mid tier indicator
    'uv_scaled',          // UV index normalized
    'humidity_scaled',    // Humidity normalized
    'visibility_scaled',  // Visibility normalized
    'conditions_clear',   // Is clear/sunny
    'conditions_cloudy',  // Is overcast/cloudy
    'conditions_rain',    // Has rain
    'irradiance_norm',    // Normalized irradiance
  ];

  constructor(stationCode: string, useXGBoost: boolean = false) {
    this.stationCode = stationCode;
    this.mrecModel = new SolarMRECModel(stationCode);
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
  loadMRECFactors(factors: SolarMRECFactors): void {
    this.mrecModel.loadFactors(factors);
  }

  /**
   * Calibrate MREC base model from historical data
   */
  calibrateMREC(data: SolarMRECCalibrationData[]): SolarMRECFactors {
    return this.mrecModel.calibrate(data);
  }

  /**
   * Get MREC factors
   */
  getMRECFactors(): SolarMRECFactors | null {
    return this.mrecModel.getFactors();
  }

  /**
   * Determine which tier an irradiance falls into
   */
  private getTier(irradiance: number): 'H' | 'M' | 'L' {
    const factors = this.mrecModel.getFactors();
    if (!factors) return 'L';

    if (irradiance >= factors.irrH) return 'H';
    if (irradiance >= factors.irrL) return 'M';
    return 'L';
  }

  /**
   * Parse conditions text to determine sky state
   */
  private parseConditions(conditions: string): { clear: boolean; cloudy: boolean; rain: boolean } {
    const lower = (conditions || '').toLowerCase();
    return {
      clear: lower.includes('clear') || lower.includes('sunny'),
      cloudy: lower.includes('overcast') || lower.includes('cloudy'),
      rain: lower.includes('rain') || lower.includes('shower') || lower.includes('storm'),
    };
  }

  /**
   * Get conditions adjustment factor
   */
  private getConditionsFactor(conditions: string): number {
    const lower = (conditions || '').toLowerCase();

    if (lower.includes('clear') || lower.includes('sunny')) {
      return this.conditionsFactors['clear'];
    }
    if (lower.includes('rain') || lower.includes('shower') || lower.includes('storm')) {
      return this.conditionsFactors['rain'];
    }
    if (lower.includes('overcast')) {
      return this.conditionsFactors['overcast'];
    }
    if (lower.includes('cloudy')) {
      return this.conditionsFactors['partially cloudy'];
    }
    return this.conditionsFactors['default'];
  }

  /**
   * Build premium feature vector for residual model
   */
  private buildPremiumFeatures(
    mrecBase: number,
    weather: SolarPremiumWeatherFeatures
  ): number[] {
    const irradiance = weather.solarRadiation;
    const tier = this.getTier(irradiance);
    const condState = this.parseConditions(weather.conditions || '');

    return [
      mrecBase,                                              // MREC base prediction
      tier === 'H' ? 1 : 0,                                 // High tier indicator
      tier === 'M' ? 1 : 0,                                 // Mid tier indicator
      Math.min((weather.uvIndex ?? 5) / 10, 1),            // UV normalized [0, 1]
      (weather.humidity ?? 70) / 100,                       // Humidity normalized [0, 1]
      Math.min((weather.visibility ?? 10) / 20, 1),        // Visibility normalized [0, 1]
      condState.clear ? 1 : 0,                              // Clear conditions
      condState.cloudy ? 1 : 0,                             // Cloudy conditions
      condState.rain ? 1 : 0,                               // Rain conditions
      irradiance / 1000,                                    // Normalized irradiance
    ];
  }

  /**
   * Simple physics-based prediction with premium corrections
   * (No ML residual - just the calibrated correction factors)
   */
  predictPhysicsOnly(weather: SolarPremiumWeatherFeatures): number {
    const irradiance = weather.solarRadiation;

    // Get MREC base prediction
    const mrecBase = this.mrecModel.predict(irradiance);

    // Apply UV correction (higher UV = clearer sky = better performance)
    let uvFactor = 1.0;
    if (weather.uvIndex !== undefined && weather.uvIndex > 0) {
      // Scale: UV 1 = 0.875x, UV 7 = 1.0x, UV 10+ = 1.125x
      uvFactor = 0.875 + Math.min(weather.uvIndex / 10, 1) * this.uvScaleCoeff;
    }

    // Apply humidity correction (high humidity = more absorption = lower output)
    let humidityFactor = 1.0;
    if (weather.humidity !== undefined) {
      // Scale: 50% = 1.05x, 70% = 1.0x, 90% = 0.85x
      humidityFactor = 1 + this.humidityCoeff * (0.7 - weather.humidity / 100);
      humidityFactor = Math.max(0.85, Math.min(1.1, humidityFactor));
    }

    // Apply conditions correction
    const conditionsFactor = this.getConditionsFactor(weather.conditions || '');

    // Combine all factors
    let cfac = mrecBase * uvFactor * humidityFactor * conditionsFactor;

    return Math.max(0, Math.min(1, cfac));
  }

  /**
   * Train the ML residual model on top of physics corrections
   *
   * @param samples - Training samples with actual capacity factors
   * @returns Training metrics
   */
  trainResidual(samples: CFacTrainingSample[]): SolarPremiumMetrics {
    // Filter samples for this station
    const stationSamples = samples.filter(s => s.stationCode === this.stationCode);

    // Filter for daylight hours with actual generation
    const daylightSamples = stationSamples.filter(s =>
      s.hour >= 6 && s.hour <= 18 && s.actualCFac > 0.01 && s.weather.solarRadiation > 10
    );

    if (daylightSamples.length < 50) {
      console.warn(`Insufficient daylight samples for ${this.stationCode}: ${daylightSamples.length}`);
      return {
        stationCode: this.stationCode,
        mrecOnlyMAPE: 0,
        premiumMAPE: 0,
        improvement: 0,
        residualR2: 0,
        sampleCount: daylightSamples.length,
      };
    }

    // Build training data
    const featureMatrix: number[][] = [];
    const residuals: number[] = [];
    let mrecErrorSum = 0;
    let validMrecCount = 0;

    for (const sample of daylightSamples) {
      const irradiance = sample.weather.solarRadiation;
      const mrecPred = this.mrecModel.predict(irradiance);
      const actual = sample.actualCFac;
      const residual = actual - mrecPred;

      // Build premium weather features
      const premiumWeather: SolarPremiumWeatherFeatures = {
        ...sample.weather,
        uvIndex: (sample.weather as any).uvIndex,
        humidity: sample.weather.humidity,
        visibility: (sample.weather as any).visibility,
        conditions: (sample.weather as any).conditions,
      };

      const features = this.buildPremiumFeatures(mrecPred, premiumWeather);
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
        // Train XGBoost
        this.xgboostModel = new CFacXGBoostRegressor({
          maxDepth: 3,             // Shallower for solar (less complex patterns)
          learningRate: 0.05,      // Lower learning rate
          nEstimators: 100,        // Fewer trees than wind
          minChildWeight: 5,       // Minimum samples per leaf
          subsample: 0.8,          // Sample 80% per tree
          alpha: 0.5               // Symmetric loss for solar (already physics-corrected)
        });
        this.xgboostModel.train(featureMatrix, residuals);
        this.residualModel = null;  // Clear linear model
      } else {
        // Train linear regression (original approach)
        const residuals2D = residuals.map(r => [r]);
        this.residualModel = new MultivariateLinearRegression(featureMatrix, residuals2D);
        this.xgboostModel = null;  // Clear XGBoost model
      }
    } catch (error: any) {
      console.warn(`Failed to train residual model for ${this.stationCode}: ${error.message}`);
      return {
        stationCode: this.stationCode,
        mrecOnlyMAPE,
        premiumMAPE: mrecOnlyMAPE,
        improvement: 0,
        residualR2: 0,
        sampleCount: daylightSamples.length,
      };
    }

    // Evaluate hybrid model
    let hybridErrorSum = 0;
    let validHybridCount = 0;
    let residualSS = 0;
    let totalSS = 0;
    const meanResidual = residuals.reduce((a, b) => a + b, 0) / residuals.length;

    for (let i = 0; i < daylightSamples.length; i++) {
      const sample = daylightSamples[i];
      const irradiance = sample.weather.solarRadiation;
      const mrecPred = this.mrecModel.predict(irradiance);
      const features = featureMatrix[i];

      // Predict residual (using XGBoost or Linear Regression)
      let predictedResidual: number;
      if (this.xgboostModel) {
        predictedResidual = this.xgboostModel.predict(features);
      } else {
        predictedResidual = this.residualModel!.predict([features])[0][0];
      }
      let hybridPred = mrecPred + predictedResidual;

      // Clamp to valid range
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

    const premiumMAPE = validHybridCount > 0 ? (hybridErrorSum / validHybridCount) * 100 : 0;
    const residualR2 = totalSS > 0 ? 1 - (residualSS / totalSS) : 0;
    const improvement = mrecOnlyMAPE > 0 ? ((mrecOnlyMAPE - premiumMAPE) / mrecOnlyMAPE) * 100 : 0;

    return {
      stationCode: this.stationCode,
      mrecOnlyMAPE,
      premiumMAPE,
      improvement,
      residualR2,
      sampleCount: daylightSamples.length,
    };
  }

  /**
   * Predict capacity factor using premium hybrid model
   *
   * @param weather - Weather features including premium data
   * @param _datetime - Not used (weather-only approach to avoid temporal overfitting)
   * @returns Predicted capacity factor [0, 1]
   */
  predict(weather: SolarPremiumWeatherFeatures, _datetime?: Date): number {
    const irradiance = weather.solarRadiation;

    // No output at night or zero irradiance
    if (irradiance <= 0) {
      return 0;
    }

    // Get MREC base prediction
    const mrecBase = this.mrecModel.predict(irradiance);

    // If no residual model trained, use physics-only prediction
    if (!this.residualModel && !this.xgboostModel) {
      return this.predictPhysicsOnly(weather);
    }

    // Build premium features and predict residual
    const features = this.buildPremiumFeatures(mrecBase, weather);

    let residual: number;
    if (this.xgboostModel) {
      residual = this.xgboostModel.predict(features);
    } else {
      residual = this.residualModel!.predict([features])[0][0];
    }

    // Combine
    let finalPred = mrecBase + residual;

    // Clamp to valid range
    return Math.max(0, Math.min(1, finalPred));
  }

  /**
   * Get MREC-only prediction (for comparison)
   */
  predictMRECOnly(irradiance: number): number {
    return this.mrecModel.predict(irradiance);
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
   * Get feature names for debugging
   */
  getFeatureNames(): string[] {
    return SolarPremiumHybridModel.FEATURE_NAMES;
  }

  /**
   * Set correction coefficients (for tuning)
   */
  setCorrections(params: {
    humidityCoeff?: number;
    uvScaleCoeff?: number;
    conditionsFactors?: Record<string, number>;
  }): void {
    if (params.humidityCoeff !== undefined) {
      this.humidityCoeff = params.humidityCoeff;
    }
    if (params.uvScaleCoeff !== undefined) {
      this.uvScaleCoeff = params.uvScaleCoeff;
    }
    if (params.conditionsFactors) {
      this.conditionsFactors = { ...this.conditionsFactors, ...params.conditionsFactors };
    }
  }
}

/**
 * Train Premium Hybrid models for all solar stations
 */
export async function trainAllSolarPremium(
  mrecFactors: SolarMRECFactors[],
  samples: CFacTrainingSample[],
  progressCallback?: (msg: string) => void,
  useXGBoost: boolean = false
): Promise<Map<string, SolarPremiumHybridModel>> {
  const models = new Map<string, SolarPremiumHybridModel>();

  const modelType = useXGBoost ? 'XGBoost' : 'Linear Regression';
  progressCallback?.(`Training Solar Premium Hybrid (${modelType}) for ${mrecFactors.length} solar stations`);

  let totalMrecMAPE = 0;
  let totalPremiumMAPE = 0;
  let stationCount = 0;

  for (let i = 0; i < mrecFactors.length; i++) {
    const factors = mrecFactors[i];
    progressCallback?.(`  [${i + 1}/${mrecFactors.length}] Training ${factors.stationCode}...`);

    const model = new SolarPremiumHybridModel(factors.stationCode, useXGBoost);
    model.loadMRECFactors(factors);

    const metrics = model.trainResidual(samples);

    if (metrics.sampleCount >= 50) {
      totalMrecMAPE += metrics.mrecOnlyMAPE;
      totalPremiumMAPE += metrics.premiumMAPE;
      stationCount++;

      progressCallback?.(`    MREC MAPE: ${metrics.mrecOnlyMAPE.toFixed(1)}% → Premium Hybrid: ${metrics.premiumMAPE.toFixed(1)}% (${metrics.improvement > 0 ? '+' : ''}${metrics.improvement.toFixed(1)}%)`);
    }

    models.set(factors.stationCode, model);
  }

  if (stationCount > 0) {
    const avgMrecMAPE = totalMrecMAPE / stationCount;
    const avgPremiumMAPE = totalPremiumMAPE / stationCount;
    const overallImprovement = ((avgMrecMAPE - avgPremiumMAPE) / avgMrecMAPE) * 100;

    progressCallback?.(`\nOverall Results (Solar Premium Hybrid - ${modelType}):`);
    progressCallback?.(`   MREC-only avg MAPE:     ${avgMrecMAPE.toFixed(1)}%`);
    progressCallback?.(`   Premium Hybrid MAPE:    ${avgPremiumMAPE.toFixed(1)}%`);
    progressCallback?.(`   Improvement:            ${overallImprovement.toFixed(1)}%`);
  }

  return models;
}
