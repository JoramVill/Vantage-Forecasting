import { DateTime } from 'luxon';
import { FeatureVector, TrainingSample } from '../types/index.js';
import { FEATURE_NAMES } from '../constants/index.js';
import MultivariateLinearRegression from 'ml-regression-multivariate-linear';
import { DemandCalibrator } from './DemandCalibrator.js';

/**
 * Time period definitions for different demand drivers
 */
enum TimePeriod {
  NIGHT = 'night',           // 0-5: Base load, low variation
  MORNING_RAMP = 'morning',  // 6-9: Wake-up patterns
  MIDDAY = 'midday',         // 10-16: Temperature/cooling dominant
  EVENING_PEAK = 'evening',  // 17-22: Residential surge
  LATE_NIGHT = 'late'        // 23: Transition
}

/**
 * Get time period for a given hour
 */
function getTimePeriod(hour: number): TimePeriod {
  if (hour >= 0 && hour <= 5) return TimePeriod.NIGHT;
  if (hour >= 6 && hour <= 9) return TimePeriod.MORNING_RAMP;
  if (hour >= 10 && hour <= 16) return TimePeriod.MIDDAY;
  if (hour >= 17 && hour <= 22) return TimePeriod.EVENING_PEAK;
  return TimePeriod.LATE_NIGHT;
}

/**
 * Statistical profile for a specific hour/daytype combination
 */
interface StatisticalBounds {
  min: number;
  median: number;
  max: number;
  count: number;
  recentDays: Array<{ date: string; demand: number; temp: number }>;
  // Temperature-demand relationship for this hour
  tempCoefficient: number; // How much demand changes per degree C
  baseTemp: number; // Reference temperature for the profile
  // Time period for this hour
  timePeriod: TimePeriod;
  // Region-specific swing characteristics (learned from data)
  swingAmplitude: number; // Actual observed daily swing for this profile
  region: string; // Region this profile belongs to
}

/**
 * Region-specific shape characteristics (learned during training)
 * Controls how the model interpolates within min/max bounds
 */
interface RegionCharacteristics {
  // Daily swing ratio: how much the region varies peak-to-trough
  avgDailySwing: number;
  // Temperature sensitivity multiplier (learned from data)
  tempSensitivityMultiplier: number;
  // Peak hour bias: does this region peak earlier/later than median?
  peakHourOffset: number;
  // Trough depth: how low does the region go relative to median?
  troughDepthRatio: number;
}

/**
 * Hybrid Interpolation Model
 *
 * Combines statistical profiles (Min/Median/Max) with time-period aware adjustments.
 * - Builds dynamic bounds from recent similar days (same daytype/hour)
 * - Uses different temperature sensitivity per time period
 * - Evening peak modeled separately from temperature-driven midday
 * - Optional growth factor to adjust bounds for trending demand
 */
export class HybridModel {
  private model: MultivariateLinearRegression | null = null;
  private profiles: Map<string, StatisticalBounds> = new Map();
  private regionCharacteristics: Map<string, RegionCharacteristics> = new Map();
  private growthFactor: number = 0; // Daily growth rate (e.g., 0.0001 = 0.01% per day)
  private recentDaysCount: number = 7;
  // Weekend correction factors learned from validation data
  // These correct for systematic over-forecasting on weekends (especially CLUZ)
  // Key: region, Value: { saturday: factor, sunday: factor }
  private weekendCorrectionFactors: Map<string, { saturday: number; sunday: number }> = new Map([
    ['CLUZ', { saturday: 0.947, sunday: 0.951 }],  // CLUZ weekends over-forecast by ~5%
    ['CVIS', { saturday: 1.009, sunday: 0.980 }],  // CVIS close to accurate
    ['CMIN', { saturday: 0.999, sunday: 1.018 }],  // CMIN close to accurate
  ]);
  // XGBoost calibrator for post-hybrid correction
  private calibrator: DemandCalibrator | null = null;

  constructor(options?: { growthFactor?: number; recentDaysCount?: number }) {
    if (options?.growthFactor !== undefined) {
      this.growthFactor = options.growthFactor;
    }
    if (options?.recentDaysCount !== undefined) {
      this.recentDaysCount = options.recentDaysCount;
    }
  }

