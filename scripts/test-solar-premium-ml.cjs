/**
 * Test Solar Premium Hybrid Model with ML Residual Learning
 *
 * Instead of fixed physics corrections, we use ML to learn
 * the optimal correction weights from training data.
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
        const dt = DateTime.fromISO(datetimeStr).plus({ hours: 1 });
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
          solarRadiation: getValue('solarradiation'),
          cloudCover: getValue('cloudcover'),
          temperature: getValue('temp'),
          windSpeed: getValue('windspeed'),
          windGust: getValue('windgust'),
          uvIndex: getValue('uvindex'),
          humidity: getValue('humidity'),
          visibility: getValue('visibility'),
          precipProb: getValue('precipprob'),
          pressure: getValue('sealevelpressure') || getValue('pressure'),
          conditions: conditions.replace(/"/g, '').toLowerCase()
        });
      }
    }
  }

  return weatherMap;
}

// Load capacity factors for solar stations
function loadCapacityFactors() {
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

// Simple linear regression for multi-feature model
class MultiFeatureLinearModel {
  constructor() {
    this.weights = null;
    this.bias = 0;
  }

  // Fit using normal equation: w = (X^T X)^(-1) X^T y
  fit(features, targets) {
    const n = features.length;
    const m = features[0].length;

    // Add bias column
    const X = features.map(f => [...f, 1]);

    // X^T X
    const XtX = [];
    for (let i = 0; i < m + 1; i++) {
      XtX[i] = [];
      for (let j = 0; j < m + 1; j++) {
        let sum = 0;
        for (let k = 0; k < n; k++) {
          sum += X[k][i] * X[k][j];
        }
        // Regularization for stability
        XtX[i][j] = sum + (i === j ? 0.001 : 0);
      }
    }

    // X^T y
    const Xty = [];
    for (let i = 0; i < m + 1; i++) {
      let sum = 0;
      for (let k = 0; k < n; k++) {
        sum += X[k][i] * targets[k];
      }
      Xty[i] = sum;
    }

    // Solve using Gaussian elimination
    const augmented = XtX.map((row, i) => [...row, Xty[i]]);
    const size = m + 1;

    // Forward elimination
    for (let col = 0; col < size; col++) {
      // Find pivot
      let maxRow = col;
      for (let row = col + 1; row < size; row++) {
        if (Math.abs(augmented[row][col]) > Math.abs(augmented[maxRow][col])) {
          maxRow = row;
        }
      }
      [augmented[col], augmented[maxRow]] = [augmented[maxRow], augmented[col]];

      // Eliminate
      const pivot = augmented[col][col];
      if (Math.abs(pivot) < 1e-10) continue;

      for (let row = col + 1; row < size; row++) {
        const factor = augmented[row][col] / pivot;
        for (let j = col; j <= size; j++) {
          augmented[row][j] -= factor * augmented[col][j];
        }
      }
    }

    // Back substitution
    const solution = new Array(size).fill(0);
    for (let row = size - 1; row >= 0; row--) {
      let sum = augmented[row][size];
      for (let col = row + 1; col < size; col++) {
        sum -= augmented[row][col] * solution[col];
      }
      solution[row] = Math.abs(augmented[row][row]) > 1e-10 ? sum / augmented[row][row] : 0;
    }

    this.weights = solution.slice(0, m);
    this.bias = solution[m];
  }

  predict(features) {
    if (!this.weights) return 0;
    let sum = this.bias;
    for (let i = 0; i < features.length; i++) {
      sum += this.weights[i] * features[i];
    }
    return sum;
  }
}

// Solar MREC calibration
function calibrateSolarMREC(data) {
  if (data.length < 100) return null;

  const sorted = [...data].sort((a, b) => b.irradiance - a.irradiance);
  const PoEH = 0.1, PoEL = 0.3;
  const idxH = Math.floor(sorted.length * PoEH);
  const idxL = Math.floor(sorted.length * PoEL);

  const highTier = sorted.slice(0, idxH);
  const midTier = sorted.slice(idxH, idxL);
  const lowTier = sorted.slice(idxL);

  if (highTier.length === 0 || midTier.length === 0 || lowTier.length === 0) return null;

  const avgH = { cf: highTier.reduce((s, d) => s + d.capacityFactor, 0) / highTier.length, irr: highTier.reduce((s, d) => s + d.irradiance, 0) / highTier.length };
  const avgM = { cf: midTier.reduce((s, d) => s + d.capacityFactor, 0) / midTier.length, irr: midTier.reduce((s, d) => s + d.irradiance, 0) / midTier.length };
  const avgL = { cf: lowTier.reduce((s, d) => s + d.capacityFactor, 0) / lowTier.length, irr: lowTier.reduce((s, d) => s + d.irradiance, 0) / lowTier.length };

  const MRecH = avgH.irr > 0 ? avgH.cf / avgH.irr : 0;
  const MRecM = avgM.irr > 0 ? avgM.cf / avgM.irr : 0;
  const MRecL = avgL.irr > 0 ? avgL.cf / avgL.irr : 0;

  return { MRecH, MRecM, MRecL, irrH: highTier[highTier.length - 1].irradiance, irrL: midTier[midTier.length - 1].irradiance };
}

// MREC-only prediction
function predictMREC(factors, irradiance) {
  if (!factors || irradiance <= 0) return 0;
  let mrec;
  if (irradiance >= factors.irrH) mrec = factors.MRecH;
  else if (irradiance >= factors.irrL) mrec = factors.MRecM;
  else mrec = factors.MRecL;
  return Math.max(0, Math.min(1, mrec * irradiance));
}

// Build feature vector for ML model
function buildFeatures(weather, mrecPred) {
  const irr = weather.solarRadiation;
  const cond = (weather.conditions || '').toLowerCase();

  return [
    mrecPred,                                        // Base MREC prediction (anchor)
    Math.min(weather.uvIndex / 10, 1) || 0.5,       // UV normalized
    (weather.humidity || 70) / 100,                  // Humidity normalized
    Math.min((weather.visibility || 10) / 20, 1),   // Visibility normalized
    (weather.cloudCover || 50) / 100,               // Cloud cover normalized
    ((weather.temperature || 25) - 25) / 20,        // Temperature deviation
    cond.includes('clear') ? 1 : 0,                 // Clear conditions
    cond.includes('overcast') ? 1 : 0,              // Overcast conditions
    cond.includes('rain') ? 1 : 0,                  // Rain conditions
    irr / 1000,                                      // Normalized irradiance
  ];
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

// Main test
async function main() {
  console.log('');
  console.log('='.repeat(90));
  console.log('SOLAR PREMIUM HYBRID MODEL TEST - ML RESIDUAL LEARNING');
  console.log('='.repeat(90));
  console.log('');

  const cfacData = loadCapacityFactors();
  const weatherCacheDir = join(process.cwd(), 'weather_cache');
  const stationDirs = readdirSync(weatherCacheDir)
    .filter(d => d.startsWith('station_'))
    .map(d => d.replace('station_', ''));

  const solarStations = ['01CLARK', '01HERMOSA_S', '06HELIOS', '02DOLORES_S'];
  const availableStations = solarStations.filter(s => stationDirs.includes(s));

  console.log('Available solar stations: ' + availableStations.join(', '));
  console.log('');

  if (availableStations.length === 0) {
    console.log('No solar station weather data available.');
    return;
  }

  const results = [];
  const trainMonths = [7, 8, 9, 10];
  const testMonths = [11, 12];

  for (const stationCode of availableStations) {
    console.log('-'.repeat(70));
    console.log('Station: ' + stationCode);
    console.log('-'.repeat(70));

    const weather = loadStationWeather(stationCode);
    const cfac = cfacData.get(stationCode);

    if (!cfac || cfac.size === 0) {
      console.log('  No capacity factor data');
      continue;
    }

    console.log('  Weather: ' + weather.size + ', CFac: ' + cfac.size);

    // Build paired data
    const trainData = [];
    const testData = [];

    for (const [key, actualCF] of cfac) {
      const wx = weather.get(key);
      if (!wx) continue;
      if (wx.hour < 6 || wx.hour > 18) continue;
      if (actualCF < 0.01 || wx.solarRadiation < 10) continue;

      const dt = DateTime.fromFormat(key, 'yyyy-MM-dd HH:mm');
      const month = dt.month;

      const dataPoint = { irradiance: wx.solarRadiation, capacityFactor: actualCF, weather: wx };

      if (trainMonths.includes(month)) trainData.push(dataPoint);
      else if (testMonths.includes(month)) testData.push(dataPoint);
    }

    console.log('  Train: ' + trainData.length + ', Test: ' + testData.length);

    if (trainData.length < 100 || testData.length < 50) {
      console.log('  SKIP: Insufficient data');
      continue;
    }

    // Calibrate MREC
    const mrecFactors = calibrateSolarMREC(trainData);
    if (!mrecFactors) {
      console.log('  SKIP: Failed to calibrate MREC');
      continue;
    }

    console.log('  MREC: MRecH=' + mrecFactors.MRecH.toFixed(6) + ', MRecM=' + mrecFactors.MRecM.toFixed(6) + ', MRecL=' + mrecFactors.MRecL.toFixed(6));

    // Train ML residual model
    const trainFeatures = [];
    const trainResiduals = [];

    for (const d of trainData) {
      const mrecPred = predictMREC(mrecFactors, d.irradiance);
      const residual = d.capacityFactor - mrecPred;
      trainFeatures.push(buildFeatures(d.weather, mrecPred));
      trainResiduals.push(residual);
    }

    const mlModel = new MultiFeatureLinearModel();
    mlModel.fit(trainFeatures, trainResiduals);

    console.log('  ML weights: ' + (mlModel.weights ? mlModel.weights.map(w => w.toFixed(4)).join(', ') : 'none'));

    // Evaluate on test set
    const mrecPreds = testData.map(d => predictMREC(mrecFactors, d.irradiance));

    const mlPreds = testData.map(d => {
      const mrecPred = predictMREC(mrecFactors, d.irradiance);
      const features = buildFeatures(d.weather, mrecPred);
      const residual = mlModel.predict(features);
      return Math.max(0, Math.min(1, mrecPred + residual));
    });

    const actuals = testData.map(d => d.capacityFactor);

    const mrecMAPE = calculateMAPE(mrecPreds, actuals);
    const mlMAPE = calculateMAPE(mlPreds, actuals);
    const improvement = ((mrecMAPE - mlMAPE) / mrecMAPE) * 100;

    console.log('');
    console.log('  Test Set Results (Nov-Dec):');
    console.log('    MREC-only MAPE:    ' + mrecMAPE.toFixed(1) + '%');
    console.log('    ML Hybrid MAPE:    ' + mlMAPE.toFixed(1) + '%');
    console.log('    Improvement:       ' + improvement.toFixed(1) + '%');

    results.push({ station: stationCode, trainSamples: trainData.length, testSamples: testData.length, mrecMAPE, mlMAPE, improvement });
  }

  // Summary
  console.log('');
  console.log('='.repeat(90));
  console.log('SUMMARY');
  console.log('='.repeat(90));
  console.log('');

  if (results.length > 0) {
    console.log('Station'.padEnd(20) + 'Train'.padStart(8) + 'Test'.padStart(8) + 'MREC MAPE'.padStart(12) + 'ML Hybrid'.padStart(12) + 'Improve'.padStart(12));
    console.log('-'.repeat(72));

    let totalMrec = 0, totalMl = 0;
    for (const r of results) {
      console.log(
        r.station.padEnd(20) +
        r.trainSamples.toString().padStart(8) +
        r.testSamples.toString().padStart(8) +
        (r.mrecMAPE.toFixed(1) + '%').padStart(12) +
        (r.mlMAPE.toFixed(1) + '%').padStart(12) +
        (r.improvement.toFixed(1) + '%').padStart(12)
      );
      totalMrec += r.mrecMAPE;
      totalMl += r.mlMAPE;
    }

    console.log('-'.repeat(72));
    const avgMrec = totalMrec / results.length;
    const avgMl = totalMl / results.length;
    const avgImprove = ((avgMrec - avgMl) / avgMrec) * 100;
    console.log('Average'.padEnd(36) + (avgMrec.toFixed(1) + '%').padStart(12) + (avgMl.toFixed(1) + '%').padStart(12) + (avgImprove.toFixed(1) + '%').padStart(12));
  }

  console.log('');
  console.log('Feature importance (learned weights):');
  console.log('  0: MREC base prediction (anchor)');
  console.log('  1: UV index (clear-sky indicator)');
  console.log('  2: Humidity (atmospheric absorption)');
  console.log('  3: Visibility (haze indicator)');
  console.log('  4: Cloud cover');
  console.log('  5: Temperature deviation');
  console.log('  6: Clear conditions flag');
  console.log('  7: Overcast conditions flag');
  console.log('  8: Rain conditions flag');
  console.log('  9: Normalized irradiance');
  console.log('');
}

main().catch(console.error);
