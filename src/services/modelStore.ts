/**
 * Model Store Service
 *
 * Manages model storage using SQLite registry and binary model files.
 * Provides operations for saving, loading, activating, and managing models.
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import {
  SavedModel,
  ModelRegistry,
  ModelListFilters,
  EntityType,
  ModelType,
  ModelGroup,
  TrainingRun,
  CalibrationData,
} from '../types/models.js';
import { serialize, deserialize, calculateChecksum } from './modelSerializer.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Paths
const PROJECT_ROOT = path.resolve(__dirname, '../../');
const MODELS_DIR = path.join(PROJECT_ROOT, 'models');
const REGISTRY_DB = path.join(MODELS_DIR, 'registry.db');

/**
 * Initialize model store (database + directory structure)
 */
export function initializeModelStore(): void {
  console.log('Initializing model store...');

  // Create directory structure
  const dirs = [
    MODELS_DIR,
    path.join(MODELS_DIR, 'demand', 'regional'),
    path.join(MODELS_DIR, 'demand', 'zonal'),
    path.join(MODELS_DIR, 'cfac', 'wind'),
    path.join(MODELS_DIR, 'cfac', 'solar'),
    path.join(MODELS_DIR, 'cfac', 'hydro'),
    path.join(MODELS_DIR, 'cfac', 'biomass'),
    path.join(MODELS_DIR, 'cfac', 'geothermal'),
    path.join(MODELS_DIR, 'cfac', 'battery'),
    path.join(MODELS_DIR, 'calibration', 'cfac_scaling'),
  ];

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      console.log(`  Created: ${dir}`);
    }
  }

  // Create database schema
  const db = getDatabase();

  // Models table
  db.exec(`
    CREATE TABLE IF NOT EXISTS models (
      id TEXT PRIMARY KEY,

      -- Entity identification
      entity_type TEXT NOT NULL,
      entity_code TEXT NOT NULL,
      is_group_model INTEGER DEFAULT 0,

      -- Model configuration
      model_type TEXT NOT NULL,
      model_config TEXT,
      version INTEGER NOT NULL,

      -- Training metadata
      trained_at TEXT NOT NULL,
      training_start TEXT,
      training_end TEXT,
      training_records INTEGER,
      holdout_days INTEGER,

      -- Performance metrics
      mape REAL,
      rmse REAL,
      mae REAL,
      r2_score REAL,
      bias REAL,
      peak_mape REAL,
      offpeak_mape REAL,
      weekday_mape REAL,
      weekend_mape REAL,
      holiday_mape REAL,
      per_zone_mape TEXT,     -- JSON: Record<string, number>
      per_region_mape TEXT,   -- JSON: Record<string, number>

      -- Calibration settings (demand models)
      calibration_mode TEXT,
      calibration_quantile_alpha REAL,
      calibration_enable_zone_scaling INTEGER,
      calibration_pass1_peak_scale REAL,
      calibration_pass1_offpeak_scale REAL,
      calibration_pass1_zone_scales TEXT,
      calibration_pass1_converged INTEGER,
      calibration_pass1_iterations INTEGER,
      calibration_pass2_train_mape REAL,
      calibration_pass2_val_mape REAL,
      calibration_pass2_alpha REAL,

      -- Status
      is_active INTEGER DEFAULT 0,
      is_archived INTEGER DEFAULT 0,

      -- File reference
      file_path TEXT NOT NULL,
      file_size INTEGER,
      checksum TEXT,

      -- Audit
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      created_by TEXT,
      notes TEXT,

      -- Integration status
      is_scheduler_active INTEGER DEFAULT 0,
      is_manual_active INTEGER DEFAULT 0,
      last_used_at TEXT,
      usage_count INTEGER DEFAULT 0
    )
  `);

  // Ensure only one active model per entity
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_active_model
      ON models(entity_type, entity_code)
      WHERE is_active = 1
  `);

  // Quick lookups
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_entity
      ON models(entity_type, entity_code)
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_trained_at
      ON models(trained_at DESC)
  `);

  // Model groups table
  db.exec(`
    CREATE TABLE IF NOT EXISTS model_groups (
      group_code TEXT PRIMARY KEY,
      group_type TEXT NOT NULL,
      description TEXT,
      station_codes TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Training runs table
  db.exec(`
    CREATE TABLE IF NOT EXISTS training_runs (
      id TEXT PRIMARY KEY,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      status TEXT,
      entities_trained INTEGER,
      models_improved INTEGER,
      models_activated INTEGER,
      error_message TEXT,
      log_path TEXT
    )
  `);

  // Migration: Add columns that may be missing in existing databases
  const migrateColumns = [
    { name: 'calibration_mode', type: 'TEXT' },
    { name: 'calibration_quantile_alpha', type: 'REAL' },
    { name: 'calibration_enable_zone_scaling', type: 'INTEGER' },
    { name: 'calibration_pass1_peak_scale', type: 'REAL' },
    { name: 'calibration_pass1_offpeak_scale', type: 'REAL' },
    { name: 'calibration_pass1_zone_scales', type: 'TEXT' },
    { name: 'calibration_pass1_converged', type: 'INTEGER' },
    { name: 'calibration_pass1_iterations', type: 'INTEGER' },
    { name: 'calibration_pass2_train_mape', type: 'REAL' },
    { name: 'calibration_pass2_val_mape', type: 'REAL' },
    { name: 'calibration_pass2_alpha', type: 'REAL' },
    { name: 'peak_mape', type: 'REAL' },
    { name: 'offpeak_mape', type: 'REAL' },
    { name: 'weekday_mape', type: 'REAL' },
    { name: 'weekend_mape', type: 'REAL' },
    { name: 'holiday_mape', type: 'REAL' },
    { name: 'per_zone_mape', type: 'TEXT' },
    { name: 'per_region_mape', type: 'TEXT' },
    { name: 'is_scheduler_active', type: 'INTEGER DEFAULT 0' },
    { name: 'is_manual_active', type: 'INTEGER DEFAULT 0' },
    { name: 'last_used_at', type: 'TEXT' },
    { name: 'usage_count', type: 'INTEGER DEFAULT 0' },
  ];

  // Get existing columns
  const existingColumns = db.prepare('PRAGMA table_info(models)').all() as { name: string }[];
  const columnNames = existingColumns.map((c) => c.name);

  // Add missing columns
  for (const col of migrateColumns) {
    if (!columnNames.includes(col.name)) {
      try {
        db.exec(`ALTER TABLE models ADD COLUMN ${col.name} ${col.type}`);
        console.log(`  Migration: Added column ${col.name}`);
      } catch {
        // Column might already exist, ignore
      }
    }
  }

  console.log('Model store initialized successfully');
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
 * Save a model to the store
 */
export function saveModel(
  model: SavedModel,
  createdBy: string = 'manual',
  notes?: string
): string {
  const db = getDatabase();

  // Determine next version for this entity
  const existingVersions = db
    .prepare(
      `SELECT MAX(version) as max_version
       FROM models
       WHERE entity_type = ? AND entity_code = ?`
    )
    .get(model.metadata.entityType, model.metadata.entityCode) as { max_version: number | null };

  const version = (existingVersions.max_version || 0) + 1;
  model.metadata.version = version;

  // Generate file path
  const filePath = getModelFilePath(model.metadata);
  const fullPath = path.join(PROJECT_ROOT, filePath);

  // Ensure directory exists
  const dir = path.dirname(fullPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Serialize and save model file
  const buffer = serialize(model);
  fs.writeFileSync(fullPath, buffer);

  const fileSize = buffer.length;
  const checksum = calculateChecksum(buffer);

  // Extract calibration settings if present
  const calibration = model.metadata.calibrationSettings;

  // Insert into registry
  const stmt = db.prepare(`
    INSERT INTO models (
      id, entity_type, entity_code, is_group_model,
      model_type, version, trained_at,
      training_start, training_end, training_records, holdout_days,
      mape, rmse, mae, r2_score, bias, peak_mape, offpeak_mape,
      weekday_mape, weekend_mape, holiday_mape,
      per_zone_mape, per_region_mape,
      calibration_mode, calibration_quantile_alpha, calibration_enable_zone_scaling,
      calibration_pass1_peak_scale, calibration_pass1_offpeak_scale, calibration_pass1_zone_scales,
      calibration_pass1_converged, calibration_pass1_iterations,
      calibration_pass2_train_mape, calibration_pass2_val_mape, calibration_pass2_alpha,
      is_active, is_archived,
      file_path, file_size, checksum,
      created_by, notes
    ) VALUES (
      ?, ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?,
      ?, ?,
      ?, ?, ?,
      ?, ?, ?,
      ?, ?,
      ?, ?, ?,
      0, 0,
      ?, ?, ?,
      ?, ?
    )
  `);

  stmt.run(
    model.metadata.id,
    model.metadata.entityType,
    model.metadata.entityCode,
    model.metadata.isGroupModel ? 1 : 0,
    model.metadata.modelType,
    version,
    model.metadata.trainedAt,
    model.metadata.trainingPeriod.start,
    model.metadata.trainingPeriod.end,
    model.metadata.trainingRecords,
    model.metadata.holdoutDays,
    model.metrics.mape,
    model.metrics.rmse,
    model.metrics.mae,
    model.metrics.r2Score,
    model.metrics.bias,
    model.metrics.peakMape || null,
    model.metrics.offpeakMape || null,
    // Day type breakdown
    model.metrics.weekdayMape || null,
    model.metrics.weekendMape || null,
    model.metrics.holidayMape || null,
    // Per-zone/region breakdown (stored as JSON)
    model.metrics.perZoneMape ? JSON.stringify(model.metrics.perZoneMape) : null,
    model.metrics.perRegionMape ? JSON.stringify(model.metrics.perRegionMape) : null,
    // Calibration settings
    calibration?.mode || null,
    calibration?.quantileAlpha || null,
    calibration?.enableZoneScaling ? 1 : null,
    calibration?.pass1?.peakScale || null,
    calibration?.pass1?.offpeakScale || null,
    calibration?.pass1?.zoneScales ? JSON.stringify(calibration.pass1.zoneScales) : null,
    calibration?.pass1?.converged ? 1 : 0,
    calibration?.pass1?.iterations || null,
    calibration?.pass2?.trainMAPE || null,
    calibration?.pass2?.validationMAPE || null,
    calibration?.pass2?.alpha || null,
    filePath,
    fileSize,
    checksum,
    createdBy,
    notes || null
  );

  console.log(`Model saved: ${model.metadata.entityType}/${model.metadata.entityCode} v${version}`);
  console.log(`  File: ${filePath}`);
  console.log(`  MAPE: ${model.metrics.mape.toFixed(2)}%`);

  return model.metadata.id;
}

/**
 * Get active model for an entity
 */
export function getActiveModel(entityType: EntityType, entityCode: string): SavedModel | null {
  const db = getDatabase();

  const row = db
    .prepare(
      `SELECT * FROM models
       WHERE entity_type = ? AND entity_code = ? AND is_active = 1
       LIMIT 1`
    )
    .get(entityType, entityCode) as ModelRegistry | undefined;

  if (!row) {
    return null;
  }

  return loadModelFromRegistry(row);
}

/**
 * Get model by ID
 */
export function getModelById(id: string): SavedModel | null {
  const db = getDatabase();

  const row = db
    .prepare('SELECT * FROM models WHERE id = ?')
    .get(id) as ModelRegistry | undefined;

  if (!row) {
    return null;
  }

  return loadModelFromRegistry(row);
}

/**
 * Get model registry entry by ID (status info without loading full model)
 */
export function getModelRegistryById(id: string): ModelRegistry | null {
  const db = getDatabase();

  const row = db
    .prepare('SELECT * FROM models WHERE id = ?')
    .get(id) as ModelRegistry | undefined;

  return row || null;
}

/**
 * List models with optional filtering
 */
export function listModels(filters?: ModelListFilters): ModelRegistry[] {
  const db = getDatabase();

  let sql = 'SELECT * FROM models WHERE 1=1';
  const params: any[] = [];

  if (filters?.entityType) {
    sql += ' AND entity_type = ?';
    params.push(filters.entityType);
  }

  if (filters?.entityCode) {
    sql += ' AND entity_code = ?';
    params.push(filters.entityCode);
  }

  if (filters?.isActive !== undefined) {
    sql += ' AND is_active = ?';
    params.push(filters.isActive ? 1 : 0);
  }

  if (filters?.isArchived !== undefined) {
    sql += ' AND is_archived = ?';
    params.push(filters.isArchived ? 1 : 0);
  }

  if (filters?.modelType) {
    sql += ' AND model_type = ?';
    params.push(filters.modelType);
  }

  sql += ' ORDER BY entity_type, entity_code, version DESC';

  return db.prepare(sql).all(...params) as ModelRegistry[];
}

/**
 * Activate a model (deactivates others for same entity)
 */
export function activateModel(id: string): void {
  const db = getDatabase();

  // Get the model to activate
  const model = db
    .prepare('SELECT entity_type, entity_code FROM models WHERE id = ?')
    .get(id) as { entity_type: string; entity_code: string } | undefined;

  if (!model) {
    throw new Error(`Model not found: ${id}`);
  }

  // Deactivate all models for this entity
  db.prepare(
    `UPDATE models
     SET is_active = 0
     WHERE entity_type = ? AND entity_code = ?`
  ).run(model.entity_type, model.entity_code);

  // Activate the specified model
  db.prepare('UPDATE models SET is_active = 1 WHERE id = ?').run(id);

  console.log(`Model activated: ${model.entity_type}/${model.entity_code} (${id})`);
}

/**
 * Archive a model
 */
export function archiveModel(id: string): void {
  const db = getDatabase();

  db.prepare('UPDATE models SET is_archived = 1, is_active = 0 WHERE id = ?').run(id);

  console.log(`Model archived: ${id}`);
}

/**
 * Delete a model (removes from registry and deletes file)
 */
export function deleteModel(id: string): void {
  const db = getDatabase();

  // Get model info
  const model = db
    .prepare('SELECT file_path FROM models WHERE id = ?')
    .get(id) as { file_path: string } | undefined;

  if (!model) {
    throw new Error(`Model not found: ${id}`);
  }

  // Delete file
  const fullPath = path.join(PROJECT_ROOT, model.file_path);
  if (fs.existsSync(fullPath)) {
    fs.unlinkSync(fullPath);
  }

  // Delete from registry
  db.prepare('DELETE FROM models WHERE id = ?').run(id);

  console.log(`Model deleted: ${id}`);
}

/**
 * Load model from registry row
 */
function loadModelFromRegistry(row: ModelRegistry): SavedModel {
  const fullPath = path.join(PROJECT_ROOT, row.file_path);

  if (!fs.existsSync(fullPath)) {
    throw new Error(`Model file not found: ${fullPath}`);
  }

  const buffer = fs.readFileSync(fullPath);

  // Verify checksum
  const actualChecksum = calculateChecksum(buffer);
  if (row.checksum && actualChecksum !== row.checksum) {
    console.warn(`Warning: Checksum mismatch for model ${row.id}`);
  }

  return deserialize(buffer);
}

/**
 * Generate file path for a model
 */
function getModelFilePath(metadata: SavedModel['metadata']): string {
  const category = ['regional', 'zonal'].includes(metadata.entityType) ? 'demand' : 'cfac';
  const type = metadata.entityType;
  const entity = metadata.entityCode;
  const timestamp = new Date(metadata.trainedAt).toISOString().split('T')[0];
  const filename = `v${String(metadata.version).padStart(3, '0')}_${timestamp}_${metadata.modelType}.vfm`;

  return path.join('models', category, type, entity, filename);
}

/**
 * Get model groups
 */
export function listModelGroups(): ModelGroup[] {
  const db = getDatabase();
  return db.prepare('SELECT * FROM model_groups ORDER BY group_type, group_code').all() as ModelGroup[];
}

/**
 * Save model group
 */
export function saveModelGroup(group: Omit<ModelGroup, 'created_at'>): void {
  const db = getDatabase();

  db.prepare(`
    INSERT OR REPLACE INTO model_groups (group_code, group_type, description, station_codes)
    VALUES (?, ?, ?, ?)
  `).run(group.group_code, group.group_type, group.description, group.station_codes);

  console.log(`Model group saved: ${group.group_code}`);
}

/**
 * Get training runs
 */
export function listTrainingRuns(limit: number = 50): TrainingRun[] {
  const db = getDatabase();
  return db
    .prepare('SELECT * FROM training_runs ORDER BY started_at DESC LIMIT ?')
    .all(limit) as TrainingRun[];
}

/**
 * Save training run
 */
export function saveTrainingRun(run: Omit<TrainingRun, 'id'>): string {
  const db = getDatabase();
  const id = crypto.randomUUID();

  db.prepare(`
    INSERT INTO training_runs (
      id, started_at, completed_at, status,
      entities_trained, models_improved, models_activated,
      error_message, log_path
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    run.started_at,
    run.completed_at || null,
    run.status,
    run.entities_trained || null,
    run.models_improved || null,
    run.models_activated || null,
    run.error_message || null,
    run.log_path || null
  );

  return id;
}

