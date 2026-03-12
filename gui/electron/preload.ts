import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  // Run CLI command
  runCommand: (args: string[]) =>
    ipcRenderer.invoke('run-command', args),

  // Run a node script (not CLI command)
  runScript: (scriptPath: string, args: string[]) =>
    ipcRenderer.invoke('run-script', scriptPath, args),

  // Select directory
  selectDirectory: () =>
    ipcRenderer.invoke('select-directory'),

  // Select file
  selectFile: (filters?: { name: string; extensions: string[] }[]) =>
    ipcRenderer.invoke('select-file', filters),

  // Save file dialog
  saveFile: (defaultName?: string) =>
    ipcRenderer.invoke('save-file', defaultName),

  // Get app path
  getAppPath: () =>
    ipcRenderer.invoke('get-app-path'),

  // Load settings
  loadSettings: () =>
    ipcRenderer.invoke('load-settings'),

  // Save settings
  saveSettings: (settings: Record<string, any>) =>
    ipcRenderer.invoke('save-settings', settings),

  // Listen for real-time command output
  onCommandOutput: (callback: (data: { type: string; data: string }) => void) => {
    ipcRenderer.on('command-output', (_event, data) => callback(data));
  },

  // Remove command output listener
  removeCommandOutputListener: () => {
    ipcRenderer.removeAllListeners('command-output');
  },

  // Check data format (zonal vs regional)
  checkDataFormat: (dirPath: string, dataType: 'demand' | 'database') =>
    ipcRenderer.invoke('check-data-format', dirPath, dataType),

  // Check weather directory structure
  checkWeatherDirectory: (dirPath: string) =>
    ipcRenderer.invoke('check-weather-directory', dirPath),

  // Get database info (date ranges, record counts)
  getDatabaseInfo: (dbPath: string) =>
    ipcRenderer.invoke('get-database-info', dbPath),

  // Import data to database
  importToDatabase: (options: { dbPath: string; dataType: 'demand' | 'cfac' | 'weather'; sourcePath: string }) =>
    ipcRenderer.invoke('import-to-database', options),

  // List trained calibration models
  listTrainedModels: () =>
    ipcRenderer.invoke('list-trained-models'),

  // Scheduler configuration management
  loadSchedulerConfig: () =>
    ipcRenderer.invoke('load-scheduler-config'),

  saveSchedulerConfig: (config: any) =>
    ipcRenderer.invoke('save-scheduler-config', config),

  getRecentRuns: (limit: number) =>
    ipcRenderer.invoke('get-recent-runs', limit),

  getCalibrations: (limit: number = 10) =>
    ipcRenderer.invoke('get-calibrations', limit),

  runSchedulerManual: (options: {
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
  }) => ipcRenderer.invoke('run-scheduler-manual', options),

  // Gateway configuration management
  loadGatewayConfig: () =>
    ipcRenderer.invoke('load-gateway-config'),

  saveGatewayConfig: (config: { host: string; port: number; username: string; password: string }) =>
    ipcRenderer.invoke('save-gateway-config', config),

  testGatewayConnection: () =>
    ipcRenderer.invoke('test-gateway-connection'),

  // Gateway storage management
  getGatewayStorage: () =>
    ipcRenderer.invoke('get-gateway-storage'),

  archiveGatewayFiles: (options: { olderThanDays: number; deleteAfterArchive?: boolean }) =>
    ipcRenderer.invoke('archive-gateway-files', options),

  clearGatewayFiles: (options: { olderThanDays: number; confirm: string }) =>
    ipcRenderer.invoke('clear-gateway-files', options),

  // Global config management
  loadGlobalConfig: () =>
    ipcRenderer.invoke('load-global-config'),

  saveGlobalConfig: (config: any) =>
    ipcRenderer.invoke('save-global-config', config),

  validateGlobalConfig: (config: any) =>
    ipcRenderer.invoke('validate-global-config', config),

  resetGlobalConfig: () =>
    ipcRenderer.invoke('reset-global-config'),
});

