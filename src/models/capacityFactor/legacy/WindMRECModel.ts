/**
 * WindMRECModel - iPool-style Three-Tier Piecewise Linear Wind Capacity Factor Model
 *
 * Port of iPool's MREC (Must-Run Energy Conversion) system from:
 * - ESite.cpp:469-493 (runtime forecasting)
 * - DMREC.cpp:222-372 (calibration)
 * - EProf.cpp:1978-2085 (CalcLevHML algorithm)
 *
 * The system uses Probability of Exceedance (PoE) to segment wind conditions
 * into three tiers, each with a calibrated conversion factor.
 */

import {
  MRECFactors,
  MRECCalibrationData,
  MREC_POE_CONSTANTS,
  StationType,
  CFacWeatherFeatures,
} from '../../../types/capacityFactor.js';

export class WindMRECModel {
  private stationCode: string;
  private factors: MRECFactors | null = null;

  constructor(stationCode: string) {
    this.stationCode = stationCode;
  }

  /**
   * Calibrate MREC factors from historical data
   * Port of iPool's CalcLevHML algorithm from EProf.cpp:1978-2085
   *
   * @param data - Array of paired (capacity factor, wind speed) samples
   * @returns Calibrated MREC factors
   */
  calibrate(data: MRECCalibrationData[]): MRECFactors {
    // Filter data for this station
    const stationData = data.filter(d => d.stationCode === this.stationCode);

    if (stationData.length < 100) {
      console.warn(`Insufficient data for ${this.stationCode}: ${stationData.length} samples (need 100+)`);
      return this.createUncalibratedFactors();
    }

    // Step 1: Find min/max wind speeds
    let minWind = Infinity;
    let maxWind = -Infinity;
    for (const d of stationData) {
      if (d.windSpeed < minWind) minWind = d.windSpeed;
      if (d.windSpeed > maxWind) maxWind = d.windSpeed;
    }

    if (maxWind <= minWind || maxWind < 0.1) {
      console.warn(`Invalid wind speed range for ${this.stationCode}: [${minWind}, ${maxWind}]`);
      return this.createUncalibratedFactors();
    }

    // Step 2: Create histogram bins (iPool uses 25 bins)
    const NUM_BINS = 25;
    const binWidth = (maxWind - minWind) / NUM_BINS;

    // Each bin tracks: count, sum of wind speeds, sum of capacity factors
    const bins: { count: number; windSum: number; cfSum: number }[] = [];
    for (let i = 0; i < NUM_BINS; i++) {
      bins.push({ count: 0, windSum: 0, cfSum: 0 });
    }

    // Step 3: Bin the data
    for (const d of stationData) {
      let binIndex = Math.floor((d.windSpeed - minWind) / binWidth);
      // Handle edge case where windSpeed === maxWind
      if (binIndex >= NUM_BINS) binIndex = NUM_BINS - 1;
      if (binIndex < 0) binIndex = 0;

      bins[binIndex].count++;
      bins[binIndex].windSum += d.windSpeed;
      bins[binIndex].cfSum += d.capacityFactor;
    }

    // Step 4: Calculate PoE thresholds (cumulative distribution from highest)
    const totalSamples = stationData.length;
    const dH = MREC_POE_CONSTANTS.PoEH; // 0.1 (top 10%)
    const dL = MREC_POE_CONSTANTS.PoEL; // 0.3 (top 30%)

    let cumCount = 0;
    let nH = 0, nM = 0, nL = 0;
    let windSumH = 0, windSumM = 0, windSumL = 0;
    let cfSumH = 0, cfSumM = 0, cfSumL = 0;
    let vH = 0, vL = 0;
    let foundVH = false, foundVL = false;

    // Iterate from highest bin to lowest (like iPool)
    for (let i = NUM_BINS - 1; i >= 0; i--) {
      const bin = bins[i];
      if (bin.count === 0) continue;

      cumCount += bin.count;

      if (cumCount <= dH * totalSamples) {
        // HIGH tier (top 10%)
        nH += bin.count;
        windSumH += bin.windSum;
        cfSumH += bin.cfSum;
      } else if (cumCount > dH * totalSamples && cumCount <= dL * totalSamples) {
        // MID tier (10%-30%)
        nM += bin.count;
        windSumM += bin.windSum;
        cfSumM += bin.cfSum;

        // Record vH threshold when transitioning from HIGH to MID
        if (!foundVH) {
          vH = minWind + i * binWidth;
          foundVH = true;
        }
      } else {
        // LOW tier (below 30%)
        nL += bin.count;
        windSumL += bin.windSum;
        cfSumL += bin.cfSum;

        // Record vL threshold when transitioning from MID to LOW
        if (!foundVL) {
          vL = minWind + i * binWidth;
          foundVL = true;
        }
      }
    }

    // Step 5: Calculate averages for each tier
    const ValH = nH > 0 ? windSumH / nH : 0;
    const ValM = nM > 0 ? windSumM / nM : 0;
    const ValL = nL > 0 ? windSumL / nL : 0;
    const CFacH = nH > 0 ? cfSumH / nH : 0;
    const CFacM = nM > 0 ? cfSumM / nM : 0;
    const CFacL = nL > 0 ? cfSumL / nL : 0;

    // Handle case where MID tier has no samples
    const CFacMFinal = CFacM > 0 ? CFacM : (CFacH + CFacL) / 2;
    const ValMFinal = ValM > 0 ? ValM : (ValH + ValL) / 2;

    // Step 6: Calculate conversion factors (CF = MRec * WindSpeed)
    // MRec = avgCF / avgWind for each tier
    let MRecH = 0, MRecM = 0, MRecL = 0;
    let calibrated = false;

    if (ValH > 0.1 && CFacH > 0) {
      MRecH = CFacH / ValH;
      MRecM = CFacMFinal / ValMFinal;
      MRecL = ValL > 0.1 ? CFacL / ValL : MRecM;  // Fallback to MID if LOW has no wind
      calibrated = true;
    }

    // Create factors object
    this.factors = {
      stationCode: this.stationCode,
      stationType: StationType.WIND,
      MRecH,
      MRecM,
      MRecL,
      vH,
      vL,
      calibrated,
      calibrationDate: new Date(),
      sampleCount: stationData.length,
      stats: {
        CFacH,
        CFacM: CFacMFinal,
        CFacL,
        ValH,
        ValM: ValMFinal,
        ValL,
        maxWind,
        minWind,
      },
    };

    return this.factors;
  }