  /**
   * Build statistical profiles from training data
   */
  buildProfiles(samples: TrainingSample[]): void {
    // Group samples by region_hour_daytype
    const grouped = new Map<string, Array<{ date: Date; demand: number; temp: number }>>();

    for (const sample of samples) {
      const hour = sample.features.hour;
      const dayType = sample.features.isSunday ? 2 : sample.features.isSaturday ? 1 : 0;
      const region = this.inferRegion(sample);
      const key = `${region}_${hour}_${dayType}`;

      if (!grouped.has(key)) {
        grouped.set(key, []);
      }

      grouped.get(key)!.push({
        date: sample.datetime,
        demand: sample.demand,
        temp: sample.features.temp
      });
    }

    // Build profiles for each group
    for (const [key, records] of grouped) {
      // Sort by date descending (most recent first)
      records.sort((a, b) => b.date.getTime() - a.date.getTime());

      // Get recent days for dynamic bounds
      const recentDays = records.slice(0, this.recentDaysCount).map(r => ({
        date: DateTime.fromJSDate(r.date).toISODate() || '',
        demand: r.demand,
        temp: r.temp
      }));

      // Calculate statistics from ALL data for stable profiles
      // Use 5th and 95th percentiles instead of min/max to be robust to outliers
      const demands = records.map(r => r.demand);
      demands.sort((a, b) => a - b);

      const p5Index = Math.floor(demands.length * 0.05);
      const p95Index = Math.min(demands.length - 1, Math.floor(demands.length * 0.95));
      const medianIndex = Math.floor(demands.length / 2);

      const min = demands[p5Index];
      const max = demands[p95Index];
      const median = demands[medianIndex];

      // Calculate temperature-demand relationship for this hour/daytype
      // Simple linear regression: demand = baseValue + tempCoeff * (temp - baseTemp)
      const temps = records.map(r => r.temp);
      const baseTemp = temps.reduce((sum, t) => sum + t, 0) / temps.length;

      // Calculate temperature coefficient using covariance
      let covTempDemand = 0;
      let varTemp = 0;
      const meanDemand = demands.reduce((sum, d) => sum + d, 0) / demands.length;

      for (const r of records) {
        covTempDemand += (r.temp - baseTemp) * (r.demand - meanDemand);
        varTemp += (r.temp - baseTemp) * (r.temp - baseTemp);
      }

      // Temperature coefficient (MW per degree C)
      // Positive means higher temp = higher demand (cooling load)
      const tempCoefficient = varTemp > 0 ? covTempDemand / varTemp : 0;

      // Extract region and hour from key (format: region_hour_daytype)
      const keyParts = key.split('_');
      const region = keyParts[0];
      const hour = parseInt(keyParts[1], 10);
      const timePeriod = getTimePeriod(hour);

      // Calculate swing amplitude for this profile
      const swingAmplitude = max - min;

      this.profiles.set(key, {
        min,
        median,
        max,
        count: demands.length,
        recentDays,
        tempCoefficient,
        baseTemp,
        timePeriod,
        swingAmplitude,
        region
      });
    }

    // Learn region-specific characteristics from profiles
    this.learnRegionCharacteristics(samples);
  }

  /**
   * Learn weekend correction factors dynamically from training data.
   * Computes Saturday and Sunday correction factors per region/zone.
   * For the old 3-region system, falls back to hardcoded values.
   * For the 14-zone system, learns from data.
   */
  public learnWeekendCorrections(
    trainingData: { datetime: Date; region: string; demand: number; predictedDemand: number }[]
  ): void {
    // Group data by region
    const regionData = new Map<string, { actual: number[]; predicted: number[]; dayType: string[] }>();

    for (const sample of trainingData) {
      const dt = sample.datetime instanceof Date ? sample.datetime : new Date(sample.datetime);
      const day = dt.getDay();
      let dayType = 'weekday';
      if (day === 6) dayType = 'saturday';
      if (day === 0) dayType = 'sunday';

      if (!regionData.has(sample.region)) {
        regionData.set(sample.region, { actual: [], predicted: [], dayType: [] });
      }
      const rd = regionData.get(sample.region)!;
      rd.actual.push(sample.demand);
      rd.predicted.push(sample.predictedDemand);
      rd.dayType.push(dayType);
    }

    // For each region, compute weekend correction
    for (const [region, data] of regionData) {
      // Skip if we already have hardcoded values for this region (CLUZ, CVIS, CMIN)
      if (this.weekendCorrectionFactors.has(region)) continue;

      let satActualSum = 0, satPredSum = 0, satCount = 0;
      let sunActualSum = 0, sunPredSum = 0, sunCount = 0;

      for (let i = 0; i < data.actual.length; i++) {
        if (data.dayType[i] === 'saturday' && data.predicted[i] > 0) {
          satActualSum += data.actual[i];
          satPredSum += data.predicted[i];
          satCount++;
        } else if (data.dayType[i] === 'sunday' && data.predicted[i] > 0) {
          sunActualSum += data.actual[i];
          sunPredSum += data.predicted[i];
          sunCount++;
        }
      }

      // Need at least 4 samples per day type (about 1 weekend)
      const saturday = satCount >= 4 ? satActualSum / satPredSum : 1.0;
      const sunday = sunCount >= 4 ? sunActualSum / sunPredSum : 1.0;

      // Clamp to reasonable range (0.85 - 1.15)
      const clamp = (v: number) => Math.max(0.85, Math.min(1.15, v));

      this.weekendCorrectionFactors.set(region, {
        saturday: clamp(saturday),
        sunday: clamp(sunday)
      });

      console.log(`  Weekend correction for ${region}: Sat=${clamp(saturday).toFixed(3)}, Sun=${clamp(sunday).toFixed(3)} (${satCount}/${sunCount} samples)`);
    }
  }

