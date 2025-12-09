#!/usr/bin/env node
import { Command } from 'commander';
import { DateTime } from 'luxon';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { parse } from 'csv-parse/sync';
import { parseDemandCsv, parseWeatherCsv, type ParsedDemandData } from './parsers/index.js';
import { mergeData } from './utils/index.js';
import { buildTrainingSamples, buildFeatureVector } from './features/index.js';
import { RegressionModel } from './models/regressionModel.js';
import { XGBoostModel } from './models/xgboostModel.js';
import { HybridModel } from './models/hybridModel.js';
import { writeForecastCsv, writeModelReport, writeMetricsSummary } from './writers/index.js';
import { REGION_MAPPINGS } from './constants/index.js';
import { ForecastResult, TrainingSample, RawWeatherData } from './types/index.js';
import { createWeatherService, DEFAULT_LOCATIONS, capacityFactorService, ClusterLocation } from './services/index.js';
import { getDatabase, closeDatabase, DatabaseStats, StoredModel } from './database/index.js';
import { ModelRouter } from './models/capacityFactor/index.js';
import { CFacWeatherFeatures, StationType, getStationTypeFromCode, CFacForecastResult } from './types/capacityFactor.js';
import { parseOutageDirectory } from './parsers/index.js';
import { generateAnalysisReport, formatProbability, getRiskColor } from './services/outageAnalysisService.js';
import { OutageSeverity, TimePeriod, GridRegion, OutageRecord } from './types/outage.js';

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

const program = new Command();

program
  .name('iload')
  .description('Load Forecasting Utility with XGBoost and Multi-Variable Weather Data')
  .version('1.0.0');

// TRAIN command - Train models on historical data
program
  .command('train')
  .description('Train forecasting models on historical demand and weather data')
  .requiredOption('-d, --demand <file>', 'Historical demand CSV file')
  .requiredOption('-w, --weather <files...>', 'Weather CSV files (one per region)')
  .option('-o, --output <dir>', 'Output directory for reports', './output')
  .option('--model <type>', 'Model type: regression, xgboost, or both', 'both')
  .action(async (options) => {
    console.log('\n🔄 Loading data...');

    // Parse demand data (supports single file or folder)
    const demandData = parseDemandCsv(options.demand);
    if (demandData.filesProcessed && demandData.filesProcessed > 1) {
      console.log(`  📊 Demand: ${demandData.records.length} records from ${demandData.filesProcessed} files`);
    } else {
      console.log(`  📊 Demand: ${demandData.records.length} records`);
    }
    console.log(`     Regions: ${demandData.regions.join(', ')}`);

    // Parse weather data
    const weatherDatasets = options.weather.map((file: string) => {
      const data = parseWeatherCsv(file);
      console.log(`  🌤️  Weather: ${data.city} - ${data.records.length} records`);
      return data;
    });

    // Merge data
    console.log('\n🔗 Merging datasets...');
    const merged = mergeData(demandData, weatherDatasets);
    console.log(`  ✅ Matched: ${merged.matchedCount} records`);
    console.log(`  ⚠️  Unmatched demand: ${merged.unmatchedDemand}, weather: ${merged.unmatchedWeather}`);

    // Build training samples
    console.log('\n🔧 Engineering features...');
    const samples = buildTrainingSamples(merged.records, false);
    console.log(`  📐 Training samples: ${samples.length} (after lag filtering)`);

    if (samples.length === 0) {
      console.error('❌ No training samples available. Need more historical data for lag features.');
      process.exit(1);
    }

    // Ensure output directory exists
    const fs = await import('fs');
    if (!fs.existsSync(options.output)) {
      fs.mkdirSync(options.output, { recursive: true });
    }

    let regressionResult = null;
    let xgboostResult = null;

    // Get date range for model metadata
    const trainingStart = DateTime.fromJSDate(demandData.startDate).toISODate()!;
    const trainingEnd = DateTime.fromJSDate(demandData.endDate).toISODate()!;

    // Train Regression model
    if (options.model === 'regression' || options.model === 'both') {
      console.log('\n📈 Training Regression model...');
      const regression = new RegressionModel();
      regressionResult = regression.train(samples);
      console.log(`  R² = ${regressionResult.r2Score.toFixed(4)}, MAPE = ${regressionResult.mape.toFixed(2)}%`);

      writeModelReport(regressionResult, `${options.output}/regression_report.md`);
      console.log(`  📄 Report: ${options.output}/regression_report.md`);

      // Save model to database
      try {
        const db = getDatabase();
        const featureNames = regression.getCoefficients().map(c => c.feature);
        const coefficients = regression.getCoefficientsArray();
        const modelId = db.saveModel(
          `Regression ${DateTime.now().toFormat('yyyy-MM-dd HH:mm')}`,
          'regression',
          trainingStart,
          trainingEnd,
          samples.length,
          regressionResult.r2Score,
          regressionResult.mape,
          regressionResult.rmse,
          regressionResult.mae,
          coefficients,
          featureNames
        );
        console.log(`  💾 Saved to database (ID: ${modelId})`);
        closeDatabase();
      } catch (error: any) {
        console.warn(`  ⚠️  Could not save to database: ${error.message}`);
      }
    }

    // Train XGBoost model
    if (options.model === 'xgboost' || options.model === 'both') {
      console.log('\n🌲 Training XGBoost model...');
      const xgboost = new XGBoostModel();
      xgboostResult = await xgboost.train(samples, {
        maxDepth: 6,
        learningRate: 0.1,
        nEstimators: 100,
        validationSplit: 0.2
      });
      console.log(`  R² = ${xgboostResult.r2Score.toFixed(4)}, MAPE = ${xgboostResult.mape.toFixed(2)}%`);

      writeModelReport(xgboostResult, `${options.output}/xgboost_report.md`);
      console.log(`  📄 Report: ${options.output}/xgboost_report.md`);

      // Note: XGBoost model persistence would require serializing trees
      // For now, we save metrics only
      try {
        const db = getDatabase();
        const modelId = db.saveModel(
          `XGBoost ${DateTime.now().toFormat('yyyy-MM-dd HH:mm')}`,
          'xgboost',
          trainingStart,
          trainingEnd,
          samples.length,
          xgboostResult.r2Score,
          xgboostResult.mape,
          xgboostResult.rmse,
          xgboostResult.mae,
          [], // XGBoost trees are complex, stored separately if needed
          []
        );
        console.log(`  💾 Saved to database (ID: ${modelId})`);
        closeDatabase();
      } catch (error: any) {
        console.warn(`  ⚠️  Could not save to database: ${error.message}`);
      }
    }

    // Write comparison summary
    if (options.model === 'both') {
      writeMetricsSummary(regressionResult, xgboostResult, `${options.output}/comparison.md`);
      console.log(`\n📊 Comparison: ${options.output}/comparison.md`);
    }

    console.log('\n✅ Training complete!');
  });

