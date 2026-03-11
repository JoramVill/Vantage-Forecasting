import { readFileSync, writeFileSync, statSync, readdirSync } from 'fs';
import { join } from 'path';
import { DateTime } from 'luxon';
import {
  RawCapacityFactorData,
  StationMetadata,
  CFacTrainingSample,
  CFacForecastResult,
  StationType,
  getStationTypeFromCode,
  CFacWeatherFeatures
} from '../types/capacityFactor.js';
import { ClusterLocation } from './weatherService.js';

interface ClusterGroupData {
  description: string;
  stations: string[];
  referenceLocation: {
    name: string;
    latitude: number;
    longitude: number;
  };
}

interface StationsJsonData {
  metadata: any;
  stations: Record<string, Omit<StationMetadata, 'type'> & { type: string }>;
  weatherMapping?: {
    notes?: string;
    clusterGroups?: Record<string, ClusterGroupData>;
  };
}

export class CapacityFactorService {
  private stations: Map<string, StationMetadata> = new Map();
  private stationsByType: Map<StationType, string[]> = new Map();
  private clusters: Map<string, ClusterLocation> = new Map();
  private stationToCluster: Map<string, string> = new Map();

  /**
   * Load station metadata from stations.json
   */
  async loadStations(stationsJsonPath?: string): Promise<Map<string, StationMetadata>> {
    const path = stationsJsonPath || join(process.cwd(), 'src', 'data', 'stations.json');
    const content = readFileSync(path, 'utf-8');
    const data: StationsJsonData = JSON.parse(content);

    this.stations.clear();
    this.stationsByType.clear();
    this.clusters.clear();
    this.stationToCluster.clear();

    // Initialize type map
    for (const stationType of Object.values(StationType)) {
      this.stationsByType.set(stationType, []);
    }

    // Load stations
    for (const [code, stationData] of Object.entries(data.stations)) {
      // Convert string type to enum
      let type: StationType;
      switch (stationData.type.toLowerCase()) {
        case 'wind':
          type = StationType.WIND;
          break;
        case 'solar':
          type = StationType.SOLAR;
          break;
        case 'hydro':
          type = StationType.HYDRO_STORAGE;
          break;
        case 'geothermal':
          type = StationType.GEOTHERMAL;
          break;
        case 'biomass':
          type = StationType.BIOMASS;
          break;
        case 'battery':
          type = StationType.BATTERY;
          break;
        default:
          type = StationType.UNKNOWN;
      }

      const metadata: StationMetadata = {
        ...stationData,
        type
      };

      this.stations.set(code, metadata);

      // Group by type
      const typeList = this.stationsByType.get(type);
      if (typeList) {
        typeList.push(code);
      }
    }

    // Load cluster groups for weather mapping
    if (data.weatherMapping?.clusterGroups) {
      for (const [clusterId, clusterData] of Object.entries(data.weatherMapping.clusterGroups)) {
        const cluster: ClusterLocation = {
          clusterId,
          name: clusterData.referenceLocation.name,
          latitude: clusterData.referenceLocation.latitude,
          longitude: clusterData.referenceLocation.longitude,
          stationCodes: clusterData.stations
        };
        this.clusters.set(clusterId, cluster);

        // Map each station to its cluster
        for (const stationCode of clusterData.stations) {
          this.stationToCluster.set(stationCode, clusterId);
        }
      }
    }

    return this.stations;
  }

  /**
   * Parse MRHCFac CSV file (capacity factor historical data)
   * Format: DateTimeEnding,01BAKUN,01BURGOS,01CLARK,...
   * Date format: "M/d/yyyy HH:mm"
   */
  async parseCapacityFactorCSV(
    filePath: string,
    progressCallback?: (msg: string) => void
  ): Promise<RawCapacityFactorData[]> {
    progressCallback?.(`Reading capacity factor file: ${filePath}`);

    const content = readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());

    if (lines.length < 2) {
      throw new Error('CSV file is empty or has no data rows');
    }

    // Parse header
    const headerLine = lines[0];
    const headers = headerLine.split(',').map(h => h.trim());

    if (headers[0] !== 'DateTimeEnding') {
      throw new Error(`Invalid CSV format: Expected first column to be "DateTimeEnding", got "${headers[0]}"`);
    }

