/**
 * Training Plan Service
 *
 * Manages training plan templates - reusable configurations for model training.
 * Part of Phase A implementation (Model Workflow Vision Part 2).
 */

import Database from 'better-sqlite3';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import {
  TrainingPlanTemplate,
  DateRangeConfig,
  TrainingPlanOverrides,
} from '../types/models.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '../../');
const MODELS_DIR = path.join(PROJECT_ROOT, 'models');
const REGISTRY_DB = path.join(MODELS_DIR, 'registry.db');

/**
 * Database row representation of training plan template
 */
interface TrainingPlanTemplateRow {
  id: string;
  name: string;
  description: string | null;
  date_range_mode: string;
  fixed_start: string | null;
  fixed_end: string | null;
  rolling_days: number | null;
  train_demand: number;
  train_cfac: number;
  demand_model_type: string;
  cfac_model_type: string;
  calibration_enabled: number;
  calibration_iterations: number;
  calibration_threshold: number;
  overrides_json: string | null;
  holdout_days: number;
  auto_activate: number;
  created_at: string;
  updated_at: string;
  created_by: string | null;
}

/**
 * Get database instance
 */
function getDatabase(): Database.Database {
  // Ensure models directory exists
  if (!fs.existsSync(MODELS_DIR)) {
    fs.mkdirSync(MODELS_DIR, { recursive: true });
  }

  const db = new Database(REGISTRY_DB);
  db.pragma('journal_mode = WAL');
  return db;
}

/**
 * Convert database row to TrainingPlanTemplate
 */
function rowToTemplate(row: TrainingPlanTemplateRow): TrainingPlanTemplate {
  const dateRange: DateRangeConfig = {
    mode: row.date_range_mode as 'fixed' | 'rolling',
    fixedStart: row.fixed_start || undefined,
    fixedEnd: row.fixed_end || undefined,
    rollingDays: row.rolling_days as (14 | 30 | 90 | 180 | 365) | undefined,
  };

  const overrides: TrainingPlanOverrides = row.overrides_json
    ? JSON.parse(row.overrides_json)
    : { zones: {}, regions: {}, stationTypes: {} };

  return {
    id: row.id,
    name: row.name,
    description: row.description || undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    dateRange,
    trainDemand: row.train_demand === 1,
    trainCfac: row.train_cfac === 1,
    demandModelType: row.demand_model_type as 'hybrid' | 'xgboost' | 'regression',
    cfacModelType: row.cfac_model_type as '4tier' | 'hybrid' | 'mrec' | 'physics',
    calibrationEnabled: row.calibration_enabled === 1,
    calibrationIterations: row.calibration_iterations,
    calibrationThreshold: row.calibration_threshold,
    overrides,
    holdoutDays: row.holdout_days,
    autoActivate: row.auto_activate === 1,
  };
}

/**
 * Create a new training plan template
 */
export function createTemplate(
  template: Omit<TrainingPlanTemplate, 'id' | 'createdAt' | 'updatedAt'>,
  createdBy: string = 'manual'
): string {
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
    ) VALUES (
      ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?,
      ?, ?,
      ?, ?, ?,
      ?,
      ?, ?,
      ?, ?, ?
    )
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

  console.log(`Training plan template created: ${template.name} (${id})`);
  return id;
}

/**
 * Update an existing training plan template
 */
export function updateTemplate(
  id: string,
  updates: Partial<Omit<TrainingPlanTemplate, 'id' | 'createdAt' | 'updatedAt'>>
): void {
  const db = getDatabase();
  const now = new Date().toISOString();

  // Build dynamic UPDATE statement
  const setClauses: string[] = ['updated_at = ?'];
  const values: any[] = [now];

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
  const stmt = db.prepare(sql);
  const result = stmt.run(...values);

  if (result.changes === 0) {
    throw new Error(`Training plan template not found: ${id}`);
  }

  console.log(`Training plan template updated: ${id}`);
}

/**
 * Delete a training plan template
 */
export function deleteTemplate(id: string): void {
  const db = getDatabase();

  const stmt = db.prepare('DELETE FROM training_plan_templates WHERE id = ?');
  const result = stmt.run(id);

  if (result.changes === 0) {
    throw new Error(`Training plan template not found: ${id}`);
  }

  console.log(`Training plan template deleted: ${id}`);
}

/**
 * Get a training plan template by ID
 */
export function getTemplateById(id: string): TrainingPlanTemplate | null {
  const db = getDatabase();

  const stmt = db.prepare('SELECT * FROM training_plan_templates WHERE id = ?');
  const row = stmt.get(id) as TrainingPlanTemplateRow | undefined;

  if (!row) {
    return null;
  }

  return rowToTemplate(row);
}

/**
 * List all training plan templates
 */
export function listTemplates(): TrainingPlanTemplate[] {
  const db = getDatabase();

  const stmt = db.prepare('SELECT * FROM training_plan_templates ORDER BY created_at DESC');
  const rows = stmt.all() as TrainingPlanTemplateRow[];

  return rows.map(rowToTemplate);
}

/**
 * Get templates by name (partial match)
 */
export function searchTemplates(nameQuery: string): TrainingPlanTemplate[] {
  const db = getDatabase();

  const stmt = db.prepare(
    `SELECT * FROM training_plan_templates
     WHERE name LIKE ?
     ORDER BY created_at DESC`
  );
  const rows = stmt.all(`%${nameQuery}%`) as TrainingPlanTemplateRow[];

  return rows.map(rowToTemplate);
}

/**
 * Create a default template for new users
 */
export function createDefaultTemplate(): string {
  const defaultTemplate: Omit<TrainingPlanTemplate, 'id' | 'createdAt' | 'updatedAt'> = {
    name: 'Default Weekly Rolling',
    description: 'Rolling 2-week window with hybrid models and calibration enabled',
    dateRange: {
      mode: 'rolling',
      rollingDays: 14,
    },
    trainDemand: true,
    trainCfac: true,
    demandModelType: 'hybrid',
    cfacModelType: '4tier',
    calibrationEnabled: true,
    calibrationIterations: 3,
    calibrationThreshold: 5.0,
    overrides: {
      zones: {},
      regions: {},
      stationTypes: {},
    },
    holdoutDays: 7,
    autoActivate: true,
  };

  return createTemplate(defaultTemplate, 'system');
}