// FORECAST command - Generate forecasts (auto-fetches weather from Visual Crossing)
program
  .command('forecast')
  .description('Generate demand forecast (auto-fetches weather data from Visual Crossing API)')
  .option('-d, --demand <file>', 'Historical demand CSV file (optional if using database)')
  .requiredOption('-s, --start <date>', 'Forecast start date (YYYY-MM-DD)')
  .requiredOption('-e, --end <date>', 'Forecast end date (YYYY-MM-DD)')
  .requiredOption('-o, --output <file>', 'Output forecast CSV file')
  .option('--model <type>', 'Model type: regression, xgboost, or hybrid', 'regression')
  .option('--use-saved', 'Use saved model from database instead of training new one')
  .option('--scale <percent>', 'Scale forecast by percentage (e.g., 5 for +5%, -3 for -3%)', '0')
  .option('--growth <percent>', 'Daily demand growth rate for hybrid model (e.g., 0.01 for 0.01%/day)', '0')
  .option('--cache <dir>', 'Weather cache directory', './weather_cache')
  .option('--use-db', 'Use demand data from database instead of file')
  .option('--train-days <days>', 'Number of days of historical data to use for training (default: 90)', '90')
  .action(async (options) => {
    try {
      const apiKey = getApiKey();
      const weatherService = createWeatherService(apiKey, options.cache);

      // Parse demand data (from file or database)
      console.log('\n🔄 Loading demand data...');
      let demandData: ParsedDemandData;

      if (options.useDb || !options.demand) {
        // Load demand data from database
        const db = getDatabase();
        const trainDays = parseInt(options.trainDays) || 90;
        const forecastStart = DateTime.fromISO(options.start);
        const trainEnd = forecastStart.minus({ days: 1 }).toISODate()!;
        const trainStart = forecastStart.minus({ days: trainDays }).toISODate()!;

        console.log(`  📂 Loading from database: ${trainStart} to ${trainEnd}`);
        demandData = db.getDemandData(trainStart, trainEnd);
        closeDatabase();

        if (demandData.records.length === 0) {
          console.error('❌ No demand data found in database for the specified period');
          console.error('   Try importing data first with: iload db import -t demand -f <file>');
          process.exit(1);
        }
        console.log(`  📊 Demand: ${demandData.records.length} records from database`);
      } else {
        // Parse demand data from file (supports single file or folder)
        demandData = parseDemandCsv(options.demand);
        if (demandData.filesProcessed && demandData.filesProcessed > 1) {
          console.log(`  📊 Demand: ${demandData.records.length} records from ${demandData.filesProcessed} files`);
        } else {
          console.log(`  📊 Demand: ${demandData.records.length} records`);
        }
      }
      console.log(`  📅 Range: ${DateTime.fromJSDate(demandData.startDate).toISODate()} to ${DateTime.fromJSDate(demandData.endDate).toISODate()}`);

      // Determine training date range (use all historical demand data)
      const trainStart = DateTime.fromJSDate(demandData.startDate).toISODate()!;
      const trainEnd = DateTime.fromJSDate(demandData.endDate).toISODate()!;

      // Fetch weather data for training period
      console.log('\n🌤️  Fetching weather data for training...');
      const trainWeatherFiles = await weatherService.saveWeatherFiles(
        trainStart,
        trainEnd,
        join(options.cache, 'combined'),
        (msg) => console.log(`  ${msg}`)
      );

      if (trainWeatherFiles.length === 0) {
        console.error('❌ Failed to fetch weather data for training');
        process.exit(1);
      }

      // Parse weather data
      const weatherDatasets = trainWeatherFiles.map(file => parseWeatherCsv(file));

      // Merge and build training samples
      console.log('\n🔧 Engineering features...');
      const merged = mergeData(demandData, weatherDatasets);
      const samples = buildTrainingSamples(merged.records, false);
      console.log(`  📐 Training samples: ${samples.length}`);

      if (samples.length === 0) {
        console.error('❌ No training samples available');
        process.exit(1);
      }

      // Train or load model
      let model: RegressionModel | XGBoostModel | HybridModel = new RegressionModel(); // Initialize to avoid TS error
      let usedSavedModel = false;

      if (options.useSaved && options.model === 'regression') {
        // Try to load saved model from database
        console.log('\n💾 Loading saved model from database...');
        try {
          const db = getDatabase();
          const savedModel = db.getActiveModel('regression');
          closeDatabase();

          if (savedModel && savedModel.coefficients.length > 0) {
            model = new RegressionModel();
            (model as RegressionModel).loadFromSerialized({
              coefficients: savedModel.coefficients,
              featureNames: savedModel.featureNames,
              intercept: 0
            });
            usedSavedModel = true;
            console.log(`  ✅ Loaded model ID ${savedModel.id}`);
            console.log(`  📊 Training R² = ${savedModel.r2Score.toFixed(4)}, MAPE = ${savedModel.mape.toFixed(2)}%`);
            console.log(`  📅 Trained on: ${savedModel.trainingStart} to ${savedModel.trainingEnd}`);
          } else {
            console.log('  ⚠️  No saved regression model found, training new one...');
          }
        } catch (error: any) {
          console.warn(`  ⚠️  Could not load saved model: ${error.message}`);
        }
      }

      if (!usedSavedModel) {
        console.log(`\n🎯 Training ${options.model} model...`);
        if (options.model === 'regression') {
          model = new RegressionModel();
          const result = (model as RegressionModel).train(samples);
          console.log(`  R² = ${result.r2Score.toFixed(4)}, MAPE = ${result.mape.toFixed(2)}%`);
        } else if (options.model === 'hybrid') {
          const growthRate = parseFloat(options.growth) / 100; // Convert percent to decimal
          model = new HybridModel({ growthFactor: growthRate, recentDaysCount: 7 });
          const result = await (model as HybridModel).train(samples);
          console.log(`  R² = ${result.r2Score.toFixed(4)}, MAPE = ${result.mape.toFixed(2)}%`);
          if (growthRate > 0) {
            console.log(`  📈 Growth factor: ${(growthRate * 100).toFixed(4)}% per day`);
          }
        } else {
          model = new XGBoostModel();
          const result = await (model as XGBoostModel).train(samples);
          console.log(`  R² = ${result.r2Score.toFixed(4)}, MAPE = ${result.mape.toFixed(2)}%`);
        }
      }

      // Fetch weather data for forecast period
      console.log('\n🌤️  Fetching weather data for forecast period...');
      const forecastWeatherFiles = await weatherService.saveWeatherFiles(
        options.start,
        options.end,
        join(options.cache, 'combined'),
        (msg) => console.log(`  ${msg}`)
      );

      // Parse forecast weather
      const forecastWeatherData = forecastWeatherFiles.map(file => parseWeatherCsv(file));

      // Build demand history map for lag features - use ALL merged records, not just samples
      // This ensures we have the most recent demand values for lag calculations
      const demandHistory = new Map<string, number>();
      const lastKnownDemand = new Map<string, { value: number; ts: number }>();

      // Build hourly averages from RAW demand data (not merged) for better fallback
      // This ensures we have averages even when weather data is missing
      // Key: "region_hour_daytype" where daytype is 0=workday, 1=saturday, 2=sunday
      const hourlyAverages = new Map<string, { sum: number; count: number }>();

      // First, build hourly averages from ALL raw demand data
      for (const record of demandData.records) {
        const dt = DateTime.fromJSDate(record.datetime);
        const hour = dt.hour;
        const dow = dt.weekday; // 1=Mon, 7=Sun
        const dayType = dow === 7 ? 2 : dow === 6 ? 1 : 0; // 0=workday, 1=sat, 2=sun
        const avgKey = `${record.region}_${hour}_${dayType}`;

        if (!hourlyAverages.has(avgKey)) {
          hourlyAverages.set(avgKey, { sum: 0, count: 0 });
        }
        const avg = hourlyAverages.get(avgKey)!;
        avg.sum += record.demand;
        avg.count++;

        // Also track last known from raw demand data
        const lastKnown = lastKnownDemand.get(record.region);
        if (!lastKnown || record.datetime.getTime() > lastKnown.ts) {
          lastKnownDemand.set(record.region, { value: record.demand, ts: record.datetime.getTime() });
        }
      }

      // Build demand history from RAW demand data first (for better lag coverage)
      // This ensures we have actual demand values even when weather data is missing
      for (const record of demandData.records) {
        const key = `${record.datetime.getTime()}_${record.region}`;
        demandHistory.set(key, record.demand);
      }

      // Merged records will overwrite with same values (no harm, just redundant)
      for (const record of merged.records) {
        const key = `${record.datetime.getTime()}_${record.region}`;
        demandHistory.set(key, record.demand);
      }

      // Temperature history for lag features
      const tempHistory = new Map<string, number>();
      const lastKnownTemp = new Map<string, { value: number; ts: number }>();

      for (const record of merged.records) {
        const key = `${record.datetime.getTime()}_${record.region}`;
        tempHistory.set(key, record.weather.temp);

        const lastKnown = lastKnownTemp.get(record.region);
        if (!lastKnown || record.datetime.getTime() > lastKnown.ts) {
          lastKnownTemp.set(record.region, { value: record.weather.temp, ts: record.datetime.getTime() });
        }
      }

      // Helper function to get typical demand for a given hour and day type
      const getTypicalDemand = (region: string, datetime: Date): number | undefined => {
        const dt = DateTime.fromJSDate(datetime);
        const hour = dt.hour;
        const dow = dt.weekday;
        const dayType = dow === 7 ? 2 : dow === 6 ? 1 : 0;
        const avgKey = `${region}_${hour}_${dayType}`;
        const avg = hourlyAverages.get(avgKey);
        if (avg && avg.count > 0) {
          return avg.sum / avg.count;
        }
        return lastKnownDemand.get(region)?.value;
      };

      // Helper to get typical demand for a specific timestamp (used for lags)
      const getTypicalDemandForTime = (region: string, timestamp: number): number | undefined => {
        const dt = DateTime.fromMillis(timestamp);
        const hour = dt.hour;
        const dow = dt.weekday;
        const dayType = dow === 7 ? 2 : dow === 6 ? 1 : 0;
        const avgKey = `${region}_${hour}_${dayType}`;
        const avg = hourlyAverages.get(avgKey);
        if (avg && avg.count > 0) {
          return avg.sum / avg.count;
        }
        return lastKnownDemand.get(region)?.value;
      };

      // Build an index of historical records by region for efficient lookup
      // Structure: region -> array of { datetime, hour, dayType, demand, temp }
      const historicalIndex = new Map<string, Array<{
        datetime: Date;
        hour: number;
        dayType: number;
        demand: number;
        temp: number | undefined;
      }>>();

      for (const record of demandData.records) {
        const dt = DateTime.fromJSDate(record.datetime);
        const hour = dt.hour;
        const dow = dt.weekday;
        const dayType = dow === 7 ? 2 : dow === 6 ? 1 : 0;
        const temp = tempHistory.get(`${record.datetime.getTime()}_${record.region}`);

        if (!historicalIndex.has(record.region)) {
          historicalIndex.set(record.region, []);
        }
        historicalIndex.get(record.region)!.push({
          datetime: record.datetime,
          hour,
          dayType,
          demand: record.demand,
          temp
        });
      }

      // Sort each region's records by datetime descending (most recent first)
      for (const [, records] of historicalIndex) {
        records.sort((a, b) => b.datetime.getTime() - a.datetime.getTime());
      }

      // Find similar days: same dayType, same hour, similar temperature
      // Returns average demand from up to 7 most recent matching days
      const findSimilarDaysDemand = (
        region: string,
        targetHour: number,
        targetDayType: number,
        targetTemp: number,
        beforeTimestamp: number,
        tempTolerance: number = 5 // degrees C
      ): number | undefined => {
        const records = historicalIndex.get(region);
        if (!records) return undefined;

        const matches: number[] = [];
        const seenDates = new Set<string>(); // Track unique dates to get different days

        for (const record of records) {
          // Only consider records before the target timestamp
          if (record.datetime.getTime() >= beforeTimestamp) continue;

          // Match hour and dayType
          if (record.hour !== targetHour || record.dayType !== targetDayType) continue;

          // Check temperature similarity (if temp is available)
          if (record.temp !== undefined && Math.abs(record.temp - targetTemp) > tempTolerance) continue;

          // Track unique days
          const dateKey = DateTime.fromJSDate(record.datetime).toISODate();
          if (dateKey && !seenDates.has(dateKey)) {
            seenDates.add(dateKey);
            matches.push(record.demand);

            // Stop after finding 7 different days
            if (matches.length >= 7) break;
          }
        }

        if (matches.length === 0) return undefined;

        // Return average of matching days
        return matches.reduce((sum, d) => sum + d, 0) / matches.length;
      };

      console.log(`  📊 Historical data loaded: ${demandHistory.size} demand records, ${tempHistory.size} temp records`);

      // Show last known values for each region
      for (const [region, data] of lastKnownDemand) {
        console.log(`  📌 Last known ${region}: ${data.value.toFixed(0)} MW at ${DateTime.fromMillis(data.ts).toISO()}`);
      }

      // Generate forecasts
      const scaleFactor = 1 + (parseFloat(options.scale) / 100);
      console.log('\n🔮 Generating forecasts...');
      if (parseFloat(options.scale) !== 0) {
        console.log(`  📈 Scaling factor: ${scaleFactor.toFixed(4)} (${parseFloat(options.scale) > 0 ? '+' : ''}${options.scale}%)`);
      }
      const forecasts: ForecastResult[] = [];

      for (const weatherData of forecastWeatherData) {
        // Match location by checking if city name contains our location name
        const location = DEFAULT_LOCATIONS.find(
          loc => weatherData.city.toLowerCase().includes(loc.name.toLowerCase())
        );
        if (!location) {
          console.warn(`  Warning: No location match for "${weatherData.city}"`);
          continue;
        }

        const region = location.demandColumn;

        for (const weather of weatherData.records) {
          const datetime = DateTime.fromISO(weather.datetime).plus({ hours: 1 }).toJSDate();
          const ts = datetime.getTime();
          const dt = DateTime.fromJSDate(datetime);
          const hour = dt.hour;
          const dow = dt.weekday;
          const dayType = dow === 7 ? 2 : dow === 6 ? 1 : 0;

          const lastTemp = lastKnownTemp.get(region)?.value;
          const currentTemp = weather.temp;

          // Get "similar days" demand - average from last 7 days matching dayType, hour, and similar temp
          // This is our best estimate for what demand should be at this time
          const similarDaysDemand = findSimilarDaysDemand(region, hour, dayType, currentTemp, ts);

          // Calculate lag features - use similar days demand as fallback for missing lags
          const lag1hTs = ts - 3600000;
          const lag24hTs = ts - 86400000;
          const lag168hTs = ts - 604800000;

          // For lag values, try actual data first, then similar days for that time, then typical
          const getLagDemand = (lagTs: number): number | undefined => {
            // First try actual historical data
            const actual = demandHistory.get(`${lagTs}_${region}`);
            if (actual !== undefined) return actual;

            // Then try similar days for the lag time
            const lagDt = DateTime.fromMillis(lagTs);
            const lagHour = lagDt.hour;
            const lagDow = lagDt.weekday;
            const lagDayType = lagDow === 7 ? 2 : lagDow === 6 ? 1 : 0;
            const lagTemp = tempHistory.get(`${lagTs}_${region}`) ?? currentTemp;
            const similar = findSimilarDaysDemand(region, lagHour, lagDayType, lagTemp, lagTs);
            if (similar !== undefined) return similar;

            // Finally fall back to typical demand
            return getTypicalDemandForTime(region, lagTs);
          };

          const demandLag1h = getLagDemand(lag1hTs);
          const demandLag24h = getLagDemand(lag24hTs);
          const demandLag168h = getLagDemand(lag168hTs);
          const tempLag1h = tempHistory.get(`${lag1hTs}_${region}`) ?? lastTemp;
          const tempLag24h = tempHistory.get(`${lag24hTs}_${region}`) ?? lastTemp;

          // Calculate rolling averages using similar approach
          let demandSum = 0, tempSum = 0, tempMax = -Infinity, count = 0;
          for (let h = 1; h <= 24; h++) {
            const lagTs = ts - h * 3600000;
            const d = getLagDemand(lagTs);
            const t = tempHistory.get(`${lagTs}_${region}`) ?? lastTemp;
            if (d !== undefined && t !== undefined) {
              demandSum += d;
              tempSum += t;
              tempMax = Math.max(tempMax, t);
              count++;
            }
          }

          // Use calculated values
          const demandRolling24h = count > 0 ? demandSum / count : similarDaysDemand ?? lastKnownDemand.get(region)?.value;
          const tempRolling24h = count > 0 ? tempSum / count : lastTemp;
          const tempMax24h = count > 0 ? tempMax : lastTemp;

          const lagData = {
            demandLag1h,
            demandLag24h,
            demandLag168h,
            tempLag1h,
            tempLag24h,
            demandRolling24h,
            tempRolling24h,
            tempMax24h
          };

          const mockRecord = { datetime, region, demand: 0, weather };
          const features = buildFeatureVector(mockRecord, lagData);

          let prediction: number;

          if (options.model === 'hybrid') {
            // Hybrid model handles bounds internally - no blending needed
            // Calculate days ahead from forecast start for growth adjustment
            const forecastStart = DateTime.fromISO(options.start);
            const currentDate = DateTime.fromJSDate(datetime);
            const daysAhead = Math.max(0, currentDate.diff(forecastStart, 'days').days);

            const hybridPrediction = (model as HybridModel).predictForRegion(features, region, daysAhead);
            prediction = (hybridPrediction ?? similarDaysDemand ?? lastKnownDemand.get(region)?.value ?? 0) * scaleFactor;
          } else {
            // Regression/XGBoost model
            const basePrediction = (model as RegressionModel | XGBoostModel).predict(features);

            // Check if we have actual lag1h data or if it came from similar days
            const hasActualLag1h = demandHistory.has(`${lag1hTs}_${region}`);

            if (hasActualLag1h) {
              // Use model prediction directly when we have real lag data
              prediction = basePrediction * scaleFactor;
            } else {
              // When lag1h is estimated (from similar days), blend model prediction with similar days
              // This prevents the cold start death spiral by anchoring to historical patterns
              const blendRatio = 0.5; // 50% model, 50% similar days
              if (similarDaysDemand !== undefined) {
                prediction = (basePrediction * blendRatio + similarDaysDemand * (1 - blendRatio)) * scaleFactor;
              } else {
                prediction = basePrediction * scaleFactor;
              }
            }
          }

          forecasts.push({
            datetime,
            region,
            predictedDemand: prediction
          });

          // Update history for progressive forecasting
          demandHistory.set(`${ts}_${region}`, prediction);
          tempHistory.set(`${ts}_${region}`, weather.temp);
        }
      }

      // Ensure output directory exists
      const outputDir = dirname(options.output);
      if (outputDir && !existsSync(outputDir)) {
        mkdirSync(outputDir, { recursive: true });
      }

      // Write forecasts
      writeForecastCsv(forecasts, options.output);
      console.log(`\n✅ Forecast written to: ${options.output}`);
      console.log(`   📊 ${forecasts.length} predictions across ${[...new Set(forecasts.map(f => f.region))].length} regions`);
      console.log(`   📅 Period: ${options.start} to ${options.end}`);

    } catch (error: any) {
      console.error(`\n❌ Error: ${error.message}`);
      process.exit(1);
    }
  });

// INFO command - Show data summary
program
  .command('info')
  .description('Display information about data files')
  .requiredOption('-d, --demand <file>', 'Demand CSV file')
  .option('-w, --weather <files...>', 'Weather CSV files')
  .action((options) => {
    console.log('\n📊 Data Summary\n');

    const demandData = parseDemandCsv(options.demand);
    console.log('Demand Data:');
    console.log(`  Path: ${options.demand}`);
    if (demandData.filesProcessed && demandData.filesProcessed > 1) {
      console.log(`  Files: ${demandData.filesProcessed} CSV files`);
    }
    console.log(`  Records: ${demandData.records.length}`);
    console.log(`  Regions: ${demandData.regions.join(', ')}`);
    console.log(`  Date Range: ${demandData.startDate.toISOString()} to ${demandData.endDate.toISOString()}`);

    if (options.weather) {
      console.log('\nWeather Data:');
      for (const file of options.weather) {
        const weatherData = parseWeatherCsv(file);
        console.log(`  ${weatherData.city}:`);
        console.log(`    File: ${file}`);
        console.log(`    Records: ${weatherData.records.length}`);
        console.log(`    Date Range: ${weatherData.startDate.toISOString()} to ${weatherData.endDate.toISOString()}`);
      }
    }
  });

