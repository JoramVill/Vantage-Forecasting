import { DateTime } from 'luxon';
import { parseDemandCsv, DemandRecord } from '../parsers/demandParser.js';
import { parseWeatherCsv, ParsedWeatherData } from '../parsers/weatherParser.js';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

/**
 * Weather data for a specific hour
 */
export interface WeatherRow {
  temp: number;
  dew: number;
  precip: number;
  windgust: number;
  windspeed: number;
  cloudcover: number;
  solarradiation: number;
  solarenergy: number;
  uvindex: number;
}

/**
 * Area-to-station mapping configuration
 * Maps area codes to weather station names
 */
export interface AreaMapping {
  [areaCode: string]: string[];
}

/**
 * Merged hourly record combining demand and weather for a specific area
 */
export interface MergedHourlyRecord {
  datetime: Date;
  area: string;
  demandMW: number;
  weather: WeatherRow;
}

/**
 * Complete merged dataset
 */
export interface MergedDataset {
  records: MergedHourlyRecord[];
  areas: string[];
  startDate: Date;
  endDate: Date;
}

/**
 * DataMerger - Joins demand and weather data into a unified dataset per area
 *
 * Responsibilities:
 * 1. Parse demand CSVs (hour-ending format: M/D/YYYY HH:mm)
 * 2. Parse weather CSVs (hour-starting format: ISO 8601)
 * 3. Align timestamps (shift weather +1 hour to match hour-ending convention)
 * 4. Average weather across multiple stations per area
 * 5. Inner join on datetime (only keep hours with both demand and weather)
 */
export class DataMerger {
  private areaMapping: AreaMapping;

  /**
   * @param areaMapping Maps area codes to weather station names
   *   Example: { "01NLUZ": ["San Fernando, Pampanga", "Baguio", ...], ... }
   */
  constructor(areaMapping: AreaMapping) {
    this.areaMapping = areaMapping;
  }

  /**
   * Load area-to-station mapping from zones.json file
   * @param zonesPath Path to zones.json file
   * @returns AreaMapping object
   */
  static loadAreaMapping(zonesPath: string): AreaMapping {
    const content = readFileSync(zonesPath, 'utf-8');
    const config = JSON.parse(content);

    const mapping: AreaMapping = {};

    // Handle both regional and zonal configurations
    if (config.regions) {
      // Regional mode (3 regions)
      for (const region of config.regions) {
        // For regional mode, use a simple mapping
        // This will need to be enhanced based on actual regional weather station mappings
        mapping[region.code] = [region.name];
      }
    }

    if (config.zones) {
      // Zonal mode (14 zones)
      for (const zone of config.zones) {
        mapping[zone.code] = zone.cities.map((city: any) => city.name);
      }
    }

    return mapping;
  }

  /**
   * Merge demand and weather data for a specific time period
   * @param demandPath Path to demand data directory or file
   * @param weatherPath Path to weather data directory
   * @returns Merged dataset with aligned timestamps
   */
  merge(demandPath: string, weatherPath: string): MergedDataset {
    console.log('Parsing demand data...');
    const demandData = parseDemandCsv(demandPath);

    console.log('Parsing weather data...');
    const weatherData = this.loadWeatherData(weatherPath);

    console.log('Merging datasets...');
    return this.mergeData(demandData.records, weatherData, demandData.regions);
  }

  /**
   * Load all weather CSV files from a directory
   * @param weatherPath Path to weather data directory
   * @returns Map of station name to weather records
   */
  private loadWeatherData(weatherPath: string): Map<string, Map<string, WeatherRow>> {
    const weatherMap = new Map<string, Map<string, WeatherRow>>();

    const stat = statSync(weatherPath);
    const files: string[] = [];

    if (stat.isDirectory()) {
      // Recursively find all CSV files
      const findCsvFiles = (dir: string) => {
        const entries = readdirSync(dir);
        for (const entry of entries) {
          const fullPath = join(dir, entry);
          const entryStat = statSync(fullPath);
          if (entryStat.isDirectory()) {
            findCsvFiles(fullPath);
          } else if (entry.toLowerCase().endsWith('.csv')) {
            files.push(fullPath);
          }
        }
      };
      findCsvFiles(weatherPath);
    } else {
      files.push(weatherPath);
    }

    console.log(`Found ${files.length} weather files`);

    for (const file of files) {
      try {
        const parsed = parseWeatherCsv(file);
        const stationMap = new Map<string, WeatherRow>();

        for (const record of parsed.records) {
          // Shift weather timestamp +1 hour to align with hour-ending demand
          const dt = DateTime.fromISO(record.datetime).plus({ hours: 1 });
          const key = dt.toFormat('yyyy-MM-dd HH:mm');

          stationMap.set(key, {
            temp: record.temp,
            dew: record.dew,
            precip: record.precip,
            windgust: record.windgust,
            windspeed: record.windspeed,
            cloudcover: record.cloudcover,
            solarradiation: record.solarradiation,
            solarenergy: record.solarenergy,
            uvindex: record.uvindex
          });
        }

        weatherMap.set(parsed.city, stationMap);
      } catch (error) {
        console.warn(`Failed to parse weather file ${file}:`, error);
      }
    }

    return weatherMap;
  }

