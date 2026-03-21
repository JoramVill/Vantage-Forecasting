/**
 * Model Management Types
 *
 * Type definitions for the model storage and management system.
 */

// Entity types for model categorization
export type DemandEntityType = 'regional' | 'zonal';
export type CFACEntityType = 'wind' | 'solar' | 'hydro' | 'biomass' | 'geothermal' | 'battery';
export type CalibrationEntityType = 'calibration';  // For CFAC calibration factors
export type EntityType = DemandEntityType | CFACEntityType | CalibrationEntityType;

// Model types
export type DemandModelType = 'xgboost' | 'hybrid' | 'regression';
export type CFACModelType = '4tier' | 'mrec' | 'physics' | 'hybrid' | 'xgboost';
export type CalibrationModelType = 'scaling';  // Calibration uses scaling factors
export type ModelType = DemandModelType | CFACModelType | CalibrationModelType;

/**
 * Demand calibration settings used during training
 */
export interface DemandCalibrationSettings {
  mode: 'hybrid' | 'iterative' | 'xgboost' | 'none';
  quantileAlpha?: number;               // For XGBoost modes (0.5-0.95)
  enableZoneScaling?: boolean;          // Per-zone scaling in iterative mode

  // Pass 1 results (IterativeScaling)
  pass1?: {
    peakScale: number;                  // Peak hour scaling %
    offpeakScale: number;               // Off-peak hour scaling %
    zoneScales?: Record<string, number>; // Per-zone scaling %
    converged: boolean;
    iterations: number;
  };

  // Pass 2 results (XGBoost)
  pass2?: {
    trainMAPE: number;
    validationMAPE: number;
    alpha: number;
  };
}

/**
 * Model metadata - identification and training information
 */
export interface ModelMetadata {
  id: string;                           // UUID
  entityType: EntityType;               // Type of entity (regional, zonal, wind, solar, etc.)
  entityCode: string;                   // Specific entity code (CLUZ, 01NLUZ, 01BURGOS, all_wind, etc.)
  isGroupModel: boolean;                // True if this is a group model (e.g., all_solar)
  modelType: ModelType;                 // Model algorithm type
  version: number;                      // Auto-increment per entity
  trainedAt: string;                    // ISO timestamp
  trainingPeriod: {
    start: string;                      // Training period start date
    end: string;                        // Training period end date
  };
  holdoutDays: number;                  // Days held out for testing
  trainingRecords: number;              // Number of records used for training
  testRecords?: number;                 // Number of records used for testing

  // Demand-specific settings (only for demand models)
  calibrationSettings?: DemandCalibrationSettings;
}

/**
 * Model performance metrics
 */
export interface ModelMetrics {
  mape: number;                         // Mean Absolute Percentage Error
  rmse: number;                         // Root Mean Squared Error
  mae: number;                          // Mean Absolute Error
  r2Score: number;                      // R-squared score
  bias: number;                         // Average bias (over/under prediction)

  // Segmented MAPE breakdown
  peakMape?: number;                    // MAPE during peak hours (9am-9pm)
  offpeakMape?: number;                 // MAPE during off-peak hours (9pm-9am)

  // Day type MAPE breakdown
  weekdayMape?: number;                 // MAPE on weekdays (Mon-Fri)
  weekendMape?: number;                 // MAPE on weekends (Sat-Sun)
  holidayMape?: number;                 // MAPE on holidays

  // Per-zone/region breakdown (for demand models)
  perZoneMape?: Record<string, number>;    // Per-zone MAPE (zonal models)
  perRegionMape?: Record<string, number>;  // Per-region MAPE (regional models)

  trainingRecords: number;              // Records used in training
  testRecords: number;                  // Records used in testing
}

/**
 * Feature configuration for model reproducibility
 */
export interface ModelFeatureConfig {
  features: string[];                                           // Feature names in order
  normalization: Record<string, { mean: number; std: number }>; // Normalization parameters
  categoricalMappings?: Record<string, Record<string, number>>; // Categorical encodings
}

/**
 * Model-specific data (varies by model type)
 */
export interface ModelData {
  type: ModelType;
  data: any;  // Type varies:
              // XGBoost: serialized booster
              // Regression: { coefficients: number[], intercept: number }
              // CFAC: { mrecFactors: {...}, mlWeights: {...} }
}

/**
 * Complete saved model structure
 */
export interface SavedModel {
  metadata: ModelMetadata;
  metrics: ModelMetrics;
  featureConfig: ModelFeatureConfig;
  modelData: ModelData;
}

/**
 * Model registry database row
 */
export interface ModelRegistry {
  id: string;

  // Entity identification
  entity_type: string;
  entity_code: string;
  is_group_model: number;               // SQLite stores boolean as 0/1

  // Model configuration
  model_type: string;
  model_config: string | null;          // JSON blob
  version: number;

  // Training metadata
  trained_at: string;
  training_start: string | null;
  training_end: string | null;
  training_records: number | null;
  holdout_days: number | null;

  // Performance metrics
  mape: number | null;
  rmse: number | null;
  mae: number | null;
  r2_score: number | null;
  bias: number | null;
  peak_mape: number | null;
  offpeak_mape: number | null;

