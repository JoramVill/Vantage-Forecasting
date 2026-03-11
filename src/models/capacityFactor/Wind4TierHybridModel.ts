/**
 * Wind4TierHybridModel - 4-Tier MREC + Region-Specific ML Residual Correction
 *
 * This model addresses the key insight from the Dec 8 01PAGUDPUD analysis:
 * gustRatio behavior INVERTS between RAMP and RATED regions.
 *
 * In RAMP region (5-12 m/s):
 * - Higher gustRatio = stronger gusts = more energy capture
 * - Coefficient should be POSITIVE
 *
 * In RATED region (12-25 m/s):
 * - Lower gustRatio = stable high winds = consistent max generation
 * - Coefficient should be NEGATIVE or NEAR-ZERO
 *
 * Features:
 * - 4-tier MREC base prediction (LOW/RAMP/RATED/HIGH)
 * - Tier indicators for ML
 * - Region-specific gustRatio: gustRatio_ramp, gustRatio_rated
 * - Temperature deviation (air density)
 * - Cloud cover (atmospheric proxy)
 * - Rated plateau stabilizer (reduces variance in rated region)
 */

import MultivariateLinearRegression from 'ml-regression-multivariate-linear';
import {
  CFacWeatherFeatures,
  CFacTrainingSample,
  MRECCalibrationData,
  StationType,
} from '../../types/capacityFactor.js';
import { Wind4TierMRECModel, MREC4TierFactors } from './Wind4TierMRECModel.js';
import { CFacXGBoostRegressor } from './CFacXGBoostRegressor.js';
import { getOptimalWindSpeed } from './WindWeatherHybridModel.js';

export interface Wind4TierHybridMetrics {
  stationCode: string;
  mrecOnlyMAPE: number;
  hybridMAPE: number;
  improvement: number;
  residualR2: number;
  sampleCount: number;
  tierDistribution: {
    low: number;
    ramp: number;
    rated: number;
    high: number;
  };
}

export class Wind4TierHybridModel {
  private stationCode: string;
  private mrecModel: Wind4TierMRECModel;
  private residualModel: MultivariateLinearRegression | null = null;
  private xgboostModel: CFacXGBoostRegressor | null = null;
  private useXGBoost: boolean = false;

  // Feature names for debugging/logging
  private static readonly FEATURE_NAMES = [
    'mrec_base',          // 4-Tier MREC prediction as anchor
    'tier_RAMP',          // Ramp tier indicator
    'tier_RATED',         // Rated tier indicator (plateau)
    'tier_HIGH',          // High tier indicator
    'gustRatio_ramp',     // gustRatio only active in RAMP region
    'gustRatio_rated',    // gustRatio only active in RATED region (inverted meaning)
    'gustRatio_high',     // gustRatio in HIGH region
    'temp_deviation',     // Air density proxy
    'wind_speed_norm',    // Normalized wind speed
    'rated_plateau_flag', // 1 when in rated plateau (stabilizer)
    'cloud_cover',        // Atmospheric conditions
  ];

  constructor(stationCode: string, useXGBoost: boolean = false) {
    this.stationCode = stationCode;
    this.mrecModel = new Wind4TierMRECModel(stationCode);
    this.useXGBoost = useXGBoost;
  }

  /**
   * Get station code
   */
  getStationCode(): string {
    return this.stationCode;
  }

  /**
   * Load pre-calibrated 4-tier MREC factors
   */
  load4TierFactors(factors: MREC4TierFactors): void {
    this.mrecModel.loadFactors(factors);
  }

  /**
   * Calibrate 4-tier MREC from historical data
   */
  calibrate4TierMREC(data: MRECCalibrationData[]): MREC4TierFactors {
    return this.mrecModel.calibrate(data);
  }

  /**
   * Get 4-tier MREC factors
   */
  get4TierFactors(): MREC4TierFactors | null {
    return this.mrecModel.getFactors();
  }

  /**
   * Get optimal wind speed for this station
   */
  private getOptimalWindSpeedForStation(weather: CFacWeatherFeatures): number {
    return getOptimalWindSpeed(this.stationCode, weather);
  }