  /**
   * Calibrate MREC factors using ML-optimized thresholds
   * Uses grid search to find optimal vH and vL that minimize peak-weighted prediction error
   *
   * Each station learns its own PoE thresholds instead of using fixed 0.1/0.3
   * Key improvements over simple MAE optimization:
   * 1. Peak-weighted error: High CF samples count more
   * 2. Asymmetric penalty: Under-prediction of peaks penalized 2x
   * 3. Constrained search: vH limited to 85th percentile of wind speeds
   *
   * @param data - Array of paired (capacity factor, wind speed) samples
   * @returns Calibrated MREC factors with optimized thresholds
   */
  calibrateMLOptimized(data: MRECCalibrationData[]): MRECFactors {
    const stationData = data.filter(d => d.stationCode === this.stationCode);

    if (stationData.length < 100) {
      console.warn(`Insufficient data for ${this.stationCode}: ${stationData.length} samples (need 100+)`);
      return this.createUncalibratedFactors();
    }

    // Sort data by wind speed
    const sortedByWind = [...stationData].sort((a, b) => a.windSpeed - b.windSpeed);
    const minWind = sortedByWind[0].windSpeed;

    // Constrain vH search to 85th percentile of wind speeds (more realistic)
    const p85Index = Math.floor(sortedByWind.length * 0.85);
    const maxSearchWind = sortedByWind[p85Index].windSpeed;
    const windRange = maxSearchWind - minWind;

    // Find max CF for weighting
    const maxCF = Math.max(...stationData.map(d => d.capacityFactor));
    const highCFThreshold = maxCF * 0.5;  // Samples with CF > 50% of max are "high"

    // Grid search parameters
    const GRID_STEPS = 25;
    let bestScore = Infinity;
    let bestVH = maxSearchWind * 0.7;
    let bestVL = maxSearchWind * 0.3;

    // Grid search over vH and vL combinations
    for (let hStep = 4; hStep < GRID_STEPS; hStep++) {
      for (let lStep = 1; lStep < hStep; lStep++) {
        const candidateVH = minWind + (hStep / GRID_STEPS) * windRange;
        const candidateVL = minWind + (lStep / GRID_STEPS) * windRange;

        // Calculate MRec factors for this threshold combination
        let nH = 0, nM = 0, nL = 0;
        let windSumH = 0, windSumM = 0, windSumL = 0;
        let cfSumH = 0, cfSumM = 0, cfSumL = 0;

        for (const d of stationData) {
          if (d.windSpeed >= candidateVH) {
            nH++; windSumH += d.windSpeed; cfSumH += d.capacityFactor;
          } else if (d.windSpeed >= candidateVL) {
            nM++; windSumM += d.windSpeed; cfSumM += d.capacityFactor;
          } else {
            nL++; windSumL += d.windSpeed; cfSumL += d.capacityFactor;
          }
        }

        // Skip if any tier has insufficient samples (reduced requirement for HIGH)
        if (nH < 5 || nM < 10 || nL < 10) continue;

        // Calculate MRec factors
        const ValH = windSumH / nH;
        const ValM = windSumM / nM;
        const ValL = windSumL / nL;
        const CFacH = cfSumH / nH;
        const CFacM = cfSumM / nM;
        const CFacL = cfSumL / nL;

        const MRecH = CFacH / ValH;
        const MRecM = CFacM / ValM;
        const MRecL = CFacL / ValL;

        // Evaluate with peak-weighted and asymmetric error
        let totalWeightedError = 0;
        let totalWeight = 0;

        for (const d of stationData) {
          let pred: number;
          if (d.windSpeed >= candidateVH) {
            pred = MRecH * d.windSpeed;
          } else if (d.windSpeed >= candidateVL) {
            pred = MRecM * d.windSpeed;
          } else {
            pred = MRecL * d.windSpeed;
          }
          pred = Math.min(1, Math.max(0, pred));

          const error = pred - d.capacityFactor;
          const absError = Math.abs(error);

          // Weight by actual CF (high CF samples count more)
          // Add 0.1 base weight so low CF samples still count somewhat
          const cfWeight = 0.1 + d.capacityFactor;

          // Asymmetric penalty: under-prediction of high CF is penalized 2x
          let penalty = absError;
          if (d.capacityFactor > highCFThreshold && error < 0) {
            // Under-predicting a high CF sample - double the penalty
            penalty = absError * 2.0;
          }

          totalWeightedError += penalty * cfWeight;
          totalWeight += cfWeight;
        }

        const weightedMAE = totalWeightedError / totalWeight;

        if (weightedMAE < bestScore) {
          bestScore = weightedMAE;
          bestVH = candidateVH;
          bestVL = candidateVL;
        }
      }
    }

    // Calculate final MRec factors with best thresholds
    let nH = 0, nM = 0, nL = 0;
    let windSumH = 0, windSumM = 0, windSumL = 0;
    let cfSumH = 0, cfSumM = 0, cfSumL = 0;

    for (const d of stationData) {
      if (d.windSpeed >= bestVH) {
        nH++; windSumH += d.windSpeed; cfSumH += d.capacityFactor;
      } else if (d.windSpeed >= bestVL) {
        nM++; windSumM += d.windSpeed; cfSumM += d.capacityFactor;
      } else {
        nL++; windSumL += d.windSpeed; cfSumL += d.capacityFactor;
      }
    }

    const ValH = nH > 0 ? windSumH / nH : bestVH;
    const ValM = nM > 0 ? windSumM / nM : (bestVH + bestVL) / 2;
    const ValL = nL > 0 ? windSumL / nL : bestVL / 2;
    const CFacH = nH > 0 ? cfSumH / nH : 0.7;
    const CFacM = nM > 0 ? cfSumM / nM : 0.4;
    const CFacL = nL > 0 ? cfSumL / nL : 0.1;

    const MRecH = ValH > 0.1 ? CFacH / ValH : 0.05;
    const MRecM = ValM > 0.1 ? CFacM / ValM : 0.03;
    const MRecL = ValL > 0.1 ? CFacL / ValL : 0.02;

    // Get actual max wind for stats
    const maxWind = sortedByWind[sortedByWind.length - 1].windSpeed;

    this.factors = {
      stationCode: this.stationCode,
      stationType: StationType.WIND,
      MRecH,
      MRecM,
      MRecL,
      vH: bestVH,
      vL: bestVL,
      calibrated: true,
      calibrationDate: new Date(),
      sampleCount: stationData.length,
      stats: {
        CFacH,
        CFacM,
        CFacL,
        ValH,
        ValM,
        ValL,
        maxWind,
        minWind,
      },
    };

    return this.factors;
  }

