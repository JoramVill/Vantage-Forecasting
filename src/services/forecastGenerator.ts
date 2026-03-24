/**
 * Forecast Generator Service
 *
 * Generates forecasts using pre-trained models from the model store.
 * This service loads active models and applies them to weather data
 * to generate fast forecasts without retraining.
 */

import { DateTime } from 'luxon';
import crypto from 'crypto';
import { getActiveModel, getModelById, saveModel, initializeModelStore } from './modelStore.js';
import { EntityType, SavedModel, ModelRegistry } from '../types/models.js';
import { HybridModel, HybridModelState } from '../models/hybridModel.js';
import { FeatureVector } from '../types/index.js';
import { isPhilippineHoliday } from '../constants/index.js';

/**
 * Forecast generation options
 */
export interface ForecastOptions {
  startDate: string;
  endDate: string;
  entityTypes?: EntityType[];     // Filter by entity types
  entityCodes?: string[];         // Filter by specific codes
  outputPath?: string;            // Output CSV path
}

/**
 * Forecast result
 */
export interface ForecastGenerationResult {
  success: boolean;
  entityType: EntityType;
  entityCode: string;
  recordsGenerated?: number;
  modelId?: string;
  error?: string;
}

/**
 * Demand forecast record
 */
export interface DemandForecastRecord {
  datetime: Date;
  region: string;
  forecast: number;
}

/**
 * Training result for model saving
 */
export interface TrainingResult {
  mape: number;
  rmse: number;
  mae: number;
  r2Score: number;
  bias: number;
  sampleCount: number;
  trainingStart: string;
  trainingEnd: string;

  // Per-zone/region MAPE breakdown
  perZoneMape?: Record<string, number>;
  perRegionMape?: Record<string, number>;

  // Peak/Off-peak MAPE breakdown
  peakMape?: number;
  offpeakMape?: number;

  // Day type MAPE breakdown
  weekdayMape?: number;
  weekendMape?: number;
  holidayMape?: number;

  // Calibration info (optional)
  calibration?: {
    mode: 'hybrid' | 'iterative' | 'xgboost' | 'none';
    quantileAlpha?: number;
    enableZoneScaling?: boolean;
    pass1?: {
      peakScale: number;
      offpeakScale: number;
      zoneScales?: Record<string, number>;
      converged: boolean;
      iterations: number;
    };
    pass2?: {
      trainMAPE: number;
      validationMAPE: number;
      alpha: number;
    };
  };
}

/**
 * Load a demand model from the model store by ID
 */
export function loadDemandModelById(modelId: string): HybridModel | null {
  const savedModel = getModelById(modelId);
  if (!savedModel) {
    console.error(`Model not found: ${modelId}`);
    return null;
  }

  // Check if it's a demand model (regional or zonal)
  if (!['regional', 'zonal'].includes(savedModel.metadata.entityType)) {
    console.error(`Model ${modelId} is not a demand model (type: ${savedModel.metadata.entityType})`);
    return null;
  }

  // Restore HybridModel from saved state
  try {
    const model = HybridModel.fromJSON(savedModel.modelData.data as HybridModelState);
    console.log(`Loaded demand model: ${savedModel.metadata.entityCode} v${savedModel.metadata.version}`);
    return model;
  } catch (error: any) {
    console.error(`Failed to restore model: ${error.message}`);
    return null;
  }
}

/**
 * Load active demand model for a region/zone
 */
export function loadActiveDemandModel(
  entityType: 'regional' | 'zonal',
  entityCode: string
): HybridModel | null {
  const savedModel = getActiveModel(entityType, entityCode);
  if (!savedModel) {
    console.log(`No active model found for ${entityType}/${entityCode}`);
    return null;
  }

  try {
    const model = HybridModel.fromJSON(savedModel.modelData.data as HybridModelState);
    console.log(`Loaded active model: ${savedModel.metadata.entityCode} v${savedModel.metadata.version}`);
    return model;
  } catch (error: any) {
    console.error(`Failed to restore model: ${error.message}`);
    return null;
  }
}

/**
 * Save a trained demand model to the model store
 */
