/**
 * WindBiasCorrectionModel - Linear Bias Correction for Wind Capacity Factor Forecasting
 *
 * Purpose: Apply simple multiplicative scale factor and offset to correct systematic
 * underestimation bias in MREC base predictions.
 *
 * Formula:
 *   CF_corrected = CF_base × scale_factor + offset
 *
 * Where scale_factor and offset are calibrated using least squares linear regression
 * to minimize error against historical data.
 *
 * This approach is simpler than hybrid models and focuses purely on correcting
 * systematic bias rather than learning complex weather interactions.
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
 * Bias correction factors for a single station
 */
export interface BiasCorrectionFactors {
  stationCode: string;
  stationType: StationType;
  scaleFactor: number;      // Multiplicative correction
  offset: number;           // Additive correction
  calibrated: boolean;
  calibrationDate?: Date;
  sampleCount?: number;

  // Statistics from calibration
  stats?: {
    baseMean: number;       // Mean of MREC predictions
    baseStdDev: number;     // Std dev of MREC predictions
    actualMean: number;     // Mean of actual values
    actualStdDev: number;   // Std dev of actual values
    r2: number;             // R² of linear fit
  };
}

/**
 * Metrics from bias correction calibration
 */
export interface BiasCorrectionMetrics {
  stationCode: string;
  baseMAPE: number;         // MREC-only MAPE
  correctedMAPE: number;    // After bias correction MAPE
  improvement: number;       // Percentage improvement
  scaleFactor: number;
  offset: number;
  r2: number;
  sampleCount: number;
}

export class WindBiasCorrectionModel {
  private stationCode: string;
  private mrecModel: WindMRECModel;
  private correctionFactors: BiasCorrectionFactors | null = null;

  constructor(stationCode: string) {
    this.stationCode = stationCode;
    this.mrecModel = new WindMRECModel(stationCode);
  }

