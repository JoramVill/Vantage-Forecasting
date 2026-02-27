/**
 * Forecast Scheduler Service
 *
 * Automates daily and weekly forecast generation by executing the existing
 * CLI commands (forecast and cfac forecast2) which are already optimized.
 *
 * KEY FEATURE: Automatic calibration before each forecast run
 * - Generates test forecast for recent period with known actuals
 * - Calculates optimal wind/solar scaling factors
 * - Verifies accuracy within ±5% threshold
 * - Applies calibrated factors to production forecasts
 */

import { DateTime } from 'luxon';
import Database from 'better-sqlite3';
import { execSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'fs';
import { parse } from 'csv-parse/sync';
import { autoPushIfEnabled, isGatewayEnabled } from './sftpPushService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface ForecastRun {
  id: number;
  run_date: string;
  run_time: string;
  forecast_type: 'demand' | 'cfac';
  horizon: 'daily' | 'weekly';
  forecast_start: string;
  forecast_end: string;
  model_used: string;
  status: 'pending' | 'completed' | 'evaluated' | 'failed';
  records_generated: number;
  duration_ms: number;
  output_file: string;
  error_message?: string;
  scale_wind?: number;
  scale_solar?: number;
}

interface CalibrationResult {
  windScale: number;
  solarScale: number;
  windDeviation: number;
  solarDeviation: number;
  demandMape: number;
  demandPeakDeviation: number;     // Peak hours (09:00-21:00) deviation %
  demandOffpeakDeviation: number;  // Off-peak hours (21:00-09:00) deviation %
  demandPeakScale: number;         // Calculated peak scaling factor
  demandOffpeakScale: number;      // Calculated off-peak scaling factor
  calibrationPeriod: { start: string; end: string };
  withinThreshold: boolean;
  // Per-station calibration scales (station code -> scale factor, e.g., 1.05 = +5%)
  stationScales: Record<string, number>;
}

interface SchedulerConfig {
  demandDataPath: string;
  cfacDataPath: string;
  outputDir: string;
  dbPath: string;
  // Calibration options
  calibrationDays?: number;      // Days to use for calibration (default: 7)
  calibrationThreshold?: number; // Max acceptable deviation (default: 5%)
  maxCalibrationIterations?: number; // Max iterations to converge (default: 3)
  // Demand options
  demandModel?: 'hybrid' | 'regression' | 'xgboost';
  useDb?: boolean;
  trainDays?: number;
  demandScale?: number;
  demandGrowth?: number;
  // CFAC options
  useXgboost?: boolean;
  asymmetricLoss?: boolean;
  biasCorrection?: boolean;
  autoCalibrateDays?: number;
  // Gateway options
  pushToGateway?: boolean;  // Push generated forecasts to Vantage-Gateway (respects global VANTAGE_GATEWAY_ENABLED)
}

export class ForecastSchedulerService {
  private db: Database.Database;
  private config: SchedulerConfig;
  private nodeCmd: string;
  private cliPath: string;
  private projectRoot: string;
  private lastCalibration: CalibrationResult | null = null;

  constructor(config: SchedulerConfig) {
    this.config = {
      demandModel: 'hybrid',
      useDb: false,
      trainDays: 90,
      autoCalibrateDays: 14,
      calibrationDays: 7,
      calibrationThreshold: 5,
      maxCalibrationIterations: 3,
      ...config
    };
    this.db = new Database(config.dbPath);
    this.ensureTables();

    // Determine CLI path - use project root as working directory
    this.nodeCmd = process.execPath;
    // __dirname is in dist/services, so go up two levels to get project root
    this.cliPath = join(dirname(dirname(__dirname)), 'dist', 'index.js');
    // Project root is where package.json lives
    this.projectRoot = dirname(dirname(__dirname));
  }

  private ensureTables(): void {
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
        status TEXT DEFAULT 'pending',
        records_generated INTEGER,
        duration_ms INTEGER,
        output_file TEXT,
        error_message TEXT,
        scale_wind REAL,
        scale_solar REAL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS forecast_evaluations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER NOT NULL,
        evaluated_at TEXT NOT NULL,
        records_matched INTEGER,
        mape REAL,
        mae REAL,
        rmse REAL,
        bias REAL,
        UNIQUE(run_id)
      );

