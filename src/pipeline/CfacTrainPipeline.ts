/**
 * CFAC Train Pipeline (V2)
 *
 * Orchestrates full CFAC training:
 * 1. Loads historical CFac data + weather
 * 2. Trains station-specific models by type:
 *    - Wind: 4-Tier MREC + ML residual (Wind4TierHybridModel)
 *    - Solar: Physics + ML residual (SolarHybridModel)
 *    - Profile: Statistical profiles (ProfileBasedModel)
 * 3. Serializes to cfac_model.vfm
 *
 * Does NOT perform calibration - that's a separate operation.
 */

import { Wind4TierHybridModel } from '../models/capacityFactor/Wind4TierHybridModel.js';
import { SolarHybridModel } from '../models/capacityFactor/SolarHybridModel.js';
import { ProfileBasedModel } from '../models/capacityFactor/ProfileBasedModel.js';
import { CFacTrainingSample, StationType, CFacWeatherFeatures } from '../types/capacityFactor.js';
import { saveCfacModel, CfacV2ModelData } from './CfacModelSerializer.js';
import fs from 'fs';
import path from 'path';
import MultivariateLinearRegression from 'ml-regression-multivariate-linear';

export interface TrainPipelineConfig {
  cfacTrainingPath: string; // Path to historical CFac data directory
  weatherCachePath?: string; // Weather cache directory
  trainingDays?: number; // Training window (default 120 days)
  validationSplit?: number; // Holdout fraction (default 0.2)
  useXGBoost?: boolean; // Use XGBoost for ML layer (default false)
  asymmetricLoss?: boolean; // Asymmetric loss for solar (default true in V2)
  outputPath: string; // Output .vfm file path
  stationsPath?: string; // Path to stations.json (default: src/data/stations.json)
  verbose?: boolean; // Detailed logging
}

/**
 * Train CFAC V2 models for all stations
 */
