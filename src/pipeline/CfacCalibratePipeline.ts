/**
 * CFAC Calibrate Pipeline (V2)
 *
 * Computes calibration factors from recent actuals:
 * 1. Loads cfac_model.vfm (read-only)
 * 2. Reads recent CFac actuals (default 14 days)
 * 3. Generates predictions using the model
 * 4. Compares predictions to actuals:
 *    - Wind: Global bias + hourly scale factors
 *    - Solar: Global bias + HOURLY scale factors (key V2 improvement)
 *    - Profile: Recent median + seasonal scale
 * 5. Writes cfac_calibration.json
 *
 * Does NOT modify cfac_model.vfm.
 */

import { loadCfacModel, saveCfacCalibration, CfacV2Calibration, CfacV2ModelData } from './CfacModelSerializer.js';
import { Wind4TierHybridModel } from '../models/capacityFactor/Wind4TierHybridModel.js';
import { SolarHybridModel } from '../models/capacityFactor/SolarHybridModel.js';
import { ProfileBasedModel } from '../models/capacityFactor/ProfileBasedModel.js';
import { CFacTrainingSample, CFacWeatherFeatures } from '../types/capacityFactor.js';
import fs from 'fs';
import path from 'path';

export interface CalibratePipelineConfig {
  modelPath: string; // Path to cfac_model.vfm
  cfacActualsPath: string; // Path to recent CFac actuals
  calibrationDays?: number; // Calibration window (default 14)
  outputPath: string; // Output cfac_calibration.json path
  solarScaleClamp?: [number, number]; // Clamp solar hourly scales (default [0.50, 1.50])
  windScaleClamp?: [number, number]; // Clamp wind hourly scales (default [0.50, 2.00])
  verbose?: boolean;
}

/**
 * Calibrate CFAC V2 models
 */
