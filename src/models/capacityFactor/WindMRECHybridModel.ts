/**
 * WindMRECHybridModel - Combines MREC base prediction with ML residual learning
 *
 * Architecture:
 * 1. MREC provides three-tier piecewise base prediction (calibrated from historical data)
 * 2. ML learns residual correction accounting for:
 *    - Temporal patterns (diurnal wind variations)
 *    - Atmospheric stability proxies (temperature, gust ratio)
 *    - Persistence (lag features)
 *    - Tier-specific adjustments
 *
 * Final prediction: CF = clamp(MREC_base + ML_residual, 0, 1)
 *                   If CF > 1.1: return 0 (high wind cutout)
 */

import MultivariateLinearRegression from 'ml-regression-multivariate-linear';
import {
  MRECFactors,
  MRECCalibrationData,
  StationType,
  CFacWeatherFeatures,
  CFacTrainingSample,
} from '../../types/capacityFactor.js';
import { WindMRECModel } from './legacy/WindMRECModel.js';

export interface MRECHybridMetrics {
  stationCode: string;
  mrecOnlyMAPE: number;
  hybridMAPE: number;
  improvement: number;  // percentage reduction in MAPE
  residualR2: number;
  sampleCount: number;
}

export class WindMRECHybridModel {
  private stationCode: string;
  private mrecModel: WindMRECModel;
  private residualModel: MultivariateLinearRegression | null = null;

  // Lag tracking for predictions
  private lagCF1h: number | null = null;
  private lagCF24h: number | null = null;
  private lastPredictionTime: number | null = null;

  // Feature names for debugging
  private static readonly RESIDUAL_FEATURE_NAMES = [
    'mrec_base',
    'tier_H',
    'tier_M',
    'hour_sin',
    'hour_cos',
    'month_sin',
    'month_cos',
    'temp_norm',
    'gust_ratio',
    'cloud_cover',
    'wind_speed_norm',
  ];

