/**
 * Parser for RTDHS (Real-Time Dispatch Historical Statistics) CSV files
 * These files contain interconnector flow and congestion data for the Philippine grid
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { DateTime } from 'luxon';
import {
  RawInterconnectorData,
  InterconnectorRecord,
  ParsedInterconnectorData
} from '../types/interconnector.js';

/**
 * Parse datetime in M/D/YYYY h:mm:ss AM/PM format
 */
function parseDateTime(dateStr: string): Date | null {
  if (!dateStr || dateStr.trim() === '') return null;

  // Try M/D/YYYY h:mm:ss AM/PM
  let dt = DateTime.fromFormat(dateStr.trim(), 'M/d/yyyy h:mm:ss a');
  if (dt.isValid) return dt.toJSDate();

  // Try M/D/YYYY HH:mm:ss
  dt = DateTime.fromFormat(dateStr.trim(), 'M/d/yyyy HH:mm:ss');
  if (dt.isValid) return dt.toJSDate();

  // Try M/D/YYYY format (for RUN_TIME field)
  dt = DateTime.fromFormat(dateStr.trim(), 'M/d/yyyy');
  if (dt.isValid) return dt.toJSDate();

  // Try ISO format as fallback
  dt = DateTime.fromISO(dateStr.trim());
  if (dt.isValid) return dt.toJSDate();

  return null;
}

/**
 * Parse a single RTDHS CSV file
 */
function parseSingleRTDHS(filePath: string): {
  records: InterconnectorRecord[];
  interconnectors: Set<string>;
  minDate: Date | null;
  maxDate: Date | null;
  congestionCount: Map<string, number>;
} {
  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').filter(l => l.trim());

  if (lines.length < 2) {
    return {
      records: [],
      interconnectors: new Set(),
      minDate: null,
      maxDate: null,
      congestionCount: new Map()
    };
  }

  const headers = lines[0].split(',').map(h => h.trim().toUpperCase());
  const colIdx = (name: string) => headers.indexOf(name);

  const runTimeIdx = colIdx('RUN_TIME');
  const mktTypeIdx = colIdx('MKT_TYPE');
  const timeIntervalIdx = colIdx('TIME_INTERVAL');
  const hvdcNameIdx = colIdx('HVDC_NAME');
  const congestionFlagIdx = colIdx('CONGESTION_FLAG');
  const flowFromIdx = colIdx('FLOW_FROM');
  const flowToIdx = colIdx('FLOW_TO');
  const overloadMWIdx = colIdx('OVERLOAD_MW');

  if (runTimeIdx === -1 || timeIntervalIdx === -1 || hvdcNameIdx === -1) {
    throw new Error(`Invalid RTDHS file format: ${filePath}. Missing required columns.`);
  }

  const records: InterconnectorRecord[] = [];
  const interconnectors = new Set<string>();
  const congestionCount = new Map<string, number>();
  let minDate: Date | null = null;
  let maxDate: Date | null = null;

  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(',').map(v => v.trim());

    if (values.length < headers.length - 1) continue; // Skip malformed lines

    const runTime = parseDateTime(values[runTimeIdx]);
    const timeInterval = parseDateTime(values[timeIntervalIdx]);

    if (!runTime || !timeInterval) continue;

    const hvdcName = values[hvdcNameIdx];
    const congestionFlag = values[congestionFlagIdx] as 'Y' | 'N';
    const flowFrom = parseFloat(values[flowFromIdx]);
    const flowTo = parseFloat(values[flowToIdx]);
    const overloadMWStr = overloadMWIdx !== -1 ? values[overloadMWIdx] : '';
    const overloadMW = overloadMWStr && overloadMWStr.trim() !== '' ? parseFloat(overloadMWStr) : null;

    // Validate interconnector name
    if (!['MINVIS1', 'VISLUZ1'].includes(hvdcName)) {
      // Silently skip unknown interconnectors
      continue;
    }

    // Validate flows
    if (isNaN(flowFrom) || isNaN(flowTo)) continue;

    interconnectors.add(hvdcName);

    if (!minDate || timeInterval < minDate) minDate = timeInterval;
    if (!maxDate || timeInterval > maxDate) maxDate = timeInterval;

    if (congestionFlag === 'Y') {
      congestionCount.set(hvdcName, (congestionCount.get(hvdcName) || 0) + 1);
    }

    records.push({
      runTime,
      marketType: mktTypeIdx !== -1 ? values[mktTypeIdx] : 'RTD',
      timeInterval,
      hvdcName,
      congestionFlag,
      flowFrom,
      flowTo,
      overloadMW,
      sourceFile: filePath
    });
  }

  return { records, interconnectors, minDate, maxDate, congestionCount };
}