// EVALUATE command - Compare forecast vs actual demand for model feedback
program
  .command('evaluate')
  .description('Evaluate forecast accuracy by comparing against actual demand data')
  .requiredOption('-f, --forecast <file>', 'Forecast CSV file to evaluate')
  .requiredOption('-a, --actual <file>', 'Actual demand CSV file')
  .option('-o, --output <file>', 'Output evaluation report file')
  .action((options) => {
    console.log('\n📊 Evaluating Forecast Accuracy...\n');

    // Parse forecast file
    const forecastContent = readFileSync(options.forecast, 'utf-8');
    const forecastRows = parse(forecastContent, { columns: true, skip_empty_lines: true, trim: true });

    // Parse actual demand
    const actualData = parseDemandCsv(options.actual);

    // Build map of actual demand by datetime and region
    const actualMap = new Map<string, number>();
    for (const record of actualData.records) {
      const key = `${record.datetime.getTime()}_${record.region}`;
      actualMap.set(key, record.demand);
    }

    // Compare forecast vs actual
    interface RegionStats {
      count: number;
      sumError: number;
      sumAbsError: number;
      sumAbsPercentError: number;
      sumSquaredError: number;
      sumActual: number;
      sumForecast: number;
      errors: { datetime: Date; forecast: number; actual: number; error: number; percentError: number }[];
    }

    const regionStats = new Map<string, RegionStats>();
    let totalMatched = 0;
    let totalUnmatched = 0;

    for (const row of forecastRows) {
      // Parse forecast datetime - format: "M/D/YYYY HH:mm"
      const dt = DateTime.fromFormat(row['DateTimeEnding'], 'M/d/yyyy HH:mm');
      if (!dt.isValid) {
        console.warn(`Invalid forecast date: ${row['DateTimeEnding']}`);
        continue;
      }
      const datetime = dt.toJSDate();

      // Check each region column
      for (const col of Object.keys(row)) {
        if (col === 'DateTimeEnding') continue;

        const forecastValue = parseFloat(row[col]);
        if (isNaN(forecastValue)) continue;

        const key = `${datetime.getTime()}_${col}`;
        const actualValue = actualMap.get(key);

        if (actualValue === undefined) {
          totalUnmatched++;
          continue;
        }

        totalMatched++;
        const error = forecastValue - actualValue;
        const absError = Math.abs(error);
        const percentError = (absError / actualValue) * 100;

        if (!regionStats.has(col)) {
          regionStats.set(col, {
            count: 0,
            sumError: 0,
            sumAbsError: 0,
            sumAbsPercentError: 0,
            sumSquaredError: 0,
            sumActual: 0,
            sumForecast: 0,
            errors: []
          });
        }

        const stats = regionStats.get(col)!;
        stats.count++;
        stats.sumError += error;
        stats.sumAbsError += absError;
        stats.sumAbsPercentError += percentError;
        stats.sumSquaredError += error * error;
        stats.sumActual += actualValue;
        stats.sumForecast += forecastValue;
        stats.errors.push({ datetime, forecast: forecastValue, actual: actualValue, error, percentError });
      }
    }

    if (totalMatched === 0) {
      console.error('❌ No matching records found between forecast and actual data');
      console.log(`   Forecast file: ${options.forecast}`);
      console.log(`   Actual file: ${options.actual}`);
      process.exit(1);
    }

    // Calculate and display metrics
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('                    FORECAST EVALUATION REPORT                  ');
    console.log('═══════════════════════════════════════════════════════════════\n');

    console.log(`Matched Records: ${totalMatched}`);
    console.log(`Unmatched Forecast Records: ${totalUnmatched}\n`);

    let reportContent = '# Forecast Evaluation Report\n\n';
    reportContent += `Generated: ${DateTime.now().toISO()}\n\n`;
    reportContent += `## Summary\n\n`;
    reportContent += `- Forecast File: ${options.forecast}\n`;
    reportContent += `- Actual File: ${options.actual}\n`;
    reportContent += `- Matched Records: ${totalMatched}\n`;
    reportContent += `- Unmatched Forecast Records: ${totalUnmatched}\n\n`;

    console.log('┌─────────┬──────────┬──────────┬──────────┬──────────┬──────────┐');
    console.log('│ Region  │   MAE    │   MAPE   │   RMSE   │   Bias   │  Count   │');
    console.log('├─────────┼──────────┼──────────┼──────────┼──────────┼──────────┤');

    reportContent += '## Metrics by Region\n\n';
    reportContent += '| Region | MAE (MW) | MAPE (%) | RMSE (MW) | Bias (MW) | Count |\n';
    reportContent += '|--------|----------|----------|-----------|-----------|-------|\n';

    let overallMae = 0, overallMape = 0, overallRmse = 0, overallBias = 0, overallCount = 0;

    for (const [region, stats] of regionStats) {
      const mae = stats.sumAbsError / stats.count;
      const mape = stats.sumAbsPercentError / stats.count;
      const rmse = Math.sqrt(stats.sumSquaredError / stats.count);
      const bias = stats.sumError / stats.count;

      console.log(`│ ${region.padEnd(7)} │ ${mae.toFixed(1).padStart(8)} │ ${mape.toFixed(2).padStart(7)}% │ ${rmse.toFixed(1).padStart(8)} │ ${(bias >= 0 ? '+' : '') + bias.toFixed(1).padStart(7)} │ ${stats.count.toString().padStart(8)} │`);

      reportContent += `| ${region} | ${mae.toFixed(1)} | ${mape.toFixed(2)} | ${rmse.toFixed(1)} | ${bias >= 0 ? '+' : ''}${bias.toFixed(1)} | ${stats.count} |\n`;

      overallMae += stats.sumAbsError;
      overallMape += stats.sumAbsPercentError;
      overallRmse += stats.sumSquaredError;
      overallBias += stats.sumError;
      overallCount += stats.count;
    }

    console.log('├─────────┼──────────┼──────────┼──────────┼──────────┼──────────┤');

    const totalMae = overallMae / overallCount;
    const totalMape = overallMape / overallCount;
    const totalRmse = Math.sqrt(overallRmse / overallCount);
    const totalBias = overallBias / overallCount;

    console.log(`│ OVERALL │ ${totalMae.toFixed(1).padStart(8)} │ ${totalMape.toFixed(2).padStart(7)}% │ ${totalRmse.toFixed(1).padStart(8)} │ ${(totalBias >= 0 ? '+' : '') + totalBias.toFixed(1).padStart(7)} │ ${overallCount.toString().padStart(8)} │`);
    console.log('└─────────┴──────────┴──────────┴──────────┴──────────┴──────────┘');

    reportContent += `| **OVERALL** | **${totalMae.toFixed(1)}** | **${totalMape.toFixed(2)}** | **${totalRmse.toFixed(1)}** | **${totalBias >= 0 ? '+' : ''}${totalBias.toFixed(1)}** | **${overallCount}** |\n\n`;

    // Interpretation
    console.log('\n📈 Interpretation:');
    console.log(`  • MAE (Mean Absolute Error): Average deviation of ${totalMae.toFixed(1)} MW`);
    console.log(`  • MAPE (Mean Absolute Percentage Error): ${totalMape.toFixed(2)}% average error`);
    console.log(`  • RMSE (Root Mean Square Error): ${totalRmse.toFixed(1)} MW (penalizes large errors)`);
    console.log(`  • Bias: ${totalBias >= 0 ? 'Over-forecasting' : 'Under-forecasting'} by ${Math.abs(totalBias).toFixed(1)} MW on average`);

    reportContent += '## Interpretation\n\n';
    reportContent += `- **MAE** (Mean Absolute Error): Average deviation of ${totalMae.toFixed(1)} MW\n`;
    reportContent += `- **MAPE** (Mean Absolute Percentage Error): ${totalMape.toFixed(2)}% average error\n`;
    reportContent += `- **RMSE** (Root Mean Square Error): ${totalRmse.toFixed(1)} MW (penalizes large errors)\n`;
    reportContent += `- **Bias**: ${totalBias >= 0 ? 'Over-forecasting' : 'Under-forecasting'} by ${Math.abs(totalBias).toFixed(1)} MW on average\n\n`;

    // Recommendations based on bias
    console.log('\n💡 Recommendations:');
    reportContent += '## Recommendations\n\n';

    if (Math.abs(totalBias) > totalMae * 0.3) {
      const scaleAdjust = (-totalBias / (overallMae / overallCount + Math.abs(totalBias))) * 100;
      console.log(`  • Significant ${totalBias >= 0 ? 'over' : 'under'}-forecasting detected`);
      console.log(`  • Consider using --scale ${scaleAdjust.toFixed(1)} to compensate`);
      reportContent += `- Significant ${totalBias >= 0 ? 'over' : 'under'}-forecasting detected\n`;
      reportContent += `- Consider using \`--scale ${scaleAdjust.toFixed(1)}\` to compensate\n`;
    } else {
      console.log('  • Forecast bias is within acceptable range');
      reportContent += '- Forecast bias is within acceptable range\n';
    }

    if (totalMape > 10) {
      console.log('  • MAPE > 10% suggests room for model improvement');
      console.log('  • Consider adding more training data or feature engineering');
      reportContent += '- MAPE > 10% suggests room for model improvement\n';
      reportContent += '- Consider adding more training data or feature engineering\n';
    } else if (totalMape > 5) {
      console.log('  • MAPE between 5-10% is acceptable for load forecasting');
      reportContent += '- MAPE between 5-10% is acceptable for load forecasting\n';
    } else {
      console.log('  • MAPE < 5% indicates excellent forecast accuracy');
      reportContent += '- MAPE < 5% indicates excellent forecast accuracy\n';
    }

    // Find worst hours for each region
    console.log('\n⚠️  Largest Errors by Region:');
    reportContent += '\n## Largest Errors by Region\n\n';

    for (const [region, stats] of regionStats) {
      const sortedErrors = stats.errors.sort((a, b) => b.percentError - a.percentError);
      const worst = sortedErrors.slice(0, 3);

      console.log(`\n  ${region}:`);
      reportContent += `### ${region}\n\n`;
      reportContent += '| DateTime | Forecast | Actual | Error | % Error |\n';
      reportContent += '|----------|----------|--------|-------|---------|\n';

      for (const e of worst) {
        const dtStr = DateTime.fromJSDate(e.datetime).toFormat('MM/dd HH:mm');
        console.log(`    ${dtStr}: Forecast ${e.forecast.toFixed(0)} vs Actual ${e.actual.toFixed(0)} (${e.percentError.toFixed(1)}% error)`);
        reportContent += `| ${dtStr} | ${e.forecast.toFixed(0)} | ${e.actual.toFixed(0)} | ${e.error >= 0 ? '+' : ''}${e.error.toFixed(0)} | ${e.percentError.toFixed(1)}% |\n`;
      }
      reportContent += '\n';
    }

    // Peak and Trough Analysis
    console.log('\n📊 Peak & Trough Analysis by Region:');
    reportContent += '\n## Peak & Trough Analysis\n\n';

    console.log('┌─────────┬────────────────────────────────────────────────────────────────────────────┐');
    console.log('│ Region  │  Type   │ Actual (MW) │ Forecast (MW) │  Error  │ % Error │   DateTime   │');
    console.log('├─────────┼─────────┼─────────────┼───────────────┼─────────┼─────────┼──────────────┤');

    reportContent += '| Region | Type | Actual (MW) | Forecast (MW) | Error (MW) | % Error | DateTime |\n';
    reportContent += '|--------|------|-------------|---------------|------------|---------|----------|\n';

    // Track overall peak/trough stats
    let peakErrors: number[] = [];
    let troughErrors: number[] = [];

    for (const [region, stats] of regionStats) {
      // Group errors by date to find daily peaks and troughs
      const byDate = new Map<string, typeof stats.errors>();
      for (const e of stats.errors) {
        const dateKey = DateTime.fromJSDate(e.datetime).toISODate() || '';
        if (!byDate.has(dateKey)) {
          byDate.set(dateKey, []);
        }
        byDate.get(dateKey)!.push(e);
      }

      // Find peaks and troughs for each day
      const dailyPeaks: typeof stats.errors = [];
      const dailyTroughs: typeof stats.errors = [];

      for (const [, dayErrors] of byDate) {
        if (dayErrors.length < 12) continue; // Skip incomplete days

        // Find peak (max actual demand)
        const peak = dayErrors.reduce((max, e) => e.actual > max.actual ? e : max, dayErrors[0]);
        dailyPeaks.push(peak);

        // Find trough (min actual demand)
        const trough = dayErrors.reduce((min, e) => e.actual < min.actual ? e : min, dayErrors[0]);
        dailyTroughs.push(trough);
      }

      if (dailyPeaks.length === 0) continue;

      // Calculate peak statistics
      const avgActualPeak = dailyPeaks.reduce((sum, e) => sum + e.actual, 0) / dailyPeaks.length;
      const avgForecastPeak = dailyPeaks.reduce((sum, e) => sum + e.forecast, 0) / dailyPeaks.length;
      const peakError = avgForecastPeak - avgActualPeak;
      const peakMape = dailyPeaks.reduce((sum, e) => sum + Math.abs(e.forecast - e.actual) / e.actual * 100, 0) / dailyPeaks.length;

      // Calculate trough statistics
      const avgActualTrough = dailyTroughs.reduce((sum, e) => sum + e.actual, 0) / dailyTroughs.length;
      const avgForecastTrough = dailyTroughs.reduce((sum, e) => sum + e.forecast, 0) / dailyTroughs.length;
      const troughError = avgForecastTrough - avgActualTrough;
      const troughMape = dailyTroughs.reduce((sum, e) => sum + Math.abs(e.forecast - e.actual) / e.actual * 100, 0) / dailyTroughs.length;

      // Track for overall stats
      peakErrors.push(peakMape);
      troughErrors.push(troughMape);

      // Find worst peak and trough for display
      const worstPeak = dailyPeaks.reduce((worst, e) =>
        Math.abs(e.forecast - e.actual) > Math.abs(worst.forecast - worst.actual) ? e : worst, dailyPeaks[0]);
      const worstTrough = dailyTroughs.reduce((worst, e) =>
        Math.abs(e.forecast - e.actual) > Math.abs(worst.forecast - worst.actual) ? e : worst, dailyTroughs[0]);

      // Display peak row
      const peakDtStr = DateTime.fromJSDate(worstPeak.datetime).toFormat('MM/dd HH:mm');
      console.log(`│ ${region.padEnd(7)} │  Peak   │ ${avgActualPeak.toFixed(0).padStart(11)} │ ${avgForecastPeak.toFixed(0).padStart(13)} │ ${(peakError >= 0 ? '+' : '') + peakError.toFixed(0).padStart(6)} │ ${peakMape.toFixed(1).padStart(6)}% │ ${peakDtStr.padStart(12)} │`);
      reportContent += `| ${region} | Peak | ${avgActualPeak.toFixed(0)} | ${avgForecastPeak.toFixed(0)} | ${peakError >= 0 ? '+' : ''}${peakError.toFixed(0)} | ${peakMape.toFixed(1)}% | ${peakDtStr} |\n`;

      // Display trough row
      const troughDtStr = DateTime.fromJSDate(worstTrough.datetime).toFormat('MM/dd HH:mm');
      console.log(`│         │ Trough  │ ${avgActualTrough.toFixed(0).padStart(11)} │ ${avgForecastTrough.toFixed(0).padStart(13)} │ ${(troughError >= 0 ? '+' : '') + troughError.toFixed(0).padStart(6)} │ ${troughMape.toFixed(1).padStart(6)}% │ ${troughDtStr.padStart(12)} │`);
      reportContent += `| | Trough | ${avgActualTrough.toFixed(0)} | ${avgForecastTrough.toFixed(0)} | ${troughError >= 0 ? '+' : ''}${troughError.toFixed(0)} | ${troughMape.toFixed(1)}% | ${troughDtStr} |\n`;

      console.log('├─────────┼─────────┼─────────────┼───────────────┼─────────┼─────────┼──────────────┤');
    }

    console.log('└─────────┴─────────┴─────────────┴───────────────┴─────────┴─────────┴──────────────┘');

    // Overall peak/trough summary
    if (peakErrors.length > 0) {
      const avgPeakMape = peakErrors.reduce((sum, e) => sum + e, 0) / peakErrors.length;
      const avgTroughMape = troughErrors.reduce((sum, e) => sum + e, 0) / troughErrors.length;

      console.log('\n📈 Peak/Trough Summary:');
      console.log(`  • Average Peak MAPE: ${avgPeakMape.toFixed(2)}%`);
      console.log(`  • Average Trough MAPE: ${avgTroughMape.toFixed(2)}%`);

      reportContent += '\n### Peak/Trough Summary\n\n';
      reportContent += `- Average Peak MAPE: ${avgPeakMape.toFixed(2)}%\n`;
      reportContent += `- Average Trough MAPE: ${avgTroughMape.toFixed(2)}%\n`;

      if (avgPeakMape > avgTroughMape * 1.5) {
        console.log('  • ⚠️  Peaks are harder to forecast than troughs');
        reportContent += '- Peaks are harder to forecast than troughs\n';
      } else if (avgTroughMape > avgPeakMape * 1.5) {
        console.log('  • ⚠️  Troughs are harder to forecast than peaks');
        reportContent += '- Troughs are harder to forecast than peaks\n';
      } else {
        console.log('  • Peak and trough accuracy are similar');
        reportContent += '- Peak and trough accuracy are similar\n';
      }
    }

    // Write report if output specified
    if (options.output) {
      const outputDir = dirname(options.output);
      if (outputDir && !existsSync(outputDir)) {
        mkdirSync(outputDir, { recursive: true });
      }
      writeFileSync(options.output, reportContent);
      console.log(`\n📄 Report written to: ${options.output}`);
    }

    console.log('\n✅ Evaluation complete!');
  });

