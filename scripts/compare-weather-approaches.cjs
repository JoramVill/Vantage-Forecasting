/**
 * Compare Cluster-Based vs Per-Station Weather Approaches
 *
 * This compares:
 * 1. OLD: Cluster-based weather with 100m wind for all stations
 * 2. NEW: Per-station weather with optimal wind height per station
 */

const { readFileSync, readdirSync, existsSync } = require('fs');
const { join } = require('path');
const { DateTime } = require('luxon');

// Wind station codes and their optimal wind heights
const OPTIMAL_WIND_HEIGHTS = {
  '01BURGOS': { height: '50m', correlation: 0.6415 },
  '01CURIMAO': { height: '10m', correlation: 0.0846 },
  '01LAOAG': { height: '10m', correlation: 0.3511 },
  '01PAGUDPUD': { height: '50m', correlation: 0.6075 },
  '01PASUQUIN': { height: '10m', correlation: 0.0701 },
  '08NABAS_W': { height: '100m', correlation: 0.7282 },
  '08STBARBRA_W': { height: '10m', correlation: 0.7398 },
};

// Station to cluster mapping (from stations.json)
const STATION_CLUSTERS = {
  '01BURGOS': 'ILOCOS_NORTE_WIND',
  '01CURIMAO': 'ILOCOS_NORTE_WIND',
  '01LAOAG': 'ILOCOS_NORTE_WIND',
  '01PAGUDPUD': 'ILOCOS_NORTE_WIND',
  '01PASUQUIN': 'ILOCOS_NORTE_WIND',
  '08NABAS_W': 'AKLAN_WIND',
  '08STBARBRA_W': 'ILOILO_RENEWABLE',
};

const WIND_STATIONS = Object.keys(OPTIMAL_WIND_HEIGHTS);

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

// Load cluster-based weather (100m wind)
function loadClusterWeather(clusterId) {
  // Check for _wind suffix first, then regular
  let clusterDir = join(process.cwd(), 'weather_cache', clusterId + '_wind');
  if (!existsSync(clusterDir)) {
    clusterDir = join(process.cwd(), 'weather_cache', clusterId);
  }

  const weatherMap = new Map();

  try {
    if (!existsSync(clusterDir)) {
      console.log('  Cluster dir not found: ' + clusterDir);
      return weatherMap;
    }

    const months = readdirSync(clusterDir).filter(d => d.startsWith('2025-'));

    for (const month of months) {
      const monthDir = join(clusterDir, month);
      if (!existsSync(monthDir)) continue;

      const files = readdirSync(monthDir).filter(f => f.endsWith('.csv'));

      for (const file of files) {
        const content = readFileSync(join(monthDir, file), 'utf-8');
        const lines = content.split('\n').filter(l => l.trim());

        if (lines.length < 2) continue;

        const headers = parseCSVLine(lines[0]).map(h => h.toLowerCase());
        const datetimeIdx = headers.indexOf('datetime');
        const windspeedIdx = headers.indexOf('windspeed');
        const windspeed100Idx = headers.indexOf('windspeed100');

        for (let i = 1; i < lines.length; i++) {
          const values = parseCSVLine(lines[i]);
          if (values.length < headers.length) continue;

          const datetimeStr = values[datetimeIdx];
          const dt = DateTime.fromISO(datetimeStr).plus({ hours: 1 });
          if (!dt.isValid) continue;

          const key = dt.toFormat('yyyy-MM-dd HH:mm');

          // For cluster, prefer 100m
          const ws100 = windspeed100Idx >= 0 ? parseFloat(values[windspeed100Idx]) : 0;
          const ws10 = parseFloat(values[windspeedIdx]) || 0;

          weatherMap.set(key, ws100 > 0 ? ws100 : ws10);
        }
      }
    }
  } catch (err) {
    console.error('Error loading cluster weather for ' + clusterId + ':', err.message);
  }

  return weatherMap;
}

// Load per-station weather with all heights
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

        const headers = parseCSVLine(lines[0]).map(h => h.toLowerCase());
        const datetimeIdx = headers.indexOf('datetime');
        const windspeedIdx = headers.indexOf('windspeed');
        const windspeed50Idx = headers.indexOf('windspeed50');
        const windspeed80Idx = headers.indexOf('windspeed80');
        const windspeed100Idx = headers.indexOf('windspeed100');

        for (let i = 1; i < lines.length; i++) {
          const values = parseCSVLine(lines[i]);
          if (values.length < headers.length) continue;

          const datetimeStr = values[datetimeIdx];
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
    console.error('Error loading station weather for ' + stationCode + ':', err.message);
  }

  return weatherMap;
}

