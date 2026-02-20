import { DateTime } from 'luxon';
import { DemandRecord, ParsedDemandData } from '../parsers/demandParser.js';
import { ParsedWeatherData } from '../parsers/weatherParser.js';
import { RawWeatherData, ZonalMergedRecord } from '../types/index.js';
import { REGION_MAPPINGS, getZonalRegionMappings } from '../constants/index.js';

export interface MergedRecord {
  datetime: Date;
  region: string;
  demand: number;
  weather: RawWeatherData;
}

export interface MergedDataset {
  records: MergedRecord[];
  regions: string[];
  startDate: Date;
  endDate: Date;
  matchedCount: number;
  unmatchedDemand: number;
  unmatchedWeather: number;
}

// Get the region code from a city name
function getRegionFromCity(city: string): string | null {
  for (const [key, mapping] of Object.entries(REGION_MAPPINGS)) {
    if (city.toLowerCase().includes(key) || mapping.city.toLowerCase() === city.toLowerCase()) {
      return mapping.demandColumn;
    }
  }
  return null;
}

// Weather datetime (hour starting) to demand datetime (hour ending)
// Weather 00:00 -> Demand 01:00
function weatherToDemandTime(weatherDatetime: string): Date {
  const dt = DateTime.fromISO(weatherDatetime);
  return dt.plus({ hours: 1 }).toJSDate();
}

export function mergeData(
  demandData: ParsedDemandData,
  weatherDatasets: ParsedWeatherData[]
): MergedDataset {
  const mergedRecords: MergedRecord[] = [];

  // Build a map of demand records by region and datetime
  const demandMap = new Map<string, DemandRecord>();
  for (const record of demandData.records) {
    const key = `${record.region}_${record.datetime.toISOString()}`;
    demandMap.set(key, record);
  }

  // Build a map of weather records by region and datetime (converted to demand time)
  const weatherMap = new Map<string, RawWeatherData>();
  for (const weatherData of weatherDatasets) {
    const region = getRegionFromCity(weatherData.city);
    if (!region) {
      console.warn(`Unknown city: ${weatherData.city}`);
      continue;
    }

    for (const record of weatherData.records) {
      const demandTime = weatherToDemandTime(record.datetime);
      const key = `${region}_${demandTime.toISOString()}`;
      weatherMap.set(key, record);
    }
  }

  // Merge by finding matching demand and weather
  let matchedCount = 0;
  const matchedDemandKeys = new Set<string>();
  const matchedWeatherKeys = new Set<string>();

  for (const [demandKey, demandRecord] of demandMap) {
    const weatherRecord = weatherMap.get(demandKey);
    if (weatherRecord) {
      mergedRecords.push({
        datetime: demandRecord.datetime,
        region: demandRecord.region,
        demand: demandRecord.demand,
        weather: weatherRecord
      });
      matchedCount++;
      matchedDemandKeys.add(demandKey);
      matchedWeatherKeys.add(demandKey);
    }
  }

  // Sort by datetime and region
  mergedRecords.sort((a, b) => {
    const dateCompare = a.datetime.getTime() - b.datetime.getTime();
    if (dateCompare !== 0) return dateCompare;
    return a.region.localeCompare(b.region);
  });

  const regions = [...new Set(mergedRecords.map(r => r.region))];

  return {
    records: mergedRecords,
    regions,
    startDate: mergedRecords.length > 0 ? mergedRecords[0].datetime : new Date(),
    endDate: mergedRecords.length > 0 ? mergedRecords[mergedRecords.length - 1].datetime : new Date(),
    matchedCount,
    unmatchedDemand: demandMap.size - matchedDemandKeys.size,
    unmatchedWeather: weatherMap.size - matchedWeatherKeys.size
  };
}

/**
 * Merge zonal demand data with weather from cities per zone.
 * Uses the first 3 cities (cityIndex 0, 1, 2) for each zone as city1/2/3.
 * Zones with more than 3 cities will have additional cities' weather stored
 * in the database but only the first 3 are used in the merged record.
 *
 * @param demandRecords - Parsed demand records (zone codes as region)
 * @param weatherDataSets - Array of { city: string, locationId: string, zoneCode: string, cityIndex: number, records: RawWeatherData[] }
 * @returns ZonalMergedRecord[] - Merged records with first 3 cities' weather per zone
 */
export function mergeZonalData(
  demandRecords: { datetime: Date; region: string; demand: number }[],
  weatherDataSets: {
    city: string;
    locationId: string;
    zoneCode: string;
    cityIndex: number; // Index of city within zone (0, 1, 2 used for city1/2/3)
    records: RawWeatherData[];
  }[]
): ZonalMergedRecord[] {
  const results: ZonalMergedRecord[] = [];

  // Build demand lookup: zone_datetime -> demand
  const demandMap = new Map<string, number>();
  for (const rec of demandRecords) {
    const dt = rec.datetime instanceof Date ? rec.datetime : new Date(rec.datetime);
    const key = `${rec.region}_${dt.getTime()}`;
    demandMap.set(key, rec.demand);
  }

  // Build weather lookup: zone_cityIndex_datetime -> RawWeatherData
  const weatherMap = new Map<string, RawWeatherData>();
  for (const dataset of weatherDataSets) {
    for (const rec of dataset.records) {
      const dt = new Date(rec.datetime);
      // Add 1 hour to weather timestamp to align with hour-ending demand
      const alignedDt = new Date(dt.getTime() + 60 * 60 * 1000);
      const key = `${dataset.zoneCode}_${dataset.cityIndex}_${alignedDt.getTime()}`;
      weatherMap.set(key, rec);
    }
  }

  // Get unique zone codes from demand data
  const zoneCodes = [...new Set(demandRecords.map(r => r.region))];

  // Get unique timestamps from demand data
  const timestamps = [...new Set(demandRecords.map(r => {
    const dt = r.datetime instanceof Date ? r.datetime : new Date(r.datetime);
    return dt.getTime();
  }))].sort();

  // Create empty weather record for missing data
  const emptyWeather: RawWeatherData = {
    datetime: '',
    name: '',
    latitude: 0,
    longitude: 0,
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

  // Merge: for each zone + timestamp, find demand + 3 city weathers
  for (const zone of zoneCodes) {
    for (const ts of timestamps) {
      const demandKey = `${zone}_${ts}`;
      const demand = demandMap.get(demandKey);

      if (demand === undefined) continue;

      const city1 = weatherMap.get(`${zone}_0_${ts}`) || { ...emptyWeather };
      const city2 = weatherMap.get(`${zone}_1_${ts}`) || { ...emptyWeather };
      const city3 = weatherMap.get(`${zone}_2_${ts}`) || { ...emptyWeather };

      results.push({
        datetime: new Date(ts),
        zone,
        demand,
        weather: { city1, city2, city3 }
      });
    }
  }

  // Sort by zone then datetime
  results.sort((a, b) => {
    if (a.zone !== b.zone) return a.zone.localeCompare(b.zone);
    return a.datetime.getTime() - b.datetime.getTime();
  });

  return results;
}
