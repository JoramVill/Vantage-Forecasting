import { parse } from 'csv-parse/sync';
import { readFileSync, statSync, readdirSync } from 'fs';
import { join } from 'path';
import { DateTime } from 'luxon';
import { DEMAND_DATE_FORMAT } from '../constants/index.js';

export interface DemandRecord {
  datetime: Date;
  region: string;
  demand: number;
}

export interface ParsedDemandData {
  records: DemandRecord[];
  regions: string[];
  startDate: Date;
  endDate: Date;
  filesProcessed?: number;
}

// Parse a single CSV file
function parseSingleCsv(filePath: string): {
  records: DemandRecord[];
  regions: Set<string>;
  minDate: Date | null;
  maxDate: Date | null;
} {
  const content = readFileSync(filePath, 'utf-8');
  const rows = parse(content, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true
  });

  const demandRecords: DemandRecord[] = [];
  const regions = new Set<string>();
  let minDate: Date | null = null;
  let maxDate: Date | null = null;

  for (const row of rows) {
    const dateStr = row['DateTimeEnding'];
    // Parse date in format "M/D/YYYY HH:mm"
    const dt = DateTime.fromFormat(dateStr, 'M/d/yyyy HH:mm');
    if (!dt.isValid) {
      console.warn(`Invalid date: ${dateStr}`);
      continue;
    }

    const datetime = dt.toJSDate();

    if (!minDate || datetime < minDate) minDate = datetime;
    if (!maxDate || datetime > maxDate) maxDate = datetime;

    // Parse each region column
    for (const col of Object.keys(row)) {
      if (col === 'DateTimeEnding') continue;

      regions.add(col);
      const demand = parseFloat(row[col]);

      if (!isNaN(demand)) {
        demandRecords.push({
          datetime,
          region: col,
          demand
        });
      }
    }
  }

  return { records: demandRecords, regions, minDate, maxDate };
}

// Parse a single file or all CSV files in a folder
export function parseDemandCsv(pathOrFolder: string): ParsedDemandData {
  const stat = statSync(pathOrFolder);

  if (stat.isDirectory()) {
    // Process all CSV files in the folder
    const files = readdirSync(pathOrFolder)
      .filter(f => f.toLowerCase().endsWith('.csv'))
      .map(f => join(pathOrFolder, f));

    if (files.length === 0) {
      throw new Error(`No CSV files found in folder: ${pathOrFolder}`);
    }

    const allRecords: DemandRecord[] = [];
    const allRegions = new Set<string>();
    let globalMinDate: Date | null = null;
    let globalMaxDate: Date | null = null;

    for (const file of files) {
      const { records, regions, minDate, maxDate } = parseSingleCsv(file);
      allRecords.push(...records);
      regions.forEach(r => allRegions.add(r));

      if (minDate && (!globalMinDate || minDate < globalMinDate)) {
        globalMinDate = minDate;
      }
      if (maxDate && (!globalMaxDate || maxDate > globalMaxDate)) {
        globalMaxDate = maxDate;
      }
    }

    // Remove duplicates (same datetime + region) - keep the latest value
    const uniqueMap = new Map<string, DemandRecord>();
    for (const record of allRecords) {
      const key = `${record.datetime.getTime()}_${record.region}`;
      uniqueMap.set(key, record);
    }

    const uniqueRecords = Array.from(uniqueMap.values());

    // Sort by datetime
    uniqueRecords.sort((a, b) => a.datetime.getTime() - b.datetime.getTime());

    return {
      records: uniqueRecords,
      regions: Array.from(allRegions),
      startDate: globalMinDate!,
      endDate: globalMaxDate!,
      filesProcessed: files.length
    };
  } else {
    // Single file
    const { records, regions, minDate, maxDate } = parseSingleCsv(pathOrFolder);
    return {
      records,
      regions: Array.from(regions),
      startDate: minDate!,
      endDate: maxDate!,
      filesProcessed: 1
    };
  }
}
