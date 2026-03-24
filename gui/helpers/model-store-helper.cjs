/**
 * Model Store Helper
 *
 * Standalone script to interact with model registry database from Electron main process.
 * Avoids NODE_MODULE_VERSION mismatch by running in a separate Node process.
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// Get project root (two levels up from gui/helpers)
const projectRoot = path.resolve(__dirname, '../..');
const modelsDir = path.join(projectRoot, 'models');
const registryDb = path.join(modelsDir, 'registry.db');

function getDatabase() {
  const Database = require('better-sqlite3');

  // Ensure models directory exists
  if (!fs.existsSync(modelsDir)) {
    fs.mkdirSync(modelsDir, { recursive: true });
  }

  const db = new Database(registryDb);
  db.pragma('journal_mode = WAL');

  // Create models table if not exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS models (
      id TEXT PRIMARY KEY,
      entity_type TEXT NOT NULL,
      entity_code TEXT NOT NULL,
      is_group_model INTEGER DEFAULT 0,
      model_type TEXT NOT NULL,
      model_config TEXT,
      version INTEGER NOT NULL,
      trained_at TEXT NOT NULL,
      training_start TEXT,
      training_end TEXT,
      training_records INTEGER,
      holdout_days INTEGER,
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
      per_zone_mape TEXT,
      per_region_mape TEXT,
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
      is_active INTEGER DEFAULT 0,
      is_archived INTEGER DEFAULT 0,
      file_path TEXT NOT NULL,
      file_size INTEGER,
      checksum TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      created_by TEXT,
      notes TEXT,
      is_scheduler_active INTEGER DEFAULT 0,
      is_manual_active INTEGER DEFAULT 0,
      last_used_at TEXT,
      usage_count INTEGER DEFAULT 0
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
    { name: 'calibration_json', type: 'TEXT' },
    { name: 'is_scheduler_active', type: 'INTEGER DEFAULT 0' },
    { name: 'is_manual_active', type: 'INTEGER DEFAULT 0' },
    { name: 'last_used_at', type: 'TEXT' },
    { name: 'usage_count', type: 'INTEGER DEFAULT 0' },
  ];

  // Get existing columns
  const existingColumns = db.prepare("PRAGMA table_info(models)").all().map(c => c.name);

  // Add missing columns
  for (const col of migrateColumns) {
    if (!existingColumns.includes(col.name)) {
      try {
        db.exec(`ALTER TABLE models ADD COLUMN ${col.name} ${col.type}`);
        console.log(`  Migration: Added column ${col.name}`);
      } catch (err) {
        // Column might already exist, ignore
      }
    }
  }

  return db;
}

function saveTrainedModel(options) {
  const db = getDatabase();

  try {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    // Get next version for this entity
    const existingVersions = db
      .prepare(`SELECT MAX(version) as max_version FROM models WHERE entity_type = ? AND entity_code = ?`)
      .get(options.entityType, options.entityCode);

    const version = ((existingVersions?.max_version) || 0) + 1;

    // Create file path for the model data
    const sanitizedName = options.name.replace(/[^a-z0-9_-]/gi, '_').toLowerCase();
    const entityDir = path.join(modelsDir, 'manual', options.entityType);
    if (!fs.existsSync(entityDir)) {
      fs.mkdirSync(entityDir, { recursive: true });
    }

    const filename = `v${String(version).padStart(3, '0')}_${now.split('T')[0]}_${sanitizedName}.json`;
    const relativeFilePath = path.join('models', 'manual', options.entityType, filename);
    const fullPath = path.join(projectRoot, relativeFilePath);

    // Save model data to JSON file
    const modelRecord = {
      id,
      name: options.name,
      notes: options.notes,
      entityType: options.entityType,
      entityCode: options.entityCode,
      version,
      createdAt: now,
      isActive: false,
      ...options.modelData
    };

    fs.writeFileSync(fullPath, JSON.stringify(modelRecord, null, 2));
    const fileSize = fs.statSync(fullPath).size;

    // Extract training period from modelData if available
    const trainingStart = options.modelData?.forecastConfig?.forecastStart || null;
    const trainingEnd = options.modelData?.forecastConfig?.forecastEnd || null;

    // Insert into database
    const stmt = db.prepare(`
      INSERT INTO models (
        id, entity_type, entity_code, is_group_model,
        model_type, version, trained_at,
        training_start, training_end,
        is_active, is_archived,
        file_path, file_size,
        created_by, notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    // Save name as notes (notes field stores the user-provided name)
    const notesValue = options.name || options.notes || null;

    stmt.run(
      id,
      options.entityType,
      options.entityCode,
      0, // is_group_model
      'manual', // model_type
      version,
      now, // trained_at
      trainingStart,
      trainingEnd,
      0, // is_active
      0, // is_archived
      relativeFilePath,
      fileSize,
      'gui', // created_by
      notesValue
    );

    db.close();

    return { success: true, id, path: fullPath };
  } catch (error) {
    db.close();
    throw error;
  }
}

function getTrainingInstances() {
  // If database doesn't exist, return empty array
  if (!fs.existsSync(registryDb)) {
    return [];
  }

  const db = getDatabase();

  try {
    // Get all non-archived REAL models (with actual weights and MAPE)
    // Excludes placeholder GUI-only entries (entity_type='forecast', model_type='manual')
    const models = db.prepare(`
      SELECT * FROM models
      WHERE is_archived = 0
        AND mape IS NOT NULL
        AND entity_type IN ('regional', 'zonal', 'wind', 'solar', 'hydro', 'biomass', 'geothermal', 'battery')
      ORDER BY entity_type, trained_at DESC
    `).all();

    db.close();

    // Group by entity_type and 5-minute time windows
    const instanceMap = new Map();

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
      instanceMap.get(key).push(model);
    }

    // Convert to TrainingInstance array
    const instances = [];

    for (const [key, groupModels] of instanceMap) {
      const [entityType, trainedAt] = key.split('|');

      // Calculate aggregate metrics
      const mapeValues = groupModels.filter(m => m.mape != null).map(m => m.mape);
      const avgMape = mapeValues.length > 0
        ? mapeValues.reduce((a, b) => a + b, 0) / mapeValues.length
        : null;
      const minMape = mapeValues.length > 0 ? Math.min(...mapeValues) : null;
      const maxMape = mapeValues.length > 0 ? Math.max(...mapeValues) : null;

      // Aggregate peak/off-peak metrics
      const peakMapeValues = groupModels.filter(m => m.peak_mape != null).map(m => m.peak_mape);
      const avgPeakMape = peakMapeValues.length > 0
        ? peakMapeValues.reduce((a, b) => a + b, 0) / peakMapeValues.length
        : null;
      const offpeakMapeValues = groupModels.filter(m => m.offpeak_mape != null).map(m => m.offpeak_mape);
      const avgOffpeakMape = offpeakMapeValues.length > 0
        ? offpeakMapeValues.reduce((a, b) => a + b, 0) / offpeakMapeValues.length
        : null;

      // Aggregate day type metrics
      const weekdayMapeValues = groupModels.filter(m => m.weekday_mape != null).map(m => m.weekday_mape);
      const avgWeekdayMape = weekdayMapeValues.length > 0
        ? weekdayMapeValues.reduce((a, b) => a + b, 0) / weekdayMapeValues.length
        : null;
      const weekendMapeValues = groupModels.filter(m => m.weekend_mape != null).map(m => m.weekend_mape);
      const avgWeekendMape = weekendMapeValues.length > 0
        ? weekendMapeValues.reduce((a, b) => a + b, 0) / weekendMapeValues.length
        : null;
      const holidayMapeValues = groupModels.filter(m => m.holiday_mape != null).map(m => m.holiday_mape);
      const avgHolidayMape = holidayMapeValues.length > 0
        ? holidayMapeValues.reduce((a, b) => a + b, 0) / holidayMapeValues.length
        : null;

      // Get training period from first model
      const trainingPeriod = groupModels[0].training_start && groupModels[0].training_end
        ? { start: groupModels[0].training_start, end: groupModels[0].training_end }
        : null;

      // Extract calibration info from first model (all models in same instance share calibration)
      const firstModel = groupModels[0];
      let calibration = null;

      if (firstModel.calibration_mode) {
        // Demand model calibration (pass1/pass2 structure)
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
      } else if (firstModel.calibration_json) {
        // CFAC model calibration (wind/solar - JSON structure)
        try {
          calibration = JSON.parse(firstModel.calibration_json);
        } catch (e) {
          // Ignore parse errors
        }
      }

      // Check if any model in this instance is scheduler/manual active
      const isSchedulerActive = groupModels.some(m => m.is_scheduler_active === 1);
      const isManualActive = groupModels.some(m => m.is_manual_active === 1);

      // Get name from first model's notes, or generate a default
      const firstModelNotes = groupModels[0]?.notes;
      const trainedDate = new Date(trainedAt);
      const defaultName = `${entityType} ${trainedDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
      const name = firstModelNotes || defaultName;

      // Parse per-zone/region MAPE from first model (stored at instance level)
      let perZoneMape = null;
      let perRegionMape = null;
      if (firstModel.per_zone_mape) {
        try {
          perZoneMape = JSON.parse(firstModel.per_zone_mape);
        } catch (e) { /* ignore parse errors */ }
      }
      if (firstModel.per_region_mape) {
        try {
          perRegionMape = JSON.parse(firstModel.per_region_mape);
        } catch (e) { /* ignore parse errors */ }
      }

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
        // Peak/Off-Peak breakdown
        avgPeakMape,
        avgOffpeakMape,
        // Day Type breakdown
        avgWeekdayMape,
        avgWeekendMape,
        avgHolidayMape,
        // Per-zone/region breakdown (from JSON columns)
        perZoneMape,
        perRegionMape,
        trainingPeriod,
        calibration,
        isSchedulerActive,
        isManualActive,
        models: groupModels.sort((a, b) => a.entity_code.localeCompare(b.entity_code)),
      });
    }

    // Sort by trained_at descending
    return instances.sort((a, b) => new Date(b.trainedAt).getTime() - new Date(a.trainedAt).getTime());
  } catch (error) {
    db.close();
    throw error;
  }
}

