/**
 * Compare Seasonal Adaptive solar model vs Default and other approaches
 * Tests whether the seasonal adaptive (dry/wet ML models) improves December predictions
 */
const fs = require('fs');

// Files to compare
const actualFile = 'Data Samples/Capacity Factor/MRHCFac_H7D1201.csv';
const defaultFile = 'output/cfac_dec_default.csv';
const seasonalAdaptiveFile = 'output/cfac_dec_seasonal_adaptive.csv';
const physicsOnlyFile = 'output/cfac_dec_physics_only.csv';

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
const seasonalAdaptive = parseCSV(fs.readFileSync(seasonalAdaptiveFile, 'utf-8'));
let physicsOnly = null;
try {
  physicsOnly = parseCSV(fs.readFileSync(physicsOnlyFile, 'utf-8'));
} catch (e) {
  console.log('Note: Physics-only file not found, skipping that comparison');
}

// Problem stations from previous analysis
const problemStations = ['01SNMANUEL_S', '06BACOLOD_S'];
const solarStations = actual.headers.filter(h => h.endsWith('_S'));

console.log('═══════════════════════════════════════════════════════════════════════════════');
console.log('       SEASONAL ADAPTIVE VS DEFAULT - December 1-7, 2025');
console.log('═══════════════════════════════════════════════════════════════════════════════');
console.log('');
console.log('Default:          Full ML residual (trained on all data including wet season)');
console.log('Seasonal Adaptive: Separate dry/wet ML models, reduced ML weight in dry season');
console.log('Physics-Only:     Physics model + bias correction (no ML residual)');
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
const seasonalMap = buildMap(seasonalAdaptive);
const physicsMap = physicsOnly ? buildMap(physicsOnly) : null;

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

// Detailed analysis for problem stations
console.log('═══════════════════════════════════════════════════════════════════════════════');
console.log('                    PROBLEM STATIONS DETAILED COMPARISON');
console.log('═══════════════════════════════════════════════════════════════════════════════');

for (const station of problemStations) {
  const defaultMetrics = calculateMetrics(actualMap, defaultMap, station);
  const seasonalMetrics = calculateMetrics(actualMap, seasonalMap, station);
  const physicsMetrics = physicsMap ? calculateMetrics(actualMap, physicsMap, station) : null;

  console.log(`\n─── ${station} ───`);
  console.log('Model                | MAPE     | Avg Bias  | Samples');
  console.log('─'.repeat(55));
  console.log(`Default (full ML)    | ${defaultMetrics.mape.toFixed(1).padStart(6)}%  | ${(defaultMetrics.avgBias >= 0 ? '+' : '')}${defaultMetrics.avgBias.toFixed(1).padStart(5)}% CF | ${defaultMetrics.count}`);
  console.log(`Seasonal Adaptive    | ${seasonalMetrics.mape.toFixed(1).padStart(6)}%  | ${(seasonalMetrics.avgBias >= 0 ? '+' : '')}${seasonalMetrics.avgBias.toFixed(1).padStart(5)}% CF | ${seasonalMetrics.count}`);
  if (physicsMetrics) {
    console.log(`Physics-Only         | ${physicsMetrics.mape.toFixed(1).padStart(6)}%  | ${(physicsMetrics.avgBias >= 0 ? '+' : '')}${physicsMetrics.avgBias.toFixed(1).padStart(5)}% CF | ${physicsMetrics.count}`);
  }

  const improvement = defaultMetrics.mape - seasonalMetrics.mape;
  if (improvement > 0) {
    console.log(`\n  ✓ Seasonal Adaptive IMPROVED by ${improvement.toFixed(1)}% MAPE`);
  } else if (improvement < 0) {
    console.log(`\n  ✗ Seasonal Adaptive WORSE by ${Math.abs(improvement).toFixed(1)}% MAPE`);
  } else {
    console.log(`\n  = No change`);
  }

  // Hourly breakdown
  console.log('\nHourly breakdown (H9-H15):');
  console.log('Hour | Actual  | Default | Seasonal | Default Err | Seasonal Err | Better');
  console.log('─'.repeat(75));

  for (let h = 9; h <= 15; h++) {
    if (!defaultMetrics.hourlyCount[h]) continue;

    const avgActual = defaultMetrics.hourlyActual[h] / defaultMetrics.hourlyCount[h];
    const avgDefault = defaultMetrics.hourlyForecast[h] / defaultMetrics.hourlyCount[h];
    const avgSeasonal = seasonalMetrics.hourlyForecast[h] / seasonalMetrics.hourlyCount[h];

    const errDefault = Math.abs(avgDefault - avgActual);
    const errSeasonal = Math.abs(avgSeasonal - avgActual);

    let better = 'TIE';
    if (errSeasonal < errDefault - 0.01) better = 'Seasonal';
    else if (errDefault < errSeasonal - 0.01) better = 'Default';

    console.log(`H${h.toString().padStart(2)} | ${(avgActual * 100).toFixed(1).padStart(5)}%  | ${(avgDefault * 100).toFixed(1).padStart(5)}%   | ${(avgSeasonal * 100).toFixed(1).padStart(6)}%   | ${(errDefault * 100).toFixed(1).padStart(9)}%   | ${(errSeasonal * 100).toFixed(1).padStart(10)}% | ${better}`);
  }
}

