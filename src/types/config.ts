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
 * Calibration settings for demand forecasting
 *
 * Supports three modes:
 * - 'hybrid': Iterative Scaling (Pass 1) + XGBoost Quantile Loss (Pass 2) - RECOMMENDED
 * - 'iterative': Iterative Scaling only (fast, deterministic)
 * - 'xgboost': XGBoost only (legacy, prone to peak crushing)
 * - 'none': No calibration applied
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

  // Hybrid Calibration Settings (added 2026-03-20)
  /** Calibration mode: hybrid (recommended), iterative, xgboost, or none */
  mode: 'hybrid' | 'iterative' | 'xgboost' | 'none';
  /** Quantile loss alpha parameter (0.5-0.95). Higher = penalize under-predictions more.
   *  Default 0.80 gives 4:1 penalty ratio for under-prediction */
  quantileAlpha: number;
  /** Enable zone-specific scaling adjustments (recommended for zonal forecasts) */
  enableZoneScaling: boolean;
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
  /** Zone and region-specific scaling adjustments */
  scaling?: {
    /** Per-zone scaling percentages (e.g., { "01NLUZ": -5 }) */
    zones: Record<string, number>;
    /** Per-region scaling percentages (e.g., { "CLUZ": 2 }) */
    regions: Record<string, number>;
  };
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
 *
 * PHASE 2 UPDATE (Gateway v2.5.0):
 * - NEW: HTTP-based uploads with explicit geography parameter
 * - NEW: License-based JWT authentication
 * - DEPRECATED: SFTP uploads (still available as fallback)
 */
export interface GatewayConfig {
  /** Enable gateway integration */
  enabled: boolean;
  /** Automatically push forecasts after generation */
  autoPush: boolean;

  // HTTP Gateway settings (v2.5.0+)
  /** Gateway HTTP URL (e.g., https://vantage-gateway.taile437a5.ts.net) */
  httpUrl?: string;
  /** License ID for JWT authentication */
  licenseId?: string;
  /** Prefer HTTP upload over SFTP when both are available (default: true) */
  preferHttp?: boolean;

  // SFTP Gateway settings (legacy, used as fallback)
  /** SFTP host address */
  sftpHost?: string;
  /** SFTP port (default: 22) */
  sftpPort?: number;
  /** SFTP username */
  sftpUser?: string;
  /** SFTP password */
  sftpPassword?: string;
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
 * Model selection configuration for using pre-trained models
 * Instead of training fresh models for each forecast run
 */
export interface ModelSelectionConfig {
  /** Enable use of pre-trained models instead of training fresh */
  useTrainedModels: boolean;
  /** Default demand model ID from model store (null = train fresh) */
  defaultDemandModel: string | null;
  /** Default CFAC model ID from model store (null = train fresh) */
  defaultCfacModel: string | null;
  /** Active CFAC calibration ID (null = train fresh, uses CFACCalibrationService) */
  activeCfacCalibrationId: string | null;
  /** Per-entity model overrides: entity_code -> model_id */
  modelOverrides: Record<string, string>;
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

  /** Model selection settings (use pre-trained models) */
  modelSelection?: ModelSelectionConfig;
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