/**
 * Update training run
 */
export function updateTrainingRun(id: string, updates: Partial<TrainingRun>): void {
  const db = getDatabase();

  const setClauses: string[] = [];
  const values: any[] = [];

  if (updates.completed_at !== undefined) {
    setClauses.push('completed_at = ?');
    values.push(updates.completed_at);
  }

  if (updates.status !== undefined) {
    setClauses.push('status = ?');
    values.push(updates.status);
  }

  if (updates.entities_trained !== undefined) {
    setClauses.push('entities_trained = ?');
    values.push(updates.entities_trained);
  }

  if (updates.models_improved !== undefined) {
    setClauses.push('models_improved = ?');
    values.push(updates.models_improved);
  }

  if (updates.models_activated !== undefined) {
    setClauses.push('models_activated = ?');
    values.push(updates.models_activated);
  }

  if (updates.error_message !== undefined) {
    setClauses.push('error_message = ?');
    values.push(updates.error_message);
  }

  if (updates.log_path !== undefined) {
    setClauses.push('log_path = ?');
    values.push(updates.log_path);
  }

  if (setClauses.length > 0) {
    values.push(id);
    db.prepare(`UPDATE training_runs SET ${setClauses.join(', ')} WHERE id = ?`).run(...values);
  }
}

/**
 * Export a model to a user-specified location
 */
