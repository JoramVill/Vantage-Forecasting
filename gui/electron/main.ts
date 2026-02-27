import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import Store from 'electron-store';
import Database from 'better-sqlite3';

// Zone codes for detection
const ZONAL_CODES = ['01NLUZ', '02METRO', '03SLUZ', '04LEYTE', '05CEBU', '06NEGROS', '07BOHOL', '08PANAY', '09NWMIN', '10LANAO', '11NCMIN', '12NEMIN', '13SEMIN', '14SWMIN'];
const REGIONAL_CODES = ['CLUZ', 'CVIS', 'CMIN'];

// Settings store with encryption
const store = new Store({
  name: 'vantage-forecaster-settings',
  encryptionKey: 'vantage-forecaster-2024',
});

let mainWindow: BrowserWindow | null = null;

function createWindow() {
  // Get icon path - go up from dist-electron to gui, then to assets
  const guiDir = path.dirname(__dirname);
  const iconPath = path.join(guiDir, 'assets', 'VANTAGE_LOGO-removebg-preview.ico');

  mainWindow = new BrowserWindow({
    width: 1000,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: 'Vantage Forecaster',
    icon: iconPath,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

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

// Get the CLI path - go up from gui/dist-electron to project root
function getCliPath(): string {
  const guiDir = path.dirname(__dirname);
  const projectRoot = path.dirname(guiDir);
  return path.join(projectRoot, 'dist', 'index.js');
}

function getProjectRoot(): string {
  const guiDir = path.dirname(__dirname);
  return path.dirname(guiDir);
}

// IPC Handler: Run CLI command with real-time output
ipcMain.handle('run-command', async (_event, args: string[]) => {
  return new Promise((resolve) => {
    const cliPath = getCliPath();
    const projectRoot = getProjectRoot();

    console.log('Running command:', 'node', cliPath, ...args);
    console.log('Working directory:', projectRoot);

    const child = spawn('node', [cliPath, ...args], {
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

    console.log('Running script:', 'node', fullScriptPath, ...args);
    console.log('Working directory:', projectRoot);

    const child = spawn('node', [fullScriptPath, ...args], {
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
ipcMain.handle('load-settings', () => {
  return {
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
    cfacModel: store.get('cfacModel', 'lstm'), // LSTM is the new default
    // Output naming settings
    demandPrefix: store.get('demandPrefix', 'FC_DEM_'),
    demandZonalPrefix: store.get('demandZonalPrefix', 'FC_ZDEM_'),
    cfacPrefix: store.get('cfacPrefix', 'FC_CF_'),
    outputSuffix: store.get('outputSuffix', ''),
    useCustomName: store.get('useCustomName', false),
    customDemandName: store.get('customDemandName', ''),
    customCfacName: store.get('customCfacName', ''),
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
    const child = spawn('node', [scriptPath, fullPath], {
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

    console.log('Running import:', 'node', cliPath, ...args);

    const child = spawn('node', [cliPath, ...args], {
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

// Load scheduler configuration from database
ipcMain.handle('load-scheduler-config', async () => {
  try {
    const projectRoot = getProjectRoot();
    const dbPath = path.join(projectRoot, 'forecast.db');

    // Check if database exists
    if (!fs.existsSync(dbPath)) {
      // Return defaults if database doesn't exist
      return {
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
    }

    // Use better-sqlite3 to read config
    const db = new Database(dbPath);

    const config = db.prepare('SELECT * FROM scheduler_config WHERE id = 1').get() as any;
    db.close();

    if (!config) {
      // Return defaults if no config found
      return {
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
    }

    // Parse database values to config format
    const dayMap: Record<string, string> = {'1':'Mon','2':'Tue','3':'Wed','4':'Thu','5':'Fri','6':'Sat','7':'Sun'};
    const runDays = config.run_days ? config.run_days.split(',').map((d: string) => {
      return dayMap[d.trim()] || d.trim();
    }) : ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];

    const forecastTypes = config.forecast_types || 'demand,cfac';
    const horizons = config.horizons || 'daily,weekly';

    return {
      enabled: config.enabled === 1,
      runTimeMorning: config.run_time_morning || '06:00',
      runTimeEvening: config.run_time_evening || '18:00',
      secondRunEnabled: !!config.run_time_evening,
      runDays,
      forecastDemand: forecastTypes.includes('demand'),
      forecastCfac: forecastTypes.includes('cfac'),
      horizonDaily: horizons.includes('daily'),
      horizonWeekly: horizons.includes('weekly'),
      weatherMaxAge: config.weather_max_age_hours || 6,
      autoPushGateway: config.auto_push_gateway === 1,
      archiveRetention: config.archive_retention_days || 90
    };
  } catch (error: any) {
    console.error('Failed to load scheduler config:', error);
    // Return defaults on error
    return {
      enabled: false,
      runTimeMorning: '06:00',
      runTimeEvening: '18:00',
      secondRunEnabled: false,
      runDays: ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'],
      forecastDemand: true,
      forecastCfac: true,
      horizonDaily: true,
      horizonWeekly: true,
      weatherMaxAge: 6,
      autoPushGateway: false,
      archiveRetention: 90
    };
  }
});

// Save scheduler configuration to database
ipcMain.handle('save-scheduler-config', async (_event, config) => {
  try {
    const projectRoot = getProjectRoot();
    const dbPath = path.join(projectRoot, 'forecast.db');

    const db = new Database(dbPath);

    // Convert runDays to database format (1-7)
    const dayMap: Record<string, string> = {'Mon':'1','Tue':'2','Wed':'3','Thu':'4','Fri':'5','Sat':'6','Sun':'7'};
    const runDays = config.runDays.map((d: string) => dayMap[d] || d).join(',');

    // Build forecast_types and horizons
    const forecastTypes = [];
    if (config.forecastDemand) forecastTypes.push('demand');
    if (config.forecastCfac) forecastTypes.push('cfac');

    const horizons = [];
    if (config.horizonDaily) horizons.push('daily');
    if (config.horizonWeekly) horizons.push('weekly');

    db.prepare(`
      INSERT INTO scheduler_config (id, enabled, run_time_morning, run_time_evening,
        run_days, forecast_types, horizons, weather_max_age_hours,
        auto_push_gateway, archive_retention_days, updated_at)
      VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(id) DO UPDATE SET
        enabled = excluded.enabled,
        run_time_morning = excluded.run_time_morning,
        run_time_evening = excluded.run_time_evening,
        run_days = excluded.run_days,
        forecast_types = excluded.forecast_types,
        horizons = excluded.horizons,
        weather_max_age_hours = excluded.weather_max_age_hours,
        auto_push_gateway = excluded.auto_push_gateway,
        archive_retention_days = excluded.archive_retention_days,
        updated_at = excluded.updated_at
    `).run(
      config.enabled ? 1 : 0,
      config.runTimeMorning,
      config.secondRunEnabled ? config.runTimeEvening : null,
      runDays,
      forecastTypes.join(','),
      horizons.join(','),
      config.weatherMaxAge,
      config.autoPushGateway ? 1 : 0,
      config.archiveRetention
    );

    db.close();
    return { success: true };
  } catch (error: any) {
    console.error('Failed to save scheduler config:', error);
    return { success: false, error: error.message };
  }
});

// Get recent forecast runs from database
ipcMain.handle('get-recent-runs', async (_event, limit = 20) => {
  try {
    const projectRoot = getProjectRoot();
    const dbPath = path.join(projectRoot, 'forecast.db');

    // Check if database exists
    if (!fs.existsSync(dbPath)) {
      return [];
    }

    const db = new Database(dbPath);

    const runs = db.prepare(`
      SELECT id, run_date, forecast_type, horizon, status,
             records_generated, gateway_path, created_at
      FROM forecast_runs
      ORDER BY created_at DESC
      LIMIT ?
    `).all(limit) as any[];

    db.close();

    return runs.map((run: any) => ({
      ...run,
      pushed_to_gateway: !!run.gateway_path
    }));
  } catch (error: any) {
    console.error('Failed to get recent runs:', error);
    return [];
  }
});

// Run scheduler manually with specified parameters
ipcMain.handle('run-scheduler-manual', async (_event, date, type, horizon) => {
  const cliPath = getCliPath();
  const projectRoot = getProjectRoot();

  // Build CLI arguments
  const args = [cliPath, 'scheduler', 'run', '-d', date];

  if (type === 'demand') args.push('--demand-only');
  else if (type === 'cfac') args.push('--cfac-only');

  if (horizon === 'daily') args.push('--daily');
  else if (horizon === 'weekly') args.push('--weekly');

  console.log('Running scheduler:', 'node', ...args);

  // Return promise that resolves when command completes
  return new Promise((resolve) => {
    const child = spawn('node', args, {
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