export async function trainCfacModels(config: TrainPipelineConfig): Promise<void> {
  const {
    cfacTrainingPath,
    weatherCachePath = './weather_cache',
    trainingDays = 120,
    validationSplit = 0.2,
    useXGBoost = false,
    asymmetricLoss = true, // Default to true in V2 for solar
    outputPath,
    stationsPath = 'src/data/stations.json',
    verbose = false,
  } = config;

  console.log('CFAC V2 Training Pipeline');
  console.log('=========================\n');

  if (verbose) {
    console.log(`Training configuration:`);
    console.log(`  Training days: ${trainingDays}`);
    console.log(`  Use XGBoost: ${useXGBoost}`);
    console.log(`  Asymmetric loss: ${asymmetricLoss}`);
    console.log(`  Weather cache: ${weatherCachePath}`);
    console.log('');
  }

  // Step 1: Load training data
  if (verbose) {
    console.log(`[${new Date().toISOString()}] Step 1: Loading historical CFac data...`);
  } else {
    console.log('Step 1: Loading historical CFac data...');
  }
  const samples = await loadTrainingSamples(cfacTrainingPath, weatherCachePath, trainingDays, verbose);
  console.log(`  Loaded ${samples.length} samples`);
  if (verbose && samples.length > 0) {
    const dateRange = {
      start: new Date(Math.min(...samples.map(s => s.datetime.getTime()))),
      end: new Date(Math.max(...samples.map(s => s.datetime.getTime())))
    };
    console.log(`  Date range: ${dateRange.start.toISOString().split('T')[0]} to ${dateRange.end.toISOString().split('T')[0]}`);
  }
  console.log('');

  // Step 2: Load station metadata
  if (verbose) {
    console.log(`[${new Date().toISOString()}] Step 2: Loading station metadata...`);
  } else {
    console.log('Step 2: Loading station metadata...');
  }
  const stationsFullPath = path.resolve(stationsPath);
  if (!fs.existsSync(stationsFullPath)) {
    throw new Error(`Stations file not found: ${stationsFullPath}`);
  }
  const stationsData = JSON.parse(fs.readFileSync(stationsFullPath, 'utf-8'));
  console.log(`  Loaded ${Object.keys(stationsData).length} stations`);
  if (verbose) {
    const stationTypes = new Map<string, number>();
    for (const station of Object.values(stationsData) as any[]) {
      const type = station.stationType || 'unknown';
      stationTypes.set(type, (stationTypes.get(type) || 0) + 1);
    }
    console.log(`  Station types:`);
    for (const [type, count] of stationTypes) {
      console.log(`    ${type}: ${count}`);
    }
  }
  console.log('');

  // Step 3: Group samples by station type
  if (verbose) {
    console.log(`[${new Date().toISOString()}] Step 3: Grouping samples by station type...`);
  } else {
    console.log('Step 3: Grouping samples by station type...');
  }
  const windSamples = samples.filter((s) => s.stationType === StationType.WIND);
  const solarSamples = samples.filter((s) => s.stationType === StationType.SOLAR);
  const profileSamples = samples.filter((s) =>
    [
      StationType.HYDRO_RUN_OF_RIVER,
      StationType.HYDRO_STORAGE,
      StationType.GEOTHERMAL,
      StationType.BIOMASS,
      StationType.BATTERY,
    ].includes(s.stationType)
  );
  console.log(`  Wind: ${windSamples.length} samples`);
  console.log(`  Solar: ${solarSamples.length} samples`);
  console.log(`  Profile: ${profileSamples.length} samples`);
  if (verbose) {
    const windStations = new Set(windSamples.map(s => s.stationCode));
    const solarStations = new Set(solarSamples.map(s => s.stationCode));
    const profileStations = new Set(profileSamples.map(s => s.stationCode));
    console.log(`  Unique stations: ${windStations.size} wind, ${solarStations.size} solar, ${profileStations.size} profile`);
  }
  console.log('');

  // Step 4: Train wind models (4-Tier Hybrid)
  if (verbose) {
    console.log(`[${new Date().toISOString()}] Step 4: Training wind models (4-Tier Hybrid)...`);
  } else {
    console.log('Step 4: Training wind models (4-Tier Hybrid)...');
  }
  const windModels = await trainWindModels(windSamples, useXGBoost, asymmetricLoss, verbose);
  console.log(`  Trained ${windModels.size} wind models\n`);

  // Step 5: Train solar models (Physics + ML Hybrid)
  if (verbose) {
    console.log(`[${new Date().toISOString()}] Step 5: Training solar models (Physics + ML Hybrid)...`);
  } else {
    console.log('Step 5: Training solar models (Physics + ML Hybrid)...');
  }
  const solarModels = await trainSolarModels(solarSamples, asymmetricLoss, verbose);
  console.log(`  Trained ${solarModels.size} solar models\n`);

  // Step 6: Train profile models
  if (verbose) {
    console.log(`[${new Date().toISOString()}] Step 6: Training profile models...`);
  } else {
    console.log('Step 6: Training profile models...');
  }
  const profileModels = await trainProfileModels(profileSamples, verbose);
  console.log(`  Trained ${profileModels.size} profile models\n`);

  // Step 7: Serialize to cfac_model.vfm
  if (verbose) {
    console.log(`[${new Date().toISOString()}] Step 7: Serializing models to .vfm...`);
  } else {
    console.log('Step 7: Serializing models to .vfm...');
  }
  const modelData = buildModelData(windModels, solarModels, profileModels, stationsData, samples);
  saveCfacModel(modelData, outputPath);
  console.log(`  Saved to ${outputPath}`);
  if (verbose) {
    console.log(`  Model size: ${JSON.stringify(modelData).length} bytes (serialized)`);
  }
  console.log('');

  console.log('Training complete!');
}

/**
 * Load training samples from historical CFac data + weather
 */