// DATABASE commands
const dbCommand = program
  .command('db')
  .description('Database management commands');

// DB STATUS - Show database statistics
dbCommand
  .command('status')
  .description('Show database statistics')
  .action(() => {
    console.log('\n📊 Database Status\n');

    try {
      const db = getDatabase();
      const stats = db.getStats();

      console.log('═══════════════════════════════════════════════════════════════');
      console.log('                    DATABASE STATISTICS                         ');
      console.log('═══════════════════════════════════════════════════════════════\n');

      console.log(`Database Path: ${db.getPath()}\n`);

      console.log('📈 Record Counts:');
      console.log(`  • Demand Records: ${stats.demandRecords.toLocaleString()}`);
      console.log(`  • Weather Records: ${stats.weatherRecords.toLocaleString()}`);
      console.log(`  • Saved Models: ${stats.models}`);

      if (stats.demandDateRange.start && stats.demandDateRange.end) {
        console.log('\n📅 Demand Date Range:');
        console.log(`  • Start: ${stats.demandDateRange.start}`);
        console.log(`  • End: ${stats.demandDateRange.end}`);
      }

      if (stats.weatherDateRange.start && stats.weatherDateRange.end) {
        console.log('\n🌤️  Weather Date Range:');
        console.log(`  • Start: ${stats.weatherDateRange.start}`);
        console.log(`  • End: ${stats.weatherDateRange.end}`);

        // Show weather data breakdown (historical vs forecast)
        const weatherStats = db.getWeatherDataStats();
        console.log('\n📊 Weather Data Breakdown:');
        console.log(`  • Historical: ${weatherStats.historicalRecords.toLocaleString()} records (permanent)`);
        console.log(`  • Forecast: ${weatherStats.forecastRecords.toLocaleString()} records`);
        if (weatherStats.staleForecastRecords > 0) {
          console.log(`  • Stale Forecast: ${weatherStats.staleForecastRecords.toLocaleString()} records (>24h old, will refresh)`);
        }
      }

      if (stats.regions.length > 0) {
        console.log('\n🗺️  Regions:');
        console.log(`  ${stats.regions.join(', ')}`);
      }

      closeDatabase();
      console.log('\n✅ Database status complete!');
    } catch (error: any) {
      console.error(`\n❌ Error: ${error.message}`);
      process.exit(1);
    }
  });

// DB IMPORT - Import data into database
dbCommand
  .command('import')
  .description('Import demand or weather data into the database')
  .requiredOption('-t, --type <type>', 'Data type: demand or weather')
  .requiredOption('-f, --file <path>', 'File or folder path to import')
  .option('-l, --location <name>', 'Location name for weather data (e.g., Manila, Cebu, Davao)')
  .option('--forecast', 'Mark weather data as forecast (not historical)')
  .action((options) => {
    console.log('\n🔄 Importing data...\n');

    try {
      const db = getDatabase();

      if (options.type === 'demand') {
        const demandData = parseDemandCsv(options.file);
        const result = db.importDemandRecords(demandData.records, options.file);

        console.log(`✅ Imported ${result.inserted} demand records`);
        if (demandData.filesProcessed && demandData.filesProcessed > 1) {
          console.log(`   From ${demandData.filesProcessed} files`);
        }
        console.log(`   Regions: ${demandData.regions.join(', ')}`);
        console.log(`   Date Range: ${DateTime.fromJSDate(demandData.startDate).toISODate()} to ${DateTime.fromJSDate(demandData.endDate).toISODate()}`);

      } else if (options.type === 'weather') {
        if (!options.location) {
          console.error('❌ Location (-l, --location) is required for weather data import');
          process.exit(1);
        }

        const weatherData = parseWeatherCsv(options.file);
        const result = db.importWeatherRecords(
          weatherData.records,
          options.location,
          options.forecast || false,
          options.file
        );

        console.log(`✅ Imported ${result.inserted} weather records`);
        console.log(`   Location: ${options.location} (${weatherData.city})`);
        console.log(`   Type: ${options.forecast ? 'Forecast' : 'Historical'}`);
        console.log(`   Date Range: ${DateTime.fromJSDate(weatherData.startDate).toISODate()} to ${DateTime.fromJSDate(weatherData.endDate).toISODate()}`);

      } else {
        console.error('❌ Invalid type. Use "demand" or "weather"');
        process.exit(1);
      }

      closeDatabase();
      console.log('\n✅ Import complete!');
    } catch (error: any) {
      console.error(`\n❌ Error: ${error.message}`);
      process.exit(1);
    }
  });

// DB MODELS - List and manage saved models
dbCommand
  .command('models')
  .description('List and manage saved models')
  .option('-a, --activate <id>', 'Activate a specific model by ID')
  .action((options) => {
    try {
      const db = getDatabase();

      if (options.activate) {
        const modelId = parseInt(options.activate);
        db.activateModel(modelId);
        console.log(`\n✅ Model ${modelId} activated`);
        closeDatabase();
        return;
      }

      const models = db.getAllModels();

      if (models.length === 0) {
        console.log('\n📊 No saved models found');
        console.log('   Train a model and it will be automatically saved to the database.');
        closeDatabase();
        return;
      }

      console.log('\n📊 Saved Models\n');
      console.log('═══════════════════════════════════════════════════════════════════════════════');
      console.log('  ID │ Active │   Type     │    R²    │   MAPE   │  Samples  │    Created');
      console.log('═══════════════════════════════════════════════════════════════════════════════');

      for (const model of models) {
        const active = model.isActive ? '  ✓  ' : '     ';
        const type = model.modelType.padEnd(10);
        const r2 = model.r2Score.toFixed(4).padStart(8);
        const mape = (model.mape.toFixed(2) + '%').padStart(8);
        const samples = model.trainingSamples.toString().padStart(9);
        // SQLite CURRENT_TIMESTAMP returns "YYYY-MM-DD HH:mm:ss" format
        const dt = DateTime.fromSQL(model.createdAt);
        const created = dt.isValid ? dt.toFormat('yyyy-MM-dd HH:mm') : model.createdAt?.substring(0, 16) || 'N/A';

        console.log(` ${model.id.toString().padStart(3)} │ ${active} │ ${type} │ ${r2} │ ${mape} │ ${samples} │ ${created}`);
      }

      console.log('───────────────────────────────────────────────────────────────────────────────');
      console.log('\n💡 Use --activate <id> to set a model as active for forecasting');

      closeDatabase();
    } catch (error: any) {
      console.error(`\n❌ Error: ${error.message}`);
      process.exit(1);
    }
  });

// DB CLEAR - Clear database data
dbCommand
  .command('clear')
  .description('Clear all data from the database')
  .option('--confirm', 'Confirm clearing all data')
  .action((options) => {
    if (!options.confirm) {
      console.log('\n⚠️  This will delete ALL data from the database.');
      console.log('   Use --confirm to proceed.');
      return;
    }

    try {
      const db = getDatabase();
      db.clearAll();
      closeDatabase();
      console.log('\n✅ Database cleared successfully');
    } catch (error: any) {
      console.error(`\n❌ Error: ${error.message}`);
      process.exit(1);
    }
  });

// CFAC commands - Capacity Factor Forecasting
const cfacCommand = program
  .command('cfac')
  .description('Capacity factor forecasting for renewable/must-run generation');

// CFAC FORECAST - Generate capacity factor forecasts
cfacCommand
  .command('forecast')
  .description('Generate capacity factor forecast for renewable/must-run stations')
  .requiredOption('-t, --training <path>', 'Training data: MRHCFac CSV file or directory')
  .requiredOption('-s, --start <date>', 'Forecast start date (YYYY-MM-DD)')
  .requiredOption('-e, --end <date>', 'Forecast end date (YYYY-MM-DD)')
  .requiredOption('-o, --output <file>', 'Output forecast CSV file')
  .option('--stations <file>', 'Stations JSON file', 'src/data/stations.json')
  .option('--cache <dir>', 'Weather cache directory', './weather_cache')
  .action(async (options) => {
    try {
      const apiKey = getApiKey();
      const weatherService = createWeatherService(apiKey, options.cache);

      console.log('\n📊 Capacity Factor Forecasting');
      console.log('═══════════════════════════════════════════════════════════════\n');

      // Load station metadata
      console.log('🔄 Loading station metadata...');
      await capacityFactorService.loadStations(options.stations);
      const stations = capacityFactorService.getAllStations();
      const clusters = capacityFactorService.getClusters();
      console.log(`   Loaded ${stations.size} stations`);
      console.log(`   Loaded ${clusters.length} weather clusters`);

      // Parse training data (capacity factors)
      console.log('\n🔄 Parsing capacity factor training data...');
      const cfacData = await capacityFactorService.parseCapacityFactorDirectory(
        options.training,
        (msg) => console.log(`   ${msg}`)
      );

      // Get unique station codes from training data
      const trainingStations = capacityFactorService.getStationCodes(cfacData);
      console.log(`   Found ${trainingStations.length} stations in training data`);

      // Categorize stations by type
      const stationsByType = new Map<StationType, string[]>();
      for (const stationType of Object.values(StationType)) {
        stationsByType.set(stationType as StationType, []);
      }
      for (const code of trainingStations) {
        const type = getStationTypeFromCode(code);
        stationsByType.get(type)!.push(code);
      }

      console.log('\n📋 Station types in training data:');
      for (const [type, codes] of stationsByType) {
        if (codes.length > 0) {
          console.log(`   ${type}: ${codes.length} stations`);
        }
      }

      // Identify wind clusters (clusters containing wind stations)
      // These clusters will fetch 100m hub-height wind data for better accuracy
      const windStations = stationsByType.get(StationType.WIND) || [];
      const windClusterIds = new Set<string>();
      for (const stationCode of windStations) {
        const clusterId = capacityFactorService.getClusterForStation(stationCode);
        if (clusterId) {
          windClusterIds.add(clusterId);
        }
      }
      if (windClusterIds.size > 0) {
        console.log(`\n🌬️  Identified ${windClusterIds.size} wind clusters for 100m hub-height data`);
      }

      // Get date range from training data
      const sortedCfac = [...cfacData].sort((a, b) => a.datetime.getTime() - b.datetime.getTime());
      const trainStart = DateTime.fromJSDate(sortedCfac[0].datetime).toISODate()!;
      const trainEnd = DateTime.fromJSDate(sortedCfac[sortedCfac.length - 1].datetime).toISODate()!;
      console.log(`\n📅 Training data range: ${trainStart} to ${trainEnd}`);

      // Fetch weather data for training period using cluster-based approach
      // Wind clusters will receive 100m hub-height wind data
      console.log('\n🌤️  Fetching cluster weather data for training period...');
      const clusterWeatherCsv = await weatherService.fetchAllClusters(
        clusters,
        trainStart,
        trainEnd,
        (msg) => console.log(`   ${msg}`),
        windClusterIds  // Pass wind cluster IDs for 100m data
      );

      if (clusterWeatherCsv.size === 0) {
        console.error('❌ Failed to fetch weather data for training');
        process.exit(1);
      }
      console.log(`   Fetched weather data for ${clusterWeatherCsv.size} clusters`);

      // Helper to parse CSV line properly (handles quoted fields with commas)
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

      // Parse cluster weather data into maps by clusterId -> datetime -> features
      const clusterWeatherData = new Map<string, Map<string, CFacWeatherFeatures>>();
      for (const [clusterId, csvData] of clusterWeatherCsv) {
        const datetimeMap = new Map<string, CFacWeatherFeatures>();
        const lines = csvData.split('\n').filter(l => l.trim());

        if (lines.length < 2) continue;

        // Parse header to get column indices (header doesn't have quoted fields)
        const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
        const colIdx = (name: string) => headers.indexOf(name);

        for (let i = 1; i < lines.length; i++) {
          // Use proper CSV parsing for data rows (may have quoted fields)
          const values = parseCSVLine(lines[i]);
          const datetimeStr = values[colIdx('datetime')];
          if (!datetimeStr) continue;

          const dt = DateTime.fromISO(datetimeStr);
          if (!dt.isValid) continue;

          // Add 1 hour to convert from hour-starting (weather API) to hour-ending (CFac format)
          // Use simple format for datetime key to avoid timezone mismatches
          const key = dt.plus({ hours: 1 }).toFormat('yyyy-MM-dd HH:mm');

          // Parse standard weather features
          const weatherFeatures: CFacWeatherFeatures = {
            windSpeed: parseFloat(values[colIdx('windspeed')]) || 0,
            windGust: parseFloat(values[colIdx('windgust')]) || 0,
            solarRadiation: parseFloat(values[colIdx('solarradiation')]) || 0,
            cloudCover: parseFloat(values[colIdx('cloudcover')]) || 0,
            temperature: parseFloat(values[colIdx('temp')]) || 0,
            precipitation: parseFloat(values[colIdx('precip')]) || 0
          };

          // Parse 100m wind data for wind clusters (if available)
          const windSpeed100Idx = colIdx('windspeed100');
          const windDir100Idx = colIdx('winddir100');
          if (windSpeed100Idx >= 0 && values[windSpeed100Idx]) {
            weatherFeatures.windSpeed100 = parseFloat(values[windSpeed100Idx]) || undefined;
          }
          if (windDir100Idx >= 0 && values[windDir100Idx]) {
            weatherFeatures.windDirection100 = parseFloat(values[windDir100Idx]) || undefined;
          }

          datetimeMap.set(key, weatherFeatures);
        }

        clusterWeatherData.set(clusterId, datetimeMap);
      }

      // Build station-to-weather mapping for training
      // Each station uses its cluster's weather data
      const weatherMap = new Map<string, CFacWeatherFeatures>();
      let matchedRecords = 0;

      // Get all unique datetimes from training data
      const trainDatetimes = new Set<string>();
      for (const record of cfacData) {
        const dt = DateTime.fromJSDate(record.datetime);
        // Use simple format for datetime key to match weather data keys
        trainDatetimes.add(dt.toFormat('yyyy-MM-dd HH:mm'));
      }

      // For each datetime, build station weather mappings
      for (const datetimeKey of trainDatetimes) {
        // Store weather keyed by datetime for the buildTrainingSamples function
        // Use average of all cluster weather for the datetime key
        let sumTemp = 0, sumWind = 0, sumGust = 0, sumSolar = 0, sumCloud = 0, sumPrecip = 0;
        let count = 0;

        for (const [, datetimeMap] of clusterWeatherData) {
          const weather = datetimeMap.get(datetimeKey);
          if (weather) {
            sumTemp += weather.temperature;
            sumWind += weather.windSpeed;
            sumGust += weather.windGust;
            sumSolar += weather.solarRadiation;
            sumCloud += weather.cloudCover;
            sumPrecip += weather.precipitation || 0;
            count++;
          }
        }

        if (count > 0) {
          weatherMap.set(datetimeKey, {
            windSpeed: sumWind / count,
            windGust: sumGust / count,
            solarRadiation: sumSolar / count,
            cloudCover: sumCloud / count,
            temperature: sumTemp / count,
            precipitation: sumPrecip / count
          });
          matchedRecords++;
        }
      }
      console.log(`   Built weather map with ${matchedRecords} hourly records from ${clusterWeatherData.size} clusters`);

      // Build training samples
      console.log('\n🔧 Building training samples...');
      const trainingSamples = await capacityFactorService.buildTrainingSamples(
        cfacData,
        weatherMap,
        (msg) => console.log(`   ${msg}`)
      );

      // Train models
      console.log('\n🎯 Training capacity factor models...');
      const modelRouter = new ModelRouter();
      await modelRouter.trainAllModels(trainingSamples, (msg) => console.log(`   ${msg}`));

      // Show training summary
      const metrics = modelRouter.getMetrics();
      console.log(`\n📈 Training Summary: ${modelRouter.getModelCount()} models trained`);

      // Calculate average metrics by type
      const metricsByType = new Map<string, { mape: number; count: number }>();
      for (const [, m] of metrics) {
        const key = m.stationType;
        if (!metricsByType.has(key)) {
          metricsByType.set(key, { mape: 0, count: 0 });
        }
        const stats = metricsByType.get(key)!;
        stats.mape += m.mape;
        stats.count++;
      }

      console.log('\n┌─────────────────┬──────────┬──────────┐');
      console.log('│   Station Type  │ Stations │ Avg MAPE │');
      console.log('├─────────────────┼──────────┼──────────┤');
      for (const [type, stats] of metricsByType) {
        const avgMape = stats.mape / stats.count;
        console.log(`│ ${type.padEnd(15)} │ ${stats.count.toString().padStart(8)} │ ${avgMape.toFixed(2).padStart(7)}% │`);
      }
      console.log('└─────────────────┴──────────┴──────────┘');

      // Fetch weather data for forecast period using cluster-based approach
      // Wind clusters will receive 100m hub-height wind data
      console.log('\n🌤️  Fetching cluster weather data for forecast period...');
      const forecastClusterWeatherCsv = await weatherService.fetchAllClusters(
        clusters,
        options.start,
        options.end,
        (msg) => console.log(`   ${msg}`),
        windClusterIds  // Pass wind cluster IDs for 100m data
      );

      // Parse forecast cluster weather data
      const forecastClusterWeatherData = new Map<string, Map<string, CFacWeatherFeatures>>();
      const forecastDatetimes: Date[] = [];

      for (const [clusterId, csvData] of forecastClusterWeatherCsv) {
        const datetimeMap = new Map<string, CFacWeatherFeatures>();
        const lines = csvData.split('\n').filter(l => l.trim());

        if (lines.length < 2) continue;

        const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
        const colIdx = (name: string) => headers.indexOf(name);

        for (let i = 1; i < lines.length; i++) {
          // Use proper CSV parsing for data rows (may have quoted fields)
          const values = parseCSVLine(lines[i]);
          const datetimeStr = values[colIdx('datetime')];
          if (!datetimeStr) continue;

          // Visual Crossing returns data at interval start, we need to shift by +1 hour for MRHCFac format (hour-ending)
          const dt = DateTime.fromISO(datetimeStr).plus({ hours: 1 });
          if (!dt.isValid) continue;

          // Use simple format for datetime key to avoid timezone mismatches
          const key = dt.toFormat('yyyy-MM-dd HH:mm');
          const datetime = dt.toJSDate();

          // Parse standard weather features
          const weatherFeatures: CFacWeatherFeatures = {
            windSpeed: parseFloat(values[colIdx('windspeed')]) || 0,
            windGust: parseFloat(values[colIdx('windgust')]) || 0,
            solarRadiation: parseFloat(values[colIdx('solarradiation')]) || 0,
            cloudCover: parseFloat(values[colIdx('cloudcover')]) || 0,
            temperature: parseFloat(values[colIdx('temp')]) || 0,
            precipitation: parseFloat(values[colIdx('precip')]) || 0
          };

          // Parse 100m wind data for wind clusters (if available)
          const windSpeed100Idx = colIdx('windspeed100');
          const windDir100Idx = colIdx('winddir100');
          if (windSpeed100Idx >= 0 && values[windSpeed100Idx]) {
            weatherFeatures.windSpeed100 = parseFloat(values[windSpeed100Idx]) || undefined;
          }
          if (windDir100Idx >= 0 && values[windDir100Idx]) {
            weatherFeatures.windDirection100 = parseFloat(values[windDir100Idx]) || undefined;
          }

          datetimeMap.set(key, weatherFeatures);
          forecastDatetimes.push(datetime);
        }

        forecastClusterWeatherData.set(clusterId, datetimeMap);
      }

      // Get unique sorted datetimes
      const uniqueDatetimes = [...new Set(forecastDatetimes.map(d => d.getTime()))]
        .sort((a, b) => a - b)
        .map(ts => new Date(ts));

      console.log(`   Forecast period: ${uniqueDatetimes.length} hours across ${forecastClusterWeatherData.size} clusters`);

      // Generate forecasts using station-specific cluster weather
      console.log('\n🔮 Generating capacity factor forecasts...');
      const forecasts: CFacForecastResult[] = [];

      for (const datetime of uniqueDatetimes) {
        const dt = DateTime.fromJSDate(datetime);
        // Use simple format for datetime key to match weather data keys
        const weatherKey = dt.toFormat('yyyy-MM-dd HH:mm');

        // Build station-specific weather map using each station's cluster weather
        const stationWeather = new Map<string, CFacWeatherFeatures>();
        for (const code of trainingStations) {
          const clusterId = capacityFactorService.getClusterForStation(code);
          if (clusterId) {
            const clusterData = forecastClusterWeatherData.get(clusterId);
            if (clusterData) {
              const weather = clusterData.get(weatherKey);
              if (weather) {
                stationWeather.set(code, weather);
              }
            }
          }

          // Fallback: if station has no cluster, use average of all clusters
          if (!stationWeather.has(code)) {
            let sumTemp = 0, sumWind = 0, sumGust = 0, sumSolar = 0, sumCloud = 0, count = 0;
            for (const [, clusterData] of forecastClusterWeatherData) {
              const weather = clusterData.get(weatherKey);
              if (weather) {
                sumTemp += weather.temperature;
                sumWind += weather.windSpeed;
                sumGust += weather.windGust;
                sumSolar += weather.solarRadiation;
                sumCloud += weather.cloudCover;
                count++;
              }
            }
            if (count > 0) {
              stationWeather.set(code, {
                windSpeed: sumWind / count,
                windGust: sumGust / count,
                solarRadiation: sumSolar / count,
                cloudCover: sumCloud / count,
                temperature: sumTemp / count
              });
            }
          }
        }

        if (stationWeather.size === 0) {
          continue;
        }

        // Predict for all stations with available weather
        const predictions = modelRouter.predictAll(trainingStations, stationWeather, datetime);
        forecasts.push(...predictions);
      }

      console.log(`   Generated ${forecasts.length} predictions`);

      // Ensure output directory exists
      const outputDir = dirname(options.output);
      if (outputDir && !existsSync(outputDir)) {
        mkdirSync(outputDir, { recursive: true });
      }

      // Write forecasts
      await capacityFactorService.writeForecastCSV(
        forecasts,
        options.output,
        trainingStations,
        (msg) => console.log(`   ${msg}`)
      );

      console.log(`\n✅ Forecast written to: ${options.output}`);
      console.log(`   📊 ${forecasts.length} predictions for ${trainingStations.length} stations`);
      console.log(`   📅 Period: ${options.start} to ${options.end}`);

    } catch (error: any) {
      console.error(`\n❌ Error: ${error.message}`);
      if (error.stack) {
        console.error(error.stack);
      }
      process.exit(1);
    }
  });

