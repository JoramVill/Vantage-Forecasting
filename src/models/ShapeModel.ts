import { DailyRecord, DailyWeather } from '../data/DailyAggregator.js';
import { ProfileLibrary, ProfileLibraryConfig } from './ProfileLibrary.js';
import { ShapeAdjuster, ShapeAdjusterConfig, ShapeAdjustmentFeatures } from './ShapeAdjuster.js';

/**
 * Configuration for ShapeModel
 */
export interface ShapeModelConfig {
  profileLibrary: Partial<ProfileLibraryConfig>;
  shapeAdjuster: Partial<ShapeAdjusterConfig>;
  archetypeBlending: number;    // Blend between archetype and median (0-1)
}

/**
 * ShapeModel - Predicts normalized 24-hour demand profile
 *
 * Combines two stages:
 * - Stage A (ProfileLibrary): Select archetype based on weather
 * - Stage B (ShapeAdjuster): Apply weather-based corrections
 *
 * Output: 24 values that sum to 1.0
 */
export class ShapeModel {
  private config: ShapeModelConfig;
  private profileLibrary: ProfileLibrary;
  private shapeAdjuster: ShapeAdjuster;

  static DEFAULT_CONFIG: ShapeModelConfig = {
    profileLibrary: {},
    shapeAdjuster: {},
    archetypeBlending: 0.8
  };

  constructor(config: Partial<ShapeModelConfig> = {}) {
    this.config = { ...ShapeModel.DEFAULT_CONFIG, ...config };
    this.profileLibrary = new ProfileLibrary(this.config.profileLibrary);
    this.shapeAdjuster = new ShapeAdjuster(this.config.shapeAdjuster);
  }

  /**
   * Train both stages of the shape model
   */
  train(dailyRecords: DailyRecord[]): {
    shapeMAPE: number;
    peakHourAccuracy: number;
    profileCorrelation: number;
  } {
    console.log('Training Shape Model...');

    // Stage A: Build profile library with archetypes
    this.profileLibrary.build(dailyRecords);

    // Get base shapes for Stage B training
    const baseShapes = new Map<string, Map<string, number[]>>();
    for (const record of dailyRecords) {
      if (!baseShapes.has(record.area)) {
        baseShapes.set(record.area, new Map());
      }
      if (!baseShapes.get(record.area)!.has(record.calendar.dayType)) {
        // Get archetype for this area+dayType
        const archetype = this.profileLibrary.selectArchetype(
          record.area,
          record.calendar.dayType,
          record.dailyWeather
        );
        const median = this.profileLibrary.getOverallMedian(record.area, record.calendar.dayType);

        // Blend archetype with median
        const blended = archetype.map((val, h) =>
          this.config.archetypeBlending * val + (1 - this.config.archetypeBlending) * median[h]
        );

        // Renormalize
        const sum = blended.reduce((s, v) => s + v, 0);
        const normalized = blended.map(v => v / sum);

        baseShapes.get(record.area)!.set(record.calendar.dayType, normalized);
      }
    }

    // Stage B: Train weather adjustments
    this.shapeAdjuster.train(dailyRecords, baseShapes);

    // Evaluate on training data
    const metrics = this.evaluate(dailyRecords);

    console.log(`Shape MAPE: ${metrics.shapeMAPE.toFixed(2)}%`);
    console.log(`Peak hour accuracy: ${metrics.peakHourAccuracy.toFixed(1)} hours`);
    console.log(`Profile correlation: ${metrics.profileCorrelation.toFixed(3)}`);

    return metrics;
  }

