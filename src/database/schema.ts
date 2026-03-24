// Database schema definitions

export const SCHEMA_VERSION = 11;  // Added cfac_calibration_id to training_instances (unify models)

export const CREATE_TABLES_SQL = `
-- Schema version tracking
CREATE TABLE IF NOT EXISTS schema_info (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Demand records from historical data
CREATE TABLE IF NOT EXISTS demand_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  datetime TEXT NOT NULL,
  region TEXT NOT NULL,
  demand REAL NOT NULL,
  source_file TEXT,
  imported_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(datetime, region)
);

-- Weather records (historical and forecast) - for DEMAND forecasting
-- NOTE: UNIQUE on (datetime, location) to support zonal mode where multiple cities map to same region
CREATE TABLE IF NOT EXISTS weather_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  datetime TEXT NOT NULL,
  location TEXT NOT NULL,
  region TEXT NOT NULL,
  temp REAL,
  dew REAL,
  precip REAL,
  windgust REAL,
  windspeed REAL,
  cloudcover REAL,
  solarradiation REAL,
  solarenergy REAL,
  uvindex REAL,
  is_forecast INTEGER DEFAULT 0,
  source TEXT,
  imported_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(datetime, location)
);

-- ============================================
-- CLUSTER WEATHER TABLES (Capacity Factor)
-- Supports extended wind (hub-height) and solar (irradiance) fields
-- Separate historical/forecast tables with archive for accuracy analysis
-- ============================================

-- Cluster weather - Historical (actual observed data)
-- Data is PERMANENT and never overwritten once stored
CREATE TABLE IF NOT EXISTS cluster_weather_historical (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  location_id TEXT NOT NULL,           -- e.g., 'SOLAR_01BOTOLAN', 'WIND_01BURGOS', 'LUZON_HYDRO'
  datetime TEXT NOT NULL,              -- ISO 8601 format

  -- Basic weather
  temp REAL,
  dew REAL,
  humidity REAL,
  precip REAL,
  precipprob REAL,
  pressure REAL,

  -- Wind (10m standard)
  windgust REAL,
  windspeed REAL,
  winddir REAL,

  -- Wind hub-height (50m, 80m, 100m)
  windspeed50 REAL,
  winddir50 REAL,
  windspeed80 REAL,
  winddir80 REAL,
  windspeed100 REAL,
  winddir100 REAL,

  -- Solar/sky
  cloudcover REAL,
  visibility REAL,
  solarradiation REAL,
  solarenergy REAL,
  uvindex REAL,

  -- Extended solar irradiance
  dniradiation REAL,                   -- Direct Normal Irradiance (W/m²)
  difradiation REAL,                   -- Diffuse Horizontal Irradiance (W/m²)
  ghiradiation REAL,                   -- Global Horizontal Irradiance (W/m²)

  -- Conditions
  conditions TEXT,

  -- Metadata
  imported_at TEXT DEFAULT CURRENT_TIMESTAMP,
  source TEXT,                         -- 'api', 'cache_migration', etc.

  UNIQUE(location_id, datetime)
);

-- Cluster weather - Forecast (latest predictions, gets refreshed)
-- Data older than 24h gets refreshed with newer forecasts
-- When date passes into the past, data is promoted to historical table
CREATE TABLE IF NOT EXISTS cluster_weather_forecast (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  location_id TEXT NOT NULL,
  datetime TEXT NOT NULL,              -- The hour being forecast

  -- Basic weather
  temp REAL,
  dew REAL,
  humidity REAL,
  precip REAL,
  precipprob REAL,
  pressure REAL,

  -- Wind (10m standard)
  windgust REAL,
  windspeed REAL,
  winddir REAL,

  -- Wind hub-height
  windspeed50 REAL,
  winddir50 REAL,
  windspeed80 REAL,
  winddir80 REAL,
  windspeed100 REAL,
  winddir100 REAL,

  -- Solar/sky
  cloudcover REAL,
  visibility REAL,
  solarradiation REAL,
  solarenergy REAL,
  uvindex REAL,

  -- Extended solar irradiance
  dniradiation REAL,
  difradiation REAL,
  ghiradiation REAL,

  -- Conditions
  conditions TEXT,

  -- Forecast metadata
  fetched_at TEXT NOT NULL,            -- When this forecast was downloaded
  source TEXT,

  UNIQUE(location_id, datetime)
);

-- Cluster weather - Forecast Archive (versioned history for accuracy analysis)
-- Append-only, stores every forecast version before it gets overwritten
-- Enables comparison: "How accurate was 24h-ahead vs 72h-ahead forecast?"
CREATE TABLE IF NOT EXISTS cluster_weather_forecast_archive (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  location_id TEXT NOT NULL,
  datetime TEXT NOT NULL,              -- The hour that was forecast
  fetched_at TEXT NOT NULL,            -- When this forecast was made

  -- Lead time calculation: datetime - fetched_at
  lead_time_hours INTEGER,             -- How many hours ahead this forecast was

  -- Basic weather
  temp REAL,
  dew REAL,
  humidity REAL,
  precip REAL,
  precipprob REAL,
  pressure REAL,

  -- Wind (10m standard)
  windgust REAL,
  windspeed REAL,
  winddir REAL,

  -- Wind hub-height
  windspeed50 REAL,
  winddir50 REAL,
  windspeed80 REAL,
  winddir80 REAL,
  windspeed100 REAL,
  winddir100 REAL,

  -- Solar/sky
  cloudcover REAL,
  visibility REAL,
  solarradiation REAL,
  solarenergy REAL,
  uvindex REAL,

  -- Extended solar irradiance
  dniradiation REAL,
  difradiation REAL,
  ghiradiation REAL,

  -- Conditions
  conditions TEXT,

  -- Archive metadata
  archived_at TEXT DEFAULT CURRENT_TIMESTAMP,
  source TEXT

  -- No UNIQUE constraint - allows multiple forecast versions for same datetime
);

-- Trained models
CREATE TABLE IF NOT EXISTS models (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  model_type TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  training_start TEXT,
  training_end TEXT,
  training_samples INTEGER,
  r2_score REAL,
  mape REAL,
  rmse REAL,
  mae REAL,
  coefficients TEXT,
  feature_names TEXT,
  is_active INTEGER DEFAULT 1,
  notes TEXT
);

-- Model training runs (history)
CREATE TABLE IF NOT EXISTS training_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  model_id INTEGER REFERENCES models(id),
  run_at TEXT DEFAULT CURRENT_TIMESTAMP,
  demand_records_used INTEGER,
  weather_records_used INTEGER,
  training_samples INTEGER,
  r2_score REAL,
  mape REAL,
  duration_ms INTEGER
);

-- Outage records (unified planned and unplanned)
CREATE TABLE IF NOT EXISTS outage_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL,
  unit_id TEXT NOT NULL,
  site_id TEXT,
  region TEXT NOT NULL,
  fuel_type TEXT NOT NULL,
  outage_type TEXT NOT NULL,  -- 'planned' or 'unplanned'
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  duration_minutes REAL NOT NULL,
  capacity_mw REAL,
  capacity_lost_mw REAL,
  severity TEXT,
  time_period TEXT,
  day_of_week INTEGER,
  hour INTEGER,
  month INTEGER,
  is_weekend INTEGER DEFAULT 0,
  source_file TEXT,
  imported_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(event_id, unit_id, start_time)
);

-- Unit metadata (for capacity and fuel type lookups)
CREATE TABLE IF NOT EXISTS unit_metadata (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  unit_id TEXT UNIQUE NOT NULL,
  site_id TEXT,
  region TEXT NOT NULL,
  fuel_type TEXT,
  capacity_mw REAL,
  commissioned_date TEXT,
  notes TEXT,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Outage probability models
CREATE TABLE IF NOT EXISTS outage_models (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  training_start TEXT,
  training_end TEXT,
  total_outages INTEGER,
  planned_outages INTEGER,
  unplanned_outages INTEGER,
  model_data TEXT,  -- JSON with probability multipliers
  is_active INTEGER DEFAULT 1,
  notes TEXT
);

-- Indexes for faster queries
CREATE INDEX IF NOT EXISTS idx_demand_datetime ON demand_records(datetime);
CREATE INDEX IF NOT EXISTS idx_demand_region ON demand_records(region);
CREATE INDEX IF NOT EXISTS idx_demand_datetime_region ON demand_records(datetime, region);

CREATE INDEX IF NOT EXISTS idx_weather_datetime ON weather_records(datetime);
CREATE INDEX IF NOT EXISTS idx_weather_region ON weather_records(region);
CREATE INDEX IF NOT EXISTS idx_weather_datetime_region ON weather_records(datetime, region);

-- Indexes for cluster weather historical
CREATE INDEX IF NOT EXISTS idx_cluster_hist_location ON cluster_weather_historical(location_id);
CREATE INDEX IF NOT EXISTS idx_cluster_hist_datetime ON cluster_weather_historical(datetime);
CREATE INDEX IF NOT EXISTS idx_cluster_hist_loc_dt ON cluster_weather_historical(location_id, datetime);

-- Indexes for cluster weather forecast
CREATE INDEX IF NOT EXISTS idx_cluster_fc_location ON cluster_weather_forecast(location_id);
CREATE INDEX IF NOT EXISTS idx_cluster_fc_datetime ON cluster_weather_forecast(datetime);
CREATE INDEX IF NOT EXISTS idx_cluster_fc_loc_dt ON cluster_weather_forecast(location_id, datetime);
CREATE INDEX IF NOT EXISTS idx_cluster_fc_fetched ON cluster_weather_forecast(fetched_at);

-- Indexes for cluster weather forecast archive
CREATE INDEX IF NOT EXISTS idx_cluster_archive_location ON cluster_weather_forecast_archive(location_id);
CREATE INDEX IF NOT EXISTS idx_cluster_archive_datetime ON cluster_weather_forecast_archive(datetime);
CREATE INDEX IF NOT EXISTS idx_cluster_archive_fetched ON cluster_weather_forecast_archive(fetched_at);
CREATE INDEX IF NOT EXISTS idx_cluster_archive_lead_time ON cluster_weather_forecast_archive(lead_time_hours);

CREATE INDEX IF NOT EXISTS idx_models_active ON models(is_active);
CREATE INDEX IF NOT EXISTS idx_models_type ON models(model_type);

CREATE INDEX IF NOT EXISTS idx_outage_unit ON outage_records(unit_id);
CREATE INDEX IF NOT EXISTS idx_outage_region ON outage_records(region);
CREATE INDEX IF NOT EXISTS idx_outage_type ON outage_records(outage_type);
CREATE INDEX IF NOT EXISTS idx_outage_start ON outage_records(start_time);
CREATE INDEX IF NOT EXISTS idx_outage_region_type ON outage_records(region, outage_type);

-- Interconnector flow records from RTDHS
CREATE TABLE IF NOT EXISTS interconnector_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  datetime TEXT NOT NULL,
  run_time TEXT NOT NULL,
  market_type TEXT NOT NULL,
  interconnector_name TEXT NOT NULL,
  congestion_flag TEXT NOT NULL,
  flow_from REAL NOT NULL,
  flow_to REAL NOT NULL,
  overload_mw REAL,
  source_file TEXT,
  imported_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(datetime, run_time, interconnector_name)
);

-- Interconnector metadata
CREATE TABLE IF NOT EXISTS interconnector_metadata (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  from_region TEXT NOT NULL,
  to_region TEXT NOT NULL,
  capacity_mw REAL NOT NULL,
  notes TEXT,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Interconnector congestion prediction models
CREATE TABLE IF NOT EXISTS interconnector_models (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  model_type TEXT DEFAULT 'regression',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  training_start TEXT,
  training_end TEXT,
  training_samples INTEGER,
  accuracy REAL,
  precision REAL,
  recall REAL,
  f1_score REAL,
  r2_score REAL,
  mape REAL,
  mae REAL,
  rmse REAL,
  training_time_ms INTEGER,
  model_data TEXT,
  is_active INTEGER DEFAULT 1,
  notes TEXT
);

-- Indexes for interconnector queries
CREATE INDEX IF NOT EXISTS idx_interconnector_datetime ON interconnector_records(datetime);
CREATE INDEX IF NOT EXISTS idx_interconnector_name ON interconnector_records(interconnector_name);
CREATE INDEX IF NOT EXISTS idx_interconnector_congestion ON interconnector_records(congestion_flag);
CREATE INDEX IF NOT EXISTS idx_interconnector_datetime_name ON interconnector_records(datetime, interconnector_name);

-- MREC (Must-Run Energy Conversion) factors for wind stations
-- Based on iPool's three-tier piecewise linear system
CREATE TABLE IF NOT EXISTS mrec_factors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  station_code TEXT UNIQUE NOT NULL,
  station_type TEXT DEFAULT 'wind',

  -- Three-tier conversion factors (CF = MRec * WindSpeed)
  mrec_h REAL NOT NULL,       -- High wind conversion factor
  mrec_m REAL NOT NULL,       -- Mid wind conversion factor
  mrec_l REAL NOT NULL,       -- Low wind conversion factor

  -- Wind speed thresholds (m/s)
  v_h REAL NOT NULL,          -- Threshold for HIGH tier
  v_l REAL NOT NULL,          -- Threshold for LOW tier

  -- Calibration status
  calibrated INTEGER DEFAULT 0,
  calibration_date TEXT,
  sample_count INTEGER,

  -- Calibration statistics (JSON)
  stats TEXT,

  -- Metadata
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  notes TEXT
);

-- Historical capacity factor data for wind stations
CREATE TABLE IF NOT EXISTS wind_cfac_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  datetime TEXT NOT NULL,
  station_code TEXT NOT NULL,
  capacity_factor REAL NOT NULL,
  wind_speed REAL,            -- m/s (10m height)
  wind_speed_100 REAL,        -- m/s (100m hub height)
  source_file TEXT,
  imported_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(datetime, station_code)
);

-- Indexes for MREC tables
CREATE INDEX IF NOT EXISTS idx_mrec_station ON mrec_factors(station_code);
CREATE INDEX IF NOT EXISTS idx_mrec_calibrated ON mrec_factors(calibrated);
CREATE INDEX IF NOT EXISTS idx_wind_cfac_datetime ON wind_cfac_history(datetime);
CREATE INDEX IF NOT EXISTS idx_wind_cfac_station ON wind_cfac_history(station_code);
CREATE INDEX IF NOT EXISTS idx_wind_cfac_datetime_station ON wind_cfac_history(datetime, station_code);

-- Historical capacity factor data for ALL station types (wind, solar, hydro, etc.)
-- Used for training CFAC models from database instead of CSV files
CREATE TABLE IF NOT EXISTS cfac_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  datetime TEXT NOT NULL,
  station_code TEXT NOT NULL,
  station_type TEXT,                -- wind, solar, hydro, geothermal, biomass, battery
  capacity_factor REAL NOT NULL,    -- 0.0 to 1.0
  source_file TEXT,
  imported_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(datetime, station_code)
);

-- Indexes for cfac_records
CREATE INDEX IF NOT EXISTS idx_cfac_records_datetime ON cfac_records(datetime);
CREATE INDEX IF NOT EXISTS idx_cfac_records_station ON cfac_records(station_code);
CREATE INDEX IF NOT EXISTS idx_cfac_records_type ON cfac_records(station_type);
CREATE INDEX IF NOT EXISTS idx_cfac_records_datetime_station ON cfac_records(datetime, station_code);

-- ============================================
-- SCHEDULED FORECAST SERVICE TABLES
-- ============================================

-- Forecast runs - tracks when forecasts were generated
CREATE TABLE IF NOT EXISTS forecast_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_date TEXT NOT NULL,              -- Date the forecast was generated (YYYY-MM-DD)
  run_time TEXT NOT NULL,              -- Time the forecast was generated (ISO 8601)
  forecast_type TEXT NOT NULL,         -- 'demand' or 'cfac'
  horizon TEXT NOT NULL,               -- 'daily' (next day) or 'weekly' (7 days ahead)
  forecast_start TEXT NOT NULL,        -- First date being forecast (YYYY-MM-DD)
  forecast_end TEXT NOT NULL,          -- Last date being forecast (YYYY-MM-DD)
  model_used TEXT,                     -- Model name/type used
  training_mape REAL,                  -- Training MAPE at time of forecast
  status TEXT DEFAULT 'pending',       -- 'pending', 'completed', 'evaluated', 'failed'
  records_generated INTEGER,
  duration_ms INTEGER,
  error_message TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,

  -- Enhanced tracking (v8)
  run_source TEXT DEFAULT 'manual',    -- 'manual', 'scheduled', 'backfill', 'gui'
  weather_refresh_mode TEXT DEFAULT 'cache', -- 'cache', 'refresh', 'force-refresh'
  archive_path TEXT,                   -- Path where forecast was archived
  pushed_to_gateway INTEGER DEFAULT 0, -- 0 = not pushed, 1 = pushed successfully
  push_timestamp TEXT,                 -- When the file was pushed to gateway
  gateway_path TEXT,                   -- Remote path on gateway
  file_checksum TEXT                   -- SHA256 of the output file
);

-- Demand forecasts - stores hourly demand forecast values
CREATE TABLE IF NOT EXISTS demand_forecasts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES forecast_runs(id),
  datetime TEXT NOT NULL,              -- Hour being forecast (ISO 8601)
  region TEXT NOT NULL,                -- CLUZ, CVIS, CMIN
  forecast_value REAL NOT NULL,        -- Forecast demand in MW
  actual_value REAL,                   -- Actual demand (filled in during evaluation)
  error_mw REAL,                       -- Absolute error in MW
  error_pct REAL,                      -- Percentage error
  UNIQUE(run_id, datetime, region)
);

-- Capacity factor forecasts - stores hourly cfac forecast values
CREATE TABLE IF NOT EXISTS cfac_forecasts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES forecast_runs(id),
  datetime TEXT NOT NULL,              -- Hour being forecast (ISO 8601)
  station_code TEXT NOT NULL,          -- Station code
  station_type TEXT NOT NULL,          -- wind, solar, hydro, etc.
  forecast_value REAL NOT NULL,        -- Forecast capacity factor (0-1)
  actual_value REAL,                   -- Actual capacity factor (filled in during evaluation)
  error_abs REAL,                      -- Absolute error
  error_pct REAL,                      -- Percentage error
  UNIQUE(run_id, datetime, station_code)
);

-- Forecast evaluations - summary metrics per run
CREATE TABLE IF NOT EXISTS forecast_evaluations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES forecast_runs(id),
  evaluated_at TEXT NOT NULL,
  records_matched INTEGER,
  records_unmatched INTEGER,
  mape REAL,
  mae REAL,
  rmse REAL,
  bias REAL,
  -- Per-region/station breakdown (JSON)
  breakdown TEXT,
  notes TEXT,
  UNIQUE(run_id)
);

-- ============================================
-- SCHEDULER CONFIGURATION (v8)
-- ============================================

-- Scheduler configuration (singleton table)
CREATE TABLE IF NOT EXISTS scheduler_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),  -- Singleton row
  enabled INTEGER DEFAULT 0,
  run_time_morning TEXT DEFAULT '06:00',   -- HH:MM format (PHT)
  run_time_evening TEXT DEFAULT '18:00',   -- Optional second run
  run_days TEXT DEFAULT '1,2,3,4,5,6,7',   -- Comma-separated day numbers (1=Mon)
  forecast_types TEXT DEFAULT 'demand,cfac', -- Comma-separated
  horizons TEXT DEFAULT 'daily,weekly',      -- Comma-separated
  weather_max_age_hours INTEGER DEFAULT 6,   -- Cache expiry for future dates
  auto_push_gateway INTEGER DEFAULT 1,       -- Push on successful forecast
  archive_retention_days INTEGER DEFAULT 90, -- Days to keep local archives
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Forecast archive tracking
CREATE TABLE IF NOT EXISTS forecast_archive (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL,
  archive_date TEXT NOT NULL,          -- Date archived (YYYY-MM-DD)
  forecast_date TEXT NOT NULL,         -- Target date being forecasted
  horizon TEXT NOT NULL,               -- 'daily' or 'weekly'
  forecast_type TEXT NOT NULL,         -- 'demand' or 'cfac'
  local_path TEXT NOT NULL,            -- Local archive path
  gateway_path TEXT,                   -- Remote gateway path (if pushed)
  file_size_bytes INTEGER,
  checksum TEXT,                       -- SHA256 for integrity
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (run_id) REFERENCES forecast_runs(id)
);

-- Hourly demand forecast values
CREATE TABLE IF NOT EXISTS demand_forecast_hourly (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL,
  datetime TEXT NOT NULL,              -- ISO 8601 timestamp
  region TEXT NOT NULL,                -- CLUZ, CVIS, CMIN (or 14 zone codes)
  forecast_mw REAL NOT NULL,
  actual_mw REAL,                      -- Populated during evaluation
  error_mw REAL,                       -- forecast - actual
  error_pct REAL,                      -- Percentage error
  FOREIGN KEY (run_id) REFERENCES forecast_runs(id)
);

-- Hourly CFAC forecast values
CREATE TABLE IF NOT EXISTS cfac_forecast_hourly (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL,
  datetime TEXT NOT NULL,
  station_code TEXT NOT NULL,          -- e.g., 01BURGOS, 01SNMANUEL_S
  station_type TEXT NOT NULL,          -- WIND, SOLAR, HYDRO, etc.
  forecast_cf REAL NOT NULL,           -- Capacity factor 0-1
  actual_cf REAL,                      -- Populated during evaluation
  error_cf REAL,
  error_pct REAL,
  FOREIGN KEY (run_id) REFERENCES forecast_runs(id)
);

-- Indexes for forecast tables
CREATE INDEX IF NOT EXISTS idx_forecast_runs_date ON forecast_runs(run_date);
CREATE INDEX IF NOT EXISTS idx_forecast_runs_type ON forecast_runs(forecast_type, horizon);
CREATE INDEX IF NOT EXISTS idx_forecast_runs_status ON forecast_runs(status);
CREATE INDEX IF NOT EXISTS idx_demand_forecasts_run ON demand_forecasts(run_id);
CREATE INDEX IF NOT EXISTS idx_demand_forecasts_datetime ON demand_forecasts(datetime);
CREATE INDEX IF NOT EXISTS idx_demand_forecasts_region ON demand_forecasts(region);
CREATE INDEX IF NOT EXISTS idx_cfac_forecasts_run ON cfac_forecasts(run_id);
CREATE INDEX IF NOT EXISTS idx_cfac_forecasts_datetime ON cfac_forecasts(datetime);
CREATE INDEX IF NOT EXISTS idx_cfac_forecasts_station ON cfac_forecasts(station_code);

-- Indexes for v8 tables
CREATE INDEX IF NOT EXISTS idx_archive_date ON forecast_archive(archive_date);
CREATE INDEX IF NOT EXISTS idx_archive_forecast_date ON forecast_archive(forecast_date);
CREATE INDEX IF NOT EXISTS idx_demand_hourly_run ON demand_forecast_hourly(run_id);
CREATE INDEX IF NOT EXISTS idx_demand_hourly_dt ON demand_forecast_hourly(datetime);
CREATE INDEX IF NOT EXISTS idx_cfac_hourly_run ON cfac_forecast_hourly(run_id);
CREATE INDEX IF NOT EXISTS idx_cfac_hourly_dt ON cfac_forecast_hourly(datetime);

-- ============================================
-- TRAINING PLAN TEMPLATES (v9 - Phase A)
-- Model Workflow Vision Part 5.1
-- ============================================

-- Training plan templates - reusable training configurations
CREATE TABLE IF NOT EXISTS training_plan_templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,

  -- Date range config
  date_range_mode TEXT NOT NULL,           -- 'fixed' | 'rolling'
  fixed_start TEXT,
  fixed_end TEXT,
  rolling_days INTEGER,

  -- Model settings
  train_demand INTEGER DEFAULT 1,
  train_cfac INTEGER DEFAULT 1,
  demand_model_type TEXT DEFAULT 'hybrid',
  cfac_model_type TEXT DEFAULT '4tier',

  -- Calibration defaults
  calibration_enabled INTEGER DEFAULT 1,
  calibration_iterations INTEGER DEFAULT 3,
  calibration_threshold REAL DEFAULT 5.0,

  -- Overrides (JSON)
  overrides_json TEXT,

  -- Advanced
  holdout_days INTEGER DEFAULT 7,
  auto_activate INTEGER DEFAULT 1,

  -- Audit
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  created_by TEXT
);

CREATE INDEX IF NOT EXISTS idx_training_plan_templates_name ON training_plan_templates(name);
CREATE INDEX IF NOT EXISTS idx_training_plan_templates_created ON training_plan_templates(created_at DESC);

-- ============================================
-- TRAINING INSTANCES (v9 - Phase C)
-- Model Workflow Vision Part 3 and Part 5.2
-- ============================================

-- Training instances - results of running training plans
CREATE TABLE IF NOT EXISTS training_instances (
  id TEXT PRIMARY KEY,
  template_id TEXT,                       -- Link to training plan template
  template_name TEXT,                     -- Snapshot of template name

  -- Execution
  started_at TEXT NOT NULL,
  completed_at TEXT,
  status TEXT DEFAULT 'running',          -- running, completed, failed, partial
  error_message TEXT,

  -- Resolved date range
  date_range_start TEXT,
  date_range_end TEXT,

  -- Results summary (JSON)
  demand_regional_summary TEXT,           -- JSON array of ModelSummary
  demand_zonal_summary TEXT,              -- JSON array of ModelSummary
  cfac_summary TEXT,                      -- JSON object by type

  -- Aggregate metrics
  demand_regional_mape REAL,
  demand_zonal_mape REAL,
  cfac_wind_mape REAL,
  cfac_solar_mape REAL,

  -- Applied overrides (JSON)
  applied_overrides_json TEXT,

  -- Link to CFAC calibration generated during this training
  cfac_calibration_id TEXT,

  -- Audit
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,

  FOREIGN KEY (template_id) REFERENCES training_plan_templates(id)
);

CREATE INDEX IF NOT EXISTS idx_training_instances_status ON training_instances(status);
CREATE INDEX IF NOT EXISTS idx_training_instances_date ON training_instances(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_training_instances_template ON training_instances(template_id);
`;

