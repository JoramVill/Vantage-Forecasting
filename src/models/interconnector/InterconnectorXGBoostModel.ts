/**
 * Interconnector Congestion Prediction Model using XGBoost
 *
 * Dual-model approach:
 * 1. Classification: Predict congestion (Y/N) using XGBoost classifier
 * 2. Regression: Predict flow magnitude using XGBoost regressor
 */

import {
  InterconnectorTrainingSample,
  InterconnectorCongestionPrediction,
  InterconnectorModelMetrics
} from '../../types/interconnector.js';
import { INTERCONNECTOR_FEATURE_NAMES } from '../../features/interconnectorFeatures.js';

/**
 * Simple XGBoost-style gradient boosting for binary classification with class weighting
 */
class XGBoostClassifier {
  private trees: any[] = [];
  private basePrediction: number = 0;
  private learningRate: number = 0.1;
  private maxDepth: number = 6;
  private nEstimators: number = 100;
  private minChildWeight: number = 1;
  private subsample: number = 0.8;
  private scalePosWeight: number = 1;

  constructor(options?: {
    maxDepth?: number;
    learningRate?: number;
    nEstimators?: number;
    minChildWeight?: number;
    subsample?: number;
    scalePosWeight?: number;
  }) {
    if (options) {
      this.maxDepth = options.maxDepth ?? 6;
      this.learningRate = options.learningRate ?? 0.1;
      this.nEstimators = options.nEstimators ?? 100;
      this.minChildWeight = options.minChildWeight ?? 1;
      this.subsample = options.subsample ?? 0.8;
      this.scalePosWeight = options.scalePosWeight ?? 1;
    }
  }

  private sigmoid(z: number): number {
    return 1 / (1 + Math.exp(-Math.max(-10, Math.min(10, z))));
  }

  train(X: number[][], y: number[]): void {
    // Initialize with base prediction (log-odds)
    const positiveCount = y.filter(v => v === 1).length;
    const negativeCount = y.length - positiveCount;
    this.basePrediction = Math.log((positiveCount + 1) / (negativeCount + 1));

    // Initialize predictions
    const predictions = new Array(y.length).fill(this.basePrediction);
    const probabilities = predictions.map(p => this.sigmoid(p));

    // Build trees using gradient boosting
    for (let round = 0; round < this.nEstimators; round++) {
      // Calculate gradients and hessians with scale_pos_weight
      const gradients: number[] = [];
      const hessians: number[] = [];

      for (let i = 0; i < y.length; i++) {
        const prob = probabilities[i];
        // Apply scale_pos_weight to positive class samples
        const weight = y[i] === 1 ? this.scalePosWeight : 1;
        gradients.push((prob - y[i]) * weight);
        hessians.push(prob * (1 - prob) * weight);
      }

      // Sample data for this round
      const sampleSize = Math.floor(X.length * this.subsample);
      const indices = this.sampleIndices(X.length, sampleSize);
      const X_sample = indices.map(i => X[i]);
      const grad_sample = indices.map(i => gradients[i]);
      const hess_sample = indices.map(i => hessians[i]);

      // Build tree
      const tree = this.buildTree(X_sample, grad_sample, hess_sample, 0);
      this.trees.push(tree);

      // Update predictions
      for (let i = 0; i < X.length; i++) {
        const treePred = this.predictTree(tree, X[i]) * this.learningRate;
        predictions[i] += treePred;
        probabilities[i] = this.sigmoid(predictions[i]);
      }
    }
  }

  private sampleIndices(total: number, sampleSize: number): number[] {
    const indices: number[] = [];
    const available = Array.from({ length: total }, (_, i) => i);

    for (let i = 0; i < sampleSize; i++) {
      const idx = Math.floor(Math.random() * available.length);
      indices.push(available[idx]);
      available.splice(idx, 1);
    }

    return indices;
  }

