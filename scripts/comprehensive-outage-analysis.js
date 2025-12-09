/**
 * Comprehensive Outage Analysis
 * - Historical analysis
 * - Last month trends
 * - Mean time of outage per region per unit type
 * - Most likely stations for unplanned outages by region
 */

import { readdirSync, readFileSync } from 'fs';
import { parse } from 'csv-parse/sync';
import { join } from 'path';
import { DateTime } from 'luxon';

const OUTAGE_DIR = 'Data Samples/Outage Events';

// Parse date from various formats
function parseDate(str) {
  if (!str) return null;

  // Clean up the string
  str = str.trim().replace(/!$/, '').trim();

  // Try various formats
  const formats = [
    'M/d/yyyy H:mm',
    'M/d/yyyy HH:mm',
    'M/d/yyyy h:mm:ss a',
    'M/d/yyyy H:mm:ss',
    'yyyy-MM-dd HH:mm:ss',
    'yyyy-MM-dd\'T\'HH:mm:ss',
    'd/M/yyyy H:mm',
    'd/M/yyyy HH:mm'
  ];

  for (const fmt of formats) {
    const dt = DateTime.fromFormat(str, fmt);
    if (dt.isValid) return dt.toJSDate();
  }

  const dt = DateTime.fromISO(str);
  if (dt.isValid) return dt.toJSDate();

  return null;
}

// Parse all outage files
function loadOutageData() {
  const files = readdirSync(OUTAGE_DIR).filter(f => f.endsWith('.csv'));
  const unplannedEvents = [];
  const detailRecords = [];
  const plannedOutages = [];

  for (const file of files) {
    const filePath = join(OUTAGE_DIR, file);
    const content = readFileSync(filePath, 'utf-8');
    let records;
    try {
      records = parse(content, { columns: true, skip_empty_lines: true, relax_column_count: true });
    } catch (e) {
      console.warn(`Warning: Could not parse ${file}: ${e.message}`);
      continue;
    }

    if (file.startsWith('Ev_')) {
      // Unplanned event summary: *EID,Type,DUID,StartTime,EndTime,Property,Capacity
      for (const r of records) {
        const eid = r['*EID'] || r['EID'] || '';
        const unitId = r['DUID'] || '';
        if (!eid || !unitId) continue;

        const startTime = parseDate(r['StartTime']);
        const endTime = parseDate(r['EndTime']);

        if (startTime) {
          unplannedEvents.push({
            eventId: eid,
            unitId: unitId,
            siteId: unitId.split('_')[0] || '',
            region: '', // Will be filled from detail records
            fuelType: '',
            startTime,
            endTime,
            capacityMW: parseFloat(r['Capacity']) || 0,
            durationMinutes: endTime && startTime ? (endTime - startTime) / (1000 * 60) : 0,
            source: file
          });
        }
      }
    } else if (file.startsWith('HistDBErr_')) {
      // Detail records: UnitID,SiteID,RegionID,MaxGen,MaxCap,MREnergy,FuelType,CapDeficit,Remarks
      for (const r of records) {
        const unitId = r['UnitID'] || '';
        if (!unitId) continue;

        // Parse date from Remarks field (e.g., "Out of Merit Outage, 11/1/2025 7:45:00 AM!")
        let startTime = null;
        const remarks = r['Remarks'] || '';
        const dateMatch = remarks.match(/(\d{1,2}\/\d{1,2}\/\d{4}\s+\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM)?)/i);
        if (dateMatch) {
          startTime = parseDate(dateMatch[1]);
        }

        detailRecords.push({
          unitId,
          siteId: r['SiteID'] || '',
          region: r['RegionID'] || '',
          fuelType: r['FuelType'] || '',
          capacityMW: parseFloat(r['MaxCap']) || 0,
          capacityDeficit: parseFloat(r['CapDeficit']) || 0,
          startTime,
          source: file
        });
      }
    }
  }

  // Load WAPOS (planned outages)
  const waposDir = join(OUTAGE_DIR, 'WAPOS');
  try {
    const waposFiles = readdirSync(waposDir).filter(f => f.endsWith('.csv'));
    for (const file of waposFiles) {
      const filePath = join(waposDir, file);
      const content = readFileSync(filePath, 'utf-8');
      let records;
      try {
        records = parse(content, { columns: true, skip_empty_lines: true, relax_column_count: true });
      } catch (e) {
        continue;
      }

      for (const r of records) {
        const unitId = r['UNIT_ID'] || r['RESOURCE_ID'] || r['RES_ID'] || '';
        if (!unitId) continue;

        const startTime = parseDate(r['START_TIME'] || r['OUTAGE_START'] || r['START_DATE']);
        const endTime = parseDate(r['END_TIME'] || r['OUTAGE_END'] || r['END_DATE']);

        if (startTime) {
          plannedOutages.push({
            unitId,
            siteId: r['SITE_ID'] || unitId.split('_')[0] || '',
            region: r['REG_ID'] || r['REGION'] || '',
            fuelType: r['FUEL_TYPE'] || '',
            startTime,
            endTime,
            capacityMW: parseFloat(r['CAPACITY']) || parseFloat(r['MW_CAPACITY']) || 0,
            durationMinutes: endTime && startTime ? (endTime - startTime) / (1000 * 60) : 0,
            type: 'planned',
            source: file
          });
        }
      }
    }
  } catch (e) {
    // WAPOS dir may not exist
  }

  // Merge events with detail records to get region/fuel info
  const detailMap = new Map();
  for (const d of detailRecords) {
    detailMap.set(d.unitId, d);
  }

  const mergedUnplanned = [];
  for (const e of unplannedEvents) {
    const detail = detailMap.get(e.unitId);
    mergedUnplanned.push({
      ...e,
      region: detail?.region || e.region || '',
      fuelType: detail?.fuelType || e.fuelType || '',
      type: 'unplanned'
    });
  }

  return { unplanned: mergedUnplanned, planned: plannedOutages, details: detailRecords };
}