export function exportModel(id: string, outputPath: string): void {
  const db = getDatabase();

  // Get model info
  const model = db
    .prepare('SELECT file_path, entity_type, entity_code FROM models WHERE id = ?')
    .get(id) as { file_path: string; entity_type: string; entity_code: string } | undefined;

  if (!model) {
    throw new Error(`Model not found: ${id}`);
  }

  // Read source file
  const sourcePath = path.join(PROJECT_ROOT, model.file_path);
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Model file not found: ${sourcePath}`);
  }

  // Copy to destination
  fs.copyFileSync(sourcePath, outputPath);

  console.log(`Model exported: ${model.entity_type}/${model.entity_code}`);
  console.log(`  Destination: ${outputPath}`);
}

/**
 * Import a model from a .vfm file
 */
export function importModel(filePath: string, createdBy: string = 'import'): string {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Model file not found: ${filePath}`);
  }

  // Load and validate the model file
  const buffer = fs.readFileSync(filePath);
  const model = deserialize(buffer);

  // Validate model structure
  if (!model.metadata || !model.modelData || !model.metrics) {
    throw new Error('Invalid model file format');
  }

  // Generate a new ID for the imported model
  const newId = crypto.randomUUID();
  model.metadata.id = newId;

  // Save the model (will assign a new version number)
  const savedId = saveModel(model, createdBy, 'Imported from external file');

  console.log(`Model imported successfully`);
  console.log(`  Entity: ${model.metadata.entityType}/${model.metadata.entityCode}`);
  console.log(`  New ID: ${savedId}`);

  return savedId;
}