  private buildTree(
    X: number[][],
    gradients: number[],
    hessians: number[],
    depth: number
  ): any {
    if (X.length === 0 || depth >= this.maxDepth) {
      const sumGrad = gradients.reduce((a, b) => a + b, 0);
      const sumHess = hessians.reduce((a, b) => a + b, 0);
      return {
        value: sumHess > 0 ? -sumGrad / (sumHess + 1e-6) : 0
      };
    }

    // Check minimum child weight
    const totalHess = hessians.reduce((a, b) => a + b, 0);
    if (totalHess < this.minChildWeight) {
      const sumGrad = gradients.reduce((a, b) => a + b, 0);
      return {
        value: totalHess > 0 ? -sumGrad / (totalHess + 1e-6) : 0
      };
    }

    // Find best split
    let bestGain = 0;
    let bestSplit = { featureIdx: 0, threshold: 0 };
    const currentLoss = this.calculateLoss(gradients, hessians);

    // Sample features
    const numFeatures = X[0].length;
    const featuresToTry = Math.min(numFeatures, Math.max(10, Math.floor(Math.sqrt(numFeatures))));
    const featureIndices: number[] = [];

    for (let i = 0; i < featuresToTry; i++) {
      let idx = Math.floor(Math.random() * numFeatures);
      while (featureIndices.includes(idx)) {
        idx = Math.floor(Math.random() * numFeatures);
      }
      featureIndices.push(idx);
    }

    // Try splits
    for (const f of featureIndices) {
      const sortedIndices = X.map((_, i) => i).sort((a, b) => X[a][f] - X[b][f]);

      const step = Math.max(1, Math.floor(sortedIndices.length / 20));
      for (let s = step; s < sortedIndices.length - step; s += step) {
        const leftIndices = sortedIndices.slice(0, s);
        const rightIndices = sortedIndices.slice(s);

        if (leftIndices.length < 5 || rightIndices.length < 5) continue;

        const leftGrad = leftIndices.map(i => gradients[i]);
        const leftHess = leftIndices.map(i => hessians[i]);
        const rightGrad = rightIndices.map(i => gradients[i]);
        const rightHess = rightIndices.map(i => hessians[i]);

        const leftLoss = this.calculateLoss(leftGrad, leftHess);
        const rightLoss = this.calculateLoss(rightGrad, rightHess);
        const gain = currentLoss - leftLoss - rightLoss;

        if (gain > bestGain) {
          bestGain = gain;
          const splitIdx = sortedIndices[s];
          const prevIdx = sortedIndices[s - 1];
          bestSplit = {
            featureIdx: f,
            threshold: (X[splitIdx][f] + X[prevIdx][f]) / 2
          };
        }
      }
    }

    // If no good split, return leaf
    if (bestGain <= 0) {
      const sumGrad = gradients.reduce((a, b) => a + b, 0);
      const sumHess = hessians.reduce((a, b) => a + b, 0);
      return {
        value: sumHess > 0 ? -sumGrad / (sumHess + 1e-6) : 0
      };
    }

    // Split data
    const leftX: number[][] = [];
    const leftGrad: number[] = [];
    const leftHess: number[] = [];
    const rightX: number[][] = [];
    const rightGrad: number[] = [];
    const rightHess: number[] = [];

    for (let i = 0; i < X.length; i++) {
      if (X[i][bestSplit.featureIdx] <= bestSplit.threshold) {
        leftX.push(X[i]);
        leftGrad.push(gradients[i]);
        leftHess.push(hessians[i]);
      } else {
        rightX.push(X[i]);
        rightGrad.push(gradients[i]);
        rightHess.push(hessians[i]);
      }
    }

    return {
      featureIdx: bestSplit.featureIdx,
      threshold: bestSplit.threshold,
      left: this.buildTree(leftX, leftGrad, leftHess, depth + 1),
      right: this.buildTree(rightX, rightGrad, rightHess, depth + 1)
    };
  }

  private calculateLoss(gradients: number[], hessians: number[]): number {
    if (gradients.length === 0) return 0;
    const sumGrad = gradients.reduce((a, b) => a + b, 0);
    const sumHess = hessians.reduce((a, b) => a + b, 0);
    return sumHess > 0 ? (sumGrad * sumGrad) / (sumHess + 1e-6) : 0;
  }

  private predictTree(tree: any, x: number[]): number {
    if (tree.value !== undefined) {
      return tree.value;
    }

    if (tree.featureIdx === undefined || tree.threshold === undefined) {
      return 0;
    }

    const featureValue = x[tree.featureIdx];
    if (isNaN(featureValue)) {
      return 0;
    }

    if (featureValue <= tree.threshold) {
      return this.predictTree(tree.left, x);
    } else {
      return this.predictTree(tree.right, x);
    }
  }

  predict(x: number[]): number {
    let logit = this.basePrediction;
    for (const tree of this.trees) {
      logit += this.predictTree(tree, x) * this.learningRate;
    }
    return this.sigmoid(logit);
  }

