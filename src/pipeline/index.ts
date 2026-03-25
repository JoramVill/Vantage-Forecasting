/**
 * Pipeline exports - V2 Architecture
 *
 * Centralized exports for all training/calibration/forecast pipelines.
 */

// Demand V2 Pipelines - Named exports to avoid conflicts
export { TrainPipeline } from './TrainPipeline.js';
export type { TrainPipelineConfig } from './TrainPipeline.js';

export { CalibratePipeline } from './CalibratePipeline.js';
export type { CalibratePipelineConfig } from './CalibratePipeline.js';

export { ForecastPipeline } from './ForecastPipeline.js';
export type { ForecastPipelineConfig } from './ForecastPipeline.js';

export { ModelSerializer } from './ModelSerializer.js';
export type {
  DemandV2ModelArtifact,
  CalibrationSnapshot,
} from './ModelSerializer.js';

// CFAC V2 Pipelines
export { trainCfacModels } from './CfacTrainPipeline.js';
export { calibrateCfacModels } from './CfacCalibratePipeline.js';
export { generateCfacForecast } from './CfacForecastPipeline.js';

export {
  saveCfacModel,
  loadCfacModel,
  saveCfacCalibration,
  loadCfacCalibration,
} from './CfacModelSerializer.js';
export type {
  CfacV2ModelData,
  CfacV2Calibration,
} from './CfacModelSerializer.js';
