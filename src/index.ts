#!/usr/bin/env node
import { Command } from 'commander';
import { DateTime } from 'luxon';
import fs, { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { parse } from 'csv-parse/sync';
import { parseDemandCsv, parseWeatherCsv, type ParsedDemandData } from './parsers/index.js';
import { mergeData } from './utils/index.js';
import { buildTrainingSamples, buildFeatureVector } from './features/index.js';
import { RegressionModel } from './models/regressionModel.js';
import { XGBoostModel } from './models/xgboostModel.js';
import { HybridModel } from './models/hybridModel.js';
import { writeForecastCsv, writeModelReport, writeMetricsSummary } from './writers/index.js';
import { REGION_MAPPINGS, isPhilippineHoliday } from './constants/index.js';
import { ForecastResult, TrainingSample, RawWeatherData } from './types/index.js';
import { createWeatherService, DEFAULT_LOCATIONS, capacityFactorService, ClusterLocation } from './services/index.js';
import { getDatabase, closeDatabase, DatabaseStats, StoredModel } from './database/index.js';
import { ModelRouter, WindMRECModel, calibrateAllMREC, calibrateAllMRECCFBased, calibrateAllMRECMLOptimized, WindMRECHybridModel, trainAllMRECHybrid, WindWeatherHybridModel, trainAllWeatherHybrid, SolarMRECModel, calibrateAllSolarMREC, SolarHybridModel, SolarIrradianceModel, SolarMRECHybridModel, calibrateAllSolarMRECHybrid, SolarSeasonalMRECModel, calibrateAllSeasonalSolarMREC, WindShearModel, trainAllWindShear, WindCubicModel, calibrateAllCubic, WindWeibullModel, calibrateAllWeibull, WindBiasCorrectionModel, calibrateAllBiasCorrection, WindEnhancedHybridModel, trainAllEnhancedHybrid, BiasCorrector, Wind4TierHybridModel, trainAll4TierHybrid, WindPhysicsHybridModel, trainAllPhysicsHybrid } from './models/capacityFactor/index.js';
import type { SolarMRECCalibrationData } from './models/capacityFactor/index.js';
import { MRECCalibrationData, WindCFacMethodology } from './types/capacityFactor.js';
import { CFacWeatherFeatures, StationType, getStationTypeFromCode, CFacForecastResult, CFacTrainingSample } from './types/capacityFactor.js';
import { parseOutageDirectory } from './parsers/index.js';
import { generateAnalysisReport, formatProbability, getRiskColor } from './services/outageAnalysisService.js';
import { OutageSeverity, TimePeriod, GridRegion, OutageRecord } from './types/outage.js';
import { parseInterconnectorCsv } from './parsers/interconnectorParser.js';
import { buildInterconnectorTrainingSamples } from './features/interconnectorFeatures.js';
import { InterconnectorCongestionModel } from './models/interconnector/index.js';
import { ForecastSchedulerService } from './services/forecastSchedulerService.js';
import { CapacityUpdateService } from './services/capacityUpdateService.js';

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
  .option('--scale-workday <percent>', 'Scale workday forecasts by percentage (overrides --scale for workdays)')
  .option('--scale-weekend <percent>', 'Scale weekend (Sat/Sun) forecasts by percentage (overrides --scale for weekends)')
  .option('--scale-holiday <percent>', 'Scale holiday forecasts by percentage (highest priority, overrides other scales)')
  .option('--scale-peak <percent>', 'Scale peak hour (09:00-21:00) forecasts by percentage')
  .option('--scale-offpeak <percent>', 'Scale off-peak hour (21:00-09:00) forecasts by percentage')
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
      // Parse scale factors (day-type-specific scales override the general scale)
      const baseScaleFactor = 1 + (parseFloat(options.scale) / 100);
      const scaleWorkday = options.scaleWorkday !== undefined ? 1 + (parseFloat(options.scaleWorkday) / 100) : null;
      const scaleWeekend = options.scaleWeekend !== undefined ? 1 + (parseFloat(options.scaleWeekend) / 100) : null;
      const scaleHoliday = options.scaleHoliday !== undefined ? 1 + (parseFloat(options.scaleHoliday) / 100) : null;
      const scalePeak = options.scalePeak !== undefined ? 1 + (parseFloat(options.scalePeak) / 100) : null;
      const scaleOffpeak = options.scaleOffpeak !== undefined ? 1 + (parseFloat(options.scaleOffpeak) / 100) : null;

      // Peak hours: 09:00-21:00 (hours 9-20 inclusive), Off-peak: 21:00-09:00 (hours 21-23, 0-8)
      const isPeakHour = (hour: number): boolean => hour >= 9 && hour < 21;

      // Helper function to get the appropriate scale factor for a given date/time
      const getScaleFactor = (dateTime: Date): number => {
        const dt = DateTime.fromJSDate(dateTime);
        const dateStr = dt.toFormat('yyyy-MM-dd');
        const dow = dt.weekday; // 1=Mon, 7=Sun
        const hour = dt.hour;

        // Start with base scale
        let dayTypeScale = baseScaleFactor;

        // Day-type priority: holiday > weekend > workday > base
        if (scaleHoliday !== null && isPhilippineHoliday(dateStr)) {
          dayTypeScale = scaleHoliday;
        } else if (scaleWeekend !== null && (dow === 6 || dow === 7)) {
          dayTypeScale = scaleWeekend;
        } else if (scaleWorkday !== null && dow >= 1 && dow <= 5 && !isPhilippineHoliday(dateStr)) {
          dayTypeScale = scaleWorkday;
        }

        // Apply peak/off-peak scaling on top of day-type scaling (multiplicative)
        let peakScale = 1.0;
        if (scalePeak !== null && isPeakHour(hour)) {
          peakScale = scalePeak;
        } else if (scaleOffpeak !== null && !isPeakHour(hour)) {
          peakScale = scaleOffpeak;
        }

        return dayTypeScale * peakScale;
      };

      console.log('\n🔮 Generating forecasts...');
      if (parseFloat(options.scale) !== 0) {
        console.log(`  📈 Base scaling factor: ${baseScaleFactor.toFixed(4)} (${parseFloat(options.scale) > 0 ? '+' : ''}${options.scale}%)`);
      }
      if (scaleWorkday !== null) {
        console.log(`  📈 Workday scaling: ${scaleWorkday.toFixed(4)} (${parseFloat(options.scaleWorkday) > 0 ? '+' : ''}${options.scaleWorkday}%)`);
      }
      if (scaleWeekend !== null) {
        console.log(`  📈 Weekend scaling: ${scaleWeekend.toFixed(4)} (${parseFloat(options.scaleWeekend) > 0 ? '+' : ''}${options.scaleWeekend}%)`);
      }
      if (scaleHoliday !== null) {
        console.log(`  📈 Holiday scaling: ${scaleHoliday.toFixed(4)} (${parseFloat(options.scaleHoliday) > 0 ? '+' : ''}${options.scaleHoliday}%)`);
      }
      if (scalePeak !== null) {
        console.log(`  📈 Peak (09:00-21:00) scaling: ${scalePeak.toFixed(4)} (${parseFloat(options.scalePeak) > 0 ? '+' : ''}${options.scalePeak}%)`);
      }
      if (scaleOffpeak !== null) {
        console.log(`  📈 Off-peak (21:00-09:00) scaling: ${scaleOffpeak.toFixed(4)} (${parseFloat(options.scaleOffpeak) > 0 ? '+' : ''}${options.scaleOffpeak}%)`);
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
            prediction = (hybridPrediction ?? similarDaysDemand ?? lastKnownDemand.get(region)?.value ?? 0) * getScaleFactor(datetime);
          } else {
            // Regression/XGBoost model
            const basePrediction = (model as RegressionModel | XGBoostModel).predict(features);

            // Check if we have actual lag1h data or if it came from similar days
            const hasActualLag1h = demandHistory.has(`${lag1hTs}_${region}`);

            if (hasActualLag1h) {
              // Use model prediction directly when we have real lag data
              prediction = basePrediction * getScaleFactor(datetime);
            } else {
              // When lag1h is estimated (from similar days), blend model prediction with similar days
              // This prevents the cold start death spiral by anchoring to historical patterns
              const blendRatio = 0.5; // 50% model, 50% similar days
              if (similarDaysDemand !== undefined) {
                prediction = (basePrediction * blendRatio + similarDaysDemand * (1 - blendRatio)) * getScaleFactor(datetime);
              } else {
                prediction = basePrediction * getScaleFactor(datetime);
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

// CFAC FORECAST2 - Generate capacity factor forecasts using OPTIMAL models for each type
// Wind: Weather-Only MREC Hybrid (75.8% MAPE)
// Solar: Physics+ML Hybrid (59.6% MAPE)
// Others: Profile-based models
cfacCommand
  .command('forecast2')
  .description('Generate CFac forecast using OPTIMAL models: Wind (Weather-Only MREC Hybrid), Solar (Physics+ML Hybrid)')
  .requiredOption('-t, --training <path>', 'Training data: MRHCFac CSV file or directory')
  .requiredOption('-s, --start <date>', 'Forecast start date (YYYY-MM-DD)')
  .requiredOption('-e, --end <date>', 'Forecast end date (YYYY-MM-DD)')
  .requiredOption('-o, --output <file>', 'Output forecast CSV file')
  .option('--stations <file>', 'Stations JSON file', 'src/data/stations.json')
  .option('--cache <dir>', 'Weather cache directory', './weather_cache')
  .option('--bias-correction', 'Enable station-specific bias correction (learns from training data)')
  .option('--asymmetric-loss', 'Use asymmetric loss function that penalizes under-predictions 2x more')
  .option('--use-xgboost', 'Use XGBoost instead of linear regression for residual models (better non-linear learning)')
  .option('--scale <percent>', 'Scale ALL forecast outputs by percentage (e.g., 5 for +5%, -3 for -3%)', '0')
  .option('--scale-solar <percent>', 'Scale SOLAR forecast outputs by percentage', '0')
  .option('--scale-wind <percent>', 'Scale WIND forecast outputs by percentage', '0')
  .option('--auto-calibrate [days]', 'Auto-calibrate using N days before forecast start (default: 14)', '14')
  .option('--no-auto-calibrate', 'Disable auto-calibration')
  .option('--exclude-outages', 'Exclude outage periods (zeros) from training data per station (default: true)')
  .option('--no-exclude-outages', 'Include all data including outages in training')
  .option('--training-end <date>', 'Training data cutoff date (YYYY-MM-DD) - exclude data after this date')
  .option('--solar-physics-only', 'Use Physics-only model for solar (no ML residual) with learned bias correction')
  .option('--solar-weather-confidence', 'Use weather-confidence weighted ML for solar (reduce ML residual when weather is clear)')
  .option('--solar-mrec', 'Use iPool-style MREC three-tier model for solar (per-station calibration)')
  .option('--solar-mrec-hybrid', 'Use MREC + ML residual hybrid for solar (best of both)')
  .option('--solar-seasonal', 'Use Seasonal MREC for solar (separate calibration for dry/monsoon/transition seasons)')
  .option('--solar-seasonal-adaptive', 'Seasonal adaptive: trains separate dry/wet models, reduces ML weight in dry season (Nov-Apr)')
  .option('--no-wind-4tier', 'Disable 4-tier MREC wind model (use legacy enhanced-hybrid instead)')
  .option('--wind-4tier', 'Use 4-tier MREC for wind - DEFAULT (LOW/RAMP/RATED/HIGH regions, ~50% MAPE)')
  .action(async (options) => {
    try {
      const apiKey = getApiKey();
      const weatherService = createWeatherService(apiKey, options.cache);

      const asymmetricLoss = options.asymmetricLoss || false;
      const useXGBoost = options.useXgboost || false;
      const solarPhysicsOnly = options.solarPhysicsOnly || false;
      const solarWeatherConfidence = options.solarWeatherConfidence || false;
      const solarMrec = options.solarMrec || false;
      const solarMrecHybrid = options.solarMrecHybrid || false;
      const solarSeasonal = options.solarSeasonal || false;
      const solarSeasonalAdaptive = options.solarSeasonalAdaptive || false;
      // 4-Tier wind model is now the default (50% MAPE vs 107% for enhanced-hybrid)
      const wind4Tier = options.noWind4tier !== true && options.no_wind_4tier !== true;

      // Parse scale factors (manual overrides)
      const scaleAll = parseFloat(options.scale) / 100;  // Convert percent to decimal
      const scaleSolar = parseFloat(options.scaleSolar) / 100;
      const scaleWind = parseFloat(options.scaleWind) / 100;

      // Parse auto-calibrate option
      const autoCalibrate = options.autoCalibrate !== false;  // Default true unless --no-auto-calibrate
      const calibrationDays = autoCalibrate ? parseInt(options.autoCalibrate) || 14 : 0;

      // Parse exclude-outages option (default: true)
      const excludeOutages = options.excludeOutages !== false;  // Default true unless --no-exclude-outages

      // Calculate calibration period dates
      const forecastStartDate = DateTime.fromISO(options.start);
      const calibrationEndDate = forecastStartDate.minus({ days: 1 });  // Day before forecast starts
      const calibrationStartDate = calibrationEndDate.minus({ days: calibrationDays - 1 });

      // Initialize scale factors (will be updated by auto-calibration if enabled)
      let effectiveSolarScale = 1 + (scaleSolar !== 0 ? scaleSolar : scaleAll);
      let effectiveWindScale = 1 + (scaleWind !== 0 ? scaleWind : scaleAll);
      let effectiveOtherScale = 1 + scaleAll;
      let calibratedSolarBias = 0;
      let calibratedWindBias = 0;

      // Per-hour solar scale factors (key: hour 0-23, value: scale factor)
      // When auto-calibrate is enabled: initialized to 1.0, will be updated by calibration
      // When auto-calibrate is disabled: use effectiveSolarScale (manual scale) for all hours
      const solarHourlyScale = new Map<number, number>();
      for (let h = 0; h < 24; h++) {
        // Use effectiveSolarScale when manual scaling is active (auto-calibrate disabled)
        // This ensures --scale-solar flag is applied when --no-auto-calibrate is used
        solarHourlyScale.set(h, autoCalibrate ? 1.0 : effectiveSolarScale);
      }

      // Per-station scale factors for WIND stations (enables station-specific calibration)
      // Key: stationCode, Value: scale factor (calculated during auto-calibration)
      const windStationScale = new Map<string, number>();

      // Per-station scale factors for SOLAR stations (enables station-specific calibration)
      // Key: stationCode, Value: scale factor (calculated during auto-calibration)
      const solarStationScale = new Map<string, number>();

      // Per-station scale factors for OTHER stations (hydro, geothermal, etc.)
      // Key: stationCode, Value: scale factor (initialized to 1.0)
      const otherStationScale = new Map<string, number>();

      console.log('\n═══════════════════════════════════════════════════════════════════════════════');
      console.log('          OPTIMAL CAPACITY FACTOR FORECASTING (v2)                              ');
      const windModelName = wind4Tier ? '4-Tier MREC Hybrid (region-specific gustRatio)' : 'Weather-Only MREC Hybrid';
      if (solarSeasonalAdaptive) {
        console.log(`   Wind: ${windModelName} | Solar: SEASONAL ADAPTIVE (dry/wet ML models)`);
      } else if (solarSeasonal) {
        // DEPRECATED: --solar-seasonal now uses Physics+ML Hybrid (same as default)
        // The Seasonal MREC model caused severe over-forecasting (+296% errors)
        console.log(`   Wind: ${windModelName} | Solar: Physics+ML Hybrid                    `);
        console.log('   NOTE: --solar-seasonal is deprecated; using default hybrid model             ');
      } else if (solarMrecHybrid) {
        console.log(`   Wind: ${windModelName} | Solar: iPool MREC + ML Residual (per-station)`);
      } else if (solarMrec) {
        console.log(`   Wind: ${windModelName} | Solar: iPool MREC Three-Tier (per-station)   `);
      } else if (solarPhysicsOnly) {
        console.log(`   Wind: ${windModelName} | Solar: Physics-Only + Bias Correction        `);
      } else if (solarWeatherConfidence) {
        console.log(`   Wind: ${windModelName} | Solar: Physics+ML (Weather-Confidence Scaled)`);
      } else {
        console.log(`   Wind: ${windModelName} | Solar: Physics+ML Hybrid                    `);
      }
      if (useXGBoost) {
        console.log('   ML MODEL: XGBoost (gradient boosting)                                         ');
      }
      if (asymmetricLoss) {
        console.log('   ASYMMETRIC LOSS: Under-predictions penalized 2x                               ');
      }
      if (autoCalibrate) {
        console.log(`   AUTO-CALIBRATE: ${calibrationDays} days (${calibrationStartDate.toISODate()} to ${calibrationEndDate.toISODate()})`);
      }
      if (!autoCalibrate && (effectiveSolarScale !== 1 || effectiveWindScale !== 1 || effectiveOtherScale !== 1)) {
        console.log('   MANUAL SCALING:');
        if (effectiveSolarScale !== 1) console.log(`      Solar: ${((effectiveSolarScale - 1) * 100).toFixed(1)}%`);
        if (effectiveWindScale !== 1) console.log(`      Wind:  ${((effectiveWindScale - 1) * 100).toFixed(1)}%`);
        if (effectiveOtherScale !== 1 && scaleAll !== 0) console.log(`      Other: ${((effectiveOtherScale - 1) * 100).toFixed(1)}%`);
      }
      console.log('═══════════════════════════════════════════════════════════════════════════════\n');

      // Load station metadata
      console.log('📍 Loading station metadata...');
      await capacityFactorService.loadStations(options.stations);
      const stations = capacityFactorService.getAllStations();
      const clusters = capacityFactorService.getClusters();
      console.log(`   Loaded ${stations.size} stations in ${clusters.length} weather clusters`);

      // Parse training data (capacity factors)
      console.log('\n📚 Parsing capacity factor training data...');
      let cfacData = await capacityFactorService.parseCapacityFactorDirectory(
        options.training,
        (msg) => console.log(`   ${msg}`)
      );

      // Apply training-end date filter if specified
      const trainingEndDate = options.trainingEnd ? DateTime.fromISO(options.trainingEnd).endOf('day').toJSDate() : null;
      if (trainingEndDate) {
        const originalCount = cfacData.length;
        cfacData = cfacData.filter(record => record.datetime <= trainingEndDate);
        console.log(`\n📅 Training data cutoff: ${options.trainingEnd}`);
        console.log(`   Original records: ${originalCount.toLocaleString()}`);
        console.log(`   After filtering:  ${cfacData.length.toLocaleString()} (removed ${(originalCount - cfacData.length).toLocaleString()} records after cutoff)`);
      }

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

      const windStations = stationsByType.get(StationType.WIND) || [];
      const solarStations = stationsByType.get(StationType.SOLAR) || [];
      const hydroRoRStations = stationsByType.get(StationType.HYDRO_RUN_OF_RIVER) || [];
      const hydroStorageStations = stationsByType.get(StationType.HYDRO_STORAGE) || [];
      const geothermalStations = stationsByType.get(StationType.GEOTHERMAL) || [];
      const biomassStations = stationsByType.get(StationType.BIOMASS) || [];
      const batteryStations = stationsByType.get(StationType.BATTERY) || [];
      const unknownStations = stationsByType.get(StationType.UNKNOWN) || [];
      // Combined OTHER stations for calibration (all non-wind, non-solar)
      const otherStations = [
        ...hydroRoRStations,
        ...hydroStorageStations,
        ...geothermalStations,
        ...biomassStations,
        ...batteryStations,
        ...unknownStations
      ];

      console.log('\n📋 Station types:');
      console.log(`   🌬️  Wind:           ${windStations.length} stations → Weather-Only MREC Hybrid`);
      console.log(`   ☀️  Solar:          ${solarStations.length} stations → Physics+ML Hybrid`);
      console.log(`   💧 Hydro (RoR):    ${hydroRoRStations.length} stations → Profile-based`);
      console.log(`   💧 Hydro (Storage): ${hydroStorageStations.length} stations → Profile-based`);
      console.log(`   🌋 Geothermal:      ${geothermalStations.length} stations → Profile-based`);
      console.log(`   🌿 Biomass:         ${biomassStations.length} stations → Profile-based`);
      console.log(`   🔋 Battery:         ${batteryStations.length} stations → Profile-based`);
      console.log(`   ❓ Unknown:         ${unknownStations.length} stations → Profile-based`);

      // ═══════════════════════════════════════════════════════════════════════════
      // FILTER OUT OUTAGE PERIODS (if enabled)
      // ═══════════════════════════════════════════════════════════════════════════
      let filteredCfacData = cfacData;

      if (excludeOutages) {
        console.log('\n🔍 Filtering out outage periods from training data...');

        const originalCount = cfacData.length;
        const stationOutageStats = new Map<string, { original: number; filtered: number; removed: number }>();

        // Group data by station
        const dataByStation = new Map<string, typeof cfacData>();
        for (const record of cfacData) {
          if (!dataByStation.has(record.stationCode)) {
            dataByStation.set(record.stationCode, []);
          }
          dataByStation.get(record.stationCode)!.push(record);
        }

        // For each station, detect and filter outage periods
        filteredCfacData = [];
        for (const [stationCode, records] of dataByStation) {
          const stationType = getStationTypeFromCode(stationCode);
          const originalStationCount = records.length;

          // Sort by datetime
          records.sort((a, b) => a.datetime.getTime() - b.datetime.getTime());

          // Detect outage hours (consecutive zeros that indicate plant is offline)
          // Different logic per station type:
          // - Wind/Geothermal: CF=0 is an outage (should run 24/7)
          // - Solar: CF=0 during daylight (6am-6pm) is an outage, nighttime zeros are normal
          // - Hydro/Biomass/Battery: Exclude consecutive zero streaks > 24 hours

          let filteredRecords: typeof records;

          if (stationType === StationType.WIND || stationType === StationType.GEOTHERMAL) {
            // Wind and Geothermal should never be zero when operating
            filteredRecords = records.filter(r => r.capacityFactor > 0);
          } else if (stationType === StationType.SOLAR) {
            // Solar: only filter daytime zeros (6am-6pm local time)
            filteredRecords = records.filter(r => {
              const hour = r.datetime.getHours();
              const isDaylight = hour >= 6 && hour <= 18;
              // Keep nighttime zeros, but filter daytime zeros
              if (!isDaylight) return true;  // Keep nighttime records
              return r.capacityFactor > 0;   // Filter daytime zeros
            });
          } else {
            // Hydro/Biomass/Battery: Detect outage streaks (>24 consecutive zeros)
            // Mark records that are part of outage streaks
            const outageIndices = new Set<number>();
            let zeroStreakStart = -1;

            for (let i = 0; i < records.length; i++) {
              if (records[i].capacityFactor === 0) {
                if (zeroStreakStart === -1) zeroStreakStart = i;
              } else {
                if (zeroStreakStart !== -1) {
                  const streakLength = i - zeroStreakStart;
                  // If streak > 24 hours, mark as outage
                  if (streakLength > 24) {
                    for (let j = zeroStreakStart; j < i; j++) {
                      outageIndices.add(j);
                    }
                  }
                }
                zeroStreakStart = -1;
              }
            }
            // Handle streak at end
            if (zeroStreakStart !== -1) {
              const streakLength = records.length - zeroStreakStart;
              if (streakLength > 24) {
                for (let j = zeroStreakStart; j < records.length; j++) {
                  outageIndices.add(j);
                }
              }
            }

            filteredRecords = records.filter((_, i) => !outageIndices.has(i));
          }

          const removedCount = originalStationCount - filteredRecords.length;
          if (removedCount > 0) {
            stationOutageStats.set(stationCode, {
              original: originalStationCount,
              filtered: filteredRecords.length,
              removed: removedCount
            });
          }

          filteredCfacData.push(...filteredRecords);
        }

        const totalRemoved = originalCount - filteredCfacData.length;
        console.log(`   Removed ${totalRemoved} outage records (${(100 * totalRemoved / originalCount).toFixed(1)}% of data)`);

        // Show stations with significant outages
        const significantOutages = [...stationOutageStats.entries()]
          .filter(([, stats]) => stats.removed > 100)
          .sort((a, b) => b[1].removed - a[1].removed)
          .slice(0, 10);

        if (significantOutages.length > 0) {
          console.log('   Stations with significant outages filtered:');
          for (const [code, stats] of significantOutages) {
            const pctRemoved = (100 * stats.removed / stats.original).toFixed(0);
            console.log(`      ${code}: ${stats.removed} records removed (${pctRemoved}%)`);
          }
        }
      }

      // Get station-specific locations for wind (more accurate than cluster centers)
      const windStationLocations = capacityFactorService.getWindStationLocations();
      const windStationClusterIds = new Set<string>();
      for (const loc of windStationLocations) {
        windStationClusterIds.add(loc.clusterId);  // e.g., "WIND_01BURGOS"
      }
      console.log(`\n🌬️  Using station-specific coordinates for ${windStationLocations.length} wind farms`);
      for (const loc of windStationLocations) {
        console.log(`   📍 ${loc.stationCodes[0]}: ${loc.latitude.toFixed(4)}, ${loc.longitude.toFixed(4)}`);
      }

      // Get station-specific locations for solar (more accurate than cluster centers)
      const solarStationLocations = capacityFactorService.getSolarStationLocations();
      const solarStationClusterIds = new Set<string>();
      for (const loc of solarStationLocations) {
        solarStationClusterIds.add(loc.clusterId);  // e.g., "SOLAR_01CLARK"
      }
      console.log(`\n☀️  Using station-specific coordinates for ${solarStationLocations.length} solar plants`);
      for (const loc of solarStationLocations) {
        console.log(`   📍 ${loc.stationCodes[0]}: ${loc.latitude.toFixed(4)}, ${loc.longitude.toFixed(4)}`);
      }

      // Helper: Proper CSV parsing
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

      // Get training data date range
      const sortedCfac = [...cfacData].sort((a, b) => a.datetime.getTime() - b.datetime.getTime());
      const trainStart = DateTime.fromJSDate(sortedCfac[0].datetime).toISODate()!;
      const trainEnd = DateTime.fromJSDate(sortedCfac[sortedCfac.length - 1].datetime).toISODate()!;
      console.log(`\n📅 Training data: ${trainStart} to ${trainEnd}`);
      console.log(`📅 Forecast period: ${options.start} to ${options.end}`);

      // Fetch weather data for training period
      console.log('\n🌤️  Fetching weather data for training period...');

      // Fetch weather for WIND stations using station-specific coordinates (100m hub height)
      console.log('   Fetching wind station-specific weather (100m hub height)...');
      const trainWindWeatherCsv = await weatherService.fetchAllClusters(
        windStationLocations,  // Individual wind station locations
        trainStart,
        trainEnd,
        (msg) => console.log(`   ${msg}`),
        windStationClusterIds  // All are wind clusters - need 100m data
      );

      // Fetch weather for SOLAR stations using station-specific coordinates
      console.log('   Fetching solar station-specific weather...');
      const trainSolarWeatherCsv = await weatherService.fetchAllClusters(
        solarStationLocations,  // Individual solar station locations
        trainStart,
        trainEnd,
        (msg) => console.log(`   ${msg}`),
        new Set<string>()  // Not wind - no 100m data needed
      );

      // Fetch weather for other stations using cluster coordinates
      // IMPORTANT: Fetch ALL clusters, not just non-wind/solar, because some clusters
      // contain BOTH solar AND hydro stations (e.g., BATAAN_SOLAR has 01HERMOSA hydro)
      // Wind/solar stations use their specific weather anyway, so duplicates are harmless
      console.log('   Fetching cluster weather for other station types...');
      const trainClusterWeatherCsv = await weatherService.fetchAllClusters(
        clusters,  // Fetch ALL clusters (was: nonWindSolarClusters)
        trainStart,
        trainEnd,
        (msg) => console.log(`   ${msg}`),
        new Set<string>()  // No wind clusters here
      );

      // Parse training weather into cluster/station -> timestamp -> features
      const trainClusterWeather = new Map<string, Map<number, CFacWeatherFeatures>>();

      // Helper to parse weather CSV
      const parseWeatherCsv = (csvData: string): Map<number, CFacWeatherFeatures> => {
        const weatherMap = new Map<number, CFacWeatherFeatures>();
        const lines = csvData.split('\n').filter(l => l.trim());
        if (lines.length < 2) return weatherMap;

        const headers = parseCSVLine(lines[0]).map(h => h.toLowerCase());
        const colIdx = (name: string) => headers.indexOf(name);

        for (let i = 1; i < lines.length; i++) {
          const values = parseCSVLine(lines[i]);
          const datetimeStr = values[colIdx('datetime')];
          if (!datetimeStr) continue;

          const dt = DateTime.fromISO(datetimeStr);
          if (!dt.isValid) continue;

          // Add 1 hour for hour-ending format
          const ts = dt.plus({ hours: 1 }).toMillis();

          const weather: CFacWeatherFeatures = {
            temperature: parseFloat(values[colIdx('temp')]) || 25,
            windSpeed: parseFloat(values[colIdx('windspeed')]) || 0,
            windSpeed100: colIdx('windspeed100') >= 0 ? parseFloat(values[colIdx('windspeed100')]) || undefined : undefined,
            windGust: parseFloat(values[colIdx('windgust')]) || 0,
            cloudCover: parseFloat(values[colIdx('cloudcover')]) || 50,
            solarRadiation: parseFloat(values[colIdx('solarradiation')]) || 0,
            precipitation: parseFloat(values[colIdx('precip')]) || 0,
          };

          weatherMap.set(ts, weather);
        }
        return weatherMap;
      };

      // Parse wind station-specific weather
      for (const [clusterId, csvData] of trainWindWeatherCsv) {
        trainClusterWeather.set(clusterId, parseWeatherCsv(csvData));
      }

      // Parse solar station-specific weather
      for (const [clusterId, csvData] of trainSolarWeatherCsv) {
        trainClusterWeather.set(clusterId, parseWeatherCsv(csvData));
      }

      // Parse cluster weather for other stations
      for (const [clusterId, csvData] of trainClusterWeatherCsv) {
        trainClusterWeather.set(clusterId, parseWeatherCsv(csvData));
      }

      console.log(`   Loaded weather: ${trainWindWeatherCsv.size} wind + ${trainSolarWeatherCsv.size} solar stations + ${trainClusterWeatherCsv.size} clusters`);

      // ═══════════════════════════════════════════════════════════════════════════
      // TRAIN OPTIMAL MODELS FOR EACH TYPE
      // ═══════════════════════════════════════════════════════════════════════════

      console.log('\n🔧 Training optimal models for each station type...');

      // ─────────────────────────────────────────────────────────────────────────────
      // 1. WIND: Weather-Only MREC Hybrid
      // ─────────────────────────────────────────────────────────────────────────────
      console.log('\n   [1/2] 🌬️  WIND: Calibrating Weather-Only MREC Hybrid...');

      // Prepare MREC calibration data
      const mrecCalibrationData: MRECCalibrationData[] = [];
      const windTrainingSamples: CFacTrainingSample[] = [];

      for (const record of filteredCfacData) {
        if (!windStations.includes(record.stationCode)) continue;

        // Use station-specific weather for wind (WIND_${stationCode})
        const windClusterId = `WIND_${record.stationCode}`;
        const weatherMap = trainClusterWeather.get(windClusterId);
        if (!weatherMap) continue;

        const ts = record.datetime.getTime();
        const weather = weatherMap.get(ts);
        if (!weather) continue;

        // For MREC calibration
        mrecCalibrationData.push({
          datetime: record.datetime,
          stationCode: record.stationCode,
          capacityFactor: record.capacityFactor,
          windSpeed: weather.windSpeed100 ?? weather.windSpeed
        });

        // For hybrid training
        const dt = record.datetime;
        windTrainingSamples.push({
          stationCode: record.stationCode,
          datetime: record.datetime,
          stationType: StationType.WIND,
          actualCFac: record.capacityFactor,
          weather,
          hour: dt.getHours(),
          dayOfWeek: dt.getDay(),
          month: dt.getMonth() + 1,
          isWeekend: dt.getDay() === 0 || dt.getDay() === 6
        });
      }

      // Calibrate MREC models using ML-optimized grid search (finds optimal vH/vL per station)
      const mrecModels = await calibrateAllMRECMLOptimized(mrecCalibrationData, (msg: string) => console.log(`      ${msg}`));

      // Extract MREC factors for hybrid
      const mrecFactorsList: import('./types/capacityFactor.js').MRECFactors[] = [];
      for (const [, model] of mrecModels) {
        const factors = model.getFactors();
        if (factors && factors.calibrated) {
          mrecFactorsList.push(factors);
        }
      }

      // Train wind models - use 4-tier if requested, otherwise Enhanced Hybrid
      let windHybridModels: Map<string, WindEnhancedHybridModel>;
      let wind4TierModels: Map<string, Wind4TierHybridModel> | null = null;

      if (wind4Tier) {
        // Train 4-Tier Hybrid (LOW/RAMP/RATED/HIGH with region-specific gustRatio)
        wind4TierModels = await trainAll4TierHybrid(
          windTrainingSamples,
          asymmetricLoss,
          (msg: string) => console.log(`      ${msg}`),
          useXGBoost
        );
        console.log(`      ✅ Trained ${wind4TierModels.size} Wind 4-Tier Hybrid models${asymmetricLoss ? ' (asymmetric loss)' : ''}`);
        // Create empty enhanced models map for compatibility
        windHybridModels = new Map();
      } else {
        // Train Enhanced Hybrid (multiplicative correction - better for peaks)
        windHybridModels = await trainAllEnhancedHybrid(
          mrecFactorsList,
          windTrainingSamples,
          asymmetricLoss,
          (msg: string) => console.log(`      ${msg}`)
        );
        console.log(`      ✅ Trained ${windHybridModels.size} Wind Enhanced Hybrid models${asymmetricLoss ? ' (asymmetric loss)' : ''}`);
      }

      // ─────────────────────────────────────────────────────────────────────────────
      // 2. SOLAR: Physics+ML Hybrid or Physics-Only with Bias Correction or MREC models
      // ─────────────────────────────────────────────────────────────────────────────
      if (solarSeasonal) {
        // DEPRECATED: --solar-seasonal now uses Physics+ML Hybrid (same as default)
        console.log('\n   [2/2] ☀️  SOLAR: Training Physics+ML Hybrid (--solar-seasonal deprecated)...');
      } else if (solarMrecHybrid) {
        console.log('\n   [2/2] ☀️  SOLAR: iPool MREC + ML Residual (per-station calibration)...');
      } else if (solarMrec) {
        console.log('\n   [2/2] ☀️  SOLAR: iPool MREC Three-Tier (per-station calibration)...');
      } else if (solarPhysicsOnly) {
        console.log('\n   [2/2] ☀️  SOLAR: Physics-Only + Bias Correction...');
      } else if (solarSeasonalAdaptive) {
        console.log('\n   [2/2] ☀️  SOLAR: Seasonal Adaptive (dry/wet ML models, reduced dry weight)...');
      } else {
        console.log('\n   [2/2] ☀️  SOLAR: Training Physics+ML Hybrid...');
      }

      const solarHybridModels = new Map<string, SolarHybridModel>();
      const solarPhysicsModels = new Map<string, SolarIrradianceModel>();
      const solarBiasCorrections = new Map<string, number>();
      const solarMrecModels = new Map<string, SolarMRECModel>();
      const solarMrecHybridModels = new Map<string, SolarMRECHybridModel>();
      const solarSeasonalModels = new Map<string, SolarSeasonalMRECModel>();

      // Collect all station samples for batch MREC calibration
      const allSolarSamples: CFacTrainingSample[] = [];
      const solarMrecCalibrationData: SolarMRECCalibrationData[] = [];

      for (const stationCode of solarStations) {
        // Use station-specific weather for solar (SOLAR_${stationCode})
        const solarClusterId = `SOLAR_${stationCode}`;
        const weatherMap = trainClusterWeather.get(solarClusterId);
        if (!weatherMap) continue;

        // Build training samples for this station
        const stationRecords = filteredCfacData.filter(r => r.stationCode === stationCode);
        const stationSamples: CFacTrainingSample[] = [];

        for (const record of stationRecords) {
          const ts = record.datetime.getTime();
          const weather = weatherMap.get(ts);
          if (!weather) continue;

          const dt = record.datetime;
          const sample: CFacTrainingSample = {
            stationCode: record.stationCode,
            datetime: record.datetime,
            stationType: StationType.SOLAR,
            actualCFac: record.capacityFactor,
            weather,
            hour: dt.getHours(),
            dayOfWeek: dt.getDay(),
            month: dt.getMonth() + 1,
            isWeekend: dt.getDay() === 0 || dt.getDay() === 6
          };
          stationSamples.push(sample);
          allSolarSamples.push(sample);

          // Build MREC calibration data (daylight hours with positive irradiance)
          if ((solarMrec || solarMrecHybrid || solarSeasonal) && dt.getHours() >= 6 && dt.getHours() <= 18 && weather.solarRadiation > 0) {
            solarMrecCalibrationData.push({
              datetime: record.datetime,
              stationCode: record.stationCode,
              capacityFactor: record.capacityFactor,
              solarIrradiance: weather.solarRadiation
            });
          }
        }

        if (stationSamples.length >= 50) {
          if (solarMrecHybrid || solarMrec) {
            // MREC models will be calibrated after this loop (batch calibration)
          } else if (solarSeasonal) {
            // DEPRECATED: --solar-seasonal now trains hybrid models (same as default)
            const model = new SolarHybridModel(stationCode);
            await model.train(stationSamples, asymmetricLoss);
            solarHybridModels.set(stationCode, model);
          } else if (solarPhysicsOnly) {
            // Physics-only mode: create model and calculate bias correction
            const physicsModel = new SolarIrradianceModel();
            solarPhysicsModels.set(stationCode, physicsModel);

            // Calculate bias from training data (daylight hours only)
            let biasSum = 0;
            let biasCount = 0;
            for (const sample of stationSamples) {
              const hour = sample.datetime.getHours();
              if (hour < 6 || hour > 18) continue;
              if (sample.actualCFac < 0.01) continue;

              const physicsPred = physicsModel.predict(sample.weather.solarRadiation, sample.weather.temperature);
              if (physicsPred > 0.01) {
                biasSum += sample.actualCFac - physicsPred;
                biasCount++;
              }
            }

            const avgBias = biasCount > 0 ? biasSum / biasCount : 0;
            solarBiasCorrections.set(stationCode, avgBias);
          } else if (solarSeasonalAdaptive) {
            // Seasonal Adaptive mode: train separate dry/wet models, reduce ML weight in dry season
            const model = new SolarHybridModel(stationCode);
            await model.train(stationSamples, asymmetricLoss);
            model.setSeasonalAdaptiveMode(true);
            solarHybridModels.set(stationCode, model);
          } else {
            // ML Hybrid mode (with optional weather-confidence scaling)
            const model = new SolarHybridModel(stationCode);
            await model.train(stationSamples, asymmetricLoss);
            // Enable weather-confidence mode if requested (scales ML residual by weather confidence)
            if (solarWeatherConfidence) {
              model.setWeatherConfidenceMode(true);
            }
            solarHybridModels.set(stationCode, model);
          }
        }
      }

      // Batch calibrate MREC models (only for non-deprecated MREC modes)
      if (solarSeasonal) {
        // DEPRECATED: --solar-seasonal now uses Physics+ML Hybrid (trained above)
        console.log(`      ✅ Trained ${solarHybridModels.size} Solar Physics+ML Hybrid models (--solar-seasonal deprecated)`);
      } else if (solarMrecHybrid) {
        // MREC + ML Residual Hybrid
        const models = await calibrateAllSolarMRECHybrid(
          solarMrecCalibrationData,
          allSolarSamples,
          asymmetricLoss,
          (msg: string) => console.log(`      ${msg}`)
        );
        for (const [code, model] of models) {
          solarMrecHybridModels.set(code, model);
        }
        console.log(`      ✅ Calibrated ${solarMrecHybridModels.size} Solar MREC+ML Hybrid models${asymmetricLoss ? ' (asymmetric loss)' : ''}`);
      } else if (solarMrec) {
        // MREC-only (three-tier piecewise)
        const models = await calibrateAllSolarMREC(
          solarMrecCalibrationData,
          (msg: string) => console.log(`      ${msg}`)
        );
        for (const [code, model] of models) {
          solarMrecModels.set(code, model);
        }
        console.log(`      ✅ Calibrated ${solarMrecModels.size} Solar MREC Three-Tier models`);
      } else if (solarPhysicsOnly) {
        const avgBias = [...solarBiasCorrections.values()].reduce((a, b) => a + b, 0) / solarBiasCorrections.size;
        console.log(`      ✅ Created ${solarPhysicsModels.size} Solar Physics-Only models`);
        console.log(`      📊 Average bias correction: ${(avgBias >= 0 ? '+' : '')}${(avgBias * 100).toFixed(1)}% CF`);
      } else if (solarSeasonalAdaptive) {
        // Count how many models have dry season model trained
        let drySeasonModelCount = 0;
        for (const model of solarHybridModels.values()) {
          if (model.hasDrySeasonModel()) drySeasonModelCount++;
        }
        console.log(`      ✅ Trained ${solarHybridModels.size} Solar Seasonal Adaptive models${asymmetricLoss ? ' (asymmetric loss)' : ''}`);
        console.log(`      📊 Dry season models trained: ${drySeasonModelCount}/${solarHybridModels.size} (rest use 30% ML weight)`);
      } else {
        console.log(`      ✅ Trained ${solarHybridModels.size} Solar Physics+ML Hybrid models${asymmetricLoss ? ' (asymmetric loss)' : ''}`);
      }

      // ─────────────────────────────────────────────────────────────────────────────
      // 3. OTHER TYPES: Use ModelRouter for profile-based models
      // ─────────────────────────────────────────────────────────────────────────────
      console.log('\n   [3/3] 📊 Other types: Training profile-based models...');

      // Build general training samples for non-wind/solar stations
      const otherTrainingStations = [
        ...hydroRoRStations,
        ...hydroStorageStations,
        ...geothermalStations,
        ...biomassStations,
        ...batteryStations,
        ...unknownStations
      ];

      // Build weather map for general ModelRouter
      const generalWeatherMap = new Map<string, CFacWeatherFeatures>();
      for (const record of filteredCfacData) {
        if (!otherTrainingStations.includes(record.stationCode)) continue;

        const clusterId = capacityFactorService.getClusterForStation(record.stationCode);
        if (!clusterId) continue;

        const clusterWeather = trainClusterWeather.get(clusterId);
        if (!clusterWeather) continue;

        const ts = record.datetime.getTime();
        const weather = clusterWeather.get(ts);
        if (!weather) continue;

        const dt = DateTime.fromJSDate(record.datetime);
        const key = dt.toFormat('yyyy-MM-dd HH:mm');
        if (!generalWeatherMap.has(key)) {
          generalWeatherMap.set(key, weather);
        }
      }

      // Filter filteredCfacData to only include non-wind/solar stations
      const otherCfacData = filteredCfacData.filter(r => otherTrainingStations.includes(r.stationCode));

      // Train general models
      const otherSamples = await capacityFactorService.buildTrainingSamples(
        otherCfacData,
        generalWeatherMap,
        () => {}
      );

      const modelRouter = new ModelRouter();
      if (otherSamples.length > 0) {
        await modelRouter.trainAllModels(otherSamples, (msg: string) => console.log(`      ${msg}`));
      }
      console.log(`      ✅ Trained ${modelRouter.getModelCount()} profile-based models`);

      // ═══════════════════════════════════════════════════════════════════════════
      // LEARN BIAS CORRECTIONS (if enabled)
      // ═══════════════════════════════════════════════════════════════════════════

      const biasCorrector = new BiasCorrector(options.biasCorrection || false);

      if (options.biasCorrection) {
        console.log('\n🔧 Learning station-specific bias corrections...');

        const trainingPredictions: Array<{ stationCode: string; predicted: number; actual: number }> = [];

        // Generate predictions on training data for bias learning
        // WIND: Use 4-Tier or Enhanced Hybrid models
        for (const sample of windTrainingSamples) {
          let predicted: number;

          if (wind4Tier && wind4TierModels) {
            const model = wind4TierModels.get(sample.stationCode);
            if (!model) continue;
            predicted = model.predict(sample.weather, sample.datetime);
          } else {
            const model = windHybridModels.get(sample.stationCode);
            if (!model) continue;
            predicted = model.predict(sample.weather, sample.datetime);
          }

          trainingPredictions.push({
            stationCode: sample.stationCode,
            predicted,
            actual: sample.actualCFac,
          });
        }

        // SOLAR: Use Physics+ML Hybrid models
        for (const record of cfacData) {
          if (!solarStations.includes(record.stationCode)) continue;

          const model = solarHybridModels.get(record.stationCode);
          if (!model) continue;

          const solarClusterId = `SOLAR_${record.stationCode}`;
          const weatherMap = trainClusterWeather.get(solarClusterId);
          if (!weatherMap) continue;

          const weather = weatherMap.get(record.datetime.getTime());
          if (!weather) continue;

          const predicted = model.predict(weather, record.datetime);
          trainingPredictions.push({
            stationCode: record.stationCode,
            predicted,
            actual: record.capacityFactor,
          });
        }

        // Learn biases
        const biasStats = biasCorrector.learnBias(trainingPredictions);
        console.log(`   ✅ Learned biases for ${biasStats.totalStations} stations`);
        console.log(`      Wind avg bias: ${biasStats.windAvgBias.toFixed(4)} (${biasStats.windAvgBias < 0 ? 'UNDER' : 'OVER'}-forecasting)`);
        console.log(`      Solar avg bias: ${biasStats.solarAvgBias.toFixed(4)} (${biasStats.solarAvgBias < 0 ? 'UNDER' : 'OVER'}-forecasting)`);

        // Print detailed bias summary
        biasCorrector.printSummary((msg) => console.log(msg));
      }

      // ═══════════════════════════════════════════════════════════════════════════
      // FETCH FORECAST WEATHER DATA
      // ═══════════════════════════════════════════════════════════════════════════

      console.log('\n🌤️  Fetching weather data for forecast period...');

      // Fetch forecast weather for wind stations (station-specific coordinates)
      const forecastWindWeatherCsv = await weatherService.fetchAllClusters(
        windStationLocations,
        options.start,
        options.end,
        (msg) => console.log(`   ${msg}`),
        windStationClusterIds
      );

      // Fetch forecast weather for solar stations (station-specific coordinates)
      const forecastSolarWeatherCsv = await weatherService.fetchAllClusters(
        solarStationLocations,
        options.start,
        options.end,
        (msg) => console.log(`   ${msg}`),
        new Set<string>()  // Not wind - no 100m data needed
      );

      // Fetch forecast weather for other stations (cluster-based)
      // IMPORTANT: Fetch ALL clusters, not just non-wind/solar, because some clusters
      // contain BOTH solar AND hydro stations (e.g., BATAAN_SOLAR has 01HERMOSA hydro)
      const forecastClusterWeatherCsv = await weatherService.fetchAllClusters(
        clusters,  // Fetch ALL clusters (was: nonWindSolarClusters)
        options.start,
        options.end,
        (msg) => console.log(`   ${msg}`),
        new Set<string>()
      );

      // Parse forecast weather
      const forecastClusterWeather = new Map<string, Map<number, CFacWeatherFeatures>>();
      const forecastTimestamps = new Set<number>();

      // Helper to parse and collect timestamps
      const parseForecastWeatherCsv = (csvData: string, clusterId: string) => {
        const weatherMap = new Map<number, CFacWeatherFeatures>();
        const lines = csvData.split('\n').filter(l => l.trim());
        if (lines.length < 2) return weatherMap;

        const headers = parseCSVLine(lines[0]).map(h => h.toLowerCase());
        const colIdx = (name: string) => headers.indexOf(name);

        for (let i = 1; i < lines.length; i++) {
          const values = parseCSVLine(lines[i]);
          const datetimeStr = values[colIdx('datetime')];
          if (!datetimeStr) continue;

          const dt = DateTime.fromISO(datetimeStr);
          if (!dt.isValid) continue;

          const ts = dt.plus({ hours: 1 }).toMillis();
          forecastTimestamps.add(ts);

          const weather: CFacWeatherFeatures = {
            temperature: parseFloat(values[colIdx('temp')]) || 25,
            windSpeed: parseFloat(values[colIdx('windspeed')]) || 0,
            windSpeed100: colIdx('windspeed100') >= 0 ? parseFloat(values[colIdx('windspeed100')]) || undefined : undefined,
            windGust: parseFloat(values[colIdx('windgust')]) || 0,
            cloudCover: parseFloat(values[colIdx('cloudcover')]) || 50,
            solarRadiation: parseFloat(values[colIdx('solarradiation')]) || 0,
            precipitation: parseFloat(values[colIdx('precip')]) || 0,
          };

          weatherMap.set(ts, weather);
        }
        return weatherMap;
      };

      // Parse wind station weather
      for (const [clusterId, csvData] of forecastWindWeatherCsv) {
        forecastClusterWeather.set(clusterId, parseForecastWeatherCsv(csvData, clusterId));
      }

      // Parse solar station weather
      for (const [clusterId, csvData] of forecastSolarWeatherCsv) {
        forecastClusterWeather.set(clusterId, parseForecastWeatherCsv(csvData, clusterId));
      }

      // Parse cluster weather
      for (const [clusterId, csvData] of forecastClusterWeatherCsv) {
        forecastClusterWeather.set(clusterId, parseForecastWeatherCsv(csvData, clusterId));
      }

      const sortedTimestamps = [...forecastTimestamps].sort((a, b) => a - b);
      console.log(`   Loaded ${sortedTimestamps.length} forecast hours (${forecastWindWeatherCsv.size} wind + ${forecastSolarWeatherCsv.size} solar + ${forecastClusterWeatherCsv.size} clusters)`);

      // ═══════════════════════════════════════════════════════════════════════════
      // AUTO-CALIBRATION (if enabled)
      // ═══════════════════════════════════════════════════════════════════════════

      if (autoCalibrate) {
        console.log('\n📊 Running auto-calibration...');
        console.log(`   Calibration period: ${calibrationStartDate.toISODate()} to ${calibrationEndDate.toISODate()} (${calibrationDays} days)`);

        // Build actual CFac lookup from training data for calibration period
        const calibrationActuals = new Map<string, number>(); // key: "timestamp_stationCode"
        const calibrationStartTs = calibrationStartDate.toJSDate().getTime();
        const calibrationEndTs = calibrationEndDate.endOf('day').toJSDate().getTime();

        for (const record of cfacData) {
          const ts = record.datetime.getTime();
          if (ts >= calibrationStartTs && ts <= calibrationEndTs) {
            const key = `${ts}_${record.stationCode}`;
            calibrationActuals.set(key, record.capacityFactor);
          }
        }

        if (calibrationActuals.size === 0) {
          console.log('   ⚠️  No actual data found for calibration period - skipping auto-calibration');
        } else {
          console.log(`   Found ${calibrationActuals.size} actual data points for calibration`);

          // Use already-loaded training weather for calibration (trainClusterWeather)
          // Generate calibration predictions and compare
          let solarBiasSum = 0, solarCount = 0;
          let windBiasSum = 0, windCount = 0;

          // Per-station tracking for wind calibration
          const windActualSum = new Map<string, number>();
          const windPredSum = new Map<string, number>();
          const windSampleCount = new Map<string, number>();

          // Calibrate wind using training weather
          for (const stationCode of windStations) {
            const windClusterId = `WIND_${stationCode}`;
            const stationWeather = trainClusterWeather.get(windClusterId);
            if (!stationWeather) continue;

            // Check model availability based on mode
            if (wind4Tier && wind4TierModels) {
              if (!wind4TierModels.has(stationCode)) continue;
            } else {
              if (!windHybridModels.has(stationCode)) continue;
            }

            for (const [ts, weather] of stationWeather) {
              // Only use data from calibration period
              if (ts < calibrationStartTs || ts > calibrationEndTs) continue;

              const key = `${ts}_${stationCode}`;
              const actual = calibrationActuals.get(key);
              if (actual === undefined || actual < 0.01) continue;

              const datetime = new Date(ts);
              let rawPrediction: number;

              if (wind4Tier && wind4TierModels) {
                const model = wind4TierModels.get(stationCode)!;
                rawPrediction = model.predict(weather, datetime);
              } else {
                const model = windHybridModels.get(stationCode)!;
                rawPrediction = model.predict(weather, datetime);
              }

              const predicted = biasCorrector.applyCorrection(stationCode, rawPrediction);

              const bias = predicted - actual;  // Positive = over-forecast, Negative = under-forecast
              windBiasSum += bias;
              windCount++;

              // Track per-station sums for ratio-based scaling
              if (predicted > 0.01) {
                windActualSum.set(stationCode, (windActualSum.get(stationCode) || 0) + actual);
                windPredSum.set(stationCode, (windPredSum.get(stationCode) || 0) + predicted);
                windSampleCount.set(stationCode, (windSampleCount.get(stationCode) || 0) + 1);
              }
            }
          }

          // Calibrate solar using training weather - with per-hour bias tracking
          // Track biases by hour for solar (hours 6-18 = daylight)
          const solarHourlyBiasSum = new Map<number, number>();
          const solarHourlyCount = new Map<number, number>();
          for (let h = 0; h < 24; h++) {
            solarHourlyBiasSum.set(h, 0);
            solarHourlyCount.set(h, 0);
          }

          for (const stationCode of solarStations) {
            const solarClusterId = `SOLAR_${stationCode}`;
            const stationWeather = trainClusterWeather.get(solarClusterId);
            if (!stationWeather) continue;

            // Check model availability based on mode
            if (solarPhysicsOnly) {
              if (!solarPhysicsModels.has(stationCode)) continue;
            } else {
              if (!solarHybridModels.has(stationCode)) continue;
            }

            for (const [ts, weather] of stationWeather) {
              // Only use data from calibration period
              if (ts < calibrationStartTs || ts > calibrationEndTs) continue;

              const key = `${ts}_${stationCode}`;
              const actual = calibrationActuals.get(key);
              if (actual === undefined || actual < 0.01) continue;

              const datetime = new Date(ts);
              const hour = datetime.getHours();
              let rawPrediction: number;

              if (solarPhysicsOnly) {
                // Physics-only mode
                const physicsModel = solarPhysicsModels.get(stationCode)!;
                const physicsPred = physicsModel.predict(weather.solarRadiation, weather.temperature);
                const biasCorrection = solarBiasCorrections.get(stationCode) || 0;
                rawPrediction = physicsPred + biasCorrection;
              } else {
                // ML Hybrid mode
                const model = solarHybridModels.get(stationCode)!;
                rawPrediction = model.predict(weather, datetime);
              }

              const predicted = biasCorrector.applyCorrection(stationCode, rawPrediction);

              const bias = predicted - actual;
              solarBiasSum += bias;
              solarCount++;

              // Track per-hour biases
              solarHourlyBiasSum.set(hour, (solarHourlyBiasSum.get(hour) || 0) + bias);
              solarHourlyCount.set(hour, (solarHourlyCount.get(hour) || 0) + 1);
            }
          }

          // Calculate average biases (global)
          calibratedSolarBias = solarCount > 0 ? solarBiasSum / solarCount : 0;
          calibratedWindBias = windCount > 0 ? windBiasSum / windCount : 0;

          // Calculate per-hour biases and scale factors for solar
          console.log(`   Calibration results:`);
          console.log(`      Solar: ${solarCount} samples, overall avg bias = ${(calibratedSolarBias * 100).toFixed(2)}%`);
          console.log(`      Wind:  ${windCount} samples, avg bias = ${(calibratedWindBias * 100).toFixed(2)}%`);

          console.log(`   Per-hour solar calibration (daylight hours):`);
          for (let h = 6; h <= 18; h++) {
            const count = solarHourlyCount.get(h) || 0;
            if (count >= 10) {  // Need at least 10 samples for reliable calibration
              const hourlyBias = (solarHourlyBiasSum.get(h) || 0) / count;
              // Scale factor: if under-forecasting (negative bias), scale up
              const hourlyScale = 1 - hourlyBias;
              // Clamp to reasonable range [0.7, 1.5] to prevent extreme corrections
              const clampedScale = Math.max(0.7, Math.min(1.5, hourlyScale));
              solarHourlyScale.set(h, clampedScale);

              const direction = hourlyBias < 0 ? 'UNDER' : 'OVER';
              console.log(`      H${h.toString().padStart(2)}: bias=${(hourlyBias * 100).toFixed(2).padStart(6)}% (${direction}) → scale=${(clampedScale * 100).toFixed(1)}%`);
            } else {
              // Not enough samples, use global scale
              solarHourlyScale.set(h, 1 - calibratedSolarBias);
            }
          }

          // Convert bias to scale factor: if under-forecasting (negative bias), we need to scale up
          // Scale factor = 1 / (1 + bias) ≈ 1 - bias for small biases
          // If bias = -0.05 (under by 5%), scale = 1.05 to compensate
          if (scaleSolar === 0 && scaleAll === 0) {  // Only auto-calibrate if no manual override
            effectiveSolarScale = 1 - calibratedSolarBias;  // Keep global for fallback
          }
          if (scaleWind === 0 && scaleAll === 0) {  // Only auto-calibrate if no manual override
            effectiveWindScale = 1 - calibratedWindBias;
          }

          console.log(`   Applied global scale factors (used when hourly calibration unavailable):`);
          console.log(`      Solar: ${(effectiveSolarScale * 100).toFixed(1)}% (${calibratedSolarBias < 0 ? 'compensating for under-forecast' : 'compensating for over-forecast'})`);
          console.log(`      Wind:  ${(effectiveWindScale * 100).toFixed(1)}% (${calibratedWindBias < 0 ? 'compensating for under-forecast' : 'compensating for over-forecast'})`);

          // NOTE: Per-station wind calibration is DISABLED because wind patterns are too variable
          // between seasons. The calibration period (e.g., Dec 18-31) often has very different
          // wind patterns than the forecast period (e.g., Jan 1-14), causing overcorrection.
          // Wind uses global bias correction only (effectiveWindScale).
          // If you want to experiment with per-station wind calibration, uncomment the code below.
          /*
          console.log(`   Calibrating WIND stations (per-station):`);
          let windCalibrated = 0;
          let windSignificantAdjustments = 0;
          for (const stationCode of windStations) {
            const count = windSampleCount.get(stationCode) || 0;
            if (count >= 10) {
              const avgActual = (windActualSum.get(stationCode) || 0) / count;
              const avgPred = (windPredSum.get(stationCode) || 0) / count;
              const scale = avgPred > 0.01 ? avgActual / avgPred : 1.0;
              const clampedScale = Math.max(0.7, Math.min(1.4, scale));
              windStationScale.set(stationCode, clampedScale);
              windCalibrated++;
              if (Math.abs(scale - 1.0) > 0.15) {
                const direction = scale < 1.0 ? 'OVER-predicting' : 'UNDER-predicting';
                console.log(`      ${stationCode}: avgActual=${(avgActual * 100).toFixed(1)}%, avgPred=${(avgPred * 100).toFixed(1)}% → scale=${(clampedScale * 100).toFixed(1)}% (${direction})`);
                windSignificantAdjustments++;
              }
            } else {
              windStationScale.set(stationCode, 1.0);
            }
          }
          console.log(`      Calibrated ${windCalibrated} wind stations (${windSignificantAdjustments} with significant adjustments)`);
          */

          // Calibrate SOLAR stations - per-station RATIO-based scaling
          // This addresses individual station characteristics (panel efficiency, tracking, inverter, local conditions)
          console.log(`   Calibrating SOLAR stations (per-station):`);
          const solarActualSum = new Map<string, number>();
          const solarPredSum = new Map<string, number>();
          const solarSampleCount = new Map<string, number>();

          for (const stationCode of solarStations) {
            const solarClusterId = `SOLAR_${stationCode}`;
            const stationWeather = trainClusterWeather.get(solarClusterId);
            if (!stationWeather) continue;

            // Check model availability based on mode
            let hasModel = false;
            if (solarMrecHybrid) {
              hasModel = solarMrecHybridModels.has(stationCode);
            } else if (solarMrec) {
              hasModel = solarMrecModels.has(stationCode);
            } else if (solarPhysicsOnly) {
              hasModel = solarPhysicsModels.has(stationCode);
            } else {
              hasModel = solarHybridModels.has(stationCode);
            }
            if (!hasModel) continue;

            for (const [ts, weather] of stationWeather) {
              // Only use data from calibration period
              if (ts < calibrationStartTs || ts > calibrationEndTs) continue;

              const key = `${ts}_${stationCode}`;
              const actual = calibrationActuals.get(key);
              if (actual === undefined || actual < 0.01) continue;

              const datetime = new Date(ts);
              const hour = datetime.getHours();

              // Only daylight hours (6-18) are meaningful for solar
              if (hour < 6 || hour > 18) continue;

              let rawPrediction: number;

              if (solarMrecHybrid) {
                const model = solarMrecHybridModels.get(stationCode)!;
                if (!model.isReady()) continue;
                rawPrediction = model.predict(weather, datetime);
              } else if (solarMrec) {
                const model = solarMrecModels.get(stationCode)!;
                if (!model.isCalibrated()) continue;
                rawPrediction = model.predict(weather.solarRadiation);
              } else if (solarPhysicsOnly) {
                const physicsModel = solarPhysicsModels.get(stationCode)!;
                const physicsPred = physicsModel.predict(weather.solarRadiation, weather.temperature);
                const biasCorr = solarBiasCorrections.get(stationCode) || 0;
                rawPrediction = physicsPred + biasCorr;
              } else {
                const model = solarHybridModels.get(stationCode)!;
                rawPrediction = model.predict(weather, datetime);
              }

              // Apply existing corrections (bias corrector, hourly scale)
              const correctedPred = biasCorrector.applyCorrection(stationCode, rawPrediction);
              const hourlyScale = solarHourlyScale.get(hour) ?? effectiveSolarScale;
              const predicted = correctedPred * hourlyScale;

              if (predicted < 0.01) continue;  // Skip near-zero predictions

              // Track sums for ratio-based scaling
              solarActualSum.set(stationCode, (solarActualSum.get(stationCode) || 0) + actual);
              solarPredSum.set(stationCode, (solarPredSum.get(stationCode) || 0) + predicted);
              solarSampleCount.set(stationCode, (solarSampleCount.get(stationCode) || 0) + 1);
            }
          }

          // Calculate per-station scale factors using RATIO method
          let solarCalibrated = 0;
          let solarSignificantAdjustments = 0;
          for (const stationCode of solarStations) {
            const count = solarSampleCount.get(stationCode) || 0;
            if (count >= 10) {  // Need at least 10 samples for reliable calibration
              const avgActual = (solarActualSum.get(stationCode) || 0) / count;
              const avgPred = (solarPredSum.get(stationCode) || 0) / count;

              // Ratio-based scale: scale = actual/predicted (direct multiplicative correction)
              const scale = avgPred > 0.01 ? avgActual / avgPred : 1.0;
              // Clamp to reasonable range [0.5, 2.0] for solar
              const clampedScale = Math.max(0.5, Math.min(2.0, scale));
              solarStationScale.set(stationCode, clampedScale);
              solarCalibrated++;

              // Only show significant calibrations (>15% difference)
              if (Math.abs(scale - 1.0) > 0.15) {
                const direction = scale < 1.0 ? 'OVER-predicting' : 'UNDER-predicting';
                console.log(`      ${stationCode}: avgActual=${(avgActual * 100).toFixed(1)}%, avgPred=${(avgPred * 100).toFixed(1)}% → scale=${(clampedScale * 100).toFixed(1)}% (${direction})`);
                solarSignificantAdjustments++;
              }
            } else {
              // Not enough samples, use 1.0 (will rely on hourly scale)
              solarStationScale.set(stationCode, 1.0);
            }
          }
          console.log(`      Calibrated ${solarCalibrated} solar stations (${solarSignificantAdjustments} with significant adjustments)`);

          // Calibrate OTHER stations (hydro, geothermal, etc.) - per-station RATIO-based scaling
          // This is critical for seasonal adjustment (e.g., hydro wet→dry season transition)
          // Uses ratio-based scaling: scale = avgActual / avgPredicted
          console.log(`   Calibrating OTHER stations (Hydro, Geo, etc.):`);
          const otherActualSum = new Map<string, number>();
          const otherPredSum = new Map<string, number>();
          const otherSampleCount = new Map<string, number>();

          // Dummy weather object for profile-based models (they ignore weather)
          const dummyWeather: CFacWeatherFeatures = {
            temperature: 30,
            windSpeed: 5,
            windGust: 8,
            cloudCover: 50,
            solarRadiation: 500
          };

          for (const stationCode of otherStations) {
            if (!modelRouter.hasModel(stationCode)) continue;

            // Iterate through calibration period timestamps
            for (const record of cfacData) {
              const ts = record.datetime.getTime();
              if (ts < calibrationStartTs || ts > calibrationEndTs) continue;
              if (record.stationCode !== stationCode) continue;

              const actual = record.capacityFactor;
              if (actual < 0.01) continue;  // Skip near-zero values (outages)

              const predicted = modelRouter.predict(stationCode, dummyWeather, record.datetime);
              if (predicted === null || predicted < 0.01) continue;

              // Track sums for ratio-based scaling
              otherActualSum.set(stationCode, (otherActualSum.get(stationCode) || 0) + actual);
              otherPredSum.set(stationCode, (otherPredSum.get(stationCode) || 0) + predicted);
              otherSampleCount.set(stationCode, (otherSampleCount.get(stationCode) || 0) + 1);
            }
          }

          // Calculate per-station scale factors using RATIO method
          let otherCalibrated = 0;
          for (const stationCode of otherStations) {
            const count = otherSampleCount.get(stationCode) || 0;
            if (count >= 10) {  // Need at least 10 samples
              const avgActual = (otherActualSum.get(stationCode) || 0) / count;
              const avgPred = (otherPredSum.get(stationCode) || 0) / count;

              // Ratio-based scale: scale = actual/predicted (direct multiplicative correction)
              const scale = avgPred > 0.01 ? avgActual / avgPred : 1.0;
              // Clamp to reasonable range [0.2, 2.0] - hydro can have large seasonal swings
              const clampedScale = Math.max(0.2, Math.min(2.0, scale));
              otherStationScale.set(stationCode, clampedScale);
              otherCalibrated++;

              // Only show significant calibrations (>10% difference)
              if (Math.abs(scale - 1.0) > 0.1) {
                const direction = scale < 1.0 ? 'OVER-predicting' : 'UNDER-predicting';
                console.log(`      ${stationCode}: avgActual=${(avgActual * 100).toFixed(1)}%, avgPred=${(avgPred * 100).toFixed(1)}% → scale=${(clampedScale * 100).toFixed(1)}% (${direction})`);
              }
            } else {
              // Not enough samples, use global scale
              otherStationScale.set(stationCode, effectiveOtherScale);
            }
          }
          console.log(`      Calibrated ${otherCalibrated} stations with sufficient samples`);
        }
      }

      // ═══════════════════════════════════════════════════════════════════════════
      // GENERATE FORECASTS
      // ═══════════════════════════════════════════════════════════════════════════

      console.log('\n🔮 Generating capacity factor forecasts...');
      const forecasts: CFacForecastResult[] = [];

      let windPredictions = 0;
      let solarPredictions = 0;
      let otherPredictions = 0;

      for (const ts of sortedTimestamps) {
        const datetime = new Date(ts);

        // WIND stations: Use 4-Tier or Enhanced Hybrid with station-specific weather
        for (const stationCode of windStations) {
          // Use station-specific weather (WIND_${stationCode})
          const windClusterId = `WIND_${stationCode}`;
          const stationWeather = forecastClusterWeather.get(windClusterId);
          if (!stationWeather) continue;

          const weather = stationWeather.get(ts);
          if (!weather) continue;

          let rawPrediction: number;
          let modelType: string;

          if (wind4Tier && wind4TierModels) {
            // 4-Tier MREC Hybrid (region-specific gustRatio)
            const model = wind4TierModels.get(stationCode);
            if (!model) continue;
            rawPrediction = model.predict(weather, datetime);
            modelType = '4tier-hybrid';
          } else {
            // Enhanced Hybrid (default)
            const model = windHybridModels.get(stationCode);
            if (!model) continue;
            rawPrediction = model.predict(weather, datetime);
            modelType = 'enhanced-hybrid';
          }

          const correctedCFac = biasCorrector.applyCorrection(stationCode, rawPrediction);
          // Apply: global wind scale * per-station scale (individual calibration)
          const stationScale = windStationScale.get(stationCode) ?? 1.0;
          const scaledCFac = correctedCFac * effectiveWindScale * stationScale;
          forecasts.push({
            datetime,
            stationCode,
            predictedCFac: Math.max(0, Math.min(1, scaledCFac)),
            modelType
          });
          windPredictions++;
        }

        // SOLAR stations: Use Physics+ML Hybrid OR Physics-Only with station-specific weather
        for (const stationCode of solarStations) {
          // Use station-specific weather (SOLAR_${stationCode})
          const solarClusterId = `SOLAR_${stationCode}`;
          const stationWeather = forecastClusterWeather.get(solarClusterId);
          if (!stationWeather) continue;

          const weather = stationWeather.get(ts);
          if (!weather) continue;

          let rawPrediction: number;
          let modelType: string;

          if (solarSeasonal) {
            // DEPRECATED: --solar-seasonal now uses Physics+ML Hybrid (same as default)
            const model = solarHybridModels.get(stationCode);
            if (!model) continue;

            rawPrediction = model.predict(weather, datetime);
            modelType = 'physics-ml-hybrid';
          } else if (solarMrecHybrid) {
            // MREC + ML Residual Hybrid mode
            const model = solarMrecHybridModels.get(stationCode);
            if (!model || !model.isReady()) continue;

            rawPrediction = model.predict(weather, datetime);
            modelType = 'mrec-ml-hybrid';
          } else if (solarMrec) {
            // MREC Three-Tier mode (iPool style)
            const model = solarMrecModels.get(stationCode);
            if (!model || !model.isCalibrated()) continue;

            rawPrediction = model.predict(weather.solarRadiation);
            modelType = 'mrec-three-tier';
          } else if (solarPhysicsOnly) {
            // Physics-Only mode: use SolarIrradianceModel + learned bias correction
            const physicsModel = solarPhysicsModels.get(stationCode);
            if (!physicsModel) continue;

            const physicsPred = physicsModel.predict(weather.solarRadiation, weather.temperature);
            const biasCorrection = solarBiasCorrections.get(stationCode) || 0;
            rawPrediction = physicsPred + biasCorrection;
            modelType = 'physics-only-bias';
          } else {
            // ML Hybrid mode: use SolarHybridModel
            const model = solarHybridModels.get(stationCode);
            if (!model) continue;

            rawPrediction = model.predict(weather, datetime);
            modelType = 'physics-ml-hybrid';
          }

          const correctedCFac = biasCorrector.applyCorrection(stationCode, rawPrediction);
          // Apply: hourly scale (global hour-of-day adjustment) * per-station scale (individual calibration)
          const hour = datetime.getHours();
          const hourlyScale = solarHourlyScale.get(hour) ?? effectiveSolarScale;
          const stationScale = solarStationScale.get(stationCode) ?? 1.0;
          const scaledCFac = correctedCFac * hourlyScale * stationScale;
          forecasts.push({
            datetime,
            stationCode,
            predictedCFac: Math.max(0, Math.min(1, scaledCFac)),
            modelType
          });
          solarPredictions++;
        }

        // OTHER stations: Use ModelRouter (profile-based)
        // Profile-based models (hydro, geothermal, biomass, battery) don't actually need weather
        // They only use datetime for prediction, but the API still requires a weather map
        for (const stationCode of otherTrainingStations) {
          // Use dummy weather - profile-based models ignore it anyway
          const dummyWeather: CFacWeatherFeatures = {
            temperature: 30,
            windSpeed: 5,
            windGust: 8,
            cloudCover: 50,
            solarRadiation: 500
          };

          const stationWeatherMap = new Map<string, CFacWeatherFeatures>();
          stationWeatherMap.set(stationCode, dummyWeather);

          const predictions = modelRouter.predictAll([stationCode], stationWeatherMap, datetime);
          for (const pred of predictions) {
            // Apply per-station scaling (uses calibrated scale if available, else global)
            const stationScale = otherStationScale.get(stationCode) || effectiveOtherScale;
            const scaledCFac = pred.predictedCFac * stationScale;
            forecasts.push({
              ...pred,
              predictedCFac: Math.max(0, Math.min(1, scaledCFac))
            });
            otherPredictions++;
          }
        }
      }

      const solarModelName = solarMrecHybrid ? 'MREC+ML Hybrid' : solarMrec ? 'MREC Three-Tier' : solarPhysicsOnly ? 'Physics-Only' : solarWeatherConfidence ? 'Weather-Conf ML' : 'Physics+ML Hybrid';
      console.log(`   Generated ${forecasts.length} total predictions:`);
      console.log(`      🌬️  Wind:  ${windPredictions} predictions (Enhanced Hybrid)`);
      console.log(`      ☀️  Solar: ${solarPredictions} predictions (${solarModelName})`);
      console.log(`      📊 Other: ${otherPredictions} predictions (Profile-based)`);

      // ═══════════════════════════════════════════════════════════════════════════
      // WRITE OUTPUT
      // ═══════════════════════════════════════════════════════════════════════════

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

      console.log('\n═══════════════════════════════════════════════════════════════════════════════');
      console.log('                              FORECAST COMPLETE                                 ');
      console.log('═══════════════════════════════════════════════════════════════════════════════\n');
      console.log(`   📁 Output: ${options.output}`);
      console.log(`   📊 Predictions: ${forecasts.length} for ${trainingStations.length} stations`);
      console.log(`   📅 Period: ${options.start} to ${options.end}`);
      console.log('');
      console.log('   Models used:');
      console.log('   ├─ Wind:  Weather-Only MREC Hybrid (expected MAPE ~75.8%)');
      console.log('   ├─ Solar: Physics+ML Hybrid (expected MAPE ~59.6%)');
      console.log('   └─ Other: Profile-based models');
      if (options.biasCorrection) {
        console.log('');
        console.log('   🔧 Bias correction: ENABLED (station-specific adjustments applied)');
      }
      if (autoCalibrate && (calibratedSolarBias !== 0 || calibratedWindBias !== 0)) {
        console.log('');
        console.log('   📊 Auto-calibrated from recent data:');
        console.log(`      Calibration period: ${calibrationStartDate.toISODate()} to ${calibrationEndDate.toISODate()}`);
        if (calibratedSolarBias !== 0) console.log(`      Solar bias: ${(calibratedSolarBias * 100).toFixed(2)}% → scale ${(effectiveSolarScale * 100).toFixed(1)}%`);
        if (calibratedWindBias !== 0) console.log(`      Wind bias:  ${(calibratedWindBias * 100).toFixed(2)}% → scale ${(effectiveWindScale * 100).toFixed(1)}%`);
      } else if (effectiveSolarScale !== 1 || effectiveWindScale !== 1 || effectiveOtherScale !== 1) {
        console.log('');
        console.log('   📈 Manual scaling applied:');
        if (effectiveSolarScale !== 1) console.log(`      Solar: ${(effectiveSolarScale * 100).toFixed(1)}% of raw`);
        if (effectiveWindScale !== 1) console.log(`      Wind:  ${(effectiveWindScale * 100).toFixed(1)}% of raw`);
        if (effectiveOtherScale !== 1) console.log(`      Other: ${(effectiveOtherScale * 100).toFixed(1)}% of raw`);
      }
      console.log('');

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

// CFAC WEATHER - Fetch per-station weather data
cfacCommand
  .command('weather')
  .description('Fetch per-station weather data with all available elements (including wind at 10m, 50m, 80m, 100m)')
  .requiredOption('-s, --start <date>', 'Start date (YYYY-MM-DD)')
  .requiredOption('-e, --end <date>', 'End date (YYYY-MM-DD)')
  .option('--stations <file>', 'Stations JSON file', 'src/data/stations.json')
  .option('--cache <dir>', 'Weather cache directory', './weather_cache')
  .option('--types <types>', 'Station types to fetch (comma-separated: wind,solar,hydro,all)', 'all')
  .option('--only <codes>', 'Only fetch specific station codes (comma-separated)')
  .action(async (options) => {
    console.log('\n═══════════════════════════════════════════════════════════════════════════════');
    console.log('          PER-STATION WEATHER DATA FETCH (Corporate Account)                   ');
    console.log('   Includes all wind heights: 10m, 50m, 80m, 100m                              ');
    console.log('═══════════════════════════════════════════════════════════════════════════════\n');

    try {
      const apiKey = getApiKey();
      const weatherService = createWeatherService(apiKey, options.cache);

      // Load station metadata
      console.log('📍 Loading station metadata...');
      const stationsData = JSON.parse(readFileSync(options.stations, 'utf-8'));

      // Build list of stations to fetch
      const stationsToFetch: Array<{ code: string; latitude: number; longitude: number; type: string }> = [];
      const typesToFetch = options.types === 'all'
        ? new Set(['wind', 'solar', 'hydro', 'geothermal', 'biomass', 'battery'])
        : new Set(options.types.split(',').map((t: string) => t.trim().toLowerCase()));

      const onlyCodes = options.only ? new Set(options.only.split(',').map((c: string) => c.trim())) : null;

      for (const [code, station] of Object.entries(stationsData.stations) as [string, any][]) {
        // Filter by type
        if (!typesToFetch.has(station.type) && !typesToFetch.has('all')) continue;

        // Filter by specific codes if provided
        if (onlyCodes && !onlyCodes.has(code)) continue;

        // Need valid coordinates
        if (!station.location?.latitude || !station.location?.longitude) {
          console.log(`  ⚠️  Skipping ${code}: missing coordinates`);
          continue;
        }

        stationsToFetch.push({
          code,
          latitude: station.location.latitude,
          longitude: station.location.longitude,
          type: station.type
        });
      }

      console.log(`   Found ${stationsToFetch.length} stations to fetch`);

      // Group by type for display
      const byType = new Map<string, number>();
      for (const s of stationsToFetch) {
        byType.set(s.type, (byType.get(s.type) || 0) + 1);
      }
      for (const [type, count] of byType) {
        console.log(`   - ${type}: ${count} stations`);
      }

      console.log(`\n📅 Date range: ${options.start} to ${options.end}`);

      // Calculate total API calls needed
      const startDate = DateTime.fromISO(options.start);
      const endDate = DateTime.fromISO(options.end);
      const totalDays = Math.ceil(endDate.diff(startDate, 'days').days) + 1;
      const totalCalls = stationsToFetch.length * totalDays;
      console.log(`   Total days: ${totalDays}`);
      console.log(`   Expected API calls: ${totalCalls} (${stationsToFetch.length} stations × ${totalDays} days)`);

      // Fetch weather data
      console.log('\n🌤️  Fetching per-station weather data...\n');

      let totalCached = 0;
      let totalDownloaded = 0;

      for (let i = 0; i < stationsToFetch.length; i++) {
        const station = stationsToFetch[i];
        console.log(`[${i + 1}/${stationsToFetch.length}] ${station.code} (${station.type}) at ${station.latitude.toFixed(4)}, ${station.longitude.toFixed(4)}`);

        const result = await weatherService.fetchStationWeatherData(
          station.code,
          station.latitude,
          station.longitude,
          options.start,
          options.end,
          (msg) => console.log(msg),
          true  // Use full elements including all wind heights
        );

        if (result.success) {
          totalCached += result.cached;
          totalDownloaded += result.downloaded;
        } else {
          console.log(`  ❌ Failed: ${result.error}`);
        }
      }

      console.log('\n═══════════════════════════════════════════════════════════════════════════════');
      console.log('                           FETCH COMPLETE                                      ');
      console.log('═══════════════════════════════════════════════════════════════════════════════\n');
      console.log(`   Stations processed: ${stationsToFetch.length}`);
      console.log(`   Days cached: ${totalCached}`);
      console.log(`   Days downloaded: ${totalDownloaded}`);
      console.log(`   Cache location: ${options.cache}/station_*`);
      console.log('\n   Weather elements fetched:');
      console.log('   - Wind: windspeed (10m), windspeed50, windspeed80, windspeed100');
      console.log('   - Wind direction: winddir, winddir50, winddir80, winddir100');
      console.log('   - Solar: solarradiation, solarenergy, uvindex');
      console.log('   - Other: temp, humidity, pressure, cloudcover, precip, conditions');

    } catch (error: any) {
      console.error(`\n❌ Error: ${error.message}`);
      process.exit(1);
    }
  });

// CFAC MREC - MREC-related subcommands
const mrecCommand = cfacCommand
  .command('mrec')
  .description('MREC (Must-Run Energy Conversion) model commands - iPool-style wind forecasting');

// CFAC MREC CALIBRATE - Calibrate MREC factors from historical data
mrecCommand
  .command('calibrate')
  .description('Calibrate MREC factors for wind stations from historical capacity factor and wind data')
  .requiredOption('-c, --cfac <path>', 'Historical capacity factor data: MRHCFac CSV file or directory')
  .option('-w, --wind <path>', 'Historical wind speed data CSV (if separate from weather cache)')
  .option('--stations <file>', 'Stations JSON file', 'src/data/stations.json')
  .option('--cache <dir>', 'Weather cache directory', './weather_cache')
  .option('--save', 'Save calibrated factors to database', false)
  .action(async (options) => {
    try {
      const apiKey = getApiKey();
      const weatherService = createWeatherService(apiKey, options.cache);
      const db = getDatabase();

      console.log('\n🔧 MREC Calibration - iPool Wind Model');
      console.log('═══════════════════════════════════════════════════════════════\n');

      // Load station metadata
      console.log('🔄 Loading station metadata...');
      await capacityFactorService.loadStations(options.stations);
      const clusters = capacityFactorService.getClusters();
      console.log(`   Loaded ${clusters.length} weather clusters`);

      // Parse capacity factor data
      console.log('\n🔄 Parsing capacity factor historical data...');
      const cfacData = await capacityFactorService.parseCapacityFactorDirectory(
        options.cfac,
        (msg) => console.log(`   ${msg}`)
      );

      // Filter for wind stations only
      const allStations = capacityFactorService.getStationCodes(cfacData);
      const windStations = allStations.filter(code => getStationTypeFromCode(code) === StationType.WIND);

      if (windStations.length === 0) {
        console.error('❌ No wind stations found in capacity factor data');
        process.exit(1);
      }
      console.log(`\n🌬️  Found ${windStations.length} wind stations to calibrate`);

      // Get wind clusters
      const windClusterIds = new Set<string>();
      for (const stationCode of windStations) {
        const clusterId = capacityFactorService.getClusterForStation(stationCode);
        if (clusterId) {
          windClusterIds.add(clusterId);
        }
      }
      console.log(`   Wind stations mapped to ${windClusterIds.size} clusters`);

      // Get date range from training data
      const sortedCfac = [...cfacData].sort((a, b) => a.datetime.getTime() - b.datetime.getTime());
      const trainStart = DateTime.fromJSDate(sortedCfac[0].datetime).toISODate()!;
      const trainEnd = DateTime.fromJSDate(sortedCfac[sortedCfac.length - 1].datetime).toISODate()!;
      console.log(`\n📅 Historical data range: ${trainStart} to ${trainEnd}`);

      // Load wind weather data from cache for each wind cluster
      console.log(`\n🌤️  Loading cluster weather data from cache (${options.cache})...`);
      const windClusters = clusters.filter(c => windClusterIds.has(c.clusterId));

      // Parse cluster weather data from cache files into datetime -> windSpeed maps
      const clusterWindData = new Map<string, Map<number, number>>();

      for (const cluster of windClusters) {
        const windMap = new Map<number, number>();
        let loadedCount = 0;

        // Iterate through date range and load cached files
        let currentDate = DateTime.fromISO(trainStart);
        const endDate = DateTime.fromISO(trainEnd);

        while (currentDate <= endDate) {
          const yearMonth = currentDate.toFormat('yyyy-MM');
          const dateStr = currentDate.toISODate()!;
          const cachePath = join(options.cache, cluster.clusterId, yearMonth, `${dateStr}.csv`);


          if (existsSync(cachePath)) {
            const csvContent = readFileSync(cachePath, 'utf-8');
            const lines = csvContent.split('\n').filter(l => l.trim());

            if (lines.length >= 2) {
              // Proper CSV parsing helper (handles quoted fields with commas)
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

              // Parse header properly
              const headers = parseCSVLine(lines[0]).map(h => h.toLowerCase());

              const datetimeIdx = headers.indexOf('datetime');
              const windSpeed100Idx = headers.indexOf('windspeed100');
              const windSpeedIdx = headers.indexOf('windspeed');

              if (datetimeIdx < 0 || windSpeedIdx < 0) {
                currentDate = currentDate.plus({ days: 1 });
                continue;
              }

              for (let i = 1; i < lines.length; i++) {
                // Parse data row with proper CSV handling
                const values = parseCSVLine(lines[i]);
                const datetimeStr = values[datetimeIdx];
                if (!datetimeStr) continue;

                const dt = DateTime.fromISO(datetimeStr);
                if (!dt.isValid) continue;

                // Convert to hour-ending timestamp (add 1 hour) to match CFac timestamps
                const ts = dt.plus({ hours: 1 }).toMillis();

                // Prefer 100m wind speed if available, fallback to 10m
                const windSpeed = windSpeed100Idx >= 0 && values[windSpeed100Idx]
                  ? parseFloat(values[windSpeed100Idx])
                  : parseFloat(values[windSpeedIdx]) || 0;

                if (!isNaN(windSpeed)) {
                  windMap.set(ts, windSpeed);
                  loadedCount++;
                }
              }
            }
          }

          currentDate = currentDate.plus({ days: 1 });
        }

        clusterWindData.set(cluster.clusterId, windMap);
        console.log(`   ${cluster.clusterId}: loaded ${loadedCount} hourly wind records`);
      }

      if (clusterWindData.size === 0) {
        console.error('❌ No weather data found in cache. Run cfac forecast first to populate cache.');
        process.exit(1);
      }

      // Build MREC calibration data by joining CFac with wind speed
      console.log('\n🔧 Building MREC calibration dataset...');
      const mrecData: MRECCalibrationData[] = [];

      for (const record of cfacData) {
        // Only process wind stations
        if (!windStations.includes(record.stationCode)) continue;

        // Get cluster for this station
        const clusterId = capacityFactorService.getClusterForStation(record.stationCode);
        if (!clusterId) continue;

        // Get wind speed for this datetime
        const windMap = clusterWindData.get(clusterId);
        if (!windMap) continue;

        const ts = record.datetime.getTime();
        const windSpeed = windMap.get(ts);
        if (windSpeed === undefined || windSpeed < 0) continue;

        mrecData.push({
          datetime: record.datetime,
          stationCode: record.stationCode,
          capacityFactor: record.capacityFactor,
          windSpeed
        });
      }

      console.log(`   Built ${mrecData.length} calibration samples`);

      // Calibrate MREC for all wind stations
      console.log('\n🎯 Calibrating MREC factors...');
      const mrecModels = await calibrateAllMREC(mrecData, (msg) => console.log(msg));

      // Display results
      console.log('\n═══════════════════════════════════════════════════════════════');
      console.log('                    MREC CALIBRATION RESULTS                    ');
      console.log('═══════════════════════════════════════════════════════════════');
      console.log('\n┌───────────────────┬──────────┬──────────┬──────────┬────────┬────────┬─────────┐');
      console.log('│ Station           │   MRecH  │   MRecM  │   MRecL  │  vH    │  vL    │ Samples │');
      console.log('├───────────────────┼──────────┼──────────┼──────────┼────────┼────────┼─────────┤');

      let calibratedCount = 0;
      for (const [stationCode, model] of mrecModels) {
        const factors = model.getFactors();
        if (!factors) continue;

        const status = factors.calibrated ? '✓' : '✗';
        console.log(`│ ${(stationCode + status).padEnd(17)} │ ${factors.MRecH.toFixed(5).padStart(8)} │ ${factors.MRecM.toFixed(5).padStart(8)} │ ${factors.MRecL.toFixed(5).padStart(8)} │ ${factors.vH.toFixed(1).padStart(6)} │ ${factors.vL.toFixed(1).padStart(6)} │ ${(factors.sampleCount || 0).toString().padStart(7)} │`);

        if (factors.calibrated) calibratedCount++;

        // Save to database if requested
        if (options.save && factors.calibrated) {
          db.saveMRECFactors(factors);
        }
      }

      console.log('└───────────────────┴──────────┴──────────┴──────────┴────────┴────────┴─────────┘');

      console.log(`\n📊 Summary: ${calibratedCount}/${mrecModels.size} stations successfully calibrated`);

      if (options.save) {
        console.log(`\n💾 Calibrated factors saved to database`);
      } else {
        console.log(`\n💡 Use --save flag to persist calibrated factors to database`);
      }

      console.log('\n💡 MREC Model Explanation:');
      console.log('   • MRecH/M/L: Conversion factors for High/Mid/Low wind tiers');
      console.log('   • Formula: CapacityFactor = MRec × WindSpeed');
      console.log('   • vH/vL: Wind speed thresholds (m/s) for tier boundaries');
      console.log('   • High wind cutout: CF > 1.1 → 0 (storm shutdown)');

      closeDatabase();
      console.log('\n✅ MREC calibration complete!');

    } catch (error: any) {
      console.error(`\n❌ Error: ${error.message}`);
      if (error.stack) {
        console.error(error.stack);
      }
      process.exit(1);
    }
  });

// CFAC MREC STATUS - Show calibrated MREC factors
mrecCommand
  .command('status')
  .description('Show calibrated MREC factors from database')
  .action(async () => {
    try {
      const db = getDatabase();

      console.log('\n📊 MREC Calibrated Factors Status');
      console.log('═══════════════════════════════════════════════════════════════\n');

      const allFactors = db.getAllMRECFactors();

      if (allFactors.length === 0) {
        console.log('No MREC factors calibrated yet.');
        console.log('Run: iload cfac mrec calibrate -c <cfac_data> --save');
        closeDatabase();
        return;
      }

      console.log('┌───────────────────┬──────────┬──────────┬──────────┬────────┬────────┬────────────────────┐');
      console.log('│ Station           │   MRecH  │   MRecM  │   MRecL  │  vH    │  vL    │ Calibration Date   │');
      console.log('├───────────────────┼──────────┼──────────┼──────────┼────────┼────────┼────────────────────┤');

      let calibrated = 0;
      for (const factors of allFactors) {
        const status = factors.calibrated ? '✓' : '✗';
        const dateStr = factors.calibrationDate
          ? DateTime.fromJSDate(factors.calibrationDate).toFormat('yyyy-MM-dd HH:mm')
          : 'N/A';

        console.log(`│ ${(factors.stationCode + status).padEnd(17)} │ ${factors.MRecH.toFixed(5).padStart(8)} │ ${factors.MRecM.toFixed(5).padStart(8)} │ ${factors.MRecL.toFixed(5).padStart(8)} │ ${factors.vH.toFixed(1).padStart(6)} │ ${factors.vL.toFixed(1).padStart(6)} │ ${dateStr.padStart(18)} │`);

        if (factors.calibrated) calibrated++;
      }

      console.log('└───────────────────┴──────────┴──────────┴──────────┴────────┴────────┴────────────────────┘');

      console.log(`\n📈 Total: ${allFactors.length} stations, ${calibrated} calibrated`);

      closeDatabase();

    } catch (error: any) {
      console.error(`\n❌ Error: ${error.message}`);
      process.exit(1);
    }
  });

// CFAC MREC PREDICT - Run MREC prediction for a single wind speed
mrecCommand
  .command('predict')
  .description('Predict capacity factor using MREC model for a given wind speed')
  .requiredOption('-s, --station <code>', 'Station code to predict for')
  .requiredOption('-w, --wind <speed>', 'Wind speed in m/s (preferably 100m hub-height)')
  .action(async (options) => {
    try {
      const db = getDatabase();

      const factors = db.getMRECFactors(options.station);
      if (!factors) {
        console.error(`❌ No MREC factors found for station ${options.station}`);
        console.log('Run: iload cfac mrec calibrate -c <cfac_data> --save');
        closeDatabase();
        process.exit(1);
      }

      const windSpeed = parseFloat(options.wind);
      if (isNaN(windSpeed) || windSpeed < 0) {
        console.error('❌ Invalid wind speed. Must be a positive number.');
        process.exit(1);
      }

      const model = new WindMRECModel(options.station);
      model.loadFactors(factors);
      const cfac = model.predict(windSpeed);

      // Determine which tier was used
      let tier = 'LOW';
      if (windSpeed >= factors.vH) {
        tier = 'HIGH';
      } else if (windSpeed >= factors.vL) {
        tier = 'MID';
      }

      console.log('\n🌬️  MREC Wind Capacity Factor Prediction');
      console.log('═══════════════════════════════════════════════════════════════\n');
      console.log(`   Station:      ${options.station}`);
      console.log(`   Wind Speed:   ${windSpeed.toFixed(1)} m/s`);
      console.log(`   Tier:         ${tier} (thresholds: vH=${factors.vH.toFixed(1)}, vL=${factors.vL.toFixed(1)})`);
      console.log(`   MRec Factor:  ${tier === 'HIGH' ? factors.MRecH.toFixed(5) : tier === 'MID' ? factors.MRecM.toFixed(5) : factors.MRecL.toFixed(5)}`);
      console.log('');
      console.log(`   📊 Predicted Capacity Factor: ${(cfac * 100).toFixed(1)}%`);

      if (cfac === 0 && windSpeed > factors.vH) {
        console.log('   ⚠️  High wind cutout triggered (storm protection)');
      }

      closeDatabase();

    } catch (error: any) {
      console.error(`\n❌ Error: ${error.message}`);
      process.exit(1);
    }
  });

// CFAC MREC CLEAR - Clear all MREC factors from database
mrecCommand
  .command('clear')
  .description('Clear all MREC factors from database')
  .option('--confirm', 'Confirm deletion')
  .action(async (options) => {
    try {
      if (!options.confirm) {
        console.log('⚠️  This will delete all calibrated MREC factors.');
        console.log('Use --confirm to proceed.');
        return;
      }

      const db = getDatabase();
      db.clearMRECFactors();
      closeDatabase();

      console.log('✅ All MREC factors cleared from database');

    } catch (error: any) {
      console.error(`\n❌ Error: ${error.message}`);
      process.exit(1);
    }
  });

// CFAC MREC FORECAST - Generate wind forecasts using MREC factors
mrecCommand
  .command('forecast')
  .description('Generate wind capacity factor forecasts using calibrated MREC factors')
  .requiredOption('-s, --start <date>', 'Forecast start date (YYYY-MM-DD)')
  .requiredOption('-e, --end <date>', 'Forecast end date (YYYY-MM-DD)')
  .option('-o, --output <path>', 'Output CSV file', 'output/cfac_mrec_forecast.csv')
  .option('--cache <dir>', 'Weather cache directory', './weather_cache')
  .option('--stations <file>', 'Stations JSON file', 'src/data/stations.json')
  .action(async (options) => {
    try {
      const db = getDatabase();

      console.log('\n🌬️  MREC Wind Capacity Factor Forecast');
      console.log('═══════════════════════════════════════════════════════════════\n');

      // Load calibrated MREC factors
      const calibratedFactors = db.getCalibratedMRECFactors();
      if (calibratedFactors.length === 0) {
        console.error('❌ No calibrated MREC factors found. Run: iload cfac mrec calibrate first.');
        closeDatabase();
        process.exit(1);
      }
      console.log(`📊 Loaded ${calibratedFactors.length} calibrated MREC factors`);

      // Load station metadata for cluster mapping
      await capacityFactorService.loadStations(options.stations);
      const clusters = capacityFactorService.getClusters();

      // Find wind clusters for the calibrated stations
      const windClusterIds = new Set<string>();
      for (const factors of calibratedFactors) {
        const clusterId = capacityFactorService.getClusterForStation(factors.stationCode);
        if (clusterId) {
          windClusterIds.add(clusterId);
        }
      }
      console.log(`🌤️  Wind stations mapped to ${windClusterIds.size} clusters`);

      // Build models map
      const mrecModels = new Map<string, WindMRECModel>();
      for (const factors of calibratedFactors) {
        const model = new WindMRECModel(factors.stationCode);
        model.loadFactors(factors);
        mrecModels.set(factors.stationCode, model);
      }

      // Load forecast weather data from cache
      console.log(`\n📅 Forecast period: ${options.start} to ${options.end}`);
      const windClusters = clusters.filter(c => windClusterIds.has(c.clusterId));

      // Helper: Proper CSV parsing
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

      // Load weather for each cluster
      const clusterWindData = new Map<string, Map<number, number>>();
      for (const cluster of windClusters) {
        const windMap = new Map<number, number>();
        let loadedCount = 0;

        let currentDate = DateTime.fromISO(options.start);
        const endDate = DateTime.fromISO(options.end);

        while (currentDate <= endDate) {
          const yearMonth = currentDate.toFormat('yyyy-MM');
          const dateStr = currentDate.toISODate()!;
          const cachePath = join(options.cache, cluster.clusterId, yearMonth, `${dateStr}.csv`);

          if (existsSync(cachePath)) {
            const csvContent = readFileSync(cachePath, 'utf-8');
            const lines = csvContent.split('\n').filter(l => l.trim());

            if (lines.length >= 2) {
              const headers = parseCSVLine(lines[0]).map(h => h.toLowerCase());
              const datetimeIdx = headers.indexOf('datetime');
              const windSpeed100Idx = headers.indexOf('windspeed100');
              const windSpeedIdx = headers.indexOf('windspeed');

              if (datetimeIdx >= 0 && windSpeedIdx >= 0) {
                for (let i = 1; i < lines.length; i++) {
                  const values = parseCSVLine(lines[i]);
                  const datetimeStr = values[datetimeIdx];
                  if (!datetimeStr) continue;

                  const dt = DateTime.fromISO(datetimeStr);
                  if (!dt.isValid) continue;

                  const ts = dt.plus({ hours: 1 }).toMillis();
                  const windSpeed = windSpeed100Idx >= 0 && values[windSpeed100Idx]
                    ? parseFloat(values[windSpeed100Idx])
                    : parseFloat(values[windSpeedIdx]) || 0;

                  if (!isNaN(windSpeed)) {
                    windMap.set(ts, windSpeed);
                    loadedCount++;
                  }
                }
              }
            }
          }
          currentDate = currentDate.plus({ days: 1 });
        }

        clusterWindData.set(cluster.clusterId, windMap);
        console.log(`   ${cluster.clusterId}: loaded ${loadedCount} hourly wind records`);
      }

      // Generate forecasts
      console.log('\n🔮 Generating MREC wind forecasts...');

      // Build datetime array
      const datetimes: DateTime[] = [];
      let dt = DateTime.fromISO(options.start).set({ hour: 1, minute: 0, second: 0, millisecond: 0 });
      const endDt = DateTime.fromISO(options.end).set({ hour: 23, minute: 0, second: 0, millisecond: 0 });
      while (dt <= endDt) {
        datetimes.push(dt);
        dt = dt.plus({ hours: 1 });
      }

      // Generate predictions
      const predictions: Map<string, Map<number, number>> = new Map();
      let totalPredictions = 0;

      for (const [stationCode, model] of mrecModels) {
        const clusterId = capacityFactorService.getClusterForStation(stationCode);
        if (!clusterId) continue;

        const windMap = clusterWindData.get(clusterId);
        if (!windMap) continue;

        const stationPredictions = new Map<number, number>();

        for (const datetime of datetimes) {
          const ts = datetime.toMillis();
          const windSpeed = windMap.get(ts);

          if (windSpeed !== undefined) {
            const cfac = model.predict(windSpeed);
            stationPredictions.set(ts, cfac);
            totalPredictions++;
          }
        }

        predictions.set(stationCode, stationPredictions);
      }

      console.log(`   Generated ${totalPredictions} predictions for ${predictions.size} wind stations`);

      // Write output CSV
      const outputDir = dirname(options.output);
      if (!existsSync(outputDir)) {
        mkdirSync(outputDir, { recursive: true });
      }

      const stationCodes = Array.from(predictions.keys()).sort();
      const headerRow = ['DateTimeEnding', ...stationCodes].join(',');
      const dataRows: string[] = [];

      for (const datetime of datetimes) {
        const ts = datetime.toMillis();
        const dateStr = datetime.toFormat('M/d/yyyy HH:mm');
        const values = stationCodes.map(code => {
          const stationPreds = predictions.get(code);
          const cfac = stationPreds?.get(ts);
          return cfac !== undefined ? cfac.toFixed(6) : '';
        });
        dataRows.push([dateStr, ...values].join(','));
      }

      const csvContent = [headerRow, ...dataRows].join('\n');
      writeFileSync(options.output, csvContent);

      console.log(`\n✅ MREC forecast written to: ${options.output}`);
      console.log(`   📊 ${totalPredictions} predictions for ${predictions.size} wind stations`);
      console.log(`   📅 Period: ${options.start} to ${options.end}`);

      closeDatabase();

    } catch (error: any) {
      console.error(`\n❌ Error: ${error.message}`);
      if (error.stack) console.error(error.stack);
      process.exit(1);
    }
  });

// CFAC MREC HYBRID - Train MREC + ML hybrid model
mrecCommand
  .command('hybrid')
  .description('Train MREC + ML hybrid model and compare against pure MREC')
  .requiredOption('-t, --training <path>', 'Training capacity factor data (MRHCFac CSV file or directory)')
  .option('--cache <dir>', 'Weather cache directory', './weather_cache')
  .option('--stations <file>', 'Stations JSON file', 'src/data/stations.json')
  .action(async (options) => {
    try {
      const db = getDatabase();

      console.log('\n🔧 MREC + ML Hybrid Model Training');
      console.log('═══════════════════════════════════════════════════════════════\n');

      // Load calibrated MREC factors
      const calibratedFactors = db.getCalibratedMRECFactors();
      if (calibratedFactors.length === 0) {
        console.error('❌ No calibrated MREC factors found. Run: iload cfac mrec calibrate --save first.');
        closeDatabase();
        process.exit(1);
      }
      console.log(`📊 Loaded ${calibratedFactors.length} calibrated MREC factors`);

      // Load station metadata
      await capacityFactorService.loadStations(options.stations);
      const clusters = capacityFactorService.getClusters();

      // Parse capacity factor training data
      console.log('\n🔄 Parsing capacity factor training data...');
      const cfacData = await capacityFactorService.parseCapacityFactorDirectory(
        options.training,
        (msg) => console.log(`   ${msg}`)
      );

      // Find wind clusters
      const windClusterIds = new Set<string>();
      for (const factors of calibratedFactors) {
        const clusterId = capacityFactorService.getClusterForStation(factors.stationCode);
        if (clusterId) windClusterIds.add(clusterId);
      }

      // Get date range
      const sortedCfac = [...cfacData].sort((a, b) => a.datetime.getTime() - b.datetime.getTime());
      const trainStart = DateTime.fromJSDate(sortedCfac[0].datetime).toISODate()!;
      const trainEnd = DateTime.fromJSDate(sortedCfac[sortedCfac.length - 1].datetime).toISODate()!;

      console.log(`\n📅 Training data range: ${trainStart} to ${trainEnd}`);

      // Helper: Proper CSV parsing
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

      // Load weather data from cache
      console.log('\n🌤️  Loading cluster weather data from cache...');
      const windClusters = clusters.filter(c => windClusterIds.has(c.clusterId));
      const clusterWeatherData = new Map<string, Map<number, CFacWeatherFeatures>>();

      for (const cluster of windClusters) {
        const weatherMap = new Map<number, CFacWeatherFeatures>();
        let loadedCount = 0;

        let currentDate = DateTime.fromISO(trainStart);
        const endDate = DateTime.fromISO(trainEnd);

        while (currentDate <= endDate) {
          const yearMonth = currentDate.toFormat('yyyy-MM');
          const dateStr = currentDate.toISODate()!;
          const cachePath = join(options.cache, cluster.clusterId, yearMonth, `${dateStr}.csv`);

          if (existsSync(cachePath)) {
            const csvContent = readFileSync(cachePath, 'utf-8');
            const lines = csvContent.split('\n').filter(l => l.trim());

            if (lines.length >= 2) {
              const headers = parseCSVLine(lines[0]).map(h => h.toLowerCase());
              const datetimeIdx = headers.indexOf('datetime');
              const tempIdx = headers.indexOf('temp');
              const windSpeedIdx = headers.indexOf('windspeed');
              const windSpeed100Idx = headers.indexOf('windspeed100');
              const windGustIdx = headers.indexOf('windgust');
              const cloudCoverIdx = headers.indexOf('cloudcover');
              const solarRadiationIdx = headers.indexOf('solarradiation');

              if (datetimeIdx >= 0 && windSpeedIdx >= 0) {
                for (let i = 1; i < lines.length; i++) {
                  const values = parseCSVLine(lines[i]);
                  const datetimeStr = values[datetimeIdx];
                  if (!datetimeStr) continue;

                  const dt = DateTime.fromISO(datetimeStr);
                  if (!dt.isValid) continue;

                  const ts = dt.plus({ hours: 1 }).toMillis();

                  const weather: CFacWeatherFeatures = {
                    temperature: tempIdx >= 0 ? parseFloat(values[tempIdx]) || 25 : 25,
                    windSpeed: parseFloat(values[windSpeedIdx]) || 0,
                    windSpeed100: windSpeed100Idx >= 0 ? parseFloat(values[windSpeed100Idx]) : undefined,
                    windGust: windGustIdx >= 0 ? parseFloat(values[windGustIdx]) || 0 : 0,
                    cloudCover: cloudCoverIdx >= 0 ? parseFloat(values[cloudCoverIdx]) || 50 : 50,
                    solarRadiation: solarRadiationIdx >= 0 ? parseFloat(values[solarRadiationIdx]) || 0 : 0,
                  };

                  weatherMap.set(ts, weather);
                  loadedCount++;
                }
              }
            }
          }
          currentDate = currentDate.plus({ days: 1 });
        }

        clusterWeatherData.set(cluster.clusterId, weatherMap);
        console.log(`   ${cluster.clusterId}: loaded ${loadedCount} hourly weather records`);
      }

      // Build training samples
      console.log('\n🔧 Building training samples...');
      const trainingSamples: CFacTrainingSample[] = [];

      for (const record of cfacData) {
        const clusterId = capacityFactorService.getClusterForStation(record.stationCode);
        if (!clusterId) continue;

        const weatherMap = clusterWeatherData.get(clusterId);
        if (!weatherMap) continue;

        const ts = record.datetime.getTime();
        const weather = weatherMap.get(ts);
        if (!weather) continue;

        // Build full training sample
        const dt = record.datetime;
        const dayOfWeek = dt.getDay();
        trainingSamples.push({
          stationCode: record.stationCode,
          datetime: record.datetime,
          stationType: StationType.WIND, // For MREC hybrid, we only care about wind
          actualCFac: record.capacityFactor,
          weather,
          hour: dt.getHours(),
          dayOfWeek,
          month: dt.getMonth() + 1,
          isWeekend: dayOfWeek === 0 || dayOfWeek === 6
        });
      }

      console.log(`   Built ${trainingSamples.length} training samples`);

      // Train MREC-ML Hybrid models
      console.log('\n🎯 Training MREC + ML Hybrid models...\n');
      const hybridModels = await trainAllMRECHybrid(
        calibratedFactors,
        trainingSamples,
        (msg) => console.log(msg)
      );

      console.log('\n═══════════════════════════════════════════════════════════════');
      console.log('                    MREC + ML HYBRID RESULTS                    ');
      console.log('═══════════════════════════════════════════════════════════════\n');

      console.log('┌───────────────────┬──────────────┬──────────────┬─────────────┐');
      console.log('│ Station           │  MREC MAPE   │ Hybrid MAPE  │ Improvement │');
      console.log('├───────────────────┼──────────────┼──────────────┼─────────────┤');

      let totalMrecMAPE = 0;
      let totalHybridMAPE = 0;
      let stationCount = 0;

      for (const [stationCode, model] of hybridModels) {
        // Re-evaluate to get metrics (or store during training)
        const stationSamples = trainingSamples.filter(s => s.stationCode === stationCode);

        if (stationSamples.length < 50) continue;

        let mrecErrorSum = 0, hybridErrorSum = 0, validCount = 0;

        for (const sample of stationSamples) {
          const windSpeed = sample.weather.windSpeed100 ?? sample.weather.windSpeed;
          const mrecPred = model.predictMRECOnly(windSpeed);
          const hybridPred = model.predict(sample.weather, sample.datetime);
          const actual = sample.actualCFac;

          if (actual > 0.01) {
            mrecErrorSum += Math.abs((mrecPred - actual) / actual);
            hybridErrorSum += Math.abs((hybridPred - actual) / actual);
            validCount++;
          }
        }

        if (validCount > 0) {
          const mrecMAPE = (mrecErrorSum / validCount) * 100;
          const hybridMAPE = (hybridErrorSum / validCount) * 100;
          const improvement = ((mrecMAPE - hybridMAPE) / mrecMAPE) * 100;

          console.log(`│ ${stationCode.padEnd(17)} │ ${mrecMAPE.toFixed(1).padStart(10)}% │ ${hybridMAPE.toFixed(1).padStart(10)}% │ ${(improvement >= 0 ? '+' : '') + improvement.toFixed(1).padStart(9)}% │`);

          totalMrecMAPE += mrecMAPE;
          totalHybridMAPE += hybridMAPE;
          stationCount++;
        }
      }

      console.log('└───────────────────┴──────────────┴──────────────┴─────────────┘');

      if (stationCount > 0) {
        const avgMrecMAPE = totalMrecMAPE / stationCount;
        const avgHybridMAPE = totalHybridMAPE / stationCount;
        const overallImprovement = ((avgMrecMAPE - avgHybridMAPE) / avgMrecMAPE) * 100;

        console.log(`\n📊 Summary (${stationCount} stations):`);
        console.log(`   MREC-only avg MAPE:  ${avgMrecMAPE.toFixed(1)}%`);
        console.log(`   Hybrid avg MAPE:     ${avgHybridMAPE.toFixed(1)}%`);
        console.log(`   Overall improvement: ${overallImprovement >= 0 ? '+' : ''}${overallImprovement.toFixed(1)}%`);
      }

      closeDatabase();
      console.log('\n✅ MREC + ML Hybrid training complete!');

    } catch (error: any) {
      console.error(`\n❌ Error: ${error.message}`);
      if (error.stack) console.error(error.stack);
      process.exit(1);
    }
  });

// CFAC MREC EVALUATE - Evaluate MREC model accuracy against actual data
mrecCommand
  .command('evaluate')
  .description('Evaluate MREC model accuracy against historical capacity factor data')
  .requiredOption('-a, --actual <path>', 'Actual capacity factor data (MRHCFac CSV file or directory)')
  .option('--cache <dir>', 'Weather cache directory', './weather_cache')
  .option('--stations <file>', 'Stations JSON file', 'src/data/stations.json')
  .action(async (options) => {
    try {
      const db = getDatabase();

      console.log('\n📊 MREC Model Evaluation');
      console.log('═══════════════════════════════════════════════════════════════\n');

      // Load calibrated MREC factors
      const calibratedFactors = db.getCalibratedMRECFactors();
      if (calibratedFactors.length === 0) {
        console.error('❌ No calibrated MREC factors found. Run: iload cfac mrec calibrate first.');
        closeDatabase();
        process.exit(1);
      }

      // Load station metadata
      await capacityFactorService.loadStations(options.stations);
      const clusters = capacityFactorService.getClusters();

      // Parse actual capacity factor data
      console.log('🔄 Parsing actual capacity factor data...');
      const actualData = await capacityFactorService.parseCapacityFactorDirectory(
        options.actual,
        (msg) => console.log(`   ${msg}`)
      );

      // Build MREC models
      const mrecModels = new Map<string, WindMRECModel>();
      const windClusterIds = new Set<string>();
      for (const factors of calibratedFactors) {
        const model = new WindMRECModel(factors.stationCode);
        model.loadFactors(factors);
        mrecModels.set(factors.stationCode, model);

        const clusterId = capacityFactorService.getClusterForStation(factors.stationCode);
        if (clusterId) windClusterIds.add(clusterId);
      }

      // Helper: Proper CSV parsing
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

      // Get date range from actual data
      const sortedActual = [...actualData].sort((a, b) => a.datetime.getTime() - b.datetime.getTime());
      const startDate = DateTime.fromJSDate(sortedActual[0].datetime).toISODate()!;
      const endDate = DateTime.fromJSDate(sortedActual[sortedActual.length - 1].datetime).toISODate()!;

      // Load weather data
      console.log(`\n📅 Evaluation period: ${startDate} to ${endDate}`);
      const windClusters = clusters.filter(c => windClusterIds.has(c.clusterId));

      const clusterWindData = new Map<string, Map<number, number>>();
      for (const cluster of windClusters) {
        const windMap = new Map<number, number>();
        let loadedCount = 0;

        let currentDate = DateTime.fromISO(startDate);
        const end = DateTime.fromISO(endDate);

        while (currentDate <= end) {
          const yearMonth = currentDate.toFormat('yyyy-MM');
          const dateStr = currentDate.toISODate()!;
          const cachePath = join(options.cache, cluster.clusterId, yearMonth, `${dateStr}.csv`);

          if (existsSync(cachePath)) {
            const csvContent = readFileSync(cachePath, 'utf-8');
            const lines = csvContent.split('\n').filter(l => l.trim());

            if (lines.length >= 2) {
              const headers = parseCSVLine(lines[0]).map(h => h.toLowerCase());
              const datetimeIdx = headers.indexOf('datetime');
              const windSpeed100Idx = headers.indexOf('windspeed100');
              const windSpeedIdx = headers.indexOf('windspeed');

              if (datetimeIdx >= 0 && windSpeedIdx >= 0) {
                for (let i = 1; i < lines.length; i++) {
                  const values = parseCSVLine(lines[i]);
                  const datetimeStr = values[datetimeIdx];
                  if (!datetimeStr) continue;

                  const dt = DateTime.fromISO(datetimeStr);
                  if (!dt.isValid) continue;

                  const ts = dt.plus({ hours: 1 }).toMillis();
                  const windSpeed = windSpeed100Idx >= 0 && values[windSpeed100Idx]
                    ? parseFloat(values[windSpeed100Idx])
                    : parseFloat(values[windSpeedIdx]) || 0;

                  if (!isNaN(windSpeed)) {
                    windMap.set(ts, windSpeed);
                    loadedCount++;
                  }
                }
              }
            }
          }
          currentDate = currentDate.plus({ days: 1 });
        }

        clusterWindData.set(cluster.clusterId, windMap);
      }

      // Evaluate each station
      console.log('\n📈 Evaluating MREC model accuracy...\n');
      console.log('┌───────────────────┬──────────┬──────────┬──────────┬─────────┐');
      console.log('│ Station           │   MAPE   │   RMSE   │   MAE    │ Samples │');
      console.log('├───────────────────┼──────────┼──────────┼──────────┼─────────┤');

      let totalMAPE = 0;
      let stationCount = 0;

      for (const [stationCode, model] of mrecModels) {
        const clusterId = capacityFactorService.getClusterForStation(stationCode);
        if (!clusterId) continue;

        const windMap = clusterWindData.get(clusterId);
        if (!windMap) continue;

        // Get actual values for this station
        const stationActual = actualData.filter(d => d.stationCode === stationCode);

        let sumAbsPercentError = 0;
        let sumSquaredError = 0;
        let sumAbsError = 0;
        let validCount = 0;

        for (const record of stationActual) {
          const ts = record.datetime.getTime();
          const windSpeed = windMap.get(ts);

          if (windSpeed !== undefined) {
            const predicted = model.predict(windSpeed);
            const actual = record.capacityFactor;

            const error = predicted - actual;
            sumSquaredError += error * error;
            sumAbsError += Math.abs(error);

            // MAPE: only count when actual > 0.01 to avoid division issues
            if (actual > 0.01) {
              sumAbsPercentError += Math.abs(error / actual);
              validCount++;
            }
          }
        }

        if (validCount > 0) {
          const mape = (sumAbsPercentError / validCount) * 100;
          const rmse = Math.sqrt(sumSquaredError / stationActual.length);
          const mae = sumAbsError / stationActual.length;

          console.log(`│ ${stationCode.padEnd(17)} │ ${mape.toFixed(1).padStart(7)}% │ ${rmse.toFixed(4).padStart(8)} │ ${mae.toFixed(4).padStart(8)} │ ${validCount.toString().padStart(7)} │`);

          totalMAPE += mape;
          stationCount++;
        }
      }

      console.log('└───────────────────┴──────────┴──────────┴──────────┴─────────┘');

      if (stationCount > 0) {
        console.log(`\n📊 Average MAPE across ${stationCount} wind stations: ${(totalMAPE / stationCount).toFixed(1)}%`);
      }

      closeDatabase();

    } catch (error: any) {
      console.error(`\n❌ Error: ${error.message}`);
      if (error.stack) console.error(error.stack);
      process.exit(1);
    }
  });

// CFAC MREC COMPARE - Compare all wind capacity factor methods
mrecCommand
  .command('compare')
  .description('Compare all wind capacity factor methods: Original Hybrid, MREC-only, MREC+ML Hybrid')
  .requiredOption('-t, --training <path>', 'Training data (July-Oct)')
  .requiredOption('-a, --actual <path>', 'Test/actual data (Nov-Dec)')
  .option('--cache <dir>', 'Weather cache directory', './weather_cache')
  .option('--stations <file>', 'Stations JSON file', 'src/data/stations.json')
  .action(async (options) => {
    try {
      const db = getDatabase();

      console.log('\n═══════════════════════════════════════════════════════════════════════════════');
      console.log('          COMPREHENSIVE WIND CAPACITY FACTOR MODEL COMPARISON                   ');
      console.log('═══════════════════════════════════════════════════════════════════════════════\n');

      // Load station metadata
      await capacityFactorService.loadStations(options.stations);
      const clusters = capacityFactorService.getClusters();

      // Helper: Proper CSV parsing
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

      // Step 1: Parse training data (July-October)
      console.log('📚 STEP 1: Loading training data (July-October)');
      console.log('─────────────────────────────────────────────────────────────────────────────\n');

      const trainingData = await capacityFactorService.parseCapacityFactorDirectory(
        options.training,
        (msg) => console.log(`   ${msg}`)
      );

      // Filter to training months only (July-October)
      const trainData = trainingData.filter(r => {
        const month = r.datetime.getMonth() + 1;
        return month >= 7 && month <= 10;
      });
      console.log(`\n   📊 Training samples: ${trainData.length} records (Jul-Oct)`);

      // Step 2: Parse test data (November-December)
      console.log('\n📋 STEP 2: Loading test data (November-December 7)');
      console.log('─────────────────────────────────────────────────────────────────────────────\n');

      const testData = await capacityFactorService.parseCapacityFactorDirectory(
        options.actual,
        (msg) => console.log(`   ${msg}`)
      );

      // Filter to test period only (November onwards)
      const testRecords = testData.filter(r => {
        const month = r.datetime.getMonth() + 1;
        return month >= 11;
      });
      console.log(`\n   📊 Test samples: ${testRecords.length} records (Nov-Dec)`);

      // Get wind station codes from training data
      const windStationCodes = [...new Set(trainData.map(r => r.stationCode))].filter(code =>
        code.includes('BURGOS') || code.includes('LAOAG') || code.includes('PAGUDPUD') ||
        code.includes('NABAS_W') || code.includes('STBARBRA_W')
      );
      console.log(`\n   🌀 Wind stations to evaluate: ${windStationCodes.join(', ')}`);

      // Get cluster IDs for wind stations
      const windClusterIds = new Set<string>();
      for (const code of windStationCodes) {
        const clusterId = capacityFactorService.getClusterForStation(code);
        if (clusterId) windClusterIds.add(clusterId);
      }

      // Step 3: Load weather data
      console.log('\n🌤️  STEP 3: Loading weather data');
      console.log('─────────────────────────────────────────────────────────────────────────────\n');

      const sortedTest = [...testRecords].sort((a, b) => a.datetime.getTime() - b.datetime.getTime());
      const testStart = DateTime.fromJSDate(sortedTest[0].datetime).toISODate()!;
      const testEnd = DateTime.fromJSDate(sortedTest[sortedTest.length - 1].datetime).toISODate()!;
      console.log(`   📅 Test period: ${testStart} to ${testEnd}`);

      // Also need training period weather for model training
      const sortedTrain = [...trainData].sort((a, b) => a.datetime.getTime() - b.datetime.getTime());
      const trainStart = DateTime.fromJSDate(sortedTrain[0].datetime).toISODate()!;
      const trainEnd = DateTime.fromJSDate(sortedTrain[sortedTrain.length - 1].datetime).toISODate()!;
      console.log(`   📅 Training period: ${trainStart} to ${trainEnd}`);

      const windClusters = clusters.filter(c => windClusterIds.has(c.clusterId));

      // Load weather for both periods
      const loadWeatherForPeriod = (start: string, end: string) => {
        const clusterWeather = new Map<string, Map<number, CFacWeatherFeatures>>();

        for (const cluster of windClusters) {
          const weatherMap = new Map<number, CFacWeatherFeatures>();
          let loadedCount = 0;

          let currentDate = DateTime.fromISO(start);
          const endDate = DateTime.fromISO(end);

          while (currentDate <= endDate) {
            const yearMonth = currentDate.toFormat('yyyy-MM');
            const dateStr = currentDate.toISODate()!;
            const cachePath = join(options.cache, cluster.clusterId, yearMonth, `${dateStr}.csv`);

            if (existsSync(cachePath)) {
              const csvContent = readFileSync(cachePath, 'utf-8');
              const lines = csvContent.split('\n').filter(l => l.trim());

              if (lines.length >= 2) {
                const headers = parseCSVLine(lines[0]).map(h => h.toLowerCase());
                const datetimeIdx = headers.indexOf('datetime');
                const tempIdx = headers.indexOf('temp');
                const windSpeedIdx = headers.indexOf('windspeed');
                const windSpeed100Idx = headers.indexOf('windspeed100');
                const windGustIdx = headers.indexOf('windgust');
                const cloudCoverIdx = headers.indexOf('cloudcover');
                const solarRadiationIdx = headers.indexOf('solarradiation');

                if (datetimeIdx >= 0 && windSpeedIdx >= 0) {
                  for (let i = 1; i < lines.length; i++) {
                    const values = parseCSVLine(lines[i]);
                    const datetimeStr = values[datetimeIdx];
                    if (!datetimeStr) continue;

                    const dt = DateTime.fromISO(datetimeStr);
                    if (!dt.isValid) continue;

                    const ts = dt.plus({ hours: 1 }).toMillis();

                    const weather: CFacWeatherFeatures = {
                      temperature: tempIdx >= 0 ? parseFloat(values[tempIdx]) || 25 : 25,
                      windSpeed: parseFloat(values[windSpeedIdx]) || 0,
                      windSpeed100: windSpeed100Idx >= 0 ? parseFloat(values[windSpeed100Idx]) : undefined,
                      windGust: windGustIdx >= 0 ? parseFloat(values[windGustIdx]) || 0 : 0,
                      cloudCover: cloudCoverIdx >= 0 ? parseFloat(values[cloudCoverIdx]) || 50 : 50,
                      solarRadiation: solarRadiationIdx >= 0 ? parseFloat(values[solarRadiationIdx]) || 0 : 0,
                    };

                    weatherMap.set(ts, weather);
                    loadedCount++;
                  }
                }
              }
            }
            currentDate = currentDate.plus({ days: 1 });
          }

          clusterWeather.set(cluster.clusterId, weatherMap);
          console.log(`   ${cluster.clusterId}: ${loadedCount} weather records`);
        }

        return clusterWeather;
      };

      console.log('\n   Loading training weather...');
      const trainWeather = loadWeatherForPeriod(trainStart, trainEnd);
      console.log('\n   Loading test weather...');
      const testWeather = loadWeatherForPeriod(testStart, testEnd);

      // Step 4: Train models
      console.log('\n🔧 STEP 4: Training models');
      console.log('─────────────────────────────────────────────────────────────────────────────\n');

      // 4a: Calibrate MREC from training data
      console.log('   🅰️  Calibrating MREC models (iPool-style three-tier)...');
      const mrecCalibrationData: MRECCalibrationData[] = [];

      for (const record of trainData) {
        if (!windStationCodes.includes(record.stationCode)) continue;

        const clusterId = capacityFactorService.getClusterForStation(record.stationCode);
        if (!clusterId) continue;

        const weatherMap = trainWeather.get(clusterId);
        if (!weatherMap) continue;

        const ts = record.datetime.getTime();
        const weather = weatherMap.get(ts);
        if (!weather) continue;

        mrecCalibrationData.push({
          datetime: record.datetime,
          stationCode: record.stationCode,
          capacityFactor: record.capacityFactor,
          windSpeed: weather.windSpeed
        });
      }

      const mrecModels = await calibrateAllMREC(mrecCalibrationData, (msg: string) => console.log(`      ${msg}`));
      console.log(`\n      ✅ Calibrated ${mrecModels.size} MREC models`);

      // 4b: Train MREC+ML Hybrid
      console.log('\n   🅱️  Training MREC+ML Hybrid models...');

      // Build training samples for hybrid
      const hybridTrainingSamples: CFacTrainingSample[] = [];
      for (const record of trainData) {
        if (!windStationCodes.includes(record.stationCode)) continue;

        const clusterId = capacityFactorService.getClusterForStation(record.stationCode);
        if (!clusterId) continue;

        const weatherMap = trainWeather.get(clusterId);
        if (!weatherMap) continue;

        const ts = record.datetime.getTime();
        const weather = weatherMap.get(ts);
        if (!weather) continue;

        const dt = record.datetime;
        const dayOfWeek = dt.getDay();
        hybridTrainingSamples.push({
          stationCode: record.stationCode,
          datetime: record.datetime,
          stationType: StationType.WIND,
          actualCFac: record.capacityFactor,
          weather,
          hour: dt.getHours(),
          dayOfWeek,
          month: dt.getMonth() + 1,
          isWeekend: dayOfWeek === 0 || dayOfWeek === 6
        });
      }

      // Extract MREC factors for hybrid training
      const mrecFactorsList: import('./types/capacityFactor.js').MRECFactors[] = [];
      for (const [stationCode, model] of mrecModels) {
        const factors = model.getFactors();
        if (factors && factors.calibrated) {
          mrecFactorsList.push(factors);
        }
      }

      const hybridModels = await trainAllMRECHybrid(
        mrecFactorsList,
        hybridTrainingSamples,
        (msg: string) => console.log(`      ${msg}`)
      );
      console.log(`\n      ✅ Trained ${hybridModels.size} MREC+ML Hybrid models`);

      // Step 5: Evaluate on test data
      console.log('\n📊 STEP 5: Evaluating models on test data (Nov 1 - Dec 7)');
      console.log('─────────────────────────────────────────────────────────────────────────────\n');

      // Results storage
      interface StationResults {
        mrecMAPE: number;
        hybridMAPE: number;
        samples: number;
      }
      const results = new Map<string, StationResults>();

      for (const stationCode of windStationCodes) {
        const mrecModel = mrecModels.get(stationCode);
        const hybridModel = hybridModels.get(stationCode);

        if (!mrecModel || !hybridModel) continue;

        const clusterId = capacityFactorService.getClusterForStation(stationCode);
        if (!clusterId) continue;

        const weatherMap = testWeather.get(clusterId);
        if (!weatherMap) continue;

        // Get test records for this station
        const stationTestRecords = testRecords.filter(r => r.stationCode === stationCode);
        if (stationTestRecords.length < 10) continue;

        let mrecErrorSum = 0;
        let hybridErrorSum = 0;
        let validCount = 0;

        for (const record of stationTestRecords) {
          const ts = record.datetime.getTime();
          const weather = weatherMap.get(ts);
          if (!weather) continue;

          const actual = record.capacityFactor;
          if (actual < 0.01) continue; // Skip near-zero for MAPE

          const windSpeed = weather.windSpeed;
          const mrecPred = mrecModel.predict(windSpeed);
          const hybridPred = hybridModel.predict(weather, record.datetime);

          mrecErrorSum += Math.abs((mrecPred - actual) / actual);
          hybridErrorSum += Math.abs((hybridPred - actual) / actual);
          validCount++;
        }

        if (validCount > 0) {
          results.set(stationCode, {
            mrecMAPE: (mrecErrorSum / validCount) * 100,
            hybridMAPE: (hybridErrorSum / validCount) * 100,
            samples: validCount
          });
        }
      }

      // Print results table
      console.log('┌───────────────────┬─────────────────┬───────────────────┬─────────────┬─────────┐');
      console.log('│ Station           │  MREC-only MAPE │  MREC+ML MAPE     │ Improvement │ Samples │');
      console.log('├───────────────────┼─────────────────┼───────────────────┼─────────────┼─────────┤');

      let totalMrecMAPE = 0;
      let totalHybridMAPE = 0;
      let stationCount = 0;

      for (const [stationCode, result] of results) {
        const improvement = ((result.mrecMAPE - result.hybridMAPE) / result.mrecMAPE) * 100;
        console.log(`│ ${stationCode.padEnd(17)} │ ${result.mrecMAPE.toFixed(1).padStart(13)}% │ ${result.hybridMAPE.toFixed(1).padStart(15)}% │ ${(improvement >= 0 ? '+' : '') + improvement.toFixed(1).padStart(9)}% │ ${result.samples.toString().padStart(7)} │`);

        totalMrecMAPE += result.mrecMAPE;
        totalHybridMAPE += result.hybridMAPE;
        stationCount++;
      }

      console.log('└───────────────────┴─────────────────┴───────────────────┴─────────────┴─────────┘');

      // Summary
      if (stationCount > 0) {
        const avgMrecMAPE = totalMrecMAPE / stationCount;
        const avgHybridMAPE = totalHybridMAPE / stationCount;
        const overallImprovement = ((avgMrecMAPE - avgHybridMAPE) / avgMrecMAPE) * 100;

        console.log('\n═══════════════════════════════════════════════════════════════════════════════');
        console.log('                              FINAL SUMMARY                                     ');
        console.log('═══════════════════════════════════════════════════════════════════════════════\n');

        console.log('   Test Period: November 1 - December 7, 2025');
        console.log(`   Stations Evaluated: ${stationCount}`);
        console.log('');
        console.log('   ┌─────────────────────────┬────────────────────┐');
        console.log('   │ Model                   │ Average MAPE       │');
        console.log('   ├─────────────────────────┼────────────────────┤');
        console.log(`   │ MREC-only (iPool-style) │ ${avgMrecMAPE.toFixed(1).padStart(14)}%   │`);
        console.log(`   │ MREC + ML Hybrid        │ ${avgHybridMAPE.toFixed(1).padStart(14)}%   │`);
        console.log('   └─────────────────────────┴────────────────────┘');
        console.log('');
        console.log(`   📈 MREC+ML Hybrid improvement over MREC-only: ${overallImprovement > 0 ? '+' : ''}${overallImprovement.toFixed(1)}%`);
        console.log('');
        console.log('   💡 Key Insights:');
        console.log('      - MREC provides strong baseline with three-tier piecewise model');
        console.log('      - ML residual learning captures temporal/atmospheric patterns');
        console.log('      - Hybrid approach combines interpretability with adaptability');
        console.log('');
      }

      closeDatabase();
      console.log('✅ Comparison complete!\n');

    } catch (error: any) {
      console.error(`\n❌ Error: ${error.message}`);
      if (error.stack) console.error(error.stack);
      process.exit(1);
    }
  });

// CFAC MREC COMPARE3 - Compare all three wind methods including Weather-Only Hybrid
mrecCommand
  .command('compare3')
  .description('Compare wind models: MREC-only, MREC+ML (temporal), MREC+ML (weather-only)')
  .requiredOption('-t, --training <path>', 'Training data (July-Oct)')
  .requiredOption('-a, --actual <path>', 'Test/actual data (Nov-Dec)')
  .option('--cache <dir>', 'Weather cache directory', './weather_cache')
  .option('--stations <file>', 'Stations JSON file', 'src/data/stations.json')
  .action(async (options) => {
    try {
      const db = getDatabase();

      console.log('\n═══════════════════════════════════════════════════════════════════════════════════════════════');
      console.log('          THREE-WAY WIND CAPACITY FACTOR MODEL COMPARISON                                        ');
      console.log('   MREC-only vs MREC+ML (Temporal) vs MREC+ML (Weather-Only)                                    ');
      console.log('═══════════════════════════════════════════════════════════════════════════════════════════════\n');

      // Load station metadata
      await capacityFactorService.loadStations(options.stations);
      const clusters = capacityFactorService.getClusters();

      // Helper: Proper CSV parsing
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

      // Step 1: Parse training data (July-October)
      console.log('📚 STEP 1: Loading training data (July-October)');
      console.log('─────────────────────────────────────────────────────────────────────────────\n');

      const trainingData = await capacityFactorService.parseCapacityFactorDirectory(
        options.training,
        (msg) => console.log(`   ${msg}`)
      );

      // Filter to training months only (July-October)
      const trainData = trainingData.filter(r => {
        const month = r.datetime.getMonth() + 1;
        return month >= 7 && month <= 10;
      });
      console.log(`\n   Training samples: ${trainData.length} records (Jul-Oct)`);

      // Step 2: Parse test data (November-December)
      console.log('\n📋 STEP 2: Loading test data (November-December)');
      console.log('─────────────────────────────────────────────────────────────────────────────\n');

      const testData = await capacityFactorService.parseCapacityFactorDirectory(
        options.actual,
        (msg) => console.log(`   ${msg}`)
      );

      // Filter to test period only (November onwards)
      const testRecords = testData.filter(r => {
        const month = r.datetime.getMonth() + 1;
        return month >= 11;
      });
      console.log(`\n   Test samples: ${testRecords.length} records (Nov-Dec)`);

      // Get wind station codes from training data
      const windStationCodes = [...new Set(trainData.map(r => r.stationCode))].filter(code =>
        code.includes('BURGOS') || code.includes('LAOAG') || code.includes('PAGUDPUD') ||
        code.includes('NABAS_W') || code.includes('STBARBRA_W')
      );
      console.log(`\n   Wind stations to evaluate: ${windStationCodes.join(', ')}`);

      // Get cluster IDs for wind stations
      const windClusterIds = new Set<string>();
      for (const code of windStationCodes) {
        const clusterId = capacityFactorService.getClusterForStation(code);
        if (clusterId) windClusterIds.add(clusterId);
      }

      // Step 3: Load weather data
      console.log('\n🌤️  STEP 3: Loading weather data');
      console.log('─────────────────────────────────────────────────────────────────────────────\n');

      const sortedTest = [...testRecords].sort((a, b) => a.datetime.getTime() - b.datetime.getTime());
      const testStart = DateTime.fromJSDate(sortedTest[0].datetime).toISODate()!;
      const testEnd = DateTime.fromJSDate(sortedTest[sortedTest.length - 1].datetime).toISODate()!;
      console.log(`   Test period: ${testStart} to ${testEnd}`);

      // Also need training period weather for model training
      const sortedTrain = [...trainData].sort((a, b) => a.datetime.getTime() - b.datetime.getTime());
      const trainStart = DateTime.fromJSDate(sortedTrain[0].datetime).toISODate()!;
      const trainEnd = DateTime.fromJSDate(sortedTrain[sortedTrain.length - 1].datetime).toISODate()!;
      console.log(`   Training period: ${trainStart} to ${trainEnd}`);

      const windClusters = clusters.filter(c => windClusterIds.has(c.clusterId));

      // Load weather for both periods
      const loadWeatherForPeriod = (start: string, end: string) => {
        const clusterWeather = new Map<string, Map<number, CFacWeatherFeatures>>();

        for (const cluster of windClusters) {
          const weatherMap = new Map<number, CFacWeatherFeatures>();
          let loadedCount = 0;

          let currentDate = DateTime.fromISO(start);
          const endDate = DateTime.fromISO(end);

          while (currentDate <= endDate) {
            const yearMonth = currentDate.toFormat('yyyy-MM');
            const dateStr = currentDate.toISODate()!;
            const cachePath = join(options.cache, cluster.clusterId, yearMonth, `${dateStr}.csv`);

            if (existsSync(cachePath)) {
              const csvContent = readFileSync(cachePath, 'utf-8');
              const lines = csvContent.split('\n').filter(l => l.trim());

              if (lines.length >= 2) {
                const headers = parseCSVLine(lines[0]).map(h => h.toLowerCase());
                const datetimeIdx = headers.indexOf('datetime');
                const tempIdx = headers.indexOf('temp');
                const windSpeedIdx = headers.indexOf('windspeed');
                const windSpeed100Idx = headers.indexOf('windspeed100');
                const windGustIdx = headers.indexOf('windgust');
                const cloudCoverIdx = headers.indexOf('cloudcover');
                const solarRadiationIdx = headers.indexOf('solarradiation');

                if (datetimeIdx >= 0 && windSpeedIdx >= 0) {
                  for (let i = 1; i < lines.length; i++) {
                    const values = parseCSVLine(lines[i]);
                    const datetimeStr = values[datetimeIdx];
                    if (!datetimeStr) continue;

                    const dt = DateTime.fromISO(datetimeStr);
                    if (!dt.isValid) continue;

                    const ts = dt.plus({ hours: 1 }).toMillis();

                    const weather: CFacWeatherFeatures = {
                      temperature: tempIdx >= 0 ? parseFloat(values[tempIdx]) || 25 : 25,
                      windSpeed: parseFloat(values[windSpeedIdx]) || 0,
                      windSpeed100: windSpeed100Idx >= 0 ? parseFloat(values[windSpeed100Idx]) : undefined,
                      windGust: windGustIdx >= 0 ? parseFloat(values[windGustIdx]) || 0 : 0,
                      cloudCover: cloudCoverIdx >= 0 ? parseFloat(values[cloudCoverIdx]) || 50 : 50,
                      solarRadiation: solarRadiationIdx >= 0 ? parseFloat(values[solarRadiationIdx]) || 0 : 0,
                    };

                    weatherMap.set(ts, weather);
                    loadedCount++;
                  }
                }
              }
            }
            currentDate = currentDate.plus({ days: 1 });
          }

          clusterWeather.set(cluster.clusterId, weatherMap);
          console.log(`   ${cluster.clusterId}: ${loadedCount} weather records`);
        }

        return clusterWeather;
      };

      console.log('\n   Loading training weather...');
      const trainWeather = loadWeatherForPeriod(trainStart, trainEnd);
      console.log('\n   Loading test weather...');
      const testWeather = loadWeatherForPeriod(testStart, testEnd);

      // Step 4: Train all three model types
      console.log('\n🔧 STEP 4: Training all three model types');
      console.log('─────────────────────────────────────────────────────────────────────────────\n');

      // 4a: Calibrate MREC from training data
      console.log('   [A] Calibrating MREC models (iPool-style three-tier)...');
      const mrecCalibrationData: MRECCalibrationData[] = [];

      for (const record of trainData) {
        if (!windStationCodes.includes(record.stationCode)) continue;

        const clusterId = capacityFactorService.getClusterForStation(record.stationCode);
        if (!clusterId) continue;

        const weatherMap = trainWeather.get(clusterId);
        if (!weatherMap) continue;

        const ts = record.datetime.getTime();
        const weather = weatherMap.get(ts);
        if (!weather) continue;

        mrecCalibrationData.push({
          datetime: record.datetime,
          stationCode: record.stationCode,
          capacityFactor: record.capacityFactor,
          windSpeed: weather.windSpeed
        });
      }

      const mrecModels = await calibrateAllMREC(mrecCalibrationData, (msg: string) => console.log(`      ${msg}`));
      console.log(`\n      Calibrated ${mrecModels.size} MREC models`);

      // 4b: Build training samples for ML hybrids
      const hybridTrainingSamples: CFacTrainingSample[] = [];
      for (const record of trainData) {
        if (!windStationCodes.includes(record.stationCode)) continue;

        const clusterId = capacityFactorService.getClusterForStation(record.stationCode);
        if (!clusterId) continue;

        const weatherMap = trainWeather.get(clusterId);
        if (!weatherMap) continue;

        const ts = record.datetime.getTime();
        const weather = weatherMap.get(ts);
        if (!weather) continue;

        const dt = record.datetime;
        const dayOfWeek = dt.getDay();
        hybridTrainingSamples.push({
          stationCode: record.stationCode,
          datetime: record.datetime,
          stationType: StationType.WIND,
          actualCFac: record.capacityFactor,
          weather,
          hour: dt.getHours(),
          dayOfWeek,
          month: dt.getMonth() + 1,
          isWeekend: dayOfWeek === 0 || dayOfWeek === 6
        });
      }

      // Extract MREC factors for hybrid training
      const mrecFactorsList: import('./types/capacityFactor.js').MRECFactors[] = [];
      for (const [stationCode, model] of mrecModels) {
        const factors = model.getFactors();
        if (factors && factors.calibrated) {
          mrecFactorsList.push(factors);
        }
      }

      // 4c: Train MREC+ML Hybrid (with temporal features - the overfitting one)
      console.log('\n   [B] Training MREC+ML Hybrid (temporal features)...');
      const temporalHybridModels = await trainAllMRECHybrid(
        mrecFactorsList,
        hybridTrainingSamples,
        (msg: string) => console.log(`      ${msg}`)
      );
      console.log(`\n      Trained ${temporalHybridModels.size} Temporal Hybrid models`);

      // 4d: Train MREC+ML Hybrid (weather-only features - the new approach)
      console.log('\n   [C] Training MREC+ML Hybrid (weather-only features)...');
      const weatherHybridModels = await trainAllWeatherHybrid(
        mrecFactorsList,
        hybridTrainingSamples,
        false,  // asymmetricLoss
        (msg: string) => console.log(`      ${msg}`)
      );
      console.log(`\n      Trained ${weatherHybridModels.size} Weather-Only Hybrid models`);

      // Step 5: Evaluate all three on test data
      console.log('\n📊 STEP 5: Evaluating all models on test data (Nov-Dec)');
      console.log('─────────────────────────────────────────────────────────────────────────────\n');

      // Results storage
      interface StationResults {
        mrecMAPE: number;
        temporalMAPE: number;
        weatherMAPE: number;
        samples: number;
      }
      const results = new Map<string, StationResults>();

      for (const stationCode of windStationCodes) {
        const mrecModel = mrecModels.get(stationCode);
        const temporalModel = temporalHybridModels.get(stationCode);
        const weatherModel = weatherHybridModels.get(stationCode);

        if (!mrecModel || !temporalModel || !weatherModel) continue;

        const clusterId = capacityFactorService.getClusterForStation(stationCode);
        if (!clusterId) continue;

        const weatherMap = testWeather.get(clusterId);
        if (!weatherMap) continue;

        // Get test records for this station
        const stationTestRecords = testRecords.filter(r => r.stationCode === stationCode);
        if (stationTestRecords.length < 10) continue;

        let mrecErrorSum = 0;
        let temporalErrorSum = 0;
        let weatherErrorSum = 0;
        let validCount = 0;

        for (const record of stationTestRecords) {
          const ts = record.datetime.getTime();
          const weather = weatherMap.get(ts);
          if (!weather) continue;

          const actual = record.capacityFactor;
          if (actual < 0.01) continue; // Skip near-zero for MAPE

          const windSpeed = weather.windSpeed;
          const mrecPred = mrecModel.predict(windSpeed);
          const temporalPred = temporalModel.predict(weather, record.datetime);
          const weatherPred = weatherModel.predict(weather, record.datetime);

          mrecErrorSum += Math.abs((mrecPred - actual) / actual);
          temporalErrorSum += Math.abs((temporalPred - actual) / actual);
          weatherErrorSum += Math.abs((weatherPred - actual) / actual);
          validCount++;
        }

        if (validCount > 0) {
          results.set(stationCode, {
            mrecMAPE: (mrecErrorSum / validCount) * 100,
            temporalMAPE: (temporalErrorSum / validCount) * 100,
            weatherMAPE: (weatherErrorSum / validCount) * 100,
            samples: validCount
          });
        }
      }

      // Print results table
      console.log('┌───────────────────┬─────────────┬──────────────────┬───────────────────┬─────────┐');
      console.log('│ Station           │  MREC MAPE  │  Temporal Hybrid │  Weather Hybrid   │ Samples │');
      console.log('├───────────────────┼─────────────┼──────────────────┼───────────────────┼─────────┤');

      let totalMrecMAPE = 0;
      let totalTemporalMAPE = 0;
      let totalWeatherMAPE = 0;
      let stationCount = 0;

      for (const [stationCode, result] of results) {
        // Find best model for this station
        const best = Math.min(result.mrecMAPE, result.temporalMAPE, result.weatherMAPE);
        const mrecMark = result.mrecMAPE === best ? '*' : ' ';
        const temporalMark = result.temporalMAPE === best ? '*' : ' ';
        const weatherMark = result.weatherMAPE === best ? '*' : ' ';

        console.log(`│ ${stationCode.padEnd(17)} │ ${result.mrecMAPE.toFixed(1).padStart(9)}%${mrecMark}│ ${result.temporalMAPE.toFixed(1).padStart(14)}%${temporalMark}│ ${result.weatherMAPE.toFixed(1).padStart(15)}%${weatherMark}│ ${result.samples.toString().padStart(7)} │`);

        totalMrecMAPE += result.mrecMAPE;
        totalTemporalMAPE += result.temporalMAPE;
        totalWeatherMAPE += result.weatherMAPE;
        stationCount++;
      }

      console.log('└───────────────────┴─────────────┴──────────────────┴───────────────────┴─────────┘');
      console.log('   (* indicates best performing model for each station)');

      // Summary
      if (stationCount > 0) {
        const avgMrecMAPE = totalMrecMAPE / stationCount;
        const avgTemporalMAPE = totalTemporalMAPE / stationCount;
        const avgWeatherMAPE = totalWeatherMAPE / stationCount;

        console.log('\n═══════════════════════════════════════════════════════════════════════════════════════════════');
        console.log('                                    FINAL SUMMARY                                              ');
        console.log('═══════════════════════════════════════════════════════════════════════════════════════════════\n');

        console.log('   Test Period: November 1 - December 7, 2025');
        console.log(`   Stations Evaluated: ${stationCount}`);
        console.log('');
        console.log('   ┌─────────────────────────────────┬────────────────────┐');
        console.log('   │ Model                           │ Average MAPE       │');
        console.log('   ├─────────────────────────────────┼────────────────────┤');
        console.log(`   │ MREC-only (iPool baseline)      │ ${avgMrecMAPE.toFixed(1).padStart(14)}%   │`);
        console.log(`   │ MREC+ML Hybrid (Temporal)       │ ${avgTemporalMAPE.toFixed(1).padStart(14)}%   │`);
        console.log(`   │ MREC+ML Hybrid (Weather-Only)   │ ${avgWeatherMAPE.toFixed(1).padStart(14)}%   │`);
        console.log('   └─────────────────────────────────┴────────────────────┘');
        console.log('');

        // Determine winner
        const bestMAPE = Math.min(avgMrecMAPE, avgTemporalMAPE, avgWeatherMAPE);
        let winner = '';
        if (bestMAPE === avgMrecMAPE) winner = 'MREC-only';
        else if (bestMAPE === avgWeatherMAPE) winner = 'MREC+ML Weather-Only Hybrid';
        else winner = 'MREC+ML Temporal Hybrid';

        console.log(`   🏆 Best Model: ${winner} with ${bestMAPE.toFixed(1)}% MAPE`);
        console.log('');

        // Insights
        console.log('   💡 Key Insights:');
        console.log('');
        if (avgTemporalMAPE > avgMrecMAPE) {
          console.log('      ⚠️  Temporal Hybrid OVERFIT: Month encoding memorized Jul-Oct patterns');
          console.log('         that don\'t transfer to Nov-Dec monsoon season transition.');
        }
        if (avgWeatherMAPE < avgTemporalMAPE) {
          console.log('      ✅ Weather-Only Hybrid avoids overfitting by using only weather features');
          console.log('         (gust ratio, temperature, wind speed) without calendar time.');
        }
        if (avgWeatherMAPE < avgMrecMAPE) {
          console.log('      📈 Weather-Only ML improves on MREC by learning weather-specific corrections');
          console.log('         like turbulence effects and air density variations.');
        }
        if (avgMrecMAPE <= avgWeatherMAPE) {
          console.log('      ⚡ MREC\'s simplicity (5 parameters) provides robust generalization');
          console.log('         when ML can\'t reliably improve on the physics-based model.');
        }
        console.log('');
      }

      closeDatabase();
      console.log('✅ Three-way comparison complete!\n');

    } catch (error: any) {
      console.error(`\n❌ Error: ${error.message}`);
      if (error.stack) console.error(error.stack);
      process.exit(1);
    }
  });

// CFAC MREC COMPARE-PHYSICS - Compare new physics-based model against existing models
mrecCommand
  .command('compare-physics')
  .description('Compare Physics-Based model vs Weather-Only vs 4-Tier Hybrid')
  .requiredOption('-t, --training <path>', 'Training data (July-Oct)')
  .requiredOption('-a, --actual <path>', 'Test/actual data (Nov-Dec)')
  .option('--cache <dir>', 'Weather cache directory', './weather_cache')
  .option('--stations <file>', 'Stations JSON file', 'src/data/stations.json')
  .action(async (options) => {
    try {
      const db = getDatabase();

      console.log('\n═══════════════════════════════════════════════════════════════════════════════════════════════');
      console.log('          PHYSICS-BASED WIND MODEL COMPARISON                                                    ');
      console.log('   Weather-Only Hybrid vs 4-Tier Hybrid vs NEW Physics Hybrid                                   ');
      console.log('═══════════════════════════════════════════════════════════════════════════════════════════════\n');

      // Load station metadata
      await capacityFactorService.loadStations(options.stations);
      const clusters = capacityFactorService.getClusters();

      // Helper: Proper CSV parsing
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

      // Step 1: Parse training data
      console.log('📚 STEP 1: Loading training data (July-October)');
      console.log('─────────────────────────────────────────────────────────────────────────────\n');

      const trainingData = await capacityFactorService.parseCapacityFactorDirectory(
        options.training,
        (msg) => console.log(`   ${msg}`)
      );

      const trainData = trainingData.filter(r => {
        const month = r.datetime.getMonth() + 1;
        return month >= 7 && month <= 10;
      });
      console.log(`\n   Training samples: ${trainData.length} records (Jul-Oct)`);

      // Step 2: Parse test data
      console.log('\n📋 STEP 2: Loading test data (November-December)');
      console.log('─────────────────────────────────────────────────────────────────────────────\n');

      const testData = await capacityFactorService.parseCapacityFactorDirectory(
        options.actual,
        (msg) => console.log(`   ${msg}`)
      );

      const testRecords = testData.filter(r => {
        const month = r.datetime.getMonth() + 1;
        return month >= 11;
      });
      console.log(`\n   Test samples: ${testRecords.length} records (Nov-Dec)`);

      // Get wind station codes
      const windStationCodes = [...new Set(trainData.map(r => r.stationCode))].filter(code =>
        code.includes('BURGOS') || code.includes('LAOAG') || code.includes('PAGUDPUD') ||
        code.includes('NABAS_W') || code.includes('STBARBRA_W') || code.includes('DOLORES') ||
        code.includes('BVISTA')
      );
      console.log(`\n   Wind stations to evaluate: ${windStationCodes.join(', ')}`);

      const windClusterIds = new Set<string>();
      for (const code of windStationCodes) {
        const clusterId = capacityFactorService.getClusterForStation(code);
        if (clusterId) windClusterIds.add(clusterId);
      }

      // Step 3: Load weather data
      console.log('\n🌤️  STEP 3: Loading weather data');
      console.log('─────────────────────────────────────────────────────────────────────────────\n');

      const sortedTest = [...testRecords].sort((a, b) => a.datetime.getTime() - b.datetime.getTime());
      const testStart = DateTime.fromJSDate(sortedTest[0].datetime).toISODate()!;
      const testEnd = DateTime.fromJSDate(sortedTest[sortedTest.length - 1].datetime).toISODate()!;
      console.log(`   Test period: ${testStart} to ${testEnd}`);

      const sortedTrain = [...trainData].sort((a, b) => a.datetime.getTime() - b.datetime.getTime());
      const trainStart = DateTime.fromJSDate(sortedTrain[0].datetime).toISODate()!;
      const trainEnd = DateTime.fromJSDate(sortedTrain[sortedTrain.length - 1].datetime).toISODate()!;
      console.log(`   Training period: ${trainStart} to ${trainEnd}`);

      const windClusters = clusters.filter(c => windClusterIds.has(c.clusterId));

      const loadWeatherForPeriod = (start: string, end: string) => {
        const clusterWeather = new Map<string, Map<number, CFacWeatherFeatures>>();

        for (const cluster of windClusters) {
          const weatherMap = new Map<number, CFacWeatherFeatures>();
          let loadedCount = 0;

          let currentDate = DateTime.fromISO(start);
          const endDate = DateTime.fromISO(end);

          while (currentDate <= endDate) {
            const yearMonth = currentDate.toFormat('yyyy-MM');
            const dateStr = currentDate.toISODate()!;
            const cachePath = join(options.cache, cluster.clusterId, yearMonth, `${dateStr}.csv`);

            if (existsSync(cachePath)) {
              const csvContent = readFileSync(cachePath, 'utf-8');
              const lines = csvContent.split('\n').filter(l => l.trim());

              if (lines.length >= 2) {
                const headers = parseCSVLine(lines[0]).map(h => h.toLowerCase());
                const datetimeIdx = headers.indexOf('datetime');
                const tempIdx = headers.indexOf('temp');
                const windSpeedIdx = headers.indexOf('windspeed');
                const windSpeed100Idx = headers.indexOf('windspeed100');
                const windGustIdx = headers.indexOf('windgust');
                const cloudCoverIdx = headers.indexOf('cloudcover');

                if (datetimeIdx >= 0 && windSpeedIdx >= 0) {
                  for (let i = 1; i < lines.length; i++) {
                    const values = parseCSVLine(lines[i]);
                    const datetimeStr = values[datetimeIdx];
                    if (!datetimeStr) continue;

                    const dt = DateTime.fromISO(datetimeStr);
                    if (!dt.isValid) continue;

                    const ts = dt.plus({ hours: 1 }).toMillis();

                    const weather: CFacWeatherFeatures = {
                      temperature: tempIdx >= 0 ? parseFloat(values[tempIdx]) || 25 : 25,
                      windSpeed: parseFloat(values[windSpeedIdx]) || 0,
                      windSpeed100: windSpeed100Idx >= 0 ? parseFloat(values[windSpeed100Idx]) : undefined,
                      windGust: windGustIdx >= 0 ? parseFloat(values[windGustIdx]) || 0 : 0,
                      cloudCover: cloudCoverIdx >= 0 ? parseFloat(values[cloudCoverIdx]) || 50 : 50,
                      solarRadiation: 0,
                    };

                    weatherMap.set(ts, weather);
                    loadedCount++;
                  }
                }
              }
            }
            currentDate = currentDate.plus({ days: 1 });
          }

          clusterWeather.set(cluster.clusterId, weatherMap);
          console.log(`   ${cluster.clusterId}: ${loadedCount} weather records`);
        }

        return clusterWeather;
      };

      console.log('\n   Loading training weather...');
      const trainWeather = loadWeatherForPeriod(trainStart, trainEnd);
      console.log('\n   Loading test weather...');
      const testWeather = loadWeatherForPeriod(testStart, testEnd);

      // Step 4: Train all model types
      console.log('\n🔧 STEP 4: Training all model types');
      console.log('─────────────────────────────────────────────────────────────────────────────\n');

      // Build training samples
      const hybridTrainingSamples: CFacTrainingSample[] = [];
      for (const record of trainData) {
        if (!windStationCodes.includes(record.stationCode)) continue;

        const clusterId = capacityFactorService.getClusterForStation(record.stationCode);
        if (!clusterId) continue;

        const weatherMap = trainWeather.get(clusterId);
        if (!weatherMap) continue;

        const ts = record.datetime.getTime();
        const weather = weatherMap.get(ts);
        if (!weather) continue;

        const dt = record.datetime;
        const dayOfWeek = dt.getDay();
        hybridTrainingSamples.push({
          stationCode: record.stationCode,
          datetime: record.datetime,
          stationType: StationType.WIND,
          actualCFac: record.capacityFactor,
          weather,
          hour: dt.getHours(),
          dayOfWeek,
          month: dt.getMonth() + 1,
          isWeekend: dayOfWeek === 0 || dayOfWeek === 6
        });
      }

      // Calibrate MREC
      console.log('   [A] Calibrating MREC...');
      const mrecCalibrationData: MRECCalibrationData[] = hybridTrainingSamples.map(s => ({
        datetime: s.datetime,
        stationCode: s.stationCode,
        capacityFactor: s.actualCFac,
        windSpeed: s.weather.windSpeed
      }));

      const mrecModels = await calibrateAllMREC(mrecCalibrationData, (msg: string) => console.log(`      ${msg}`));

      const mrecFactorsList: import('./types/capacityFactor.js').MRECFactors[] = [];
      for (const [, model] of mrecModels) {
        const factors = model.getFactors();
        if (factors && factors.calibrated) {
          mrecFactorsList.push(factors);
        }
      }

      // Train Weather-Only Hybrid
      console.log('\n   [B] Training Weather-Only Hybrid...');
      const weatherHybridModels = await trainAllWeatherHybrid(
        mrecFactorsList,
        hybridTrainingSamples,
        false,
        (msg: string) => console.log(`      ${msg}`)
      );

      // Train 4-Tier Hybrid (the broken one)
      console.log('\n   [C] Training 4-Tier Hybrid (original)...');
      const tier4Models = await trainAll4TierHybrid(
        hybridTrainingSamples,
        false,
        (msg: string) => console.log(`      ${msg}`),
        false
      );

      // Train NEW Physics Hybrid
      console.log('\n   [D] Training NEW Physics Hybrid (fixed power curve)...');
      const physicsHybridModels = await trainAllPhysicsHybrid(
        hybridTrainingSamples,
        false,
        (msg: string) => console.log(`      ${msg}`),
        false
      );

      // Step 5: Evaluate on test data
      console.log('\n📊 STEP 5: Evaluating all models on test data (Nov-Dec)');
      console.log('─────────────────────────────────────────────────────────────────────────────\n');

      interface StationResults {
        weatherMAPE: number;
        tier4MAPE: number;
        physicsMAPE: number;
        samples: number;
      }
      const results = new Map<string, StationResults>();

      for (const stationCode of windStationCodes) {
        const weatherModel = weatherHybridModels.get(stationCode);
        const tier4Model = tier4Models.get(stationCode);
        const physicsModel = physicsHybridModels.get(stationCode);

        if (!weatherModel || !tier4Model || !physicsModel) continue;

        const clusterId = capacityFactorService.getClusterForStation(stationCode);
        if (!clusterId) continue;

        const weatherMap = testWeather.get(clusterId);
        if (!weatherMap) continue;

        const stationTestRecords = testRecords.filter(r => r.stationCode === stationCode);
        if (stationTestRecords.length < 10) continue;

        let weatherErrorSum = 0;
        let tier4ErrorSum = 0;
        let physicsErrorSum = 0;
        let validCount = 0;

        for (const record of stationTestRecords) {
          const ts = record.datetime.getTime();
          const weather = weatherMap.get(ts);
          if (!weather) continue;

          const actual = record.capacityFactor;
          if (actual < 0.01) continue;

          const weatherPred = weatherModel.predict(weather, record.datetime);
          const tier4Pred = tier4Model.predict(weather, record.datetime);
          const physicsPred = physicsModel.predict(weather, record.datetime);

          weatherErrorSum += Math.abs((weatherPred - actual) / actual);
          tier4ErrorSum += Math.abs((tier4Pred - actual) / actual);
          physicsErrorSum += Math.abs((physicsPred - actual) / actual);
          validCount++;
        }

        if (validCount > 0) {
          results.set(stationCode, {
            weatherMAPE: (weatherErrorSum / validCount) * 100,
            tier4MAPE: (tier4ErrorSum / validCount) * 100,
            physicsMAPE: (physicsErrorSum / validCount) * 100,
            samples: validCount
          });
        }
      }

      // Print results
      console.log('┌───────────────────┬───────────────────┬──────────────────┬───────────────────┬─────────┐');
      console.log('│ Station           │  Weather-Only     │  4-Tier (broken) │  Physics (NEW)    │ Samples │');
      console.log('├───────────────────┼───────────────────┼──────────────────┼───────────────────┼─────────┤');

      let totalWeatherMAPE = 0;
      let totalTier4MAPE = 0;
      let totalPhysicsMAPE = 0;
      let stationCount = 0;

      for (const [stationCode, result] of results) {
        const best = Math.min(result.weatherMAPE, result.tier4MAPE, result.physicsMAPE);
        const weatherMark = result.weatherMAPE === best ? '*' : ' ';
        const tier4Mark = result.tier4MAPE === best ? '*' : ' ';
        const physicsMark = result.physicsMAPE === best ? '*' : ' ';

        console.log(`│ ${stationCode.padEnd(17)} │ ${result.weatherMAPE.toFixed(1).padStart(15)}%${weatherMark}│ ${result.tier4MAPE.toFixed(1).padStart(14)}%${tier4Mark}│ ${result.physicsMAPE.toFixed(1).padStart(15)}%${physicsMark}│ ${result.samples.toString().padStart(7)} │`);

        totalWeatherMAPE += result.weatherMAPE;
        totalTier4MAPE += result.tier4MAPE;
        totalPhysicsMAPE += result.physicsMAPE;
        stationCount++;
      }

      console.log('└───────────────────┴───────────────────┴──────────────────┴───────────────────┴─────────┘');
      console.log('   (* indicates best performing model for each station)');

      if (stationCount > 0) {
        const avgWeatherMAPE = totalWeatherMAPE / stationCount;
        const avgTier4MAPE = totalTier4MAPE / stationCount;
        const avgPhysicsMAPE = totalPhysicsMAPE / stationCount;

        console.log('\n═══════════════════════════════════════════════════════════════════════════════════════════════');
        console.log('                                    FINAL SUMMARY                                              ');
        console.log('═══════════════════════════════════════════════════════════════════════════════════════════════\n');

        console.log('   ┌─────────────────────────────────┬────────────────────┐');
        console.log('   │ Model                           │ Average MAPE       │');
        console.log('   ├─────────────────────────────────┼────────────────────┤');
        console.log(`   │ Weather-Only Hybrid             │ ${avgWeatherMAPE.toFixed(1).padStart(14)}%   │`);
        console.log(`   │ 4-Tier Hybrid (broken)          │ ${avgTier4MAPE.toFixed(1).padStart(14)}%   │`);
        console.log(`   │ Physics Hybrid (NEW)            │ ${avgPhysicsMAPE.toFixed(1).padStart(14)}%   │`);
        console.log('   └─────────────────────────────────┴────────────────────┘');

        const bestMAPE = Math.min(avgWeatherMAPE, avgTier4MAPE, avgPhysicsMAPE);
        let winner = '';
        if (bestMAPE === avgPhysicsMAPE) winner = 'Physics Hybrid (NEW)';
        else if (bestMAPE === avgWeatherMAPE) winner = 'Weather-Only Hybrid';
        else winner = '4-Tier Hybrid';

        console.log(`\n   🏆 Best Model: ${winner} with ${bestMAPE.toFixed(1)}% MAPE`);

        // Calculate improvement
        const improvementOver4Tier = ((avgTier4MAPE - avgPhysicsMAPE) / avgTier4MAPE) * 100;
        const improvementOverWeather = ((avgWeatherMAPE - avgPhysicsMAPE) / avgWeatherMAPE) * 100;

        console.log('\n   📈 Physics Model Improvement:');
        console.log(`      vs 4-Tier (broken): ${improvementOver4Tier > 0 ? '+' : ''}${improvementOver4Tier.toFixed(1)}%`);
        console.log(`      vs Weather-Only:    ${improvementOverWeather > 0 ? '+' : ''}${improvementOverWeather.toFixed(1)}%`);
      }

      closeDatabase();
      console.log('\n✅ Physics model comparison complete!\n');

    } catch (error: any) {
      console.error(`\n❌ Error: ${error.message}`);
      if (error.stack) console.error(error.stack);
      process.exit(1);
    }
  });

// CFAC MREC SOLAR - Compare solar capacity factor methods
mrecCommand
  .command('solar')
  .description('Compare solar capacity factor methods: Physics-only, Hybrid (Physics+ML), MREC (iPool-style)')
  .requiredOption('-t, --training <path>', 'Training data (July-Oct)')
  .requiredOption('-a, --actual <path>', 'Test/actual data (Nov-Dec)')
  .option('--cache <dir>', 'Weather cache directory', './weather_cache')
  .option('--stations <file>', 'Stations JSON file', 'src/data/stations.json')
  .action(async (options) => {
    try {
      console.log('\n═══════════════════════════════════════════════════════════════════════════════');
      console.log('          COMPREHENSIVE SOLAR CAPACITY FACTOR MODEL COMPARISON                  ');
      console.log('═══════════════════════════════════════════════════════════════════════════════\n');

      // Load station metadata
      await capacityFactorService.loadStations(options.stations);
      const clusters = capacityFactorService.getClusters();

      // Helper: Proper CSV parsing
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

      // Step 1: Parse training data (July-October)
      console.log('📚 STEP 1: Loading training data (July-October)');
      console.log('─────────────────────────────────────────────────────────────────────────────\n');

      const trainingData = await capacityFactorService.parseCapacityFactorDirectory(
        options.training,
        (msg) => console.log(`   ${msg}`)
      );

      // Filter to training months only (July-October)
      const trainData = trainingData.filter(r => {
        const month = r.datetime.getMonth() + 1;
        return month >= 7 && month <= 10;
      });
      console.log(`\n   📊 Training samples: ${trainData.length} records (Jul-Oct)`);

      // Step 2: Parse test data (November-December)
      console.log('\n📋 STEP 2: Loading test data (November-December 7)');
      console.log('─────────────────────────────────────────────────────────────────────────────\n');

      const testData = await capacityFactorService.parseCapacityFactorDirectory(
        options.actual,
        (msg) => console.log(`   ${msg}`)
      );

      // Filter to test period only (November onwards)
      const testRecords = testData.filter(r => {
        const month = r.datetime.getMonth() + 1;
        return month >= 11;
      });
      console.log(`\n   📊 Test samples: ${testRecords.length} records (Nov-Dec)`);

      // Get solar station codes from training data (stations ending in _S)
      const solarStationCodes = [...new Set(trainData.map(r => r.stationCode))].filter(code =>
        code.endsWith('_S') && !code.includes('_S_') // Solar stations but not _S_A, _S_B, etc.
      ).slice(0, 10); // Limit to first 10 for manageable output
      console.log(`\n   ☀️  Solar stations to evaluate: ${solarStationCodes.length} stations`);
      console.log(`      ${solarStationCodes.slice(0, 5).join(', ')}${solarStationCodes.length > 5 ? '...' : ''}`);

      // Get cluster IDs for solar stations
      const solarClusterIds = new Set<string>();
      for (const code of solarStationCodes) {
        const clusterId = capacityFactorService.getClusterForStation(code);
        if (clusterId) solarClusterIds.add(clusterId);
      }

      // Step 3: Load weather data
      console.log('\n🌤️  STEP 3: Loading weather data');
      console.log('─────────────────────────────────────────────────────────────────────────────\n');

      const sortedTest = [...testRecords].sort((a, b) => a.datetime.getTime() - b.datetime.getTime());
      const testStart = DateTime.fromJSDate(sortedTest[0].datetime).toISODate()!;
      const testEnd = DateTime.fromJSDate(sortedTest[sortedTest.length - 1].datetime).toISODate()!;
      console.log(`   📅 Test period: ${testStart} to ${testEnd}`);

      const sortedTrain = [...trainData].sort((a, b) => a.datetime.getTime() - b.datetime.getTime());
      const trainStart = DateTime.fromJSDate(sortedTrain[0].datetime).toISODate()!;
      const trainEnd = DateTime.fromJSDate(sortedTrain[sortedTrain.length - 1].datetime).toISODate()!;
      console.log(`   📅 Training period: ${trainStart} to ${trainEnd}`);

      const solarClusters = clusters.filter(c => solarClusterIds.has(c.clusterId));

      // Load weather for both periods
      const loadWeatherForPeriod = (start: string, end: string) => {
        const clusterWeather = new Map<string, Map<number, CFacWeatherFeatures>>();

        for (const cluster of solarClusters) {
          const weatherMap = new Map<number, CFacWeatherFeatures>();
          let loadedCount = 0;

          let currentDate = DateTime.fromISO(start);
          const endDate = DateTime.fromISO(end);

          while (currentDate <= endDate) {
            const yearMonth = currentDate.toFormat('yyyy-MM');
            const dateStr = currentDate.toISODate()!;
            const cachePath = join(options.cache, cluster.clusterId, yearMonth, `${dateStr}.csv`);

            if (existsSync(cachePath)) {
              const csvContent = readFileSync(cachePath, 'utf-8');
              const lines = csvContent.split('\n').filter(l => l.trim());

              if (lines.length >= 2) {
                const headers = parseCSVLine(lines[0]).map(h => h.toLowerCase());
                const datetimeIdx = headers.indexOf('datetime');
                const tempIdx = headers.indexOf('temp');
                const windSpeedIdx = headers.indexOf('windspeed');
                const cloudCoverIdx = headers.indexOf('cloudcover');
                const solarRadiationIdx = headers.indexOf('solarradiation');

                if (datetimeIdx >= 0 && solarRadiationIdx >= 0) {
                  for (let i = 1; i < lines.length; i++) {
                    const values = parseCSVLine(lines[i]);
                    const datetimeStr = values[datetimeIdx];
                    if (!datetimeStr) continue;

                    const dt = DateTime.fromISO(datetimeStr);
                    if (!dt.isValid) continue;

                    const ts = dt.plus({ hours: 1 }).toMillis();

                    const weather: CFacWeatherFeatures = {
                      temperature: tempIdx >= 0 ? parseFloat(values[tempIdx]) || 25 : 25,
                      windSpeed: windSpeedIdx >= 0 ? parseFloat(values[windSpeedIdx]) || 0 : 0,
                      windGust: 0,
                      cloudCover: cloudCoverIdx >= 0 ? parseFloat(values[cloudCoverIdx]) || 50 : 50,
                      solarRadiation: parseFloat(values[solarRadiationIdx]) || 0,
                    };

                    weatherMap.set(ts, weather);
                    loadedCount++;
                  }
                }
              }
            }
            currentDate = currentDate.plus({ days: 1 });
          }

          clusterWeather.set(cluster.clusterId, weatherMap);
          console.log(`   ${cluster.clusterId}: ${loadedCount} weather records`);
        }

        return clusterWeather;
      };

      console.log('\n   Loading training weather...');
      const trainWeather = loadWeatherForPeriod(trainStart, trainEnd);
      console.log('\n   Loading test weather...');
      const testWeather = loadWeatherForPeriod(testStart, testEnd);

      // Step 4: Train models
      console.log('\n🔧 STEP 4: Training models');
      console.log('─────────────────────────────────────────────────────────────────────────────\n');

      // 4a: Calibrate Solar MREC from training data
      console.log('   🅰️  Calibrating Solar MREC models (iPool-style three-tier)...');
      const solarMrecCalibrationData: SolarMRECCalibrationData[] = [];

      for (const record of trainData) {
        if (!solarStationCodes.includes(record.stationCode)) continue;

        const clusterId = capacityFactorService.getClusterForStation(record.stationCode);
        if (!clusterId) continue;

        const weatherMap = trainWeather.get(clusterId);
        if (!weatherMap) continue;

        const ts = record.datetime.getTime();
        const weather = weatherMap.get(ts);
        if (!weather) continue;

        solarMrecCalibrationData.push({
          datetime: record.datetime,
          stationCode: record.stationCode,
          capacityFactor: record.capacityFactor,
          solarIrradiance: weather.solarRadiation
        });
      }

      const solarMrecModels = await calibrateAllSolarMREC(solarMrecCalibrationData, (msg: string) => console.log(`      ${msg}`));
      console.log(`\n      ✅ Calibrated ${solarMrecModels.size} Solar MREC models`);

      // 4b: Train Solar Hybrid (Physics + ML)
      console.log('\n   🅱️  Training Solar Hybrid models (Physics + ML)...');
      const solarHybridModels = new Map<string, SolarHybridModel>();

      for (const stationCode of solarStationCodes) {
        const clusterId = capacityFactorService.getClusterForStation(stationCode);
        if (!clusterId) continue;

        const weatherMap = trainWeather.get(clusterId);
        if (!weatherMap) continue;

        // Build training samples for this station
        const stationTrainSamples: CFacTrainingSample[] = [];
        for (const record of trainData) {
          if (record.stationCode !== stationCode) continue;

          const ts = record.datetime.getTime();
          const weather = weatherMap.get(ts);
          if (!weather) continue;

          const dt = record.datetime;
          const dayOfWeek = dt.getDay();
          stationTrainSamples.push({
            stationCode: record.stationCode,
            datetime: record.datetime,
            stationType: StationType.SOLAR,
            actualCFac: record.capacityFactor,
            weather,
            hour: dt.getHours(),
            dayOfWeek,
            month: dt.getMonth() + 1,
            isWeekend: dayOfWeek === 0 || dayOfWeek === 6
          });
        }

        if (stationTrainSamples.length < 50) continue;

        try {
          const hybridModel = new SolarHybridModel(stationCode);
          await hybridModel.train(stationTrainSamples);
          solarHybridModels.set(stationCode, hybridModel);
        } catch (err: any) {
          console.log(`      Could not train hybrid for ${stationCode}: ${err.message}`);
        }
      }
      console.log(`      ✅ Trained ${solarHybridModels.size} Solar Hybrid models`);

      // Step 5: Evaluate on test data
      console.log('\n📊 STEP 5: Evaluating models on test data (Nov 1 - Dec 7)');
      console.log('─────────────────────────────────────────────────────────────────────────────\n');

      // Physics-only model (same for all stations)
      const physicsModel = new SolarIrradianceModel();

      // Results storage
      interface SolarStationResults {
        physicsMAPE: number;
        hybridMAPE: number;
        mrecMAPE: number;
        samples: number;
      }
      const results = new Map<string, SolarStationResults>();

      for (const stationCode of solarStationCodes) {
        const mrecModel = solarMrecModels.get(stationCode);
        const hybridModel = solarHybridModels.get(stationCode);

        if (!mrecModel || !mrecModel.isCalibrated()) continue;

        const clusterId = capacityFactorService.getClusterForStation(stationCode);
        if (!clusterId) continue;

        const weatherMap = testWeather.get(clusterId);
        if (!weatherMap) continue;

        // Get test records for this station
        const stationTestRecords = testRecords.filter(r => r.stationCode === stationCode);
        if (stationTestRecords.length < 10) continue;

        let physicsErrorSum = 0;
        let hybridErrorSum = 0;
        let mrecErrorSum = 0;
        let validCount = 0;

        for (const record of stationTestRecords) {
          const ts = record.datetime.getTime();
          const weather = weatherMap.get(ts);
          if (!weather) continue;

          const actual = record.capacityFactor;
          // Only evaluate daylight hours with actual generation
          const hour = record.datetime.getHours();
          if (hour < 6 || hour > 18 || actual < 0.01) continue;

          const solarRadiation = weather.solarRadiation;
          const temperature = weather.temperature;

          const physicsPred = physicsModel.predict(solarRadiation, temperature);
          const mrecPred = mrecModel.predict(solarRadiation);
          const hybridPred = hybridModel ? hybridModel.predict(weather, record.datetime) : physicsPred;

          physicsErrorSum += Math.abs((physicsPred - actual) / actual);
          mrecErrorSum += Math.abs((mrecPred - actual) / actual);
          hybridErrorSum += Math.abs((hybridPred - actual) / actual);
          validCount++;
        }

        if (validCount > 0) {
          results.set(stationCode, {
            physicsMAPE: (physicsErrorSum / validCount) * 100,
            hybridMAPE: (hybridErrorSum / validCount) * 100,
            mrecMAPE: (mrecErrorSum / validCount) * 100,
            samples: validCount
          });
        }
      }

      // Print results table
      console.log('┌───────────────────┬───────────────┬───────────────┬───────────────┬─────────┐');
      console.log('│ Station           │ Physics MAPE  │ Hybrid MAPE   │  MREC MAPE    │ Samples │');
      console.log('├───────────────────┼───────────────┼───────────────┼───────────────┼─────────┤');

      let totalPhysicsMAPE = 0;
      let totalHybridMAPE = 0;
      let totalMrecMAPE = 0;
      let stationCount = 0;

      for (const [stationCode, result] of results) {
        const bestMAPE = Math.min(result.physicsMAPE, result.hybridMAPE, result.mrecMAPE);
        const physicsMarker = result.physicsMAPE === bestMAPE ? '*' : ' ';
        const hybridMarker = result.hybridMAPE === bestMAPE ? '*' : ' ';
        const mrecMarker = result.mrecMAPE === bestMAPE ? '*' : ' ';

        console.log(`│ ${stationCode.padEnd(17)} │ ${result.physicsMAPE.toFixed(1).padStart(10)}%${physicsMarker} │ ${result.hybridMAPE.toFixed(1).padStart(10)}%${hybridMarker} │ ${result.mrecMAPE.toFixed(1).padStart(10)}%${mrecMarker} │ ${result.samples.toString().padStart(7)} │`);

        totalPhysicsMAPE += result.physicsMAPE;
        totalHybridMAPE += result.hybridMAPE;
        totalMrecMAPE += result.mrecMAPE;
        stationCount++;
      }

      console.log('└───────────────────┴───────────────┴───────────────┴───────────────┴─────────┘');
      console.log('   * = Best performer for that station');

      // Summary
      if (stationCount > 0) {
        const avgPhysicsMAPE = totalPhysicsMAPE / stationCount;
        const avgHybridMAPE = totalHybridMAPE / stationCount;
        const avgMrecMAPE = totalMrecMAPE / stationCount;

        console.log('\n═══════════════════════════════════════════════════════════════════════════════');
        console.log('                           SOLAR MODEL SUMMARY                                 ');
        console.log('═══════════════════════════════════════════════════════════════════════════════\n');

        console.log('   Test Period: November 1 - December 7, 2025 (daylight hours only)');
        console.log(`   Stations Evaluated: ${stationCount}`);
        console.log('');
        console.log('   ┌────────────────────────────────┬────────────────────┐');
        console.log('   │ Model                          │ Average MAPE       │');
        console.log('   ├────────────────────────────────┼────────────────────┤');
        console.log(`   │ Physics-only (Irradiance)      │ ${avgPhysicsMAPE.toFixed(1).padStart(14)}%   │`);
        console.log(`   │ Physics + ML Hybrid            │ ${avgHybridMAPE.toFixed(1).padStart(14)}%   │`);
        console.log(`   │ MREC (iPool-style)             │ ${avgMrecMAPE.toFixed(1).padStart(14)}%   │`);
        console.log('   └────────────────────────────────┴────────────────────┘');
        console.log('');

        // Determine best model
        const minMAPE = Math.min(avgPhysicsMAPE, avgHybridMAPE, avgMrecMAPE);
        let bestModel = 'Physics-only';
        if (avgHybridMAPE === minMAPE) bestModel = 'Physics + ML Hybrid';
        if (avgMrecMAPE === minMAPE) bestModel = 'MREC (iPool-style)';

        console.log(`   🏆 Best Overall Model: ${bestModel} (${minMAPE.toFixed(1)}% MAPE)`);
        console.log('');
        console.log('   💡 Key Differences from Wind MREC:');
        console.log('      - Solar uses irradiance (W/m²) instead of wind speed (m/s)');
        console.log('      - No overflow protection (solar doesn\'t shut down from too much sun)');
        console.log('      - Same PoE thresholds: HIGH (top 10%), MID (10-30%), LOW (below 30%)');
        console.log('');
      }

      console.log('✅ Solar comparison complete!\n');

    } catch (error: any) {
      console.error(`\n❌ Error: ${error.message}`);
      if (error.stack) console.error(error.stack);
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

// INTERCONNECTOR command - Interconnector constraint analysis and forecasting
const interconnectorCmd = program
  .command('interconnector')
  .description('Interconnector constraint analysis and congestion forecasting');

// IMPORT command
interconnectorCmd
  .command('import')
  .description('Import RTDHS interconnector data into database')
  .requiredOption('-f, --file <path>', 'RTDHS CSV file or directory (Z:\\WESM FILES\\RTDHS\\)')
  .option('--start <date>', 'Start date YYYY-MM-DD (for directory import)')
  .option('--end <date>', 'End date YYYY-MM-DD (for directory import)')
  .action(async (options) => {
    console.log('\n🔄 Importing interconnector data...');

    try {
      const data = parseInterconnectorCsv(
        options.file,
        (msg) => console.log(`  ${msg}`),
        options.start,
        options.end
      );

      console.log(`\n📊 Parsed ${data.records.length} records`);
      console.log(`  Interconnectors: ${data.interconnectors.join(', ')}`);
      console.log(`  Date range: ${DateTime.fromJSDate(data.startDate).toISODate()} to ${DateTime.fromJSDate(data.endDate).toISODate()}`);
      console.log(`  Congestion events: ${data.totalCongestionEvents}`);

      for (const [interconnector, count] of data.congestionByInterconnector.entries()) {
        console.log(`    ${interconnector}: ${count} events`);
      }

      const db = getDatabase();
      const result = db.importInterconnectorRecords(data.records, options.file);
      closeDatabase();

      console.log(`\n✅ Import complete!`);
      console.log(`  Inserted: ${result.inserted} records`);
    } catch (error: any) {
      console.error(`\n❌ Error: ${error.message}`);
      process.exit(1);
    }
  });

// STATS command
interconnectorCmd
  .command('stats')
  .description('Display interconnector statistics and congestion history')
  .option('-i, --interconnector <name>', 'Filter by interconnector (MINVIS1, VISLUZ1)')
  .option('--start <date>', 'Start date YYYY-MM-DD')
  .option('--end <date>', 'End date YYYY-MM-DD')
  .action(async (options) => {
    console.log('\n📊 Interconnector Statistics\n');

    try {
      const db = getDatabase();
      const stats = db.getInterconnectorStats(
        options.interconnector,
        options.start,
        options.end
      );
      closeDatabase();

      if (stats.length === 0) {
        console.log('No data found. Import RTDHS data first using "interconnector import"');
        return;
      }

      for (const stat of stats) {
        console.log(`${stat.interconnector}:`);
        console.log(`  Total records: ${stat.totalRecords}`);
        console.log(`  Congestion events: ${stat.congestionEvents}`);
        console.log(`  Congestion rate: ${(stat.congestionRate * 100).toFixed(2)}%`);
        console.log(`  Average flow (from): ${stat.avgFlowFrom.toFixed(2)} MW`);
        console.log(`  Average flow (to): ${stat.avgFlowTo.toFixed(2)} MW`);
        console.log(`  Peak flow (from): ${stat.peakFlowFrom.toFixed(2)} MW`);
        console.log(`  Peak flow (to): ${stat.peakFlowTo.toFixed(2)} MW`);
        console.log(`  Date range: ${stat.dateRange.start} to ${stat.dateRange.end}\n`);
      }
    } catch (error: any) {
      console.error(`\n❌ Error: ${error.message}`);
      process.exit(1);
    }
  });

// TRAIN command
interconnectorCmd
  .command('train')
  .description('Train congestion prediction model')
  .option('--start <date>', 'Training start date YYYY-MM-DD')
  .option('--end <date>', 'Training end date YYYY-MM-DD')
  .option('-i, --interconnector <name>', 'Train for specific interconnector (default: both)')
  .option('-o, --output <dir>', 'Output directory for reports', './output')
  .option('--model <type>', 'Model type: regression, xgboost, both (default: both)', 'both')
  .action(async (options) => {
    console.log('\n🔄 Training interconnector congestion model...\n');

    try {
      // Validate model type
      const modelType = options.model.toLowerCase();
      if (!['regression', 'xgboost', 'both'].includes(modelType)) {
        console.error('❌ Invalid model type. Use: regression, xgboost, or both');
        process.exit(1);
      }

      const db = getDatabase();

      // Load interconnector data
      console.log('📊 Loading data from database...');
      const interconnectorRecords = db.getInterconnectorRecords(
        options.start,
        options.end,
        options.interconnector
      );

      if (interconnectorRecords.length === 0) {
        console.error('❌ No interconnector data found. Import RTDHS data first.');
        closeDatabase();
        process.exit(1);
      }

      // Load demand data
      const demandRecords = db.getDemandRecords(options.start, options.end);

      // Load weather data
      const weatherRecords = db.getWeatherRecords(options.start, options.end);

      closeDatabase();

      console.log(`  Interconnector records: ${interconnectorRecords.length}`);
      console.log(`  Demand records: ${demandRecords.length}`);
      console.log(`  Weather records: ${weatherRecords.length}`);

      if (demandRecords.length === 0 || weatherRecords.length === 0) {
        console.error('\n❌ Missing demand or weather data. Import historical data first.');
        process.exit(1);
      }

      // Build training samples
      console.log('\n🔧 Building training samples...');
      const samples = buildInterconnectorTrainingSamples(
        interconnectorRecords,
        demandRecords,
        weatherRecords
      );

      console.log(`  Training samples: ${samples.length}`);

      if (samples.length < 100) {
        console.error('❌ Not enough training samples (need at least 100). Import more historical data.');
        process.exit(1);
      }

      // Display constraint detection statistics
      console.log('\n📈 Constraint Detection Analysis:');
      const constrainedSamples = samples.filter(s => s.isActuallyConstrained);
      const flaggedSamples = samples.filter(s => s.isCongested);

      const constrainedAndFlagged = samples.filter(s => s.isActuallyConstrained && s.isCongested).length;
      const constrainedNotFlagged = samples.filter(s => s.isActuallyConstrained && !s.isCongested).length;
      const flaggedNotConstrained = samples.filter(s => !s.isActuallyConstrained && s.isCongested).length;

      console.log(`  Total constraint periods detected: ${constrainedSamples.length} (${(constrainedSamples.length / samples.length * 100).toFixed(2)}%)`);
      console.log(`  Total CONGESTION_FLAG events: ${flaggedSamples.length} (${(flaggedSamples.length / samples.length * 100).toFixed(2)}%)`);
      console.log(`\n  Comparison with CONGESTION_FLAG:`);
      console.log(`    Constrained + Flagged:     ${constrainedAndFlagged}`);
      console.log(`    Constrained (no flag):     ${constrainedNotFlagged}`);
      console.log(`    Flagged (not constrained): ${flaggedNotConstrained}`);

      // Constraint level distribution
      const levelCounts = new Map<number, number>();
      for (const sample of constrainedSamples) {
        if (sample.constraintLevel !== undefined) {
          levelCounts.set(sample.constraintLevel, (levelCounts.get(sample.constraintLevel) || 0) + 1);
        }
      }

      console.log(`\n  Constraint Level Distribution:`);
      const sortedLevels = Array.from(levelCounts.entries()).sort((a, b) => b[1] - a[1]);
      for (const [level, count] of sortedLevels.slice(0, 10)) {
        console.log(`    ${level.toString().padEnd(6)} MW: ${count} samples`);
      }

      const results: any[] = [];

      // Train regression model
      if (modelType === 'regression' || modelType === 'both') {
        console.log('\n🎯 Training Regression Model...');
        console.log('  Model: Logistic Regression (classification) + Linear Regression (flow prediction)');

        const regStartTime = Date.now();
        const model = new InterconnectorCongestionModel();
        const metrics = model.train(samples);
        const regTrainTime = Date.now() - regStartTime;

        results.push({
          type: 'regression',
          model,
          metrics,
          trainTime: regTrainTime
        });

        console.log(`\n✅ Regression Model Training Complete!`);
        console.log(`  Training time: ${(regTrainTime / 1000).toFixed(2)}s`);

        if (metrics.classWeights && metrics.classDistribution) {
          console.log(`\nClass Weighting:`);
          console.log(`  Class 0 (Not Constrained): ${metrics.classDistribution.class0} samples, weight: ${metrics.classWeights[0].toFixed(2)}`);
          console.log(`  Class 1 (Constrained):     ${metrics.classDistribution.class1} samples, weight: ${metrics.classWeights[1].toFixed(2)}`);
          const imbalanceRatio = (metrics.classDistribution.class0 / metrics.classDistribution.class1).toFixed(2);
          console.log(`  Class imbalance ratio: ${imbalanceRatio}:1`);
        }

        console.log(`\nClassification Metrics:`);
        console.log(`  Accuracy:  ${(metrics.accuracy * 100).toFixed(2)}%`);
        console.log(`  Precision: ${(metrics.precision * 100).toFixed(2)}%`);
        console.log(`  Recall:    ${(metrics.recall * 100).toFixed(2)}%`);
        console.log(`  F1 Score:  ${(metrics.f1Score * 100).toFixed(2)}%`);

        console.log(`\nConfusion Matrix:`);
        console.log(`  True Positives:  ${metrics.confusionMatrix.truePositive}`);
        console.log(`  True Negatives:  ${metrics.confusionMatrix.trueNegative}`);
        console.log(`  False Positives: ${metrics.confusionMatrix.falsePositive}`);
        console.log(`  False Negatives: ${metrics.confusionMatrix.falseNegative}`);

        console.log(`\nRegression Metrics (Flow Prediction):`);
        console.log(`  R² Score: ${metrics.r2Score.toFixed(4)}`);
        console.log(`  MAPE:     ${metrics.mape.toFixed(2)}%`);
        console.log(`  MAE:      ${metrics.mae.toFixed(2)} MW`);
        console.log(`  RMSE:     ${metrics.rmse.toFixed(2)} MW`);

        // Save model to database
        console.log('\n💾 Saving regression model to database...');
        const db2 = getDatabase();
        const modelId = db2.saveInterconnectorModel(
          `Regression ${DateTime.now().toFormat('yyyy-MM-dd HH:mm')}`,
          options.start || 'all',
          options.end || 'all',
          samples.length,
          metrics,
          model.serialize(),
          'regression',
          regTrainTime
        );
        closeDatabase();
        console.log(`  Model ID: ${modelId}`);
      }

      // Train XGBoost model
      if (modelType === 'xgboost' || modelType === 'both') {
        console.log('\n🎯 Training XGBoost Model...');
        console.log('  Model: XGBoost (classification) + XGBoost (regression)');
        console.log('  Hyperparameters: maxDepth=6, learningRate=0.1, nEstimators=200, subsample=0.8');
        console.log('  Note: scalePosWeight calculated automatically based on class distribution');

        const { InterconnectorXGBoostModel } = await import('./models/interconnector/InterconnectorXGBoostModel.js');

        const xgbStartTime = Date.now();
        const xgbModel = new InterconnectorXGBoostModel({
          maxDepth: 6,
          learningRate: 0.1,
          nEstimators: 200,
          minChildWeight: 1,
          subsample: 0.8
        });
        const xgbMetrics = xgbModel.train(samples);
        const xgbTrainTime = Date.now() - xgbStartTime;

        results.push({
          type: 'xgboost',
          model: xgbModel,
          metrics: xgbMetrics,
          trainTime: xgbTrainTime
        });

        console.log(`\n✅ XGBoost Model Training Complete!`);
        console.log(`  Training time: ${(xgbTrainTime / 1000).toFixed(2)}s`);

        if (xgbMetrics.scalePosWeight && xgbMetrics.classDistribution) {
          console.log(`\nClass Weighting:`);
          console.log(`  Negative samples (Not Constrained): ${xgbMetrics.classDistribution.negative}`);
          console.log(`  Positive samples (Constrained):     ${xgbMetrics.classDistribution.positive}`);
          console.log(`  scale_pos_weight: ${xgbMetrics.scalePosWeight.toFixed(2)}`);
          const imbalanceRatio = (xgbMetrics.classDistribution.negative / xgbMetrics.classDistribution.positive).toFixed(2);
          console.log(`  Class imbalance ratio: ${imbalanceRatio}:1`);
        }

        console.log(`\nClassification Metrics:`);
        console.log(`  Accuracy:  ${(xgbMetrics.accuracy * 100).toFixed(2)}%`);
        console.log(`  Precision: ${(xgbMetrics.precision * 100).toFixed(2)}%`);
        console.log(`  Recall:    ${(xgbMetrics.recall * 100).toFixed(2)}%`);
        console.log(`  F1 Score:  ${(xgbMetrics.f1Score * 100).toFixed(2)}%`);

        console.log(`\nConfusion Matrix:`);
        console.log(`  True Positives:  ${xgbMetrics.confusionMatrix.truePositive}`);
        console.log(`  True Negatives:  ${xgbMetrics.confusionMatrix.trueNegative}`);
        console.log(`  False Positives: ${xgbMetrics.confusionMatrix.falsePositive}`);
        console.log(`  False Negatives: ${xgbMetrics.confusionMatrix.falseNegative}`);

        console.log(`\nRegression Metrics (Flow Prediction):`);
        console.log(`  R² Score: ${xgbMetrics.r2Score.toFixed(4)}`);
        console.log(`  MAPE:     ${xgbMetrics.mape.toFixed(2)}%`);
        console.log(`  MAE:      ${xgbMetrics.mae.toFixed(2)} MW`);
        console.log(`  RMSE:     ${xgbMetrics.rmse.toFixed(2)} MW`);

        // Display feature importance
        const featureImportance = xgbModel.getFeatureImportance();
        const topFeatures = Array.from(featureImportance.entries())
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10);

        console.log(`\nTop 10 Important Features:`);
        for (const [name, importance] of topFeatures) {
          console.log(`  ${name.padEnd(25)} ${(importance * 100).toFixed(2)}%`);
        }

        // Save model to database
        console.log('\n💾 Saving XGBoost model to database...');
        const db3 = getDatabase();
        const xgbModelId = db3.saveInterconnectorModel(
          `XGBoost ${DateTime.now().toFormat('yyyy-MM-dd HH:mm')}`,
          options.start || 'all',
          options.end || 'all',
          samples.length,
          xgbMetrics,
          xgbModel.serialize(),
          'xgboost',
          xgbTrainTime
        );
        closeDatabase();
        console.log(`  Model ID: ${xgbModelId}`);
      }

      // Generate comparison report if both models were trained
      if (results.length === 2) {
        console.log('\n\n📊 MODEL COMPARISON REPORT');
        console.log('═'.repeat(80));

        const reg = results.find(r => r.type === 'regression');
        const xgb = results.find(r => r.type === 'xgboost');

        console.log('\n📈 CLASSIFICATION METRICS');
        console.log('-'.repeat(80));
        console.log(`${'Metric'.padEnd(20)} | ${'Regression'.padEnd(15)} | ${'XGBoost'.padEnd(15)} | ${'Winner'.padEnd(15)}`);
        console.log('-'.repeat(80));

        const compareMetric = (name: string, regVal: number, xgbVal: number, higherBetter: boolean = true) => {
          const winner = higherBetter
            ? (xgbVal > regVal ? 'XGBoost' : regVal > xgbVal ? 'Regression' : 'Tie')
            : (xgbVal < regVal ? 'XGBoost' : regVal < xgbVal ? 'Regression' : 'Tie');
          const regStr = `${(regVal * 100).toFixed(2)}%`.padEnd(15);
          const xgbStr = `${(xgbVal * 100).toFixed(2)}%`.padEnd(15);
          console.log(`${name.padEnd(20)} | ${regStr} | ${xgbStr} | ${winner}`);
        };

        compareMetric('Accuracy', reg.metrics.accuracy, xgb.metrics.accuracy);
        compareMetric('Precision', reg.metrics.precision, xgb.metrics.precision);
        compareMetric('Recall', reg.metrics.recall, xgb.metrics.recall);
        compareMetric('F1 Score', reg.metrics.f1Score, xgb.metrics.f1Score);

        console.log('\n📉 REGRESSION METRICS (Flow Prediction)');
        console.log('-'.repeat(80));
        console.log(`${'Metric'.padEnd(20)} | ${'Regression'.padEnd(15)} | ${'XGBoost'.padEnd(15)} | ${'Winner'.padEnd(15)}`);
        console.log('-'.repeat(80));

        const compareRegMetric = (name: string, regVal: number, xgbVal: number, higherBetter: boolean = true) => {
          const winner = higherBetter
            ? (xgbVal > regVal ? 'XGBoost' : regVal > xgbVal ? 'Regression' : 'Tie')
            : (xgbVal < regVal ? 'XGBoost' : regVal < xgbVal ? 'Regression' : 'Tie');
          const regStr = `${regVal.toFixed(2)}`.padEnd(15);
          const xgbStr = `${xgbVal.toFixed(2)}`.padEnd(15);
          console.log(`${name.padEnd(20)} | ${regStr} | ${xgbStr} | ${winner}`);
        };

        compareRegMetric('R² Score', reg.metrics.r2Score, xgb.metrics.r2Score, true);
        compareRegMetric('MAPE (%)', reg.metrics.mape, xgb.metrics.mape, false);
        compareRegMetric('MAE (MW)', reg.metrics.mae, xgb.metrics.mae, false);
        compareRegMetric('RMSE (MW)', reg.metrics.rmse, xgb.metrics.rmse, false);

        console.log('\n⏱️  TRAINING TIME');
        console.log('-'.repeat(80));
        console.log(`Regression: ${(reg.trainTime / 1000).toFixed(2)}s`);
        console.log(`XGBoost:    ${(xgb.trainTime / 1000).toFixed(2)}s`);
        console.log(`Winner:     ${reg.trainTime < xgb.trainTime ? 'Regression' : 'XGBoost'} (faster)`);

        console.log('\n💡 RECOMMENDATIONS');
        console.log('-'.repeat(80));

        // Calculate overall score (weighted average)
        const regScore = (reg.metrics.accuracy + reg.metrics.f1Score + reg.metrics.r2Score) / 3;
        const xgbScore = (xgb.metrics.accuracy + xgb.metrics.f1Score + xgb.metrics.r2Score) / 3;

        if (xgbScore > regScore + 0.02) {
          console.log('✅ XGBoost shows significantly better performance overall.');
          console.log('   Recommended for production use.');
        } else if (regScore > xgbScore + 0.02) {
          console.log('✅ Regression shows better performance and is faster to train.');
          console.log('   Recommended for production use.');
        } else {
          console.log('⚖️  Both models show similar performance.');
          console.log('   Consider XGBoost for slightly better accuracy,');
          console.log('   or Regression for faster training and inference.');
        }

        console.log('\n═'.repeat(80));
      }

      console.log('\n✅ Model training complete!');

    } catch (error: any) {
      console.error(`\n❌ Error: ${error.message}`);
      if (error.stack) {
        console.error(error.stack);
      }
      process.exit(1);
    }
  });

// DETECT-CONSTRAINTS command
interconnectorCmd
  .command('detect-constraints')
  .description('Detect constraint periods using flat-line analysis')
  .option('--start <date>', 'Start date YYYY-MM-DD')
  .option('--end <date>', 'End date YYYY-MM-DD')
  .option('-i, --interconnector <name>', 'Filter by interconnector (MINVIS1, VISLUZ1)')
  .option('-o, --output <file>', 'Export constraints to CSV file')
  .option('--tolerance <mw>', 'Flow variance tolerance in MW (default: 2)', '2')
  .option('--min-duration <intervals>', 'Minimum duration in 5-min intervals (default: 12)', '12')
  .action(async (options) => {
    console.log('\n🔍 Detecting constraint periods...\n');

    try {
      const { detectConstraintsByInterconnector, calculateConstraintStats, exportConstraintsToCSV } = await import('./analysis/detectConstraints.js');

      // Load interconnector data from database
      const db = getDatabase();
      const records = db.getInterconnectorRecords(
        options.start,
        options.end,
        options.interconnector
      );
      closeDatabase();

      if (records.length === 0) {
        console.error('❌ No interconnector data found. Import RTDHS data first.');
        process.exit(1);
      }

      console.log(`📊 Analyzing ${records.length} records...`);
      console.log(`  Date range: ${DateTime.fromJSDate(records[0].timeInterval).toISODate()} to ${DateTime.fromJSDate(records[records.length - 1].timeInterval).toISODate()}`);

      // Detect constraints
      const config = {
        tolerance: parseFloat(options.tolerance),
        minDuration: parseInt(options.minDuration),
        roundingPrecision: 10
      };

      const constraintsByInterconnector = detectConstraintsByInterconnector(records, config);

      // Display results for each interconnector
      let allConstraints: any[] = [];
      for (const [interconnector, constraints] of constraintsByInterconnector.entries()) {
        console.log(`\n${interconnector}:`);
        console.log(`  Constraint periods detected: ${constraints.length}`);

        if (constraints.length === 0) {
          continue;
        }

        allConstraints = allConstraints.concat(constraints);

        const interconnectorRecords = records.filter(r => r.hvdcName === interconnector);
        const stats = calculateConstraintStats(constraints, interconnectorRecords);

        console.log(`  Total constrained hours: ${stats.totalConstrainedHours.toFixed(2)}`);
        console.log(`  Average duration: ${stats.avgDuration.toFixed(2)} hours`);
        console.log(`  Max duration: ${stats.maxDuration.toFixed(2)} hours`);
        console.log(`  Min duration: ${stats.minDuration.toFixed(2)} hours`);

        console.log(`\n  Constraint Level Distribution:`);
        const sortedLevels = Array.from(stats.constraintLevelDistribution.entries())
          .sort((a, b) => b[1] - a[1]);
        for (const [level, count] of sortedLevels.slice(0, 10)) {
          console.log(`    ${level.toString().padEnd(6)} MW: ${count} periods`);
        }

        console.log(`\n  Comparison with CONGESTION_FLAG:`);
        console.log(`    Constrained + Flagged:     ${stats.comparisonWithCongestionFlag.constrainedWithFlag}`);
        console.log(`    Constrained (no flag):     ${stats.comparisonWithCongestionFlag.constrainedWithoutFlag}`);
        console.log(`    Flagged (not constrained): ${stats.comparisonWithCongestionFlag.flaggedWithoutConstraint}`);
        console.log(`    Agreement:                 ${stats.comparisonWithCongestionFlag.agreement.toFixed(2)}%`);

        // Show top 10 longest constraints
        const sortedConstraints = [...constraints].sort((a, b) => b.durationHours - a.durationHours);
        console.log(`\n  Top 10 Longest Constraint Periods:`);
        for (const constraint of sortedConstraints.slice(0, 10)) {
          const startStr = DateTime.fromJSDate(constraint.startTime).toFormat('yyyy-MM-dd HH:mm');
          const endStr = DateTime.fromJSDate(constraint.endTime).toFormat('yyyy-MM-dd HH:mm');
          console.log(`    ${startStr} → ${endStr} | ${constraint.constraintLevel} MW | ${constraint.durationHours.toFixed(2)} hrs`);
        }
      }

      // Export to CSV if requested
      if (options.output && allConstraints.length > 0) {
        const csv = exportConstraintsToCSV(allConstraints);
        await fs.promises.writeFile(options.output, csv, 'utf-8');
        console.log(`\n✅ Exported ${allConstraints.length} constraint periods to ${options.output}`);
      }

      console.log('\n✅ Constraint detection complete!');

    } catch (error: any) {
      console.error(`\n❌ Error: ${error.message}`);
      if (error.stack) {
        console.error(error.stack);
      }
      process.exit(1);
    }
  });

// FORECAST command
interconnectorCmd
  .command('forecast')
  .description('Forecast interconnector congestion probability')
  .requiredOption('-s, --start <date>', 'Forecast start date YYYY-MM-DD')
  .requiredOption('-e, --end <date>', 'Forecast end date YYYY-MM-DD')
  .requiredOption('-o, --output <file>', 'Output forecast CSV file')
  .option('--demand-forecast <file>', 'Use demand forecast CSV (default: use historical demand)')
  .option('--model-type <type>', 'Model type: regression or xgboost (default: active model)')
  .action(async (options) => {
    console.log('\n🔄 Generating interconnector congestion forecast...\n');

    try {
      // Load model
      const db = getDatabase();
      const modelType = options.modelType ? options.modelType.toLowerCase() : undefined;

      if (modelType && !['regression', 'xgboost'].includes(modelType)) {
        console.error('❌ Invalid model type. Use: regression or xgboost');
        closeDatabase();
        process.exit(1);
      }

      const savedModel = db.getActiveInterconnectorModel(modelType);

      if (!savedModel) {
        const typeMsg = modelType ? ` of type '${modelType}'` : '';
        console.error(`❌ No saved model found${typeMsg}. Train a model first using "interconnector train".`);
        closeDatabase();
        process.exit(1);
      }

      console.log(`📊 Using model: ${savedModel.name}`);
      console.log(`  Model type: ${savedModel.modelType}`);
      console.log(`  Training samples: ${savedModel.trainingSamples}`);
      console.log(`  Accuracy: ${(savedModel.accuracy * 100).toFixed(2)}%`);
      console.log(`  F1 Score: ${(savedModel.f1Score * 100).toFixed(2)}%`);
      console.log(`  R² Score: ${savedModel.r2Score.toFixed(4)}\n`);

      // Load appropriate model
      let model: any;
      if (savedModel.modelType === 'xgboost') {
        const { InterconnectorXGBoostModel } = await import('./models/interconnector/InterconnectorXGBoostModel.js');
        model = InterconnectorXGBoostModel.deserialize(savedModel.modelData);
      } else {
        model = InterconnectorCongestionModel.deserialize(savedModel.modelData);
      }

      // For now, just indicate that forecasting functionality needs demand/weather forecast
      console.log('⚠️  Forecast generation requires:');
      console.log('   1. Demand forecast data');
      console.log('   2. Weather forecast data');
      console.log('   3. Historical flow data for lag features\n');

      console.log('💡 This feature will be available after integrating with existing forecast commands.');

      closeDatabase();

    } catch (error: any) {
      console.error(`\n❌ Error: ${error.message}`);
      process.exit(1);
    }
  });

// CFAC FORECAST3 - Optimal forecasting with Enhanced Hybrid for wind
cfacCommand
  .command('forecast3')
  .description('Generate CFac forecasts using Enhanced Hybrid for wind (best shape + boost)')
  .requiredOption('-t, --training <path>', 'Training data: MRHCFac CSV file or directory')
  .requiredOption('-s, --start <date>', 'Forecast start date (YYYY-MM-DD)')
  .requiredOption('-e, --end <date>', 'Forecast end date (YYYY-MM-DD)')
  .requiredOption('-o, --output <file>', 'Output forecast CSV file')
  .option('--stations <file>', 'Stations JSON file', 'src/data/stations.json')
  .option('--cache <dir>', 'Weather cache directory', './weather_cache')
  .option('--smooth <factor>', 'Wind smoothing factor 0-1 (0=none, 0.5=moderate, 0.8=heavy)', '0')
  .action(async (options) => {
    try {
      const apiKey = getApiKey();
      const weatherService = createWeatherService(apiKey, options.cache);
      const smoothFactor = Math.max(0, Math.min(1, parseFloat(options.smooth) || 0));

      console.log('\n═══════════════════════════════════════════════════════════════════════════════');
      console.log('          OPTIMAL CAPACITY FACTOR FORECASTING (v3)                              ');
      console.log('   Wind: Enhanced Hybrid | Solar: Physics+ML | Others: Profile-based           ');
      console.log('═══════════════════════════════════════════════════════════════════════════════\n');

      // Ensure output directory exists
      const outputDir = dirname(options.output);
      if (outputDir && !existsSync(outputDir)) {
        mkdirSync(outputDir, { recursive: true });
      }

      // Load station metadata
      console.log('📍 Loading station metadata...');
      await capacityFactorService.loadStations(options.stations);
      const stations = capacityFactorService.getAllStations();
      const clusters = capacityFactorService.getClusters();
      console.log(`   Loaded ${stations.size} stations in ${clusters.length} weather clusters`);

      // Parse training data
      console.log('\n📚 Parsing capacity factor training data...');
      const cfacData = await capacityFactorService.parseCapacityFactorDirectory(
        options.training,
        (msg) => console.log(`   ${msg}`)
      );

      // Categorize stations
      const trainingStations = capacityFactorService.getStationCodes(cfacData);
      const stationsByType = new Map<StationType, string[]>();
      for (const stationType of Object.values(StationType)) {
        stationsByType.set(stationType as StationType, []);
      }
      for (const code of trainingStations) {
        const type = getStationTypeFromCode(code);
        stationsByType.get(type)!.push(code);
      }

      const windStations = stationsByType.get(StationType.WIND) || [];
      const solarStations = stationsByType.get(StationType.SOLAR) || [];

      console.log('\n📋 Station types:');
      console.log(`   🌬️  Wind:           ${windStations.length} stations → Enhanced Hybrid (multiplicative boost)`);
      console.log(`   ☀️  Solar:          ${solarStations.length} stations → Physics+ML Hybrid`);
      console.log(`   📊 Others:          ${trainingStations.length - windStations.length - solarStations.length} stations → Profile-based`);

      // Identify wind clusters
      const windClusterIds = new Set<string>();
      for (const code of windStations) {
        const clusterId = capacityFactorService.getClusterForStation(code);
        if (clusterId) windClusterIds.add(clusterId);
      }

      // Helper: CSV parsing
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

      // Date ranges
      const sortedCfac = [...cfacData].sort((a, b) => a.datetime.getTime() - b.datetime.getTime());
      const trainStart = DateTime.fromJSDate(sortedCfac[0].datetime).toISODate()!;
      const trainEnd = DateTime.fromJSDate(sortedCfac[sortedCfac.length - 1].datetime).toISODate()!;
      console.log(`\n📅 Training data: ${trainStart} to ${trainEnd}`);
      console.log(`📅 Forecast period: ${options.start} to ${options.end}`);

      // Fetch training weather
      console.log('\n🌤️  Fetching weather data for training period...');
      const trainClusterWeatherCsv = await weatherService.fetchAllClusters(
        clusters,
        trainStart,
        trainEnd,
        (msg) => console.log(`   ${msg}`),
        windClusterIds
      );

      // Parse training weather
      const trainClusterWeather = new Map<string, Map<number, CFacWeatherFeatures>>();
      for (const [clusterId, csvData] of trainClusterWeatherCsv) {
        const weatherMap = new Map<number, CFacWeatherFeatures>();
        const lines = csvData.split('\n').filter(l => l.trim());
        if (lines.length < 2) continue;

        const headers = parseCSVLine(lines[0]).map(h => h.toLowerCase());
        const colIdx = (name: string) => headers.indexOf(name);

        for (let i = 1; i < lines.length; i++) {
          const values = parseCSVLine(lines[i]);
          const datetimeStr = values[colIdx('datetime')];
          if (!datetimeStr) continue;

          const dt = DateTime.fromISO(datetimeStr);
          if (!dt.isValid) continue;

          const ts = dt.plus({ hours: 1 }).toMillis();
          const weather: CFacWeatherFeatures = {
            temperature: parseFloat(values[colIdx('temp')]) || 25,
            windSpeed: parseFloat(values[colIdx('windspeed')]) || 0,
            windSpeed100: colIdx('windspeed100') >= 0 ? parseFloat(values[colIdx('windspeed100')]) || undefined : undefined,
            windSpeed80: colIdx('windspeed80') >= 0 ? parseFloat(values[colIdx('windspeed80')]) || undefined : undefined,
            windSpeed50: colIdx('windspeed50') >= 0 ? parseFloat(values[colIdx('windspeed50')]) || undefined : undefined,
            windGust: parseFloat(values[colIdx('windgust')]) || 0,
            cloudCover: parseFloat(values[colIdx('cloudcover')]) || 50,
            solarRadiation: parseFloat(values[colIdx('solarradiation')]) || 0,
            precipitation: parseFloat(values[colIdx('precip')]) || 0,
          };
          weatherMap.set(ts, weather);
        }
        trainClusterWeather.set(clusterId, weatherMap);
      }
      console.log(`   Loaded weather for ${trainClusterWeather.size} clusters`);

      // Build training samples
      const mrecCalibrationData: MRECCalibrationData[] = [];
      const windTrainingSamples: CFacTrainingSample[] = [];
      const solarTrainingSamples: CFacTrainingSample[] = [];
      const allTrainingSamples: CFacTrainingSample[] = [];

      for (const record of cfacData) {
        const clusterId = capacityFactorService.getClusterForStation(record.stationCode);
        if (!clusterId) continue;

        const weatherMap = trainClusterWeather.get(clusterId);
        if (!weatherMap) continue;

        const ts = record.datetime.getTime();
        const weather = weatherMap.get(ts);
        if (!weather) continue;

        const dt = record.datetime;
        const stationType = getStationTypeFromCode(record.stationCode);

        const sample: CFacTrainingSample = {
          stationCode: record.stationCode,
          datetime: record.datetime,
          stationType,
          actualCFac: record.capacityFactor,
          weather,
          hour: dt.getHours(),
          dayOfWeek: dt.getDay(),
          month: dt.getMonth() + 1,
          isWeekend: dt.getDay() === 0 || dt.getDay() === 6
        };

        allTrainingSamples.push(sample);

        if (stationType === StationType.WIND) {
          mrecCalibrationData.push({
            datetime: record.datetime,
            stationCode: record.stationCode,
            capacityFactor: record.capacityFactor,
            windSpeed: weather.windSpeed100 ?? weather.windSpeed
          });
          windTrainingSamples.push(sample);
        } else if (stationType === StationType.SOLAR) {
          solarTrainingSamples.push(sample);
        }
      }

      console.log(`\n📊 Training samples: ${allTrainingSamples.length} total`);

      // ═══════════════════════════════════════════════════════════════════════════
      // TRAIN OPTIMAL MODELS
      // ═══════════════════════════════════════════════════════════════════════════

      console.log('\n🔧 Training optimal models for each station type...\n');

      // 1. WIND: Enhanced Hybrid (MREC base + multiplicative correction)
      console.log('   [1/3] 🌬️  WIND: Calibrating Enhanced Hybrid...');
      const mrecModels = await calibrateAllMREC(mrecCalibrationData, (msg: string) => console.log(`      ${msg}`));
      const mrecFactorsList: import('./types/capacityFactor.js').MRECFactors[] = [];
      for (const [, model] of mrecModels) {
        const factors = model.getFactors();
        if (factors && factors.calibrated) {
          mrecFactorsList.push(factors);
        }
      }

      const windEnhancedModels = await trainAllEnhancedHybrid(
        mrecFactorsList,
        windTrainingSamples,
        false,  // asymmetricLoss
        (msg: string) => console.log(`      ${msg}`)
      );
      console.log(`      ✅ Trained ${windEnhancedModels.size} Wind Enhanced Hybrid models`);

      // 2. SOLAR: Physics+ML Hybrid
      console.log('\n   [2/3] ☀️  SOLAR: Training Physics+ML Hybrid...');
      const solarHybridModels = new Map<string, SolarHybridModel>();
      const uniqueSolarStations = [...new Set(solarTrainingSamples.map(s => s.stationCode))];

      for (const stationCode of uniqueSolarStations) {
        const stationSamples = solarTrainingSamples.filter(s => s.stationCode === stationCode);
        if (stationSamples.length < 50) continue;

        const model = new SolarHybridModel(stationCode);
        model.train(stationSamples);
        solarHybridModels.set(stationCode, model);
      }
      console.log(`      ✅ Trained ${solarHybridModels.size} Solar Physics+ML Hybrid models`);

      // 3. OTHER TYPES: Profile-based
      console.log('\n   [3/3] 📊 Other types: Training profile-based models...');
      const modelRouter = new ModelRouter();
      const otherSamples = allTrainingSamples.filter(s =>
        s.stationType !== StationType.WIND && s.stationType !== StationType.SOLAR
      );
      await modelRouter.trainAllModels(otherSamples, (msg: string) => console.log(`      ${msg}`));
      console.log(`      ✅ Trained ${modelRouter.getModelCount()} profile-based models`);

      // ═══════════════════════════════════════════════════════════════════════════
      // FETCH FORECAST WEATHER
      // ═══════════════════════════════════════════════════════════════════════════

      console.log('\n🌤️  Fetching weather data for forecast period...');
      const forecastClusterWeatherCsv = await weatherService.fetchAllClusters(
        clusters,
        options.start,
        options.end,
        (msg) => console.log(`   ${msg}`),
        windClusterIds
      );

      // Parse forecast weather
      const forecastClusterWeather = new Map<string, Map<number, CFacWeatherFeatures>>();
      const forecastTimestamps = new Set<number>();

      for (const [clusterId, csvData] of forecastClusterWeatherCsv) {
        const weatherMap = new Map<number, CFacWeatherFeatures>();
        const lines = csvData.split('\n').filter(l => l.trim());
        if (lines.length < 2) continue;

        const headers = parseCSVLine(lines[0]).map(h => h.toLowerCase());
        const colIdx = (name: string) => headers.indexOf(name);

        for (let i = 1; i < lines.length; i++) {
          const values = parseCSVLine(lines[i]);
          const datetimeStr = values[colIdx('datetime')];
          if (!datetimeStr) continue;

          const dt = DateTime.fromISO(datetimeStr);
          if (!dt.isValid) continue;

          const ts = dt.plus({ hours: 1 }).toMillis();
          forecastTimestamps.add(ts);

          const weather: CFacWeatherFeatures = {
            temperature: parseFloat(values[colIdx('temp')]) || 25,
            windSpeed: parseFloat(values[colIdx('windspeed')]) || 0,
            windSpeed100: colIdx('windspeed100') >= 0 ? parseFloat(values[colIdx('windspeed100')]) || undefined : undefined,
            windSpeed80: colIdx('windspeed80') >= 0 ? parseFloat(values[colIdx('windspeed80')]) || undefined : undefined,
            windSpeed50: colIdx('windspeed50') >= 0 ? parseFloat(values[colIdx('windspeed50')]) || undefined : undefined,
            windGust: parseFloat(values[colIdx('windgust')]) || 0,
            cloudCover: parseFloat(values[colIdx('cloudcover')]) || 50,
            solarRadiation: parseFloat(values[colIdx('solarradiation')]) || 0,
            precipitation: parseFloat(values[colIdx('precip')]) || 0,
          };
          weatherMap.set(ts, weather);
        }
        forecastClusterWeather.set(clusterId, weatherMap);
      }

      const sortedTimestamps = [...forecastTimestamps].sort((a, b) => a - b);
      console.log(`   Loaded ${sortedTimestamps.length} forecast hours across ${forecastClusterWeather.size} clusters`);

      // ═══════════════════════════════════════════════════════════════════════════
      // GENERATE FORECASTS
      // ═══════════════════════════════════════════════════════════════════════════

      console.log('\n🔮 Generating capacity factor forecasts...');

      const forecasts: CFacForecastResult[] = [];
      let windCount = 0, solarCount = 0, otherCount = 0;

      for (const ts of sortedTimestamps) {
        const datetime = new Date(ts);

        for (const stationCode of trainingStations) {
          const clusterId = capacityFactorService.getClusterForStation(stationCode);
          if (!clusterId) continue;

          const clusterWeather = forecastClusterWeather.get(clusterId);
          if (!clusterWeather) continue;

          const weather = clusterWeather.get(ts);
          if (!weather) continue;

          const stationType = getStationTypeFromCode(stationCode);
          let predictedCFac = 0;
          let modelType = 'unknown';

          if (stationType === StationType.WIND) {
            // Use Enhanced Hybrid for wind
            const model = windEnhancedModels.get(stationCode);
            if (model) {
              predictedCFac = model.predict(weather, datetime);
              modelType = 'enhanced-hybrid';
              windCount++;
            }
          } else if (stationType === StationType.SOLAR) {
            // Use Physics+ML Hybrid for solar
            const model = solarHybridModels.get(stationCode);
            if (model) {
              predictedCFac = model.predict(weather, datetime);
              modelType = 'solar-hybrid';
              solarCount++;
            }
          } else {
            // Use profile-based for others via ModelRouter
            const routerPred = modelRouter.predict(stationCode, weather, datetime);
            if (routerPred !== null) {
              predictedCFac = routerPred;
              modelType = 'profile-based';
              otherCount++;
            }
          }

          forecasts.push({
            datetime,
            stationCode,
            predictedCFac: Math.max(0, Math.min(1, predictedCFac)),
            modelType
          });
        }
      }

      console.log(`   Generated ${forecasts.length} total predictions:`);
      console.log(`      🌬️  Wind:  ${windCount} predictions (Enhanced Hybrid)`);
      console.log(`      ☀️  Solar: ${solarCount} predictions (Physics+ML Hybrid)`);
      console.log(`      📊 Other: ${otherCount} predictions (Profile-based)`);

      // ═══════════════════════════════════════════════════════════════════════════
      // APPLY WIND SMOOTHING (if enabled)
      // ═══════════════════════════════════════════════════════════════════════════

      if (smoothFactor > 0) {
        console.log(`\n🌊 Applying wind smoothing (factor: ${smoothFactor.toFixed(2)})...`);

        // Group wind forecasts by station, sorted by time
        const windForecastsByStation = new Map<string, CFacForecastResult[]>();
        for (const f of forecasts) {
          if (f.modelType === 'enhanced-hybrid') {
            if (!windForecastsByStation.has(f.stationCode)) {
              windForecastsByStation.set(f.stationCode, []);
            }
            windForecastsByStation.get(f.stationCode)!.push(f);
          }
        }

        // Apply exponential moving average to each wind station
        // Formula: smoothed[t] = (1-alpha) * prediction[t] + alpha * smoothed[t-1]
        const alpha = smoothFactor;
        let totalSmoothed = 0;

        for (const [stationCode, stationForecasts] of windForecastsByStation) {
          // Sort by datetime
          stationForecasts.sort((a, b) => a.datetime.getTime() - b.datetime.getTime());

          // Apply EMA smoothing
          let prevSmoothed = stationForecasts[0].predictedCFac;
          for (let i = 0; i < stationForecasts.length; i++) {
            const original = stationForecasts[i].predictedCFac;
            const smoothed = (1 - alpha) * original + alpha * prevSmoothed;
            stationForecasts[i].predictedCFac = Math.max(0, Math.min(1, smoothed));
            prevSmoothed = smoothed;
            totalSmoothed++;
          }
        }

        console.log(`   Smoothed ${totalSmoothed} wind predictions across ${windForecastsByStation.size} stations`);
      }

      // ═══════════════════════════════════════════════════════════════════════════
      // WRITE OUTPUT
      // ═══════════════════════════════════════════════════════════════════════════

      console.log('\n📝 Writing forecast results...');

      // Group by datetime
      const byDatetime = new Map<string, Map<string, number>>();
      for (const f of forecasts) {
        const dtKey = DateTime.fromJSDate(f.datetime).toFormat('yyyy-MM-dd HH:mm');
        if (!byDatetime.has(dtKey)) {
          byDatetime.set(dtKey, new Map());
        }
        byDatetime.get(dtKey)!.set(f.stationCode, f.predictedCFac);
      }

      // Build CSV
      const sortedDatetimes = [...byDatetime.keys()].sort();
      const header = ['datetime', ...trainingStations].join(',');
      const rows = sortedDatetimes.map(dt => {
        const stationValues = byDatetime.get(dt)!;
        const values = trainingStations.map(s => {
          const val = stationValues.get(s);
          return val !== undefined ? val.toFixed(4) : '';
        });
        return [dt, ...values].join(',');
      });

      const csv = [header, ...rows].join('\n');
      writeFileSync(options.output, csv);
      console.log(`   Wrote ${sortedDatetimes.length} forecast rows for ${trainingStations.length} stations`);

      console.log('\n═══════════════════════════════════════════════════════════════════════════════');
      console.log('                              FORECAST COMPLETE                                 ');
      console.log('═══════════════════════════════════════════════════════════════════════════════');
      console.log(`\n   📁 Output: ${options.output}`);
      console.log(`   📊 Predictions: ${forecasts.length} for ${trainingStations.length} stations`);
      console.log(`   📅 Period: ${options.start} to ${options.end}`);
      console.log('\n   Models used:');
      console.log(`   ├─ Wind:  Enhanced Hybrid (MREC + multiplicative boost)${smoothFactor > 0 ? ` + EMA smoothing (${smoothFactor.toFixed(2)})` : ''}`);
      console.log('   ├─ Solar: Physics+ML Hybrid');
      console.log('   └─ Other: Profile-based models');

    } catch (error: any) {
      console.error(`\n❌ Error: ${error.message}`);
      if (error.stack) {
        console.error(error.stack);
      }
      process.exit(1);
    }
  });

// CFAC WIND-COMPARE - Compare different wind models for capacity factor forecasting
cfacCommand
  .command('wind-compare')
  .description('Generate wind CFac forecasts using multiple model variants for comparison')
  .requiredOption('-t, --training <path>', 'Training data: MRHCFac CSV file or directory')
  .requiredOption('-s, --start <date>', 'Forecast start date (YYYY-MM-DD)')
  .requiredOption('-e, --end <date>', 'Forecast end date (YYYY-MM-DD)')
  .requiredOption('-o, --output <dir>', 'Output directory for forecast CSV files')
  .option('--stations <file>', 'Stations JSON file', 'src/data/stations.json')
  .option('--cache <dir>', 'Weather cache directory', './weather_cache')
  .action(async (options) => {
    try {
      const apiKey = getApiKey();
      const weatherService = createWeatherService(apiKey, options.cache);

      console.log('\n═══════════════════════════════════════════════════════════════════════════════');
      console.log('          WIND MODEL COMPARISON - Capacity Factor Forecasting                   ');
      console.log('   Comparing: Wind Shear | Cubic | Weibull | Bias Correction                   ');
      console.log('═══════════════════════════════════════════════════════════════════════════════\n');

      // Ensure output directory exists
      if (!existsSync(options.output)) {
        mkdirSync(options.output, { recursive: true });
      }

      // Load station metadata
      console.log('📍 Loading station metadata...');
      await capacityFactorService.loadStations(options.stations);
      const stations = capacityFactorService.getAllStations();
      const clusters = capacityFactorService.getClusters();
      console.log(`   Loaded ${stations.size} stations in ${clusters.length} weather clusters`);

      // Parse training data (capacity factors)
      console.log('\n📚 Parsing capacity factor training data...');
      const cfacData = await capacityFactorService.parseCapacityFactorDirectory(
        options.training,
        (msg) => console.log(`   ${msg}`)
      );

      // Get unique station codes from training data
      const trainingStations = capacityFactorService.getStationCodes(cfacData);

      // Filter to wind stations only
      const windStations = trainingStations.filter(code => {
        const type = getStationTypeFromCode(code);
        return type === StationType.WIND;
      });
      console.log(`\n🌬️  Found ${windStations.length} wind stations for comparison`);

      if (windStations.length === 0) {
        console.error('❌ No wind stations found in training data');
        process.exit(1);
      }

      // Identify wind clusters for 100m hub-height data
      const windClusterIds = new Set<string>();
      for (const stationCode of windStations) {
        const clusterId = capacityFactorService.getClusterForStation(stationCode);
        if (clusterId) windClusterIds.add(clusterId);
      }

      // Get training data date range
      const sortedCfac = [...cfacData].sort((a, b) => a.datetime.getTime() - b.datetime.getTime());
      const trainStart = DateTime.fromJSDate(sortedCfac[0].datetime).toISODate()!;
      const trainEnd = DateTime.fromJSDate(sortedCfac[sortedCfac.length - 1].datetime).toISODate()!;
      console.log(`📅 Training data: ${trainStart} to ${trainEnd}`);
      console.log(`📅 Forecast period: ${options.start} to ${options.end}`);

      // Helper: Proper CSV parsing
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

      // Fetch weather data for training period
      console.log('\n🌤️  Fetching weather data for training period...');
      const trainClusterWeatherCsv = await weatherService.fetchAllClusters(
        clusters,
        trainStart,
        trainEnd,
        (msg) => console.log(`   ${msg}`),
        windClusterIds
      );

      // Parse training weather into cluster -> timestamp -> features
      const trainClusterWeather = new Map<string, Map<number, CFacWeatherFeatures>>();
      for (const [clusterId, csvData] of trainClusterWeatherCsv) {
        const weatherMap = new Map<number, CFacWeatherFeatures>();
        const lines = csvData.split('\n').filter(l => l.trim());
        if (lines.length < 2) continue;

        const headers = parseCSVLine(lines[0]).map(h => h.toLowerCase());
        const colIdx = (name: string) => headers.indexOf(name);

        for (let i = 1; i < lines.length; i++) {
          const values = parseCSVLine(lines[i]);
          const datetimeStr = values[colIdx('datetime')];
          if (!datetimeStr) continue;

          const dt = DateTime.fromISO(datetimeStr);
          if (!dt.isValid) continue;

          const ts = dt.plus({ hours: 1 }).toMillis();

          const weather: CFacWeatherFeatures = {
            temperature: parseFloat(values[colIdx('temp')]) || 25,
            windSpeed: parseFloat(values[colIdx('windspeed')]) || 0,
            windSpeed100: colIdx('windspeed100') >= 0 ? parseFloat(values[colIdx('windspeed100')]) || undefined : undefined,
            windSpeed80: colIdx('windspeed80') >= 0 ? parseFloat(values[colIdx('windspeed80')]) || undefined : undefined,
            windSpeed50: colIdx('windspeed50') >= 0 ? parseFloat(values[colIdx('windspeed50')]) || undefined : undefined,
            windGust: parseFloat(values[colIdx('windgust')]) || 0,
            cloudCover: parseFloat(values[colIdx('cloudcover')]) || 50,
            solarRadiation: parseFloat(values[colIdx('solarradiation')]) || 0,
            precipitation: parseFloat(values[colIdx('precip')]) || 0,
          };

          weatherMap.set(ts, weather);
        }
        trainClusterWeather.set(clusterId, weatherMap);
      }
      console.log(`   Loaded weather for ${trainClusterWeather.size} clusters`);

      // Prepare MREC calibration data and training samples
      const mrecCalibrationData: MRECCalibrationData[] = [];
      const windTrainingSamples: CFacTrainingSample[] = [];

      for (const record of cfacData) {
        if (!windStations.includes(record.stationCode)) continue;

        const clusterId = capacityFactorService.getClusterForStation(record.stationCode);
        if (!clusterId) continue;

        const weatherMap = trainClusterWeather.get(clusterId);
        if (!weatherMap) continue;

        const ts = record.datetime.getTime();
        const weather = weatherMap.get(ts);
        if (!weather) continue;

        // For MREC calibration
        mrecCalibrationData.push({
          datetime: record.datetime,
          stationCode: record.stationCode,
          capacityFactor: record.capacityFactor,
          windSpeed: weather.windSpeed100 ?? weather.windSpeed
        });

        // For hybrid training
        const dt = record.datetime;
        windTrainingSamples.push({
          stationCode: record.stationCode,
          datetime: record.datetime,
          stationType: StationType.WIND,
          actualCFac: record.capacityFactor,
          weather,
          hour: dt.getHours(),
          dayOfWeek: dt.getDay(),
          month: dt.getMonth() + 1,
          isWeekend: dt.getDay() === 0 || dt.getDay() === 6
        });
      }

      console.log(`\n📊 Prepared ${mrecCalibrationData.length} calibration samples`);

      // ═══════════════════════════════════════════════════════════════════════════
      // TRAIN ALL WIND MODELS
      // ═══════════════════════════════════════════════════════════════════════════

      console.log('\n🔧 Training all wind model variants...\n');

      // 1. Calibrate base MREC models (shared by most variants)
      console.log('   [1/5] Calibrating base MREC models...');
      const mrecModels = await calibrateAllMREC(mrecCalibrationData, (msg: string) => console.log(`      ${msg}`));
      const mrecFactorsList: import('./types/capacityFactor.js').MRECFactors[] = [];
      for (const [, model] of mrecModels) {
        const factors = model.getFactors();
        if (factors && factors.calibrated) {
          mrecFactorsList.push(factors);
        }
      }

      // 2. Wind Shear Model
      console.log('\n   [2/5] Training Wind Shear models...');
      const windShearModels = await trainAllWindShear(
        mrecFactorsList,
        windTrainingSamples,
        false,  // autoCalibrate
        (msg: string) => console.log(`      ${msg}`)
      );

      // 3. Cubic Power Curve Model
      console.log('\n   [3/5] Calibrating Cubic Power Curve models...');
      const cubicModels = await calibrateAllCubic(mrecCalibrationData, (msg: string) => console.log(`      ${msg}`));

      // 4. Weibull Model
      console.log('\n   [4/5] Calibrating Weibull Distribution models...');
      const weibullModels = await calibrateAllWeibull(mrecCalibrationData, (msg: string) => console.log(`      ${msg}`));

      // 5. Bias Correction Model
      console.log('\n   [5/6] Calibrating Bias Correction models...');
      const biasCorrectionModels = await calibrateAllBiasCorrection(
        mrecFactorsList,
        windTrainingSamples,
        (msg: string) => console.log(`      ${msg}`)
      );

      // 6. Enhanced Hybrid Model (multiplicative correction + physics boost)
      console.log('\n   [6/6] Training Enhanced Hybrid models...');
      const enhancedHybridModels = await trainAllEnhancedHybrid(
        mrecFactorsList,
        windTrainingSamples,
        false,
        (msg: string) => console.log(`      ${msg}`)
      );

      // ═══════════════════════════════════════════════════════════════════════════
      // FETCH FORECAST WEATHER DATA
      // ═══════════════════════════════════════════════════════════════════════════

      console.log('\n🌤️  Fetching weather data for forecast period...');
      const forecastClusterWeatherCsv = await weatherService.fetchAllClusters(
        clusters,
        options.start,
        options.end,
        (msg) => console.log(`   ${msg}`),
        windClusterIds
      );

      // Parse forecast weather
      const forecastClusterWeather = new Map<string, Map<number, CFacWeatherFeatures>>();
      const forecastTimestamps = new Set<number>();

      for (const [clusterId, csvData] of forecastClusterWeatherCsv) {
        const weatherMap = new Map<number, CFacWeatherFeatures>();
        const lines = csvData.split('\n').filter(l => l.trim());
        if (lines.length < 2) continue;

        const headers = parseCSVLine(lines[0]).map(h => h.toLowerCase());
        const colIdx = (name: string) => headers.indexOf(name);

        for (let i = 1; i < lines.length; i++) {
          const values = parseCSVLine(lines[i]);
          const datetimeStr = values[colIdx('datetime')];
          if (!datetimeStr) continue;

          const dt = DateTime.fromISO(datetimeStr);
          if (!dt.isValid) continue;

          const ts = dt.plus({ hours: 1 }).toMillis();
          forecastTimestamps.add(ts);

          const weather: CFacWeatherFeatures = {
            temperature: parseFloat(values[colIdx('temp')]) || 25,
            windSpeed: parseFloat(values[colIdx('windspeed')]) || 0,
            windSpeed100: colIdx('windspeed100') >= 0 ? parseFloat(values[colIdx('windspeed100')]) || undefined : undefined,
            windSpeed80: colIdx('windspeed80') >= 0 ? parseFloat(values[colIdx('windspeed80')]) || undefined : undefined,
            windSpeed50: colIdx('windspeed50') >= 0 ? parseFloat(values[colIdx('windspeed50')]) || undefined : undefined,
            windGust: parseFloat(values[colIdx('windgust')]) || 0,
            cloudCover: parseFloat(values[colIdx('cloudcover')]) || 50,
            solarRadiation: parseFloat(values[colIdx('solarradiation')]) || 0,
            precipitation: parseFloat(values[colIdx('precip')]) || 0,
          };

          weatherMap.set(ts, weather);
        }
        forecastClusterWeather.set(clusterId, weatherMap);
      }

      const sortedTimestamps = [...forecastTimestamps].sort((a, b) => a - b);
      console.log(`   Loaded ${sortedTimestamps.length} forecast hours across ${forecastClusterWeather.size} clusters`);

      // ═══════════════════════════════════════════════════════════════════════════
      // GENERATE FORECASTS FOR EACH MODEL
      // ═══════════════════════════════════════════════════════════════════════════

      console.log('\n🔮 Generating capacity factor forecasts for all models...\n');

      // Forecasts by model type
      const forecastsByModel = {
        mrec: [] as CFacForecastResult[],
        windShear: [] as CFacForecastResult[],
        cubic: [] as CFacForecastResult[],
        weibull: [] as CFacForecastResult[],
        biasCorrection: [] as CFacForecastResult[],
        enhancedHybrid: [] as CFacForecastResult[],
      };

      for (const ts of sortedTimestamps) {
        const datetime = new Date(ts);

        for (const stationCode of windStations) {
          const clusterId = capacityFactorService.getClusterForStation(stationCode);
          if (!clusterId) continue;

          const clusterWeather = forecastClusterWeather.get(clusterId);
          if (!clusterWeather) continue;

          const weather = clusterWeather.get(ts);
          if (!weather) continue;

          const windSpeed = weather.windSpeed100 ?? weather.windSpeed;

          // 1. MREC Only
          const mrecModel = mrecModels.get(stationCode);
          if (mrecModel) {
            const cfac = mrecModel.predict(windSpeed);
            forecastsByModel.mrec.push({
              datetime,
              stationCode,
              predictedCFac: Math.max(0, Math.min(1, cfac)),
              modelType: 'mrec-only'
            });
          }

          // 2. Wind Shear
          const shearModel = windShearModels.get(stationCode);
          if (shearModel) {
            const cfac = shearModel.predict(weather, datetime);
            forecastsByModel.windShear.push({
              datetime,
              stationCode,
              predictedCFac: Math.max(0, Math.min(1, cfac)),
              modelType: 'wind-shear'
            });
          }

          // 3. Cubic
          const cubicModel = cubicModels.get(stationCode);
          if (cubicModel) {
            const cfac = cubicModel.predictFromWeather(weather, datetime);
            forecastsByModel.cubic.push({
              datetime,
              stationCode,
              predictedCFac: Math.max(0, Math.min(1, cfac)),
              modelType: 'cubic'
            });
          }

          // 4. Weibull
          const weibullModel = weibullModels.get(stationCode);
          if (weibullModel) {
            const cfac = weibullModel.predictFromWeather(weather, datetime);
            forecastsByModel.weibull.push({
              datetime,
              stationCode,
              predictedCFac: Math.max(0, Math.min(1, cfac)),
              modelType: 'weibull'
            });
          }

          // 5. Bias Correction
          const biasModel = biasCorrectionModels.get(stationCode);
          if (biasModel) {
            const cfac = biasModel.predict(weather, datetime);
            forecastsByModel.biasCorrection.push({
              datetime,
              stationCode,
              predictedCFac: Math.max(0, Math.min(1, cfac)),
              modelType: 'bias-correction'
            });
          }

          // 6. Enhanced Hybrid
          const enhancedModel = enhancedHybridModels.get(stationCode);
          if (enhancedModel) {
            const cfac = enhancedModel.predict(weather, datetime);
            forecastsByModel.enhancedHybrid.push({
              datetime,
              stationCode,
              predictedCFac: Math.max(0, Math.min(1, cfac)),
              modelType: 'enhanced-hybrid'
            });
          }
        }
      }

      // ═══════════════════════════════════════════════════════════════════════════
      // WRITE OUTPUT FILES
      // ═══════════════════════════════════════════════════════════════════════════

      console.log('📝 Writing forecast files...\n');

      const writeModelForecast = (forecasts: CFacForecastResult[], filename: string, modelName: string) => {
        if (forecasts.length === 0) {
          console.log(`   ⚠️  No forecasts for ${modelName}`);
          return;
        }

        // Group by datetime
        const byDatetime = new Map<string, Map<string, number>>();
        for (const f of forecasts) {
          const dtKey = DateTime.fromJSDate(f.datetime).toFormat('yyyy-MM-dd HH:mm');
          if (!byDatetime.has(dtKey)) {
            byDatetime.set(dtKey, new Map());
          }
          byDatetime.get(dtKey)!.set(f.stationCode, f.predictedCFac);
        }

        // Build CSV
        const sortedDatetimes = [...byDatetime.keys()].sort();
        const header = ['datetime', ...windStations].join(',');
        const rows = sortedDatetimes.map(dt => {
          const stationValues = byDatetime.get(dt)!;
          const values = windStations.map(s => {
            const val = stationValues.get(s);
            return val !== undefined ? val.toFixed(4) : '';
          });
          return [dt, ...values].join(',');
        });

        const csv = [header, ...rows].join('\n');
        const filepath = join(options.output, filename);
        writeFileSync(filepath, csv);
        console.log(`   ✅ ${modelName}: ${filepath} (${forecasts.length} predictions)`);
      };

      writeModelForecast(forecastsByModel.mrec, 'cfac_wind_mrec.csv', 'MREC Only');
      writeModelForecast(forecastsByModel.windShear, 'cfac_wind_shear.csv', 'Wind Shear');
      writeModelForecast(forecastsByModel.cubic, 'cfac_wind_cubic.csv', 'Cubic Power Curve');
      writeModelForecast(forecastsByModel.weibull, 'cfac_wind_weibull.csv', 'Weibull Distribution');
      writeModelForecast(forecastsByModel.biasCorrection, 'cfac_wind_bias.csv', 'Bias Correction');
      writeModelForecast(forecastsByModel.enhancedHybrid, 'cfac_wind_enhanced.csv', 'Enhanced Hybrid');

      console.log('\n═══════════════════════════════════════════════════════════════════════════════');
      console.log('                           COMPARISON COMPLETE                                  ');
      console.log('═══════════════════════════════════════════════════════════════════════════════');
      console.log(`\n   📁 Output directory: ${options.output}`);
      console.log(`   📊 ${windStations.length} wind stations`);
      console.log(`   📅 Period: ${options.start} to ${options.end}`);
      console.log('\n   Model files:');
      console.log('   ├─ cfac_wind_mrec.csv       - MREC Only (baseline)');
      console.log('   ├─ cfac_wind_shear.csv      - Wind Shear Power Law');
      console.log('   ├─ cfac_wind_cubic.csv      - Cubic Power Curve');
      console.log('   ├─ cfac_wind_weibull.csv    - Weibull Distribution');
      console.log('   ├─ cfac_wind_bias.csv       - Bias Correction');
      console.log('   └─ cfac_wind_enhanced.csv   - Enhanced Hybrid (recommended)');

    } catch (error: any) {
      console.error(`\n❌ Error: ${error.message}`);
      if (error.stack) {
        console.error(error.stack);
      }
      process.exit(1);
    }
  });

// =============================================================================
// SCHEDULER COMMANDS - Background forecast service
// =============================================================================

const scheduler = program.command('scheduler').description('Scheduled forecast generation service');

// scheduler run - Run calibrated daily/weekly forecasts
scheduler
  .command('run')
  .description('Run calibrated daily and weekly forecasts (auto-calibrates before each run)')
  .option('-d, --date <date>', 'Date to run as (YYYY-MM-DD), default: today')
  .option('--daily', 'Run only daily forecast (next day)')
  .option('--weekly', 'Run only weekly forecast (next 7 days)')
  .option('--demand-only', 'Only generate demand forecasts')
  .option('--cfac-only', 'Only generate CFAC forecasts')
  .option('--demand-path <path>', 'Path to demand training data', 'Data Samples/Demand')
  .option('--cfac-path <path>', 'Path to cfac training data', 'Data Samples/Capacity Factor')
  .option('--output <dir>', 'Output directory', './output')
  .option('--db <path>', 'Scheduler database path', './forecast.db')
  // Calibration options
  .option('--calib-days <days>', 'Days to use for calibration', '7')
  .option('--calib-threshold <percent>', 'Max acceptable calibration deviation', '5')
  .option('--max-iterations <n>', 'Max calibration iterations', '3')
  // Demand model options
  .option('--demand-model <type>', 'Demand model: hybrid, regression, xgboost', 'hybrid')
  // CFAC model options
  .option('--use-xgboost', 'Use XGBoost for CFAC residual models')
  .option('--asymmetric-loss', 'Penalize under-predictions 2x for CFAC')
  .option('--bias-correction', 'Enable station-specific bias correction')
  .action(async (options) => {
    try {
      const service = new ForecastSchedulerService({
        demandDataPath: options.demandPath,
        cfacDataPath: options.cfacPath,
        outputDir: options.output,
        dbPath: options.db,
        // Calibration options
        calibrationDays: parseInt(options.calibDays) || 7,
        calibrationThreshold: parseInt(options.calibThreshold) || 5,
        maxCalibrationIterations: parseInt(options.maxIterations) || 3,
        // Demand options
        demandModel: options.demandModel,
        // CFAC options
        useXgboost: options.useXgboost || false,
        asymmetricLoss: options.asymmetricLoss || false,
        biasCorrection: options.biasCorrection || false
      });

      const asOfDate = options.date || DateTime.now().toISODate()!;
      let forecastType: 'demand' | 'cfac' | 'both' = 'both';
      if (options.demandOnly) forecastType = 'demand';
      if (options.cfacOnly) forecastType = 'cfac';

      let horizon: 'daily' | 'weekly' | 'both' = 'both';
      if (options.daily && !options.weekly) horizon = 'daily';
      if (options.weekly && !options.daily) horizon = 'weekly';

      const result = await service.runCalibratedForecasts(asOfDate, {
        forecastType,
        horizon,
        verbose: true
      });

      const summary = service.getRunsSummary();
      console.log('\n📊 Run Summary:');
      console.log(`   Total runs: ${summary.total}`);
      console.log(`   Completed: ${summary.completed}`);

      service.close();
    } catch (error: any) {
      console.error(`\n❌ Error: ${error.message}`);
      process.exit(1);
    }
  });

// scheduler backfill - Generate calibrated forecasts for a date range
scheduler
  .command('backfill')
  .description('Generate calibrated forecasts for each date in a range')
  .requiredOption('-s, --start <date>', 'Start date (YYYY-MM-DD)')
  .requiredOption('-e, --end <date>', 'End date (YYYY-MM-DD)')
  .option('--daily', 'Generate only daily forecasts')
  .option('--weekly', 'Generate only weekly forecasts')
  .option('--demand-only', 'Only generate demand forecasts')
  .option('--cfac-only', 'Only generate CFAC forecasts')
  .option('--demand-path <path>', 'Path to demand training data', 'Data Samples/Demand')
  .option('--cfac-path <path>', 'Path to cfac training data', 'Data Samples/Capacity Factor')
  .option('--output <dir>', 'Output directory', './output')
  .option('--db <path>', 'Scheduler database path', './forecast.db')
  .option('--calib-days <days>', 'Days to use for calibration', '7')
  .action(async (options) => {
    try {
      const service = new ForecastSchedulerService({
        demandDataPath: options.demandPath,
        cfacDataPath: options.cfacPath,
        outputDir: options.output,
        dbPath: options.db,
        calibrationDays: parseInt(options.calibDays) || 7
      });

      let horizon: 'daily' | 'weekly' | 'both' = 'both';
      if (options.daily && !options.weekly) horizon = 'daily';
      if (options.weekly && !options.daily) horizon = 'weekly';

      let forecastType: 'demand' | 'cfac' | 'both' = 'both';
      if (options.demandOnly) forecastType = 'demand';
      if (options.cfacOnly) forecastType = 'cfac';

      const start = DateTime.fromISO(options.start);
      const end = DateTime.fromISO(options.end);
      let current = start;
      let runCount = 0;

      console.log(`\n🔄 Backfilling calibrated forecasts from ${options.start} to ${options.end}`);

      while (current <= end) {
        const dateStr = current.toISODate()!;
        console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
        console.log(`Processing: ${dateStr}`);

        try {
          await service.runCalibratedForecasts(dateStr, {
            horizon,
            forecastType,
            verbose: false
          });
          runCount++;
          console.log(`   ✓ ${dateStr} complete`);
        } catch (error: any) {
          console.log(`   ✗ ${dateStr}: ${error.message}`);
        }

        current = current.plus({ days: 1 });
      }

      console.log(`\n✅ Backfill complete: ${runCount} days processed`);

      service.close();
    } catch (error: any) {
      console.error(`\n❌ Error: ${error.message}`);
      process.exit(1);
    }
  });

// scheduler history - Show calibration history
scheduler
  .command('history')
  .description('Show calibration and forecast run history')
  .option('--db <path>', 'Database path', './forecast.db')
  .option('-n, --limit <number>', 'Number of recent records to show', '10')
  .action(async (options) => {
    try {
      const service = new ForecastSchedulerService({
        demandDataPath: 'Data Samples/Demand',
        cfacDataPath: 'Data Samples/Capacity Factor',
        outputDir: './output',
        dbPath: options.db
      });

      const history = service.getCalibrationHistory(parseInt(options.limit) || 10);
      const summary = service.getRunsSummary();

      console.log('\n📊 Calibration History:');
      console.log('┌──────────────┬────────────┬────────────┬────────────────────────────┐');
      console.log('│     Date     │ Wind Scale │ Solar Scale│          Status            │');
      console.log('├──────────────┼────────────┼────────────┼────────────────────────────┤');
      for (const h of history) {
        const windScale = h.wind_scale > 0 ? `+${h.wind_scale}%` : `${h.wind_scale}%`;
        const solarScale = h.solar_scale > 0 ? `+${h.solar_scale}%` : `${h.solar_scale}%`;
        const status = h.within_threshold ? '✅ Within threshold' : '⚠️  Exceeded threshold';
        console.log(`│ ${h.calibration_date.padEnd(12)} │ ${windScale.padStart(10)} │ ${solarScale.padStart(10)} │ ${status.padEnd(26)} │`);
      }
      console.log('└──────────────┴────────────┴────────────┴────────────────────────────┘');

      console.log('\n📊 Run Summary:');
      console.log(`   Total runs: ${summary.total}`);
      console.log(`   Completed: ${summary.completed}`);
      console.log(`   Failed: ${summary.failed}`);

      service.close();
    } catch (error: any) {
      console.error(`\n❌ Error: ${error.message}`);
      process.exit(1);
    }
  });

// scheduler status - Show scheduler status and history
scheduler
  .command('status')
  .description('Show forecast scheduler status and run history')
  .option('--db <path>', 'Database path', './forecast.db')
  .option('-n, --limit <number>', 'Number of recent runs to show', '10')
  .action(async (options) => {
    try {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(options.db);

      // Ensure tables exist
      db.exec(`
        CREATE TABLE IF NOT EXISTS forecast_runs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          run_date TEXT NOT NULL,
          run_time TEXT NOT NULL,
          forecast_type TEXT NOT NULL,
          horizon TEXT NOT NULL,
          forecast_start TEXT NOT NULL,
          forecast_end TEXT NOT NULL,
          model_used TEXT,
          training_mape REAL,
          status TEXT DEFAULT 'pending',
          records_generated INTEGER,
          duration_ms INTEGER,
          error_message TEXT,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS forecast_evaluations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          run_id INTEGER NOT NULL,
          evaluated_at TEXT NOT NULL,
          records_matched INTEGER,
          records_unmatched INTEGER,
          mape REAL,
          mae REAL,
          rmse REAL,
          bias REAL,
          breakdown TEXT,
          notes TEXT
        );
      `);

      const summary = db.prepare(`
        SELECT
          COUNT(*) as total,
          SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
          SUM(CASE WHEN status = 'evaluated' THEN 1 ELSE 0 END) as evaluated,
          SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
          SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending
        FROM forecast_runs
      `).get() as any;

      console.log('\n📊 Forecast Scheduler Status\n');
      console.log('┌─────────────────────────────────────┐');
      console.log(`│ Total runs:     ${String(summary?.total || 0).padStart(18)} │`);
      console.log(`│ Completed:      ${String(summary?.completed || 0).padStart(18)} │`);
      console.log(`│ Evaluated:      ${String(summary?.evaluated || 0).padStart(18)} │`);
      console.log(`│ Pending:        ${String(summary?.pending || 0).padStart(18)} │`);
      console.log(`│ Failed:         ${String(summary?.failed || 0).padStart(18)} │`);
      console.log('└─────────────────────────────────────┘');

      const avgMape = db.prepare(`
        SELECT AVG(mape) as avg_mape, MIN(mape) as min_mape, MAX(mape) as max_mape
        FROM forecast_evaluations
      `).get() as any;

      if (avgMape?.avg_mape) {
        console.log('\n📈 Evaluation Metrics:');
        console.log(`   Avg MAPE: ${avgMape.avg_mape.toFixed(2)}%`);
        console.log(`   Min MAPE: ${avgMape.min_mape.toFixed(2)}%`);
        console.log(`   Max MAPE: ${avgMape.max_mape.toFixed(2)}%`);
      }

      const recentRuns = db.prepare(`
        SELECT r.*, e.mape, e.mae
        FROM forecast_runs r
        LEFT JOIN forecast_evaluations e ON r.id = e.run_id
        ORDER BY r.run_date DESC, r.run_time DESC
        LIMIT ?
      `).all(parseInt(options.limit)) as any[];

      if (recentRuns.length > 0) {
        console.log(`\n📋 Recent Runs (last ${options.limit}):\n`);
        console.log('┌──────────────┬─────────┬─────────┬────────────┬──────────┬─────────┐');
        console.log('│ Run Date     │ Type    │ Horizon │ Target     │ Status   │ MAPE    │');
        console.log('├──────────────┼─────────┼─────────┼────────────┼──────────┼─────────┤');

        for (const run of recentRuns) {
          const mape = run.mape ? `${run.mape.toFixed(1)}%` : '-';
          console.log(`│ ${run.run_date} │ ${run.forecast_type.padEnd(7)} │ ${run.horizon.padEnd(7)} │ ${run.forecast_start} │ ${run.status.padEnd(8)} │ ${mape.padStart(7)} │`);
        }
        console.log('└──────────────┴─────────┴─────────┴────────────┴──────────┴─────────┘');
      }

      db.close();
    } catch (error: any) {
      console.error(`\n❌ Error: ${error.message}`);
      process.exit(1);
    }
  });

// scheduler service - Run as background service
scheduler
  .command('service')
  .description('Run as a background service (generates forecasts daily with auto-calibration)')
  .option('--hour <hour>', 'Hour to run daily forecasts (0-23)', '6')
  .option('--interval <minutes>', 'Check interval in minutes', '60')
  .option('--demand-path <path>', 'Path to demand training data', 'Data Samples/Demand')
  .option('--cfac-path <path>', 'Path to cfac training data', 'Data Samples/Capacity Factor')
  .option('--output <dir>', 'Output directory', './output')
  .option('--db <path>', 'Scheduler database path', './forecast.db')
  // Calibration options
  .option('--calib-days <days>', 'Days to use for calibration', '7')
  .option('--calib-threshold <percent>', 'Max acceptable calibration deviation', '5')
  .option('--max-iterations <n>', 'Max calibration iterations', '3')
  // CFAC model options
  .option('--use-xgboost', 'Use XGBoost for CFAC residual models')
  .option('--bias-correction', 'Enable station-specific bias correction')
  .action(async (options) => {
    try {
      const service = new ForecastSchedulerService({
        demandDataPath: options.demandPath,
        cfacDataPath: options.cfacPath,
        outputDir: options.output,
        dbPath: options.db,
        useDb: true,
        calibrationDays: parseInt(options.calibDays) || 7,
        calibrationThreshold: parseFloat(options.calibThreshold) || 5,
        maxCalibrationIterations: parseInt(options.maxIterations) || 3,
        useXgboost: options.useXgboost || false,
        biasCorrection: options.biasCorrection || false
      });

      // Run as service (blocks indefinitely)
      await service.runAsService({
        runHour: parseInt(options.hour),
        interval: parseInt(options.interval)
      });

    } catch (error: any) {
      console.error(`\n❌ Error: ${error.message}`);
      process.exit(1);
    }
  });

// CAPACITY command group - Manage station capacity data
const capacityCmd = program.command('capacity').description('Manage station capacity database and check for IEMOP updates');

// capacity check - Check for updates from IEMOP
capacityCmd
  .command('check')
  .description('Check IEMOP for new or changed stations')
  .option('--force', 'Force refresh from IEMOP even if cache is fresh')
  .option('--cache <dir>', 'Cache directory for IEMOP data', './iemop_cache')
  .option('--stations <path>', 'Path to stations.json', './src/data/stations.json')
  .option('-o, --output <file>', 'Output report to file')
  .option('-v, --verbose', 'Show detailed progress')
  .action(async (options) => {
    try {
      console.log('\n🔍 Checking IEMOP for station updates...\n');

      const service = new CapacityUpdateService(options.cache, options.stations);
      const report = await service.checkForUpdates(options.force, options.verbose);

      // Display report
      const reportText = service.generateReport(report);
      console.log(reportText);

      // Save report if output specified
      if (options.output) {
        writeFileSync(options.output, reportText);
        console.log(`\n📄 Report saved to: ${options.output}`);
      }

      // Summary status
      if (report.changes.length === 0) {
        console.log('\n✅ Station database is up to date!');
      } else {
        console.log(`\n⚠️  Found ${report.changes.length} changes requiring attention.`);

        const newStations = report.changes.filter(c => c.type === 'NEW_STATION');
        if (newStations.length > 0) {
          console.log(`\n📋 New stations requiring research:`);
          for (const change of newStations) {
            console.log(`   - ${change.stationCode}`);
          }
          console.log(`\nRun 'iload capacity research --station <code>' to research a new station.`);
        }
      }

    } catch (error: any) {
      console.error(`\n❌ Error: ${error.message}`);
      process.exit(1);
    }
  });

// capacity compare - Compare local genlist with stations.json
capacityCmd
  .command('compare')
  .description('Compare local genlist.csv with stations.json')
  .requiredOption('-g, --genlist <file>', 'Path to genlist.csv file')
  .option('--stations <path>', 'Path to stations.json', './src/data/stations.json')
  .option('-v, --verbose', 'Show detailed output')
  .action(async (options) => {
    try {
      console.log('\n📊 Comparing genlist.csv with stations.json...\n');

      const service = new CapacityUpdateService('./iemop_cache', options.stations);
      const { IEMOPDownloadService } = await import('./services/iemopDownloadService.js');
      const downloader = new IEMOPDownloadService();

      // Parse genlist
      const records = downloader.parseGenlistCSV(options.genlist);
      console.log(`Loaded ${records.length} records from genlist.csv`);

      // Load stations.json
      const stationsJson = service.loadStationsJSON();
      const genlistStations = downloader.getUniqueStations(records);

      // Compare
      console.log(`\nGenlist unique stations: ${genlistStations.size}`);
      console.log(`Our stations.json:       ${Object.keys(stationsJson.stations).length}`);

      // Find missing in our database
      const missing: string[] = [];
      for (const [code] of genlistStations) {
        if (!stationsJson.stations[code]) {
          missing.push(code);
        }
      }

      if (missing.length > 0) {
        console.log(`\n⚠️  ${missing.length} stations in genlist not in our database:`);
        for (const code of missing.sort()) {
          const data = genlistStations.get(code)!;
          console.log(`   ${code} (${data.region}) - ${data.resources.length} resources`);
        }
      } else {
        console.log('\n✅ All genlist stations are in our database!');
      }

    } catch (error: any) {
      console.error(`\n❌ Error: ${error.message}`);
      process.exit(1);
    }
  });

// capacity research - Generate research prompt for a station
capacityCmd
  .command('research')
  .description('Generate research prompt for a new station')
  .requiredOption('-s, --station <code>', 'Station code to research')
  .option('-g, --genlist <file>', 'Path to genlist.csv (uses cache if not specified)')
  .option('--cache <dir>', 'Cache directory', './iemop_cache')
  .action(async (options) => {
    try {
      const { IEMOPDownloadService } = await import('./services/iemopDownloadService.js');
      const downloader = new IEMOPDownloadService(options.cache);

      // Get genlist
      let genlistPath = options.genlist;
      if (!genlistPath) {
        genlistPath = downloader.getCachedGenlistPath();
        if (!genlistPath) {
          console.log('No cached genlist found. Downloading from IEMOP...');
          const result = await downloader.downloadMNM('ALL', true);
          if (!result.success) {
            throw new Error(`Failed to download MNM data: ${result.error}`);
          }
          genlistPath = downloader.getCachedGenlistPath();
        }
      }

      if (!genlistPath) {
        throw new Error('No genlist.csv available');
      }

      const records = downloader.parseGenlistCSV(genlistPath);
      const service = new CapacityUpdateService(options.cache);

      const prompts = service.generateResearchPrompts([options.station], records);
      const prompt = prompts.get(options.station);

      if (!prompt) {
        console.log(`\n⚠️  Station ${options.station} not found in genlist`);
        process.exit(1);
      }

      console.log('\n' + '='.repeat(80));
      console.log('RESEARCH PROMPT');
      console.log('='.repeat(80));
      console.log(prompt);
      console.log('='.repeat(80));
      console.log('\nCopy the above prompt to an LLM for research, then use:');
      console.log(`  iload capacity add --station ${options.station} --data <json_file>`);

    } catch (error: any) {
      console.error(`\n❌ Error: ${error.message}`);
      process.exit(1);
    }
  });

// capacity add - Add a new station to stations.json
capacityCmd
  .command('add')
  .description('Add a new station to stations.json')
  .requiredOption('-s, --station <code>', 'Station code')
  .option('-d, --data <file>', 'JSON file with station data')
  .option('-n, --name <name>', 'Station name')
  .option('-t, --type <type>', 'Station type (solar, wind, hydro, etc.)')
  .option('--operator <name>', 'Operator name')
  .option('--capacity <mw>', 'Capacity in MW')
  .option('--lat <lat>', 'Latitude')
  .option('--lon <lon>', 'Longitude')
  .option('--grid <grid>', 'Grid (CLUZ, CVIS, CMIN)')
  .option('--stations <path>', 'Path to stations.json', './src/data/stations.json')
  .action(async (options) => {
    try {
      const service = new CapacityUpdateService('./iemop_cache', options.stations);

      let data: any = {};

      // Load from JSON file if provided
      if (options.data) {
        const content = readFileSync(options.data, 'utf-8');
        data = JSON.parse(content);
      }

      // Override with command line options
      if (options.name) data.name = options.name;
      if (options.type) data.type = options.type;
      if (options.operator) data.operator = options.operator;
      if (options.capacity) data.capacity_mw = parseFloat(options.capacity);
      if (options.grid) data.grid = options.grid;

      if (options.lat && options.lon) {
        data.location = data.location || {};
        data.location.latitude = parseFloat(options.lat);
        data.location.longitude = parseFloat(options.lon);
      }

      service.addNewStation(options.station, data);
      console.log(`\n✅ Added station ${options.station} to stations.json`);

    } catch (error: any) {
      console.error(`\n❌ Error: ${error.message}`);
      process.exit(1);
    }
  });

// capacity download - Download fresh data from IEMOP
capacityCmd
  .command('download')
  .description('Download fresh MNM data from IEMOP')
  .option('--cache <dir>', 'Cache directory', './iemop_cache')
  .option('-v, --verbose', 'Show detailed progress')
  .action(async (options) => {
    try {
      console.log('\n📥 Downloading MNM data from IEMOP...\n');

      const { IEMOPDownloadService } = await import('./services/iemopDownloadService.js');
      const downloader = new IEMOPDownloadService(options.cache);

      const result = await downloader.downloadMNM('ALL', options.verbose);

      if (result.success) {
        console.log(`\n✅ Downloaded successfully: ${result.filePath}`);
      } else {
        console.log(`\n❌ Download failed: ${result.error}`);
      }

    } catch (error: any) {
      console.error(`\n❌ Error: ${error.message}`);
      process.exit(1);
    }
  });

// capacity cfac-check - Check CFAC CSV files for new renewable stations
capacityCmd
  .command('cfac-check')
  .description('Compare CFAC CSV columns against stations.json to detect new renewable stations')
  .requiredOption('-t, --training <path>', 'Path to CFAC training data folder')
  .option('--stations <path>', 'Path to stations.json', './src/data/stations.json')
  .option('--type <types>', 'Station types to check (comma-separated: solar,wind,hydro)', 'solar,wind,hydro')
  .option('-o, --output <file>', 'Output report to file')
  .option('-v, --verbose', 'Show detailed output')
  .action(async (options) => {
    try {
      console.log('\n🔍 Checking CFAC data for new renewable stations...\n');

      const service = new CapacityUpdateService('./iemop_cache', options.stations);
      const stationsJson = service.loadStationsJSON();

      // Get station types to check
      const typesToCheck = options.type.toLowerCase().split(',').map((t: string) => t.trim());
      console.log(`📋 Checking for types: ${typesToCheck.join(', ')}`);

      // Read all CSV files in the training directory
      const trainingDir = options.training;
      if (!existsSync(trainingDir)) {
        throw new Error(`Training directory not found: ${trainingDir}`);
      }

      const csvFiles = fs.readdirSync(trainingDir)
        .filter(f => f.toLowerCase().endsWith('.csv'));

      if (csvFiles.length === 0) {
        throw new Error(`No CSV files found in ${trainingDir}`);
      }

      console.log(`📂 Found ${csvFiles.length} CFAC CSV files`);

      // Extract all unique station codes from CSV headers
      const allStationCodes = new Set<string>();
      for (const csvFile of csvFiles) {
        const filePath = join(trainingDir, csvFile);
        const content = readFileSync(filePath, 'utf-8');
        const firstLine = content.split('\n')[0];
        const headers = firstLine.split(',').map(h => h.trim());

        // Skip first column (DateTimeEnding)
        for (let i = 1; i < headers.length; i++) {
          if (headers[i]) {
            allStationCodes.add(headers[i]);
          }
        }
      }

      console.log(`📊 Found ${allStationCodes.size} unique stations in CFAC data\n`);

      // Filter by renewable types
      const renewableStations: { code: string; type: string }[] = [];
      for (const code of allStationCodes) {
        const stationType = getStationTypeFromCode(code);
        let typeStr: string;

        switch (stationType) {
          case StationType.SOLAR: typeStr = 'solar'; break;
          case StationType.WIND: typeStr = 'wind'; break;
          case StationType.HYDRO_RUN_OF_RIVER:
          case StationType.HYDRO_STORAGE: typeStr = 'hydro'; break;
          case StationType.GEOTHERMAL: typeStr = 'geothermal'; break;
          case StationType.BIOMASS: typeStr = 'biomass'; break;
          case StationType.BATTERY: typeStr = 'battery'; break;
          default: typeStr = 'other';
        }

        if (typesToCheck.includes(typeStr)) {
          renewableStations.push({ code, type: typeStr });
        }
      }

      console.log(`🌿 Renewable stations (${typesToCheck.join('/')}): ${renewableStations.length}`);

      // Check which are missing from stations.json
      const missingStations: { code: string; type: string }[] = [];
      const presentStations: { code: string; type: string }[] = [];

      for (const station of renewableStations) {
        if (!stationsJson.stations[station.code]) {
          missingStations.push(station);
        } else {
          presentStations.push(station);
        }
      }

      // Group by type for display
      const missingByType = new Map<string, string[]>();
      for (const station of missingStations) {
        if (!missingByType.has(station.type)) {
          missingByType.set(station.type, []);
        }
        missingByType.get(station.type)!.push(station.code);
      }

      const presentByType = new Map<string, string[]>();
      for (const station of presentStations) {
        if (!presentByType.has(station.type)) {
          presentByType.set(station.type, []);
        }
        presentByType.get(station.type)!.push(station.code);
      }

      // Display results
      console.log('\n' + '='.repeat(70));
      console.log('CFAC COVERAGE REPORT');
      console.log('='.repeat(70));

      console.log('\n📊 SUMMARY:');
      console.log(`   Total renewable in CFAC:    ${renewableStations.length}`);
      console.log(`   In stations.json:           ${presentStations.length}`);
      console.log(`   Missing from stations.json: ${missingStations.length}`);
      console.log(`   Coverage:                   ${(100 * presentStations.length / renewableStations.length).toFixed(1)}%`);

      // Show coverage by type
      console.log('\n📋 BY TYPE:');
      for (const type of typesToCheck) {
        const present = presentByType.get(type)?.length || 0;
        const missing = missingByType.get(type)?.length || 0;
        const total = present + missing;
        const coverage = total > 0 ? (100 * present / total).toFixed(1) : '0.0';
        const emoji = type === 'solar' ? '☀️ ' : type === 'wind' ? '🌬️ ' : type === 'hydro' ? '💧' : '🔋';
        console.log(`   ${emoji} ${type.toUpperCase().padEnd(8)}: ${present}/${total} (${coverage}% coverage)`);
      }

      if (missingStations.length === 0) {
        console.log('\n✅ All renewable stations in CFAC data are in stations.json!');
      } else {
        console.log('\n' + '-'.repeat(70));
        console.log('⚠️  MISSING STATIONS (need to be added to stations.json):');
        console.log('-'.repeat(70));

        for (const [type, codes] of missingByType) {
          console.log(`\n[${type.toUpperCase()}] (${codes.length} stations):`);
          for (const code of codes.sort()) {
            console.log(`   - ${code}`);
          }
        }

        console.log('\n💡 To add a missing station:');
        console.log('   iload capacity research --station <code>   # Get research prompt');
        console.log('   iload capacity add --station <code> ...    # Add station');
      }

      if (options.verbose) {
        console.log('\n' + '-'.repeat(70));
        console.log('PRESENT STATIONS:');
        console.log('-'.repeat(70));
        for (const [type, codes] of presentByType) {
          console.log(`\n[${type.toUpperCase()}] (${codes.length} stations):`);
          console.log(`   ${codes.sort().join(', ')}`);
        }
      }

      console.log('\n' + '='.repeat(70));

      // Save report if output specified
      if (options.output) {
        const reportLines: string[] = [];
        reportLines.push('CFAC COVERAGE REPORT');
        reportLines.push(`Generated: ${new Date().toISOString()}`);
        reportLines.push(`Training data: ${trainingDir}`);
        reportLines.push('');
        reportLines.push('SUMMARY:');
        reportLines.push(`Total renewable in CFAC: ${renewableStations.length}`);
        reportLines.push(`In stations.json: ${presentStations.length}`);
        reportLines.push(`Missing: ${missingStations.length}`);
        reportLines.push(`Coverage: ${(100 * presentStations.length / renewableStations.length).toFixed(1)}%`);
        reportLines.push('');

        if (missingStations.length > 0) {
          reportLines.push('MISSING STATIONS:');
          for (const [type, codes] of missingByType) {
            reportLines.push(`[${type}]`);
            for (const code of codes.sort()) {
              reportLines.push(`  ${code}`);
            }
          }
        }

        writeFileSync(options.output, reportLines.join('\n'));
        console.log(`📄 Report saved to: ${options.output}`);
      }

    } catch (error: any) {
      console.error(`\n❌ Error: ${error.message}`);
      process.exit(1);
    }
  });

program.parse();
