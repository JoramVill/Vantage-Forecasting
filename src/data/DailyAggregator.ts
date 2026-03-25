import { DateTime } from 'luxon';
import { MergedHourlyRecord, WeatherRow } from './DataMerger.js';
import { isPhilippineHoliday } from '../constants/index.js';

/**
 * Daily weather summary for Level Model
 */
export interface DailyWeather {
  avgTemp: number;
  maxTemp: number;
  minTemp: number;
  tempRange: number;
  CDH: number;              // Cooling degree-hours (base 24°C)
  totalPrecip: number;
  avgCloudCover: number;
  totalSolar: number;
  avgHeatIndex: number;
}

/**
 * Hourly weather trajectory for Shape Model
 */
export interface HourlyWeather {
  hour: number;
  temp: number;
  cloudcover: number;
  solarradiation: number;
}

/**
 * Weather trajectory features derived from hourly data
 */
export interface WeatherTrajectory {
  peakTempHour: number;       // Hour of maximum temperature
  morningRampRate: number;    // °C/hour from 6 AM to noon
  eveningCoolRate: number;    // °C/hour from 3 PM to 9 PM
}

/**
 * Calendar features for both models
 */
export interface CalendarFeatures {
  dayOfWeek: number;          // 0-6 (Sunday=0)
  isWeekend: boolean;
  isSaturday: boolean;
  isSunday: boolean;
  isHoliday: boolean;
  isWorkday: boolean;
  month: number;              // 1-12
  dayType: 'workday' | 'saturday' | 'sunday' | 'holiday';
}

/**
 * Daily aggregated record for training
 */
export interface DailyRecord {
  date: string;               // YYYY-MM-DD
  area: string;
  dailyTotal: number;         // Sum of 24 hours (MW)
  shape: number[];            // 24 values normalized to sum to 1.0
  hourlyDemand: number[];     // 24 raw MW values
  dailyWeather: DailyWeather;
  hourlyWeather: HourlyWeather[];
  weatherTrajectory: WeatherTrajectory;
  calendar: CalendarFeatures;
}

/**
 * DailyAggregator - Transforms hourly merged data into daily training records
 *
 * Responsibilities:
 * 1. Aggregate hourly demand into daily totals
 * 2. Compute normalized shapes (each hour / total, sum to 1.0)
 * 3. Compute daily weather summaries for Level Model
 * 4. Compute hourly weather trajectories for Shape Model
 * 5. Add calendar features (day type, holidays, etc.)
 */
export class DailyAggregator {
  private baseTemp: number;

  /**
   * @param baseTemp Base temperature for cooling degree-hours calculation (default 24°C)
   */
  constructor(baseTemp: number = 24) {
    this.baseTemp = baseTemp;
  }

  /**
   * Aggregate hourly records into daily records
   * @param hourlyRecords Array of merged hourly records
   * @returns Array of daily records
   */
  aggregate(hourlyRecords: MergedHourlyRecord[]): DailyRecord[] {
    // Group by area and date
    const grouped = new Map<string, Map<string, MergedHourlyRecord[]>>();

    for (const record of hourlyRecords) {
      const area = record.area;
      const dt = DateTime.fromJSDate(record.datetime);
      const dateKey = dt.toFormat('yyyy-MM-dd');

      if (!grouped.has(area)) {
        grouped.set(area, new Map());
      }
      if (!grouped.get(area)!.has(dateKey)) {
        grouped.get(area)!.set(dateKey, []);
      }
      grouped.get(area)!.get(dateKey)!.push(record);
    }

    const dailyRecords: DailyRecord[] = [];

    // Process each area-date combination
    for (const [area, dateMap] of grouped) {
      for (const [dateKey, records] of dateMap) {
        // Only process if we have complete 24-hour data
        if (records.length !== 24) {
          console.warn(`Incomplete day data for ${area} on ${dateKey}: ${records.length} hours, skipping`);
          continue;
        }

        // Sort by hour
        records.sort((a, b) => a.datetime.getTime() - b.datetime.getTime());

        const dailyRecord = this.createDailyRecord(area, dateKey, records);
        if (dailyRecord) {
          dailyRecords.push(dailyRecord);
        }
      }
    }

    console.log(`Created ${dailyRecords.length} daily records`);

    // Validate all shapes sum to 1.0
    this.validateShapes(dailyRecords);

    return dailyRecords;
  }

