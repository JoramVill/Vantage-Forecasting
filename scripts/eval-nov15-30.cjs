const fs = require('fs');
const { parse } = require('csv-parse/sync');

// Read forecast
const forecastRaw = fs.readFileSync('output/cfac_nov_cfbased.csv', 'utf8');
const forecastRows = parse(forecastRaw, { columns: true });

// Read actual November data
const actualRaw = fs.readFileSync('Data Samples/Capacity Factor/MRHCFac_HIST_NOV.csv', 'utf8');
const actualRows = parse(actualRaw, { columns: true });

// Filter for Nov 15-30
const startDate = new Date('2025-11-15T00:00:00');
const endDate = new Date('2025-11-30T23:59:59');

// Get station columns (skip datetime)
const stations = Object.keys(forecastRows[0]).filter(k => k !== 'datetime' && k !== 'DateTimeEnding');

// Build actual lookup
const actualLookup = {};
for (const row of actualRows) {
  const dt = row['DateTimeEnding'] || row['datetime'];
  if (!dt) continue;

  // Parse date (format: 11/15/2025 1:00)
  const parts = dt.match(/(\d+)\/(\d+)\/(\d+)\s+(\d+):(\d+)/);
  if (!parts) continue;
  const [_, month, day, year, hour, min] = parts;
  const date = new Date(year, month-1, day, hour, min);

  if (date >= startDate && date <= endDate) {
    const key = date.toISOString();
    actualLookup[key] = row;
  }
}

// Calculate metrics per station
const metrics = {};
let totalCount = 0;
let totalError = 0;

for (const row of forecastRows) {
  const dt = row['DateTimeEnding'] || row['datetime'];
  if (!dt) continue;

  // Parse forecast datetime - handle both formats
  // Format 1: "11/15/2025 01:00" (US date format)
  // Format 2: "2025-11-15 01:00" (ISO-like)
  let date;
  const usDateParts = dt.match(/(\d+)\/(\d+)\/(\d+)\s+(\d+):(\d+)/);
  if (usDateParts) {
    const [_, month, day, year, hour, min] = usDateParts;
    date = new Date(year, month-1, day, hour, min);
  } else {
    date = new Date(dt.replace(' ', 'T') + ':00');
  }

  if (date < startDate || date > endDate) continue;

  const key = date.toISOString();
  const actual = actualLookup[key];
  if (!actual) continue;

  for (const station of stations) {
    const pred = parseFloat(row[station]);
    const act = parseFloat(actual[station]);

    if (isNaN(pred) || isNaN(act)) continue;

    if (!metrics[station]) {
      metrics[station] = { sumAbsErr: 0, sumActual: 0, sumSqErr: 0, count: 0, pairs: [] };
    }

    const err = Math.abs(pred - act);
    metrics[station].sumAbsErr += err;
    metrics[station].sumActual += act;
    metrics[station].sumSqErr += err * err;
    metrics[station].count++;
    metrics[station].pairs.push({ pred, act });
    totalCount++;
    totalError += err;
  }
}

// Calculate MAPE and RMSE per station
const results = [];
for (const [station, m] of Object.entries(metrics)) {
  if (m.count < 10) continue;

  const mae = m.sumAbsErr / m.count;
  const rmse = Math.sqrt(m.sumSqErr / m.count);
  const avgActual = m.sumActual / m.count;
  const mape = avgActual > 0.01 ? (m.sumAbsErr / m.sumActual) * 100 : null;

  results.push({ station, mape, mae, rmse, count: m.count, avgActual });
}

// Sort by station type then name
const windStations = results.filter(r => ['01BURGOS','01LAOAG','01PAGUDPUD','02DOLORES','08NABAS_W','08BVISTA'].includes(r.station));
const solarStations = results.filter(r => r.station.includes('_S') || r.station.includes('SOLAR') || ['01BOTOLAN','01CAYANGA','01CLARK','01CURIMAO','01HERMOSA','01LIMAY','01PASUQUIN','01SNMARCELINO','01SNRAFAEL','01SNTGO','03CALAMBA','03CLACA','03DASMAEHV','05CALUNG','06HELIOS','11KIBAW'].includes(r.station));
const otherStations = results.filter(r => !windStations.includes(r) && !solarStations.includes(r));

console.log('═══════════════════════════════════════════════════════════════════════════════');
console.log('         CAPACITY FACTOR EVALUATION: NOV 15-30, 2025 (Peak Enhanced)');
console.log('═══════════════════════════════════════════════════════════════════════════════');
console.log();