  /**
   * Merge demand records with weather data
   * @param demandRecords Array of demand records
   * @param weatherData Map of station name to weather records
   * @param areas List of area codes from demand data
   * @returns Merged dataset
   */
  private mergeData(
    demandRecords: DemandRecord[],
    weatherData: Map<string, Map<string, WeatherRow>>,
    areas: string[]
  ): MergedDataset {
    const merged: MergedHourlyRecord[] = [];
    let minDate: Date | null = null;
    let maxDate: Date | null = null;

    // Group demand records by area and datetime
    const demandByAreaTime = new Map<string, Map<string, number>>();
    for (const record of demandRecords) {
      const area = record.region;
      const timeKey = DateTime.fromJSDate(record.datetime).toFormat('yyyy-MM-dd HH:mm');

      if (!demandByAreaTime.has(area)) {
        demandByAreaTime.set(area, new Map());
      }
      demandByAreaTime.get(area)!.set(timeKey, record.demand);
    }

    // For each area, merge with averaged weather
    for (const area of areas) {
      const demandMap = demandByAreaTime.get(area);
      if (!demandMap) continue;

      const stations = this.areaMapping[area];
      if (!stations || stations.length === 0) {
        console.warn(`No weather stations mapped for area ${area}, skipping`);
        continue;
      }

      // Get all available datetimes for this area
      for (const [timeKey, demand] of demandMap) {
        // Average weather across all stations for this area
        const avgWeather = this.averageWeather(stations, timeKey, weatherData);

        if (avgWeather) {
          const dt = DateTime.fromFormat(timeKey, 'yyyy-MM-dd HH:mm');
          const datetime = dt.toJSDate();

          merged.push({
            datetime,
            area,
            demandMW: demand,
            weather: avgWeather
          });

          if (!minDate || datetime < minDate) minDate = datetime;
          if (!maxDate || datetime > maxDate) maxDate = datetime;
        }
      }
    }

    console.log(`Merged ${merged.length} hourly records across ${areas.length} areas`);
    console.log(`Date range: ${minDate?.toISOString()} to ${maxDate?.toISOString()}`);

    return {
      records: merged,
      areas,
      startDate: minDate!,
      endDate: maxDate!
    };
  }

  /**
   * Average weather data across multiple stations for a specific timestamp
   * @param stations List of station names
   * @param timeKey Timestamp key in format 'yyyy-MM-dd HH:mm'
   * @param weatherData Map of station name to weather records
   * @returns Averaged weather or null if no data available
   */
  private averageWeather(
    stations: string[],
    timeKey: string,
    weatherData: Map<string, Map<string, WeatherRow>>
  ): WeatherRow | null {
    const weatherRecords: WeatherRow[] = [];

    for (const station of stations) {
      const stationData = weatherData.get(station);
      if (stationData) {
        const weather = stationData.get(timeKey);
        if (weather) {
          weatherRecords.push(weather);
        }
      }
    }

    if (weatherRecords.length === 0) {
      return null;
    }

    // Calculate average across all stations
    const avg: WeatherRow = {
      temp: 0,
      dew: 0,
      precip: 0,
      windgust: 0,
      windspeed: 0,
      cloudcover: 0,
      solarradiation: 0,
      solarenergy: 0,
      uvindex: 0
    };

    for (const record of weatherRecords) {
      avg.temp += record.temp;
      avg.dew += record.dew;
      avg.precip += record.precip;
      avg.windgust += record.windgust;
      avg.windspeed += record.windspeed;
      avg.cloudcover += record.cloudcover;
      avg.solarradiation += record.solarradiation;
      avg.solarenergy += record.solarenergy;
      avg.uvindex += record.uvindex;
    }

    const count = weatherRecords.length;
    avg.temp /= count;
    avg.dew /= count;
    avg.precip /= count;
    avg.windgust /= count;
    avg.windspeed /= count;
    avg.cloudcover /= count;
    avg.solarradiation /= count;
    avg.solarenergy /= count;
    avg.uvindex /= count;

    return avg;
  }
}
