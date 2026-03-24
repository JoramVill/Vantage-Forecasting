/**
 * Training Instance Service
 *
 * Manages training instance tracking - links training runs to model results,
 * stores detailed metrics, and provides instance history.
 *
 * Part of Model Workflow Vision - Phase C
 */

import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Paths
const PROJECT_ROOT = path.resolve(__dirname, '../../');
const MODELS_DIR = path.join(PROJECT_ROOT, 'models');
const REGISTRY_DB = path.join(MODELS_DIR, 'registry.db');

/**
 * Model summary for a single entity
 */
export interface ModelSummary {
  entityCode: string;
  modelId: string;
  modelType: string;
  mape: number;
  mae: number;
  rmse: number;
  isActive: boolean;
  scalingApplied?: number;
  calibrationIterations?: number;
}

/**
 * Training instance - result of running a training plan
 */
export interface TrainingInstance {
  id: string;
  templateId?: string;
  templateName?: string;
  startedAt: string;
  completedAt?: string;
  status: 'running' | 'completed' | 'failed' | 'partial';
  errorMessage?: string;
  dateRangeStart?: string;
  dateRangeEnd?: string;
  demandRegionalSummary?: ModelSummary[];
  demandZonalSummary?: ModelSummary[];
  cfacSummary?: Record<string, ModelSummary[]>;
  demandRegionalMape?: number;
  demandZonalMape?: number;
  cfacWindMape?: number;
  cfacSolarMape?: number;
  appliedOverrides?: any;
  // Link to CFAC calibration generated during this training
  cfacCalibrationId?: string;
}

/**
 * Aggregate metrics for completion
 */
export interface AggregateMetrics {
  demandRegionalMape?: number;
  demandZonalMape?: number;
  cfacWindMape?: number;
  cfacSolarMape?: number;
}

/**
 * Training Instance Service
 */
export class TrainingInstanceService {
  private db: Database.Database;

  constructor(dbPath?: string) {
    const path = dbPath || REGISTRY_DB;

    // Ensure models directory exists
    const dir = dirname(path);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
  }

  /**
   * Start a new training instance (before training begins)
   */
  startInstance(templateId?: string, templateName?: string): string {
    const id = uuidv4();
    const startedAt = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO training_instances (
          id, template_id, template_name, started_at, status
        ) VALUES (?, ?, ?, ?, 'running')`
      )
      .run(id, templateId || null, templateName || null, startedAt);

    console.log(`Training instance started: ${id}`);
    if (templateName) {
      console.log(`  Template: ${templateName}`);
    }

    return id;
  }

  /**
   * Update instance with date range (after resolving rolling dates)
   */
  setDateRange(id: string, start: string, end: string): void {
    this.db
      .prepare(
        `UPDATE training_instances
         SET date_range_start = ?, date_range_end = ?
         WHERE id = ?`
      )
      .run(start, end, id);

    console.log(`Training instance ${id}: Date range set to ${start} - ${end}`);
  }

  /**
   * Add model summary as training progresses
   */
  addModelSummary(
    id: string,
    category: 'demandRegional' | 'demandZonal' | 'cfac',
    summary: ModelSummary,
    cfacType?: string
  ): void {
    // Get current instance
    const instance = this.getInstance(id);
    if (!instance) {
      throw new Error(`Training instance not found: ${id}`);
    }

    // Update the appropriate summary array
    if (category === 'demandRegional') {
      const summaries = instance.demandRegionalSummary || [];
      summaries.push(summary);

      this.db
        .prepare(
          `UPDATE training_instances
           SET demand_regional_summary = ?
           WHERE id = ?`
        )
        .run(JSON.stringify(summaries), id);
    } else if (category === 'demandZonal') {
      const summaries = instance.demandZonalSummary || [];
      summaries.push(summary);

      this.db
        .prepare(
          `UPDATE training_instances
           SET demand_zonal_summary = ?
           WHERE id = ?`
        )
        .run(JSON.stringify(summaries), id);
    } else if (category === 'cfac') {
      if (!cfacType) {
        throw new Error('cfacType is required for CFAC summaries');
      }

      const cfacSummary = instance.cfacSummary || {};
      if (!cfacSummary[cfacType]) {
        cfacSummary[cfacType] = [];
      }
      cfacSummary[cfacType].push(summary);

      this.db
        .prepare(
          `UPDATE training_instances
           SET cfac_summary = ?
           WHERE id = ?`
        )
        .run(JSON.stringify(cfacSummary), id);
    }

    console.log(
      `Training instance ${id}: Added ${category}${cfacType ? `/${cfacType}` : ''} model ${summary.entityCode}`
    );
  }

  /**
   * Complete instance (set status, final metrics)
   */
  completeInstance(id: string, metrics: AggregateMetrics): void {
    this.db
      .prepare(
        `UPDATE training_instances
         SET status = 'completed',
             completed_at = ?,
             demand_regional_mape = ?,
             demand_zonal_mape = ?,
             cfac_wind_mape = ?,
             cfac_solar_mape = ?
         WHERE id = ?`
      )
      .run(
        new Date().toISOString(),
        metrics.demandRegionalMape || null,
        metrics.demandZonalMape || null,
        metrics.cfacWindMape || null,
        metrics.cfacSolarMape || null,
        id
      );

    console.log(`Training instance ${id}: Completed`);
    if (metrics.demandRegionalMape !== undefined) {
      console.log(`  Regional MAPE: ${metrics.demandRegionalMape.toFixed(2)}%`);
    }
    if (metrics.demandZonalMape !== undefined) {
      console.log(`  Zonal MAPE: ${metrics.demandZonalMape.toFixed(2)}%`);
    }
  }

  /**
   * Mark instance as failed
   */
  failInstance(id: string, errorMessage: string): void {
    this.db
      .prepare(
        `UPDATE training_instances
         SET status = 'failed',
             completed_at = ?,
             error_message = ?
         WHERE id = ?`
      )
      .run(new Date().toISOString(), errorMessage, id);

    console.error(`Training instance ${id}: Failed - ${errorMessage}`);
  }

  /**
   * Mark instance as partial (some models succeeded, some failed)
   */
  markPartial(id: string, errorMessage: string): void {
    this.db
      .prepare(
        `UPDATE training_instances
         SET status = 'partial',
             error_message = ?
         WHERE id = ?`
      )
      .run(errorMessage, id);

    console.warn(`Training instance ${id}: Partial completion - ${errorMessage}`);
  }

  /**
   * Set applied overrides (JSON)
   */
  setAppliedOverrides(id: string, overrides: any): void {
    this.db
      .prepare(
        `UPDATE training_instances
         SET applied_overrides_json = ?
         WHERE id = ?`
      )
      .run(JSON.stringify(overrides), id);
  }

  /**
   * Set CFAC calibration ID (link to generated calibration)
   */
  setCfacCalibrationId(id: string, calibrationId: string): void {
    this.db
      .prepare(
        `UPDATE training_instances
         SET cfac_calibration_id = ?
         WHERE id = ?`
      )
      .run(calibrationId, id);
    console.log(`Training instance ${id}: CFAC calibration set to ${calibrationId}`);
  }

  /**
   * Get instance by ID
   */
  getInstance(id: string): TrainingInstance | null {
    const row = this.db
      .prepare('SELECT * FROM training_instances WHERE id = ?')
      .get(id) as any;

    if (!row) {
      return null;
    }

    return this.rowToInstance(row);
  }

  /**
   * List recent instances
   */
  listInstances(limit: number = 50): TrainingInstance[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM training_instances
         ORDER BY started_at DESC
         LIMIT ?`
      )
      .all(limit) as any[];

