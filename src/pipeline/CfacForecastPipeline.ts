/**
 * CFAC Forecast Pipeline (V2)
 *
 * Stateless inference:
 * 1. Loads cfac_model.vfm (read-only)
 * 2. Loads cfac_calibration.json (read-only)
 * 3. Fetches weather forecast for target period
 * 4. For each station, each hour:
 *    - Applies model → applies calibration → clamps to [0.0, 1.0]
 * 5. Writes forecast CSV
 *
 * Does NOT:
 * - Access CFac actuals
 * - Retrain or modify any models
 * - Perform any learning
 *
 * Reproducible: same model + calibration + weather = exact same output
 */

import { loadCfacModel, loadCfacCalibration, CfacV2ModelData, CfacV2Calibration } from './CfacModelSerializer.js';
import { Wind4TierHybridModel } from '../models/capacityFactor/Wind4TierHybridModel.js';
import { SolarHybridModel } from '../models/capacityFactor/SolarHybridModel.js';
import { ProfileBasedModel } from '../models/capacityFactor/ProfileBasedModel.js';
import { CFacWeatherFeatures, getStationTypeFromCode, StationType } from '../types/capacityFactor.js';
import { createWeatherService, ClusterLocation } from '../services/weatherService.js';
import { DateTime } from 'luxon';
import fs from 'fs';
import path from 'path';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

// Default API key (can be overridden by env or config)
const DEFAULT_API_KEY = 'BJYBHG8K3YS8EFK46233M8L75';

function getApiKey(): string {
  // Check environment variable first
  if (process.env.VISUAL_CROSSING_API_KEY) {
    return process.env.VISUAL_CROSSING_API_KEY;
  }
  // Check config file
  const configPath = join(process.cwd(), 'config.json');
  if (existsSync(configPath)) {
    try {
      const config = JSON.parse(readFileSync(configPath, 'utf8'));
      if (config.visualCrossingApiKey) {
        return config.visualCrossingApiKey;
      }
    } catch {}
  }
  return DEFAULT_API_KEY;
}

export interface ForecastPipelineConfig {
  modelPath: string; // Path to cfac_model.vfm
  calibrationPath: string; // Path to cfac_calibration.json
  startDate: string; // Forecast start date (YYYY-MM-DD)
  endDate: string; // Forecast end date (YYYY-MM-DD)
  outputPath: string; // Output CSV path
  weatherCachePath?: string; // Weather cache directory
  stations?: string[]; // Forecast specific stations only (default: all)
  verbose?: boolean;
}

/**
 * Generate CFAC forecast
 */
