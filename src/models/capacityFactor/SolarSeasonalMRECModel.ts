/**
 * SolarSeasonalMRECModel - Seasonal MREC Calibration for Solar
 *
 * Addresses the monsoon/dry season bias problem by maintaining separate
 * MREC calibration factors for each Philippine season:
 *
 * - DRY (Amihan): November-February - NE monsoon, clearer skies, higher CF
 * - MONSOON (Habagat): June-October - SW monsoon, rainy/cloudy, lower CF
 * - TRANSITION: March-May - hot dry season, moderate CF
 *
 * This solves the ~57% under-prediction problem when training on monsoon
 * data and forecasting for dry season.
 */

import {
  StationType,
  CFacWeatherFeatures,
} from '../../types/capacityFactor.js';

/**
 * Philippine seasons based on monsoon patterns
 */
export enum PhilippineSeason {
  DRY = 'dry',           // Nov-Feb (Amihan - NE monsoon)
  MONSOON = 'monsoon',   // Jun-Oct (Habagat - SW monsoon)
  TRANSITION = 'transition', // Mar-May (hot dry)
}

/**
 * Get the season for a given date
 */
export function getPhilippineSeason(date: Date): PhilippineSeason {
  const month = date.getMonth() + 1; // 1-12

  if (month >= 11 || month <= 2) {
    return PhilippineSeason.DRY;
  } else if (month >= 6 && month <= 10) {
    return PhilippineSeason.MONSOON;
  } else {
    return PhilippineSeason.TRANSITION;
  }
}

/**
 * MREC factors for a single season
 */
export interface SeasonalMRECFactors {
  MRecH: number;   // High irradiance conversion factor
  MRecM: number;   // Mid irradiance conversion factor
  MRecL: number;   // Low irradiance conversion factor
  irrH: number;    // Threshold for HIGH tier (W/m²)
  irrL: number;    // Threshold for MID tier (W/m²)
  calibrated: boolean;
  sampleCount: number;
  stats?: {
    CFacH: number;
    CFacM: number;
    CFacL: number;
    IrrH: number;
    IrrM: number;
    IrrL: number;
    avgCFac: number;  // Average CF for this season
  };
}

/**
 * Complete seasonal MREC factors for a station
 */
export interface SolarSeasonalMRECFactors {
  stationCode: string;
  stationType: StationType;
  seasons: {
    [PhilippineSeason.DRY]?: SeasonalMRECFactors;
    [PhilippineSeason.MONSOON]?: SeasonalMRECFactors;
    [PhilippineSeason.TRANSITION]?: SeasonalMRECFactors;
  };
  calibrationDate: Date;
  totalSamples: number;
}

export interface SolarSeasonalCalibrationData {
  datetime: Date;
  stationCode: string;
  capacityFactor: number;
  solarIrradiance: number;
}

// Same PoE constants as iPool
const SOLAR_MREC_POE = {
  PoEHs: 0.1,   // Top 10% for HIGH tier
  PoELs: 0.3,   // Top 30% for MID tier cutoff
} as const;

export class SolarSeasonalMRECModel {
  private stationCode: string;
  private factors: SolarSeasonalMRECFactors | null = null;

  constructor(stationCode: string) {
    this.stationCode = stationCode;
  }

  /**
   * Calibrate seasonal MREC factors from historical data
   * Separates data by season and calibrates each independently
   */
  calibrate(data: SolarSeasonalCalibrationData[]): SolarSeasonalMRECFactors {
    // Filter for this station
    const stationData = data.filter(d => d.stationCode === this.stationCode);

    // Group by season
    const seasonalData: Map<PhilippineSeason, SolarSeasonalCalibrationData[]> = new Map();
    for (const season of Object.values(PhilippineSeason)) {
      seasonalData.set(season, []);
    }

    for (const d of stationData) {
      const season = getPhilippineSeason(d.datetime);
      seasonalData.get(season)!.push(d);
    }

    // Calibrate each season
    const seasonFactors: SolarSeasonalMRECFactors['seasons'] = {};

    for (const [season, samples] of seasonalData) {
      const factors = this.calibrateSeason(samples, season);
      if (factors) {
        seasonFactors[season] = factors;
      }
    }

    this.factors = {
      stationCode: this.stationCode,
      stationType: StationType.SOLAR,
      seasons: seasonFactors,
      calibrationDate: new Date(),
      totalSamples: stationData.length,
    };

    return this.factors;
  }

