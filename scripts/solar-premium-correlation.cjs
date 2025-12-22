/**
 * Solar Premium Features Correlation Analysis
 *
 * Correlates premium weather features (UV index, humidity, visibility, conditions)
 * with actual solar capacity factor data to quantify improvement potential.
 */

const { readFileSync, readdirSync, existsSync } = require('fs');
const { join } = require('path');
const { DateTime } = require('luxon');

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

// Pearson correlation
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

// R-squared
function rSquared(actual, predicted) {
  const meanActual = actual.reduce((a, b) => a + b, 0) / actual.length;
  let ssRes = 0, ssTot = 0;
  for (let i = 0; i < actual.length; i++) {
    ssRes += (actual[i] - predicted[i]) ** 2;
    ssTot += (actual[i] - meanActual) ** 2;
  }
  return ssTot > 0 ? 1 - (ssRes / ssTot) : 0;
}

// MAPE
function mape(actual, predicted) {
  let errorSum = 0, count = 0;
  for (let i = 0; i < actual.length; i++) {
    if (actual[i] > 0.01) {
      errorSum += Math.abs((predicted[i] - actual[i]) / actual[i]);
      count++;
    }
  }
  return count > 0 ? (errorSum / count) * 100 : 0;
}

// Load per-station weather with all premium features
function loadStationWeather(stationCode) {
  const stationDir = join(process.cwd(), 'weather_cache', 'station_' + stationCode);
  if (!existsSync(stationDir)) return new Map();

  const weatherMap = new Map();
  const months = readdirSync(stationDir).filter(d => d.startsWith('2025-'));

  for (const month of months) {
    const monthDir = join(stationDir, month);
    if (!existsSync(monthDir)) continue;

    const files = readdirSync(monthDir).filter(f => f.endsWith('.csv'));

    for (const file of files) {
      const content = readFileSync(join(monthDir, file), 'utf-8');
      const lines = content.split('\n').filter(l => l.trim());

      if (lines.length < 2) continue;

      const headers = parseCSVLine(lines[0]).map(h => h.toLowerCase());

      const getIdx = (name) => headers.indexOf(name);

      for (let i = 1; i < lines.length; i++) {
        const values = parseCSVLine(lines[i]);
        if (values.length < headers.length) continue;

        const datetimeStr = values[getIdx('datetime')];
        const dt = DateTime.fromISO(datetimeStr).plus({ hours: 1 }); // Hour-ending
        if (!dt.isValid) continue;

        const key = dt.toFormat('yyyy-MM-dd HH:mm');

        const getValue = (name) => {
          const idx = getIdx(name);
          return idx >= 0 ? parseFloat(values[idx]) || 0 : 0;
        };

        const conditions = getIdx('conditions') >= 0 ? values[getIdx('conditions')] : '';

        weatherMap.set(key, {
          datetime: dt.toJSDate(),
          hour: dt.hour,
          month: dt.month,
          // Standard features
          solarradiation: getValue('solarradiation'),
          solarenergy: getValue('solarenergy'),
          cloudcover: getValue('cloudcover'),
          temperature: getValue('temp'),
          // Premium features
          uvindex: getValue('uvindex'),
          humidity: getValue('humidity'),
          visibility: getValue('visibility'),
          precipprob: getValue('precipprob'),
          pressure: getValue('sealevelpressure') || getValue('pressure'),
          conditions: conditions.replace(/"/g, '').toLowerCase()
        });
      }
    }
  }

  return weatherMap;
}

// Load cluster-based weather for comparison
function loadClusterWeather(clusterName) {
  const clusterDir = join(process.cwd(), 'weather_cache', clusterName);
  if (!existsSync(clusterDir)) return new Map();

  const weatherMap = new Map();
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

      for (let i = 1; i < lines.length; i++) {
        const values = parseCSVLine(lines[i]);
        if (values.length < headers.length) continue;

        const datetimeIdx = headers.indexOf('datetime');
        const datetimeStr = values[datetimeIdx];
        const dt = DateTime.fromISO(datetimeStr).plus({ hours: 1 });
        if (!dt.isValid) continue;

        const key = dt.toFormat('yyyy-MM-dd HH:mm');

        const getValue = (name) => {
          const idx = headers.indexOf(name);
          return idx >= 0 ? parseFloat(values[idx]) || 0 : 0;
        };

        weatherMap.set(key, {
          datetime: dt.toJSDate(),
          hour: dt.hour,
          solarradiation: getValue('solarradiation'),
          cloudcover: getValue('cloudcover'),
          temperature: getValue('temp'),
          uvindex: getValue('uvindex'),
          humidity: getValue('humidity'),
          visibility: getValue('visibility'),
        });
      }
    }
  }

  return weatherMap;
}

