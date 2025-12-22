/**
 * Quick comparison: Default vs Seasonal Adaptive (0.75 ML weight)
 */
const fs = require('fs');

const actualFile = 'Data Samples/Capacity Factor/MRHCFac_H7D1201.csv';
const defaultFile = 'output/cfac_dec_default.csv';
const seasonal075File = 'output/cfac_dec_seasonal_075.csv';

function parseCSV(content) {
  const lines = content.split('\n').filter(l => l.trim());
  if (lines.length < 2) return { headers: [], rows: [] };
  const headers = lines[0].split(',').map(h => h.trim());
  const rows = lines.slice(1).map(l => l.split(',').map(v => v.trim()));
  return { headers, rows };
}

const actual = parseCSV(fs.readFileSync(actualFile, 'utf-8'));
const defaultForecast = parseCSV(fs.readFileSync(defaultFile, 'utf-8'));
const seasonal075 = parseCSV(fs.readFileSync(seasonal075File, 'utf-8'));

function buildMap(data) {
  const map = new Map();
  for (const row of data.rows) {
    const datetime = row[0];
    for (let i = 1; i < data.headers.length; i++) {
      const cf = parseFloat(row[i]);
      if (!isNaN(cf)) map.set(`${datetime}_${data.headers[i]}`, cf);
    }
  }
  return map;
}

const actualMap = buildMap(actual);
const defaultMap = buildMap(defaultForecast);
const seasonal075Map = buildMap(seasonal075);

function calculateMetrics(actualM, forecastM, stationCode) {
  let sumAbsError = 0, sumActual = 0, sumForecast = 0, count = 0;
  const hourlyActual = {}, hourlyForecast = {}, hourlyCount = {};

  for (const [key, actualCf] of actualM) {
    if (!key.endsWith(`_${stationCode}`)) continue;
    const forecastCf = forecastM.get(key);
    if (forecastCf === undefined) continue;

    const datetime = key.split('_')[0];
    const hourMatch = datetime.match(/\s+(\d+):/);
    if (!hourMatch) continue;
    const hour = parseInt(hourMatch[1], 10);
    if (hour < 6 || hour > 18) continue;
    if (actualCf < 0.01) continue;

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

const problemStations = ['01SNMANUEL_S', '06BACOLOD_S'];
const solarStations = actual.headers.filter(h => h.endsWith('_S'));

console.log('═══════════════════════════════════════════════════════════════════════════════');
console.log('       SEASONAL ADAPTIVE (0.75 weight) VS DEFAULT - December 1-7, 2025');
console.log('═══════════════════════════════════════════════════════════════════════════════');
console.log('');

for (const station of problemStations) {
  const defaultMetrics = calculateMetrics(actualMap, defaultMap, station);
  const seasonal075Metrics = calculateMetrics(actualMap, seasonal075Map, station);

  console.log(`\n─── ${station} ───`);
  console.log('Model                | MAPE     | Avg Bias  | Samples');
  console.log('─'.repeat(55));
  console.log(`Default (full ML)    | ${defaultMetrics.mape.toFixed(1).padStart(6)}%  | ${(defaultMetrics.avgBias >= 0 ? '+' : '')}${defaultMetrics.avgBias.toFixed(1).padStart(5)}% CF | ${defaultMetrics.count}`);
  console.log(`Seasonal (0.75 wt)   | ${seasonal075Metrics.mape.toFixed(1).padStart(6)}%  | ${(seasonal075Metrics.avgBias >= 0 ? '+' : '')}${seasonal075Metrics.avgBias.toFixed(1).padStart(5)}% CF | ${seasonal075Metrics.count}`);

  console.log('\nHourly breakdown (H9-H15):');
  console.log('Hour | Actual  | Default | Seasonal | Default Err | Seasonal Err');
  console.log('─'.repeat(65));

  for (let h = 9; h <= 15; h++) {
    if (!defaultMetrics.hourlyCount[h]) continue;
    const avgActual = defaultMetrics.hourlyActual[h] / defaultMetrics.hourlyCount[h];
    const avgDefault = defaultMetrics.hourlyForecast[h] / defaultMetrics.hourlyCount[h];
    const avgSeasonal = seasonal075Metrics.hourlyForecast[h] / seasonal075Metrics.hourlyCount[h];
    const errDefault = Math.abs(avgDefault - avgActual);
    const errSeasonal = Math.abs(avgSeasonal - avgActual);
    console.log(`H${h.toString().padStart(2)} | ${(avgActual * 100).toFixed(1).padStart(5)}%  | ${(avgDefault * 100).toFixed(1).padStart(5)}%   | ${(avgSeasonal * 100).toFixed(1).padStart(6)}%   | ${(errDefault * 100).toFixed(1).padStart(9)}%   | ${(errSeasonal * 100).toFixed(1).padStart(10)}%`);
  }
}

// Overall summary
let totalDefaultMape = 0, totalSeasonalMape = 0, stationCount = 0;
for (const station of solarStations) {
  const defaultMetrics = calculateMetrics(actualMap, defaultMap, station);
  const seasonalMetrics = calculateMetrics(actualMap, seasonal075Map, station);
  if (defaultMetrics.count < 10) continue;
  totalDefaultMape += defaultMetrics.mape;
  totalSeasonalMape += seasonalMetrics.mape;
  stationCount++;
}

console.log('\n═══════════════════════════════════════════════════════════════════════════════');
console.log(`Average MAPE across ${stationCount} solar stations:`);
console.log(`  Default:              ${(totalDefaultMape / stationCount).toFixed(1)}%`);
console.log(`  Seasonal (0.75 wt):   ${(totalSeasonalMape / stationCount).toFixed(1)}%`);
const improvement = (totalDefaultMape - totalSeasonalMape) / stationCount;
console.log(`  Improvement:          ${improvement >= 0 ? '+' : ''}${improvement.toFixed(1)}%`);
console.log('');
