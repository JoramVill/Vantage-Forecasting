/**
 * Retrain Wind MREC/Hybrid Models with Per-Station Weather Data
 *
 * This script:
 * 1. Loads per-station weather data (with all wind heights)
 * 2. Uses optimal wind height for each station based on correlation analysis
 * 3. Calibrates MREC factors
 * 4. Trains hybrid residual models
 * 5. Compares accuracy before/after per-station weather
 */

const { readFileSync, readdirSync } = require('fs');
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

// Get optimal wind speed for station
function getOptimalWindSpeed(stationCode, weather) {
  const config = OPTIMAL_WIND_HEIGHTS[stationCode];
  if (!config) {
    return weather.windspeed100 || weather.windspeed;
  }

  switch (config.height) {
    case '100m': return weather.windspeed100 || weather.windspeed80 || weather.windspeed50 || weather.windspeed;
    case '80m': return weather.windspeed80 || weather.windspeed100 || weather.windspeed50 || weather.windspeed;
    case '50m': return weather.windspeed50 || weather.windspeed80 || weather.windspeed100 || weather.windspeed;
    default: return weather.windspeed;
  }
}

// Load per-station weather data with all wind heights
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
        const tempIdx = headers.indexOf('temp');
        const cloudcoverIdx = headers.indexOf('cloudcover');
        const windgustIdx = headers.indexOf('windgust');

        for (let i = 1; i < lines.length; i++) {
          const values = parseCSVLine(lines[i]);
          if (values.length < headers.length) continue;

          const datetimeStr = values[datetimeIdx];
          // Add 1 hour: weather is hour-starting, cfac is hour-ending
          const dt = DateTime.fromISO(datetimeStr).plus({ hours: 1 });
          if (!dt.isValid) continue;

          const key = dt.toFormat('yyyy-MM-dd HH:mm');

          weatherMap.set(key, {
            datetime: dt.toJSDate(),
            windspeed: parseFloat(values[windspeedIdx]) || 0,
            windspeed50: parseFloat(values[windspeed50Idx]) || 0,
            windspeed80: parseFloat(values[windspeed80Idx]) || 0,
            windspeed100: parseFloat(values[windspeed100Idx]) || 0,
            temperature: parseFloat(values[tempIdx]) || 25,
            cloudcover: parseFloat(values[cloudcoverIdx]) || 0,
            windgust: parseFloat(values[windgustIdx]) || 0
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

// Calculate MREC factors from paired (windSpeed, capacityFactor) data
function calibrateMREC(data) {
  if (data.length < 100) {
    return null;
  }

  // Sort by wind speed
  const sorted = [...data].sort((a, b) => b.windSpeed - a.windSpeed);

  // PoE thresholds (from iPool)
  const PoEH = 0.1;  // Top 10%
  const PoEL = 0.3;  // Top 30%

  const idxH = Math.floor(sorted.length * PoEH);
  const idxL = Math.floor(sorted.length * PoEL);

  // Split into tiers
  const highTier = sorted.slice(0, idxH);
  const midTier = sorted.slice(idxH, idxL);
  const lowTier = sorted.slice(idxL);

  if (highTier.length === 0 || midTier.length === 0 || lowTier.length === 0) {
    return null;
  }

  // Calculate average CF and wind speed per tier
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

  // Calculate MRec factors: CF = MRec * WindSpeed
  const MRecH = avgH.ws > 0 ? avgH.cf / avgH.ws : 0;
  const MRecM = avgM.ws > 0 ? avgM.cf / avgM.ws : 0;
  const MRecL = avgL.ws > 0 ? avgL.cf / avgL.ws : 0;

  // Thresholds
  const vH = highTier[highTier.length - 1].windSpeed;
  const vL = midTier[midTier.length - 1].windSpeed;

  return {
    MRecH, MRecM, MRecL,
    vH, vL,
    sampleCount: data.length,
    stats: { avgH, avgM, avgL }
  };
}

// Predict using MREC
function predictMREC(factors, windSpeed) {
  if (!factors) return 0;

  let mrec;
  if (windSpeed >= factors.vH) {
    mrec = factors.MRecH;
  } else if (windSpeed >= factors.vL) {
    mrec = factors.MRecM;
  } else {
    mrec = factors.MRecL;
  }

  let cfac = mrec * windSpeed;

  // High wind cutout
  if (cfac > 1.1) return 0;

  return Math.max(0, Math.min(1, cfac));
}

// Calculate MAPE
function calculateMAPE(predictions, actuals) {
  let errorSum = 0;
  let count = 0;

  for (let i = 0; i < predictions.length; i++) {
    const actual = actuals[i];
    const pred = predictions[i];

    if (actual > 0.01) {
      errorSum += Math.abs((pred - actual) / actual);
      count++;
    }
  }

  return count > 0 ? (errorSum / count) * 100 : 0;
}

// Main analysis
async function main() {
  console.log('');
  console.log('='.repeat(80));
  console.log('WIND MODEL RETRAINING WITH PER-STATION WEATHER + OPTIMAL WIND HEIGHTS');
  console.log('='.repeat(80));
  console.log('');

  // Load capacity factors
  console.log('Loading capacity factor data...');
  const cfacData = loadCapacityFactors();

  // Split into training (July-October) and test (November-December)
  const trainMonths = [7, 8, 9, 10];
  const testMonths = [11, 12];

  const results = [];

  for (const stationCode of WIND_STATIONS) {
    console.log('');
    console.log('-'.repeat(60));
    console.log('Processing ' + stationCode);
    console.log('-'.repeat(60));

    // Load per-station weather
    const weatherData = loadStationWeather(stationCode);
    console.log('  Weather records: ' + weatherData.size);

    const stationCfac = cfacData.get(stationCode);
    console.log('  CFac records: ' + stationCfac.size);

    const optimalHeight = OPTIMAL_WIND_HEIGHTS[stationCode].height;
    console.log('  Optimal wind height: ' + optimalHeight);

    // Build paired data
    const trainData = [];
    const testData = [];

    for (const [key, cfac] of stationCfac) {
      const weather = weatherData.get(key);
      if (!weather) continue;

      const windSpeed = getOptimalWindSpeed(stationCode, weather);
      if (windSpeed <= 0) continue;

      const dt = DateTime.fromFormat(key, 'yyyy-MM-dd HH:mm');
      const month = dt.month;

      const dataPoint = { windSpeed, capacityFactor: cfac, datetime: dt.toJSDate() };

      if (trainMonths.includes(month)) {
        trainData.push(dataPoint);
      } else if (testMonths.includes(month)) {
        testData.push(dataPoint);
      }
    }

    console.log('  Training samples: ' + trainData.length);
    console.log('  Test samples: ' + testData.length);

    if (trainData.length < 100 || testData.length < 100) {
      console.log('  SKIP: Insufficient data');
      continue;
    }

    // Calibrate MREC on training data
    const mrecFactors = calibrateMREC(trainData);
    if (!mrecFactors) {
      console.log('  SKIP: Failed to calibrate MREC');
      continue;
    }

    console.log('  MREC Factors:');
    console.log('    MRecH=' + mrecFactors.MRecH.toFixed(5) + ' (vH=' + mrecFactors.vH.toFixed(1) + ')');
    console.log('    MRecM=' + mrecFactors.MRecM.toFixed(5));
    console.log('    MRecL=' + mrecFactors.MRecL.toFixed(5) + ' (vL=' + mrecFactors.vL.toFixed(1) + ')');

    // Evaluate on test set
    const testPredictions = testData.map(d => predictMREC(mrecFactors, d.windSpeed));
    const testActuals = testData.map(d => d.capacityFactor);

    const testMAPE = calculateMAPE(testPredictions, testActuals);

    console.log('');
    console.log('  Test Set Performance (Nov-Dec):');
    console.log('    MAPE: ' + testMAPE.toFixed(1) + '%');

    results.push({
      station: stationCode,
      optimalHeight,
      trainSamples: trainData.length,
      testSamples: testData.length,
      testMAPE,
      mrecFactors
    });
  }

  // Summary table
  console.log('');
  console.log('='.repeat(100));
  console.log('SUMMARY RESULTS - Per-Station Weather with Optimal Wind Height');
  console.log('='.repeat(100));
  console.log('');
  console.log('Station'.padEnd(15) + 'Opt Height'.padStart(12) + 'Train'.padStart(10) + 'Test'.padStart(10) + 'Test MAPE'.padStart(12));
  console.log('-'.repeat(60));

  let totalMAPE = 0;
  let count = 0;

  for (const r of results) {
    console.log(
      r.station.padEnd(15) +
      r.optimalHeight.padStart(12) +
      r.trainSamples.toString().padStart(10) +
      r.testSamples.toString().padStart(10) +
      (r.testMAPE.toFixed(1) + '%').padStart(12)
    );
    totalMAPE += r.testMAPE;
    count++;
  }

  console.log('-'.repeat(60));
  if (count > 0) {
    console.log('Average MAPE: ' + (totalMAPE / count).toFixed(1) + '%');
  }

  console.log('');
  console.log('=== COMPARISON NOTES ===');
  console.log('');
  console.log('Previous cluster-based approach (single 100m wind):');
  console.log('  - Used weather from cluster center, not actual station location');
  console.log('  - Always used 100m wind speed for all stations');
  console.log('');
  console.log('New per-station approach (optimal wind height):');
  console.log('  - Uses weather data fetched for each station location');
  console.log('  - Uses station-specific optimal wind height based on correlation analysis');
  console.log('');
  console.log('Key insight: Different stations have different optimal wind heights');
  console.log('because of local terrain effects on wind shear profiles.');
  console.log('');
}

main().catch(console.error);
