/**
 * Compare Seasonal Adaptive FIXED (0.75 weight now properly applied) vs Default
 */
const fs = require('fs');

const actualFile = 'Data Samples/Capacity Factor/MRHCFac_H7D1201.csv';
const defaultFile = 'output/cfac_dec_default.csv';
const seasonalFixedFile = 'output/cfac_dec_seasonal_075_fixed.csv';
const seasonalOldFile = 'output/cfac_dec_seasonal_adaptive.csv'; // Previous run with bug

function parseCSV(content) {
  const lines = content.split('\n').filter(l => l.trim());
  if (lines.length < 2) return { headers: [], rows: [] };
  const headers = lines[0].split(',').map(h => h.trim());
  const rows = lines.slice(1).map(l => l.split(',').map(v => v.trim()));
  return { headers, rows };
}

const actual = parseCSV(fs.readFileSync(actualFile, 'utf-8'));
const defaultForecast = parseCSV(fs.readFileSync(defaultFile, 'utf-8'));
const seasonalFixed = parseCSV(fs.readFileSync(seasonalFixedFile, 'utf-8'));
let seasonalOld = null;
try {
  seasonalOld = parseCSV(fs.readFileSync(seasonalOldFile, 'utf-8'));
} catch (e) {}

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
const seasonalFixedMap = buildMap(seasonalFixed);
const seasonalOldMap = seasonalOld ? buildMap(seasonalOld) : null;

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
console.log('       SEASONAL ADAPTIVE FIXED (0.75 weight) VS DEFAULT - December 1-7, 2025');
console.log('═══════════════════════════════════════════════════════════════════════════════');
console.log('');
console.log('BUG FIX: Previously the 0.75 weight was in a fallback code path that was never');
console.log('executed because dry season models were trained. Now the weight is properly');
console.log('applied to reduce ML residual by 25% even when using dry season model.');
console.log('');

for (const station of problemStations) {
  const defaultMetrics = calculateMetrics(actualMap, defaultMap, station);
  const seasonalFixedMetrics = calculateMetrics(actualMap, seasonalFixedMap, station);
  const seasonalOldMetrics = seasonalOldMap ? calculateMetrics(actualMap, seasonalOldMap, station) : null;

  console.log(`\n─── ${station} ───`);
  console.log('Model                    | MAPE     | Avg Bias  | Samples');
  console.log('─'.repeat(60));
  console.log(`Default (full ML)        | ${defaultMetrics.mape.toFixed(1).padStart(6)}%  | ${(defaultMetrics.avgBias >= 0 ? '+' : '')}${defaultMetrics.avgBias.toFixed(1).padStart(5)}% CF | ${defaultMetrics.count}`);
  if (seasonalOldMetrics) {
    console.log(`Seasonal OLD (bug)       | ${seasonalOldMetrics.mape.toFixed(1).padStart(6)}%  | ${(seasonalOldMetrics.avgBias >= 0 ? '+' : '')}${seasonalOldMetrics.avgBias.toFixed(1).padStart(5)}% CF | ${seasonalOldMetrics.count}`);
  }
  console.log(`Seasonal FIXED (0.75 wt) | ${seasonalFixedMetrics.mape.toFixed(1).padStart(6)}%  | ${(seasonalFixedMetrics.avgBias >= 0 ? '+' : '')}${seasonalFixedMetrics.avgBias.toFixed(1).padStart(5)}% CF | ${seasonalFixedMetrics.count}`);

  const improvementVsDefault = defaultMetrics.mape - seasonalFixedMetrics.mape;
  const biasChange = seasonalFixedMetrics.avgBias - defaultMetrics.avgBias;
  console.log(`\n  vs Default: MAPE ${improvementVsDefault >= 0 ? 'improved' : 'worse'} by ${Math.abs(improvementVsDefault).toFixed(1)}%`);
  console.log(`              Bias changed from ${defaultMetrics.avgBias >= 0 ? '+' : ''}${defaultMetrics.avgBias.toFixed(1)}% to ${seasonalFixedMetrics.avgBias >= 0 ? '+' : ''}${seasonalFixedMetrics.avgBias.toFixed(1)}%`);

  console.log('\nHourly breakdown (H9-H15):');
  console.log('Hour | Actual  | Default | Fixed   | Default Err | Fixed Err');
  console.log('─'.repeat(65));

  for (let h = 9; h <= 15; h++) {
    if (!defaultMetrics.hourlyCount[h]) continue;
    const avgActual = defaultMetrics.hourlyActual[h] / defaultMetrics.hourlyCount[h];
    const avgDefault = defaultMetrics.hourlyForecast[h] / defaultMetrics.hourlyCount[h];
    const avgFixed = seasonalFixedMetrics.hourlyForecast[h] / seasonalFixedMetrics.hourlyCount[h];
    const errDefault = Math.abs(avgDefault - avgActual);
    const errFixed = Math.abs(avgFixed - avgActual);
    console.log(`H${h.toString().padStart(2)} | ${(avgActual * 100).toFixed(1).padStart(5)}%  | ${(avgDefault * 100).toFixed(1).padStart(5)}%   | ${(avgFixed * 100).toFixed(1).padStart(5)}%   | ${(errDefault * 100).toFixed(1).padStart(9)}%   | ${(errFixed * 100).toFixed(1).padStart(7)}%`);
  }
}

