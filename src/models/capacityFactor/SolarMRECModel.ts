/**
 * SolarMRECModel - iPool-style Three-Tier Piecewise Linear Solar Capacity Factor Model
 *
 * Port of iPool's MREC (Must-Run Energy Conversion) system for Solar:
 * - ESite.cpp:469-493 (runtime forecasting)
 * - DMREC.cpp:222-372 (calibration)
 * - EProf.cpp:1978-2085 (CalcLevHML algorithm)
 *
 * Key Differences from Wind MREC:
 * - Input is solar irradiance (W/m²) instead of wind speed (m/s)
 * - NO overflow protection (wind has CF > 1.1 → 0 for storm cutout)
 * - Same PoE thresholds: PoEHs=0.1, PoELs=0.3
 * - Simpler behavior: just cap at 1.0, no physical cutout
 */

import {
  StationType,
  CFacWeatherFeatures,
} from '../../types/capacityFactor.js';

export interface SolarMRECFactors {
  stationCode: string;
  stationType: StationType;
  MRecH: number;   // High irradiance conversion factor
  MRecM: number;   // Mid irradiance conversion factor
  MRecL: number;   // Low irradiance conversion factor
  irrH: number;    // Threshold for HIGH tier (W/m²)
  irrL: number;    // Threshold for MID tier (W/m²)
  calibrated: boolean;
  calibrationDate?: Date;
  sampleCount?: number;
  stats?: {
    CFacH: number;
    CFacM: number;
    CFacL: number;
    IrrH: number;
    IrrM: number;
    IrrL: number;
    maxIrr: number;
    minIrr: number;
  };
}

export interface SolarMRECCalibrationData {
  datetime: Date;
  stationCode: string;
  capacityFactor: number;
  solarIrradiance: number;  // W/m²
}

// Same PoE constants as wind (from iPool ConstDefinitions.cpp)
export const SOLAR_MREC_POE_CONSTANTS = {
  PoEHs: 0.1,   // Top 10% for HIGH tier
  PoELs: 0.3,   // Top 30% for MID tier cutoff
} as const;

export class SolarMRECModel {
  private stationCode: string;
  private factors: SolarMRECFactors | null = null;

  constructor(stationCode: string) {
    this.stationCode = stationCode;
  }