export async function calibrateCfacModels(config: CalibratePipelineConfig): Promise<void> {
  const {
    modelPath,
    cfacActualsPath,
    calibrationDays = 14,
    outputPath,
    solarScaleClamp = [0.5, 1.5],
    windScaleClamp = [0.5, 2.0],
    verbose = false,
  } = config;

  console.log('CFAC V2 Calibration Pipeline');
  console.log('============================\n');

  if (verbose) {
    console.log(`Calibration configuration:`);
    console.log(`  Calibration days: ${calibrationDays}`);
    console.log(`  Solar scale clamp: [${solarScaleClamp[0]}, ${solarScaleClamp[1]}]`);
    console.log(`  Wind scale clamp: [${windScaleClamp[0]}, ${windScaleClamp[1]}]`);
    console.log('');
  }

  // Step 1: Load model
  if (verbose) {
    console.log(`[${new Date().toISOString()}] Step 1: Loading CFAC V2 model...`);
  } else {
    console.log('Step 1: Loading CFAC V2 model...');
  }
  const modelData = loadCfacModel(modelPath);
  console.log(`  Loaded model from ${modelPath}`);
  console.log(`  Trained: ${modelData.trainedAt}`);
  if (verbose) {
    console.log(`  Training period: ${modelData.trainingPeriod.start} to ${modelData.trainingPeriod.end}`);
    console.log(`  Model stations: wind=${Object.keys(modelData.wind).length}, solar=${Object.keys(modelData.solar).length}, profile=${Object.keys(modelData.profile).length}`);
  }
  console.log('');

  // Step 2: Load recent actuals
  if (verbose) {
    console.log(`[${new Date().toISOString()}] Step 2: Loading recent CFac actuals...`);
  } else {
    console.log('Step 2: Loading recent CFac actuals...');
  }
  const samples = await loadCalibrationSamples(cfacActualsPath, calibrationDays, verbose);
  console.log(`  Loaded ${samples.length} samples (${calibrationDays} days)`);
  if (verbose && samples.length > 0) {
    const dateRange = {
      start: new Date(Math.min(...samples.map(s => s.datetime.getTime()))),
      end: new Date(Math.max(...samples.map(s => s.datetime.getTime())))
    };
    console.log(`  Date range: ${dateRange.start.toISOString().split('T')[0]} to ${dateRange.end.toISOString().split('T')[0]}`);
    const stationCounts = new Map<string, number>();
    for (const sample of samples) {
      stationCounts.set(sample.stationCode, (stationCounts.get(sample.stationCode) || 0) + 1);
    }
    console.log(`  Samples per station:`);
    for (const [station, count] of stationCounts) {
      console.log(`    ${station}: ${count} samples`);
    }
  }
  console.log('');

  // Step 3: Reconstruct models from serialized data
  if (verbose) {
    console.log(`[${new Date().toISOString()}] Step 3: Reconstructing models from serialized data...`);
  } else {
    console.log('Step 3: Reconstructing models from serialized data...');
  }
  const { windModels, solarModels, profileModels } = reconstructModels(modelData);
  console.log(`  Wind: ${windModels.size} models`);
  console.log(`  Solar: ${solarModels.size} models`);
  console.log(`  Profile: ${profileModels.size} models\n`);

  // Step 4: Calibrate wind models
  if (verbose) {
    console.log(`[${new Date().toISOString()}] Step 4: Calibrating wind models...`);
  } else {
    console.log('Step 4: Calibrating wind models...');
  }
  const windCalibration = calibrateWindModels(windModels, samples, windScaleClamp, verbose);
  console.log(`  Calibrated ${Object.keys(windCalibration).length} wind stations\n`);

  // Step 5: Calibrate solar models (HOURLY calibration - V2 improvement)
  if (verbose) {
    console.log(`[${new Date().toISOString()}] Step 5: Calibrating solar models (hourly)...`);
  } else {
    console.log('Step 5: Calibrating solar models (hourly)...');
  }
  const solarCalibration = calibrateSolarModels(solarModels, samples, solarScaleClamp, verbose);
  console.log(`  Calibrated ${Object.keys(solarCalibration).length} solar stations\n`);

  // Step 6: Calibrate profile models
  if (verbose) {
    console.log(`[${new Date().toISOString()}] Step 6: Calibrating profile models...`);
  } else {
    console.log('Step 6: Calibrating profile models...');
  }
  const profileCalibration = calibrateProfileModels(profileModels, samples, verbose);
  console.log(`  Calibrated ${Object.keys(profileCalibration).length} profile stations\n`);

  // Step 7: Compute metrics
  if (verbose) {
    console.log(`[${new Date().toISOString()}] Step 7: Computing calibration metrics...`);
  } else {
    console.log('Step 7: Computing calibration metrics...');
  }
  const metrics = computeCalibrationMetrics(
    windModels,
    solarModels,
    profileModels,
    windCalibration,
    solarCalibration,
    profileCalibration,
    samples
  );

  if (verbose) {
    console.log(`  Calibration metrics (post-calibration MAPE):`);
    console.log(`    Wind stations:`);
    for (const [station, metric] of Object.entries(metrics.wind)) {
      console.log(`      ${station}: ${metric.mape.toFixed(1)}%`);
    }
    console.log(`    Solar stations:`);
    for (const [station, metric] of Object.entries(metrics.solar)) {
      console.log(`      ${station}: ${metric.mape.toFixed(1)}%`);
    }
    console.log(`    Profile stations:`);
    for (const [station, metric] of Object.entries(metrics.profile)) {
      console.log(`      ${station}: ${metric.mape.toFixed(1)}%`);
    }
  }

  // Step 8: Save calibration
  if (verbose) {
    console.log(`[${new Date().toISOString()}] Step 8: Saving calibration...`);
  } else {
    console.log('Step 8: Saving calibration...');
  }
  const calibration: CfacV2Calibration = {
    calibrationDate: new Date().toISOString(),
    modelVersion: path.basename(modelPath),
    calibrationDays,
    wind: windCalibration,
    solar: solarCalibration,
    profile: profileCalibration,
    metrics,
  };

  saveCfacCalibration(calibration, outputPath);
  console.log(`  Saved to ${outputPath}\n`);

  console.log('Calibration complete!');
}

/**
 * Load calibration samples from recent CFac actuals
 */
