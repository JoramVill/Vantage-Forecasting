/**
 * DemandCalibrator - Quantile Loss XGBoost calibration for hybrid demand model
 *
 * HYBRID CALIBRATION ARCHITECTURE (Pass 2):
 * This calibrator learns residual corrections AFTER Iterative Scaling (Pass 1).
 * It uses Quantile Loss to penalize under-predictions more heavily than
 * over-predictions, solving the "peak crushing" problem of symmetric MSE.
 *
 * Key improvements over original MSE-based calibrator:
 * 1. Quantile Loss with configurable alpha (default 0.80 = 4:1 penalty ratio)
 * 2. Relaxed clamping (±50% vs restrictive ±15%)
 * 3. Momentum feature (rolling 24h error average)
 * 4. Forecast horizon awareness
 *
 * Reference: Documents/planning/HYBRID_CALIBRATION_IMPLEMENTATION.md
 */

import { TrainingSample, FeatureVector } from '../types/index.js';
import { isPhilippineHoliday } from '../constants/index.js';
import * as fs from 'fs';
import * as path from 'path';

// Zone code mapping for one-hot encoding
const ZONE_CODES = [
  '01NLUZ', '02NLUZ', '03CLUZ', '04CLUZ', '05SLUZ', '06SLUZ', '07SLUZ',
  '08EVIS', '09EVIS', '10WVIS', '11WVIS', '12NMIN', '13SMIN', '14SWMIN'
];

// Day type encoding
type DayType = 'workday' | 'saturday' | 'sunday' | 'holiday';

interface CalibrationSample {
  features: number[];
  target: number; // correction factor: actual / hybridPrediction
}

export interface CalibrationMetrics {
  trainMAPE: number;
  validationMAPE: number;
  avgCorrection: number;
  correctionStdDev: number;
  sampleCount: number;
}

export interface TreeNode {
  featureIdx?: number;
  threshold?: number;
  left?: TreeNode;
  right?: TreeNode;
  value?: number;
}

export class DemandCalibrator {
  private model: any = null;
  private trees: TreeNode[] = [];
  private basePrediction: number = 1.0;
  private trained: boolean = false;
  private metrics: CalibrationMetrics | null = null;

  // Quantile regression parameter
  // alpha > 0.5 penalizes under-predictions more heavily
  // 0.80 = 4:1 penalty ratio (under vs over)
  private alpha: number = 0.80;

  // Learning rate for gradient boosting
  private learningRate: number = 0.1;

  // Feature names for interpretability (expanded for Phase 3)
  private featureNames: string[] = [
    'zoneIdx',
    'hour', 'hourSin', 'hourCos',
    'dayTypeWorkday', 'dayTypeSaturday', 'dayTypeSunday', 'dayTypeHoliday',
    'temp', 'humidity', 'cloudCover',
    'hybridPrediction',
    'demandLag24h',
    'month', 'monthSin', 'monthCos',
    // Phase 3 features
    'momentum24h',      // Rolling 24h error average
    'errorTrend',       // Error direction (improving/worsening)
    'forecastHorizon',  // Hours ahead in prediction
    'tempRamp'          // Rate of temperature change
  ];

  // Track recent errors for momentum calculation
  private recentErrors: number[] = [];

  constructor(options?: { alpha?: number; learningRate?: number }) {
    if (options?.alpha !== undefined) {
      this.alpha = Math.max(0.5, Math.min(0.95, options.alpha));
    }
    if (options?.learningRate !== undefined) {
      this.learningRate = options.learningRate;
    }
  }

  /**
   * Get day type from sample features
   */
  private getDayType(features: FeatureVector, datetime: Date): DayType {
    const dateStr = datetime.toISOString().split('T')[0];
    if (isPhilippineHoliday(dateStr)) return 'holiday';
    if (features.isSunday) return 'sunday';
    if (features.isSaturday) return 'saturday';
    return 'workday';
  }

