/**
 * WindEnhancedHybridModel - MREC base with multiplicative correction and physics boost
 *
 * Key Improvements over WindWeatherHybridModel:
 * 1. Uses MULTIPLICATIVE correction instead of additive (scales proportionally)
 * 2. Incorporates physics-based power boost (P ∝ v³ vs linear MREC)
 * 3. No hard cutoffs - smooth transitions to avoid artificial dips
 * 4. Learns a boost factor to address systematic underestimation
 *
 * Architecture:
 * 1. MREC provides robust three-tier base prediction (good shape)
 * 2. Physics boost applies cubic power law correction
 * 3. ML learns multiplicative correction from weather features
 * 4. Final: CF = MREC_base × physics_boost × ml_correction
 */

import MultivariateLinearRegression from 'ml-regression-multivariate-linear';
import {
  MRECFactors,
  CFacWeatherFeatures,
  CFacTrainingSample,
} from '../../../types/capacityFactor.js';
import { WindMRECModel } from './WindMRECModel.js';

export interface EnhancedHybridFactors {
  stationCode: string;
  // Physics boost parameters
  physicsBoostEnabled: boolean;
  ratedWindSpeed: number;      // Wind speed at which turbine reaches rated power
  boostExponent: number;       // Exponent for power law boost (default ~0.5)
  // Multiplicative correction parameters
  baseMultiplier: number;      // Global scaling factor to address underestimation
  // Fallback flag - if true, use MREC only (ML made things worse)
  useMRECOnly: boolean;
  // Statistics
  meanActualCF: number;
  meanPredictedCF: number;
  correctionRatio: number;     // meanActual / meanPredicted
}

export interface EnhancedHybridMetrics {
  stationCode: string;
  mrecOnlyMAPE: number;
  enhancedMAPE: number;
  improvement: number;
  correctionRatio: number;
  sampleCount: number;
}

export class WindEnhancedHybridModel {
  private stationCode: string;
  private mrecModel: WindMRECModel;
  private residualModel: MultivariateLinearRegression | null = null;
  private factors: EnhancedHybridFactors | null = null;