  constructor(stationCode: string) {
    this.stationCode = stationCode;
    this.mrecModel = new WindMRECModel(stationCode);
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
   * Build feature vector for residual model
   */
  private buildResidualFeatures(
    mrecBase: number,
    weather: CFacWeatherFeatures,
    datetime: Date
  ): number[] {
    const tier = this.getTier(weather.windSpeed100 ?? weather.windSpeed);
    const hour = datetime.getHours();
    const month = datetime.getMonth() + 1;  // 1-12

    // Gust ratio: indicates turbulence
    const gustRatio = weather.windGust && weather.windSpeed > 0.1
      ? weather.windGust / weather.windSpeed
      : 1.0;

    return [
      mrecBase,                                          // MREC base prediction
      tier === 'H' ? 1 : 0,                             // High tier indicator
      tier === 'M' ? 1 : 0,                             // Mid tier indicator
      Math.sin(2 * Math.PI * hour / 24),                // Hour sine
      Math.cos(2 * Math.PI * hour / 24),                // Hour cosine
      Math.sin(2 * Math.PI * month / 12),               // Month sine
      Math.cos(2 * Math.PI * month / 12),               // Month cosine
      (weather.temperature ?? 25) / 50,                  // Normalized temperature
      Math.min(gustRatio, 3),                           // Capped gust ratio
      (weather.cloudCover ?? 50) / 100,                 // Cloud cover 0-1
      (weather.windSpeed100 ?? weather.windSpeed) / 30, // Normalized wind speed
    ];
  }

  /**
   * Train the residual model from historical samples
   *
   * @param samples - Training samples with actual capacity factors
   * @returns Training metrics
   */
  trainResidual(samples: CFacTrainingSample[]): MRECHybridMetrics {
    // Filter samples for this station
    const stationSamples = samples.filter(s => s.stationCode === this.stationCode);

    if (stationSamples.length < 50) {
      console.warn(`Insufficient samples for ${this.stationCode}: ${stationSamples.length}`);
      return {
        stationCode: this.stationCode,
        mrecOnlyMAPE: 0,
        hybridMAPE: 0,
        improvement: 0,
        residualR2: 0,
        sampleCount: stationSamples.length,
      };
    }

    // Build training data: (features, residual)
    const featureMatrix: number[][] = [];
    const residuals: number[] = [];
    let mrecErrorSum = 0;
    let validMrecCount = 0;

    for (const sample of stationSamples) {
      const windSpeed = sample.weather.windSpeed100 ?? sample.weather.windSpeed;
      const mrecPred = this.mrecModel.predict(windSpeed);
      const actual = sample.actualCFac;
      const residual = actual - mrecPred;

      const features = this.buildResidualFeatures(mrecPred, sample.weather, sample.datetime);
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
      // Convert residuals to 2D array for the regression library
      const residuals2D = residuals.map(r => [r]);
      this.residualModel = new MultivariateLinearRegression(featureMatrix, residuals2D);
    } catch (error: any) {
      console.warn(`Failed to train residual model for ${this.stationCode}: ${error.message}`);
      return {
        stationCode: this.stationCode,
        mrecOnlyMAPE,
        hybridMAPE: mrecOnlyMAPE,
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
      const windSpeed = sample.weather.windSpeed100 ?? sample.weather.windSpeed;
      const mrecPred = this.mrecModel.predict(windSpeed);
      const features = featureMatrix[i];

      // Predict residual
      const predictedResidual = this.residualModel!.predict([features])[0][0];
      let hybridPred = mrecPred + predictedResidual;

      // High wind cutout
      if (hybridPred > 1.1) hybridPred = 0;
      hybridPred = Math.max(0, Math.min(1, hybridPred));

      const actual = sample.actualCFac;

      // Hybrid MAPE
      if (actual > 0.01) {
        hybridErrorSum += Math.abs((hybridPred - actual) / actual);
        validHybridCount++;
      }

      // R² calculation for residual prediction
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
    };
  }

  /**
   * Predict capacity factor using hybrid model
   *
   * @param weather - Weather features including wind speed
   * @param datetime - Prediction datetime
   * @returns Predicted capacity factor [0, 1]
   */
  predict(weather: CFacWeatherFeatures, datetime: Date): number {
    const windSpeed = weather.windSpeed100 ?? weather.windSpeed;

    // Get MREC base prediction
    const mrecBase = this.mrecModel.predict(windSpeed);

    // If no residual model, return MREC-only
    if (!this.residualModel) {
      return mrecBase;
    }

    // Build features and predict residual
    const features = this.buildResidualFeatures(mrecBase, weather, datetime);
    const residual = this.residualModel.predict([features])[0][0];

    // Combine
    let finalPred = mrecBase + residual;

    // High wind cutout (from iPool)
    if (finalPred > 1.1) {
      return 0;
    }

    // Clamp to valid range
    finalPred = Math.max(0, Math.min(1, finalPred));

    // Update lag tracking
    const currentTime = datetime.getTime();
    if (this.lastPredictionTime !== null) {
      const hoursDiff = (currentTime - this.lastPredictionTime) / (1000 * 60 * 60);
      if (Math.abs(hoursDiff - 1) < 0.1) {
        this.lagCF24h = this.lagCF1h;
        this.lagCF1h = finalPred;
      }
    }
    this.lastPredictionTime = currentTime;

    return finalPred;
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
    return this.residualModel !== null;
  }

  /**
   * Check if MREC is calibrated
   */
  isMRECCalibrated(): boolean {
    return this.mrecModel.isCalibrated();
  }

  /**
   * Reset lag tracking (call when starting a new forecast sequence)
   */
  resetLags(): void {
    this.lagCF1h = null;
    this.lagCF24h = null;
    this.lastPredictionTime = null;
  }
}

/**
 * Train MREC-ML Hybrid models for all wind stations
 */
export async function trainAllMRECHybrid(
  mrecFactors: MRECFactors[],
  samples: CFacTrainingSample[],
  progressCallback?: (msg: string) => void
): Promise<Map<string, WindMRECHybridModel>> {
  const models = new Map<string, WindMRECHybridModel>();

  progressCallback?.(`Training MREC-ML Hybrid for ${mrecFactors.length} wind stations`);

  let totalMrecMAPE = 0;
  let totalHybridMAPE = 0;
  let stationCount = 0;

  for (let i = 0; i < mrecFactors.length; i++) {
    const factors = mrecFactors[i];
    progressCallback?.(`  [${i + 1}/${mrecFactors.length}] Training ${factors.stationCode}...`);

    const model = new WindMRECHybridModel(factors.stationCode);
    model.loadMRECFactors(factors);

    const metrics = model.trainResidual(samples);

    if (metrics.sampleCount >= 50) {
      totalMrecMAPE += metrics.mrecOnlyMAPE;
      totalHybridMAPE += metrics.hybridMAPE;
      stationCount++;

      progressCallback?.(`    MREC MAPE: ${metrics.mrecOnlyMAPE.toFixed(1)}% → Hybrid MAPE: ${metrics.hybridMAPE.toFixed(1)}% (${metrics.improvement > 0 ? '+' : ''}${metrics.improvement.toFixed(1)}% improvement)`);
    }

    models.set(factors.stationCode, model);
  }

  if (stationCount > 0) {
    const avgMrecMAPE = totalMrecMAPE / stationCount;
    const avgHybridMAPE = totalHybridMAPE / stationCount;
    const overallImprovement = ((avgMrecMAPE - avgHybridMAPE) / avgMrecMAPE) * 100;

    progressCallback?.(`\n📊 Overall Results:`);
    progressCallback?.(`   MREC-only avg MAPE: ${avgMrecMAPE.toFixed(1)}%`);
    progressCallback?.(`   Hybrid avg MAPE:    ${avgHybridMAPE.toFixed(1)}%`);
    progressCallback?.(`   Improvement:        ${overallImprovement.toFixed(1)}%`);
  }

  return models;
}
