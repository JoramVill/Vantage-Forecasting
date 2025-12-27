/**
 * Wind4TierMRECModel - Physics-Based Four-Tier Wind Capacity Factor Model
 *
 * Extends the traditional 3-tier MREC with a dedicated "RATED" tier
 * to capture the power curve plateau behavior.
 *
 * Power Curve Regions:
 *
 * CF
 * 1.0 |                    _____[RATED PLATEAU]_____
 *     |                   /                         \
 *     |                  / [RAMP]                    \[DERATE]
 * 0.5 |                 /                             |
 *     |    [LOW/CUBIC] /                              |
 * 0.0 |_______________/                               |[CUT-OUT]
 *     0    4    8    12   16   20   24   28   32   36
 *
 * Tiers:
 * - LOW:   0 to vLow (~5 m/s)    - Below/around cut-in, minimal generation
 * - RAMP:  vLow to vRated (~12)  - Cubic power region, CF climbing
 * - RATED: vRated to vHigh (~25) - Plateau region, CF stable near max
 * - HIGH:  Above vHigh           - Near cut-out, potential derating
 *
 * Key Insight: gustRatio behavior inverts between RAMP and RATED regions
 * - RAMP:  Higher gustRatio = stronger gusts = more energy capture
 * - RATED: Lower gustRatio = stable wind = consistent high generation
 */

import {
  MRECCalibrationData,
  StationType,
  CFacWeatherFeatures,
} from '../../types/capacityFactor.js';

/**
 * Four-tier MREC factors with physics-based thresholds
 */
export interface MREC4TierFactors {
  stationCode: string;
  stationType: StationType;

  // Conversion factors for each tier (CF = MRec × windSpeed)
  MRecLow: number;    // Low tier conversion factor
  MRecRamp: number;   // Ramp tier conversion factor
  MRecRated: number;  // Rated tier conversion factor
  MRecHigh: number;   // High tier conversion factor

  // Tier thresholds (wind speed in m/s)
  vLow: number;       // Threshold between LOW and RAMP (~5 m/s)
  vRated: number;     // Threshold between RAMP and RATED (~12 m/s)
  vHigh: number;      // Threshold between RATED and HIGH (~25 m/s)

  // Calibration metadata
  calibrated: boolean;
  calibrationDate: Date;
  sampleCount: number;

  // Statistics for debugging
  stats?: {
    CFacLow: number;
    CFacRamp: number;
    CFacRated: number;
    CFacHigh: number;
    ValLow: number;
    ValRamp: number;
    ValRated: number;
    ValHigh: number;
    maxWind: number;
    minWind: number;
    ratedPlateuCF: number;  // Average CF in rated region
  };
}

/**
 * Default physics-based thresholds (can be overridden per station)
 */
export const DEFAULT_WIND_THRESHOLDS = {
  vLow: 5,      // Cut-in region ends
  vRated: 12,   // Rated power begins
  vHigh: 25,    // Near cut-out begins
  vCutOut: 28,  // Full cut-out (for reference)
};

export class Wind4TierMRECModel {
  private stationCode: string;
  private factors: MREC4TierFactors | null = null;

  constructor(stationCode: string) {
    this.stationCode = stationCode;
  }