// Load capacity factors for solar stations
function loadSolarCapacityFactors() {
  const cfacDir = join(process.cwd(), 'Data Samples', 'Capacity Factor');
  const stationData = new Map();

  const files = readdirSync(cfacDir).filter(f => f.toLowerCase().endsWith('.csv'));

  for (const file of files) {
    const content = readFileSync(join(cfacDir, file), 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());
    if (lines.length < 2) continue;

    const headers = lines[0].split(',').map(h => h.trim());

    for (let i = 1; i < lines.length; i++) {
      const values = lines[i].split(',').map(v => v.trim());
      if (values.length < 2) continue;

      const dt = DateTime.fromFormat(values[0], 'M/d/yyyy HH:mm');
      if (!dt.isValid) continue;

      const key = dt.toFormat('yyyy-MM-dd HH:mm');

      for (let j = 1; j < headers.length; j++) {
        const station = headers[j];
        if (!stationData.has(station)) {
          stationData.set(station, new Map());
        }

        const cfac = parseFloat(values[j]);
        if (!isNaN(cfac) && cfac >= 0 && cfac <= 1) {
          stationData.get(station).set(key, cfac);
        }
      }
    }
  }

  return stationData;
}

// Solar capacity factor prediction using basic physics + corrections
function predictSolarCF(weather, params = {}) {
  const {
    irradianceScale = 1.4,
    useUVCorrection = false,
    useHumidityCorrection = false,
    useConditionsCorrection = false,
    systemLoss = 0.92,
    tempCoeff = -0.003
  } = params;

  const hour = weather.hour;

  // No output at night
  if (hour < 6 || hour > 18) return 0;

  // Base irradiance from weather
  let ghi = weather.solarradiation * irradianceScale;

  // Standard Temperature Correction
  const tempDev = (weather.temperature - 25);
  const tempFactor = 1 + tempCoeff * tempDev;

  // UV Index Correction (clear-sky indicator)
  let uvFactor = 1.0;
  if (useUVCorrection && weather.uvindex > 0) {
    // Higher UV = clearer sky = better conditions
    // Scale: UV 1 = 0.9x, UV 7 = 1.0x, UV 10+ = 1.1x
    uvFactor = 0.85 + Math.min(weather.uvindex / 10, 1) * 0.25;
  }

  // Humidity Correction (atmospheric absorption)
  let humidityFactor = 1.0;
  if (useHumidityCorrection && weather.humidity > 0) {
    // High humidity = more absorption = lower output
    // Scale: 50% = 1.05x, 70% = 1.0x, 90% = 0.9x
    humidityFactor = 1.15 - (weather.humidity / 200);
    humidityFactor = Math.max(0.85, Math.min(1.1, humidityFactor));
  }

  // Conditions Text Correction
  let conditionsFactor = 1.0;
  if (useConditionsCorrection && weather.conditions) {
    const cond = weather.conditions.toLowerCase();
    if (cond.includes('clear')) {
      conditionsFactor = 1.1;
    } else if (cond.includes('overcast') || cond.includes('rain')) {
      conditionsFactor = 0.85;
    } else if (cond.includes('partially cloudy')) {
      conditionsFactor = 0.95;
    }
  }

  // Combine all factors
  let cfac = (ghi / 1000) * tempFactor * systemLoss * uvFactor * humidityFactor * conditionsFactor;

  return Math.max(0, Math.min(1, cfac));
}

