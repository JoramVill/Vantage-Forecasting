/**
 * Evaluate satellite-based solar forecast vs default forecast
 * Tests whether `include=remote` satellite irradiance improves December predictions
 */
const fs = require('fs');

// Files
const actualFile = 'Data Samples/Capacity Factor/MRHCFac_H7D1201.csv';
const defaultFile = 'output/cfac_dec_default.csv';
const satelliteFile = 'output/cfac_dec_satellite.csv';

function parseCSV(content) {
  const lines = content.split('\n').filter(l => l.trim());
  if (lines.length < 2) return { headers: [], rows: [] };
  const headers = lines[0].split(',').map(h => h.trim());
  const rows = lines.slice(1).map(l => l.split(',').map(v => v.trim()));
  return { headers, rows };
}

// Load files
const actual = parseCSV(fs.readFileSync(actualFile, 'utf-8'));
const defaultForecast = parseCSV(fs.readFileSync(defaultFile, 'utf-8'));
const satelliteForecast = parseCSV(fs.readFileSync(satelliteFile, 'utf-8'));

console.log('═══════════════════════════════════════════════════════════════════════════════');
console.log('       SATELLITE VS DEFAULT SOLAR FORECAST - December 2025');
console.log('═══════════════════════════════════════════════════════════════════════════════');
console.log('');
console.log('Default:   Uses Visual Crossing with ground-station interpolated irradiance');
console.log('Satellite: Uses Visual Crossing with include=remote (Himawari-8/9 satellite data)');
console.log('');

// Build lookup maps
function buildMap(data) {
  const map = new Map();
  for (const row of data.rows) {
    const datetime = row[0];
    for (let i = 1; i < data.headers.length; i++) {
      const cf = parseFloat(row[i]);
      if (!isNaN(cf)) {
        map.set(`${datetime}_${data.headers[i]}`, cf);
      }
    }
  }
  return map;
}

const actualMap = buildMap(actual);
const defaultMap = buildMap(defaultForecast);
const satelliteMap = buildMap(satelliteForecast);

// Calculate metrics per station
function calculateMetrics(actualM, forecastM, stationCode) {
  let sumAbsError = 0;
  let sumActual = 0;
  let sumForecast = 0;
  let count = 0;
  const hourlyActual = {};
  const hourlyForecast = {};
  const hourlyCount = {};

  for (const [key, actualCf] of actualM) {
    if (!key.endsWith(`_${stationCode}`)) continue;
    const forecastCf = forecastM.get(key);
    if (forecastCf === undefined) continue;

    const datetime = key.split('_')[0];
    const hourMatch = datetime.match(/\s+(\d+):/);
    if (!hourMatch) continue;
    const hour = parseInt(hourMatch[1], 10);
    if (hour < 6 || hour > 18) continue;
    if (actualCf < 0.01) continue;  // Skip nighttime/zero values

    sumAbsError += Math.abs(forecastCf - actualCf);
    sumActual += actualCf;
    sumForecast += forecastCf;
    count++;

    if (!hourlyActual[hour]) {
      hourlyActual[hour] = 0;
      hourlyForecast[hour] = 0;
      hourlyCount[hour] = 0;
    }
    hourlyActual[hour] += actualCf;
    hourlyForecast[hour] += forecastCf;
    hourlyCount[hour]++;
  }

  const mape = count > 0 ? (sumAbsError / sumActual) * 100 : 0;
  const avgBias = count > 0 ? ((sumForecast - sumActual) / count) * 100 : 0;

  return { mape, avgBias, count, hourlyActual, hourlyForecast, hourlyCount };
}

// Problem stations from previous analysis
const problemStations = ['01SNMANUEL_S', '06BACOLOD_S'];
const solarStations = actual.headers.filter(h => h.endsWith('_S'));

// Detailed analysis for problem stations
console.log('═══════════════════════════════════════════════════════════════════════════════');
console.log('                    PROBLEM STATIONS DETAILED COMPARISON');
console.log('═══════════════════════════════════════════════════════════════════════════════');