      CREATE TABLE IF NOT EXISTS calibration_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        calibration_date TEXT NOT NULL,
        calibration_start TEXT NOT NULL,
        calibration_end TEXT NOT NULL,
        wind_scale REAL NOT NULL,
        solar_scale REAL NOT NULL,
        wind_deviation REAL NOT NULL,
        solar_deviation REAL NOT NULL,
        demand_mape REAL,
        demand_peak_deviation REAL,
        demand_offpeak_deviation REAL,
        demand_peak_scale REAL,
        demand_offpeak_scale REAL,
        within_threshold INTEGER,
        iterations INTEGER,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_forecast_runs_date ON forecast_runs(run_date);
      CREATE INDEX IF NOT EXISTS idx_forecast_runs_status ON forecast_runs(status);
    `);
  }

  /**
   * MAIN ENTRY POINT: Run calibrated forecasts
   *
   * This method:
   * 1. Runs calibration to determine optimal wind/solar scaling
   * 2. Verifies calibration is within threshold
   * 3. Generates production forecasts with calibrated values
   */
  async runCalibratedForecasts(
    asOfDate: string,
    options?: {
      forecastType?: 'demand' | 'cfac' | 'both';
      horizon?: 'daily' | 'weekly' | 'both';
      verbose?: boolean;
    }
  ): Promise<{
    calibration: CalibrationResult;
    forecasts: { demand?: ForecastRun[]; cfac?: ForecastRun[] };
  }> {
    const forecastType = options?.forecastType || 'both';
    const horizon = options?.horizon || 'both';
    const verbose = options?.verbose ?? true;

    if (verbose) {
      console.log('\n═══════════════════════════════════════════════════════════════════════════════');
      console.log('                    CALIBRATED FORECAST GENERATION                              ');
      console.log('═══════════════════════════════════════════════════════════════════════════════');
      console.log(`\n📅 As-of date: ${asOfDate}`);
    }

    // Step 1: Run calibration
    const calibration = await this.runCalibration(asOfDate, verbose);

    // Step 2: Check if within threshold
    if (!calibration.withinThreshold) {
      console.log(`\n⚠️  Warning: Calibration deviation exceeds ${this.config.calibrationThreshold}% threshold`);
      console.log(`   Wind: ${calibration.windDeviation.toFixed(1)}%, Solar: ${calibration.solarDeviation.toFixed(1)}%`);
      console.log('   Proceeding with best available calibration...');
    }

    // Step 3: Generate production forecasts
    const forecasts: { demand?: ForecastRun[]; cfac?: ForecastRun[] } = {
      demand: [],
      cfac: []
    };

    const asOf = DateTime.fromISO(asOfDate);

    if (verbose) {
      console.log('\n───────────────────────────────────────────────────────────────────────────────');
      console.log('                         GENERATING PRODUCTION FORECASTS                        ');
      console.log('───────────────────────────────────────────────────────────────────────────────');
    }

    // Daily forecasts
    if (horizon === 'daily' || horizon === 'both') {
      const targetDate = asOf.plus({ days: 1 }).toISODate()!;

      if (verbose) {
        console.log(`\n📅 Daily forecast: ${targetDate}`);
      }

      if (forecastType === 'demand' || forecastType === 'both') {
        const run = await this.runDemandForecast(asOfDate, targetDate, targetDate, 'daily', verbose, calibration);
        forecasts.demand!.push(run);
      }

      if (forecastType === 'cfac' || forecastType === 'both') {
        const run = await this.runCfacForecastWithCalibration(
          asOfDate, targetDate, targetDate, 'daily', calibration, verbose
        );
        forecasts.cfac!.push(run);
      }
    }

    // Weekly forecasts
    if (horizon === 'weekly' || horizon === 'both') {
      const startDate = asOf.plus({ days: 1 }).toISODate()!;
      const endDate = asOf.plus({ days: 7 }).toISODate()!;

      if (verbose) {
        console.log(`\n📅 Weekly forecast: ${startDate} to ${endDate}`);
      }

      if (forecastType === 'demand' || forecastType === 'both') {
        const run = await this.runDemandForecast(asOfDate, startDate, endDate, 'weekly', verbose, calibration);
        forecasts.demand!.push(run);
      }

      if (forecastType === 'cfac' || forecastType === 'both') {
        const run = await this.runCfacForecastWithCalibration(
          asOfDate, startDate, endDate, 'weekly', calibration, verbose
        );
        forecasts.cfac!.push(run);
      }
    }

    if (verbose) {
      console.log('\n═══════════════════════════════════════════════════════════════════════════════');
      console.log('                              FORECAST COMPLETE                                 ');
      console.log('═══════════════════════════════════════════════════════════════════════════════');
      console.log(`\n✅ Calibration:`);
      console.log(`   Wind ${calibration.windScale > 0 ? '+' : ''}${calibration.windScale}%, Solar ${calibration.solarScale > 0 ? '+' : ''}${calibration.solarScale}%`);
      if (calibration.demandPeakScale !== 0 || calibration.demandOffpeakScale !== 0) {
        console.log(`   Demand peak ${calibration.demandPeakScale > 0 ? '+' : ''}${calibration.demandPeakScale}%, off-peak ${calibration.demandOffpeakScale > 0 ? '+' : ''}${calibration.demandOffpeakScale}%`);
      }
      console.log(`📁 Output: ${this.config.outputDir}/daily/ and ${this.config.outputDir}/weekly/`);
    }

    return { calibration, forecasts };
  }

  /**
   * Run calibration to determine optimal scaling factors
   * Iterates until ALL metrics are within threshold or max iterations reached
   */
  async runCalibration(asOfDate: string, verbose: boolean = true): Promise<CalibrationResult> {
    const calibDays = this.config.calibrationDays!;
    const threshold = this.config.calibrationThreshold!;
    // Use higher max iterations to ensure convergence
    const maxIterations = Math.max(this.config.maxCalibrationIterations || 3, 10);

    const asOf = DateTime.fromISO(asOfDate);

    // Find calibration period (most recent data before as-of date)
    const calibEnd = asOf.minus({ days: 1 }).toISODate()!;
    const calibStart = asOf.minus({ days: calibDays }).toISODate()!;

    if (verbose) {
      console.log('\n───────────────────────────────────────────────────────────────────────────────');
      console.log('                              CALIBRATION PHASE                                 ');
      console.log('───────────────────────────────────────────────────────────────────────────────');
      console.log(`   Calibration period: ${calibStart} to ${calibEnd}`);
      console.log(`   Threshold: ±${threshold}%, Max iterations: ${maxIterations}`);
    }

    // Create calibration directory
    const calibDir = join(this.config.outputDir, 'calibration', asOfDate);
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
        await this.generateCfacForecast(
          calibStart, calibEnd, calibForecastFile,
          windScale, solarScale, false
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

    // ═══════════════════════════════════════════════════════════════════════
    // DEMAND CALIBRATION - Iterate until peak AND off-peak converge
    // ═══════════════════════════════════════════════════════════════════════
    if (verbose) {
      console.log('\n   ⚡ Calibrating demand forecast...');
    }

    let demandIteration = 0;
    let demandConverged = false;
    const maxDemandIterations = 5;

    while (demandIteration < maxDemandIterations) {
      demandIteration++;

      if (verbose && demandIteration > 1) {
        console.log(`\n   📊 Demand Iteration ${demandIteration}/${maxDemandIterations}`);
        console.log(`      Scaling: Peak ${demandPeakScale > 0 ? '+' : ''}${demandPeakScale}%, Off-peak ${demandOffpeakScale > 0 ? '+' : ''}${demandOffpeakScale}%`);
      }

      const demandCalibFile = join(calibDir, `demand_calib_iter${demandIteration}.csv`);

      try {
        await this.generateDemandForecast(
          calibStart, calibEnd, demandCalibFile, false,
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

    const withinThreshold = cfacConverged && demandConverged;

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
      withinThreshold,
      stationScales
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
      demandPeakScale, demandOffpeakScale, withinThreshold ? 1 : 0, cfacIteration + demandIteration
    );

    this.lastCalibration = result;
    return result;
  }

  /**
   * Detect station outages from actual data
   * An outage is detected when a station has consecutive hours of 0 output
   * during times when it would normally produce (daytime for solar, anytime for wind)
   *
   * @returns Map of station -> Set of datetime strings that are in outage
   */
  private detectStationOutages(
    actData: any[],
    stations: string[],
    isSolar: boolean,
    minConsecutiveZeros: number = 6
  ): Map<string, Set<string>> {
    const outages = new Map<string, Set<string>>();

    // Sort data by datetime
    const sortedData = [...actData].sort((a, b) =>
      a.DateTimeEnding.localeCompare(b.DateTimeEnding)
    );

    for (const station of stations) {
      const stationOutages = new Set<string>();
      let consecutiveZeros: string[] = [];

      for (const row of sortedData) {
        const dt = row.DateTimeEnding;
        const hour = parseInt(dt.split(' ')[1]?.split(':')[0] || '0');

        // For solar, only check daytime hours (6-18)
        if (isSolar && (hour < 6 || hour > 18)) {
          // Reset consecutive count at night for solar
          if (consecutiveZeros.length >= minConsecutiveZeros) {
            consecutiveZeros.forEach(d => stationOutages.add(d));
          }
          consecutiveZeros = [];
          continue;
        }

        const actVal = parseFloat(row[station]);

        if (actVal === 0 || isNaN(actVal)) {
          consecutiveZeros.push(dt);
        } else {
          // Non-zero value - check if we had an outage period
          if (consecutiveZeros.length >= minConsecutiveZeros) {
            consecutiveZeros.forEach(d => stationOutages.add(d));
          }
          consecutiveZeros = [];
        }
      }

      // Check final run
      if (consecutiveZeros.length >= minConsecutiveZeros) {
        consecutiveZeros.forEach(d => stationOutages.add(d));
      }

      if (stationOutages.size > 0) {
        outages.set(station, stationOutages);
      }
    }

    return outages;
  }

  /**
   * Analyze CFAC calibration forecast against actuals
   * Automatically detects and excludes station outage periods from comparison
   */
  private analyzeCalibrationForecast(forecastFile: string, verbose: boolean): { windDeviation: number; solarDeviation: number; stationScales: Record<string, number> } | null {
    if (!existsSync(forecastFile)) {
      return null;
    }

    try {
      const fcContent = readFileSync(forecastFile, 'utf-8');
      const fcData = parse(fcContent, { columns: true, skip_empty_lines: true });

      // Find actuals file
      const actualsDir = this.config.cfacDataPath;
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

      // Detect outages (6+ consecutive hours of zero output)
      const windOutages = this.detectStationOutages(actData, windStations, false, 6);
      const solarOutages = this.detectStationOutages(actData, solarStations, true, 6);

      if (verbose) {
        const windOutageCount = Array.from(windOutages.values()).reduce((sum, set) => sum + set.size, 0);
        const solarOutageCount = Array.from(solarOutages.values()).reduce((sum, set) => sum + set.size, 0);
        if (windOutageCount > 0 || solarOutageCount > 0) {
          console.log(`      ⚠️  Detected outages: ${windOutages.size} wind stations (${windOutageCount} hours), ${solarOutages.size} solar stations (${solarOutageCount} hours)`);
        }
      }

      let windFcSum = 0, windActSum = 0, windExcluded = 0;
      let solarFcSum = 0, solarActSum = 0, solarExcluded = 0;

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
          // Skip if station is in outage for this datetime
          if (windOutages.get(station)?.has(dt)) {
            windExcluded++;
            continue;
          }

          const fcVal = parseFloat(fcRow[station]) || 0;
          const actVal = parseFloat(actRow[station]) || 0;
          if (actVal > 0.01) {
            windFcSum += fcVal;
            windActSum += actVal;
            // Per-station tracking
            stationFcSums[station] += fcVal;
            stationActSums[station] += actVal;
          }
        }

        // Solar (daytime hours 6-18)
        const hour = parseInt(dt.split(' ')[1]?.split(':')[0] || '0');
        if (hour >= 6 && hour <= 18) {
          for (const station of solarStations) {
            // Skip if station is in outage for this datetime
            if (solarOutages.get(station)?.has(dt)) {
              solarExcluded++;
              continue;
            }

            const fcVal = parseFloat(fcRow[station]) || 0;
            const actVal = parseFloat(actRow[station]) || 0;
            if (actVal > 0.01) {
              solarFcSum += fcVal;
              solarActSum += actVal;
              // Per-station tracking
              stationFcSums[station] += fcVal;
              stationActSums[station] += actVal;
            }
          }
        }
      }

      if (verbose && (windExcluded > 0 || solarExcluded > 0)) {
        console.log(`      📊 Excluded from calibration: ${windExcluded} wind, ${solarExcluded} solar station-hours`);
      }

      const windRatio = windFcSum > 0 ? windActSum / windFcSum : 1;
      const solarRatio = solarFcSum > 0 ? solarActSum / solarFcSum : 1;

      // Compute per-station scaling factors
      const stationScales: Record<string, number> = {};
      for (const station of allStations) {
        const fcSum = stationFcSums[station];
        const actSum = stationActSums[station];
        if (fcSum > 0.1) {
          // Scale factor: actual/forecast (e.g., 1.05 means actual was 5% higher than forecast)
          stationScales[station] = actSum / fcSum;
        } else {
          // No valid data for this station, use 1.0 (no scaling)
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
   * Analyze demand forecast against actuals - returns overall MAPE and peak/off-peak deviations
   */
  private analyzeDemandForecast(forecastFile: string): {
    mape: number;
    peakDeviation: number;   // % deviation for peak hours (positive = under-forecast)
    offpeakDeviation: number; // % deviation for off-peak hours
  } {
    if (!existsSync(forecastFile)) {
      return { mape: 100, peakDeviation: 0, offpeakDeviation: 0 };
    }

    try {
      const fcContent = readFileSync(forecastFile, 'utf-8');
      const fcData = parse(fcContent, { columns: true, skip_empty_lines: true });

      // Load demand actuals
      const demandDir = this.config.demandDataPath;
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

      // Peak hours: 09:00-21:00 (hours 9-20), Off-peak: 21:00-09:00 (hours 21-23, 0-8)
      const isPeakHour = (dateTimeStr: string): boolean => {
        // Parse hour from format "M/D/YYYY HH:mm"
        const timePart = dateTimeStr.split(' ')[1];
        if (!timePart) return false;
        const hour = parseInt(timePart.split(':')[0]);
        return hour >= 9 && hour < 21;
      };

      let totalError = 0;
      let count = 0;
      let peakFcSum = 0, peakActSum = 0, peakCount = 0;
      let offpeakFcSum = 0, offpeakActSum = 0, offpeakCount = 0;

      for (const fcRow of fcData) {
        const dt = fcRow.DateTimeEnding;
        const actRow = actMap.get(dt);
        if (!actRow) continue;

        const isPeak = isPeakHour(dt);

        for (const region of ['CLUZ', 'CVIS', 'CMIN']) {
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

      // Calculate directional deviations: positive = under-forecasting (need to scale up)
      // (Actual - Forecast) / Actual * 100
      const peakDeviation = peakCount > 0 ? (peakActSum - peakFcSum) / peakActSum * 100 : 0;
      const offpeakDeviation = offpeakCount > 0 ? (offpeakActSum - offpeakFcSum) / offpeakActSum * 100 : 0;

      return { mape, peakDeviation, offpeakDeviation };

    } catch (error) {
      return { mape: 100, peakDeviation: 0, offpeakDeviation: 0 };
    }
  }

  /**
   * Generate CFAC forecast (internal helper)
   */
  private async generateCfacForecast(
    startDate: string,
    endDate: string,
    outputFile: string,
    scaleWind: number,
    scaleSolar: number,
    verbose: boolean
  ): Promise<void> {
    const args = [
      this.cliPath,
      'cfac', 'forecast2',
      '-t', this.config.cfacDataPath,
      '-s', startDate,
      '-e', endDate,
      '-o', outputFile,
      '--cache', './weather_cache'
    ];

    // When using manual scaling, disable auto-calibration to prevent override
    if (scaleWind !== 0 || scaleSolar !== 0) {
      args.push('--no-auto-calibrate');
    }

    if (scaleWind !== 0) {
      args.push('--scale-wind', scaleWind.toString());
    }

    if (scaleSolar !== 0) {
      args.push('--scale-solar', scaleSolar.toString());
    }

    if (this.config.useXgboost) {
      args.push('--use-xgboost');
    }

    if (this.config.asymmetricLoss) {
      args.push('--asymmetric-loss');
    }

    if (this.config.biasCorrection) {
      args.push('--bias-correction');
    }

    execSync(`"${this.nodeCmd}" ${args.map(a => `"${a}"`).join(' ')}`, {
      cwd: this.projectRoot,
      encoding: 'utf-8',
      timeout: 1200000,
      stdio: verbose ? 'inherit' : 'pipe'
    });
  }

  /**
   * Generate demand forecast (internal helper)
   */
  private async generateDemandForecast(
    startDate: string,
    endDate: string,
    outputFile: string,
    verbose: boolean,
    scalePeak?: number,
    scaleOffpeak?: number
  ): Promise<void> {
    const args = [
      this.cliPath,
      'forecast',
      '-d', this.config.demandDataPath,
      '-s', startDate,
      '-e', endDate,
      '-o', outputFile,
      '--model', this.config.demandModel || 'hybrid',
      '--cache', './weather_cache'
    ];

    // Add peak/off-peak scaling if provided
    if (scalePeak !== undefined && scalePeak !== 0) {
      args.push('--scale-peak', scalePeak.toString());
    }
    if (scaleOffpeak !== undefined && scaleOffpeak !== 0) {
      args.push('--scale-offpeak', scaleOffpeak.toString());
    }

    execSync(`"${this.nodeCmd}" ${args.map(a => `"${a}"`).join(' ')}`, {
      cwd: this.projectRoot,
      encoding: 'utf-8',
      timeout: 600000,
      stdio: verbose ? 'inherit' : 'pipe'
    });
  }

  /**
   * Run CFAC forecast with calibrated scaling
   */
  private async runCfacForecastWithCalibration(
    asOfDate: string,
    startDate: string,
    endDate: string,
    horizon: 'daily' | 'weekly',
    calibration: CalibrationResult,
    verbose: boolean
  ): Promise<ForecastRun> {
    const startTime = Date.now();
    const runTime = DateTime.now().toISO()!;

    // New folder structure: {outputDir}/{horizon}/CFAC/cfac_{startDate}_{endDate}.csv
    const outputDir = join(this.config.outputDir, horizon, 'CFAC');
    if (!existsSync(outputDir)) {
      mkdirSync(outputDir, { recursive: true });
    }
    const outputFile = join(outputDir, `cfac_${startDate}_${endDate}.csv`);

    const insertRun = this.db.prepare(`
      INSERT INTO forecast_runs
      (run_date, run_time, forecast_type, horizon, forecast_start, forecast_end, status, output_file, scale_wind, scale_solar)
      VALUES (?, ?, 'cfac', ?, ?, ?, 'pending', ?, ?, ?)
    `);
    const result = insertRun.run(
      asOfDate, runTime, horizon, startDate, endDate, outputFile,
      calibration.windScale, calibration.solarScale
    );
    const runId = result.lastInsertRowid as number;

    try {
      if (verbose) {
        console.log(`   🌬️  Wind scale: ${calibration.windScale > 0 ? '+' : ''}${calibration.windScale}%`);
        console.log(`   ☀️  Solar scale: ${calibration.solarScale > 0 ? '+' : ''}${calibration.solarScale}%`);
      }

      await this.generateCfacForecast(
        startDate, endDate, outputFile,
        calibration.windScale, calibration.solarScale,
        verbose
      );

      // Apply per-station scaling to the forecast output
      if (Object.keys(calibration.stationScales).length > 0) {
        this.applyPerStationScaling(outputFile, calibration.stationScales, verbose);
      }

      let recordCount = 0;
      if (existsSync(outputFile)) {
        const content = readFileSync(outputFile, 'utf-8');
        recordCount = content.split('\n').length - 1;
      }

      const duration = Date.now() - startTime;

      const modelDesc = ['cfac-forecast2', `wind${calibration.windScale > 0 ? '+' : ''}${calibration.windScale}%`, `solar${calibration.solarScale > 0 ? '+' : ''}${calibration.solarScale}%`];

      this.db.prepare(`
        UPDATE forecast_runs
        SET status = 'completed', model_used = ?, records_generated = ?, duration_ms = ?
        WHERE id = ?
      `).run(modelDesc.join('+'), recordCount, duration, runId);

      if (verbose) {
        console.log(`   ✅ CFAC forecast: ${recordCount} records in ${(duration/1000).toFixed(1)}s`);
        console.log(`   📄 ${outputFile}`);
      }

      // Push to gateway if enabled (respects global VANTAGE_GATEWAY_ENABLED and config.pushToGateway)
      if (this.config.pushToGateway || isGatewayEnabled()) {
        if (verbose) {
          console.log(`   📤 Pushing to gateway...`);
        }
        await autoPushIfEnabled(outputFile, this.config.pushToGateway);
      }

      return this.getRunById(runId)!;

    } catch (error: any) {
      const duration = Date.now() - startTime;
      this.db.prepare(`
        UPDATE forecast_runs SET status = 'failed', error_message = ?, duration_ms = ? WHERE id = ?
      `).run(error.message, duration, runId);

      if (verbose) {
        console.log(`   ❌ CFAC forecast failed: ${error.message}`);
      }

      throw error;
    }
  }

  /**
   * Apply per-station scaling factors to a CFAC forecast CSV
   * This adjusts each station's values by their individual calibration factors
   */
  private applyPerStationScaling(
    outputFile: string,
    stationScales: Record<string, number>,
    verbose: boolean
  ): void {
    if (!existsSync(outputFile)) {
      return;
    }

    try {
      const content = readFileSync(outputFile, 'utf-8');
      const data = parse(content, { columns: true, skip_empty_lines: true });

      if (data.length === 0) {
        return;
      }

      const columns = Object.keys(data[0]);
      const stationsToScale = columns.filter(col =>
        col !== 'DateTimeEnding' && stationScales[col] !== undefined
      );

      let adjustedCount = 0;

      for (const row of data) {
        for (const station of stationsToScale) {
          const scale = stationScales[station];
          // Only apply if scale differs from 1.0 by more than 1%
          if (Math.abs(scale - 1.0) > 0.01) {
            const originalValue = parseFloat(row[station]) || 0;
            // Apply scaling, cap at 1.0 (capacity factor can't exceed 100%)
            const scaledValue = Math.min(1.0, Math.max(0, originalValue * scale));
            row[station] = scaledValue.toFixed(4);
            adjustedCount++;
          }
        }
      }

      // Write back to file
      const header = columns.join(',');
      const rows = data.map((row: any) => columns.map(col => row[col]).join(','));
      const newContent = [header, ...rows].join('\n') + '\n';

      writeFileSync(outputFile, newContent, 'utf-8');

      if (verbose && adjustedCount > 0) {
        const scaledStations = Object.entries(stationScales)
          .filter(([_, scale]) => Math.abs(scale - 1.0) > 0.01)
          .length;
        console.log(`   📊 Applied per-station scaling: ${scaledStations} stations, ${adjustedCount} values adjusted`);
      }

    } catch (error: any) {
      if (verbose) {
        console.log(`   ⚠️  Per-station scaling failed: ${error.message}`);
      }
    }
  }

  /**
   * Run demand forecast with optional calibrated peak/off-peak scaling
   */
  private async runDemandForecast(
    asOfDate: string,
    startDate: string,
    endDate: string,
    horizon: 'daily' | 'weekly',
    verbose: boolean,
    calibration?: CalibrationResult
  ): Promise<ForecastRun> {
    const startTime = Date.now();
    const runTime = DateTime.now().toISO()!;

    // New folder structure: {outputDir}/{horizon}/Demand/demand_{startDate}_{endDate}.csv
    const outputDir = join(this.config.outputDir, horizon, 'Demand');
    if (!existsSync(outputDir)) {
      mkdirSync(outputDir, { recursive: true });
    }
    const outputFile = join(outputDir, `demand_${startDate}_${endDate}.csv`);

    const insertRun = this.db.prepare(`
      INSERT INTO forecast_runs (run_date, run_time, forecast_type, horizon, forecast_start, forecast_end, status, output_file)
      VALUES (?, ?, 'demand', ?, ?, ?, 'pending', ?)
    `);
    const result = insertRun.run(asOfDate, runTime, horizon, startDate, endDate, outputFile);
    const runId = result.lastInsertRowid as number;

    try {
      // Extract peak/off-peak scaling from calibration if available
      const scalePeak = calibration?.demandPeakScale;
      const scaleOffpeak = calibration?.demandOffpeakScale;

      if (verbose && (scalePeak || scaleOffpeak)) {
        console.log(`   📊 Peak scale: ${scalePeak && scalePeak > 0 ? '+' : ''}${scalePeak || 0}%`);
        console.log(`   📊 Off-peak scale: ${scaleOffpeak && scaleOffpeak > 0 ? '+' : ''}${scaleOffpeak || 0}%`);
      }

      await this.generateDemandForecast(startDate, endDate, outputFile, verbose, scalePeak, scaleOffpeak);

      let recordCount = 0;
      if (existsSync(outputFile)) {
        const content = readFileSync(outputFile, 'utf-8');
        recordCount = content.split('\n').length - 1;
      }

      const duration = Date.now() - startTime;

      // Build model description including scaling info
      const modelParts: string[] = [this.config.demandModel || 'hybrid'];
      if (scalePeak && scalePeak !== 0) {
        modelParts.push(`peak${scalePeak > 0 ? '+' : ''}${scalePeak}%`);
      }
      if (scaleOffpeak && scaleOffpeak !== 0) {
        modelParts.push(`offpeak${scaleOffpeak > 0 ? '+' : ''}${scaleOffpeak}%`);
      }

      this.db.prepare(`
        UPDATE forecast_runs
        SET status = 'completed', model_used = ?, records_generated = ?, duration_ms = ?
        WHERE id = ?
      `).run(modelParts.join('+'), recordCount, duration, runId);

      if (verbose) {
        console.log(`   ✅ Demand forecast: ${recordCount} records in ${(duration/1000).toFixed(1)}s`);
        console.log(`   📄 ${outputFile}`);
      }

      // Push to gateway if enabled (respects global VANTAGE_GATEWAY_ENABLED and config.pushToGateway)
      if (this.config.pushToGateway || isGatewayEnabled()) {
        if (verbose) {
          console.log(`   📤 Pushing to gateway...`);
        }
        await autoPushIfEnabled(outputFile, this.config.pushToGateway);
      }

      return this.getRunById(runId)!;

    } catch (error: any) {
      const duration = Date.now() - startTime;
      this.db.prepare(`
        UPDATE forecast_runs SET status = 'failed', error_message = ?, duration_ms = ? WHERE id = ?
      `).run(error.message, duration, runId);

      if (verbose) {
        console.log(`   ❌ Demand forecast failed: ${error.message}`);
      }

      throw error;
    }
  }

  /**
   * Legacy methods for backwards compatibility
   */
  async runDailyForecast(
    asOfDate: string,
    options?: { forecastType?: 'demand' | 'cfac' | 'both'; verbose?: boolean }
  ): Promise<{ demand?: ForecastRun; cfac?: ForecastRun }> {
    const result = await this.runCalibratedForecasts(asOfDate, {
      ...options,
      horizon: 'daily'
    });
    return {
      demand: result.forecasts.demand?.[0],
      cfac: result.forecasts.cfac?.[0]
    };
  }

  async runWeeklyForecast(
    asOfDate: string,
    options?: { forecastType?: 'demand' | 'cfac' | 'both'; verbose?: boolean }
  ): Promise<{ demand?: ForecastRun; cfac?: ForecastRun }> {
    const result = await this.runCalibratedForecasts(asOfDate, {
      ...options,
      horizon: 'weekly'
    });
    return {
      demand: result.forecasts.demand?.[0],
      cfac: result.forecasts.cfac?.[0]
    };
  }

  /**
   * Get a run by ID
   */
  private getRunById(id: number): ForecastRun | null {
    return this.db.prepare('SELECT * FROM forecast_runs WHERE id = ?').get(id) as ForecastRun | null;
  }

  /**
   * Get last calibration result
   */
  getLastCalibration(): CalibrationResult | null {
    return this.lastCalibration;
  }

  /**
   * Get calibration history
   */
  getCalibrationHistory(limit: number = 10): any[] {
    return this.db.prepare(`
      SELECT * FROM calibration_history ORDER BY created_at DESC LIMIT ?
    `).all(limit) as any[];
  }

  /**
   * Get summary of all runs
   */
  getRunsSummary(): {
    total: number;
    completed: number;
    evaluated: number;
    failed: number;
    avgMape?: number;
  } {
    const stats = this.db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN status = 'evaluated' THEN 1 ELSE 0 END) as evaluated,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
      FROM forecast_runs
    `).get() as any;

    const avgMape = this.db.prepare(`
      SELECT AVG(mape) as avg_mape FROM forecast_evaluations
    `).get() as { avg_mape: number | null };

    return {
      ...stats,
      avgMape: avgMape.avg_mape ?? undefined
    };
  }

  /**
   * Run as background service
   */
  async runAsService(options?: {
    runHour?: number;
    interval?: number;
  }): Promise<void> {
    const runHour = options?.runHour ?? 6;
    const interval = (options?.interval ?? 60) * 60 * 1000;

    console.log(`🚀 Forecast Scheduler Service started`);
    console.log(`   Will run daily at ${runHour}:00`);
    console.log(`   Checking every ${interval / 60000} minutes`);
    console.log(`   Calibration: ${this.config.calibrationDays} days, ±${this.config.calibrationThreshold}% threshold`);
    console.log(`   Gateway push: ${this.config.pushToGateway || isGatewayEnabled() ? 'ENABLED' : 'disabled'}`);

    let lastRunDate: string | null = null;

    const checkAndRun = async () => {
      const now = DateTime.now();
      const today = now.toISODate()!;

      if (now.hour >= runHour && lastRunDate !== today) {
        console.log(`\n⏰ Scheduled run triggered at ${now.toISO()}`);

        try {
          await this.runCalibratedForecasts(today, {
            horizon: 'both',
            forecastType: 'both',
            verbose: true
          });
          lastRunDate = today;
        } catch (error: any) {
          console.error(`❌ Scheduled run failed: ${error.message}`);
        }
      }
    };

    await checkAndRun();
    setInterval(checkAndRun, interval);
  }

  close(): void {
    this.db.close();
  }
}
