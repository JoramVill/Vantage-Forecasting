/**
 * Configuration Service
 *
 * Manages the global forecast configuration stored in forecast_config.json.
 * Provides read/write access, validation, and migration from legacy scheduler_config.
 *
 * @see Documents/planning/UNIFIED_FORECAST_SYSTEM_PLAN.md
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import Database from 'better-sqlite3';
import type {
  GlobalForecastConfig,
  PartialGlobalForecastConfig,
  ConfigValidationResult
} from '../types/config.js';

export class ConfigService {
  private configPath: string;
  private config: GlobalForecastConfig | null = null;

  constructor(configPath?: string) {
    this.configPath = configPath || join(process.cwd(), 'forecast_config.json');
  }

  /**
   * Get default configuration values
   */
  static getDefaults(): GlobalForecastConfig {
    return {
      version: 1,

      paths: {
        demandTraining: 'Data Samples/Demand',
        cfacTraining: 'Data Samples/Capacity Factor',
        output: './output',
        archive: './output/archive',
        weatherCache: './weather_cache'
      },

      databases: {
        scheduler: './forecast.db',
        regionalDemand: './data/iload.db',
        zonalDemand: './data/iload_zonal.db'
      },

      calibration: {
        enabled: true,
        days: 7,
        threshold: 5,
        maxIterations: 10
      },

      cfac: {
        useXgboost: false,
        asymmetricLoss: false,
        biasCorrection: false
      },

      demand: {
        model: 'hybrid',
        geography: 'regional',
        growthRate: 0
      },

      weather: {
        maxAgeHours: 6,
        refreshMode: 'auto'
      },

      output: {
        archiveEnabled: true,
        retentionDays: 90,
        naming: 'gateway'
      },

      gateway: {
        enabled: false,
        autoPush: false,
        // HTTP Gateway (v2.5.0+) - preferred method
        httpUrl: 'https://vantage-gateway.taile437a5.ts.net',
        licenseId: '',  // Set via VANTAGE_LICENSE_ID env var
        preferHttp: true,
        // SFTP Gateway (legacy fallback)
        sftpHost: '100.115.9.94',
        sftpPort: 22,
        sftpUser: 'vantage-upload',
        sftpPassword: ''  // Set via VANTAGE_GATEWAY_PASSWORD env var
      },

      scheduler: {
        enabled: false,
        runTimes: ['06:00'],
        runDays: [1, 2, 3, 4, 5, 6, 7],
        forecastTypes: ['demand', 'cfac'],
        horizons: ['daily', 'weekly']
      }
    };
  }

  /**
   * Load configuration from JSON file
   * If file doesn't exist, attempts migration from scheduler_config database
   */
  load(): GlobalForecastConfig {
    // If already loaded and cached, return it
    if (this.config !== null) {
      return this.config;
    }

    // Try loading from JSON file
    if (existsSync(this.configPath)) {
      try {
        const content = readFileSync(this.configPath, 'utf8');
        const loaded = JSON.parse(content) as GlobalForecastConfig;

        // Merge with defaults to handle missing fields (forward compatibility)
        this.config = this.mergeWithDefaults(loaded);
        return this.config;
      } catch (error: any) {
        throw new Error(`Failed to parse forecast_config.json: ${error.message}`);
      }
    }

    // File doesn't exist - try migration from scheduler_config database
    const migrated = this.migrateFromDatabase();
    if (migrated) {
      console.log('✅ Migrated scheduler_config from database to forecast_config.json');
      this.config = migrated;
      this.save(); // Save migrated config
      return this.config;
    }

    // No existing config - use defaults
    this.config = ConfigService.getDefaults();
    return this.config;
  }

  /**
   * Save current configuration to JSON file
   */
  save(config?: GlobalForecastConfig): void {
    const toSave = config || this.config;
    if (!toSave) {
      throw new Error('No configuration to save');
    }

    // Ensure directory exists
    const dir = dirname(this.configPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    // Write JSON with pretty formatting
    const content = JSON.stringify(toSave, null, 2);
    writeFileSync(this.configPath, content, 'utf8');

    // Update cached config
    this.config = toSave;
  }

  /**
   * Get current configuration (loads if not already loaded)
   */
  get(): GlobalForecastConfig {
    if (!this.config) {
      return this.load();
    }
    return this.config;
  }

  /**
   * Set configuration value using dot notation
   * Examples:
   *   set('calibration.days', 14)
   *   set('cfac.useXgboost', true)
   *   set('demand.geography', 'zonal')
   */
  set(key: string, value: any): void {
    const config = this.get();

    const parts = key.split('.');
    if (parts.length < 1 || parts.length > 2) {
      throw new Error(`Invalid key format: ${key}. Use format "section.field" or "field"`);
    }

    if (parts.length === 1) {
      // Top-level field (e.g., "version")
      if (!(parts[0] in config)) {
        throw new Error(`Unknown config field: ${parts[0]}`);
      }
      (config as any)[parts[0]] = value;
    } else {
      // Nested field (e.g., "calibration.days")
      const [section, field] = parts;
      if (!(section in config)) {
        throw new Error(`Unknown config section: ${section}`);
      }
      const sectionObj = (config as any)[section];
      if (typeof sectionObj !== 'object' || sectionObj === null) {
        throw new Error(`Config section ${section} is not an object`);
      }
      if (!(field in sectionObj)) {
        throw new Error(`Unknown field ${field} in section ${section}`);
      }
      sectionObj[field] = value;
    }

    // Validate after setting
    const validation = this.validate(config);
    if (!validation.valid) {
      throw new Error(`Invalid configuration after set: ${validation.errors.join(', ')}`);
    }

    this.save(config);
  }

  /**
   * Reset configuration to defaults
   */
  reset(): void {
    this.config = ConfigService.getDefaults();
    this.save();
  }

  /**
   * Validate configuration structure and values
   */
  validate(config?: GlobalForecastConfig): ConfigValidationResult {
    const toValidate = config || this.get();
    const errors: string[] = [];
    const warnings: string[] = [];

    // Check version
    if (typeof toValidate.version !== 'number' || toValidate.version < 1) {
      errors.push('version must be a positive number');
    }

    // Validate paths
    if (!toValidate.paths || typeof toValidate.paths !== 'object') {
      errors.push('paths section is required');
    } else {
      const requiredPaths = ['demandTraining', 'cfacTraining', 'output', 'archive', 'weatherCache'];
      for (const path of requiredPaths) {
        if (!toValidate.paths[path as keyof typeof toValidate.paths]) {
          errors.push(`paths.${path} is required`);
        }
      }
    }

    // Validate databases
    if (!toValidate.databases || typeof toValidate.databases !== 'object') {
      errors.push('databases section is required');
    } else {
      const requiredDbs = ['scheduler', 'regionalDemand', 'zonalDemand'];
      for (const db of requiredDbs) {
        if (!toValidate.databases[db as keyof typeof toValidate.databases]) {
          errors.push(`databases.${db} is required`);
        }
      }
    }

    // Validate calibration
    if (toValidate.calibration) {
      if (typeof toValidate.calibration.enabled !== 'boolean') {
        errors.push('calibration.enabled must be boolean');
      }
      if (toValidate.calibration.days < 1 || toValidate.calibration.days > 365) {
        errors.push('calibration.days must be between 1 and 365');
      }
      if (toValidate.calibration.threshold < 0 || toValidate.calibration.threshold > 100) {
        errors.push('calibration.threshold must be between 0 and 100');
      }
      if (toValidate.calibration.maxIterations < 1 || toValidate.calibration.maxIterations > 100) {
        errors.push('calibration.maxIterations must be between 1 and 100');
      }
    } else {
      errors.push('calibration section is required');
    }

    // Validate cfac
    if (toValidate.cfac) {
      if (typeof toValidate.cfac.useXgboost !== 'boolean') {
        errors.push('cfac.useXgboost must be boolean');
      }
      if (typeof toValidate.cfac.asymmetricLoss !== 'boolean') {
        errors.push('cfac.asymmetricLoss must be boolean');
      }
      if (typeof toValidate.cfac.biasCorrection !== 'boolean') {
        errors.push('cfac.biasCorrection must be boolean');
      }
    } else {
      errors.push('cfac section is required');
    }

    // Validate demand
    if (toValidate.demand) {
      const validModels = ['hybrid', 'regression', 'xgboost'];
      if (!validModels.includes(toValidate.demand.model)) {
        errors.push(`demand.model must be one of: ${validModels.join(', ')}`);
      }
      const validGeography = ['regional', 'zonal'];
      if (!validGeography.includes(toValidate.demand.geography)) {
        errors.push(`demand.geography must be one of: ${validGeography.join(', ')}`);
      }
      if (typeof toValidate.demand.growthRate !== 'number') {
        errors.push('demand.growthRate must be a number');
      }
    } else {
      errors.push('demand section is required');
    }

    // Validate weather
    if (toValidate.weather) {
      if (toValidate.weather.maxAgeHours < 0 || toValidate.weather.maxAgeHours > 168) {
        warnings.push('weather.maxAgeHours should be between 0 and 168 (1 week)');
      }
      const validRefreshModes = ['auto', 'always', 'never'];
      if (!validRefreshModes.includes(toValidate.weather.refreshMode)) {
        errors.push(`weather.refreshMode must be one of: ${validRefreshModes.join(', ')}`);
      }
    } else {
      errors.push('weather section is required');
    }

    // Validate output
    if (toValidate.output) {
      if (typeof toValidate.output.archiveEnabled !== 'boolean') {
        errors.push('output.archiveEnabled must be boolean');
      }
      if (toValidate.output.retentionDays < 0) {
        errors.push('output.retentionDays must be >= 0');
      }
      const validNaming = ['gateway', 'legacy'];
      if (!validNaming.includes(toValidate.output.naming)) {
        errors.push(`output.naming must be one of: ${validNaming.join(', ')}`);
      }
    } else {
      errors.push('output section is required');
    }

    // Validate gateway
    if (toValidate.gateway) {
      if (typeof toValidate.gateway.enabled !== 'boolean') {
        errors.push('gateway.enabled must be boolean');
      }
      if (typeof toValidate.gateway.autoPush !== 'boolean') {
        errors.push('gateway.autoPush must be boolean');
      }
    } else {
      errors.push('gateway section is required');
    }

    // Validate scheduler
    if (toValidate.scheduler) {
      if (typeof toValidate.scheduler.enabled !== 'boolean') {
        errors.push('scheduler.enabled must be boolean');
      }
      if (!Array.isArray(toValidate.scheduler.runTimes)) {
        errors.push('scheduler.runTimes must be an array');
      } else {
        for (const time of toValidate.scheduler.runTimes) {
          if (!/^\d{2}:\d{2}$/.test(time)) {
            errors.push(`scheduler.runTimes contains invalid time format: ${time} (use HH:MM)`);
          }
        }
      }
      if (!Array.isArray(toValidate.scheduler.runDays)) {
        errors.push('scheduler.runDays must be an array');
      } else {
        for (const day of toValidate.scheduler.runDays) {
          if (typeof day !== 'number' || day < 1 || day > 7) {
            errors.push(`scheduler.runDays contains invalid day: ${day} (use 1-7)`);
          }
        }
      }
      if (!Array.isArray(toValidate.scheduler.forecastTypes)) {
        errors.push('scheduler.forecastTypes must be an array');
      } else {
        for (const type of toValidate.scheduler.forecastTypes) {
          if (type !== 'demand' && type !== 'cfac') {
            errors.push(`scheduler.forecastTypes contains invalid type: ${type} (use demand or cfac)`);
          }
        }
      }
      if (!Array.isArray(toValidate.scheduler.horizons)) {
        errors.push('scheduler.horizons must be an array');
      } else {
        for (const horizon of toValidate.scheduler.horizons) {
          if (horizon !== 'daily' && horizon !== 'weekly') {
            errors.push(`scheduler.horizons contains invalid horizon: ${horizon} (use daily or weekly)`);
          }
        }
      }
    } else {
      errors.push('scheduler section is required');
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings
    };
  }

  /**
   * Migrate configuration from scheduler_config database table (read-only)
   * Returns the migrated config or null if no database found
   */
  private migrateFromDatabase(): GlobalForecastConfig | null {
    const dbPath = join(process.cwd(), 'forecast.db');

    // Check if database exists
    if (!existsSync(dbPath)) {
      return null;
    }

    try {
      const db = new Database(dbPath, { readonly: true });

      // Check if scheduler_config table exists
      const tableCheck = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='scheduler_config'"
      ).get();

      if (!tableCheck) {
        db.close();
        return null;
      }

      // Read scheduler_config
      const row = db.prepare('SELECT * FROM scheduler_config WHERE id = 1').get() as any;
      db.close();

      if (!row) {
        return null;
      }

      // Start with defaults
      const config = ConfigService.getDefaults();

      // Map database values to config
      // Scheduler settings
      config.scheduler.enabled = row.enabled === 1;

      // Parse run times (morning and evening from separate columns)
      const runTimes: string[] = [];
      if (row.run_time_morning) runTimes.push(row.run_time_morning);
      if (row.run_time_evening && row.run_time_evening !== row.run_time_morning) {
        runTimes.push(row.run_time_evening);
      }
      config.scheduler.runTimes = runTimes.length > 0 ? runTimes : ['06:00'];

      // Parse run days (comma-separated string)
      if (row.run_days) {
        config.scheduler.runDays = row.run_days.split(',').map((d: string) => parseInt(d.trim()));
      }

      // Parse forecast types (comma-separated string)
      if (row.forecast_types) {
        config.scheduler.forecastTypes = row.forecast_types.split(',').map((t: string) => t.trim()) as ('demand' | 'cfac')[];
      }

      // Parse horizons (comma-separated string)
      if (row.horizons) {
        config.scheduler.horizons = row.horizons.split(',').map((h: string) => h.trim()) as ('daily' | 'weekly')[];
      }

      // Weather settings
      if (row.weather_max_age_hours !== undefined) {
        config.weather.maxAgeHours = row.weather_max_age_hours;
      }

      // Gateway settings
      if (row.auto_push_gateway !== undefined) {
        config.gateway.autoPush = row.auto_push_gateway === 1;
      }

      // Archive settings
      if (row.archive_retention_days !== undefined) {
        config.output.retentionDays = row.archive_retention_days;
      }

      // Demand geography
      if (row.demand_geography) {
        config.demand.geography = row.demand_geography as 'regional' | 'zonal';
      }

      return config;
    } catch (error: any) {
      // If migration fails, return null (will use defaults)
      console.warn(`Warning: Failed to migrate scheduler_config: ${error.message}`);
      return null;
    }
  }

  /**
   * Merge loaded config with defaults to handle missing fields
   */
  private mergeWithDefaults(loaded: Partial<GlobalForecastConfig>): GlobalForecastConfig {
    const defaults = ConfigService.getDefaults();

    return {
      version: loaded.version ?? defaults.version,
      paths: { ...defaults.paths, ...loaded.paths },
      databases: { ...defaults.databases, ...loaded.databases },
      calibration: { ...defaults.calibration, ...loaded.calibration },
      cfac: { ...defaults.cfac, ...loaded.cfac },
      demand: { ...defaults.demand, ...loaded.demand },
      weather: { ...defaults.weather, ...loaded.weather },
      output: { ...defaults.output, ...loaded.output },
      gateway: { ...defaults.gateway, ...loaded.gateway },
      scheduler: { ...defaults.scheduler, ...loaded.scheduler }
    };
  }

  /**
   * Get the config file path
   */
  getConfigPath(): string {
    return this.configPath;
  }
}

// Export singleton instance for convenience
let defaultInstance: ConfigService | null = null;

export function getConfigService(configPath?: string): ConfigService {
  if (!defaultInstance || configPath) {
    defaultInstance = new ConfigService(configPath);
  }
  return defaultInstance;
}
