/**
 * WindWeibullModel - Weibull Distribution-Based Wind Capacity Factor Model
 *
 * Uses Weibull distribution parameters to model wind speed distribution
 * and calculate expected capacity factor analytically.
 *
 * Weibull PDF: f(v) = (k/A) × (v/A)^(k-1) × exp(-(v/A)^k)
 * Where:
 *   k = shape parameter (1.5-3.0, higher = steadier winds)
 *   A = scale parameter (proportional to mean wind speed)
 *
 * Capacity Factor is computed by integrating power curve over Weibull distribution:
 *   CF = ∫ P(v) × f(v) dv from cut-in to cut-out
 */

import {
  StationType,
  CFacWeatherFeatures,
} from '../../types/capacityFactor.js';

/**
 * Weibull distribution parameters for a wind station
 */
export interface WeibullFactors {
  stationCode: string;
  stationType: StationType;

  // Weibull parameters
  k: number;           // Shape parameter (dimensionless)
  A: number;           // Scale parameter (m/s)

  // Station statistics
  meanWindSpeed: number;    // Average wind speed (m/s)
  stdDevWindSpeed: number;  // Standard deviation of wind speed (m/s)
  meanCapacityFactor: number; // Average capacity factor (0-1)

  // Wind turbine characteristics (simplified)
  cutInSpeed: number;   // Minimum wind speed for generation (m/s)
  ratedSpeed: number;   // Wind speed at rated power (m/s)
  cutOutSpeed: number;  // Maximum wind speed before shutdown (m/s)

  // Calibration metadata
  calibrated: boolean;
  calibrationDate?: Date;
  sampleCount?: number;
}

/**
 * Weibull calibration input data
 */
export interface WeibullCalibrationData {
  datetime: Date;
  stationCode: string;
  capacityFactor: number;  // 0.0 to 1.0
  windSpeed: number;       // m/s (preferably hub-height 100m)
}

export class WindWeibullModel {
  private stationCode: string;
  private factors: WeibullFactors | null = null;

  // Integration parameters
  private static readonly INTEGRATION_STEPS = 100; // Number of steps for numerical integration

  constructor(stationCode: string) {
    this.stationCode = stationCode;
  }

  /**
   * Calibrate Weibull parameters from historical data
   *
   * @param data - Array of paired (capacity factor, wind speed) samples
   * @returns Calibrated Weibull factors
   */
  calibrate(data: WeibullCalibrationData[]): WeibullFactors {
    // Filter data for this station
    const stationData = data.filter(d => d.stationCode === this.stationCode);

    if (stationData.length < 100) {
      console.warn(`Insufficient data for ${this.stationCode}: ${stationData.length} samples (need 100+)`);
      return this.createUncalibratedFactors();
    }

    // Step 1: Calculate wind speed statistics
    const windSpeeds = stationData.map(d => d.windSpeed);
    const capacityFactors = stationData.map(d => d.capacityFactor);

    const meanWind = this.mean(windSpeeds);
    const stdDevWind = this.standardDeviation(windSpeeds, meanWind);
    const meanCF = this.mean(capacityFactors);

    if (meanWind < 0.1 || stdDevWind < 0.01) {
      console.warn(`Invalid wind statistics for ${this.stationCode}: mean=${meanWind.toFixed(2)}, std=${stdDevWind.toFixed(2)}`);
      return this.createUncalibratedFactors();
    }

    // Step 2: Estimate Weibull shape parameter k using empirical formula
    // k ≈ (σ/μ)^(-1.086) where σ = std dev, μ = mean
    const cv = stdDevWind / meanWind; // Coefficient of variation
    const k = Math.pow(cv, -1.086);

    // Constrain k to reasonable range for wind (1.5 to 3.5)
    const kConstrained = Math.max(1.5, Math.min(3.5, k));

    // Step 3: Estimate Weibull scale parameter A
    // A = μ / Γ(1 + 1/k)
    const gammaFactor = this.gamma(1 + 1 / kConstrained);
    const A = meanWind / gammaFactor;

    // Step 4: Estimate turbine characteristics from data
    const sortedWinds = [...windSpeeds].sort((a, b) => a - b);
    const cutInSpeed = this.percentile(sortedWinds, 5);  // P5
    const cutOutSpeed = this.percentile(sortedWinds, 99); // P99

    // Estimate rated speed as wind speed where high CFs occur
    // Find wind speed at which CF is typically above 0.7
    const highCFWinds = stationData
      .filter(d => d.capacityFactor > 0.7)
      .map(d => d.windSpeed);
    const ratedSpeed = highCFWinds.length > 0
      ? this.percentile([...highCFWinds].sort((a, b) => a - b), 50)
      : meanWind * 1.5;

    // Create calibrated factors
    this.factors = {
      stationCode: this.stationCode,
      stationType: StationType.WIND,
      k: kConstrained,
      A,
      meanWindSpeed: meanWind,
      stdDevWindSpeed: stdDevWind,
      meanCapacityFactor: meanCF,
      cutInSpeed: Math.max(2, cutInSpeed),     // Minimum 2 m/s
      ratedSpeed: Math.max(8, ratedSpeed),      // Minimum 8 m/s
      cutOutSpeed: Math.min(25, cutOutSpeed),   // Maximum 25 m/s
      calibrated: true,
      calibrationDate: new Date(),
      sampleCount: stationData.length,
    };

    return this.factors;
  }