// Overall summary
let totalDefaultMape = 0, totalFixedMape = 0, totalOldMape = 0, stationCount = 0;
let totalDefaultBias = 0, totalFixedBias = 0, totalOldBias = 0;
for (const station of solarStations) {
  const defaultMetrics = calculateMetrics(actualMap, defaultMap, station);
  const fixedMetrics = calculateMetrics(actualMap, seasonalFixedMap, station);
  const oldMetrics = seasonalOldMap ? calculateMetrics(actualMap, seasonalOldMap, station) : null;
  if (defaultMetrics.count < 10) continue;
  totalDefaultMape += defaultMetrics.mape;
  totalFixedMape += fixedMetrics.mape;
  totalDefaultBias += defaultMetrics.avgBias;
  totalFixedBias += fixedMetrics.avgBias;
  if (oldMetrics) {
    totalOldMape += oldMetrics.mape;
    totalOldBias += oldMetrics.avgBias;
  }
  stationCount++;
}

console.log('\n═══════════════════════════════════════════════════════════════════════════════');
console.log(`Average across ${stationCount} solar stations:`);
console.log('─'.repeat(60));
console.log(`Model                    | Avg MAPE | Avg Bias`);
console.log('─'.repeat(60));
console.log(`Default (full ML)        | ${(totalDefaultMape / stationCount).toFixed(1).padStart(6)}%  | ${(totalDefaultBias / stationCount) >= 0 ? '+' : ''}${(totalDefaultBias / stationCount).toFixed(1).padStart(5)}%`);
if (seasonalOldMap) {
  console.log(`Seasonal OLD (bug)       | ${(totalOldMape / stationCount).toFixed(1).padStart(6)}%  | ${(totalOldBias / stationCount) >= 0 ? '+' : ''}${(totalOldBias / stationCount).toFixed(1).padStart(5)}%`);
}
console.log(`Seasonal FIXED (0.75 wt) | ${(totalFixedMape / stationCount).toFixed(1).padStart(6)}%  | ${(totalFixedBias / stationCount) >= 0 ? '+' : ''}${(totalFixedBias / stationCount).toFixed(1).padStart(5)}%`);

const mapeImprovement = (totalDefaultMape - totalFixedMape) / stationCount;
const biasImprovement = Math.abs(totalDefaultBias / stationCount) - Math.abs(totalFixedBias / stationCount);

console.log('');
console.log('═══════════════════════════════════════════════════════════════════════════════');
console.log('                    SUMMARY');
console.log('═══════════════════════════════════════════════════════════════════════════════');
console.log(`MAPE change:     ${mapeImprovement >= 0 ? '+' : ''}${mapeImprovement.toFixed(1)}% (${mapeImprovement >= 0 ? 'improved' : 'worse'})`);
console.log(`Bias reduction:  ${biasImprovement >= 0 ? '+' : ''}${biasImprovement.toFixed(1)}% (${biasImprovement >= 0 ? 'improved' : 'worse'})`);
console.log('');
console.log('Target: Reduce over-forecasting from +12% (old bug) toward 0% bias');
console.log(`Result: Bias is now ${(totalFixedBias / stationCount) >= 0 ? '+' : ''}${(totalFixedBias / stationCount).toFixed(1)}%`);
console.log('');