  serialize(): any {
    return {
      trees: this.trees,
      basePrediction: this.basePrediction,
      learningRate: this.learningRate,
      maxDepth: this.maxDepth,
      nEstimators: this.nEstimators,
      scalePosWeight: this.scalePosWeight
    };
  }

  static deserialize(data: any): XGBoostClassifier {
    const model = new XGBoostClassifier();
    model.trees = data.trees;
    model.basePrediction = data.basePrediction;
    model.learningRate = data.learningRate;
    model.maxDepth = data.maxDepth;
    model.nEstimators = data.nEstimators;
    model.scalePosWeight = data.scalePosWeight ?? 1;
    return model;
  }
}

/**
 * XGBoost regressor for flow prediction
 */
class XGBoostRegressor {
  private trees: any[] = [];
  private basePrediction: number = 0;
  private learningRate: number = 0.1;
  private maxDepth: number = 6;
  private nEstimators: number = 100;
  private minChildWeight: number = 1;
  private subsample: number = 0.8;

  constructor(options?: {
    maxDepth?: number;
    learningRate?: number;
    nEstimators?: number;
    minChildWeight?: number;
    subsample?: number;
  }) {
    if (options) {
      this.maxDepth = options.maxDepth ?? 6;
      this.learningRate = options.learningRate ?? 0.1;
      this.nEstimators = options.nEstimators ?? 100;
      this.minChildWeight = options.minChildWeight ?? 1;
      this.subsample = options.subsample ?? 0.8;
    }
  }

  train(X: number[][], y: number[]): void {
    // Initialize with mean
    this.basePrediction = y.reduce((a, b) => a + b, 0) / y.length;

    // Initialize predictions
    const predictions = new Array(y.length).fill(this.basePrediction);
    const residuals = y.map((actual, i) => actual - predictions[i]);

    // Build trees
    for (let round = 0; round < this.nEstimators; round++) {
      // Sample data
      const sampleSize = Math.floor(X.length * this.subsample);
      const indices = this.sampleIndices(X.length, sampleSize);
      const X_sample = indices.map(i => X[i]);
      const residuals_sample = indices.map(i => residuals[i]);

      // Build tree
      const tree = this.buildTree(X_sample, residuals_sample, 0);
      this.trees.push(tree);

      // Update predictions and residuals
      for (let i = 0; i < X.length; i++) {
        const treePred = this.predictTree(tree, X[i]) * this.learningRate;
        predictions[i] += treePred;
        residuals[i] = y[i] - predictions[i];
      }
    }
  }

  private sampleIndices(total: number, sampleSize: number): number[] {
    const indices: number[] = [];
    const available = Array.from({ length: total }, (_, i) => i);

    for (let i = 0; i < sampleSize; i++) {
      const idx = Math.floor(Math.random() * available.length);
      indices.push(available[idx]);
      available.splice(idx, 1);
    }

    return indices;
  }

