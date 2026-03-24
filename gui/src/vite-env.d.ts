/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<{}, {}, any>;
  export default component;
}

interface Window {
  electronAPI: {
    runCommand: (args: string[]) => Promise<{ stdout: string; stderr: string; code: number; error?: string }>;
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
    getZonesConfig: () => Promise<{
      zones: Array<{ code: string; name: string; parentRegion: string }>;
      regions: Array<{ code: string; name: string; parentKey: string }>;
      zoneToRegion: Record<string, string>;
    }>;
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
    loadGlobalConfig: () => Promise<any>;
    saveGlobalConfig: (config: any) => Promise<void>;
    validateGlobalConfig: (config: any) => Promise<{ valid: boolean; errors: string[] }>;
    resetGlobalConfig: () => Promise<any>;
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
    // Model management
    initModelStore: () => Promise<void>;
    listModels: (filters?: { entityType?: string; entityCode?: string; isActive?: boolean }) => Promise<Array<{
      id: string;
      entity_type: string;
      entity_code: string;
      model_type: string;
      version: number;
      trained_at: string;
      mape?: number;
      rmse?: number;
      is_active: boolean;
      is_archived: boolean;
      file_path: string;
    }>>;
    getTrainingInstances: () => Promise<Array<{
      id: string;
      entityType: string;
      trainedAt: string;
      modelCount: number;
      activeCount: number;
      avgMape: number | null;
      minMape: number | null;
      maxMape: number | null;
      trainingPeriod: { start: string; end: string } | null;
      models: any[];
    }>>;
    getModelById: (id: string) => Promise<any>;
    getActiveModel: (entityType: string, entityCode: string) => Promise<any>;
    activateModel: (id: string) => Promise<void>;
    archiveModel: (id: string) => Promise<void>;
    deleteModel: (id: string) => Promise<void>;
    setSchedulerActiveModel: (id: string) => Promise<{ success: boolean; error?: string }>;
    setManualActiveModel: (id: string) => Promise<{ success: boolean; error?: string }>;
    trainModel: (options: {
      demandPath: string;
      startDate: string;
      endDate: string;
      modelType: string;
      type: string;
      holdoutDays?: number;
      autoActivate?: boolean;
    }) => Promise<any>;
    listModelGroups: () => Promise<Array<{ group_code: string; group_type: string; description?: string }>>;
    listTrainingRuns: (limit?: number) => Promise<Array<{
      id: string;
      started_at: string;
      completed_at?: string;
      status: string;
      entities_trained?: number;
    }>>;
    // Save trained model from Manual tab
    saveTrainedModel: (options: {
      name: string;
      notes: string;
      modelData: any;
      entityType: string;
      entityCode: string;
    }) => Promise<{ success: boolean; id?: string; path?: string; error?: string }>;
    // Re-evaluate model
    reEvaluateModel: (id: string, options?: { days?: number; update?: boolean }) => Promise<any>;
    // Export model
    exportModel: (id: string) => Promise<{ success: boolean; path?: string; error?: string }>;
    // Import model
    importModel: () => Promise<{ success: boolean; id?: string; error?: string }>;
    // Update model selection config
    updateModelSelection: (modelSelection: any) => Promise<{ success: boolean; error?: string }>;
    // Training plan management
    listTrainingPlans: () => Promise<Array<{
      id: string;
      name: string;
      description?: string;
      dateRange: {
        mode: 'fixed' | 'rolling';
        fixedStart?: string;
        fixedEnd?: string;
        rollingDays?: 14 | 30 | 90 | 180 | 365;
      };
      trainDemand: boolean;
      trainCfac: boolean;
      demandModelType: 'hybrid' | 'xgboost' | 'regression';
      cfacModelType: '4tier' | 'hybrid' | 'mrec' | 'physics';
      calibrationEnabled: boolean;
      calibrationIterations: number;
      calibrationThreshold: number;
      holdoutDays: number;
      autoActivate: boolean;
      createdAt: string;
      updatedAt: string;
    }>>;
    createTrainingPlan: (plan: {
      name: string;
      description?: string;
      dateRange: {
        mode: 'fixed' | 'rolling';
        fixedStart?: string;
        fixedEnd?: string;
        rollingDays?: 14 | 30 | 90 | 180 | 365;
      };
      trainDemand: boolean;
      trainCfac: boolean;
      demandModelType: 'hybrid' | 'xgboost' | 'regression';
      cfacModelType: '4tier' | 'hybrid' | 'mrec' | 'physics';
      calibrationEnabled: boolean;
      calibrationIterations: number;
      calibrationThreshold: number;
      holdoutDays: number;
      autoActivate: boolean;
    }) => Promise<{
      id: string;
      name: string;
      description?: string;
      dateRange: {
        mode: 'fixed' | 'rolling';
        fixedStart?: string;
        fixedEnd?: string;
        rollingDays?: 14 | 30 | 90 | 180 | 365;
      };
      trainDemand: boolean;
      trainCfac: boolean;
      demandModelType: 'hybrid' | 'xgboost' | 'regression';
      cfacModelType: '4tier' | 'hybrid' | 'mrec' | 'physics';
      calibrationEnabled: boolean;
      calibrationIterations: number;
      calibrationThreshold: number;
      holdoutDays: number;
      autoActivate: boolean;
      createdAt: string;
      updatedAt: string;
    }>;
    updateTrainingPlan: (id: string, updates: Partial<{
      name: string;
      description?: string;
      dateRange: {
        mode: 'fixed' | 'rolling';
        fixedStart?: string;
        fixedEnd?: string;
        rollingDays?: 14 | 30 | 90 | 180 | 365;
      };
      trainDemand: boolean;
      trainCfac: boolean;
      demandModelType: 'hybrid' | 'xgboost' | 'regression';
      cfacModelType: '4tier' | 'hybrid' | 'mrec' | 'physics';
      calibrationEnabled: boolean;
      calibrationIterations: number;
      calibrationThreshold: number;
      holdoutDays: number;
      autoActivate: boolean;
    }>) => Promise<{
      id: string;
      name: string;
      description?: string;
      dateRange: {
        mode: 'fixed' | 'rolling';
        fixedStart?: string;
        fixedEnd?: string;
        rollingDays?: 14 | 30 | 90 | 180 | 365;
      };
      trainDemand: boolean;
      trainCfac: boolean;
      demandModelType: 'hybrid' | 'xgboost' | 'regression';
      cfacModelType: '4tier' | 'hybrid' | 'mrec' | 'physics';
      calibrationEnabled: boolean;
      calibrationIterations: number;
      calibrationThreshold: number;
      holdoutDays: number;
      autoActivate: boolean;
      createdAt: string;
      updatedAt: string;
    }>;
    deleteTrainingPlan: (id: string) => Promise<void>;
    // CFAC Calibration management
    listCfacCalibrations: () => Promise<Array<{
      id: string;
      createdAt: string;
      trainingStart: string;
      trainingEnd: string;
      windMAPE: number;
      solarMAPE: number;
      stationCount: number;
      isActive: boolean;
    }>>;
    getCfacCalibrationDetails: (id: string) => Promise<{
      id: string;
      createdAt: string;
      trainingPeriod: { start: string; end: string };
      config: {
        useXgboost: boolean;
        asymmetricLoss: boolean;
        biasCorrection: boolean;
        autoCalibrateDays: number;
        excludeOutages: boolean;
      };
      globalFactors: {
        windBias: number;
        solarBias: number;
        otherBias: number;
      };
      solarHourlyScale: Record<number, number>;
      windMRECFactors: Record<string, {
        stationCode: string;
        vL: number;
        vH: number;
        tL: number;
        tH: number;
        calibrated: boolean;
      }>;
      stationScales: {
        wind: Record<string, number>;
        solar: Record<string, number>;
        other: Record<string, number>;
      };
      trainingMetrics: {
        windMAPE: number;
        solarMAPE: number;
        stationCount: number;
        trainingRecords: number;
      };
    } | null>;
    setActiveCfacCalibration: (id: string) => Promise<void>;
    deleteCfacCalibration: (id: string) => Promise<boolean>;
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
  };
}
