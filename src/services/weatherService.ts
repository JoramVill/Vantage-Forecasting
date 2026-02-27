import axios from 'axios';
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, unlinkSync, statSync } from 'fs';
import { join } from 'path';
import { DateTime } from 'luxon';
import { getDatabase, closeDatabase, DatabaseService } from '../database/index.js';
import { RawWeatherData, ClusterWeatherRecord } from '../types/index.js';

export interface WeatherLocation {
  id: string;
  name: string;
  region: string;
  demandColumn: string;
}

// Cluster-based location for capacity factor forecasting
export interface ClusterLocation {
  clusterId: string;
  name: string;
  latitude: number;
  longitude: number;
  stationCodes: string[];
}

export interface WeatherServiceConfig {
  apiKey: string;
  cacheDir: string;
  locations: WeatherLocation[];
}

export interface WeatherCacheInfo {
  path: string;
  exists: boolean;
  ageHours: number;
  isHistorical: boolean;  // Target date is fully in the past
  needsRefresh: boolean;
}

export type WeatherRefreshMode = 'cache' | 'refresh' | 'force-refresh';

export interface FetchWeatherOptions {
  refreshMode?: WeatherRefreshMode;
  maxAgeHours?: number;
}

// Default locations for Philippine grid regions
export const DEFAULT_LOCATIONS: WeatherLocation[] = [
  { id: 'manila', name: 'Manila', region: 'luzon', demandColumn: 'CLUZ' },
  { id: 'cebu', name: 'Cebu City', region: 'visayas', demandColumn: 'CVIS' },
  { id: 'davao', name: 'Davao City', region: 'mindanao', demandColumn: 'CMIN' }
];

// Zonal weather locations - 45 cities for 14-zone demand forecasting
// NLUZ has 6 cities (larger coverage area), other zones have 3 cities each
export const ZONAL_LOCATIONS: WeatherLocation[] = [
  // 01NLUZ - Northern Luzon (Region I, II, III, CAR) - 6 cities for larger coverage
  { id: '01nluz_sanfernando', name: 'San Fernando, Pampanga', region: 'luzon', demandColumn: '01NLUZ' },
  { id: '01nluz_baguio', name: 'Baguio', region: 'luzon', demandColumn: '01NLUZ' },
  { id: '01nluz_tuguegarao', name: 'Tuguegarao', region: 'luzon', demandColumn: '01NLUZ' },
  { id: '01nluz_laoag', name: 'Laoag', region: 'luzon', demandColumn: '01NLUZ' },
  { id: '01nluz_dagupan', name: 'Dagupan', region: 'luzon', demandColumn: '01NLUZ' },
  { id: '01nluz_angeles', name: 'Angeles City', region: 'luzon', demandColumn: '01NLUZ' },
  // 02METRO - Metro Manila (NCR)
  { id: '02metro_manila', name: 'Manila', region: 'luzon', demandColumn: '02METRO' },
  { id: '02metro_quezoncity', name: 'Quezon City', region: 'luzon', demandColumn: '02METRO' },
  { id: '02metro_makati', name: 'Makati', region: 'luzon', demandColumn: '02METRO' },
  // 03SLUZ - Southern Luzon (CALABARZON, MIMAROPA, Bicol)
  { id: '03sluz_batangas', name: 'Batangas', region: 'luzon', demandColumn: '03SLUZ' },
  { id: '03sluz_lucena', name: 'Lucena', region: 'luzon', demandColumn: '03SLUZ' },
  { id: '03sluz_legazpi', name: 'Legazpi', region: 'luzon', demandColumn: '03SLUZ' },
  // 04LEYTE - Leyte / Eastern Visayas
  { id: '04leyte_tacloban', name: 'Tacloban', region: 'visayas', demandColumn: '04LEYTE' },
  { id: '04leyte_ormoc', name: 'Ormoc', region: 'visayas', demandColumn: '04LEYTE' },
  { id: '04leyte_catbalogan', name: 'Catbalogan', region: 'visayas', demandColumn: '04LEYTE' },
  // 05CEBU - Cebu
  { id: '05cebu_cebucity', name: 'Cebu City', region: 'visayas', demandColumn: '05CEBU' },
  { id: '05cebu_mandaue', name: 'Mandaue', region: 'visayas', demandColumn: '05CEBU' },
  { id: '05cebu_lapulapu', name: 'Lapu-Lapu', region: 'visayas', demandColumn: '05CEBU' },
  // 06NEGROS - Negros
  { id: '06negros_bacolod', name: 'Bacolod', region: 'visayas', demandColumn: '06NEGROS' },
  { id: '06negros_dumaguete', name: 'Dumaguete', region: 'visayas', demandColumn: '06NEGROS' },
  { id: '06negros_kabankalan', name: 'Kabankalan', region: 'visayas', demandColumn: '06NEGROS' },
  // 07BOHOL - Bohol
  { id: '07bohol_tagbilaran', name: 'Tagbilaran', region: 'visayas', demandColumn: '07BOHOL' },
  { id: '07bohol_ubay', name: 'Ubay', region: 'visayas', demandColumn: '07BOHOL' },
  { id: '07bohol_talibon', name: 'Talibon', region: 'visayas', demandColumn: '07BOHOL' },
  // 08PANAY - Panay / Western Visayas
  { id: '08panay_iloilo', name: 'Iloilo City', region: 'visayas', demandColumn: '08PANAY' },
  { id: '08panay_roxas', name: 'Roxas', region: 'visayas', demandColumn: '08PANAY' },
  { id: '08panay_kalibo', name: 'Kalibo', region: 'visayas', demandColumn: '08PANAY' },
  // 09NWMIN - Northwest Mindanao (Zamboanga Peninsula)
  { id: '09nwmin_zamboanga', name: 'Zamboanga City', region: 'mindanao', demandColumn: '09NWMIN' },
  { id: '09nwmin_pagadian', name: 'Pagadian', region: 'mindanao', demandColumn: '09NWMIN' },
  { id: '09nwmin_dipolog', name: 'Dipolog', region: 'mindanao', demandColumn: '09NWMIN' },
  // 10LANAO - Lanao
  { id: '10lanao_iligan', name: 'Iligan', region: 'mindanao', demandColumn: '10LANAO' },
  { id: '10lanao_marawi', name: 'Marawi', region: 'mindanao', demandColumn: '10LANAO' },
  { id: '10lanao_ozamiz', name: 'Ozamiz', region: 'mindanao', demandColumn: '10LANAO' },
  // 11NCMIN - North Central Mindanao
  { id: '11ncmin_cagayandeorocity', name: 'Cagayan de Oro', region: 'mindanao', demandColumn: '11NCMIN' },
  { id: '11ncmin_malaybalay', name: 'Malaybalay', region: 'mindanao', demandColumn: '11NCMIN' },
  { id: '11ncmin_valencia', name: 'Valencia', region: 'mindanao', demandColumn: '11NCMIN' },
  // 12NEMIN - Northeast Mindanao (Caraga)
  { id: '12nemin_butuan', name: 'Butuan', region: 'mindanao', demandColumn: '12NEMIN' },
  { id: '12nemin_surigao', name: 'Surigao City', region: 'mindanao', demandColumn: '12NEMIN' },
  { id: '12nemin_bislig', name: 'Bislig', region: 'mindanao', demandColumn: '12NEMIN' },
  // 13SEMIN - Southeast Mindanao (Davao Region)
  { id: '13semin_davao', name: 'Davao City', region: 'mindanao', demandColumn: '13SEMIN' },
  { id: '13semin_tagum', name: 'Tagum', region: 'mindanao', demandColumn: '13SEMIN' },
  { id: '13semin_panabo', name: 'Panabo', region: 'mindanao', demandColumn: '13SEMIN' },
  // 14SWMIN - Southwest Mindanao (SOCCSKSARGEN)
  { id: '14swmin_gensantos', name: 'General Santos', region: 'mindanao', demandColumn: '14SWMIN' },
  { id: '14swmin_koronadal', name: 'Koronadal', region: 'mindanao', demandColumn: '14SWMIN' },
  { id: '14swmin_cotabato', name: 'Cotabato City', region: 'mindanao', demandColumn: '14SWMIN' }
];

