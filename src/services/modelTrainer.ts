/**
 * Model Training Service
 *
 * Handles training of demand and capacity factor models,
 * calculates metrics, and saves models to the model store.
 */

import crypto from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { DateTime } from 'luxon';
import { saveModel, activateModel, getActiveModel } from './modelStore.js';
import { SavedModel, ModelMetrics, DemandModelType, CFACModelType, TrainingPlanOverrides } from '../types/models.js';
import { FEATURE_NAMES } from '../constants/index.js';
import { parseDemandCsv, parseWeatherCsv } from '../parsers/index.js';
import { WeatherService, ZONAL_LOCATIONS, DEFAULT_LOCATIONS, getZonalLocationsByZone, WeatherLocation } from './weatherService.js';
import { mergeData, mergeZonalData, MergedRecord } from '../utils/dataMerger.js';
import { buildTrainingSamples } from '../features/index.js';
import { HybridModel, HybridModelState } from '../models/hybridModel.js';
import { TrainingSample, ZonalMergedRecord } from '../types/index.js';
import { overrideService } from './overrideService.js';
import { getTrainingInstanceService, ModelSummary, AggregateMetrics } from './trainingInstanceService.js';

// Default API key (same as used in index.ts)
const DEFAULT_API_KEY = 'CXZ5ABVDE32SVNPVGVQWH3TSW';

/**
 * Get Visual Crossing API key from env, config, or default
 */
function getApiKey(): string {
  if (process.env.VISUAL_CROSSING_API_KEY) {
    return process.env.VISUAL_CROSSING_API_KEY;
  }
  const configPath = join(process.cwd(), 'config.json');
  if (existsSync(configPath)) {
    try {
      const config = JSON.parse(readFileSync(configPath, 'utf8'));
      if (config.visualCrossingApiKey) {
        return config.visualCrossingApiKey;
      }
    } catch { /* ignore */ }
  }
  return DEFAULT_API_KEY;
}

/**
 * Training options for demand models
 */
export interface DemandTrainingOptions {
  demandDataPath: string;
  weatherFiles?: string[];
  startDate?: string;
  endDate?: string;
  modelType: DemandModelType;
  zonal: boolean;
  holdoutDays?: number;
  autoActivate?: boolean;
  weatherCacheDir?: string;
  overrides?: TrainingPlanOverrides; // Per-entity overrides
  templateId?: string;
  templateName?: string;
  trainingInstanceId?: string; // Pre-created instance ID
}

/**
 * Training options for CFAC models
 */
export interface CFACTrainingOptions {
  trainingDataPath: string;
  startDate?: string;
  endDate?: string;
  modelType: CFACModelType;
  stationCodes?: string[];
  groupModel?: string;
  holdoutDays?: number;
  autoActivate?: boolean;
}

/**
 * Training result
 */
export interface TrainingResult {
  success: boolean;
  modelId?: string;
  entityType: string;
  entityCode: string;
  metrics?: ModelMetrics;
  activated?: boolean;
  error?: string;
  trainingInstanceId?: string; // Instance ID if tracking is enabled
}

/**
 * Train demand models (regional or zonal)
 *
 * Full implementation that:
 * 1. Loads demand data
 * 2. Fetches weather data
 * 3. Merges and builds training samples
 * 4. Trains HybridModel for each region/zone
 * 5. Saves models to the model store
 */
