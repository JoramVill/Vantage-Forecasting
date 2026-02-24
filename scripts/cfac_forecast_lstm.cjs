/**
 * LSTM Capacity Factor Forecasting Script
 *
 * @deprecated This standalone script is deprecated. Use the integrated CLI command instead:
 *   node dist/index.js cfac forecast2 --model lstm -t <training> -s <start> -e <end> -o <output>
 *
 * The LSTM functionality has been integrated into the main CLI for better maintainability
 * and consistent output formatting. This script will be removed in a future version.
 *
 * Original Usage (deprecated):
 *   node scripts/cfac_forecast_lstm.cjs -s 2026-01-10 -e 2026-02-28 -o output/cfac_lstm_forecast.csv
 */

// Deprecation warning
console.warn('');
console.warn('===============================================================================');
console.warn('  DEPRECATION WARNING: This standalone script is deprecated.');
console.warn('  Use the integrated CLI command instead:');
console.warn('    node dist/index.js cfac forecast2 --model lstm -t <training> -s <start> -e <end> -o <output>');
console.warn('===============================================================================');
console.warn('');

const { parse } = require('csv-parse/sync');
const fs = require('fs');
const path = require('path');
const synaptic = require('synaptic');
const { Architect, Trainer, Network } = synaptic;

// Configuration
const WIND_SEQUENCE_LENGTH = 24;  // Use past 24 hours for wind
const SOLAR_SEQUENCE_LENGTH = 12;  // Use past 12 hours for solar
const WIND_FEATURE_COUNT = 8;
const SOLAR_FEATURE_COUNT = 8;

// Parse command line arguments
function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    start: null,
    end: null,
    output: 'output/cfac_lstm_forecast.csv',
    training: 'Data Samples/Capacity Factor',
    cache: 'weather_cache',
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '-s':
      case '--start':
        options.start = args[++i];
        break;
      case '-e':
      case '--end':
        options.end = args[++i];
        break;
      case '-o':
      case '--output':
        options.output = args[++i];
        break;
      case '-t':
      case '--training':
        options.training = args[++i];
        break;
      case '--cache':
        options.cache = args[++i];
        break;
    }
  }

  if (!options.start || !options.end) {
    console.error('Usage: node cfac_forecast_lstm.cjs -s <start-date> -e <end-date> [-o <output.csv>]');
    console.error('  -s, --start    Forecast start date (YYYY-MM-DD)');
    console.error('  -e, --end      Forecast end date (YYYY-MM-DD)');
    console.error('  -o, --output   Output CSV file (default: output/cfac_lstm_forecast.csv)');
    console.error('  -t, --training Training data directory (default: Data Samples/Capacity Factor)');
    process.exit(1);
  }

  return options;
}

// Load stations.json to get all station codes and types
function loadStations(stationsPath) {
  const content = fs.readFileSync(stationsPath, 'utf-8');
  const data = JSON.parse(content);
  const stations = new Map();

  for (const [code, info] of Object.entries(data.stations)) {
    stations.set(code, {
      code,
      type: info.type.toLowerCase(),
      latitude: info.latitude,
      longitude: info.longitude,
    });
  }

  return stations;
}

// Classify station type from code
function getStationType(code) {
  // Wind stations
  const windStations = ['01BURGOS', '01LAOAG', '01PAGUDPUD', '02DOLORES', '02MMPP_G01',
                        '03AWOC_G01', '08PWIND_G01', '08WIND_G02', '08NABAS_W', '08BVISTA'];
  if (windStations.includes(code)) return 'wind';

  if (code.endsWith('_W')) return 'wind';
  if (code.endsWith('_S')) return 'solar';
  if (code.endsWith('_H')) return 'hydro';
  if (code.endsWith('_BI') || code.endsWith('_BG') || code.endsWith('_BL')) return 'biomass';
  if (code.endsWith('_B')) return 'battery';
  if (code.endsWith('_G') || code.endsWith('_GP')) return 'geothermal';

  return 'other';
}