async function loadCalibrationSamples(
  cfacPath: string,
  calibrationDays: number,
  verbose: boolean
): Promise<CFacTrainingSample[]> {
  if (verbose) {
    console.log(`  Loading recent CFac actuals from: ${cfacPath}`);
  }

  // Step 1: Parse CFac CSV files
  const { CapacityFactorService } = await import('../services/capacityFactorService.js');
  const cfacService = new CapacityFactorService();

  const cfacData = await cfacService.parseCapacityFactorDirectory(
    cfacPath,
    verbose ? (msg) => console.log(`    ${msg}`) : undefined
  );

  if (cfacData.length === 0) {
    throw new Error('No capacity factor data loaded for calibration');
  }

  // Step 2: Filter to last calibrationDays
  const timestamps = cfacData.map((r) => r.datetime.getTime());
  const maxTimestamp = Math.max(...timestamps);
  const maxDate = new Date(maxTimestamp);
  const minDate = new Date(maxTimestamp - calibrationDays * 24 * 60 * 60 * 1000);

  const filteredData = cfacData.filter(
    (r) => r.datetime >= minDate && r.datetime <= maxDate
  );

  if (verbose) {
    console.log(`  Filtered to last ${calibrationDays} days: ${filteredData.length} records`);
    console.log(`  Date range: ${minDate.toISOString().split('T')[0]} to ${maxDate.toISOString().split('T')[0]}`);
  }

  // Step 3: Load station metadata and weather
  const stationsPath = path.resolve('src/data/stations.json');
  await cfacService.loadStations(stationsPath);

  const { DateTime } = await import('luxon');
  const { createWeatherService } = await import('../services/weatherService.js');
  const { getStationTypeFromCode } = await import('../types/capacityFactor.js');

  // Use default weather cache path
  const weatherService = createWeatherService('./weather_cache');

  // Get wind and solar station locations
  const windStationLocations = cfacService.getWindStationLocations();
  const solarStationLocations = cfacService.getSolarStationLocations();
  const clusters = cfacService.getClusters();

  const startDateStr = DateTime.fromJSDate(minDate).toISODate() || '';
  const endDateStr = DateTime.fromJSDate(maxDate).toISODate() || '';

  if (verbose) {
    console.log(`  Fetching weather data for calibration period...`);
  }

  // Fetch weather for wind stations
  const windClusterIds = new Set<string>();
  for (const loc of windStationLocations) {
    windClusterIds.add(loc.clusterId);
  }

  const windWeatherCsv = await weatherService.fetchAllClusters(
    windStationLocations,
    startDateStr,
    endDateStr,
    verbose ? (msg) => console.log(`    ${msg}`) : undefined,
    windClusterIds
  );

  // Fetch weather for solar stations
  const solarWeatherCsv = await weatherService.fetchAllClusters(
    solarStationLocations,
    startDateStr,
    endDateStr,
    verbose ? (msg) => console.log(`    ${msg}`) : undefined
  );

  // Fetch weather for other stations
  const clusterWeatherCsv = await weatherService.fetchAllClusters(
    clusters,
    startDateStr,
    endDateStr,
    verbose ? (msg) => console.log(`    ${msg}`) : undefined
  );

  // Step 4: Parse weather CSV into maps
  const weatherMap = new Map<string, Map<number, CFacWeatherFeatures>>();

  // CSV parser helper
  const parseCSVLine = (line: string): string[] => {
    const result: string[] = [];
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
  };

  const parseWeatherCsv = (csvData: string, clusterId: string) => {
    const clusterWeather = new Map<number, CFacWeatherFeatures>();
    const lines = csvData.split('\n').filter((l) => l.trim());
    if (lines.length < 2) return clusterWeather;

    const headers = parseCSVLine(lines[0]).map((h) => h.toLowerCase());
    const colIdx = (name: string) => headers.indexOf(name);

    for (let i = 1; i < lines.length; i++) {
      const values = parseCSVLine(lines[i]);
      const datetimeStr = values[colIdx('datetime')];
      if (!datetimeStr) continue;

      const dt = DateTime.fromISO(datetimeStr);
      if (!dt.isValid) continue;

      // Hour-starting to hour-ending conversion
      const ts = dt.plus({ hours: 1 }).toMillis();

      const weather: CFacWeatherFeatures = {
        temperature: parseFloat(values[colIdx('temp')]) || 25,
        windSpeed: parseFloat(values[colIdx('windspeed')]) || 0,
        windSpeed100: colIdx('windspeed100') >= 0 ? parseFloat(values[colIdx('windspeed100')]) || undefined : undefined,
        windGust: parseFloat(values[colIdx('windgust')]) || 0,
        cloudCover: parseFloat(values[colIdx('cloudcover')]) || 50,
        solarRadiation: parseFloat(values[colIdx('solarradiation')]) || 0,
        precipitation: parseFloat(values[colIdx('precip')]) || 0,
        humidity: parseFloat(values[colIdx('humidity')]) || undefined,
        uvIndex: parseFloat(values[colIdx('uvindex')]) || undefined,
      };

      clusterWeather.set(ts, weather);
    }
    return clusterWeather;
  };

  // Parse all weather data
  for (const [clusterId, csvData] of windWeatherCsv) {
    weatherMap.set(clusterId, parseWeatherCsv(csvData, clusterId));
  }
  for (const [clusterId, csvData] of solarWeatherCsv) {
    weatherMap.set(clusterId, parseWeatherCsv(csvData, clusterId));
  }
  for (const [clusterId, csvData] of clusterWeatherCsv) {
    weatherMap.set(clusterId, parseWeatherCsv(csvData, clusterId));
  }

  // Step 5: Merge CFac + weather into CFacTrainingSample[]
  const samples: CFacTrainingSample[] = [];

  for (const record of filteredData) {
    const stationCode = record.stationCode;
    const stationType = getStationTypeFromCode(stationCode);
    const ts = record.datetime.getTime();

    // Determine cluster ID
    let clusterId: string;
    if (stationType === 'wind') {
      clusterId = `WIND_${stationCode}`;
    } else if (stationType === 'solar') {
      clusterId = `SOLAR_${stationCode}`;
    } else {
      // Use cluster mapping
      clusterId = cfacService.getClusterForStation(stationCode) || '';
    }

    const clusterWeather = weatherMap.get(clusterId);
    if (!clusterWeather) {
      continue; // Skip if no weather data for cluster
    }

    const weather = clusterWeather.get(ts);
    if (!weather) {
      continue; // Skip if missing weather for this timestamp
    }

    const dt = DateTime.fromJSDate(record.datetime);

    samples.push({
      datetime: record.datetime,
      stationCode,
      stationType,
      actualCFac: record.capacityFactor,
      weather,
      hour: dt.hour,
      dayOfWeek: dt.weekday % 7, // 0 = Sunday
      month: dt.month,
      isWeekend: dt.weekday >= 6,
    });
  }

  if (verbose) {
    console.log(`  Merged ${samples.length} calibration samples (CFac + weather)`);
  }

  return samples;
}

