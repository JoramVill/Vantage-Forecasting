/**
 * Calibrator - Learns and applies bias corrections from recent actuals
 *
 * Responsibilities:
 * 1. Level Calibration: Compute daily total scale factors per area
 * 2. Shape Calibration: Compute per-hour correction factors per area
 * 3. Asymmetric Clamping: Protect peaks and troughs differently
 * 4. Renormalization: Ensure shapes sum to 1.0 after correction
 */

export interface CalibrationConfig {
  levelClamp: [number, number];    // Min/max level scale [0.90, 1.10]
  shapeClamp: [number, number];    // Min/max shape correction [0.88, 1.12]
  peakBias: number;                 // Peak protection bias (0-1), default 0.3
}

export interface CalibrationFactors {
  levelScale: Map<string, number>;           // Area → daily total scale factor
  shapeCorrection: Map<string, number[]>;    // Area → 24-hour correction factors
}

/**
 * Historical shape medians for determining peak/trough hours
 */
interface AreaShapeMedians {
  area: string;
  medianShape: number[];  // 24-hour median shape
  peakHours: number[];    // Top 6 hours by median value
  troughHours: number[];  // Bottom 6 hours by median value
}

export class Calibrator {
  private config: CalibrationConfig;
  private areaShapeMedians: Map<string, AreaShapeMedians>;

  static DEFAULT_CONFIG: CalibrationConfig = {
    levelClamp: [0.90, 1.10],
    shapeClamp: [0.88, 1.12],
    peakBias: 0.3
  };

  constructor(config: Partial<CalibrationConfig> = {}) {
    this.config = { ...Calibrator.DEFAULT_CONFIG, ...config };
    this.areaShapeMedians = new Map();
  }

  /**
   * Compute calibration factors from recent actuals vs predictions
   *
   * @param calibrationData Array of {area, date, actualTotal, predictedTotal, actualShape, predictedShape}
   * @returns Calibration factors (level scales + shape corrections)
   */
  computeCalibrationFactors(calibrationData: Array<{
    area: string;
    date: string;
    actualTotal: number;
    predictedTotal: number;
    actualShape: number[];    // 24 values summing to 1.0
    predictedShape: number[]; // 24 values summing to 1.0
  }>): CalibrationFactors {
    const levelRatios = new Map<string, number[]>();
    const shapeRatios = new Map<string, number[][]>();

    // Collect ratios per area
    for (const record of calibrationData) {
      // Level ratio: actual / predicted daily total
      const levelRatio = record.actualTotal / record.predictedTotal;
      if (!levelRatios.has(record.area)) {
        levelRatios.set(record.area, []);
      }
      levelRatios.get(record.area)!.push(levelRatio);

      // Shape ratio per hour: actual[h] / predicted[h]
      if (!shapeRatios.has(record.area)) {
        shapeRatios.set(record.area, Array.from({ length: 24 }, () => []));
      }
      const hourlyRatios = shapeRatios.get(record.area)!;
      for (let h = 0; h < 24; h++) {
        if (record.predictedShape[h] > 0) {
          hourlyRatios[h].push(record.actualShape[h] / record.predictedShape[h]);
        }
      }
    }

    // Compute level scale factors (mean ratio per area, clamped)
    const levelScale = new Map<string, number>();
    for (const [area, ratios] of levelRatios.entries()) {
      const meanRatio = ratios.reduce((sum, r) => sum + r, 0) / ratios.length;
      const clamped = this.clampValue(meanRatio, this.config.levelClamp[0], this.config.levelClamp[1]);
      levelScale.set(area, clamped);

      if (Math.abs(clamped - 1.0) > 0.03) {
        console.warn(`[Calibrator] ${area} level scale = ${clamped.toFixed(3)} (${(clamped - 1.0) > 0 ? '+' : ''}${((clamped - 1.0) * 100).toFixed(1)}%)`);
      }
    }

    // Compute shape correction factors (mean ratio per area per hour, asymmetrically clamped)
    const shapeCorrection = new Map<string, number[]>();
    for (const [area, hourlyRatios] of shapeRatios.entries()) {
      const corrections = hourlyRatios.map((ratios, h) => {
        if (ratios.length === 0) return 1.0;
        const meanRatio = ratios.reduce((sum, r) => sum + r, 0) / ratios.length;

        // Asymmetric clamping based on hour type
        const { lowerClamp, upperClamp } = this.getAsymmetricClamps(area, h);
        return this.clampValue(meanRatio, lowerClamp, upperClamp);
      });

      // Renormalize to preserve sum = 1.0
      const sum = corrections.reduce((s, v) => s + v, 0);
      const normalized = corrections.map(v => v / sum);

      shapeCorrection.set(area, normalized);

      // Log significant corrections
      const maxDeviation = Math.max(...normalized.map(v => Math.abs(v - 1.0)));
      if (maxDeviation > 0.05) {
        console.warn(`[Calibrator] ${area} shape correction max deviation = ${(maxDeviation * 100).toFixed(1)}%`);
      }
    }

    return { levelScale, shapeCorrection };
  }

