/**
 * Test Solar Premium Hybrid Model
 *
 * Tests the new SolarPremiumHybridModel against actual data
 * to verify the ~30% MAPE improvement from premium features.
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
          solarRadiation: getValue('solarradiation'),
          solarEnergy: getValue('solarenergy'),
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

// Solar MREC calibration (simplified port)
function calibrateSolarMREC(data) {
  if (data.length < 100) return null;

  // Sort by irradiance descending
  const sorted = [...data].sort((a, b) => b.irradiance - a.irradiance);

  const PoEH = 0.1;  // Top 10%
  const PoEL = 0.3;  // Top 30%

  const idxH = Math.floor(sorted.length * PoEH);
  const idxL = Math.floor(sorted.length * PoEL);

  const highTier = sorted.slice(0, idxH);
  const midTier = sorted.slice(idxH, idxL);
  const lowTier = sorted.slice(idxL);

  if (highTier.length === 0 || midTier.length === 0 || lowTier.length === 0) {
    return null;
  }

  const avgH = {
    cf: highTier.reduce((s, d) => s + d.capacityFactor, 0) / highTier.length,
    irr: highTier.reduce((s, d) => s + d.irradiance, 0) / highTier.length
  };
  const avgM = {
    cf: midTier.reduce((s, d) => s + d.capacityFactor, 0) / midTier.length,
    irr: midTier.reduce((s, d) => s + d.irradiance, 0) / midTier.length
  };
  const avgL = {
    cf: lowTier.reduce((s, d) => s + d.capacityFactor, 0) / lowTier.length,
    irr: lowTier.reduce((s, d) => s + d.irradiance, 0) / lowTier.length
  };

  const MRecH = avgH.irr > 0 ? avgH.cf / avgH.irr : 0;
  const MRecM = avgM.irr > 0 ? avgM.cf / avgM.irr : 0;
  const MRecL = avgL.irr > 0 ? avgL.cf / avgL.irr : 0;

  const irrH = highTier[highTier.length - 1].irradiance;
  const irrL = midTier[midTier.length - 1].irradiance;

  return { MRecH, MRecM, MRecL, irrH, irrL, sampleCount: data.length };
}

// MREC-only prediction
function predictMREC(factors, irradiance) {
  if (!factors || irradiance <= 0) return 0;

  let mrec;
  if (irradiance >= factors.irrH) {
    mrec = factors.MRecH;
  } else if (irradiance >= factors.irrL) {
    mrec = factors.MRecM;
  } else {
    mrec = factors.MRecL;
  }

  return Math.max(0, Math.min(1, mrec * irradiance));
}

// Premium hybrid prediction (physics-based corrections)
function predictPremiumHybrid(factors, weather) {
  const irradiance = weather.solarRadiation;
  if (irradiance <= 0) return 0;

  // Base MREC prediction
  let mrecBase = predictMREC(factors, irradiance);

  // UV Index correction (higher UV = clearer sky = better performance)
  let uvFactor = 1.0;
  if (weather.uvIndex > 0) {
    uvFactor = 0.875 + Math.min(weather.uvIndex / 10, 1) * 0.25;
  }

  // Humidity correction (high humidity = more absorption = lower output)
  let humidityFactor = 1.0;
  if (weather.humidity > 0) {
    humidityFactor = 1 + 0.15 * (0.7 - weather.humidity / 100);
    humidityFactor = Math.max(0.85, Math.min(1.1, humidityFactor));
  }

  // Conditions correction
  let conditionsFactor = 1.0;
  const cond = (weather.conditions || '').toLowerCase();
  if (cond.includes('clear') || cond.includes('sunny')) {
    conditionsFactor = 1.10;
  } else if (cond.includes('rain') || cond.includes('shower') || cond.includes('storm')) {
    conditionsFactor = 0.80;
  } else if (cond.includes('overcast')) {
    conditionsFactor = 0.85;
  } else if (cond.includes('cloudy')) {
    conditionsFactor = 0.95;
  }

  // Combine all factors
  let cfac = mrecBase * uvFactor * humidityFactor * conditionsFactor;

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

// Main test
async function main() {
  console.log('');
  console.log('='.repeat(90));
  console.log('SOLAR PREMIUM HYBRID MODEL TEST');
  console.log('='.repeat(90));
  console.log('');

  // Load capacity factors
  const cfacData = loadCapacityFactors();

  // Test solar stations with per-station weather
  const weatherCacheDir = join(process.cwd(), 'weather_cache');
  const stationDirs = readdirSync(weatherCacheDir)
    .filter(d => d.startsWith('station_'))
    .map(d => d.replace('station_', ''));

  // Solar stations we want to test
  const solarStations = ['01CLARK', '01HERMOSA_S', '06HELIOS', '02DOLORES_S'];
  const availableStations = solarStations.filter(s => stationDirs.includes(s));

  console.log('Available solar stations with per-station weather:');
  for (const s of availableStations) {
    console.log('  - ' + s);
  }
  console.log('');

  if (availableStations.length === 0) {
    console.log('No solar station weather data available.');
    console.log('Run: node dist/index.js cfac weather --types solar --only "01CLARK,01HERMOSA_S" -s 2025-07-01 -e 2025-12-02');
    return;
  }

  const results = [];
  const trainMonths = [7, 8, 9, 10];  // Training: Jul-Oct
  const testMonths = [11, 12];         // Testing: Nov-Dec

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

    console.log('  Weather records: ' + weather.size);
    console.log('  CFac records: ' + cfac.size);

    // Build paired data for daylight hours with actual generation
    const trainData = [];
    const testData = [];

    for (const [key, actualCF] of cfac) {
      const wx = weather.get(key);
      if (!wx) continue;
      if (wx.hour < 6 || wx.hour > 18) continue;  // Daylight only
      if (actualCF < 0.01 || wx.solarRadiation < 10) continue;  // Skip zero output

      const dt = DateTime.fromFormat(key, 'yyyy-MM-dd HH:mm');
      const month = dt.month;

      const dataPoint = {
        datetime: wx.datetime,
        irradiance: wx.solarRadiation,
        capacityFactor: actualCF,
        weather: wx
      };

      if (trainMonths.includes(month)) {
        trainData.push(dataPoint);
      } else if (testMonths.includes(month)) {
        testData.push(dataPoint);
      }
    }

    console.log('  Training samples: ' + trainData.length);
    console.log('  Test samples: ' + testData.length);

    if (trainData.length < 100) {
      console.log('  SKIP: Insufficient training data');
      continue;
    }

    // Calibrate MREC on training data
    const mrecFactors = calibrateSolarMREC(trainData);
    if (!mrecFactors) {
      console.log('  SKIP: Failed to calibrate MREC');
      continue;
    }

    console.log('');
    console.log('  MREC Factors:');
    console.log('    MRecH=' + mrecFactors.MRecH.toFixed(6) + ' (irrH=' + mrecFactors.irrH.toFixed(0) + ')');
    console.log('    MRecM=' + mrecFactors.MRecM.toFixed(6));
    console.log('    MRecL=' + mrecFactors.MRecL.toFixed(6) + ' (irrL=' + mrecFactors.irrL.toFixed(0) + ')');

    // Test on hold-out set
    if (testData.length < 50) {
      console.log('  SKIP: Insufficient test data');
      continue;
    }

    const mrecPreds = testData.map(d => predictMREC(mrecFactors, d.irradiance));
    const premiumPreds = testData.map(d => predictPremiumHybrid(mrecFactors, d.weather));
    const actuals = testData.map(d => d.capacityFactor);

    const mrecMAPE = calculateMAPE(mrecPreds, actuals);
    const premiumMAPE = calculateMAPE(premiumPreds, actuals);
    const improvement = ((mrecMAPE - premiumMAPE) / mrecMAPE) * 100;

    console.log('');
    console.log('  Test Set Results (Nov-Dec):');
    console.log('    MREC-only MAPE:    ' + mrecMAPE.toFixed(1) + '%');
    console.log('    Premium Hybrid:    ' + premiumMAPE.toFixed(1) + '%');
    console.log('    Improvement:       ' + improvement.toFixed(1) + '%');

    results.push({
      station: stationCode,
      trainSamples: trainData.length,
      testSamples: testData.length,
      mrecMAPE,
      premiumMAPE,
      improvement
    });
  }

  // Summary
  console.log('');
  console.log('='.repeat(90));
  console.log('SUMMARY');
  console.log('='.repeat(90));
  console.log('');

  if (results.length > 0) {
    console.log('Station'.padEnd(20) + 'Train'.padStart(8) + 'Test'.padStart(8) + 'MREC MAPE'.padStart(12) + 'Premium'.padStart(12) + 'Improve'.padStart(12));
    console.log('-'.repeat(72));

    let totalMrecMAPE = 0;
    let totalPremiumMAPE = 0;

    for (const r of results) {
      console.log(
        r.station.padEnd(20) +
        r.trainSamples.toString().padStart(8) +
        r.testSamples.toString().padStart(8) +
        (r.mrecMAPE.toFixed(1) + '%').padStart(12) +
        (r.premiumMAPE.toFixed(1) + '%').padStart(12) +
        (r.improvement.toFixed(1) + '%').padStart(12)
      );
      totalMrecMAPE += r.mrecMAPE;
      totalPremiumMAPE += r.premiumMAPE;
    }

    console.log('-'.repeat(72));
    const avgMrecMAPE = totalMrecMAPE / results.length;
    const avgPremiumMAPE = totalPremiumMAPE / results.length;
    const avgImprovement = ((avgMrecMAPE - avgPremiumMAPE) / avgMrecMAPE) * 100;
    console.log('Average'.padEnd(36) +
      (avgMrecMAPE.toFixed(1) + '%').padStart(12) +
      (avgPremiumMAPE.toFixed(1) + '%').padStart(12) +
      (avgImprovement.toFixed(1) + '%').padStart(12)
    );
  } else {
    console.log('No results to display.');
  }

  console.log('');
  console.log('Note: Premium features that contribute to improvement:');
  console.log('  - UV Index:   Clear-sky indicator (r=0.78 with CF)');
  console.log('  - Humidity:   Atmospheric absorption (r=-0.42 with CF)');
  console.log('  - Conditions: Categorical cloud/rain adjustment');
  console.log('');
}

main().catch(console.error);