  /**
   * Calibrate MREC factors using CF-based shoulder points
   * Instead of wind percentiles, find thresholds where CF behavior changes
   *
   * This learns shoulder points from actual CF-wind relationship:
   * - vH: wind speed where CF reaches ~70% of max (high production zone)
   * - vL: wind speed where CF starts meaningful output (~20% of max)
   *
   * @param data - Array of paired (capacity factor, wind speed) samples
   * @returns Calibrated MREC factors
   */
  calibrateCFBased(data: MRECCalibrationData[]): MRECFactors {
    const stationData = data.filter(d => d.stationCode === this.stationCode);

    if (stationData.length < 100) {
      console.warn(`Insufficient data for ${this.stationCode}: ${stationData.length} samples (need 100+)`);
      return this.createUncalibratedFactors();
    }

    // Step 1: Sort data by wind speed and bin it
    const sortedData = [...stationData].sort((a, b) => a.windSpeed - b.windSpeed);

    // Create bins for analysis
    const NUM_BINS = 30;
    const minWind = sortedData[0].windSpeed;
    const maxWind = sortedData[sortedData.length - 1].windSpeed;
    const binWidth = (maxWind - minWind) / NUM_BINS;

    interface Bin {
      windCenter: number;
      cfSum: number;
      windSum: number;
      count: number;
    }

    const bins: Bin[] = [];
    for (let i = 0; i < NUM_BINS; i++) {
      bins.push({
        windCenter: minWind + (i + 0.5) * binWidth,
        cfSum: 0,
        windSum: 0,
        count: 0
      });
    }

    // Bin the data
    for (const d of stationData) {
      let binIndex = Math.floor((d.windSpeed - minWind) / binWidth);
      if (binIndex >= NUM_BINS) binIndex = NUM_BINS - 1;
      if (binIndex < 0) binIndex = 0;

      bins[binIndex].cfSum += d.capacityFactor;
      bins[binIndex].windSum += d.windSpeed;
      bins[binIndex].count++;
    }

    // Step 2: Find max CF and calculate CF thresholds
    let maxCF = 0;
    for (const bin of bins) {
      if (bin.count > 5) {
        const avgCF = bin.cfSum / bin.count;
        if (avgCF > maxCF) maxCF = avgCF;
      }
    }

    // Threshold targets (as fraction of max CF)
    const cfHighThreshold = maxCF * 0.65;   // 65% of max CF → HIGH tier starts
    const cfLowThreshold = maxCF * 0.25;    // 25% of max CF → MID tier starts

    // Step 3: Find wind speeds where CF crosses these thresholds
    let vH = maxWind * 0.7;  // Default fallback
    let vL = maxWind * 0.3;  // Default fallback
    let foundVH = false;
    let foundVL = false;

    // Scan from low wind to high to find transition points
    for (let i = 0; i < bins.length; i++) {
      const bin = bins[i];
      if (bin.count < 3) continue;

      const avgCF = bin.cfSum / bin.count;
      const avgWind = bin.windSum / bin.count;

      // Find where CF first reaches the high threshold
      if (!foundVH && avgCF >= cfHighThreshold) {
        vH = avgWind;
        foundVH = true;
      }

      // Find where CF first reaches the low threshold
      if (!foundVL && avgCF >= cfLowThreshold) {
        vL = avgWind;
        foundVL = true;
      }
    }

    // Ensure vL < vH
    if (vL >= vH) {
      vL = vH * 0.6;
    }

    // Step 4: Calculate tier statistics and MRec factors
    let nH = 0, nM = 0, nL = 0;
    let windSumH = 0, windSumM = 0, windSumL = 0;
    let cfSumH = 0, cfSumM = 0, cfSumL = 0;

    for (const d of stationData) {
      if (d.windSpeed >= vH) {
        nH++;
        windSumH += d.windSpeed;
        cfSumH += d.capacityFactor;
      } else if (d.windSpeed >= vL) {
        nM++;
        windSumM += d.windSpeed;
        cfSumM += d.capacityFactor;
      } else {
        nL++;
        windSumL += d.windSpeed;
        cfSumL += d.capacityFactor;
      }
    }

    // Calculate averages
    const ValH = nH > 0 ? windSumH / nH : vH;
    const ValM = nM > 0 ? windSumM / nM : (vH + vL) / 2;
    const ValL = nL > 0 ? windSumL / nL : vL / 2;
    const CFacH = nH > 0 ? cfSumH / nH : maxCF;
    const CFacM = nM > 0 ? cfSumM / nM : maxCF * 0.5;
    const CFacL = nL > 0 ? cfSumL / nL : maxCF * 0.15;

    // Step 5: Calculate MRec conversion factors
    const MRecH = ValH > 0.1 ? CFacH / ValH : 0.05;
    const MRecM = ValM > 0.1 ? CFacM / ValM : 0.03;
    const MRecL = ValL > 0.1 ? CFacL / ValL : 0.02;

    this.factors = {
      stationCode: this.stationCode,
      stationType: StationType.WIND,
      MRecH,
      MRecM,
      MRecL,
      vH,
      vL,
      calibrated: true,
      calibrationDate: new Date(),
      sampleCount: stationData.length,
      stats: {
        CFacH,
        CFacM,
        CFacL,
        ValH,
        ValM,
        ValL,
        maxWind,
        minWind,
      },
    };

    return this.factors;
  }

