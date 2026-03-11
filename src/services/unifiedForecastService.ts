/**
 * Unified Forecast Service
 *
 * Single entry point for all forecast generation (Manual, Scheduler, Backfill).
 * Integrates global configuration, System B calibration, and proven forecast models.
 *
 * Phase 2 of Unified Forecast System Plan.
 * @see Documents/planning/UNIFIED_FORECAST_SYSTEM_PLAN.md Section 7 (Phase 2)
 */

import { DateTime } from 'luxon';
import Database from 'better-sqlite3';
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { parse } from 'csv-parse/sync';
import { spawn } from 'child_process';
import { getConfigService, ConfigService } from './configService.js';
import type { GlobalForecastConfig } from '../types/config.js';
import { pushFileToGateway, isGatewayEnabled, type ForecastCategory } from './sftpPushService.js';

// ═══════════════════════════════════════════════════════════════════════════
// Request and Result Types
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Request to generate forecasts
 */
export interface ForecastRequest {
  /** Start date (YYYY-MM-DD) */
  startDate: string;
  /** End date (YYYY-MM-DD) */
  endDate: string;
  /** Forecast types to generate */
  types: ('demand' | 'cfac')[];
  /** Horizons to generate (daily = D+1, weekly = D+7) */
  horizons: ('daily' | 'weekly')[];
  /** Override output directory */
  outputDir?: string;
  /** As-of date for archiving (defaults to today) */
  asOfDate?: string;

  // Per-run overrides
  /** Skip calibration for this run */
  noCalibrate?: boolean;
  /** Override: Use XGBoost for CFAC ML layer */
  useXgboost?: boolean;
  /** Override: Use asymmetric loss for CFAC */
  asymmetricLoss?: boolean;
  /** Override: Use bias correction for CFAC */
  biasCorrection?: boolean;
  /** Override: Use zonal mode for demand (14 zones) */
  zonal?: boolean;
  /** Override: Force weather refresh */
  refreshWeather?: boolean;
}

/**
 * Calibration result from System B iterative calibration
 */
export interface CalibrationResult {
  /** Wind scaling factor (percentage, e.g., 5 = +5%) */
  windScale: number;
  /** Solar scaling factor (percentage) */
  solarScale: number;
  /** Wind deviation from actuals (percentage) */
  windDeviation: number;
  /** Solar deviation from actuals (percentage) */
  solarDeviation: number;
  /** Demand MAPE (percentage) */
  demandMape: number;
  /** Peak hours deviation (percentage, positive = under-forecast) */
  demandPeakDeviation: number;
  /** Off-peak hours deviation (percentage) */
  demandOffpeakDeviation: number;
  /** Peak hours scaling factor (percentage) */
  demandPeakScale: number;
  /** Off-peak hours scaling factor (percentage) */
  demandOffpeakScale: number;
  /** CFAC calibration period */
  calibrationPeriod: { start: string; end: string };
  /** Demand calibration period (may differ from CFAC) */
  demandCalibrationPeriod?: { start: string; end: string };
  /** Whether calibration converged within threshold */
  withinThreshold: boolean;
  /** Per-station calibration scales (station code -> scale factor, e.g., 1.05 = +5%) */
  stationScales: Record<string, number>;
  /** Number of iterations to converge */
  iterations: number;
}

/**
 * Result of forecast generation
 */
export interface ForecastResult {
  /** Generated files with paths */
  files: {
    type: 'demand' | 'cfac';
    horizon: 'daily' | 'weekly';
    path: string;
    archived?: string;
    pushedToGateway?: boolean;
  }[];
  /** Calibration result (if calibration was run) */
  calibration?: CalibrationResult;
  /** Execution time in milliseconds */
  durationMs: number;
  /** Any warnings or issues */
  warnings: string[];
}

// ═══════════════════════════════════════════════════════════════════════════
// Unified Forecast Service
// ═══════════════════════════════════════════════════════════════════════════

export class UnifiedForecastService {
  private config: GlobalForecastConfig;
  private configService: ConfigService;
  private db: Database.Database;

  constructor(configPath?: string, dbPath?: string) {
    this.configService = getConfigService(configPath);
    this.config = this.configService.get();

    // Initialize database for calibration history and forecast runs
    const dbFile = dbPath || this.config.databases.scheduler;
    this.db = new Database(dbFile);
    this.initDatabase();
  }

  /**
   * Initialize database schema
   */
  private initDatabase(): void {
    // Calibration history table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS calibration_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        calibration_date TEXT NOT NULL,
        calibration_start TEXT NOT NULL,
        calibration_end TEXT NOT NULL,
        wind_scale REAL NOT NULL,
        solar_scale REAL NOT NULL,
        wind_deviation REAL NOT NULL,
        solar_deviation REAL NOT NULL,
        demand_mape REAL NOT NULL,
        demand_peak_deviation REAL NOT NULL,
        demand_offpeak_deviation REAL NOT NULL,
        demand_peak_scale REAL NOT NULL,
        demand_offpeak_scale REAL NOT NULL,
        within_threshold INTEGER NOT NULL,
        iterations INTEGER NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);