  private buildTree(
    X: number[][],
    residuals: number[],
    depth: number
  ): any {
    if (X.length === 0 || depth >= this.maxDepth || X.length < this.minChildWeight) {
      const mean = residuals.reduce((a, b) => a + b, 0) / residuals.length;
      return { value: isNaN(mean) ? 0 : mean };
    }

    // Find best split
    let bestGain = 0;
    let bestSplit = { featureIdx: 0, threshold: 0 };
    const currentMean = residuals.reduce((a, b) => a + b, 0) / residuals.length;
    const currentVariance = residuals.reduce((sum, r) => sum + Math.pow(r - currentMean, 2), 0);

    // Sample features
    const numFeatures = X[0].length;
    const featuresToTry = Math.min(numFeatures, Math.max(10, Math.floor(Math.sqrt(numFeatures))));
    const featureIndices: number[] = [];

    for (let i = 0; i < featuresToTry; i++) {
      let idx = Math.floor(Math.random() * numFeatures);
      while (featureIndices.includes(idx)) {
        idx = Math.floor(Math.random() * numFeatures);
      }
      featureIndices.push(idx);
    }

    // Try splits
    for (const f of featureIndices) {
      const sortedIndices = X.map((_, i) => i).sort((a, b) => X[a][f] - X[b][f]);

      const step = Math.max(1, Math.floor(sortedIndices.length / 20));
      for (let s = step; s < sortedIndices.length - step; s += step) {
        const leftIndices = sortedIndices.slice(0, s);
        const rightIndices = sortedIndices.slice(s);

        if (leftIndices.length < 5 || rightIndices.length < 5) continue;

        const leftResiduals = leftIndices.map(i => residuals[i]);
        const rightResiduals = rightIndices.map(i => residuals[i]);

        const leftMean = leftResiduals.reduce((a, b) => a + b, 0) / leftResiduals.length;
        const rightMean = rightResiduals.reduce((a, b) => a + b, 0) / rightResiduals.length;

        const leftVar = leftResiduals.reduce((sum, r) => sum + Math.pow(r - leftMean, 2), 0);
        const rightVar = rightResiduals.reduce((sum, r) => sum + Math.pow(r - rightMean, 2), 0);

        const gain = currentVariance - leftVar - rightVar;

        if (gain > bestGain) {
          bestGain = gain;
          const splitIdx = sortedIndices[s];
          const prevIdx = sortedIndices[s - 1];
          bestSplit = {
            featureIdx: f,
            threshold: (X[splitIdx][f] + X[prevIdx][f]) / 2
          };
        }
      }
    }

    // If no good split, return leaf
    if (bestGain <= 0) {
      return { value: isNaN(currentMean) ? 0 : currentMean };
    }

    // Split data
    const leftX: number[][] = [];
    const leftResiduals: number[] = [];
    const rightX: number[][] = [];
    const rightResiduals: number[] = [];

    for (let i = 0; i < X.length; i++) {
      if (X[i][bestSplit.featureIdx] <= bestSplit.threshold) {
        leftX.push(X[i]);
        leftResiduals.push(residuals[i]);
      } else {
        rightX.push(X[i]);
        rightResiduals.push(residuals[i]);
      }
    }

    return {
      featureIdx: bestSplit.featureIdx,
      threshold: bestSplit.threshold,
      left: this.buildTree(leftX, leftResiduals, depth + 1),
      right: this.buildTree(rightX, rightResiduals, depth + 1)
    };
  }

  private predictTree(tree: any, x: number[]): number {
    if (tree.value !== undefined) {
      return tree.value;
    }

    if (tree.featureIdx === undefined || tree.threshold === undefined) {
      return 0;
    }

    const featureValue = x[tree.featureIdx];
    if (isNaN(featureValue)) {
      return 0;
    }

    if (featureValue <= tree.threshold) {
      return this.predictTree(tree.left, x);
    } else {
      return this.predictTree(tree.right, x);
    }
  }

  predict(x: number[]): number {
    let prediction = this.basePrediction;
    for (const tree of this.trees) {
      prediction += this.predictTree(tree, x) * this.learningRate;
    }
    return prediction;
  }

  serialize(): any {
    return {
      trees: this.trees,
      basePrediction: this.basePrediction,
      learningRate: this.learningRate,
      maxDepth: this.maxDepth,
      nEstimators: this.nEstimators
    };
  }

  static deserialize(data: any): XGBoostRegressor {
    const model = new XGBoostRegressor();
    model.trees = data.trees;
    model.basePrediction = data.basePrediction;
    model.learningRate = data.learningRate;
    model.maxDepth = data.maxDepth;
    model.nEstimators = data.nEstimators;
    return model;
  }
}

/**
 * Main interconnector congestion model using XGBoost
 */
export class InterconnectorXGBoostModel {
  private classificationModel: XGBoostClassifier;
  private regressionModelFrom: XGBoostRegressor;
  private regressionModelTo: XGBoostRegressor;
  private featureNames: string[];
  private ready: boolean = false;
  private featureImportances: Map<string, number> = new Map();

  constructor(options?: {
    maxDepth?: number;
    learningRate?: number;
    nEstimators?: number;
    minChildWeight?: number;
    subsample?: number;
    scalePosWeight?: number;
  }) {
    const opts = {
      maxDepth: options?.maxDepth ?? 6,
      learningRate: options?.learningRate ?? 0.1,
      nEstimators: options?.nEstimators ?? 200,  // Increased from 100
      minChildWeight: options?.minChildWeight ?? 1,
      subsample: options?.subsample ?? 0.8,
      scalePosWeight: options?.scalePosWeight ?? 1
    };

    this.classificationModel = new XGBoostClassifier(opts);
    this.regressionModelFrom = new XGBoostRegressor(opts);
    this.regressionModelTo = new XGBoostRegressor(opts);
    this.featureNames = INTERCONNECTOR_FEATURE_NAMES;
  }

