import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import Store from 'electron-store';

// Note: better-sqlite3 is NOT loaded directly in Electron main process
// due to native module compatibility issues (NODE_MODULE_VERSION mismatch).
// All database operations use helper scripts spawned via Node.js subprocess.

// Zone codes for detection
const ZONAL_CODES = ['01NLUZ', '02METRO', '03SLUZ', '04LEYTE', '05CEBU', '06NEGROS', '07BOHOL', '08PANAY', '09NWMIN', '10LANAO', '11NCMIN', '12NEMIN', '13SEMIN', '14SWMIN'];
const REGIONAL_CODES = ['CLUZ', 'CVIS', 'CMIN'];

// ═══════════════════════════════════════════════════════════════════════════════
// PORTABLE MODE DETECTION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Detect if running in portable mode (packaged distribution)
 * Portable mode is detected by:
 * 1. Presence of .portable marker file in app directory
 * 2. Presence of cli/node/node.exe (bundled Node.js)
 */
function isPortableMode(): boolean {
  const appDir = path.dirname(app.getPath('exe'));
  const portableMarker = path.join(appDir, '.portable');
  const bundledNode = path.join(appDir, 'cli', 'node', 'node.exe');
  return fs.existsSync(portableMarker) || fs.existsSync(bundledNode);
}

/**
 * Get the application root directory
 * - Portable: directory containing the .exe
 * - Development: project root (parent of gui/)
 */
function getAppRoot(): string {
  if (isPortableMode()) {
    return path.dirname(app.getPath('exe'));
  }
  // Development mode: go up from gui/dist-electron to project root
  const guiDir = path.dirname(__dirname);
  return path.dirname(guiDir);
}

/**
 * Get the Node.js executable path
 * - Portable: bundled node.exe in cli/node/
 * - Development: system 'node' command
 */
function getNodePath(): string {
  if (isPortableMode()) {
    const bundledNode = path.join(getAppRoot(), 'cli', 'node', 'node.exe');
    if (fs.existsSync(bundledNode)) {
      return bundledNode;
    }
  }
  return 'node'; // Use system node
}

/**
 * Get the CLI script path
 * - Portable: cli/dist/index.js
 * - Development: dist/index.js (relative to project root)
 */
function getCliScriptPath(): string {
  const appRoot = getAppRoot();
  if (isPortableMode()) {
    return path.join(appRoot, 'cli', 'dist', 'index.js');
  }
  return path.join(appRoot, 'dist', 'index.js');
}

// ═══════════════════════════════════════════════════════════════════════════════
// GLOBAL CONFIG SERVICE (Local implementation to avoid ESM/CJS compatibility issues)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Global Forecast Configuration interfaces
 * Mirrors the CLI types in src/types/config.ts
 */
interface GlobalForecastConfig {
  version: number;
  paths: {
    demandTraining: string;
    cfacTraining: string;
    output: string;
    archive: string;
    weatherCache: string;
  };
  databases: {
    scheduler: string;
    regionalDemand: string;
    zonalDemand: string;
  };
  calibration: {
    enabled: boolean;
    days: number;
    threshold: number;
    maxIterations: number;
  };
  cfac: {
    useXgboost: boolean;
    asymmetricLoss: boolean;
    biasCorrection: boolean;
  };
  demand: {
    model: 'hybrid' | 'regression' | 'xgboost';
    geography: 'regional' | 'zonal' | 'both';
    growthRate: number;
  };
  weather: {
    maxAgeHours: number;
    refreshMode: 'auto' | 'always' | 'never';
  };
  output: {
    archiveEnabled: boolean;
    retentionDays: number;
    naming: 'gateway' | 'legacy';
  };
  gateway: {
    enabled: boolean;
    autoPush: boolean;
  };
  scheduler: {
    enabled: boolean;
    runTimes: string[];
    runDays: number[];
    forecastTypes: ('demand' | 'cfac')[];
    horizons: ('daily' | 'weekly')[];
  };
}

interface ConfigValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Local config service that doesn't require importing ESM modules
 * Handles forecast_config.json directly in the Electron main process
 */
class LocalConfigService {
  private configPath: string;
  private config: GlobalForecastConfig | null = null;