  /**
   * Get station code
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
   * Calibrate bias correction factors using linear regression
   *
   * Fits: actual = scale × predicted + offset
   * Using ordinary least squares regression
   *
   * @param samples - Training samples with actual capacity factors
   * @returns Calibration metrics
   */
  calibrate(samples: CFacTrainingSample[]): BiasCorrectionMetrics {
    // Filter samples for this station
    const stationSamples = samples.filter(s => s.stationCode === this.stationCode);

    if (stationSamples.length < 50) {
      console.warn(`Insufficient samples for ${this.stationCode}: ${stationSamples.length}`);
      return {
        stationCode: this.stationCode,
        baseMAPE: 0,
        correctedMAPE: 0,
        improvement: 0,
        scaleFactor: 1.0,
        offset: 0.0,
        r2: 0,
        sampleCount: stationSamples.length,
      };
    }

    // Step 1: Generate MREC base predictions
    const basePredictions: number[] = [];
    const actuals: number[] = [];

    for (const sample of stationSamples) {
      const windSpeed = sample.weather.windSpeed100 ??
                       sample.weather.windSpeed80 ??
                       sample.weather.windSpeed50 ??
                       sample.weather.windSpeed;

      const basePred = this.mrecModel.predict(windSpeed);
      basePredictions.push(basePred);
      actuals.push(sample.actualCFac);
    }

    // Step 2: Calculate statistics for diagnostics
    const baseMean = basePredictions.reduce((a, b) => a + b, 0) / basePredictions.length;
    const actualMean = actuals.reduce((a, b) => a + b, 0) / actuals.length;

    const baseVariance = basePredictions.reduce((sum, val) => sum + (val - baseMean) ** 2, 0) / basePredictions.length;
    const actualVariance = actuals.reduce((sum, val) => sum + (val - actualMean) ** 2, 0) / actuals.length;

    const baseStdDev = Math.sqrt(baseVariance);
    const actualStdDev = Math.sqrt(actualVariance);

    // Step 3: Linear regression using least squares
    // Minimize: sum((actual - (scale * predicted + offset))^2)
    //
    // Solution:
    //   scale = cov(predicted, actual) / var(predicted)
    //   offset = mean(actual) - scale * mean(predicted)

    let covariance = 0;
    for (let i = 0; i < basePredictions.length; i++) {
      covariance += (basePredictions[i] - baseMean) * (actuals[i] - actualMean);
    }
    covariance /= basePredictions.length;

    let scaleFactor = 1.0;
    let offset = 0.0;

    if (baseVariance > 1e-10) {
      scaleFactor = covariance / baseVariance;
      offset = actualMean - scaleFactor * baseMean;
    } else {
      // Fallback: no variance in predictions, use mean adjustment only
      offset = actualMean - baseMean;
    }

    // Step 4: Calculate R² for the linear fit
    let totalSS = 0;
    let residualSS = 0;

    for (let i = 0; i < actuals.length; i++) {
      const predicted = scaleFactor * basePredictions[i] + offset;
      residualSS += (actuals[i] - predicted) ** 2;
      totalSS += (actuals[i] - actualMean) ** 2;
    }

    const r2 = totalSS > 0 ? 1 - (residualSS / totalSS) : 0;

    // Step 5: Evaluate MAPE before and after correction
    let baseMAPESum = 0;
    let correctedMAPESum = 0;
    let validCount = 0;

    for (let i = 0; i < basePredictions.length; i++) {
      const actual = actuals[i];
      const basePred = basePredictions[i];

      // Apply bias correction with clamping
      let correctedPred = scaleFactor * basePred + offset;

      // High wind cutout (from iPool)
      if (correctedPred > 1.1) {
        correctedPred = 0;
      } else {
        correctedPred = Math.max(0, Math.min(1, correctedPred));
      }

      // Calculate MAPE (only for non-zero actuals)
      if (actual > 0.01) {
        baseMAPESum += Math.abs((basePred - actual) / actual);
        correctedMAPESum += Math.abs((correctedPred - actual) / actual);
        validCount++;
      }
    }

    const baseMAPE = validCount > 0 ? (baseMAPESum / validCount) * 100 : 0;
    const correctedMAPE = validCount > 0 ? (correctedMAPESum / validCount) * 100 : 0;
    const improvement = baseMAPE > 0 ? ((baseMAPE - correctedMAPE) / baseMAPE) * 100 : 0;

    // Step 6: Store calibrated factors
    this.correctionFactors = {
      stationCode: this.stationCode,
      stationType: StationType.WIND,
      scaleFactor,
      offset,
      calibrated: true,
      calibrationDate: new Date(),
      sampleCount: stationSamples.length,
      stats: {
        baseMean,
        baseStdDev,
        actualMean,
        actualStdDev,
        r2,
      },
    };

    return {
      stationCode: this.stationCode,
      baseMAPE,
      correctedMAPE,
      improvement,
      scaleFactor,
      offset,
      r2,
      sampleCount: stationSamples.length,
    };
  }

  /**
   * Load pre-calibrated bias correction factors
   */
  loadCorrectionFactors(factors: BiasCorrectionFactors): void {
    this.correctionFactors = factors;
  }

  /**
   * Get calibrated correction factors
   */
  getCorrectionFactors(): BiasCorrectionFactors | null {
    return this.correctionFactors;
  }

  /**
   * Predict capacity factor with bias correction
   *
   * @param weather - Weather features
   * @param _datetime - Not used (kept for interface compatibility)
   * @returns Predicted capacity factor [0, 1]
   */
  predict(weather: CFacWeatherFeatures, _datetime?: Date): number {
    // Get optimal wind speed (prefer hub height)
    const windSpeed = weather.windSpeed100 ??
                     weather.windSpeed80 ??
                     weather.windSpeed50 ??
                     weather.windSpeed;

    // Get MREC base prediction
    const basePred = this.mrecModel.predict(windSpeed);

    // If no correction factors calibrated, return MREC-only
    if (!this.correctionFactors || !this.correctionFactors.calibrated) {
      return basePred;
    }

    // Apply bias correction: corrected = base × scale + offset
    let correctedPred = this.correctionFactors.scaleFactor * basePred + this.correctionFactors.offset;

    // High wind cutout (from iPool)
    if (correctedPred > 1.1) {
      return 0;
    }

    // Clamp to valid range [0, 1]
    return Math.max(0, Math.min(1, correctedPred));
  }

