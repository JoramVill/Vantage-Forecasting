/**
 * Wind Speed Elevation Correlation Analysis
 * Analyzes which wind height (10m, 50m, 80m, 100m) best correlates with actual capacity factor
 */

const { readFileSync, readdirSync } = require('fs');
const { join } = require('path');
const { DateTime } = require('luxon');

// Wind station codes
const WIND_STATIONS = [
  '01BURGOS',
  '01CURIMAO',
  '01LAOAG',
  '01PAGUDPUD',
  '01PASUQUIN',
  '08NABAS_W',
  '08STBARBRA_W'
];

// Calculate Pearson correlation
function pearsonCorrelation(x, y) {
  const n = x.length;
  if (n !== y.length || n === 0) return 0;

  const sumX = x.reduce((a, b) => a + b, 0);
  const sumY = y.reduce((a, b) => a + b, 0);
  const sumXY = x.reduce((sum, xi, i) => sum + xi * y[i], 0);
  const sumX2 = x.reduce((sum, xi) => sum + xi * xi, 0);
  const sumY2 = y.reduce((sum, yi) => sum + yi * yi, 0);

  const numerator = n * sumXY - sumX * sumY;
  const denominator = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));

  if (denominator === 0) return 0;
  return numerator / denominator;
}

// Parse CSV line handling quoted values
function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current.trim());
  return result;
}

// Load station weather from per-station cache
function loadStationWeather(stationCode) {
  const stationDir = join(process.cwd(), 'weather_cache', 'station_' + stationCode);
  const weatherMap = new Map();

  try {
    const months = readdirSync(stationDir).filter(d => d.startsWith('2025-'));

    for (const month of months) {
      const monthDir = join(stationDir, month);
      const files = readdirSync(monthDir).filter(f => f.endsWith('.csv'));

      for (const file of files) {
        const content = readFileSync(join(monthDir, file), 'utf-8');
        const lines = content.split('\n').filter(l => l.trim());

        if (lines.length < 2) continue;

        const headers = parseCSVLine(lines[0]);
        const windspeedIdx = headers.indexOf('windspeed');
        const windspeed50Idx = headers.indexOf('windspeed50');
        const windspeed80Idx = headers.indexOf('windspeed80');
        const windspeed100Idx = headers.indexOf('windspeed100');
        const datetimeIdx = headers.indexOf('datetime');

        for (let i = 1; i < lines.length; i++) {
          const values = parseCSVLine(lines[i]);
          if (values.length < headers.length) continue;

          const datetimeStr = values[datetimeIdx];
          // Add 1 hour: weather is hour-starting, cfac is hour-ending
          const dt = DateTime.fromISO(datetimeStr).plus({ hours: 1 });
          if (!dt.isValid) continue;

          const key = dt.toFormat('yyyy-MM-dd HH:mm');

          weatherMap.set(key, {
            windspeed: parseFloat(values[windspeedIdx]) || 0,
            windspeed50: parseFloat(values[windspeed50Idx]) || 0,
            windspeed80: parseFloat(values[windspeed80Idx]) || 0,
            windspeed100: parseFloat(values[windspeed100Idx]) || 0
          });
        }
      }
    }
  } catch (err) {
    console.error('Error loading weather for ' + stationCode + ':', err.message);
  }

  return weatherMap;
}

// Load capacity factors from MRHCFac CSV files
function loadCapacityFactors() {
  const cfacDir = join(process.cwd(), 'Data Samples', 'Capacity Factor');
  const stationData = new Map();

  for (const station of WIND_STATIONS) {
    stationData.set(station, new Map());
  }

  const files = readdirSync(cfacDir).filter(f => f.toLowerCase().endsWith('.csv'));

  for (const file of files) {
    const content = readFileSync(join(cfacDir, file), 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());

    if (lines.length < 2) continue;

    const headers = lines[0].split(',').map(h => h.trim());
    const stationIndices = new Map();

    for (const station of WIND_STATIONS) {
      const idx = headers.indexOf(station);
      if (idx !== -1) stationIndices.set(station, idx);
    }

    for (let i = 1; i < lines.length; i++) {
      const values = lines[i].split(',').map(v => v.trim());
      if (values.length < 2) continue;

      const dt = DateTime.fromFormat(values[0], 'M/d/yyyy HH:mm');
      if (!dt.isValid) continue;

      const key = dt.toFormat('yyyy-MM-dd HH:mm');

      for (const [station, idx] of stationIndices) {
        const cfac = parseFloat(values[idx]);
        if (!isNaN(cfac) && cfac >= 0 && cfac <= 1) {
          stationData.get(station).set(key, cfac);
        }
      }
    }
  }

  return stationData;
}

// Main analysis
console.log('');
console.log('=== Wind Speed Elevation Correlation Analysis ===');
console.log('');
console.log('Loading capacity factor data...');

const cfacData = loadCapacityFactors();
const results = [];