// Type declaration for window.electronAPI
declare global {
  interface Window {
    electronAPI: {
      runCommand: (args: string[]) => Promise<{ stdout: string; stderr: string; code: number; error?: string }>;
      runScript: (scriptPath: string, args: string[]) => Promise<{ stdout: string; stderr: string; code: number; error?: string }>;
      selectDirectory: () => Promise<string | null>;
      selectFile: (filters?: { name: string; extensions: string[] }[]) => Promise<string | null>;
      saveFile: (defaultName?: string) => Promise<string | null>;
      getAppPath: () => Promise<string>;
      loadSettings: () => Promise<Record<string, any>>;
      saveSettings: (settings: Record<string, any>) => Promise<boolean>;
      onCommandOutput: (callback: (data: { type: string; data: string }) => void) => void;
      removeCommandOutputListener: () => void;
      checkDataFormat: (dirPath: string, dataType: 'demand' | 'database') => Promise<{
        format: 'zonal' | 'regional' | 'mixed' | 'unknown' | 'error';
        message: string;
        columns?: string[];
      }>;
      checkWeatherDirectory: (dirPath: string) => Promise<{
        valid: boolean;
        message: string;
        hasCombined?: boolean;
        hasCityFolders?: boolean;
        windStations?: number;
        solarStations?: number;
        csvFileCount?: number;
        dateRange?: { start: string; end: string };
        folders?: string[];
      }>;
      getDatabaseInfo: (dbPath: string) => Promise<{
        success: boolean;
        message: string;
        rawOutput?: string;
        demand?: { records: number; range?: string | { start: string; end: string } | null; regions?: string[] } | null;
        cfac?: { records: number; range?: string | null } | null;
        weather?: { records: number; range?: string | null } | null;
      }>;
      importToDatabase: (options: { dbPath: string; dataType: 'demand' | 'cfac' | 'weather'; sourcePath: string }) => Promise<{
        success: boolean;
        message: string;
        stdout?: string;
        stderr?: string;
      }>;
      listTrainedModels: () => Promise<{
        success: boolean;
        message?: string;
        models?: { name: string; date: string; mape?: number }[];
      }>;
      loadSchedulerConfig: () => Promise<{
        enabled: boolean;
        runTimeMorning: string;
        runTimeEvening: string;
        secondRunEnabled: boolean;
        runDays: string[];
        forecastDemand: boolean;
        forecastCfac: boolean;
        horizonDaily: boolean;
        horizonWeekly: boolean;
        weatherMaxAge: number;
        autoPushGateway: boolean;
        archiveRetention: number;
      }>;
      saveSchedulerConfig: (config: any) => Promise<{ success: boolean; error?: string }>;
      getRecentRuns: (limit: number) => Promise<Array<{
        id: number;
        run_date: string;
        forecast_type: string;
        horizon: string;
        status: string;
        records_generated: number;
        pushed_to_gateway: boolean;
        created_at: string;
      }>>;
      getCalibrations: (limit?: number) => Promise<Array<{
        id: number;
        date: string;
        periodStart: string;
        periodEnd: string;
        windScale: number;
        solarScale: number;
        windDeviation: number;
        solarDeviation: number;
        demandMape: number;
        demandPeakScale: number;
        demandOffpeakScale: number;
        converged: boolean;
        iterations: number;
        createdAt: string;
      }>>;
      runSchedulerManual: (options: {
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
        useXgboost?: boolean;
        asymmetricLoss?: boolean;
        biasCorrection?: boolean;
        weatherCacheDir?: string;
      }) => Promise<{
        success: boolean;
        output?: string;
        error?: string;
      }>;
      loadGatewayConfig: () => Promise<{
        host: string;
        port: number;
        username: string;
        password: string;
      }>;
      saveGatewayConfig: (config: { host: string; port: number; username: string; password: string }) => Promise<{
        success: boolean;
        error?: string;
      }>;
      testGatewayConnection: () => Promise<{
        connected: boolean;
        directories?: { path: string; accessible: boolean; error?: string }[];
        error?: string;
      }>;
      getGatewayStorage: () => Promise<{
        success: boolean;
        error?: string;
        categories?: Record<string, {
          files: number;
          size: number;
          sizeFormatted: string;
          oldest: string;
          newest: string;
        }>;
        totalFiles?: number;
        totalSize?: number;
        totalSizeFormatted?: string;
        oldestFile?: string;
        newestFile?: string;
      }>;
      archiveGatewayFiles: (options: { olderThanDays: number; deleteAfterArchive?: boolean }) => Promise<{
        success: boolean;
        error?: string;
        message?: string;
        cutoffDate?: string;
        results?: {
          archived: { file: string; date: string; action: string }[];
          errors: string[];
        };
      }>;
      clearGatewayFiles: (options: { olderThanDays: number; confirm: string }) => Promise<{
        success: boolean;
        error?: string;
        message?: string;
        cutoffDate?: string;
        results?: {
          deleted: { file: string; date: string }[];
          errors: string[];
        };
      }>;
      loadGlobalConfig: () => Promise<any>;
      saveGlobalConfig: (config: any) => Promise<{ success: boolean }>;
      validateGlobalConfig: (config: any) => Promise<{ valid: boolean; errors: string[] }>;
      resetGlobalConfig: () => Promise<any>;
    };
  }
}