/**
 * Calibration info from database (for display)
 */
export interface CalibrationInfo {
  mode: string;
  quantileAlpha?: number;
  enableZoneScaling?: boolean;
  pass1?: {
    peakScale: number;
    offpeakScale: number;
    zoneScales?: Record<string, number>;
    converged: boolean;
    iterations: number;
  };
  pass2?: {
    trainMAPE: number;
    validationMAPE: number;
    alpha: number;
  };
}

/**
 * Training Instance - groups models trained together
 */
export interface TrainingInstance {
  id: string;  // Composite key: entityType + timestamp window
  entityType: string;
  trainedAt: string;
  name: string;                         // User-friendly name or auto-generated label
  modelCount: number;
  activeCount: number;
  avgMape: number | null;
  minMape: number | null;
  maxMape: number | null;
  trainingPeriod: { start: string; end: string } | null;
  calibration: CalibrationInfo | null;  // Calibration settings used
  isSchedulerActive: boolean;           // True if any model in this instance is scheduler active
  isManualActive: boolean;              // True if any model in this instance is manual active
  models: ModelRegistry[];
}

/**
 * Get training instances - groups models by entity_type and training timestamp
 * Models trained within the same 5-minute window are considered one instance
 */
export function getTrainingInstances(): TrainingInstance[] {
  const db = getDatabase();

  // Get all models ordered by entity_type and trained_at
  const models = db.prepare(`
    SELECT * FROM models
    WHERE is_archived = 0
    ORDER BY entity_type, trained_at DESC
  `).all() as ModelRegistry[];

  // Group by entity_type and 5-minute time windows
  const instanceMap = new Map<string, ModelRegistry[]>();

  for (const model of models) {
    // Truncate timestamp to 5-minute window
    const timestamp = new Date(model.trained_at);
    timestamp.setMinutes(Math.floor(timestamp.getMinutes() / 5) * 5);
    timestamp.setSeconds(0);
    timestamp.setMilliseconds(0);

    const key = `${model.entity_type}|${timestamp.toISOString()}`;

    if (!instanceMap.has(key)) {
      instanceMap.set(key, []);
    }
    instanceMap.get(key)!.push(model);
  }

  // Convert to TrainingInstance array
  const instances: TrainingInstance[] = [];

  for (const [key, groupModels] of instanceMap) {
    const [entityType, trainedAt] = key.split('|');

    // Calculate aggregate metrics
    const mapeValues = groupModels.filter(m => m.mape != null).map(m => m.mape!);
    const avgMape = mapeValues.length > 0
      ? mapeValues.reduce((a, b) => a + b, 0) / mapeValues.length
      : null;
    const minMape = mapeValues.length > 0 ? Math.min(...mapeValues) : null;
    const maxMape = mapeValues.length > 0 ? Math.max(...mapeValues) : null;

    // Get training period from first model
    const trainingPeriod = groupModels[0].training_start && groupModels[0].training_end
      ? { start: groupModels[0].training_start, end: groupModels[0].training_end }
      : null;

    // Extract calibration info from first model (all models in same instance share calibration)
    const firstModel = groupModels[0] as any;
    let calibration: CalibrationInfo | null = null;

    if (firstModel.calibration_mode) {
      calibration = {
        mode: firstModel.calibration_mode,
        quantileAlpha: firstModel.calibration_quantile_alpha || undefined,
        enableZoneScaling: firstModel.calibration_enable_zone_scaling === 1,
      };

      // Add Pass 1 info if present
      if (firstModel.calibration_pass1_peak_scale != null) {
        calibration.pass1 = {
          peakScale: firstModel.calibration_pass1_peak_scale,
          offpeakScale: firstModel.calibration_pass1_offpeak_scale || 0,
          zoneScales: firstModel.calibration_pass1_zone_scales
            ? JSON.parse(firstModel.calibration_pass1_zone_scales)
            : undefined,
          converged: firstModel.calibration_pass1_converged === 1,
          iterations: firstModel.calibration_pass1_iterations || 0,
        };
      }

      // Add Pass 2 info if present
      if (firstModel.calibration_pass2_train_mape != null) {
        calibration.pass2 = {
          trainMAPE: firstModel.calibration_pass2_train_mape,
          validationMAPE: firstModel.calibration_pass2_val_mape || 0,
          alpha: firstModel.calibration_pass2_alpha || 0.5,
        };
      }
    }

    // Check if any model in this instance is scheduler/manual active
    const isSchedulerActive = groupModels.some((m: any) => m.is_scheduler_active === 1);
    const isManualActive = groupModels.some((m: any) => m.is_manual_active === 1);

    // Get name from first model's notes, or generate a default
    const firstModelNotes = groupModels[0]?.notes;
    const trainedDate = new Date(trainedAt);
    const defaultName = `${entityType} ${trainedDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
    const name = firstModelNotes || defaultName;

    instances.push({
      id: key,
      entityType,
      trainedAt,
      name,
      modelCount: groupModels.length,
      activeCount: groupModels.filter(m => m.is_active).length,
      avgMape,
      minMape,
      maxMape,
      trainingPeriod,
      calibration,
      isSchedulerActive,
      isManualActive,
      models: groupModels.sort((a, b) => a.entity_code.localeCompare(b.entity_code)),
    });
  }

  // Sort by trained_at descending
  return instances.sort((a, b) => new Date(b.trainedAt).getTime() - new Date(a.trainedAt).getTime());
}

/**
 * Save calibration factors to the model store
 * This allows calibrations to be part of the unified training instance system
 */
export function saveCalibration(
  calibration: CalibrationData,
  trainedAt?: string,
  createdBy: string = 'scheduler',
  notes?: string
): string {
  const db = getDatabase();

  // Use provided timestamp or current time
  const timestamp = trainedAt || new Date().toISOString();

  // Determine next version for calibration entity
  const existingVersions = db
    .prepare(
      `SELECT MAX(version) as max_version
       FROM models
       WHERE entity_type = 'calibration' AND entity_code = 'cfac_scaling'`
    )
    .get() as { max_version: number | null };

  const version = (existingVersions?.max_version || 0) + 1;

  // Generate unique ID
  const id = crypto.randomUUID();

  // Create file path for calibration data
  const filePath = `models/calibration/cfac_scaling/v${String(version).padStart(3, '0')}_${timestamp.split('T')[0]}_scaling.vfm`;
  const fullPath = path.join(PROJECT_ROOT, filePath);

  // Ensure directory exists
  const dir = path.dirname(fullPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Create SavedModel structure for calibration
  const savedModel: SavedModel = {
    metadata: {
      id,
      entityType: 'calibration' as EntityType,
      entityCode: 'cfac_scaling',
      isGroupModel: true,
      modelType: 'scaling' as ModelType,
      version,
      trainedAt: timestamp,
      trainingPeriod: calibration.calibrationPeriod,
      holdoutDays: 0,
      trainingRecords: 0,
    },
    metrics: {
      mape: calibration.demandMape || 0,
      rmse: 0,
      mae: 0,
      r2Score: 0,
      bias: 0,
      trainingRecords: 0,
      testRecords: 0,
    },
    featureConfig: {
      features: [],
      normalization: {},
    },
    modelData: {
      type: 'scaling' as ModelType,
      data: calibration,
    },
  };

  // Serialize and write to file
  const serialized = serialize(savedModel);
  fs.writeFileSync(fullPath, serialized);
  const fileSize = fs.statSync(fullPath).size;
  const checksum = calculateChecksum(serialized);

  // Insert into database
  db.prepare(
    `INSERT INTO models (
      id, entity_type, entity_code, is_group_model,
      model_type, version, trained_at,
      training_start, training_end,
      mape, is_active, is_archived,
      file_path, file_size, checksum,
      created_by, notes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    'calibration',
    'cfac_scaling',
    1, // is_group_model
    'scaling',
    version,
    timestamp,
    calibration.calibrationPeriod.start,
    calibration.calibrationPeriod.end,
    calibration.demandMape || null,
    0, // is_active (calibrations don't have active status)
    0, // is_archived
    filePath,
    fileSize,
    checksum,
    createdBy,
    notes || `Calibration: Wind ${((calibration.windScale - 1) * 100).toFixed(1)}%, Solar ${((calibration.solarScale - 1) * 100).toFixed(1)}%`
  );

  console.log(`Saved calibration v${version} to model store: ${id}`);
  return id;
}

/**
 * Get a calibration by ID
 */
export function getCalibrationById(id: string): CalibrationData | null {
  const db = getDatabase();

  const row = db.prepare(
    `SELECT * FROM models WHERE id = ? AND entity_type = 'calibration'`
  ).get(id) as ModelRegistry | undefined;

  if (!row) {
    return null;
  }

  // Load and deserialize
  const fullPath = path.join(PROJECT_ROOT, row.file_path);
  if (!fs.existsSync(fullPath)) {
    throw new Error(`Calibration file not found: ${fullPath}`);
  }

  const data = fs.readFileSync(fullPath);
  const savedModel = deserialize(data);
  return savedModel.modelData.data as CalibrationData;
}

/**
 * Get most recent calibration
 */
export function getMostRecentCalibration(): CalibrationData | null {
  const db = getDatabase();

  const row = db.prepare(
    `SELECT * FROM models
     WHERE entity_type = 'calibration' AND entity_code = 'cfac_scaling' AND is_archived = 0
     ORDER BY trained_at DESC
     LIMIT 1`
  ).get() as ModelRegistry | undefined;

  if (!row) {
    return null;
  }

  return getCalibrationById(row.id);
}

/**
 * Set a model as the active model for the scheduler
 * Deactivates any other model of the same entity type
 */
export function setSchedulerActiveModel(modelId: string): void {
  const db = getDatabase();

  // Get the model's entity type
  const model = db
    .prepare('SELECT entity_type FROM models WHERE id = ?')
    .get(modelId) as { entity_type: string } | undefined;

  if (!model) {
    throw new Error(`Model not found: ${modelId}`);
  }

  // Deactivate all models of this entity type for scheduler
  db.prepare(
    `UPDATE models SET is_scheduler_active = 0 WHERE entity_type = ?`
  ).run(model.entity_type);

  // Activate the specified model for scheduler
  db.prepare(
    `UPDATE models SET is_scheduler_active = 1 WHERE id = ?`
  ).run(modelId);

  console.log(`Model ${modelId} set as scheduler active for ${model.entity_type}`);
}

/**
 * Set a model as the active model for manual forecasts
 */
export function setManualActiveModel(modelId: string): void {
  const db = getDatabase();

  const model = db
    .prepare('SELECT entity_type FROM models WHERE id = ?')
    .get(modelId) as { entity_type: string } | undefined;

  if (!model) {
    throw new Error(`Model not found: ${modelId}`);
  }

  // Deactivate all models of this entity type for manual
  db.prepare(
    `UPDATE models SET is_manual_active = 0 WHERE entity_type = ?`
  ).run(model.entity_type);

  // Activate the specified model for manual
  db.prepare(
    `UPDATE models SET is_manual_active = 1 WHERE id = ?`
  ).run(modelId);

  console.log(`Model ${modelId} set as manual active for ${model.entity_type}`);
}

/**
 * Record model usage (updates last_used_at and increments usage_count)
 */
export function recordModelUsage(modelId: string): void {
  const db = getDatabase();

  db.prepare(
    `UPDATE models
     SET last_used_at = ?, usage_count = COALESCE(usage_count, 0) + 1
     WHERE id = ?`
  ).run(new Date().toISOString(), modelId);
}

/**
 * Get the scheduler active model for an entity type
 */
export function getSchedulerActiveModel(entityType: EntityType): SavedModel | null {
  const db = getDatabase();

  const row = db
    .prepare(
      `SELECT * FROM models
       WHERE entity_type = ? AND is_scheduler_active = 1
       LIMIT 1`
    )
    .get(entityType) as ModelRegistry | undefined;

  if (!row) {
    return null;
  }

  return loadModelFromRegistry(row);
}
