/**
 * Capacity Update Service
 * Compares IEMOP data with stations.json to detect changes in the market
 *
 * Features:
 * - Detects new stations not in our database
 * - Identifies changed capacities or operators
 * - Flags decommissioned/removed stations
 * - Generates reports for human review
 * - Can trigger LLM research for new stations
 */

import * as fs from 'fs';
import * as path from 'path';
import { IEMOPDownloadService, GenlistRecord } from './iemopDownloadService.js';
import { getStationTypeFromCode, StationType } from '../types/capacityFactor.js';

// Internal type mapping for stations.json (uses lowercase strings)
type StationTypeString = 'solar' | 'wind' | 'hydro' | 'geothermal' | 'biomass' | 'battery' | 'other' | 'unknown';

// Station data structure from stations.json
export interface StationData {
  name: string;
  type: string;
  operator: string;
  capacity_mw: number | null;
  location: {
    municipality: string;
    province: string;
    region: string;
    latitude: number;
    longitude: number;
    notes?: string;
  };
  grid: string;
  commissioned?: number;
  turbines?: number;
  turbine_model?: string;
  parent?: string;
  units?: string[];
  notes?: string;
}

export interface StationsJSON {
  metadata: {
    description: string;
    version: string;
    lastUpdated: string;
    sources: string[];
    notes: string;
  };
  stations: Record<string, StationData>;
  weatherMapping: unknown;
}

export interface CapacityChange {
  type: 'NEW_STATION' | 'REMOVED_STATION' | 'CAPACITY_CHANGE' | 'OPERATOR_CHANGE' | 'REGION_MISMATCH';
  stationCode: string;
  details: {
    old?: Partial<StationData>;
    new?: {
      region?: string;
      operator?: string;
      resources?: string[];
      capacity_mw?: number;
    };
  };
  severity: 'HIGH' | 'MEDIUM' | 'LOW';
  requiresResearch: boolean;
}

export interface UpdateReport {
  timestamp: Date;
  genlistRecordCount: number;
  uniqueStationCount: number;
  ourStationCount: number;
  changes: CapacityChange[];
  summary: {
    newStations: number;
    removedStations: number;
    capacityChanges: number;
    operatorChanges: number;
    regionMismatches: number;
  };
}

export class CapacityUpdateService {
  private downloadService: IEMOPDownloadService;
  private stationsJsonPath: string;

  constructor(cacheDir: string = './iemop_cache', stationsJsonPath?: string) {
    this.downloadService = new IEMOPDownloadService(cacheDir);
    this.stationsJsonPath = stationsJsonPath || path.join(process.cwd(), 'src', 'data', 'stations.json');
  }

  /**
   * Load stations.json
   */
  loadStationsJSON(): StationsJSON {
    const content = fs.readFileSync(this.stationsJsonPath, 'utf-8');
    return JSON.parse(content);
  }

  /**
   * Save stations.json with updates
   */
  saveStationsJSON(data: StationsJSON): void {
    // Update the lastUpdated field
    data.metadata.lastUpdated = new Date().toISOString().split('T')[0];
    fs.writeFileSync(this.stationsJsonPath, JSON.stringify(data, null, 2));
  }

  /**
   * Check for capacity updates from IEMOP
   * Downloads fresh data if cache is stale
   */
  async checkForUpdates(forceRefresh: boolean = false, verbose: boolean = false): Promise<UpdateReport> {
    // Check if we need to download fresh data
    if (forceRefresh || this.downloadService.isCacheStale('MNM', 24)) {
      if (verbose) console.log('Downloading fresh MNM data from IEMOP...');
      const result = await this.downloadService.downloadMNM('ALL', verbose);

      if (!result.success) {
        // Try to use cached data if available
        const cachedPath = this.downloadService.getCachedGenlistPath();
        if (!cachedPath) {
          throw new Error(`Failed to download MNM data and no cache available: ${result.error}`);
        }
        if (verbose) console.log('Using cached genlist data');
      }
    }

    // Load genlist data
    const genlistPath = this.downloadService.getCachedGenlistPath();
    if (!genlistPath) {
      throw new Error('No genlist.csv available');
    }

    if (verbose) console.log(`Loading genlist from: ${genlistPath}`);
    const genlistRecords = this.downloadService.parseGenlistCSV(genlistPath);

    // Load our stations.json
    const stationsJson = this.loadStationsJSON();

    // Compare and generate report
    return this.compareStations(genlistRecords, stationsJson, verbose);
  }

