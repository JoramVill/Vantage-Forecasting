/**
 * WindCubicModel - Physics-Based Cubic/Polynomial Power Curve Model
 *
 * Uses the fundamental wind power physics equation:
 *   P = 0.5 × ρ × A × Cp × v³
 *
 * Simplified to capacity factor with polynomial calibration:
 *   CF = min(1, max(0, a × v³ + b × v² + c × v + d))
 *
 * This approach models the true turbine power curve regions:
 * - Cut-in speed (typically 3-4 m/s): CF = 0 below this
 * - Cubic region (cut-in to rated): CF follows cubic curve
 * - Rated speed (typically 12-15 m/s): CF approaches 1.0
 * - Cut-out speed (typically 25 m/s): CF = 0 above this (storm protection)
 */

import {
  StationType,
  CFacWeatherFeatures,
  MRECCalibrationData,
} from '../../types/capacityFactor.js';

/**
 * Cubic power curve calibration factors for a single station
 */
export interface CubicPowerCurveFactors {
  stationCode: string;
  stationType: StationType;

  // Polynomial coefficients: CF = a*v³ + b*v² + c*v + d
  a: number;  // Cubic coefficient
  b: number;  // Quadratic coefficient
  c: number;  // Linear coefficient
  d: number;  // Constant term

  // Turbine operational parameters (m/s)
  cutInSpeed: number;   // Minimum wind speed for operation (typically 3-4 m/s)
  ratedSpeed: number;   // Speed at which turbine reaches rated power (typically 12-15 m/s)
  cutOutSpeed: number;  // Maximum safe wind speed (typically 25 m/s)

  // Calibration metadata
  calibrated: boolean;
  calibrationDate?: Date;
  sampleCount?: number;

  // Calibration quality metrics
  stats?: {
    rmse: number;          // Root Mean Square Error
    r2: number;            // R-squared coefficient of determination
    meanWindSpeed: number; // Average wind speed in training data
    meanCF: number;        // Average capacity factor in training data
    maxCF: number;         // Maximum observed capacity factor
  };
}

export class WindCubicModel {
  private stationCode: string;
  private factors: CubicPowerCurveFactors | null = null;

  constructor(stationCode: string) {
    this.stationCode = stationCode;
  }