// CFAC EVALUATE - Evaluate capacity factor forecast accuracy
cfacCommand
  .command('evaluate')
  .description('Evaluate capacity factor forecast accuracy against actual data')
  .requiredOption('-f, --forecast <file>', 'Forecast CSV file to evaluate')
  .requiredOption('-a, --actual <file>', 'Actual capacity factor CSV file (MRHCFac format)')
  .option('-o, --output <file>', 'Output evaluation report file')
  .action(async (options) => {
    console.log('\n📊 Evaluating Capacity Factor Forecast...\n');

    try {
      // Parse forecast file
      const forecastContent = readFileSync(options.forecast, 'utf-8');
      const forecastRows = parse(forecastContent, { columns: true, skip_empty_lines: true, trim: true });

      // Parse actual capacity factor data
      const actualData = await capacityFactorService.parseCapacityFactorCSV(
        options.actual,
        (msg) => console.log(`  ${msg}`)
      );

      // Build map of actual CFac by datetime and station
      const actualMap = new Map<string, number>();
      for (const record of actualData) {
        const key = `${record.datetime.getTime()}_${record.stationCode}`;
        actualMap.set(key, record.capacityFactor);
      }

      // Compare forecast vs actual
      interface StationStats {
        count: number;
        sumError: number;
        sumAbsError: number;
        sumAbsPercentError: number;
        sumSquaredError: number;
        type: StationType;
      }

      const stationStats = new Map<string, StationStats>();
      let totalMatched = 0;
      let totalUnmatched = 0;

      for (const row of forecastRows) {
        // Parse forecast datetime
        const dt = DateTime.fromFormat(row['DateTimeEnding'], 'M/d/yyyy HH:mm');
        if (!dt.isValid) {
          continue;
        }
        const datetime = dt.toJSDate();

        // Check each station column
        for (const col of Object.keys(row)) {
          if (col === 'DateTimeEnding') continue;

          const forecastValue = parseFloat(row[col]);
          if (isNaN(forecastValue)) continue;

          const key = `${datetime.getTime()}_${col}`;
          const actualValue = actualMap.get(key);

          if (actualValue === undefined) {
            totalUnmatched++;
            continue;
          }

          totalMatched++;
          const error = forecastValue - actualValue;
          const absError = Math.abs(error);
          const percentError = actualValue > 0.01 ? (absError / actualValue) * 100 : 0;

          if (!stationStats.has(col)) {
            stationStats.set(col, {
              count: 0,
              sumError: 0,
              sumAbsError: 0,
              sumAbsPercentError: 0,
              sumSquaredError: 0,
              type: getStationTypeFromCode(col)
            });
          }

          const stats = stationStats.get(col)!;
          stats.count++;
          stats.sumError += error;
          stats.sumAbsError += absError;
          stats.sumAbsPercentError += percentError;
          stats.sumSquaredError += error * error;
        }
      }

      if (totalMatched === 0) {
        console.error('❌ No matching records found between forecast and actual data');
        process.exit(1);
      }

      // Calculate and display metrics
      console.log('═══════════════════════════════════════════════════════════════');
      console.log('              CAPACITY FACTOR FORECAST EVALUATION              ');
      console.log('═══════════════════════════════════════════════════════════════\n');

      console.log(`Matched Records: ${totalMatched}`);
      console.log(`Unmatched Forecast Records: ${totalUnmatched}\n`);

      // Group by type for summary
      const typeStats = new Map<string, { mae: number; mape: number; count: number; stations: number }>();

      console.log('┌─────────────────┬──────────┬──────────┬──────────┬──────────┐');
      console.log('│     Station     │   MAE    │   MAPE   │   RMSE   │  Count   │');
      console.log('├─────────────────┼──────────┼──────────┼──────────┼──────────┤');

      let reportContent = '# Capacity Factor Forecast Evaluation\n\n';
      reportContent += `Generated: ${DateTime.now().toISO()}\n\n`;
      reportContent += `## Summary\n\n`;
      reportContent += `- Forecast File: ${options.forecast}\n`;
      reportContent += `- Actual File: ${options.actual}\n`;
      reportContent += `- Matched Records: ${totalMatched}\n`;
      reportContent += `- Unmatched Records: ${totalUnmatched}\n\n`;
      reportContent += '## Metrics by Station\n\n';
      reportContent += '| Station | Type | MAE | MAPE (%) | RMSE | Count |\n';
      reportContent += '|---------|------|-----|----------|------|-------|\n';

      for (const [station, stats] of stationStats) {
        const mae = stats.sumAbsError / stats.count;
        const mape = stats.sumAbsPercentError / stats.count;
        const rmse = Math.sqrt(stats.sumSquaredError / stats.count);

        // Display (truncate station name if needed)
        const displayName = station.length > 15 ? station.substring(0, 12) + '...' : station;
        console.log(`│ ${displayName.padEnd(15)} │ ${mae.toFixed(4).padStart(8)} │ ${mape.toFixed(2).padStart(7)}% │ ${rmse.toFixed(4).padStart(8)} │ ${stats.count.toString().padStart(8)} │`);

        reportContent += `| ${station} | ${stats.type} | ${mae.toFixed(4)} | ${mape.toFixed(2)} | ${rmse.toFixed(4)} | ${stats.count} |\n`;

        // Aggregate by type
        const typeKey = stats.type;
        if (!typeStats.has(typeKey)) {
          typeStats.set(typeKey, { mae: 0, mape: 0, count: 0, stations: 0 });
        }
        const ts = typeStats.get(typeKey)!;
        ts.mae += mae;
        ts.mape += mape;
        ts.count += stats.count;
        ts.stations++;
      }

      console.log('└─────────────────┴──────────┴──────────┴──────────┴──────────┘');

      // Type summary
      console.log('\n📊 Summary by Station Type:\n');
      console.log('┌─────────────────┬──────────┬──────────┬──────────┐');
      console.log('│   Station Type  │ Stations │ Avg MAE  │ Avg MAPE │');
      console.log('├─────────────────┼──────────┼──────────┼──────────┤');

      reportContent += '\n## Summary by Station Type\n\n';
      reportContent += '| Type | Stations | Avg MAE | Avg MAPE (%) |\n';
      reportContent += '|------|----------|---------|---------------|\n';

      for (const [type, ts] of typeStats) {
        const avgMae = ts.mae / ts.stations;
        const avgMape = ts.mape / ts.stations;
        console.log(`│ ${type.padEnd(15)} │ ${ts.stations.toString().padStart(8)} │ ${avgMae.toFixed(4).padStart(8)} │ ${avgMape.toFixed(2).padStart(7)}% │`);
        reportContent += `| ${type} | ${ts.stations} | ${avgMae.toFixed(4)} | ${avgMape.toFixed(2)} |\n`;
      }

      console.log('└─────────────────┴──────────┴──────────┴──────────┘');

      // Interpretation
      console.log('\n💡 Interpretation:');
      console.log('  • MAE (Mean Absolute Error): Average absolute deviation from actual');
      console.log('  • MAPE (Mean Absolute Percentage Error): Percentage deviation');
      console.log('  • Values are capacity factors (0.0 to 1.0)');

      reportContent += '\n## Interpretation\n\n';
      reportContent += '- **MAE** (Mean Absolute Error): Average absolute deviation from actual capacity factor\n';
      reportContent += '- **MAPE** (Mean Absolute Percentage Error): Percentage deviation from actual\n';
      reportContent += '- Values represent capacity factors (0.0 to 1.0)\n';

      // Write report if output specified
      if (options.output) {
        const outputDir = dirname(options.output);
        if (outputDir && !existsSync(outputDir)) {
          mkdirSync(outputDir, { recursive: true });
        }
        writeFileSync(options.output, reportContent);
        console.log(`\n📄 Report written to: ${options.output}`);
      }

      console.log('\n✅ Evaluation complete!');

    } catch (error: any) {
      console.error(`\n❌ Error: ${error.message}`);
      process.exit(1);
    }
  });