  /**
   * Create uncalibrated factors (fallback)
   * Uses typical wind turbine and Weibull parameters
   */
  private createUncalibratedFactors(): WeibullFactors {
    this.factors = {
      stationCode: this.stationCode,
      stationType: StationType.WIND,
      k: 2.0,              // Typical Rayleigh distribution (k=2)
      A: 7.5,              // Typical scale for moderate wind sites
      meanWindSpeed: 6.5,  // Typical mean wind speed
      stdDevWindSpeed: 3.0,
      meanCapacityFactor: 0.25,
      cutInSpeed: 3.0,     // Typical cut-in
      ratedSpeed: 12.0,    // Typical rated speed
      cutOutSpeed: 25.0,   // Typical cut-out
      calibrated: false,
      calibrationDate: new Date(),
      sampleCount: 0,
    };
    return this.factors;
  }

  /**
   * Load pre-calibrated factors
   */
  loadFactors(factors: WeibullFactors): void {
    this.factors = factors;
  }

  /**
   * Predict capacity factor from wind speed
   * Uses current wind speed to scale the expected CF based on Weibull distribution
   *
   * @param windSpeed - Wind speed in m/s (preferably hub-height 100m)
   * @returns Predicted capacity factor [0, 1]
   */
  predict(windSpeed: number): number {
    if (!this.factors) {
      throw new Error(`Weibull factors not calibrated for station ${this.stationCode}`);
    }

    if (!this.factors.calibrated) {
      // Simple linear approximation for uncalibrated
      return this.simplePowerCurve(windSpeed, this.factors);
    }

    // Use Weibull-scaled prediction
    return this.weibullScaledPrediction(windSpeed, this.factors);
  }

  /**
   * Weibull-scaled prediction
   * Calculates expected CF based on where current wind falls in the distribution
   */
  private weibullScaledPrediction(windSpeed: number, factors: WeibullFactors): number {
    // Handle out-of-range conditions
    if (windSpeed < factors.cutInSpeed) {
      return 0;
    }

    if (windSpeed > factors.cutOutSpeed) {
      return 0; // Shutdown in extreme winds
    }

    // Calculate expected CF using simplified power curve
    const baseCF = this.simplePowerCurve(windSpeed, factors);

    // Calculate probability density at current wind speed
    const currentPDF = this.weibullPDF(windSpeed, factors.k, factors.A);

    // Calculate expected PDF (at mean wind speed)
    const expectedPDF = this.weibullPDF(factors.meanWindSpeed, factors.k, factors.A);

    // Scale CF based on relative position in distribution
    // If current wind has higher PDF than mean, we're in a typical condition
    // Use ratio to adjust, but limit the adjustment to prevent extreme values
    const pdfRatio = expectedPDF > 0 ? Math.min(2, currentPDF / expectedPDF) : 1;

    // Blend the base CF with mean CF weighted by PDF ratio
    // When wind is typical (high PDF ratio), use more of base prediction
    // When wind is unusual (low PDF ratio), blend more with mean
    const weight = Math.min(1, pdfRatio);
    const scaledCF = weight * baseCF + (1 - weight) * factors.meanCapacityFactor;

    // Additional scaling based on wind speed relative to rated speed
    let finalCF = scaledCF;

    if (windSpeed >= factors.ratedSpeed) {
      // At or above rated speed: full capacity with slight degradation at very high winds
      const degradation = Math.max(0, 1 - (windSpeed - factors.ratedSpeed) / (factors.cutOutSpeed - factors.ratedSpeed) * 0.1);
      finalCF = Math.min(1.0, baseCF * degradation);
    }

    return Math.max(0, Math.min(1, finalCF));
  }