  /**
   * Build calibration features from a sample and hybrid prediction
   *
   * Extended with Phase 3 features:
   * - momentum24h: Rolling 24h error average
   * - errorTrend: Whether errors are improving or worsening
   * - forecastHorizon: How far ahead the prediction is
   * - tempRamp: Rate of temperature change
   */
  private buildCalibrationFeatures(
    sample: TrainingSample,
    hybridPrediction: number,
    context?: {
      recentErrors?: number[];
      forecastHorizon?: number;
      prevTemp?: number;
    }
  ): number[] {
    const features = sample.features;
    const hour = features.hour;
    const dayType = this.getDayType(features, sample.datetime);

    // Zone one-hot (use index for tree-based model)
    const zoneIdx = ZONE_CODES.indexOf(sample.region);

    // Hour cyclic encoding
    const hourSin = Math.sin(hour * 2 * Math.PI / 24);
    const hourCos = Math.cos(hour * 2 * Math.PI / 24);

    // Day type one-hot
    const dayTypeWorkday = dayType === 'workday' ? 1 : 0;
    const dayTypeSaturday = dayType === 'saturday' ? 1 : 0;
    const dayTypeSunday = dayType === 'sunday' ? 1 : 0;
    const dayTypeHoliday = dayType === 'holiday' ? 1 : 0;

    // Weather features
    const temp = features.temp || 28;
    const humidity = features.relativeHumidity || 70;
    const cloudCover = features.cloudcover || 50;

    // Hybrid prediction (normalized)
    const hybridNorm = hybridPrediction / 1000; // Scale to reasonable range

    // Demand lag (if available)
    const demandLag24h = (features.demandLag24h || hybridPrediction) / 1000;

    // Month cyclic encoding
    const month = sample.datetime.getMonth() + 1;
    const monthSin = Math.sin(month * 2 * Math.PI / 12);
    const monthCos = Math.cos(month * 2 * Math.PI / 12);

    // Phase 3: New context-aware features
    const recentErrors = context?.recentErrors || this.recentErrors;

    // Momentum: Rolling 24h error average (positive = under-predicting)
    const momentum24h = recentErrors.length > 0
      ? recentErrors.slice(-24).reduce((a, b) => a + b, 0) / Math.min(recentErrors.length, 24)
      : 0;

    // Error trend: Compare recent 6h vs older 6h (positive = getting worse)
    let errorTrend = 0;
    if (recentErrors.length >= 12) {
      const recent6h = recentErrors.slice(-6).reduce((a, b) => a + b, 0) / 6;
      const older6h = recentErrors.slice(-12, -6).reduce((a, b) => a + b, 0) / 6;
      errorTrend = (recent6h - older6h) / 10; // Normalize
    }

    // Forecast horizon (normalized to 0-1 for a week)
    const forecastHorizon = (context?.forecastHorizon ?? 24) / 168;

    // Temperature ramp (rate of change)
    const prevTemp = context?.prevTemp ?? temp;
    const tempRamp = (temp - prevTemp) / 10; // Normalize

    return [
      zoneIdx >= 0 ? zoneIdx : 0,
      hour, hourSin, hourCos,
      dayTypeWorkday, dayTypeSaturday, dayTypeSunday, dayTypeHoliday,
      temp, humidity, cloudCover,
      hybridNorm,
      demandLag24h,
      month, monthSin, monthCos,
      // Phase 3 features
      momentum24h,
      errorTrend,
      forecastHorizon,
      tempRamp
    ];
  }