// CFAC INFO - Show information about capacity factor data
cfacCommand
  .command('info')
  .description('Display information about capacity factor data files')
  .requiredOption('-d, --data <path>', 'Capacity factor CSV file or directory')
  .option('--stations <file>', 'Stations JSON file', 'src/data/stations.json')
  .action(async (options) => {
    console.log('\n📊 Capacity Factor Data Information\n');

    try {
      // Load station metadata
      await capacityFactorService.loadStations(options.stations);

      // Parse capacity factor data
      const cfacData = await capacityFactorService.parseCapacityFactorDirectory(
        options.data,
        (msg) => console.log(`  ${msg}`)
      );

      // Get unique stations
      const stationCodes = capacityFactorService.getStationCodes(cfacData);

      // Get date range
      const sorted = [...cfacData].sort((a, b) => a.datetime.getTime() - b.datetime.getTime());
      const startDate = sorted[0].datetime;
      const endDate = sorted[sorted.length - 1].datetime;

      console.log('\n═══════════════════════════════════════════════════════════════');
      console.log(`  Path: ${options.data}`);
      console.log(`  Total Records: ${cfacData.length.toLocaleString()}`);
      console.log(`  Stations: ${stationCodes.length}`);
      console.log(`  Date Range: ${DateTime.fromJSDate(startDate).toISO()} to ${DateTime.fromJSDate(endDate).toISO()}`);
      console.log('═══════════════════════════════════════════════════════════════\n');

      // Group by type
      const byType = new Map<string, string[]>();
      for (const code of stationCodes) {
        const type = getStationTypeFromCode(code);
        if (!byType.has(type)) {
          byType.set(type, []);
        }
        byType.get(type)!.push(code);
      }

      console.log('📋 Stations by Type:\n');
      for (const [type, codes] of byType) {
        console.log(`  ${type} (${codes.length}):`);
        for (const code of codes.slice(0, 10)) {
          const stats = capacityFactorService.getStationStatistics(cfacData, code);
          if (stats) {
            console.log(`    ${code}: mean=${stats.mean.toFixed(3)}, min=${stats.min.toFixed(3)}, max=${stats.max.toFixed(3)} (${stats.count} records)`);
          }
        }
        if (codes.length > 10) {
          console.log(`    ... and ${codes.length - 10} more`);
        }
        console.log('');
      }

      console.log('✅ Info complete!');

    } catch (error: any) {
      console.error(`\n❌ Error: ${error.message}`);
      process.exit(1);
    }
  });

// FORECAST-ALL command - Generate both demand and capacity factor forecasts
program
  .command('forecast-all')
  .description('Generate both demand and capacity factor forecasts in a single command')
  .requiredOption('-d, --demand <file>', 'Historical demand CSV file or directory')
  .requiredOption('-c, --cfac <path>', 'Capacity factor training data: MRHCFac CSV file or directory')
  .requiredOption('-s, --start <date>', 'Forecast start date (YYYY-MM-DD)')
  .requiredOption('-e, --end <date>', 'Forecast end date (YYYY-MM-DD)')
  .option('-o, --output <dir>', 'Output directory for forecast files', './output')
  .option('--model <type>', 'Demand model type: regression, xgboost, or hybrid', 'regression')
  .option('--stations <file>', 'Stations JSON file for cfac', 'src/data/stations.json')
  .option('--cache <dir>', 'Weather cache directory', './weather_cache')
  .action(async (options) => {
    try {
      const apiKey = getApiKey();
      const weatherService = createWeatherService(apiKey, options.cache);

      console.log('\n════════════════════════════════════════════════════════════════');
      console.log('              COMBINED DEMAND & CAPACITY FACTOR FORECAST          ');
      console.log('════════════════════════════════════════════════════════════════\n');

      // Ensure output directory exists
      if (!existsSync(options.output)) {
        mkdirSync(options.output, { recursive: true });
      }

      // Generate output filenames
      const demandOutputFile = join(options.output, `demand_forecast_${options.start}_${options.end}.csv`);
      const cfacOutputFile = join(options.output, `cfac_forecast_${options.start}_${options.end}.csv`);

      // ==================== PART 1: DEMAND FORECAST ====================
      console.log('╔══════════════════════════════════════════════════════════════╗');
      console.log('║                    PART 1: DEMAND FORECAST                   ║');
      console.log('╚══════════════════════════════════════════════════════════════╝\n');

      // Parse demand data
      console.log('🔄 Loading demand data...');
      const demandData = parseDemandCsv(options.demand);
      if (demandData.filesProcessed && demandData.filesProcessed > 1) {
        console.log(`  📊 Demand: ${demandData.records.length} records from ${demandData.filesProcessed} files`);
      } else {
        console.log(`  📊 Demand: ${demandData.records.length} records`);
      }
      console.log(`  📅 Range: ${DateTime.fromJSDate(demandData.startDate).toISODate()} to ${DateTime.fromJSDate(demandData.endDate).toISODate()}`);

      // Determine training date range
      const trainStart = DateTime.fromJSDate(demandData.startDate).toISODate()!;
      const trainEnd = DateTime.fromJSDate(demandData.endDate).toISODate()!;

      // Fetch weather data for training period
      console.log('\n🌤️  Fetching weather data for training...');
      const trainWeatherFiles = await weatherService.saveWeatherFiles(
        trainStart,
        trainEnd,
        join(options.cache, 'combined'),
        (msg) => console.log(`  ${msg}`)
      );

      if (trainWeatherFiles.length === 0) {
        console.error('❌ Failed to fetch weather data for training');
        process.exit(1);
      }

      // Parse weather data and merge
      const weatherDatasets = trainWeatherFiles.map(file => parseWeatherCsv(file));
      console.log('\n🔧 Engineering features...');
      const merged = mergeData(demandData, weatherDatasets);
      const samples = buildTrainingSamples(merged.records, false);
      console.log(`  📐 Training samples: ${samples.length}`);

      if (samples.length === 0) {
        console.error('❌ No training samples available');
        process.exit(1);
      }

      // Train demand model
      console.log(`\n🎯 Training ${options.model} model...`);
      let model: RegressionModel | XGBoostModel | HybridModel;
      if (options.model === 'regression') {
        model = new RegressionModel();
        const result = (model as RegressionModel).train(samples);
        console.log(`  R² = ${result.r2Score.toFixed(4)}, MAPE = ${result.mape.toFixed(2)}%`);
      } else if (options.model === 'hybrid') {
        model = new HybridModel({ growthFactor: 0, recentDaysCount: 7 });
        const result = await (model as HybridModel).train(samples);
        console.log(`  R² = ${result.r2Score.toFixed(4)}, MAPE = ${result.mape.toFixed(2)}%`);
      } else {
        model = new XGBoostModel();
        const result = await (model as XGBoostModel).train(samples);
        console.log(`  R² = ${result.r2Score.toFixed(4)}, MAPE = ${result.mape.toFixed(2)}%`);
      }

      // Fetch weather for forecast period
      console.log('\n🌤️  Fetching weather data for forecast period...');
      const forecastWeatherFiles = await weatherService.saveWeatherFiles(
        options.start,
        options.end,
        join(options.cache, 'combined'),
        (msg) => console.log(`  ${msg}`)
      );

      // Parse forecast weather and prepare historical data for lags
      const forecastWeatherDatasets = forecastWeatherFiles.map(file => parseWeatherCsv(file));
      const forecastMerged = mergeData(demandData, forecastWeatherDatasets);

      // Last known values per region
      const lastKnownValues: Map<string, { demand: number; datetime: Date }> = new Map();
      for (const record of demandData.records) {
        const existing = lastKnownValues.get(record.region);
        if (!existing || record.datetime > existing.datetime) {
          lastKnownValues.set(record.region, { demand: record.demand, datetime: record.datetime });
        }
      }

      console.log(`  📊 Historical data loaded: ${demandData.records.length} demand records, ${forecastMerged.records.length} temp records`);
      for (const [region, val] of lastKnownValues) {
        console.log(`  📌 Last known ${region}: ${val.demand} MW at ${DateTime.fromJSDate(val.datetime).toISO()}`);
      }

      // Generate demand forecasts
      console.log('\n🔮 Generating demand forecasts...');
      const forecastStart = DateTime.fromISO(options.start);
      const forecastEnd = DateTime.fromISO(options.end);
      const demandForecasts: ForecastResult[] = [];

      // Create a map of weather data by datetime and region
      const weatherMap: Map<string, Map<string, RawWeatherData>> = new Map();
      for (const dataset of forecastWeatherDatasets) {
        const regionMapping = REGION_MAPPINGS[dataset.city.toLowerCase()];
        const region = regionMapping ? regionMapping.demandColumn : 'CLUZ';
        for (const record of dataset.records) {
          const dt = DateTime.fromISO(record.datetime);
          const key = dt.plus({ hours: 1 }).toISO()!;
          if (!weatherMap.has(key)) {
            weatherMap.set(key, new Map());
          }
          weatherMap.get(key)!.set(region, record);
        }
      }

      // Build predictions for each hour
      let currentHour = forecastStart;
      const regions = demandData.regions;

      while (currentHour <= forecastEnd) {
        const weatherKey = currentHour.toISO()!;
        const regionWeather = weatherMap.get(weatherKey);

        if (regionWeather) {
          for (const region of regions) {
            const weather = regionWeather.get(region);
            if (weather) {
              const lastVal = lastKnownValues.get(region);
              const demandLag24h = lastVal?.demand || 10000;

              // Build a mock record for buildFeatureVector
              const mockRecord = {
                datetime: currentHour.toJSDate(),
                region,
                demand: 0,
                weather
              };
              const lagData = {
                demandLag1h: demandLag24h,
                demandLag24h: demandLag24h,
                demandLag168h: demandLag24h,
                tempLag1h: weather.temp,
                tempLag24h: weather.temp,
                demandRolling24h: demandLag24h,
                tempRolling24h: weather.temp,
                tempMax24h: weather.temp
              };
              const featureVector = buildFeatureVector(mockRecord, lagData);

              let predicted: number;
              if (options.model === 'xgboost') {
                predicted = await (model as XGBoostModel).predict(featureVector);
              } else if (options.model === 'hybrid') {
                predicted = (model as HybridModel).predict(featureVector, region) ?? 0;
              } else {
                predicted = (model as RegressionModel).predict(featureVector);
              }

              demandForecasts.push({
                datetime: currentHour.toJSDate(),
                region,
                predictedDemand: predicted
              });
            }
          }
        }

        currentHour = currentHour.plus({ hours: 1 });
      }

      // Write demand forecast
      writeForecastCsv(demandForecasts, demandOutputFile);
      console.log(`\n✅ Demand forecast written to: ${demandOutputFile}`);
      console.log(`   📊 ${demandForecasts.length} predictions across ${regions.length} regions`);

      // ==================== PART 2: CAPACITY FACTOR FORECAST ====================
      console.log('\n╔══════════════════════════════════════════════════════════════╗');
      console.log('║               PART 2: CAPACITY FACTOR FORECAST               ║');
      console.log('╚══════════════════════════════════════════════════════════════╝\n');

      // Load station metadata
      console.log('🔄 Loading station metadata...');
      await capacityFactorService.loadStations(options.stations);
      const stations = capacityFactorService.getAllStations();
      const clusters = capacityFactorService.getClusters();
      console.log(`   Loaded ${stations.size} stations`);
      console.log(`   Loaded ${clusters.length} weather clusters`);

      // Parse capacity factor training data
      console.log('\n🔄 Parsing capacity factor training data...');
      const cfacData = await capacityFactorService.parseCapacityFactorDirectory(
        options.cfac,
        (msg) => console.log(`   ${msg}`)
      );

      const trainingStations = capacityFactorService.getStationCodes(cfacData);
      console.log(`   Found ${trainingStations.length} stations in training data`);

      // Categorize stations by type
      const stationsByType = new Map<StationType, string[]>();
      for (const stationType of Object.values(StationType)) {
        stationsByType.set(stationType as StationType, []);
      }
      for (const code of trainingStations) {
        const type = getStationTypeFromCode(code);
        stationsByType.get(type)!.push(code);
      }

      console.log('\n📋 Station types in training data:');
      for (const [type, codes] of stationsByType) {
        if (codes.length > 0) {
          console.log(`   ${type}: ${codes.length} stations`);
        }
      }

      // Identify wind clusters
      const windStations = stationsByType.get(StationType.WIND) || [];
      const windClusterIds = new Set<string>();
      for (const stationCode of windStations) {
        const clusterId = capacityFactorService.getClusterForStation(stationCode);
        if (clusterId) {
          windClusterIds.add(clusterId);
        }
      }
      if (windClusterIds.size > 0) {
        console.log(`\n🌬️  Identified ${windClusterIds.size} wind clusters for 100m hub-height data`);
      }

      // Get cfac training date range
      const sortedCfac = [...cfacData].sort((a, b) => a.datetime.getTime() - b.datetime.getTime());
      const cfacTrainStart = DateTime.fromJSDate(sortedCfac[0].datetime).toISODate()!;
      const cfacTrainEnd = DateTime.fromJSDate(sortedCfac[sortedCfac.length - 1].datetime).toISODate()!;
      console.log(`\n📅 Training data range: ${cfacTrainStart} to ${cfacTrainEnd}`);

      // Fetch cluster weather for training
      console.log('\n🌤️  Fetching cluster weather data for training period...');
      const clusterWeatherCsv = await weatherService.fetchAllClusters(
        clusters,
        cfacTrainStart,
        cfacTrainEnd,
        (msg) => console.log(`   ${msg}`),
        windClusterIds
      );
      console.log(`   Fetched weather data for ${clusterWeatherCsv.size} clusters`);

      // Helper to parse CSV line
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

      // Parse cluster weather data
      const clusterWeatherData = new Map<string, Map<string, CFacWeatherFeatures>>();
      for (const [clusterId, csvData] of clusterWeatherCsv) {
        const datetimeMap = new Map<string, CFacWeatherFeatures>();
        const lines = csvData.split('\n').filter(l => l.trim());
        if (lines.length < 2) continue;

        const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
        const colIdx = (name: string) => headers.indexOf(name);

        for (let i = 1; i < lines.length; i++) {
          const values = parseCSVLine(lines[i]);
          const datetimeStr = values[colIdx('datetime')];
          if (!datetimeStr) continue;

          const dt = DateTime.fromISO(datetimeStr);
          if (!dt.isValid) continue;

          const key = dt.plus({ hours: 1 }).toFormat('yyyy-MM-dd HH:mm');

          const weatherFeatures: CFacWeatherFeatures = {
            windSpeed: parseFloat(values[colIdx('windspeed')]) || 0,
            windGust: parseFloat(values[colIdx('windgust')]) || 0,
            solarRadiation: parseFloat(values[colIdx('solarradiation')]) || 0,
            cloudCover: parseFloat(values[colIdx('cloudcover')]) || 0,
            temperature: parseFloat(values[colIdx('temp')]) || 0,
            precipitation: parseFloat(values[colIdx('precip')]) || 0
          };

          const windSpeed100Idx = colIdx('windspeed100');
          const windDir100Idx = colIdx('winddir100');
          if (windSpeed100Idx >= 0 && values[windSpeed100Idx]) {
            weatherFeatures.windSpeed100 = parseFloat(values[windSpeed100Idx]) || undefined;
          }
          if (windDir100Idx >= 0 && values[windDir100Idx]) {
            weatherFeatures.windDirection100 = parseFloat(values[windDir100Idx]) || undefined;
          }

          datetimeMap.set(key, weatherFeatures);
        }
        clusterWeatherData.set(clusterId, datetimeMap);
      }

      // Build training weather map
      const cfacWeatherMap = new Map<string, CFacWeatherFeatures>();
      const trainDatetimes = new Set<string>();
      for (const record of cfacData) {
        const dt = DateTime.fromJSDate(record.datetime);
        trainDatetimes.add(dt.toFormat('yyyy-MM-dd HH:mm'));
      }

      for (const datetimeKey of trainDatetimes) {
        let sumTemp = 0, sumWind = 0, sumGust = 0, sumSolar = 0, sumCloud = 0, sumPrecip = 0;
        let count = 0;

        for (const [, datetimeMapInner] of clusterWeatherData) {
          const weather = datetimeMapInner.get(datetimeKey);
          if (weather) {
            sumTemp += weather.temperature;
            sumWind += weather.windSpeed;
            sumGust += weather.windGust;
            sumSolar += weather.solarRadiation;
            sumCloud += weather.cloudCover;
            sumPrecip += weather.precipitation || 0;
            count++;
          }
        }

        if (count > 0) {
          cfacWeatherMap.set(datetimeKey, {
            windSpeed: sumWind / count,
            windGust: sumGust / count,
            solarRadiation: sumSolar / count,
            cloudCover: sumCloud / count,
            temperature: sumTemp / count,
            precipitation: sumPrecip / count
          });
        }
      }
      console.log(`   Built weather map with ${cfacWeatherMap.size} hourly records from ${clusterWeatherData.size} clusters`);

      // Build training samples
      console.log('\n🔧 Building training samples...');
      const cfacTrainingSamples = await capacityFactorService.buildTrainingSamples(
        cfacData,
        cfacWeatherMap,
        (msg) => console.log(`   ${msg}`)
      );

      // Train capacity factor models
      console.log('\n🎯 Training capacity factor models...');
      const modelRouter = new ModelRouter();
      await modelRouter.trainAllModels(cfacTrainingSamples, (msg) => console.log(`   ${msg}`));

      const metrics = modelRouter.getMetrics();
      console.log(`\n📈 Training Summary: ${modelRouter.getModelCount()} models trained`);

      // Fetch forecast cluster weather
      console.log('\n🌤️  Fetching cluster weather data for forecast period...');
      const forecastClusterWeatherCsv = await weatherService.fetchAllClusters(
        clusters,
        options.start,
        options.end,
        (msg) => console.log(`   ${msg}`),
        windClusterIds
      );

      // Parse forecast cluster weather
      const forecastClusterWeatherData = new Map<string, Map<string, CFacWeatherFeatures>>();
      const cfacForecastDatetimes: Date[] = [];

      for (const [clusterId, csvData] of forecastClusterWeatherCsv) {
        const datetimeMap = new Map<string, CFacWeatherFeatures>();
        const lines = csvData.split('\n').filter(l => l.trim());
        if (lines.length < 2) continue;

        const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
        const colIdx = (name: string) => headers.indexOf(name);

        for (let i = 1; i < lines.length; i++) {
          const values = parseCSVLine(lines[i]);
          const datetimeStr = values[colIdx('datetime')];
          if (!datetimeStr) continue;

          const dt = DateTime.fromISO(datetimeStr).plus({ hours: 1 });
          if (!dt.isValid) continue;

          const key = dt.toFormat('yyyy-MM-dd HH:mm');
          const datetime = dt.toJSDate();

          const weatherFeatures: CFacWeatherFeatures = {
            windSpeed: parseFloat(values[colIdx('windspeed')]) || 0,
            windGust: parseFloat(values[colIdx('windgust')]) || 0,
            solarRadiation: parseFloat(values[colIdx('solarradiation')]) || 0,
            cloudCover: parseFloat(values[colIdx('cloudcover')]) || 0,
            temperature: parseFloat(values[colIdx('temp')]) || 0,
            precipitation: parseFloat(values[colIdx('precip')]) || 0
          };

          const windSpeed100Idx = colIdx('windspeed100');
          const windDir100Idx = colIdx('winddir100');
          if (windSpeed100Idx >= 0 && values[windSpeed100Idx]) {
            weatherFeatures.windSpeed100 = parseFloat(values[windSpeed100Idx]) || undefined;
          }
          if (windDir100Idx >= 0 && values[windDir100Idx]) {
            weatherFeatures.windDirection100 = parseFloat(values[windDir100Idx]) || undefined;
          }

          datetimeMap.set(key, weatherFeatures);
          cfacForecastDatetimes.push(datetime);
        }
        forecastClusterWeatherData.set(clusterId, datetimeMap);
      }

      const uniqueCfacDatetimes = [...new Set(cfacForecastDatetimes.map(d => d.getTime()))]
        .sort((a, b) => a - b)
        .map(ts => new Date(ts));
      console.log(`   Forecast period: ${uniqueCfacDatetimes.length} hours across ${forecastClusterWeatherData.size} clusters`);

      // Generate capacity factor forecasts
      console.log('\n🔮 Generating capacity factor forecasts...');
      const cfacForecasts: CFacForecastResult[] = [];

      for (const datetime of uniqueCfacDatetimes) {
        const dt = DateTime.fromJSDate(datetime);
        const weatherKey = dt.toFormat('yyyy-MM-dd HH:mm');

        const stationWeather = new Map<string, CFacWeatherFeatures>();
        for (const code of trainingStations) {
          const clusterId = capacityFactorService.getClusterForStation(code);
          if (clusterId) {
            const clusterData = forecastClusterWeatherData.get(clusterId);
            if (clusterData) {
              const weather = clusterData.get(weatherKey);
              if (weather) {
                stationWeather.set(code, weather);
              }
            }
          }

          if (!stationWeather.has(code)) {
            let sumTemp = 0, sumWind = 0, sumGust = 0, sumSolar = 0, sumCloud = 0, count = 0;
            for (const [, clusterData] of forecastClusterWeatherData) {
              const weather = clusterData.get(weatherKey);
              if (weather) {
                sumTemp += weather.temperature;
                sumWind += weather.windSpeed;
                sumGust += weather.windGust;
                sumSolar += weather.solarRadiation;
                sumCloud += weather.cloudCover;
                count++;
              }
            }
            if (count > 0) {
              stationWeather.set(code, {
                windSpeed: sumWind / count,
                windGust: sumGust / count,
                solarRadiation: sumSolar / count,
                cloudCover: sumCloud / count,
                temperature: sumTemp / count
              });
            }
          }
        }

        if (stationWeather.size === 0) continue;

        const predictions = modelRouter.predictAll(trainingStations, stationWeather, datetime);
        cfacForecasts.push(...predictions);
      }

      console.log(`   Generated ${cfacForecasts.length} predictions`);

      // Write capacity factor forecast
      await capacityFactorService.writeForecastCSV(
        cfacForecasts,
        cfacOutputFile,
        trainingStations,
        (msg) => console.log(`   ${msg}`)
      );

      console.log(`\n✅ Capacity factor forecast written to: ${cfacOutputFile}`);
      console.log(`   📊 ${cfacForecasts.length} predictions for ${trainingStations.length} stations`);

      // ==================== SUMMARY ====================
      console.log('\n╔══════════════════════════════════════════════════════════════╗');
      console.log('║                         SUMMARY                              ║');
      console.log('╚══════════════════════════════════════════════════════════════╝\n');
      console.log(`📅 Forecast Period: ${options.start} to ${options.end}`);
      console.log(`📁 Output Directory: ${options.output}`);
      console.log('');
      console.log('📈 Generated Files:');
      console.log(`   • Demand Forecast:  ${demandOutputFile}`);
      console.log(`     - ${demandForecasts.length} predictions across ${regions.length} regions`);
      console.log(`   • Capacity Factor:  ${cfacOutputFile}`);
      console.log(`     - ${cfacForecasts.length} predictions for ${trainingStations.length} stations`);
      console.log('');
      console.log('✅ Combined forecast complete!');

    } catch (error: any) {
      console.error(`\n❌ Error: ${error.message}`);
      process.exit(1);
    }
  });