/**
 * Reconstruct model instances from serialized data
 */
function reconstructModels(modelData: CfacV2ModelData): {
  windModels: Map<string, Wind4TierHybridModel>;
  solarModels: Map<string, SolarHybridModel>;
  profileModels: Map<string, ProfileBasedModel>;
} {
  const windModels = new Map<string, Wind4TierHybridModel>();
  const solarModels = new Map<string, SolarHybridModel>();
  const profileModels = new Map<string, ProfileBasedModel>();

  // Reconstruct wind models
  for (const [stationCode, windData] of Object.entries(modelData.wind)) {
    const model = new Wind4TierHybridModel(stationCode, windData.useXGBoost);

    // Reconstruct MREC4TierFactors from serialized data
    const mrecFactors = {
      stationCode: windData.mrecFactors.stationCode,
      stationType: windData.mrecFactors.stationType as any,
      MRecLow: windData.mrecFactors.MRecLow,
      MRecRamp: windData.mrecFactors.MRecRamp,
      MRecRated: windData.mrecFactors.MRecRated,
      MRecHigh: windData.mrecFactors.MRecHigh,
      vLow: windData.mrecFactors.vLow,
      vRated: windData.mrecFactors.vRated,
      vHigh: windData.mrecFactors.vHigh,
      calibrated: windData.mrecFactors.calibrated,
      calibrationDate: new Date(windData.mrecFactors.calibrationDate),
      sampleCount: windData.mrecFactors.sampleCount,
    };
    model.load4TierFactors(mrecFactors);

    // Restore residual model
    if (windData.residualModel) {
      const MultivariateLinearRegression = require('ml-regression-multivariate-linear');
      const mockX = [[0]];
      const mockY = [[0]];
      const mlrModel = new MultivariateLinearRegression(mockX, mockY);
      (mlrModel as any).weights = windData.residualModel.weights;
      (mlrModel as any).inputs = windData.residualModel.inputs;
      (mlrModel as any).outputs = windData.residualModel.outputs;
      (model as any).residualModel = mlrModel;
    }

    windModels.set(stationCode, model);
  }

  // Reconstruct solar models
  for (const [stationCode, solarData] of Object.entries(modelData.solar)) {
    const model = SolarHybridModel.fromJSON({
      version: 1,
      stationCode,
      biasCorrection: solarData.biasCorrection,
      drySeasonBiasCorrection: solarData.drySeasonBiasCorrection,
      physicsOnlyMode: false,
      weatherConfidenceMode: false,
      seasonalAdaptiveMode: false,
      hourlyCorrection: solarData.hourlyCorrection,
      drySeasonHourlyCorrection: solarData.drySeasonHourlyCorrection,
      residualModel: solarData.residualModel,
      drySeasonResidualModel: solarData.drySeasonResidualModel,
      irradianceModelParams: solarData.irradianceModelParams,
    });

    solarModels.set(stationCode, model);
  }

  // Reconstruct profile models
  for (const [stationCode, profileData] of Object.entries(modelData.profile)) {
    const model = new ProfileBasedModel(stationCode);

    // Restore profiles
    const profilesMap = new Map<string, any>();
    for (const { key, stats } of profileData.profiles) {
      profilesMap.set(key, stats);
    }
    (model as any).profiles = profilesMap;

    profileModels.set(stationCode, model);
  }

  return { windModels, solarModels, profileModels };
}

