/**
 * WindPhysicsMRECModel - Physics-Based Wind Capacity Factor Model
 *
 * This model correctly implements the wind turbine power curve physics:
 *
 * Power Curve Regions:
 *
 * CF
 * 1.0 |                    ___________[RATED PLATEAU]___________
 *     |                   /                                     \
 *     |                  / [RAMP - Quadratic]                    \[DERATE]
 * 0.5 |                 /                                         \
 *     |    [LOW]       /                                           |
 * 0.0 |_______________/                                            |[CUT-OUT]
 *     0    3    6    9   12   15   18   21   24   27   30
 *                        Wind Speed (m/s)
 *
 * Key Physics:
 * - LOW (0 to vCutIn ~3-4 m/s): Near-zero output, turbine not spinning
 * - RAMP (vCutIn to vRated ~12-14 m/s): Power increases with v² (simplified from v³)
 * - RATED (vRated to vHigh ~25 m/s): CONSTANT output at rated capacity
 * - DERATE (vHigh to vCutOut ~28 m/s): Linear ramp-down for protection
 * - CUT-OUT (above vCutOut): Zero output, turbine shut down
 *
 * The key insight: RATED region is FLAT, not linear!
 */

import {
  MRECCalibrationData,
  StationType,
  CFacWeatherFeatures,
} from '../../types/capacityFactor.js';

/**
 * Physics-based MREC factors
 */
export interface PhysicsMRECFactors {
  stationCode: string;
  stationType: StationType;

  // Physics thresholds (wind speed in m/s)
  vCutIn: number;    // Cut-in wind speed (~3-4 m/s)
  vRated: number;    // Rated wind speed (~12-14 m/s)
  vHigh: number;     // Start of derate region (~25 m/s)
  vCutOut: number;   // Cut-out wind speed (~28 m/s)

  // Capacity factors
  ratedCF: number;   // CF at rated wind (plateau value, typically 0.7-0.9)
  lowCF: number;     // Average CF in low region (for linear approximation)

  // Low region linear factor (for sub-cut-in)
  MRecLow: number;

  // Calibration metadata
  calibrated: boolean;
  calibrationDate: Date;
  sampleCount: number;

  // Statistics for debugging
  stats?: {
    avgCFLow: number;
    avgCFRamp: number;
    avgCFRated: number;
    avgCFHigh: number;
    nLow: number;
    nRamp: number;
    nRated: number;
    nHigh: number;
    maxWind: number;
    minWind: number;
  };
}

/**
 * Default physics constants for wind turbines
 */
export const WIND_PHYSICS_DEFAULTS = {
  vCutIn: 3.5,    // Typical cut-in speed
  vRated: 12,     // Typical rated speed
  vHigh: 25,      // Start of derate
  vCutOut: 28,    // Cut-out speed
  ratedCF: 0.85,  // Default rated CF if can't calibrate
};

export class WindPhysicsMRECModel {
  private stationCode: string;
  private factors: PhysicsMRECFactors | null = null;

  constructor(stationCode: string) {
    this.stationCode = stationCode;
  }

