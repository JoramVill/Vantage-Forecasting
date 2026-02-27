"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
electron_1.contextBridge.exposeInMainWorld('electronAPI', {
    // Run CLI command
    runCommand: (args) => electron_1.ipcRenderer.invoke('run-command', args),
    // Run a node script (not CLI command)
    runScript: (scriptPath, args) => electron_1.ipcRenderer.invoke('run-script', scriptPath, args),
    // Select directory
    selectDirectory: () => electron_1.ipcRenderer.invoke('select-directory'),
    // Select file
    selectFile: (filters) => electron_1.ipcRenderer.invoke('select-file', filters),
    // Save file dialog
    saveFile: (defaultName) => electron_1.ipcRenderer.invoke('save-file', defaultName),
    // Get app path
    getAppPath: () => electron_1.ipcRenderer.invoke('get-app-path'),
    // Load settings
    loadSettings: () => electron_1.ipcRenderer.invoke('load-settings'),
    // Save settings
    saveSettings: (settings) => electron_1.ipcRenderer.invoke('save-settings', settings),
    // Listen for real-time command output
    onCommandOutput: (callback) => {
        electron_1.ipcRenderer.on('command-output', (_event, data) => callback(data));
    },
    // Remove command output listener
    removeCommandOutputListener: () => {
        electron_1.ipcRenderer.removeAllListeners('command-output');
    },
    // Check data format (zonal vs regional)
    checkDataFormat: (dirPath, dataType) => electron_1.ipcRenderer.invoke('check-data-format', dirPath, dataType),
    // Check weather directory structure
    checkWeatherDirectory: (dirPath) => electron_1.ipcRenderer.invoke('check-weather-directory', dirPath),
    // Get database info (date ranges, record counts)
    getDatabaseInfo: (dbPath) => electron_1.ipcRenderer.invoke('get-database-info', dbPath),
    // Import data to database
    importToDatabase: (options) => electron_1.ipcRenderer.invoke('import-to-database', options),
    // List trained calibration models
    listTrainedModels: () => electron_1.ipcRenderer.invoke('list-trained-models'),
    // Scheduler configuration management
    loadSchedulerConfig: () => electron_1.ipcRenderer.invoke('load-scheduler-config'),
    saveSchedulerConfig: (config) => electron_1.ipcRenderer.invoke('save-scheduler-config', config),
    getRecentRuns: (limit) => electron_1.ipcRenderer.invoke('get-recent-runs', limit),
    runSchedulerManual: (date, type, horizon) => electron_1.ipcRenderer.invoke('run-scheduler-manual', date, type, horizon),
});
