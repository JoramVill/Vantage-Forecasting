/**
 * Compare Seasonal FIXED (using main model) vs Default vs Old Seasonal (separate dry model)
 */
const fs = require('fs');

const actualFile = 'Data Samples/Capacity Factor/MRHCFac_H7D1201.csv';
const defaultFile = 'output/cfac_dec_default.csv';
const seasonalOldFile = 'output/cfac_dec_seasonal_096.csv'; // Old broken seasonal (separate dry model)
const seasonalFixedFile = 'output/cfac_dec_seasonal_fixed.csv'; // New fixed seasonal (uses main model)

function parseCSV(content) {
  const lines = content.split('\n').filter(l => l.trim());
  if (lines.length < 2) return { headers: [], rows: [] };
  const headers = lines[0].split(',').map(h => h.trim());
  const rows = lines.slice(1).map(l => l.split(',').map(v => v.trim()));
  return { headers, rows };
}

const actual = parseCSV(fs.readFileSync(actualFile, 'utf-8'));
const defaultForecast = parseCSV(fs.readFileSync(defaultFile, 'utf-8'));
let seasonalOld = null;
let seasonalFixed = null;

try { seasonalOld = parseCSV(fs.readFileSync(seasonalOldFile, 'utf-8')); } catch (e) { console.log('Old seasonal not found'); }
try { seasonalFixed = parseCSV(fs.readFileSync(seasonalFixedFile, 'utf-8')); } catch (e) { console.log('Fixed seasonal not found'); }

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
const seasonalOldMap = seasonalOld ? buildMap(seasonalOld) : null;
const seasonalFixedMap = seasonalFixed ? buildMap(seasonalFixed) : null;

function calculateMetrics(actualM, forecastM, stationCode) {
  let sumAbsError = 0, sumActual = 0, sumForecast = 0, count = 0;

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
  }

  const mape = count > 0 ? (sumAbsError / sumActual) * 100 : 0;
  const avgBias = count > 0 ? ((sumForecast - sumActual) / count) * 100 : 0;
  return { mape, avgBias, count };
}

// Get solar stations (those ending with _S plus known solar stations without _S)
const knownSolarWithoutSuffix = ['01LIMAY', '01CAYANGA', '01CLARK', '01HERMOSA', '01CURIMAO', '01BOTOLAN'];
const solarStations = actual.headers.filter(h => h.endsWith('_S') || knownSolarWithoutSuffix.includes(h));

console.log('═══════════════════════════════════════════════════════════════════════════════');
console.log('       SEASONAL FIX VERIFICATION - December 1-8, 2025');
console.log('═══════════════════════════════════════════════════════════════════════════════');
console.log('');
console.log('FIX: Seasonal model now uses MAIN model with ML weight instead of separate dry');
console.log('     season model. This preserves station-specific calibrations.');
console.log('');

// Focus on 01LIMAY which had the +296% error
const problemStations = ['01LIMAY', '01SNMANUEL_S', '06BACOLOD_S'];

for (const station of problemStations) {
  const defaultMetrics = calculateMetrics(actualMap, defaultMap, station);
  const oldMetrics = seasonalOldMap ? calculateMetrics(actualMap, seasonalOldMap, station) : null;
  const fixedMetrics = seasonalFixedMap ? calculateMetrics(actualMap, seasonalFixedMap, station) : null;

  if (defaultMetrics.count < 5) continue;

  console.log(`\n─── ${station} ───`);
  console.log('Model                    | MAPE     | Avg Bias  | Samples');
  console.log('─'.repeat(60));
  console.log(`Default                  | ${defaultMetrics.mape.toFixed(1).padStart(6)}%  | ${(defaultMetrics.avgBias >= 0 ? '+' : '')}${defaultMetrics.avgBias.toFixed(1).padStart(5)}% CF | ${defaultMetrics.count}`);
  if (oldMetrics) {
    console.log(`Seasonal OLD (BROKEN)    | ${oldMetrics.mape.toFixed(1).padStart(6)}%  | ${(oldMetrics.avgBias >= 0 ? '+' : '')}${oldMetrics.avgBias.toFixed(1).padStart(5)}% CF | ${oldMetrics.count}`);
  }
  if (fixedMetrics) {
    console.log(`Seasonal FIXED           | ${fixedMetrics.mape.toFixed(1).padStart(6)}%  | ${(fixedMetrics.avgBias >= 0 ? '+' : '')}${fixedMetrics.avgBias.toFixed(1).padStart(5)}% CF | ${fixedMetrics.count}`);
  }

  if (fixedMetrics && oldMetrics) {
    const mapeImprovement = oldMetrics.mape - fixedMetrics.mape;
    const biasImprovement = Math.abs(oldMetrics.avgBias) - Math.abs(fixedMetrics.avgBias);
    console.log(`\n  Fix impact: MAPE ${mapeImprovement >= 0 ? 'improved' : 'worse'} by ${Math.abs(mapeImprovement).toFixed(1)}%, Bias ${biasImprovement >= 0 ? 'improved' : 'worse'} by ${Math.abs(biasImprovement).toFixed(1)}%`);
  }
}