async function loadTrainingSamples(
  cfacPath: string,
  weatherCachePath: string,
  trainingDays: number,
  verbose: boolean
): Promise<CFacTrainingSample[]> {
  if (verbose) {
    console.log(`  Loading CFac data from: ${cfacPath}`);
  }

  // Step 1: Parse CFac CSV files
  const { CapacityFactorService } = await import('../services/capacityFactorService.js');
  const cfacService = new CapacityFactorService();

  const cfacData = await cfacService.parseCapacityFactorDirectory(
    cfacPath,
    verbose ? (msg) => console.log(`    ${msg}`) : undefined
  );

  if (cfacData.length === 0) {
    throw new Error('No capacity factor data loaded');
  }

  // Step 2: Determine date range (last trainingDays)
  const timestamps = cfacData.map((r) => r.datetime.getTime());
  const maxTimestamp = Math.max(...timestamps);
  const maxDate = new Date(maxTimestamp);
  const minDate = new Date(maxTimestamp - trainingDays * 24 * 60 * 60 * 1000);

  const filteredData = cfacData.filter(
    (r) => r.datetime >= minDate && r.datetime <= maxDate
  );

  if (verbose) {
    console.log(`  Filtered to last ${trainingDays} days: ${filteredData.length} records`);
    console.log(`  Date range: ${minDate.toISOString().split('T')[0]} to ${maxDate.toISOString().split('T')[0]}`);
  }

  // Step 3: Load station metadata
  const stationsPath = path.resolve('src/data/stations.json');
  await cfacService.loadStations(stationsPath);
  const stations = cfacService.getAllStations();

  // Step 4: Group by station to fetch weather
  const { DateTime } = await import('luxon');
  const { createWeatherService } = await import('../services/weatherService.js');
  const { getStationTypeFromCode } = await import('../types/capacityFactor.js');

  const weatherService = createWeatherService(weatherCachePath);
  const stationCodes = cfacService.getStationCodes(filteredData);

  // Get wind and solar station locations (station-specific weather)
  const windStationLocations = cfacService.getWindStationLocations();
  const solarStationLocations = cfacService.getSolarStationLocations();
  const clusters = cfacService.getClusters();

  const startDateStr = DateTime.fromJSDate(minDate).toISODate() || '';
  const endDateStr = DateTime.fromJSDate(maxDate).toISODate() || '';

  if (verbose) {
    console.log(`  Fetching weather data for ${stationCodes.length} stations...`);
  }

  // Fetch weather for wind stations (100m hub height)
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

  // Fetch weather for other stations (cluster-based)
  const clusterWeatherCsv = await weatherService.fetchAllClusters(
    clusters,
    startDateStr,
    endDateStr,
    verbose ? (msg) => console.log(`    ${msg}`) : undefined
  );

  // Step 5: Parse weather CSV into maps
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

  // Step 6: Merge CFac + weather into CFacTrainingSample[]
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
      if (verbose) {
        console.log(`    Warning: No weather data for cluster ${clusterId} (station ${stationCode})`);
      }
      continue;
    }

    const weather = clusterWeather.get(ts);
    if (!weather) {
      continue; // Missing weather for this timestamp
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
    console.log(`  Merged ${samples.length} training samples (CFac + weather)`);
  }

  return samples;
}

/**
 * Train wind models using Wind4TierHybridModel
 */
async function trainWindModels(
  samples: CFacTrainingSample[],
  useXGBoost: boolean,
  asymmetricLoss: boolean,
  verbose: boolean
): Promise<Map<string, Wind4TierHybridModel>> {
  const models = new Map<string, Wind4TierHybridModel>();

  // Get unique wind stations
  const windStations = new Set<string>();
  for (const s of samples) {
    windStations.add(s.stationCode);
  }

  console.log(`  Training ${windStations.size} wind stations...`);

  // Train each station
  for (const stationCode of windStations) {
    if (verbose) {
      console.log(`    Training ${stationCode}...`);
    }

    const model = new Wind4TierHybridModel(stationCode, useXGBoost);

    // Calibrate MREC
    const stationSamples = samples.filter((s) => s.stationCode === stationCode);
    const mrecData = stationSamples.map((s) => ({
      datetime: s.datetime,
      stationCode: s.stationCode,
      windSpeed: s.weather.windSpeed100 ?? s.weather.windSpeed,
      capacityFactor: s.actualCFac,
    }));
    model.calibrate4TierMREC(mrecData);

    // Train hybrid residual
    const metrics = model.trainResidual(samples, asymmetricLoss);

    if (verbose) {
      console.log(`      MAPE: ${metrics.hybridMAPE.toFixed(1)}%`);
    }

    models.set(stationCode, model);
  }

  return models;
}

/**
 * Train solar models using SolarHybridModel
 */
async function trainSolarModels(
  samples: CFacTrainingSample[],
  asymmetricLoss: boolean,
  verbose: boolean
): Promise<Map<string, SolarHybridModel>> {
  const models = new Map<string, SolarHybridModel>();

  // Get unique solar stations
  const solarStations = new Set<string>();
  for (const s of samples) {
    solarStations.add(s.stationCode);
  }

  console.log(`  Training ${solarStations.size} solar stations...`);

  // Train each station
  for (const stationCode of solarStations) {
    if (verbose) {
      console.log(`    Training ${stationCode}...`);
    }

    const model = new SolarHybridModel(stationCode);
    const stationSamples = samples.filter((s) => s.stationCode === stationCode);
    const metrics = await model.train(stationSamples, asymmetricLoss);

    if (verbose) {
      console.log(`      MAPE: ${metrics.mape.toFixed(1)}%`);
    }

    models.set(stationCode, model);
  }

  return models;
}

/**
 * Train profile models using ProfileBasedModel
 */
