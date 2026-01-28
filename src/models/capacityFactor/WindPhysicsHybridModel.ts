/**
 * WindPhysicsHybridModel - Physics-Based MREC + Weather ML Residual
 *
 * Combines the corrected physics-based power curve model with
 * weather-only ML residual correction.
 *
 * Architecture:
 * 1. Physics MREC provides robust base prediction using correct power curve
 *    - LOW: Linear (below cut-in)
 *    - RAMP: Quadratic (power region)
 *    - RATED: Constant plateau (key fix!)
 *    - HIGH: Linear ramp-down to cut-out
 *
 * 2. ML learns residual correction from WEATHER features only:
 *    - Gust ratio (turbulence indicator)
 *    - Temperature deviation (air density proxy)
 *    - Cloud cover (atmospheric conditions)
 *    - NO temporal features (avoids overfitting)
 */

import MultivariateLinearRegression from 'ml-regression-multivariate-linear';
import {
  MRECCalibrationData,
  CFacWeatherFeatures,
  CFacTrainingSample,
  StationType,
} from '../../types/capacityFactor.js';
import { WindPhysicsMRECModel, PhysicsMRECFactors } from './WindPhysicsMRECModel.js';
import { CFacXGBoostRegressor } from './CFacXGBoostRegressor.js';
import { getOptimalWindSpeed } from './WindWeatherHybridModel.js';

export interface PhysicsHybridMetrics {
  stationCode: string;
  physicsOnlyMAPE: number;
  hybridMAPE: number;
  improvement: number;
  residualR2: number;
  sampleCount: number;
  tierDistribution: {
    low: number;
    ramp: number;
    rated: number;
    high: number;
    cutout: number;
  };
}

export class WindPhysicsHybridModel {
  private stationCode: string;
  private physicsModel: WindPhysicsMRECModel;
  private residualModel: MultivariateLinearRegression | null = null;
  private xgboostModel: CFacXGBoostRegressor | null = null;
  private useXGBoost: boolean = false;

  // Feature names (weather-only to avoid overfitting)
  private static readonly FEATURE_NAMES = [
    'physics_base',     // Physics model prediction as anchor
    'tier_RAMP',        // In ramp region
    'tier_RATED',       // In rated region (plateau)
    'tier_HIGH',        // In high/derate region
    'gust_ratio',       // Turbulence: windGust / windSpeed
    'temp_deviation',   // Air density proxy
    'wind_speed_norm',  // Normalized wind speed
    'cloud_cover',      // Atmospheric conditions
  ];

  constructor(stationCode: string, useXGBoost: boolean = false) {
    this.stationCode = stationCode;
    this.physicsModel = new WindPhysicsMRECModel(stationCode);
    this.useXGBoost = useXGBoost;
  }

  /**
   * Get station code
   */
  getStationCode(): string {
    return this.stationCode;
  }

  /**
   * Calibrate physics MREC from historical data
   */
  calibratePhysics(data: MRECCalibrationData[]): PhysicsMRECFactors {
    return this.physicsModel.calibrate(data);
  }

  /**
   * Load pre-calibrated physics factors
   */
  loadPhysicsFactors(factors: PhysicsMRECFactors): void {
    this.physicsModel.loadFactors(factors);
  }

  /**
   * Get physics factors
   */
  getPhysicsFactors(): PhysicsMRECFactors | null {
    return this.physicsModel.getFactors();
  }

  /**
   * Get optimal wind speed for this station
   */
  private getOptimalWindSpeedForStation(weather: CFacWeatherFeatures): number {
    return getOptimalWindSpeed(this.stationCode, weather);
  }

  /**
   * Build WEATHER-ONLY feature vector for residual model
   */
  private buildWeatherFeatures(
    physicsBase: number,
    weather: CFacWeatherFeatures
  ): number[] {
    const windSpeed = this.getOptimalWindSpeedForStation(weather);
    const tier = this.physicsModel.getTier(windSpeed);

    // Gust ratio: indicates turbulence
    const gustRatio = weather.windGust && windSpeed > 0.1
      ? Math.min(weather.windGust / windSpeed, 3)
      : 1.0;

    // Temperature deviation from standard (25°C)
    const tempDeviation = ((weather.temperature ?? 25) - 25) / 20;

    // Tier indicators
    const isRamp = tier === 'RAMP' ? 1 : 0;
    const isRated = tier === 'RATED' ? 1 : 0;
    const isHigh = tier === 'HIGH' ? 1 : 0;

    return [
      physicsBase,                             // Physics prediction as anchor
      isRamp,                                  // Ramp tier indicator
      isRated,                                 // Rated tier indicator
      isHigh,                                  // High tier indicator
      gustRatio,                               // Turbulence indicator
      tempDeviation,                           // Air density proxy
      windSpeed / 30,                          // Normalized wind speed
      (weather.cloudCover ?? 50) / 100,        // Atmospheric conditions
    ];
  }