export async function generateCfacForecast(config: ForecastPipelineConfig): Promise<void> {
  const {
    modelPath,
    calibrationPath,
    startDate,
    endDate,
    outputPath,
    weatherCachePath = './weather_cache',
    stations,
    verbose = false,
  } = config;

  console.log('CFAC V2 Forecast Pipeline');
  console.log('==========================\n');

  if (verbose) {
    console.log(`Forecast configuration:`);
    console.log(`  Forecast period: ${startDate} to ${endDate}`);
    console.log(`  Weather cache: ${weatherCachePath}`);
    console.log(`  Target stations: ${stations ? stations.length : 'all'}`);
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

  // Step 2: Load calibration
  if (verbose) {
    console.log(`[${new Date().toISOString()}] Step 2: Loading calibration...`);
  } else {
    console.log('Step 2: Loading calibration...');
  }
  const calibration = loadCfacCalibration(calibrationPath);
  console.log(`  Loaded calibration from ${calibrationPath}`);
  console.log(`  Calibration date: ${calibration.calibrationDate}`);
  if (verbose) {
    console.log(`  Calibration days: ${calibration.calibrationDays}`);
    console.log(`  Calibrated stations: wind=${Object.keys(calibration.wind).length}, solar=${Object.keys(calibration.solar).length}, profile=${Object.keys(calibration.profile).length}`);
  }
  console.log('');

  // Step 3: Reconstruct models
  if (verbose) {
    console.log(`[${new Date().toISOString()}] Step 3: Reconstructing models...`);
  } else {
    console.log('Step 3: Reconstructing models...');
  }
  const { windModels, solarModels, profileModels } = reconstructModels(modelData);
  const allStations = [
    ...Array.from(windModels.keys()),
    ...Array.from(solarModels.keys()),
    ...Array.from(profileModels.keys()),
  ];
  const targetStations = stations || allStations;
  console.log(`  Total stations: ${allStations.length}`);
  console.log(`  Forecasting: ${targetStations.length} stations`);
  if (verbose) {
    console.log(`  Station breakdown: ${windModels.size} wind, ${solarModels.size} solar, ${profileModels.size} profile`);
  }
  console.log('');

  // Step 4: Fetch weather forecast
  if (verbose) {
    console.log(`[${new Date().toISOString()}] Step 4: Fetching weather forecast...`);
  } else {
    console.log('Step 4: Fetching weather forecast...');
  }
  const weatherData = await fetchWeatherForecast(
    targetStations,
    modelData.stations,
    startDate,
    endDate,
    weatherCachePath,
    verbose
  );
  console.log(`  Fetched weather for ${Object.keys(weatherData).length} stations`);
  if (verbose) {
    let totalDataPoints = 0;
    for (const data of Object.values(weatherData)) {
      totalDataPoints += data.length;
    }
    console.log(`  Total weather data points: ${totalDataPoints}`);
  }
  console.log('');

  // Step 5: Generate forecasts
  if (verbose) {
    console.log(`[${new Date().toISOString()}] Step 5: Generating forecasts...`);
  } else {
    console.log('Step 5: Generating forecasts...');
  }
  const forecasts = generateForecasts(
    targetStations,
    windModels,
    solarModels,
    profileModels,
    calibration,
    weatherData,
    startDate,
    endDate,
    verbose
  );
  console.log(`  Generated forecasts for ${Object.keys(forecasts).length} stations`);
  if (verbose) {
    console.log(`  Forecast statistics:`);
    for (const [station, values] of Object.entries(forecasts)) {
      const avg = values.reduce((a, b) => a + b, 0) / values.length;
      const max = Math.max(...values);
      const min = Math.min(...values);
      console.log(`    ${station}: avg=${(avg * 100).toFixed(1)}%, min=${(min * 100).toFixed(1)}%, max=${(max * 100).toFixed(1)}%`);
    }
  }
  console.log('');

  // Step 6: Write CSV
  if (verbose) {
    console.log(`[${new Date().toISOString()}] Step 6: Writing forecast CSV...`);
  } else {
    console.log('Step 6: Writing forecast CSV...');
  }
  writeForecastCSV(forecasts, outputPath, startDate, endDate);
  console.log(`  Saved to ${outputPath}\n`);

  console.log('Forecast complete!');
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
 * Fetch weather forecast for all stations
 */
async function fetchWeatherForecast(
  stations: string[],
  stationsMetadata: CfacV2ModelData['stations'],
  startDate: string,
  endDate: string,
  weatherCachePath: string,
  verbose: boolean
): Promise<{ [stationCode: string]: CFacWeatherFeatures[] }> {
  const weatherData: { [stationCode: string]: CFacWeatherFeatures[] } = {};

  // Create weather service
  const apiKey = getApiKey();
  const weatherService = createWeatherService(apiKey, weatherCachePath);

  // Group stations by type for organized fetching
  const windStations: string[] = [];
  const solarStations: string[] = [];
  const otherStations: string[] = [];

  for (const stationCode of stations) {
    const stationType = getStationTypeFromCode(stationCode);
    if (stationType === StationType.WIND) {
      windStations.push(stationCode);
    } else if (stationType === StationType.SOLAR) {
      solarStations.push(stationCode);
    } else {
      otherStations.push(stationCode);
    }
  }

  if (verbose) {
    console.log(`   Station breakdown: ${windStations.length} wind, ${solarStations.length} solar, ${otherStations.length} other`);
  }

  // Prepare cluster locations for each station type
  const windLocations: ClusterLocation[] = [];
  const solarLocations: ClusterLocation[] = [];
  const otherLocations: ClusterLocation[] = [];

  // Build wind station locations (station-specific, need 100m hub-height data)
  for (const stationCode of windStations) {
    const meta = stationsMetadata[stationCode];
    if (!meta || !meta.location || !meta.location.latitude || !meta.location.longitude) {
      if (verbose) console.log(`  ⚠️  Skipping ${stationCode}: no coordinates`);
      continue;
    }
    windLocations.push({
      clusterId: `WIND_${stationCode}`,
      name: stationCode,
      latitude: meta.location.latitude,
      longitude: meta.location.longitude,
      stationCodes: [stationCode]
    });
  }

  // Build solar station locations (station-specific)
  for (const stationCode of solarStations) {
    const meta = stationsMetadata[stationCode];
    if (!meta || !meta.location || !meta.location.latitude || !meta.location.longitude) {
      if (verbose) console.log(`  ⚠️  Skipping ${stationCode}: no coordinates`);
      continue;
    }
    solarLocations.push({
      clusterId: `SOLAR_${stationCode}`,
      name: stationCode,
      latitude: meta.location.latitude,
      longitude: meta.location.longitude,
      stationCodes: [stationCode]
    });
  }

  // Build other station locations
  for (const stationCode of otherStations) {
    const meta = stationsMetadata[stationCode];
    if (!meta || !meta.location || !meta.location.latitude || !meta.location.longitude) {
      if (verbose) console.log(`  ⚠️  Skipping ${stationCode}: no coordinates`);
      continue;
    }
    otherLocations.push({
      clusterId: stationCode,
      name: stationCode,
      latitude: meta.location.latitude,
      longitude: meta.location.longitude,
      stationCodes: [stationCode]
    });
  }

  // Fetch weather for each station type
  const allFetchedData = new Map<string, string>();

  // Fetch wind weather (with 100m hub-height data)
  if (windLocations.length > 0) {
    if (verbose) console.log(`   Fetching wind station weather (100m hub height)...`);
    const windClusterIds = new Set(windLocations.map(loc => loc.clusterId));
    const windData = await weatherService.fetchAllClusters(
      windLocations,
      startDate,
      endDate,
      verbose ? (msg) => console.log(`   ${msg}`) : undefined,
      windClusterIds,
      { refreshMode: 'refresh' }
    );
    for (const [clusterId, csvData] of windData) {
      allFetchedData.set(clusterId, csvData);
    }
  }

  // Fetch solar weather
  if (solarLocations.length > 0) {
    if (verbose) console.log(`   Fetching solar station weather...`);
    const solarData = await weatherService.fetchAllClusters(
      solarLocations,
      startDate,
      endDate,
      verbose ? (msg) => console.log(`   ${msg}`) : undefined,
      new Set(), // No wind clusters
      { refreshMode: 'refresh' }
    );
    for (const [clusterId, csvData] of solarData) {
      allFetchedData.set(clusterId, csvData);
    }
  }

  // Fetch other station weather
  if (otherLocations.length > 0) {
    if (verbose) console.log(`   Fetching other station weather...`);
    const otherData = await weatherService.fetchAllClusters(
      otherLocations,
      startDate,
      endDate,
      verbose ? (msg) => console.log(`   ${msg}`) : undefined,
      new Set(), // No wind clusters
      { refreshMode: 'refresh' }
    );
    for (const [clusterId, csvData] of otherData) {
      allFetchedData.set(clusterId, csvData);
    }
  }

  // Parse CSV data into CFacWeatherFeatures arrays
  for (const stationCode of stations) {
    const stationType = getStationTypeFromCode(stationCode);
    let clusterId = stationCode;
    if (stationType === StationType.WIND) {
      clusterId = `WIND_${stationCode}`;
    } else if (stationType === StationType.SOLAR) {
      clusterId = `SOLAR_${stationCode}`;
    }

    const csvData = allFetchedData.get(clusterId);
    if (!csvData) {
      if (verbose) console.log(`  ⚠️  No weather data for ${stationCode}`);
      continue;
    }

    // Parse CSV to weather features
    const features = parseWeatherCsv(csvData, stationType === StationType.WIND);
    weatherData[stationCode] = features;

    if (verbose) {
      console.log(`  ✓ ${stationCode}: ${features.length} weather records`);
    }
  }

  return weatherData;
}

/**
 * Helper function to parse weather CSV into CFacWeatherFeatures array
 */
function parseWeatherCsv(csvData: string, isWind: boolean): CFacWeatherFeatures[] {
  const features: CFacWeatherFeatures[] = [];
  const lines = csvData.split('\n').filter(l => l.trim());
  if (lines.length < 2) return features;

  // Parse header
  const headers = lines[0].split(',').map(h => h.toLowerCase().trim());
  const colIdx = (name: string) => headers.indexOf(name);

  // Parse data rows
  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(',');
    const datetimeStr = values[colIdx('datetime')];
    if (!datetimeStr) continue;

    // Parse datetime
    const dt = DateTime.fromISO(datetimeStr.trim());
    if (!dt.isValid) continue;

    // Build weather features
    const weather: CFacWeatherFeatures = {
      temperature: parseFloat(values[colIdx('temp')]) || 25,
      windSpeed: parseFloat(values[colIdx('windspeed')]) || 0,
      windGust: parseFloat(values[colIdx('windgust')]) || 0,
      windDirection: parseFloat(values[colIdx('winddir')]) || undefined,
      cloudCover: parseFloat(values[colIdx('cloudcover')]) || 50,
      solarRadiation: parseFloat(values[colIdx('solarradiation')]) || 0,
      precipitation: parseFloat(values[colIdx('precip')]) || 0,
      humidity: parseFloat(values[colIdx('humidity')]) || 70,
      uvIndex: parseFloat(values[colIdx('uvindex')]) || undefined,
      visibility: parseFloat(values[colIdx('visibility')]) || undefined,
      pressure: parseFloat(values[colIdx('pressure')]) || undefined,
    };

    // Add 100m wind speed for wind stations
    if (isWind && colIdx('windspeed100') >= 0) {
      weather.windSpeed100 = parseFloat(values[colIdx('windspeed100')]) || weather.windSpeed;
    }

    features.push(weather);
  }

  return features;
}

/**
 * Generate forecasts for all stations
 */
function generateForecasts(
  stations: string[],
  windModels: Map<string, Wind4TierHybridModel>,
  solarModels: Map<string, SolarHybridModel>,
  profileModels: Map<string, ProfileBasedModel>,
  calibration: CfacV2Calibration,
  weatherData: { [stationCode: string]: CFacWeatherFeatures[] },
  startDate: string,
  endDate: string,
  verbose: boolean
): { [stationCode: string]: number[] } {
  const forecasts: { [stationCode: string]: number[] } = {};

  // Generate hourly timestamps
  const start = new Date(startDate);
  const end = new Date(endDate);
  const hours: Date[] = [];

  for (let dt = new Date(start); dt <= end; dt.setHours(dt.getHours() + 1)) {
    hours.push(new Date(dt));
  }

  for (const stationCode of stations) {
    const stationForecasts: number[] = [];

    // Determine station type and get model
    let model: Wind4TierHybridModel | SolarHybridModel | ProfileBasedModel | null = null;
    let stationType: 'wind' | 'solar' | 'profile' = 'profile';

    if (windModels.has(stationCode)) {
      model = windModels.get(stationCode)!;
      stationType = 'wind';
    } else if (solarModels.has(stationCode)) {
      model = solarModels.get(stationCode)!;
      stationType = 'solar';
    } else if (profileModels.has(stationCode)) {
      model = profileModels.get(stationCode)!;
      stationType = 'profile';
    }

    if (!model) {
      if (verbose) {
        console.log(`    ${stationCode}: No model found, skipping`);
      }
      continue;
    }

    // Get weather for this station
    const weather = weatherData[stationCode];
    if (!weather || weather.length === 0) {
      if (verbose) {
        console.log(`    ${stationCode}: No weather data, skipping`);
      }
      continue;
    }

    // Generate forecast for each hour
    for (let i = 0; i < hours.length; i++) {
      const datetime = hours[i];
      const hourWeather = weather[i];
      if (!hourWeather) {
        stationForecasts.push(0);
        continue;
      }

      // Get raw model prediction
      let rawPrediction = 0;
      if (stationType === 'wind') {
        rawPrediction = (model as Wind4TierHybridModel).predict(hourWeather, datetime);
      } else if (stationType === 'solar') {
        rawPrediction = (model as SolarHybridModel).predict(hourWeather, datetime);
      } else {
        rawPrediction = (model as ProfileBasedModel).predict(datetime);
      }

      // Apply calibration
      let calibrated = rawPrediction;
      const hour = datetime.getHours();

      if (stationType === 'wind' && calibration.wind[stationCode]) {
        const cal = calibration.wind[stationCode];
        calibrated = (rawPrediction - cal.globalBias) * cal.hourlyScale[hour];
      } else if (stationType === 'solar' && calibration.solar[stationCode]) {
        const cal = calibration.solar[stationCode];
        calibrated = (rawPrediction - cal.globalBias) * cal.hourlyScale[hour];
      } else if (stationType === 'profile' && calibration.profile[stationCode]) {
        const cal = calibration.profile[stationCode];
        calibrated = rawPrediction * cal.seasonalScale;
      }

      // Clamp to [0.0, 1.0]
      const final = Math.max(0, Math.min(1, calibrated));
      stationForecasts.push(final);
    }

    forecasts[stationCode] = stationForecasts;

    if (verbose) {
      const avg = stationForecasts.reduce((a, b) => a + b, 0) / stationForecasts.length;
      console.log(`    ${stationCode} (${stationType}): avg CF = ${(avg * 100).toFixed(1)}%`);
    }
  }

  return forecasts;
}

/**
 * Write forecast to CSV
 */
function writeForecastCSV(
  forecasts: { [stationCode: string]: number[] },
  outputPath: string,
  startDate: string,
  endDate: string
): void {
  const stations = Object.keys(forecasts).sort();
  if (stations.length === 0) {
    throw new Error('No forecasts to write');
  }

  // Generate hourly timestamps
  const start = new Date(startDate);
  const end = new Date(endDate);
  const rows: string[] = [];

  // Header
  rows.push(['DateTimeEnding', ...stations].join(','));

  // Data rows
  let hourIndex = 0;
  for (let dt = new Date(start); dt <= end; dt.setHours(dt.getHours() + 1)) {
    const timestamp = formatDateTimeEnding(dt);
    const values = stations.map((station) => {
      const val = forecasts[station][hourIndex];
      return val !== undefined ? val.toFixed(4) : '0.0000';
    });
    rows.push([timestamp, ...values].join(','));
    hourIndex++;
  }

  // Write to file
  fs.writeFileSync(outputPath, rows.join('\n'), 'utf-8');
}

/**
 * Format datetime as M/D/YYYY HH:mm (hour-ending convention)
 */
function formatDateTimeEnding(dt: Date): string {
  const month = dt.getMonth() + 1;
  const day = dt.getDate();
  const year = dt.getFullYear();
  const hour = dt.getHours();
  const minute = dt.getMinutes();

  return `${month}/${day}/${year} ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}