  /**
   * Simplified power curve for wind turbine
   * Piecewise linear approximation:
   *   0 < v < cut-in: CF = 0
   *   cut-in <= v < rated: CF = cubic curve to rated power
   *   rated <= v < cut-out: CF = 1.0
   *   v >= cut-out: CF = 0
   */
  private simplePowerCurve(windSpeed: number, factors: WeibullFactors): number {
    if (windSpeed < factors.cutInSpeed) {
      return 0;
    }

    if (windSpeed >= factors.cutOutSpeed) {
      return 0;
    }

    if (windSpeed >= factors.ratedSpeed) {
      return 1.0;
    }

    // Between cut-in and rated: use cubic curve (realistic power curve shape)
    // CF = ((v - v_cut_in) / (v_rated - v_cut_in))^3
    const normalizedSpeed = (windSpeed - factors.cutInSpeed) /
                           (factors.ratedSpeed - factors.cutInSpeed);

    return Math.pow(normalizedSpeed, 3);
  }

  /**
   * Weibull probability density function
   * f(v) = (k/A) × (v/A)^(k-1) × exp(-(v/A)^k)
   */
  private weibullPDF(v: number, k: number, A: number): number {
    if (v < 0 || A <= 0 || k <= 0) {
      return 0;
    }

    const vOverA = v / A;
    return (k / A) * Math.pow(vOverA, k - 1) * Math.exp(-Math.pow(vOverA, k));
  }

  /**
   * Weibull cumulative distribution function
   * F(v) = 1 - exp(-(v/A)^k)
   */
  private weibullCDF(v: number, k: number, A: number): number {
    if (v < 0) return 0;
    if (A <= 0 || k <= 0) return 0;

    return 1 - Math.exp(-Math.pow(v / A, k));
  }

