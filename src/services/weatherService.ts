import axios from 'axios';
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { DateTime } from 'luxon';
import { getDatabase, closeDatabase, DatabaseService } from '../database/index.js';
import { RawWeatherData } from '../types/index.js';

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

// Default locations for Philippine grid regions
export const DEFAULT_LOCATIONS: WeatherLocation[] = [
  { id: 'manila', name: 'Manila', region: 'luzon', demandColumn: 'CLUZ' },
  { id: 'cebu', name: 'Cebu City', region: 'visayas', demandColumn: 'CVIS' },
  { id: 'davao', name: 'Davao City', region: 'mindanao', demandColumn: 'CMIN' }
];

// Weather elements to fetch (matching existing format)
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
  'solarradiation',
  'solarenergy',
  'uvindex'
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
  'windspeed',
  'windspeed100',   // Wind speed at 100m (hub height)
  'winddir100',     // Wind direction at 100m
  'cloudcover',
  'solarradiation',
  'solarenergy',
  'uvindex'
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
    const url = `${this.baseUrl}${encodeURIComponent(location.name)}/${date}/${date}` +
                `?unitGroup=metric&contentType=csv&include=hours` +
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
    if (useWindElements) {
      try {
        const windUrl = `${this.baseUrl}${locationStr}/${date}/${date}` +
                        `?unitGroup=metric&contentType=csv&include=hours` +
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
                `?unitGroup=metric&contentType=csv&include=hours` +
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
    header = 'name,latitude,longitude,datetime,temp,dew,precip,windgust,windspeed,cloudcover,solarradiation,solarenergy,uvindex';
    for (const record of weatherData.records) {
      allRows.push([
        record.name,
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
   * Returns combined CSV data for all days
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
  ): Promise<{ success: boolean; data?: string; error?: string; cached: number; downloaded: number }> {
    const dates = this.getDateRange(startDate, endDate);
    const allRows: string[] = [];
    let header: string | null = null;
    let cachedCount = 0;
    let downloadedCount = 0;

    // Use standard cache key for now - 100m wind data requires premium API subscription
    // When premium access is available, the code will automatically try to fetch 100m data
    // but will fall back to standard 10m data if unavailable
    const cacheKey = cluster.clusterId;

    onProgress?.(`Fetching ${isWindCluster ? 'wind (100m)' : 'standard'} weather for cluster ${cluster.clusterId} (${cluster.name}): ${dates.length} days`);

    for (const date of dates) {
      try {
        let csvData: string | null = null;

        // Check cache first (using cacheKey which includes wind suffix)
        if (this.hasCachedData(cacheKey, date)) {
          csvData = this.readCachedData(cacheKey, date);
          cachedCount++;
        } else {
          // Download from API using coordinates
          onProgress?.(`  Downloading ${cluster.clusterId} ${date}${isWindCluster ? ' (100m wind)' : ''}...`);
          csvData = await this.downloadDayDataByCoords(
            cluster.clusterId,
            cluster.latitude,
            cluster.longitude,
            date,
            isWindCluster  // Pass flag to request extended wind elements
          );
          this.saveCacheData(cacheKey, date, csvData);
          downloadedCount++;

          // Small delay to avoid rate limiting
          await new Promise(resolve => setTimeout(resolve, 200));
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
        onProgress?.(`  Error fetching ${date}: ${error.message}`);
        // Continue with other dates
      }
    }

    if (!header || allRows.length === 0) {
      return { success: false, error: 'No weather data retrieved', cached: cachedCount, downloaded: downloadedCount };
    }

    // Combine header and all rows
    const combinedData = [header, ...allRows].join('\n');

    onProgress?.(`  ${cluster.clusterId}: ${cachedCount} cached, ${downloadedCount} downloaded`);

    return { success: true, data: combinedData, cached: cachedCount, downloaded: downloadedCount };
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

    for (const cluster of clusters) {
      const isWindCluster = windClusterIds?.has(cluster.clusterId) || false;
      const result = await this.fetchClusterWeatherData(cluster, startDate, endDate, onProgress, isWindCluster);
      if (result.success && result.data) {
        results.set(cluster.clusterId, result.data);
      }
    }

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