// Summary across all solar stations
console.log('\n═══════════════════════════════════════════════════════════════════════════════');
console.log('                    ALL SOLAR STATIONS SUMMARY');
console.log('═══════════════════════════════════════════════════════════════════════════════');

let totalDefaultMape = 0;
let totalSeasonalMape = 0;
let totalPhysicsMape = 0;
let stationCount = 0;
let seasonalWins = 0;
let defaultWins = 0;
const stationResults = [];

for (const station of solarStations) {
  const defaultMetrics = calculateMetrics(actualMap, defaultMap, station);
  const seasonalMetrics = calculateMetrics(actualMap, seasonalMap, station);
  const physicsMetrics = physicsMap ? calculateMetrics(actualMap, physicsMap, station) : null;

  if (defaultMetrics.count < 10) continue;

  stationResults.push({
    station,
    default: defaultMetrics.mape,
    seasonal: seasonalMetrics.mape,
    physics: physicsMetrics ? physicsMetrics.mape : 0,
    defaultBias: defaultMetrics.avgBias,
    seasonalBias: seasonalMetrics.avgBias
  });

  totalDefaultMape += defaultMetrics.mape;
  totalSeasonalMape += seasonalMetrics.mape;
  if (physicsMetrics) totalPhysicsMape += physicsMetrics.mape;
  stationCount++;

  if (seasonalMetrics.mape < defaultMetrics.mape) seasonalWins++;
  else if (defaultMetrics.mape < seasonalMetrics.mape) defaultWins++;
}

console.log(`\nAverage MAPE across ${stationCount} solar stations:`);
console.log(`  Default (full ML):       ${(totalDefaultMape / stationCount).toFixed(1)}%`);
console.log(`  Seasonal Adaptive:       ${(totalSeasonalMape / stationCount).toFixed(1)}%`);
if (physicsMap) {
  console.log(`  Physics-Only:            ${(totalPhysicsMape / stationCount).toFixed(1)}%`);
}

const overallImprovement = (totalDefaultMape - totalSeasonalMape) / stationCount;
if (overallImprovement > 0) {
  console.log(`\n  ✓ Seasonal Adaptive improves overall MAPE by ${overallImprovement.toFixed(1)}%`);
} else {
  console.log(`\n  ✗ Seasonal Adaptive does not improve overall MAPE (${Math.abs(overallImprovement).toFixed(1)}% worse)`);
}

console.log(`\nWin/Loss per station:`);
console.log(`  Seasonal wins: ${seasonalWins} stations`);
console.log(`  Default wins:  ${defaultWins} stations`);
console.log(`  Ties:          ${stationCount - seasonalWins - defaultWins} stations`);

// Top improvements
console.log('\n─────────────────────────────────────────────────────────────────────────────');
console.log('Top 10 stations where Seasonal Adaptive outperforms Default:');
console.log('Station         | Default MAPE | Seasonal MAPE | Improvement');
console.log('─'.repeat(65));

const improvements = stationResults
  .map(r => ({ ...r, improvement: r.default - r.seasonal }))
  .sort((a, b) => b.improvement - a.improvement)
  .slice(0, 10);

for (const r of improvements) {
  const sign = r.improvement >= 0 ? '+' : '';
  console.log(`${r.station.padEnd(15)} | ${r.default.toFixed(1).padStart(10)}%  | ${r.seasonal.toFixed(1).padStart(11)}%  | ${sign}${r.improvement.toFixed(1)}%`);
}

// Bottom 10 (where Seasonal is worse)
console.log('\n─────────────────────────────────────────────────────────────────────────────');
console.log('Top 10 stations where Seasonal Adaptive underperforms Default:');
console.log('Station         | Default MAPE | Seasonal MAPE | Change');
console.log('─'.repeat(65));

const worsenings = stationResults
  .map(r => ({ ...r, improvement: r.default - r.seasonal }))
  .sort((a, b) => a.improvement - b.improvement)
  .slice(0, 10);

for (const r of worsenings) {
  const sign = r.improvement >= 0 ? '+' : '';
  console.log(`${r.station.padEnd(15)} | ${r.default.toFixed(1).padStart(10)}%  | ${r.seasonal.toFixed(1).padStart(11)}%  | ${sign}${r.improvement.toFixed(1)}%`);
}

console.log('\n═══════════════════════════════════════════════════════════════════════════════');
console.log('                    CONCLUSION');
console.log('═══════════════════════════════════════════════════════════════════════════════');

if (overallImprovement > 5) {
  console.log(`\n✓ SEASONAL ADAPTIVE SIGNIFICANTLY IMPROVES December solar forecasting!`);
  console.log(`  - Average MAPE reduction: ${overallImprovement.toFixed(1)}%`);
  console.log(`  - The separate dry season ML model + reduced ML weight helps December predictions.`);
  console.log(`  - Recommendation: Use --solar-seasonal-adaptive for dry season forecasting.`);
} else if (overallImprovement > 0) {
  console.log(`\n✓ Seasonal Adaptive provides modest improvement for December solar forecasting.`);
  console.log(`  - Average MAPE reduction: ${overallImprovement.toFixed(1)}%`);
} else {
  console.log(`\n✗ Seasonal Adaptive does not improve December solar forecasting.`);
  console.log(`  - The issue may be elsewhere (physics model, weather data, etc.)`);
}
console.log('');