// Main analysis
const { unplanned, planned, details } = loadOutageData();
const allOutages = [...unplanned, ...planned];

console.log('='.repeat(100));
console.log('                     COMPREHENSIVE OUTAGE ANALYSIS REPORT');
console.log('='.repeat(100));
console.log('');

console.log(`Loaded ${unplanned.length} unplanned events, ${planned.length} planned outages, ${details.length} detail records`);
console.log('');

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 1: HISTORICAL OVERVIEW
// ═══════════════════════════════════════════════════════════════════════════════

console.log('┌' + '─'.repeat(98) + '┐');
console.log('│' + ' SECTION 1: HISTORICAL OVERVIEW'.padEnd(98) + '│');
console.log('└' + '─'.repeat(98) + '┘');
console.log('');

const validOutages = allOutages.filter(o => o.startTime && !isNaN(o.startTime.getTime()));
if (validOutages.length === 0) {
  console.log('No valid outage records found with parseable dates.');
  console.log('Attempting to use detail records for analysis...');

  // Fall back to using detail records
  const validDetails = details.filter(d => d.region && d.fuelType);
  if (validDetails.length === 0) {
    console.log('No detail records available either.');
    process.exit(1);
  }

  console.log(`Using ${validDetails.length} detail records for analysis.`);
}

const timestamps = validOutages.map(o => o.startTime.getTime()).filter(t => !isNaN(t));
const minDate = timestamps.length > 0 ? new Date(Math.min(...timestamps)) : new Date();
const maxDate = timestamps.length > 0 ? new Date(Math.max(...timestamps)) : new Date();
const daySpan = Math.max(1, (maxDate - minDate) / (1000 * 60 * 60 * 24));

console.log(`Data Period: ${minDate.toISOString().split('T')[0]} to ${maxDate.toISOString().split('T')[0]} (${Math.round(daySpan)} days)`);
console.log('');
console.log('Overall Statistics:');
console.log(`  Total Outage Events: ${allOutages.length}`);
console.log(`    - Unplanned: ${unplanned.length}`);
console.log(`    - Planned: ${planned.length}`);
console.log(`  Average Outages per Day: ${(allOutages.length / daySpan).toFixed(2)}`);
console.log('');

// Build unit info from details
const unitInfo = new Map();
for (const d of details) {
  if (!unitInfo.has(d.unitId)) {
    unitInfo.set(d.unitId, { region: d.region, fuelType: d.fuelType, siteId: d.siteId });
  }
}

// Enrich unplanned with unit info
for (const o of unplanned) {
  if (!o.region && unitInfo.has(o.unitId)) {
    o.region = unitInfo.get(o.unitId).region;
    o.fuelType = unitInfo.get(o.unitId).fuelType;
  }
}

// By region
console.log('By Region:');
console.log('─'.repeat(80));
console.log('Region     │ Unplanned │ Planned │ Total │ Avg Duration (hrs) │ Events/Day');
console.log('─'.repeat(80));