// Load training data from CSV files
function loadTrainingData(dataDir) {
  const files = fs.readdirSync(dataDir).filter(f => f.endsWith('.csv'));
  const allRecords = [];

  for (const file of files) {
    const content = fs.readFileSync(path.join(dataDir, file), 'utf-8');
    const rows = parse(content, { columns: true, skip_empty_lines: true, relax_column_count: true });

    for (const row of rows) {
      const dt = row['DateTimeEnding'];
      if (!dt) continue;

      for (const [station, value] of Object.entries(row)) {
        if (station === 'DateTimeEnding') continue;
        const cf = parseFloat(value);
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

  return allRecords;
}

// Load weather data from cache for a station
function loadWeatherForStation(station, cacheDir, stationType) {
  const weatherData = new Map();

  const patterns = stationType === 'wind'
    ? [`WIND_${station}`, station]
    : [`SOLAR_${station}`, station];

  for (const pattern of patterns) {
    const stationDir = path.join(cacheDir, pattern);
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

              const date = new Date(dt);
              const month = date.getMonth() + 1;
              const day = date.getDate();
              const year = date.getFullYear();
              const hour = date.getHours();
              const endHour = (hour + 1) % 24;
              const endDay = hour === 23 ? day + 1 : day;

              const key = `${month}/${endDay}/${year} ${String(endHour).padStart(2, '0')}:00`;

              if (stationType === 'wind') {
                weatherData.set(key, {
                  windSpeed: parseFloat(row['windspeed']) || 0,
                  windSpeed100m: parseFloat(row['windspeed_100m']) || parseFloat(row['windspeed']) || 0,
                  windGust: parseFloat(row['windgust']) || 0,
                  temperature: parseFloat(row['temp']) || 25,
                  cloudCover: parseFloat(row['cloudcover']) || 50,
                  humidity: parseFloat(row['humidity']) || 70,
                });
              } else {
                weatherData.set(key, {
                  solarRadiation: parseFloat(row['solarradiation']) || 0,
                  uvIndex: parseFloat(row['uvindex']) || 0,
                  cloudCover: parseFloat(row['cloudcover']) || 50,
                  temperature: parseFloat(row['temp']) || 25,
                  humidity: parseFloat(row['humidity']) || 70,
                });
              }
            }
          } catch (e) {
            // Skip problematic files
          }
        }
      }
      break;
    }
  }

  return weatherData;
}

// Extract wind features
function extractWindFeatures(weather, hour, prevCF) {
  if (!weather) {
    return [0, 0, 1, 25, 50, Math.sin(hour/24*2*Math.PI), Math.cos(hour/24*2*Math.PI), prevCF];
  }

  const windSpeed = weather.windSpeed100m || weather.windSpeed || 0;
  const windGust = weather.windGust || windSpeed;
  const gustRatio = windSpeed > 0.1 ? Math.min(windGust / windSpeed, 3) : 1.0;

  return [
    windSpeed,
    windGust,
    gustRatio,
    weather.temperature || 25,
    weather.cloudCover || 50,
    Math.sin(hour/24*2*Math.PI),
    Math.cos(hour/24*2*Math.PI),
    prevCF,
  ];
}