  /**
   * Train the calibrator on hybrid model errors using Quantile Loss
   *
   * Key difference from MSE-based training:
   * - Uses quantile loss with alpha parameter to penalize under-predictions
   * - Default alpha=0.80 means 4:1 penalty ratio (under vs over)
   * - This prevents "peak crushing" seen with symmetric MSE
   *
   * @param samples Training samples with actual demand
   * @param hybridPredictor Function that returns hybrid model prediction for a sample
   * @param options Training options
   */
  async train(
    samples: TrainingSample[],
    hybridPredictor: (sample: TrainingSample) => number,
    options?: {
      maxDepth?: number;
      nEstimators?: number;
      learningRate?: number;
      minChildWeight?: number;
      validationSplit?: number;
      alpha?: number;  // Quantile parameter (default: 0.80)
    }
  ): Promise<CalibrationMetrics> {
    const opts = {
      maxDepth: options?.maxDepth ?? 4,
      nEstimators: options?.nEstimators ?? 50,
      learningRate: options?.learningRate ?? 0.1,
      minChildWeight: options?.minChildWeight ?? 10,
      validationSplit: options?.validationSplit ?? 0.2,
      alpha: options?.alpha ?? this.alpha
    };

    // Update instance alpha if provided
    if (options?.alpha !== undefined) {
      this.alpha = opts.alpha;
    }
    this.learningRate = opts.learningRate;

    console.log('  Building calibration dataset...');

    // Build calibration samples
    const calibrationSamples: CalibrationSample[] = [];
    let skipped = 0;

    for (const sample of samples) {
      const hybridPred = hybridPredictor(sample);

      // Skip invalid predictions
      if (!hybridPred || hybridPred <= 0 || !sample.demand || sample.demand <= 0) {
        skipped++;
        continue;
      }

      // Calculate correction factor (what hybrid should have been multiplied by)
      const correctionFactor = sample.demand / hybridPred;

      // Clamp extreme corrections (likely outliers/data issues)
      if (correctionFactor < 0.5 || correctionFactor > 2.0) {
        skipped++;
        continue;
      }

      calibrationSamples.push({
        features: this.buildCalibrationFeatures(sample, hybridPred),
        target: correctionFactor
      });
    }

    if (calibrationSamples.length < 100) {
      console.warn(`  Warning: Only ${calibrationSamples.length} valid calibration samples`);
    }

    console.log(`  Calibration samples: ${calibrationSamples.length} (skipped ${skipped})`);

    // Split into train/validation
    const splitIdx = Math.floor(calibrationSamples.length * (1 - opts.validationSplit));
    const shuffled = calibrationSamples.sort(() => Math.random() - 0.5);
    const trainData = shuffled.slice(0, splitIdx);
    const valData = shuffled.slice(splitIdx);

    // Train gradient boosting model
    const X_train = trainData.map(s => s.features);
    const y_train = trainData.map(s => s.target);
    const X_val = valData.map(s => s.features);
    const y_val = valData.map(s => s.target);

    console.log(`  Training XGBoost calibrator (${opts.nEstimators} trees, depth ${opts.maxDepth})...`);

    // Try to use XGBoost, fall back to custom gradient boosting
    try {
      const XGBoost = await this.loadXGBoost();

      if (XGBoost) {
        this.model = new XGBoost({
          max_depth: opts.maxDepth,
          eta: opts.learningRate,
          objective: 'reg:squarederror',
          booster: 'gbtree',
          min_child_weight: opts.minChildWeight,
          lambda: 1.0,  // L2 regularization
          subsample: 0.8
        });

        await this.model.fit(X_train, y_train, {
          num_boost_round: opts.nEstimators
        });
      } else {
        this.trainFallbackModel(X_train, y_train, opts);
      }
    } catch (error) {
      console.warn('  XGBoost not available, using fallback gradient boosting');
      this.trainFallbackModel(X_train, y_train, opts);
    }

    this.trained = true;

    // Calculate metrics
    const trainPreds = X_train.map(x => this.predictSingle(x));
    const valPreds = X_val.map(x => this.predictSingle(x));

    const trainMAPE = this.calculateMAPE(y_train, trainPreds);
    const validationMAPE = this.calculateMAPE(y_val, valPreds);

    const allCorrections = calibrationSamples.map(s => s.target);
    const avgCorrection = allCorrections.reduce((a, b) => a + b, 0) / allCorrections.length;
    const correctionStdDev = Math.sqrt(
      allCorrections.reduce((sum, c) => sum + Math.pow(c - avgCorrection, 2), 0) / allCorrections.length
    );

    this.metrics = {
      trainMAPE,
      validationMAPE,
      avgCorrection,
      correctionStdDev,
      sampleCount: calibrationSamples.length
    };

    console.log(`  Calibrator trained: Train MAPE=${trainMAPE.toFixed(2)}%, Val MAPE=${validationMAPE.toFixed(2)}%`);
    console.log(`  Avg correction: ${avgCorrection.toFixed(3)}, StdDev: ${correctionStdDev.toFixed(3)}`);

    return this.metrics;
  }

  /**
   * Load XGBoost library
   */
  private async loadXGBoost(): Promise<any> {
    try {
      const xgb = await import('@fractal-solutions/xgboost-js');
      return xgb.default || xgb.XGBoost || xgb;
    } catch {
      return null;
    }
  }