// Get optimal wind speed for station
function getOptimalWindSpeed(stationCode, weather) {
  const config = OPTIMAL_WIND_HEIGHTS[stationCode];
  if (!config) return weather.windspeed100 || weather.windspeed;

  switch (config.height) {
    case '100m': return weather.windspeed100 || weather.windspeed80 || weather.windspeed50 || weather.windspeed;
    case '80m': return weather.windspeed80 || weather.windspeed100 || weather.windspeed50 || weather.windspeed;
    case '50m': return weather.windspeed50 || weather.windspeed80 || weather.windspeed100 || weather.windspeed;
    default: return weather.windspeed;
  }
}

// Load capacity factors
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

// Calibrate MREC
function calibrateMREC(data) {
  if (data.length < 100) return null;

  const sorted = [...data].sort((a, b) => b.windSpeed - a.windSpeed);
  const idxH = Math.floor(sorted.length * 0.1);
  const idxL = Math.floor(sorted.length * 0.3);

  const highTier = sorted.slice(0, idxH);
  const midTier = sorted.slice(idxH, idxL);
  const lowTier = sorted.slice(idxL);

  if (highTier.length === 0 || midTier.length === 0 || lowTier.length === 0) return null;

  const avgH = {
    cf: highTier.reduce((s, d) => s + d.capacityFactor, 0) / highTier.length,
    ws: highTier.reduce((s, d) => s + d.windSpeed, 0) / highTier.length
  };
  const avgM = {
    cf: midTier.reduce((s, d) => s + d.capacityFactor, 0) / midTier.length,
    ws: midTier.reduce((s, d) => s + d.windSpeed, 0) / midTier.length
  };
  const avgL = {
    cf: lowTier.reduce((s, d) => s + d.capacityFactor, 0) / lowTier.length,
    ws: lowTier.reduce((s, d) => s + d.windSpeed, 0) / lowTier.length
  };

  return {
    MRecH: avgH.ws > 0 ? avgH.cf / avgH.ws : 0,
    MRecM: avgM.ws > 0 ? avgM.cf / avgM.ws : 0,
    MRecL: avgL.ws > 0 ? avgL.cf / avgL.ws : 0,
    vH: highTier[highTier.length - 1].windSpeed,
    vL: midTier[midTier.length - 1].windSpeed
  };
}

// Predict MREC
function predictMREC(factors, windSpeed) {
  if (!factors) return 0;

  let mrec;
  if (windSpeed >= factors.vH) mrec = factors.MRecH;
  else if (windSpeed >= factors.vL) mrec = factors.MRecM;
  else mrec = factors.MRecL;

  let cfac = mrec * windSpeed;
  if (cfac > 1.1) return 0;
  return Math.max(0, Math.min(1, cfac));
}

// Calculate MAPE
function calculateMAPE(predictions, actuals) {
  let errorSum = 0, count = 0;
  for (let i = 0; i < predictions.length; i++) {
    if (actuals[i] > 0.01) {
      errorSum += Math.abs((predictions[i] - actuals[i]) / actuals[i]);
      count++;
    }
  }
  return count > 0 ? (errorSum / count) * 100 : 0;
}

