/**
 * Compare three solar model approaches for December:
 * 1. Default (Physics+ML Hybrid)
 * 2. Physics-Only (no ML residual)
 * 3. Weather-Confidence (scales ML residual by weather confidence)
 */
const fs = require('fs');
const path = require('path');

// Files to compare
const actualFile = 'Data Samples/Capacity Factor/MRHCFac_H7D1201.csv';
const defaultFile = 'output/cfac_dec_default.csv';
const physicsOnlyFile = 'output/cfac_dec_physics_only.csv';
const weatherConfFile = 'output/cfac_dec_weather_conf.csv';

function parseCSV(content) {
  const lines = content.split('\n').filter(l => l.trim());
  if (lines.length < 2) return { headers: [], rows: [] };
  const headers = lines[0].split(',').map(h => h.trim());
  const rows = lines.slice(1).map(l => l.split(',').map(v => v.trim()));
  return { headers, rows };
}

// Load all files
const actual = parseCSV(fs.readFileSync(actualFile, 'utf-8'));
const defaultForecast = parseCSV(fs.readFileSync(defaultFile, 'utf-8'));
const physicsOnly = parseCSV(fs.readFileSync(physicsOnlyFile, 'utf-8'));
const weatherConf = parseCSV(fs.readFileSync(weatherConfFile, 'utf-8'));

// Problem stations to focus on
const problemStations = ['01SNMANUEL_S', '06BACOLOD_S'];

// Also check all solar stations
const solarStations = actual.headers.filter(h => h.endsWith('_S'));

console.log('═══════════════════════════════════════════════════════════════════════════════');
console.log('          SOLAR MODEL COMPARISON - December 1-7, 2025');
console.log('═══════════════════════════════════════════════════════════════════════════════');
console.log('');
console.log('Comparing three approaches:');
console.log('  1. Default:          Physics+ML Hybrid (ML residual trained on wet season)');
console.log('  2. Physics-Only:     Physics model + bias correction (no ML residual)');
console.log('  3. Weather-Conf:     Physics+ML with weather-confidence scaled residual');
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
const physicsOnlyMap = buildMap(physicsOnly);
const weatherConfMap = buildMap(weatherConf);

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

// Compare problem stations in detail
console.log('═══════════════════════════════════════════════════════════════════════════════');
console.log('                    PROBLEM STATIONS DETAILED ANALYSIS');
console.log('═══════════════════════════════════════════════════════════════════════════════');

for (const station of problemStations) {
  const defaultMetrics = calculateMetrics(actualMap, defaultMap, station);
  const physicsMetrics = calculateMetrics(actualMap, physicsOnlyMap, station);
  const weatherMetrics = calculateMetrics(actualMap, weatherConfMap, station);

  console.log(`\n─── ${station} ───`);
  console.log('Model               | MAPE     | Avg Bias  | Samples');
  console.log('─'.repeat(55));
  console.log(`Default (ML Hybrid) | ${defaultMetrics.mape.toFixed(1).padStart(6)}%  | ${(defaultMetrics.avgBias >= 0 ? '+' : '')}${defaultMetrics.avgBias.toFixed(1).padStart(5)}% CF | ${defaultMetrics.count}`);
  console.log(`Physics-Only        | ${physicsMetrics.mape.toFixed(1).padStart(6)}%  | ${(physicsMetrics.avgBias >= 0 ? '+' : '')}${physicsMetrics.avgBias.toFixed(1).padStart(5)}% CF | ${physicsMetrics.count}`);
  console.log(`Weather-Confidence  | ${weatherMetrics.mape.toFixed(1).padStart(6)}%  | ${(weatherMetrics.avgBias >= 0 ? '+' : '')}${weatherMetrics.avgBias.toFixed(1).padStart(5)}% CF | ${weatherMetrics.count}`);

  // Hourly breakdown
  console.log('\nHourly breakdown (H9-H15):');
  console.log('Hour | Actual  | Default | Physics | Weather | Best Model');
  console.log('─'.repeat(60));

  for (let h = 9; h <= 15; h++) {
    if (!defaultMetrics.hourlyCount[h]) continue;

    const avgActual = defaultMetrics.hourlyActual[h] / defaultMetrics.hourlyCount[h];
    const avgDefault = defaultMetrics.hourlyForecast[h] / defaultMetrics.hourlyCount[h];
    const avgPhysics = physicsMetrics.hourlyForecast[h] / physicsMetrics.hourlyCount[h];
    const avgWeather = weatherMetrics.hourlyForecast[h] / weatherMetrics.hourlyCount[h];

    const errDefault = Math.abs(avgDefault - avgActual);
    const errPhysics = Math.abs(avgPhysics - avgActual);
    const errWeather = Math.abs(avgWeather - avgActual);

    let best = 'Default';
    if (errPhysics <= errDefault && errPhysics <= errWeather) best = 'Physics';
    else if (errWeather <= errDefault && errWeather <= errPhysics) best = 'Weather';

    console.log(`H${h.toString().padStart(2)} | ${(avgActual * 100).toFixed(1).padStart(5)}%  | ${(avgDefault * 100).toFixed(1).padStart(5)}%  | ${(avgPhysics * 100).toFixed(1).padStart(5)}%  | ${(avgWeather * 100).toFixed(1).padStart(5)}%  | ${best}`);
  }
}