  /**
   * Calibrate Solar MREC factors from historical data
   * Port of iPool's CalcLevHML algorithm
   *
   * @param data - Array of paired (capacity factor, solar irradiance) samples
   * @returns Calibrated MREC factors
   */
  calibrate(data: SolarMRECCalibrationData[]): SolarMRECFactors {
    // Filter data for this station
    const stationData = data.filter(d => d.stationCode === this.stationCode);

    if (stationData.length < 100) {
      console.warn(`Insufficient data for ${this.stationCode}: ${stationData.length} samples (need 100+)`);
      return this.createUncalibratedFactors();
    }

    // Filter out nighttime (zero irradiance) samples for calibration
    const daylightData = stationData.filter(d => d.solarIrradiance > 10);

    if (daylightData.length < 50) {
      console.warn(`Insufficient daylight samples for ${this.stationCode}: ${daylightData.length}`);
      return this.createUncalibratedFactors();
    }

    // Step 1: Find min/max irradiance
    let minIrr = Infinity;
    let maxIrr = -Infinity;
    for (const d of daylightData) {
      if (d.solarIrradiance < minIrr) minIrr = d.solarIrradiance;
      if (d.solarIrradiance > maxIrr) maxIrr = d.solarIrradiance;
    }

    if (maxIrr <= minIrr || maxIrr < 10) {
      console.warn(`Invalid irradiance range for ${this.stationCode}: [${minIrr}, ${maxIrr}]`);
      return this.createUncalibratedFactors();
    }

    // Step 2: Create histogram bins (iPool uses 25 bins)
    const NUM_BINS = 25;
    const binWidth = (maxIrr - minIrr) / NUM_BINS;

    // Each bin tracks: count, sum of irradiance, sum of capacity factors
    const bins: { count: number; irrSum: number; cfSum: number }[] = [];
    for (let i = 0; i < NUM_BINS; i++) {
      bins.push({ count: 0, irrSum: 0, cfSum: 0 });
    }

    // Step 3: Bin the data
    for (const d of daylightData) {
      let binIndex = Math.floor((d.solarIrradiance - minIrr) / binWidth);
      if (binIndex >= NUM_BINS) binIndex = NUM_BINS - 1;
      if (binIndex < 0) binIndex = 0;

      bins[binIndex].count++;
      bins[binIndex].irrSum += d.solarIrradiance;
      bins[binIndex].cfSum += d.capacityFactor;
    }

    // Step 4: Calculate PoE thresholds (cumulative distribution from highest)
    const totalSamples = daylightData.length;
    const dH = SOLAR_MREC_POE_CONSTANTS.PoEHs; // 0.1 (top 10%)
    const dL = SOLAR_MREC_POE_CONSTANTS.PoELs; // 0.3 (top 30%)

    let cumCount = 0;
    let nH = 0, nM = 0, nL = 0;
    let irrSumH = 0, irrSumM = 0, irrSumL = 0;
    let cfSumH = 0, cfSumM = 0, cfSumL = 0;
    let irrH = 0, irrL = 0;
    let foundIrrH = false, foundIrrL = false;

    // Iterate from highest bin to lowest (like iPool)
    for (let i = NUM_BINS - 1; i >= 0; i--) {
      const bin = bins[i];
      if (bin.count === 0) continue;

      cumCount += bin.count;

      if (cumCount <= dH * totalSamples) {
        // HIGH tier (top 10%)
        nH += bin.count;
        irrSumH += bin.irrSum;
        cfSumH += bin.cfSum;
      } else if (cumCount > dH * totalSamples && cumCount <= dL * totalSamples) {
        // MID tier (10%-30%)
        nM += bin.count;
        irrSumM += bin.irrSum;
        cfSumM += bin.cfSum;

        // Record irrH threshold when transitioning from HIGH to MID
        if (!foundIrrH) {
          irrH = minIrr + i * binWidth;
          foundIrrH = true;
        }
      } else {
        // LOW tier (below 30%)
        nL += bin.count;
        irrSumL += bin.irrSum;
        cfSumL += bin.cfSum;

        // Record irrL threshold when transitioning from MID to LOW
        if (!foundIrrL) {
          irrL = minIrr + i * binWidth;
          foundIrrL = true;
        }
      }
    }

    // Step 5: Calculate averages for each tier
    const IrrH = nH > 0 ? irrSumH / nH : 0;
    const IrrM = nM > 0 ? irrSumM / nM : 0;
    const IrrL = nL > 0 ? irrSumL / nL : 0;
    const CFacH = nH > 0 ? cfSumH / nH : 0;
    const CFacM = nM > 0 ? cfSumM / nM : 0;
    const CFacL = nL > 0 ? cfSumL / nL : 0;

    // Handle case where MID tier has no samples
    const CFacMFinal = CFacM > 0 ? CFacM : (CFacH + CFacL) / 2;
    const IrrMFinal = IrrM > 0 ? IrrM : (IrrH + IrrL) / 2;

    // Step 6: Calculate conversion factors (CF = MRec * Irradiance)
    // MRec = avgCF / avgIrradiance for each tier
    let MRecH = 0, MRecM = 0, MRecL = 0;
    let calibrated = false;

    if (IrrH > 10 && CFacH > 0) {
      MRecH = CFacH / IrrH;
      MRecM = CFacMFinal / IrrMFinal;
      MRecL = IrrL > 10 ? CFacL / IrrL : MRecM;
      calibrated = true;
    }

    // Create factors object
    this.factors = {
      stationCode: this.stationCode,
      stationType: StationType.SOLAR,
      MRecH,
      MRecM,
      MRecL,
      irrH,
      irrL,
      calibrated,
      calibrationDate: new Date(),
      sampleCount: stationData.length,
      stats: {
        CFacH,
        CFacM: CFacMFinal,
        CFacL,
        IrrH,
        IrrM: IrrMFinal,
        IrrL,
        maxIrr,
        minIrr,
      },
    };

    return this.factors;
  }

  /**
   * Create uncalibrated factors (fallback)
   * Uses reasonable defaults based on typical solar panel behavior
   */
  private createUncalibratedFactors(): SolarMRECFactors {
    this.factors = {
      stationCode: this.stationCode,
      stationType: StationType.SOLAR,
      MRecH: 0.00085,   // ~85% CF at 1000 W/m²
      MRecM: 0.00080,   // ~60% CF at 750 W/m²
      MRecL: 0.00070,   // ~35% CF at 500 W/m²
      irrH: 800,        // High irradiance threshold
      irrL: 400,        // Low irradiance threshold
      calibrated: false,
      calibrationDate: new Date(),
      sampleCount: 0,
    };
    return this.factors;
  }