  /**
   * Get MREC-only prediction (for comparison)
   */
  predictMRECOnly(windSpeed: number): number {
    return this.mrecModel.predict(windSpeed);
  }

  /**
   * Check if bias correction is calibrated
   */
  isCalibrated(): boolean {
    return this.correctionFactors?.calibrated ?? false;
  }

  /**
   * Check if MREC is calibrated
   */
  isMRECCalibrated(): boolean {
    return this.mrecModel.isCalibrated();
  }

  /**
   * Serialize correction factors for database storage
   */
  toJSON(): string {
    if (!this.correctionFactors) {
      throw new Error('No correction factors to serialize');
    }
    return JSON.stringify(this.correctionFactors);
  }

  /**
   * Load correction factors from JSON string
   */
  fromJSON(json: string): void {
    const parsed = JSON.parse(json) as BiasCorrectionFactors;
    if (parsed.calibrationDate) {
      parsed.calibrationDate = new Date(parsed.calibrationDate);
    }
    this.correctionFactors = parsed;
  }
}

/**
 * Batch calibrate bias correction models for multiple stations
 *
 * @param mrecFactors - Pre-calibrated MREC factors for all stations
 * @param samples - All training samples (will be grouped by station)
 * @param progressCallback - Optional progress callback
 * @returns Map of station code to calibrated model
 */
export async function calibrateAllBiasCorrection(
  mrecFactors: MRECFactors[],
  samples: CFacTrainingSample[],
  progressCallback?: (msg: string) => void
): Promise<Map<string, WindBiasCorrectionModel>> {
  const models = new Map<string, WindBiasCorrectionModel>();

  progressCallback?.(`Calibrating Bias Correction for ${mrecFactors.length} wind stations`);

  let totalBaseMAPE = 0;
  let totalCorrectedMAPE = 0;
  let calibratedCount = 0;

  for (let i = 0; i < mrecFactors.length; i++) {
    const factors = mrecFactors[i];
    progressCallback?.(`  [${i + 1}/${mrecFactors.length}] Calibrating ${factors.stationCode}...`);

    const model = new WindBiasCorrectionModel(factors.stationCode);
    model.loadMRECFactors(factors);

    const metrics = model.calibrate(samples);

    if (metrics.sampleCount >= 50) {
      totalBaseMAPE += metrics.baseMAPE;
      totalCorrectedMAPE += metrics.correctedMAPE;
      calibratedCount++;

      progressCallback?.(`    MREC MAPE: ${metrics.baseMAPE.toFixed(1)}% → Bias-Corrected: ${metrics.correctedMAPE.toFixed(1)}% (${metrics.improvement > 0 ? '+' : ''}${metrics.improvement.toFixed(1)}%)`);
      progressCallback?.(`    Correction: CF_corrected = ${metrics.scaleFactor.toFixed(4)} × CF_base + ${metrics.offset.toFixed(4)}`);
      progressCallback?.(`    R²: ${metrics.r2.toFixed(4)}`);
    } else {
      progressCallback?.(`    Insufficient samples: ${metrics.sampleCount}`);
    }

    models.set(factors.stationCode, model);
  }

  if (calibratedCount > 0) {
    const avgBaseMAPE = totalBaseMAPE / calibratedCount;
    const avgCorrectedMAPE = totalCorrectedMAPE / calibratedCount;
    const overallImprovement = ((avgBaseMAPE - avgCorrectedMAPE) / avgBaseMAPE) * 100;

    progressCallback?.(`\nOverall Results (Bias Correction):`);
    progressCallback?.(`   MREC-only avg MAPE:         ${avgBaseMAPE.toFixed(1)}%`);
    progressCallback?.(`   Bias-Corrected MAPE:        ${avgCorrectedMAPE.toFixed(1)}%`);
    progressCallback?.(`   Average Improvement:        ${overallImprovement.toFixed(1)}%`);
    progressCallback?.(`   Stations Calibrated:        ${calibratedCount}/${mrecFactors.length}`);
  }

  return models;
}
