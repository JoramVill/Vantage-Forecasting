/**
 * Parser for outage event data files
 * Handles:
 * - Ev_*.csv (unplanned/forced outage events)
 * - HistDBErr_*.csv (outage details with capacity info)
 * - WAPOS_*.csv (planned/scheduled maintenance outages)
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join } from 'path';
import { DateTime } from 'luxon';
import {
  RawOutageEvent,
  OutageDetail,
  OutageRecord,
  ParsedOutageData,
  PlannedOutage,
  GridRegion,
  FuelType,
  OutageSeverity,
  OutageType,
  TimePeriod
} from '../types/outage.js';

/**
 * Parse a CSV line handling quoted fields
 */
function parseCSVLine(line: string): string[] {
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
 * Parse date in M/D/YYYY HH:mm format
 */
function parseDateTime(dateStr: string): Date | null {
  if (!dateStr) return null;

  // Try M/D/YYYY HH:mm format (from Ev files)
  let dt = DateTime.fromFormat(dateStr, 'M/d/yyyy HH:mm');
  if (dt.isValid) return dt.toJSDate();

  // Try M/D/YYYY h:mm:ss a format (from HistDBErr remarks)
  dt = DateTime.fromFormat(dateStr, 'M/d/yyyy h:mm:ss a');
  if (dt.isValid) return dt.toJSDate();

  // Try M/D/YYYY format (no time)
  dt = DateTime.fromFormat(dateStr, 'M/d/yyyy');
  if (dt.isValid) return dt.toJSDate();

  return null;
}

/**
 * Extract datetime from remarks field
 * Example: "Out of Merit Outage, 7/1/2025 12:00:00 AM!"
 */
function extractDateFromRemarks(remarks: string): Date | null {
  const match = remarks.match(/(\d{1,2}\/\d{1,2}\/\d{4}\s+\d{1,2}:\d{2}:\d{2}\s+[AP]M)/i);
  if (match) {
    return parseDateTime(match[1]);
  }
  return null;
}

/**
 * Determine fuel type from string
 */
function parseFuelType(fuelStr: string): FuelType {
  const upper = fuelStr.toUpperCase().trim();
  if (upper === 'COAL') return 'COAL';
  if (upper === 'CCGT' || upper === 'GAS' || upper === 'NATURAL GAS') return 'CCGT';
  if (upper === 'OIL' || upper === 'DIESEL') return 'OIL';
  if (upper === 'HYDRO') return 'HYDRO';
  if (upper === 'GEOTHERMAL') return 'GEOTHERMAL';
  if (upper === 'SOLAR') return 'SOLAR';
  if (upper === 'WIND') return 'WIND';
  if (upper === 'BIOMASS') return 'BIOMASS';
  if (upper === 'BATTERY' || upper === 'BESS') return 'BATTERY';
  return 'OTHER';
}

/**
 * Determine outage severity based on capacity lost
 */
function determineSeverity(capacityLostMW: number): OutageSeverity {
  const absCapacity = Math.abs(capacityLostMW);
  if (absCapacity < 50) return OutageSeverity.MINOR;
  if (absCapacity < 200) return OutageSeverity.MODERATE;
  if (absCapacity < 500) return OutageSeverity.MAJOR;
  return OutageSeverity.CRITICAL;
}

/**
 * Determine time period from hour
 */
function determineTimePeriod(hour: number): TimePeriod {
  if (hour >= 6 && hour < 12) return TimePeriod.MORNING;
  if (hour >= 12 && hour < 18) return TimePeriod.AFTERNOON;
  if (hour >= 18 && hour < 24) return TimePeriod.EVENING;
  return TimePeriod.NIGHT;
}

/**
 * Parse an Ev_*.csv event file
 */
export function parseEventFile(filePath: string): RawOutageEvent[] {
  const content = readFileSync(filePath, 'utf8');
  const lines = content.split('\n').filter(l => l.trim());

  if (lines.length < 2) return [];

  // Parse header (first column starts with *)
  const headers = lines[0].split(',').map(h => h.trim().toLowerCase().replace('*', ''));
  const colIdx = (name: string) => headers.indexOf(name);

  const events: RawOutageEvent[] = [];

  for (let i = 1; i < lines.length; i++) {
    const values = parseCSVLine(lines[i]);
    if (values.length < 5) continue;

    const startTime = parseDateTime(values[colIdx('starttime')]);
    const endTime = parseDateTime(values[colIdx('endtime')]);

    if (!startTime || !endTime) continue;

    events.push({
      eventId: values[colIdx('eid')] || values[0],
      type: values[colIdx('type')],
      duid: values[colIdx('duid')],
      startTime,
      endTime,
      property: values[colIdx('property')],
      capacity: parseFloat(values[colIdx('capacity')]) || 0
    });
  }

  return events;
}

/**
 * Parse a HistDBErr_*.csv detail file
 */
export function parseDetailFile(filePath: string): OutageDetail[] {
  const content = readFileSync(filePath, 'utf8');
  const lines = content.split('\n').filter(l => l.trim());

  if (lines.length < 2) return [];

  const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
  const colIdx = (name: string) => headers.indexOf(name);
  const remarksIdx = colIdx('remarks');

  const details: OutageDetail[] = [];

  for (let i = 1; i < lines.length; i++) {
    const values = parseCSVLine(lines[i]);
    if (values.length < 7) continue;

    // Remarks field may contain commas (not quoted), so join all values from remarks index onward
    const remarks = remarksIdx >= 0 ? values.slice(remarksIdx).join(', ') : '';
    const datetime = extractDateFromRemarks(remarks);

    if (!datetime) continue;

    const regionStr = values[colIdx('regionid')] || '';
    const region: GridRegion = ['CLUZ', 'CVIS', 'CMIN'].includes(regionStr)
      ? regionStr as GridRegion
      : 'CLUZ';

    details.push({
      unitId: values[colIdx('unitid')],
      siteId: values[colIdx('siteid')],
      regionId: region,
      maxGen: parseFloat(values[colIdx('maxgen')]) || 0,
      maxCap: parseFloat(values[colIdx('maxcap')]) || 0,
      mrEnergy: parseFloat(values[colIdx('mrenergy')]) || 0,
      fuelType: parseFuelType(values[colIdx('fueltype')] || 'OTHER'),
      capDeficit: parseFloat(values[colIdx('capdeficit')]) || 0,
      remarks,
      datetime
    });
  }

  return details;
}

/**
 * Merge events and details into unified outage records
 */
export function mergeOutageData(
  events: RawOutageEvent[],
  details: OutageDetail[]
): OutageRecord[] {
  const records: OutageRecord[] = [];
  const detailMap = new Map<string, OutageDetail>();

  // Index details by unitId and approximate datetime
  for (const detail of details) {
    const key = `${detail.unitId}_${DateTime.fromJSDate(detail.datetime).toFormat('yyyyMMdd')}`;
    // Keep the one with highest capacity deficit
    const existing = detailMap.get(key);
    if (!existing || Math.abs(detail.capDeficit) > Math.abs(existing.capDeficit)) {
      detailMap.set(key, detail);
    }
  }

  for (const event of events) {
    const dateKey = DateTime.fromJSDate(event.startTime).toFormat('yyyyMMdd');
    const lookupKey = `${event.duid}_${dateKey}`;
    const detail = detailMap.get(lookupKey);

    const durationMinutes = (event.endTime.getTime() - event.startTime.getTime()) / (1000 * 60);
    const dt = DateTime.fromJSDate(event.startTime);

    // Use detail info if available, otherwise infer from event
    const region: GridRegion = detail?.regionId || inferRegionFromUnit(event.duid);
    const fuelType: FuelType = detail?.fuelType || inferFuelTypeFromUnit(event.duid);
    const capacityMW = detail?.maxCap || 100; // Default estimate
    const capacityLostMW = detail ? Math.abs(detail.capDeficit) : capacityMW;

    records.push({
      eventId: event.eventId,
      unitId: event.duid,
      siteId: detail?.siteId || extractSiteId(event.duid),
      region,
      fuelType,
      outageType: OutageType.UNPLANNED,  // Ev_/HistDBErr are unplanned outages
      startTime: event.startTime,
      endTime: event.endTime,
      durationMinutes,
      capacityMW,
      capacityLostMW,
      severity: determineSeverity(capacityLostMW),
      timePeriod: determineTimePeriod(dt.hour),
      dayOfWeek: dt.weekday % 7, // Convert to 0-6 (Sunday-Saturday)
      hour: dt.hour,
      month: dt.month,
      isWeekend: dt.weekday >= 6
    });
  }

  return records;
}

/**
 * Infer region from unit ID prefix
 * Format: XX_SITE_UNN where XX is region code
 */
function inferRegionFromUnit(unitId: string): GridRegion {
  const prefix = unitId.substring(0, 2);
  const num = parseInt(prefix, 10);

  // Based on observed patterns:
  // 01-03: CLUZ (Luzon)
  // 04-08: CVIS (Visayas)
  // 10-14: CMIN (Mindanao)
  if (num >= 1 && num <= 3) return 'CLUZ';
  if (num >= 4 && num <= 8) return 'CVIS';
  if (num >= 10 && num <= 14) return 'CMIN';
  return 'CLUZ'; // Default
}

/**
 * Infer fuel type from unit naming conventions
 */
function inferFuelTypeFromUnit(unitId: string): FuelType {
  const upper = unitId.toUpperCase();
  if (upper.includes('_G0') || upper.includes('_G1')) {
    // Could be gas or coal generator
    if (upper.includes('STA-RI') || upper.includes('ILIJAN') || upper.includes('EERI')) {
      return 'CCGT';
    }
  }
  return 'COAL'; // Default for thermal plants
}

/**
 * Extract site ID from unit ID
 */
function extractSiteId(unitId: string): string {
  // Format: XXSITE_UNN -> extract XXSITE
  const parts = unitId.split('_');
  if (parts.length >= 2) {
    return parts[0];
  }
  return unitId;
}

/**
 * Parse a WAPOS_*.csv planned outage file
 * Format: RUN_TIME,RESOURCE_NAME,START_TIME,END_TIME,PARAMETER_TYPE,STATUS,
 */
export function parseWAPOSFile(filePath: string): PlannedOutage[] {
  const content = readFileSync(filePath, 'utf8');
  const lines = content.split('\n').filter(l => l.trim());

  if (lines.length < 2) return [];

  const headers = lines[0].split(',').map(h => h.trim().toLowerCase().replace(/_/g, ''));
  const colIdx = (name: string) => {
    const idx = headers.indexOf(name);
    if (idx >= 0) return idx;
    // Try alternative names
    if (name === 'runtime') return headers.indexOf('run_time') >= 0 ? headers.indexOf('run_time') : 0;
    if (name === 'resourcename') return headers.indexOf('resource_name') >= 0 ? headers.indexOf('resource_name') : 1;
    if (name === 'starttime') return headers.indexOf('start_time') >= 0 ? headers.indexOf('start_time') : 2;
    if (name === 'endtime') return headers.indexOf('end_time') >= 0 ? headers.indexOf('end_time') : 3;
    if (name === 'parametertype') return headers.indexOf('parameter_type') >= 0 ? headers.indexOf('parameter_type') : 4;
    return -1;
  };

  const outages: PlannedOutage[] = [];

  for (let i = 1; i < lines.length; i++) {
    const values = parseCSVLine(lines[i]);
    if (values.length < 5) continue;

    // Parse run time (just date, M/D/YYYY)
    const runTime = parseDateTime(values[0]);

    // Parse start/end times (can be M/D/YYYY or M/D/YYYY h:mm:ss AM/PM)
    const startTime = parseDateTime(values[2]);
    const endTime = parseDateTime(values[3]);

    if (!runTime || !startTime || !endTime) continue;

    const resourceName = values[1]?.trim();
    if (!resourceName) continue;

    outages.push({
      runTime,
      resourceName,
      startTime,
      endTime,
      parameterType: values[4]?.trim() || 'STATUS',
      status: values[5]?.trim() || 'OUT'
    });
  }

  return outages;
}

/**
 * Convert planned outages to unified OutageRecord format
 */
export function convertPlannedToRecords(plannedOutages: PlannedOutage[]): OutageRecord[] {
  const records: OutageRecord[] = [];

  // Group by resource and date range to avoid duplicates
  const uniqueOutages = new Map<string, PlannedOutage>();

  for (const outage of plannedOutages) {
    const key = `${outage.resourceName}_${outage.startTime.toISOString()}_${outage.endTime.toISOString()}`;
    // Keep the most recent runTime for duplicate outages
    const existing = uniqueOutages.get(key);
    if (!existing || outage.runTime > existing.runTime) {
      uniqueOutages.set(key, outage);
    }
  }

  let eventCounter = 0;
  for (const outage of uniqueOutages.values()) {
    const durationMinutes = (outage.endTime.getTime() - outage.startTime.getTime()) / (1000 * 60);
    const dt = DateTime.fromJSDate(outage.startTime);

    // Infer region and fuel type from unit ID
    const region = inferRegionFromUnit(outage.resourceName);
    const fuelType = inferFuelTypeFromUnit(outage.resourceName);

    // For planned outages, we estimate capacity based on duration and typical unit sizes
    const capacityMW = estimateCapacityFromUnit(outage.resourceName);

    records.push({
      eventId: `WAPOS_${++eventCounter}`,
      unitId: outage.resourceName,
      siteId: extractSiteId(outage.resourceName),
      region,
      fuelType,
      outageType: OutageType.PLANNED,
      startTime: outage.startTime,
      endTime: outage.endTime,
      durationMinutes,
      capacityMW,
      capacityLostMW: capacityMW,  // Full capacity assumed lost during planned outage
      severity: determineSeverity(capacityMW),
      timePeriod: determineTimePeriod(dt.hour),
      dayOfWeek: dt.weekday % 7,
      hour: dt.hour,
      month: dt.month,
      isWeekend: dt.weekday >= 6
    });
  }

  return records;
}

/**
 * Estimate unit capacity from naming conventions
 */
function estimateCapacityFromUnit(unitId: string): number {
  const upper = unitId.toUpperCase();

  // Large coal plants typically 300-660 MW per unit
  if (upper.includes('SLPGC') || upper.includes('PAGBILAO') || upper.includes('QUEZON')) return 350;
  if (upper.includes('ILIJAN')) return 600;
  if (upper.includes('STA-RI')) return 500;
  if (upper.includes('MASINLOC') || upper.includes('SUAL')) return 600;
  if (upper.includes('SMC') || upper.includes('CALACA')) return 300;

  // Hydro plants
  if (upper.includes('MAGAT')) return 180;
  if (upper.includes('ANGAT')) return 50;
  if (upper.includes('KALAYAAN')) return 350;
  if (upper.includes('AMBUKLAO') || upper.includes('BINGA')) return 75;

  // Visayas plants
  if (upper.includes('CEDC') || upper.includes('TOLEDO') || upper.includes('TPC')) return 80;
  if (upper.includes('THVI') || upper.includes('THERMA')) return 170;
  if (upper.includes('CPPC')) return 20;  // Smaller units

  // Mindanao plants
  if (upper.includes('FDC') || upper.includes('STEAG')) return 210;
  if (upper.includes('AGUS') || upper.includes('PULANGI')) return 50;  // Hydro
  if (upper.includes('SARANGANI') || upper.includes('SARANG')) return 100;

  // Default estimate based on unit number
  if (upper.includes('_G0') || upper.includes('_G1')) return 100;  // Gas turbine
  if (upper.includes('_U0') || upper.includes('_U1')) return 150;  // Steam unit

  return 100;  // Default
}

/**
 * Parse all outage files in a directory
 * Supports both unplanned (Ev_, HistDBErr_) and planned (WAPOS) outages
 */
export function parseOutageDirectory(
  dirPath: string,
  onProgress?: (message: string) => void,
  options?: { includeWAPOS?: boolean; waposDir?: string }
): ParsedOutageData {
  const allEvents: RawOutageEvent[] = [];
  const allDetails: OutageDetail[] = [];
  const allPlannedOutages: PlannedOutage[] = [];

  // Get all CSV files in main directory
  const files = readdirSync(dirPath).filter(f => f.endsWith('.csv'));

  onProgress?.(`Found ${files.length} CSV files to process`);

  for (const file of files) {
    const filePath = join(dirPath, file);
    const stat = statSync(filePath);

    if (!stat.isFile()) continue;

    onProgress?.(`Processing ${file}...`);

    if (file.startsWith('Ev_')) {
      // Unplanned event file
      const events = parseEventFile(filePath);
      allEvents.push(...events);
      onProgress?.(`  Parsed ${events.length} unplanned outage events`);
    } else if (file.startsWith('HistDBErr_')) {
      // Detail file
      const details = parseDetailFile(filePath);
      allDetails.push(...details);
      onProgress?.(`  Parsed ${details.length} outage details`);
    } else if (file.startsWith('WAPOS_')) {
      // Planned outage file (in case it's in the main directory)
      const planned = parseWAPOSFile(filePath);
      allPlannedOutages.push(...planned);
      onProgress?.(`  Parsed ${planned.length} planned outages`);
    }
  }

  // Check for WAPOS subdirectory
  const waposDir = options?.waposDir || join(dirPath, 'WAPOS');
  if (options?.includeWAPOS !== false && existsSync(waposDir)) {
    onProgress?.(`\nProcessing WAPOS directory...`);
    const waposFiles = readdirSync(waposDir).filter(f => f.endsWith('.csv') && f.startsWith('WAPOS_'));
    onProgress?.(`Found ${waposFiles.length} WAPOS files`);

    for (const file of waposFiles) {
      const filePath = join(waposDir, file);
      const stat = statSync(filePath);

      if (!stat.isFile()) continue;

      const planned = parseWAPOSFile(filePath);
      allPlannedOutages.push(...planned);
    }
    onProgress?.(`  Total planned outages parsed: ${allPlannedOutages.length}`);
  }

  // Merge unplanned events with details
  onProgress?.(`Merging ${allEvents.length} unplanned events with ${allDetails.length} details...`);
  const unplannedRecords = mergeOutageData(allEvents, allDetails);

  // Convert planned outages to records
  onProgress?.(`Converting ${allPlannedOutages.length} planned outages...`);
  const plannedRecords = convertPlannedToRecords(allPlannedOutages);
  onProgress?.(`  Created ${plannedRecords.length} unique planned outage records`);

  // Combine all records
  const allRecords = [...unplannedRecords, ...plannedRecords];

  // Calculate date range
  let minDate = new Date();
  let maxDate = new Date(0);

  for (const record of allRecords) {
    if (record.startTime < minDate) minDate = record.startTime;
    if (record.endTime > maxDate) maxDate = record.endTime;
  }

  // Get unique units
  const uniqueUnits = new Set(allRecords.map(r => r.unitId)).size;

  onProgress?.(`\nCreated ${allRecords.length} total outage records`);
  onProgress?.(`  Unplanned: ${unplannedRecords.length}`);
  onProgress?.(`  Planned: ${plannedRecords.length}`);
  onProgress?.(`Date range: ${DateTime.fromJSDate(minDate).toISODate()} to ${DateTime.fromJSDate(maxDate).toISODate()}`);
  onProgress?.(`Unique units: ${uniqueUnits}`);

  return {
    events: allEvents,
    details: allDetails,
    plannedOutages: allPlannedOutages,
    records: allRecords,
    dateRange: {
      start: minDate,
      end: maxDate
    },
    totalEvents: allEvents.length + plannedRecords.length,
    totalPlannedOutages: plannedRecords.length,
    totalUnplannedOutages: unplannedRecords.length,
    uniqueUnits
  };
}