  /**
   * Build REGION-SPECIFIC feature vector for residual model
   *
   * Key innovation: gustRatio is split into separate features per region
   * so the model can learn different coefficients for each.
   */
  private buildRegionSpecificFeatures(
    mrecBase: number,
    weather: CFacWeatherFeatures
  ): number[] {
    const windSpeed = this.getOptimalWindSpeedForStation(weather);
    const tier = this.mrecModel.getTier(windSpeed);

    // Calculate base gust ratio
    const gustRatio = weather.windGust && windSpeed > 0.1
      ? Math.min(weather.windGust / windSpeed, 3)
      : 1.0;

    // Temperature deviation from standard (25°C)
    const tempDeviation = ((weather.temperature ?? 25) - 25) / 20;

    // Tier indicators
    const isRamp = tier === 'RAMP' ? 1 : 0;
    const isRated = tier === 'RATED' ? 1 : 0;
    const isHigh = tier === 'HIGH' ? 1 : 0;

    // Region-specific gustRatio features
    // These allow the model to learn DIFFERENT coefficients for gustRatio
    // in each region - solving the Dec 8 issue
    const gustRatio_ramp = isRamp ? gustRatio : 0;
    const gustRatio_rated = isRated ? gustRatio : 0;
    const gustRatio_high = isHigh ? gustRatio : 0;

    // Rated plateau stabilizer - helps anchor predictions in rated region
    // When in rated plateau, CF should be near max and stable
    const ratedPlateauFlag = isRated;

    return [
      mrecBase,                                    // MREC prediction as anchor
      isRamp,                                      // Ramp tier indicator
      isRated,                                     // Rated tier indicator
      isHigh,                                      // High tier indicator
      gustRatio_ramp,                              // gustRatio in RAMP (positive effect)
      gustRatio_rated,                             // gustRatio in RATED (inverted/neutral)
      gustRatio_high,                              // gustRatio in HIGH
      tempDeviation,                               // Air density proxy
      windSpeed / 30,                              // Normalized wind speed
      ratedPlateauFlag,                            // Stabilizer for rated region
      (weather.cloudCover ?? 50) / 100,           // Atmospheric conditions
    ];
  }