/**
 * Main parser function - handles file or directory
 *
 * @param pathOrFolder - Path to a single RTDHS CSV file or a directory containing RTDHS files
 * @param onProgress - Optional callback for progress reporting
 * @param startDate - Optional filter for start date (for directory import)
 * @param endDate - Optional filter for end date (for directory import)
 * @returns Parsed interconnector data with statistics
 */
export function parseInterconnectorCsv(
  pathOrFolder: string,
  onProgress?: (msg: string) => void,
  startDate?: string,
  endDate?: string
): ParsedInterconnectorData {
  const stat = statSync(pathOrFolder);

  if (stat.isDirectory()) {
    // Handle directory - find all RTDHS_*.csv files
    let files = readdirSync(pathOrFolder)
      .filter(f => f.startsWith('RTDHS_') && f.endsWith('.csv'))
      .map(f => join(pathOrFolder, f));

    if (files.length === 0) {
      throw new Error(`No RTDHS_*.csv files found in ${pathOrFolder}`);
    }

    // Date filtering if provided
    if (startDate || endDate) {
      const filterStartDT = startDate ? DateTime.fromISO(startDate) : null;
      const filterEndDT = endDate ? DateTime.fromISO(endDate) : null;

      files = files.filter(f => {
        // Extract date from filename: RTDHS_YYYYMMDD.csv
        const match = f.match(/RTDHS_(\d{8})\.csv$/);
        if (!match) return true; // Include if can't parse

        const fileDateStr = match[1];
        const fileDate = DateTime.fromFormat(fileDateStr, 'yyyyMMdd');
        if (!fileDate.isValid) return true;

        if (filterStartDT && fileDate < filterStartDT) return false;
        if (filterEndDT && fileDate > filterEndDT) return false;

        return true;
      });
    }

    onProgress?.(`Found ${files.length} RTDHS files to process`);

    const allRecords: InterconnectorRecord[] = [];
    const allInterconnectors = new Set<string>();
    const congestionByInterconnector = new Map<string, number>();
    let globalMinDate: Date | null = null;
    let globalMaxDate: Date | null = null;

    for (const file of files) {
      onProgress?.(`Processing ${file}...`);
      const { records, interconnectors, minDate, maxDate, congestionCount } = parseSingleRTDHS(file);

      allRecords.push(...records);
      interconnectors.forEach(i => allInterconnectors.add(i));

      for (const [interconnector, count] of congestionCount.entries()) {
        congestionByInterconnector.set(
          interconnector,
          (congestionByInterconnector.get(interconnector) || 0) + count
        );
      }

      if (minDate && (!globalMinDate || minDate < globalMinDate)) globalMinDate = minDate;
      if (maxDate && (!globalMaxDate || maxDate > globalMaxDate)) globalMaxDate = maxDate;
    }

    // Deduplicate by datetime + run_time + interconnector
    const uniqueMap = new Map<string, InterconnectorRecord>();
    for (const record of allRecords) {
      const key = `${record.timeInterval.getTime()}_${record.runTime.getTime()}_${record.hvdcName}`;
      uniqueMap.set(key, record);
    }

    const uniqueRecords = Array.from(uniqueMap.values());
    uniqueRecords.sort((a, b) => a.timeInterval.getTime() - b.timeInterval.getTime());

    onProgress?.(`Total records: ${uniqueRecords.length} (from ${files.length} files, ${allRecords.length - uniqueRecords.length} duplicates removed)`);
    if (globalMinDate && globalMaxDate) {
      onProgress?.(`Date range: ${DateTime.fromJSDate(globalMinDate).toISODate()} to ${DateTime.fromJSDate(globalMaxDate).toISODate()}`);
    }

    return {
      records: uniqueRecords,
      interconnectors: Array.from(allInterconnectors),
      startDate: globalMinDate || new Date(),
      endDate: globalMaxDate || new Date(),
      filesProcessed: files.length,
      totalCongestionEvents: Array.from(congestionByInterconnector.values()).reduce((a, b) => a + b, 0),
      congestionByInterconnector
    };
  } else {
    // Single file
    const { records, interconnectors, minDate, maxDate, congestionCount } = parseSingleRTDHS(pathOrFolder);

    // Deduplicate
    const uniqueMap = new Map<string, InterconnectorRecord>();
    for (const record of records) {
      const key = `${record.timeInterval.getTime()}_${record.runTime.getTime()}_${record.hvdcName}`;
      uniqueMap.set(key, record);
    }

    const uniqueRecords = Array.from(uniqueMap.values());
    uniqueRecords.sort((a, b) => a.timeInterval.getTime() - b.timeInterval.getTime());

    return {
      records: uniqueRecords,
      interconnectors: Array.from(interconnectors),
      startDate: minDate || new Date(),
      endDate: maxDate || new Date(),
      filesProcessed: 1,
      totalCongestionEvents: Array.from(congestionCount.values()).reduce((a, b) => a + b, 0),
      congestionByInterconnector: congestionCount
    };
  }
}