  /**
   * Compare IEMOP genlist with our stations.json
   */
  private compareStations(genlistRecords: GenlistRecord[], stationsJson: StationsJSON, verbose: boolean = false): UpdateReport {
    const iemopStations = this.downloadService.getUniqueStations(genlistRecords);
    const ourStations = stationsJson.stations;
    const changes: CapacityChange[] = [];

    // Check for new stations in IEMOP that we don't have
    for (const [stationCode, iemopData] of iemopStations) {
      if (!ourStations[stationCode]) {
        // New station detected!
        const stationType = this.inferStationType(stationCode, iemopData.resources);

        changes.push({
          type: 'NEW_STATION',
          stationCode,
          details: {
            new: {
              region: iemopData.region,
              operator: Array.from(iemopData.tradingParticipants).join(', '),
              resources: iemopData.resources
            }
          },
          severity: 'HIGH',
          requiresResearch: true
        });

        if (verbose) {
          console.log(`NEW STATION: ${stationCode} (${stationType}) - ${iemopData.region}`);
          console.log(`  Resources: ${iemopData.resources.length}`);
          console.log(`  Operators: ${Array.from(iemopData.tradingParticipants).join(', ')}`);
        }
      } else {
        // Station exists - check for changes
        const ourData = ourStations[stationCode];

        // Check region mismatch
        const expectedGrid = this.regionToGrid(iemopData.region);
        if (ourData.grid && expectedGrid && ourData.grid !== expectedGrid) {
          changes.push({
            type: 'REGION_MISMATCH',
            stationCode,
            details: {
              old: { grid: ourData.grid } as Partial<StationData>,
              new: { region: iemopData.region }
            },
            severity: 'MEDIUM',
            requiresResearch: false
          });

          if (verbose) {
            console.log(`REGION MISMATCH: ${stationCode} - Our grid: ${ourData.grid}, IEMOP region: ${iemopData.region}`);
          }
        }

        // Check operator changes (if we have operator info)
        if (ourData.operator && ourData.operator !== 'Unknown') {
          const iemopOperators = Array.from(iemopData.tradingParticipants);
          const operatorChanged = !iemopOperators.some(op =>
            ourData.operator.toLowerCase().includes(op.toLowerCase().split(' ')[0]) ||
            op.toLowerCase().includes(ourData.operator.toLowerCase().split(' ')[0])
          );

          if (operatorChanged && iemopOperators.length > 0) {
            changes.push({
              type: 'OPERATOR_CHANGE',
              stationCode,
              details: {
                old: { operator: ourData.operator } as Partial<StationData>,
                new: { operator: iemopOperators.join(', ') }
              },
              severity: 'LOW',
              requiresResearch: false
            });

            if (verbose) {
              console.log(`OPERATOR CHANGE: ${stationCode} - Old: ${ourData.operator}, New: ${iemopOperators.join(', ')}`);
            }
          }
        }
      }
    }

    // Check for removed stations (in our database but not in IEMOP)
    // Note: IEMOP genlist uses aggregate station codes, while our database has individual stations
    // So we skip this check as it would create false positives
    // The genlist maps resources to aggregate stations (e.g., 01CBNTUAN_S -> 01CBNTUAN)
    // Our stations.json has the specific station codes (01CBNTUAN_S) which won't appear in genlist

    // Generate summary
    const summary = {
      newStations: changes.filter(c => c.type === 'NEW_STATION').length,
      removedStations: changes.filter(c => c.type === 'REMOVED_STATION').length,
      capacityChanges: changes.filter(c => c.type === 'CAPACITY_CHANGE').length,
      operatorChanges: changes.filter(c => c.type === 'OPERATOR_CHANGE').length,
      regionMismatches: changes.filter(c => c.type === 'REGION_MISMATCH').length
    };

    return {
      timestamp: new Date(),
      genlistRecordCount: genlistRecords.length,
      uniqueStationCount: iemopStations.size,
      ourStationCount: Object.keys(ourStations).length,
      changes,
      summary
    };
  }