// Summary across all solar stations
console.log('\n═══════════════════════════════════════════════════════════════════════════════');
console.log('                    ALL SOLAR STATIONS SUMMARY');
console.log('═══════════════════════════════════════════════════════════════════════════════');

let totalDefaultMape = 0;
let totalPhysicsMape = 0;
let totalWeatherMape = 0;
let stationCount = 0;

const stationResults = [];

for (const station of solarStations) {
  const defaultMetrics = calculateMetrics(actualMap, defaultMap, station);
  const physicsMetrics = calculateMetrics(actualMap, physicsOnlyMap, station);
  const weatherMetrics = calculateMetrics(actualMap, weatherConfMap, station);

  if (defaultMetrics.count < 10) continue;

  stationResults.push({
    station,
    default: defaultMetrics.mape,
    physics: physicsMetrics.mape,
    weather: weatherMetrics.mape,
    defaultBias: defaultMetrics.avgBias,
    physicsBias: physicsMetrics.avgBias,
    weatherBias: weatherMetrics.avgBias
  });

  totalDefaultMape += defaultMetrics.mape;
  totalPhysicsMape += physicsMetrics.mape;
  totalWeatherMape += weatherMetrics.mape;
  stationCount++;
}

console.log(`\nAverage MAPE across ${stationCount} solar stations:`);
console.log(`  Default (ML Hybrid):     ${(totalDefaultMape / stationCount).toFixed(1)}%`);
console.log(`  Physics-Only:            ${(totalPhysicsMape / stationCount).toFixed(1)}%`);
console.log(`  Weather-Confidence:      ${(totalWeatherMape / stationCount).toFixed(1)}%`);

// Find best model per station
let defaultWins = 0, physicsWins = 0, weatherWins = 0;
for (const r of stationResults) {
  if (r.default <= r.physics && r.default <= r.weather) defaultWins++;
  else if (r.physics <= r.default && r.physics <= r.weather) physicsWins++;
  else weatherWins++;
}

console.log(`\nBest model per station:`);
console.log(`  Default wins:            ${defaultWins} stations`);
console.log(`  Physics-Only wins:       ${physicsWins} stations`);
console.log(`  Weather-Confidence wins: ${weatherWins} stations`);

// Top 10 stations where physics-only wins by most
console.log('\n─────────────────────────────────────────────────────────────────────────────');
console.log('Top 10 stations where Physics-Only outperforms Default:');
console.log('Station         | Default MAPE | Physics MAPE | Improvement');
console.log('─'.repeat(60));

const physicsImprovements = stationResults
  .map(r => ({ ...r, improvement: r.default - r.physics }))
  .sort((a, b) => b.improvement - a.improvement)
  .slice(0, 10);

for (const r of physicsImprovements) {
  console.log(`${r.station.padEnd(15)} | ${r.default.toFixed(1).padStart(10)}%  | ${r.physics.toFixed(1).padStart(10)}%  | ${(r.improvement >= 0 ? '+' : '')}${r.improvement.toFixed(1)}%`);
}

console.log('\n═══════════════════════════════════════════════════════════════════════════════');
console.log('                    CONCLUSION');
console.log('═══════════════════════════════════════════════════════════════════════════════');

const avgDefault = totalDefaultMape / stationCount;
const avgPhysics = totalPhysicsMape / stationCount;
const avgWeather = totalWeatherMape / stationCount;

if (avgPhysics < avgDefault && avgPhysics < avgWeather) {
  console.log(`\nPhysics-Only model is BEST for December forecasting!`);
  console.log(`  - MAPE improvement over Default: ${(avgDefault - avgPhysics).toFixed(1)}%`);
  console.log(`  - This confirms that the ML residual learned wet-season patterns`);
  console.log(`    that don't apply to dry-season December.`);
} else if (avgWeather < avgDefault && avgWeather < avgPhysics) {
  console.log(`\nWeather-Confidence model is BEST for December forecasting!`);
  console.log(`  - MAPE improvement over Default: ${(avgDefault - avgWeather).toFixed(1)}%`);
  console.log(`  - The adaptive ML weighting helps when weather is confident.`);
} else {
  console.log(`\nDefault ML Hybrid remains competitive.`);
  console.log(`  - Consider using Physics-Only for stations with large seasonal swings.`);
}
console.log('');