  /**
   * Learn region-specific shape characteristics from training data
   * This replaces hardcoded TEMP_SENSITIVITY with data-driven values
   */
  private learnRegionCharacteristics(samples: TrainingSample[]): void {
    // Group samples by region and date to calculate daily patterns
    const regionDays = new Map<string, Map<string, Array<{ hour: number; demand: number; temp: number }>>>();

    for (const sample of samples) {
      const region = this.inferRegion(sample);
      const dateStr = DateTime.fromJSDate(sample.datetime).toISODate() || '';

      if (!regionDays.has(region)) {
        regionDays.set(region, new Map());
      }
      const regionData = regionDays.get(region)!;
      if (!regionData.has(dateStr)) {
        regionData.set(dateStr, []);
      }
      regionData.get(dateStr)!.push({
        hour: sample.features.hour,
        demand: sample.demand,
        temp: sample.features.temp
      });
    }

    // Calculate characteristics for each region
    for (const [region, dailyData] of regionDays) {
      const dailySwings: number[] = [];
      const dailyPeakHours: number[] = [];
      const dailyTroughRatios: number[] = [];
      const tempDemandCorrelations: number[] = [];

      for (const [dateStr, hourlyData] of dailyData) {
        if (hourlyData.length < 20) continue; // Skip incomplete days

        const demands = hourlyData.map(h => h.demand);
        const temps = hourlyData.map(h => h.temp);
        const maxDemand = Math.max(...demands);
        const minDemand = Math.min(...demands);
        const avgDemand = demands.reduce((a, b) => a + b, 0) / demands.length;

        // Daily swing (max - min)
        dailySwings.push(maxDemand - minDemand);

        // Peak hour
        const peakHour = hourlyData[demands.indexOf(maxDemand)].hour;
        dailyPeakHours.push(peakHour);

        // Trough depth ratio (how far below average is the trough)
        dailyTroughRatios.push(minDemand / avgDemand);

        // Temperature-demand correlation for this day
        if (temps.length > 1) {
          const avgTemp = temps.reduce((a, b) => a + b, 0) / temps.length;
          let covTD = 0, varT = 0, varD = 0;
          for (let i = 0; i < demands.length; i++) {
            const tDev = temps[i] - avgTemp;
            const dDev = demands[i] - avgDemand;
            covTD += tDev * dDev;
            varT += tDev * tDev;
            varD += dDev * dDev;
          }
          if (varT > 0 && varD > 0) {
            tempDemandCorrelations.push(covTD / Math.sqrt(varT * varD));
          }
        }
      }

      if (dailySwings.length === 0) continue;

      // Calculate average characteristics
      const avgDailySwing = dailySwings.reduce((a, b) => a + b, 0) / dailySwings.length;
      const avgPeakHour = dailyPeakHours.reduce((a, b) => a + b, 0) / dailyPeakHours.length;
      const avgTroughRatio = dailyTroughRatios.reduce((a, b) => a + b, 0) / dailyTroughRatios.length;
      const avgTempCorr = tempDemandCorrelations.length > 0
        ? tempDemandCorrelations.reduce((a, b) => a + b, 0) / tempDemandCorrelations.length
        : 0.5;

      // Temperature sensitivity multiplier based on correlation
      // High correlation = temperature drives demand (use full temp coefficient)
      // Low correlation = other factors dominate (dampen temp coefficient)
      const tempSensitivityMultiplier = 0.3 + (Math.abs(avgTempCorr) * 0.7);

      this.regionCharacteristics.set(region, {
        avgDailySwing,
        tempSensitivityMultiplier,
        peakHourOffset: avgPeakHour - 15, // Offset from typical 3pm peak
        troughDepthRatio: avgTroughRatio
      });
    }
  }