// OUTAGE command - Analyze outage events and calculate probabilities
const outageCmd = program.command('outage').description('Outage event analysis and probability forecasting');

outageCmd
  .command('analyze')
  .description('Analyze outage events and generate probability statistics')
  .requiredOption('-d, --data <path>', 'Path to outage data directory (Ev_*.csv, HistDBErr_*.csv, and WAPOS/*.csv files)')
  .option('-o, --output <file>', 'Output JSON file for analysis report')
  .option('--predict-days <days>', 'Number of days to predict ahead', '7')
  .option('--no-wapos', 'Exclude WAPOS planned outages from analysis')
  .option('--save-db', 'Save analysis results to database')
  .action(async (options) => {
    try {
      console.log('\n📊 Outage Analysis');
      console.log('═══════════════════════════════════════════════════════════════\n');

      // Parse outage data
      console.log('🔄 Loading outage data...');
      const data = parseOutageDirectory(
        options.data,
        (msg) => console.log(`   ${msg}`),
        { includeWAPOS: options.wapos !== false }
      );

      if (data.records.length === 0) {
        console.error('❌ No outage records found');
        process.exit(1);
      }

      // Generate analysis report
      console.log('\n📈 Analyzing outage patterns...');
      const report = generateAnalysisReport(data, (msg) => console.log(`   ${msg}`));

      // Display summary
      console.log('\n╔══════════════════════════════════════════════════════════════╗');
      console.log('║                       ANALYSIS SUMMARY                       ║');
      console.log('╚══════════════════════════════════════════════════════════════╝\n');

      console.log('📅 Data Period:');
      console.log(`   ${DateTime.fromJSDate(report.dataRange.start).toISODate()} to ${DateTime.fromJSDate(report.dataRange.end).toISODate()}`);
      console.log(`   (${Math.round((report.dataRange.end.getTime() - report.dataRange.start.getTime()) / (1000 * 60 * 60 * 24))} days)\n`);

      console.log('📊 Overall Statistics:');
      console.log(`   • Total Outages:           ${report.summary.totalOutages}`);
      console.log(`     ├─ Planned (WAPOS):      ${data.totalPlannedOutages}`);
      console.log(`     └─ Unplanned (Forced):   ${data.totalUnplannedOutages}`);
      console.log(`   • Total Capacity Lost:     ${report.summary.totalCapacityLostMWh.toFixed(0)} MWh`);
      console.log(`   • Average Outages/Day:     ${report.summary.averageOutagesPerDay.toFixed(2)}`);
      console.log(`   • Most Affected Region:    ${report.summary.mostAffectedRegion}`);
      console.log(`   • Most Affected Fuel:      ${report.summary.mostAffectedFuelType}`);
      console.log(`   • Peak Outage Hour:        ${report.summary.peakOutageHour}:00\n`);

      // Region breakdown
      console.log('🗺️  Regional Breakdown:');
      console.log('┌──────────┬──────────┬──────────┬──────────────┬────────────────┬──────────────┐');
      console.log('│  Region  │ Planned  │Unplanned │ Outages/Day  │ Avg Cap Lost   │ Peak Hour    │');
      console.log('├──────────┼──────────┼──────────┼──────────────┼────────────────┼──────────────┤');
      for (const region of ['CLUZ', 'CVIS', 'CMIN'] as GridRegion[]) {
        const stats = report.regionStats[region];
        console.log(`│ ${region.padEnd(8)} │ ${String(stats.plannedOutages).padStart(8)} │${String(stats.unplannedOutages).padStart(9)} │ ${stats.averageUnplannedOutagesPerDay.toFixed(2).padStart(12)} │ ${stats.averageCapacityLostMW.toFixed(0).padStart(10)} MW │ ${String(stats.peakOutageHour).padStart(5)}:00     │`);
      }
      console.log('└──────────┴──────────┴──────────┴──────────────┴────────────────┴──────────────┘\n');

      // Severity distribution
      console.log('⚠️  Severity Distribution:');
      const sevTotal = report.summary.totalOutages;
      for (const severity of [OutageSeverity.MINOR, OutageSeverity.MODERATE, OutageSeverity.MAJOR, OutageSeverity.CRITICAL]) {
        const count = Object.values(report.regionStats).reduce((sum, r) => sum + r.outagesBySeverity[severity], 0);
        const pct = ((count / sevTotal) * 100).toFixed(1);
        const bar = '█'.repeat(Math.round(count / sevTotal * 30));
        console.log(`   ${severity.padEnd(10)} ${bar.padEnd(30)} ${pct}% (${count})`);
      }

      // Time period distribution
      console.log('\n🕐 Time Period Distribution:');
      for (const period of [TimePeriod.MORNING, TimePeriod.AFTERNOON, TimePeriod.EVENING, TimePeriod.NIGHT]) {
        const count = Object.values(report.regionStats).reduce((sum, r) => sum + r.outagesByTimePeriod[period], 0);
        const pct = ((count / sevTotal) * 100).toFixed(1);
        const bar = '█'.repeat(Math.round(count / sevTotal * 30));
        const timeRange = period === TimePeriod.MORNING ? '06:00-12:00' :
                         period === TimePeriod.AFTERNOON ? '12:00-18:00' :
                         period === TimePeriod.EVENING ? '18:00-24:00' : '00:00-06:00';
        console.log(`   ${period.padEnd(10)} (${timeRange}) ${bar.padEnd(20)} ${pct}%`);
      }

      // Top 10 problematic units
      console.log('\n🔧 Top 10 Most Problematic Units:');
      console.log('┌────────────────────┬──────────┬──────────┬──────────────┬──────────────┐');
      console.log('│ Unit ID            │ Region   │ Fuel     │ Outage Rate  │ Availability │');
      console.log('├────────────────────┼──────────┼──────────┼──────────────┼──────────────┤');
      for (const unit of report.unitStats.slice(0, 10)) {
        console.log(`│ ${unit.unitId.padEnd(18)} │ ${unit.region.padEnd(8)} │ ${unit.fuelType.padEnd(8)} │ ${unit.outageRate.toFixed(2).padStart(8)}/mo  │ ${(unit.availabilityRate * 100).toFixed(1).padStart(8)}%    │`);
      }
      console.log('└────────────────────┴──────────┴──────────┴──────────────┴──────────────┘\n');

      // Probability model summary
      console.log('📈 Probability Model:');
      console.log('   Base Outage Probability per Day:');
      for (const region of ['CLUZ', 'CVIS', 'CMIN'] as GridRegion[]) {
        const prob = report.probabilityModel.regionBaseProbability[region];
        console.log(`     ${region}: ${formatProbability(prob)} (${(prob * 30).toFixed(1)} outages/month)`);
      }

      console.log('\n   Day of Week Risk Multipliers:');
      const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      let dowLine = '     ';
      for (let i = 0; i < 7; i++) {
        const mult = report.probabilityModel.dayOfWeekMultiplier[i];
        dowLine += `${days[i]}: ${mult.toFixed(2)}x  `;
      }
      console.log(dowLine);

      console.log('\n   Time Period Risk Multipliers:');
      for (const period of [TimePeriod.MORNING, TimePeriod.AFTERNOON, TimePeriod.EVENING, TimePeriod.NIGHT]) {
        const mult = report.probabilityModel.timePeriodMultiplier[period];
        console.log(`     ${period.padEnd(10)}: ${mult.toFixed(2)}x`);
      }

      // Predictions
      if (report.predictions.length > 0) {
        console.log('\n╔══════════════════════════════════════════════════════════════╗');
        console.log('║                    7-DAY OUTAGE FORECAST                     ║');
        console.log('╚══════════════════════════════════════════════════════════════╝\n');

        // Group predictions by date
        const predByDate = new Map<string, typeof report.predictions>();
        for (const pred of report.predictions) {
          const dateKey = DateTime.fromJSDate(pred.datetime).toISODate()!;
          if (!predByDate.has(dateKey)) {
            predByDate.set(dateKey, []);
          }
          predByDate.get(dateKey)!.push(pred);
        }

        console.log('┌────────────┬──────────┬──────────────┬─────────────────┬──────────────┐');
        console.log('│ Date       │ Region   │ Probability  │ Expected Loss   │ Risk Level   │');
        console.log('├────────────┼──────────┼──────────────┼─────────────────┼──────────────┤');

        for (const [date, preds] of predByDate) {
          for (const pred of preds) {
            const color = getRiskColor(pred.riskLevel);
            const reset = '\x1b[0m';
            console.log(`│ ${date} │ ${pred.region.padEnd(8)} │ ${formatProbability(pred.probabilityOfOutage).padStart(12)} │ ${pred.expectedCapacityLossMW.toFixed(0).padStart(10)} MW   │ ${color}${pred.riskLevel.padEnd(12)}${reset} │`);
          }
        }
        console.log('└────────────┴──────────┴──────────────┴─────────────────┴──────────────┘');
      }

      // Save report to file if requested
      if (options.output) {
        const outputPath = options.output;
        writeFileSync(outputPath, JSON.stringify(report, null, 2));
        console.log(`\n💾 Full report saved to: ${outputPath}`);
      }

      // Save to database if requested
      if (options.saveDb) {
        console.log('\n💾 Saving to database...');
        const { saveOutageDataToDatabase } = await import('./services/outageAnalysisService.js');
        const { recordsImported, modelId } = saveOutageDataToDatabase(
          data,
          report.probabilityModel,
          (msg) => console.log(`   ${msg}`)
        );
        console.log(`   ✅ Saved ${recordsImported} records, model ID: ${modelId}`);
      }

      console.log('\n✅ Outage analysis complete!');

    } catch (error: any) {
      console.error(`\n❌ Error: ${error.message}`);
      process.exit(1);
    }
  });