  /**
   * Predict shape for a given area, day type, and weather
   */
  predict(
    area: string,
    dayType: string,
    dailyWeather: DailyWeather,
    adjustmentFeatures: ShapeAdjustmentFeatures
  ): number[] {
    // Stage A: Select archetype based on weather
    const archetype = this.profileLibrary.selectArchetype(area, dayType, dailyWeather);
    const median = this.profileLibrary.getOverallMedian(area, dayType);

    // Blend archetype with median
    const blended = archetype.map((val, h) =>
      this.config.archetypeBlending * val + (1 - this.config.archetypeBlending) * median[h]
    );

    // Renormalize after blending
    const blendSum = blended.reduce((s, v) => s + v, 0);
    const baseShape = blended.map(v => v / blendSum);

    // Stage B: Apply weather-based adjustments
    const adjustedShape = this.shapeAdjuster.adjust(area, dayType, baseShape, adjustmentFeatures);

    // Final validation: ensure sum = 1.0
    const finalSum = adjustedShape.reduce((s, v) => s + v, 0);
    if (Math.abs(finalSum - 1.0) > 0.001) {
      console.warn(`Shape sum ${finalSum} != 1.0 for ${area} ${dayType}`);
      // Renormalize
      return adjustedShape.map(v => v / finalSum);
    }

    return adjustedShape;
  }

  /**
   * Evaluate model on daily records
   */
  private evaluate(dailyRecords: DailyRecord[]): {
    shapeMAPE: number;
    peakHourAccuracy: number;
    profileCorrelation: number;
  } {
    let totalMAPE = 0;
    let totalPeakError = 0;
    let totalCorrelation = 0;
    let count = 0;

    for (const record of dailyRecords) {
      const features = ShapeAdjuster.extractFeatures(record);
      const predicted = this.predict(
        record.area,
        record.calendar.dayType,
        record.dailyWeather,
        features
      );

      // Shape MAPE
      const shapeMAPE = this.computeShapeMAPE(record.shape, predicted);
      totalMAPE += shapeMAPE;

      // Peak hour accuracy
      const actualPeak = this.findPeakHour(record.shape);
      const predictedPeak = this.findPeakHour(predicted);
      totalPeakError += Math.abs(actualPeak - predictedPeak);

      // Profile correlation
      const correlation = this.computeCorrelation(record.shape, predicted);
      totalCorrelation += correlation;

      count++;
    }

    return {
      shapeMAPE: totalMAPE / count,
      peakHourAccuracy: totalPeakError / count,
      profileCorrelation: totalCorrelation / count
    };
  }

  /**
   * Compute MAPE between actual and predicted shapes
   */
  private computeShapeMAPE(actual: number[], predicted: number[]): number {
    let sumPctError = 0;
    for (let h = 0; h < 24; h++) {
      const error = Math.abs(actual[h] - predicted[h]);
      sumPctError += (error / actual[h]) * 100;
    }
    return sumPctError / 24;
  }

  /**
   * Find peak hour in shape
   */
  private findPeakHour(shape: number[]): number {
    let maxVal = -Infinity;
    let maxHour = 0;
    for (let h = 0; h < 24; h++) {
      if (shape[h] > maxVal) {
        maxVal = shape[h];
        maxHour = h;
      }
    }
    return maxHour;
  }

  /**
   * Compute Pearson correlation between shapes
   */
  private computeCorrelation(actual: number[], predicted: number[]): number {
    const n = actual.length;

    // Means
    const meanActual = actual.reduce((s, v) => s + v, 0) / n;
    const meanPred = predicted.reduce((s, v) => s + v, 0) / n;

    // Covariance and standard deviations
    let cov = 0;
    let varActual = 0;
    let varPred = 0;

    for (let i = 0; i < n; i++) {
      const diffActual = actual[i] - meanActual;
      const diffPred = predicted[i] - meanPred;

      cov += diffActual * diffPred;
      varActual += diffActual * diffActual;
      varPred += diffPred * diffPred;
    }

    const stdActual = Math.sqrt(varActual);
    const stdPred = Math.sqrt(varPred);

    if (stdActual === 0 || stdPred === 0) {
      return 0;
    }

    return cov / (stdActual * stdPred);
  }

  /**
   * Serialize model for saving
   */
  serialize(): any {
    return {
      config: this.config,
      profileLibrary: this.profileLibrary.serialize(),
      shapeAdjuster: this.shapeAdjuster.serialize()
    };
  }

  /**
   * Deserialize model from saved state
   */
  static deserialize(data: any): ShapeModel {
    const model = new ShapeModel(data.config);
    model.profileLibrary = ProfileLibrary.deserialize(data.profileLibrary);
    model.shapeAdjuster = ShapeAdjuster.deserialize(data.shapeAdjuster);
    return model;
  }
}