  /**
   * Train the ML model to predict position within the statistical range
   */
  async train(samples: TrainingSample[]): Promise<{ r2Score: number; mape: number }> {
    // First build statistical profiles
    this.buildProfiles(samples);

    // Prepare training data for position prediction
    const X: number[][] = [];
    const Y: number[][] = [];

    for (const sample of samples) {
      const hour = sample.features.hour;
      const dayType = sample.features.isSunday ? 2 : sample.features.isSaturday ? 1 : 0;
      const region = this.inferRegion(sample);
      const key = `${region}_${hour}_${dayType}`;

      const profile = this.profiles.get(key);
      if (!profile || profile.max === profile.min) continue;

      // Calculate actual position (0 = min, 1 = max)
      const position = (sample.demand - profile.min) / (profile.max - profile.min);

      // Build feature vector (excluding demand-related lags to avoid circular dependency)
      const featureValues = this.extractPositionFeatures(sample.features, profile);
      X.push(featureValues);
      Y.push([position]);
    }

    if (X.length === 0) {
      throw new Error('No valid training samples after filtering');
    }

    // Train regression model to predict position
    this.model = new MultivariateLinearRegression(X, Y);

    // Calculate metrics
    let totalError = 0;
    let totalPercentError = 0;
    let ssRes = 0;
    let ssTot = 0;
    let validSamples = 0;
    const meanDemand = samples.reduce((sum, s) => sum + s.demand, 0) / samples.length;

    for (const sample of samples) {
      const region = sample.region;
      const predicted = this.predictForRegion(sample.features, region);
      if (predicted === undefined) continue;

      validSamples++;
      const error = Math.abs(predicted - sample.demand);
      totalError += error;
      totalPercentError += error / Math.max(sample.demand, 1) * 100;
      ssRes += Math.pow(predicted - sample.demand, 2);
      ssTot += Math.pow(sample.demand - meanDemand, 2);
    }

    const r2Score = 1 - (ssRes / ssTot);
    const mape = validSamples > 0 ? totalPercentError / validSamples : 0;

    return { r2Score, mape };
  }

  /**
   * Extract features for position prediction
   * Uses relative/normalized features rather than absolute demand values
   */
  private extractPositionFeatures(features: FeatureVector, profile: StatisticalBounds): number[] {
    const featureValues: number[] = [];

    // Temporal features (normalized)
    featureValues.push(features.hourSin);
    featureValues.push(features.hourCos);
    featureValues.push(features.isWeekend);
    featureValues.push(features.isHoliday);
    featureValues.push(features.isWorkday);
    featureValues.push(features.isSaturday);
    featureValues.push(features.isSunday);
    featureValues.push(features.dayOfMonth / 31); // Normalize
    featureValues.push(features.month / 12); // Normalize

    // Temperature features (relative to profile)
    const avgRecentTemp = profile.recentDays.length > 0
      ? profile.recentDays.reduce((sum, d) => sum + d.temp, 0) / profile.recentDays.length
      : features.temp;

    featureValues.push(features.temp); // Absolute temp
    featureValues.push(features.temp - avgRecentTemp); // Temp deviation from recent
    featureValues.push(features.tempSquared / 1000); // Normalized temp squared

    // Lag features as RATIOS to profile median (not absolute values)
    // This prevents the death spiral by normalizing
    if (profile.median > 0) {
      featureValues.push((features.demandLag1h ?? profile.median) / profile.median);
      featureValues.push((features.demandLag24h ?? profile.median) / profile.median);
      featureValues.push((features.demandLag168h ?? profile.median) / profile.median);
      featureValues.push((features.demandRolling24h ?? profile.median) / profile.median);
    } else {
      featureValues.push(1, 1, 1, 1);
    }

    // Temperature lag ratios
    const avgTemp = avgRecentTemp || 25;
    featureValues.push((features.tempLag1h ?? avgTemp) / avgTemp);
    featureValues.push((features.tempLag24h ?? avgTemp) / avgTemp);
    featureValues.push((features.tempRolling24h ?? avgTemp) / avgTemp);

    return featureValues;
  }

