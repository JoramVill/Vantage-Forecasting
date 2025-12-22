/**
 * Compare December forecast vs actual capacity factor data
 * Shows hourly profile and identifies under/over-prediction by station
 */
const fs = require('fs');
const path = require('path');

// Load actual December data
const actualFile = 'Data Samples/Capacity Factor/MRHCFac_H7D1201.csv';
const forecastFile = 'output/cfac_december_with_dec_training.csv';

function parseCSV(content) {
  const lines = content.split('\n').filter(l => l.trim());
  if (lines.length < 2) return { headers: [], rows: [] };

  const headers = lines[0].split(',').map(h => h.trim());
  const rows = [];

  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(',');
    if (values.length >= 2) {
      rows.push(values.map(v => v.trim()));
    }
  }

  return { headers, rows };
}

// Load files
const actualContent = fs.readFileSync(actualFile, 'utf-8');
const forecastContent = fs.readFileSync(forecastFile, 'utf-8');

const actual = parseCSV(actualContent);
const forecast = parseCSV(forecastContent);

console.log(`Actual file: ${actualFile}`);
console.log(`  Rows: ${actual.rows.length}, Columns: ${actual.headers.length}`);
console.log(`Forecast file: ${forecastFile}`);
console.log(`  Rows: ${forecast.rows.length}, Columns: ${forecast.headers.length}`);

// Find solar columns (ending with _S)
const actualSolarCols = actual.headers
  .map((h, i) => ({ name: h, idx: i }))
  .filter(c => c.name.endsWith('_S'));

const forecastSolarCols = forecast.headers
  .map((h, i) => ({ name: h, idx: i }))
  .filter(c => c.name.endsWith('_S'));

console.log(`\nSolar stations in actual: ${actualSolarCols.length}`);
console.log(`Solar stations in forecast: ${forecastSolarCols.length}`);

// Find common solar stations
const actualSolarNames = new Set(actualSolarCols.map(c => c.name));
const forecastSolarNames = new Set(forecastSolarCols.map(c => c.name));
const commonSolar = [...actualSolarNames].filter(n => forecastSolarNames.has(n));
console.log(`Common solar stations: ${commonSolar.length}`);

// Build lookup maps
const actualMap = new Map(); // key: "datetime_station" -> cfac
const forecastMap = new Map();

for (const row of actual.rows) {
  const datetime = row[0];
  for (const col of actualSolarCols) {
    if (row.length > col.idx) {
      const cfac = parseFloat(row[col.idx]);
      if (!isNaN(cfac) && cfac >= 0 && cfac <= 1) {
        actualMap.set(`${datetime}_${col.name}`, cfac);
      }
    }
  }
}

for (const row of forecast.rows) {
  const datetime = row[0];
  for (const col of forecastSolarCols) {
    if (row.length > col.idx) {
      const cfac = parseFloat(row[col.idx]);
      if (!isNaN(cfac) && cfac >= 0 && cfac <= 1) {
        forecastMap.set(`${datetime}_${col.name}`, cfac);
      }
    }
  }
}

console.log(`\nActual data points: ${actualMap.size}`);
console.log(`Forecast data points: ${forecastMap.size}`);

// Compare by hour
const hourlyActual = {};
const hourlyForecast = {};
const hourlyCounts = {};
for (let h = 0; h < 24; h++) {
  hourlyActual[h] = 0;
  hourlyForecast[h] = 0;
  hourlyCounts[h] = 0;
}

// Per-station comparison
const stationDiffs = new Map(); // station -> { sumDiff, count, sumActual, sumForecast }