// Get zonal locations grouped by zone code
export function getZonalLocationsByZone(): Map<string, WeatherLocation[]> {
  const map = new Map<string, WeatherLocation[]>();
  for (const loc of ZONAL_LOCATIONS) {
    const existing = map.get(loc.demandColumn) || [];
    existing.push(loc);
    map.set(loc.demandColumn, existing);
  }
  return map;
}

// Weather elements to fetch (matching existing format)
// Now includes extended solar radiation components for better PV modeling
const HOURLY_ELEMENTS = [
  'datetime',
  'name',
  'latitude',
  'longitude',
  'temp',
  'dew',
  'precip',
  'windgust',
  'windspeed',
  'cloudcover',
  'solarradiation',    // GHI - Global Horizontal Irradiance (W/m²)
  'solarenergy',
  'uvindex',
  'dniradiation',      // DNI - Direct Normal Irradiance (W/m²)
  'difradiation',      // DHI - Diffuse Horizontal Irradiance (W/m²)
  'ghiradiation'       // GHI - explicit Global Horizontal Irradiance (W/m²)
];

// Extended wind elements for wind farm forecasting (hub height ~80-100m)
// Visual Crossing offers wind data at 50m, 80m, and 100m heights
const WIND_ELEMENTS = [
  'datetime',
  'name',
  'latitude',
  'longitude',
  'temp',
  'dew',
  'precip',
  'windgust',
  'windspeed',        // 10m wind speed (standard)
  'winddir',          // 10m wind direction
  'windspeed50',      // Wind speed at 50m
  'winddir50',        // Wind direction at 50m
  'windspeed80',      // Wind speed at 80m
  'winddir80',        // Wind direction at 80m
  'windspeed100',     // Wind speed at 100m (hub height)
  'winddir100',       // Wind direction at 100m
  'cloudcover',
  'solarradiation',
  'solarenergy',
  'uvindex'
];

// Full elements for per-station fetching (includes all data for analysis)
const FULL_ELEMENTS = [
  'datetime',
  'name',
  'latitude',
  'longitude',
  'temp',
  'dew',
  'humidity',
  'precip',
  'precipprob',
  'windgust',
  'windspeed',
  'winddir',
  'windspeed50',
  'winddir50',
  'windspeed80',
  'winddir80',
  'windspeed100',
  'winddir100',
  'pressure',
  'cloudcover',
  'visibility',
  'solarradiation',
  'solarenergy',
  'uvindex',
  'conditions'
];

export class WeatherService {
  private apiKey: string;
  private cacheDir: string;
  private locations: WeatherLocation[];
  private baseUrl = 'https://weather.visualcrossing.com/VisualCrossingWebServices/rest/services/timeline/';
  private useDatabase: boolean = true;  // Primary storage is now database

  constructor(config: WeatherServiceConfig) {
    this.apiKey = config.apiKey;
    this.cacheDir = config.cacheDir;
    this.locations = config.locations;

    // Ensure cache directory exists (still used as backup/legacy)
    if (!existsSync(this.cacheDir)) {
      mkdirSync(this.cacheDir, { recursive: true });
    }
  }