  /**
   * Predict demand using hybrid interpolation
   */
  predict(features: FeatureVector, region?: string): number | undefined {
    if (!this.model) return undefined;

    const hour = features.hour;
    const dayType = features.isSunday ? 2 : features.isSaturday ? 1 : 0;
    const inferredRegion = region || 'UNKNOWN';
    const key = `${inferredRegion}_${hour}_${dayType}`;

    const profile = this.profiles.get(key);
    if (!profile) {
      // Fallback: try to find any profile for this hour/dayType
      for (const [k, p] of this.profiles) {
        if (k.endsWith(`_${hour}_${dayType}`)) {
          return this.interpolate(features, p);
        }
      }
      return undefined;
    }

    return this.interpolate(features, profile);
  }

  /**
   * Predict with explicit region
   */
  predictForRegion(features: FeatureVector, region: string, daysAhead: number = 0): number | undefined {
    if (!this.model) return undefined;

    const hour = features.hour;
    const dayType = features.isSunday ? 2 : features.isSaturday ? 1 : 0;
    const key = `${region}_${hour}_${dayType}`;

    let profile = this.profiles.get(key);
    if (!profile) return undefined;

    // Apply growth factor if set
    if (this.growthFactor > 0 && daysAhead > 0) {
      const growthMultiplier = 1 + (this.growthFactor * daysAhead);
      profile = {
        ...profile,
        min: profile.min * growthMultiplier,
        median: profile.median * growthMultiplier,
        max: profile.max * growthMultiplier
      };
    }

    let prediction = this.interpolate(features, profile);

    // Apply weekend correction factor to fix systematic over-forecasting
    // This correction is based on observed forecast vs actual bias
    if (prediction !== undefined) {
      const correction = this.weekendCorrectionFactors.get(region);
      if (correction) {
        if (features.isSaturday === 1) {
          prediction *= correction.saturday;
        } else if (features.isSunday === 1) {
          prediction *= correction.sunday;
        }
      }
    }

    return prediction;
  }

  /**
   * Interpolate using profile bounds with region-specific learned characteristics
   * Uses data-driven temperature sensitivity instead of hardcoded values
   */
  private interpolate(features: FeatureVector, profile: StatisticalBounds): number {
    // Get region-specific characteristics (learned from data)
    const regionChars = this.regionCharacteristics.get(profile.region);

    // Start with the median demand for this hour/daytype
    let prediction = profile.median;

    // Get time-period base sensitivity (varies by time of day)
    const timePeriodSensitivity = this.getTimePeriodSensitivity(profile.timePeriod);

    // Apply region-specific temperature sensitivity multiplier
    // This is LEARNED from data, not hardcoded
    const regionTempMultiplier = regionChars?.tempSensitivityMultiplier ?? 1.0;
    const effectiveTempSensitivity = timePeriodSensitivity * regionTempMultiplier;

    // Apply temperature adjustment
    const tempDeviation = features.temp - profile.baseTemp;
    const tempAdjustment = profile.tempCoefficient * tempDeviation * effectiveTempSensitivity;
    prediction += tempAdjustment;

    // For regions with high daily swing, use bounds more aggressively
    // For regions with low daily swing, stay closer to median
    if (regionChars && profile.swingAmplitude > 0) {
      // Calculate where we are relative to median based on temp
      const normalizedTempDev = tempDeviation / 10; // Normalize to ~±1 range

      // Scale the position within bounds by how much this region typically swings
      // Regions with high swing should use more of their min/max range
      const swingFactor = Math.min(1.5, regionChars.avgDailySwing / profile.swingAmplitude);

      if (normalizedTempDev > 0) {
        // Hot temperature - interpolate toward max
        const distToMax = profile.max - profile.median;
        prediction = profile.median + (distToMax * normalizedTempDev * swingFactor * 0.5);
      } else {
        // Cool temperature - interpolate toward min
        const distToMin = profile.median - profile.min;
        prediction = profile.median + (distToMin * normalizedTempDev * swingFactor * 0.5);
      }
    }

    // Use lag-based adjustment for recent trend (smaller effect)
    if (features.demandLag24h !== undefined && profile.median > 0) {
      const lag24hRatio = features.demandLag24h / profile.median;
      // Apply a small adjustment based on recent trend (±5% max)
      const trendAdjustment = Math.max(-0.05, Math.min(0.05, lag24hRatio - 1));
      prediction *= (1 + trendAdjustment * 0.3); // Dampen the effect
    }

    // Clamp to min/max bounds to preserve the hourly shape
    prediction = Math.max(profile.min, Math.min(profile.max, prediction));

    // Ensure non-negative predictions
    return Math.max(0, prediction);
  }