  /**
   * Convert IEMOP region name to our grid code
   */
  private regionToGrid(region: string): string | null {
    switch (region.toUpperCase()) {
      case 'LUZON': return 'CLUZ';
      case 'VISAYAS': return 'CVIS';
      case 'MINDANAO': return 'CMIN';
      default: return null;
    }
  }

  /**
   * Infer station type from station code and resource names
   * Returns a string type for use with stations.json
   */
  private inferStationType(stationCode: string, resources: string[]): StationTypeString {
    // First check the station code suffix using the enum function
    const enumType = getStationTypeFromCode(stationCode);
    if (enumType !== StationType.UNKNOWN) {
      // Convert enum to string
      return this.stationTypeEnumToString(enumType);
    }

    // Check resource names for clues
    const allResources = resources.join(' ').toLowerCase();

    if (allResources.includes('solar') || allResources.includes('pv')) return 'solar';
    if (allResources.includes('wind')) return 'wind';
    if (allResources.includes('hydro') || allResources.includes('hydroelectric')) return 'hydro';
    if (allResources.includes('geothermal')) return 'geothermal';
    if (allResources.includes('biomass') || allResources.includes('biogas') || allResources.includes('bagasse')) return 'biomass';
    if (allResources.includes('battery') || allResources.includes('bess')) return 'battery';

    return 'unknown';
  }

  /**
   * Convert StationType enum to string for stations.json
   */
  private stationTypeEnumToString(type: StationType): StationTypeString {
    switch (type) {
      case StationType.WIND: return 'wind';
      case StationType.SOLAR: return 'solar';
      case StationType.HYDRO_RUN_OF_RIVER:
      case StationType.HYDRO_STORAGE: return 'hydro';
      case StationType.GEOTHERMAL: return 'geothermal';
      case StationType.BIOMASS: return 'biomass';
      case StationType.BATTERY: return 'battery';
      default: return 'unknown';
    }
  }

  /**
   * Generate a human-readable report
   */
  generateReport(report: UpdateReport): string {
    const lines: string[] = [];

    lines.push('='.repeat(80));
    lines.push('CAPACITY UPDATE REPORT');
    lines.push(`Generated: ${report.timestamp.toISOString()}`);
    lines.push('='.repeat(80));
    lines.push('');
    lines.push('SUMMARY:');
    lines.push(`  IEMOP Genlist Records: ${report.genlistRecordCount}`);
    lines.push(`  Unique IEMOP Stations: ${report.uniqueStationCount}`);
    lines.push(`  Our Station Database:  ${report.ourStationCount}`);
    lines.push('');
    lines.push(`  New Stations:       ${report.summary.newStations}`);
    lines.push(`  Removed Stations:   ${report.summary.removedStations}`);
    lines.push(`  Capacity Changes:   ${report.summary.capacityChanges}`);
    lines.push(`  Operator Changes:   ${report.summary.operatorChanges}`);
    lines.push(`  Region Mismatches:  ${report.summary.regionMismatches}`);
    lines.push('');

    if (report.changes.length === 0) {
      lines.push('No changes detected - station database is up to date!');
    } else {
      lines.push('-'.repeat(80));
      lines.push('DETAILED CHANGES:');
      lines.push('-'.repeat(80));
      lines.push('');

      // Group by type
      const byType = new Map<string, CapacityChange[]>();
      for (const change of report.changes) {
        if (!byType.has(change.type)) byType.set(change.type, []);
        byType.get(change.type)!.push(change);
      }

      for (const [type, changes] of byType) {
        lines.push(`\n[${type}] (${changes.length} items)`);
        lines.push('-'.repeat(40));

        for (const change of changes) {
          lines.push(`\n  Station: ${change.stationCode}`);
          lines.push(`  Severity: ${change.severity}`);
          lines.push(`  Requires Research: ${change.requiresResearch ? 'YES' : 'NO'}`);

          if (change.details.old) {
            lines.push(`  Previous: ${JSON.stringify(change.details.old)}`);
          }
          if (change.details.new) {
            lines.push(`  Current:  ${JSON.stringify(change.details.new)}`);
          }
        }
      }
    }

    lines.push('');
    lines.push('='.repeat(80));
    lines.push('END OF REPORT');
    lines.push('='.repeat(80));

    return lines.join('\n');
  }

  /**
   * Get list of new stations that need research
   */
  getStationsRequiringResearch(report: UpdateReport): string[] {
    return report.changes
      .filter(c => c.requiresResearch && c.type === 'NEW_STATION')
      .map(c => c.stationCode);
  }

