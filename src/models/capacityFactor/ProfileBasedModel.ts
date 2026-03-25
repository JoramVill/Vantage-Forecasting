import { CFacTrainingSample, CFacProfileStats } from '../../types/capacityFactor.js';

/**
 * Base class for profile-based capacity factor models
 * Used for stations with stable patterns (geothermal, biomass, battery, hydro)
 */
export class ProfileBasedModel {
  protected profiles: Map<string, CFacProfileStats> = new Map();
  protected stationCode: string;

  constructor(stationCode: string) {
    this.stationCode = stationCode;
  }

  /**
   * Build profiles from historical data
   * Groups by hour and dayType (weekday=0, saturday=1, sunday=2)
   */
  buildProfiles(samples: CFacTrainingSample[]): void {
    // Group samples by profile key
    const grouped = new Map<string, number[]>();

    for (const sample of samples) {
      const dayType = sample.isWeekend
        ? sample.dayOfWeek === 0
          ? 2 // Sunday
          : 1 // Saturday
        : 0; // Weekday

      const key = this.getProfileKey(sample.hour, dayType, sample.month);

      if (!grouped.has(key)) {
        grouped.set(key, []);
      }

      grouped.get(key)!.push(sample.actualCFac);
    }

    // Calculate statistics for each profile
    for (const [key, values] of grouped) {
      if (values.length === 0) continue;

      const stats = this.calculateStats(values);
      this.profiles.set(key, stats);
    }
  }

  /**
   * Get profile key: "hour_dayType" or "hour_dayType_month" for seasonal
   */
  protected getProfileKey(hour: number, dayType: number, month?: number): string {
    return `${hour}_${dayType}`;
  }

  /**
   * Calculate statistics from an array of values
   */
  protected calculateStats(values: number[]): CFacProfileStats {
    if (values.length === 0) {
      return {
        min: 0,
        median: 0,
        max: 0,
        mean: 0,
        stdDev: 0,
        count: 0,
      };
    }

    // Sort values for percentile calculations
    const sorted = [...values].sort((a, b) => a - b);
    const count = sorted.length;

    // Calculate percentiles (P5, P50, P95)
    const p5Index = Math.max(0, Math.floor(count * 0.05));
    const p50Index = Math.floor(count * 0.5);
    const p95Index = Math.min(count - 1, Math.floor(count * 0.95));

    const min = sorted[p5Index];
    const median = sorted[p50Index];
    const max = sorted[p95Index];

    // Calculate mean
    const mean = values.reduce((sum, v) => sum + v, 0) / count;

    // Calculate standard deviation
    const variance = values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / count;
    const stdDev = Math.sqrt(variance);

    return {
      min,
      median,
      max,
      mean,
      stdDev,
      count,
    };
  }

  /**
   * Predict capacity factor using median from profile
   */
  predict(datetime: Date): number {
    const hour = datetime.getHours();
    const dayOfWeek = datetime.getDay();
    const month = datetime.getMonth() + 1; // 1-based

    const dayType = dayOfWeek === 0 ? 2 : dayOfWeek === 6 ? 1 : 0;

    const key = this.getProfileKey(hour, dayType, month);
    const profile = this.profiles.get(key);

    if (!profile) {
      // Fallback: try to find profile for this hour with any dayType
      for (const [k, p] of this.profiles) {
        if (k.startsWith(`${hour}_`)) {
          return p.median;
        }
      }
      // If still not found, return 0
      return 0;
    }

    return profile.median;
  }

  /**
   * Get prediction with bounds
   */
  predictWithBounds(datetime: Date): { prediction: number; lower: number; upper: number } {
    const hour = datetime.getHours();
    const dayOfWeek = datetime.getDay();
    const month = datetime.getMonth() + 1; // 1-based

    const dayType = dayOfWeek === 0 ? 2 : dayOfWeek === 6 ? 1 : 0;

    const key = this.getProfileKey(hour, dayType, month);
    const profile = this.profiles.get(key);

    if (!profile) {
      // Fallback: try to find profile for this hour with any dayType
      for (const [k, p] of this.profiles) {
        if (k.startsWith(`${hour}_`)) {
          return {
            prediction: p.median,
            lower: p.min,
            upper: p.max,
          };
        }
      }
      // If still not found, return 0
      return { prediction: 0, lower: 0, upper: 0 };
    }

    return {
      prediction: profile.median,
      lower: profile.min,
      upper: profile.max,
    };
  }

  /**
   * Check if model is ready for predictions
   */
  isReady(): boolean {
    return this.profiles.size > 0;
  }
}

// Type alias for consistency with other capacity factor models
export type ProfileModel = ProfileBasedModel;
export default ProfileBasedModel;