export async function trainDemandModels(
  options: DemandTrainingOptions
): Promise<TrainingResult[]> {
  const results: TrainingResult[] = [];
  const holdoutDays = options.holdoutDays ?? 14;
  const autoActivate = options.autoActivate ?? true;
  const cacheDir = options.weatherCacheDir ?? './weather_cache';
  const overrides = options.overrides ?? { zones: {}, regions: {}, stationTypes: {} };

  // Start training instance tracking
  const instanceService = getTrainingInstanceService();
  const instanceId = options.trainingInstanceId || instanceService.startInstance(
    options.templateId,
    options.templateName
  );

  console.log('\n[Model Training] Starting demand model training...');
  console.log(`  Instance ID: ${instanceId}`);
  console.log(`  Mode: ${options.zonal ? 'Zonal (14 sub-regions)' : 'Regional (3 regions)'}`);
  console.log(`  Model type: ${options.modelType}`);
  console.log(`  Holdout days: ${holdoutDays}`);

  // Validate and display overrides
  if (options.overrides) {
    const validation = overrideService.validateOverrides(overrides);
    if (validation.warnings.length > 0) {
      console.log('\n⚠️  Override warnings:');
      validation.warnings.forEach(w => console.log(`  - ${w}`));
    }
    if (!validation.valid) {
      console.error('\n❌ Override validation failed:');
      validation.errors.forEach(e => console.error(`  - ${e}`));
      throw new Error('Invalid override configuration');
    }
    console.log('\n📝 ' + overrideService.getOverridesSummary(overrides));
  }

  try {
    // 1. Load demand data
    console.log('\n📊 Loading demand data...');
    const demandData = parseDemandCsv(options.demandDataPath);
    console.log(`  Records: ${demandData.records.length}`);
    console.log(`  Date range: ${DateTime.fromJSDate(demandData.startDate).toISODate()} to ${DateTime.fromJSDate(demandData.endDate).toISODate()}`);
    console.log(`  Regions: ${demandData.regions.join(', ')}`);

    // Determine entities to train
    const entities = options.zonal
      ? ['01NLUZ', '02METRO', '03SLUZ', '04LEYTE', '05CEBU', '06NEGROS', '07BOHOL', '08PANAY', '09NWMIN', '10LANAO', '11NCMIN', '12NEMIN', '13SEMIN', '14SWMIN']
      : ['CLUZ', 'CVIS', 'CMIN'];

    // 2. Fetch weather data
    console.log('\n🌤️  Fetching weather data...');
    const apiKey = getApiKey();

    const weatherStart = options.startDate || DateTime.fromJSDate(demandData.startDate).toISODate()!;
    const weatherEnd = options.endDate || DateTime.fromJSDate(demandData.endDate).toISODate()!;

    let mergedRecords: MergedRecord[];

    if (options.zonal) {
      // Zonal mode: use 42 cities (3 per zone)
      const zonalWeatherService = new WeatherService({
        apiKey,
        cacheDir: cacheDir,
        locations: ZONAL_LOCATIONS
      });

      console.log(`  Fetching weather for ${ZONAL_LOCATIONS.length} zonal cities...`);
      const weatherFiles = await zonalWeatherService.saveWeatherFiles(
        weatherStart,
        weatherEnd,
        join(cacheDir, 'zonal_combined'),
        (msg) => console.log(`  ${msg}`)
      );

      // Build zonal weather sets by mapping files to zones
      const zonalByZone = getZonalLocationsByZone();
      const zones = Array.from(zonalByZone.keys());
      const zonalWeatherSets: Array<{
        city: string;
        locationId: string;
        zoneCode: string;
        cityIndex: number;
        records: import('../types/index.js').RawWeatherData[];
      }> = [];

      for (const filePath of weatherFiles) {
        // Extract location ID from filename (e.g., Weather_hourly_san_fernando_...csv)
        const match = filePath.match(/Weather_hourly_([^_]+(?:_[^_]+)*?)_\d{4}-\d{2}-\d{2}/);
        if (!match) continue;

        const locationId = match[1];
        const location = ZONAL_LOCATIONS.find(l => l.id === locationId);
        if (!location) continue;

        const zoneCode = location.demandColumn;
        const zoneCities: WeatherLocation[] = zonalByZone.get(zoneCode) || [];
        const cityIndex = zoneCities.findIndex((c: WeatherLocation) => c.id === locationId);

        const weatherData = parseWeatherCsv(filePath);
        zonalWeatherSets.push({
          city: weatherData.city,
          locationId,
          zoneCode,
          cityIndex,
          records: weatherData.records
        });
      }

      console.log(`  Weather mapped: ${zonalWeatherSets.length} city datasets across ${zones.length} zones`);

      // Merge demand with zonal weather
      console.log('\n🔗 Merging demand with zonal weather...');
      const zonalMerged = mergeZonalData(demandData.records, zonalWeatherSets);
      console.log(`  Merged records: ${zonalMerged.length}`);

      // Convert ZonalMergedRecord to standard MergedRecord using city1 weather
      mergedRecords = zonalMerged.map(rec => ({
        datetime: rec.datetime,
        region: rec.zone,
        demand: rec.demand,
        weather: rec.weather.city1
      }));
    } else {
      // Regional mode: use 3 cities (Manila, Cebu, Davao)
      const regionalWeatherService = new WeatherService({
        apiKey,
        cacheDir: cacheDir,
        locations: DEFAULT_LOCATIONS
      });

      console.log(`  Fetching weather for ${DEFAULT_LOCATIONS.length} regional cities...`);
      const weatherFiles = await regionalWeatherService.saveWeatherFiles(
        weatherStart,
        weatherEnd,
        join(cacheDir, 'combined'),
        (msg) => console.log(`  ${msg}`)
      );

      const weatherDatasets = weatherFiles.map(file => parseWeatherCsv(file));
      console.log(`  Fetched weather for ${weatherDatasets.length} locations`);

      // Merge demand and weather
      console.log('\n🔗 Merging demand and weather data...');
      const merged = mergeData(demandData, weatherDatasets);
      console.log(`  Matched: ${merged.matchedCount} records`);
      console.log(`  Unmatched demand: ${merged.unmatchedDemand}, weather: ${merged.unmatchedWeather}`);
      mergedRecords = merged.records;
    }

    // 4. Build training samples
    console.log('\n🔧 Engineering features...');
    const allSamples = buildTrainingSamples(mergedRecords, options.zonal);
    console.log(`  Total samples: ${allSamples.length}`);

    if (allSamples.length === 0) {
      throw new Error('No training samples available. Need more historical data for lag features.');
    }

    // Split into training and holdout
    const cutoffDate = DateTime.fromJSDate(demandData.endDate).minus({ days: holdoutDays });
    const trainingSamples = allSamples.filter(s => DateTime.fromJSDate(s.datetime) < cutoffDate);
    const holdoutSamples = allSamples.filter(s => DateTime.fromJSDate(s.datetime) >= cutoffDate);

    console.log(`  Training samples: ${trainingSamples.length}`);
    console.log(`  Holdout samples: ${holdoutSamples.length}`);

    // Get date range for metadata
    const trainingStart = options.startDate || DateTime.fromJSDate(demandData.startDate).toISODate()!;
    const trainingEnd = cutoffDate.toISODate()!;

    // Update instance with resolved date range
    instanceService.setDateRange(instanceId, trainingStart, trainingEnd);

    // Store applied overrides
    if (options.overrides) {
      instanceService.setAppliedOverrides(instanceId, overrides);
    }

    // 5. Train model for each entity
    console.log('\n🎯 Training models...');

    for (const entityCode of entities) {
      try {
        // Check for overrides
        const entityType = options.zonal ? 'zone' : 'region';
        const override = overrideService.getEffectiveOverride(
          entityCode,
          entityType,
          overrides
        );

        // Merge with defaults
        const effectiveConfig = overrideService.mergeWithDefaults(override, {
          modelType: options.modelType,
          calibrationIterations: 0, // Not used in current implementation
          holdoutDays: holdoutDays,
        });

        // Skip if disabled
        if (!effectiveConfig.enabled) {
          console.log(`\n  ${entityCode}: SKIPPED (disabled by override)`);
          results.push({
            success: true,
            entityType: options.zonal ? 'zonal' : 'regional',
            entityCode,
            activated: false,
          });
          continue;
        }

        console.log(`\n  Training ${entityCode}...`);
        if (override) {
          const overrideParts: string[] = [];
          if (effectiveConfig.scalingPercent !== 0) {
            overrideParts.push(`scaling: ${effectiveConfig.scalingPercent > 0 ? '+' : ''}${effectiveConfig.scalingPercent}%`);
          }
          if (override.modelType) {
            overrideParts.push(`model: ${effectiveConfig.modelType}`);
          }
          if (override.holdoutDays) {
            overrideParts.push(`holdout: ${effectiveConfig.holdoutDays}d`);
          }
          if (overrideParts.length > 0) {
            console.log(`    Overrides: ${overrideParts.join(', ')}`);
          }
        }

        // Use overridden holdout days
        const entityHoldoutDays = effectiveConfig.holdoutDays;
        const entityCutoffDate = DateTime.fromJSDate(demandData.endDate).minus({ days: entityHoldoutDays });

        // Filter samples for this entity with entity-specific holdout
        const entityAllSamples = allSamples.filter(s => s.region === entityCode);
        const entityTrainSamples = entityAllSamples.filter(s => DateTime.fromJSDate(s.datetime) < entityCutoffDate);
        const entityHoldoutSamples = entityAllSamples.filter(s => DateTime.fromJSDate(s.datetime) >= entityCutoffDate);

        if (entityTrainSamples.length < 100) {
          console.log(`    ⚠️  Insufficient data (${entityTrainSamples.length} samples), skipping`);
          results.push({
            success: false,
            entityType: options.zonal ? 'zonal' : 'regional',
            entityCode,
            error: `Insufficient training data: ${entityTrainSamples.length} samples`,
          });
          continue;
        }

        // Train HybridModel
        const model = new HybridModel();
        const trainResult = await model.train(entityTrainSamples);

        // Calculate holdout metrics (before scaling)
        const metricsBeforeScaling = calculateMetrics(model, entityHoldoutSamples);

        // Apply scaling if specified
        let metrics = metricsBeforeScaling;
        if (effectiveConfig.scalingPercent !== 0) {
          // Note: Scaling is applied during prediction, so we need to calculate metrics with scaling
          metrics = calculateMetricsWithScaling(model, entityHoldoutSamples, effectiveConfig.scalingPercent);
          console.log(`    Training R²: ${trainResult.r2Score.toFixed(4)}, MAPE: ${trainResult.mape.toFixed(2)}%`);
          console.log(`    Holdout MAPE (before scaling): ${metricsBeforeScaling.mape.toFixed(2)}%`);
          console.log(`    Holdout MAPE (after ${effectiveConfig.scalingPercent > 0 ? '+' : ''}${effectiveConfig.scalingPercent}% scaling): ${metrics.mape.toFixed(2)}%, MAE: ${metrics.mae.toFixed(2)}`);
        } else {
          console.log(`    Training R²: ${trainResult.r2Score.toFixed(4)}, MAPE: ${trainResult.mape.toFixed(2)}%`);
          console.log(`    Holdout MAPE: ${metrics.mape.toFixed(2)}%, MAE: ${metrics.mae.toFixed(2)}`);
        }

        // Serialize model state
        const modelState = model.toJSON();

        // Store scaling in model state if applied
        if (effectiveConfig.scalingPercent !== 0) {
          modelState.scalingPercent = effectiveConfig.scalingPercent;
        }

        // Update training end to reflect entity-specific holdout
        const entityTrainingEnd = entityCutoffDate.toISODate()!;

        // Create SavedModel object
        const savedModel: SavedModel = {
          metadata: {
            id: crypto.randomUUID(),
            entityType: options.zonal ? 'zonal' : 'regional',
            entityCode,
            isGroupModel: false,
            modelType: effectiveConfig.modelType as DemandModelType,
            version: 1,
            trainedAt: new Date().toISOString(),
            trainingPeriod: {
              start: trainingStart,
              end: entityTrainingEnd,
            },
            holdoutDays: entityHoldoutDays,
            trainingRecords: entityTrainSamples.length,
            testRecords: entityHoldoutSamples.length,
          },
          metrics: {
            ...metrics,
            trainingRecords: entityTrainSamples.length,
            testRecords: entityHoldoutSamples.length,
          },
          featureConfig: {
            features: [...FEATURE_NAMES],
            normalization: {},
          },
          modelData: {
            type: effectiveConfig.modelType as DemandModelType,
            data: modelState,
          },
        };

        // Check if new model is better than existing active model
        let shouldActivate = autoActivate;
        if (autoActivate) {
          const activeModel = getActiveModel(
            options.zonal ? 'zonal' : 'regional',
            entityCode
          );
          if (activeModel && activeModel.metrics.mape < metrics.mape) {
            console.log(`    ⚠️  New model MAPE (${metrics.mape.toFixed(2)}%) is worse than active (${activeModel.metrics.mape.toFixed(2)}%)`);
            shouldActivate = false;
          }
        }

        // Save model
        const modelId = saveModel(savedModel, 'cli-train');

        // Activate if appropriate
        if (shouldActivate) {
          activateModel(modelId);
          console.log(`    ✓ Model saved and activated (ID: ${modelId.slice(0, 8)}...)`);
        } else {
          console.log(`    ✓ Model saved but NOT activated (ID: ${modelId.slice(0, 8)}...)`);
        }

        // Add model summary to training instance
        const modelSummary: ModelSummary = {
          entityCode,
          modelId,
          modelType: effectiveConfig.modelType as string,
          mape: metrics.mape,
          mae: metrics.mae,
          rmse: metrics.rmse,
          isActive: shouldActivate,
          scalingApplied: effectiveConfig.scalingPercent !== 0 ? effectiveConfig.scalingPercent : undefined,
        };

        instanceService.addModelSummary(
          instanceId,
          options.zonal ? 'demandZonal' : 'demandRegional',
          modelSummary
        );

        results.push({
          success: true,
          modelId,
          entityType: options.zonal ? 'zonal' : 'regional',
          entityCode,
          metrics,
          activated: shouldActivate,
          trainingInstanceId: instanceId,
        });

      } catch (error: any) {
        console.log(`    ❌ Failed: ${error.message}`);
        results.push({
          success: false,
          entityType: options.zonal ? 'zonal' : 'regional',
          entityCode,
          error: error.message,
        });
      }
    }

    console.log('\n✅ Training complete!');

    // Calculate aggregate metrics and complete instance
    const successfulResults = results.filter(r => r.success && r.metrics);
    if (successfulResults.length > 0) {
      const mapeValues = successfulResults.map(r => r.metrics!.mape);
      const avgMape = mapeValues.reduce((a, b) => a + b, 0) / mapeValues.length;

      const aggregateMetrics: AggregateMetrics = options.zonal
        ? { demandZonalMape: avgMape }
        : { demandRegionalMape: avgMape };

      instanceService.completeInstance(instanceId, aggregateMetrics);
    } else {
      // Mark as failed if no models succeeded
      instanceService.failInstance(instanceId, 'No models trained successfully');
    }

    return results;

  } catch (error: any) {
    console.error(`\n❌ Training failed: ${error.message}`);

    // Mark instance as failed
    try {
      const instanceService = getTrainingInstanceService();
      instanceService.failInstance(instanceId, error.message);
    } catch (e) {
      console.error('Failed to update training instance:', e);
    }

    throw error;
  }
}