  /**
   * Add a new station to stations.json
   * This creates a placeholder entry that can be enriched with research
   */
  addNewStation(stationCode: string, data: Partial<StationData>): void {
    const stationsJson = this.loadStationsJSON();

    if (stationsJson.stations[stationCode]) {
      throw new Error(`Station ${stationCode} already exists`);
    }

    // Create placeholder with inferred data
    const type = data.type || getStationTypeFromCode(stationCode);
    const grid = data.grid || this.inferGrid(stationCode);

    stationsJson.stations[stationCode] = {
      name: data.name || `${stationCode} (Auto-detected)`,
      type: type,
      operator: data.operator || 'Unknown',
      capacity_mw: data.capacity_mw || null,
      location: data.location || {
        municipality: 'Unknown',
        province: 'Unknown',
        region: 'Unknown',
        latitude: 0,
        longitude: 0,
        notes: 'NEEDS VERIFICATION - Auto-added from IEMOP genlist'
      },
      grid: grid,
      ...data
    };

    this.saveStationsJSON(stationsJson);
  }

  /**
   * Infer grid from station code prefix
   */
  private inferGrid(stationCode: string): string {
    const prefix = stationCode.substring(0, 2);
    const num = parseInt(prefix);

    if (num >= 1 && num <= 3) return 'CLUZ';  // Luzon
    if (num >= 4 && num <= 8) return 'CVIS';  // Visayas
    if (num >= 9 && num <= 14) return 'CMIN'; // Mindanao

    return 'CLUZ'; // Default
  }

  /**
   * Generate research prompts for new stations
   * These can be used with an LLM to research station details
   */
  generateResearchPrompts(stationCodes: string[], genlistRecords: GenlistRecord[]): Map<string, string> {
    const prompts = new Map<string, string>();

    for (const code of stationCodes) {
      const records = genlistRecords.filter(r => r.stationName === code);
      const types = new Set(records.map(r => this.extractTypeFromDescription(r.description)));
      const operators = new Set(records.map(r => r.tradingParticipant).filter(Boolean));
      const region = records[0]?.regionName || 'Unknown';

      const prompt = `Research the following power plant in the Philippines:

Station Code: ${code}
Region: ${region}
Likely Type: ${Array.from(types).join(', ') || 'Unknown'}
Trading Participant(s): ${Array.from(operators).join(', ') || 'Unknown'}
Resource Units: ${records.map(r => r.resourceName).join(', ')}
Descriptions: ${records.map(r => r.description).join('; ')}

Please find:
1. Exact location (municipality, province, latitude, longitude)
2. Type of plant (solar, wind, hydro, geothermal, biomass, battery, etc.)
3. Installed capacity in MW
4. Year commissioned (if available)
5. Operator/Owner company
6. Any additional technical details (number of turbines, panel type, etc.)

Format the response as JSON matching this structure:
{
  "name": "Full plant name",
  "type": "solar|wind|hydro|geothermal|biomass|battery|other",
  "operator": "Company name",
  "capacity_mw": number or null,
  "location": {
    "municipality": "City/Municipality",
    "province": "Province",
    "region": "Region (e.g., Region IV-A)",
    "latitude": number,
    "longitude": number
  },
  "grid": "CLUZ|CVIS|CMIN",
  "commissioned": year or null
}`;

      prompts.set(code, prompt);
    }

    return prompts;
  }

  /**
   * Extract plant type from description
   */
  private extractTypeFromDescription(description: string): string {
    const desc = description.toLowerCase();

    if (desc.includes('solar') || desc.includes('pv')) return 'solar';
    if (desc.includes('wind')) return 'wind';
    if (desc.includes('hydro')) return 'hydro';
    if (desc.includes('geothermal')) return 'geothermal';
    if (desc.includes('biomass') || desc.includes('biogas') || desc.includes('bagasse')) return 'biomass';
    if (desc.includes('battery') || desc.includes('bess')) return 'battery';
    if (desc.includes('coal')) return 'coal';
    if (desc.includes('diesel') || desc.includes('bunker')) return 'diesel';
    if (desc.includes('natural gas') || desc.includes('combined cycle')) return 'gas';

    return 'unknown';
  }
}

// Export singleton
export const capacityUpdateService = new CapacityUpdateService();