  /**
   * Calibrate physics-based factors from historical data
   *
   * Key difference from original: We calibrate the RATED plateau CF,
   * not linear conversion factors for each tier.
   */
  calibrate(data: MRECCalibrationData[]): PhysicsMRECFactors {
    const stationData = data.filter(d => d.stationCode === this.stationCode);

    if (stationData.length < 100) {
      console.warn(`Insufficient data for ${this.stationCode}: ${stationData.length} samples`);
      return this.createUncalibratedFactors();
    }

    // Sort by wind speed
    const sortedData = [...stationData].sort((a, b) => a.windSpeed - b.windSpeed);
    const minWind = sortedData[0].windSpeed;
    const maxWind = sortedData[sortedData.length - 1].windSpeed;

    // Start with physics defaults
    let vCutIn = WIND_PHYSICS_DEFAULTS.vCutIn;
    let vRated = WIND_PHYSICS_DEFAULTS.vRated;
    let vHigh = WIND_PHYSICS_DEFAULTS.vHigh;
    const vCutOut = WIND_PHYSICS_DEFAULTS.vCutOut;

    // Adjust thresholds based on data range (some sites have different turbines)
    // But keep them within reasonable physics bounds
    if (maxWind < vHigh) {
      // Site never sees high winds - adjust down but keep physics ratios
      vHigh = Math.max(20, maxWind * 0.9);
      vRated = Math.min(vRated, vHigh * 0.5);
    }

    // Bin data by tier using physics thresholds
    let nLow = 0, nRamp = 0, nRated = 0, nHigh = 0;
    let cfSumLow = 0, cfSumRamp = 0, cfSumRated = 0, cfSumHigh = 0;
    let windSumLow = 0;

    for (const d of stationData) {
      if (d.windSpeed >= vHigh) {
        nHigh++;
        cfSumHigh += d.capacityFactor;
      } else if (d.windSpeed >= vRated) {
        nRated++;
        cfSumRated += d.capacityFactor;
      } else if (d.windSpeed >= vCutIn) {
        nRamp++;
        cfSumRamp += d.capacityFactor;
      } else {
        nLow++;
        cfSumLow += d.capacityFactor;
        windSumLow += d.windSpeed;
      }
    }

    // Calculate average CFs per region
    const avgCFLow = nLow > 0 ? cfSumLow / nLow : 0.05;
    const avgCFRamp = nRamp > 0 ? cfSumRamp / nRamp : 0.4;
    const avgCFRated = nRated > 0 ? cfSumRated / nRated : 0.75;
    const avgCFHigh = nHigh > 0 ? cfSumHigh / nHigh : avgCFRated * 0.7;

    // The RATED CF is the key calibration target
    // Use the average CF in the rated region as the plateau value
    const ratedCF = avgCFRated > 0.1 ? avgCFRated : WIND_PHYSICS_DEFAULTS.ratedCF;

    // For LOW region, use simple linear factor
    const avgWindLow = nLow > 0 ? windSumLow / nLow : vCutIn / 2;
    const MRecLow = avgWindLow > 0.1 ? avgCFLow / avgWindLow : 0.02;

    // Optimize vRated to minimize RAMP region error
    // The ramp should end where CF reaches ~90% of rated
    if (nRamp > 20) {
      const rampData = stationData.filter(d => d.windSpeed >= vCutIn && d.windSpeed < vHigh);
      const sortedRamp = rampData.sort((a, b) => a.windSpeed - b.windSpeed);

      // Find wind speed where CF first reaches 85% of rated
      for (const d of sortedRamp) {
        if (d.capacityFactor >= ratedCF * 0.85) {
          vRated = Math.max(vCutIn + 2, Math.min(d.windSpeed, vHigh - 5));
          break;
        }
      }
    }

    this.factors = {
      stationCode: this.stationCode,
      stationType: StationType.WIND,
      vCutIn,
      vRated,
      vHigh,
      vCutOut,
      ratedCF,
      lowCF: avgCFLow,
      MRecLow,
      calibrated: true,
      calibrationDate: new Date(),
      sampleCount: stationData.length,
      stats: {
        avgCFLow,
        avgCFRamp,
        avgCFRated,
        avgCFHigh,
        nLow,
        nRamp,
        nRated,
        nHigh,
        maxWind,
        minWind,
      },
    };

    return this.factors;
  }

  /**
   * Create uncalibrated factors with physics defaults
   */
  private createUncalibratedFactors(): PhysicsMRECFactors {
    this.factors = {
      stationCode: this.stationCode,
      stationType: StationType.WIND,
      vCutIn: WIND_PHYSICS_DEFAULTS.vCutIn,
      vRated: WIND_PHYSICS_DEFAULTS.vRated,
      vHigh: WIND_PHYSICS_DEFAULTS.vHigh,
      vCutOut: WIND_PHYSICS_DEFAULTS.vCutOut,
      ratedCF: WIND_PHYSICS_DEFAULTS.ratedCF,
      lowCF: 0.05,
      MRecLow: 0.02,
      calibrated: false,
      calibrationDate: new Date(),
      sampleCount: 0,
    };
    return this.factors;
  }

  /**
   * Load pre-calibrated factors
   */
  loadFactors(factors: PhysicsMRECFactors): void {
    this.factors = factors;
  }

  /**
   * Get current tier for a wind speed
   */
  getTier(windSpeed: number): 'CUTOUT' | 'HIGH' | 'RATED' | 'RAMP' | 'LOW' {
    if (!this.factors) return 'LOW';

    if (windSpeed >= this.factors.vCutOut) return 'CUTOUT';
    if (windSpeed >= this.factors.vHigh) return 'HIGH';
    if (windSpeed >= this.factors.vRated) return 'RATED';
    if (windSpeed >= this.factors.vCutIn) return 'RAMP';
    return 'LOW';
  }