  /**
   * Create uncalibrated factors (fallback)
   * Uses reasonable defaults based on typical wind turbine behavior
   */
  private createUncalibratedFactors(): MRECFactors {
    this.factors = {
      stationCode: this.stationCode,
      stationType: StationType.WIND,
      MRecH: 0.08,   // ~80% CF at 10 m/s
      MRecM: 0.06,   // ~36% CF at 6 m/s
      MRecL: 0.03,   // ~9% CF at 3 m/s
      vH: 10,        // High wind threshold
      vL: 5,         // Low wind threshold
      calibrated: false,
      calibrationDate: new Date(),
      sampleCount: 0,
    };
    return this.factors;
  }

  /**
   * Load pre-calibrated factors
   */
  loadFactors(factors: MRECFactors): void {
    this.factors = factors;
  }

  /**
   * Predict capacity factor from wind speed
   * Port of iPool's ESite.cpp:469-493 runtime logic
   *
   * @param windSpeed - Wind speed in m/s (preferably hub-height 100m)
   * @returns Predicted capacity factor [0, 1]
   */
  predict(windSpeed: number): number {
    if (!this.factors) {
      throw new Error(`MREC factors not calibrated for station ${this.stationCode}`);
    }

    if (!this.factors.calibrated) {
      // Return simple estimate for uncalibrated stations
      return Math.min(1, Math.max(0, windSpeed * 0.05));
    }

    let PcCon: number;

    // Three-tier piecewise linear conversion
    if (windSpeed >= this.factors.vH) {
      PcCon = this.factors.MRecH * windSpeed;
    } else if (windSpeed >= this.factors.vL) {
      PcCon = this.factors.MRecM * windSpeed;
    } else {
      PcCon = this.factors.MRecL * windSpeed;
    }

    // High wind cutout protection (from iPool ESite.cpp:482-485)
    // If predicted CF > 110%, likely a storm shutdown scenario
    if (PcCon > 1.1) {
      return 0;  // High wind cutout
    }

    // Cap at 100%
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
    // Prefer 100m wind speed for wind farms (hub height)
    const windSpeed = weather.windSpeed100 ?? weather.windSpeed;
    return this.predict(windSpeed);
  }