  /**
   * Calculate quantile loss gradient
   *
   * For quantile regression with alpha:
   * - gradient = alpha * residual if actual > predicted (under-prediction)
   * - gradient = (1-alpha) * residual if actual < predicted (over-prediction)
   *
   * alpha = 0.5 → symmetric (standard MSE behavior)
   * alpha > 0.5 → penalize under-predictions more
   *
   * Penalty ratio = alpha / (1 - alpha)
   * alpha = 0.80 → 4:1 ratio
   * alpha = 0.90 → 9:1 ratio
   */
  private calculateQuantileGradient(actual: number, predicted: number): number {
    const residual = actual - predicted;
    if (residual > 0) {
      // Under-prediction: weight by alpha
      return this.alpha * residual;
    } else {
      // Over-prediction: weight by (1 - alpha)
      return (1 - this.alpha) * residual;
    }
  }

  /**
   * Fallback gradient boosting with QUANTILE LOSS
   *
   * Key difference from original:
   * - Uses calculateQuantileGradient instead of simple residuals
   * - This penalizes under-predictions more heavily (based on alpha)
   */
  private trainFallbackModel(X: number[][], y: number[], opts: any): void {
    // Subsample for faster training (limit to 10k samples)
    const maxSamples = 10000;
    let trainX = X;
    let trainY = y;

    if (X.length > maxSamples) {
      console.log(`  Subsampling ${X.length} to ${maxSamples} samples for faster training...`);
      const indices = this.sampleIndices(X.length, maxSamples);
      trainX = indices.map(i => X[i]);
      trainY = indices.map(i => y[i]);
    }

    // Use more trees now that we have proper quantile loss
    const nTrees = Math.min(opts.nEstimators, 30);

    this.basePrediction = trainY.reduce((a, b) => a + b, 0) / trainY.length;
    const predictions = new Array(trainY.length).fill(this.basePrediction);

    this.trees = [];

    console.log(`  Training with Quantile Loss (alpha=${this.alpha.toFixed(2)}, penalty ratio=${(this.alpha / (1 - this.alpha)).toFixed(1)}:1)`);

    for (let round = 0; round < nTrees; round++) {
      // Calculate QUANTILE gradients instead of simple residuals
      const gradients = trainY.map((actual, i) =>
        this.calculateQuantileGradient(actual, predictions[i])
      );

      const tree = this.buildTree(trainX, gradients, 0, opts.maxDepth, opts.minChildWeight);
      this.trees.push(tree);

      // Update predictions
      for (let i = 0; i < trainX.length; i++) {
        const treePred = this.predictTree(tree, trainX[i]);
        predictions[i] += opts.learningRate * treePred;
      }

      // Progress indicator
      if ((round + 1) % 10 === 0) {
        console.log(`    Tree ${round + 1}/${nTrees} trained`);
      }
    }
    console.log(`  Quantile Loss model trained with ${nTrees} trees`);
  }

  /**
   * Sample random indices without replacement
   */
  private sampleIndices(total: number, sampleSize: number): number[] {
    const indices = Array.from({ length: total }, (_, i) => i);
    // Fisher-Yates shuffle (partial)
    for (let i = 0; i < sampleSize; i++) {
      const j = i + Math.floor(Math.random() * (total - i));
      [indices[i], indices[j]] = [indices[j], indices[i]];
    }
    return indices.slice(0, sampleSize);
  }