  /**
   * Train the weather-only residual model
   */
  trainResidual(samples: CFacTrainingSample[], asymmetricLoss: boolean = false): PhysicsHybridMetrics {
    const stationSamples = samples.filter(s => s.stationCode === this.stationCode);

    if (stationSamples.length < 50) {
      console.warn(`Insufficient samples for ${this.stationCode}: ${stationSamples.length}`);
      return this.createEmptyMetrics(stationSamples.length);
    }

    // Track tier distribution
    let nLow = 0, nRamp = 0, nRated = 0, nHigh = 0, nCutout = 0;

    // Build training data
    const featureMatrix: number[][] = [];
    const residuals: number[] = [];
    let physicsErrorSum = 0;
    let validPhysicsCount = 0;

    for (const sample of stationSamples) {
      const windSpeed = this.getOptimalWindSpeedForStation(sample.weather);
      const tier = this.physicsModel.getTier(windSpeed);

      // Track tier distribution
      switch (tier) {
        case 'LOW': nLow++; break;
        case 'RAMP': nRamp++; break;
        case 'RATED': nRated++; break;
        case 'HIGH': nHigh++; break;
        case 'CUTOUT': nCutout++; break;
      }

      const physicsPred = this.physicsModel.predict(windSpeed);
      const actual = sample.actualCFac;
      const residual = actual - physicsPred;

      const features = this.buildWeatherFeatures(physicsPred, sample.weather);
      featureMatrix.push(features);
      residuals.push(residual);

      // Track physics-only error
      if (actual > 0.01) {
        physicsErrorSum += Math.abs((physicsPred - actual) / actual);
        validPhysicsCount++;
      }
    }

    const physicsOnlyMAPE = validPhysicsCount > 0 ? (physicsErrorSum / validPhysicsCount) * 100 : 0;

    // Train residual model
    try {
      if (this.useXGBoost) {
        this.xgboostModel = new CFacXGBoostRegressor({
          maxDepth: 4,
          learningRate: 0.05,
          nEstimators: 150,
          minChildWeight: 5,
          subsample: 0.8,
          alpha: asymmetricLoss ? 0.65 : 0.5
        });
        this.xgboostModel.train(featureMatrix, residuals);
        this.residualModel = null;
      } else {
        if (asymmetricLoss) {
          const augmentedFeatures: number[][] = [];
          const augmentedResiduals: number[] = [];

          for (let i = 0; i < stationSamples.length; i++) {
            augmentedFeatures.push(featureMatrix[i]);
            augmentedResiduals.push(residuals[i]);

            // Duplicate under-prediction samples
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
        this.xgboostModel = null;
      }
    } catch (error: any) {
      console.warn(`Failed to train residual for ${this.stationCode}: ${error.message}`);
      return {
        stationCode: this.stationCode,
        physicsOnlyMAPE,
        hybridMAPE: physicsOnlyMAPE,
        improvement: 0,
        residualR2: 0,
        sampleCount: stationSamples.length,
        tierDistribution: { low: nLow, ramp: nRamp, rated: nRated, high: nHigh, cutout: nCutout },
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
      const windSpeed = this.getOptimalWindSpeedForStation(sample.weather);
      const physicsPred = this.physicsModel.predict(windSpeed);
      const features = featureMatrix[i];

      let predictedResidual: number;
      if (this.xgboostModel) {
        predictedResidual = this.xgboostModel.predict(features);
      } else {
        predictedResidual = this.residualModel!.predict([features])[0][0];
      }

      let hybridPred = physicsPred + predictedResidual;
      hybridPred = Math.max(0, Math.min(1, hybridPred));

      const actual = sample.actualCFac;

      if (actual > 0.01) {
        hybridErrorSum += Math.abs((hybridPred - actual) / actual);
        validHybridCount++;
      }

      // R² calculation
      const actualResidual = residuals[i];
      residualSS += (actualResidual - predictedResidual) ** 2;
      totalSS += (actualResidual - meanResidual) ** 2;
    }

    const hybridMAPE = validHybridCount > 0 ? (hybridErrorSum / validHybridCount) * 100 : 0;
    const residualR2 = totalSS > 0 ? 1 - (residualSS / totalSS) : 0;
    const improvement = physicsOnlyMAPE > 0 ? ((physicsOnlyMAPE - hybridMAPE) / physicsOnlyMAPE) * 100 : 0;

    return {
      stationCode: this.stationCode,
      physicsOnlyMAPE,
      hybridMAPE,
      improvement,
      residualR2,
      sampleCount: stationSamples.length,
      tierDistribution: { low: nLow, ramp: nRamp, rated: nRated, high: nHigh, cutout: nCutout },
    };
  }

  /**
   * Predict capacity factor using physics hybrid model
   */
  predict(weather: CFacWeatherFeatures, _datetime?: Date): number {
    const windSpeed = this.getOptimalWindSpeedForStation(weather);

    // Get physics base prediction
    const physicsBase = this.physicsModel.predict(windSpeed);

    // If no residual model, return physics-only
    if (!this.residualModel && !this.xgboostModel) {
      return physicsBase;
    }

    // Build weather features and predict residual
    const features = this.buildWeatherFeatures(physicsBase, weather);

    let residual: number;
    if (this.xgboostModel) {
      residual = this.xgboostModel.predict(features);
    } else {
      residual = this.residualModel!.predict([features])[0][0];
    }

    // Combine
    let finalPred = physicsBase + residual;

    return Math.max(0, Math.min(1, finalPred));
  }

  /**
   * Get physics-only prediction (for comparison)
   */
  predictPhysicsOnly(windSpeed: number): number {
    return this.physicsModel.predict(windSpeed);
  }

  /**
   * Get current tier
   */
  getTier(windSpeed: number): string {
    return this.physicsModel.getTier(windSpeed);
  }

  /**
   * Check if hybrid model is trained
   */
  isHybridTrained(): boolean {
    return this.residualModel !== null || this.xgboostModel !== null;
  }

  /**
   * Check if physics is calibrated
   */
  isPhysicsCalibrated(): boolean {
    return this.physicsModel.isCalibrated();
  }

  /**
   * Get feature names
   */
  getFeatureNames(): string[] {
    return WindPhysicsHybridModel.FEATURE_NAMES;
  }

  /**
   * Create empty metrics for insufficient data
   */
  private createEmptyMetrics(sampleCount: number): PhysicsHybridMetrics {
    return {
      stationCode: this.stationCode,
      physicsOnlyMAPE: 0,
      hybridMAPE: 0,
      improvement: 0,
      residualR2: 0,
      sampleCount,
      tierDistribution: { low: 0, ramp: 0, rated: 0, high: 0, cutout: 0 },
    };
  }
}

/**
 * Train Physics Hybrid models for all wind stations
 */
export async function trainAllPhysicsHybrid(
  samples: CFacTrainingSample[],
  asymmetricLoss: boolean = false,
  progressCallback?: (msg: string) => void,
  useXGBoost: boolean = false
): Promise<Map<string, WindPhysicsHybridModel>> {
  const models = new Map<string, WindPhysicsHybridModel>();

  // Get unique wind stations
  const windStations = new Set<string>();
  for (const s of samples) {
    if (s.stationType === StationType.WIND) {
      windStations.add(s.stationCode);
    }
  }

  const modelType = useXGBoost ? 'XGBoost' : 'Linear Regression';
  progressCallback?.(`Training Physics Hybrid (${modelType}) for ${windStations.size} wind stations${asymmetricLoss ? ' (asymmetric loss)' : ''}`);

  // Prepare MREC calibration data
  const mrecData: MRECCalibrationData[] = samples
    .filter(s => s.stationType === StationType.WIND)
    .map(s => ({
      datetime: s.datetime,
      stationCode: s.stationCode,
      windSpeed: s.weather.windSpeed100 ?? s.weather.windSpeed,
      capacityFactor: s.actualCFac,
    }));

  let totalPhysicsMAPE = 0;
  let totalHybridMAPE = 0;
  let stationCount = 0;
  let idx = 0;

  for (const stationCode of windStations) {
    idx++;
    progressCallback?.(`  [${idx}/${windStations.size}] Training ${stationCode}...`);

    const model = new WindPhysicsHybridModel(stationCode, useXGBoost);

    // Calibrate physics model
    const factors = model.calibratePhysics(mrecData);

    if (factors.calibrated) {
      progressCallback?.(`    Physics: vCutIn=${factors.vCutIn.toFixed(1)}, vRated=${factors.vRated.toFixed(1)}, vHigh=${factors.vHigh.toFixed(1)} m/s, RatedCF=${(factors.ratedCF * 100).toFixed(1)}%`);
    }

    // Train hybrid residual
    const metrics = model.trainResidual(samples, asymmetricLoss);

    if (metrics.sampleCount >= 50) {
      totalPhysicsMAPE += metrics.physicsOnlyMAPE;
      totalHybridMAPE += metrics.hybridMAPE;
      stationCount++;

      progressCallback?.(`    Physics MAPE: ${metrics.physicsOnlyMAPE.toFixed(1)}% → Hybrid: ${metrics.hybridMAPE.toFixed(1)}% (${metrics.improvement > 0 ? '+' : ''}${metrics.improvement.toFixed(1)}%)`);
      progressCallback?.(`    Tiers: LOW=${metrics.tierDistribution.low}, RAMP=${metrics.tierDistribution.ramp}, RATED=${metrics.tierDistribution.rated}, HIGH=${metrics.tierDistribution.high}, CUTOUT=${metrics.tierDistribution.cutout}`);
    }

    models.set(stationCode, model);
  }

  if (stationCount > 0) {
    const avgPhysicsMAPE = totalPhysicsMAPE / stationCount;
    const avgHybridMAPE = totalHybridMAPE / stationCount;
    const overallImprovement = ((avgPhysicsMAPE - avgHybridMAPE) / avgPhysicsMAPE) * 100;

    progressCallback?.(`\nOverall Results (Physics Hybrid - ${modelType}):`);
    progressCallback?.(`  Physics-only avg MAPE:  ${avgPhysicsMAPE.toFixed(1)}%`);
    progressCallback?.(`  Physics Hybrid MAPE:    ${avgHybridMAPE.toFixed(1)}%`);
    progressCallback?.(`  Improvement:            ${overallImprovement.toFixed(1)}%`);
  }

  return models;
}