  /**
   * Calibrate 4-tier MREC factors from historical data
   * Uses physics-based default thresholds with data-driven adjustment
   */
  calibrate(data: MRECCalibrationData[]): MREC4TierFactors {
    const stationData = data.filter(d => d.stationCode === this.stationCode);

    if (stationData.length < 100) {
      console.warn(`Insufficient data for ${this.stationCode}: ${stationData.length} samples (need 100+)`);
      return this.createUncalibratedFactors();
    }

    // Sort by wind speed
    const sortedData = [...stationData].sort((a, b) => a.windSpeed - b.windSpeed);
    const minWind = sortedData[0].windSpeed;
    const maxWind = sortedData[sortedData.length - 1].windSpeed;

    // Use physics-based defaults, adjusted for this station's wind range
    let vLow = DEFAULT_WIND_THRESHOLDS.vLow;
    let vRated = DEFAULT_WIND_THRESHOLDS.vRated;
    let vHigh = DEFAULT_WIND_THRESHOLDS.vHigh;

    // Adjust thresholds based on actual data range
    // If station never sees high winds, adjust accordingly
    if (maxWind < vHigh) {
      vHigh = maxWind * 0.85;
    }
    if (maxWind < vRated) {
      vRated = maxWind * 0.6;
      vLow = maxWind * 0.3;
    }

    // Optimize thresholds using grid search
    const optimized = this.optimizeThresholds(stationData, vLow, vRated, vHigh);
    vLow = optimized.vLow;
    vRated = optimized.vRated;
    vHigh = optimized.vHigh;

    // Calculate tier statistics
    let nLow = 0, nRamp = 0, nRated = 0, nHigh = 0;
    let windSumLow = 0, windSumRamp = 0, windSumRated = 0, windSumHigh = 0;
    let cfSumLow = 0, cfSumRamp = 0, cfSumRated = 0, cfSumHigh = 0;

    for (const d of stationData) {
      if (d.windSpeed >= vHigh) {
        nHigh++;
        windSumHigh += d.windSpeed;
        cfSumHigh += d.capacityFactor;
      } else if (d.windSpeed >= vRated) {
        nRated++;
        windSumRated += d.windSpeed;
        cfSumRated += d.capacityFactor;
      } else if (d.windSpeed >= vLow) {
        nRamp++;
        windSumRamp += d.windSpeed;
        cfSumRamp += d.capacityFactor;
      } else {
        nLow++;
        windSumLow += d.windSpeed;
        cfSumLow += d.capacityFactor;
      }
    }

    // Calculate averages
    const ValLow = nLow > 0 ? windSumLow / nLow : vLow / 2;
    const ValRamp = nRamp > 0 ? windSumRamp / nRamp : (vLow + vRated) / 2;
    const ValRated = nRated > 0 ? windSumRated / nRated : (vRated + vHigh) / 2;
    const ValHigh = nHigh > 0 ? windSumHigh / nHigh : vHigh * 1.1;

    const CFacLow = nLow > 0 ? cfSumLow / nLow : 0.05;
    const CFacRamp = nRamp > 0 ? cfSumRamp / nRamp : 0.4;
    const CFacRated = nRated > 0 ? cfSumRated / nRated : 0.75;
    const CFacHigh = nHigh > 0 ? cfSumHigh / nHigh : 0.6;

    // Calculate MRec conversion factors
    const MRecLow = ValLow > 0.1 ? CFacLow / ValLow : 0.01;
    const MRecRamp = ValRamp > 0.1 ? CFacRamp / ValRamp : 0.04;
    const MRecRated = ValRated > 0.1 ? CFacRated / ValRated : 0.05;
    const MRecHigh = ValHigh > 0.1 ? CFacHigh / ValHigh : 0.03;

    this.factors = {
      stationCode: this.stationCode,
      stationType: StationType.WIND,
      MRecLow,
      MRecRamp,
      MRecRated,
      MRecHigh,
      vLow,
      vRated,
      vHigh,
      calibrated: true,
      calibrationDate: new Date(),
      sampleCount: stationData.length,
      stats: {
        CFacLow,
        CFacRamp,
        CFacRated,
        CFacHigh,
        ValLow,
        ValRamp,
        ValRated,
        ValHigh,
        maxWind,
        minWind,
        ratedPlateuCF: CFacRated,
      },
    };

    return this.factors;
  }

  /**
   * Optimize tier thresholds using grid search
   * Minimizes weighted prediction error with asymmetric penalty for under-prediction
   */
  private optimizeThresholds(
    data: MRECCalibrationData[],
    defaultVLow: number,
    defaultVRated: number,
    defaultVHigh: number
  ): { vLow: number; vRated: number; vHigh: number } {
    const STEPS = 10;
    let bestScore = Infinity;
    let bestVLow = defaultVLow;
    let bestVRated = defaultVRated;
    let bestVHigh = defaultVHigh;

    // Search around defaults
    const vLowRange = [defaultVLow * 0.6, defaultVLow * 1.4];
    const vRatedRange = [defaultVRated * 0.7, defaultVRated * 1.3];
    const vHighRange = [defaultVHigh * 0.8, defaultVHigh * 1.2];

    for (let l = 0; l < STEPS; l++) {
      const candidateVLow = vLowRange[0] + (l / STEPS) * (vLowRange[1] - vLowRange[0]);

      for (let r = 0; r < STEPS; r++) {
        const candidateVRated = vRatedRange[0] + (r / STEPS) * (vRatedRange[1] - vRatedRange[0]);

        if (candidateVRated <= candidateVLow * 1.5) continue; // Ensure separation

        for (let h = 0; h < STEPS; h++) {
          const candidateVHigh = vHighRange[0] + (h / STEPS) * (vHighRange[1] - vHighRange[0]);

          if (candidateVHigh <= candidateVRated * 1.3) continue; // Ensure separation

          const score = this.evaluateThresholds(data, candidateVLow, candidateVRated, candidateVHigh);

          if (score < bestScore) {
            bestScore = score;
            bestVLow = candidateVLow;
            bestVRated = candidateVRated;
            bestVHigh = candidateVHigh;
          }
        }
      }
    }

    return { vLow: bestVLow, vRated: bestVRated, vHigh: bestVHigh };
  }