    return rows.map((row) => this.rowToInstance(row));
  }

  /**
   * Get instances by template
   */
  getInstancesByTemplate(templateId: string): TrainingInstance[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM training_instances
         WHERE template_id = ?
         ORDER BY started_at DESC`
      )
      .all(templateId) as any[];

    return rows.map((row) => this.rowToInstance(row));
  }

  /**
   * Delete instance
   */
  deleteInstance(id: string): boolean {
    const result = this.db.prepare('DELETE FROM training_instances WHERE id = ?').run(id);

    if (result.changes > 0) {
      console.log(`Training instance deleted: ${id}`);
      return true;
    }

    return false;
  }

  /**
   * Convert database row to TrainingInstance
   */
  private rowToInstance(row: any): TrainingInstance {
    return {
      id: row.id,
      templateId: row.template_id,
      templateName: row.template_name,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      status: row.status,
      errorMessage: row.error_message,
      dateRangeStart: row.date_range_start,
      dateRangeEnd: row.date_range_end,
      demandRegionalSummary: row.demand_regional_summary
        ? JSON.parse(row.demand_regional_summary)
        : undefined,
      demandZonalSummary: row.demand_zonal_summary
        ? JSON.parse(row.demand_zonal_summary)
        : undefined,
      cfacSummary: row.cfac_summary ? JSON.parse(row.cfac_summary) : undefined,
      demandRegionalMape: row.demand_regional_mape,
      demandZonalMape: row.demand_zonal_mape,
      cfacWindMape: row.cfac_wind_mape,
      cfacSolarMape: row.cfac_solar_mape,
      appliedOverrides: row.applied_overrides_json
        ? JSON.parse(row.applied_overrides_json)
        : undefined,
      cfacCalibrationId: row.cfac_calibration_id,
    };
  }

  /**
   * Close database connection
   */
  close(): void {
    this.db.close();
  }
}

/**
 * Singleton instance
 */
let instance: TrainingInstanceService | null = null;

/**
 * Get the singleton instance
 */
export function getTrainingInstanceService(): TrainingInstanceService {
  if (!instance) {
    instance = new TrainingInstanceService();
  }
  return instance;
}

/**
 * Close singleton instance
 */
export function closeTrainingInstanceService(): void {
  if (instance) {
    instance.close();
    instance = null;
  }
}

// Convenience export
export const trainingInstanceService = {
  getInstance: () => getTrainingInstanceService(),
  close: closeTrainingInstanceService,
};