  /**
   * Train both classification and regression models
   */
  train(samples: InterconnectorTrainingSample[]): InterconnectorModelMetrics & {
    scalePosWeight?: number,
    classDistribution?: { negative: number, positive: number }
  } {
    if (samples.length === 0) {
      throw new Error('No training samples provided');
    }

    console.log('  XGBoost: Preparing data...');

    // Split into train/validation (80/20)
    const splitIdx = Math.floor(samples.length * 0.8);
    const trainSamples = samples.slice(0, splitIdx);
    const validSamples = samples.slice(splitIdx);

    // Prepare data
    const X_train = trainSamples.map(s => s.features);
    // Use actual detected constraints instead of misleading CONGESTION_FLAG
    const y_class_train = trainSamples.map(s => s.isActuallyConstrained ? 1 : 0);
    const y_flow_from_train = trainSamples.map(s => s.flowFrom);
    const y_flow_to_train = trainSamples.map(s => s.flowTo);

    // Calculate scale_pos_weight
    const negativeCount = y_class_train.filter(y => y === 0).length;
    const positiveCount = y_class_train.filter(y => y === 1).length;
    const scalePosWeight = negativeCount / positiveCount;

    console.log(`  XGBoost: Class distribution - Negative: ${negativeCount}, Positive: ${positiveCount}`);
    console.log(`  XGBoost: Calculated scale_pos_weight: ${scalePosWeight.toFixed(2)}`);

    // Create new classifier with calculated scale_pos_weight
    this.classificationModel = new XGBoostClassifier({
      maxDepth: 6,
      learningRate: 0.1,
      nEstimators: 200,
      subsample: 0.8,
      scalePosWeight: scalePosWeight
    });

    // Train classification model
    console.log('  XGBoost: Training classification model...');
    const classStartTime = Date.now();
    this.classificationModel.train(X_train, y_class_train);
    const classTrainTime = Date.now() - classStartTime;

    // Train regression models
    console.log('  XGBoost: Training regression models...');
    const regStartTime = Date.now();
    this.regressionModelFrom.train(X_train, y_flow_from_train);
    this.regressionModelTo.train(X_train, y_flow_to_train);
    const regTrainTime = Date.now() - regStartTime;

    this.ready = true;

    // Calculate feature importance via permutation
    console.log('  XGBoost: Calculating feature importance...');
    this.calculateFeatureImportance(X_train, y_class_train);

    // Evaluate on validation set
    console.log('  XGBoost: Evaluating model...');
    const metrics = this.evaluate(validSamples);

    console.log(`  XGBoost: Training time - Classification: ${(classTrainTime / 1000).toFixed(2)}s, Regression: ${(regTrainTime / 1000).toFixed(2)}s`);

    return {
      ...metrics,
      trainingSamples: samples.length,
      trainingDate: new Date().toISOString(),
      scalePosWeight: scalePosWeight,
      classDistribution: {
        negative: negativeCount,
        positive: positiveCount
      }
    };
  }

  /**
   * Calculate feature importance using permutation method
   */
  private calculateFeatureImportance(X: number[][], y: number[]): void {
    // Calculate base accuracy
    const baseAccuracy = this.calculateAccuracy(X, y);

    // Permute each feature and measure drop in accuracy
    for (let f = 0; f < this.featureNames.length; f++) {
      const shuffledX = X.map(row => [...row]);
      const shuffledValues = X.map(row => row[f]);

      // Shuffle
      for (let i = shuffledValues.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffledValues[i], shuffledValues[j]] = [shuffledValues[j], shuffledValues[i]];
      }

      shuffledX.forEach((row, i) => row[f] = shuffledValues[i]);

      const shuffledAccuracy = this.calculateAccuracy(shuffledX, y);
      const importance = Math.max(0, baseAccuracy - shuffledAccuracy);
      this.featureImportances.set(this.featureNames[f], importance);
    }

