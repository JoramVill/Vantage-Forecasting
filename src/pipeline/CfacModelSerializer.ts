/**
 * CFAC Model Serializer
 *
 * Handles serialization and deserialization of CFAC V2 models and calibration data.
 * Provides a unified interface for saving and loading:
 * - cfac_model.vfm: Trained model weights, parameters, and configuration
 * - cfac_calibration.json: Calibration factors (global bias + hourly scales)
 */

import { serialize, deserialize } from '../services/modelSerializer.js';
import { SavedModel, ModelType } from '../types/models.js';
import fs from 'fs';
import path from 'path';

/**
 * CFAC V2 Calibration Data
 *
 * Contains per-station correction factors computed during calibration phase.
 * Applied at inference time to adjust model predictions.
 */
export interface CfacV2Calibration {
  calibrationDate: string;
  modelVersion: string; // Reference to .vfm file used
  calibrationDays: number;

  wind: {
    [stationCode: string]: {
      globalBias: number;
      hourlyScale: number[]; // 24 values (one per hour)
      sampleCount: number;
      calibrationDate: string;
    };
  };

  solar: {
    [stationCode: string]: {
      globalBias: number;
      hourlyScale: number[]; // 24 values (0 for night hours, >0 for daylight)
      sampleCount: number;
      calibrationDate: string;
    };
  };

  profile: {
    [stationCode: string]: {
      recentMedian: number;
      seasonalScale: number;
    };
  };

  metrics: {
    wind: { [stationCode: string]: { mape: number } };
    solar: { [stationCode: string]: { mape: number } };
    profile: { [stationCode: string]: { mape: number } };
  };
}

/**
 * CFAC V2 Model Data
 *
 * Serialized model state for all station types.
 * This is the payload stored in cfac_model.vfm.
 */
export interface CfacV2ModelData {
  version: string; // 'cfac-v2'
  trainedAt: string;
  trainingPeriod: { start: string; end: string };

  // Wind models (4-Tier Hybrid)
  wind: {
    [stationCode: string]: {
      mrecFactors: {
        stationCode: string;
        stationType: string;
        MRecLow: number;
        MRecRamp: number;
        MRecRated: number;
        MRecHigh: number;
        vLow: number;
        vRated: number;
        vHigh: number;
        calibrated: boolean;
        calibrationDate: string;
        sampleCount: number;
      };
      residualModel: {
        weights: number[][];
        inputs: number;
        outputs: number;
      } | null;
      useXGBoost: boolean;
      xgboostModel?: any; // XGBoost serialized state (if used)
    };
  };

  // Solar models (Physics + ML Hybrid)
  solar: {
    [stationCode: string]: {
      irradianceModelParams: {
        tempCoeff: number;
        systemLoss: number;
      };
      residualModel: {
        weights: number[][];
        inputs: number;
        outputs: number;
      } | null;
      drySeasonResidualModel: {
        weights: number[][];
        inputs: number;
        outputs: number;
      } | null;
      biasCorrection: number;
      drySeasonBiasCorrection: number;
      hourlyCorrection: Array<[number, number]>;
      drySeasonHourlyCorrection: Array<[number, number]>;
    };
  };

  // Profile models (Hydro, Geothermal, Biomass, Battery)
  profile: {
    [stationCode: string]: {
      profiles: Array<{
        key: string; // "hour_dayType" or "hour_dayType_month"
        stats: {
          min: number;
          median: number;
          max: number;
          mean: number;
          stdDev: number;
          count: number;
        };
      }>;
    };
  };

  // Station metadata snapshot
  stations: {
    [stationCode: string]: {
      name: string;
      type: string;
      capacity_mw: number;
      location: { latitude: number; longitude: number };
      grid: string;
    };
  };

  // Training configuration
  config: {
    windScaleClamp: [number, number];
    solarScaleClamp: [number, number];
    profileScaleClamp: [number, number];
    solarAlpha: number;
    tempCoefficient: number;
    confidenceThreshold: number;
  };
}

/**
 * Save CFAC V2 model to .vfm file
 */
export function saveCfacModel(modelData: CfacV2ModelData, outputPath: string): void {
  // Wrap in SavedModel structure
  const savedModel: SavedModel = {
    metadata: {
      id: `cfac-v2-${Date.now()}`,
      entityType: 'wind', // Use a valid EntityType (wind, solar, etc.)
      entityCode: 'all_stations',
      isGroupModel: true,
      modelType: 'hybrid' as ModelType,
      version: 1,
      trainedAt: modelData.trainedAt,
      trainingPeriod: modelData.trainingPeriod,
      trainingRecords: 0, // Calculated by caller
      holdoutDays: 0,
    },
    metrics: {
      mape: 0, // Aggregate metric calculated by caller
      rmse: 0,
      mae: 0,
      r2Score: 0,
      bias: 0,
      trainingRecords: 0,
      testRecords: 0,
    },
    featureConfig: {
      features: [],
      normalization: {},
    },
    modelData: {
      type: 'hybrid' as ModelType,
      data: modelData,
    },
  };

  // Serialize to MessagePack binary
  const buffer = serialize(savedModel);
  fs.writeFileSync(outputPath, buffer);

  console.log(`Saved CFAC V2 model: ${outputPath}`);
  console.log(`  Size: ${(buffer.length / 1024).toFixed(1)} KB`);
  console.log(`  Wind stations: ${Object.keys(modelData.wind).length}`);
  console.log(`  Solar stations: ${Object.keys(modelData.solar).length}`);
  console.log(`  Profile stations: ${Object.keys(modelData.profile).length}`);
}

/**
 * Load CFAC V2 model from .vfm file
 */
export function loadCfacModel(modelPath: string): CfacV2ModelData {
  if (!fs.existsSync(modelPath)) {
    throw new Error(`Model file not found: ${modelPath}`);
  }

  const buffer = fs.readFileSync(modelPath);
  const savedModel = deserialize(buffer);

  // Validate model type (accept hybrid for CFAC V2)
  if (savedModel.modelData.type !== 'hybrid' && savedModel.modelData.type !== '4tier') {
    console.warn(`Warning: Model type is '${savedModel.modelData.type}', expected 'hybrid' or '4tier' for CFAC V2`);
  }

  return savedModel.modelData.data as CfacV2ModelData;
}

/**
 * Save CFAC V2 calibration to JSON file
 */
export function saveCfacCalibration(calibration: CfacV2Calibration, outputPath: string): void {
  fs.writeFileSync(outputPath, JSON.stringify(calibration, null, 2), 'utf-8');

  console.log(`Saved CFAC V2 calibration: ${outputPath}`);
  console.log(`  Calibration date: ${calibration.calibrationDate}`);
  console.log(`  Calibration days: ${calibration.calibrationDays}`);
  console.log(`  Wind stations: ${Object.keys(calibration.wind).length}`);
  console.log(`  Solar stations: ${Object.keys(calibration.solar).length}`);
  console.log(`  Profile stations: ${Object.keys(calibration.profile).length}`);
}

/**
 * Load CFAC V2 calibration from JSON file
 */
export function loadCfacCalibration(calibrationPath: string): CfacV2Calibration {
  if (!fs.existsSync(calibrationPath)) {
    throw new Error(`Calibration file not found: ${calibrationPath}`);
  }

  const content = fs.readFileSync(calibrationPath, 'utf-8');
  return JSON.parse(content) as CfacV2Calibration;
}