// Main
async function main() {
  console.log('');
  console.log('='.repeat(100));
  console.log('COMPARISON: Cluster-Based (100m) vs Per-Station (Optimal Height) Weather');
  console.log('='.repeat(100));
  console.log('');

  const cfacData = loadCapacityFactors();
  const trainMonths = [7, 8, 9, 10];
  const testMonths = [11, 12];

  // Load cluster weather for each unique cluster
  const clusterWeather = new Map();
  for (const clusterId of [...new Set(Object.values(STATION_CLUSTERS))]) {
    console.log('Loading cluster weather: ' + clusterId);
    clusterWeather.set(clusterId, loadClusterWeather(clusterId));
  }

  const results = [];

  for (const stationCode of WIND_STATIONS) {
    console.log('');
    console.log('-'.repeat(70));
    console.log('Station: ' + stationCode);
    console.log('-'.repeat(70));

    const stationCfac = cfacData.get(stationCode);
    const clusterId = STATION_CLUSTERS[stationCode];
    const clusterWx = clusterWeather.get(clusterId);

    // Load per-station weather
    const stationWx = loadStationWeather(stationCode);

    // Build paired data for both approaches
    const clusterTrainData = [];
    const clusterTestData = [];
    const stationTrainData = [];
    const stationTestData = [];

    for (const [key, cfac] of stationCfac) {
      const dt = DateTime.fromFormat(key, 'yyyy-MM-dd HH:mm');
      const month = dt.month;
      const isTraining = trainMonths.includes(month);
      const isTesting = testMonths.includes(month);

      // Cluster approach
      const clusterWindSpeed = clusterWx.get(key);
      if (clusterWindSpeed && clusterWindSpeed > 0) {
        const dp = { windSpeed: clusterWindSpeed, capacityFactor: cfac };
        if (isTraining) clusterTrainData.push(dp);
        else if (isTesting) clusterTestData.push(dp);
      }

      // Per-station approach
      const stationWeather = stationWx.get(key);
      if (stationWeather) {
        const windSpeed = getOptimalWindSpeed(stationCode, stationWeather);
        if (windSpeed > 0) {
          const dp = { windSpeed, capacityFactor: cfac };
          if (isTraining) stationTrainData.push(dp);
          else if (isTesting) stationTestData.push(dp);
        }
      }
    }

    console.log('  Cluster approach - train: ' + clusterTrainData.length + ', test: ' + clusterTestData.length);
    console.log('  Station approach - train: ' + stationTrainData.length + ', test: ' + stationTestData.length);

    // Calibrate and evaluate both
    let clusterMAPE = null, stationMAPE = null;

    // Cluster
    if (clusterTrainData.length >= 100 && clusterTestData.length >= 50) {
      const factors = calibrateMREC(clusterTrainData);
      if (factors) {
        const preds = clusterTestData.map(d => predictMREC(factors, d.windSpeed));
        const actuals = clusterTestData.map(d => d.capacityFactor);
        clusterMAPE = calculateMAPE(preds, actuals);
      }
    }

    // Station
    if (stationTrainData.length >= 100 && stationTestData.length >= 50) {
      const factors = calibrateMREC(stationTrainData);
      if (factors) {
        const preds = stationTestData.map(d => predictMREC(factors, d.windSpeed));
        const actuals = stationTestData.map(d => d.capacityFactor);
        stationMAPE = calculateMAPE(preds, actuals);
      }
    }

    console.log('');
    if (clusterMAPE !== null) console.log('  Cluster (100m):     ' + clusterMAPE.toFixed(1) + '% MAPE');
    else console.log('  Cluster (100m):     N/A (insufficient data)');

    if (stationMAPE !== null) {
      const optHeight = OPTIMAL_WIND_HEIGHTS[stationCode].height;
      console.log('  Station (' + optHeight + '):    ' + stationMAPE.toFixed(1) + '% MAPE');
    }
    else console.log('  Station (optimal):  N/A (insufficient data)');

    if (clusterMAPE !== null && stationMAPE !== null) {
      const improvement = clusterMAPE - stationMAPE;
      const pctImpr = ((clusterMAPE - stationMAPE) / clusterMAPE) * 100;
      console.log('  Improvement:        ' + (improvement > 0 ? '+' : '') + improvement.toFixed(1) + '% (' + (pctImpr > 0 ? '+' : '') + pctImpr.toFixed(1) + '%)');
    }

    results.push({
      station: stationCode,
      cluster: clusterId,
      optHeight: OPTIMAL_WIND_HEIGHTS[stationCode].height,
      clusterMAPE,
      stationMAPE,
      clusterTestN: clusterTestData.length,
      stationTestN: stationTestData.length
    });
  }

  // Summary
  console.log('');
  console.log('='.repeat(100));
  console.log('SUMMARY');
  console.log('='.repeat(100));
  console.log('');
  console.log('Station'.padEnd(15) + 'Opt Ht'.padStart(10) + 'Cluster MAPE'.padStart(15) + 'Station MAPE'.padStart(15) + 'Improvement'.padStart(15));
  console.log('-'.repeat(70));

  let totalCluster = 0, totalStation = 0, count = 0;

  for (const r of results) {
    const clusterStr = r.clusterMAPE !== null ? r.clusterMAPE.toFixed(1) + '%' : 'N/A';
    const stationStr = r.stationMAPE !== null ? r.stationMAPE.toFixed(1) + '%' : 'N/A';

    let improvStr = 'N/A';
    if (r.clusterMAPE !== null && r.stationMAPE !== null) {
      const impr = r.clusterMAPE - r.stationMAPE;
      improvStr = (impr > 0 ? '+' : '') + impr.toFixed(1) + '%';
      totalCluster += r.clusterMAPE;
      totalStation += r.stationMAPE;
      count++;
    }

    console.log(
      r.station.padEnd(15) +
      r.optHeight.padStart(10) +
      clusterStr.padStart(15) +
      stationStr.padStart(15) +
      improvStr.padStart(15)
    );
  }

  console.log('-'.repeat(70));
  if (count > 0) {
    const avgCluster = totalCluster / count;
    const avgStation = totalStation / count;
    const avgImpr = avgCluster - avgStation;
    console.log(
      'AVERAGE'.padEnd(15) +
      ''.padStart(10) +
      (avgCluster.toFixed(1) + '%').padStart(15) +
      (avgStation.toFixed(1) + '%').padStart(15) +
      ((avgImpr > 0 ? '+' : '') + avgImpr.toFixed(1) + '%').padStart(15)
    );
  }

  console.log('');
}

main().catch(console.error);