    // Normalize
    const maxImp = Math.max(...this.featureImportances.values());
    if (maxImp > 0) {
      this.featureImportances.forEach((v, k) => {
        this.featureImportances.set(k, v / maxImp);
      });
    }
  }

  private calculateAccuracy(X: number[][], y: number[]): number {
    let correct = 0;
    for (let i = 0; i < X.length; i++) {
      const prob = this.classificationModel.predict(X[i]);
      const predicted = prob >= 0.5 ? 1 : 0;
      if (predicted === y[i]) correct++;
    }
    return correct / X.length;
  }

  /**
   * Evaluate model on validation samples
   */
  private evaluate(samples: InterconnectorTrainingSample[]): Omit<InterconnectorModelMetrics, 'trainingSamples' | 'trainingDate'> {
    const predictions = samples.map(s => {
      const prob = this.classificationModel.predict(s.features);
      const predicted = prob >= 0.5 ? 1 : 0;
      const flowFrom = this.regressionModelFrom.predict(s.features);
      return {
        predicted,
        actual: s.isCongested ? 1 : 0,
        probability: prob,
        actualFlowFrom: s.flowFrom,
        predictedFlowFrom: flowFrom
      };
    });

    // Classification metrics
    let tp = 0, tn = 0, fp = 0, fn = 0;
    for (const p of predictions) {
      if (p.actual === 1 && p.predicted === 1) tp++;
      else if (p.actual === 0 && p.predicted === 0) tn++;
      else if (p.actual === 0 && p.predicted === 1) fp++;
      else if (p.actual === 1 && p.predicted === 0) fn++;
    }

    const accuracy = (tp + tn) / predictions.length;
    const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
    const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
    const f1Score = precision + recall > 0 ? 2 * (precision * recall) / (precision + recall) : 0;

    // Regression metrics (for flow prediction)
    const actuals = predictions.map(p => p.actualFlowFrom);
    const predicted = predictions.map(p => p.predictedFlowFrom);
    const n = actuals.length;

    const mae = actuals.reduce((sum, a, i) => sum + Math.abs(a - predicted[i]), 0) / n;
    const mse = actuals.reduce((sum, a, i) => sum + Math.pow(a - predicted[i], 2), 0) / n;
    const rmse = Math.sqrt(mse);

    const mape = actuals.reduce((sum, a, i) => {
      if (a === 0) return sum;
      return sum + Math.abs((a - predicted[i]) / a) * 100;
    }, 0) / n;

    const mean = actuals.reduce((a, b) => a + b, 0) / n;
    const ssTotal = actuals.reduce((sum, a) => sum + Math.pow(a - mean, 2), 0);
    const ssResidual = actuals.reduce((sum, a, i) => sum + Math.pow(a - predicted[i], 2), 0);
    const r2Score = 1 - (ssResidual / ssTotal);

    return {
      accuracy,
      precision,
      recall,
      f1Score,
      confusionMatrix: {
        truePositive: tp,
        trueNegative: tn,
        falsePositive: fp,
        falseNegative: fn
      },
      r2Score,
      mape,
      mae,
      rmse
    };
  }

  /**
   * Predict congestion and flow
   */
  predict(
    features: number[],
    datetime: Date,
    interconnector: string
  ): InterconnectorCongestionPrediction {
    if (!this.ready) {
      throw new Error('Model not trained or loaded');
    }

    // Classification prediction
    const congestionProbability = this.classificationModel.predict(features);

    // Regression prediction
    const expectedFlowFrom = this.regressionModelFrom.predict(features);
    const expectedFlowTo = this.regressionModelTo.predict(features);

    const predictedFlag = congestionProbability >= 0.5 ? 'Y' : 'N';
    const confidence = Math.abs(congestionProbability - 0.5) * 2; // Scale to 0-1

    return {
      datetime,
      interconnector,
      congestionProbability,
      expectedFlowFrom,
      expectedFlowTo,
      predictedFlag,
      confidence
    };
  }

  /**
   * Check if model is ready for prediction
   */
  isReady(): boolean {
    return this.ready;
  }

  /**
   * Get feature importance
   */
  getFeatureImportance(): Map<string, number> {
    return new Map(this.featureImportances);
  }

  /**
   * Serialize model for database storage
   */
  serialize(): string {
    if (!this.ready) {
      throw new Error('Model not trained');
    }

    return JSON.stringify({
      classificationModel: this.classificationModel.serialize(),
      regressionModelFrom: this.regressionModelFrom.serialize(),
      regressionModelTo: this.regressionModelTo.serialize(),
      featureNames: this.featureNames,
      featureImportances: Array.from(this.featureImportances.entries())
    });
  }

  /**
   * Load model from serialized data
   */
  static deserialize(data: string): InterconnectorXGBoostModel {
    const parsed = JSON.parse(data);
    const model = new InterconnectorXGBoostModel();

    model.classificationModel = XGBoostClassifier.deserialize(parsed.classificationModel);
    model.regressionModelFrom = XGBoostRegressor.deserialize(parsed.regressionModelFrom);
    model.regressionModelTo = XGBoostRegressor.deserialize(parsed.regressionModelTo);
    model.featureNames = parsed.featureNames;
    model.featureImportances = new Map(parsed.featureImportances);
    model.ready = true;

    return model;
  }
}
