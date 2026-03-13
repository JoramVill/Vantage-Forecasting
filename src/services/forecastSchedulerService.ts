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
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync, statSync } from 'fs';
import { parse } from 'csv-parse/sync';
import { pushFileToGateway, isGatewayEnabled, type ForecastCategory, type PushResult, type Geography } from './sftpPushService.js';
import { createHash } from 'crypto';

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
  calibrationPeriod: { start: string; end: string };  // CFAC calibration period
  demandCalibrationPeriod?: { start: string; end: string };  // Demand calibration period (if different)
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
  demandGeography?: 'regional' | 'zonal' | 'both';  // Geography mode for demand forecasts
  useDb?: boolean;       // Use database as training data source
  dataDbPath?: string;   // Database path for training data (different from dbPath which is scheduler db)
  regionalDbPath?: string;  // Regional demand database path (iload.db)
  zonalDbPath?: string;     // Zonal demand database path (iload_zonal.db)
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

  // New: Configurable run times (PHT)
  runTimes?: string[];           // e.g., ['06:00', '18:00']
  runDays?: number[];            // 1-7 (1=Monday)

  // New: Weather refresh
  weatherMaxAgeHours?: number;   // Default: 6
  weatherRefreshMode?: 'auto' | 'always' | 'never';

  // New: Archiving
  archiveEnabled?: boolean;
  archiveRetentionDays?: number; // Default: 90

  // New: Gateway naming
  gatewayNaming?: 'gateway' | 'legacy';  // Use DA_DEM_* or FC_DEM_*
}

interface SchedulerConfigDB {
  id: number;
  enabled: boolean;
  run_time_morning: string;
  run_time_evening: string | null;
  run_days: string;  // Comma-separated
  forecast_types: string;  // Comma-separated
  horizons: string;  // Comma-separated
  demand_geography: 'regional' | 'zonal' | 'both';  // Geography mode for demand forecasts
  weather_max_age_hours: number;
  auto_push_gateway: boolean;
  archive_retention_days: number;
  updated_at: string;
}

// Zonal demand columns (14 zones)
const ZONAL_COLUMNS = ['01NLUZ', '02METRO', '03SLUZ', '04LEYTE', '05CEBU', '06NEGROS', '07BOHOL', '08PANAY', '09NWMIN', '10LANAO', '11NCMIN', '12NEMIN', '13SEMIN', '14SWMIN'];
// Regional demand columns (3 regions)
const REGIONAL_COLUMNS = ['CLUZ', 'CVIS', 'CMIN'];

export class ForecastSchedulerService {
  private db: Database.Database;
  private config: SchedulerConfig;
  private nodeCmd: string;
  private cliPath: string;
  private projectRoot: string;
  private lastCalibration: CalibrationResult | null = null;
  private isZonalData: boolean | null = null;  // Cache the data format detection

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

    // Load stored scheduler config from database if not explicitly set
    // This connects the GUI settings to the scheduler service
    const storedConfig = this.loadSchedulerConfig();
    if (storedConfig) {
      if (this.config.pushToGateway === undefined && storedConfig.auto_push_gateway) {
        this.config.pushToGateway = true;
      }
      if (this.config.demandGeography === undefined) {
        this.config.demandGeography = storedConfig.demand_geography;
      }
    }

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
        gateway_path TEXT,
        gateway_category TEXT,
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

      -- Scheduler configuration (singleton table)
      CREATE TABLE IF NOT EXISTS scheduler_config (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        enabled INTEGER DEFAULT 0,
        run_time_morning TEXT DEFAULT '06:00',
        run_time_evening TEXT DEFAULT '18:00',
        run_days TEXT DEFAULT '1,2,3,4,5,6,7',
        forecast_types TEXT DEFAULT 'demand,cfac',
        horizons TEXT DEFAULT 'daily,weekly',
        demand_geography TEXT DEFAULT 'regional',
        weather_max_age_hours INTEGER DEFAULT 6,
        auto_push_gateway INTEGER DEFAULT 1,
        archive_retention_days INTEGER DEFAULT 90,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      );

      -- Migration: Add demand_geography column if it doesn't exist
      -- This is a safe operation that will fail silently if the column already exists

      -- Forecast archive tracking
      CREATE TABLE IF NOT EXISTS forecast_archive (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER NOT NULL,
        archive_date TEXT NOT NULL,
        forecast_date TEXT NOT NULL,
        horizon TEXT NOT NULL,
        forecast_type TEXT NOT NULL,
        local_path TEXT NOT NULL,
        gateway_path TEXT,
        file_size_bytes INTEGER,
        checksum TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (run_id) REFERENCES forecast_runs(id)
      );

      -- Hourly demand forecast values
      CREATE TABLE IF NOT EXISTS demand_forecast_hourly (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER NOT NULL,
        datetime TEXT NOT NULL,
        region TEXT NOT NULL,
        forecast_mw REAL NOT NULL,
        actual_mw REAL,
        error_mw REAL,
        error_pct REAL,
        FOREIGN KEY (run_id) REFERENCES forecast_runs(id)
      );

      -- Hourly CFAC forecast values
      CREATE TABLE IF NOT EXISTS cfac_forecast_hourly (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER NOT NULL,
        datetime TEXT NOT NULL,
        station_code TEXT NOT NULL,
        station_type TEXT NOT NULL,
        forecast_cf REAL NOT NULL,
        actual_cf REAL,
        error_cf REAL,
        error_pct REAL,
        FOREIGN KEY (run_id) REFERENCES forecast_runs(id)
      );