  /**
   * Load pre-calibrated factors
   */
  loadFactors(factors: SolarMRECFactors): void {
    this.factors = factors;
  }

  /**
   * Predict capacity factor from solar irradiance
   * Port of iPool's ESite.cpp:469-493 runtime logic (solar variant)
   *
   * Note: Unlike wind, solar has NO overflow protection (>1.1 → 0)
   * Solar simply caps at 1.0
   *
   * @param solarIrradiance - Solar irradiance in W/m²
   * @returns Predicted capacity factor [0, 1]
   */
  predict(solarIrradiance: number): number {
    if (!this.factors) {
      throw new Error(`MREC factors not calibrated for station ${this.stationCode}`);
    }

    // Night time or no sun
    if (solarIrradiance <= 0) {
      return 0;
    }

    if (!this.factors.calibrated) {
      // Return simple estimate for uncalibrated stations
      return Math.min(1, Math.max(0, solarIrradiance * 0.00085));
    }

    let PcCon: number;

    // Three-tier piecewise linear conversion
    if (solarIrradiance >= this.factors.irrH) {
      PcCon = this.factors.MRecH * solarIrradiance;
    } else if (solarIrradiance >= this.factors.irrL) {
      PcCon = this.factors.MRecM * solarIrradiance;
    } else {
      PcCon = this.factors.MRecL * solarIrradiance;
    }

    // NOTE: Unlike wind, solar has NO overflow protection!
    // Solar panels don't shut down from too much sun
    // Just cap at 100%
    if (PcCon > 1.0) {
      PcCon = 1.0;
    }

    // Ensure non-negative
    return Math.max(0, PcCon);
  }

  /**
   * Predict from weather features (interface compatibility)
   */
  predictFromWeather(weather: CFacWeatherFeatures, _datetime: Date): number {
    return this.predict(weather.solarRadiation);
  }

  /**
   * Get calibrated factors
   */
  getFactors(): SolarMRECFactors | null {
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
   * Serialize factors for storage
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
    const parsed = JSON.parse(json) as SolarMRECFactors;
    if (parsed.calibrationDate) {
      parsed.calibrationDate = new Date(parsed.calibrationDate);
    }
    this.factors = parsed;
  }
}

/**
 * Batch calibrate Solar MREC models for multiple stations
 *
 * @param data - All calibration data (will be grouped by station)
 * @param progressCallback - Optional progress callback
 * @returns Map of station code to calibrated model
 */
export async function calibrateAllSolarMREC(
  data: SolarMRECCalibrationData[],
  progressCallback?: (msg: string) => void
): Promise<Map<string, SolarMRECModel>> {
  // Group data by station
  const stationData = new Map<string, SolarMRECCalibrationData[]>();
  for (const d of data) {
    if (!stationData.has(d.stationCode)) {
      stationData.set(d.stationCode, []);
    }
    stationData.get(d.stationCode)!.push(d);
  }

  progressCallback?.(`Calibrating Solar MREC for ${stationData.size} stations from ${data.length} samples`);

  const models = new Map<string, SolarMRECModel>();
  let calibratedCount = 0;
  let uncalibratedCount = 0;

  for (const [stationCode, samples] of stationData) {
    progressCallback?.(`  [${calibratedCount + uncalibratedCount + 1}/${stationData.size}] Calibrating ${stationCode}...`);

    const model = new SolarMRECModel(stationCode);
    const factors = model.calibrate(
      samples.map(s => ({ ...s, stationCode }))
    );

    if (factors.calibrated) {
      calibratedCount++;
      progressCallback?.(`    Calibrated: MRecH=${factors.MRecH.toFixed(6)}, MRecM=${factors.MRecM.toFixed(6)}, MRecL=${factors.MRecL.toFixed(6)}`);
      progressCallback?.(`    Thresholds: irrH=${factors.irrH.toFixed(0)} W/m², irrL=${factors.irrL.toFixed(0)} W/m²`);
    } else {
      uncalibratedCount++;
      progressCallback?.(`    Could not calibrate (insufficient data: ${samples.length} samples)`);
    }

    models.set(stationCode, model);
  }

  progressCallback?.(`\nCalibration complete: ${calibratedCount} calibrated, ${uncalibratedCount} uncalibrated`);

  return models;
}
