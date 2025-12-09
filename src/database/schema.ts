// Database schema definitions

export const SCHEMA_VERSION = 2;  // Updated for outage tables

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

-- Weather records (historical and forecast)
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
  UNIQUE(datetime, region)
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

CREATE INDEX IF NOT EXISTS idx_models_active ON models(is_active);
CREATE INDEX IF NOT EXISTS idx_models_type ON models(model_type);

CREATE INDEX IF NOT EXISTS idx_outage_unit ON outage_records(unit_id);
CREATE INDEX IF NOT EXISTS idx_outage_region ON outage_records(region);
CREATE INDEX IF NOT EXISTS idx_outage_type ON outage_records(outage_type);
CREATE INDEX IF NOT EXISTS idx_outage_start ON outage_records(start_time);
CREATE INDEX IF NOT EXISTS idx_outage_region_type ON outage_records(region, outage_type);
`;

export const REGION_MAPPING: Record<string, string> = {
  'manila': 'CLUZ',
  'cebu': 'CVIS',
  'cebu city': 'CVIS',
  'davao': 'CMIN',
  'davao city': 'CMIN'
};
