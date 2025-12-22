/**
 * Compare ML weights: Default (1.0) vs 0.92 vs 0.96 - December 2025
 */
const fs = require('fs');

const actualFile = 'Data Samples/Capacity Factor/MRHCFac_H7D1201.csv';
const defaultFile = 'output/cfac_dec_default.csv';
const weight092File = 'output/cfac_dec_seasonal_092.csv';
const weight096File = 'output/cfac_dec_seasonal_096.csv';

function parseCSV(content) {
  const lines = content.split('\n').filter(l => l.trim());
  if (lines.length < 2) return { headers: [], rows: [] };
  const headers = lines[0].split(',').map(h => h.trim());
  const rows = lines.slice(1).map(l => l.split(',').map(v => v.trim()));
  return { headers, rows };
}

const actual = parseCSV(fs.readFileSync(actualFile, 'utf-8'));
const defaultForecast = parseCSV(fs.readFileSync(defaultFile, 'utf-8'));
const weight092 = parseCSV(fs.readFileSync(weight092File, 'utf-8'));
const weight096 = parseCSV(fs.readFileSync(weight096File, 'utf-8'));

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
const w092Map = buildMap(weight092);
const w096Map = buildMap(weight096);

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

const solarStations = actual.headers.filter(h => h.endsWith('_S'));

console.log('═══════════════════════════════════════════════════════════════════════════════');
console.log('       ML WEIGHT CALIBRATION - December 2025 Solar Forecasts');
console.log('═══════════════════════════════════════════════════════════════════════════════');

let totalDefault = { mape: 0, bias: 0 }, total092 = { mape: 0, bias: 0 }, total096 = { mape: 0, bias: 0 };
let stationCount = 0;

for (const station of solarStations) {
  const defMetrics = calculateMetrics(actualMap, defaultMap, station);
  const m092 = calculateMetrics(actualMap, w092Map, station);
  const m096 = calculateMetrics(actualMap, w096Map, station);
  if (defMetrics.count < 10) continue;
  totalDefault.mape += defMetrics.mape;
  totalDefault.bias += defMetrics.avgBias;
  total092.mape += m092.mape;
  total092.bias += m092.avgBias;
  total096.mape += m096.mape;
  total096.bias += m096.avgBias;
  stationCount++;
}

console.log(`\nAverage across ${stationCount} solar stations:`);
console.log('─'.repeat(60));
console.log('Model                | Avg MAPE | Avg Bias');
console.log('─'.repeat(60));
console.log(`Default (1.0 weight) | ${(totalDefault.mape / stationCount).toFixed(1).padStart(6)}%  | ${(totalDefault.bias / stationCount) >= 0 ? '+' : ''}${(totalDefault.bias / stationCount).toFixed(1).padStart(5)}%`);
console.log(`Weight 0.92          | ${(total092.mape / stationCount).toFixed(1).padStart(6)}%  | ${(total092.bias / stationCount) >= 0 ? '+' : ''}${(total092.bias / stationCount).toFixed(1).padStart(5)}%`);
console.log(`Weight 0.96          | ${(total096.mape / stationCount).toFixed(1).padStart(6)}%  | ${(total096.bias / stationCount) >= 0 ? '+' : ''}${(total096.bias / stationCount).toFixed(1).padStart(5)}%`);

console.log('\n═══════════════════════════════════════════════════════════════════════════════');
console.log('Calibration goal: ~0% bias with minimal MAPE increase');
console.log('═══════════════════════════════════════════════════════════════════════════════');