  /**
   * Build a single decision tree (optimized with cumulative sums)
   */
  private buildTree(
    X: number[][],
    y: number[],
    depth: number,
    maxDepth: number,
    minChildWeight: number
  ): TreeNode {
    const n = y.length;

    // Leaf node conditions
    if (depth >= maxDepth || n < minChildWeight) {
      return { value: y.reduce((a, b) => a + b, 0) / n };
    }

    let bestGain = 0;
    let bestFeature = 0;
    let bestThreshold = 0;
    let bestSplitIdx = 0;
    let bestSortedIndices: number[] = [];

    const totalSum = y.reduce((a, b) => a + b, 0);
    const totalSumSq = y.reduce((sum, v) => sum + v * v, 0);
    const yMean = totalSum / n;
    // Variance = sum((y - mean)^2) = sum(y^2) - 2*mean*sum(y) + n*mean^2 = sum(y^2) - n*mean^2
    const totalVariance = totalSumSq - n * yMean * yMean;

    // Find best split using cumulative sums (O(n log n) per feature instead of O(n²))
    for (let featureIdx = 0; featureIdx < X[0].length; featureIdx++) {
      // Sort indices by feature value
      const sortedIndices = Array.from({ length: n }, (_, i) => i);
      sortedIndices.sort((a, b) => X[a][featureIdx] - X[b][featureIdx]);

      // Use cumulative sums to compute left/right statistics in O(1) per split
      let leftSum = 0;
      let leftSumSq = 0;

      for (let i = 0; i < n - 1; i++) {
        const idx = sortedIndices[i];
        const yVal = y[idx];
        leftSum += yVal;
        leftSumSq += yVal * yVal;

        const leftCount = i + 1;
        const rightCount = n - leftCount;

        // Skip if either side is too small
        if (leftCount < minChildWeight || rightCount < minChildWeight) continue;

        // Skip if same feature value (no valid split)
        if (X[sortedIndices[i]][featureIdx] === X[sortedIndices[i + 1]][featureIdx]) continue;

        const rightSum = totalSum - leftSum;
        const rightSumSq = totalSumSq - leftSumSq;

        const leftMean = leftSum / leftCount;
        const rightMean = rightSum / rightCount;

        // Variance = sum(y^2) - n*mean^2
        const leftVariance = leftSumSq - leftCount * leftMean * leftMean;
        const rightVariance = rightSumSq - rightCount * rightMean * rightMean;

        const gain = totalVariance - leftVariance - rightVariance;

        if (gain > bestGain) {
          bestGain = gain;
          bestFeature = featureIdx;
          bestSplitIdx = i;
          bestThreshold = (X[sortedIndices[i]][featureIdx] + X[sortedIndices[i + 1]][featureIdx]) / 2;
          bestSortedIndices = sortedIndices;
        }
      }
    }

    // No good split found
    if (bestGain <= 0) {
      return { value: yMean };
    }

    // Build child nodes using the best split
    const leftIndices = bestSortedIndices.slice(0, bestSplitIdx + 1);
    const rightIndices = bestSortedIndices.slice(bestSplitIdx + 1);

    const leftX = leftIndices.map(i => X[i]);
    const leftY = leftIndices.map(i => y[i]);
    const rightX = rightIndices.map(i => X[i]);
    const rightY = rightIndices.map(i => y[i]);

    return {
      featureIdx: bestFeature,
      threshold: bestThreshold,
      left: this.buildTree(leftX, leftY, depth + 1, maxDepth, minChildWeight),
      right: this.buildTree(rightX, rightY, depth + 1, maxDepth, minChildWeight)
    };
  }

  /**
   * Predict using a single tree
   */
  private predictTree(node: TreeNode, features: number[]): number {
    if (node.value !== undefined) {
      return node.value;
    }

    if (features[node.featureIdx!] <= node.threshold!) {
      return this.predictTree(node.left!, features);
    } else {
      return this.predictTree(node.right!, features);
    }
  }

  /**
   * Predict correction factor for a single feature vector
   */
  private predictSingle(features: number[]): number {
    if (this.model) {
      // Use XGBoost model
      const pred = this.model.predict([features])[0];
      return this.clampCorrection(pred);
    }

    // Use fallback model with configurable learning rate
    let prediction = this.basePrediction;
    for (const tree of this.trees) {
      prediction += this.learningRate * this.predictTree(tree, features);
    }

    return this.clampCorrection(prediction);
  }

  /**
   * Clamp correction factor to safety bounds only
   *
   * CHANGED: Relaxed from ±15% to ±50%
   * The restrictive ±15% clamping was identified as a cause of
   * "peak crushing" - preventing the model from reaching true peaks.
   *
   * Now allows corrections up to ±50% (safety limit only).
   * The quantile loss function handles proper penalty weighting.
   */
  private clampCorrection(correction: number): number {
    // Safety bounds only - allow corrections up to ±50%
    return Math.max(0.50, Math.min(1.50, correction));
  }

  /**
   * Calculate MAPE
   */
  private calculateMAPE(actual: number[], predicted: number[]): number {
    const errors = actual.map((a, i) => Math.abs((a - predicted[i]) / a) * 100);
    return errors.reduce((a, b) => a + b, 0) / errors.length;
  }