/**
 * Calibrate wind models - compute global bias + hourly scale factors
 */
function calibrateWindModels(
  models: Map<string, Wind4TierHybridModel>,
  samples: CFacTrainingSample[],
  scaleClamp: [number, number],
  verbose: boolean
): CfacV2Calibration['wind'] {
  const calibration: CfacV2Calibration['wind'] = {};

  for (const [stationCode, model] of models) {
    const stationSamples = samples.filter((s) => s.stationCode === stationCode);
    if (stationSamples.length < 10) {
      if (verbose) {
        console.log(`    ${stationCode}: Insufficient samples (${stationSamples.length}), skipping`);
      }
      continue;
    }

    // Compute global bias
    let biasSum = 0;
    let biasCount = 0;

    for (const sample of stationSamples) {
      const predicted = model.predict(sample.weather, sample.datetime);
      const actual = sample.actualCFac;
      if (actual > 0.01) {
        biasSum += predicted - actual;
        biasCount++;
      }
    }

    const globalBias = biasCount > 0 ? biasSum / biasCount : 0;

    // Compute hourly scale factors
    const hourlyActuals: Map<number, number[]> = new Map();
    const hourlyPredicted: Map<number, number[]> = new Map();

    for (let h = 0; h < 24; h++) {
      hourlyActuals.set(h, []);
      hourlyPredicted.set(h, []);
    }

    for (const sample of stationSamples) {
      const hour = sample.hour;
      const predicted = model.predict(sample.weather, sample.datetime);
      const actual = sample.actualCFac;

      if (predicted > 0.01 && actual > 0.01) {
        hourlyActuals.get(hour)!.push(actual);
        hourlyPredicted.get(hour)!.push(predicted);
      }
    }

    const hourlyScale: number[] = [];
    for (let h = 0; h < 24; h++) {
      const actuals = hourlyActuals.get(h)!;
      const predicteds = hourlyPredicted.get(h)!;

      if (actuals.length >= 3) {
        const avgActual = actuals.reduce((a, b) => a + b, 0) / actuals.length;
        const avgPredicted = predicteds.reduce((a, b) => a + b, 0) / predicteds.length;
        const scale = avgPredicted > 0.01 ? avgActual / avgPredicted : 1.0;
        const clamped = Math.max(scaleClamp[0], Math.min(scaleClamp[1], scale));
        hourlyScale.push(clamped);
      } else {
        hourlyScale.push(1.0); // Default (no correction)
      }
    }

    calibration[stationCode] = {
      globalBias,
      hourlyScale,
      sampleCount: stationSamples.length,
      calibrationDate: new Date().toISOString(),
    };

    if (verbose) {
      console.log(`    ${stationCode}: bias=${globalBias.toFixed(3)}, samples=${stationSamples.length}`);
    }
  }

  return calibration;
}