for (const region of ['CLUZ', 'CVIS', 'CMIN']) {
  const regionUnplanned = unplanned.filter(o => o.region === region);
  const regionPlanned = planned.filter(o => o.region === region);
  const regionAll = [...regionUnplanned, ...regionPlanned];

  const withDuration = regionAll.filter(o => o.durationMinutes > 0);
  const avgDuration = withDuration.length > 0
    ? withDuration.reduce((s, o) => s + o.durationMinutes, 0) / withDuration.length / 60
    : 0;

  const eventsPerDay = regionAll.length / daySpan;

  console.log(`${region.padEnd(10)} │ ${regionUnplanned.length.toString().padStart(9)} │ ${regionPlanned.length.toString().padStart(7)} │ ${regionAll.length.toString().padStart(5)} │ ${avgDuration.toFixed(1).padStart(18)} │ ${eventsPerDay.toFixed(2).padStart(10)}`);
}
console.log('');

// By fuel type from details
console.log('By Fuel Type (from detail records):');
console.log('─'.repeat(80));
const fuelCounts = new Map();
for (const d of details) {
  if (!d.fuelType) continue;
  if (!fuelCounts.has(d.fuelType)) {
    fuelCounts.set(d.fuelType, { count: 0, units: new Set() });
  }
  fuelCounts.get(d.fuelType).count++;
  fuelCounts.get(d.fuelType).units.add(d.unitId);
}

console.log('Fuel Type       │ Records │ Unique Units');
console.log('─'.repeat(50));
for (const [fuel, data] of [...fuelCounts.entries()].sort((a, b) => b[1].count - a[1].count)) {
  console.log(`${fuel.padEnd(15)} │ ${data.count.toString().padStart(7)} │ ${data.units.size.toString().padStart(12)}`);
}
console.log('');

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 2: LAST MONTH TRENDS (November 2025)
// ═══════════════════════════════════════════════════════════════════════════════

console.log('┌' + '─'.repeat(98) + '┐');
console.log('│' + ' SECTION 2: LAST MONTH TRENDS (November 2025)'.padEnd(98) + '│');
console.log('└' + '─'.repeat(98) + '┘');
console.log('');

const nov2025Start = new Date('2025-11-01');
const nov2025End = new Date('2025-11-30T23:59:59');

const lastMonthOutages = unplanned.filter(o =>
  o.startTime && o.startTime >= nov2025Start && o.startTime <= nov2025End
);

console.log(`November 2025 Unplanned Outages: ${lastMonthOutages.length}`);
console.log('');

// Week-by-week breakdown
console.log('Weekly Breakdown:');
console.log('─'.repeat(60));
const weeks = [
  { name: 'Week 1 (Nov 1-7)', start: new Date('2025-11-01'), end: new Date('2025-11-07T23:59:59') },
  { name: 'Week 2 (Nov 8-14)', start: new Date('2025-11-08'), end: new Date('2025-11-14T23:59:59') },
  { name: 'Week 3 (Nov 15-21)', start: new Date('2025-11-15'), end: new Date('2025-11-21T23:59:59') },
  { name: 'Week 4 (Nov 22-30)', start: new Date('2025-11-22'), end: new Date('2025-11-30T23:59:59') }
];

for (const week of weeks) {
  const weekOutages = lastMonthOutages.filter(o => o.startTime >= week.start && o.startTime <= week.end);
  const byRegion = { CLUZ: 0, CVIS: 0, CMIN: 0 };
  for (const o of weekOutages) {
    if (byRegion[o.region] !== undefined) byRegion[o.region]++;
  }
  console.log(`${week.name}: ${weekOutages.length} outages (CLUZ: ${byRegion.CLUZ}, CVIS: ${byRegion.CVIS}, CMIN: ${byRegion.CMIN})`);
}
console.log('');

// Most affected units in last month
console.log('Most Affected Units (November 2025):');
console.log('─'.repeat(80));
const unitCounts = new Map();
for (const o of lastMonthOutages) {
  const key = o.unitId;
  if (!unitCounts.has(key)) {
    unitCounts.set(key, { unitId: o.unitId, region: o.region, fuelType: o.fuelType, count: 0, totalDuration: 0 });
  }
  const entry = unitCounts.get(key);
  entry.count++;
  entry.totalDuration += o.durationMinutes || 0;
}