// Overall summary
let totalDefaultMape = 0, totalOldMape = 0, totalFixedMape = 0, stationCount = 0;
let totalDefaultBias = 0, totalOldBias = 0, totalFixedBias = 0;

for (const station of solarStations) {
  const defaultMetrics = calculateMetrics(actualMap, defaultMap, station);
  const oldMetrics = seasonalOldMap ? calculateMetrics(actualMap, seasonalOldMap, station) : null;
  const fixedMetrics = seasonalFixedMap ? calculateMetrics(actualMap, seasonalFixedMap, station) : null;

  if (defaultMetrics.count < 10) continue;

  totalDefaultMape += defaultMetrics.mape;
  totalDefaultBias += defaultMetrics.avgBias;
  if (oldMetrics) {
    totalOldMape += oldMetrics.mape;
    totalOldBias += oldMetrics.avgBias;
  }
  if (fixedMetrics) {
    totalFixedMape += fixedMetrics.mape;
    totalFixedBias += fixedMetrics.avgBias;
  }
  stationCount++;
}

console.log('\n═══════════════════════════════════════════════════════════════════════════════');
console.log(`Average across ${stationCount} solar stations:`);
console.log('─'.repeat(60));
console.log(`Model                    | Avg MAPE | Avg Bias`);
console.log('─'.repeat(60));
console.log(`Default                  | ${(totalDefaultMape / stationCount).toFixed(1).padStart(6)}%  | ${(totalDefaultBias / stationCount) >= 0 ? '+' : ''}${(totalDefaultBias / stationCount).toFixed(1).padStart(5)}%`);
if (seasonalOldMap) {
  console.log(`Seasonal OLD (BROKEN)    | ${(totalOldMape / stationCount).toFixed(1).padStart(6)}%  | ${(totalOldBias / stationCount) >= 0 ? '+' : ''}${(totalOldBias / stationCount).toFixed(1).padStart(5)}%`);
}
if (seasonalFixedMap) {
  console.log(`Seasonal FIXED           | ${(totalFixedMape / stationCount).toFixed(1).padStart(6)}%  | ${(totalFixedBias / stationCount) >= 0 ? '+' : ''}${(totalFixedBias / stationCount).toFixed(1).padStart(5)}%`);
}

console.log('');
console.log('═══════════════════════════════════════════════════════════════════════════════');
console.log('                    SUMMARY');
console.log('═══════════════════════════════════════════════════════════════════════════════');

if (seasonalFixedMap && seasonalOldMap) {
  const mapeImprovementVsOld = (totalOldMape - totalFixedMape) / stationCount;
  const biasImprovementVsOld = Math.abs(totalOldBias / stationCount) - Math.abs(totalFixedBias / stationCount);

  console.log(`Fix vs Old Seasonal: MAPE ${mapeImprovementVsOld >= 0 ? 'improved' : 'worse'} by ${Math.abs(mapeImprovementVsOld).toFixed(1)}%`);
  console.log(`                     Bias ${biasImprovementVsOld >= 0 ? 'improved' : 'worse'} by ${Math.abs(biasImprovementVsOld).toFixed(1)}%`);
}

if (seasonalFixedMap) {
  const fixedMatchesDefault = Math.abs((totalFixedMape / stationCount) - (totalDefaultMape / stationCount)) < 0.1;
  if (fixedMatchesDefault) {
    console.log('\nFIXED seasonal now matches DEFAULT model behavior.');
  } else {
    console.log(`\nFIXED seasonal differs from DEFAULT by ${Math.abs((totalFixedMape / stationCount) - (totalDefaultMape / stationCount)).toFixed(1)}% MAPE`);
  }
}

console.log('');