  /**
   * Calibrate polynomial power curve from historical data
   * Uses least squares regression to fit: CF = a*v³ + b*v² + c*v + d
   *
   * @param data - Array of paired (capacity factor, wind speed) samples
   * @returns Calibrated power curve factors
   */
  calibrate(data: MRECCalibrationData[]): CubicPowerCurveFactors {
    // Filter data for this station
    const stationData = data.filter(d => d.stationCode === this.stationCode);

    if (stationData.length < 100) {
      console.warn(`Insufficient data for ${this.stationCode}: ${stationData.length} samples (need 100+)`);
      return this.createUncalibratedFactors();
    }

    // Step 1: Estimate turbine operational parameters from data distribution
    const windSpeeds = stationData.map(d => d.windSpeed).sort((a, b) => a - b);
    const capacityFactors = stationData.map(d => d.capacityFactor);

    // Cut-in: find minimum wind speed where CF > 0.05
    let cutInSpeed = 3.0; // default
    for (const sample of stationData) {
      if (sample.capacityFactor > 0.05) {
        cutInSpeed = Math.max(2.0, sample.windSpeed - 1.0);
        break;
      }
    }

    // Rated speed: find wind speed where CF consistently approaches 1.0
    // Use 90th percentile of wind speeds where CF > 0.8
    const highCFSamples = stationData
      .filter(d => d.capacityFactor > 0.8)
      .map(d => d.windSpeed)
      .sort((a, b) => a - b);

    let ratedSpeed = 12.0; // default
    if (highCFSamples.length > 0) {
      const p90Index = Math.floor(highCFSamples.length * 0.9);
      ratedSpeed = Math.max(10.0, highCFSamples[p90Index] || 12.0);
    }

    // Cut-out: use maximum observed wind speed or standard 25 m/s
    const maxWind = Math.max(...windSpeeds);
    const cutOutSpeed = Math.min(25.0, Math.max(20.0, maxWind + 2.0));

    // Step 2: Filter data to operational range (cut-in to cut-out)
    const operationalData = stationData.filter(
      d => d.windSpeed >= cutInSpeed && d.windSpeed <= cutOutSpeed
    );

    if (operationalData.length < 50) {
      console.warn(`Insufficient operational data for ${this.stationCode}: ${operationalData.length} samples`);
      return this.createUncalibratedFactors();
    }

    // Step 3: Build least squares regression matrices
    // We solve: [X]ᵀ[X] × coeffs = [X]ᵀ × Y
    // where X is the design matrix [v³, v², v, 1] and Y is the CF vector

    const n = operationalData.length;
    const X: number[][] = [];
    const Y: number[] = [];

    for (const sample of operationalData) {
      const v = sample.windSpeed;
      X.push([v * v * v, v * v, v, 1]); // [v³, v², v, 1]
      Y.push(sample.capacityFactor);
    }

    // Compute [X]ᵀ[X] (4x4 matrix)
    const XtX: number[][] = [
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ];

    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        let sum = 0;
        for (let k = 0; k < n; k++) {
          sum += X[k][i] * X[k][j];
        }
        XtX[i][j] = sum;
      }
    }

    // Compute [X]ᵀ × Y (4x1 vector)
    const XtY: number[] = [0, 0, 0, 0];
    for (let i = 0; i < 4; i++) {
      let sum = 0;
      for (let k = 0; k < n; k++) {
        sum += X[k][i] * Y[k];
      }
      XtY[i] = sum;
    }

    // Solve [X]ᵀ[X] × coeffs = [X]ᵀY using Gaussian elimination
    const coeffs = this.solveLinearSystem(XtX, XtY);

    if (!coeffs) {
      console.warn(`Linear system solve failed for ${this.stationCode}`);
      return this.createUncalibratedFactors();
    }

    const [a, b, c, d] = coeffs;

    // Step 4: Calculate quality metrics
    let sumSquaredError = 0;
    let sumCF = 0;
    let maxCF = 0;
    let sumWind = 0;

    for (const sample of operationalData) {
      const v = sample.windSpeed;
      const predicted = this.evaluatePolynomial(a, b, c, d, v);
      const error = sample.capacityFactor - predicted;
      sumSquaredError += error * error;
      sumCF += sample.capacityFactor;
      sumWind += v;
      if (sample.capacityFactor > maxCF) {
        maxCF = sample.capacityFactor;
      }
    }

    const rmse = Math.sqrt(sumSquaredError / n);
    const meanCF = sumCF / n;
    const meanWindSpeed = sumWind / n;

    // Calculate R²
    let totalSumSquares = 0;
    for (const sample of operationalData) {
      const deviation = sample.capacityFactor - meanCF;
      totalSumSquares += deviation * deviation;
    }
    const r2 = totalSumSquares > 0 ? 1 - (sumSquaredError / totalSumSquares) : 0;

    // Create factors object
    this.factors = {
      stationCode: this.stationCode,
      stationType: StationType.WIND,
      a,
      b,
      c,
      d,
      cutInSpeed,
      ratedSpeed,
      cutOutSpeed,
      calibrated: true,
      calibrationDate: new Date(),
      sampleCount: operationalData.length,
      stats: {
        rmse,
        r2,
        meanWindSpeed,
        meanCF,
        maxCF,
      },
    };

    return this.factors;
  }

  /**
   * Evaluate polynomial: CF = a*v³ + b*v² + c*v + d
   * Clamps result to [0, 1] range
   */
  private evaluatePolynomial(a: number, b: number, c: number, d: number, v: number): number {
    const result = a * v * v * v + b * v * v + c * v + d;
    return Math.min(1.0, Math.max(0.0, result));
  }

  /**
   * Solve linear system Ax = b using Gaussian elimination with partial pivoting
   * @param A - Coefficient matrix (4x4)
   * @param b - Right-hand side vector (4x1)
   * @returns Solution vector x or null if singular
   */
  private solveLinearSystem(A: number[][], b: number[]): number[] | null {
    const n = 4;
    // Create augmented matrix [A|b]
    const aug: number[][] = A.map((row, i) => [...row, b[i]]);

    // Forward elimination with partial pivoting
    for (let k = 0; k < n; k++) {
      // Find pivot
      let maxRow = k;
      let maxVal = Math.abs(aug[k][k]);
      for (let i = k + 1; i < n; i++) {
        const absVal = Math.abs(aug[i][k]);
        if (absVal > maxVal) {
          maxVal = absVal;
          maxRow = i;
        }
      }

      // Check for singular matrix
      if (maxVal < 1e-10) {
        return null;
      }

      // Swap rows if needed
      if (maxRow !== k) {
        [aug[k], aug[maxRow]] = [aug[maxRow], aug[k]];
      }

      // Eliminate column k
      for (let i = k + 1; i < n; i++) {
        const factor = aug[i][k] / aug[k][k];
        for (let j = k; j <= n; j++) {
          aug[i][j] -= factor * aug[k][j];
        }
      }
    }

    // Back substitution
    const x: number[] = new Array(n);
    for (let i = n - 1; i >= 0; i--) {
      let sum = aug[i][n];
      for (let j = i + 1; j < n; j++) {
        sum -= aug[i][j] * x[j];
      }
      x[i] = sum / aug[i][i];
    }

    return x;
  }

  /**
   * Create uncalibrated factors with reasonable defaults
   * Based on typical IEC Class II turbine power curves
   */
  private createUncalibratedFactors(): CubicPowerCurveFactors {
    // Default coefficients for a typical turbine
    // These approximate: CF = 0 at v=3, CF ≈ 1 at v=12
    // Rough approximation: CF ≈ 0.008*v³ - 0.06*v² + 0.15*v - 0.12
    this.factors = {
      stationCode: this.stationCode,
      stationType: StationType.WIND,
      a: 0.008,
      b: -0.06,
      c: 0.15,
      d: -0.12,
      cutInSpeed: 3.0,
      ratedSpeed: 12.0,
      cutOutSpeed: 25.0,
      calibrated: false,
      calibrationDate: new Date(),
      sampleCount: 0,
    };
    return this.factors;
  }

  /**
   * Load pre-calibrated factors
   */
  loadFactors(factors: CubicPowerCurveFactors): void {
    this.factors = factors;
  }

  /**
   * Predict capacity factor from wind speed using calibrated power curve
   *
   * @param windSpeed - Wind speed in m/s (preferably hub-height 100m)
   * @returns Predicted capacity factor [0, 1]
   */
  predict(windSpeed: number): number {
    if (!this.factors) {
      throw new Error(`Cubic power curve not calibrated for station ${this.stationCode}`);
    }

    // Apply cut-in threshold
    if (windSpeed < this.factors.cutInSpeed) {
      return 0;
    }

    // Apply cut-out threshold (storm shutdown)
    if (windSpeed >= this.factors.cutOutSpeed) {
      return 0;
    }

    // Evaluate polynomial in operational range
    const cf = this.evaluatePolynomial(
      this.factors.a,
      this.factors.b,
      this.factors.c,
      this.factors.d,
      windSpeed
    );

    // For speeds above rated, cap at 1.0 (rated power)
    if (windSpeed >= this.factors.ratedSpeed) {
      return Math.min(1.0, cf);
    }

    return cf;
  }

  /**
   * Predict from weather features (interface compatibility)
   */
  predictFromWeather(weather: CFacWeatherFeatures, _datetime: Date): number {
    // Prefer 100m wind speed for wind farms (hub height)
    const windSpeed = weather.windSpeed100 ?? weather.windSpeed;
    return this.predict(windSpeed);
  }

  /**
   * Get calibrated factors
   */
  getFactors(): CubicPowerCurveFactors | null {
    return this.factors;
  }

  /**
   * Check if model is calibrated
   */
  isCalibrated(): boolean {
    return this.factors?.calibrated ?? false;
  }

  /**
   * Get station code
   */
  getStationCode(): string {
    return this.stationCode;
  }

  /**
   * Serialize factors for database storage
   */
  toJSON(): string {
    if (!this.factors) {
      throw new Error('No factors to serialize');
    }
    return JSON.stringify(this.factors);
  }

  /**
   * Load factors from JSON string
   */
  fromJSON(json: string): void {
    const parsed = JSON.parse(json) as CubicPowerCurveFactors;
    if (parsed.calibrationDate) {
      parsed.calibrationDate = new Date(parsed.calibrationDate);
    }
    this.factors = parsed;
  }
}