export function saveDemandModel(
  model: HybridModel,
  entityType: 'regional' | 'zonal',
  entityCode: string,
  trainingResult: TrainingResult,
  autoActivate: boolean = false,
  notes?: string
): string {
  // Ensure model store is initialized
  initializeModelStore();

  // Generate model ID
  const id = crypto.randomUUID();

  // Build calibration settings from training result
  const calibrationSettings = trainingResult.calibration ? {
    mode: trainingResult.calibration.mode,
    quantileAlpha: trainingResult.calibration.quantileAlpha,
    enableZoneScaling: trainingResult.calibration.enableZoneScaling,
    pass1: trainingResult.calibration.pass1,
    pass2: trainingResult.calibration.pass2,
  } : undefined;

  // Create SavedModel structure
  const savedModel: SavedModel = {
    metadata: {
      id,
      entityType: entityType as EntityType,
      entityCode,
      isGroupModel: entityCode === 'all' || entityCode.startsWith('all_'),
      modelType: 'hybrid',
      version: 1, // Will be updated by saveModel
      trainedAt: new Date().toISOString(),
      trainingPeriod: {
        start: trainingResult.trainingStart,
        end: trainingResult.trainingEnd,
      },
      holdoutDays: 7,
      trainingRecords: trainingResult.sampleCount,
      calibrationSettings,
    },
    metrics: {
      mape: trainingResult.mape,
      rmse: trainingResult.rmse,
      mae: trainingResult.mae,
      r2Score: trainingResult.r2Score,
      bias: trainingResult.bias,
      // Segmented MAPE
      peakMape: trainingResult.peakMape,
      offpeakMape: trainingResult.offpeakMape,
      // Day type MAPE
      weekdayMape: trainingResult.weekdayMape,
      weekendMape: trainingResult.weekendMape,
      holidayMape: trainingResult.holidayMape,
      // Per-zone/region breakdown
      perZoneMape: trainingResult.perZoneMape,
      perRegionMape: trainingResult.perRegionMape,
      trainingRecords: trainingResult.sampleCount,
      testRecords: Math.floor(trainingResult.sampleCount * 0.2),
    },
    featureConfig: {
      features: [
        'hour', 'dayOfWeek', 'month', 'isWeekend', 'isHoliday',
        'temp', 'humidity', 'cloudcover', 'windspeed'
      ],
      normalization: {},
    },
    modelData: {
      type: 'hybrid',
      data: (() => {
        const modelState = model.toJSON();
        // Extract structured calibration summary from model state
        const weekendFactors: Record<string, { saturday: number; sunday: number }> = {};
        for (const { region, factors } of modelState.weekendCorrectionFactors || []) {
          weekendFactors[region] = factors;
        }
        const calibration = {
          weekend_factors: weekendFactors,
          xgboost_correction: !!modelState.calibrator,
          pass1_calibrator: modelState.iterativeCalibrator?.calibrationResult || null,
          pass2_calibrator: modelState.calibrator?.metrics || null,
        };
        return {
          model: modelState,
          calibration,
          config: { geography: entityType, modelType: 'hybrid' }
        };
      })(),
    },
  };

  // Save to model store
  const savedId = saveModel(savedModel, 'forecast-generator', notes);
  console.log(`Saved demand model: ${entityType}/${entityCode} (ID: ${savedId})`);

  return savedId;
}

/**
 * Generate demand forecast using a loaded model
 *
 * @param model The HybridModel to use for predictions
 * @param weatherRecords Weather data records (must include temp, humidity, etc.)
 * @param regions List of regions/zones to forecast
 * @param startDate Start of forecast period
 * @param endDate End of forecast period
 */