    // Forecast runs table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS forecast_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_date TEXT NOT NULL,
        run_time TEXT NOT NULL,
        forecast_type TEXT NOT NULL,
        horizon TEXT NOT NULL,
        forecast_start TEXT NOT NULL,
        forecast_end TEXT NOT NULL,
        model_used TEXT,
        status TEXT NOT NULL,
        records_generated INTEGER,
        duration_ms INTEGER,
        output_file TEXT,
        error_message TEXT,
        scale_wind REAL,
        scale_solar REAL,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);
  }

  /**
   * Generate forecasts based on request
   * This is the single entry point for all forecast generation
   */
  async generateForecast(request: ForecastRequest): Promise<ForecastResult> {
    const startTime = Date.now();
    const result: ForecastResult = {
      files: [],
      durationMs: 0,
      warnings: []
    };

    const asOfDate = request.asOfDate || DateTime.now().toISODate()!;

    // Step 1: Run calibration if enabled and not skipped
    let calibration: CalibrationResult | undefined;
    if (this.config.calibration.enabled && !request.noCalibrate) {
      try {
        calibration = await this.runCalibration(asOfDate, true);
        result.calibration = calibration;
      } catch (error: any) {
        result.warnings.push(`Calibration failed: ${error.message}`);
        console.warn(`⚠️  Calibration failed, proceeding without calibration: ${error.message}`);
      }
    }

    // Step 2: Generate forecasts for each type and horizon
    const outputDir = request.outputDir || this.config.paths.output;

    for (const type of request.types) {
      for (const horizon of request.horizons) {
        try {
          const file = await this.generateSingleForecast(
            type,
            horizon,
            request.startDate,
            request.endDate,
            outputDir,
            asOfDate,
            calibration,
            request
          );

          result.files.push(file);
        } catch (error: any) {
          result.warnings.push(`Failed to generate ${type} ${horizon}: ${error.message}`);
          console.error(`❌ Failed to generate ${type} ${horizon}: ${error.message}`);
        }
      }
    }

    result.durationMs = Date.now() - startTime;
    return result;
  }

  /**
   * Generate a single forecast (CFAC or demand, daily or weekly)
   */
  private async generateSingleForecast(
    type: 'demand' | 'cfac',
    horizon: 'daily' | 'weekly',
    startDate: string,
    endDate: string,
    outputDir: string,
    asOfDate: string,
    calibration: CalibrationResult | undefined,
    request: ForecastRequest
  ): Promise<ForecastResult['files'][0]> {
    const horizonPrefix = horizon === 'daily' ? 'da' : 'wa';
    const typePrefix = type === 'demand' ? 'dem' : 'mhcf';

    // Create output directory structure: {outputDir}/{horizon}/{TYPE}/
    const typeDir = join(outputDir, horizon, type === 'demand' ? 'DEMAND' : 'CFAC');
    if (!existsSync(typeDir)) {
      mkdirSync(typeDir, { recursive: true });
    }

    // Generate filename
    const filename = horizon === 'daily'
      ? `${horizonPrefix}_${typePrefix}_${startDate}.csv`
      : `${horizonPrefix}_${typePrefix}_${startDate}_${endDate}.csv`;
    const outputFile = join(typeDir, filename);

    // Generate the forecast
    if (type === 'cfac') {
      await this.generateCfacForecast(
        startDate,
        endDate,
        outputFile,
        calibration,
        request
      );
    } else {
      await this.generateDemandForecast(
        startDate,
        endDate,
        outputFile,
        calibration,
        request
      );
    }

    const fileResult: ForecastResult['files'][0] = {
      type,
      horizon,
      path: outputFile
    };

    // Step 3: Archive if enabled
    if (this.config.output.archiveEnabled) {
      try {
        const archivedPath = await this.archiveForecast(
          outputFile,
          type,
          horizon,
          startDate,
          endDate,
          asOfDate
        );
        fileResult.archived = archivedPath;
      } catch (error: any) {
        console.warn(`⚠️  Failed to archive ${outputFile}: ${error.message}`);
      }
    }

    // Step 4: Push to gateway if enabled
    if (this.config.gateway.enabled && this.config.gateway.autoPush && isGatewayEnabled()) {
      try {
        const category = this.getGatewayCategory(type, horizon);
        const pushResult = await pushFileToGateway(outputFile, category);
        fileResult.pushedToGateway = pushResult.success;
        if (!pushResult.success) {
          console.warn(`⚠️  Failed to push to gateway: ${pushResult.error}`);
        }
      } catch (error: any) {
        console.warn(`⚠️  Failed to push to gateway: ${error.message}`);
      }
    }

    return fileResult;
  }

  /**
   * Run System B calibration (iterative, convergent)
   * Extracted from ForecastSchedulerService lines 569-847
   */
  async runCalibration(
    asOfDate: string,
    verbose: boolean = true
  ): Promise<CalibrationResult> {
    const calibDays = this.config.calibration.days;
    const threshold = this.config.calibration.threshold;
    const maxIterations = this.config.calibration.maxIterations;

    // Auto-detect the most recent actual data dates for CFAC and demand separately
    const cfacMostRecentDate = this.findMostRecentActualDate(this.config.paths.cfacTraining);
    const demandMostRecentDate = this.findMostRecentActualDate(this.config.paths.demandTraining);

    if (!cfacMostRecentDate && !demandMostRecentDate) {
      throw new Error('Could not find any actual data files for calibration');
    }

    // CFAC calibration period
    const cfacCalibEnd = cfacMostRecentDate;
    const cfacCalibEndDt = cfacCalibEnd ? DateTime.fromISO(cfacCalibEnd) : null;
    const cfacCalibStart = cfacCalibEndDt ? cfacCalibEndDt.minus({ days: calibDays }).toISODate()! : null;

    // Demand calibration period (may differ from CFAC)
    const demandCalibEnd = demandMostRecentDate;
    const demandCalibEndDt = demandCalibEnd ? DateTime.fromISO(demandCalibEnd) : null;
    const demandCalibStart = demandCalibEndDt ? demandCalibEndDt.minus({ days: calibDays }).toISODate()! : null;

    if (verbose) {
      console.log('\n───────────────────────────────────────────────────────────────────────────────');
      console.log('                              CALIBRATION PHASE                                 ');
      console.log('───────────────────────────────────────────────────────────────────────────────');
      if (cfacCalibEnd) {
        console.log(`   CFAC data ends: ${cfacCalibEnd}`);
        console.log(`   CFAC calibration: ${cfacCalibStart} to ${cfacCalibEnd} (${calibDays} days)`);
      } else {
        console.log('   CFAC data: Not available');
      }
      if (demandCalibEnd) {
        console.log(`   Demand data ends: ${demandCalibEnd}`);
        console.log(`   Demand calibration: ${demandCalibStart} to ${demandCalibEnd} (${calibDays} days)`);
      } else {
        console.log('   Demand data: Not available');
      }
      console.log(`   Threshold: ±${threshold}%, Max iterations: ${maxIterations}`);
    }

    // For backwards compatibility, use CFAC dates if available, otherwise demand
    const calibEnd = cfacCalibEnd || demandCalibEnd!;
    const calibStart = cfacCalibStart || demandCalibStart!;

    // Create calibration directory
    const calibDir = join(this.config.paths.output, 'calibration', asOfDate);
    if (!existsSync(calibDir)) {
      mkdirSync(calibDir, { recursive: true });
    }

    let windScale = 0;
    let solarScale = 0;
    let windDeviation = 0;
    let solarDeviation = 0;
    let demandMape = 0;
    let demandPeakDeviation = 0;
    let demandOffpeakDeviation = 0;
    let demandPeakScale = 0;
    let demandOffpeakScale = 0;
    let cfacIteration = 0;
    let cfacConverged = false;
    let stationScales: Record<string, number> = {};

    // ═══════════════════════════════════════════════════════════════════════
    // CAPACITY FACTOR CALIBRATION - Iterate until wind AND solar converge
    // ═══════════════════════════════════════════════════════════════════════
    if (cfacCalibStart && cfacCalibEnd) {
      if (verbose) {
        console.log('\n   🌬️☀️ Calibrating capacity factors...');
      }

      while (cfacIteration < maxIterations) {
        cfacIteration++;

        if (verbose) {
          console.log(`\n   📊 CFAC Iteration ${cfacIteration}/${maxIterations}`);
          console.log(`      Scaling: Wind ${windScale > 0 ? '+' : ''}${windScale}%, Solar ${solarScale > 0 ? '+' : ''}${solarScale}%`);
        }

        // Generate calibration forecast with current scales
        const calibForecastFile = join(calibDir, `cfac_calib_iter${cfacIteration}.csv`);

        try {
          // Use 'cache' mode for calibration since it's always historical data
          await this.generateCfacForecastRaw(
            cfacCalibStart!,
            cfacCalibEnd!,
            calibForecastFile,
            windScale,
            solarScale,
            'cache'
          );
        } catch (error: any) {
          if (verbose) {
            console.log(`      ❌ Calibration forecast failed: ${error.message}`);
          }
          break;
        }

        // Analyze calibration results
        const analysis = this.analyzeCalibrationForecast(calibForecastFile, verbose);

        if (!analysis) {
          if (verbose) {
            console.log('      ❌ Could not analyze calibration forecast');
          }
          break;
        }

        windDeviation = analysis.windDeviation;
        solarDeviation = analysis.solarDeviation;
        stationScales = analysis.stationScales;

        const windOk = Math.abs(windDeviation) <= threshold;
        const solarOk = Math.abs(solarDeviation) <= threshold;

        if (verbose) {
          console.log(`      Wind deviation: ${windDeviation >= 0 ? '+' : ''}${windDeviation.toFixed(1)}% ${windOk ? '✅' : '❌'}`);
          console.log(`      Solar deviation: ${solarDeviation >= 0 ? '+' : ''}${solarDeviation.toFixed(1)}% ${solarOk ? '✅' : '❌'}`);
        }

        // Check if BOTH within threshold
        if (windOk && solarOk) {
          cfacConverged = true;
          if (verbose) {
            console.log(`\n   ✅ CFAC calibration converged at iteration ${cfacIteration}`);
          }
          break;
        }

        // Adjust scaling factors based on deviation
        // Positive deviation = under-forecasting = need to scale UP
        if (!windOk) {
          windScale = Math.round(windScale + windDeviation);
        }
        if (!solarOk) {
          solarScale = Math.round(solarScale + solarDeviation);
        }

        // Clean up intermediate file
        if (existsSync(calibForecastFile)) {
          unlinkSync(calibForecastFile);
        }
      }

      if (!cfacConverged && verbose) {
        console.log(`\n   ⚠️  CFAC calibration did not fully converge after ${cfacIteration} iterations`);
        console.log(`      Final: Wind ${windDeviation >= 0 ? '+' : ''}${windDeviation.toFixed(1)}%, Solar ${solarDeviation >= 0 ? '+' : ''}${solarDeviation.toFixed(1)}%`);
      }
    } else {
      if (verbose) {
        console.log('\n   ⏭️  Skipping CFAC calibration (no CFAC data available)');
      }
      cfacConverged = true; // Mark as converged so we don't fail the overall calibration
    }

    // ═══════════════════════════════════════════════════════════════════════
    // DEMAND CALIBRATION - Iterate until peak AND off-peak converge
    // ═══════════════════════════════════════════════════════════════════════
    let demandIteration = 0;
    let demandConverged = false;
    const maxDemandIterations = 5;

    if (demandCalibStart && demandCalibEnd) {
      if (verbose) {
        console.log('\n   ⚡ Calibrating demand forecast...');
      }

      while (demandIteration < maxDemandIterations) {
        demandIteration++;

        if (verbose && demandIteration > 1) {
          console.log(`\n   📊 Demand Iteration ${demandIteration}/${maxDemandIterations}`);
          console.log(`      Scaling: Peak ${demandPeakScale > 0 ? '+' : ''}${demandPeakScale}%, Off-peak ${demandOffpeakScale > 0 ? '+' : ''}${demandOffpeakScale}%`);
        }

        const demandCalibFile = join(calibDir, `demand_calib_iter${demandIteration}.csv`);

        try {
          await this.generateDemandForecastRaw(
            demandCalibStart,
            demandCalibEnd,
            demandCalibFile,
            demandIteration > 1 ? demandPeakScale : undefined,
            demandIteration > 1 ? demandOffpeakScale : undefined
          );

          const demandAnalysis = this.analyzeDemandForecast(demandCalibFile);
          demandMape = demandAnalysis.mape;
          demandPeakDeviation = demandAnalysis.peakDeviation;
          demandOffpeakDeviation = demandAnalysis.offpeakDeviation;

          const peakOk = Math.abs(demandPeakDeviation) <= threshold;
          const offpeakOk = Math.abs(demandOffpeakDeviation) <= threshold;

          if (verbose) {
            console.log(`      Demand MAPE: ${demandMape.toFixed(2)}%`);
            console.log(`      Peak deviation: ${demandPeakDeviation >= 0 ? '+' : ''}${demandPeakDeviation.toFixed(1)}% ${peakOk ? '✅' : '❌'}`);
            console.log(`      Off-peak deviation: ${demandOffpeakDeviation >= 0 ? '+' : ''}${demandOffpeakDeviation.toFixed(1)}% ${offpeakOk ? '✅' : '❌'}`);
          }

          // Check if BOTH within threshold
          if (peakOk && offpeakOk) {
            demandConverged = true;
            if (verbose) {
              console.log(`\n   ✅ Demand calibration converged at iteration ${demandIteration}`);
            }
            break;
          }

          // Adjust scaling factors
          if (!peakOk) {
            demandPeakScale = Math.round(demandPeakScale + demandPeakDeviation);
          }
          if (!offpeakOk) {
            demandOffpeakScale = Math.round(demandOffpeakScale + demandOffpeakDeviation);
          }

          // Clean up intermediate file
          if (existsSync(demandCalibFile)) {
            unlinkSync(demandCalibFile);
          }
        } catch (error) {
          if (verbose) {
            console.log('      ⚠️  Could not verify demand accuracy');
          }
          break;
        }
      }

      if (!demandConverged && verbose) {
        console.log(`\n   ⚠️  Demand calibration did not fully converge after ${demandIteration} iterations`);
      }
    } else {
      if (verbose) {
        console.log('\n   ⏭️  Skipping demand calibration (no demand data available)');
      }
      demandConverged = true; // Mark as converged so we don't fail the overall calibration
    }

    const withinThreshold = cfacConverged && demandConverged;
    const totalIterations = cfacIteration + demandIteration;

    const result: CalibrationResult = {
      windScale,
      solarScale,
      windDeviation,
      solarDeviation,
      demandMape,
      demandPeakDeviation,
      demandOffpeakDeviation,
      demandPeakScale,
      demandOffpeakScale,
      calibrationPeriod: { start: calibStart, end: calibEnd },
      demandCalibrationPeriod: demandCalibStart && demandCalibEnd
        ? { start: demandCalibStart, end: demandCalibEnd }
        : undefined,
      withinThreshold,
      stationScales,
      iterations: totalIterations
    };

    // Store calibration in database
    this.db.prepare(`
      INSERT INTO calibration_history
      (calibration_date, calibration_start, calibration_end, wind_scale, solar_scale,
       wind_deviation, solar_deviation, demand_mape, demand_peak_deviation, demand_offpeak_deviation,
       demand_peak_scale, demand_offpeak_scale, within_threshold, iterations)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      asOfDate, calibStart, calibEnd, windScale, solarScale,
      windDeviation, solarDeviation, demandMape, demandPeakDeviation, demandOffpeakDeviation,
      demandPeakScale, demandOffpeakScale, withinThreshold ? 1 : 0, totalIterations
    );

    return result;
  }

  /**
   * Find the most recent actual data date from data files
   * Scans all CSV files and finds the latest DateTimeEnding value
   */
  private findMostRecentActualDate(dataPath: string): string | null {
    try {
      if (!existsSync(dataPath)) {
        return null;
      }

      const actualFiles = readdirSync(dataPath).filter(f => f.endsWith('.csv'));

      if (actualFiles.length === 0) {
        return null;
      }

      let mostRecentDate: DateTime | null = null;

      for (const file of actualFiles) {
        try {
          const content = readFileSync(join(dataPath, file), 'utf-8');
          const data = parse(content, { columns: true, skip_empty_lines: true });

          for (const row of data) {
            const dtStr = row.DateTimeEnding;
            if (!dtStr) continue;

            // Parse datetime from format "M/D/YYYY HH:mm" or "YYYY-MM-DD HH:mm"
            let rowDate: DateTime;

            if (dtStr.includes('/')) {
              // M/D/YYYY HH:mm format
              const parts = dtStr.split(' ');
              const dateParts = parts[0].split('/');
              const month = parseInt(dateParts[0]);
              const day = parseInt(dateParts[1]);
              const year = parseInt(dateParts[2]);
              rowDate = DateTime.fromObject({ year, month, day });
            } else {
              // ISO format YYYY-MM-DD
              rowDate = DateTime.fromISO(dtStr.split(' ')[0]);
            }

            if (rowDate.isValid && (!mostRecentDate || rowDate > mostRecentDate)) {
              mostRecentDate = rowDate;
            }
          }
        } catch (e) {
          // Skip files that can't be parsed
          continue;
        }
      }

      return mostRecentDate ? mostRecentDate.toISODate() : null;
    } catch (error) {
      return null;
    }
  }

  /**
   * Analyze CFAC calibration forecast against actuals
   */
  private analyzeCalibrationForecast(
    forecastFile: string,
    verbose: boolean
  ): { windDeviation: number; solarDeviation: number; stationScales: Record<string, number> } | null {
    if (!existsSync(forecastFile)) {
      return null;
    }

    try {
      const fcContent = readFileSync(forecastFile, 'utf-8');
      const fcData = parse(fcContent, { columns: true, skip_empty_lines: true });

      // Find actuals file
      const actualsDir = this.config.paths.cfacTraining;
      const actualFiles = readdirSync(actualsDir).filter(f => f.endsWith('.csv'));

      if (actualFiles.length === 0) {
        return null;
      }

      // Load all actual data
      let actData: any[] = [];
      for (const file of actualFiles) {
        const content = readFileSync(join(actualsDir, file), 'utf-8');
        const data = parse(content, { columns: true, skip_empty_lines: true });
        actData = actData.concat(data);
      }

      // Build actuals map
      const actMap = new Map<string, any>();
      for (const row of actData) {
        actMap.set(row.DateTimeEnding, row);
      }

      // Wind stations
      const windStations = ['01BURGOS', '01LAOAG', '01PAGUDPUD', '02DOLORES', '08BVISTA', '08NABAS_W'];

      // Solar stations (ending with _S)
      const allColumns = Object.keys(fcData[0] || {});
      const solarStations = allColumns.filter(k => k.endsWith('_S') && k !== 'DateTimeEnding');

      let windFcSum = 0, windActSum = 0;
      let solarFcSum = 0, solarActSum = 0;

      // Per-station tracking for individual calibration
      const stationFcSums: Record<string, number> = {};
      const stationActSums: Record<string, number> = {};
      const allStations = [...windStations, ...solarStations];
      for (const station of allStations) {
        stationFcSums[station] = 0;
        stationActSums[station] = 0;
      }

      for (const fcRow of fcData) {
        const dt = fcRow.DateTimeEnding;
        const actRow = actMap.get(dt);
        if (!actRow) continue;

        // Wind
        for (const station of windStations) {
          const fcVal = parseFloat(fcRow[station]);
          const actVal = parseFloat(actRow[station]);
          if (!isNaN(fcVal) && !isNaN(actVal)) {
            windFcSum += fcVal;
            windActSum += actVal;
            stationFcSums[station] += fcVal;
            stationActSums[station] += actVal;
          }
        }

        // Solar
        for (const station of solarStations) {
          const fcVal = parseFloat(fcRow[station]);
          const actVal = parseFloat(actRow[station]);
          if (!isNaN(fcVal) && !isNaN(actVal)) {
            solarFcSum += fcVal;
            solarActSum += actVal;
            stationFcSums[station] += fcVal;
            stationActSums[station] += actVal;
          }
        }
      }

      const windRatio = windFcSum > 0 ? windActSum / windFcSum : 1.0;
      const solarRatio = solarFcSum > 0 ? solarActSum / solarFcSum : 1.0;

      // Per-station scales
      const stationScales: Record<string, number> = {};
      for (const station of allStations) {
        const fcSum = stationFcSums[station];
        const actSum = stationActSums[station];
        if (fcSum > 0.1) {
          stationScales[station] = actSum / fcSum;
        } else {
          stationScales[station] = 1.0;
        }
      }

      if (verbose) {
        // Log stations with significant deviation (>10%)
        const significantStations = Object.entries(stationScales)
          .filter(([_, scale]) => Math.abs(scale - 1.0) > 0.1)
          .sort((a, b) => Math.abs(b[1] - 1.0) - Math.abs(a[1] - 1.0));
        if (significantStations.length > 0) {
          console.log(`      📊 Stations with >10% deviation: ${significantStations.slice(0, 5).map(([s, v]) => `${s}(${((v-1)*100).toFixed(0)}%)`).join(', ')}${significantStations.length > 5 ? ` +${significantStations.length - 5} more` : ''}`);
        }
      }

      return {
        windDeviation: (windRatio - 1) * 100,
        solarDeviation: (solarRatio - 1) * 100,
        stationScales
      };
    } catch (error) {
      return null;
    }
  }

  /**
   * Analyze demand forecast against actuals
   */
  private analyzeDemandForecast(forecastFile: string): {
    mape: number;
    peakDeviation: number;
    offpeakDeviation: number;
  } {
    if (!existsSync(forecastFile)) {
      return { mape: 100, peakDeviation: 0, offpeakDeviation: 0 };
    }

    try {
      const fcContent = readFileSync(forecastFile, 'utf-8');
      const fcData = parse(fcContent, { columns: true, skip_empty_lines: true });

      // Load demand actuals
      const demandDir = this.config.paths.demandTraining;
      const demandFiles = readdirSync(demandDir).filter(f => f.endsWith('.csv'));

      let actData: any[] = [];
      for (const file of demandFiles) {
        const content = readFileSync(join(demandDir, file), 'utf-8');
        const data = parse(content, { columns: true, skip_empty_lines: true });
        actData = actData.concat(data);
      }

      const actMap = new Map<string, any>();
      for (const row of actData) {
        actMap.set(row.DateTimeEnding, row);
      }

      // Peak hours: 09:00-21:00, Off-peak: 21:00-09:00
      const isPeakHour = (dateTimeStr: string): boolean => {
        const timePart = dateTimeStr.split(' ')[1];
        if (!timePart) return false;
        const hour = parseInt(timePart.split(':')[0]);
        return hour >= 9 && hour < 21;
      };

      let totalError = 0;
      let count = 0;
      let peakFcSum = 0, peakActSum = 0, peakCount = 0;
      let offpeakFcSum = 0, offpeakActSum = 0, offpeakCount = 0;

      // Detect columns (regional: CLUZ, CVIS, CMIN or zonal: 01NLUZ, etc.)
      const regions = this.getDemandColumns(fcData[0]);

      for (const fcRow of fcData) {
        const dt = fcRow.DateTimeEnding;
        const actRow = actMap.get(dt);
        if (!actRow) continue;

        const isPeak = isPeakHour(dt);

        for (const region of regions) {
          const fcVal = parseFloat(fcRow[region]);
          const actVal = parseFloat(actRow[region]);
          if (!isNaN(fcVal) && !isNaN(actVal) && actVal > 0) {
            totalError += Math.abs(fcVal - actVal) / actVal * 100;
            count++;

            if (isPeak) {
              peakFcSum += fcVal;
              peakActSum += actVal;
              peakCount++;
            } else {
              offpeakFcSum += fcVal;
              offpeakActSum += actVal;
              offpeakCount++;
            }
          }
        }
      }

      const mape = count > 0 ? totalError / count : 100;
      const peakDeviation = peakCount > 0 ? (peakActSum - peakFcSum) / peakActSum * 100 : 0;
      const offpeakDeviation = offpeakCount > 0 ? (offpeakActSum - offpeakFcSum) / offpeakActSum * 100 : 0;

      return { mape, peakDeviation, offpeakDeviation };
    } catch (error) {
      return { mape: 100, peakDeviation: 0, offpeakDeviation: 0 };
    }
  }

  /**
   * Detect demand columns (regional or zonal) from data
   */
  private getDemandColumns(sampleRow: any): string[] {
    const columns = Object.keys(sampleRow);

    // Check for regional columns
    const regionalCols = ['CLUZ', 'CVIS', 'CMIN'];
    if (regionalCols.every(col => columns.includes(col))) {
      return regionalCols;
    }

    // Check for zonal columns
    const zonalPrefixes = ['01NLUZ', '02METRO', '03SLUZ', '04LEYTE', '05CEBU', '06NEGROS', '07BOHOL', '08PANAY', '09NWMIN', '10LANAO', '11NCMIN', '12NEMIN', '13SEMIN', '14SWMIN'];
    const zonalCols = columns.filter(col => zonalPrefixes.includes(col));
    if (zonalCols.length > 0) {
      return zonalCols;
    }

    // Default to regional
    return regionalCols;
  }

  /**
   * Generate CFAC forecast (raw, no archiving or gateway push)
   * This is used by calibration and production forecasts
   *
   * NOTE: This invokes the CLI via child_process since the forecast logic
   * is deeply embedded in the CLI command (2000+ lines). A future refactoring
   * could extract this to a reusable service method.
   */
  private async generateCfacForecastRaw(
    startDate: string,
    endDate: string,
    outputFile: string,
    scaleWind: number,
    scaleSolar: number,
    weatherRefreshMode: 'cache' | 'refresh' | 'force-refresh'
  ): Promise<void> {
    // Build CLI command arguments
    const args = [
      'dist/index.js',
      'cfac',
      'forecast2',
      '-t', this.config.paths.cfacTraining,
      '-s', startDate,
      '-e', endDate,
      '-o', outputFile,
      '--cache', this.config.paths.weatherCache,
      '--no-auto-calibrate'
    ];

    // Add scale factors if non-zero
    if (scaleWind !== 0) {
      args.push('--scale-wind', scaleWind.toString());
    }
    if (scaleSolar !== 0) {
      args.push('--scale-solar', scaleSolar.toString());
    }

    // Add optional flags from config
    if (this.config.cfac.useXgboost) {
      args.push('--use-xgboost');
    }
    if (this.config.cfac.asymmetricLoss) {
      args.push('--asymmetric-loss');
    }
    if (this.config.cfac.biasCorrection) {
      args.push('--bias-correction');
    }

    // Weather refresh mode
    if (weatherRefreshMode === 'force-refresh') {
      args.push('--refresh-weather');
    }

    // Execute CLI command
    return new Promise((resolve, reject) => {
      const child = spawn('node', args, {
        cwd: process.cwd(),
        stdio: 'inherit'
      });

      child.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`CFAC forecast command failed with code ${code}`));
        }
      });

      child.on('error', (error) => {
        reject(new Error(`Failed to spawn CFAC forecast command: ${error.message}`));
      });
    });
  }

  /**
   * Generate demand forecast (raw, no archiving or gateway push)
   *
   * NOTE: This invokes the CLI via child_process since the forecast logic
   * is deeply embedded in the CLI command. A future refactoring could extract
   * this to a reusable service method.
   */
  private async generateDemandForecastRaw(
    startDate: string,
    endDate: string,
    outputFile: string,
    scalePeak?: number,
    scaleOffpeak?: number
  ): Promise<void> {
    // Build CLI command arguments
    const args = [
      'dist/index.js',
      'forecast',
      '-s', startDate,
      '-e', endDate,
      '-o', outputFile,
      '--model', this.config.demand.model,
      '--cache', this.config.paths.weatherCache,
      '--use-db'
    ];

    // Add zonal flag if geography is zonal
    if (this.config.demand.geography === 'zonal') {
      args.push('--zonal');
    }

    // Add scale factors if provided
    if (scalePeak !== undefined && scalePeak !== 0) {
      args.push('--scale-peak', scalePeak.toString());
    }
    if (scaleOffpeak !== undefined && scaleOffpeak !== 0) {
      args.push('--scale-offpeak', scaleOffpeak.toString());
    }

    // Execute CLI command
    return new Promise((resolve, reject) => {
      const child = spawn('node', args, {
        cwd: process.cwd(),
        stdio: 'inherit'
      });

      child.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`Demand forecast command failed with code ${code}`));
        }
      });

      child.on('error', (error) => {
        reject(new Error(`Failed to spawn demand forecast command: ${error.message}`));
      });
    });
  }

  /**
   * Generate CFAC forecast using calibration and config
   */
  private async generateCfacForecast(
    startDate: string,
    endDate: string,
    outputFile: string,
    calibration: CalibrationResult | undefined,
    request: ForecastRequest
  ): Promise<void> {
    const windScale = calibration?.windScale || 0;
    const solarScale = calibration?.solarScale || 0;

    // Determine weather refresh mode
    let weatherMode: 'cache' | 'refresh' | 'force-refresh' = 'refresh';
    if (request.refreshWeather) {
      weatherMode = 'force-refresh';
    } else if (this.config.weather.refreshMode === 'never') {
      weatherMode = 'cache';
    } else if (this.config.weather.refreshMode === 'always') {
      weatherMode = 'force-refresh';
    }

    await this.generateCfacForecastRaw(
      startDate,
      endDate,
      outputFile,
      windScale,
      solarScale,
      weatherMode
    );
  }

  /**
   * Generate demand forecast using calibration and config
   */
  private async generateDemandForecast(
    startDate: string,
    endDate: string,
    outputFile: string,
    calibration: CalibrationResult | undefined,
    request: ForecastRequest
  ): Promise<void> {
    const scalePeak = calibration?.demandPeakScale || 0;
    const scaleOffpeak = calibration?.demandOffpeakScale || 0;

    await this.generateDemandForecastRaw(
      startDate,
      endDate,
      outputFile,
      scalePeak,
      scaleOffpeak
    );
  }

  /**
   * Archive forecast file with gateway naming convention
   */
  private async archiveForecast(
    sourceFile: string,
    type: 'demand' | 'cfac',
    horizon: 'daily' | 'weekly',
    startDate: string,
    endDate: string,
    asOfDate: string
  ): Promise<string> {
    const archiveDir = this.config.paths.archive;
    if (!existsSync(archiveDir)) {
      mkdirSync(archiveDir, { recursive: true });
    }

    // Gateway naming: D+1_demand_ASOF_START_END.csv
    const horizonLabel = horizon === 'daily' ? 'D+1' : 'D+7';
    const typeLabel = type === 'demand' ? 'demand' : 'mhcf';
    const archiveFilename = horizon === 'daily'
      ? `${horizonLabel}_${typeLabel}_${asOfDate}_${startDate}_${startDate}.csv`
      : `${horizonLabel}_${typeLabel}_${asOfDate}_${startDate}_${endDate}.csv`;

    const archivePath = join(archiveDir, archiveFilename);

    // Copy file
    const content = readFileSync(sourceFile, 'utf-8');
    writeFileSync(archivePath, content, 'utf-8');

    return archivePath;
  }

  /**
   * Get gateway category for forecast file
   */
  private getGatewayCategory(type: 'demand' | 'cfac', horizon: 'daily' | 'weekly'): ForecastCategory {
    if (type === 'demand') {
      return horizon === 'daily' ? 'day-ahead-demand' : 'week-ahead-demand';
    } else {
      return horizon === 'daily' ? 'day-ahead-mhcf' : 'week-ahead-mhcf';
    }
  }

  /**
   * Close database connection
   */
  close(): void {
    this.db.close();
  }
}

/**
 * Get singleton instance of UnifiedForecastService
 */
let defaultServiceInstance: UnifiedForecastService | null = null;

export function getUnifiedForecastService(configPath?: string, dbPath?: string): UnifiedForecastService {
  if (!defaultServiceInstance || configPath || dbPath) {
    defaultServiceInstance = new UnifiedForecastService(configPath, dbPath);
  }
  return defaultServiceInstance;
}