for (const [key, actualCfac] of actualMap) {
  const forecastCfac = forecastMap.get(key);
  if (forecastCfac !== undefined) {
    const datetime = key.split('_')[0];
    const station = key.split('_').slice(1).join('_');

    // Extract hour
    const hourMatch = datetime.match(/\s+(\d+):/);
    if (hourMatch) {
      const hour = parseInt(hourMatch[1], 10);
      hourlyActual[hour] += actualCfac;
      hourlyForecast[hour] += forecastCfac;
      hourlyCounts[hour]++;
    }

    // Per-station tracking
    if (!stationDiffs.has(station)) {
      stationDiffs.set(station, { sumDiff: 0, count: 0, sumActual: 0, sumForecast: 0 });
    }
    const stats = stationDiffs.get(station);
    stats.sumDiff += (forecastCfac - actualCfac);
    stats.sumActual += actualCfac;
    stats.sumForecast += forecastCfac;
    stats.count++;
  }
}

console.log('\n=== Hourly Comparison (Forecast vs Actual December) ===');
console.log('Hour | Actual CF | Forecast CF | Diff    | %Diff');
console.log('-'.repeat(55));

for (let h = 6; h <= 18; h++) {
  if (hourlyCounts[h] > 0) {
    const avgActual = hourlyActual[h] / hourlyCounts[h];
    const avgForecast = hourlyForecast[h] / hourlyCounts[h];
    const diff = avgForecast - avgActual;
    const pctDiff = avgActual > 0 ? (diff / avgActual * 100) : 0;

    let marker = '';
    if (pctDiff < -10) marker = ' << UNDER';
    if (pctDiff > 10) marker = ' >> OVER';

    console.log(`H${h.toString().padStart(2)} | ${(avgActual * 100).toFixed(1).padStart(7)}%  | ${(avgForecast * 100).toFixed(1).padStart(7)}%   | ${(diff * 100).toFixed(2).padStart(6)}% | ${pctDiff.toFixed(1).padStart(6)}%${marker}`);
  }
}

// Station-level analysis
console.log('\n=== Station-Level Analysis ===');
console.log('Top 10 stations with LARGEST under-forecast (during daylight):');

const stationList = [...stationDiffs.entries()]
  .map(([station, stats]) => ({
    station,
    avgDiff: stats.sumDiff / stats.count,
    avgActual: stats.sumActual / stats.count,
    avgForecast: stats.sumForecast / stats.count,
    count: stats.count
  }))
  .filter(s => s.avgActual > 0.05) // Only meaningful solar output
  .sort((a, b) => a.avgDiff - b.avgDiff); // Most under-forecast first

console.log('Station         | Avg Actual | Avg Forecast | Diff     | Samples');
console.log('-'.repeat(70));

for (let i = 0; i < Math.min(10, stationList.length); i++) {
  const s = stationList[i];
  console.log(`${s.station.padEnd(15)} | ${(s.avgActual * 100).toFixed(1).padStart(8)}%  | ${(s.avgForecast * 100).toFixed(1).padStart(10)}%  | ${(s.avgDiff * 100).toFixed(2).padStart(7)}% | ${s.count}`);
}

console.log('\nTop 10 stations with LARGEST over-forecast:');
console.log('Station         | Avg Actual | Avg Forecast | Diff     | Samples');
console.log('-'.repeat(70));

const overList = stationList.slice().reverse();
for (let i = 0; i < Math.min(10, overList.length); i++) {
  const s = overList[i];
  console.log(`${s.station.padEnd(15)} | ${(s.avgActual * 100).toFixed(1).padStart(8)}%  | ${(s.avgForecast * 100).toFixed(1).padStart(10)}%  | ${(s.avgDiff * 100).toFixed(2).padStart(7)}% | ${s.count}`);
}

// Calculate total MW difference at peak (assuming 10MW average per station)
console.log('\n=== Total MW Impact (assuming 10MW avg per station) ===');
for (let h = 10; h <= 14; h++) {
  if (hourlyCounts[h] > 0) {
    const avgActual = hourlyActual[h] / hourlyCounts[h];
    const avgForecast = hourlyForecast[h] / hourlyCounts[h];
    const diff = avgForecast - avgActual;
    const numStations = commonSolar.length;
    const mwDiff = diff * 10 * numStations; // 10MW per station

    console.log(`H${h}: ${mwDiff.toFixed(1)} MW difference (${numStations} stations × 10MW × ${(diff * 100).toFixed(1)}%)`);
  }
}