  /**
   * Evaluate threshold combination using weighted MAE
   */
  private evaluateThresholds(
    data: MRECCalibrationData[],
    vLow: number,
    vRated: number,
    vHigh: number
  ): number {
    // Calculate tier statistics for these thresholds
    let nLow = 0, nRamp = 0, nRated = 0, nHigh = 0;
    let windSumLow = 0, windSumRamp = 0, windSumRated = 0, windSumHigh = 0;
    let cfSumLow = 0, cfSumRamp = 0, cfSumRated = 0, cfSumHigh = 0;

    for (const d of data) {
      if (d.windSpeed >= vHigh) {
        nHigh++; windSumHigh += d.windSpeed; cfSumHigh += d.capacityFactor;
      } else if (d.windSpeed >= vRated) {
        nRated++; windSumRated += d.windSpeed; cfSumRated += d.capacityFactor;
      } else if (d.windSpeed >= vLow) {
        nRamp++; windSumRamp += d.windSpeed; cfSumRamp += d.capacityFactor;
      } else {
        nLow++; windSumLow += d.windSpeed; cfSumLow += d.capacityFactor;
      }
    }

    // Need samples in each tier
    if (nLow < 10 || nRamp < 10 || nRated < 5) return Infinity;

    // Calculate MRec factors
    const MRecLow = nLow > 0 && windSumLow > 0 ? cfSumLow / windSumLow : 0;
    const MRecRamp = nRamp > 0 && windSumRamp > 0 ? cfSumRamp / windSumRamp : 0;
    const MRecRated = nRated > 0 && windSumRated > 0 ? cfSumRated / windSumRated : 0;
    const MRecHigh = nHigh > 0 && windSumHigh > 0 ? cfSumHigh / windSumHigh : MRecRated;

    // Evaluate predictions
    let totalError = 0;
    let totalWeight = 0;

    for (const d of data) {
      let pred: number;
      if (d.windSpeed >= vHigh) {
        pred = MRecHigh * d.windSpeed;
      } else if (d.windSpeed >= vRated) {
        pred = MRecRated * d.windSpeed;
      } else if (d.windSpeed >= vLow) {
        pred = MRecRamp * d.windSpeed;
      } else {
        pred = MRecLow * d.windSpeed;
      }
      pred = Math.min(1, Math.max(0, pred));

      const error = pred - d.capacityFactor;
      const absError = Math.abs(error);

      // Weight by actual CF + asymmetric penalty for under-prediction
      const weight = 0.1 + d.capacityFactor;
      let penalty = absError;
      if (error < 0 && d.capacityFactor > 0.5) {
        penalty *= 2; // Double penalty for under-predicting high CF
      }

      totalError += penalty * weight;
      totalWeight += weight;
    }

    return totalError / totalWeight;
  }

  /**
   * Create uncalibrated factors with physics-based defaults
   */
  private createUncalibratedFactors(): MREC4TierFactors {
    this.factors = {
      stationCode: this.stationCode,
      stationType: StationType.WIND,
      MRecLow: 0.02,   // ~10% CF at 5 m/s
      MRecRamp: 0.05,  // ~40% CF at 8 m/s
      MRecRated: 0.06, // ~75% CF at 12 m/s
      MRecHigh: 0.03,  // ~75% CF at 25 m/s (flat)
      vLow: DEFAULT_WIND_THRESHOLDS.vLow,
      vRated: DEFAULT_WIND_THRESHOLDS.vRated,
      vHigh: DEFAULT_WIND_THRESHOLDS.vHigh,
      calibrated: false,
      calibrationDate: new Date(),
      sampleCount: 0,
    };
    return this.factors;
  }

  /**
   * Load pre-calibrated factors
   */
  loadFactors(factors: MREC4TierFactors): void {
    this.factors = factors;
  }