/**
 * Calibrate solar models - HOURLY scale factors per station (V2 KEY IMPROVEMENT)
 *
 * For each station, for each hour h (during generating hours):
 *   hourlyScale[h] = mean(actual[h] / predicted[h])
 *                    across calibration days where predicted[h] > 0.01
 *
 * Non-generating hours (night) get a scale factor of 0.
 */
function calibrateSolarModels(
  models: Map<string, SolarHybridModel>,
  samples: CFacTrainingSample[],
  scaleClamp: [number, number],
  verbose: boolean
): CfacV2Calibration['solar'] {
  const calibration: CfacV2Calibration['solar'] = {};

  for (const [stationCode, model] of models) {
    const stationSamples = samples.filter((s) => s.stationCode === stationCode);
    if (stationSamples.length < 10) {
      if (verbose) {
        console.log(`    ${stationCode}: Insufficient samples (${stationSamples.length}), skipping`);
      }
      continue;
    }

    // Compute global bias (for generating hours only)
    let biasSum = 0;
    let biasCount = 0;

    for (const sample of stationSamples) {
      const predicted = model.predict(sample.weather, sample.datetime);
      const actual = sample.actualCFac;
      if (actual > 0.05) {
        // Daylight threshold
        biasSum += predicted - actual;
        biasCount++;
      }
    }

    const globalBias = biasCount > 0 ? biasSum / biasCount : 0;

    // Compute HOURLY scale factors (THE KEY V2 SOLAR IMPROVEMENT)
    const hourlyActuals: Map<number, number[]> = new Map();
    const hourlyPredicted: Map<number, number[]> = new Map();

    for (let h = 0; h < 24; h++) {
      hourlyActuals.set(h, []);
      hourlyPredicted.set(h, []);
    }

    for (const sample of stationSamples) {
      const hour = sample.hour;
      const predicted = model.predict(sample.weather, sample.datetime);
      const actual = sample.actualCFac;

      // Only use samples with meaningful values
      if (predicted > 0.01) {
        hourlyActuals.get(hour)!.push(actual);
        hourlyPredicted.get(hour)!.push(predicted);
      }
    }

    const hourlyScale: number[] = [];
    for (let h = 0; h < 24; h++) {
      const actuals = hourlyActuals.get(h)!;
      const predicteds = hourlyPredicted.get(h)!;

      if (actuals.length >= 3) {
        const avgActual = actuals.reduce((a, b) => a + b, 0) / actuals.length;
        const avgPredicted = predicteds.reduce((a, b) => a + b, 0) / predicteds.length;

        // If this is a night hour (avg actual < 0.01), set scale to 0
        if (avgActual < 0.01) {
          hourlyScale.push(0);
        } else if (avgPredicted > 0.01) {
          const scale = avgActual / avgPredicted;
          const clamped = Math.max(scaleClamp[0], Math.min(scaleClamp[1], scale));
          hourlyScale.push(clamped);
        } else {
          hourlyScale.push(1.0);
        }
      } else {
        // Not enough data for this hour
        hourlyScale.push(h >= 6 && h <= 18 ? 1.0 : 0); // Default: 1.0 for day, 0 for night
      }
    }

    calibration[stationCode] = {
      globalBias,
      hourlyScale,
      sampleCount: stationSamples.length,
      calibrationDate: new Date().toISOString(),
    };

    if (verbose) {
      // Show midday scale factors (10-14) to see the under-prediction correction
      const middayScales = hourlyScale.slice(10, 15).map((s) => s.toFixed(2)).join(', ');
      console.log(
        `    ${stationCode}: bias=${globalBias.toFixed(3)}, midday scales (10-14)=[${middayScales}]`
      );
    }
  }

  return calibration;
}

/**
 * Calibrate profile models - recent median + seasonal scale
 */