  /**
   * Create a single daily record from 24 hourly records
   */
  private createDailyRecord(
    area: string,
    dateKey: string,
    hourlyRecords: MergedHourlyRecord[]
  ): DailyRecord | null {
    // Extract hourly demand values
    const hourlyDemand = hourlyRecords.map(r => r.demandMW);

    // Calculate daily total
    const dailyTotal = hourlyDemand.reduce((sum, val) => sum + val, 0);

    if (dailyTotal === 0) {
      console.warn(`Zero daily total for ${area} on ${dateKey}, skipping`);
      return null;
    }

    // Calculate normalized shape (must sum to 1.0)
    const shape = hourlyDemand.map(mw => mw / dailyTotal);

    // Verify shape sums to 1.0
    const shapeSum = shape.reduce((sum, val) => sum + val, 0);
    if (Math.abs(shapeSum - 1.0) > 0.001) {
      console.warn(`Shape sum ${shapeSum} != 1.0 for ${area} on ${dateKey}`);
    }

    // Compute daily weather summary
    const dailyWeather = this.computeDailyWeather(hourlyRecords);

    // Compute hourly weather trajectory
    const hourlyWeather = this.computeHourlyWeather(hourlyRecords);

    // Compute weather trajectory features
    const weatherTrajectory = this.computeWeatherTrajectory(hourlyWeather);

    // Compute calendar features
    const calendar = this.computeCalendarFeatures(dateKey);

    return {
      date: dateKey,
      area,
      dailyTotal,
      shape,
      hourlyDemand,
      dailyWeather,
      hourlyWeather,
      weatherTrajectory,
      calendar
    };
  }

  /**
   * Compute daily weather summary
   */
  private computeDailyWeather(hourlyRecords: MergedHourlyRecord[]): DailyWeather {
    const temps = hourlyRecords.map(r => r.weather.temp);
    const avgTemp = temps.reduce((sum, t) => sum + t, 0) / temps.length;
    const maxTemp = Math.max(...temps);
    const minTemp = Math.min(...temps);
    const tempRange = maxTemp - minTemp;

    // Cooling degree-hours (CDH)
    const CDH = temps.reduce((sum, t) => sum + Math.max(0, t - this.baseTemp), 0);

    // Total precipitation
    const totalPrecip = hourlyRecords.reduce((sum, r) => sum + r.weather.precip, 0);

    // Average cloud cover
    const avgCloudCover = hourlyRecords.reduce((sum, r) => sum + r.weather.cloudcover, 0) / hourlyRecords.length;

    // Total solar radiation
    const totalSolar = hourlyRecords.reduce((sum, r) => sum + r.weather.solarradiation, 0);

    // Average heat index (simplified - use actual calculation in production)
    const avgHeatIndex = this.calculateHeatIndex(avgTemp, hourlyRecords);

    return {
      avgTemp,
      maxTemp,
      minTemp,
      tempRange,
      CDH,
      totalPrecip,
      avgCloudCover,
      totalSolar,
      avgHeatIndex
    };
  }

  /**
   * Calculate average heat index using Rothfusz regression
   */
  private calculateHeatIndex(avgTemp: number, hourlyRecords: MergedHourlyRecord[]): number {
    const heatIndices: number[] = [];

    for (const record of hourlyRecords) {
      const T = record.weather.temp;
      const D = record.weather.dew;

      // Calculate relative humidity using Magnus formula
      const RH = 100 * Math.exp((17.27 * D) / (237.7 + D)) / Math.exp((17.27 * T) / (237.7 + T));

      // Rothfusz heat index formula (for T > 26.7°C and RH > 40%)
      if (T > 26.7 && RH > 40) {
        const HI = -8.785 + 1.611 * T + 2.339 * RH - 0.146 * T * RH
          - 0.013 * T * T - 0.016 * RH * RH
          + 0.002 * T * T * RH + 0.001 * T * RH * RH
          - 0.000004 * T * T * RH * RH;
        heatIndices.push(HI);
      } else {
        heatIndices.push(T);
      }
    }

    return heatIndices.reduce((sum, hi) => sum + hi, 0) / heatIndices.length;
  }