  /**
   * Calibrate MREC factors for a single season
   */
  private calibrateSeason(
    data: SolarSeasonalCalibrationData[],
    season: PhilippineSeason
  ): SeasonalMRECFactors | null {
    // Filter daylight samples
    const daylightData = data.filter(d => d.solarIrradiance > 10);

    if (daylightData.length < 20) {
      // Not enough data for this season - return null
      return null;
    }

    // Find min/max irradiance
    let minIrr = Infinity;
    let maxIrr = -Infinity;
    let cfSum = 0;

    for (const d of daylightData) {
      if (d.solarIrradiance < minIrr) minIrr = d.solarIrradiance;
      if (d.solarIrradiance > maxIrr) maxIrr = d.solarIrradiance;
      cfSum += d.capacityFactor;
    }

    if (maxIrr <= minIrr || maxIrr < 10) {
      return null;
    }

    const avgCFac = cfSum / daylightData.length;

    // Create histogram bins (25 bins like iPool)
    const NUM_BINS = 25;
    const binWidth = (maxIrr - minIrr) / NUM_BINS;

    const bins: { count: number; irrSum: number; cfSum: number }[] = [];
    for (let i = 0; i < NUM_BINS; i++) {
      bins.push({ count: 0, irrSum: 0, cfSum: 0 });
    }

    // Bin the data
    for (const d of daylightData) {
      let binIndex = Math.floor((d.solarIrradiance - minIrr) / binWidth);
      if (binIndex >= NUM_BINS) binIndex = NUM_BINS - 1;
      if (binIndex < 0) binIndex = 0;

      bins[binIndex].count++;
      bins[binIndex].irrSum += d.solarIrradiance;
      bins[binIndex].cfSum += d.capacityFactor;
    }

    // Calculate PoE thresholds
    const totalSamples = daylightData.length;
    const dH = SOLAR_MREC_POE.PoEHs;
    const dL = SOLAR_MREC_POE.PoELs;

    let cumCount = 0;
    let nH = 0, nM = 0, nL = 0;
    let irrSumH = 0, irrSumM = 0, irrSumL = 0;
    let cfSumH = 0, cfSumM = 0, cfSumL = 0;
    let irrH = 0, irrL = 0;
    let foundIrrH = false, foundIrrL = false;

    // Iterate from highest to lowest
    for (let i = NUM_BINS - 1; i >= 0; i--) {
      const bin = bins[i];
      if (bin.count === 0) continue;

      cumCount += bin.count;

      if (cumCount <= dH * totalSamples) {
        nH += bin.count;
        irrSumH += bin.irrSum;
        cfSumH += bin.cfSum;
      } else if (cumCount <= dL * totalSamples) {
        nM += bin.count;
        irrSumM += bin.irrSum;
        cfSumM += bin.cfSum;

        if (!foundIrrH) {
          irrH = minIrr + i * binWidth;
          foundIrrH = true;
        }
      } else {
        nL += bin.count;
        irrSumL += bin.irrSum;
        cfSumL += bin.cfSum;

        if (!foundIrrL) {
          irrL = minIrr + i * binWidth;
          foundIrrL = true;
        }
      }
    }

    // Calculate tier averages
    const IrrH = nH > 0 ? irrSumH / nH : 0;
    const IrrM = nM > 0 ? irrSumM / nM : 0;
    const IrrL = nL > 0 ? irrSumL / nL : 0;
    const CFacH = nH > 0 ? cfSumH / nH : 0;
    const CFacM = nM > 0 ? cfSumM / nM : 0;
    const CFacL = nL > 0 ? cfSumL / nL : 0;

    const CFacMFinal = CFacM > 0 ? CFacM : (CFacH + CFacL) / 2;
    const IrrMFinal = IrrM > 0 ? IrrM : (IrrH + IrrL) / 2;

    // Calculate conversion factors
    let MRecH = 0, MRecM = 0, MRecL = 0;
    let calibrated = false;

    if (IrrH > 10 && CFacH > 0) {
      MRecH = CFacH / IrrH;
      MRecM = IrrMFinal > 10 ? CFacMFinal / IrrMFinal : MRecH;
      MRecL = IrrL > 10 ? CFacL / IrrL : MRecM;
      calibrated = true;
    }

    return {
      MRecH,
      MRecM,
      MRecL,
      irrH,
      irrL,
      calibrated,
      sampleCount: daylightData.length,
      stats: {
        CFacH,
        CFacM: CFacMFinal,
        CFacL,
        IrrH,
        IrrM: IrrMFinal,
        IrrL,
        avgCFac,
      },
    };
  }