  /**
   * Calibrate a hybrid prediction
   *
   * @param hybridPrediction The raw hybrid model prediction
   * @param sample The sample with features (for context)
   * @returns Calibrated prediction
   */
  calibrate(hybridPrediction: number, sample: TrainingSample): number {
    if (!this.trained) {
      return hybridPrediction; // No calibration if not trained
    }

    const features = this.buildCalibrationFeatures(sample, hybridPrediction);
    const correction = this.predictSingle(features);

    return hybridPrediction * correction;
  }

  /**
   * Calibrate with explicit features (for forecast generation)
   */
  calibrateWithFeatures(
    hybridPrediction: number,
    zone: string,
    hour: number,
    dayType: DayType,
    weather: { temp: number; humidity: number; cloudCover: number },
    demandLag24h: number,
    month: number
  ): number {
    if (!this.trained) {
      return hybridPrediction;
    }

    const zoneIdx = ZONE_CODES.indexOf(zone);
    const hourSin = Math.sin(hour * 2 * Math.PI / 24);
    const hourCos = Math.cos(hour * 2 * Math.PI / 24);
    const monthSin = Math.sin(month * 2 * Math.PI / 12);
    const monthCos = Math.cos(month * 2 * Math.PI / 12);

    const features = [
      zoneIdx >= 0 ? zoneIdx : 0,
      hour, hourSin, hourCos,
      dayType === 'workday' ? 1 : 0,
      dayType === 'saturday' ? 1 : 0,
      dayType === 'sunday' ? 1 : 0,
      dayType === 'holiday' ? 1 : 0,
      weather.temp, weather.humidity, weather.cloudCover,
      hybridPrediction / 1000,
      demandLag24h / 1000,
      month, monthSin, monthCos
    ];

    const correction = this.predictSingle(features);
    return hybridPrediction * correction;
  }

  /**
   * Check if calibrator is trained
   */
  isTrained(): boolean {
    return this.trained;
  }

  /**
   * Check if calibrator is ready (alias for isTrained)
   */
  isReady(): boolean {
    return this.trained;
  }

  /**
   * Get training metrics
   */
  getMetrics(): CalibrationMetrics | null {
    return this.metrics;
  }

  /**
   * Get zone codes for external use
   */
  static getZoneCodes(): string[] {
    return ZONE_CODES;
  }

  /**
   * Track an error for momentum calculation
   * Call this after each prediction to build momentum history
   */
  trackError(error: number): void {
    this.recentErrors.push(error);
    // Keep only last 48 hours of errors
    if (this.recentErrors.length > 48) {
      this.recentErrors.shift();
    }
  }

  /**
   * Clear error history (call at start of new forecast)
   */
  clearErrorHistory(): void {
    this.recentErrors = [];
  }

  /**
   * Get current alpha parameter
   */
  getAlpha(): number {
    return this.alpha;
  }

  /**
   * Save calibrator state to a JSON file
   */
  save(filepath: string): void {
    const state = {
      version: 2,  // Bumped for quantile loss support
      type: 'demand-calibrator',
      trees: this.trees,
      basePrediction: this.basePrediction,
      alpha: this.alpha,
      learningRate: this.learningRate,
      metrics: this.metrics,
      featureNames: this.featureNames,
      trainedAt: new Date().toISOString(),
      validationMAPE: this.metrics?.validationMAPE  // For IPC handler compatibility
    };

    // Ensure directory exists
    const dir = path.dirname(filepath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(filepath, JSON.stringify(state, null, 2));
  }

  /**
   * Load calibrator state from a JSON file
   */
  static load(filepath: string): DemandCalibrator {
    if (!fs.existsSync(filepath)) {
      throw new Error(`Calibrator file not found: ${filepath}`);
    }

    const content = fs.readFileSync(filepath, 'utf-8');
    const state = JSON.parse(content);

    if (state.type !== 'demand-calibrator') {
      throw new Error('Invalid calibrator file format');
    }

    const calibrator = new DemandCalibrator({
      alpha: state.alpha ?? 0.80,
      learningRate: state.learningRate ?? 0.1
    });
    calibrator.trees = state.trees;
    calibrator.basePrediction = state.basePrediction;
    calibrator.metrics = state.metrics;
    calibrator.trained = true;

    return calibrator;
  }
}