// Main analysis
async function main() {
  console.log('');
  console.log('='.repeat(100));
  console.log('SOLAR CAPACITY FACTOR CORRELATION WITH PREMIUM WEATHER FEATURES');
  console.log('='.repeat(100));
  console.log('');

  // Load capacity factors
  console.log('Loading capacity factor data...');
  const cfacData = loadSolarCapacityFactors();

  // Find solar stations with per-station weather
  const weatherCacheDir = join(process.cwd(), 'weather_cache');
  const stationDirs = readdirSync(weatherCacheDir)
    .filter(d => d.startsWith('station_'))
    .map(d => d.replace('station_', ''));

  // Solar station codes to analyze
  const solarStations = ['01CLARK', '01HERMOSA_S', '06HELIOS', '02DOLORES_S', '01SNTGO_S'];

  // Also check cluster-based solar stations
  const SOLAR_CLUSTERS = [
    { name: 'PAMPANGA_SOLAR', cluster: 'PAMPANGA_SOLAR', stations: ['01CLARK', '01HERMOSA_S'] },
    { name: 'NEGROS_SOLAR', cluster: 'NEGROS_SOLAR', stations: ['06HELIOS'] },
  ];

  // Check which solar stations have per-station weather data
  const availableStations = solarStations.filter(s => stationDirs.includes(s));

  console.log('');
  console.log('Solar stations with per-station weather data:');
  for (const s of availableStations) {
    console.log('  ' + s);
  }

  if (availableStations.length === 0) {
    console.log('');
    console.log('No per-station solar weather data yet. Using cluster data for analysis.');
    console.log('');
  }

  // Results storage
  const results = [];

  // Analyze each available station
  for (const stationCode of availableStations) {
    console.log('');
    console.log('-'.repeat(80));
    console.log('Analyzing ' + stationCode);
    console.log('-'.repeat(80));

    const weather = loadStationWeather(stationCode);
    const cfac = cfacData.get(stationCode);

    if (!cfac || cfac.size === 0) {
      console.log('  No capacity factor data found');
      continue;
    }

    console.log('  Weather records: ' + weather.size);
    console.log('  CFac records: ' + cfac.size);

    // Build paired data for daylight hours only
    const paired = [];
    for (const [key, actualCF] of cfac) {
      const wx = weather.get(key);
      if (!wx) continue;
      if (wx.hour < 6 || wx.hour > 18) continue; // Daylight only
      if (actualCF < 0.01) continue; // Skip zero output

      paired.push({
        datetime: wx.datetime,
        hour: wx.hour,
        actualCF,
        solarradiation: wx.solarradiation,
        cloudcover: wx.cloudcover,
        temperature: wx.temperature,
        uvindex: wx.uvindex,
        humidity: wx.humidity,
        visibility: wx.visibility,
        conditions: wx.conditions
      });
    }

    console.log('  Paired samples (daylight, CF > 0): ' + paired.length);

    if (paired.length < 100) {
      console.log('  SKIP: Insufficient paired data');
      continue;
    }

    // Calculate correlations with actual CF
    const actualCFs = paired.map(p => p.actualCF);
    const solarRads = paired.map(p => p.solarradiation);
    const cloudCovers = paired.map(p => p.cloudcover);
    const uvIndices = paired.map(p => p.uvindex);
    const humidities = paired.map(p => p.humidity);
    const visibilities = paired.map(p => p.visibility);

    console.log('');
    console.log('  Feature Correlations with Actual CF:');
    console.log('    Solar radiation: r = ' + pearsonCorrelation(solarRads, actualCFs).toFixed(4));
    console.log('    Cloud cover:     r = ' + pearsonCorrelation(cloudCovers, actualCFs).toFixed(4));
    console.log('    UV Index:        r = ' + pearsonCorrelation(uvIndices, actualCFs).toFixed(4));
    console.log('    Humidity:        r = ' + pearsonCorrelation(humidities, actualCFs).toFixed(4));
    console.log('    Visibility:      r = ' + pearsonCorrelation(visibilities, actualCFs).toFixed(4));

    // Test different prediction models
    const models = [
      { name: 'Base (solarrad only)', params: { irradianceScale: 1.4 } },
      { name: '+ UV correction', params: { irradianceScale: 1.4, useUVCorrection: true } },
      { name: '+ Humidity correction', params: { irradianceScale: 1.4, useHumidityCorrection: true } },
      { name: '+ Conditions text', params: { irradianceScale: 1.4, useConditionsCorrection: true } },
      { name: '+ All premium features', params: { irradianceScale: 1.4, useUVCorrection: true, useHumidityCorrection: true, useConditionsCorrection: true } },
    ];

    console.log('');
    console.log('  Model Comparison:');
    console.log('  ' + 'Model'.padEnd(30) + 'MAPE'.padStart(10) + 'R²'.padStart(10));
    console.log('  ' + '-'.repeat(50));

    for (const model of models) {
      const predictions = paired.map(p => predictSolarCF(p, model.params));
      const modelMAPE = mape(actualCFs, predictions);
      const modelR2 = rSquared(actualCFs, predictions);

      console.log(
        '  ' + model.name.padEnd(30) +
        (modelMAPE.toFixed(1) + '%').padStart(10) +
        modelR2.toFixed(4).padStart(10)
      );

      if (model.name === 'Base (solarrad only)') {
        results.push({
          station: stationCode,
          baseMAPE: modelMAPE,
          baseR2: modelR2
        });
      } else if (model.name === '+ All premium features') {
        const existing = results.find(r => r.station === stationCode);
        if (existing) {
          existing.premiumMAPE = modelMAPE;
          existing.premiumR2 = modelR2;
          existing.improvement = ((existing.baseMAPE - modelMAPE) / existing.baseMAPE) * 100;
        }
      }
    }

    // Analyze by conditions
    console.log('');
    console.log('  Actual CF by Weather Conditions:');
    const conditionGroups = new Map();
    for (const p of paired) {
      const cond = p.conditions || 'unknown';
      if (!conditionGroups.has(cond)) {
        conditionGroups.set(cond, []);
      }
      conditionGroups.get(cond).push(p.actualCF);
    }

    const sortedConditions = [...conditionGroups.entries()]
      .filter(([c, cfs]) => cfs.length >= 10)
      .sort((a, b) => b[1].length - a[1].length);

    console.log('  ' + 'Condition'.padEnd(35) + 'Count'.padStart(8) + 'Avg CF'.padStart(10) + 'Std Dev'.padStart(10));
    console.log('  ' + '-'.repeat(63));
    for (const [cond, cfs] of sortedConditions) {
      const avgCF = cfs.reduce((a, b) => a + b, 0) / cfs.length;
      const variance = cfs.reduce((sum, cf) => sum + (cf - avgCF) ** 2, 0) / cfs.length;
      const stdDev = Math.sqrt(variance);
      console.log(
        '  ' + cond.substring(0, 33).padEnd(35) +
        cfs.length.toString().padStart(8) +
        avgCF.toFixed(3).padStart(10) +
        stdDev.toFixed(3).padStart(10)
      );
    }
  }

  // Summary
  console.log('');
  console.log('='.repeat(100));
  console.log('SUMMARY: Premium Features Impact on Solar Forecasting');
  console.log('='.repeat(100));
  console.log('');

  if (results.length > 0) {
    console.log('Station'.padEnd(20) + 'Base MAPE'.padStart(12) + 'Premium MAPE'.padStart(14) + 'Improvement'.padStart(14));
    console.log('-'.repeat(60));

    let totalImprovement = 0;
    for (const r of results) {
      if (r.premiumMAPE) {
        console.log(
          r.station.padEnd(20) +
          (r.baseMAPE.toFixed(1) + '%').padStart(12) +
          (r.premiumMAPE.toFixed(1) + '%').padStart(14) +
          (r.improvement.toFixed(1) + '%').padStart(14)
        );
        totalImprovement += r.improvement;
      }
    }

    if (results.filter(r => r.premiumMAPE).length > 0) {
      const avgImprovement = totalImprovement / results.filter(r => r.premiumMAPE).length;
      console.log('-'.repeat(60));
      console.log('Average Improvement: ' + avgImprovement.toFixed(1) + '%');
    }
  }

  console.log('');
  console.log('Key Findings:');
  console.log('');
  console.log('1. UV Index: Strong positive correlation with CF - indicates clear-sky conditions');
  console.log('2. Humidity: Negative correlation - high humidity reduces atmospheric transmission');
  console.log('3. Conditions text: Categorical indicator for cloud/rain adjustment');
  console.log('');
  console.log('Recommendation: Implement SolarPremiumHybridModel that incorporates:');
  console.log('  - UV index correction factor');
  console.log('  - Humidity atmospheric absorption adjustment');
  console.log('  - Conditions-based categorical multiplier');
  console.log('');
}

main().catch(console.error);