  /**
   * Get base time-period sensitivity (before region adjustment)
   * This provides the baseline shape - regions then modify this
   */
  private getTimePeriodSensitivity(timePeriod: TimePeriod): number {
    switch (timePeriod) {
      case TimePeriod.NIGHT: return 0.4;        // Low temp sensitivity at night
      case TimePeriod.MORNING_RAMP: return 0.6; // Moderate during morning ramp
      case TimePeriod.MIDDAY: return 1.0;       // Full temp sensitivity (cooling load)
      case TimePeriod.EVENING_PEAK: return 0.5; // Lower - residential patterns dominate
      case TimePeriod.LATE_NIGHT: return 0.4;   // Low temp sensitivity
      default: return 0.6;
    }
  }

  /**
   * Get dynamic bounds for a specific hour/daytype from recent similar days
   */
  getDynamicBounds(
    region: string,
    hour: number,
    dayType: number,
    currentTemp: number,
    tempTolerance: number = 5
  ): { min: number; median: number; max: number } | undefined {
    const key = `${region}_${hour}_${dayType}`;
    const profile = this.profiles.get(key);
    if (!profile) return undefined;

    // Filter recent days by temperature similarity
    const tempFilteredDays = profile.recentDays.filter(
      d => Math.abs(d.temp - currentTemp) <= tempTolerance
    );

    if (tempFilteredDays.length >= 3) {
      // Use temperature-filtered bounds
      const demands = tempFilteredDays.map(d => d.demand).sort((a, b) => a - b);
      return {
        min: demands[0],
        median: demands[Math.floor(demands.length / 2)],
        max: demands[demands.length - 1]
      };
    }

    // Fall back to all recent days
    if (profile.recentDays.length >= 3) {
      const demands = profile.recentDays.map(d => d.demand).sort((a, b) => a - b);
      return {
        min: demands[0],
        median: demands[Math.floor(demands.length / 2)],
        max: demands[demands.length - 1]
      };
    }

    // Fall back to full profile
    return {
      min: profile.min,
      median: profile.median,
      max: profile.max
    };
  }

  /**
   * Infer region from features (placeholder - actual implementation needs region in features)
   */
  private inferRegion(sample: TrainingSample): string {
    // For now, we'll need to pass region explicitly or add it to features
    // This is a limitation we'll address in integration
    return (sample as any).region || 'UNKNOWN';
  }

  /**
   * Get profile statistics for debugging
   */
  getProfileStats(): Map<string, { min: number; median: number; max: number; count: number }> {
    const stats = new Map<string, { min: number; median: number; max: number; count: number }>();
    for (const [key, profile] of this.profiles) {
      stats.set(key, {
        min: profile.min,
        median: profile.median,
        max: profile.max,
        count: profile.count
      });
    }
    return stats;
  }

  isReady(): boolean {
    return this.model !== null && this.profiles.size > 0;
  }

  setGrowthFactor(factor: number): void {
    this.growthFactor = factor;
  }

  /**
   * Set the XGBoost calibrator for post-hybrid correction
   */
  setCalibrator(calibrator: DemandCalibrator): void {
    this.calibrator = calibrator;
  }

  /**
   * Get the XGBoost calibrator
   */
  getCalibrator(): DemandCalibrator | null {
    return this.calibrator;
  }

  /**
   * Check if calibrator is available
   */
  hasCalibrator(): boolean {
    return this.calibrator !== null && this.calibrator.isReady();
  }

  /**
   * Apply calibration to a hybrid prediction
   * Returns the calibrated prediction, or the original if calibrator is not ready
   */
  applyCalibration(
    hybridPrediction: number,
    sample: TrainingSample
  ): number {
    if (!this.calibrator || !this.calibrator.isReady()) {
      return hybridPrediction;
    }
    return this.calibrator.calibrate(hybridPrediction, sample);
  }

}