// Wind stations
console.log('🌬️  WIND STATIONS');
console.log('─────────────────────────────────────────────────────────────────');
console.log('Station          │ MAPE      │ MAE     │ RMSE    │ Avg Actual │ Samples');
console.log('─────────────────┼───────────┼─────────┼─────────┼────────────┼────────');
for (const r of windStations.sort((a,b) => a.station.localeCompare(b.station))) {
  const mapeStr = r.mape !== null ? r.mape.toFixed(1) + '%' : 'N/A';
  console.log(r.station.padEnd(16) + ' │ ' + mapeStr.padStart(8) + '  │ ' + r.mae.toFixed(4).padStart(7) + ' │ ' + r.rmse.toFixed(4).padStart(7) + ' │ ' + r.avgActual.toFixed(4).padStart(10) + ' │ ' + r.count);
}

// Wind average
if (windStations.length > 0) {
  const avgMape = windStations.filter(r => r.mape !== null).reduce((sum, r) => sum + r.mape, 0) / windStations.filter(r => r.mape !== null).length;
  const avgMae = windStations.reduce((sum, r) => sum + r.mae, 0) / windStations.length;
  console.log('─────────────────┼───────────┼─────────┼─────────┼────────────┼────────');
  console.log('WIND AVERAGE     │ ' + avgMape.toFixed(1).padStart(8) + '% │ ' + avgMae.toFixed(4).padStart(7) + ' │         │            │');
}

console.log();
console.log('☀️  SOLAR STATIONS (Top 10 by volume)');
console.log('─────────────────────────────────────────────────────────────────');
console.log('Station          │ MAPE      │ MAE     │ RMSE    │ Avg Actual │ Samples');
console.log('─────────────────┼───────────┼─────────┼─────────┼────────────┼────────');
const topSolar = solarStations.filter(r => r.avgActual > 0.05).sort((a,b) => b.avgActual - a.avgActual).slice(0, 10);
for (const r of topSolar) {
  const mapeStr = r.mape !== null ? r.mape.toFixed(1) + '%' : 'N/A';
  console.log(r.station.padEnd(16) + ' │ ' + mapeStr.padStart(8) + '  │ ' + r.mae.toFixed(4).padStart(7) + ' │ ' + r.rmse.toFixed(4).padStart(7) + ' │ ' + r.avgActual.toFixed(4).padStart(10) + ' │ ' + r.count);
}

// Solar average
if (solarStations.length > 0) {
  const validSolar = solarStations.filter(r => r.mape !== null && r.avgActual > 0.01);
  const avgMape = validSolar.reduce((sum, r) => sum + r.mape, 0) / validSolar.length;
  const avgMae = solarStations.reduce((sum, r) => sum + r.mae, 0) / solarStations.length;
  console.log('─────────────────┼───────────┼─────────┼─────────┼────────────┼────────');
  console.log('SOLAR AVERAGE    │ ' + avgMape.toFixed(1).padStart(8) + '% │ ' + avgMae.toFixed(4).padStart(7) + ' │         │            │ (' + validSolar.length + ' stations)');
}

console.log();
console.log('📊 OTHER STATIONS (Top 10 by volume)');
console.log('─────────────────────────────────────────────────────────────────');
console.log('Station          │ MAPE      │ MAE     │ RMSE    │ Avg Actual │ Samples');
console.log('─────────────────┼───────────┼─────────┼─────────┼────────────┼────────');
const topOther = otherStations.filter(r => r.avgActual > 0.05).sort((a,b) => b.avgActual - a.avgActual).slice(0, 10);
for (const r of topOther) {
  const mapeStr = r.mape !== null ? r.mape.toFixed(1) + '%' : 'N/A';
  console.log(r.station.padEnd(16) + ' │ ' + mapeStr.padStart(8) + '  │ ' + r.mae.toFixed(4).padStart(7) + ' │ ' + r.rmse.toFixed(4).padStart(7) + ' │ ' + r.avgActual.toFixed(4).padStart(10) + ' │ ' + r.count);
}

console.log();
console.log('═══════════════════════════════════════════════════════════════════════════════');
console.log('                              OVERALL SUMMARY');
console.log('═══════════════════════════════════════════════════════════════════════════════');
console.log('  Total comparisons: ' + totalCount);
console.log('  Period: Nov 15-30, 2025 (384 hours)');
console.log('  Wind stations: ' + windStations.length);
console.log('  Solar stations: ' + solarStations.length);
console.log('  Other stations: ' + otherStations.length);