outageCmd
  .command('summary')
  .description('Quick summary of outage statistics')
  .requiredOption('-d, --data <path>', 'Path to outage data directory')
  .option('--no-wapos', 'Exclude WAPOS planned outages')
  .action(async (options) => {
    try {
      console.log('\n📊 Quick Outage Summary\n');

      const data = parseOutageDirectory(options.data, undefined, { includeWAPOS: options.wapos !== false });

      console.log(`Total Outage Events: ${data.totalEvents}`);
      console.log(`  Planned (WAPOS):   ${data.totalPlannedOutages}`);
      console.log(`  Unplanned:         ${data.totalUnplannedOutages}`);
      console.log(`Unique Units Affected: ${data.uniqueUnits}`);
      console.log(`Date Range: ${DateTime.fromJSDate(data.dateRange.start).toISODate()} to ${DateTime.fromJSDate(data.dateRange.end).toISODate()}`);

      // Count by region
      const byRegion: Record<string, { planned: number; unplanned: number }> = {
        CLUZ: { planned: 0, unplanned: 0 },
        CVIS: { planned: 0, unplanned: 0 },
        CMIN: { planned: 0, unplanned: 0 }
      };
      for (const record of data.records) {
        if (record.outageType === 'planned') {
          byRegion[record.region].planned++;
        } else {
          byRegion[record.region].unplanned++;
        }
      }

      console.log('\nOutages by Region:');
      for (const [region, counts] of Object.entries(byRegion)) {
        const total = counts.planned + counts.unplanned;
        console.log(`  ${region}: ${total} (${counts.planned} planned, ${counts.unplanned} unplanned)`);
      }

      // Count by severity
      const bySeverity: Record<string, number> = {};
      for (const record of data.records) {
        bySeverity[record.severity] = (bySeverity[record.severity] || 0) + 1;
      }

      console.log('\nOutages by Severity:');
      for (const [severity, count] of Object.entries(bySeverity)) {
        console.log(`  ${severity}: ${count}`);
      }

    } catch (error: any) {
      console.error(`\n❌ Error: ${error.message}`);
      process.exit(1);
    }
  });

outageCmd
  .command('weather-forecast')
  .description('Generate weather-adjusted outage probability forecast')
  .option('-s, --start <date>', 'Start date for forecast (YYYY-MM-DD)', DateTime.now().toISODate()!)
  .option('-d, --days <number>', 'Number of days to forecast', '7')
  .option('--precip <mm>', 'Manual precipitation override (mm) for all regions')
  .option('--wind <kmh>', 'Manual wind speed override (km/h) for all regions')
  .option('-k, --api-key <key>', 'Visual Crossing API key (or set VISUAL_CROSSING_API_KEY env)')
  .option('-c, --cache <path>', 'Weather cache directory', './data/weather_cache')
  .action(async (options) => {
    try {
      const {
        generateWeatherAdjustedForecast,
        formatWeatherForecastReport,
        getPrecipitationMultiplier,
        getWindSpeedMultiplier,
        DEFAULT_WEATHER_MULTIPLIERS
      } = await import('./services/outageAnalysisService.js');

      console.log('\n🌧️  Weather-Adjusted Outage Probability Forecast');
      console.log('═══════════════════════════════════════════════════════════════\n');

      // If manual values provided, show quick calculation
      if (options.precip !== undefined || options.wind !== undefined) {
        const precipMm = parseFloat(options.precip) || 0;
        const windKmh = parseFloat(options.wind) || 0;

        console.log('Manual Weather Input Mode:');
        console.log(`  Precipitation: ${precipMm} mm`);
        console.log(`  Wind Speed: ${windKmh} km/h\n`);

        console.log('Risk Multipliers by Region:');
        console.log('┌────────┬─────────────────┬─────────────────┬─────────────────┐');
        console.log('│ Region │ Precip Mult     │ Wind Mult       │ Combined        │');
        console.log('├────────┼─────────────────┼─────────────────┼─────────────────┤');

        for (const region of ['CLUZ', 'CVIS', 'CMIN'] as GridRegion[]) {
          const precipResult = getPrecipitationMultiplier(precipMm, region);
          const windResult = getWindSpeedMultiplier(windKmh);
          const combined = Math.max(precipResult.multiplier, windResult.multiplier);

          console.log(`│ ${region}   │ ${precipResult.multiplier.toFixed(2)}x (${precipResult.label.padEnd(8)}) │ ${windResult.multiplier.toFixed(2)}x (${windResult.label.padEnd(8)}) │ ${combined.toFixed(2)}x             │`);
        }
        console.log('└────────┴─────────────────┴─────────────────┴─────────────────┘\n');

        console.log('Weather Risk Thresholds (from ML analysis):');
        console.log('\nPrecipitation:');
        for (const t of DEFAULT_WEATHER_MULTIPLIERS.precipitationThresholds) {
          console.log(`  >= ${t.minPrecipMm.toString().padStart(3)} mm: ${t.multiplier.toFixed(2)}x (${t.label})`);
        }
        console.log('\nWind Speed:');
        for (const t of DEFAULT_WEATHER_MULTIPLIERS.windSpeedThresholds) {
          console.log(`  >= ${t.minWindKmh.toString().padStart(3)} km/h: ${t.multiplier.toFixed(2)}x (${t.label})`);
        }
        return;
      }

      // Generate forecast from database weather data
      const startDate = options.start;
      const days = parseInt(options.days) || 7;
      const endDate = DateTime.fromISO(startDate).plus({ days: days - 1 }).toISODate()!;

      console.log(`Forecast Period: ${startDate} to ${endDate}`);

      // Auto-fetch missing weather data for all regions
      const apiKey = getApiKey();
      const weatherService = createWeatherService(apiKey, options.cache);

      console.log('\n🌤️  Fetching weather data for all regions...\n');

      for (const location of DEFAULT_LOCATIONS) {
        try {
          await weatherService.fetchWeatherData(
            location,
            startDate,
            endDate,
            (msg) => console.log(`  ${msg}`)
          );
        } catch (error: any) {
          console.log(`  ⚠️  Could not fetch weather for ${location.name}: ${error.message}`);
        }
      }

      console.log('\n📊 Generating outage probability forecast...\n');

      const forecasts = generateWeatherAdjustedForecast(
        startDate,
        days,
        (msg) => console.log(`  ${msg}`)
      );

      if (forecasts.length === 0) {
        console.log('\n⚠️  No weather data available for the specified period.');
        console.log('   Check your API key or use manual mode: iload outage weather-forecast --precip 50 --wind 40');
        return;
      }

      console.log('\n' + formatWeatherForecastReport(forecasts));

    } catch (error: any) {
      console.error(`\n❌ Error: ${error.message}`);
      process.exit(1);
    }
  });

outageCmd
  .command('duration-stats')
  .description('Show outage duration statistics by severity and region')
  .option('-d, --data <path>', 'Path to outage data directory (optional, uses database if not provided)')
  .option('--no-wapos', 'Exclude WAPOS planned outages')
  .action(async (options) => {
    try {
      const { loadOutageDataFromDatabase } = await import('./services/outageAnalysisService.js');

      console.log('\n📊 Outage Duration Statistics by Severity and Region');
      console.log('═══════════════════════════════════════════════════════════════\n');

      let records: OutageRecord[];

      if (options.data) {
        const data = parseOutageDirectory(options.data, undefined, { includeWAPOS: options.wapos !== false });
        records = data.records;
        console.log(`Loaded ${records.length} records from files\n`);
      } else {
        const data = loadOutageDataFromDatabase();
        records = data.records;
        console.log(`Loaded ${records.length} records from database\n`);
      }

      if (records.length === 0) {
        console.log('No outage records found.');
        return;
      }

      // Calculate statistics by region and severity
      const stats: Record<string, Record<string, {
        count: number;
        totalMinutes: number;
        minMinutes: number;
        maxMinutes: number;
        avgCapacityMW: number;
        durations: number[];
      }>> = {};

      const regions: GridRegion[] = ['CLUZ', 'CVIS', 'CMIN'];
      const severities = ['minor', 'moderate', 'major', 'critical'];

      // Initialize
      for (const region of regions) {
        stats[region] = {};
        for (const severity of severities) {
          stats[region][severity] = {
            count: 0,
            totalMinutes: 0,
            minMinutes: Infinity,
            maxMinutes: 0,
            avgCapacityMW: 0,
            durations: []
          };
        }
      }

      // Collect data
      for (const record of records) {
        const s = stats[record.region][record.severity];
        s.count++;
        s.totalMinutes += record.durationMinutes;
        s.minMinutes = Math.min(s.minMinutes, record.durationMinutes);
        s.maxMinutes = Math.max(s.maxMinutes, record.durationMinutes);
        s.avgCapacityMW += record.capacityLostMW;
        s.durations.push(record.durationMinutes);
      }

      // Calculate medians and averages
      const calcMedian = (arr: number[]): number => {
        if (arr.length === 0) return 0;
        const sorted = [...arr].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
      };

      // Print report for each region
      for (const region of regions) {
        console.log(`\n─── ${region} ───────────────────────────────────────────────────────────`);
        console.log('');
        console.log('Severity  │ Count │ Avg Duration │ Median Duration │ Min      │ Max       │ Avg MW Lost');
        console.log('──────────┼───────┼──────────────┼─────────────────┼──────────┼───────────┼────────────');

        for (const severity of severities) {
          const s = stats[region][severity];
          if (s.count === 0) {
            console.log(`${severity.padEnd(9)} │     0 │          N/A │             N/A │      N/A │       N/A │        N/A`);
            continue;
          }

          const avgMin = s.totalMinutes / s.count;
          const medianMin = calcMedian(s.durations);
          const avgCapacity = s.avgCapacityMW / s.count;

          const formatDuration = (mins: number): string => {
            if (mins >= 60) {
              const hours = Math.floor(mins / 60);
              const remaining = Math.round(mins % 60);
              return `${hours}h ${remaining}m`.padStart(10);
            }
            return `${Math.round(mins)}m`.padStart(10);
          };

          console.log(`${severity.padEnd(9)} │ ${s.count.toString().padStart(5)} │ ${formatDuration(avgMin)} │ ${formatDuration(medianMin).padStart(15)} │ ${formatDuration(s.minMinutes)} │ ${formatDuration(s.maxMinutes)} │ ${avgCapacity.toFixed(0).padStart(7)} MW`);
        }
      }

      // Overall summary
      console.log('\n═══════════════════════════════════════════════════════════════');
      console.log('OVERALL SUMMARY');
      console.log('───────────────────────────────────────────────────────────────\n');

      console.log('Severity  │ Total Count │ Avg Duration │ Total Hours │ % of Outages');
      console.log('──────────┼─────────────┼──────────────┼─────────────┼─────────────');

      for (const severity of severities) {
        let totalCount = 0;
        let totalMinutes = 0;
        const allDurations: number[] = [];

        for (const region of regions) {
          const s = stats[region][severity];
          totalCount += s.count;
          totalMinutes += s.totalMinutes;
          allDurations.push(...s.durations);
        }

        if (totalCount === 0) {
          console.log(`${severity.padEnd(9)} │           0 │          N/A │         N/A │        0.0%`);
          continue;
        }

        const avgMin = totalMinutes / totalCount;
        const pct = (totalCount / records.length * 100).toFixed(1);
        const totalHours = (totalMinutes / 60).toFixed(1);

        const formatDuration = (mins: number): string => {
          if (mins >= 60) {
            const hours = Math.floor(mins / 60);
            const remaining = Math.round(mins % 60);
            return `${hours}h ${remaining}m`.padStart(10);
          }
          return `${Math.round(mins)}m`.padStart(10);
        };

        console.log(`${severity.padEnd(9)} │ ${totalCount.toString().padStart(11)} │ ${formatDuration(avgMin)} │ ${totalHours.padStart(11)} │ ${pct.padStart(11)}%`);
      }

      console.log('\n✅ Duration statistics complete!');

    } catch (error: any) {
      console.error(`\n❌ Error: ${error.message}`);
      process.exit(1);
    }
  });

program.parse();
