/**
 * Global Forecast Configuration Types
 *
 * Defines the structure for forecast_config.json - the single source of truth
 * for all forecast settings across Manual, Scheduler, and Backfill modes.
 *
 * @see Documents/planning/UNIFIED_FORECAST_SYSTEM_PLAN.md
 */

/**
 * Paths configuration for data and output directories
 */
export interface PathsConfig {
  /** Path to demand training data folder */
  demandTraining: string;
  /** Path to capacity factor training data folder */
  cfacTraining: string;
  /** Output directory for forecasts */
  output: string;
  /** Archive directory for historical forecasts */
  archive: string;
  /** Weather cache directory */
  weatherCache: string;
}

/**
 * Database paths configuration
 */
export interface DatabasesConfig {
  /** Scheduler database (forecast runs, calibration history) */
  scheduler: string;
  /** Regional demand database (3 regions) */
  regionalDemand: string;
  /** Zonal demand database (14 zones) */
  zonalDemand: string;
}

/**
 * Calibration settings for System B (iterative calibration)
 */
export interface CalibrationConfig {
  /** Enable automatic calibration */
  enabled: boolean;
  /** Number of days to use for calibration (default: 7) */
  days: number;
  /** Convergence threshold percentage (default: 5) */
  threshold: number;
  /** Maximum calibration iterations (default: 10) */
  maxIterations: number;
}

/**
 * Capacity Factor (CFAC) model options
 */
export interface CfacConfig {
  /** Use XGBoost for ML layer instead of linear regression */
  useXgboost: boolean;
  /** Penalize under-predictions 2x (reduces under-forecasting bias) */
  asymmetricLoss: boolean;
  /** Apply station-specific bias correction */
  biasCorrection: boolean;
}

/**
 * Demand model options
 */
export interface DemandConfig {
  /** Model type: hybrid (recommended), regression, or xgboost */
  model: 'hybrid' | 'regression' | 'xgboost';
  /** Geography mode: regional (3 regions) or zonal (14 sub-regions) */
  geography: 'regional' | 'zonal';
  /** Daily growth rate adjustment (e.g., 0.001 for 0.1%) */
  growthRate: number;
}

/**
 * Weather fetching configuration
 */
export interface WeatherConfig {
  /** Maximum age of cached weather data in hours before refresh */
  maxAgeHours: number;
  /** Weather refresh mode: auto (check age), always (force refresh), never (cache only) */
  refreshMode: 'auto' | 'always' | 'never';
}

/**
 * Output and archiving configuration
 */
export interface OutputConfig {
  /** Enable automatic archiving of forecasts */
  archiveEnabled: boolean;
  /** Retention period for archived forecasts in days */
  retentionDays: number;
  /** File naming convention: gateway (standard) or legacy */
  naming: 'gateway' | 'legacy';
}

/**
 * Gateway integration configuration
 */
export interface GatewayConfig {
  /** Enable gateway integration */
  enabled: boolean;
  /** Automatically push forecasts after generation */
  autoPush: boolean;
}

/**
 * Scheduler service configuration
 */
export interface SchedulerConfig {
  /** Enable scheduler service */
  enabled: boolean;
  /** Times to run scheduler (HH:MM format, 24-hour) */
  runTimes: string[];
  /** Days to run (1=Monday, 7=Sunday) */
  runDays: number[];
  /** Forecast types to generate */
  forecastTypes: ('demand' | 'cfac')[];
  /** Forecast horizons to generate */
  horizons: ('daily' | 'weekly')[];
}

/**
 * Global Forecast Configuration
 *
 * This is the main configuration interface that represents the entire
 * forecast_config.json file structure.
 */
export interface GlobalForecastConfig {
  /** Config version for migration compatibility */
  version: number;

  /** Data and output paths */
  paths: PathsConfig;

  /** Database file paths */
  databases: DatabasesConfig;

  /** Calibration settings */
  calibration: CalibrationConfig;

  /** Capacity Factor model options */
  cfac: CfacConfig;

  /** Demand model options */
  demand: DemandConfig;

  /** Weather fetching settings */
  weather: WeatherConfig;

  /** Output and archiving settings */
  output: OutputConfig;

  /** Gateway integration settings */
  gateway: GatewayConfig;

  /** Scheduler service settings */
  scheduler: SchedulerConfig;
}

/**
 * Partial config for updates (allows setting individual values)
 */
export type PartialGlobalForecastConfig = {
  [K in keyof GlobalForecastConfig]?:
    GlobalForecastConfig[K] extends object
      ? Partial<GlobalForecastConfig[K]>
      : GlobalForecastConfig[K];
};

/**
 * Validation result for config checks
 */
export interface ConfigValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Config migration info
 */
export interface ConfigMigration {
  fromVersion: number;
  toVersion: number;
  migratedAt: string;
  changes: string[];
}