export const REGION_MAPPING: Record<string, string> = {
  'manila': 'CLUZ',
  'cebu': 'CVIS',
  'cebu city': 'CVIS',
  'davao': 'CMIN',
  'davao city': 'CMIN',
  // Zonal mappings (45 cities -> 14 zones) - NLUZ has 6 cities, others have 3
  // Northern Luzon (6 cities for larger coverage area)
  'san fernando': '01NLUZ',
  'san fernando, pampanga': '01NLUZ',
  'baguio': '01NLUZ',
  'tuguegarao': '01NLUZ',
  'laoag': '01NLUZ',
  'dagupan': '01NLUZ',
  'angeles city': '01NLUZ',
  'angeles': '01NLUZ',
  // Metro Manila
  'quezon city': '02METRO',
  'makati': '02METRO',
  // Southern Luzon
  'batangas': '03SLUZ',
  'lucena': '03SLUZ',
  'legazpi': '03SLUZ',
  // Eastern Visayas
  'tacloban': '04LEYTE',
  'ormoc': '04LEYTE',
  'catbalogan': '04LEYTE',
  // Cebu
  'mandaue': '05CEBU',
  'lapu-lapu': '05CEBU',
  // Negros
  'bacolod': '06NEGROS',
  'dumaguete': '06NEGROS',
  'kabankalan': '06NEGROS',
  // Bohol
  'tagbilaran': '07BOHOL',
  'ubay': '07BOHOL',
  'talibon': '07BOHOL',
  // Panay
  'iloilo city': '08PANAY',
  'roxas': '08PANAY',
  'kalibo': '08PANAY',
  // NW Mindanao
  'zamboanga city': '09NWMIN',
  'pagadian': '09NWMIN',
  'dipolog': '09NWMIN',
  // Lanao
  'iligan': '10LANAO',
  'marawi': '10LANAO',
  'ozamiz': '10LANAO',
  // NC Mindanao
  'cagayan de oro': '11NCMIN',
  'malaybalay': '11NCMIN',
  'valencia': '11NCMIN',
  // NE Mindanao
  'butuan': '12NEMIN',
  'surigao city': '12NEMIN',
  'bislig': '12NEMIN',
  // SE Mindanao
  'tagum': '13SEMIN',
  'panabo': '13SEMIN',
  // SW Mindanao
  'general santos': '14SWMIN',
  'koronadal': '14SWMIN',
  'cotabato city': '14SWMIN'
};
