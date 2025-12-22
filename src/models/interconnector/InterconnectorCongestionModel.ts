/**
 * Interconnector Congestion Prediction Model
 *
 * Dual-model approach:
 * 1. Classification: Predict congestion (Y/N) using logistic regression
 * 2. Regression: Predict flow magnitude using linear regression
 */

import MultivariateLinearRegression from 'ml-regression-multivariate-linear';
import {
  InterconnectorTrainingSample,
  InterconnectorCongestionPrediction,
  InterconnectorModelMetrics
} from '../../types/interconnector.js';
import { INTERCONNECTOR_FEATURE_NAMES } from '../../features/interconnectorFeatures.js';

/**
 * Simple logistic regression for binary classification with class weighting
 */
class LogisticRegressionModel {
  private weights: number[] = [];
  private intercept: number = 0;
  private learningRate: number = 0.01;
  private iterations: number = 1000;
  private classWeights: number[] = [1, 1];

  train(X: number[][], y: number[]): { classWeights: number[], classDistribution: { class0: number, class1: number } } {
    const nFeatures = X[0].length;
    this.weights = new Array(nFeatures).fill(0);
    this.intercept = 0;

    // Calculate class weights automatically
    const class0Count = y.filter(label => label === 0).length;
    const class1Count = y.filter(label => label === 1).length;
    const totalSamples = y.length;

    // Weight = total_samples / (n_classes * class_count)
    this.classWeights = [
      totalSamples / (2 * class0Count),  // Weight for class 0
      totalSamples / (2 * class1Count)   // Weight for class 1
    ];

    // Gradient descent with class weighting
    for (let iter = 0; iter < this.iterations; iter++) {
      const gradWeights = new Array(nFeatures).fill(0);
      let gradIntercept = 0;

      for (let i = 0; i < X.length; i++) {
        const prediction = this.sigmoid(this.dotProduct(X[i], this.weights) + this.intercept);
        const error = prediction - y[i];

        // Apply class weight
        const weight = y[i] === 1 ? this.classWeights[1] : this.classWeights[0];
        const weightedError = error * weight;

        for (let j = 0; j < nFeatures; j++) {
          gradWeights[j] += weightedError * X[i][j];
        }
        gradIntercept += weightedError;
      }

      // Update weights
      for (let j = 0; j < nFeatures; j++) {
        this.weights[j] -= (this.learningRate * gradWeights[j]) / X.length;
      }
      this.intercept -= (this.learningRate * gradIntercept) / X.length;
    }

    return {
      classWeights: this.classWeights,
      classDistribution: {
        class0: class0Count,
        class1: class1Count
      }
    };
  }

  predict(x: number[]): number {
    return this.sigmoid(this.dotProduct(x, this.weights) + this.intercept);
  }

  private sigmoid(z: number): number {
    return 1 / (1 + Math.exp(-z));
  }

  private dotProduct(a: number[], b: number[]): number {
    return a.reduce((sum, val, i) => sum + val * b[i], 0);
  }

  getWeights(): number[] {
    return this.weights;
  }

  getIntercept(): number {
    return this.intercept;
  }

  setWeights(weights: number[], intercept: number): void {
    this.weights = weights;
    this.intercept = intercept;
  }
}

/**
 * Main interconnector congestion model
 */
export class InterconnectorCongestionModel {
  private classificationModel: LogisticRegressionModel;
  private regressionModelFrom: MultivariateLinearRegression | null = null;
  private regressionModelTo: MultivariateLinearRegression | null = null;
  private featureNames: string[];
  private ready: boolean = false;

  // Stored coefficients for loaded models
  private storedClassWeights: number[] | null = null;
  private storedClassIntercept: number = 0;
  private storedRegFromWeights: number[][] | null = null;
  private storedRegToWeights: number[][] | null = null;

  constructor() {
    this.classificationModel = new LogisticRegressionModel();
    this.featureNames = INTERCONNECTOR_FEATURE_NAMES;
  }

