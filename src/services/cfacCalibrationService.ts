/**
 * CFAC Calibration Service
 *
 * Manages CFAC calibration state storage and retrieval.
 * Calibration state includes scale factors, MREC coefficients, and bias corrections.
 *
 * Storage format:
 * - models/cfac-calibration/calibration_{id}.json - Full calibration state
 * - models/cfac-calibration/active.json - Reference to active calibration ID
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import {
  CFACCalibrationState,
  CalibrationSummary,
} from '../types/cfacCalibration.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PROJECT_ROOT = path.resolve(__dirname, '../../');

export class CFACCalibrationService {
  private calibrationDir: string;

  constructor(calibrationDir: string = 'models/cfac-calibration') {
    this.calibrationDir = path.isAbsolute(calibrationDir)
      ? calibrationDir
      : path.join(PROJECT_ROOT, calibrationDir);
  }

  /**
   * Ensure calibration directory exists
   */
  private ensureDir(): void {
    if (!fs.existsSync(this.calibrationDir)) {
      fs.mkdirSync(this.calibrationDir, { recursive: true });
    }
  }

  /**
   * Generate unique calibration ID
   * Format: cfac-cal-YYYY-MM-DD-HHmmss
   */
  private generateId(): string {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');
    return `cfac-cal-${year}-${month}-${day}-${hours}${minutes}${seconds}`;
  }

  /**
   * Save calibration state to JSON file
   */
  saveCalibration(state: CFACCalibrationState): string {
    this.ensureDir();

    // Generate ID if not provided
    if (!state.id) {
      state.id = this.generateId();
    }

    // Set createdAt if not provided
    if (!state.createdAt) {
      state.createdAt = new Date().toISOString();
    }

    const filename = `calibration_${state.id}.json`;
    const filePath = path.join(this.calibrationDir, filename);

    // Write calibration state to file
    fs.writeFileSync(filePath, JSON.stringify(state, null, 2), 'utf-8');

    console.log(`Saved CFAC calibration: ${state.id}`);
    console.log(`  File: ${filePath}`);
    console.log(`  Wind MAPE: ${state.trainingMetrics.windMAPE.toFixed(2)}%`);
    console.log(`  Solar MAPE: ${state.trainingMetrics.solarMAPE.toFixed(2)}%`);

    return state.id;
  }

  /**
   * Load calibration by ID
   */
  loadCalibration(id: string): CFACCalibrationState | null {
    const filename = `calibration_${id}.json`;
    const filePath = path.join(this.calibrationDir, filename);

    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      return JSON.parse(content) as CFACCalibrationState;
    } catch (error) {
      // File not found or parse error
      return null;
    }
  }

  /**
   * Get all saved calibrations (sorted by date, newest first)
   */
  listCalibrations(): CalibrationSummary[] {
    try {
      this.ensureDir();

      // Read all files in directory
      const files = fs.readdirSync(this.calibrationDir);

      // Filter for calibration files (not active.json)
      const calibrationFiles = files.filter(
        (f) => f.startsWith('calibration_') && f.endsWith('.json')
      );

      // Load summaries
      const summaries: CalibrationSummary[] = [];

      // Get active calibration ID
      const activeId = this.getActiveCalibrationId();

      for (const file of calibrationFiles) {
        const filePath = path.join(this.calibrationDir, file);
        try {
          const content = fs.readFileSync(filePath, 'utf-8');
          const state = JSON.parse(content) as CFACCalibrationState;

          summaries.push({
            id: state.id,
            createdAt: state.createdAt,
            trainingStart: state.trainingPeriod.start,
            trainingEnd: state.trainingPeriod.end,
            windMAPE: state.trainingMetrics.windMAPE,
            solarMAPE: state.trainingMetrics.solarMAPE,
            stationCount: state.trainingMetrics.stationCount,
            isActive: state.id === activeId,
          });
        } catch (error) {
          console.warn(`Failed to load calibration file: ${file}`, error);
        }
      }

      // Sort by creation date (newest first)
      summaries.sort((a, b) => {
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      });

      return summaries;
    } catch (error) {
      // Directory doesn't exist or can't be read
      return [];
    }
  }

  /**
   * Get active calibration ID from active.json
   */
  private getActiveCalibrationId(): string | null {
    const activePath = path.join(this.calibrationDir, 'active.json');

    try {
      const content = fs.readFileSync(activePath, 'utf-8');
      const data = JSON.parse(content);
      return data.activeCalibrationId || null;
    } catch {
      return null;
    }
  }

  /**
   * Set active calibration (store reference in active.json)
   */
  setActiveCalibration(id: string): void {
    this.ensureDir();

    // Verify calibration exists
    const calibration = this.loadCalibration(id);
    if (!calibration) {
      throw new Error(`Calibration not found: ${id}`);
    }

    const activePath = path.join(this.calibrationDir, 'active.json');
    const activeData = {
      activeCalibrationId: id,
      setAt: new Date().toISOString(),
    };

    fs.writeFileSync(activePath, JSON.stringify(activeData, null, 2), 'utf-8');

    console.log(`Set active CFAC calibration: ${id}`);
  }

  /**
   * Get currently active calibration
   */
  getActiveCalibration(): CFACCalibrationState | null {
    const activeId = this.getActiveCalibrationId();
    if (!activeId) {
      return null;
    }

    return this.loadCalibration(activeId);
  }

  /**
   * Delete calibration by ID
   */
  deleteCalibration(id: string): boolean {
    const filename = `calibration_${id}.json`;
    const filePath = path.join(this.calibrationDir, filename);

    try {
      fs.unlinkSync(filePath);
      console.log(`Deleted CFAC calibration: ${id}`);

      // If this was the active calibration, clear active.json
      const activeId = this.getActiveCalibrationId();
      if (activeId === id) {
        const activePath = path.join(this.calibrationDir, 'active.json');
        try {
          fs.unlinkSync(activePath);
        } catch {
          // Ignore error if active.json doesn't exist
        }
      }

      return true;
    } catch {
      return false;
    }
  }

  /**
   * Prune old calibrations (keep only recent N days)
   */
  pruneCalibrations(keepDays: number = 30): number {
    const calibrations = this.listCalibrations();
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - keepDays);

    let deletedCount = 0;

    for (const cal of calibrations) {
      const createdDate = new Date(cal.createdAt);
      if (createdDate < cutoffDate && !cal.isActive) {
        const deleted = this.deleteCalibration(cal.id);
        if (deleted) {
          deletedCount++;
        }
      }
    }

    if (deletedCount > 0) {
      console.log(`Pruned ${deletedCount} old calibration(s)`);
    }

    return deletedCount;
  }
}