  /**
   * Train the region-specific residual model
   */
  trainResidual(samples: CFacTrainingSample[], asymmetricLoss: boolean = false): Wind4TierHybridMetrics {
    const stationSamples = samples.filter(s => s.stationCode === this.stationCode);

    if (stationSamples.length < 50) {
      console.warn(`Insufficient samples for ${this.stationCode}: ${stationSamples.length}`);
      return this.createEmptyMetrics(stationSamples.length);
    }

    // Track tier distribution
    let nLow = 0, nRamp = 0, nRated = 0, nHigh = 0;

    // Build training data
    const featureMatrix: number[][] = [];
    const residuals: number[] = [];
    let mrecErrorSum = 0;
    let validMrecCount = 0;

    for (const sample of stationSamples) {
      const windSpeed = this.getOptimalWindSpeedForStation(sample.weather);
      const tier = this.mrecModel.getTier(windSpeed);

      // Track tier distribution
      switch (tier) {
        case 'LOW': nLow++; break;
        case 'RAMP': nRamp++; break;
        case 'RATED': nRated++; break;
        case 'HIGH': nHigh++; break;
      }

      const mrecPred = this.mrecModel.predict(windSpeed);
      const actual = sample.actualCFac;
      const residual = actual - mrecPred;

      const features = this.buildRegionSpecificFeatures(mrecPred, sample.weather);
      featureMatrix.push(features);
      residuals.push(residual);

      // Track MREC-only error
      if (actual > 0.01) {
        mrecErrorSum += Math.abs((mrecPred - actual) / actual);
        validMrecCount++;
      }
    }

    const mrecOnlyMAPE = validMrecCount > 0 ? (mrecErrorSum / validMrecCount) * 100 : 0;

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
        // Linear regression with optional asymmetric loss
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
      console.warn(`Failed to train 4-tier residual for ${this.stationCode}: ${error.message}`);
      return {
        stationCode: this.stationCode,
        mrecOnlyMAPE,
        hybridMAPE: mrecOnlyMAPE,
        improvement: 0,
        residualR2: 0,
        sampleCount: stationSamples.length,
        tierDistribution: { low: nLow, ramp: nRamp, rated: nRated, high: nHigh },
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
      const mrecPred = this.mrecModel.predict(windSpeed);
      const features = featureMatrix[i];

      let predictedResidual: number;
      if (this.xgboostModel) {
        predictedResidual = this.xgboostModel.predict(features);
      } else {
        predictedResidual = this.residualModel!.predict([features])[0][0];
      }

      let hybridPred = mrecPred + predictedResidual;

      // High wind cutout
      if (hybridPred > 1.1) hybridPred = 0;
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
    const improvement = mrecOnlyMAPE > 0 ? ((mrecOnlyMAPE - hybridMAPE) / mrecOnlyMAPE) * 100 : 0;

    return {
      stationCode: this.stationCode,
      mrecOnlyMAPE,
      hybridMAPE,
      improvement,
      residualR2,
      sampleCount: stationSamples.length,
      tierDistribution: { low: nLow, ramp: nRamp, rated: nRated, high: nHigh },
    };
  }

  /**
   * Predict capacity factor using 4-tier hybrid model
   */
  predict(
    weather: CFacWeatherFeatures,
    _datetime?: Date,
    weatherSequence?: CFacWeatherFeatures[],
    hours?: number[],
    months?: number[]
  ): number {
    const windSpeed = this.getOptimalWindSpeedForStation(weather);

    // Get 4-tier MREC base prediction
    const mrecBase = this.mrecModel.predict(windSpeed);

    // If no residual model, return MREC-only
    if (!this.residualModel && !this.xgboostModel) {
      return mrecBase;
    }

    // Build region-specific features and predict residual
    const features = this.buildRegionSpecificFeatures(mrecBase, weather);

    let residual: number;
    if (this.xgboostModel) {
      residual = this.xgboostModel.predict(features);
    } else {
      residual = this.residualModel!.predict([features])[0][0];
    }

    // Combine
    let finalPred = mrecBase + residual;

    // High wind cutout
    if (finalPred > 1.1) {
      return 0;
    }

    return Math.max(0, Math.min(1, finalPred));
  }

  /**
   * Get MREC-only prediction (for comparison)
   */
  predictMRECOnly(windSpeed: number): number {
    return this.mrecModel.predict(windSpeed);
  }

  /**
   * Get current tier for debugging
   */
  getTier(windSpeed: number): string {
    return this.mrecModel.getTier(windSpeed);
  }

  /**
   * Check if in rated plateau
   */
  isInRatedPlateau(weather: CFacWeatherFeatures): boolean {
    const windSpeed = this.getOptimalWindSpeedForStation(weather);
    return this.mrecModel.isInRatedPlateau(windSpeed);
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
   * Get feature names
   */
  getFeatureNames(): string[] {
    return Wind4TierHybridModel.FEATURE_NAMES;
  }


  /**
   * Create empty metrics for insufficient data
   */
  private createEmptyMetrics(sampleCount: number): Wind4TierHybridMetrics {
    return {
      stationCode: this.stationCode,
      mrecOnlyMAPE: 0,
      hybridMAPE: 0,
      improvement: 0,
      residualR2: 0,
      sampleCount,
      tierDistribution: { low: 0, ramp: 0, rated: 0, high: 0 },
    };
  }
}

/**
 * Train 4-Tier Hybrid models for all wind stations
 */
export async function trainAll4TierHybrid(
  samples: CFacTrainingSample[],
  asymmetricLoss: boolean = false,
  progressCallback?: (msg: string) => void,
  useXGBoost: boolean = false
): Promise<Map<string, Wind4TierHybridModel>> {
  const models = new Map<string, Wind4TierHybridModel>();

  // Get unique wind stations
  const windStations = new Set<string>();
  for (const s of samples) {
    if (s.stationType === StationType.WIND) {
      windStations.add(s.stationCode);
    }
  }

  const modelType = useXGBoost ? 'XGBoost' : 'Linear Regression';
  progressCallback?.(`Training 4-Tier Hybrid (${modelType}) for ${windStations.size} wind stations${asymmetricLoss ? ' (asymmetric loss)' : ''}`);

  // First, calibrate 4-tier MREC for all stations
  const mrecData: MRECCalibrationData[] = samples
    .filter(s => s.stationType === StationType.WIND)
    .map(s => ({
      datetime: s.datetime,
      stationCode: s.stationCode,
      windSpeed: s.weather.windSpeed100 ?? s.weather.windSpeed,
      capacityFactor: s.actualCFac,
    }));

  let totalMrecMAPE = 0;
  let totalHybridMAPE = 0;
  let stationCount = 0;
  let idx = 0;

  for (const stationCode of windStations) {
    idx++;
    progressCallback?.(`  [${idx}/${windStations.size}] Training ${stationCode}...`);

    const model = new Wind4TierHybridModel(stationCode, useXGBoost);

    // Calibrate 4-tier MREC
    const factors = model.calibrate4TierMREC(mrecData);

    if (factors.calibrated) {
      progressCallback?.(`    Tiers: vLow=${factors.vLow.toFixed(1)}, vRated=${factors.vRated.toFixed(1)}, vHigh=${factors.vHigh.toFixed(1)} m/s`);
    }

    // Train hybrid residual
    const metrics = model.trainResidual(samples, asymmetricLoss);

    if (metrics.sampleCount >= 50) {
      totalMrecMAPE += metrics.mrecOnlyMAPE;
      totalHybridMAPE += metrics.hybridMAPE;
      stationCount++;

      progressCallback?.(`    MREC MAPE: ${metrics.mrecOnlyMAPE.toFixed(1)}% → 4-Tier Hybrid: ${metrics.hybridMAPE.toFixed(1)}% (${metrics.improvement > 0 ? '+' : ''}${metrics.improvement.toFixed(1)}%)`);
      progressCallback?.(`    Tier distribution: LOW=${metrics.tierDistribution.low}, RAMP=${metrics.tierDistribution.ramp}, RATED=${metrics.tierDistribution.rated}, HIGH=${metrics.tierDistribution.high}`);
    }

    models.set(stationCode, model);
  }

  if (stationCount > 0) {
    const avgMrecMAPE = totalMrecMAPE / stationCount;
    const avgHybridMAPE = totalHybridMAPE / stationCount;
    const overallImprovement = ((avgMrecMAPE - avgHybridMAPE) / avgMrecMAPE) * 100;

    progressCallback?.(`\nOverall Results (4-Tier Hybrid - ${modelType}):`);
    progressCallback?.(`  MREC-only avg MAPE:    ${avgMrecMAPE.toFixed(1)}%`);
    progressCallback?.(`  4-Tier Hybrid MAPE:    ${avgHybridMAPE.toFixed(1)}%`);
    progressCallback?.(`  Improvement:           ${overallImprovement.toFixed(1)}%`);
  }

  return models;
}
