#!/usr/bin/env node
/**
 * Scheduler Query Helper
 *
 * Queries the forecast.db database and returns JSON results.
 * Used by the Electron GUI to avoid native module compatibility issues.
 *
 * Usage:
 *   node scheduler-query.cjs config [dbPath]
 *   node scheduler-query.cjs runs [limit] [dbPath]
 *   node scheduler-query.cjs calibrations [limit] [dbPath]
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const command = process.argv[2];
const arg1 = process.argv[3];
const arg2 = process.argv[4];

// Default database path
function getDbPath(customPath) {
  if (customPath && fs.existsSync(customPath)) {
    return customPath;
  }
  const defaultPath = path.join(process.cwd(), 'forecast.db');
  return fs.existsSync(defaultPath) ? defaultPath : null;
}

// Run migrations to ensure schema is up-to-date
function migrateDatabase(db) {
  // Check if forecast_runs table exists
  const tableExists = db.prepare(`
    SELECT name FROM sqlite_master WHERE type='table' AND name='forecast_runs'
  `).get();

  if (!tableExists) return;

  // Check for missing columns and add them
  const columns = db.prepare("PRAGMA table_info(forecast_runs)").all();
  const colNames = columns.map(c => c.name);

  if (!colNames.includes('gateway_path')) {
    db.exec('ALTER TABLE forecast_runs ADD COLUMN gateway_path TEXT');
  }
  if (!colNames.includes('gateway_category')) {
    db.exec('ALTER TABLE forecast_runs ADD COLUMN gateway_category TEXT');
  }
  if (!colNames.includes('output_file')) {
    db.exec('ALTER TABLE forecast_runs ADD COLUMN output_file TEXT');
  }
  if (!colNames.includes('scale_wind')) {
    db.exec('ALTER TABLE forecast_runs ADD COLUMN scale_wind REAL');
  }
  if (!colNames.includes('scale_solar')) {
    db.exec('ALTER TABLE forecast_runs ADD COLUMN scale_solar REAL');
  }
}

// Get scheduler configuration
function getConfig(dbPath) {
  const defaults = {
    enabled: false,
    runTimeMorning: '06:00',
    runTimeEvening: '18:00',
    secondRunEnabled: false,
    runDays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
    forecastDemand: true,
    forecastCfac: true,
    horizonDaily: true,
    horizonWeekly: true,
    demandGeography: 'regional',
    weatherMaxAge: 6,
    autoPushGateway: false,
    archiveRetention: 90
  };

  if (!dbPath) {
    return defaults;
  }

  try {
    const db = new Database(dbPath);
    const config = db.prepare('SELECT * FROM scheduler_config WHERE id = 1').get();
    db.close();

    if (!config) {
      return defaults;
    }

    // Parse database values to config format
    const dayMap = {'1':'Mon','2':'Tue','3':'Wed','4':'Thu','5':'Fri','6':'Sat','7':'Sun'};
    const runDays = config.run_days ? config.run_days.split(',').map(d => {
      return dayMap[d.trim()] || d.trim();
    }) : ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];

    const forecastTypes = config.forecast_types || 'demand,cfac';
    const horizons = config.horizons || 'daily,weekly';

    return {
      enabled: config.enabled === 1,
      runTimeMorning: config.run_time_morning || '06:00',
      runTimeEvening: config.run_time_evening || '18:00',
      secondRunEnabled: !!config.run_time_evening,
      runDays,
      forecastDemand: forecastTypes.includes('demand'),
      forecastCfac: forecastTypes.includes('cfac'),
      horizonDaily: horizons.includes('daily'),
      horizonWeekly: horizons.includes('weekly'),
      demandGeography: config.demand_geography || 'regional',
      weatherMaxAge: config.weather_max_age_hours || 6,
      autoPushGateway: config.auto_push_gateway === 1,
      archiveRetention: config.archive_retention_days || 90
    };
  } catch (error) {
    console.error('Error reading config:', error.message);
    return defaults;
  }
}

// Get recent forecast runs
function getRecentRuns(limit, dbPath) {
  if (!dbPath) {
    return [];
  }

  try {
    const db = new Database(dbPath);
    migrateDatabase(db);

    const runs = db.prepare(`
      SELECT id, run_date, forecast_type, horizon, status,
             records_generated, gateway_path, created_at
      FROM forecast_runs
      ORDER BY created_at DESC
      LIMIT ?
    `).all(limit);

    db.close();

    return runs.map(run => ({
      ...run,
      pushed_to_gateway: !!run.gateway_path
    }));
  } catch (error) {
    console.error('Error reading runs:', error.message);
    return [];
  }
}

// Save scheduler configuration
function saveConfig(configJson, dbPath) {
  if (!dbPath) {
    return { success: false, error: 'No database path provided' };
  }

  try {
    const config = JSON.parse(configJson);
    const db = new Database(dbPath);

    // Ensure scheduler_config table exists
    db.exec(`
      CREATE TABLE IF NOT EXISTS scheduler_config (
        id INTEGER PRIMARY KEY DEFAULT 1,
        enabled INTEGER DEFAULT 0,
        run_time_morning TEXT DEFAULT '06:00',
        run_time_evening TEXT,
        run_days TEXT DEFAULT '1,2,3,4,5,6,7',
        forecast_types TEXT DEFAULT 'demand,cfac',
        horizons TEXT DEFAULT 'daily,weekly',
        demand_geography TEXT DEFAULT 'regional',
        weather_max_age_hours INTEGER DEFAULT 6,
        auto_push_gateway INTEGER DEFAULT 0,
        archive_retention_days INTEGER DEFAULT 90
      )
    `);

    // Migration: Add demand_geography column if it doesn't exist (for existing databases)
    try {
      const tableInfo = db.prepare('PRAGMA table_info(scheduler_config)').all();
      const hasGeographyColumn = tableInfo.some(col => col.name === 'demand_geography');
      if (!hasGeographyColumn) {
        db.exec("ALTER TABLE scheduler_config ADD COLUMN demand_geography TEXT DEFAULT 'regional'");
      }
    } catch (e) {
      // Column likely already exists
    }

    // Convert runDays to database format (1-7)
    const dayMap = {'Mon':'1','Tue':'2','Wed':'3','Thu':'4','Fri':'5','Sat':'6','Sun':'7'};
    const runDays = (config.runDays || []).map(d => dayMap[d] || d).join(',');

    // Build forecast types
    const forecastTypes = [];
    if (config.forecastDemand) forecastTypes.push('demand');
    if (config.forecastCfac) forecastTypes.push('cfac');

    // Build horizons
    const horizons = [];
    if (config.horizonDaily) horizons.push('daily');
    if (config.horizonWeekly) horizons.push('weekly');

    // Upsert configuration
    db.exec('DELETE FROM scheduler_config WHERE id = 1');
    db.prepare(`
      INSERT INTO scheduler_config (
        id, enabled, run_time_morning, run_time_evening, run_days,
        forecast_types, horizons, demand_geography, weather_max_age_hours,
        auto_push_gateway, archive_retention_days
      ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      config.enabled ? 1 : 0,
      config.runTimeMorning || '06:00',
      config.secondRunEnabled ? (config.runTimeEvening || '18:00') : null,
      runDays || '1,2,3,4,5,6,7',
      forecastTypes.join(',') || 'demand,cfac',
      horizons.join(',') || 'daily,weekly',
      config.demandGeography || 'regional',
      config.weatherMaxAge || 6,
      config.autoPushGateway ? 1 : 0,
      config.archiveRetention || 90
    );

    db.close();
    return { success: true };
  } catch (error) {
    console.error('Error saving config:', error.message);
    return { success: false, error: error.message };
  }
}

// Get calibration history
function getCalibrations(limit, dbPath) {
  if (!dbPath) {
    return [];
  }

  try {
    const db = new Database(dbPath);

    // Check if table exists
    const tableExists = db.prepare(`
      SELECT name FROM sqlite_master WHERE type='table' AND name='calibration_history'
    `).get();

    if (!tableExists) {
      db.close();
      return [];
    }

    const calibrations = db.prepare(`
      SELECT id, calibration_date, calibration_start, calibration_end,
             wind_scale, solar_scale, wind_deviation, solar_deviation,
             demand_mape, demand_peak_scale, demand_offpeak_scale,
             within_threshold, iterations, created_at
      FROM calibration_history
      ORDER BY created_at DESC
      LIMIT ?
    `).all(limit);

    db.close();

    return calibrations.map(cal => ({
      id: cal.id,
      date: cal.calibration_date,
      periodStart: cal.calibration_start,
      periodEnd: cal.calibration_end,
      windScale: cal.wind_scale,
      solarScale: cal.solar_scale,
      windDeviation: cal.wind_deviation,
      solarDeviation: cal.solar_deviation,
      demandMape: cal.demand_mape,
      demandPeakScale: cal.demand_peak_scale,
      demandOffpeakScale: cal.demand_offpeak_scale,
      converged: cal.within_threshold === 1,
      iterations: cal.iterations,
      createdAt: cal.created_at
    }));
  } catch (error) {
    console.error('Error reading calibrations:', error.message);
    return [];
  }
}

// Main execution
try {
  let result;

  switch (command) {
    case 'config': {
      const dbPath = getDbPath(arg1);
      result = getConfig(dbPath);
      break;
    }
    case 'runs': {
      const limit = parseInt(arg1) || 20;
      const dbPath = getDbPath(arg2);
      result = getRecentRuns(limit, dbPath);
      break;
    }
    case 'calibrations': {
      const limit = parseInt(arg1) || 10;
      const dbPath = getDbPath(arg2);
      result = getCalibrations(limit, dbPath);
      break;
    }
    case 'save-config': {
      const configJson = arg1;
      const dbPath = getDbPath(arg2);
      result = saveConfig(configJson, dbPath);
      break;
    }
    default:
      result = { error: `Unknown command: ${command}. Use: config, save-config, runs, calibrations` };
  }

  console.log(JSON.stringify(result));
} catch (error) {
  console.log(JSON.stringify({ error: error.message }));
  process.exit(1);
}