function setSchedulerActive(modelId) {
  const db = getDatabase();

  try {
    const model = db.prepare('SELECT entity_type FROM models WHERE id = ?').get(modelId);
    if (!model) {
      throw new Error(`Model not found: ${modelId}`);
    }

    // Deactivate all of same type
    db.prepare('UPDATE models SET is_scheduler_active = 0 WHERE entity_type = ?').run(model.entity_type);

    // Activate this one
    db.prepare('UPDATE models SET is_scheduler_active = 1 WHERE id = ?').run(modelId);

    db.close();
    return { success: true };
  } catch (error) {
    db.close();
    throw error;
  }
}

function setManualActive(modelId) {
  const db = getDatabase();

  try {
    const model = db.prepare('SELECT entity_type FROM models WHERE id = ?').get(modelId);
    if (!model) {
      throw new Error(`Model not found: ${modelId}`);
    }

    db.prepare('UPDATE models SET is_manual_active = 0 WHERE entity_type = ?').run(model.entity_type);
    db.prepare('UPDATE models SET is_manual_active = 1 WHERE id = ?').run(modelId);

    db.close();
    return { success: true };
  } catch (error) {
    db.close();
    throw error;
  }
}

function getModelById(modelId) {
  if (!fs.existsSync(registryDb)) {
    return { success: false, error: 'Database not found' };
  }

  const db = getDatabase();

  try {
    const model = db.prepare('SELECT * FROM models WHERE id = ?').get(modelId);
    db.close();

    if (!model) {
      return { success: false, error: `Model not found: ${modelId}` };
    }

    return {
      success: true,
      model: {
        id: model.id,
        entityType: model.entity_type,
        entityCode: model.entity_code,
        modelType: model.model_type,
        version: model.version,
        trainedAt: model.trained_at,
        trainingStart: model.training_start,
        trainingEnd: model.training_end,
        mape: model.mape,
        rmse: model.rmse,
        mae: model.mae,
        peakMape: model.peak_mape,
        offpeakMape: model.offpeak_mape,
        weekdayMape: model.weekday_mape,
        weekendMape: model.weekend_mape,
        holidayMape: model.holiday_mape,
        isActive: model.is_active === 1,
        isSchedulerActive: model.is_scheduler_active === 1,
        isManualActive: model.is_manual_active === 1,
        filePath: model.file_path,
        notes: model.notes
      }
    };
  } catch (error) {
    db.close();
    return { success: false, error: error.message };
  }
}

async function main() {
  const method = process.argv[2];
  const args = process.argv.slice(3).map(arg => {
    try {
      return JSON.parse(arg);
    } catch {
      return arg;
    }
  });

  let result;

  switch (method) {
    case 'save':
      result = saveTrainedModel(args[0]);
      break;
    case 'getInstances':
      result = getTrainingInstances();
      break;
    case 'setSchedulerActive':
      result = setSchedulerActive(args[0]);
      break;
    case 'setManualActive':
      result = setManualActive(args[0]);
      break;
    case 'get':
      result = getModelById(args[0]?.id || args[0]);
      break;
    default:
      throw new Error(`Unknown method: ${method}`);
  }

  // Output result as JSON
  console.log(JSON.stringify(result));
}

main().catch(err => {
  console.error(JSON.stringify({ success: false, error: err.message }));
  process.exit(1);
});
