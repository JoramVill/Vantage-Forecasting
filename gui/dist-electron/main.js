"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
const child_process_1 = require("child_process");
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const electron_store_1 = __importDefault(require("electron-store"));
// Zone codes for detection
const ZONAL_CODES = ['01NLUZ', '02METRO', '03SLUZ', '04LEYTE', '05CEBU', '06NEGROS', '07BOHOL', '08PANAY', '09NWMIN', '10LANAO', '11NCMIN', '12NEMIN', '13SEMIN', '14SWMIN'];
const REGIONAL_CODES = ['CLUZ', 'CVIS', 'CMIN'];
// Settings store with encryption
const store = new electron_store_1.default({
    name: 'vantage-forecaster-settings',
    encryptionKey: 'vantage-forecaster-2024',
});
let mainWindow = null;
function createWindow() {
    // Get icon path - go up from dist-electron to gui, then to assets
    const guiDir = path.dirname(__dirname);
    const iconPath = path.join(guiDir, 'assets', 'VANTAGE_LOGO-removebg-preview.ico');
    mainWindow = new electron_1.BrowserWindow({
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
    }
    else {
        mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
    }
    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}
electron_1.app.whenReady().then(createWindow);
electron_1.app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        electron_1.app.quit();
    }
});
electron_1.app.on('activate', () => {
    if (electron_1.BrowserWindow.getAllWindows().length === 0) {
        createWindow();
    }
});
// Get the CLI path - go up from gui/dist-electron to project root
function getCliPath() {
    const guiDir = path.dirname(__dirname);
    const projectRoot = path.dirname(guiDir);
    return path.join(projectRoot, 'dist', 'index.js');
}
function getProjectRoot() {
    const guiDir = path.dirname(__dirname);
    return path.dirname(guiDir);
}
// IPC Handler: Run CLI command with real-time output
electron_1.ipcMain.handle('run-command', async (_event, args) => {
    return new Promise((resolve) => {
        const cliPath = getCliPath();
        const projectRoot = getProjectRoot();
        console.log('Running command:', 'node', cliPath, ...args);
        console.log('Working directory:', projectRoot);
        const child = (0, child_process_1.spawn)('node', [cliPath, ...args], {
            cwd: projectRoot,
            shell: false,
            env: { ...process.env },
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (data) => {
            const text = data.toString();
            stdout += text;
            // Send real-time output to renderer
            if (mainWindow) {
                mainWindow.webContents.send('command-output', { type: 'stdout', data: text });
            }
        });
        child.stderr.on('data', (data) => {
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
electron_1.ipcMain.handle('select-directory', async () => {
    if (!mainWindow)
        return null;
    const result = await electron_1.dialog.showOpenDialog(mainWindow, {
        properties: ['openDirectory'],
    });
    return result.canceled ? null : result.filePaths[0];
});
// IPC Handler: Select file
electron_1.ipcMain.handle('select-file', async (_event, filters) => {
    if (!mainWindow)
        return null;
    const result = await electron_1.dialog.showOpenDialog(mainWindow, {
        properties: ['openFile'],
        filters: filters || [{ name: 'All Files', extensions: ['*'] }],
    });
    return result.canceled ? null : result.filePaths[0];
});
// IPC Handler: Save file dialog
electron_1.ipcMain.handle('save-file', async (_event, defaultName) => {
    if (!mainWindow)
        return null;
    const result = await electron_1.dialog.showSaveDialog(mainWindow, {
        defaultPath: defaultName || 'forecast.csv',
        filters: [
            { name: 'CSV Files', extensions: ['csv'] },
            { name: 'All Files', extensions: ['*'] },
        ],
    });
    return result.canceled ? null : result.filePath;
});
// IPC Handler: Get app path
electron_1.ipcMain.handle('get-app-path', () => {
    return getProjectRoot();
});
// IPC Handler: Load settings
electron_1.ipcMain.handle('load-settings', () => {
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
electron_1.ipcMain.handle('save-settings', (_event, settings) => {
    for (const [key, value] of Object.entries(settings)) {
        store.set(key, value);
    }
    return true;
});
// IPC Handler: Check data format (zonal vs regional)
electron_1.ipcMain.handle('check-data-format', async (_event, dirPath, dataType) => {
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
        }
        else if (hasRegional && !hasZonal) {
            return {
                format: 'regional',
                message: 'Detected 3-region format (CLUZ, CVIS, CMIN)',
                columns: REGIONAL_CODES.filter(code => header.includes(code))
            };
        }
        else if (hasZonal && hasRegional) {
            return {
                format: 'mixed',
                message: 'Data contains both zonal and regional columns'
            };
        }
        else {
            return {
                format: 'unknown',
                message: 'Could not detect data format from CSV headers'
            };
        }
    }
    catch (error) {
        return { format: 'error', message: error.message };
    }
});
// IPC Handler: Check weather directory structure
electron_1.ipcMain.handle('check-weather-directory', async (_event, dirPath) => {
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
        if (hasCombined)
            parts.push('combined');
        if (hasZonal)
            parts.push('zonal');
        if (zonalFolders.length > 0)
            parts.push(`${zonalFolders.length} zone folders`);
        if (windFolders.length > 0)
            parts.push(`${windFolders.length} wind`);
        if (solarFolders.length > 0)
            parts.push(`${solarFolders.length} solar`);
        let message = `Weather cache: ${parts.join(', ')}`;
        if (dateRange.start && dateRange.end) {
            message += ` (${dateRange.start} to ${dateRange.end})`;
        }
        return { valid: true, message, ...info };
    }
    catch (error) {
        return { valid: false, message: error.message };
    }
});
// IPC Handler: Get database info (date ranges, record counts)
electron_1.ipcMain.handle('get-database-info', async (_event, dbPath) => {
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
        const child = (0, child_process_1.spawn)('node', [scriptPath, fullPath], {
            cwd: projectRoot,
            shell: false,
            env: { ...process.env },
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
            }
            catch (parseError) {
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
electron_1.ipcMain.handle('import-to-database', async (_event, options) => {
    return new Promise((resolve) => {
        const cliPath = getCliPath();
        const projectRoot = getProjectRoot();
        // Build the import command
        const args = ['db', 'import', '-t', options.dataType, '-f', options.sourcePath, '--db', options.dbPath];
        console.log('Running import:', 'node', cliPath, ...args);
        const child = (0, child_process_1.spawn)('node', [cliPath, ...args], {
            cwd: projectRoot,
            shell: false,
            env: { ...process.env },
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (data) => {
            const text = data.toString();
            stdout += text;
            if (mainWindow) {
                mainWindow.webContents.send('command-output', { type: 'stdout', data: text });
            }
        });
        child.stderr.on('data', (data) => {
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