  /**
   * Get calibrated factors
   */
  getFactors(): MRECFactors | null {
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
    const parsed = JSON.parse(json) as MRECFactors;
    if (parsed.calibrationDate) {
      parsed.calibrationDate = new Date(parsed.calibrationDate);
    }
    this.factors = parsed;
  }
}

/**
 * Batch calibrate MREC models for multiple stations
 *
 * @param data - All calibration data (will be grouped by station)
 * @param progressCallback - Optional progress callback
 * @returns Map of station code to calibrated model
 */
export async function calibrateAllMREC(
  data: MRECCalibrationData[],
  progressCallback?: (msg: string) => void
): Promise<Map<string, WindMRECModel>> {
  // Group data by station
  const stationData = new Map<string, MRECCalibrationData[]>();
  for (const d of data) {
    if (!stationData.has(d.stationCode)) {
      stationData.set(d.stationCode, []);
    }
    stationData.get(d.stationCode)!.push(d);
  }

  progressCallback?.(`Calibrating MREC for ${stationData.size} stations from ${data.length} samples`);

  const models = new Map<string, WindMRECModel>();
  let calibratedCount = 0;
  let uncalibratedCount = 0;

  for (const [stationCode, samples] of stationData) {
    progressCallback?.(`  [${calibratedCount + uncalibratedCount + 1}/${stationData.size}] Calibrating ${stationCode}...`);

    const model = new WindMRECModel(stationCode);
    const factors = model.calibrate(
      samples.map(s => ({ ...s, stationCode }))
    );

    if (factors.calibrated) {
      calibratedCount++;
      progressCallback?.(`    Calibrated: MRecH=${factors.MRecH.toFixed(4)}, MRecM=${factors.MRecM.toFixed(4)}, MRecL=${factors.MRecL.toFixed(4)}`);
      progressCallback?.(`    Thresholds: vH=${factors.vH.toFixed(1)} m/s, vL=${factors.vL.toFixed(1)} m/s`);
    } else {
      uncalibratedCount++;
      progressCallback?.(`    Could not calibrate (insufficient data: ${samples.length} samples)`);
    }

    models.set(stationCode, model);
  }

  progressCallback?.(`\nCalibration complete: ${calibratedCount} calibrated, ${uncalibratedCount} uncalibrated`);

  return models;
}