  /**
   * Compute hourly weather trajectory
   */
  private computeHourlyWeather(hourlyRecords: MergedHourlyRecord[]): HourlyWeather[] {
    return hourlyRecords.map((record, idx) => ({
      hour: idx,
      temp: record.weather.temp,
      cloudcover: record.weather.cloudcover,
      solarradiation: record.weather.solarradiation
    }));
  }

  /**
   * Compute weather trajectory features
   */
  private computeWeatherTrajectory(hourlyWeather: HourlyWeather[]): WeatherTrajectory {
    // Find peak temperature hour
    let peakTempHour = 0;
    let maxTemp = -Infinity;
    for (let i = 0; i < hourlyWeather.length; i++) {
      if (hourlyWeather[i].temp > maxTemp) {
        maxTemp = hourlyWeather[i].temp;
        peakTempHour = i;
      }
    }

    // Morning ramp rate (6 AM to noon)
    let morningRampRate = 0;
    if (hourlyWeather.length >= 12) {
      const temp6am = hourlyWeather[6].temp;
      const temp12pm = hourlyWeather[12].temp;
      morningRampRate = (temp12pm - temp6am) / 6; // °C per hour
    }

    // Evening cool rate (3 PM to 9 PM)
    let eveningCoolRate = 0;
    if (hourlyWeather.length >= 21) {
      const temp3pm = hourlyWeather[15].temp;
      const temp9pm = hourlyWeather[21].temp;
      eveningCoolRate = (temp9pm - temp3pm) / 6; // °C per hour
    }

    return {
      peakTempHour,
      morningRampRate,
      eveningCoolRate
    };
  }

  /**
   * Compute calendar features
   */
  private computeCalendarFeatures(dateKey: string): CalendarFeatures {
    const dt = DateTime.fromFormat(dateKey, 'yyyy-MM-dd');
    const dayOfWeek = dt.weekday === 7 ? 0 : dt.weekday; // Luxon: 1=Mon, 7=Sun -> 0=Sun, 1=Mon
    const isSaturday = dayOfWeek === 6;
    const isSunday = dayOfWeek === 0;
    const isWeekend = isSaturday || isSunday;
    const isHoliday = isPhilippineHoliday(dateKey);
    const isWorkday = !isWeekend && !isHoliday;
    const month = dt.month;

    let dayType: 'workday' | 'saturday' | 'sunday' | 'holiday';
    if (isHoliday) {
      dayType = 'holiday';
    } else if (isSunday) {
      dayType = 'sunday';
    } else if (isSaturday) {
      dayType = 'saturday';
    } else {
      dayType = 'workday';
    }

    return {
      dayOfWeek,
      isWeekend,
      isSaturday,
      isSunday,
      isHoliday,
      isWorkday,
      month,
      dayType
    };
  }

  /**
   * Validate that all shapes sum to 1.0
   */
  private validateShapes(dailyRecords: DailyRecord[]): void {
    let invalidCount = 0;
    for (const record of dailyRecords) {
      const sum = record.shape.reduce((s, v) => s + v, 0);
      if (Math.abs(sum - 1.0) > 0.001) {
        console.warn(`Invalid shape sum ${sum} for ${record.area} on ${record.date}`);
        invalidCount++;
      }
    }

    if (invalidCount > 0) {
      console.warn(`Found ${invalidCount} records with invalid shape sums`);
    } else {
      console.log('All shapes validated: sum = 1.0 ✓');
    }
  }
}