  /**
   * Predict capacity factor using physics-based power curve
   *
   * This is the KEY fix: each region uses the correct physics formula
   */
  predict(windSpeed: number): number {
    if (!this.factors) {
      throw new Error(`Physics MREC factors not calibrated for station ${this.stationCode}`);
    }

    if (!this.factors.calibrated) {
      // Simple fallback for uncalibrated
      return Math.min(1, Math.max(0, windSpeed * 0.04));
    }

    const { vCutIn, vRated, vHigh, vCutOut, ratedCF, MRecLow } = this.factors;
    const tier = this.getTier(windSpeed);

    let cf: number;

    switch (tier) {
      case 'CUTOUT':
        // Above cut-out: turbine is shut down
        cf = 0;
        break;

      case 'HIGH':
        // Derate region: linear ramp-down from rated to cut-out
        // CF decreases linearly from ratedCF at vHigh to 0 at vCutOut
        cf = ratedCF * (vCutOut - windSpeed) / (vCutOut - vHigh);
        cf = Math.max(0, cf);
        break;

      case 'RATED':
        // Rated region: CONSTANT output at rated CF (the key fix!)
        cf = ratedCF;
        break;

      case 'RAMP':
        // Ramp region: quadratic approximation of power curve
        // Real power is proportional to v³, but CF saturates, so use v²
        // Normalized: CF goes from ~0 at vCutIn to ratedCF at vRated
        const normalizedWind = (windSpeed - vCutIn) / (vRated - vCutIn);
        cf = ratedCF * Math.pow(normalizedWind, 2);
        break;

      default: // LOW
        // Below cut-in: very low output (turbine barely spinning or not at all)
        cf = MRecLow * windSpeed;
        break;
    }

    // Clamp to valid range
    return Math.max(0, Math.min(1, cf));
  }

  /**
   * Predict from weather features
   */
  predictFromWeather(weather: CFacWeatherFeatures, _datetime: Date): number {
    const windSpeed = weather.windSpeed100 ?? weather.windSpeed;
    return this.predict(windSpeed);
  }

  /**
   * Get calibrated factors
   */
  getFactors(): PhysicsMRECFactors | null {
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
   * Get the rated CF
   */
  getRatedCF(): number {
    return this.factors?.ratedCF ?? WIND_PHYSICS_DEFAULTS.ratedCF;
  }

  /**
   * Serialize factors
   */
  toJSON(): string {
    if (!this.factors) throw new Error('No factors to serialize');
    return JSON.stringify(this.factors);
  }

  /**
   * Load factors from JSON
   */
  fromJSON(json: string): void {
    const parsed = JSON.parse(json) as PhysicsMRECFactors;
    if (parsed.calibrationDate) {
      parsed.calibrationDate = new Date(parsed.calibrationDate);
    }
    this.factors = parsed;
  }
}

/**
 * Batch calibrate physics-based MREC models for multiple stations
 */
export async function calibrateAllPhysicsMREC(
  data: MRECCalibrationData[],
  progressCallback?: (msg: string) => void
): Promise<Map<string, WindPhysicsMRECModel>> {
  // Group by station
  const stationData = new Map<string, MRECCalibrationData[]>();
  for (const d of data) {
    if (!stationData.has(d.stationCode)) {
      stationData.set(d.stationCode, []);
    }
    stationData.get(d.stationCode)!.push(d);
  }

  progressCallback?.(`Calibrating Physics MREC for ${stationData.size} stations from ${data.length} samples`);

  const models = new Map<string, WindPhysicsMRECModel>();
  let calibratedCount = 0;
  let uncalibratedCount = 0;

  for (const [stationCode, samples] of stationData) {
    progressCallback?.(`  [${calibratedCount + uncalibratedCount + 1}/${stationData.size}] Calibrating ${stationCode}...`);

    const model = new WindPhysicsMRECModel(stationCode);
    const factors = model.calibrate(samples.map(s => ({ ...s, stationCode })));

    if (factors.calibrated) {
      calibratedCount++;
      progressCallback?.(`    Thresholds: vCutIn=${factors.vCutIn.toFixed(1)}, vRated=${factors.vRated.toFixed(1)}, vHigh=${factors.vHigh.toFixed(1)}, vCutOut=${factors.vCutOut.toFixed(1)} m/s`);
      progressCallback?.(`    RatedCF=${(factors.ratedCF * 100).toFixed(1)}%`);
      if (factors.stats) {
        progressCallback?.(`    Samples: LOW=${factors.stats.nLow}, RAMP=${factors.stats.nRamp}, RATED=${factors.stats.nRated}, HIGH=${factors.stats.nHigh}`);
      }
    } else {
      uncalibratedCount++;
      progressCallback?.(`    Could not calibrate (insufficient data: ${samples.length} samples)`);
    }

    models.set(stationCode, model);
  }

  progressCallback?.(`\nPhysics MREC calibration complete: ${calibratedCount} calibrated, ${uncalibratedCount} uncalibrated`);

  return models;
}