/**
 * Batch calibrate MREC models using CF-based shoulder points
 * This learns thresholds from actual CF-wind relationship instead of wind percentiles
 *
 * @param data - All calibration data (will be grouped by station)
 * @param progressCallback - Optional progress callback
 * @returns Map of station code to calibrated model
 */
export async function calibrateAllMRECCFBased(
  data: MRECCalibrationData[],
  progressCallback?: (msg: string) => void
): Promise<Map<string, WindMRECModel>> {
  // Group data by station
  const stationData = new Map<string, MRECCalibrationData[]>();
  for (const d of data) {
    if (!stationData.has(d.stationCode)) {
      stationData.set(d.stationCode, []);
    }
    stationData.get(d.stationCode)!.push(d);
  }

  progressCallback?.(`Calibrating MREC (CF-based) for ${stationData.size} stations from ${data.length} samples`);

  const models = new Map<string, WindMRECModel>();
  let calibratedCount = 0;
  let uncalibratedCount = 0;

  for (const [stationCode, samples] of stationData) {
    progressCallback?.(`  [${calibratedCount + uncalibratedCount + 1}/${stationData.size}] Calibrating ${stationCode}...`);

    const model = new WindMRECModel(stationCode);
    const factors = model.calibrateCFBased(
      samples.map(s => ({ ...s, stationCode }))
    );

    if (factors.calibrated) {
      calibratedCount++;
      progressCallback?.(`    CF-Based: MRecH=${factors.MRecH.toFixed(4)}, MRecM=${factors.MRecM.toFixed(4)}, MRecL=${factors.MRecL.toFixed(4)}`);
      progressCallback?.(`    Learned thresholds: vH=${factors.vH.toFixed(1)} m/s, vL=${factors.vL.toFixed(1)} m/s`);
    } else {
      uncalibratedCount++;
      progressCallback?.(`    Could not calibrate (insufficient data: ${samples.length} samples)`);
    }

    models.set(stationCode, model);
  }

  progressCallback?.(`\nCF-Based calibration complete: ${calibratedCount} calibrated, ${uncalibratedCount} uncalibrated`);

  return models;
}