/**
 * Calculate metrics for a model on a set of samples
 */
function calculateMetrics(model: HybridModel, samples: TrainingSample[]): ModelMetrics {
  if (samples.length === 0) {
    return {
      mape: 0,
      rmse: 0,
      mae: 0,
      r2Score: 0,
      bias: 0,
      trainingRecords: 0,
      testRecords: 0,
    };
  }

  let totalAbsError = 0;
  let totalAbsPercentError = 0;
  let totalSquaredError = 0;
  let totalBias = 0;
  let ssRes = 0;
  let ssTot = 0;
  let validCount = 0;

  const meanDemand = samples.reduce((sum, s) => sum + s.demand, 0) / samples.length;

  for (const sample of samples) {
    const predicted = model.predict(sample.features, sample.region);
    if (predicted === undefined) continue;

    const error = predicted - sample.demand;
    const absError = Math.abs(error);

    totalAbsError += absError;
    totalAbsPercentError += (absError / Math.max(sample.demand, 1)) * 100;
    totalSquaredError += error * error;
    totalBias += error;
    ssRes += error * error;
    ssTot += Math.pow(sample.demand - meanDemand, 2);
    validCount++;
  }

  if (validCount === 0) {
    return {
      mape: 100,
      rmse: 0,
      mae: 0,
      r2Score: 0,
      bias: 0,
      trainingRecords: 0,
      testRecords: samples.length,
    };
  }

  return {
    mape: totalAbsPercentError / validCount,
    rmse: Math.sqrt(totalSquaredError / validCount),
    mae: totalAbsError / validCount,
    r2Score: ssTot > 0 ? 1 - (ssRes / ssTot) : 0,
    bias: totalBias / validCount,
    trainingRecords: 0,
    testRecords: validCount,
  };
}