function calibrateProfileModels(
  models: Map<string, ProfileBasedModel>,
  samples: CFacTrainingSample[],
  verbose: boolean
): CfacV2Calibration['profile'] {
  const calibration: CfacV2Calibration['profile'] = {};

  for (const [stationCode, model] of models) {
    const stationSamples = samples.filter((s) => s.stationCode === stationCode);
    if (stationSamples.length < 10) {
      if (verbose) {
        console.log(`    ${stationCode}: Insufficient samples (${stationSamples.length}), skipping`);
      }
      continue;
    }

    // Compute recent median
    const cfacs = stationSamples.map((s) => s.actualCFac).sort((a, b) => a - b);
    const recentMedian = cfacs[Math.floor(cfacs.length / 2)];

    // Compute profile median for same period
    let profileSum = 0;
    let profileCount = 0;
    for (const sample of stationSamples) {
      const profilePred = model.predict(sample.datetime);
      profileSum += profilePred;
      profileCount++;
    }
    const profileMedian = profileCount > 0 ? profileSum / profileCount : 0;

    // Seasonal scale
    const seasonalScale = profileMedian > 0.01 ? recentMedian / profileMedian : 1.0;

    calibration[stationCode] = {
      recentMedian,
      seasonalScale: Math.max(0.5, Math.min(1.5, seasonalScale)), // Clamp
    };

    if (verbose) {
      console.log(
        `    ${stationCode}: recentMedian=${recentMedian.toFixed(2)}, seasonalScale=${seasonalScale.toFixed(2)}`
      );
    }
  }

  return calibration;
}

/**
 * Compute calibration metrics
 */
function computeCalibrationMetrics(
  windModels: Map<string, Wind4TierHybridModel>,
  solarModels: Map<string, SolarHybridModel>,
  profileModels: Map<string, ProfileBasedModel>,
  windCalibration: CfacV2Calibration['wind'],
  solarCalibration: CfacV2Calibration['solar'],
  profileCalibration: CfacV2Calibration['profile'],
  samples: CFacTrainingSample[]
): CfacV2Calibration['metrics'] {
  const metrics: CfacV2Calibration['metrics'] = {
    wind: {},
    solar: {},
    profile: {},
  };

  // Wind metrics
  for (const [stationCode, model] of windModels) {
    const stationSamples = samples.filter((s) => s.stationCode === stationCode);
    const cal = windCalibration[stationCode];
    if (!cal) continue;

    let errorSum = 0;
    let count = 0;

    for (const sample of stationSamples) {
      const rawPred = model.predict(sample.weather, sample.datetime);
      const calibrated = (rawPred - cal.globalBias) * cal.hourlyScale[sample.hour];
      const actual = sample.actualCFac;

      if (actual > 0.01) {
        errorSum += Math.abs((calibrated - actual) / actual);
        count++;
      }
    }

    metrics.wind[stationCode] = { mape: count > 0 ? (errorSum / count) * 100 : 0 };
  }

  // Solar metrics
  for (const [stationCode, model] of solarModels) {
    const stationSamples = samples.filter((s) => s.stationCode === stationCode);
    const cal = solarCalibration[stationCode];
    if (!cal) continue;

    let errorSum = 0;
    let count = 0;

    for (const sample of stationSamples) {
      const rawPred = model.predict(sample.weather, sample.datetime);
      const calibrated = (rawPred - cal.globalBias) * cal.hourlyScale[sample.hour];
      const actual = sample.actualCFac;

      if (actual > 0.05) {
        errorSum += Math.abs((calibrated - actual) / actual);
        count++;
      }
    }

    metrics.solar[stationCode] = { mape: count > 0 ? (errorSum / count) * 100 : 0 };
  }

  // Profile metrics
  for (const [stationCode, model] of profileModels) {
    const stationSamples = samples.filter((s) => s.stationCode === stationCode);
    const cal = profileCalibration[stationCode];
    if (!cal) continue;

    let errorSum = 0;
    let count = 0;

    for (const sample of stationSamples) {
      const profilePred = model.predict(sample.datetime);
      const calibrated = profilePred * cal.seasonalScale;
      const actual = sample.actualCFac;

      if (actual > 0.01) {
        errorSum += Math.abs((calibrated - actual) / actual);
        count++;
      }
    }

    metrics.profile[stationCode] = { mape: count > 0 ? (errorSum / count) * 100 : 0 };
  }

  return metrics;
}