/**
 * Batch calibrate MREC models using ML-optimized grid search
 * This finds optimal vH/vL thresholds per station that minimize prediction error
 *
 * @param data - All calibration data (will be grouped by station)
 * @param progressCallback - Optional progress callback
 * @returns Map of station code to calibrated model
 */
export async function calibrateAllMRECMLOptimized(
  data: MRECCalibrationData[],
  progressCallback?: (msg: string) => void
): Promise<Map<string, WindMRECModel>> {
  // Group data by station
  const stationData = new Map<string, MRECCalibrationData[]>();
  for (const d of data) {
    if (!stationData.has(d.stationCode)) {
      stationData.set(d.stationCode, []);
    }
    stationData.get(d.stationCode)!.push(d);
  }

  progressCallback?.(`Calibrating MREC (ML-Optimized) for ${stationData.size} stations from ${data.length} samples`);

  const models = new Map<string, WindMRECModel>();
  let calibratedCount = 0;
  let uncalibratedCount = 0;

  for (const [stationCode, samples] of stationData) {
    progressCallback?.(`  [${calibratedCount + uncalibratedCount + 1}/${stationData.size}] Calibrating ${stationCode}...`);

    const model = new WindMRECModel(stationCode);
    const factors = model.calibrateMLOptimized(
      samples.map(s => ({ ...s, stationCode }))
    );

    if (factors.calibrated) {
      calibratedCount++;
      // Calculate learned PoE for display
      const sortedSamples = [...samples].sort((a, b) => b.windSpeed - a.windSpeed);
      const aboveVH = sortedSamples.filter(s => s.windSpeed >= factors.vH).length;
      const aboveVL = sortedSamples.filter(s => s.windSpeed >= factors.vL).length;
      const learnedPoEH = (aboveVH / samples.length * 100).toFixed(1);
      const learnedPoEL = (aboveVL / samples.length * 100).toFixed(1);

      progressCallback?.(`    ML-Optimized: MRecH=${factors.MRecH.toFixed(4)}, MRecM=${factors.MRecM.toFixed(4)}, MRecL=${factors.MRecL.toFixed(4)}`);
      progressCallback?.(`    Learned thresholds: vH=${factors.vH.toFixed(1)} m/s (top ${learnedPoEH}%), vL=${factors.vL.toFixed(1)} m/s (top ${learnedPoEL}%)`);
    } else {
      uncalibratedCount++;
      progressCallback?.(`    Could not calibrate (insufficient data: ${samples.length} samples)`);
    }

    models.set(stationCode, model);
  }

  progressCallback?.(`\nML-Optimized calibration complete: ${calibratedCount} calibrated, ${uncalibratedCount} uncalibrated`);

  return models;
}