/**
 * Calculate metrics for a model with scaling applied
 */
function calculateMetricsWithScaling(
  model: HybridModel,
  samples: TrainingSample[],
  scalingPercent: number
): ModelMetrics {
  if (samples.length === 0) {
    return {
      mape: 0,
      rmse: 0,
      mae: 0,
      r2Score: 0,
      bias: 0,
      trainingRecords: 0,
      testRecords: 0,
    };
  }

  let totalAbsError = 0;
  let totalAbsPercentError = 0;
  let totalSquaredError = 0;
  let totalBias = 0;
  let ssRes = 0;
  let ssTot = 0;
  let validCount = 0;

  const meanDemand = samples.reduce((sum, s) => sum + s.demand, 0) / samples.length;

  for (const sample of samples) {
    const rawPredicted = model.predict(sample.features, sample.region);
    if (rawPredicted === undefined) continue;

    // Apply scaling
    const predicted = overrideService.applyScaling(rawPredicted, scalingPercent);

    const error = predicted - sample.demand;
    const absError = Math.abs(error);

    totalAbsError += absError;
    totalAbsPercentError += (absError / Math.max(sample.demand, 1)) * 100;
    totalSquaredError += error * error;
    totalBias += error;
    ssRes += error * error;
    ssTot += Math.pow(sample.demand - meanDemand, 2);
    validCount++;
  }

  if (validCount === 0) {
    return {
      mape: 100,
      rmse: 0,
      mae: 0,
      r2Score: 0,
      bias: 0,
      trainingRecords: 0,
      testRecords: samples.length,
    };
  }

  return {
    mape: totalAbsPercentError / validCount,
    rmse: Math.sqrt(totalSquaredError / validCount),
    mae: totalAbsError / validCount,
    r2Score: ssTot > 0 ? 1 - (ssRes / ssTot) : 0,
    bias: totalBias / validCount,
    trainingRecords: 0,
    testRecords: validCount,
  };
}

