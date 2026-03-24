#!/usr/bin/env node
/**
 * Training Plan Helper Script
 * Used by Electron main process to avoid ESM/CJS compatibility issues
 * Usage: node scripts/training-plan-helper.cjs <operation> [args...]
 */

const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

const PROJECT_ROOT = process.cwd();
const MODELS_DIR = path.join(PROJECT_ROOT, 'models');
const REGISTRY_DB = path.join(MODELS_DIR, 'registry.db');

// Get database instance and ensure schema exists
function getDatabase() {
  if (!fs.existsSync(MODELS_DIR)) {
    fs.mkdirSync(MODELS_DIR, { recursive: true });
  }

  const db = new Database(REGISTRY_DB);
  db.pragma('journal_mode = WAL');

  // Ensure training_plan_templates table exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS training_plan_templates (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      date_range_mode TEXT NOT NULL DEFAULT 'rolling',
      fixed_start TEXT,
      fixed_end TEXT,
      rolling_days INTEGER DEFAULT 30,
      train_demand INTEGER DEFAULT 1,
      train_cfac INTEGER DEFAULT 1,
      demand_model_type TEXT DEFAULT 'hybrid',
      cfac_model_type TEXT DEFAULT '4tier',
      calibration_enabled INTEGER DEFAULT 1,
      calibration_iterations INTEGER DEFAULT 10,
      calibration_threshold REAL DEFAULT 5.0,
      overrides_json TEXT,
      holdout_days INTEGER DEFAULT 7,
      auto_activate INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      created_by TEXT DEFAULT 'cli'
    );

    CREATE TABLE IF NOT EXISTS training_instances (
      id TEXT PRIMARY KEY,
      template_id TEXT,
      template_name TEXT,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      status TEXT NOT NULL DEFAULT 'running',
      error_message TEXT,
      date_range_start TEXT,
      date_range_end TEXT,
      demand_regional_summary TEXT,
      demand_zonal_summary TEXT,
      cfac_summary TEXT,
      demand_regional_mape REAL,
      demand_zonal_mape REAL,
      cfac_wind_mape REAL,
      cfac_solar_mape REAL,
      applied_overrides_json TEXT,
      cfac_calibration_id TEXT,
      FOREIGN KEY (template_id) REFERENCES training_plan_templates(id)
    );

    CREATE INDEX IF NOT EXISTS idx_training_plan_templates_name ON training_plan_templates(name);
    CREATE INDEX IF NOT EXISTS idx_training_plan_templates_created ON training_plan_templates(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_training_instances_started ON training_instances(started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_training_instances_status ON training_instances(status);
  `);

  return db;
}

// Convert database row to template object
function rowToTemplate(row) {
  const dateRange = {
    mode: row.date_range_mode,
    fixedStart: row.fixed_start || undefined,
    fixedEnd: row.fixed_end || undefined,
    rollingDays: row.rolling_days || undefined,
  };

  const overrides = row.overrides_json ? JSON.parse(row.overrides_json) : {
    zones: {},
    regions: {},
    stationTypes: {},
  };

  return {
    id: row.id,
    name: row.name,
    description: row.description || undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    dateRange,
    trainDemand: row.train_demand === 1,
    trainCfac: row.train_cfac === 1,
    demandModelType: row.demand_model_type,
    cfacModelType: row.cfac_model_type,
    calibrationEnabled: row.calibration_enabled === 1,
    calibrationIterations: row.calibration_iterations,
    calibrationThreshold: row.calibration_threshold,
    overrides,
    holdoutDays: row.holdout_days,
    autoActivate: row.auto_activate === 1,
  };
}

// Operations
const operations = {
  create(templateJson, createdBy = 'gui') {
    const template = JSON.parse(templateJson);
    const db = getDatabase();
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    const stmt = db.prepare(`
      INSERT INTO training_plan_templates (
        id, name, description,
        date_range_mode, fixed_start, fixed_end, rolling_days,
        train_demand, train_cfac,
        demand_model_type, cfac_model_type,
        calibration_enabled, calibration_iterations, calibration_threshold,
        overrides_json,
        holdout_days, auto_activate,
        created_at, updated_at, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      template.name,
      template.description || null,
      template.dateRange.mode,
      template.dateRange.fixedStart || null,
      template.dateRange.fixedEnd || null,
      template.dateRange.rollingDays || null,
      template.trainDemand ? 1 : 0,
      template.trainCfac ? 1 : 0,
      template.demandModelType,
      template.cfacModelType,
      template.calibrationEnabled ? 1 : 0,
      template.calibrationIterations,
      template.calibrationThreshold,
      JSON.stringify(template.overrides),
      template.holdoutDays,
      template.autoActivate ? 1 : 0,
      now,
      now,
      createdBy
    );

    db.close();
    return { id };
  },

  update(id, updatesJson) {
    const updates = JSON.parse(updatesJson);
    const db = getDatabase();
    const now = new Date().toISOString();

    const setClauses = ['updated_at = ?'];
    const values = [now];

    if (updates.name !== undefined) {
      setClauses.push('name = ?');
      values.push(updates.name);
    }

    if (updates.description !== undefined) {
      setClauses.push('description = ?');
      values.push(updates.description || null);
    }

    if (updates.dateRange !== undefined) {
      setClauses.push('date_range_mode = ?', 'fixed_start = ?', 'fixed_end = ?', 'rolling_days = ?');
      values.push(
        updates.dateRange.mode,
        updates.dateRange.fixedStart || null,
        updates.dateRange.fixedEnd || null,
        updates.dateRange.rollingDays || null
      );
    }

    if (updates.trainDemand !== undefined) {
      setClauses.push('train_demand = ?');
      values.push(updates.trainDemand ? 1 : 0);
    }

    if (updates.trainCfac !== undefined) {
      setClauses.push('train_cfac = ?');
      values.push(updates.trainCfac ? 1 : 0);
    }

    if (updates.demandModelType !== undefined) {
      setClauses.push('demand_model_type = ?');
      values.push(updates.demandModelType);
    }

    if (updates.cfacModelType !== undefined) {
      setClauses.push('cfac_model_type = ?');
      values.push(updates.cfacModelType);
    }

    if (updates.calibrationEnabled !== undefined) {
      setClauses.push('calibration_enabled = ?');
      values.push(updates.calibrationEnabled ? 1 : 0);
    }

    if (updates.calibrationIterations !== undefined) {
      setClauses.push('calibration_iterations = ?');
      values.push(updates.calibrationIterations);
    }

    if (updates.calibrationThreshold !== undefined) {
      setClauses.push('calibration_threshold = ?');
      values.push(updates.calibrationThreshold);
    }

    if (updates.overrides !== undefined) {
      setClauses.push('overrides_json = ?');
      values.push(JSON.stringify(updates.overrides));
    }

    if (updates.holdoutDays !== undefined) {
      setClauses.push('holdout_days = ?');
      values.push(updates.holdoutDays);
    }

    if (updates.autoActivate !== undefined) {
      setClauses.push('auto_activate = ?');
      values.push(updates.autoActivate ? 1 : 0);
    }

    values.push(id);

    const sql = `UPDATE training_plan_templates SET ${setClauses.join(', ')} WHERE id = ?`;
    const result = db.prepare(sql).run(...values);

    db.close();

    if (result.changes === 0) {
      throw new Error(`Training plan template not found: ${id}`);
    }

    return { success: true };
  },

  delete(id) {
    const db = getDatabase();
    const result = db.prepare('DELETE FROM training_plan_templates WHERE id = ?').run(id);
    db.close();

    if (result.changes === 0) {
      throw new Error(`Training plan template not found: ${id}`);
    }

    return { success: true };
  },

  get(id) {
    const db = getDatabase();
    const row = db.prepare('SELECT * FROM training_plan_templates WHERE id = ?').get(id);
    db.close();

    if (!row) {
      throw new Error(`Training plan template not found: ${id}`);
    }

    return rowToTemplate(row);
  },

  list() {
    const db = getDatabase();
    const rows = db.prepare('SELECT * FROM training_plan_templates ORDER BY created_at DESC').all();
    db.close();

    return rows.map(rowToTemplate);
  },
};

// Main execution
try {
  const operation = process.argv[2];
  const args = process.argv.slice(3);

  if (!operation || !operations[operation]) {
    throw new Error(`Invalid operation: ${operation}. Valid operations: create, update, delete, get, list`);
  }

  const result = operations[operation](...args);
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(JSON.stringify({ error: error.message }));
  process.exit(1);
}