for (const station of problemStations) {
  const defaultMetrics = calculateMetrics(actualMap, defaultMap, station);
  const satelliteMetrics = calculateMetrics(actualMap, satelliteMap, station);

  console.log(`\n─── ${station} ───`);
  console.log('Model               | MAPE     | Avg Bias  | Samples');
  console.log('─'.repeat(55));
  console.log(`Default (ground)    | ${defaultMetrics.mape.toFixed(1).padStart(6)}%  | ${(defaultMetrics.avgBias >= 0 ? '+' : '')}${defaultMetrics.avgBias.toFixed(1).padStart(5)}% CF | ${defaultMetrics.count}`);
  console.log(`Satellite (remote)  | ${satelliteMetrics.mape.toFixed(1).padStart(6)}%  | ${(satelliteMetrics.avgBias >= 0 ? '+' : '')}${satelliteMetrics.avgBias.toFixed(1).padStart(5)}% CF | ${satelliteMetrics.count}`);

  const improvement = defaultMetrics.mape - satelliteMetrics.mape;
  if (improvement > 0) {
    console.log(`\n  ✓ Satellite IMPROVED by ${improvement.toFixed(1)}% MAPE`);
  } else if (improvement < 0) {
    console.log(`\n  ✗ Satellite WORSE by ${Math.abs(improvement).toFixed(1)}% MAPE`);
  } else {
    console.log(`\n  = No change`);
  }

  // Hourly breakdown
  console.log('\nHourly breakdown (H9-H15):');
  console.log('Hour | Actual  | Default | Satellite | Default Err | Satellite Err | Better');
  console.log('─'.repeat(75));

  for (let h = 9; h <= 15; h++) {
    if (!defaultMetrics.hourlyCount[h]) continue;

    const avgActual = defaultMetrics.hourlyActual[h] / defaultMetrics.hourlyCount[h];
    const avgDefault = defaultMetrics.hourlyForecast[h] / defaultMetrics.hourlyCount[h];
    const avgSatellite = satelliteMetrics.hourlyForecast[h] / satelliteMetrics.hourlyCount[h];

    const errDefault = Math.abs(avgDefault - avgActual);
    const errSatellite = Math.abs(avgSatellite - avgActual);

    let better = 'TIE';
    if (errSatellite < errDefault - 0.01) better = 'Satellite';
    else if (errDefault < errSatellite - 0.01) better = 'Default';

    console.log(`H${h.toString().padStart(2)} | ${(avgActual * 100).toFixed(1).padStart(5)}%  | ${(avgDefault * 100).toFixed(1).padStart(5)}%   | ${(avgSatellite * 100).toFixed(1).padStart(7)}%  | ${(errDefault * 100).toFixed(1).padStart(9)}%   | ${(errSatellite * 100).toFixed(1).padStart(11)}% | ${better}`);
  }
}

// Summary across all solar stations
console.log('\n═══════════════════════════════════════════════════════════════════════════════');
console.log('                    ALL SOLAR STATIONS SUMMARY');
console.log('═══════════════════════════════════════════════════════════════════════════════');

let totalDefaultMape = 0;
let totalSatelliteMape = 0;
let stationCount = 0;
let satelliteWins = 0;
let defaultWins = 0;
const stationResults = [];

for (const station of solarStations) {
  const defaultMetrics = calculateMetrics(actualMap, defaultMap, station);
  const satelliteMetrics = calculateMetrics(actualMap, satelliteMap, station);

  if (defaultMetrics.count < 10) continue;

  stationResults.push({
    station,
    default: defaultMetrics.mape,
    satellite: satelliteMetrics.mape,
    defaultBias: defaultMetrics.avgBias,
    satelliteBias: satelliteMetrics.avgBias
  });

  totalDefaultMape += defaultMetrics.mape;
  totalSatelliteMape += satelliteMetrics.mape;
  stationCount++;

  if (satelliteMetrics.mape < defaultMetrics.mape) satelliteWins++;
  else if (defaultMetrics.mape < satelliteMetrics.mape) defaultWins++;
}

console.log(`\nAverage MAPE across ${stationCount} solar stations:`);
console.log(`  Default (ground-station):   ${(totalDefaultMape / stationCount).toFixed(1)}%`);
console.log(`  Satellite (Himawari-8/9):   ${(totalSatelliteMape / stationCount).toFixed(1)}%`);

const overallImprovement = (totalDefaultMape - totalSatelliteMape) / stationCount;
if (overallImprovement > 0) {
  console.log(`\n  ✓ Satellite data improves overall MAPE by ${overallImprovement.toFixed(1)}%`);
} else {
  console.log(`\n  ✗ Satellite data does not improve overall MAPE (${Math.abs(overallImprovement).toFixed(1)}% worse)`);
}

console.log(`\nWin/Loss per station:`);
console.log(`  Satellite wins: ${satelliteWins} stations`);
console.log(`  Default wins:   ${defaultWins} stations`);
console.log(`  Ties:           ${stationCount - satelliteWins - defaultWins} stations`);

// Top improvements
console.log('\n─────────────────────────────────────────────────────────────────────────────');
console.log('Top 10 stations where Satellite outperforms Default:');
console.log('Station         | Default MAPE | Satellite MAPE | Improvement');
console.log('─'.repeat(65));

const improvements = stationResults
  .map(r => ({ ...r, improvement: r.default - r.satellite }))
  .sort((a, b) => b.improvement - a.improvement)
  .slice(0, 10);

for (const r of improvements) {
  const sign = r.improvement >= 0 ? '+' : '';
  console.log(`${r.station.padEnd(15)} | ${r.default.toFixed(1).padStart(10)}%  | ${r.satellite.toFixed(1).padStart(12)}%  | ${sign}${r.improvement.toFixed(1)}%`);
}

console.log('\n═══════════════════════════════════════════════════════════════════════════════');
console.log('                    CONCLUSION');
console.log('═══════════════════════════════════════════════════════════════════════════════');

if (overallImprovement > 2) {
  console.log(`\n✓ SATELLITE DATA SIGNIFICANTLY IMPROVES December solar forecasting!`);
  console.log(`  - Average MAPE reduction: ${overallImprovement.toFixed(1)}%`);
  console.log(`  - The include=remote parameter provides Himawari-8/9 satellite irradiance`);
  console.log(`  - This is more accurate than interpolated ground-station data for Philippines`);
} else if (overallImprovement > 0) {
  console.log(`\n✓ Satellite data provides modest improvement for December solar forecasting.`);
  console.log(`  - Average MAPE reduction: ${overallImprovement.toFixed(1)}%`);
} else {
  console.log(`\n✗ Satellite data does not improve December solar forecasting.`);
  console.log(`  - The issue may be elsewhere in the model (bias correction, ML residual, etc.)`);
}
console.log('');
