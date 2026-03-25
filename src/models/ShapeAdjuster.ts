import { DailyRecord, HourlyWeather, WeatherTrajectory } from '../data/DailyAggregator.js';

/**
 * Shape adjustment features for Stage B
 */
export interface ShapeAdjustmentFeatures {
  peakTempHour: number;
  morningRampRate: number;
  eveningCoolRate: number;
  tempRange: number;
  avgTemp: number;
  avgCloudCover: number;
  isDaytimeRain: boolean;
}

/**
 * Configuration for ShapeAdjuster
 */
export interface ShapeAdjusterConfig {
  weatherInfluence: number;     // Multiplier for weather adjustments (0-2)
  adjustmentModel: 'linear';    // Model type (only linear implemented in Phase 1)
}

/**
 * Per-hour regression coefficients
 */
interface HourlyCoefficients {
  peakTempHour: number;
  morningRampRate: number;
  eveningCoolRate: number;
  tempRange: number;
  avgTemp: number;
  avgCloudCover: number;
  isDaytimeRain: number;
  intercept: number;
}

/**
 * ShapeAdjuster - Stage B of Shape Model
 *
 * Responsibilities:
 * 1. Learn per-hour linear corrections based on weather trajectory features
 * 2. Apply weather-based adjustments to base shapes from Stage A
 * 3. Renormalize adjusted shapes to sum to 1.0
 */
export class ShapeAdjuster {
  private config: ShapeAdjusterConfig;
  private coefficients: Map<string, Map<string, HourlyCoefficients[]>>;

  static DEFAULT_CONFIG: ShapeAdjusterConfig = {
    weatherInfluence: 1.0,
    adjustmentModel: 'linear'
  };

  constructor(config: Partial<ShapeAdjusterConfig> = {}) {
    this.config = { ...ShapeAdjuster.DEFAULT_CONFIG, ...config };
    this.coefficients = new Map();
  }

  /**
   * Train Stage B adjustment model
   */
  train(
    dailyRecords: DailyRecord[],
    profileLibrary: Map<string, Map<string, number[]>>
  ): void {
    console.log('Training Shape Adjuster (Stage B)...');

    // Group by area and dayType
    const grouped = new Map<string, Map<string, DailyRecord[]>>();
    for (const record of dailyRecords) {
      if (!grouped.has(record.area)) {
        grouped.set(record.area, new Map());
      }
      const dayTypeMap = grouped.get(record.area)!;
      if (!dayTypeMap.has(record.calendar.dayType)) {
        dayTypeMap.set(record.calendar.dayType, []);
      }
      dayTypeMap.get(record.calendar.dayType)!.push(record);
    }

    // Train per-hour regression for each area+dayType
    for (const [area, dayTypeMap] of grouped) {
      if (!this.coefficients.has(area)) {
        this.coefficients.set(area, new Map());
      }

      for (const [dayType, records] of dayTypeMap) {
        console.log(`Training Stage B for ${area} ${dayType} (${records.length} samples)`);

        const baseShapes = profileLibrary.get(area)?.get(dayType);
        if (!baseShapes) {
          console.warn(`No base shape for ${area} ${dayType}, skipping`);
          continue;
        }

        const coeffs = this.trainHourlyRegression(records, baseShapes);
        this.coefficients.get(area)!.set(dayType, coeffs);
      }
    }

    console.log('Shape Adjuster training complete');
  }

  /**
   * Train per-hour linear regression
   */
  private trainHourlyRegression(
    records: DailyRecord[],
    baseShape: number[]
  ): HourlyCoefficients[] {
    const hourlyCoeffs: HourlyCoefficients[] = [];

    // Train separate regression for each hour
    for (let hour = 0; hour < 24; hour++) {
      const features: number[][] = [];
      const targets: number[] = [];

      for (const record of records) {
        // Extract features
        const isDaytimeRain = this.isDaytimeRain(record.hourlyWeather);
        const feat = [
          record.weatherTrajectory.peakTempHour,
          record.weatherTrajectory.morningRampRate,
          record.weatherTrajectory.eveningCoolRate,
          record.dailyWeather.tempRange,
          record.dailyWeather.avgTemp,
          record.dailyWeather.avgCloudCover,
          isDaytimeRain ? 1 : 0
        ];

        // Target is residual: actual - base
        const residual = record.shape[hour] - baseShape[hour];

        features.push(feat);
        targets.push(residual);
      }

      // Fit linear regression using least squares
      const coeffs = this.fitLinearRegression(features, targets);
      hourlyCoeffs.push(coeffs);
    }

    return hourlyCoeffs;
  }

  /**
   * Fit linear regression using ordinary least squares
   */
  private fitLinearRegression(X: number[][], y: number[]): HourlyCoefficients {
    const n = X.length;
    const p = X[0].length;

    // Add intercept column
    const X_with_intercept = X.map(row => [1, ...row]);

    // Compute X^T * X
    const XtX: number[][] = Array(p + 1).fill(0).map(() => Array(p + 1).fill(0));
    for (let i = 0; i <= p; i++) {
      for (let j = 0; j <= p; j++) {
        for (let k = 0; k < n; k++) {
          XtX[i][j] += X_with_intercept[k][i] * X_with_intercept[k][j];
        }
      }
    }

    // Compute X^T * y
    const Xty: number[] = Array(p + 1).fill(0);
    for (let i = 0; i <= p; i++) {
      for (let k = 0; k < n; k++) {
        Xty[i] += X_with_intercept[k][i] * y[k];
      }
    }

    // Solve (X^T * X) * beta = X^T * y using Gaussian elimination
    const beta = this.solveLinearSystem(XtX, Xty);

    return {
      intercept: beta[0],
      peakTempHour: beta[1],
      morningRampRate: beta[2],
      eveningCoolRate: beta[3],
      tempRange: beta[4],
      avgTemp: beta[5],
      avgCloudCover: beta[6],
      isDaytimeRain: beta[7]
    };
  }