  /**
   * Train both classification and regression models
   */
  train(samples: InterconnectorTrainingSample[]): InterconnectorModelMetrics & {
    classWeights?: number[],
    classDistribution?: { class0: number, class1: number }
  } {
    if (samples.length === 0) {
      throw new Error('No training samples provided');
    }

    // Split into train/validation (80/20)
    const splitIdx = Math.floor(samples.length * 0.8);
    const trainSamples = samples.slice(0, splitIdx);
    const validSamples = samples.slice(splitIdx);

    // Prepare data
    const X_train = trainSamples.map(s => s.features);
    // Use actual detected constraints instead of misleading CONGESTION_FLAG
    const y_class_train = trainSamples.map(s => s.isActuallyConstrained ? 1 : 0);
    const y_flow_from_train = trainSamples.map(s => [s.flowFrom]);
    const y_flow_to_train = trainSamples.map(s => [s.flowTo]);

    // Train classification model with class weighting
    const trainingInfo = this.classificationModel.train(X_train, y_class_train);

    // Train regression models
    this.regressionModelFrom = new MultivariateLinearRegression(X_train, y_flow_from_train);
    this.regressionModelTo = new MultivariateLinearRegression(X_train, y_flow_to_train);

    this.ready = true;

    // Evaluate on validation set
    const metrics = this.evaluate(validSamples);

    return {
      ...metrics,
      trainingSamples: samples.length,
      trainingDate: new Date().toISOString(),
      classWeights: trainingInfo.classWeights,
      classDistribution: trainingInfo.classDistribution
    };
  }

  /**
   * Evaluate model on validation samples
   */
  private evaluate(samples: InterconnectorTrainingSample[]): Omit<InterconnectorModelMetrics, 'trainingSamples' | 'trainingDate'> {
    const predictions = samples.map(s => {
      const prob = this.classificationModel.predict(s.features);
      const predicted = prob >= 0.5 ? 1 : 0;
      const flowFrom = this.regressionModelFrom!.predict(s.features)[0];
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
    if (!this.ready && !this.storedClassWeights) {
      throw new Error('Model not trained or loaded');
    }

    // Classification prediction
    let congestionProbability: number;
    if (this.storedClassWeights) {
      // Use stored weights
      const logit = features.reduce((sum, val, i) => sum + val * this.storedClassWeights![i], 0) + this.storedClassIntercept;
      congestionProbability = 1 / (1 + Math.exp(-logit));
    } else {
      congestionProbability = this.classificationModel.predict(features);
    }

    // Regression prediction
    let expectedFlowFrom: number;
    let expectedFlowTo: number;

    if (this.storedRegFromWeights) {
      // Use stored weights
      expectedFlowFrom = features.reduce((sum, val, i) => sum + val * this.storedRegFromWeights![i][0], 0);
      expectedFlowTo = features.reduce((sum, val, i) => sum + val * this.storedRegToWeights![i][0], 0);
    } else {
      expectedFlowFrom = this.regressionModelFrom!.predict(features)[0];
      expectedFlowTo = this.regressionModelTo!.predict(features)[0];
    }

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
    return this.ready || this.storedClassWeights !== null;
  }

  /**
   * Serialize model for database storage
   */
  serialize(): string {
    if (!this.ready) {
      throw new Error('Model not trained');
    }

    return JSON.stringify({
      classificationWeights: this.classificationModel.getWeights(),
      classificationIntercept: this.classificationModel.getIntercept(),
      regressionFromWeights: this.regressionModelFrom!.weights,
      regressionToWeights: this.regressionModelTo!.weights,
      featureNames: this.featureNames
    });
  }

  /**
   * Load model from serialized data
   */
  static deserialize(data: string): InterconnectorCongestionModel {
    const parsed = JSON.parse(data);
    const model = new InterconnectorCongestionModel();

    // Store coefficients for prediction
    model.storedClassWeights = parsed.classificationWeights;
    model.storedClassIntercept = parsed.classificationIntercept;
    model.storedRegFromWeights = parsed.regressionFromWeights;
    model.storedRegToWeights = parsed.regressionToWeights;
    model.featureNames = parsed.featureNames;

    return model;
  }
}