    // Extract station codes (all columns except DateTimeEnding)
    const stationCodes = headers.slice(1);
    progressCallback?.(`Found ${stationCodes.length} stations in capacity factor file`);

    const records: RawCapacityFactorData[] = [];
    let parseErrors = 0;

    // Parse data rows
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      const values = line.split(',').map(v => v.trim());

      // Parse datetime
      const dateStr = values[0];
      const dt = DateTime.fromFormat(dateStr, 'M/d/yyyy HH:mm');

      if (!dt.isValid) {
        parseErrors++;
        if (parseErrors <= 3) {
          progressCallback?.(`  Warning: Invalid date format: ${dateStr}`);
        }
        continue;
      }

      const datetime = dt.toJSDate();

      // Parse capacity factors for each station
      for (let j = 1; j < values.length && j <= stationCodes.length; j++) {
        const stationCode = stationCodes[j - 1];
        const cfacStr = values[j];

        if (!cfacStr || cfacStr === '') {
          // Missing value, skip
          continue;
        }

        const capacityFactor = parseFloat(cfacStr);

        if (isNaN(capacityFactor)) {
          // Invalid number, skip
          continue;
        }

        // Validate capacity factor range (0.0 to 1.0)
        if (capacityFactor < 0 || capacityFactor > 1.0) {
          progressCallback?.(`  Warning: Capacity factor out of range [0,1]: ${capacityFactor} for ${stationCode}`);
          continue;
        }

        records.push({
          datetime,
          stationCode,
          capacityFactor
        });
      }
    }

    if (parseErrors > 3) {
      progressCallback?.(`  ... and ${parseErrors - 3} more date parsing errors`);
    }

    progressCallback?.(`Parsed ${records.length} capacity factor records from ${lines.length - 1} rows`);

    return records;
  }

  /**
   * Parse multiple MRHCFac CSV files from a directory
   */
  async parseCapacityFactorDirectory(
    dirPath: string,
    progressCallback?: (msg: string) => void
  ): Promise<RawCapacityFactorData[]> {
    const stat = statSync(dirPath);

    if (!stat.isDirectory()) {
      // Single file
      return this.parseCapacityFactorCSV(dirPath, progressCallback);
    }

    // Multiple files
    const files = readdirSync(dirPath)
      .filter(f => f.toLowerCase().endsWith('.csv'))
      .map(f => join(dirPath, f));

    if (files.length === 0) {
      throw new Error(`No CSV files found in directory: ${dirPath}`);
    }

    progressCallback?.(`Found ${files.length} CSV files to process`);

    const allRecords: RawCapacityFactorData[] = [];

    for (const file of files) {
      const records = await this.parseCapacityFactorCSV(file, progressCallback);
      // Use loop instead of spread to avoid stack overflow with large arrays
      for (const record of records) {
        allRecords.push(record);
      }
    }

    // Remove duplicates (same datetime + station) - keep latest
    const uniqueMap = new Map<string, RawCapacityFactorData>();
    for (const record of allRecords) {
      const key = `${record.datetime.getTime()}_${record.stationCode}`;
      uniqueMap.set(key, record);
    }

    const uniqueRecords = Array.from(uniqueMap.values());

    // Sort by datetime
    uniqueRecords.sort((a, b) => a.datetime.getTime() - b.datetime.getTime());

    progressCallback?.(`Total unique records: ${uniqueRecords.length}`);

    return uniqueRecords;
  }

  /**
   * Get unique station codes from parsed data
   */
  getStationCodes(data: RawCapacityFactorData[]): string[] {
    const codes = new Set<string>();
    for (const record of data) {
      codes.add(record.stationCode);
    }
    return Array.from(codes).sort();
  }

  /**
   * Group capacity factor data by station
   */
  groupByStation(data: RawCapacityFactorData[]): Map<string, RawCapacityFactorData[]> {
    const grouped = new Map<string, RawCapacityFactorData[]>();

    for (const record of data) {
      if (!grouped.has(record.stationCode)) {
        grouped.set(record.stationCode, []);
      }
      grouped.get(record.stationCode)!.push(record);
    }

    // Sort each station's records by datetime
    for (const [station, records] of grouped) {
      records.sort((a, b) => a.datetime.getTime() - b.datetime.getTime());
    }

    return grouped;
  }

  /**
   * Build training samples by joining capacity factor data with weather data
   * @param cfacData - Raw capacity factor data
   * @param weatherData - Map of datetime ISO string -> weather features
   * @param progressCallback - Progress callback function
   *
   * Training data filtering:
   * - Excludes Nov 1-16 (transition period between monsoon and dry season)
   * - Applies exponential decay weighting (recent data gets higher weight)
   */
  async buildTrainingSamples(
    cfacData: RawCapacityFactorData[],
    weatherData: Map<string, CFacWeatherFeatures>,
    progressCallback?: (msg: string) => void
  ): Promise<CFacTrainingSample[]> {
    progressCallback?.('Building training samples from capacity factor and weather data');

    const samples: CFacTrainingSample[] = [];
    const grouped = this.groupByStation(cfacData);

    // Find the most recent datetime for recency weighting
    let maxTimestamp = 0;
    for (const [, records] of grouped) {
      for (const record of records) {
        const ts = record.datetime.getTime();
        if (ts > maxTimestamp) maxTimestamp = ts;
      }
    }
    const maxDate = DateTime.fromMillis(maxTimestamp);

    // Recency decay parameter: λ = 0.02 per day (half-life ≈ 35 days)
    // weight = e^(-λ × days_ago)
    // This gives: 0 days ago = 1.0, 14 days = 0.76, 30 days = 0.55, 120 days = 0.09
    const DECAY_LAMBDA = 0.02;

    let processedStations = 0;
    const totalStations = grouped.size;
    let excludedNov1to16 = 0;

    for (const [stationCode, records] of grouped) {
      processedStations++;

      // Determine station type
      const stationType = this.stations.has(stationCode)
        ? this.stations.get(stationCode)!.type
        : getStationTypeFromCode(stationCode);

      // Build index for lag calculations
      const cfacByTime = new Map<number, number>();
      for (const record of records) {
        cfacByTime.set(record.datetime.getTime(), record.capacityFactor);
      }

      // Process each record
      for (let i = 0; i < records.length; i++) {
        const record = records[i];
        const datetime = record.datetime;
        const ts = datetime.getTime();

        // Get weather data for this datetime
        const dt = DateTime.fromJSDate(datetime);

        // FILTER: Exclude Nov 1-16 (monsoon-to-dry transition period)
        // This period has inconsistent patterns that hurt model generalization
        if (dt.month === 11 && dt.day >= 1 && dt.day <= 16) {
          excludedNov1to16++;
          continue;
        }

        // Use simple format for datetime key to avoid timezone mismatches
        const weatherKey = dt.toFormat('yyyy-MM-dd HH:mm');
        const weather = weatherData.get(weatherKey);

        // Profile-based models (hydro, geothermal, biomass, battery) don't need weather
        // Only wind and solar require weather data for training
        const isWeatherDependent = stationType === StationType.WIND || stationType === StationType.SOLAR;

        if (!weather && isWeatherDependent) {
          // No weather data for weather-dependent station, skip
          continue;
        }

        // For profile-based models without weather, use dummy values (they're not used anyway)
        const effectiveWeather: CFacWeatherFeatures = weather || {
          temperature: 30,
          windSpeed: 5,
          windGust: 8,
          cloudCover: 50,
          solarRadiation: 500,
        };

        // Calculate lag features
        const lag1h = ts - 1 * 60 * 60 * 1000;
        const lag24h = ts - 24 * 60 * 60 * 1000;

        const cfacLag1h = cfacByTime.get(lag1h);
        const cfacLag24h = cfacByTime.get(lag24h);

        // Extract temporal features
        const hour = dt.hour;
        const dayOfWeek = dt.weekday % 7; // 0=Sunday
        const month = dt.month;
        const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;

        // Calculate recency weight using exponential decay
        const daysAgo = maxDate.diff(dt, 'days').days;
        const weight = Math.exp(-DECAY_LAMBDA * daysAgo);

        samples.push({
          datetime,
          stationCode,
          stationType,
          actualCFac: record.capacityFactor,
          weather: effectiveWeather,
          hour,
          dayOfWeek,
          month,
          isWeekend,
          cfacLag1h,
          cfacLag24h,
          weight
        });
      }

      if (processedStations % 10 === 0 || processedStations === totalStations) {
        progressCallback?.(`  Processed ${processedStations}/${totalStations} stations`);
      }
    }

    progressCallback?.(`Built ${samples.length} training samples (excluded ${excludedNov1to16} Nov 1-16 records)`);

    // Log weight distribution (avoid spread operator for large arrays to prevent stack overflow)
    if (samples.length > 0) {
      let minWeight = Infinity;
      let maxWeight = -Infinity;
      let sumWeight = 0;
      for (const sample of samples) {
        const w = sample.weight || 1.0;
        if (w < minWeight) minWeight = w;
        if (w > maxWeight) maxWeight = w;
        sumWeight += w;
      }
      const avgWeight = sumWeight / samples.length;
      progressCallback?.(`  Recency weights: min=${minWeight.toFixed(3)}, max=${maxWeight.toFixed(3)}, avg=${avgWeight.toFixed(3)}`);
    }

    return samples;
  }

  /**
   * Write forecast results to WESM-compatible CSV format
   * Format: DateTimeEnding,01BAKUN,01BURGOS,01CLARK,...
   */
  async writeForecastCSV(
    results: CFacForecastResult[],
    outputPath: string,
    stationCodes: string[],
    progressCallback?: (msg: string) => void
  ): Promise<void> {
    progressCallback?.(`Writing forecast results to ${outputPath}`);

    // Sort station codes to ensure consistent column order
    const sortedStations = [...stationCodes].sort();

    // Group results by datetime
    const byDatetime = new Map<number, Map<string, number>>();

    for (const result of results) {
      const ts = result.datetime.getTime();

      if (!byDatetime.has(ts)) {
        byDatetime.set(ts, new Map());
      }

      byDatetime.get(ts)!.set(result.stationCode, result.predictedCFac);
    }

    // Get sorted datetimes
    const timestamps = Array.from(byDatetime.keys()).sort((a, b) => a - b);

    // Build CSV
    const lines: string[] = [];

    // Header
    lines.push(['DateTimeEnding', ...sortedStations].join(','));

    // Data rows
    for (const ts of timestamps) {
      const dt = DateTime.fromMillis(ts);
      const dateStr = dt.toFormat('M/d/yyyy HH:mm');

      const row: string[] = [dateStr];

      const stationValues = byDatetime.get(ts)!;

      for (const station of sortedStations) {
        const cfac = stationValues.get(station);
        // Format to 4 decimal places
        row.push(cfac !== undefined ? cfac.toFixed(4) : '');
      }

      lines.push(row.join(','));
    }

    // Write to file
    const content = lines.join('\n');
    writeFileSync(outputPath, content, 'utf-8');

    progressCallback?.(`Wrote ${timestamps.length} forecast rows for ${sortedStations.length} stations`);
  }

  /**
   * Get stations by type
   */
  getStationsByType(type: StationType): string[] {
    return this.stationsByType.get(type) || [];
  }

  /**
   * Get station metadata
   */
  getStationMetadata(stationCode: string): StationMetadata | undefined {
    return this.stations.get(stationCode);
  }

  /**
   * Get all stations
   */
  getAllStations(): Map<string, StationMetadata> {
    return new Map(this.stations);
  }

  /**
   * Get statistics for a station's capacity factor data
   */
  getStationStatistics(
    data: RawCapacityFactorData[],
    stationCode: string
  ): {
    count: number;
    mean: number;
    min: number;
    max: number;
    p25: number;
    p50: number;
    p75: number;
    stdDev: number;
  } | null {
    const stationData = data.filter(r => r.stationCode === stationCode);

    if (stationData.length === 0) {
      return null;
    }

    const values = stationData.map(r => r.capacityFactor).sort((a, b) => a - b);
    const count = values.length;

    // Mean
    const mean = values.reduce((sum, v) => sum + v, 0) / count;

    // Min/Max
    const min = values[0];
    const max = values[count - 1];

    // Percentiles
    const p25 = values[Math.floor(count * 0.25)];
    const p50 = values[Math.floor(count * 0.50)];
    const p75 = values[Math.floor(count * 0.75)];

    // Standard deviation
    const variance = values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / count;
    const stdDev = Math.sqrt(variance);

    return {
      count,
      mean,
      min,
      max,
      p25,
      p50,
      p75,
      stdDev
    };
  }

  /**
   * Get all cluster locations for weather fetching
   */
  getClusters(): ClusterLocation[] {
    return Array.from(this.clusters.values());
  }

  /**
   * Get cluster ID for a station code
   */
  getClusterForStation(stationCode: string): string | undefined {
    return this.stationToCluster.get(stationCode);
  }

  /**
   * Get cluster location by ID
   */
  getCluster(clusterId: string): ClusterLocation | undefined {
    return this.clusters.get(clusterId);
  }

  /**
   * Get station-specific ClusterLocation objects for wind stations
   * Uses each station's exact coordinates instead of cluster reference location
   * This improves wind forecast accuracy since wind is highly location-sensitive
   */
  getWindStationLocations(): ClusterLocation[] {
    const windStations = this.stationsByType.get(StationType.WIND) || [];
    const locations: ClusterLocation[] = [];

    for (const stationCode of windStations) {
      const metadata = this.stations.get(stationCode);
      if (metadata?.location?.latitude && metadata?.location?.longitude) {
        locations.push({
          clusterId: `WIND_${stationCode}`,  // Use station code as cluster ID
          name: `${stationCode} (${metadata.location.municipality}, ${metadata.location.province})`,
          latitude: metadata.location.latitude,
          longitude: metadata.location.longitude,
          stationCodes: [stationCode]  // Only this one station
        });
      }
    }

    return locations;
  }

  /**
   * Get station-specific coordinates for a wind station
   */
  getStationLocation(stationCode: string): { latitude: number; longitude: number; name: string } | undefined {
    const metadata = this.stations.get(stationCode);
    if (metadata?.location?.latitude && metadata?.location?.longitude) {
      return {
        latitude: metadata.location.latitude,
        longitude: metadata.location.longitude,
        name: `${stationCode} (${metadata.location.municipality}, ${metadata.location.province})`
      };
    }
    return undefined;
  }

  /**
   * Get station-specific ClusterLocation objects for solar stations
   * Uses each station's exact coordinates instead of cluster reference location
   * This improves solar forecast accuracy since solar radiation/cloud cover is location-sensitive
   */
  getSolarStationLocations(): ClusterLocation[] {
    const solarStations = this.stationsByType.get(StationType.SOLAR) || [];
    const locations: ClusterLocation[] = [];

    for (const stationCode of solarStations) {
      const metadata = this.stations.get(stationCode);
      if (metadata?.location?.latitude && metadata?.location?.longitude) {
        locations.push({
          clusterId: `SOLAR_${stationCode}`,  // Use station code as cluster ID
          name: `${stationCode} (${metadata.location.municipality}, ${metadata.location.province})`,
          latitude: metadata.location.latitude,
          longitude: metadata.location.longitude,
          stationCodes: [stationCode]  // Only this one station
        });
      }
    }

    return locations;
  }

  /**
   * Get the number of loaded clusters
   */
  getClusterCount(): number {
    return this.clusters.size;
  }

  /**
   * Build a map of station code -> weather features from cluster weather data
   * Uses the station's cluster weather data for each station
   */
  buildStationWeatherMap(
    clusterWeatherData: Map<string, Map<string, CFacWeatherFeatures>>,
    stationCodes: string[],
    datetimeKey: string
  ): Map<string, CFacWeatherFeatures> {
    const result = new Map<string, CFacWeatherFeatures>();

    for (const stationCode of stationCodes) {
      const clusterId = this.stationToCluster.get(stationCode);
      if (clusterId) {
        const clusterData = clusterWeatherData.get(clusterId);
        if (clusterData) {
          const weather = clusterData.get(datetimeKey);
          if (weather) {
            result.set(stationCode, weather);
          }
        }
      }
    }

    return result;
  }
}

/**
 * Create a singleton instance of the capacity factor service
 */
export const capacityFactorService = new CapacityFactorService();