  constructor() {
    // Use project root for config path
    this.configPath = path.join(getAppRoot(), 'forecast_config.json');
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
        autoPush: false
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
   */
  load(): GlobalForecastConfig {
    if (this.config !== null) {
      return this.config;
    }

    if (fs.existsSync(this.configPath)) {
      try {
        const content = fs.readFileSync(this.configPath, 'utf8');
        const loaded = JSON.parse(content) as GlobalForecastConfig;
        this.config = this.mergeWithDefaults(loaded);
        return this.config;
      } catch (error: any) {
        throw new Error(`Failed to parse forecast_config.json: ${error.message}`);
      }
    }

    // No existing config - use defaults
    this.config = LocalConfigService.getDefaults();
    return this.config;
  }

  /**
   * Save configuration to JSON file
   */
  save(config?: GlobalForecastConfig): void {
    const toSave = config || this.config;
    if (!toSave) {
      throw new Error('No configuration to save');
    }

    const dir = path.dirname(this.configPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const content = JSON.stringify(toSave, null, 2);
    fs.writeFileSync(this.configPath, content, 'utf8');
    this.config = toSave;
  }

  /**
   * Reset configuration to defaults
   */
  reset(): void {
    this.config = LocalConfigService.getDefaults();
    this.save();
  }

  /**
   * Validate configuration
   */
  validate(config?: GlobalForecastConfig): ConfigValidationResult {
    const toValidate = config || this.load();
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
      for (const p of requiredPaths) {
        if (!toValidate.paths[p as keyof typeof toValidate.paths]) {
          errors.push(`paths.${p} is required`);
        }
      }
    }

    // Validate databases
    if (!toValidate.databases || typeof toValidate.databases !== 'object') {
      errors.push('databases section is required');
    }

    // Validate calibration
    if (toValidate.calibration) {
      if (typeof toValidate.calibration.enabled !== 'boolean') {
        errors.push('calibration.enabled must be boolean');
      }
      if (toValidate.calibration.days < 1 || toValidate.calibration.days > 365) {
        errors.push('calibration.days must be between 1 and 365');
      }
    } else {
      errors.push('calibration section is required');
    }

    // Validate demand
    if (toValidate.demand) {
      const validModels = ['hybrid', 'regression', 'xgboost'];
      if (!validModels.includes(toValidate.demand.model)) {
        errors.push(`demand.model must be one of: ${validModels.join(', ')}`);
      }
      const validGeography = ['regional', 'zonal', 'both'];
      if (!validGeography.includes(toValidate.demand.geography)) {
        errors.push(`demand.geography must be one of: ${validGeography.join(', ')}`);
      }
    } else {
      errors.push('demand section is required');
    }

    // Validate weather
    if (toValidate.weather) {
      const validRefreshModes = ['auto', 'always', 'never'];
      if (!validRefreshModes.includes(toValidate.weather.refreshMode)) {
        errors.push(`weather.refreshMode must be one of: ${validRefreshModes.join(', ')}`);
      }
    } else {
      errors.push('weather section is required');
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings
    };
  }

  /**
   * Merge loaded config with defaults to handle missing fields
   */
  private mergeWithDefaults(loaded: Partial<GlobalForecastConfig>): GlobalForecastConfig {
    const defaults = LocalConfigService.getDefaults();

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
}

// Singleton instance for the local config service
const localConfigService = new LocalConfigService();

// Settings store with encryption
const store = new Store({
  name: 'vantage-forecaster-settings',
  encryptionKey: 'vantage-forecaster-2024',
});

let mainWindow: BrowserWindow | null = null;

// Window state management
interface WindowState {
  width: number;
  height: number;
  x?: number;
  y?: number;
  isMaximized?: boolean;
}

function getWindowState(): WindowState {
  const defaultState: WindowState = { width: 1000, height: 800 };
  const saved = store.get('windowState') as WindowState | undefined;
  return saved || defaultState;
}

function saveWindowState(): void {
  if (!mainWindow) return;

  const isMaximized = mainWindow.isMaximized();
  if (!isMaximized) {
    const bounds = mainWindow.getBounds();
    store.set('windowState', {
      width: bounds.width,
      height: bounds.height,
      x: bounds.x,
      y: bounds.y,
      isMaximized: false,
    });
  } else {
    // Keep the previous non-maximized bounds but flag as maximized
    const current = store.get('windowState') as WindowState | undefined;
    if (current) {
      store.set('windowState', { ...current, isMaximized: true });
    }
  }
}

function createWindow() {
  // Get icon path - go up from dist-electron to gui, then to assets
  const guiDir = path.dirname(__dirname);
  const iconPath = path.join(guiDir, 'assets', 'VANTAGE_LOGO-removebg-preview.ico');

  // Restore previous window state
  const windowState = getWindowState();

  mainWindow = new BrowserWindow({
    width: windowState.width,
    height: windowState.height,
    x: windowState.x,
    y: windowState.y,
    minWidth: 800,
    minHeight: 600,
    title: 'Vantage Forecaster',
    icon: iconPath,
    backgroundColor: '#1e293b', // Match titlebar/terminal header color
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#1e293b', // Match --bg-secondary (terminal header)
      symbolColor: '#e2e8f0',
      height: 40,
    },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Restore maximized state
  if (windowState.isMaximized) {
    mainWindow.maximize();
  }

  // Save window state on resize/move
  mainWindow.on('resize', saveWindowState);
  mainWindow.on('move', saveWindowState);
  mainWindow.on('close', saveWindowState);

  // Load Vite dev server in development, built files in production
  if (process.env.NODE_ENV === 'development') {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// Get the CLI path - portable aware
function getCliPath(): string {
  return getCliScriptPath();
}

function getProjectRoot(): string {
  return getAppRoot();
}

// IPC Handler: Run CLI command with real-time output
ipcMain.handle('run-command', async (_event, args: string[]) => {
  return new Promise((resolve) => {
    const cliPath = getCliPath();
    const projectRoot = getProjectRoot();

    const nodePath = getNodePath();
    console.log('Running command:', nodePath, cliPath, ...args);
    console.log('Working directory:', projectRoot);
    console.log('Portable mode:', isPortableMode());

    const child = spawn(nodePath, [cliPath, ...args], {
      cwd: projectRoot,
      shell: false,
      env: { ...process.env },
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data: Buffer) => {
      const text = data.toString();
      stdout += text;
      // Send real-time output to renderer
      if (mainWindow) {
        mainWindow.webContents.send('command-output', { type: 'stdout', data: text });
      }
    });

    child.stderr.on('data', (data: Buffer) => {
      const text = data.toString();
      stderr += text;
      // Send real-time output to renderer
      if (mainWindow) {
        mainWindow.webContents.send('command-output', { type: 'stderr', data: text });
      }
    });

    child.on('close', (code) => {
      resolve({ stdout, stderr, code });
    });

    child.on('error', (err) => {
      resolve({ stdout, stderr, code: -1, error: err.message });
    });
  });
});

// IPC Handler: Run a node script (not CLI command)
ipcMain.handle('run-script', async (_event, scriptPath: string, args: string[]) => {
  return new Promise((resolve) => {
    const projectRoot = getProjectRoot();
    const fullScriptPath = path.join(projectRoot, scriptPath);

    const nodePath = getNodePath();
    console.log('Running script:', nodePath, fullScriptPath, ...args);
    console.log('Working directory:', projectRoot);

    const child = spawn(nodePath, [fullScriptPath, ...args], {
      cwd: projectRoot,
      shell: false,
      env: { ...process.env },
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data: Buffer) => {
      const text = data.toString();
      stdout += text;
      // Send real-time output to renderer
      if (mainWindow) {
        mainWindow.webContents.send('command-output', { type: 'stdout', data: text });
      }
    });

    child.stderr.on('data', (data: Buffer) => {
      const text = data.toString();
      stderr += text;
      // Send real-time output to renderer
      if (mainWindow) {
        mainWindow.webContents.send('command-output', { type: 'stderr', data: text });
      }
    });

    child.on('close', (code) => {
      resolve({ stdout, stderr, code });
    });

    child.on('error', (err) => {
      resolve({ stdout, stderr, code: -1, error: err.message });
    });
  });
});

// IPC Handler: Select directory
ipcMain.handle('select-directory', async () => {
  if (!mainWindow) return null;

  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
  });

  return result.canceled ? null : result.filePaths[0];
});

// IPC Handler: Select file
ipcMain.handle('select-file', async (_event, filters?: { name: string; extensions: string[] }[]) => {
  if (!mainWindow) return null;

  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: filters || [{ name: 'All Files', extensions: ['*'] }],
  });

  return result.canceled ? null : result.filePaths[0];
});

// IPC Handler: Save file dialog
ipcMain.handle('save-file', async (_event, defaultName?: string) => {
  if (!mainWindow) return null;

  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: defaultName || 'forecast.csv',
    filters: [
      { name: 'CSV Files', extensions: ['csv'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });

  return result.canceled ? null : result.filePath;
});

// IPC Handler: Get app path
ipcMain.handle('get-app-path', () => {
  return getProjectRoot();
});

// IPC Handler: Load settings
// Returns all saved settings from electron-store
ipcMain.handle('load-settings', () => {
  // Return all stored settings (store.store contains all key-value pairs)
  // We provide defaults for commonly used settings
  const allSettings = store.store as Record<string, any>;

  // Merge with defaults for backward compatibility
  return {
    // Manual tab settings
    dataSource: store.get('dataSource', 'csv'),
    databasePath: store.get('databasePath', ''),
    demandDataDir: store.get('demandDataDir', ''),
    cfacDataDir: store.get('cfacDataDir', ''),
    weatherDataDir: store.get('weatherDataDir', './weather_cache'),
    demandOutputDir: store.get('demandOutputDir', 'output/Demand'),
    cfacOutputDir: store.get('cfacOutputDir', 'output/CFAC'),
    enableDemand: store.get('enableDemand', true),
    enableCfac: store.get('enableCfac', true),
    enableZonal: store.get('enableZonal', false),
    scalingPercent: store.get('scalingPercent', 100),
    cfacModel: store.get('cfacModel', 'hybrid'),
    demandModel: store.get('demandModel', 'hybrid-calibrated'),
    pushToGateway: store.get('pushToGateway', false),
    // Per-type scaling
    scalingWind: store.get('scalingWind', 100),
    scalingSolar: store.get('scalingSolar', 100),
    usePerTypeScaling: store.get('usePerTypeScaling', false),
    demandGrowthRate: store.get('demandGrowthRate', 0),
    trainingEndDate: store.get('trainingEndDate', ''),
    // Output naming settings
    demandPrefix: store.get('demandPrefix', 'FC_DEM_'),
    demandZonalPrefix: store.get('demandZonalPrefix', 'FC_ZDEM_'),
    cfacPrefix: store.get('cfacPrefix', 'FC_CF_'),
    outputSuffix: store.get('outputSuffix', ''),
    useCustomName: store.get('useCustomName', false),
    customDemandName: store.get('customDemandName', ''),
    customCfacName: store.get('customCfacName', ''),
    // Tab state
    activeTab: store.get('activeTab', 'manual'),
    // Scheduler settings
    schedulerDailyEnabled: store.get('schedulerDailyEnabled', true),
    schedulerWeeklyEnabled: store.get('schedulerWeeklyEnabled', true),
    schedulerDemandEnabled: store.get('schedulerDemandEnabled', true),
    schedulerCfacEnabled: store.get('schedulerCfacEnabled', true),
    schedulerDemandGeography: store.get('schedulerDemandGeography', 'regional'),
    schedulerOutputDir: store.get('schedulerOutputDir', 'output/forecasts'),
    schedulerDemandModel: store.get('schedulerDemandModel', 'hybrid'),
    schedulerCalibDays: store.get('schedulerCalibDays', 7),
    schedulerCalibThreshold: store.get('schedulerCalibThreshold', 5),
    schedulerMaxIterations: store.get('schedulerMaxIterations', 3),
    calibrationIterations: store.get('calibrationIterations', 3),
    schedulerDataSource: store.get('schedulerDataSource', 'database'),
    schedulerTimes: store.get('schedulerTimes', ['06:00']),
    schedulerAutoEnabled: store.get('schedulerAutoEnabled', false),
    schedulerDemandPrefix: store.get('schedulerDemandPrefix', 'FC_DEM_'),
    schedulerDemandZonalPrefix: store.get('schedulerDemandZonalPrefix', 'FC_ZDEM_'),
    schedulerCfacPrefix: store.get('schedulerCfacPrefix', 'FC_CF_'),
    schedulerOutputSuffix: store.get('schedulerOutputSuffix', ''),
    schedulerSelectedCalibrator: store.get('schedulerSelectedCalibrator', ''),
    schedulerCalibrationMode: store.get('schedulerCalibrationMode', 'auto'),
    schedulerCalibrationPeriod: store.get('schedulerCalibrationPeriod', '1month'),
    selectedCalibrationId: store.get('selectedCalibrationId', null),
    schedulerRefreshWeather: store.get('schedulerRefreshWeather', false),
    schedulerOverwrite: store.get('schedulerOverwrite', false),
    schedulerSuffix: store.get('schedulerSuffix', ''),
    // Global settings (Settings tab)
    globalRegionalDemandDb: store.get('globalRegionalDemandDb', 'data/iload.db'),
    globalZonalDemandDb: store.get('globalZonalDemandDb', 'data/iload_zonal.db'),
    globalSchedulerDb: store.get('globalSchedulerDb', './forecast.db'),
    globalDemandCsvPath: store.get('globalDemandCsvPath', 'Data Samples/Demand'),
    globalCfacCsvPath: store.get('globalCfacCsvPath', 'Data Samples/Capacity Factor'),
    globalWeatherCacheDir: store.get('globalWeatherCacheDir', './weather_cache'),
    globalSchedulerOutputDir: store.get('globalSchedulerOutputDir', './output/forecasts'),
    autoImportBeforeRun: store.get('autoImportBeforeRun', true),
    autoFetchWeather: store.get('autoFetchWeather', true),
    // Per-type CFAC settings (Wind and Solar have different optimal configurations)
    windUseXgboost: store.get('windUseXgboost', false),
    windAsymmetricLoss: store.get('windAsymmetricLoss', false),
    windBiasCorrection: store.get('windBiasCorrection', false),
    solarUseXgboost: store.get('solarUseXgboost', true),
    solarAsymmetricLoss: store.get('solarAsymmetricLoss', true),
    solarBiasCorrection: store.get('solarBiasCorrection', false),
    // Calibration settings
    calibrationMode: store.get('calibrationMode', 'auto'),
    selectedCalibrator: store.get('selectedCalibrator', ''),
    saveCalibrator: store.get('saveCalibrator', false),
    // Include any other settings that were saved
    ...allSettings,
  };
});

// IPC Handler: Save settings
ipcMain.handle('save-settings', (_event, settings: Record<string, any>) => {
  for (const [key, value] of Object.entries(settings)) {
    store.set(key, value);
  }
  return true;
});

// IPC Handler: Check data format (zonal vs regional)
ipcMain.handle('check-data-format', async (_event, dirPath: string, dataType: 'demand' | 'database') => {
  try {
    if (dataType === 'database') {
      // For database, we need to check the schema
      // This would require running a CLI command or reading the db
      // For now, return unknown and let the user decide
      return { format: 'unknown', message: 'Database format detection not implemented' };
    }

    // Check CSV directory for demand data
    const stats = fs.statSync(dirPath);
    if (!stats.isDirectory()) {
      return { format: 'unknown', message: 'Path is not a directory' };
    }

    // Find CSV files in the directory
    const files = fs.readdirSync(dirPath).filter(f => f.toLowerCase().endsWith('.csv'));
    if (files.length === 0) {
      return { format: 'unknown', message: 'No CSV files found in directory' };
    }

    // Read the first CSV file to check headers
    const firstFile = path.join(dirPath, files[0]);
    const content = fs.readFileSync(firstFile, 'utf-8');
    const lines = content.split('\n');
    if (lines.length === 0) {
      return { format: 'unknown', message: 'CSV file is empty' };
    }

    const header = lines[0].toUpperCase();

    // Check for zonal codes
    const hasZonal = ZONAL_CODES.some(code => header.includes(code));
    const hasRegional = REGIONAL_CODES.some(code => header.includes(code));

    if (hasZonal && !hasRegional) {
      return {
        format: 'zonal',
        message: 'Detected 14-zone format (zonal demand data)',
        columns: ZONAL_CODES.filter(code => header.includes(code))
      };
    } else if (hasRegional && !hasZonal) {
      return {
        format: 'regional',
        message: 'Detected 3-region format (CLUZ, CVIS, CMIN)',
        columns: REGIONAL_CODES.filter(code => header.includes(code))
      };
    } else if (hasZonal && hasRegional) {
      return {
        format: 'mixed',
        message: 'Data contains both zonal and regional columns'
      };
    } else {
      return {
        format: 'unknown',
        message: 'Could not detect data format from CSV headers'
      };
    }
  } catch (error: any) {
    return { format: 'error', message: error.message };
  }
});

// IPC Handler: Check weather directory structure
ipcMain.handle('check-weather-directory', async (_event, dirPath: string) => {
  try {
    // Handle relative paths
    let fullPath = dirPath;
    if (!path.isAbsolute(dirPath)) {
      fullPath = path.join(getProjectRoot(), dirPath);
    }

    if (!fs.existsSync(fullPath)) {
      return { valid: false, message: `Directory does not exist: ${dirPath}` };
    }

    const stats = fs.statSync(fullPath);
    if (!stats.isDirectory()) {
      return { valid: false, message: 'Path is not a directory' };
    }

    const contents = fs.readdirSync(fullPath);

    // Check for expected weather folder structure
    // Weather cache has: combined, WIND_*, SOLAR_*, station_*, zonal folders, city folders
    const windFolders = contents.filter(f => f.startsWith('WIND_') || f.includes('_WIND'));
    const solarFolders = contents.filter(f => f.startsWith('SOLAR_'));
    const stationFolders = contents.filter(f => f.startsWith('station_'));
    const zonalFolders = contents.filter(f => /^\d{2}[a-z]+/.test(f)); // e.g., 01nluz, 02metro
    const hasCombined = contents.includes('combined');
    const hasZonal = contents.includes('zonal');

    // Check subfolders for date-based CSV files
    let dateRange = { start: '', end: '' };
    const checkFolder = hasCombined ? path.join(fullPath, 'combined') : fullPath;

    if (fs.existsSync(checkFolder) && fs.statSync(checkFolder).isDirectory()) {
      const subContents = fs.readdirSync(checkFolder);
      // Look for year-month folders (e.g., 2025-01, 2026-02)
      const monthFolders = subContents.filter(f => /^\d{4}-\d{2}$/.test(f)).sort();
      if (monthFolders.length > 0) {
        dateRange.start = monthFolders[0];
        dateRange.end = monthFolders[monthFolders.length - 1];
      }
    }

    const totalFolders = contents.filter(f => {
      const fPath = path.join(fullPath, f);
      return fs.existsSync(fPath) && fs.statSync(fPath).isDirectory();
    }).length;

    const info = {
      hasCombined,
      hasZonal,
      windStations: windFolders.length,
      solarStations: solarFolders.length,
      stationFolders: stationFolders.length,
      zonalFolders: zonalFolders.length,
      totalFolders,
      dateRange,
    };

    // Check if it looks like a weather cache
    const isWeatherCache = hasCombined || hasZonal || windFolders.length > 0 || solarFolders.length > 0 || zonalFolders.length > 0;

    if (!isWeatherCache) {
      return {
        valid: false,
        message: 'Directory does not appear to contain weather data.',
        ...info
      };
    }

    // Build summary message
    const parts = [];
    if (hasCombined) parts.push('combined');
    if (hasZonal) parts.push('zonal');
    if (zonalFolders.length > 0) parts.push(`${zonalFolders.length} zone folders`);
    if (windFolders.length > 0) parts.push(`${windFolders.length} wind`);
    if (solarFolders.length > 0) parts.push(`${solarFolders.length} solar`);

    let message = `Weather cache: ${parts.join(', ')}`;
    if (dateRange.start && dateRange.end) {
      message += ` (${dateRange.start} to ${dateRange.end})`;
    }

    return { valid: true, message, ...info };
  } catch (error: any) {
    return { valid: false, message: error.message };
  }
});

// IPC Handler: Get database info (date ranges, record counts)
ipcMain.handle('get-database-info', async (_event, dbPath: string) => {
  return new Promise((resolve) => {
    const projectRoot = getProjectRoot();
    const scriptPath = path.join(projectRoot, 'scripts', 'db-info.cjs');

    // Resolve the database path
    let fullPath = dbPath;
    if (!path.isAbsolute(dbPath)) {
      fullPath = path.join(projectRoot, dbPath);
    }

    if (!fs.existsSync(fullPath)) {
      resolve({
        success: false,
        message: `Database file not found: ${dbPath}`,
        demand: null,
        cfac: null,
        weather: null
      });
      return;
    }

    // Run the db-info script from the project root (where better-sqlite3 is installed)
    const nodePath = getNodePath();
    const child = spawn(nodePath, [scriptPath, fullPath], {
      cwd: projectRoot,
      shell: false,
      env: { ...process.env },
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      try {
        // Try to parse stderr first (script outputs JSON to stderr on error)
        if (stderr && stderr.trim().startsWith('{')) {
          resolve(JSON.parse(stderr.trim()));
          return;
        }
        // Parse stdout
        if (stdout && stdout.trim().startsWith('{')) {
          resolve(JSON.parse(stdout.trim()));
          return;
        }
        resolve({
          success: false,
          message: stderr || 'Failed to get database info',
          demand: null,
          cfac: null,
          weather: null
        });
      } catch (parseError: any) {
        resolve({
          success: false,
          message: `Parse error: ${parseError.message}`,
          demand: null,
          cfac: null,
          weather: null
        });
      }
    });

    child.on('error', (err) => {
      resolve({
        success: false,
        message: err.message,
        demand: null,
        cfac: null,
        weather: null
      });
    });
  });
});

// IPC Handler: Import data to database
ipcMain.handle('import-to-database', async (_event, options: {
  dbPath: string;
  dataType: 'demand' | 'cfac' | 'weather';
  sourcePath: string;
}) => {
  return new Promise((resolve) => {
    const cliPath = getCliPath();
    const projectRoot = getProjectRoot();

    // Build the import command
    const args = ['db', 'import', '-t', options.dataType, '-f', options.sourcePath, '--db', options.dbPath];

    const nodePath = getNodePath();
    console.log('Running import:', nodePath, cliPath, ...args);

    const child = spawn(nodePath, [cliPath, ...args], {
      cwd: projectRoot,
      shell: false,
      env: { ...process.env },
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data: Buffer) => {
      const text = data.toString();
      stdout += text;
      if (mainWindow) {
        mainWindow.webContents.send('command-output', { type: 'stdout', data: text });
      }
    });

    child.stderr.on('data', (data: Buffer) => {
      const text = data.toString();
      stderr += text;
      if (mainWindow) {
        mainWindow.webContents.send('command-output', { type: 'stderr', data: text });
      }
    });

    child.on('close', (code) => {
      resolve({
        success: code === 0,
        message: code === 0 ? 'Import completed successfully' : (stderr || 'Import failed'),
        stdout,
        stderr
      });
    });

    child.on('error', (err) => {
      resolve({ success: false, message: err.message });
    });
  });
});

// IPC Handler: List trained calibration models
ipcMain.handle('list-trained-models', async () => {
  try {
    const projectRoot = getProjectRoot();
    const modelsDir = path.join(projectRoot, 'models', 'calibrator');

    // Create directory if it doesn't exist
    if (!fs.existsSync(modelsDir)) {
      fs.mkdirSync(modelsDir, { recursive: true });
      return { success: true, models: [] };
    }

    const files = fs.readdirSync(modelsDir);
    const models: { name: string; date: string; mape?: number }[] = [];

    for (const file of files) {
      if (file.endsWith('.json')) {
        const fullPath = path.join(modelsDir, file);
        const stats = fs.statSync(fullPath);
        const name = file.replace('.json', '');

        // Try to read MAPE from the model file
        let mape: number | undefined;
        try {
          const content = fs.readFileSync(fullPath, 'utf-8');
          const modelData = JSON.parse(content);
          if (modelData.validationMAPE) {
            mape = modelData.validationMAPE;
          }
        } catch (e) {
          // Ignore parse errors
        }

        models.push({
          name,
          date: stats.mtime.toISOString().split('T')[0],
          mape
        });
      }
    }

    // Sort by date descending (newest first)
    models.sort((a, b) => b.date.localeCompare(a.date));

    return { success: true, models };
  } catch (error: any) {
    return { success: false, message: error.message };
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// SCHEDULER IPC HANDLERS
// ═══════════════════════════════════════════════════════════════════════════════

// Helper function to run scheduler-query script
function runSchedulerQuery(command: string, ...args: string[]): Promise<any> {
  return new Promise((resolve, reject) => {
    const projectRoot = getProjectRoot();
    const nodePath = getNodePath();
    const scriptPath = path.join(projectRoot, 'scripts', 'scheduler-query.cjs');
    const dbPath = path.join(projectRoot, 'forecast.db');

    const spawnArgs = [scriptPath, command, ...args, dbPath];

    const child = spawn(nodePath, spawnArgs, {
      cwd: projectRoot,
      env: { ...process.env },
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      if (code === 0 && stdout.trim()) {
        try {
          resolve(JSON.parse(stdout.trim()));
        } catch (e) {
          console.error('Failed to parse scheduler-query output:', stdout);
          reject(new Error('Invalid JSON output'));
        }
      } else {
        console.error('scheduler-query error:', stderr);
        reject(new Error(stderr || 'Unknown error'));
      }
    });

    child.on('error', (err) => {
      reject(err);
    });
  });
}

// Load scheduler configuration from database
ipcMain.handle('load-scheduler-config', async () => {
  const defaults = {
    enabled: false,
    runTimeMorning: '06:00',
    runTimeEvening: '18:00',
    secondRunEnabled: false,
    runDays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
    forecastDemand: true,
    forecastCfac: true,
    horizonDaily: true,
    horizonWeekly: true,
    weatherMaxAge: 6,
    autoPushGateway: false,
    archiveRetention: 90
  };

  try {
    const config = await runSchedulerQuery('config');
    return config || defaults;
  } catch (error: any) {
    console.error('Failed to load scheduler config:', error);
    return defaults;
  }
});

// Save scheduler configuration to database
ipcMain.handle('save-scheduler-config', async (_event, config) => {
  try {
    // Use scheduler-query script to save config (same approach as load)
    const configJson = JSON.stringify(config);
    const result = await runSchedulerQuery('save-config', configJson);
    return result || { success: false, error: 'No result from save operation' };
  } catch (error: any) {
    console.error('Failed to save scheduler config:', error);
    return { success: false, error: error.message };
  }
});

// Get recent forecast runs from database
ipcMain.handle('get-recent-runs', async (_event, limit = 20) => {
  try {
    const runs = await runSchedulerQuery('runs', String(limit));
    return runs || [];
  } catch (error: any) {
    console.error('Failed to get recent runs:', error);
    return [];
  }
});

// Get saved calibrations from database
ipcMain.handle('get-calibrations', async (_event, limit = 10) => {
  try {
    const calibrations = await runSchedulerQuery('calibrations', String(limit));
    return calibrations || [];
  } catch (error: any) {
    console.error('Failed to get calibrations:', error);
    return [];
  }
});

// Run scheduler manually with specified parameters
ipcMain.handle('run-scheduler-manual', async (_event, options: {
  date: string;
  type: string;
  horizon: string;
  calibratorPath?: string | null;
  trainingDays?: number;
  endDate?: string | null;
  verbose?: boolean;
  pushGateway?: boolean;
  useCalibrationId?: number | null;
  useDb?: boolean;
  dataDbPath?: string | null;
  maxIterations?: number;
  refreshWeather?: boolean;
  overwrite?: boolean;
  suffix?: string | null;
  outputDir?: string;
  weatherCacheDir?: string;
}) => {
  const cliPath = getCliPath();
  const projectRoot = getProjectRoot();

  const { date, type, horizon, calibratorPath, trainingDays, endDate, verbose, pushGateway,
          useCalibrationId, useDb, dataDbPath, maxIterations, refreshWeather, overwrite,
          suffix, outputDir, weatherCacheDir } = options;

  // Determine if this is a date range (backfill) or single date run
  const isBackfill = endDate && endDate !== date;

  // Build CLI arguments
  const args = isBackfill
    ? [cliPath, 'scheduler', 'backfill', '-s', date, '-e', endDate]
    : [cliPath, 'scheduler', 'run', '-d', date];

  if (type === 'demand') args.push('--demand-only');
  else if (type === 'cfac') args.push('--cfac-only');

  if (horizon === 'daily') args.push('--daily');
  else if (horizon === 'weekly') args.push('--weekly');

  // Add calibrator path if using a saved model
  if (calibratorPath) {
    args.push('--load-calibrator', calibratorPath);
  }

  // Add auto-calibration training period (data end date is auto-detected from actual data)
  if (trainingDays && trainingDays > 0) {
    args.push('--training-days', String(trainingDays));
  }

  // Add max calibration iterations (0 = no calibration)
  if (typeof maxIterations === 'number') {
    args.push('--max-iterations', String(maxIterations));
  }

  // Add quiet flag if verbose is explicitly false (verbose is default/true)
  if (verbose === false) {
    args.push('--quiet');
  }

  // Add gateway push flag if enabled
  if (pushGateway === true) {
    args.push('--push-gateway');
  }

  // Use saved calibration to skip calibration phase
  if (useCalibrationId && useCalibrationId > 0) {
    args.push('--use-calibration', String(useCalibrationId));
  }

  // Database source options
  if (useDb === true) {
    args.push('--use-db');
    if (dataDbPath) {
      args.push('--data-db', dataDbPath);
    }
  }

  // New options
  if (refreshWeather === true) {
    args.push('--refresh-weather');
  }

  if (isBackfill && overwrite === true) {
    args.push('--overwrite');
  }

  if (isBackfill && suffix) {
    args.push('--suffix', suffix);
  }

  if (outputDir) {
    args.push('--output', outputDir);
  }

  // Note: --cache is not supported by scheduler commands (it uses its own weather cache logic)
  // Note: Geography is read from forecast_config.json (demand.geography) - ensure config is saved before running
  // The weatherCacheDir setting is used by manual forecast commands instead
  // Note: Model options (--use-xgboost, --asymmetric-loss, --bias-correction) are read from forecast_config.json

  const nodePath = getNodePath();
  console.log('Running scheduler:', nodePath, ...args);

  // Return promise that resolves when command completes
  return new Promise((resolve) => {
    const child = spawn(nodePath, args, {
      cwd: projectRoot,
      shell: false,
      env: { ...process.env }
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data: Buffer) => {
      const text = data.toString();
      stdout += text;
      // Send real-time output to renderer
      if (mainWindow) {
        mainWindow.webContents.send('command-output', { type: 'stdout', data: text });
      }
    });

    child.stderr.on('data', (data: Buffer) => {
      const text = data.toString();
      stderr += text;
      // Send real-time output to renderer
      if (mainWindow) {
        mainWindow.webContents.send('command-output', { type: 'stderr', data: text });
      }
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve({ success: true, output: stdout });
      } else {
        resolve({ success: false, error: stderr || stdout });
      }
    });

    child.on('error', (err) => {
      resolve({ success: false, error: err.message });
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// GATEWAY CONFIGURATION IPC HANDLERS
// ═══════════════════════════════════════════════════════════════════════════════

interface GatewayConfig {
  host: string;
  port: number;
  username: string;
  password: string;
}

interface ConfigFile {
  gateway?: GatewayConfig;
  [key: string]: any;
}

// Load gateway configuration from config.json
ipcMain.handle('load-gateway-config', async () => {
  try {
    const projectRoot = getProjectRoot();
    const configPath = path.join(projectRoot, 'config.json');

    const defaults: GatewayConfig = {
      host: '100.115.9.94',
      port: 22,
      username: 'vantage-upload',
      password: ''
    };

    if (!fs.existsSync(configPath)) {
      return defaults;
    }

    const configContent = fs.readFileSync(configPath, 'utf8');
    const config: ConfigFile = JSON.parse(configContent);

    return {
      host: config.gateway?.host || defaults.host,
      port: config.gateway?.port || defaults.port,
      username: config.gateway?.username || defaults.username,
      password: config.gateway?.password || defaults.password
    };
  } catch (error: any) {
    console.error('Failed to load gateway config:', error);
    return {
      host: '100.115.9.94',
      port: 22,
      username: 'vantage-upload',
      password: ''
    };
  }
});

// Save gateway configuration to config.json
ipcMain.handle('save-gateway-config', async (_event, gatewayConfig: GatewayConfig) => {
  try {
    const projectRoot = getProjectRoot();
    const configPath = path.join(projectRoot, 'config.json');

    let config: ConfigFile = {};

    // Load existing config if it exists
    if (fs.existsSync(configPath)) {
      const configContent = fs.readFileSync(configPath, 'utf8');
      config = JSON.parse(configContent);
    }

    // Update gateway section
    config.gateway = {
      host: gatewayConfig.host,
      port: gatewayConfig.port,
      username: gatewayConfig.username,
      password: gatewayConfig.password
    };

    // Write back to config.json
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

    return { success: true };
  } catch (error: any) {
    console.error('Failed to save gateway config:', error);
    return { success: false, error: error.message };
  }
});

// Test gateway connection
ipcMain.handle('test-gateway-connection', async () => {
  try {
    const projectRoot = getProjectRoot();
    const cliPath = getCliPath();
    const nodePath = getNodePath();

    return new Promise<{ connected: boolean; directories?: any[]; error?: string }>((resolve) => {
      const args = ['gateway', 'test'];

      const child = spawn(nodePath, [cliPath, ...args], {
        cwd: projectRoot,
        env: { ...process.env },
        shell: true
      });

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      child.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      child.on('close', (code) => {
        // Parse the output to determine connection status
        const output = stdout + stderr;

        if (code === 0 && output.includes('Connected')) {
          // Parse directory results from output
          const directories: { path: string; accessible: boolean; error?: string }[] = [];
          const lines = output.split('\n');

          for (const line of lines) {
            if (line.includes('/day-ahead') || line.includes('/week-ahead') ||
                line.includes('/demand') || line.includes('/cfac') || line.includes('/other')) {
              const accessible = line.includes('✓');
              const pathMatch = line.match(/[✓✗]\s+(\S+)/);
              if (pathMatch) {
                directories.push({
                  path: pathMatch[1],
                  accessible,
                  error: accessible ? undefined : 'Not accessible'
                });
              }
            }
          }

          resolve({ connected: true, directories });
        } else {
          // Extract error message
          let error = 'Connection failed';
          if (output.includes('password not configured')) {
            error = 'Password not configured';
          } else if (output.includes('ECONNREFUSED')) {
            error = 'Connection refused - check if Tailscale is connected';
          } else if (output.includes('ETIMEDOUT')) {
            error = 'Connection timed out - check network';
          } else if (output.includes('Authentication')) {
            error = 'Authentication failed - check password';
          } else if (stderr) {
            error = stderr.split('\n')[0];
          }

          resolve({ connected: false, error });
        }
      });

      child.on('error', (err) => {
        resolve({ connected: false, error: err.message });
      });

      // Timeout after 30 seconds
      setTimeout(() => {
        child.kill();
        resolve({ connected: false, error: 'Connection timed out' });
      }, 30000);
    });
  } catch (error: any) {
    return { connected: false, error: error.message };
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// GLOBAL CONFIG IPC HANDLERS
// ═══════════════════════════════════════════════════════════════════════════════

// Load global config (uses local service to avoid ESM/CJS compatibility issues)
ipcMain.handle('load-global-config', async () => {
  return localConfigService.load();
});

// Save global config
ipcMain.handle('save-global-config', async (_event, config) => {
  localConfigService.save(config);
  return { success: true };
});

// Validate config
ipcMain.handle('validate-global-config', async (_event, config) => {
  return localConfigService.validate(config);
});

// Reset config to defaults
ipcMain.handle('reset-global-config', async () => {
  localConfigService.reset();
  return localConfigService.load();
});

// ═══════════════════════════════════════════════════════════════════════════════
// GATEWAY STORAGE MANAGEMENT IPC HANDLERS
// ═══════════════════════════════════════════════════════════════════════════════

interface GatekeeperApiConfig {
  baseUrl: string;
  adminKey: string;
}

// Helper function to get gateway API configuration
function getGatekeeperApiConfig(): GatekeeperApiConfig {
  const projectRoot = getProjectRoot();
  const configPath = path.join(projectRoot, 'config.json');

  // Default to Tailscale Funnel URL (HTTPS, no port)
  let baseUrl = 'https://vantage-gateway.taile437a5.ts.net';
  let adminKey = ''; // Admin key for authentication

  if (fs.existsSync(configPath)) {
    try {
      const configContent = fs.readFileSync(configPath, 'utf8');
      const config: ConfigFile = JSON.parse(configContent);
      // Allow override of the API URL if specified
      if (config.gatekeeperApiUrl) {
        baseUrl = config.gatekeeperApiUrl;
      }
      if (config.gatekeeperAdminKey) {
        adminKey = config.gatekeeperAdminKey;
      }
    } catch (e) {
      // Use defaults
    }
  }

  // Also check environment variable
  if (!adminKey && process.env.VANTAGE_ADMIN_KEY) {
    adminKey = process.env.VANTAGE_ADMIN_KEY;
  }

  return {
    baseUrl,
    adminKey
  };
}

// Get gateway storage statistics
ipcMain.handle('get-gateway-storage', async () => {
  try {
    const { baseUrl, adminKey } = getGatekeeperApiConfig();

    if (!adminKey) {
      return { success: false, error: 'Gatekeeper admin key not configured. Add "gatekeeperAdminKey" to config.json or set VANTAGE_ADMIN_KEY environment variable.' };
    }

    const response = await fetch(`${baseUrl}/admin/storage`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${adminKey}`
      }
    });

    if (!response.ok) {
      const errorText = await response.text();
      if (response.status === 401) {
        return { success: false, error: 'Authentication failed. Check your admin key.' };
      }
      return { success: false, error: `HTTP ${response.status}: ${errorText}` };
    }

    const data = await response.json();
    return { success: true, ...data };
  } catch (error: any) {
    console.error('Failed to get gateway storage:', error);
    if (error.code === 'ECONNREFUSED') {
      return { success: false, error: 'Cannot connect to Gatekeeper API. Is the server running?' };
    }
    if (error.cause?.code === 'ECONNREFUSED') {
      return { success: false, error: 'Cannot connect to Gatekeeper API. Is the server running?' };
    }
    return { success: false, error: error.message };
  }
});

// Archive old gateway files
ipcMain.handle('archive-gateway-files', async (_event, options: { olderThanDays: number; deleteAfterArchive?: boolean }) => {
  try {
    const { baseUrl, adminKey } = getGatekeeperApiConfig();

    if (!adminKey) {
      return { success: false, error: 'Gatekeeper admin key not configured.' };
    }

    const response = await fetch(`${baseUrl}/admin/archive`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${adminKey}`
      },
      body: JSON.stringify({
        olderThanDays: options.olderThanDays,
        deleteAfterArchive: options.deleteAfterArchive || false
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      if (response.status === 401) {
        return { success: false, error: 'Authentication failed. Check your admin key.' };
      }
      return { success: false, error: `HTTP ${response.status}: ${errorText}` };
    }

    const data = await response.json();
    return { success: true, ...data };
  } catch (error: any) {
    console.error('Failed to archive gateway files:', error);
    if (error.code === 'ECONNREFUSED' || error.cause?.code === 'ECONNREFUSED') {
      return { success: false, error: 'Cannot connect to Gatekeeper API. Is the server running?' };
    }
    return { success: false, error: error.message };
  }
});

// Clear (delete) old gateway files
ipcMain.handle('clear-gateway-files', async (_event, options: { olderThanDays: number; confirm: string }) => {
  try {
    // Validate confirmation string
    if (options.confirm !== 'DELETE') {
      return { success: false, error: 'Invalid confirmation string. Must be "DELETE".' };
    }

    const { baseUrl, adminKey } = getGatekeeperApiConfig();

    if (!adminKey) {
      return { success: false, error: 'Gatekeeper admin key not configured.' };
    }

    const response = await fetch(`${baseUrl}/admin/clear`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${adminKey}`
      },
      body: JSON.stringify({
        olderThanDays: options.olderThanDays,
        confirm: options.confirm
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      if (response.status === 401) {
        return { success: false, error: 'Authentication failed. Check your admin key.' };
      }
      return { success: false, error: `HTTP ${response.status}: ${errorText}` };
    }

    const data = await response.json();
    return { success: true, ...data };
  } catch (error: any) {
    console.error('Failed to clear gateway files:', error);
    if (error.code === 'ECONNREFUSED' || error.cause?.code === 'ECONNREFUSED') {
      return { success: false, error: 'Cannot connect to Gatekeeper API. Is the server running?' };
    }
    return { success: false, error: error.message };
  }
});
