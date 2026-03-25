/**
 * SolarMRECHybridModel - iPool MREC Base + ML Residual Learning
 *
 * Combines the best of both approaches:
 * 1. MREC Base: Per-station calibrated three-tier piecewise linear (iPool style)
 * 2. ML Residual: Learns corrections from cloud cover, temporal patterns, etc.
 *
 * This should capture:
 * - Per-station efficiency/degradation differences (via MREC calibration)
 * - Weather effects beyond irradiance (via ML residual)
 */

import { SolarMRECModel, SolarMRECCalibrationData, SolarMRECFactors } from '../SolarMRECModel.js';
import { CFacTrainingSample, CFacWeatherFeatures } from '../../../types/capacityFactor.js';
import MultivariateLinearRegression from 'ml-regression-multivariate-linear';

export interface SolarMRECHybridFactors extends SolarMRECFactors {
  residualModelTrained: boolean;
  residualStats?: {
    trainMAPE: number;
    trainR2: number;
    sampleCount: number;
  };
}

export class SolarMRECHybridModel {
  private stationCode: string;
  private mrecModel: SolarMRECModel;
  private residualModel: MultivariateLinearRegression | null = null;
  private factors: SolarMRECHybridFactors | null = null;

  constructor(stationCode: string) {
    this.stationCode = stationCode;
    this.mrecModel = new SolarMRECModel(stationCode);
  }

  /**
   * Calibrate MREC factors from historical capacity factor + irradiance data
   * This is Step 1: Learn per-station conversion factors
   *
   * @param data - Array of (datetime, stationCode, capacityFactor, solarIrradiance) records
   * @returns Calibrated MREC factors
   */
  calibrateMREC(data: SolarMRECCalibrationData[]): SolarMRECFactors {
    return this.mrecModel.calibrate(data);
  }

  /**
   * Train ML residual model on top of MREC base
   * This is Step 2: Learn corrections from weather features
   *
   * residual = actual_CFac - MREC_prediction
   *
   * @param samples - Training samples with weather data
   * @param asymmetricLoss - If true, penalize under-predictions more (2:1 ratio)
   * @returns Training metrics
   */
  trainResidual(samples: CFacTrainingSample[], asymmetricLoss: boolean = false): { mape: number; r2Score: number } {
    if (!this.mrecModel.isCalibrated()) {
      throw new Error(`MREC not calibrated for station ${this.stationCode}. Call calibrateMREC first.`);
    }

    // Filter for this station
    const stationSamples = samples.filter(s => s.stationCode === this.stationCode);

    if (stationSamples.length < 10) {
      console.warn(`Insufficient samples for ${this.stationCode}: ${stationSamples.length}`);
      return { mape: Infinity, r2Score: 0 };
    }

    // Prepare training data
    const X: number[][] = [];
    const Y: number[][] = [];

    for (const sample of stationSamples) {
      // Skip nighttime samples (allow 5 AM to 7 PM for seasonal variation)
      if (sample.hour < 5 || sample.hour > 19 || sample.weather.solarRadiation <= 0) {
        continue;
      }

      // Get MREC base prediction
      const mrecPred = this.mrecModel.predict(sample.weather.solarRadiation);

      // Calculate residual
      const residual = sample.actualCFac - mrecPred;

      // Extract features for residual prediction
      const features = this.extractResidualFeatures(sample, mrecPred);

      X.push(features);
      Y.push([residual]);

      // Asymmetric loss: duplicate under-prediction samples
      if (asymmetricLoss && residual > 0 && sample.actualCFac > 0.1) {
        X.push([...features]);
        Y.push([residual]);
      }
    }

    if (X.length < 10) {
      console.warn(`Insufficient daylight samples for ${this.stationCode}: ${X.length}`);
      return { mape: Infinity, r2Score: 0 };
    }

    // Train residual model
    this.residualModel = new MultivariateLinearRegression(X, Y);

    // Calculate training metrics
    let totalAbsError = 0;
    let totalPercentError = 0;
    let validCount = 0;
    let ssRes = 0;
    let ssTot = 0;
    const meanActual = stationSamples.reduce((sum, s) => sum + s.actualCFac, 0) / stationSamples.length;

    for (const sample of stationSamples) {
      if (sample.hour < 5 || sample.hour > 19 || sample.weather.solarRadiation <= 0) {
        continue;
      }

      const predicted = this.predict(sample.weather, sample.datetime);
      const actual = sample.actualCFac;
      const error = Math.abs(predicted - actual);

      totalAbsError += error;

      if (actual > 0.01) {
        totalPercentError += (error / actual) * 100;
        validCount++;
      }

      ssRes += Math.pow(predicted - actual, 2);
      ssTot += Math.pow(actual - meanActual, 2);
    }

    const mape = validCount > 0 ? totalPercentError / validCount : Infinity;
    const r2Score = ssTot > 0 ? 1 - (ssRes / ssTot) : 0;

    // Update factors with residual stats
    const mrecFactors = this.mrecModel.getFactors();
    if (mrecFactors) {
      this.factors = {
        ...mrecFactors,
        residualModelTrained: true,
        residualStats: {
          trainMAPE: mape,
          trainR2: r2Score,
          sampleCount: X.length,
        },
      };
    }

    return { mape, r2Score };
  }