  /**
   * Predict capacity factor using seasonal MREC factors
   * Automatically selects the appropriate season based on datetime
   */
  predict(solarIrradiance: number, datetime: Date): number {
    if (!this.factors) {
      throw new Error(`Seasonal MREC not calibrated for ${this.stationCode}`);
    }

    if (solarIrradiance <= 0) {
      return 0;
    }

    // Get the season for the forecast datetime
    const season = getPhilippineSeason(datetime);
    let seasonFactors = this.factors.seasons[season];

    // Fallback to any available season if target season not calibrated
    if (!seasonFactors || !seasonFactors.calibrated) {
      // Try in order: transition (most neutral), then monsoon, then dry
      seasonFactors = this.factors.seasons[PhilippineSeason.TRANSITION]
        || this.factors.seasons[PhilippineSeason.MONSOON]
        || this.factors.seasons[PhilippineSeason.DRY];

      if (!seasonFactors || !seasonFactors.calibrated) {
        // No calibrated season available - use default
        return Math.min(1, Math.max(0, solarIrradiance * 0.00085));
      }
    }

    // Three-tier piecewise linear prediction
    let PcCon: number;

    if (solarIrradiance >= seasonFactors.irrH) {
      PcCon = seasonFactors.MRecH * solarIrradiance;
    } else if (solarIrradiance >= seasonFactors.irrL) {
      PcCon = seasonFactors.MRecM * solarIrradiance;
    } else {
      PcCon = seasonFactors.MRecL * solarIrradiance;
    }

    return Math.max(0, Math.min(1, PcCon));
  }

  /**
   * Predict from weather features
   */
  predictFromWeather(weather: CFacWeatherFeatures, datetime: Date): number {
    return this.predict(weather.solarRadiation, datetime);
  }

  /**
   * Get factors for a specific season
   */
  getSeasonFactors(season: PhilippineSeason): SeasonalMRECFactors | undefined {
    return this.factors?.seasons[season];
  }

  /**
   * Get all factors
   */
  getFactors(): SolarSeasonalMRECFactors | null {
    return this.factors;
  }

  /**
   * Check if any season is calibrated
   */
  isCalibrated(): boolean {
    if (!this.factors) return false;

    return Object.values(this.factors.seasons).some(s => s?.calibrated);
  }

  /**
   * Check if a specific season is calibrated
   */
  isSeasonCalibrated(season: PhilippineSeason): boolean {
    return this.factors?.seasons[season]?.calibrated ?? false;
  }

  /**
   * Get station code
   */
  getStationCode(): string {
    return this.stationCode;
  }

  /**
   * Get summary of seasonal calibration
   */
  getSummary(): string {
    if (!this.factors) return `${this.stationCode}: Not calibrated`;

    const parts: string[] = [`${this.stationCode}:`];

    for (const season of Object.values(PhilippineSeason)) {
      const sf = this.factors.seasons[season];
      if (sf?.calibrated) {
        parts.push(`  ${season}: n=${sf.sampleCount}, avgCF=${sf.stats?.avgCFac.toFixed(3) || '?'}`);
      } else {
        parts.push(`  ${season}: no data`);
      }
    }

    return parts.join('\n');
  }
}

/**
 * Batch calibrate seasonal MREC models for multiple stations
 */
export async function calibrateAllSeasonalSolarMREC(
  data: SolarSeasonalCalibrationData[],
  progressCallback?: (msg: string) => void
): Promise<Map<string, SolarSeasonalMRECModel>> {
  // Group by station
  const stationData = new Map<string, SolarSeasonalCalibrationData[]>();
  for (const d of data) {
    if (!stationData.has(d.stationCode)) {
      stationData.set(d.stationCode, []);
    }
    stationData.get(d.stationCode)!.push(d);
  }

  progressCallback?.(`Calibrating Seasonal Solar MREC for ${stationData.size} stations`);

  const models = new Map<string, SolarSeasonalMRECModel>();
  let idx = 0;

  for (const [stationCode, samples] of stationData) {
    idx++;
    const model = new SolarSeasonalMRECModel(stationCode);
    const factors = model.calibrate(samples);

    // Count calibrated seasons
    const calibratedSeasons = Object.values(factors.seasons)
      .filter(s => s?.calibrated).length;

    progressCallback?.(`  [${idx}/${stationData.size}] ${stationCode}: ${calibratedSeasons}/3 seasons calibrated`);

    // Log seasonal averages
    for (const season of Object.values(PhilippineSeason)) {
      const sf = factors.seasons[season];
      if (sf?.calibrated) {
        progressCallback?.(`    ${season.toUpperCase()}: n=${sf.sampleCount}, avgCF=${sf.stats?.avgCFac.toFixed(3)}, MRecH=${sf.MRecH.toFixed(6)}`);
      }
    }

    models.set(stationCode, model);
  }

  progressCallback?.(`\nSeasonal calibration complete for ${models.size} stations`);

  return models;
}