const sortedUnits = [...unitCounts.values()].sort((a, b) => b.count - a.count).slice(0, 10);
console.log('Unit ID              │ Region │ Fuel Type │ Outages │ Total Duration (hrs)');
console.log('─'.repeat(80));
for (const u of sortedUnits) {
  console.log(`${u.unitId.padEnd(20)} │ ${(u.region || 'N/A').padEnd(6)} │ ${(u.fuelType || 'N/A').padEnd(9)} │ ${u.count.toString().padStart(7)} │ ${(u.totalDuration / 60).toFixed(1).padStart(20)}`);
}
console.log('');

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 3: MEAN TIME OF OUTAGE PER REGION PER UNIT TYPE
// ═══════════════════════════════════════════════════════════════════════════════

console.log('┌' + '─'.repeat(98) + '┐');
console.log('│' + ' SECTION 3: MEAN TIME OF OUTAGE (MTTR) - By Region and Fuel Type'.padEnd(98) + '│');
console.log('└' + '─'.repeat(98) + '┘');
console.log('');

console.log('Mean Time To Repair (MTTR) in Hours - UNPLANNED OUTAGES ONLY');
console.log('');

const regions = ['CLUZ', 'CVIS', 'CMIN'];
const fuelTypes = [...new Set(details.map(d => d.fuelType).filter(f => f))].sort();

// Build MTTR matrix
console.log('─'.repeat(100));
console.log('Fuel Type'.padEnd(15) + ' │ ' + regions.map(r => r.padStart(20)).join(' │ '));
console.log('─'.repeat(100));

const unplannedWithDuration = unplanned.filter(o => o.durationMinutes > 0 && o.region && o.fuelType);

for (const fuel of fuelTypes) {
  let row = fuel.padEnd(15) + ' │ ';
  for (const region of regions) {
    const matching = unplannedWithDuration.filter(o => o.region === region && o.fuelType === fuel);
    if (matching.length > 0) {
      const avgHours = matching.reduce((s, o) => s + o.durationMinutes, 0) / matching.length / 60;
      const cell = `${avgHours.toFixed(1)}h (n=${matching.length})`;
      row += cell.padStart(20) + ' │ ';
    } else {
      row += '-'.padStart(20) + ' │ ';
    }
  }
  console.log(row);
}
console.log('');

// Detailed breakdown
console.log('Detailed MTTR Statistics (hours):');
console.log('─'.repeat(100));
console.log('Region │ Fuel Type       │ Count │   Mean   │    Min   │    Max   │ Std Dev');
console.log('─'.repeat(100));

for (const region of regions) {
  for (const fuel of fuelTypes) {
    const matching = unplannedWithDuration.filter(o => o.region === region && o.fuelType === fuel);
    if (matching.length >= 2) {
      const durations = matching.map(o => o.durationMinutes / 60);
      const mean = durations.reduce((a, b) => a + b, 0) / durations.length;
      const min = Math.min(...durations);
      const max = Math.max(...durations);
      const variance = durations.reduce((s, d) => s + Math.pow(d - mean, 2), 0) / durations.length;
      const stdDev = Math.sqrt(variance);

      console.log(`${region.padEnd(6)} │ ${fuel.padEnd(15)} │ ${matching.length.toString().padStart(5)} │ ${mean.toFixed(1).padStart(8)} │ ${min.toFixed(1).padStart(8)} │ ${max.toFixed(1).padStart(8)} │ ${stdDev.toFixed(1).padStart(8)}`);
    }
  }
}
console.log('');

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 4: MOST LIKELY STATIONS FOR UNPLANNED OUTAGES BY REGION
// ═══════════════════════════════════════════════════════════════════════════════

console.log('┌' + '─'.repeat(98) + '┐');
console.log('│' + ' SECTION 4: HIGH-RISK STATIONS FOR UNPLANNED OUTAGES (By Region)'.padEnd(98) + '│');
console.log('└' + '─'.repeat(98) + '┘');
console.log('');

// Calculate risk score based on frequency
const stationRisk = new Map();
for (const o of unplanned) {
  const key = o.unitId;
  if (!stationRisk.has(key)) {
    stationRisk.set(key, {
      unitId: o.unitId,
      siteId: o.siteId,
      region: o.region,
      fuelType: o.fuelType,
      outageCount: 0,
      totalDurationHrs: 0,
      lastOutage: null
    });
  }
  const entry = stationRisk.get(key);
  entry.outageCount++;
  entry.totalDurationHrs += (o.durationMinutes || 0) / 60;
  if (!entry.lastOutage || (o.startTime && o.startTime > entry.lastOutage)) {
    entry.lastOutage = o.startTime;
  }
}

// Enrich with info from details
for (const [unitId, entry] of stationRisk) {
  if (!entry.region && unitInfo.has(unitId)) {
    entry.region = unitInfo.get(unitId).region;
    entry.fuelType = unitInfo.get(unitId).fuelType;
  }
}