async function trainProfileModels(
  samples: CFacTrainingSample[],
  verbose: boolean
): Promise<Map<string, ProfileBasedModel>> {
  const models = new Map<string, ProfileBasedModel>();

  // Get unique profile stations
  const profileStations = new Set<string>();
  for (const s of samples) {
    profileStations.add(s.stationCode);
  }

  console.log(`  Training ${profileStations.size} profile stations...`);

  // Train each station
  for (const stationCode of profileStations) {
    if (verbose) {
      console.log(`    Building profile for ${stationCode}...`);
    }

    const model = new ProfileBasedModel(stationCode);
    const stationSamples = samples.filter((s) => s.stationCode === stationCode);
    model.buildProfiles(stationSamples);

    models.set(stationCode, model);
  }

  return models;
}

/**
 * Build CfacV2ModelData from trained models
 */
function buildModelData(
  windModels: Map<string, Wind4TierHybridModel>,
  solarModels: Map<string, SolarHybridModel>,
  profileModels: Map<string, ProfileBasedModel>,
  stationsData: any,
  samples: CFacTrainingSample[]
): CfacV2ModelData {
  const trainingDates = samples.map((s) => s.datetime);
  const trainingStart = new Date(Math.min(...trainingDates.map((d) => d.getTime())));
  const trainingEnd = new Date(Math.max(...trainingDates.map((d) => d.getTime())));

  const modelData: CfacV2ModelData = {
    version: 'cfac-v2',
    trainedAt: new Date().toISOString(),
    trainingPeriod: {
      start: trainingStart.toISOString(),
      end: trainingEnd.toISOString(),
    },
    wind: {},
    solar: {},
    profile: {},
    stations: {},
    config: {
      windScaleClamp: [0.5, 2.0],
      solarScaleClamp: [0.5, 1.5],
      profileScaleClamp: [0.5, 1.5],
      solarAlpha: 0.65,
      tempCoefficient: 0.004,
      confidenceThreshold: 50,
    },
  };

  // Serialize wind models
  for (const [stationCode, model] of windModels) {
    const factors = model.get4TierFactors();
    if (!factors) continue;

    // Extract residual model weights
    let residualModel = null;
    if (model.isHybridTrained() && (model as any).residualModel) {
      const mlrModel = (model as any).residualModel as MultivariateLinearRegression;
      residualModel = {
        weights: (mlrModel as any).weights,
        inputs: (mlrModel as any).inputs,
        outputs: (mlrModel as any).outputs,
      };
    }

    modelData.wind[stationCode] = {
      mrecFactors: {
        stationCode: factors.stationCode,
        stationType: factors.stationType.toString(),
        MRecLow: factors.MRecLow,
        MRecRamp: factors.MRecRamp,
        MRecRated: factors.MRecRated,
        MRecHigh: factors.MRecHigh,
        vLow: factors.vLow,
        vRated: factors.vRated,
        vHigh: factors.vHigh,
        calibrated: factors.calibrated,
        calibrationDate: factors.calibrationDate.toISOString(),
        sampleCount: factors.sampleCount,
      },
      residualModel,
      useXGBoost: (model as any).useXGBoost || false,
      xgboostModel: undefined, // TODO: Serialize XGBoost if used
    };

    // Add station metadata
    if (stationsData[stationCode]) {
      modelData.stations[stationCode] = stationsData[stationCode];
    }
  }

  // Serialize solar models
  for (const [stationCode, model] of solarModels) {
    const state = model.toJSON();

    modelData.solar[stationCode] = {
      irradianceModelParams: state.irradianceModelParams,
      residualModel: state.residualModel,
      drySeasonResidualModel: state.drySeasonResidualModel,
      biasCorrection: state.biasCorrection,
      drySeasonBiasCorrection: state.drySeasonBiasCorrection,
      hourlyCorrection: state.hourlyCorrection,
      drySeasonHourlyCorrection: state.drySeasonHourlyCorrection,
    };

    // Add station metadata
    if (stationsData[stationCode]) {
      modelData.stations[stationCode] = stationsData[stationCode];
    }
  }

  // Serialize profile models
  for (const [stationCode, model] of profileModels) {
    const profiles: Array<{
      key: string;
      stats: {
        min: number;
        median: number;
        max: number;
        mean: number;
        stdDev: number;
        count: number;
      };
    }> = [];

    // Extract profiles from model
    const profilesMap = (model as any).profiles as Map<string, any>;
    for (const [key, stats] of profilesMap) {
      profiles.push({ key, stats });
    }

    modelData.profile[stationCode] = { profiles };

    // Add station metadata
    if (stationsData[stationCode]) {
      modelData.stations[stationCode] = stationsData[stationCode];
    }
  }

  return modelData;
}