  /**
   * Extract features for residual prediction
   */
  private extractResidualFeatures(sample: CFacTrainingSample, mrecPred: number): number[] {
    const features: number[] = [];
    const weather = sample.weather;

    // Solar radiation (normalized)
    features.push(weather.solarRadiation / 1000);

    // Cloud cover (normalized) - key for residual learning
    features.push(weather.cloudCover / 100);

    // Temperature (normalized)
    features.push(weather.temperature / 50);

    // Temporal features (cyclical)
    const hourRad = (sample.hour * 2 * Math.PI) / 24;
    features.push(Math.sin(hourRad));
    features.push(Math.cos(hourRad));

    // Month (normalized)
    features.push(sample.month / 12);

    // MREC base prediction (important feature)
    features.push(mrecPred);

    // Humidity if available (affects panel efficiency)
    if (weather.humidity !== undefined) {
      features.push(weather.humidity / 100);
    } else {
      features.push(0.5); // Default
    }

    // UV index if available (clear sky indicator)
    if (weather.uvIndex !== undefined) {
      features.push(weather.uvIndex / 11);
    } else {
      features.push(0.5);
    }

    return features;
  }

  /**
   * Predict capacity factor
   * CFac = MREC_base + ML_residual, clamped to [0, 1]
   *
   * @param weather - Weather features
   * @param datetime - For temporal features
   * @returns Predicted capacity factor
   */
  predict(weather: CFacWeatherFeatures, datetime: Date): number {
    const hour = datetime.getHours();

    // Night time (allow 5 AM to 7 PM for seasonal variation)
    if (hour < 5 || hour > 19 || weather.solarRadiation <= 0) {
      return 0;
    }

    // MREC base prediction
    const mrecPred = this.mrecModel.predict(weather.solarRadiation);

    // If no residual model, return MREC-only
    if (!this.residualModel) {
      return mrecPred;
    }

    // Create temp sample for feature extraction
    const tempSample: CFacTrainingSample = {
      datetime,
      stationCode: this.stationCode,
      stationType: 'solar' as any,
      actualCFac: 0,
      weather,
      hour,
      dayOfWeek: datetime.getDay(),
      month: datetime.getMonth() + 1,
      isWeekend: datetime.getDay() === 0 || datetime.getDay() === 6,
    };

    // Extract features and predict residual
    const features = this.extractResidualFeatures(tempSample, mrecPred);
    const residual = this.residualModel.predict(features)[0];

    // Combine and clamp
    const prediction = mrecPred + residual;
    return Math.max(0, Math.min(1, prediction));
  }

  /**
   * Get MREC-only prediction (no ML residual)
   */
  predictMRECOnly(solarRadiation: number): number {
    return this.mrecModel.predict(solarRadiation);
  }

  /**
   * Check if fully trained (MREC + residual)
   */
  isReady(): boolean {
    return this.mrecModel.isCalibrated() && this.residualModel !== null;
  }

  /**
   * Check if MREC is calibrated
   */
  isMRECCalibrated(): boolean {
    return this.mrecModel.isCalibrated();
  }

  /**
   * Get station code
   */
  getStationCode(): string {
    return this.stationCode;
  }

  /**
   * Get factors
   */
  getFactors(): SolarMRECHybridFactors | null {
    return this.factors;
  }

  /**
   * Get MREC factors
   */
  getMRECFactors(): SolarMRECFactors | null {
    return this.mrecModel.getFactors();
  }
}

/**
 * Batch calibrate and train SolarMRECHybrid models
 *
 * @param mrecData - MREC calibration data (CF + irradiance pairs)
 * @param trainingSamples - Full training samples with weather
 * @param asymmetricLoss - Use asymmetric loss for residual training
 * @param progressCallback - Progress callback
 * @returns Map of station code to trained model
 */
export async function calibrateAllSolarMRECHybrid(
  mrecData: SolarMRECCalibrationData[],
  trainingSamples: CFacTrainingSample[],
  asymmetricLoss: boolean = false,
  progressCallback?: (msg: string) => void
): Promise<Map<string, SolarMRECHybridModel>> {
  // Group MREC data by station
  const stationMRECData = new Map<string, SolarMRECCalibrationData[]>();
  for (const d of mrecData) {
    if (!stationMRECData.has(d.stationCode)) {
      stationMRECData.set(d.stationCode, []);
    }
    stationMRECData.get(d.stationCode)!.push(d);
  }

  progressCallback?.(`Calibrating Solar MREC+Hybrid for ${stationMRECData.size} stations`);

  const models = new Map<string, SolarMRECHybridModel>();
  let mrecCalibrated = 0;
  let residualTrained = 0;

  for (const [stationCode, data] of stationMRECData) {
    const model = new SolarMRECHybridModel(stationCode);

    // Step 1: Calibrate MREC
    const mrecFactors = model.calibrateMREC(data);

    if (mrecFactors.calibrated) {
      mrecCalibrated++;
      progressCallback?.(`  ${stationCode}: MREC calibrated (irrH=${mrecFactors.irrH.toFixed(0)}, irrL=${mrecFactors.irrL.toFixed(0)})`);

      // Step 2: Train residual model
      const stationSamples = trainingSamples.filter(s => s.stationCode === stationCode);
      if (stationSamples.length >= 10) {
        const metrics = model.trainResidual(stationSamples, asymmetricLoss);
        if (metrics.mape < Infinity) {
          residualTrained++;
          progressCallback?.(`    + Residual trained: MAPE=${metrics.mape.toFixed(1)}%, R²=${metrics.r2Score.toFixed(3)}`);
        }
      }
    } else {
      progressCallback?.(`  ${stationCode}: MREC calibration failed (insufficient data: ${data.length})`);
    }

    models.set(stationCode, model);
  }

  progressCallback?.(`\nCalibration complete: ${mrecCalibrated} MREC calibrated, ${residualTrained} residual trained`);

  return models;
}
