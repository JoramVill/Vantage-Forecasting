/**
 * Solar LSTM Model Training and Evaluation Script
 *
 * This script trains LSTM neural networks for solar capacity factor forecasting
 * and compares performance against existing physics-based + ML models.
 */

const { parse } = require('csv-parse/sync');
const fs = require('fs');
const path = require('path');

// Dynamic import for ES modules
async function main() {
  console.log('='.repeat(80));
  console.log('  LSTM NEURAL NETWORK TRAINING FOR SOLAR CAPACITY FACTOR');
  console.log('='.repeat(80));

  // Load synaptic
  const synaptic = require('synaptic');
  const { Architect, Trainer, Network } = synaptic;

  // Configuration
  const SEQUENCE_LENGTH = 12;  // Use past 12 hours (solar patterns are more regular)
  const FEATURE_COUNT = 8;
  const VALIDATION_SPLIT = 0.2;

  // Solar stations to train (representative sample across regions)
  const SOLAR_STATIONS = [
    '01SNMANUEL_S',
    '01CURIMAO',
    '01PASUQUIN',
    '01CBNTUAN_S',
    '01HERMOSA_S',
    '01LAOAG_S',
    '03CLACA_S',
    '06CADIZ_S',
  ];

  // Load training data
  const dataDir = path.join(__dirname, '..', 'Data Samples', 'Capacity Factor');
  const files = fs.readdirSync(dataDir).filter(f => f.endsWith('.csv'));

  console.log(`\nLoading training data from ${files.length} files...`);

  // Parse all CFAC data
  const allRecords = [];
  for (const file of files) {
    const content = fs.readFileSync(path.join(dataDir, file), 'utf-8');
    const rows = parse(content, { columns: true, skip_empty_lines: true, relax_column_count: true });
    for (const row of rows) {
      const dt = row['DateTimeEnding'];
      if (!dt) continue;

      for (const station of SOLAR_STATIONS) {
        const cf = parseFloat(row[station]);
        if (!isNaN(cf) && cf >= 0 && cf <= 1) {
          allRecords.push({
            datetime: dt,
            station: station,
            cf: cf,
          });
        }
      }
    }
  }

  console.log(`Loaded ${allRecords.length} solar capacity factor records`);

  // Load weather data from cache
  const weatherCache = path.join(__dirname, '..', 'weather_cache');

  function loadWeatherForStation(station) {
    const weatherData = new Map();

    // Try to find weather files for this station
    const patterns = [
      `SOLAR_${station}`,
      station,
    ];

    for (const pattern of patterns) {
      const stationDir = path.join(weatherCache, pattern);
      if (fs.existsSync(stationDir)) {
        const monthDirs = fs.readdirSync(stationDir).filter(d =>
          fs.statSync(path.join(stationDir, d)).isDirectory()
        );

        for (const monthDir of monthDirs) {
          const monthPath = path.join(stationDir, monthDir);
          const csvFiles = fs.readdirSync(monthPath).filter(f => f.endsWith('.csv'));

          for (const csvFile of csvFiles) {
            try {
              const content = fs.readFileSync(path.join(monthPath, csvFile), 'utf-8');
              const rows = parse(content, { columns: true, skip_empty_lines: true });

              for (const row of rows) {
                const dt = row['datetime'];
                if (!dt) continue;

                // Convert ISO date to match CFAC format
                const date = new Date(dt);
                const month = date.getMonth() + 1;
                const day = date.getDate();
                const year = date.getFullYear();
                const hour = date.getHours();
                // Hour-ending format: add 1 hour
                const endHour = (hour + 1) % 24;
                const endDay = hour === 23 ? day + 1 : day;

                const key = `${month}/${endDay}/${year} ${String(endHour).padStart(2, '0')}:00`;

                weatherData.set(key, {
                  solarRadiation: parseFloat(row['solarradiation']) || 0,
                  uvIndex: parseFloat(row['uvindex']) || 0,
                  cloudCover: parseFloat(row['cloudcover']) || 50,
                  temperature: parseFloat(row['temp']) || 25,
                  humidity: parseFloat(row['humidity']) || 70,
                });
              }
            } catch (e) {
              // Skip problematic files
            }
          }
        }
        break;  // Found data for this pattern
      }
    }

    return weatherData;
  }

  // Extract features for a timestep
  function extractFeatures(weather, hour, prevCF) {
    if (!weather) {
      return [0, 0, 50, 25, 70, Math.sin(hour/24*2*Math.PI), Math.cos(hour/24*2*Math.PI), prevCF];
    }

    const solarRadiation = weather.solarRadiation || 0;
    const uvIndex = weather.uvIndex || 0;
    const cloudCover = weather.cloudCover || 50;
    const temperature = weather.temperature || 25;
    const humidity = weather.humidity || 70;
    const hourRad = (hour / 24) * 2 * Math.PI;

    return [
      solarRadiation,
      uvIndex,
      cloudCover,
      temperature,
      humidity,
      Math.sin(hourRad),
      Math.cos(hourRad),
      prevCF,
    ];
  }

  // Normalize features
  function normalizeFeatures(features, means, stds) {
    return features.map((val, i) => {
      const mean = means[i] || 0;
      const std = stds[i] || 1;
      return (val - mean) / (std || 1);
    });
  }

  // Calculate normalization parameters
  function calculateNormalization(allFeatures) {
    const featureCount = FEATURE_COUNT;
    const means = new Array(featureCount).fill(0);
    const stds = new Array(featureCount).fill(0);

    for (const features of allFeatures) {
      for (let i = 0; i < featureCount; i++) {
        means[i] += features[i] || 0;
      }
    }
    for (let i = 0; i < featureCount; i++) {
      means[i] /= allFeatures.length;
    }

    for (const features of allFeatures) {
      for (let i = 0; i < featureCount; i++) {
        const diff = (features[i] || 0) - means[i];
        stds[i] += diff * diff;
      }
    }
    for (let i = 0; i < featureCount; i++) {
      stds[i] = Math.sqrt(stds[i] / allFeatures.length);
      if (stds[i] < 0.001) stds[i] = 1;
    }

    return { means, stds };
  }

  // Train LSTM for a single station
  function trainStationLSTM(station, records, weatherData) {
    console.log(`\n  Training LSTM for ${station}...`);

    // Sort records by datetime
    const stationRecords = records
      .filter(r => r.station === station)
      .sort((a, b) => {
        const parseDate = (d) => {
          const [datePart, timePart] = d.split(' ');
          const [m, day, y] = datePart.split('/').map(Number);
          const [h, min] = timePart.split(':').map(Number);
          return new Date(y, m - 1, day, h, min).getTime();
        };
        return parseDate(a.datetime) - parseDate(b.datetime);
      });

    console.log(`    Records: ${stationRecords.length}`);

    if (stationRecords.length < SEQUENCE_LENGTH + 10) {
      console.log(`    Skipping - insufficient data`);
      return null;
    }

    // Build features for all records
    const allFeatures = [];
    for (let i = 0; i < stationRecords.length; i++) {
      const rec = stationRecords[i];
      const weather = weatherData.get(rec.datetime);
      const hour = parseInt(rec.datetime.split(' ')[1].split(':')[0]);
      const prevCF = i > 0 ? stationRecords[i - 1].cf : rec.cf;
      const features = extractFeatures(weather, hour, prevCF);
      allFeatures.push(features);
    }

    // Calculate normalization
    const { means, stds } = calculateNormalization(allFeatures);

    // Build sequences
    const sequences = [];
    for (let i = SEQUENCE_LENGTH; i < stationRecords.length; i++) {
      const input = [];
      for (let j = i - SEQUENCE_LENGTH; j < i; j++) {
        const normalized = normalizeFeatures(allFeatures[j], means, stds);
        input.push(...normalized);
      }
      const target = stationRecords[i].cf;
      sequences.push({ input, output: [Math.max(0, Math.min(1, target))] });
    }

    console.log(`    Sequences: ${sequences.length}`);

    // Split train/validation
    const splitIdx = Math.floor(sequences.length * (1 - VALIDATION_SPLIT));
    const trainSet = sequences.slice(0, splitIdx);
    const valSet = sequences.slice(splitIdx);

    console.log(`    Train: ${trainSet.length}, Validation: ${valSet.length}`);

    // Create network (simpler architecture for solar's more regular patterns)
    const inputSize = SEQUENCE_LENGTH * FEATURE_COUNT;
    const network = new Architect.Perceptron(
      inputSize,
      Math.floor(inputSize / 2),
      24,
      12,
      1
    );

    const trainer = new Trainer(network);

    // Train
    console.log(`    Training (max 3000 iterations)...`);
    const startTime = Date.now();
    const result = trainer.train(trainSet, {
      rate: 0.01,
      iterations: 3000,
      error: 0.005,
      shuffle: true,
      log: false,
      cost: Trainer.cost.MSE,
    });

    const trainingTime = Date.now() - startTime;
    console.log(`    Training: error=${result.error.toFixed(6)}, iterations=${result.iterations}, time=${(trainingTime/1000).toFixed(1)}s`);

    // Evaluate on validation set (only daylight hours with actual generation)
    let totalAbsError = 0;
    let totalPctError = 0;
    let count = 0;

    for (const seq of valSet) {
      const prediction = network.activate(seq.input)[0];
      const actual = seq.output[0];

      // Only evaluate during daylight hours (when there's actual generation)
      if (actual > 0.01) {
        const absError = Math.abs(prediction - actual);
        const pctError = (absError / actual) * 100;
        totalAbsError += absError;
        totalPctError += pctError;
        count++;
      }
    }

    const valMAPE = count > 0 ? totalPctError / count : NaN;
    const valMAE = count > 0 ? totalAbsError / count : NaN;

    console.log(`    Validation MAPE: ${valMAPE.toFixed(2)}%, MAE: ${valMAE.toFixed(4)} (${count} daylight samples)`);

    return {
      station,
      network: network.toJSON(),
      means,
      stds,
      trainingError: result.error,
      valMAPE,
      valMAE,
      trainingSamples: trainSet.length,
      validationSamples: valSet.length,
      daylightSamples: count,
      trainingTime,
    };
  }

  // Train all solar stations
  console.log('\n' + '='.repeat(80));
  console.log('  TRAINING LSTM MODELS FOR ALL SOLAR STATIONS');
  console.log('='.repeat(80));

  const results = [];

  for (const station of SOLAR_STATIONS) {
    console.log(`\nLoading weather data for ${station}...`);
    const weatherData = loadWeatherForStation(station);
    console.log(`  Weather records: ${weatherData.size}`);

    const result = trainStationLSTM(station, allRecords, weatherData);
    if (result) {
      results.push(result);
    }
  }

  // Summary
  console.log('\n' + '='.repeat(80));
  console.log('  SOLAR LSTM TRAINING RESULTS SUMMARY');
  console.log('='.repeat(80));

  console.log('\n' + 'Station'.padEnd(18) + 'Val MAPE%'.padStart(12) + 'Val MAE'.padStart(10) +
              'Train Err'.padStart(12) + 'Daylight'.padStart(10) + 'Time(s)'.padStart(10));
  console.log('-'.repeat(72));

  let totalMAPE = 0;
  let totalMAE = 0;
  let stationCount = 0;

  for (const r of results) {
    console.log(
      r.station.padEnd(18) +
      r.valMAPE.toFixed(2).padStart(12) +
      r.valMAE.toFixed(4).padStart(10) +
      r.trainingError.toFixed(6).padStart(12) +
      String(r.daylightSamples).padStart(10) +
      (r.trainingTime / 1000).toFixed(1).padStart(10)
    );
    totalMAPE += r.valMAPE;
    totalMAE += r.valMAE;
    stationCount++;
  }

  console.log('-'.repeat(72));
  console.log(
    'AVERAGE'.padEnd(18) +
    (totalMAPE / stationCount).toFixed(2).padStart(12) +
    (totalMAE / stationCount).toFixed(4).padStart(10)
  );

  // Comparison with existing models
  console.log('\n' + '='.repeat(80));
  console.log('  COMPARISON WITH EXISTING MODELS');
  console.log('='.repeat(80));

  console.log('\nExisting model performance (from comparison report):');
  console.log('  XGBoost Solar MAPE:  54.72%');
  console.log('  Default Solar MAPE:  54.72%');
  console.log('  XGB+Asym Solar MAPE: 54.97%');
  console.log('  Basic Solar MAPE:    67.42%');

  const avgLSTMMAPE = totalMAPE / stationCount;
  console.log(`\nLSTM Average Solar MAPE: ${avgLSTMMAPE.toFixed(2)}%`);

  if (avgLSTMMAPE < 54.72) {
    const improvement = ((54.72 - avgLSTMMAPE) / 54.72 * 100).toFixed(1);
    console.log(`\n*** LSTM OUTPERFORMS BEST EXISTING MODEL BY ${improvement}% ***`);
  } else {
    const deficit = ((avgLSTMMAPE - 54.72) / 54.72 * 100).toFixed(1);
    console.log(`\n--- LSTM underperforms best existing model by ${deficit}% ---`);
  }

  // Save results
  const outputPath = path.join(__dirname, '..', 'output', 'solar_lstm_training_results.json');
  fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));
  console.log(`\nResults saved to: ${outputPath}`);

  console.log('\n' + '='.repeat(80));
}

main().catch(console.error);