// Calculate risk score
for (const [key, entry] of stationRisk) {
  const avgDuration = entry.outageCount > 0 ? entry.totalDurationHrs / entry.outageCount : 0;
  entry.riskScore = entry.outageCount * (1 + Math.log(1 + avgDuration));
  entry.avgDuration = avgDuration;
}

for (const region of regions) {
  console.log(`\n${'═'.repeat(50)}`);
  console.log(`  ${region} - TOP 15 HIGH-RISK STATIONS`);
  console.log(`${'═'.repeat(50)}`);
  console.log('');
  console.log('Rank │ Unit ID              │ Fuel     │ Outages │ Avg Dur(h) │ Last Outage');
  console.log('─'.repeat(85));

  const regionStations = [...stationRisk.values()]
    .filter(s => s.region === region)
    .sort((a, b) => b.outageCount - a.outageCount)
    .slice(0, 15);

  let rank = 1;
  for (const s of regionStations) {
    const lastOutageStr = s.lastOutage ? DateTime.fromJSDate(s.lastOutage).toFormat('yyyy-MM-dd') : 'N/A';
    console.log(`${rank.toString().padStart(4)} │ ${s.unitId.padEnd(20)} │ ${(s.fuelType || 'N/A').padEnd(8)} │ ${s.outageCount.toString().padStart(7)} │ ${s.avgDuration.toFixed(1).padStart(10)} │ ${lastOutageStr}`);
    rank++;
  }
}

console.log('');
console.log('');

// ═══════════════════════════════════════════════════════════════════════════════
// SUMMARY
// ═══════════════════════════════════════════════════════════════════════════════

console.log('┌' + '─'.repeat(98) + '┐');
console.log('│' + ' SUMMARY & KEY FINDINGS'.padEnd(98) + '│');
console.log('└' + '─'.repeat(98) + '┘');
console.log('');

// Top 5 riskiest overall
console.log('TOP 5 HIGHEST RISK STATIONS (ALL REGIONS):');
console.log('─'.repeat(80));
const top5Overall = [...stationRisk.values()].sort((a, b) => b.outageCount - a.outageCount).slice(0, 5);
for (let i = 0; i < top5Overall.length; i++) {
  const s = top5Overall[i];
  console.log(`${i + 1}. ${s.unitId} (${s.region || 'Unknown'}, ${s.fuelType || 'N/A'}) - ${s.outageCount} outages, ${s.avgDuration.toFixed(1)}h avg duration`);
}
console.log('');

// Key findings
console.log('KEY FINDINGS:');
console.log('─'.repeat(80));

const cluzCount = unplanned.filter(o => o.region === 'CLUZ').length;
const cvisCount = unplanned.filter(o => o.region === 'CVIS').length;
const cminCount = unplanned.filter(o => o.region === 'CMIN').length;
console.log(`1. Regional unplanned outage counts: CLUZ=${cluzCount}, CVIS=${cvisCount}, CMIN=${cminCount}`);

const fuelOutages = new Map();
for (const o of unplanned) {
  if (!o.fuelType) continue;
  fuelOutages.set(o.fuelType, (fuelOutages.get(o.fuelType) || 0) + 1);
}
const topFuel = [...fuelOutages.entries()].sort((a, b) => b[1] - a[1])[0];
if (topFuel) {
  console.log(`2. Most affected fuel type: ${topFuel[0]} with ${topFuel[1]} outages`);
}

const withDuration = unplanned.filter(o => o.durationMinutes > 0);
if (withDuration.length > 0) {
  const avgMTTR = withDuration.reduce((s, o) => s + o.durationMinutes, 0) / withDuration.length / 60;
  console.log(`3. Average MTTR across all units: ${avgMTTR.toFixed(1)} hours`);
}

const novCount = lastMonthOutages.length;
const prevMonthStart = new Date('2025-10-01');
const prevMonthEnd = new Date('2025-10-31T23:59:59');
const octOutages = unplanned.filter(o => o.startTime && o.startTime >= prevMonthStart && o.startTime <= prevMonthEnd);
const trend = novCount > octOutages.length ? 'INCREASING' : novCount < octOutages.length ? 'DECREASING' : 'STABLE';
console.log(`4. November 2025 vs October 2025: ${novCount} vs ${octOutages.length} outages (${trend})`);

console.log('');
console.log('='.repeat(100));
console.log('                              END OF REPORT');
console.log('='.repeat(100));