export function generateDemandForecastWithModel(
  model: HybridModel,
  weatherRecords: Array<{
    datetime: Date;
    temp: number;
    humidity?: number;
    cloudcover?: number;
    windspeed?: number;
    precip?: number;
    uvindex?: number;
    solarradiation?: number;
  }>,
  regions: string[],
  demandHistory?: Map<string, number>
): DemandForecastRecord[] {
  const forecasts: DemandForecastRecord[] = [];

  for (const record of weatherRecords) {
    const dt = DateTime.fromJSDate(record.datetime);
    const hour = dt.hour;
    const dayOfWeek = dt.weekday; // 1=Monday, 7=Sunday
    const month = dt.month;
    const isWeekend = dayOfWeek >= 6;
    const isSaturday = dayOfWeek === 6;
    const isSunday = dayOfWeek === 7;
    const isHoliday = isPhilippineHoliday(dt.toISODate()!);

    const humidity = record.humidity ?? 70;
    const dew = calculateDewPoint(record.temp, humidity);

    // Build feature vector with all required FeatureVector properties
    const features: FeatureVector = {
      // Basic temporal
      hour,
      dayOfWeek,
      dayOfMonth: dt.day,
      month,
      isWeekend: isWeekend ? 1 : 0,
      isHoliday: isHoliday ? 1 : 0,

      // Cyclical hour encoding
      hourSin: Math.sin(2 * Math.PI * hour / 24),
      hourCos: Math.cos(2 * Math.PI * hour / 24),

      // Day type one-hot encoding
      isWorkday: (!isWeekend && !isHoliday) ? 1 : 0,
      isSaturday: isSaturday ? 1 : 0,
      isSunday: isSunday ? 1 : 0,

      // Hour one-hot encoding (24 features)
      hour_0: hour === 0 ? 1 : 0, hour_1: hour === 1 ? 1 : 0, hour_2: hour === 2 ? 1 : 0,
      hour_3: hour === 3 ? 1 : 0, hour_4: hour === 4 ? 1 : 0, hour_5: hour === 5 ? 1 : 0,
      hour_6: hour === 6 ? 1 : 0, hour_7: hour === 7 ? 1 : 0, hour_8: hour === 8 ? 1 : 0,
      hour_9: hour === 9 ? 1 : 0, hour_10: hour === 10 ? 1 : 0, hour_11: hour === 11 ? 1 : 0,
      hour_12: hour === 12 ? 1 : 0, hour_13: hour === 13 ? 1 : 0, hour_14: hour === 14 ? 1 : 0,
      hour_15: hour === 15 ? 1 : 0, hour_16: hour === 16 ? 1 : 0, hour_17: hour === 17 ? 1 : 0,
      hour_18: hour === 18 ? 1 : 0, hour_19: hour === 19 ? 1 : 0, hour_20: hour === 20 ? 1 : 0,
      hour_21: hour === 21 ? 1 : 0, hour_22: hour === 22 ? 1 : 0, hour_23: hour === 23 ? 1 : 0,

      // Hour-DayType interactions
      hourWorkday: (!isWeekend && !isHoliday) ? hour : 0,
      hourSaturday: isSaturday ? hour : 0,
      hourSunday: isSunday ? hour : 0,

      // Raw weather
      temp: record.temp,
      tempSquared: record.temp * record.temp,
      dew,
      precip: record.precip ?? 0,
      windgust: (record.windspeed ?? 5) * 1.5,
      windspeed: record.windspeed ?? 5,
      cloudcover: record.cloudcover ?? 50,
      solarradiation: record.solarradiation ?? 500,
      uvindex: record.uvindex ?? 5,

      // Derived weather
      relativeHumidity: humidity,
      heatIndex: calculateHeatIndex(record.temp, humidity),
      CDH: Math.max(0, record.temp - 24),
      effectiveSolar: (record.solarradiation ?? 500) * (1 - (record.cloudcover ?? 50) / 100),
      apparentTemp: record.temp, // Simplified
      isRaining: (record.precip ?? 0) > 0 ? 1 : 0,
      tempDewSpread: record.temp - dew,
      isDaytime: (hour >= 6 && hour <= 18) ? 1 : 0,

      // Lag features (optional - use defaults)
      demandLag1h: 0,
      demandLag24h: 0,
      demandLag168h: 0,
      tempLag1h: record.temp,
      tempLag24h: record.temp,

      // Rolling averages
      demandRolling24h: 0,
      tempRolling24h: record.temp,
      tempMax24h: record.temp,
    };

    // Generate predictions for each region
    for (const region of regions) {
      const prediction = model.predictForRegion(features, region);
      if (prediction !== undefined) {
        forecasts.push({
          datetime: record.datetime,
          region,
          forecast: Math.max(0, prediction), // Ensure non-negative
        });
      }
    }
  }

  return forecasts;
}

/**
 * Calculate heat index (simplified Rothfusz formula)
 */
