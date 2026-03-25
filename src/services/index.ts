export * from './weatherService.js';
export * from './capacityFactorService.js';
export * from './outageAnalysisService.js';
export * from './iemopDownloadService.js';
export * from './capacityUpdateService.js';
export * from './configService.js';
export * from './unifiedForecastService.js';
export * from './modelStore.js';
export * from './modelTrainer.js';

// Training instance service - explicit re-export to avoid conflicts
export {
  TrainingInstanceService,
  getTrainingInstanceService,
  closeTrainingInstanceService,
  trainingInstanceService,
} from './trainingInstanceService.js';
export type {
  TrainingInstance as TrainingInstanceRecord,
  ModelSummary,
  AggregateMetrics,
} from './trainingInstanceService.js';

// CFAC retrain monitor
export {
  CfacRetrainMonitor,
  createCfacRetrainMonitor,
} from './cfacRetrainMonitor.js';
export type {
  RetrainAlert,
  CacheStatus,
} from './cfacRetrainMonitor.js';

// V2 Architecture - forecast generator (stateless forecast service)
export { saveDemandModel as saveDemandModelV2 } from './forecastGenerator.js';
export type { TrainingResult as TrainingResultV2 } from './forecastGenerator.js';

// V2 Architecture - override service (manual forecast adjustments)
export * from './overrideService.js';

// V2 Architecture - intraday refresh service (update forecasts mid-day)
export * from './intradayRefresh.js';

// V2 Architecture - training plan service (coordinated retraining schedules)
export * from './trainingPlanService.js';