  // Status
  is_active: number;                    // SQLite stores boolean as 0/1
  is_archived: number;                  // SQLite stores boolean as 0/1

  // File reference
  file_path: string;
  file_size: number | null;
  checksum: string | null;              // SHA256

  // Audit
  created_at: string;
  created_by: string | null;            // 'manual' | 'scheduler' | 'auto-retrain'
  notes: string | null;

  // Integration status
  is_scheduler_active?: number;         // 1 if this is the active model for scheduler
  is_manual_active?: number;            // 1 if this is the active model for manual forecast
  last_used_at?: string;                // ISO timestamp of last usage
  usage_count?: number;                 // Number of times this model was used
}

/**
 * Model group definition (for CFAC)
 */
export interface ModelGroup {
  group_code: string;                   // 'all_wind', 'all_solar', etc.
  group_type: string;                   // 'wind' | 'solar' | ...
  description: string | null;
  station_codes: string | null;         // JSON array of station codes
  created_at: string;
}

/**
 * Training run record
 */
export interface TrainingRun {
  id: string;
  started_at: string;
  completed_at: string | null;
  status: 'running' | 'completed' | 'failed';
  entities_trained: number | null;
  models_improved: number | null;
  models_activated: number | null;
  error_message: string | null;
  log_path: string | null;
}

/**
 * Model list filter options
 */
export interface ModelListFilters {
  entityType?: EntityType;
  entityCode?: string;
  isActive?: boolean;
  isArchived?: boolean;
  modelType?: ModelType;
}

/**
 * Model comparison result
 */
export interface ModelComparison {
  entity: {
    type: EntityType;
    code: string;
  };
  models: Array<{
    id: string;
    version: number;
    modelType: ModelType;
    trainedAt: string;
    metrics: ModelMetrics;
    isActive: boolean;
  }>;
  recommendation?: string;              // Which model is recommended
}

/**
 * Calibration data - CFAC and demand scaling factors
 * Stored as modelData for calibration entity types
 */
export interface CalibrationData {
  // CFAC scaling factors
  windScale: number;                    // e.g., 1.05 means +5% adjustment
  solarScale: number;                   // e.g., 0.98 means -2% adjustment

  // Demand scaling factors
  demandPeakScale: number;              // Peak hour adjustment
  demandOffpeakScale: number;           // Off-peak hour adjustment

  // Per-station solar scaling (for station-specific calibration)
  stationScales?: Record<string, number>;

  // Calibration period
  calibrationPeriod: {
    start: string;
    end: string;
  };

  // Performance metrics from calibration
  windDeviation?: number;               // Deviation from threshold
  solarDeviation?: number;
  demandMape?: number;

  // Calibration metadata
  iterations?: number;
  withinThreshold?: boolean;
}

/**
 * Training Plan Types (Phase A - Model Workflow Vision Part 1-2)
 */

/**
 * Date range configuration for training data
 */
export interface DateRangeConfig {
  mode: 'fixed' | 'rolling';

  // Fixed mode
  fixedStart?: string;  // YYYY-MM-DD
  fixedEnd?: string;    // YYYY-MM-DD

  // Rolling mode
  rollingDays?: 14 | 30 | 90 | 180 | 365;
}

/**
 * Per-entity override settings
 */
export interface EntityOverride {
  entityCode: string;  // e.g., "01NLUZ", "CLUZ", "all_wind"

  // Override options
  scalingPercent?: number;        // e.g., -5 for -5%, +10 for +10%
  modelType?: string;             // Override model algorithm
  calibrationIterations?: number; // 0 = off, 1-10 = iterations
  holdoutDays?: number;           // Days to hold out for testing
  enabled?: boolean;              // false = skip this entity
}

/**
 * Granular overrides for zones, regions, and station types
 */
export interface TrainingPlanOverrides {
  // Per-zone overrides (for zonal demand)
  zones: Record<string, EntityOverride>;

  // Per-region overrides (for regional demand)
  regions: Record<string, EntityOverride>;

  // Per-station-type overrides (for CFAC)
  stationTypes: Record<string, EntityOverride>;
}

/**
 * Training Plan Template - reusable training configuration
 */
export interface TrainingPlanTemplate {
  id: string;                      // UUID
  name: string;                    // User-friendly name
  description?: string;
  createdAt: string;               // ISO timestamp
  updatedAt: string;               // ISO timestamp

  // Date range configuration
  dateRange: DateRangeConfig;

  // What to train
  trainDemand: boolean;            // Always true for now
  trainCfac: boolean;              // Optional

  // Default settings
  demandModelType: 'hybrid' | 'xgboost' | 'regression';
  cfacModelType: '4tier' | 'hybrid' | 'mrec' | 'physics';

  // Global calibration settings
  calibrationEnabled: boolean;
  calibrationIterations: number;   // Default for all entities
  calibrationThreshold: number;    // % threshold for convergence

  // Granular overrides
  overrides: TrainingPlanOverrides;

  // Advanced
  holdoutDays: number;             // Days to hold out for testing
  autoActivate: boolean;           // Activate models if better than current
}