      CREATE INDEX IF NOT EXISTS idx_forecast_runs_date ON forecast_runs(run_date);
      CREATE INDEX IF NOT EXISTS idx_forecast_runs_status ON forecast_runs(status);
      CREATE INDEX IF NOT EXISTS idx_archive_date ON forecast_archive(archive_date);
      CREATE INDEX IF NOT EXISTS idx_archive_forecast_date ON forecast_archive(forecast_date);
      CREATE INDEX IF NOT EXISTS idx_demand_hourly_run ON demand_forecast_hourly(run_id);
      CREATE INDEX IF NOT EXISTS idx_demand_hourly_dt ON demand_forecast_hourly(datetime);
      CREATE INDEX IF NOT EXISTS idx_cfac_hourly_run ON cfac_forecast_hourly(run_id);
      CREATE INDEX IF NOT EXISTS idx_cfac_hourly_dt ON cfac_forecast_hourly(datetime);
    `);

    // Migration: Add demand_geography column if it doesn't exist (for existing databases)
    try {
      const tableInfo = this.db.prepare('PRAGMA table_info(scheduler_config)').all() as { name: string }[];
      const hasGeographyColumn = tableInfo.some(col => col.name === 'demand_geography');
      if (!hasGeographyColumn) {
        this.db.exec(`ALTER TABLE scheduler_config ADD COLUMN demand_geography TEXT DEFAULT 'regional'`);
      }
    } catch {
      // Column likely already exists or table doesn't exist yet (will be created above)
    }

    // Migration: Add missing columns to forecast_runs table (for existing databases)
    try {
      const forecastRunsInfo = this.db.prepare('PRAGMA table_info(forecast_runs)').all() as { name: string }[];
      const columnNames = forecastRunsInfo.map(col => col.name);

      if (!columnNames.includes('gateway_path')) {
        this.db.exec('ALTER TABLE forecast_runs ADD COLUMN gateway_path TEXT');
      }
      if (!columnNames.includes('gateway_category')) {
        this.db.exec('ALTER TABLE forecast_runs ADD COLUMN gateway_category TEXT');
      }
      if (!columnNames.includes('output_file')) {
        this.db.exec('ALTER TABLE forecast_runs ADD COLUMN output_file TEXT');
      }
      if (!columnNames.includes('scale_wind')) {
        this.db.exec('ALTER TABLE forecast_runs ADD COLUMN scale_wind REAL');
      }
      if (!columnNames.includes('scale_solar')) {
        this.db.exec('ALTER TABLE forecast_runs ADD COLUMN scale_solar REAL');
      }
    } catch {
      // Columns likely already exist or table doesn't exist yet (will be created above)
    }
  }

  /**
   * Detect if demand data is in zonal format (14 zones) vs regional format (3 regions)
   * Checks the first CSV file in the demand data path for column headers.
   * Result is cached for the lifetime of the service instance.
   */
  private detectDemandDataFormat(): boolean {
    if (this.isZonalData !== null) {
      return this.isZonalData;
    }

    try {
      const demandDir = this.config.demandDataPath;
      if (!existsSync(demandDir)) {
        this.isZonalData = false;
        return false;
      }

      // Find first CSV file
      const files = readdirSync(demandDir).filter(f => f.endsWith('.csv'));
      if (files.length === 0) {
        this.isZonalData = false;
        return false;
      }

      // Read header of first file
      const content = readFileSync(join(demandDir, files[0]), 'utf-8');
      const headerLine = content.split('\n')[0] || '';
      const columns = headerLine.split(',').map(c => c.trim());

      // Check for zonal columns (e.g., 01NLUZ, 02METRO, etc.)
      const hasZonalColumns = ZONAL_COLUMNS.some(zc => columns.includes(zc));
      // Check for regional columns (CLUZ, CVIS, CMIN)
      const hasRegionalColumns = REGIONAL_COLUMNS.some(rc => columns.includes(rc));

      // Prefer zonal detection if both are present (shouldn't happen), otherwise use what's found
      this.isZonalData = hasZonalColumns && !hasRegionalColumns;
      return this.isZonalData;
    } catch {
      this.isZonalData = false;
      return false;
    }
  }

  /**
   * Get the appropriate demand columns based on data format
   */
  private getDemandColumns(): string[] {
    return this.detectDemandDataFormat() ? ZONAL_COLUMNS : REGIONAL_COLUMNS;
  }

  /**
   * MAIN ENTRY POINT: Run calibrated forecasts
   *
   * This method:
   * 1. Runs calibration to determine optimal wind/solar scaling (or uses saved calibration)
   * 2. Verifies calibration is within threshold
   * 3. Generates production forecasts with calibrated values
   */
  async runCalibratedForecasts(
    asOfDate: string,
    options?: {
      forecastType?: 'demand' | 'cfac' | 'both';
      horizon?: 'daily' | 'weekly' | 'both';
      verbose?: boolean;
      loadCalibratorPath?: string;  // Path to saved calibrator model (skips auto-training)
      trainingDays?: number;  // Number of days for auto-calibration training (default: 30)
      suffix?: string;  // Suffix to append to archive filenames (e.g., "_v2")
      overwrite?: boolean;  // Overwrite existing archives
      useCalibrationId?: number;  // Use saved calibration by ID (skips calibration phase)
      useMostRecentCalibration?: boolean;  // Use most recent saved calibration
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

    // Step 1: Get calibration (from saved or run new)
    let calibration: CalibrationResult;

    if (options?.useCalibrationId) {
      // Use specific saved calibration
      const saved = this.getCalibrationById(options.useCalibrationId);
      if (!saved) {
        throw new Error(`Calibration ID ${options.useCalibrationId} not found`);
      }
      calibration = saved;
      if (verbose) {
        console.log(`\n📋 Using saved calibration #${options.useCalibrationId}`);
        console.log(`   Wind: ${calibration.windScale >= 0 ? '+' : ''}${calibration.windScale}%`);
        console.log(`   Solar: ${calibration.solarScale >= 0 ? '+' : ''}${calibration.solarScale}%`);
        console.log(`   Period: ${calibration.calibrationPeriod.start} to ${calibration.calibrationPeriod.end}`);
        console.log(`   Converged: ${calibration.withinThreshold ? 'Yes ✓' : 'No'}`);
      }
    } else if (options?.useMostRecentCalibration) {
      // Use most recent saved calibration
      const recent = this.getMostRecentCalibration();
      if (!recent) {
        throw new Error('No saved calibration found. Run calibration first or remove --use-saved-calibration flag.');
      }
      calibration = recent.calibration;
      if (verbose) {
        console.log(`\n📋 Using most recent calibration #${recent.id} (${new Date(recent.createdAt).toLocaleString()})`);
        console.log(`   Wind: ${calibration.windScale >= 0 ? '+' : ''}${calibration.windScale}%`);
        console.log(`   Solar: ${calibration.solarScale >= 0 ? '+' : ''}${calibration.solarScale}%`);
        console.log(`   Period: ${calibration.calibrationPeriod.start} to ${calibration.calibrationPeriod.end}`);
        console.log(`   Converged: ${calibration.withinThreshold ? 'Yes ✓' : 'No'}`);
      }
    } else {
      // Run new calibration (auto-detects most recent actual data)
      calibration = await this.runCalibration(asOfDate, verbose, options?.trainingDays);
    }

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
    const errors: string[] = [];  // Track errors so one failure doesn't stop others

    const asOf = DateTime.fromISO(asOfDate);

    if (verbose) {
      console.log('\n───────────────────────────────────────────────────────────────────────────────');
      console.log('                         GENERATING PRODUCTION FORECASTS                        ');
      console.log('───────────────────────────────────────────────────────────────────────────────');
    }

    // PHASE 1 OPTIMIZATION: When running both horizons, daily runs first to populate weather cache,
    // then weekly reuses the cached data. This reduces API calls and speeds up the second forecast.

    // Determine horizons to generate
    const horizonsToRun = horizon === 'both' ? ['daily', 'weekly'] as const : [horizon] as const;

    // Track if we've already fetched weather for this date (for cache reuse optimization)
    let demandWeatherFetched = false;
    let cfacWeatherFetched = false;

    for (const currentHorizon of horizonsToRun) {
      const startDate = asOf.plus({ days: 1 }).toISODate()!;
      const endDate = currentHorizon === 'daily'
        ? startDate
        : asOf.plus({ days: 7 }).toISODate()!;

      if (verbose) {
        if (currentHorizon === 'daily') {
          console.log(`\n📅 Daily forecast: ${startDate}`);
        } else {
          console.log(`\n📅 Weekly forecast: ${startDate} to ${endDate}`);
        }
      }

      // Generate demand forecast
      if (forecastType === 'demand' || forecastType === 'both') {
        try {
          const run = await this.runDemandForecast(
            asOfDate, startDate, endDate, currentHorizon, verbose, calibration,
            options?.loadCalibratorPath, options?.suffix, options?.overwrite,
            demandWeatherFetched // Pass flag to indicate if weather cache can be reused
          );
          forecasts.demand!.push(run);
          demandWeatherFetched = true; // Mark weather as fetched for next horizon
        } catch (error: any) {
          errors.push(`${currentHorizon === 'daily' ? 'Daily' : 'Weekly'} demand: ${error.message}`);
          if (verbose) {
            console.log(`   ⚠️  ${currentHorizon === 'daily' ? 'Daily' : 'Weekly'} demand forecast failed: ${error.message}`);
          }
        }
      }

      // Generate CFAC forecast
      if (forecastType === 'cfac' || forecastType === 'both') {
        try {
          const run = await this.runCfacForecastWithCalibration(
            asOfDate, startDate, endDate, currentHorizon, calibration, verbose,
            options?.suffix, options?.overwrite,
            cfacWeatherFetched // Pass flag to indicate if weather cache can be reused
          );
          forecasts.cfac!.push(run);
          cfacWeatherFetched = true; // Mark weather as fetched for next horizon
        } catch (error: any) {
          errors.push(`${currentHorizon === 'daily' ? 'Daily' : 'Weekly'} CFAC: ${error.message}`);
          if (verbose) {
            console.log(`   ⚠️  ${currentHorizon === 'daily' ? 'Daily' : 'Weekly'} CFAC forecast failed: ${error.message}`);
          }
        }
      }
    }

    // Report any errors that occurred
    if (errors.length > 0 && verbose) {
      console.log(`\n⚠️  Some forecasts failed:`);
      for (const err of errors) {
        console.log(`   - ${err}`);
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
   *
   * Auto-detects the most recent actual data date from CFAC files.
   * The training period counts back from the most recent actual data date.
   */
  async runCalibration(
    asOfDate: string,
    verbose: boolean = true,
    trainingDays?: number
  ): Promise<CalibrationResult> {
    // Use provided values or fall back to config defaults
    const calibDays = trainingDays || this.config.calibrationDays!;
    const threshold = this.config.calibrationThreshold!;
    // Use higher max iterations to ensure convergence
    const maxIterations = Math.max(this.config.maxCalibrationIterations || 3, 10);

    // Auto-detect the most recent actual data dates for CFAC and demand separately
    const cfacMostRecentDate = this.findMostRecentActualDate(this.config.cfacDataPath);
    const demandMostRecentDate = this.findMostRecentActualDate(this.config.demandDataPath);

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
        await this.generateCfacForecast(
          cfacCalibStart!, cfacCalibEnd!, calibForecastFile,
          windScale, solarScale, false, 'cache'
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
          // For calibration, use regional format (or primary geography if not 'both')
          const calibGeography = this.config.demandGeography === 'zonal' ? 'zonal' : 'regional';
          await this.generateDemandForecast(
            demandCalibStart, demandCalibEnd, demandCalibFile, calibGeography, false,
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
   * Find the most recent actual data date from data files
   * Scans all CSV files and finds the latest DateTimeEnding value
   *
   * @param dataPath - Path to the data directory (defaults to CFAC data path)
   * @returns ISO date string (YYYY-MM-DD) of the most recent actual data, or null if not found
   */
  findMostRecentActualDate(dataPath?: string): string | null {
    try {
      const actualsDir = dataPath || this.config.cfacDataPath;

      if (!existsSync(actualsDir)) {
        return null;
      }

      const actualFiles = readdirSync(actualsDir).filter(f => f.endsWith('.csv'));

      if (actualFiles.length === 0) {
        return null;
      }

      let mostRecentDate: DateTime | null = null;

      for (const file of actualFiles) {
        try {
          const content = readFileSync(join(actualsDir, file), 'utf-8');
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

        // Use the appropriate columns based on data format (zonal or regional)
        for (const region of this.getDemandColumns()) {
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
   * @param weatherRefreshMode - Override weather refresh mode ('cache' for historical dates)
   */
  private async generateCfacForecast(
    startDate: string,
    endDate: string,
    outputFile: string,
    scaleWind: number,
    scaleSolar: number,
    verbose: boolean,
    weatherRefreshMode?: 'cache' | 'refresh' | 'force-refresh'
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

    // Add database source flag if enabled
    if (this.config.useDb) {
      args.push('--use-db');
      if (this.config.dataDbPath) {
        args.push('--db', this.config.dataDbPath);
      }
    }

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

    // Add weather max age if configured
    if (this.config.weatherMaxAgeHours !== undefined) {
      args.push('--weather-max-age', this.config.weatherMaxAgeHours.toString());
    }

    // Add weather refresh mode - use 'cache' for historical dates to avoid unnecessary API calls
    const refreshMode = weatherRefreshMode || this.config.weatherRefreshMode || 'refresh';
    if (refreshMode !== 'refresh') {
      // Map config values to CLI values
      const cliMode = refreshMode === 'never' ? 'cache' : refreshMode === 'always' ? 'force-refresh' : refreshMode;
      args.push('--weather-refresh-mode', cliMode);
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
    geography: 'regional' | 'zonal',
    verbose: boolean,
    scalePeak?: number,
    scaleOffpeak?: number,
    loadCalibratorPath?: string
  ): Promise<void> {
    // Determine data source path based on geography and database configuration
    let dataSourcePath: string;

    if (this.config.useDb) {
      // Use database source - select appropriate database based on geography
      if (geography === 'zonal' && this.config.zonalDbPath) {
        dataSourcePath = this.config.zonalDbPath;
      } else if (geography === 'regional' && this.config.regionalDbPath) {
        dataSourcePath = this.config.regionalDbPath;
      } else {
        // Fallback to generic dataDbPath
        dataSourcePath = this.config.dataDbPath || this.config.demandDataPath;
      }
    } else {
      // Use CSV source
      dataSourcePath = this.config.demandDataPath;
    }

    const args = [
      this.cliPath,
      'forecast',
      '-d', dataSourcePath,
      '-s', startDate,
      '-e', endDate,
      '-o', outputFile,
      '--model', this.config.demandModel || 'hybrid',
      '--cache', './weather_cache'
    ];

    // Add database source flag if enabled
    if (this.config.useDb) {
      args.push('--use-db');
    }

    // Add --zonal flag based on geography parameter (not file detection)
    if (geography === 'zonal') {
      args.push('--zonal');
    }

    // Add peak/off-peak scaling if provided
    if (scalePeak !== undefined && scalePeak !== 0) {
      args.push('--scale-peak', scalePeak.toString());
    }
    if (scaleOffpeak !== undefined && scaleOffpeak !== 0) {
      args.push('--scale-offpeak', scaleOffpeak.toString());
    }

    // Add calibrator path if provided (uses saved model instead of auto-training)
    if (loadCalibratorPath) {
      args.push('--load-calibrator', loadCalibratorPath);
    }

    // Note: Weather caching is handled automatically by the weatherService
    // The demand forecast command uses --cache <dir> for cache directory (already set above)
    // --weather-refresh-mode and --weather-max-age are only valid for cfac forecast2

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
    verbose: boolean,
    suffix?: string,
    overwrite?: boolean,
    weatherCacheAvailable?: boolean  // PHASE 1: Indicates weather already fetched by previous horizon
  ): Promise<ForecastRun> {
    const startTime = Date.now();
    const runTime = DateTime.now().toISO()!;

    // New folder structure: {outputDir}/{horizon}/CFAC/{horizon_prefix}_mhcf_{dates}.csv
    const outputDir = join(this.config.outputDir, horizon, 'CFAC');
    if (!existsSync(outputDir)) {
      mkdirSync(outputDir, { recursive: true });
    }
    // Use consistent naming: da_mhcf_YYYY-MM-DD.csv or wa_mhcf_YYYY-MM-DD_YYYY-MM-DD.csv
    const horizonPrefix = horizon === 'daily' ? 'da' : 'wa';
    const outputFilename = horizon === 'daily'
      ? `${horizonPrefix}_mhcf_${startDate}.csv`
      : `${horizonPrefix}_mhcf_${startDate}_${endDate}.csv`;
    const outputFile = join(outputDir, outputFilename);

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

      // PHASE 1 OPTIMIZATION: Determine weather refresh mode
      // Priority: 1) Cache available from previous horizon, 2) Historical forecast, 3) Normal refresh
      const forecastEnd = DateTime.fromISO(endDate);
      const today = DateTime.now().startOf('day');
      const isHistoricalForecast = forecastEnd < today;

      let weatherMode: 'cache' | 'refresh' | 'force-refresh' | undefined;
      if (weatherCacheAvailable) {
        weatherMode = 'cache'; // Reuse weather from previous horizon (daily->weekly optimization)
        if (verbose) {
          console.log('   ♻️  Reusing weather cache from previous forecast');
        }
      } else if (isHistoricalForecast) {
        weatherMode = 'cache'; // Historical dates should use cached data
      }

      await this.generateCfacForecast(
        startDate, endDate, outputFile,
        calibration.windScale, calibration.solarScale,
        verbose, weatherMode
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

      // Store hourly forecasts in database
      this.storeHourlyForecasts(runId, outputFile, 'cfac');

      // Archive forecast if enabled
      let archivePath: string | null = null;
      if (this.config.archiveEnabled !== false) {  // Default: enabled
        archivePath = this.archiveForecast(outputFile, asOfDate, horizon, 'cfac', suffix, overwrite);
        if (archivePath && verbose) {
          console.log(`   📦 Archived: ${archivePath}`);
        }
      }

      // Push to gateway if enabled (respects global VANTAGE_GATEWAY_ENABLED and config.pushToGateway)
      // CFAC forecasts don't use geography parameter (only demand files do)
      let gatewayPath: string | null = null;
      let gatewayCategory: ForecastCategory | null = null;
      if (this.config.pushToGateway || isGatewayEnabled()) {
        if (verbose) {
          console.log(`   📤 Pushing to gateway...`);
        }
        try {
          gatewayCategory = this.getForecastCategory(horizon, 'cfac');
          // CFAC files don't use geography - pass undefined
          const pushResult: PushResult = await pushFileToGateway(outputFile, gatewayCategory, undefined);
          if (pushResult.success) {
            gatewayPath = pushResult.remotePath;
            if (verbose) {
              const method = pushResult.httpUpload ? 'HTTP' : 'SFTP';
              console.log(`   ✅ Pushed to gateway (${method}): ${gatewayPath}`);
            }
          } else if (verbose) {
            console.log(`   ⚠️  Gateway push failed: ${pushResult.error}`);
          }
        } catch (error: any) {
          if (verbose) {
            console.log(`   ⚠️  Gateway push error: ${error.message}`);
          }
        }
      }

      // Update run with gateway info
      if (gatewayPath || gatewayCategory) {
        this.db.prepare(`
          UPDATE forecast_runs SET gateway_path = ?, gateway_category = ? WHERE id = ?
        `).run(gatewayPath, gatewayCategory, runId);
      }

      // Record archive in database
      if (archivePath) {
        const targetDate = horizon === 'daily'
          ? DateTime.fromISO(asOfDate).plus({ days: 1 }).toISODate()!
          : DateTime.fromISO(asOfDate).plus({ days: 1 }).toISODate()!;

        const fileStats = statSync(archivePath);
        const checksum = this.calculateChecksum(archivePath);

        this.db.prepare(`
          INSERT INTO forecast_archive
          (run_id, archive_date, forecast_date, horizon, forecast_type, local_path, gateway_path, file_size_bytes, checksum)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(runId, asOfDate, targetDate, horizon, 'cfac', archivePath, gatewayPath, fileStats.size, checksum);
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
   * Handles both regional and zonal forecasts based on config.demandGeography
   */
  private async runDemandForecast(
    asOfDate: string,
    startDate: string,
    endDate: string,
    horizon: 'daily' | 'weekly',
    verbose: boolean,
    calibration?: CalibrationResult,
    loadCalibratorPath?: string,
    suffix?: string,
    overwrite?: boolean,
    weatherCacheAvailable?: boolean  // PHASE 1: Indicates weather already fetched by previous horizon
  ): Promise<ForecastRun> {
    const geography = this.config.demandGeography || 'regional';

    // If geography is "both", generate both regional and zonal forecasts
    if (geography === 'both') {
      if (verbose) {
        console.log(`   🌍 Generating both regional and zonal forecasts`);
      }

      // Generate regional forecast (fetches weather)
      const regionalRun = await this.runSingleDemandForecast(
        asOfDate, startDate, endDate, horizon, 'regional',
        verbose, calibration, loadCalibratorPath, suffix, overwrite, weatherCacheAvailable
      );

      // Generate zonal forecast (reuses weather cache from regional)
      await this.runSingleDemandForecast(
        asOfDate, startDate, endDate, horizon, 'zonal',
        verbose, calibration, loadCalibratorPath, suffix, overwrite, true // Weather already fetched
      );

      // Return the regional run as the primary result (for backward compatibility)
      return regionalRun;
    } else {
      // Generate single forecast (regional or zonal)
      return await this.runSingleDemandForecast(
        asOfDate, startDate, endDate, horizon, geography,
        verbose, calibration, loadCalibratorPath, suffix, overwrite, weatherCacheAvailable
      );
    }
  }

  /**
   * Run a single demand forecast (either regional or zonal)
   * Internal helper method called by runDemandForecast()
   */
  private async runSingleDemandForecast(
    asOfDate: string,
    startDate: string,
    endDate: string,
    horizon: 'daily' | 'weekly',
    geography: 'regional' | 'zonal',
    verbose: boolean,
    calibration?: CalibrationResult,
    loadCalibratorPath?: string,
    suffix?: string,
    overwrite?: boolean,
    weatherCacheAvailable?: boolean  // PHASE 1: Indicates weather already fetched
  ): Promise<ForecastRun> {
    const startTime = Date.now();
    const runTime = DateTime.now().toISO()!;

    // New folder structure: {outputDir}/{horizon}/Demand/{geography}/{horizon_prefix}_demand_{dates}.csv
    const outputDir = join(this.config.outputDir, horizon, 'Demand', geography);
    if (!existsSync(outputDir)) {
      mkdirSync(outputDir, { recursive: true });
    }
    // Use consistent naming with geography: da_demand_regional_YYYY-MM-DD.csv or da_demand_zonal_YYYY-MM-DD.csv
    const horizonPrefix = horizon === 'daily' ? 'da' : 'wa';
    const outputFilename = horizon === 'daily'
      ? `${horizonPrefix}_demand_${geography}_${startDate}.csv`
      : `${horizonPrefix}_demand_${geography}_${startDate}_${endDate}.csv`;
    const outputFile = join(outputDir, outputFilename);

    if (verbose) {
      console.log(`   🌐 Geography: ${geography}`);
    }

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

      await this.generateDemandForecast(startDate, endDate, outputFile, geography, verbose, scalePeak, scaleOffpeak, loadCalibratorPath);

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

      // Store hourly forecasts in database
      this.storeHourlyForecasts(runId, outputFile, 'demand');

      // Archive forecast if enabled
      let archivePath: string | null = null;
      if (this.config.archiveEnabled !== false) {  // Default: enabled
        archivePath = this.archiveForecast(outputFile, asOfDate, horizon, 'demand', suffix, overwrite);
        if (archivePath && verbose) {
          console.log(`   📦 Archived: ${archivePath}`);
        }
      }

      // Push to gateway if enabled (respects global VANTAGE_GATEWAY_ENABLED and config.pushToGateway)
      // PHASE 2: Pass explicit geography from forecast context to gateway
      let gatewayPath: string | null = null;
      let gatewayCategory: ForecastCategory | null = null;
      if (this.config.pushToGateway || isGatewayEnabled()) {
        if (verbose) {
          console.log(`   📤 Pushing to gateway (${geography})...`);
        }
        try {
          gatewayCategory = this.getForecastCategory(horizon, 'demand');
          // Pass explicit geography from forecast context - no filename parsing needed!
          const pushResult: PushResult = await pushFileToGateway(outputFile, gatewayCategory, geography as Geography);
          if (pushResult.success) {
            gatewayPath = pushResult.remotePath;
            if (verbose) {
              const method = pushResult.httpUpload ? 'HTTP' : 'SFTP';
              console.log(`   ✅ Pushed to gateway (${method}): ${gatewayPath}`);
            }
          } else if (verbose) {
            console.log(`   ⚠️  Gateway push failed: ${pushResult.error}`);
          }
        } catch (error: any) {
          if (verbose) {
            console.log(`   ⚠️  Gateway push error: ${error.message}`);
          }
        }
      }

      // Update run with gateway info
      if (gatewayPath || gatewayCategory) {
        this.db.prepare(`
          UPDATE forecast_runs SET gateway_path = ?, gateway_category = ? WHERE id = ?
        `).run(gatewayPath, gatewayCategory, runId);
      }

      // Record archive in database
      if (archivePath) {
        const targetDate = horizon === 'daily'
          ? DateTime.fromISO(asOfDate).plus({ days: 1 }).toISODate()!
          : DateTime.fromISO(asOfDate).plus({ days: 1 }).toISODate()!;

        const fileStats = statSync(archivePath);
        const checksum = this.calculateChecksum(archivePath);

        this.db.prepare(`
          INSERT INTO forecast_archive
          (run_id, archive_date, forecast_date, horizon, forecast_type, local_path, gateway_path, file_size_bytes, checksum)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(runId, asOfDate, targetDate, horizon, 'demand', archivePath, gatewayPath, fileStats.size, checksum);
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
   * Get calibration history with formatted display info
   */
  getCalibrationHistory(limit: number = 10): any[] {
    return this.db.prepare(`
      SELECT * FROM calibration_history ORDER BY created_at DESC LIMIT ?
    `).all(limit) as any[];
  }

  /**
   * Get calibration by ID
   */
  getCalibrationById(id: number): CalibrationResult | null {
    const row = this.db.prepare(`
      SELECT * FROM calibration_history WHERE id = ?
    `).get(id) as any;

    if (!row) return null;

    return {
      windScale: row.wind_scale,
      solarScale: row.solar_scale,
      windDeviation: row.wind_deviation,
      solarDeviation: row.solar_deviation,
      demandMape: row.demand_mape || 0,
      demandPeakDeviation: row.demand_peak_deviation || 0,
      demandOffpeakDeviation: row.demand_offpeak_deviation || 0,
      demandPeakScale: row.demand_peak_scale || 0,
      demandOffpeakScale: row.demand_offpeak_scale || 0,
      calibrationPeriod: {
        start: row.calibration_start,
        end: row.calibration_end
      },
      withinThreshold: row.within_threshold === 1,
      stationScales: {}
    };
  }

  /**
   * Get the most recent successful calibration
   */
  getMostRecentCalibration(): { id: number; calibration: CalibrationResult; createdAt: string } | null {
    const row = this.db.prepare(`
      SELECT * FROM calibration_history
      WHERE within_threshold = 1
      ORDER BY created_at DESC
      LIMIT 1
    `).get() as any;

    if (!row) {
      // Fall back to any calibration if no converged ones exist
      const anyRow = this.db.prepare(`
        SELECT * FROM calibration_history ORDER BY created_at DESC LIMIT 1
      `).get() as any;

      if (!anyRow) return null;

      return {
        id: anyRow.id,
        createdAt: anyRow.created_at,
        calibration: {
          windScale: anyRow.wind_scale,
          solarScale: anyRow.solar_scale,
          windDeviation: anyRow.wind_deviation,
          solarDeviation: anyRow.solar_deviation,
          demandMape: anyRow.demand_mape || 0,
          demandPeakDeviation: anyRow.demand_peak_deviation || 0,
          demandOffpeakDeviation: anyRow.demand_offpeak_deviation || 0,
          demandPeakScale: anyRow.demand_peak_scale || 0,
          demandOffpeakScale: anyRow.demand_offpeak_scale || 0,
          calibrationPeriod: { start: anyRow.calibration_start, end: anyRow.calibration_end },
          withinThreshold: anyRow.within_threshold === 1,
          stationScales: {}
        }
      };
    }

    return {
      id: row.id,
      createdAt: row.created_at,
      calibration: {
        windScale: row.wind_scale,
        solarScale: row.solar_scale,
        windDeviation: row.wind_deviation,
        solarDeviation: row.solar_deviation,
        demandMape: row.demand_mape || 0,
        demandPeakDeviation: row.demand_peak_deviation || 0,
        demandOffpeakDeviation: row.demand_offpeak_deviation || 0,
        demandPeakScale: row.demand_peak_scale || 0,
        demandOffpeakScale: row.demand_offpeak_scale || 0,
        calibrationPeriod: { start: row.calibration_start, end: row.calibration_end },
        withinThreshold: row.within_threshold === 1,
        stationScales: {}
      }
    };
  }

  /**
   * Format calibration for display
   */
  formatCalibrationForDisplay(row: any): string {
    const date = new Date(row.created_at).toLocaleDateString();
    const time = new Date(row.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const windSign = row.wind_scale >= 0 ? '+' : '';
    const solarSign = row.solar_scale >= 0 ? '+' : '';
    const converged = row.within_threshold ? '✓' : '○';

    return `[${row.id}] ${date} ${time} | Wind: ${windSign}${row.wind_scale}%, Solar: ${solarSign}${row.solar_scale}% | ${row.calibration_start} to ${row.calibration_end} ${converged}`;
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

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * SCHEDULER CONFIGURATION MANAGEMENT
   * ═══════════════════════════════════════════════════════════════════════════
   */

  /**
   * Load scheduler configuration from database
   */
  loadSchedulerConfig(): SchedulerConfigDB | null {
    const row = this.db.prepare('SELECT * FROM scheduler_config WHERE id = 1').get() as any;
    if (!row) return null;

    return {
      id: row.id,
      enabled: row.enabled === 1,
      run_time_morning: row.run_time_morning,
      run_time_evening: row.run_time_evening,
      run_days: row.run_days,
      forecast_types: row.forecast_types,
      horizons: row.horizons,
      demand_geography: row.demand_geography || 'regional',  // Default to regional for backward compatibility
      weather_max_age_hours: row.weather_max_age_hours,
      auto_push_gateway: row.auto_push_gateway === 1,
      archive_retention_days: row.archive_retention_days,
      updated_at: row.updated_at
    };
  }

  /**
   * Save scheduler configuration to database
   */
  saveSchedulerConfig(config: Partial<SchedulerConfigDB>): void {
    // Ensure singleton row exists
    this.db.prepare(`
      INSERT OR IGNORE INTO scheduler_config (id, enabled) VALUES (1, 0)
    `).run();

    // Build update query dynamically
    const fields: string[] = [];
    const values: any[] = [];

    if (config.enabled !== undefined) {
      fields.push('enabled = ?');
      values.push(config.enabled ? 1 : 0);
    }
    if (config.run_time_morning !== undefined) {
      fields.push('run_time_morning = ?');
      values.push(config.run_time_morning);
    }
    if (config.run_time_evening !== undefined) {
      fields.push('run_time_evening = ?');
      values.push(config.run_time_evening);
    }
    if (config.run_days !== undefined) {
      fields.push('run_days = ?');
      values.push(config.run_days);
    }
    if (config.forecast_types !== undefined) {
      fields.push('forecast_types = ?');
      values.push(config.forecast_types);
    }
    if (config.horizons !== undefined) {
      fields.push('horizons = ?');
      values.push(config.horizons);
    }
    if (config.demand_geography !== undefined) {
      fields.push('demand_geography = ?');
      values.push(config.demand_geography);
    }
    if (config.weather_max_age_hours !== undefined) {
      fields.push('weather_max_age_hours = ?');
      values.push(config.weather_max_age_hours);
    }
    if (config.auto_push_gateway !== undefined) {
      fields.push('auto_push_gateway = ?');
      values.push(config.auto_push_gateway ? 1 : 0);
    }
    if (config.archive_retention_days !== undefined) {
      fields.push('archive_retention_days = ?');
      values.push(config.archive_retention_days);
    }

    if (fields.length > 0) {
      fields.push('updated_at = CURRENT_TIMESTAMP');
      this.db.prepare(`
        UPDATE scheduler_config SET ${fields.join(', ')} WHERE id = 1
      `).run(...values);
    }
  }

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * ARCHIVE MANAGEMENT
   * ═══════════════════════════════════════════════════════════════════════════
   */

  /**
   * Get gateway-compatible filename based on configuration
   * @param horizon - 'daily' or 'weekly'
   * @param type - 'demand' or 'cfac'
   * @param targetDate - Date being forecasted (YYYY-MM-DD)
   * @param naming - Naming convention ('gateway' uses DA_/WA_ prefix, 'legacy' uses FC_)
   * @returns Filename string
   */
  getGatewayFilename(config: {
    horizon: 'daily' | 'weekly';
    type: 'demand' | 'cfac';
    startDate: string;
    endDate?: string;  // Required for weekly, optional for daily
    naming?: 'gateway' | 'legacy';
  }): string {
    const { horizon, type, startDate, endDate, naming = 'gateway' } = config;

    // Type code: demand or mhcf
    const typeCode = type === 'demand' ? 'demand' : 'mhcf';

    if (naming === 'legacy') {
      // Legacy naming: FC_DEM_YYYY-MM-DD.csv (backwards compatibility)
      const legacyTypeCode = type === 'demand' ? 'DEM' : 'MHCF';
      return `FC_${legacyTypeCode}_${startDate}.csv`;
    }

    // Gateway naming with distinct horizon prefixes:
    // Day-ahead: da_demand_YYYY-MM-DD.csv, da_mhcf_YYYY-MM-DD.csv
    // Week-ahead: wa_demand_YYYY-MM-DD_YYYY-MM-DD.csv, wa_mhcf_YYYY-MM-DD_YYYY-MM-DD.csv
    const horizonPrefix = horizon === 'daily' ? 'da' : 'wa';

    if (horizon === 'daily') {
      return `${horizonPrefix}_${typeCode}_${startDate}.csv`;
    } else {
      // Week-ahead includes both start and end dates
      const end = endDate || DateTime.fromISO(startDate).plus({ days: 6 }).toISODate()!;
      return `${horizonPrefix}_${typeCode}_${startDate}_${end}.csv`;
    }
  }

  /**
   * Get forecast category for gateway push based on horizon and type
   */
  private getForecastCategory(horizon: 'daily' | 'weekly', type: 'demand' | 'cfac'): ForecastCategory {
    if (horizon === 'daily') {
      return type === 'demand' ? 'day-ahead-demand' : 'day-ahead-mhcf';
    } else {
      return type === 'demand' ? 'week-ahead-demand' : 'week-ahead-mhcf';
    }
  }

  /**
   * Calculate SHA256 checksum for a file (synchronous)
   */
  private calculateChecksum(filePath: string): string {
    const hash = createHash('sha256');
    const content = readFileSync(filePath);
    hash.update(content);
    return hash.digest('hex');
  }

  /**
   * Archive a forecast file with gateway naming convention
   * Structure: output/archive/YYYY-MM/YYYY-MM-DD/DA_DEM_YYYY-MM-DD.csv
   *
   * @param outputFile - Source file path
   * @param asOfDate - As-of date (YYYY-MM-DD)
   * @param horizon - 'daily' or 'weekly'
   * @param type - 'demand' or 'cfac'
   * @param suffix - Optional suffix to append to filename (e.g., "_v2")
   * @param overwrite - If true, overwrite existing archive files
   * @returns Archive file path
   */
  archiveForecast(
    outputFile: string,
    asOfDate: string,
    horizon: 'daily' | 'weekly',
    type: 'demand' | 'cfac',
    suffix?: string,
    overwrite?: boolean
  ): string | null {
    if (!existsSync(outputFile)) {
      return null;
    }

    try {
      // Parse as-of date
      const asOf = DateTime.fromISO(asOfDate);
      const yearMonth = asOf.toFormat('yyyy-MM');

      // Create archive directory structure: output/archive/YYYY-MM/YYYY-MM-DD/
      const archiveDir = join(this.config.outputDir, 'archive', yearMonth, asOfDate);
      if (!existsSync(archiveDir)) {
        mkdirSync(archiveDir, { recursive: true });
      }

      // Get start and end dates for forecast period
      const startDate = asOf.plus({ days: 1 }).toISODate()!;
      const endDate = horizon === 'daily'
        ? startDate  // Day-ahead: single day
        : asOf.plus({ days: 7 }).toISODate()!;  // Week-ahead: 7 days

      // Generate gateway-compatible filename
      const naming = this.config.gatewayNaming || 'gateway';
      let archiveFilename = this.getGatewayFilename({ horizon, type, startDate, endDate, naming });

      // Apply suffix if provided (insert before .csv extension)
      if (suffix) {
        archiveFilename = archiveFilename.replace('.csv', `${suffix}.csv`);
      }

      const archivePath = join(archiveDir, archiveFilename);

      // Check if archive already exists
      if (existsSync(archivePath) && !overwrite) {
        // Skip archiving if file exists and overwrite is not enabled
        return archivePath;  // Return existing path without overwriting
      }

      // Copy file to archive
      const content = readFileSync(outputFile);
      writeFileSync(archivePath, content);

      return archivePath;
    } catch (error) {
      console.error(`Failed to archive forecast: ${error}`);
      return null;
    }
  }

  /**
   * Clean up old archives based on retention policy
   */
  cleanupOldArchives(): { deleted: number; errors: number } {
    const retentionDays = this.config.archiveRetentionDays || 90;
    const cutoffDate = DateTime.now().minus({ days: retentionDays });

    let deleted = 0;
    let errors = 0;

    try {
      const archiveRoot = join(this.config.outputDir, 'archive');
      if (!existsSync(archiveRoot)) {
        return { deleted: 0, errors: 0 };
      }

      // Iterate through YYYY-MM directories
      const yearMonthDirs = readdirSync(archiveRoot);

      for (const yearMonth of yearMonthDirs) {
        const yearMonthPath = join(archiveRoot, yearMonth);
        if (!statSync(yearMonthPath).isDirectory()) continue;

        // Iterate through YYYY-MM-DD directories
        const dateDirs = readdirSync(yearMonthPath);

        for (const dateDir of dateDirs) {
          try {
            const archiveDate = DateTime.fromISO(dateDir);
            if (!archiveDate.isValid) continue;

            if (archiveDate < cutoffDate) {
              const datePath = join(yearMonthPath, dateDir);
              // Delete all files in this date directory
              const files = readdirSync(datePath);
              for (const file of files) {
                unlinkSync(join(datePath, file));
                deleted++;
              }
              // Remove empty directory
              try {
                const remainingFiles = readdirSync(datePath);
                if (remainingFiles.length === 0) {
                  // Use rmdir via execSync for safety
                  execSync(`rmdir "${datePath}"`, { cwd: this.projectRoot });
                }
              } catch (e) {
                // Directory not empty or other error, ignore
              }
            }
          } catch (e) {
            errors++;
          }
        }
      }
    } catch (error) {
      console.error(`Archive cleanup failed: ${error}`);
      errors++;
    }

    return { deleted, errors };
  }

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * HOURLY FORECAST STORAGE
   * ═══════════════════════════════════════════════════════════════════════════
   */

  /**
   * Store hourly demand forecast values in database using transaction
   */
  storeHourlyDemandForecasts(runId: number, forecastFile: string): { stored: number } {
    if (!existsSync(forecastFile)) {
      return { stored: 0 };
    }

    try {
      const content = readFileSync(forecastFile, 'utf-8');
      const data = parse(content, { columns: true, skip_empty_lines: true });

      if (data.length === 0) {
        return { stored: 0 };
      }

      let stored = 0;

      // Get region columns (exclude DateTimeEnding)
      const columns = Object.keys(data[0]);
      const regions = columns.filter(col => col !== 'DateTimeEnding');

      const insertStmt = this.db.prepare(`
        INSERT INTO demand_forecast_hourly (run_id, datetime, region, forecast_mw)
        VALUES (?, ?, ?, ?)
      `);

      // Flatten data into batch array to avoid stack overflow
      const BATCH_SIZE = 1000;
      const batchItems: Array<{ datetime: string; region: string; forecastMW: number }> = [];

      for (const row of data) {
        const datetime = row.DateTimeEnding;
        for (const region of regions) {
          const forecastMW = parseFloat(row[region]);
          if (!isNaN(forecastMW)) {
            batchItems.push({ datetime, region, forecastMW });
          }
        }
      }

      // Process in batches to avoid stack overflow
      for (let i = 0; i < batchItems.length; i += BATCH_SIZE) {
        const batch = batchItems.slice(i, i + BATCH_SIZE);
        const batchTransaction = this.db.transaction(() => {
          for (const item of batch) {
            insertStmt.run(runId, item.datetime, item.region, item.forecastMW);
          }
        });
        batchTransaction();
        stored += batch.length;
      }

      return { stored };

    } catch (error) {
      console.error(`Failed to store hourly demand forecasts: ${error}`);
      return { stored: 0 };
    }
  }

  /**
   * Store hourly CFAC forecast values in database using transaction
   */
  storeHourlyCfacForecasts(runId: number, forecastFile: string): { stored: number } {
    if (!existsSync(forecastFile)) {
      return { stored: 0 };
    }

    try {
      const content = readFileSync(forecastFile, 'utf-8');
      const data = parse(content, { columns: true, skip_empty_lines: true });

      if (data.length === 0) {
        return { stored: 0 };
      }

      let stored = 0;

      // Get station columns (exclude DateTimeEnding)
      const columns = Object.keys(data[0]);
      const stations = columns.filter(col => col !== 'DateTimeEnding');

      // Detect station type from suffix
      const getStationType = (stationCode: string): string => {
        if (stationCode.endsWith('_W')) return 'WIND';
        if (stationCode.endsWith('_S')) return 'SOLAR';
        if (stationCode.endsWith('_H')) return 'HYDRO';
        if (stationCode.endsWith('_B')) return 'BATTERY';
        if (stationCode.endsWith('_G') || stationCode.endsWith('_GP')) return 'GEOTHERMAL';
        if (stationCode.endsWith('_BI') || stationCode.endsWith('_BG') || stationCode.endsWith('_BL')) return 'BIOMASS';

        // Explicit wind stations (non-standard naming)
        const windStations = ['01BURGOS', '01LAOAG', '01PAGUDPUD', '02DOLORES', '02MMPP_G01', '03AWOC_G01', '08PWIND_G01', '08WIND_G02'];
        if (windStations.includes(stationCode)) return 'WIND';

        return 'UNKNOWN';
      };

      const insertStmt = this.db.prepare(`
        INSERT INTO cfac_forecast_hourly (run_id, datetime, station_code, station_type, forecast_cf)
        VALUES (?, ?, ?, ?, ?)
      `);

      // Flatten data into batch array to avoid stack overflow
      const BATCH_SIZE = 1000;
      const batchItems: Array<{ datetime: string; station: string; stationType: string; forecastCF: number }> = [];

      for (const row of data) {
        const datetime = row.DateTimeEnding;
        for (const station of stations) {
          const forecastCF = parseFloat(row[station]);
          if (!isNaN(forecastCF)) {
            const stationType = getStationType(station);
            batchItems.push({ datetime, station, stationType, forecastCF });
          }
        }
      }

      // Process in batches to avoid stack overflow
      for (let i = 0; i < batchItems.length; i += BATCH_SIZE) {
        const batch = batchItems.slice(i, i + BATCH_SIZE);
        const batchTransaction = this.db.transaction(() => {
          for (const item of batch) {
            insertStmt.run(runId, item.datetime, item.station, item.stationType, item.forecastCF);
          }
        });
        batchTransaction();
        stored += batch.length;
      }

      return { stored };

    } catch (error) {
      console.error(`Failed to store hourly CFAC forecasts: ${error}`);
      return { stored: 0 };
    }
  }

  /**
   * Store hourly forecasts based on type
   */
  private storeHourlyForecasts(runId: number, forecastFile: string, type: 'demand' | 'cfac'): void {
    if (type === 'demand') {
      this.storeHourlyDemandForecasts(runId, forecastFile);
    } else {
      this.storeHourlyCfacForecasts(runId, forecastFile);
    }
  }

  close(): void {
    this.db.close();
  }
}