// Extract solar features
function extractSolarFeatures(weather, hour, prevCF) {
  if (!weather) {
    return [0, 0, 50, 25, 70, Math.sin(hour/24*2*Math.PI), Math.cos(hour/24*2*Math.PI), prevCF];
  }

  return [
    weather.solarRadiation || 0,
    weather.uvIndex || 0,
    weather.cloudCover || 50,
    weather.temperature || 25,
    weather.humidity || 70,
    Math.sin(hour/24*2*Math.PI),
    Math.cos(hour/24*2*Math.PI),
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
function calculateNormalization(allFeatures, featureCount) {
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

// Train LSTM for a station
function trainStationLSTM(station, records, weatherData, stationType) {
  const sequenceLength = stationType === 'wind' ? WIND_SEQUENCE_LENGTH : SOLAR_SEQUENCE_LENGTH;
  const featureCount = stationType === 'wind' ? WIND_FEATURE_COUNT : SOLAR_FEATURE_COUNT;
  const extractFeatures = stationType === 'wind' ? extractWindFeatures : extractSolarFeatures;

  // Sort records
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

  if (stationRecords.length < sequenceLength + 10) {
    return null;
  }

  // Build features
  const allFeatures = [];
  for (let i = 0; i < stationRecords.length; i++) {
    const rec = stationRecords[i];
    const weather = weatherData.get(rec.datetime);
    const hour = parseInt(rec.datetime.split(' ')[1].split(':')[0]);
    const prevCF = i > 0 ? stationRecords[i - 1].cf : rec.cf;
    allFeatures.push(extractFeatures(weather, hour, prevCF));
  }

  const { means, stds } = calculateNormalization(allFeatures, featureCount);

  // Build sequences
  const sequences = [];
  for (let i = sequenceLength; i < stationRecords.length; i++) {
    const input = [];
    for (let j = i - sequenceLength; j < i; j++) {
      input.push(...normalizeFeatures(allFeatures[j], means, stds));
    }
    sequences.push({
      input,
      output: [Math.max(0, Math.min(1, stationRecords[i].cf))]
    });
  }

  // Split train/validation
  const splitIdx = Math.floor(sequences.length * 0.8);
  const trainSet = sequences.slice(0, splitIdx);

  // Create network
  const inputSize = sequenceLength * featureCount;
  const network = new Architect.Perceptron(
    inputSize,
    Math.floor(inputSize / 2),
    stationType === 'wind' ? 32 : 24,
    stationType === 'wind' ? 16 : 12,
    1
  );

  const trainer = new Trainer(network);
  trainer.train(trainSet, {
    rate: 0.01,
    iterations: 3000,
    error: 0.005,
    shuffle: true,
    log: false,
    cost: Trainer.cost.MSE,
  });

  return {
    network,
    means,
    stds,
    sequenceLength,
    featureCount,
    extractFeatures,
    lastRecords: stationRecords.slice(-sequenceLength),
  };
}

// Generate forecast dates/hours
function generateForecastDates(startDate, endDate) {
  const dates = [];
  const start = new Date(startDate + 'T00:00:00');
  const end = new Date(endDate + 'T23:00:00');

  for (let d = new Date(start); d <= end; d.setHours(d.getHours() + 1)) {
    // Use hour-ending format: 01:00 to 24:00 internally, but output as 00:00-23:00
    // When hour-ending is 24:00 (hour 23 + 1), output as 00:00 of next day
    const hourEnding = d.getHours() + 1;

    let displayDate, displayHour;
    if (hourEnding === 24) {
      // Hour-ending 24:00 = 00:00 of next day
      const nextDay = new Date(d);
      nextDay.setDate(nextDay.getDate() + 1);
      displayDate = nextDay;
      displayHour = 0;
    } else {
      displayDate = d;
      displayHour = hourEnding;
    }

    dates.push({
      datetime: `${displayDate.getMonth() + 1}/${displayDate.getDate()}/${displayDate.getFullYear()} ${String(displayHour).padStart(2, '0')}:00`,
      hour: d.getHours(),  // Keep internal hour as 0-23 for calculations
    });
  }

  return dates;
}

// Calculate profile-based forecast for non-wind/solar stations
function calculateProfileForecast(station, records, forecastDates) {
  const stationRecords = records.filter(r => r.station === station);
  if (stationRecords.length === 0) return new Map();

  // Calculate average CF by hour of day
  const hourlyAverages = new Map();
  const hourCounts = new Map();

  for (const rec of stationRecords) {
    const hour = parseInt(rec.datetime.split(' ')[1].split(':')[0]);
    hourlyAverages.set(hour, (hourlyAverages.get(hour) || 0) + rec.cf);
    hourCounts.set(hour, (hourCounts.get(hour) || 0) + 1);
  }

  for (const [hour, sum] of hourlyAverages) {
    hourlyAverages.set(hour, sum / hourCounts.get(hour));
  }

  const forecasts = new Map();
  for (const { datetime, hour } of forecastDates) {
    forecasts.set(datetime, hourlyAverages.get(hour) || 0);
  }

  return forecasts;
}

// Main function
async function main() {
  const options = parseArgs();

  console.log('='.repeat(80));
  console.log('          LSTM CAPACITY FACTOR FORECASTING');
  console.log('='.repeat(80));
  console.log(`\n  Forecast Period: ${options.start} to ${options.end}`);
  console.log(`  Output: ${options.output}`);
  console.log(`  Training Data: ${options.training}`);

  // Load training data
  console.log('\n📚 Loading training data...');
  const dataDir = path.join(process.cwd(), options.training);
  const allRecords = loadTrainingData(dataDir);
  console.log(`   Loaded ${allRecords.length} capacity factor records`);

  // Get unique stations and classify
  const stationSet = new Set(allRecords.map(r => r.station));
  const stations = Array.from(stationSet);
  console.log(`   Found ${stations.length} stations`);

  const windStations = stations.filter(s => getStationType(s) === 'wind');
  const solarStations = stations.filter(s => getStationType(s) === 'solar');
  const otherStations = stations.filter(s => !['wind', 'solar'].includes(getStationType(s)));

  console.log(`\n📋 Station breakdown:`);
  console.log(`   🌬️  Wind:  ${windStations.length} stations → LSTM neural network`);
  console.log(`   ☀️  Solar: ${solarStations.length} stations → LSTM neural network`);
  console.log(`   📊 Other: ${otherStations.length} stations → Profile-based`);

  // Train LSTM models
  console.log('\n🧠 Training LSTM models...');
  const models = new Map();

  // Train wind models
  console.log('\n  Training wind LSTM models:');
  let windTrained = 0;
  for (const station of windStations) {
    process.stdout.write(`    ${station}... `);
    const weatherData = loadWeatherForStation(station, options.cache, 'wind');
    if (weatherData.size < 100) {
      console.log('skipped (insufficient weather)');
      continue;
    }
    const model = trainStationLSTM(station, allRecords, weatherData, 'wind');
    if (model) {
      models.set(station, { ...model, type: 'wind' });
      windTrained++;
      console.log('done');
    } else {
      console.log('skipped (insufficient data)');
    }
  }
  console.log(`    Trained ${windTrained}/${windStations.length} wind models`);

  // Train solar models
  console.log('\n  Training solar LSTM models:');
  let solarTrained = 0;
  for (const station of solarStations) {
    process.stdout.write(`    ${station}... `);
    const weatherData = loadWeatherForStation(station, options.cache, 'solar');
    if (weatherData.size < 100) {
      console.log('skipped (insufficient weather)');
      continue;
    }
    const model = trainStationLSTM(station, allRecords, weatherData, 'solar');
    if (model) {
      models.set(station, { ...model, type: 'solar' });
      solarTrained++;
      console.log('done');
    } else {
      console.log('skipped (insufficient data)');
    }
  }
  console.log(`    Trained ${solarTrained}/${solarStations.length} solar models`);

  // Generate forecast dates
  console.log('\n📅 Generating forecast dates...');
  const forecastDates = generateForecastDates(options.start, options.end);
  console.log(`   ${forecastDates.length} hourly timestamps`);

  // Generate forecasts
  console.log('\n🔮 Generating forecasts...');
  const forecasts = new Map(); // datetime -> { station -> cf }

  for (const { datetime, hour } of forecastDates) {
    forecasts.set(datetime, new Map());
  }

  // Forecast with LSTM models
  for (const [station, model] of models) {
    const weatherData = loadWeatherForStation(station, options.cache, model.type);
    let prevCF = model.lastRecords.length > 0 ? model.lastRecords[model.lastRecords.length - 1].cf : 0.3;

    for (const { datetime, hour } of forecastDates) {
      const weather = weatherData.get(datetime);
      const features = model.extractFeatures(weather, hour, prevCF);
      const normalized = normalizeFeatures(features, model.means, model.stds);

      // Build sequence input (pad with current features if needed)
      const input = [];
      for (let i = 0; i < model.sequenceLength; i++) {
        input.push(...normalized);
      }

      const prediction = model.network.activate(input)[0];
      const cf = Math.max(0, Math.min(1, prediction));

      forecasts.get(datetime).set(station, cf);
      prevCF = cf;
    }
  }

  // Forecast with profile-based models for other stations
  for (const station of otherStations) {
    const stationForecasts = calculateProfileForecast(station, allRecords, forecastDates);
    for (const [datetime, cf] of stationForecasts) {
      if (forecasts.has(datetime)) {
        forecasts.get(datetime).set(station, cf);
      }
    }
  }

  // Also add profile-based forecasts for wind/solar stations that didn't train
  for (const station of [...windStations, ...solarStations]) {
    if (!models.has(station)) {
      const stationForecasts = calculateProfileForecast(station, allRecords, forecastDates);
      for (const [datetime, cf] of stationForecasts) {
        if (forecasts.has(datetime)) {
          forecasts.get(datetime).set(station, cf);
        }
      }
    }
  }

  // Write output CSV
  console.log('\n📝 Writing output CSV...');
  const outputDir = path.dirname(options.output);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Build CSV content
  // Filter out SOLAR and WIND aggregate columns - they're not real stations
  const sortedStations = stations
    .filter(s => s !== 'SOLAR' && s !== 'WIND')
    .sort();
  const header = ['DateTimeEnding', ...sortedStations].join(',');
  const rows = [header];

  for (const { datetime } of forecastDates) {
    const stationForecasts = forecasts.get(datetime);
    const values = [datetime];
    for (const station of sortedStations) {
      const cf = stationForecasts.get(station);
      // Use 4 decimal places to match regular CFAC format
      if (cf !== undefined) {
        values.push(cf.toFixed(4));
      } else {
        values.push('');
      }
    }
    rows.push(values.join(','));
  }

  fs.writeFileSync(options.output, rows.join('\n'));
  console.log(`   Written ${forecastDates.length} rows x ${stations.length} stations`);

  // Summary
  console.log('\n' + '='.repeat(80));
  console.log('  LSTM FORECAST COMPLETE');
  console.log('='.repeat(80));
  console.log(`\n  📊 Output: ${options.output}`);
  console.log(`  📅 Period: ${options.start} to ${options.end}`);
  console.log(`  🕐 Hours:  ${forecastDates.length}`);
  console.log(`  🏭 Stations: ${stations.length}`);
  console.log(`  🧠 LSTM Models: ${models.size} (Wind: ${windTrained}, Solar: ${solarTrained})`);
  console.log(`  📈 Profile-Based: ${otherStations.length + (windStations.length - windTrained) + (solarStations.length - solarTrained)}`);
  console.log('\n' + '='.repeat(80));
}

main().catch(console.error);