  /**
   * Calculate expected capacity factor by integrating power curve over Weibull distribution
   * CF = ∫ P(v) × f(v) dv from cut-in to cut-out
   *
   * Uses trapezoidal rule for numerical integration
   */
  private calculateExpectedCF(factors: WeibullFactors): number {
    const { k, A, cutInSpeed, cutOutSpeed } = factors;

    const steps = WindWeibullModel.INTEGRATION_STEPS;
    const dv = (cutOutSpeed - cutInSpeed) / steps;

    let integral = 0;

    for (let i = 0; i <= steps; i++) {
      const v = cutInSpeed + i * dv;
      const powerCurve = this.simplePowerCurve(v, factors);
      const pdf = this.weibullPDF(v, k, A);

      // Trapezoidal rule
      const weight = (i === 0 || i === steps) ? 0.5 : 1.0;
      integral += weight * powerCurve * pdf * dv;
    }

    return integral;
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
  getFactors(): WeibullFactors | null {
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
    const parsed = JSON.parse(json) as WeibullFactors;
    if (parsed.calibrationDate) {
      parsed.calibrationDate = new Date(parsed.calibrationDate);
    }
    this.factors = parsed;
  }

  // Statistical helper functions

  private mean(values: number[]): number {
    if (values.length === 0) return 0;
    return values.reduce((sum, v) => sum + v, 0) / values.length;
  }

  private standardDeviation(values: number[], mean?: number): number {
    if (values.length < 2) return 0;

    const avg = mean ?? this.mean(values);
    const squaredDiffs = values.map(v => Math.pow(v - avg, 2));
    const variance = squaredDiffs.reduce((sum, v) => sum + v, 0) / (values.length - 1);

    return Math.sqrt(variance);
  }

  private percentile(sortedValues: number[], p: number): number {
    if (sortedValues.length === 0) return 0;

    const index = (p / 100) * (sortedValues.length - 1);
    const lower = Math.floor(index);
    const upper = Math.ceil(index);
    const weight = index - lower;

    return sortedValues[lower] * (1 - weight) + sortedValues[upper] * weight;
  }

  /**
   * Gamma function approximation using Lanczos approximation
   * Γ(z) for z > 0
   *
   * Used for: A = mean_wind / Γ(1 + 1/k)
   */
  private gamma(z: number): number {
    // For small positive integers, use factorial
    if (z === 1) return 1;
    if (z === 2) return 1;

    // Lanczos approximation coefficients (g = 7)
    const g = 7;
    const coef = [
      0.99999999999980993,
      676.5203681218851,
      -1259.1392167224028,
      771.32342877765313,
      -176.61502916214059,
      12.507343278686905,
      -0.13857109526572012,
      9.9843695780195716e-6,
      1.5056327351493116e-7
    ];

    if (z < 0.5) {
      // Use reflection formula: Γ(z) × Γ(1-z) = π / sin(πz)
      return Math.PI / (Math.sin(Math.PI * z) * this.gamma(1 - z));
    }

    z -= 1;
    let x = coef[0];
    for (let i = 1; i < g + 2; i++) {
      x += coef[i] / (z + i);
    }

    const t = z + g + 0.5;
    return Math.sqrt(2 * Math.PI) * Math.pow(t, z + 0.5) * Math.exp(-t) * x;
  }
}

/**
 * Batch calibrate Weibull models for multiple stations
 *
 * @param data - All calibration data (will be grouped by station)
 * @param progressCallback - Optional progress callback
 * @returns Map of station code to calibrated model
 */
export async function calibrateAllWeibull(
  data: WeibullCalibrationData[],
  progressCallback?: (msg: string) => void
): Promise<Map<string, WindWeibullModel>> {
  // Group data by station
  const stationData = new Map<string, WeibullCalibrationData[]>();
  for (const d of data) {
    if (!stationData.has(d.stationCode)) {
      stationData.set(d.stationCode, []);
    }
    stationData.get(d.stationCode)!.push(d);
  }

  progressCallback?.(`Calibrating Weibull models for ${stationData.size} stations from ${data.length} samples`);

  const models = new Map<string, WindWeibullModel>();
  let calibratedCount = 0;
  let uncalibratedCount = 0;

  for (const [stationCode, samples] of stationData) {
    progressCallback?.(`  [${calibratedCount + uncalibratedCount + 1}/${stationData.size}] Calibrating ${stationCode}...`);

    const model = new WindWeibullModel(stationCode);
    const factors = model.calibrate(
      samples.map(s => ({ ...s, stationCode }))
    );

    if (factors.calibrated) {
      calibratedCount++;
      progressCallback?.(`    Calibrated: k=${factors.k.toFixed(3)}, A=${factors.A.toFixed(2)} m/s`);
      progressCallback?.(`    Mean wind: ${factors.meanWindSpeed.toFixed(2)} m/s, Mean CF: ${(factors.meanCapacityFactor * 100).toFixed(1)}%`);
      progressCallback?.(`    Turbine: cut-in=${factors.cutInSpeed.toFixed(1)}, rated=${factors.ratedSpeed.toFixed(1)}, cut-out=${factors.cutOutSpeed.toFixed(1)} m/s`);
    } else {
      uncalibratedCount++;
      progressCallback?.(`    Could not calibrate (insufficient data: ${samples.length} samples)`);
    }

    models.set(stationCode, model);
  }

  progressCallback?.(`\nCalibration complete: ${calibratedCount} calibrated, ${uncalibratedCount} uncalibrated`);

  return models;
}