/**
 * Train CFAC models (per-station or group)
 *
 * This is a placeholder stub for now. Full CFAC training integration
 * requires refactoring the existing cfac forecast2 code into reusable services.
 *
 * To train CFAC models currently, use:
 *   node dist/index.js cfac forecast2 -t "Data Samples/Capacity Factor" -s START -e END -o output.csv
 *
 * The trained models can then be manually saved using saveTrainedModel() helper.
 */
export async function trainCFACModels(
  options: CFACTrainingOptions
): Promise<TrainingResult[]> {
  console.log('\n[CFAC Training] CFAC model training via CLI is not yet fully integrated');
  console.log('');
  console.log('Current workaround:');
  console.log('1. Train models using: node dist/index.js cfac forecast2 -t "path" -s START -e END -o out.csv');
  console.log('2. Models will be trained and you can manually save them to the model store');
  console.log('');
  console.log('Full CLI integration will be available in a future update.');

  return [];
}


/**
 * Helper: Create and save a model manually
 *
 * This function can be used to save a model after training with existing code.
 */
export function saveTrainedModel(
  entityType: 'regional' | 'zonal' | 'wind' | 'solar' | 'hydro' | 'biomass' | 'geothermal' | 'battery',
  entityCode: string,
  modelType: string,
  trainingStart: string,
  trainingEnd: string,
  metrics: ModelMetrics,
  modelData: any,
  autoActivate: boolean = true
): string {
  const savedModel: SavedModel = {
    metadata: {
      id: crypto.randomUUID(),
      entityType,
      entityCode,
      isGroupModel: false,
      modelType: modelType as any,
      version: 1,
      trainedAt: new Date().toISOString(),
      trainingPeriod: {
        start: trainingStart,
        end: trainingEnd,
      },
      holdoutDays: 14,
      trainingRecords: metrics.trainingRecords,
      testRecords: metrics.testRecords,
    },
    metrics,
    featureConfig: {
      features: [...FEATURE_NAMES],
      normalization: {},
    },
    modelData: {
      type: modelType as any,
      data: modelData,
    },
  };

  const modelId = saveModel(savedModel, 'manual');

  if (autoActivate) {
    activateModel(modelId);
  }

  return modelId;
}