  // Feature names for ML correction
  private static readonly FEATURE_NAMES = [
    'mrec_base',           // MREC prediction as anchor
    'wind_normalized',     // Wind speed / rated speed
    'gust_normalized',     // Gust speed / rated speed (key for peaks)
    'gust_ratio',          // Turbulence indicator
    'temp_deviation',      // Air density proxy
    'cloud_cover',         // Atmospheric conditions
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
   * Get MREC factors
   */
  getMRECFactors(): MRECFactors | null {
    return this.mrecModel.getFactors();
  }

  /**
   * Get enhanced factors
   */
  getEnhancedFactors(): EnhancedHybridFactors | null {
    return this.factors;
  }

  /**
   * Get optimal wind speed from weather features
   */
  private getWindSpeed(weather: CFacWeatherFeatures): number {
    return weather.windSpeed100 ?? weather.windSpeed80 ?? weather.windSpeed50 ?? weather.windSpeed;
  }

  /**
   * Apply physics-based boost
   *
   * Wind power is proportional to v³, but MREC uses linear relationship.
   * This applies a smooth boost that increases with wind speed.
   *
   * boost = 1 + boostExponent × (v / v_rated)^2
   *
   * This gives higher boost at higher winds without hard cutoffs.
   */
  private applyPhysicsBoost(mrecBase: number, windSpeed: number): number {
    if (!this.factors || !this.factors.physicsBoostEnabled) {
      return mrecBase;
    }

    const ratedSpeed = this.factors.ratedWindSpeed;
    const exponent = this.factors.boostExponent;

    // Smooth quadratic boost (from cubic vs linear difference)
    const normalizedWind = Math.min(windSpeed / ratedSpeed, 2.0); // Cap at 2x rated
    const boost = 1 + exponent * normalizedWind * normalizedWind;

    return mrecBase * boost;
  }

  /**
   * Build feature vector for ML correction (multiplicative)
   */
  private buildFeatures(mrecBase: number, weather: CFacWeatherFeatures): number[] {
    const windSpeed = this.getWindSpeed(weather);
    const ratedSpeed = this.factors?.ratedWindSpeed ?? 15;
    const gustSpeed = weather.windGust ?? windSpeed;

    // Gust ratio: indicates turbulence
    const gustRatio = weather.windGust && windSpeed > 0.1
      ? Math.min(weather.windGust / windSpeed, 3)
      : 1.0;

    // Temperature deviation from standard (affects air density)
    const tempDeviation = ((weather.temperature ?? 25) - 25) / 20;

    return [
      mrecBase,                              // MREC prediction as anchor
      windSpeed / ratedSpeed,                // Normalized wind speed
      gustSpeed / ratedSpeed,                // Normalized gust speed (key for peaks)
      gustRatio,                             // Turbulence indicator
      tempDeviation,                         // Air density proxy
      (weather.cloudCover ?? 50) / 100,      // Atmospheric conditions
    ];
  }

  /**
   * Train the enhanced hybrid model
   *
   * @param samples - Training samples with actual capacity factors
   * @param asymmetricLoss - If true, penalize under-predictions more heavily (2:1 ratio)
   * @returns Training metrics
   */
  train(samples: CFacTrainingSample[], asymmetricLoss: boolean = false): EnhancedHybridMetrics {
    const stationSamples = samples.filter(s => s.stationCode === this.stationCode);

    if (stationSamples.length < 50) {
      console.warn(`Insufficient samples for ${this.stationCode}: ${stationSamples.length}`);
      return this.createEmptyMetrics(stationSamples.length);
    }

    // Step 1: Calculate MREC predictions and statistics
    let mrecSum = 0;
    let actualSum = 0;
    let mrecErrorSum = 0;
    let validCount = 0;
    const mrecPredictions: number[] = [];
    const actualValues: number[] = [];
    const windSpeeds: number[] = [];

    for (const sample of stationSamples) {
      const windSpeed = this.getWindSpeed(sample.weather);
      const mrecPred = this.mrecModel.predict(windSpeed);
      const actual = sample.actualCFac;

      mrecPredictions.push(mrecPred);
      actualValues.push(actual);
      windSpeeds.push(windSpeed);

      mrecSum += mrecPred;
      actualSum += actual;

      if (actual > 0.01) {
        mrecErrorSum += Math.abs((mrecPred - actual) / actual);
        validCount++;
      }
    }

    const mrecOnlyMAPE = validCount > 0 ? (mrecErrorSum / validCount) * 100 : 0;
    const meanMrec = mrecSum / stationSamples.length;
    const meanActual = actualSum / stationSamples.length;

    // Step 2: Calculate correction ratio (key to fixing underestimation)
    const correctionRatio = meanMrec > 0.001 ? meanActual / meanMrec : 1.0;

    // Step 3: Estimate rated wind speed from data (P90 of wind speeds where CF > 0.5)
    const highCFWinds = windSpeeds.filter((w, i) => actualValues[i] > 0.5);
    const ratedWindSpeed = highCFWinds.length > 0
      ? this.percentile(highCFWinds, 50)
      : this.percentile(windSpeeds, 75);

    // Step 4: Determine physics boost parameters
    // If we're underestimating, use a positive boost exponent
    // Increased cap from 0.5 to 0.8 to better capture peak capacity factors
    const boostExponent = correctionRatio > 1 ? Math.min((correctionRatio - 1) * 0.6, 0.8) : 0;

    // Step 5: Store factors (initially assume ML will help)
    this.factors = {
      stationCode: this.stationCode,
      physicsBoostEnabled: boostExponent > 0.01,
      ratedWindSpeed: Math.max(ratedWindSpeed, 8), // Minimum 8 m/s
      boostExponent,
      baseMultiplier: correctionRatio,
      useMRECOnly: false,  // Will be set to true if ML degrades performance
      meanActualCF: meanActual,
      meanPredictedCF: meanMrec,
      correctionRatio,
    };

    // Step 6: Train ML multiplicative correction
    // We learn to predict: actual / (mrec × physics_boost × base_multiplier)
    const featureMatrix: number[][] = [];
    const correctionTargets: number[] = [];

    for (let i = 0; i < stationSamples.length; i++) {
      const sample = stationSamples[i];
      const mrecPred = mrecPredictions[i];
      const actual = actualValues[i];

      // Apply physics boost and base multiplier
      const boostedPred = this.applyPhysicsBoost(mrecPred, windSpeeds[i]) * this.factors.baseMultiplier;

      if (boostedPred > 0.001 && actual > 0.001) {
        // Target is the multiplicative correction needed
        const correction = actual / boostedPred;
        // Clamp to reasonable range to avoid extreme values
        // Increased to 5.0 - training data shows peaks can require 4x+ multiplier
        const clampedCorrection = Math.max(0.2, Math.min(5.0, correction));

        const features = this.buildFeatures(mrecPred, sample.weather);
        featureMatrix.push(features);
        correctionTargets.push(clampedCorrection);

        // Asymmetric loss: duplicate samples where model under-predicts (correction > 1)
        // This makes the model learn to correct under-predictions more aggressively
        if (asymmetricLoss && correction > 1.0 && actual > 0.1) {
          // Duplicate this sample once more (2x total weight for under-predictions)
          featureMatrix.push([...features]);
          correctionTargets.push(clampedCorrection);
        }
      }
    }

    // Train residual model to predict multiplicative correction
    if (featureMatrix.length >= 30) {
      try {
        const targets2D = correctionTargets.map(c => [c]);
        this.residualModel = new MultivariateLinearRegression(featureMatrix, targets2D);
      } catch (error: any) {
        console.warn(`Failed to train ML correction for ${this.stationCode}: ${error.message}`);
      }
    }

    // Step 7: Evaluate enhanced model
    let enhancedErrorSum = 0;
    let enhancedValidCount = 0;

    for (let i = 0; i < stationSamples.length; i++) {
      const sample = stationSamples[i];
      const actual = actualValues[i];

      const predicted = this.predict(sample.weather, sample.datetime);

      if (actual > 0.01) {
        enhancedErrorSum += Math.abs((predicted - actual) / actual);
        enhancedValidCount++;
      }
    }

    const enhancedMAPE = enhancedValidCount > 0 ? (enhancedErrorSum / enhancedValidCount) * 100 : 0;
    const improvement = mrecOnlyMAPE > 0 ? ((mrecOnlyMAPE - enhancedMAPE) / mrecOnlyMAPE) * 100 : 0;

    // Step 8: Fallback check - if Enhanced makes things worse, use MREC only
    if (enhancedMAPE > mrecOnlyMAPE && this.factors) {
      this.factors.useMRECOnly = true;
      this.residualModel = null;  // Clear ML model to save memory
      console.warn(`  ⚠️  ${this.stationCode}: Enhanced degraded performance (${mrecOnlyMAPE.toFixed(1)}% → ${enhancedMAPE.toFixed(1)}%), falling back to MREC-only`);
    }

    return {
      stationCode: this.stationCode,
      mrecOnlyMAPE,
      enhancedMAPE: this.factors?.useMRECOnly ? mrecOnlyMAPE : enhancedMAPE,  // Report MREC if fallback
      improvement: this.factors?.useMRECOnly ? 0 : improvement,
      correctionRatio,
      sampleCount: stationSamples.length,
    };
  }

  /**
   * Predict capacity factor using enhanced hybrid model
   *
   * @param weather - Weather features
   * @param _datetime - Not used directly
   * @param weatherSequence - Optional weather sequence for LSTM correction
   * @param hours - Optional hour values for LSTM correction
   * @param months - Optional month values for LSTM correction
   * @returns Predicted capacity factor [0, 1]
   */
  predict(
    weather: CFacWeatherFeatures,
    _datetime?: Date,
    weatherSequence?: CFacWeatherFeatures[],
    hours?: number[],
    months?: number[]
  ): number {
    const windSpeed = this.getWindSpeed(weather);

    // Step 1: Get MREC base prediction (provides good shape)
    const mrecBase = this.mrecModel.predict(windSpeed);

    // If not trained, return scaled MREC
    if (!this.factors) {
      return Math.max(0, Math.min(1, mrecBase));
    }

    // Fallback: If ML was found to degrade performance, use MREC only
    if (this.factors.useMRECOnly) {
      return Math.max(0, Math.min(1, mrecBase));
    }

    // Step 2: Apply physics boost (smooth, no hard cutoffs)
    const boosted = this.applyPhysicsBoost(mrecBase, windSpeed);

    // Step 3: Apply base multiplier (addresses systematic underestimation)
    let prediction = boosted * this.factors.baseMultiplier;

    // Step 4: Apply ML multiplicative correction if available
    if (this.residualModel) {
      const features = this.buildFeatures(mrecBase, weather);
      const mlCorrection = this.residualModel.predict([features])[0][0];
      // Clamp ML correction to reasonable range
      // Increased upper bound to 4.0 - training data shows peaks can require 4x+ multiplier
      // when high CF occurs at moderate wind speeds (MREC linear assumption breaks down)
      const clampedCorrection = Math.max(0.3, Math.min(4.0, mlCorrection));
      prediction *= clampedCorrection;
    }

    // Step 5: Smooth high-wind handling (instead of hard cutout)
    // Gradually reduce CF as it approaches unrealistic values
    // Raised threshold from 0.95 to 0.98 to allow more peak expression
    if (prediction > 0.98) {
      // Soft cap: asymptotically approach 1.0
      prediction = 0.98 + 0.02 * (1 - Math.exp(-(prediction - 0.98) * 15));
    }

    // Clamp to valid range
    return Math.max(0, Math.min(1, prediction));
  }

  /**
   * Get MREC-only prediction (for comparison)
   */
  predictMRECOnly(windSpeed: number): number {
    return this.mrecModel.predict(windSpeed);
  }

  /**
   * Check if model is trained
   */
  isTrained(): boolean {
    return this.factors !== null;
  }

  /**
   * Check if MREC is calibrated
   */
  isMRECCalibrated(): boolean {
    return this.mrecModel.isCalibrated();
  }


  /**
   * Calculate percentile of array
   */
  private percentile(arr: number[], p: number): number {
    if (arr.length === 0) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const index = (p / 100) * (sorted.length - 1);
    const lower = Math.floor(index);
    const upper = Math.ceil(index);
    if (lower === upper) return sorted[lower];
    return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
  }

  /**
   * Create empty metrics for insufficient data
   */
  private createEmptyMetrics(sampleCount: number): EnhancedHybridMetrics {
    return {
      stationCode: this.stationCode,
      mrecOnlyMAPE: 0,
      enhancedMAPE: 0,
      improvement: 0,
      correctionRatio: 1,
      sampleCount,
    };
  }

  /**
   * Serialize model state to JSON-compatible object
   * Returns an object that can be saved to model store
   */
  toJSON(): WindEnhancedHybridState {
    return {
      version: 1,
      stationCode: this.stationCode,
      mrecFactors: this.mrecModel.getFactors(),
      enhancedFactors: this.factors,
      residualModel: this.residualModel ? {
        weights: (this.residualModel as any).weights,
        inputs: (this.residualModel as any).inputs,
        outputs: (this.residualModel as any).outputs,
      } : null,
    };
  }

  /**
   * Restore model state from serialized data
   * Static factory method for creating a new model from saved state
   */
  static fromJSON(state: WindEnhancedHybridState): WindEnhancedHybridModel {
    const model = new WindEnhancedHybridModel(state.stationCode);

    // Restore MREC factors
    if (state.mrecFactors) {
      model.mrecModel.loadFactors(state.mrecFactors);
    }

    // Restore enhanced factors
    if (state.enhancedFactors) {
      model.factors = state.enhancedFactors;
    }

    // Restore residual model (ML correction)
    if (state.residualModel) {
      const mockX = [[0]];
      const mockY = [[0]];
      model.residualModel = new MultivariateLinearRegression(mockX, mockY);
      (model.residualModel as any).weights = state.residualModel.weights;
      (model.residualModel as any).inputs = state.residualModel.inputs;
      (model.residualModel as any).outputs = state.residualModel.outputs;
    }

    return model;
  }
}

/**
 * Serialized state for WindEnhancedHybridModel
 */
export interface WindEnhancedHybridState {
  version: number;
  stationCode: string;
  mrecFactors: MRECFactors | null;
  enhancedFactors: EnhancedHybridFactors | null;
  residualModel: {
    weights: number[][];
    inputs: number;
    outputs: number;
  } | null;
}

/**
 * Train Enhanced Hybrid models for all wind stations
 */
export async function trainAllEnhancedHybrid(
  mrecFactors: MRECFactors[],
  samples: CFacTrainingSample[],
  asymmetricLoss: boolean = false,
  progressCallback?: (msg: string) => void
): Promise<Map<string, WindEnhancedHybridModel>> {
  const models = new Map<string, WindEnhancedHybridModel>();

  progressCallback?.(`Training Enhanced Hybrid for ${mrecFactors.length} wind stations${asymmetricLoss ? ' (with asymmetric loss)' : ''}`);

  let totalMrecMAPE = 0;
  let totalEnhancedMAPE = 0;
  let stationCount = 0;

  for (let i = 0; i < mrecFactors.length; i++) {
    const factors = mrecFactors[i];
    progressCallback?.(`  [${i + 1}/${mrecFactors.length}] Training ${factors.stationCode}...`);

    const model = new WindEnhancedHybridModel(factors.stationCode);
    model.loadMRECFactors(factors);

    const metrics = model.train(samples, asymmetricLoss);

    if (metrics.sampleCount >= 50) {
      totalMrecMAPE += metrics.mrecOnlyMAPE;
      totalEnhancedMAPE += metrics.enhancedMAPE;
      stationCount++;

      const enhancedFactors = model.getEnhancedFactors();
      progressCallback?.(`    MREC MAPE: ${metrics.mrecOnlyMAPE.toFixed(1)}% → Enhanced: ${metrics.enhancedMAPE.toFixed(1)}% (${metrics.improvement > 0 ? '+' : ''}${metrics.improvement.toFixed(1)}%)`);
      progressCallback?.(`    Correction ratio: ${metrics.correctionRatio.toFixed(2)}x, Physics boost: ${enhancedFactors?.boostExponent.toFixed(3) ?? 'N/A'}`);
    }

    models.set(factors.stationCode, model);
  }

  if (stationCount > 0) {
    const avgMrecMAPE = totalMrecMAPE / stationCount;
    const avgEnhancedMAPE = totalEnhancedMAPE / stationCount;
    const overallImprovement = ((avgMrecMAPE - avgEnhancedMAPE) / avgMrecMAPE) * 100;

    progressCallback?.(`\nOverall Results (Enhanced Hybrid):`);
    progressCallback?.(`   MREC-only avg MAPE:     ${avgMrecMAPE.toFixed(1)}%`);
    progressCallback?.(`   Enhanced Hybrid MAPE:   ${avgEnhancedMAPE.toFixed(1)}%`);
    progressCallback?.(`   Improvement:            ${overallImprovement.toFixed(1)}%`);
  }

  return models;
}
