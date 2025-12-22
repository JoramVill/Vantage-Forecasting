/**
 * XGBoost Regressor for Capacity Factor Models
 *
 * Reusable gradient boosting implementation optimized for capacity factor predictions.
 * Adapted from the interconnector model's XGBoostRegressor but tailored for CFac use cases:
 * - Supports asymmetric loss (quantile regression) to reduce under-forecasting bias
 * - Optimized hyperparameters for 0-1 bounded predictions
 * - Lightweight serialization for model persistence
 */

export interface XGBoostRegressorOptions {
  maxDepth?: number;
  learningRate?: number;
  nEstimators?: number;
  minChildWeight?: number;
  subsample?: number;
  alpha?: number;  // Quantile parameter: 0.5 = symmetric, >0.5 = penalize under-predictions more
}

interface TreeNode {
  value?: number;
  featureIdx?: number;
  threshold?: number;
  left?: TreeNode;
  right?: TreeNode;
}

export class CFacXGBoostRegressor {
  private trees: TreeNode[] = [];
  private basePrediction: number = 0;
  private learningRate: number = 0.1;
  private maxDepth: number = 6;
  private nEstimators: number = 100;
  private minChildWeight: number = 1;
  private subsample: number = 0.8;
  private alpha: number = 0.5;  // 0.5 = symmetric MSE, >0.5 = penalize under-predictions

  constructor(options?: XGBoostRegressorOptions) {
    if (options) {
      this.maxDepth = options.maxDepth ?? 6;
      this.learningRate = options.learningRate ?? 0.1;
      this.nEstimators = options.nEstimators ?? 100;
      this.minChildWeight = options.minChildWeight ?? 1;
      this.subsample = options.subsample ?? 0.8;
      this.alpha = options.alpha ?? 0.5;
    }
  }

  /**
   * Train the model using gradient boosting
   *
   * @param X - Feature matrix [samples x features]
   * @param y - Target values [samples]
   */
  train(X: number[][], y: number[]): void {
    if (X.length === 0 || y.length === 0 || X.length !== y.length) {
      throw new Error('Invalid training data dimensions');
    }

    // Initialize with median (robust to outliers)
    const sortedY = [...y].sort((a, b) => a - b);
    this.basePrediction = sortedY[Math.floor(sortedY.length / 2)];

    // Initialize predictions
    const predictions = new Array(y.length).fill(this.basePrediction);

    // Build trees iteratively
    for (let round = 0; round < this.nEstimators; round++) {
      // Calculate gradients (residuals with asymmetric loss)
      const gradients = this.calculateGradients(y, predictions);

      // Sample data for stochastic gradient boosting
      const sampleSize = Math.floor(X.length * this.subsample);
      const indices = this.sampleIndices(X.length, sampleSize);
      const X_sample = indices.map(i => X[i]);
      const grad_sample = indices.map(i => gradients[i]);

      // Build tree
      const tree = this.buildTree(X_sample, grad_sample, 0);
      this.trees.push(tree);

      // Update predictions
      for (let i = 0; i < X.length; i++) {
        const treePred = this.predictTree(tree, X[i]) * this.learningRate;
        predictions[i] += treePred;
      }
    }
  }

  /**
   * Calculate gradients for asymmetric loss function
   *
   * For quantile regression with alpha:
   * - gradient = alpha if actual > predicted (under-prediction)
   * - gradient = -(1-alpha) if actual < predicted (over-prediction)
   *
   * alpha = 0.5 → symmetric (standard MSE)
   * alpha > 0.5 → penalize under-predictions more
   * alpha < 0.5 → penalize over-predictions more
   */
  private calculateGradients(y: number[], predictions: number[]): number[] {
    const gradients: number[] = [];

    for (let i = 0; i < y.length; i++) {
      const residual = y[i] - predictions[i];

      if (this.alpha === 0.5) {
        // Standard MSE gradient (symmetric)
        gradients.push(residual);
      } else {
        // Asymmetric quantile loss gradient
        if (residual > 0) {
          // Under-prediction: scale by alpha
          gradients.push(residual * this.alpha);
        } else {
          // Over-prediction: scale by (1-alpha)
          gradients.push(residual * (1 - this.alpha));
        }
      }
    }

    return gradients;
  }

  /**
   * Sample indices without replacement
   */
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