  /**
   * Parse a CSV line handling quoted fields with commas
   */
  private parseCSVLine(line: string): string[] {
    const result: string[] = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === ',' && !inQuotes) {
        result.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }
    result.push(current.trim());
    return result;
  }

  /**
   * Parse CSV response from Visual Crossing API into RawWeatherData records
   */
  private parseCsvToRecords(csvData: string, locationName: string): RawWeatherData[] {
    const lines = csvData.split('\n').filter(l => l.trim());
    if (lines.length < 2) return [];

    // Header line typically doesn't have quoted fields
    const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
    const colIdx = (name: string) => headers.indexOf(name);

    const records: RawWeatherData[] = [];

    for (let i = 1; i < lines.length; i++) {
      // Data lines may have quoted fields (e.g., location name with commas)
      const values = this.parseCSVLine(lines[i]);

      records.push({
        name: locationName,
        latitude: parseFloat(values[colIdx('latitude')]) || 0,
        longitude: parseFloat(values[colIdx('longitude')]) || 0,
        datetime: values[colIdx('datetime')],
        temp: parseFloat(values[colIdx('temp')]) || 0,
        dew: parseFloat(values[colIdx('dew')]) || 0,
        precip: parseFloat(values[colIdx('precip')]) || 0,
        windgust: parseFloat(values[colIdx('windgust')]) || 0,
        windspeed: parseFloat(values[colIdx('windspeed')]) || 0,
        cloudcover: parseFloat(values[colIdx('cloudcover')]) || 0,
        solarradiation: parseFloat(values[colIdx('solarradiation')]) || 0,
        solarenergy: parseFloat(values[colIdx('solarenergy')]) || 0,
        uvindex: parseFloat(values[colIdx('uvindex')]) || 0
      });
    }

    return records;
  }

  /**
   * Get the cache file path for a specific location and date
   */
  private getCacheFilePath(locationId: string, date: string): string {
    // Organize by location/year/month for easier management
    const dt = DateTime.fromISO(date);
    const yearMonth = dt.toFormat('yyyy-MM');
    const cacheSubDir = join(this.cacheDir, locationId, yearMonth);

    if (!existsSync(cacheSubDir)) {
      mkdirSync(cacheSubDir, { recursive: true });
    }

    return join(cacheSubDir, `${date}.csv`);
  }

  /**
   * Check if we have cached data for a specific date
   */
  private hasCachedData(locationId: string, date: string): boolean {
    const filePath = this.getCacheFilePath(locationId, date);
    return existsSync(filePath);
  }

  /**
   * Read cached data for a specific date
   */
  private readCachedData(locationId: string, date: string): string | null {
    const filePath = this.getCacheFilePath(locationId, date);
    if (existsSync(filePath)) {
      return readFileSync(filePath, 'utf8');
    }
    return null;
  }

  /**
   * Check if weather cache needs refresh
   *
   * Rule: Historical data (target date fully passed) never expires.
   * Future data expires after maxAgeHours (default 6).
   *
   * IMPORTANT: "Historical" is determined by comparing the target date
   * to the current date in PHT, not by current time. This handles the
   * midnight edge case correctly.
   */
  checkCacheAge(
    targetDate: string,  // YYYY-MM-DD
    cachePath: string,
    maxAgeHours: number = 6
  ): WeatherCacheInfo {
    const now = DateTime.now().setZone('Asia/Manila');
    const target = DateTime.fromISO(targetDate).setZone('Asia/Manila');

    // Target is historical if the entire day has passed
    // (target date < today's date, not just current time)
    const isHistorical = target.startOf('day') < now.startOf('day');

    const exists = existsSync(cachePath);
    let ageHours = 0;

    if (exists) {
      const stats = statSync(cachePath);
      ageHours = (now.toMillis() - stats.mtimeMs) / (1000 * 60 * 60);
    }

    // Historical data never needs refresh
    // Future data needs refresh if older than maxAgeHours
    const needsRefresh = !isHistorical && exists && ageHours > maxAgeHours;

    return { path: cachePath, exists, ageHours, isHistorical, needsRefresh };
  }

  /**
   * Validate cached weather data for completeness
   * Returns true if data is valid, false if it appears incomplete/stale
   *
   * Detection logic:
   * - Solar clusters (SOLAR_*): Daylight hours (6-18) should have solarradiation > 0
   * - Wind clusters (WIND_*): windspeed100 values should be present (not empty)
   * - If hourly data rows have mostly empty values, data is incomplete
   */
  private validateCachedWeatherData(csvData: string, clusterId: string, date: string): { valid: boolean; reason?: string } {
    const lines = csvData.split('\n').filter(l => l.trim());
    if (lines.length < 2) {
      return { valid: false, reason: 'No data rows' };
    }

    const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
    const datetimeIdx = headers.indexOf('datetime');
    const solarIdx = headers.indexOf('solarradiation');
    const windspeed100Idx = headers.indexOf('windspeed100');
    const windspeedIdx = headers.indexOf('windspeed');

    // Check if this is a solar or wind cluster
    const isSolarCluster = clusterId.startsWith('SOLAR_');
    const isWindCluster = clusterId.startsWith('WIND_');

    let emptyCount = 0;
    let daylightEmptySolar = 0;
    let daylightHours = 0;
    let windEmptyCount = 0;
    let totalRows = 0;

    for (let i = 1; i < lines.length; i++) {
      // Use parseCSVLine to handle quoted fields with commas (e.g., "15.2889,120.0256")
      const values = this.parseCSVLine(lines[i]);
      totalRows++;

      // Get hour from datetime (format: 2026-01-10T01:00:00)
      const datetime = values[datetimeIdx] || '';
      const hourMatch = datetime.match(/T(\d{2}):/);
      const hour = hourMatch ? parseInt(hourMatch[1], 10) : -1;

      // Check for empty row (all values after datetime are empty)
      const dataValues = values.slice(4); // Skip datetime, name, lat, lon
      const allEmpty = dataValues.every(v => !v || v.trim() === '');
      if (allEmpty) {
        emptyCount++;
      }

      // Solar validation: daylight hours should have solarradiation > 0
      if (isSolarCluster && solarIdx >= 0 && hour >= 6 && hour <= 18) {
        daylightHours++;
        const solarValue = parseFloat(values[solarIdx] || '0');
        if (solarValue === 0 || isNaN(solarValue) || values[solarIdx]?.trim() === '') {
          daylightEmptySolar++;
        }
      }

      // Wind validation: windspeed100 or windspeed should be present
      if (isWindCluster) {
        const ws100 = values[windspeed100Idx]?.trim() || '';
        const ws = values[windspeedIdx]?.trim() || '';
        if (ws100 === '' && ws === '') {
          windEmptyCount++;
        }
      }
    }

    // Validation rules:
    // 1. If more than 50% of rows are completely empty, data is incomplete
    if (totalRows > 0 && emptyCount / totalRows > 0.5) {
      return { valid: false, reason: `${emptyCount}/${totalRows} rows are empty (${Math.round(emptyCount/totalRows*100)}%)` };
    }

    // 2. Solar: If more than 80% of daylight hours have zero/empty solarradiation, data is incomplete
    if (isSolarCluster && daylightHours > 0 && daylightEmptySolar / daylightHours > 0.8) {
      return { valid: false, reason: `${daylightEmptySolar}/${daylightHours} daylight hours have no solar radiation data` };
    }

    // 3. Wind: If more than 50% of rows have no wind speed data, data is incomplete
    if (isWindCluster && totalRows > 0 && windEmptyCount / totalRows > 0.5) {
      return { valid: false, reason: `${windEmptyCount}/${totalRows} rows have no wind speed data` };
    }

    return { valid: true };
  }

  /**
   * Delete a cached weather file
   */
  private deleteCachedData(locationId: string, date: string): boolean {
    const filePath = this.getCacheFilePath(locationId, date);
    if (existsSync(filePath)) {
      try {
        unlinkSync(filePath);
        return true;
      } catch (e) {
        return false;
      }
    }
    return false;
  }

  /**
   * Save data to cache for a specific date
   */
  private saveCacheData(locationId: string, date: string, data: string): void {
    const filePath = this.getCacheFilePath(locationId, date);
    writeFileSync(filePath, data, 'utf8');
  }

  /**
   * Download weather data for a single day from Visual Crossing API
   */
  private async downloadDayData(location: WeatherLocation, date: string): Promise<string> {
    // Always use Asia/Manila timezone for Philippine grid consistency
    const url = `${this.baseUrl}${encodeURIComponent(location.name)}/${date}/${date}` +
                `?unitGroup=metric&contentType=csv&include=hours,remote` +
                `&timezone=Asia/Manila` +
                `&elements=${HOURLY_ELEMENTS.join(',')}` +
                `&key=${this.apiKey}`;

    const response = await axios({
      method: 'GET',
      url: url,
      timeout: 60000
    });

    return response.data;
  }

  /**
   * Download weather data for a single day using coordinates (lat/lon)
   * @param clusterId - Cluster ID for caching purposes
   * @param latitude - Latitude of the location
   * @param longitude - Longitude of the location
   * @param date - Date in YYYY-MM-DD format
   * @param useWindElements - If true, try to fetch extended wind elements (100m height)
   *                          Falls back to standard elements if premium features unavailable
   */
  private async downloadDayDataByCoords(
    clusterId: string,
    latitude: number,
    longitude: number,
    date: string,
    useWindElements: boolean = false
  ): Promise<string> {
    // Visual Crossing API accepts lat,lon as location
    const locationStr = `${latitude},${longitude}`;

    // Try wind elements first if requested
    // Always use Asia/Manila timezone for Philippine grid consistency
    const timezone = 'Asia/Manila';

    if (useWindElements) {
      try {
        const windUrl = `${this.baseUrl}${locationStr}/${date}/${date}` +
                        `?unitGroup=metric&contentType=csv&include=hours,remote` +
                        `&timezone=${timezone}` +
                        `&elements=${WIND_ELEMENTS.join(',')}` +
                        `&key=${this.apiKey}`;

        const response = await axios({
          method: 'GET',
          url: windUrl,
          timeout: 60000
        });

        return response.data;
      } catch (error: any) {
        // If 401 or 400, extended wind elements not available - fall back to standard
        if (error.response?.status === 401 || error.response?.status === 400) {
          // Fall through to standard elements
        } else {
          throw error; // Re-throw other errors (network, etc.)
        }
      }
    }

    // Standard elements (fallback or default)
    const url = `${this.baseUrl}${locationStr}/${date}/${date}` +
                `?unitGroup=metric&contentType=csv&include=hours,remote` +
                `&timezone=${timezone}` +
                `&elements=${HOURLY_ELEMENTS.join(',')}` +
                `&key=${this.apiKey}`;

    const response = await axios({
      method: 'GET',
      url: url,
      timeout: 60000
    });

    return response.data;
  }

  /**
   * Parse CSV header to get column indices
   */
  private parseHeader(headerLine: string): Map<string, number> {
    const columns = headerLine.split(',').map(c => c.trim().toLowerCase());
    const indices = new Map<string, number>();
    columns.forEach((col, idx) => indices.set(col, idx));
    return indices;
  }

  /**
   * Parse cluster weather CSV into records for database import
   * Handles both standard and extended wind elements
   */
  private parseClusterCsvToRecords(csvData: string): Array<{
    datetime: string;
    temp?: number;
    dew?: number;
    humidity?: number;
    precip?: number;
    precipprob?: number;
    pressure?: number;
    windgust?: number;
    windspeed?: number;
    winddir?: number;
    windspeed50?: number;
    winddir50?: number;
    windspeed80?: number;
    winddir80?: number;
    windspeed100?: number;
    winddir100?: number;
    cloudcover?: number;
    visibility?: number;
    solarradiation?: number;
    solarenergy?: number;
    uvindex?: number;
    dniradiation?: number;
    difradiation?: number;
    ghiradiation?: number;
    conditions?: string;
  }> {
    const lines = csvData.split('\n').filter(l => l.trim());
    if (lines.length < 2) return [];

    const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
    const colIdx = (name: string) => headers.indexOf(name);

    const records: Array<any> = [];

    const getNumericValue = (values: string[], idx: number): number | undefined => {
      if (idx < 0) return undefined;
      const val = values[idx]?.trim();
      if (!val || val === '') return undefined;
      const num = parseFloat(val);
      return isNaN(num) ? undefined : num;
    };

    const getStringValue = (values: string[], idx: number): string | undefined => {
      if (idx < 0) return undefined;
      const val = values[idx]?.trim();
      return val || undefined;
    };

    for (let i = 1; i < lines.length; i++) {
      const values = this.parseCSVLine(lines[i]);

      const record = {
        datetime: values[colIdx('datetime')],
        temp: getNumericValue(values, colIdx('temp')),
        dew: getNumericValue(values, colIdx('dew')),
        humidity: getNumericValue(values, colIdx('humidity')),
        precip: getNumericValue(values, colIdx('precip')),
        precipprob: getNumericValue(values, colIdx('precipprob')),
        pressure: getNumericValue(values, colIdx('pressure')),
        windgust: getNumericValue(values, colIdx('windgust')),
        windspeed: getNumericValue(values, colIdx('windspeed')),
        winddir: getNumericValue(values, colIdx('winddir')),
        windspeed50: getNumericValue(values, colIdx('windspeed50')),
        winddir50: getNumericValue(values, colIdx('winddir50')),
        windspeed80: getNumericValue(values, colIdx('windspeed80')),
        winddir80: getNumericValue(values, colIdx('winddir80')),
        windspeed100: getNumericValue(values, colIdx('windspeed100')),
        winddir100: getNumericValue(values, colIdx('winddir100')),
        cloudcover: getNumericValue(values, colIdx('cloudcover')),
        visibility: getNumericValue(values, colIdx('visibility')),
        solarradiation: getNumericValue(values, colIdx('solarradiation')),
        solarenergy: getNumericValue(values, colIdx('solarenergy')),
        uvindex: getNumericValue(values, colIdx('uvindex')),
        dniradiation: getNumericValue(values, colIdx('dniradiation')),
        difradiation: getNumericValue(values, colIdx('difradiation')),
        ghiradiation: getNumericValue(values, colIdx('ghiradiation')),
        conditions: getStringValue(values, colIdx('conditions'))
      };

      if (record.datetime) {
        records.push(record);
      }
    }

    return records;
  }

  /**
   * Format cluster weather records as CSV for backward compatibility
   */
  private formatClusterRecordsAsCsv(
    records: Array<ClusterWeatherRecord & { isHistorical?: boolean }>,
    isWindCluster: boolean
  ): string {
    if (records.length === 0) return '';

    // Use appropriate headers based on cluster type
    const headers = isWindCluster ? WIND_ELEMENTS : HOURLY_ELEMENTS;
    const headerLine = headers.join(',');

    const rows: string[] = [headerLine];

    for (const record of records) {
      // Extract name, lat, lon from locationId (e.g., "SOLAR_01BOTOLAN" -> need coordinates)
      // For now, use placeholder values - the actual coordinates aren't stored in the DB records
      // This is fine since the downstream parsers primarily use datetime and weather values
      const row = headers.map(h => {
        switch (h) {
          case 'datetime': return record.datetime || '';
          case 'name': return record.locationId || '';
          case 'latitude': return '0';  // Placeholder - coordinates used at fetch time
          case 'longitude': return '0'; // Placeholder - coordinates used at fetch time
          case 'temp': return record.temp ?? '';
          case 'dew': return record.dew ?? '';
          case 'humidity': return record.humidity ?? '';
          case 'precip': return record.precip ?? '';
          case 'precipprob': return record.precipprob ?? '';
          case 'pressure': return record.pressure ?? '';
          case 'windgust': return record.windgust ?? '';
          case 'windspeed': return record.windspeed ?? '';
          case 'winddir': return record.winddir ?? '';
          case 'windspeed50': return record.windspeed50 ?? '';
          case 'winddir50': return record.winddir50 ?? '';
          case 'windspeed80': return record.windspeed80 ?? '';
          case 'winddir80': return record.winddir80 ?? '';
          case 'windspeed100': return record.windspeed100 ?? '';
          case 'winddir100': return record.winddir100 ?? '';
          case 'cloudcover': return record.cloudcover ?? '';
          case 'visibility': return record.visibility ?? '';
          case 'solarradiation': return record.solarradiation ?? '';
          case 'solarenergy': return record.solarenergy ?? '';
          case 'uvindex': return record.uvindex ?? '';
          case 'dniradiation': return record.dniradiation ?? '';
          case 'difradiation': return record.difradiation ?? '';
          case 'ghiradiation': return record.ghiradiation ?? '';
          case 'conditions': return record.conditions ?? '';
          default: return '';
        }
      });
      rows.push(row.join(','));
    }

    return rows.join('\n');
  }

  /**
   * Get all dates between start and end (inclusive)
   */
  private getDateRange(startDate: string, endDate: string): string[] {
    const dates: string[] = [];
    let current = DateTime.fromISO(startDate);
    const end = DateTime.fromISO(endDate);

    while (current <= end) {
      dates.push(current.toISODate()!);
      current = current.plus({ days: 1 });
    }

    return dates;
  }

  /**
   * Fetch weather data for a date range, using DATABASE as primary storage
   * Falls back to file cache for legacy compatibility
   * Returns combined CSV data for all days
   *
   * Smart refresh logic:
   * - Historical data (past dates) is permanent, never re-downloaded
   * - Forecast data is refreshed if stale (>24 hours old)
   * - Past dates with forecast data get replaced with actual historical data
   */
  async fetchWeatherData(
    location: WeatherLocation,
    startDate: string,
    endDate: string,
    onProgress?: (message: string) => void
  ): Promise<{ success: boolean; data?: string; error?: string; cached: number; downloaded: number; refreshed: number }> {
    const dates = this.getDateRange(startDate, endDate);
    const allRows: string[] = [];
    let header: string | null = null;
    let cachedCount = 0;
    let downloadedCount = 0;
    let refreshedCount = 0;

    onProgress?.(`Fetching weather data for ${location.name}: ${dates.length} days`);

    // Get database instance
    const db = getDatabase();

    // Check which dates need to be fetched (missing, stale forecast, or needs historical)
    const missingDates = db.getMissingWeatherDates(location.name, startDate, endDate);
    const staleForecastDates = new Set(db.getStaleForecastDates(location.name, startDate, endDate));
    const needsHistoricalDates = new Set(db.getDatesNeedingHistoricalData(location.name, startDate, endDate));
    const dbAvailableDates = new Set(dates.filter(d => !missingDates.includes(d)));

    // Calculate breakdown for progress message
    const trulyMissing = missingDates.filter(d => !staleForecastDates.has(d) && !needsHistoricalDates.has(d));
    const staleToRefresh = missingDates.filter(d => staleForecastDates.has(d));
    const needsHistorical = missingDates.filter(d => needsHistoricalDates.has(d));

    if (missingDates.length > 0) {
      onProgress?.(`  Database: ${dbAvailableDates.size} days OK`);
      if (trulyMissing.length > 0) onProgress?.(`  Missing: ${trulyMissing.length} days`);
      if (staleToRefresh.length > 0) onProgress?.(`  Stale forecast: ${staleToRefresh.length} days (will refresh)`);
      if (needsHistorical.length > 0) onProgress?.(`  Needs historical: ${needsHistorical.length} days (replacing forecast with actual)`);
    } else {
      onProgress?.(`  Database has all ${dbAvailableDates.size} days (historical data preserved)`);
    }

    // Download dates that need updating
    for (const date of missingDates) {
      try {
        const isStale = staleForecastDates.has(date);
        const needsHist = needsHistoricalDates.has(date);

        // Check file cache as fallback before downloading (only for truly missing)
        if (!isStale && !needsHist && this.hasCachedData(location.id, date)) {
          const csvData = this.readCachedData(location.id, date);
          if (csvData) {
            // Import from file cache to database
            const records = this.parseCsvToRecords(csvData, location.name);
            if (records.length > 0) {
              db.importWeatherDay(records, location.name);
              cachedCount++;
              onProgress?.(`  Imported ${location.name} ${date} from file cache`);
              continue;
            }
          }
        }

        // Download from API
        const reason = needsHist ? '(historical)' : isStale ? '(refresh)' : '';
        onProgress?.(`  Downloading ${location.name} ${date} ${reason}...`);
        const csvData = await this.downloadDayData(location, date);

        // Parse and store in database (auto-detects historical vs forecast)
        const records = this.parseCsvToRecords(csvData, location.name);
        if (records.length > 0) {
          const result = db.importWeatherDay(records, location.name);
          if (isStale || needsHist) {
            refreshedCount++;
          } else {
            downloadedCount++;
          }
        }

        // Also save to file cache for backup
        this.saveCacheData(location.id, date, csvData);

        // Small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 200));
      } catch (error: any) {
        onProgress?.(`  Error fetching ${date}: ${error.message}`);
        // Continue with other dates
      }
    }

    // Count dates that were already in database (and don't need refresh)
    cachedCount += dbAvailableDates.size;

    // Now retrieve ALL data from database and format as CSV
    const weatherData = db.getWeatherDataForParser(location.name, startDate, endDate);

    if (!weatherData || weatherData.records.length === 0) {
      return { success: false, error: 'No weather data retrieved', cached: cachedCount, downloaded: downloadedCount, refreshed: refreshedCount };
    }

    // Convert database records to CSV format
    // Quote the name field to handle commas in city names (e.g. "San Fernando, Pampanga")
    header = 'name,latitude,longitude,datetime,temp,dew,precip,windgust,windspeed,cloudcover,solarradiation,solarenergy,uvindex';
    for (const record of weatherData.records) {
      const quotedName = record.name.includes(',') ? `"${record.name}"` : record.name;
      allRows.push([
        quotedName,
        record.latitude,
        record.longitude,
        record.datetime,
        record.temp,
        record.dew,
        record.precip,
        record.windgust,
        record.windspeed,
        record.cloudcover,
        record.solarradiation,
        record.solarenergy,
        record.uvindex
      ].join(','));
    }

    // Combine header and all rows
    const combinedData = [header, ...allRows].join('\n');

    const summary = [];
    if (cachedCount > 0) summary.push(`${cachedCount} from DB`);
    if (downloadedCount > 0) summary.push(`${downloadedCount} new`);
    if (refreshedCount > 0) summary.push(`${refreshedCount} refreshed`);
    onProgress?.(`  ${location.name}: ${summary.join(', ')}`);

    return { success: true, data: combinedData, cached: cachedCount, downloaded: downloadedCount, refreshed: refreshedCount };
  }

  /**
   * Fetch weather data for all configured locations
   */
  async fetchAllLocations(
    startDate: string,
    endDate: string,
    onProgress?: (message: string) => void
  ): Promise<Map<string, string>> {
    const results = new Map<string, string>();

    for (const location of this.locations) {
      const result = await this.fetchWeatherData(location, startDate, endDate, onProgress);
      if (result.success && result.data) {
        results.set(location.demandColumn, result.data);
      }
    }

    return results;
  }

  /**
   * Save combined weather data to files (for compatibility with existing parsers)
   */
  async saveWeatherFiles(
    startDate: string,
    endDate: string,
    outputDir: string,
    onProgress?: (message: string) => void
  ): Promise<string[]> {
    const savedFiles: string[] = [];

    if (!existsSync(outputDir)) {
      mkdirSync(outputDir, { recursive: true });
    }

    for (const location of this.locations) {
      const result = await this.fetchWeatherData(location, startDate, endDate, onProgress);

      if (result.success && result.data) {
        const filename = `Weather_hourly_${location.id}_${startDate}_${endDate}.csv`;
        const filePath = join(outputDir, filename);
        writeFileSync(filePath, result.data, 'utf8');
        savedFiles.push(filePath);
        onProgress?.(`Saved: ${filename}`);
      }
    }

    return savedFiles;
  }

  /**
   * Fetch weather data for a cluster location using coordinates
   * Uses DATABASE as primary storage with smart refresh logic:
   * - Historical data (past dates) is permanent, never re-downloaded
   * - Forecast data is refreshed if stale (>24 hours old)
   * - Past dates with forecast data get replaced with actual historical data
   *
   * Returns combined CSV data for all days (backward compatible)
   *
   * @param cluster - Cluster location with coordinates
   * @param startDate - Start date in YYYY-MM-DD format
   * @param endDate - End date in YYYY-MM-DD format
   * @param onProgress - Progress callback
   * @param isWindCluster - If true, fetch extended wind elements (100m height) for wind farm forecasting
   */
  async fetchClusterWeatherData(
    cluster: ClusterLocation,
    startDate: string,
    endDate: string,
    onProgress?: (message: string) => void,
    isWindCluster: boolean = false
  ): Promise<{ success: boolean; data?: string; error?: string; cached: number; downloaded: number; refreshed?: number }> {
    const dates = this.getDateRange(startDate, endDate);
    let cachedCount = 0;
    let downloadedCount = 0;
    let refreshedCount = 0;

    const db = getDatabase();
    const locationId = cluster.clusterId;
    const cacheKey = cluster.clusterId;
    const fetchedAt = DateTime.now().toISO()!;

    onProgress?.(`Fetching ${isWindCluster ? 'wind (100m)' : 'standard'} weather for cluster ${cluster.clusterId} (${cluster.name}): ${dates.length} days`);

    // Check which dates need fetching using smart database logic
    const missingDates = db.getClusterMissingDates(locationId, startDate, endDate, 24);

    // Get existing data counts
    const existingCount = dates.length - missingDates.length;
    cachedCount = existingCount;

    if (missingDates.length > 0) {
      // Get breakdown for detailed progress
      const today = DateTime.now().startOf('day');
      const staleCount = missingDates.filter(d => DateTime.fromISO(d) >= today).length;
      const needsHistCount = missingDates.filter(d => DateTime.fromISO(d) < today).length;

      onProgress?.(`  Database: ${existingCount} days OK`);
      if (needsHistCount > 0) onProgress?.(`  Needs historical: ${needsHistCount} days`);
      if (staleCount > 0) onProgress?.(`  Stale/missing forecast: ${staleCount - needsHistCount > 0 ? staleCount : missingDates.length - needsHistCount} days`);
    } else {
      onProgress?.(`  Database has all ${existingCount} days (historical data preserved)`);
    }

    // Download dates that need updating
    for (const date of missingDates) {
      try {
        const isPast = DateTime.fromISO(date) < DateTime.now().startOf('day');

        // First check file cache as fallback (for migration from old system)
        if (this.hasCachedData(cacheKey, date)) {
          const csvData = this.readCachedData(cacheKey, date);
          if (csvData) {
            const validation = this.validateCachedWeatherData(csvData, cluster.clusterId, date);
            if (validation.valid) {
              // Import from file cache to database
              const records = this.parseClusterCsvToRecords(csvData);
              if (records.length > 0) {
                db.importClusterWeather(records, locationId, fetchedAt, 'file_cache');
                onProgress?.(`  Imported ${cluster.clusterId} ${date} from file cache`);
                if (isPast) refreshedCount++; else cachedCount++;
                continue;
              }
            } else {
              // Invalid cache file - delete it
              this.deleteCachedData(cacheKey, date);
            }
          }
        }

        // Download from API
        const reason = isPast ? '(historical)' : '';
        onProgress?.(`  Downloading ${cluster.clusterId} ${date}${isWindCluster ? ' (100m wind)' : ''} ${reason}...`);

        const csvData = await this.downloadDayDataByCoords(
          cluster.clusterId,
          cluster.latitude,
          cluster.longitude,
          date,
          isWindCluster
        );

        // Parse and store in database (auto-routes to historical/forecast)
        const records = this.parseClusterCsvToRecords(csvData);
        if (records.length > 0) {
          const result = db.importClusterWeather(records, locationId, fetchedAt, 'api');
          if (isPast) {
            refreshedCount++;
          } else {
            downloadedCount++;
          }
        }

        // Also save to file cache for backup
        this.saveCacheData(cacheKey, date, csvData);

        // Small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 200));
      } catch (error: any) {
        onProgress?.(`  Error fetching ${date}: ${error.message}`);
        // Continue with other dates
      }
    }

    // Retrieve all data from database (merged historical + forecast)
    const weatherRecords = db.getClusterWeather(locationId, startDate, endDate);

    if (weatherRecords.length === 0) {
      return { success: false, error: 'No weather data retrieved', cached: cachedCount, downloaded: downloadedCount, refreshed: refreshedCount };
    }

    // Format database records as CSV for backward compatibility
    const recordsWithLocationId = weatherRecords.map(r => ({
      ...r,
      locationId: locationId
    })) as Array<ClusterWeatherRecord & { isHistorical?: boolean }>;

    const combinedData = this.formatClusterRecordsAsCsv(recordsWithLocationId, isWindCluster);

    const summary = [];
    if (cachedCount > 0) summary.push(`${cachedCount} from DB`);
    if (downloadedCount > 0) summary.push(`${downloadedCount} new`);
    if (refreshedCount > 0) summary.push(`${refreshedCount} refreshed`);
    onProgress?.(`  ${cluster.clusterId}: ${summary.join(', ')}`);

    return { success: true, data: combinedData, cached: cachedCount, downloaded: downloadedCount, refreshed: refreshedCount };
  }

  /**
   * Fetch weather data for all cluster locations
   * Returns a map of clusterId -> CSV data
   * @param clusters - Array of cluster locations
   * @param startDate - Start date in YYYY-MM-DD format
   * @param endDate - End date in YYYY-MM-DD format
   * @param onProgress - Progress callback
   * @param windClusterIds - Set of cluster IDs that are wind farms (will fetch 100m wind data)
   */
  async fetchAllClusters(
    clusters: ClusterLocation[],
    startDate: string,
    endDate: string,
    onProgress?: (message: string) => void,
    windClusterIds?: Set<string>
  ): Promise<Map<string, string>> {
    const results = new Map<string, string>();
    const totalClusters = clusters.length;
    const windCount = windClusterIds?.size || 0;
    const dates = this.getDateRange(startDate, endDate);
    const totalDays = dates.length;

    // Show detailed header
    onProgress?.(`   Clusters: ${totalClusters} locations (${windCount} wind, ${totalClusters - windCount} other)`);
    onProgress?.(`   Period: ${startDate} to ${endDate} (${totalDays} days)`);
    onProgress?.(`   Expected API calls: up to ${totalClusters * totalDays} (cached data will be skipped)`);

    let totalCached = 0;
    let totalDownloaded = 0;
    let totalRefreshed = 0;
    let processedCount = 0;

    for (const cluster of clusters) {
      processedCount++;
      const isWindCluster = windClusterIds?.has(cluster.clusterId) || false;
      const clusterType = isWindCluster ? '[WIND 100m]' : '[STANDARD]';

      onProgress?.(`   [${processedCount}/${totalClusters}] ${cluster.clusterId} ${clusterType} @ ${cluster.latitude.toFixed(4)}, ${cluster.longitude.toFixed(4)}`);

      const result = await this.fetchClusterWeatherData(cluster, startDate, endDate, onProgress, isWindCluster);
      if (result.success && result.data) {
        results.set(cluster.clusterId, result.data);
        totalCached += result.cached || 0;
        totalDownloaded += result.downloaded || 0;
        totalRefreshed += result.refreshed || 0;
      }
    }

    // Show summary
    onProgress?.(`   Summary: ${totalCached} cached, ${totalDownloaded} downloaded, ${totalRefreshed} refreshed`);
    onProgress?.(`   Successfully fetched: ${results.size}/${totalClusters} clusters`);

    return results;
  }

  /**
   * Check what data is available in cache for a date range
   */
  getCacheStatus(startDate: string, endDate: string): Map<string, { cached: number; missing: number; dates: string[] }> {
    const dates = this.getDateRange(startDate, endDate);
    const status = new Map<string, { cached: number; missing: number; dates: string[] }>();

    for (const location of this.locations) {
      let cached = 0;
      let missing = 0;
      const missingDates: string[] = [];

      for (const date of dates) {
        if (this.hasCachedData(location.id, date)) {
          cached++;
        } else {
          missing++;
          missingDates.push(date);
        }
      }

      status.set(location.id, { cached, missing, dates: missingDates });
    }

    return status;
  }

  /**
   * Clear cache for a specific location or all locations
   */
  clearCache(locationId?: string): void {
    const { rmSync } = require('fs');

    if (locationId) {
      const locationDir = join(this.cacheDir, locationId);
      if (existsSync(locationDir)) {
        rmSync(locationDir, { recursive: true });
      }
    } else {
      // Clear all cache
      for (const location of this.locations) {
        const locationDir = join(this.cacheDir, location.id);
        if (existsSync(locationDir)) {
          rmSync(locationDir, { recursive: true });
        }
      }
    }
  }

  /**
   * Fetch weather data for a single station using its exact coordinates
   * Returns full weather elements including all wind heights (10m, 50m, 80m, 100m)
   * @param stationCode - Station code for caching
   * @param latitude - Station latitude
   * @param longitude - Station longitude
   * @param startDate - Start date YYYY-MM-DD
   * @param endDate - End date YYYY-MM-DD
   * @param onProgress - Progress callback
   * @param useFullElements - If true, fetch all available elements including all wind heights
   */
  async fetchStationWeatherData(
    stationCode: string,
    latitude: number,
    longitude: number,
    startDate: string,
    endDate: string,
    onProgress?: (message: string) => void,
    useFullElements: boolean = true
  ): Promise<{ success: boolean; data?: string; error?: string; cached: number; downloaded: number }> {
    const dates = this.getDateRange(startDate, endDate);
    const allRows: string[] = [];
    let header: string | null = null;
    let cachedCount = 0;
    let downloadedCount = 0;

    // Use station-specific cache directory
    const cacheKey = `station_${stationCode}`;

    for (const date of dates) {
      try {
        let csvData: string | null = null;

        // Check cache first
        if (this.hasCachedData(cacheKey, date)) {
          csvData = this.readCachedData(cacheKey, date);
          cachedCount++;
        } else {
          // Download from API using station coordinates
          onProgress?.(`  Downloading ${stationCode} ${date}...`);

          const locationStr = `${latitude},${longitude}`;
          const elements = useFullElements ? FULL_ELEMENTS : WIND_ELEMENTS;

          const url = `${this.baseUrl}${locationStr}/${date}/${date}` +
                      `?unitGroup=metric&contentType=csv&include=hours,remote` +
                      `&elements=${elements.join(',')}` +
                      `&key=${this.apiKey}`;

          const response = await axios({
            method: 'GET',
            url: url,
            timeout: 60000
          });

          csvData = response.data as string;
          if (csvData) {
            this.saveCacheData(cacheKey, date, csvData);
            downloadedCount++;
          }

          // Small delay to avoid rate limiting
          await new Promise(resolve => setTimeout(resolve, 150));
        }

        if (csvData) {
          const lines = csvData.split('\n').filter(l => l.trim());

          // Keep header from first file
          if (!header && lines.length > 0) {
            header = lines[0];
          }

          // Add data rows (skip header)
          for (let i = 1; i < lines.length; i++) {
            allRows.push(lines[i]);
          }
        }
      } catch (error: any) {
        onProgress?.(`  Error fetching ${stationCode} ${date}: ${error.message}`);
        // Continue with other dates
      }
    }

    if (!header || allRows.length === 0) {
      return { success: false, error: 'No weather data retrieved', cached: cachedCount, downloaded: downloadedCount };
    }

    const combinedData = [header, ...allRows].join('\n');

    if (downloadedCount > 0 || cachedCount > 0) {
      onProgress?.(`  ${stationCode}: ${cachedCount} cached, ${downloadedCount} downloaded`);
    }

    return { success: true, data: combinedData, cached: cachedCount, downloaded: downloadedCount };
  }

  /**
   * Fetch weather data for multiple stations
   * @param stations - Array of {code, latitude, longitude, type}
   * @param startDate - Start date YYYY-MM-DD
   * @param endDate - End date YYYY-MM-DD
   * @param onProgress - Progress callback
   */
  async fetchAllStationsWeather(
    stations: Array<{ code: string; latitude: number; longitude: number; type: string }>,
    startDate: string,
    endDate: string,
    onProgress?: (message: string) => void
  ): Promise<Map<string, string>> {
    const results = new Map<string, string>();

    onProgress?.(`Fetching per-station weather for ${stations.length} stations...`);

    for (let i = 0; i < stations.length; i++) {
      const station = stations[i];
      onProgress?.(`[${i + 1}/${stations.length}] ${station.code} (${station.type})`);

      const result = await this.fetchStationWeatherData(
        station.code,
        station.latitude,
        station.longitude,
        startDate,
        endDate,
        onProgress,
        true  // Use full elements
      );

      if (result.success && result.data) {
        results.set(station.code, result.data);
      }
    }

    onProgress?.(`Completed: ${results.size}/${stations.length} stations`);
    return results;
  }

  /**
   * Get the date of the most recent cached data
   */
  getLatestCachedDate(locationId: string): string | null {
    const locationDir = join(this.cacheDir, locationId);
    if (!existsSync(locationDir)) return null;

    let latestDate: string | null = null;

    const yearMonths = readdirSync(locationDir);
    for (const ym of yearMonths.sort().reverse()) {
      const ymDir = join(locationDir, ym);
      const files = readdirSync(ymDir).filter(f => f.endsWith('.csv'));

      for (const file of files.sort().reverse()) {
        const date = file.replace('.csv', '');
        if (!latestDate || date > latestDate) {
          latestDate = date;
          break;
        }
      }

      if (latestDate) break;
    }

    return latestDate;
  }
}

/**
 * Create a weather service with default configuration
 */
export function createWeatherService(apiKey: string, cacheDir?: string): WeatherService {
  return new WeatherService({
    apiKey,
    cacheDir: cacheDir || join(process.cwd(), 'weather_cache'),
    locations: DEFAULT_LOCATIONS
  });
}