  /**
   * Solve linear system Ax = b using Gaussian elimination
   */
  private solveLinearSystem(A: number[][], b: number[]): number[] {
    const n = A.length;
    const augmented: number[][] = A.map((row, i) => [...row, b[i]]);

    // Forward elimination
    for (let i = 0; i < n; i++) {
      // Find pivot
      let maxRow = i;
      for (let k = i + 1; k < n; k++) {
        if (Math.abs(augmented[k][i]) > Math.abs(augmented[maxRow][i])) {
          maxRow = k;
        }
      }

      // Swap rows
      [augmented[i], augmented[maxRow]] = [augmented[maxRow], augmented[i]];

      // Eliminate column
      for (let k = i + 1; k < n; k++) {
        const factor = augmented[k][i] / augmented[i][i];
        for (let j = i; j <= n; j++) {
          augmented[k][j] -= factor * augmented[i][j];
        }
      }
    }

    // Back substitution
    const x: number[] = Array(n).fill(0);
    for (let i = n - 1; i >= 0; i--) {
      x[i] = augmented[i][n];
      for (let j = i + 1; j < n; j++) {
        x[i] -= augmented[i][j] * x[j];
      }
      x[i] /= augmented[i][i];

      // Handle NaN (singular matrix)
      if (isNaN(x[i])) {
        x[i] = 0;
      }
    }

    return x;
  }

  /**
   * Check if there's precipitation during daytime hours (9 AM - 6 PM)
   */
  private isDaytimeRain(hourlyWeather: HourlyWeather[]): boolean {
    // This is a simplified check - actual implementation should look at precip data
    // For now, return false as placeholder
    return false;
  }

  /**
   * Apply weather-based adjustments to base shape
   */
  adjust(
    area: string,
    dayType: string,
    baseShape: number[],
    features: ShapeAdjustmentFeatures
  ): number[] {
    const areaCoeffs = this.coefficients.get(area);
    if (!areaCoeffs) {
      // No coefficients, return base shape unchanged
      return baseShape;
    }

    const dayTypeCoeffs = areaCoeffs.get(dayType);
    if (!dayTypeCoeffs) {
      // No coefficients for this day type, return base shape unchanged
      return baseShape;
    }

    const adjustedShape: number[] = [];

    for (let hour = 0; hour < 24; hour++) {
      const coeffs = dayTypeCoeffs[hour];

      // Compute raw adjustment
      const rawAdjustment =
        coeffs.intercept +
        coeffs.peakTempHour * features.peakTempHour +
        coeffs.morningRampRate * features.morningRampRate +
        coeffs.eveningCoolRate * features.eveningCoolRate +
        coeffs.tempRange * features.tempRange +
        coeffs.avgTemp * features.avgTemp +
        coeffs.avgCloudCover * features.avgCloudCover +
        coeffs.isDaytimeRain * (features.isDaytimeRain ? 1 : 0);

      // Apply weather influence multiplier
      const scaledAdjustment = this.config.weatherInfluence * rawAdjustment;

      // Apply adjustment to base shape
      adjustedShape.push(baseShape[hour] + scaledAdjustment);
    }

    // Renormalize to sum to 1.0
    const sum = adjustedShape.reduce((s, v) => s + v, 0);
    return adjustedShape.map(v => v / sum);
  }

  /**
   * Extract adjustment features from daily record
   */
  static extractFeatures(record: DailyRecord): ShapeAdjustmentFeatures {
    // Check for daytime rain (hours 9-18)
    const daytimeHours = record.hourlyWeather.slice(9, 19);
    const isDaytimeRain = false; // Placeholder - need precipitation data in hourly weather

    return {
      peakTempHour: record.weatherTrajectory.peakTempHour,
      morningRampRate: record.weatherTrajectory.morningRampRate,
      eveningCoolRate: record.weatherTrajectory.eveningCoolRate,
      tempRange: record.dailyWeather.tempRange,
      avgTemp: record.dailyWeather.avgTemp,
      avgCloudCover: record.dailyWeather.avgCloudCover,
      isDaytimeRain
    };
  }

  /**
   * Serialize adjuster for saving
   */
  serialize(): any {
    const entries: any[] = [];

    for (const [area, dayTypeMap] of this.coefficients) {
      for (const [dayType, coeffs] of dayTypeMap) {
        entries.push({
          area,
          dayType,
          coefficients: coeffs
        });
      }
    }

    return {
      config: this.config,
      entries
    };
  }

  /**
   * Deserialize adjuster from saved state
   */
  static deserialize(data: any): ShapeAdjuster {
    const adjuster = new ShapeAdjuster(data.config);

    for (const entry of data.entries) {
      if (!adjuster.coefficients.has(entry.area)) {
        adjuster.coefficients.set(entry.area, new Map());
      }
      adjuster.coefficients.get(entry.area)!.set(entry.dayType, entry.coefficients);
    }

    return adjuster;
  }
}
