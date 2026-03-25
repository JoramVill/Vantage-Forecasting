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

  // Zones configuration (loaded from zones.json)
  getZonesConfig: () =>
    ipcRenderer.invoke('get-zones-config'),

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
    useCalibrationId?: string | number | null; // String UUID from CFAC calibration service or legacy number
    useModelId?: string | null; // Use saved trained model from model store (skips training)
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

  getGatewayFiles: (filters?: { type?: string; category?: string; geography?: string; limit?: number }) =>
    ipcRenderer.invoke('get-gateway-files', filters),

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

  updateModelSelection: (modelSelection: any) =>
    ipcRenderer.invoke('update-model-selection', modelSelection),

  // Model Management
  initModelStore: () =>
    ipcRenderer.invoke('init-model-store'),

  listModels: (filters?: { entityType?: string; entityCode?: string; isActive?: boolean }) =>
    ipcRenderer.invoke('list-models', filters),

  getTrainingInstances: () =>
    ipcRenderer.invoke('get-training-instances'),

  getModelById: (id: string) =>
    ipcRenderer.invoke('get-model-by-id', id),

  getActiveModel: (entityType: string, entityCode: string) =>
    ipcRenderer.invoke('get-active-model', entityType, entityCode),

  activateModel: (id: string) =>
    ipcRenderer.invoke('activate-model', id),

  archiveModel: (id: string) =>
    ipcRenderer.invoke('archive-model', id),

  deleteModel: (id: string) =>
    ipcRenderer.invoke('delete-model', id),

  setSchedulerActiveModel: (id: string) =>
    ipcRenderer.invoke('set-scheduler-active', id),

  setManualActiveModel: (id: string) =>
    ipcRenderer.invoke('set-manual-active', id),

  trainModel: (options: {
    type: 'regional' | 'zonal';
    demandPath: string;
    startDate: string;
    endDate: string;
    modelType: string;
    holdoutDays: number;
    autoActivate: boolean;
  }) =>
    ipcRenderer.invoke('train-model', options),

  listModelGroups: () =>
    ipcRenderer.invoke('list-model-groups'),

  listTrainingRuns: (limit: number) =>
    ipcRenderer.invoke('list-training-runs', limit),

  reEvaluateModel: (id: string, options?: { days?: number; update?: boolean }) =>
    ipcRenderer.invoke('re-evaluate-model', id, options),

  saveTrainedModel: (modelData: any) =>
    ipcRenderer.invoke('save-trained-model', modelData),

  exportModel: (id: string) =>
    ipcRenderer.invoke('export-model', id),

  importModel: () =>
    ipcRenderer.invoke('import-model'),

  // Training Plan management
  listTrainingPlans: () =>
    ipcRenderer.invoke('training-plan:list'),

  getTrainingPlan: (id: string) =>
    ipcRenderer.invoke('training-plan:get', id),

  createTrainingPlan: (plan: any) =>
    ipcRenderer.invoke('training-plan:create', plan),

  updateTrainingPlan: (id: string, updates: any) =>
    ipcRenderer.invoke('training-plan:update', id, updates),

  deleteTrainingPlan: (id: string) =>
    ipcRenderer.invoke('training-plan:delete', id),

  // CFAC Calibration management
  listCfacCalibrations: () =>
    ipcRenderer.invoke('cfac-calibration:list'),

  getCfacCalibrationDetails: (id: string) =>
    ipcRenderer.invoke('cfac-calibration:get', id),

  setActiveCfacCalibration: (id: string) =>
    ipcRenderer.invoke('cfac-calibration:set-active', id),

  deleteCfacCalibration: (id: string) =>
    ipcRenderer.invoke('cfac-calibration:delete', id),

  // Demand Calibration management
  demandCalibration: {
    runIterative: (options: { forecastPath: string; actualPath: string; dateTimeColumn?: string }) =>
      ipcRenderer.invoke('demand-calibration:run-iterative', options),
    runHybrid: (options: { forecastPath: string; actualPath: string; alpha?: number; dateTimeColumn?: string }) =>
      ipcRenderer.invoke('demand-calibration:run-hybrid', options),
    list: () => ipcRenderer.invoke('demand-calibration:list'),
    load: (filename: string) => ipcRenderer.invoke('demand-calibration:load', filename),
    save: (data: any, filename: string) => ipcRenderer.invoke('demand-calibration:save', data, filename),
  },

  // Unified forecast with calibration
  runDemandForecastCalibrated: (options: {
    startDate: string;
    endDate: string;
    outputPath: string;
    geography: 'regional' | 'zonal' | 'both';
    trainingPath?: string;
    actualPath?: string;
    calibrationMode?: 'hybrid' | 'iterative' | 'xgboost' | 'none';
    quantileAlpha?: number;
  }) => ipcRenderer.invoke('run-demand-forecast-calibrated', options),

  // V2 Operations (for GUI V2 Operations Tab)
  listVfmFiles: (directory?: string) =>
    ipcRenderer.invoke('list-vfm-files', directory),

  listCalibrationFiles: (directory?: string) =>
    ipcRenderer.invoke('list-calibration-files', directory),

  // Delete a file (.vfm or calibration.json)
  deleteFile: (filePath: string) =>
    ipcRenderer.invoke('delete-file', filePath),

  // Read .vfm file contents (for Models Tab file view)
  readVfmFile: (filePath: string) =>
    ipcRenderer.invoke('read-vfm-file', filePath),

  // Get file stats (for calibration age calculation)
  getFileStats: (filePath: string) =>
    ipcRenderer.invoke('get-file-stats', filePath),
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
        useCalibrationId?: string | number | null; // String UUID from CFAC calibration service or legacy number
        useModelId?: string | null; // Use saved trained model from model store (skips training)
        useDb?: boolean;
        dataDbPath?: string | null;
        maxIterations?: number;
        refreshWeather?: boolean;
        overwrite?: boolean;
        suffix?: string | null;
        outputDir?: string;
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
      getGatewayFiles: (filters?: { type?: string; category?: string; geography?: string; limit?: number }) => Promise<{
        success: boolean;
        error?: string;
        files?: Array<{
          filename: string;
          type: string;
          category: string;
          geography: string | null;
          size: number;
          sizeFormatted: string;
          date: string;
          modified: string;
          path: string;
        }>;
        count?: number;
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
      updateModelSelection: (modelSelection: any) => Promise<{ success: boolean; error?: string }>;

      // Model Management
      initModelStore: () => Promise<void>;
      listModels: (filters?: { entityType?: string; entityCode?: string; isActive?: boolean }) => Promise<any[]>;
      getTrainingInstances: () => Promise<any[]>;
      getModelById: (id: string) => Promise<any | null>;
      getActiveModel: (entityType: string, entityCode: string) => Promise<any | null>;
      activateModel: (id: string) => Promise<void>;
      archiveModel: (id: string) => Promise<void>;
      deleteModel: (id: string) => Promise<void>;
      setSchedulerActiveModel: (id: string) => Promise<{ success: boolean; error?: string }>;
      setManualActiveModel: (id: string) => Promise<{ success: boolean; error?: string }>;
      trainModel: (options: any) => Promise<any[]>;
      listModelGroups: () => Promise<any[]>;
      listTrainingRuns: (limit: number) => Promise<any[]>;
      reEvaluateModel: (id: string, options?: { days?: number; update?: boolean }) => Promise<any>;
      saveTrainedModel: (modelData: any) => Promise<{ success: boolean; error?: string }>;
      exportModel: (id: string) => Promise<{ success: boolean; path?: string; error?: string }>;
      importModel: () => Promise<{ success: boolean; id?: string; error?: string }>;

      // Training Plan management
      listTrainingPlans: () => Promise<any[]>;
      getTrainingPlan: (id: string) => Promise<any | null>;
      createTrainingPlan: (plan: any) => Promise<any>;
      updateTrainingPlan: (id: string, updates: any) => Promise<any>;
      deleteTrainingPlan: (id: string) => Promise<void>;

      // CFAC Calibration management
      listCfacCalibrations: () => Promise<any[]>;
      getCfacCalibrationDetails: (id: string) => Promise<any | null>;
      setActiveCfacCalibration: (id: string) => Promise<void>;
      deleteCfacCalibration: (id: string) => Promise<boolean>;

      // Demand Calibration management
      demandCalibration: {
        runIterative: (options: { forecastPath: string; actualPath: string; dateTimeColumn?: string }) => Promise<{
          success: boolean;
          error?: string;
          calibration?: any;
          metrics?: any;
        }>;
        runHybrid: (options: { forecastPath: string; actualPath: string; alpha?: number; dateTimeColumn?: string }) => Promise<{
          success: boolean;
          error?: string;
          calibration?: any;
          metrics?: any;
        }>;
        list: () => Promise<any[]>;
        load: (filename: string) => Promise<any | null>;
        save: (data: any, filename: string) => Promise<{ success: boolean; error?: string }>;
      };

      // Unified forecast with calibration
      runDemandForecastCalibrated: (options: {
        startDate: string;
        endDate: string;
        outputPath: string;
        geography: 'regional' | 'zonal' | 'both';
        trainingPath?: string;
        actualPath?: string;
        calibrationMode?: 'hybrid' | 'iterative' | 'xgboost' | 'none';
        quantileAlpha?: number;
      }) => Promise<{
        success: boolean;
        error?: string;
        outputPath?: string;
        calibration?: {
          mode: string;
          applied: boolean;
          reason?: string;
          result?: any;
        };
      }>;

      // V2 Operations (for GUI V2 Operations Tab)
      listVfmFiles: (directory?: string) => Promise<Array<{ name: string; path: string; size: number; modified: string }>>;
      listCalibrationFiles: (directory?: string) => Promise<Array<{ name: string; path: string; size: number; modified: string }>>;
      deleteFile: (filePath: string) => Promise<{ success: boolean; error?: string }>;
      getFileStats: (filePath: string) => Promise<{ exists: boolean; size?: number; modified?: number; error?: string }>;
    };
  }
}