function calculateHeatIndex(tempC: number, humidity: number): number {
  const tempF = tempC * 9/5 + 32;
  if (tempF < 80) return tempC;

  const hi = -42.379 + 2.04901523 * tempF + 10.14333127 * humidity
    - 0.22475541 * tempF * humidity - 0.00683783 * tempF * tempF
    - 0.05481717 * humidity * humidity + 0.00122874 * tempF * tempF * humidity
    + 0.00085282 * tempF * humidity * humidity - 0.00000199 * tempF * tempF * humidity * humidity;

  return (hi - 32) * 5/9;
}

/**
 * Calculate dew point (Magnus formula)
 */
function calculateDewPoint(tempC: number, humidity: number): number {
  const a = 17.27;
  const b = 237.7;
  const alpha = ((a * tempC) / (b + tempC)) + Math.log(humidity / 100);
  return (b * alpha) / (a - alpha);
}

/**
 * Get model registry info without loading full model
 */
export function getModelInfo(modelId: string): ModelRegistry | null {
  const savedModel = getModelById(modelId);
  if (!savedModel) {
    return null;
  }

  return {
    id: savedModel.metadata.id,
    entity_type: savedModel.metadata.entityType,
    entity_code: savedModel.metadata.entityCode,
    is_group_model: savedModel.metadata.isGroupModel ? 1 : 0,
    model_type: savedModel.metadata.modelType,
    model_config: null, // JSON config stored separately in modelData
    version: savedModel.metadata.version,
    trained_at: savedModel.metadata.trainedAt,
    training_start: savedModel.metadata.trainingPeriod.start,
    training_end: savedModel.metadata.trainingPeriod.end,
    training_records: savedModel.metadata.trainingRecords || 0,
    holdout_days: savedModel.metadata.holdoutDays || 7,
    mape: savedModel.metrics.mape,
    rmse: savedModel.metrics.rmse,
    mae: savedModel.metrics.mae,
    r2_score: savedModel.metrics.r2Score,
    bias: savedModel.metrics.bias,
    peak_mape: savedModel.metrics.peakMape || null,
    offpeak_mape: savedModel.metrics.offpeakMape || null,
    is_active: 0, // Would need to query DB for this
    is_archived: 0,
    file_path: '',
    file_size: null,
    checksum: null,
    created_at: savedModel.metadata.trainedAt,
    created_by: null,
    notes: null,
  };
}

/**
 * Generate forecasts using pre-trained models
 * (Legacy stub - kept for compatibility)
 */
export async function generateForecasts(
  options: ForecastOptions
): Promise<ForecastGenerationResult[]> {
  console.log('\n[Forecast Generation] Using model store');
  console.log(`  Date range: ${options.startDate} to ${options.endDate}`);

  // This would be implemented to load all active models and generate forecasts
  // For now, return empty array - actual implementation uses the specific functions above

  return [];
}

/**
 * Generate demand forecast for a single entity
 * (Legacy stub - kept for compatibility)
 */
export async function generateDemandForecast(
  entityType: 'regional' | 'zonal',
  entityCode: string,
  startDate: string,
  endDate: string
): Promise<ForecastGenerationResult> {
  // Load active model
  const model = getActiveModel(entityType, entityCode);

  if (!model) {
    return {
      success: false,
      entityType,
      entityCode,
      error: 'No active model found',
    };
  }

  return {
    success: true,
    entityType,
    entityCode,
    modelId: model.metadata.id,
    recordsGenerated: 0,
  };
}

/**
 * Generate CFAC forecast for a single station
 * (Legacy stub - kept for compatibility)
 */
export async function generateCFACForecast(
  stationType: 'wind' | 'solar' | 'hydro' | 'biomass' | 'geothermal' | 'battery',
  stationCode: string,
  startDate: string,
  endDate: string
): Promise<ForecastGenerationResult> {
  // Load active model (or group model)
  let model = getActiveModel(stationType, stationCode);

  if (!model) {
    // Try group model
    model = getActiveModel(stationType, `all_${stationType}`);
  }

  if (!model) {
    return {
      success: false,
      entityType: stationType,
      entityCode: stationCode,
      error: 'No active model or group model found',
    };
  }

  return {
    success: true,
    entityType: stationType,
    entityCode: stationCode,
    modelId: model.metadata.id,
    recordsGenerated: 0,
  };
}