  /**
   * Apply calibration factors to a forecast
   *
   * @param area Area code
   * @param predictedTotal Predicted daily total
   * @param predictedShape Predicted 24-hour shape
   * @param factors Calibration factors
   * @returns Calibrated {total, shape}
   */
  applyCalibration(
    area: string,
    predictedTotal: number,
    predictedShape: number[],
    factors: CalibrationFactors
  ): { calibratedTotal: number; calibratedShape: number[] } {
    // Apply level scale
    const levelScale = factors.levelScale.get(area) || 1.0;
    const calibratedTotal = predictedTotal * levelScale;

    // Apply shape correction
    const shapeCorr = factors.shapeCorrection.get(area);
    if (!shapeCorr) {
      // No calibration for this area - return predicted shape unchanged
      return { calibratedTotal, calibratedShape: predictedShape };
    }

    const corrected = predictedShape.map((val, h) => val * shapeCorr[h]);

    // Renormalize to sum to 1.0
    const sum = corrected.reduce((s, v) => s + v, 0);
    const calibratedShape = corrected.map(v => v / sum);

    return { calibratedTotal, calibratedShape };
  }

  /**
   * Set historical shape medians for asymmetric clamping
   * @param dailyRecords Training data to compute medians from
   */
  setHistoricalShapeMedians(dailyRecords: Array<{
    area: string;
    shape: number[];
  }>): void {
    const areaShapes = new Map<string, number[][]>();

    // Collect shapes per area
    for (const record of dailyRecords) {
      if (!areaShapes.has(record.area)) {
        areaShapes.set(record.area, []);
      }
      areaShapes.get(record.area)!.push(record.shape);
    }

    // Compute medians per area
    for (const [area, shapes] of areaShapes.entries()) {
      const medianShape = this.computeMedianShape(shapes);

      // Identify peak and trough hours
      const hourValues = medianShape.map((val, h) => ({ hour: h, value: val }));
      hourValues.sort((a, b) => b.value - a.value);

      const peakHours = hourValues.slice(0, 6).map(hv => hv.hour);
      const troughHours = hourValues.slice(-6).map(hv => hv.hour);

      this.areaShapeMedians.set(area, {
        area,
        medianShape,
        peakHours,
        troughHours
      });
    }
  }

  /**
   * Get asymmetric clamps for a specific hour in an area
   * Peak hours get wider upward clamps, trough hours get wider downward clamps
   */
  private getAsymmetricClamps(area: string, hour: number): { lowerClamp: number; upperClamp: number } {
    const baseClamp = this.config.shapeClamp;
    const peakBias = this.config.peakBias;

    const medians = this.areaShapeMedians.get(area);
    if (!medians) {
      // No historical data - use symmetric clamps
      return { lowerClamp: baseClamp[0], upperClamp: baseClamp[1] };
    }

    const isPeak = medians.peakHours.includes(hour);
    const isTrough = medians.troughHours.includes(hour);

    if (isPeak) {
      // Peak hours: allow more upward correction
      return {
        lowerClamp: baseClamp[0],
        upperClamp: baseClamp[1] + peakBias * 0.06
      };
    } else if (isTrough) {
      // Trough hours: allow more downward correction
      return {
        lowerClamp: baseClamp[0] - peakBias * 0.06,
        upperClamp: baseClamp[1]
      };
    } else {
      // Shoulder hours: symmetric
      return { lowerClamp: baseClamp[0], upperClamp: baseClamp[1] };
    }
  }

  /**
   * Clamp a value to [min, max]
   */
  private clampValue(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
  }

  /**
   * Compute element-wise median of an array of shapes
   */
  private computeMedianShape(shapes: number[][]): number[] {
    if (shapes.length === 0) {
      return Array(24).fill(1 / 24);
    }

    const medianShape: number[] = [];
    for (let h = 0; h < 24; h++) {
      const values = shapes.map(s => s[h]).sort((a, b) => a - b);
      const mid = Math.floor(values.length / 2);
      if (values.length % 2 === 0) {
        medianShape.push((values[mid - 1] + values[mid]) / 2);
      } else {
        medianShape.push(values[mid]);
      }
    }

    return medianShape;
  }
}