  /**
   * Build a regression tree recursively
   */
  private buildTree(
    X: number[][],
    gradients: number[],
    depth: number
  ): TreeNode {
    // Stopping criteria
    if (X.length === 0 || depth >= this.maxDepth || X.length < this.minChildWeight) {
      const mean = gradients.reduce((a, b) => a + b, 0) / gradients.length;
      return { value: isNaN(mean) ? 0 : mean };
    }

    // Find best split
    let bestGain = 0;
    let bestSplit = { featureIdx: 0, threshold: 0 };
    const currentMean = gradients.reduce((a, b) => a + b, 0) / gradients.length;
    const currentVariance = gradients.reduce((sum, g) => sum + Math.pow(g - currentMean, 2), 0);

    // Sample features (random forest style)
    const numFeatures = X[0].length;
    const featuresToTry = Math.min(numFeatures, Math.max(5, Math.floor(Math.sqrt(numFeatures))));
    const featureIndices: number[] = [];

    for (let i = 0; i < featuresToTry; i++) {
      let idx = Math.floor(Math.random() * numFeatures);
      while (featureIndices.includes(idx)) {
        idx = Math.floor(Math.random() * numFeatures);
      }
      featureIndices.push(idx);
    }

    // Try splits on sampled features
    for (const f of featureIndices) {
      const sortedIndices = X.map((_, i) => i).sort((a, b) => X[a][f] - X[b][f]);

      // Try split points (sample 20 per feature for speed)
      const step = Math.max(1, Math.floor(sortedIndices.length / 20));
      for (let s = step; s < sortedIndices.length - step; s += step) {
        const leftIndices = sortedIndices.slice(0, s);
        const rightIndices = sortedIndices.slice(s);

        // Enforce minimum leaf size
        if (leftIndices.length < 5 || rightIndices.length < 5) continue;

        const leftGrad = leftIndices.map(i => gradients[i]);
        const rightGrad = rightIndices.map(i => gradients[i]);

        const leftMean = leftGrad.reduce((a, b) => a + b, 0) / leftGrad.length;
        const rightMean = rightGrad.reduce((a, b) => a + b, 0) / rightGrad.length;

        const leftVar = leftGrad.reduce((sum, g) => sum + Math.pow(g - leftMean, 2), 0);
        const rightVar = rightGrad.reduce((sum, g) => sum + Math.pow(g - rightMean, 2), 0);

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

    // If no good split found, return leaf
    if (bestGain <= 0) {
      return { value: isNaN(currentMean) ? 0 : currentMean };
    }

    // Split data and recurse
    const leftX: number[][] = [];
    const leftGrad: number[] = [];
    const rightX: number[][] = [];
    const rightGrad: number[] = [];

    for (let i = 0; i < X.length; i++) {
      if (X[i][bestSplit.featureIdx] <= bestSplit.threshold) {
        leftX.push(X[i]);
        leftGrad.push(gradients[i]);
      } else {
        rightX.push(X[i]);
        rightGrad.push(gradients[i]);
      }
    }

    return {
      featureIdx: bestSplit.featureIdx,
      threshold: bestSplit.threshold,
      left: this.buildTree(leftX, leftGrad, depth + 1),
      right: this.buildTree(rightX, rightGrad, depth + 1)
    };
  }

  /**
   * Predict using a single tree
   */
  private predictTree(tree: TreeNode, x: number[]): number {
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
      return tree.left ? this.predictTree(tree.left, x) : 0;
    } else {
      return tree.right ? this.predictTree(tree.right, x) : 0;
    }
  }

  /**
   * Make prediction for a single sample
   */
  predict(x: number[]): number {
    let prediction = this.basePrediction;
    for (const tree of this.trees) {
      prediction += this.predictTree(tree, x) * this.learningRate;
    }
    return prediction;
  }

  /**
   * Serialize model for storage
   */
  serialize(): any {
    return {
      trees: this.trees,
      basePrediction: this.basePrediction,
      learningRate: this.learningRate,
      maxDepth: this.maxDepth,
      nEstimators: this.nEstimators,
      minChildWeight: this.minChildWeight,
      subsample: this.subsample,
      alpha: this.alpha
    };
  }

  /**
   * Deserialize model from storage
   */
  static deserialize(data: any): CFacXGBoostRegressor {
    const model = new CFacXGBoostRegressor();
    model.trees = data.trees;
    model.basePrediction = data.basePrediction;
    model.learningRate = data.learningRate;
    model.maxDepth = data.maxDepth;
    model.nEstimators = data.nEstimators;
    model.minChildWeight = data.minChildWeight ?? 1;
    model.subsample = data.subsample ?? 0.8;
    model.alpha = data.alpha ?? 0.5;
    return model;
  }

  /**
   * Get model info
   */
  getInfo(): {
    nTrees: number;
    maxDepth: number;
    learningRate: number;
    alpha: number;
  } {
    return {
      nTrees: this.trees.length,
      maxDepth: this.maxDepth,
      learningRate: this.learningRate,
      alpha: this.alpha
    };
  }
}