  /**
   * Get current tier for a wind speed
   */
  getTier(windSpeed: number): 'LOW' | 'RAMP' | 'RATED' | 'HIGH' {
    if (!this.factors) return 'LOW';

    if (windSpeed >= this.factors.vHigh) return 'HIGH';
    if (windSpeed >= this.factors.vRated) return 'RATED';
    if (windSpeed >= this.factors.vLow) return 'RAMP';
    return 'LOW';
  }

  /**
   * Check if wind is in rated plateau region
   */
  isInRatedPlateau(windSpeed: number): boolean {
    return this.getTier(windSpeed) === 'RATED';
  }

  /**
   * Predict capacity factor from wind speed
   */
  predict(windSpeed: number): number {
    if (!this.factors) {
      throw new Error(`4-Tier MREC factors not calibrated for station ${this.stationCode}`);
    }

    if (!this.factors.calibrated) {
      return Math.min(1, Math.max(0, windSpeed * 0.05));
    }

    let PcCon: number;
    const tier = this.getTier(windSpeed);

    switch (tier) {
      case 'HIGH':
        PcCon = this.factors.MRecHigh * windSpeed;
        break;
      case 'RATED':
        PcCon = this.factors.MRecRated * windSpeed;
        break;
      case 'RAMP':
        PcCon = this.factors.MRecRamp * windSpeed;
        break;
      default:
        PcCon = this.factors.MRecLow * windSpeed;
    }

    // High wind cutout protection
    if (PcCon > 1.1) {
      return 0;
    }

    return Math.max(0, Math.min(1, PcCon));
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
  getFactors(): MREC4TierFactors | null {
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
   * Get the rated plateau CF (for reference)
   */
  getRatedPlateauCF(): number {
    return this.factors?.stats?.ratedPlateuCF ?? 0.75;
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
    const parsed = JSON.parse(json) as MREC4TierFactors;
    if (parsed.calibrationDate) {
      parsed.calibrationDate = new Date(parsed.calibrationDate);
    }
    this.factors = parsed;
  }
}

/**
 * Batch calibrate 4-tier MREC models for multiple stations
 */
export async function calibrateAll4TierMREC(
  data: MRECCalibrationData[],
  progressCallback?: (msg: string) => void
): Promise<Map<string, Wind4TierMRECModel>> {
  // Group by station
  const stationData = new Map<string, MRECCalibrationData[]>();
  for (const d of data) {
    if (!stationData.has(d.stationCode)) {
      stationData.set(d.stationCode, []);
    }
    stationData.get(d.stationCode)!.push(d);
  }

  progressCallback?.(`Calibrating 4-Tier MREC for ${stationData.size} stations from ${data.length} samples`);

  const models = new Map<string, Wind4TierMRECModel>();
  let calibratedCount = 0;
  let uncalibratedCount = 0;

  for (const [stationCode, samples] of stationData) {
    progressCallback?.(`  [${calibratedCount + uncalibratedCount + 1}/${stationData.size}] Calibrating ${stationCode}...`);

    const model = new Wind4TierMRECModel(stationCode);
    const factors = model.calibrate(samples.map(s => ({ ...s, stationCode })));

    if (factors.calibrated) {
      calibratedCount++;
      progressCallback?.(`    Thresholds: vLow=${factors.vLow.toFixed(1)}, vRated=${factors.vRated.toFixed(1)}, vHigh=${factors.vHigh.toFixed(1)} m/s`);
      progressCallback?.(`    MRec: Low=${factors.MRecLow.toFixed(4)}, Ramp=${factors.MRecRamp.toFixed(4)}, Rated=${factors.MRecRated.toFixed(4)}, High=${factors.MRecHigh.toFixed(4)}`);
      if (factors.stats) {
        progressCallback?.(`    Avg CF: Low=${(factors.stats.CFacLow * 100).toFixed(1)}%, Ramp=${(factors.stats.CFacRamp * 100).toFixed(1)}%, Rated=${(factors.stats.CFacRated * 100).toFixed(1)}%, High=${(factors.stats.CFacHigh * 100).toFixed(1)}%`);
      }
    } else {
      uncalibratedCount++;
      progressCallback?.(`    Could not calibrate (insufficient data: ${samples.length} samples)`);
    }

    models.set(stationCode, model);
  }

  progressCallback?.(`\n4-Tier calibration complete: ${calibratedCount} calibrated, ${uncalibratedCount} uncalibrated`);

  return models;
}