for (const stationCode of WIND_STATIONS) {
  console.log('Processing ' + stationCode + '...');

  const weatherData = loadStationWeather(stationCode);
  console.log('  Weather records: ' + weatherData.size);

  const stationCfac = cfacData.get(stationCode);
  console.log('  CFac records: ' + stationCfac.size);

  // Join data by datetime key
  const ws10 = [], ws50 = [], ws80 = [], ws100 = [], cfs = [];

  for (const [key, cfac] of stationCfac) {
    const weather = weatherData.get(key);
    if (weather && weather.windspeed > 0) {
      ws10.push(weather.windspeed);
      ws50.push(weather.windspeed50);
      ws80.push(weather.windspeed80);
      ws100.push(weather.windspeed100);
      cfs.push(cfac);
    }
  }

  if (cfs.length < 100) {
    console.log('  Insufficient matched samples: ' + cfs.length);
    continue;
  }

  console.log('  Matched samples: ' + cfs.length);

  const corr10m = pearsonCorrelation(ws10, cfs);
  const corr50m = pearsonCorrelation(ws50, cfs);
  const corr80m = pearsonCorrelation(ws80, cfs);
  const corr100m = pearsonCorrelation(ws100, cfs);

  const avgCf = cfs.reduce((a, b) => a + b, 0) / cfs.length;

  results.push({
    station: stationCode,
    samples: cfs.length,
    corr10m, corr50m, corr80m, corr100m,
    avgCf,
    avgWs: {
      ws10: ws10.reduce((a, b) => a + b, 0) / ws10.length,
      ws50: ws50.reduce((a, b) => a + b, 0) / ws50.length,
      ws80: ws80.reduce((a, b) => a + b, 0) / ws80.length,
      ws100: ws100.reduce((a, b) => a + b, 0) / ws100.length
    }
  });
}

// Print results table
console.log('');
console.log('='.repeat(120));
console.log('CORRELATION ANALYSIS RESULTS');
console.log('='.repeat(120));
console.log('');
console.log('Correlation coefficients (higher = better predictor of capacity factor):');
console.log('-'.repeat(98));
console.log(
  'Station'.padEnd(15) +
  'Samples'.padStart(10) +
  '10m Corr'.padStart(12) +
  '50m Corr'.padStart(12) +
  '80m Corr'.padStart(12) +
  '100m Corr'.padStart(12) +
  'Best Height'.padStart(15) +
  'Avg CF'.padStart(10)
);
console.log('-'.repeat(98));

for (const r of results) {
  let best = '10m', maxC = Math.abs(r.corr10m);
  if (Math.abs(r.corr50m) > maxC) { best = '50m'; maxC = Math.abs(r.corr50m); }
  if (Math.abs(r.corr80m) > maxC) { best = '80m'; maxC = Math.abs(r.corr80m); }
  if (Math.abs(r.corr100m) > maxC) { best = '100m'; maxC = Math.abs(r.corr100m); }

  console.log(
    r.station.padEnd(15) +
    r.samples.toString().padStart(10) +
    r.corr10m.toFixed(4).padStart(12) +
    r.corr50m.toFixed(4).padStart(12) +
    r.corr80m.toFixed(4).padStart(12) +
    r.corr100m.toFixed(4).padStart(12) +
    best.padStart(15) +
    (r.avgCf * 100).toFixed(1).padStart(9) + '%'
  );
}

console.log('-'.repeat(98));

// Average wind speeds table
console.log('');
console.log('Average wind speeds by elevation (m/s):');
console.log('-'.repeat(80));
console.log(
  'Station'.padEnd(15) +
  'Avg 10m'.padStart(12) +
  'Avg 50m'.padStart(12) +
  'Avg 80m'.padStart(12) +
  'Avg 100m'.padStart(12)
);
console.log('-'.repeat(80));

for (const r of results) {
  console.log(
    r.station.padEnd(15) +
    r.avgWs.ws10.toFixed(2).padStart(12) +
    r.avgWs.ws50.toFixed(2).padStart(12) +
    r.avgWs.ws80.toFixed(2).padStart(12) +
    r.avgWs.ws100.toFixed(2).padStart(12)
  );
}

console.log('-'.repeat(80));

// Summary recommendations
console.log('');
console.log('=== RECOMMENDATIONS ===');
console.log('');

for (const r of results) {
  let best = '10m', maxC = r.corr10m;
  if (r.corr50m > maxC) { best = '50m'; maxC = r.corr50m; }
  if (r.corr80m > maxC) { best = '80m'; maxC = r.corr80m; }
  if (r.corr100m > maxC) { best = '100m'; maxC = r.corr100m; }
  console.log(r.station + ': Use ' + best + ' wind speed (r=' + maxC.toFixed(4) + ')');
}

// Overall averages
console.log('');
console.log('Overall average correlations:');
const avgCorr10 = results.reduce((s, r) => s + r.corr10m, 0) / results.length;
const avgCorr50 = results.reduce((s, r) => s + r.corr50m, 0) / results.length;
const avgCorr80 = results.reduce((s, r) => s + r.corr80m, 0) / results.length;
const avgCorr100 = results.reduce((s, r) => s + r.corr100m, 0) / results.length;
console.log('  10m:  ' + avgCorr10.toFixed(4));
console.log('  50m:  ' + avgCorr50.toFixed(4));
console.log('  80m:  ' + avgCorr80.toFixed(4));
console.log('  100m: ' + avgCorr100.toFixed(4));

const bestOverall = [
  { height: '10m', corr: avgCorr10 },
  { height: '50m', corr: avgCorr50 },
  { height: '80m', corr: avgCorr80 },
  { height: '100m', corr: avgCorr100 }
].sort((a, b) => b.corr - a.corr)[0];

console.log('');
console.log('BEST OVERALL: ' + bestOverall.height + ' (avg r=' + bestOverall.corr.toFixed(4) + ')');
console.log('');