/**
 * Batch calibrate Cubic power curve models for multiple stations
 *
 * @param data - All calibration data (will be grouped by station)
 * @param progressCallback - Optional progress callback
 * @returns Map of station code to calibrated model
 */
export async function calibrateAllCubic(
  data: MRECCalibrationData[],
  progressCallback?: (msg: string) => void
): Promise<Map<string, WindCubicModel>> {
  // Group data by station
  const stationData = new Map<string, MRECCalibrationData[]>();
  for (const d of data) {
    if (!stationData.has(d.stationCode)) {
      stationData.set(d.stationCode, []);
    }
    stationData.get(d.stationCode)!.push(d);
  }

  progressCallback?.(`Calibrating Cubic Power Curve for ${stationData.size} stations from ${data.length} samples`);

  const models = new Map<string, WindCubicModel>();
  let calibratedCount = 0;
  let uncalibratedCount = 0;

  for (const [stationCode, samples] of stationData) {
    progressCallback?.(`  [${calibratedCount + uncalibratedCount + 1}/${stationData.size}] Calibrating ${stationCode}...`);

    const model = new WindCubicModel(stationCode);
    const factors = model.calibrate(
      samples.map(s => ({ ...s, stationCode }))
    );

    if (factors.calibrated) {
      calibratedCount++;
      progressCallback?.(`    Calibrated: a=${factors.a.toFixed(6)}, b=${factors.b.toFixed(6)}, c=${factors.c.toFixed(6)}, d=${factors.d.toFixed(6)}`);
      progressCallback?.(`    Operational: cut-in=${factors.cutInSpeed.toFixed(1)} m/s, rated=${factors.ratedSpeed.toFixed(1)} m/s, cut-out=${factors.cutOutSpeed.toFixed(1)} m/s`);
      if (factors.stats) {
        progressCallback?.(`    Quality: R²=${factors.stats.r2.toFixed(3)}, RMSE=${factors.stats.rmse.toFixed(4)}`);
      }
    } else {
      uncalibratedCount++;
      progressCallback?.(`    Could not calibrate (insufficient data: ${samples.length} samples)`);
    }

    models.set(stationCode, model);
  }

  progressCallback?.(`\nCalibration complete: ${calibratedCount} calibrated, ${uncalibratedCount} uncalibrated`);

  return models;
}
