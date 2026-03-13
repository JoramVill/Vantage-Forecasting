<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch, toRaw } from 'vue';

// Data source
const dataSource = ref<'database' | 'csv'>('csv');
const databasePath = ref('');
const demandDataDir = ref('');
const cfacDataDir = ref('');
const weatherDataDir = ref('');
const demandOutputDir = ref('output/Demand');
const cfacOutputDir = ref('output/CFAC');

// Weather directory validation - UNUSED
// const weatherDirStatus = ref<{ valid: boolean; message: string } | null>(null);

// Database info
const databaseInfo = ref<{
  demand?: { records: number; range?: string | { start: string; end: string } | null; regions?: string[] } | null;
  cfac?: { records: number; range?: string | null } | null;
  weather?: { records: number; range?: string | null } | null;
} | null>(null);
const isLoadingDbInfo = ref(false);
// const isImporting = ref(false); // UNUSED
// const showDbUpdatePanel = ref(false); // Unused - commented out

// Date ranges
const trainingStart = ref('');
const trainingEnd = ref('');
const forecastStart = ref('');
const forecastEnd = ref('');

// Tab navigation
const activeTab = ref<'manual' | 'scheduler' | 'gateway' | 'settings'>('manual');

// Forecast options
const enableDemand = ref(true);
const enableCfac = ref(true);
// enableZonal is now a computed property that syncs with globalConfig.demand.geography
// Manual tab checkbox: ON = zonal or both, OFF = regional
const enableZonal = computed({
  get: () => {
    const geo = globalConfig.value?.demand?.geography;
    return geo === 'zonal' || geo === 'both';
  },
  set: (val: boolean) => {
    if (globalConfig.value?.demand) {
      // When toggling checkbox: zonal/regional only (not both - that's scheduler-only)
      globalConfig.value.demand.geography = val ? 'zonal' : 'regional';
      // Also sync scheduler dropdown
      schedulerConfig.value.demandGeography = globalConfig.value.demand.geography;
      // Save config so CLI reads updated value
      saveGlobalConfig();
    }
  }
});
const scalingPercent = ref(100);
const scalingWind = ref(100); // Per-type scaling for wind
const scalingSolar = ref(100); // Per-type scaling for solar
const usePerTypeScaling = ref(false); // Enable per-type scaling mode
const cfacModel = ref<'hybrid' | 'hybrid-lstm' | 'legacy'>('hybrid'); // Hybrid (physics + ML) is the best performer
const demandModel = ref<'hybrid' | 'hybrid-calibrated'>('hybrid-calibrated'); // Hybrid + XGBoost calibration is best (4.77% MAPE)
const pushToGateway = ref(false); // Push forecasts to Vantage-Gateway server
const demandGrowthRate = ref(0); // Daily demand growth rate (e.g., 0.001 = 0.1%)
const trainingEndDate = ref(''); // Optional training data cutoff date

// Scheduler state - OLD (legacy, not used by new scheduler tab)
// const schedulerMode = ref<'run' | 'backfill'>('run');
// const schedulerAsOfDate = ref('');
// const schedulerStartDate = ref('');
// const schedulerEndDate = ref('');
const schedulerDailyEnabled = ref(true);
const schedulerWeeklyEnabled = ref(true);
const schedulerDemandEnabled = ref(true);
const schedulerCfacEnabled = ref(true);
const schedulerDemandGeography = ref<'regional' | 'zonal' | 'both'>('regional');
const schedulerOutputDir = ref('output/forecasts');
// Scheduler data source removed - now uses global settings

// ============ GLOBAL SETTINGS (Settings Tab) ============
// Database paths (global - used by all tabs)
const globalRegionalDemandDb = ref('data/iload.db');
const globalZonalDemandDb = ref('data/iload_zonal.db');
const globalSchedulerDb = ref('./forecast.db');
// CSV source directories (global - used for auto-import and manual import)
const globalDemandCsvPath = ref('Data Samples/Demand');
const globalCfacCsvPath = ref('Data Samples/Capacity Factor');
// Cache directories
const globalWeatherCacheDir = ref('./weather_cache');
// Output directory override for scheduler
const globalSchedulerOutputDir = ref('./output/forecasts');
// Auto-import settings
const autoImportBeforeRun = ref(true);
const autoFetchWeather = ref(true);
const schedulerDemandModel = ref<'hybrid' | 'regression' | 'xgboost'>('hybrid');
// Note: CFAC model options (useXgboost, asymmetricLoss, biasCorrection) are now managed in globalConfig (forecast_config.json)
const schedulerCalibDays = ref(7);
const schedulerCalibThreshold = ref(5);
const schedulerMaxIterations = ref(3);
// Calibration settings (0 = no calibration, 1-10 = iterations)
const calibrationIterations = ref(3);
// Data source toggle: 'database' or 'csv'
const schedulerDataSource = ref<'database' | 'csv'>('database');
const schedulerIsRunning = ref(false);
const schedulerProgress = ref(0);
const schedulerStatusHistory = ref<Array<{ time: string; message: string; type: 'info' | 'success' | 'error' | 'warn' | 'debug' }>>([]);
const schedulerCurrentStatus = ref('');

// Enhanced progress tracking
const schedulerProgressTotal = ref(0);
const schedulerProgressCurrent = ref(0);
const schedulerProgressEta = ref('');
const schedulerCurrentDate = ref('');

// Terminal filtering
const terminalFilterError = ref(true);
const terminalFilterWarn = ref(true);
const terminalFilterInfo = ref(true);
const terminalFilterDebug = ref(true);
const terminalSearchQuery = ref('');

// Scheduler schedule times (for automatic runs)
const schedulerTimes = ref<string[]>(['06:00']);
const schedulerAutoEnabled = ref(false);

// Scheduler output naming
const schedulerDemandPrefix = ref('FC_DEM_');
const schedulerDemandZonalPrefix = ref('FC_ZDEM_');
const schedulerCfacPrefix = ref('FC_CF_');
const schedulerOutputSuffix = ref('');

// Scheduler configuration (for service automation)
interface SchedulerConfig {
  enabled: boolean;
  runTimeMorning: string;
  runTimeEvening: string;
  secondRunEnabled: boolean;
  runDays: string[];
  forecastDemand: boolean;
  forecastCfac: boolean;
  horizonDaily: boolean;
  horizonWeekly: boolean;
  demandGeography: 'regional' | 'zonal' | 'both';  // Geography mode for demand forecasts
  weatherMaxAge: number;
  autoPushGateway: boolean;
  archiveRetention: number;
}

interface ForecastRun {
  id: number;
  run_date: string;
  forecast_type: string;
  horizon: string;
  status: string;
  records_generated: number;
  pushed_to_gateway: boolean;
  created_at: string;
}

// Gateway configuration (for SFTP push to vantage-gateway server)
interface GatewayConfig {
  host: string;
  port: number;
  username: string;
  password: string;
}

const gatewayConfig = ref<GatewayConfig>({
  host: '100.115.9.94',
  port: 22,
  username: 'vantage-upload',
  password: ''
});
const gatewayTestStatus = ref<'idle' | 'testing' | 'success' | 'error'>('idle');
const gatewayTestMessage = ref('');

// Gateway Storage Management
interface StorageCategory {
  files: number;
  size: number;
  sizeFormatted: string;
  oldest: string;
  newest: string;
}
interface StorageStats {
  categories: Record<string, StorageCategory>;
  totalFiles: number;
  totalSize: number;
  totalSizeFormatted: string;
  oldestFile: string;
  newestFile: string;
}
const gatewayStorageStats = ref<StorageStats | null>(null);
const gatewayStorageLoading = ref(false);
const gatewayStorageError = ref('');
const gatewayArchiveDays = ref(30);
const gatewayArchiveLoading = ref(false);
const gatewayClearDays = ref(90);
const gatewayClearLoading = ref(false);
const gatewayClearConfirm = ref(false);
const gatewayActionMessage = ref('');
const gatewayActionType = ref<'success' | 'error' | ''>('');

const schedulerConfig = ref<SchedulerConfig>({
  enabled: false,
  runTimeMorning: '06:00',
  runTimeEvening: '18:00',
  secondRunEnabled: false,
  runDays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
  forecastDemand: true,
  forecastCfac: true,
  horizonDaily: true,
  horizonWeekly: true,
  demandGeography: 'regional',
  weatherMaxAge: 6,
  autoPushGateway: false,
  archiveRetention: 90
});
const recentRuns = ref<ForecastRun[]>([]);
const manualRunDate = ref('');
const manualRunEndDate = ref(''); // Optional end date for backfill range
const manualRunType = ref<'both' | 'demand' | 'cfac'>('both');
const manualRunHorizon = ref<'both' | 'daily' | 'weekly'>('both');
const schedulerCalibrationMode = ref<'auto' | 'saved' | 'reuse'>('auto'); // auto = calibrate on-the-fly, saved = use saved model, reuse = use saved calibration
const schedulerSelectedCalibrator = ref<string>('');
const schedulerCalibrationPeriod = ref<'14days' | '1month' | '2months' | '3months'>('1month'); // How much data to use for calibration
const schedulerVerboseOutput = ref(true); // Show detailed progress in terminal (default: true)
const schedulerRefreshWeather = ref(false); // Force weather cache refresh
const schedulerOverwrite = ref(false); // Overwrite existing forecasts (backfill mode)
const schedulerSuffix = ref(''); // Custom suffix for backfill filenames

// ============ GLOBAL CONFIG (forecast_config.json) ============
// Global config from forecast_config.json
const globalConfig = ref<any>(null);
const configLoading = ref(false);
const configSaveStatus = ref<'idle' | 'saving' | 'saved' | 'error'>('idle');
const configDirty = ref(false);

// Saved calibrations (for 'reuse' mode - skip recalibration)
interface SavedCalibration {
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
}
const savedCalibrations = ref<SavedCalibration[]>([]);
const selectedCalibrationId = ref<number | null>(null);

// Terminal panel tabs (for scheduler tab - switch between terminal output and recent runs)
const terminalPanelTab = ref<'terminal' | 'runs'>('terminal');

// Calibration settings (for hybrid-calibrated mode)
const calibrationMode = ref<'auto' | 'saved'>('auto'); // auto = train on-the-fly, saved = use saved model
const selectedCalibrator = ref<string>('');
const availableCalibratorModels = ref<{ name: string; date: string; mape?: number }[]>([]);
const saveCalibrator = ref(false); // Save after auto-training

// Output naming settings
const demandPrefix = ref('FC_DEM_');
const demandZonalPrefix = ref('FC_ZDEM_');
const cfacPrefix = ref('FC_CF_');
const outputSuffix = ref('');
const useCustomName = ref(false);
const customDemandName = ref('');
const customCfacName = ref('');
// const showNamingOptions = ref(false); // Unused - commented out

// State
const isRunning = ref(false);
const isComplete = ref(false);
const hasError = ref(false);

// Data format detection
const dataFormatMessage = ref('');
const dataFormatType = ref<'info' | 'warning' | 'error' | ''>('');

// Progress tracking
const progress = ref(0);
const currentStatus = ref('');
const statusHistory = ref<Array<{ time: string; message: string; type: 'info' | 'success' | 'error' }>>([]);
// const showHistory = ref(false); // Unused - commented out

// Terminal panel state
const terminalExpanded = ref(false);
const terminalHeight = ref(300); // Default expanded height in pixels
const isResizing = ref(false);
const minTerminalHeight = 100;
const maxTerminalHeight = 600;

// Computed filtered scheduler history
const filteredSchedulerHistory = computed(() => {
  let filtered = schedulerStatusHistory.value;

  // Apply type filters
  filtered = filtered.filter(item => {
    if (item.type === 'error') return terminalFilterError.value;
    if (item.type === 'warn') return terminalFilterWarn.value;
    if (item.type === 'info' || item.type === 'success') return terminalFilterInfo.value;
    if (item.type === 'debug') return terminalFilterDebug.value;
    return true;
  });

  // Apply search filter
  if (terminalSearchQuery.value.trim()) {
    const query = terminalSearchQuery.value.toLowerCase();
    filtered = filtered.filter(item =>
      item.message.toLowerCase().includes(query) ||
      item.time.toLowerCase().includes(query)
    );
  }

  return filtered;
});

// Helper to highlight search matches
function highlightMatch(text: string): string {
  if (!terminalSearchQuery.value.trim()) return text;

  const query = terminalSearchQuery.value;
  // Escape regex special characters
  const escapedQuery = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`(${escapedQuery})`, 'gi');
  return text.replace(regex, '<mark>$1</mark>');
}

// Terminal resize handlers
function startTerminalResize(e: MouseEvent) {
  e.preventDefault();
  isResizing.value = true;
  document.addEventListener('mousemove', handleTerminalResize);
  document.addEventListener('mouseup', stopTerminalResize);
}

function handleTerminalResize(e: MouseEvent) {
  if (!isResizing.value) return;
  const windowHeight = window.innerHeight;
  const newHeight = windowHeight - e.clientY;
  terminalHeight.value = Math.max(minTerminalHeight, Math.min(maxTerminalHeight, newHeight));
  // Auto-expand if user is resizing
  if (!terminalExpanded.value && terminalHeight.value > 60) {
    terminalExpanded.value = true;
  }
}

function stopTerminalResize() {
  isResizing.value = false;
  document.removeEventListener('mousemove', handleTerminalResize);
  document.removeEventListener('mouseup', stopTerminalResize);
}

// Save settings to persistent storage
function saveSettings() {
  window.electronAPI.saveSettings({
    dataSource: dataSource.value,
    databasePath: databasePath.value,
    demandDataDir: demandDataDir.value,
    cfacDataDir: cfacDataDir.value,
    weatherDataDir: weatherDataDir.value,
    demandOutputDir: demandOutputDir.value,
    cfacOutputDir: cfacOutputDir.value,
    enableDemand: enableDemand.value,
    enableCfac: enableCfac.value,
    // enableZonal removed - now derived from globalConfig.demand.geography
    scalingPercent: scalingPercent.value,
    cfacModel: cfacModel.value,
    demandModel: demandModel.value,
    pushToGateway: pushToGateway.value,
    // Calibration settings
    calibrationMode: calibrationMode.value,
    selectedCalibrator: selectedCalibrator.value,
    saveCalibrator: saveCalibrator.value,
    // Output naming
    demandPrefix: demandPrefix.value,
    demandZonalPrefix: demandZonalPrefix.value,
    cfacPrefix: cfacPrefix.value,
    outputSuffix: outputSuffix.value,
    useCustomName: useCustomName.value,
    customDemandName: customDemandName.value,
    customCfacName: customCfacName.value,
    // Tab state
    activeTab: activeTab.value,
    // Scheduler settings (schedulerMode removed - legacy)
    // schedulerMode: schedulerMode.value,
    schedulerDailyEnabled: schedulerDailyEnabled.value,
    schedulerWeeklyEnabled: schedulerWeeklyEnabled.value,
    schedulerDemandEnabled: schedulerDemandEnabled.value,
    schedulerCfacEnabled: schedulerCfacEnabled.value,
    schedulerDemandGeography: schedulerDemandGeography.value,
    schedulerOutputDir: schedulerOutputDir.value,
    // Global settings
    globalRegionalDemandDb: globalRegionalDemandDb.value,
    globalZonalDemandDb: globalZonalDemandDb.value,
    globalSchedulerDb: globalSchedulerDb.value,
    globalDemandCsvPath: globalDemandCsvPath.value,
    globalCfacCsvPath: globalCfacCsvPath.value,
    autoImportBeforeRun: autoImportBeforeRun.value,
    autoFetchWeather: autoFetchWeather.value,
    schedulerDemandModel: schedulerDemandModel.value,
    schedulerCalibDays: schedulerCalibDays.value,
    schedulerCalibThreshold: schedulerCalibThreshold.value,
    schedulerMaxIterations: schedulerMaxIterations.value,
    calibrationIterations: calibrationIterations.value,
    schedulerDataSource: schedulerDataSource.value,
    // New scheduler settings
    schedulerTimes: [...schedulerTimes.value],
    schedulerAutoEnabled: schedulerAutoEnabled.value,
    schedulerDemandPrefix: schedulerDemandPrefix.value,
    schedulerDemandZonalPrefix: schedulerDemandZonalPrefix.value,
    schedulerCfacPrefix: schedulerCfacPrefix.value,
    schedulerOutputSuffix: schedulerOutputSuffix.value,
    schedulerSelectedCalibrator: schedulerSelectedCalibrator.value,
    // Auto calibration settings
    schedulerCalibrationMode: schedulerCalibrationMode.value,
    schedulerCalibrationPeriod: schedulerCalibrationPeriod.value,
    selectedCalibrationId: selectedCalibrationId.value,
    // New global settings
    globalWeatherCacheDir: globalWeatherCacheDir.value,
    globalSchedulerOutputDir: globalSchedulerOutputDir.value,
    // Scheduler backfill options
    schedulerRefreshWeather: schedulerRefreshWeather.value,
    schedulerOverwrite: schedulerOverwrite.value,
    schedulerSuffix: schedulerSuffix.value,
    // Manual forecast advanced options
    scalingWind: scalingWind.value,
    scalingSolar: scalingSolar.value,
    usePerTypeScaling: usePerTypeScaling.value,
    demandGrowthRate: demandGrowthRate.value,
    trainingEndDate: trainingEndDate.value,
  });
}

// Watch for settings changes and persist them
watch([dataSource, databasePath, demandDataDir, cfacDataDir, weatherDataDir, demandOutputDir, cfacOutputDir, enableDemand, enableCfac, enableZonal, scalingPercent, scalingWind, scalingSolar, usePerTypeScaling, cfacModel, demandModel, pushToGateway, demandGrowthRate, trainingEndDate, calibrationMode, selectedCalibrator, saveCalibrator, demandPrefix, demandZonalPrefix, cfacPrefix, outputSuffix, useCustomName, customDemandName, customCfacName, activeTab, schedulerDailyEnabled, schedulerWeeklyEnabled, schedulerDemandEnabled, schedulerCfacEnabled, schedulerDemandGeography, schedulerOutputDir, schedulerDemandModel, schedulerCalibDays, schedulerCalibThreshold, schedulerMaxIterations, schedulerCalibrationMode, schedulerCalibrationPeriod, schedulerRefreshWeather, schedulerOverwrite, schedulerSuffix, globalRegionalDemandDb, globalZonalDemandDb, globalSchedulerDb, globalDemandCsvPath, globalCfacCsvPath, globalWeatherCacheDir, globalSchedulerOutputDir, autoImportBeforeRun, autoFetchWeather], () => {
  saveSettings();
});

// Set default dates and load saved settings
onMounted(async () => {
  const today = new Date();
  const thirtyDaysAgo = new Date(today);
  thirtyDaysAgo.setDate(today.getDate() - 30);
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);
  const nextWeek = new Date(today);
  nextWeek.setDate(today.getDate() + 7);

  trainingStart.value = formatDate(thirtyDaysAgo);
  trainingEnd.value = formatDate(today);
  forecastStart.value = formatDate(tomorrow);
  forecastEnd.value = formatDate(nextWeek);
  manualRunDate.value = formatDate(today);

  // Load saved settings
  try {
    const settings = await window.electronAPI.loadSettings();
    if (settings.dataSource) dataSource.value = settings.dataSource;
    if (settings.databasePath) databasePath.value = settings.databasePath;
    if (settings.demandDataDir) demandDataDir.value = settings.demandDataDir;
    if (settings.cfacDataDir) cfacDataDir.value = settings.cfacDataDir;
    if (settings.weatherDataDir) weatherDataDir.value = settings.weatherDataDir;
    if (settings.demandOutputDir) demandOutputDir.value = settings.demandOutputDir;
    if (settings.cfacOutputDir) cfacOutputDir.value = settings.cfacOutputDir;
    if (typeof settings.enableDemand === 'boolean') enableDemand.value = settings.enableDemand;
    if (typeof settings.enableCfac === 'boolean') enableCfac.value = settings.enableCfac;
    // enableZonal removed - now derived from globalConfig.demand.geography
    if (typeof settings.pushToGateway === 'boolean') pushToGateway.value = settings.pushToGateway;
    if (typeof settings.scalingPercent === 'number') scalingPercent.value = settings.scalingPercent;
    if (settings.cfacModel === 'hybrid' || settings.cfacModel === 'hybrid-lstm' || settings.cfacModel === 'legacy') cfacModel.value = settings.cfacModel;
    // Migration: convert old 'lstm' setting to 'hybrid'
    if (settings.cfacModel === 'lstm') cfacModel.value = 'hybrid';
    if (settings.demandModel === 'hybrid' || settings.demandModel === 'hybrid-calibrated') demandModel.value = settings.demandModel;
    // Calibration settings
    if (settings.calibrationMode) calibrationMode.value = settings.calibrationMode;
    if (settings.selectedCalibrator) selectedCalibrator.value = settings.selectedCalibrator;
    if (settings.saveCalibrator !== undefined) saveCalibrator.value = settings.saveCalibrator;
    // Output naming
    if (settings.demandPrefix) demandPrefix.value = settings.demandPrefix;
    if (settings.demandZonalPrefix) demandZonalPrefix.value = settings.demandZonalPrefix;
    if (settings.cfacPrefix) cfacPrefix.value = settings.cfacPrefix;
    if (settings.outputSuffix !== undefined) outputSuffix.value = settings.outputSuffix;
    if (typeof settings.useCustomName === 'boolean') useCustomName.value = settings.useCustomName;
    if (settings.customDemandName) customDemandName.value = settings.customDemandName;
    if (settings.customCfacName) customCfacName.value = settings.customCfacName;
    // Tab state
    if (settings.activeTab === 'manual' || settings.activeTab === 'scheduler' || settings.activeTab === 'gateway' || settings.activeTab === 'settings') activeTab.value = settings.activeTab;
    // Scheduler settings (schedulerMode removed - legacy)
    // if (settings.schedulerMode === 'run' || settings.schedulerMode === 'backfill') schedulerMode.value = settings.schedulerMode;
    if (typeof settings.schedulerDailyEnabled === 'boolean') schedulerDailyEnabled.value = settings.schedulerDailyEnabled;
    if (typeof settings.schedulerWeeklyEnabled === 'boolean') schedulerWeeklyEnabled.value = settings.schedulerWeeklyEnabled;
    if (typeof settings.schedulerDemandEnabled === 'boolean') schedulerDemandEnabled.value = settings.schedulerDemandEnabled;
    if (typeof settings.schedulerCfacEnabled === 'boolean') schedulerCfacEnabled.value = settings.schedulerCfacEnabled;
    // Load demandGeography with backward compatibility from schedulerZonalEnabled
    if (settings.schedulerDemandGeography === 'regional' || settings.schedulerDemandGeography === 'zonal' || settings.schedulerDemandGeography === 'both') {
      schedulerDemandGeography.value = settings.schedulerDemandGeography;
    } else if (typeof settings.schedulerZonalEnabled === 'boolean') {
      // Backward compatibility: convert old boolean to new value
      schedulerDemandGeography.value = settings.schedulerZonalEnabled ? 'zonal' : 'regional';
    }
    if (settings.schedulerOutputDir) schedulerOutputDir.value = settings.schedulerOutputDir;
    // Global settings
    if (settings.globalRegionalDemandDb) globalRegionalDemandDb.value = settings.globalRegionalDemandDb;
    if (settings.globalZonalDemandDb) globalZonalDemandDb.value = settings.globalZonalDemandDb;
    if (settings.globalSchedulerDb) globalSchedulerDb.value = settings.globalSchedulerDb;
    if (settings.globalDemandCsvPath) globalDemandCsvPath.value = settings.globalDemandCsvPath;
    if (settings.globalCfacCsvPath) globalCfacCsvPath.value = settings.globalCfacCsvPath;
    if (typeof settings.autoImportBeforeRun === 'boolean') autoImportBeforeRun.value = settings.autoImportBeforeRun;
    if (typeof settings.autoFetchWeather === 'boolean') autoFetchWeather.value = settings.autoFetchWeather;
    // Backwards compatibility: migrate old scheduler paths to global
    if (!settings.globalDemandCsvPath && settings.schedulerDemandPath) {
      globalDemandCsvPath.value = settings.schedulerDemandPath;
    }
    if (!settings.globalCfacCsvPath && settings.schedulerCfacPath) {
      globalCfacCsvPath.value = settings.schedulerCfacPath;
    }
    if (!settings.globalSchedulerDb && settings.schedulerDbPath) {
      globalSchedulerDb.value = settings.schedulerDbPath;
    }
    if (settings.schedulerDemandModel) schedulerDemandModel.value = settings.schedulerDemandModel;
    // Note: CFAC model options are now managed in globalConfig (forecast_config.json) instead of local settings
    if (typeof settings.schedulerCalibDays === 'number') schedulerCalibDays.value = settings.schedulerCalibDays;
    if (typeof settings.schedulerCalibThreshold === 'number') schedulerCalibThreshold.value = settings.schedulerCalibThreshold;
    if (typeof settings.schedulerMaxIterations === 'number') schedulerMaxIterations.value = settings.schedulerMaxIterations;
    if (typeof settings.calibrationIterations === 'number') calibrationIterations.value = settings.calibrationIterations;
    if (settings.schedulerDataSource === 'database' || settings.schedulerDataSource === 'csv') schedulerDataSource.value = settings.schedulerDataSource;
    // New scheduler settings
    if (Array.isArray(settings.schedulerTimes) && settings.schedulerTimes.length > 0) schedulerTimes.value = settings.schedulerTimes;
    if (typeof settings.schedulerAutoEnabled === 'boolean') schedulerAutoEnabled.value = settings.schedulerAutoEnabled;
    if (settings.schedulerDemandPrefix) schedulerDemandPrefix.value = settings.schedulerDemandPrefix;
    if (settings.schedulerDemandZonalPrefix) schedulerDemandZonalPrefix.value = settings.schedulerDemandZonalPrefix;
    if (settings.schedulerCfacPrefix) schedulerCfacPrefix.value = settings.schedulerCfacPrefix;
    if (settings.schedulerOutputSuffix) schedulerOutputSuffix.value = settings.schedulerOutputSuffix;
    if (settings.schedulerSelectedCalibrator) schedulerSelectedCalibrator.value = settings.schedulerSelectedCalibrator;
    // Auto calibration settings (also support legacy schedulerTrainingMode for backwards compatibility)
    if (settings.schedulerCalibrationMode === 'auto' || settings.schedulerCalibrationMode === 'saved' || settings.schedulerCalibrationMode === 'reuse') {
      schedulerCalibrationMode.value = settings.schedulerCalibrationMode;
    } else if (settings.schedulerTrainingMode === 'auto' || settings.schedulerTrainingMode === 'saved') {
      schedulerCalibrationMode.value = settings.schedulerTrainingMode;
    }
    if (settings.schedulerCalibrationPeriod) schedulerCalibrationPeriod.value = settings.schedulerCalibrationPeriod;
    if (typeof settings.selectedCalibrationId === 'number') selectedCalibrationId.value = settings.selectedCalibrationId;

    // New global settings
    if (settings.globalWeatherCacheDir) globalWeatherCacheDir.value = settings.globalWeatherCacheDir;
    if (settings.globalSchedulerOutputDir) globalSchedulerOutputDir.value = settings.globalSchedulerOutputDir;
    // Scheduler backfill options
    if (typeof settings.schedulerRefreshWeather === 'boolean') schedulerRefreshWeather.value = settings.schedulerRefreshWeather;
    if (typeof settings.schedulerOverwrite === 'boolean') schedulerOverwrite.value = settings.schedulerOverwrite;
    if (settings.schedulerSuffix !== undefined) schedulerSuffix.value = settings.schedulerSuffix;
    // Manual forecast advanced options
    if (typeof settings.scalingWind === 'number') scalingWind.value = settings.scalingWind;
    if (typeof settings.scalingSolar === 'number') scalingSolar.value = settings.scalingSolar;
    if (typeof settings.usePerTypeScaling === 'boolean') usePerTypeScaling.value = settings.usePerTypeScaling;
    if (typeof settings.demandGrowthRate === 'number') demandGrowthRate.value = settings.demandGrowthRate;
    if (settings.trainingEndDate) trainingEndDate.value = settings.trainingEndDate;

    // Load database info if in database mode
    if (dataSource.value === 'database' && databasePath.value) {
      loadDatabaseInfo();
    }
  } catch (e) {
    console.error('Failed to load settings:', e);
  }

  // Load available calibrator models
  loadCalibratorModels();

  // Load scheduler configuration, gateway config, recent runs, and saved calibrations
  loadSchedulerConfig();
  loadGatewayConfig();
  loadRecentRuns();
  loadSavedCalibrations();

  // Load global config from forecast_config.json
  await loadGlobalConfig();

  // Set up real-time output listener - routes to appropriate terminal
  window.electronAPI.onCommandOutput((data) => {
    if (schedulerIsRunning.value) {
      parseSchedulerOutput(data.data, data.type === 'stderr');
    } else {
      parseOutput(data.data, data.type === 'stderr');
    }
  });
});

onUnmounted(() => {
  window.electronAPI.removeCommandOutputListener();
});

function formatDate(date: Date): string {
  return date.toISOString().split('T')[0];
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function addStatus(message: string, type: 'info' | 'success' | 'error' = 'info') {
  currentStatus.value = message;
  statusHistory.value.push({
    time: formatTime(new Date()),
    message,
    type
  });
}

function parseOutput(text: string, isError: boolean) {
  // Parse CLI output and extract meaningful status updates
  const lines = text.split('\n').filter(line => line.trim());

  for (const line of lines) {
    // Skip empty lines and dividers
    if (!line.trim() || line.match(/^[=\-]+$/)) continue;

    // Skip Electron/Chrome console noise
    if (line.includes('ERROR:CONSOLE') || line.includes('DevTools')) continue;

    // Detect key status messages
    if (line.includes('Loading training data')) {
      addStatus('Loading training data...');
    } else if (line.includes('Fetching weather')) {
      addStatus('Fetching weather data...');
    } else if (line.includes('Training') && line.includes('model')) {
      addStatus('Training models...');
    } else if (line.includes('Generating forecast')) {
      addStatus('Generating forecast...');
    } else if (line.includes('stations processed') || line.includes('Processing station')) {
      const match = line.match(/(\d+)/);
      if (match) addStatus(`Processing stations... (${match[1]})`);
    } else if (line.includes('Calibrating')) {
      addStatus('Calibrating models...');
    } else if (line.includes('Writing output') || line.includes('Saved to')) {
      addStatus('Writing output file...');
    } else if (line.includes('MAPE') || line.includes('accuracy')) {
      addStatus(line.trim(), 'success');
    } else if (isError && !line.includes('warning') && (line.toLowerCase().includes('error') || line.toLowerCase().includes('failed'))) {
      // Only treat as error if it's from stderr AND contains error/failed keywords
      addStatus(line.trim(), 'error');
      hasError.value = true;
    }
  }
}

// Parse scheduler command output and route to scheduler terminal
function parseSchedulerOutput(text: string, isError: boolean) {
  const lines = text.split('\n').filter(line => line.trim());

  for (const line of lines) {
    // Skip empty lines and dividers
    if (!line.trim() || line.match(/^[=\-─═]+$/)) continue;

    // Skip Electron/Chrome console noise
    if (line.includes('ERROR:CONSOLE') || line.includes('DevTools')) continue;

    // Clean line for display (remove emoji prefixes for cleaner look)
    const cleanLine = line.trim();

    // === PROGRESS TRACKING ===
    // Parse structured progress data: "[PROGRESS] 5/7 dates | Current: 2026-01-05 | ETA: 2m 15s"
    const progressMatch = line.match(/\[PROGRESS\]\s+(\d+)\/(\d+)\s+dates\s+\|\s+Current:\s+(\S+)\s+\|\s+ETA:\s+(.+)/);
    if (progressMatch) {
      const [, current, total, date, eta] = progressMatch;
      schedulerProgressCurrent.value = parseInt(current);
      schedulerProgressTotal.value = parseInt(total);
      schedulerCurrentDate.value = date;
      schedulerProgressEta.value = eta;
      schedulerProgress.value = (parseInt(current) / parseInt(total)) * 100;
      continue; // Don't add to history
    }

    // === DETAILED CALIBRATION INFO (show these!) ===
    // Calibration iteration progress
    if (line.includes('Iteration') && (line.includes('CFAC') || line.includes('Demand'))) {
      addSchedulerStatus(cleanLine);
      schedulerProgress.value = 40;
    }
    // Wind/Solar deviation and scale info
    else if (line.includes('deviation') || line.includes('Wind scale') || line.includes('Solar scale')) {
      addSchedulerStatus(cleanLine);
    }
    // Calibration period info
    else if (line.includes('calibration:') || line.includes('data ends:')) {
      addSchedulerStatus(cleanLine);
      schedulerProgress.value = 15;
    }
    // Calibration converged messages
    else if (line.includes('converged')) {
      addSchedulerStatus(cleanLine, 'success');
      schedulerProgress.value = 50;
    }
    // Station training progress
    else if (line.includes('Trained') && line.includes('MAPE')) {
      addSchedulerStatus(cleanLine);
      schedulerProgress.value = 60;
    }
    // Training complete summary
    else if (line.includes('Training complete:') || line.includes('stations trained')) {
      addSchedulerStatus(cleanLine, 'success');
      schedulerProgress.value = 65;
    }
    // Model type info (Wind/Solar model being used)
    else if (line.includes('Wind:') && (line.includes('Hybrid') || line.includes('MREC'))) {
      addSchedulerStatus(cleanLine);
    }
    else if (line.includes('Solar:') && (line.includes('Hybrid') || line.includes('Physics'))) {
      addSchedulerStatus(cleanLine);
    }
    // Forecast file info
    else if (line.includes('forecast:') && line.includes('records')) {
      addSchedulerStatus(cleanLine, 'success');
      schedulerProgress.value = 80;
    }
    // === STANDARD STATUS MESSAGES ===
    else if (line.includes('Running scheduler') || line.includes('Starting scheduler')) {
      addSchedulerStatus('Starting scheduler run...');
      schedulerProgress.value = 10;
    } else if (line.includes('Loading training data') || line.includes('Loading demand data') || line.includes('Parsing capacity')) {
      addSchedulerStatus('Loading training data...');
      schedulerProgress.value = 20;
    } else if (line.includes('Fetching weather')) {
      addSchedulerStatus('Fetching weather data...');
      schedulerProgress.value = 30;
    } else if (line.includes('Training') && line.includes('model')) {
      addSchedulerStatus('Training models...');
      schedulerProgress.value = 50;
    } else if (line.includes('Generating forecast') || line.includes('generating')) {
      addSchedulerStatus('Generating forecast...');
      schedulerProgress.value = 60;
    } else if (line.includes('stations processed') || line.includes('Processing station')) {
      const match = line.match(/(\d+)/);
      if (match) addSchedulerStatus(`Processing stations... (${match[1]})`);
      schedulerProgress.value = 70;
    } else if (line.includes('Calibrating') || line.includes('AUTO-CALIBRATE')) {
      addSchedulerStatus('Calibrating models...');
      schedulerProgress.value = 35;
    } else if (line.includes('Writing output') || line.includes('Saved to') || line.includes('Output saved')) {
      addSchedulerStatus('Writing output file...');
      schedulerProgress.value = 85;
    } else if (line.includes('Archiving') || line.includes('archived') || line.includes('Archived:')) {
      addSchedulerStatus(cleanLine);
      schedulerProgress.value = 90;
    } else if (line.includes('Pushing') || line.includes('gateway') || line.includes('Gateway')) {
      addSchedulerStatus(cleanLine);
      schedulerProgress.value = 95;
    } else if (line.includes('MAPE') || line.includes('accuracy') || line.includes('R²')) {
      addSchedulerStatus(cleanLine, 'success');
    } else if (line.includes('completed') || line.includes('COMPLETE') || line.includes('success')) {
      addSchedulerStatus(cleanLine, 'success');
      schedulerProgress.value = 100;
    } else if (line.includes('Daily forecast:') || line.includes('Weekly forecast:')) {
      addSchedulerStatus(cleanLine);
      schedulerProgress.value = 55;
    } else if (isError && !line.includes('warning') && (line.toLowerCase().includes('error') || line.toLowerCase().includes('failed'))) {
      addSchedulerStatus(cleanLine, 'error');
    }
    // Show warnings
    else if (line.includes('⚠️') || line.includes('warning') || line.includes('Warning')) {
      addSchedulerStatus(cleanLine, 'warn');
    }
  }
}

// Validation
const canRunForecast = computed(() => {
  if (!enableDemand.value && !enableCfac.value) return false;
  if (!forecastStart.value || !forecastEnd.value) return false;
  if (dataSource.value === 'database' && !databasePath.value) return false;
  if (dataSource.value === 'csv') {
    if (enableDemand.value && !demandDataDir.value) return false;
    if (enableCfac.value && !cfacDataDir.value) return false;
  }
  return true;
});

// Convert calibration period to days for display
const computedTrainingDays = computed(() => {
  switch (schedulerCalibrationPeriod.value) {
    case '14days': return 14;
    case '1month': return 30;
    case '2months': return 60;
    case '3months': return 90;
    default: return 30;
  }
});

// Clear format message
function clearFormatMessage() {
  dataFormatMessage.value = '';
  dataFormatType.value = '';
}

// Handle format detection result
function handleFormatResult(result: { format: string; message: string; columns?: string[] }, expectedZonal: boolean) {
  if (result.format === 'error') {
    dataFormatMessage.value = result.message;
    dataFormatType.value = 'error';
    return;
  }

  const isZonalData = result.format === 'zonal';
  const isRegionalData = result.format === 'regional';

  if (result.format === 'unknown' || result.format === 'mixed') {
    dataFormatMessage.value = result.message;
    dataFormatType.value = 'warning';
  } else if (expectedZonal && isRegionalData) {
    dataFormatMessage.value = 'Zonal Mode is ON, but data contains regional format (CLUZ, CVIS, CMIN). Switching to Non-Zonal mode.';
    dataFormatType.value = 'warning';
    enableZonal.value = false;
  } else if (!expectedZonal && isZonalData) {
    dataFormatMessage.value = 'Detected 14-zone format data. Switching to Zonal Mode.';
    dataFormatType.value = 'info';
    enableZonal.value = true;
  } else {
    dataFormatMessage.value = result.message;
    dataFormatType.value = 'info';
  }

  // Auto-clear message after 5 seconds
  setTimeout(clearFormatMessage, 5000);
}

// Browse functions
async function browseDemandDir() {
  const path = await window.electronAPI.selectDirectory();
  if (path) {
    demandDataDir.value = path;
    // Check data format
    const result = await window.electronAPI.checkDataFormat(path, 'demand');
    handleFormatResult(result, enableZonal.value);
  }
}

async function browseCfacDir() {
  const path = await window.electronAPI.selectDirectory();
  if (path) cfacDataDir.value = path;
}

async function browseDatabase() {
  const path = await window.electronAPI.selectFile([
    { name: 'SQLite Database', extensions: ['db', 'sqlite', 'sqlite3'] },
  ]);
  if (path) {
    databasePath.value = path;
    // Check data format (database detection will be handled separately)
    const result = await window.electronAPI.checkDataFormat(path, 'database');
    if (result.format !== 'unknown') {
      handleFormatResult(result, enableZonal.value);
    }
  }
}

// ============ Settings Tab Browse Functions ============
async function browseRegionalDb() {
  const path = await window.electronAPI.selectFile([
    { name: 'SQLite Database', extensions: ['db', 'sqlite', 'sqlite3'] },
  ]);
  if (path) globalRegionalDemandDb.value = path;
}

async function browseZonalDb() {
  const path = await window.electronAPI.selectFile([
    { name: 'SQLite Database', extensions: ['db', 'sqlite', 'sqlite3'] },
  ]);
  if (path) globalZonalDemandDb.value = path;
}

async function browseSchedulerDb() {
  const path = await window.electronAPI.selectFile([
    { name: 'SQLite Database', extensions: ['db', 'sqlite', 'sqlite3'] },
  ]);
  if (path) globalSchedulerDb.value = path;
}

async function browseDemandCsvDir() {
  const path = await window.electronAPI.selectDirectory();
  if (path) globalDemandCsvPath.value = path;
}

async function browseCfacCsvDir() {
  const path = await window.electronAPI.selectDirectory();
  if (path) globalCfacCsvPath.value = path;
}

async function browseWeatherCacheDir() {
  const path = await window.electronAPI.selectDirectory();
  if (path) globalWeatherCacheDir.value = path;
}

async function browseSchedulerOutputDir() {
  const path = await window.electronAPI.selectDirectory();
  if (path) globalSchedulerOutputDir.value = path;
}

// ============ Settings Tab Import Functions ============
async function importDemandToDb() {
  if (!globalDemandCsvPath.value) {
    addSchedulerStatus('Error: No demand CSV directory specified', 'error');
    return;
  }
  terminalExpanded.value = true;
  addSchedulerStatus(`Importing demand data from ${globalDemandCsvPath.value}...`);
  // Import to both regional and zonal databases
  try {
    const resultRegional = await window.electronAPI.importToDatabase({
      dbPath: globalRegionalDemandDb.value,
      dataType: 'demand',
      sourcePath: globalDemandCsvPath.value
    });
    addSchedulerStatus(`Regional DB: ${resultRegional.message}`, resultRegional.success ? 'success' : 'error');

    const resultZonal = await window.electronAPI.importToDatabase({
      dbPath: globalZonalDemandDb.value,
      dataType: 'demand',
      sourcePath: globalDemandCsvPath.value
    });
    addSchedulerStatus(`Zonal DB: ${resultZonal.message}`, resultZonal.success ? 'success' : 'error');
  } catch (error: any) {
    addSchedulerStatus(`Error: ${error.message}`, 'error');
  }
}

async function importCfacToDb() {
  if (!globalCfacCsvPath.value) {
    addSchedulerStatus('Error: No CFAC CSV directory specified', 'error');
    return;
  }
  terminalExpanded.value = true;
  addSchedulerStatus(`Importing CFAC data from ${globalCfacCsvPath.value}...`);
  try {
    const result = await window.electronAPI.importToDatabase({
      dbPath: globalSchedulerDb.value,
      dataType: 'cfac',
      sourcePath: globalCfacCsvPath.value
    });
    addSchedulerStatus(result.message, result.success ? 'success' : 'error');
  } catch (error: any) {
    addSchedulerStatus(`Error: ${error.message}`, 'error');
  }
}

// ============ Settings Tab Status Functions ============
async function checkRegionalDbStatus() {
  terminalExpanded.value = true;
  try {
    const info = await window.electronAPI.getDatabaseInfo(globalRegionalDemandDb.value);
    addSchedulerStatus(`Regional Demand Database: ${info.message}`, info.success ? 'success' : 'error');
  } catch (error: any) {
    addSchedulerStatus(`Error checking database: ${error.message}`, 'error');
  }
}

async function checkZonalDbStatus() {
  terminalExpanded.value = true;
  try {
    const info = await window.electronAPI.getDatabaseInfo(globalZonalDemandDb.value);
    addSchedulerStatus(`Zonal Demand Database: ${info.message}`, info.success ? 'success' : 'error');
  } catch (error: any) {
    addSchedulerStatus(`Error checking database: ${error.message}`, 'error');
  }
}

async function checkSchedulerDbStatus() {
  terminalExpanded.value = true;
  try {
    const info = await window.electronAPI.getDatabaseInfo(globalSchedulerDb.value);
    addSchedulerStatus(`Scheduler Database: ${info.message}`, info.success ? 'success' : 'error');
  } catch (error: any) {
    addSchedulerStatus(`Error checking database: ${error.message}`, 'error');
  }
}

// ============ Global Config Functions ============
// Load global config from forecast_config.json
async function loadGlobalConfig() {
  configLoading.value = true;
  try {
    globalConfig.value = await window.electronAPI.loadGlobalConfig();
    // Sync scheduler tab geography dropdown from global config (single source of truth)
    if (globalConfig.value?.demand?.geography) {
      schedulerConfig.value.demandGeography = globalConfig.value.demand.geography as 'regional' | 'zonal' | 'both';
    }
    addSchedulerStatus('Global config loaded successfully', 'success');
  } catch (e: any) {
    console.error('Failed to load global config:', e);
    addSchedulerStatus(`Error loading config: ${e.message}`, 'error');
  } finally {
    configLoading.value = false;
  }
}

// Mark global config as dirty (unsaved changes)
function markConfigDirty() {
  configDirty.value = true;
}

// Sync scheduler demand geography to global config and save
// This ensures CLI reads the correct value from forecast_config.json
async function syncDemandGeographyToConfig() {
  if (!globalConfig.value) return;
  // Sync scheduler tab selection to global config
  globalConfig.value.demand.geography = schedulerConfig.value.demandGeography;
  // Save immediately so CLI can read it
  await saveGlobalConfig();
}

// Save global config to forecast_config.json
async function saveGlobalConfig() {
  if (!globalConfig.value) return;
  configSaveStatus.value = 'saving';
  try {
    // Deep clone to plain object - Vue reactive proxies can't be sent via IPC
    const plainConfig = JSON.parse(JSON.stringify(globalConfig.value));
    await window.electronAPI.saveGlobalConfig(plainConfig);
    configSaveStatus.value = 'saved';
    configDirty.value = false;
    addSchedulerStatus('Global config saved successfully', 'success');
    setTimeout(() => configSaveStatus.value = 'idle', 2000);
  } catch (e: any) {
    console.error('Failed to save global config:', e);
    configSaveStatus.value = 'error';
    addSchedulerStatus(`Error saving config: ${e.message}`, 'error');
  }
}

// Reset global config to defaults
async function resetGlobalConfig() {
  if (!confirm('Reset all global settings to defaults? This will overwrite your current configuration.')) return;
  try {
    globalConfig.value = await window.electronAPI.resetGlobalConfig();
    configSaveStatus.value = 'saved';
    configDirty.value = false;
    addSchedulerStatus('Global config reset to defaults', 'success');
    setTimeout(() => configSaveStatus.value = 'idle', 2000);
  } catch (e: any) {
    console.error('Failed to reset global config:', e);
    addSchedulerStatus(`Error resetting config: ${e.message}`, 'error');
  }
}

async function browseDemandOutputDir() {
  const path = await window.electronAPI.selectDirectory();
  if (path) demandOutputDir.value = path;
}

async function browseCfacOutputDir() {
  const path = await window.electronAPI.selectDirectory();
  if (path) cfacOutputDir.value = path;
}

// async function browseWeatherDir() {
//   const path = await window.electronAPI.selectDirectory();
//   if (path) {
//     weatherDataDir.value = path;
//     // Validate weather directory structure
//     const result = await window.electronAPI.checkWeatherDirectory(path);
//     weatherDirStatus.value = result;
//     if (!result.valid) {
//       dataFormatMessage.value = result.message;
//       dataFormatType.value = 'warning';
//       setTimeout(clearFormatMessage, 5000);
//     }
//   }
// } // Unused - commented out

// Database info functions
async function loadDatabaseInfo() {
  if (!databasePath.value) return;

  isLoadingDbInfo.value = true;
  try {
    const result = await window.electronAPI.getDatabaseInfo(databasePath.value);
    if (result.success) {
      databaseInfo.value = {
        demand: result.demand,
        cfac: result.cfac,
        weather: result.weather
      };

      // Auto-detect zonal mode based on number of regions
      const regions = result.demand?.regions || [];
      if (regions.length > 0) {
        const isZonalDb = regions.length > 3; // More than 3 regions = zonal (14 zones)

        if (isZonalDb !== enableZonal.value) {
          enableZonal.value = isZonalDb;
          dataFormatMessage.value = isZonalDb
            ? `Detected 14-zone database. Zonal Mode enabled automatically.`
            : `Detected 3-region database. Zonal Mode disabled.`;
          dataFormatType.value = 'info';
          setTimeout(clearFormatMessage, 5000);
        }
      }
    } else {
      databaseInfo.value = null;
      dataFormatMessage.value = result.message;
      dataFormatType.value = 'error';
      setTimeout(clearFormatMessage, 5000);
    }
  } catch (e: any) {
    databaseInfo.value = null;
    console.error('Failed to load database info:', e);
  } finally {
    isLoadingDbInfo.value = false;
  }
}

// async function importData(dataType: 'demand' | 'cfac' | 'weather') {
//   let sourcePath = '';
//   if (dataType === 'demand') sourcePath = demandDataDir.value;
//   else if (dataType === 'cfac') sourcePath = cfacDataDir.value;
//   else if (dataType === 'weather') sourcePath = weatherDataDir.value;

//   if (!sourcePath || !databasePath.value) {
//     dataFormatMessage.value = `Please select a ${dataType} data directory first`;
//     dataFormatType.value = 'warning';
//     setTimeout(clearFormatMessage, 5000);
//     return;
//   }

//   isImporting.value = true;
//   addStatus(`Importing ${dataType} data...`);

//   try {
//     const result = await window.electronAPI.importToDatabase({
//       dbPath: databasePath.value,
//       dataType,
//       sourcePath
//     });

//     if (result.success) {
//       addStatus(`${dataType} import completed`, 'success');
//       // Refresh database info
//       await loadDatabaseInfo();
//     } else {
//       addStatus(`${dataType} import failed: ${result.message}`, 'error');
//     }
//   } catch (e: any) {
//     addStatus(`${dataType} import error: ${e.message}`, 'error');
//   } finally {
//     isImporting.value = false;
//   }
// } // Unused - commented out

// Watch for database path changes
watch(databasePath, async (newPath) => {
  if (newPath && dataSource.value === 'database') {
    await loadDatabaseInfo();
  }
});

// Run forecast
async function runForecast() {
  if (!canRunForecast.value) return;

  // Reset state
  isRunning.value = true;
  isComplete.value = false;
  hasError.value = false;
  progress.value = 0;
  currentStatus.value = 'Starting...';
  statusHistory.value = [];

  const totalSteps = (enableDemand.value ? 1 : 0) + (enableCfac.value ? 1 : 0);
  let completedSteps = 0;

  try {
    // Run Demand forecast
    if (enableDemand.value) {
      addStatus('Starting Demand Forecast...');
      progress.value = 5;

      const demandFilename = generateOutputFilename('demand');
      const demandArgs = [
        'forecast',
        '-d', dataSource.value === 'database' ? databasePath.value : demandDataDir.value,
        '-s', forecastStart.value,
        '-e', forecastEnd.value,
        '-o', `${demandOutputDir.value}/${demandFilename}`,
        '--model', 'hybrid',
      ];

      // Add database flag if using database mode
      if (dataSource.value === 'database') {
        demandArgs.push('--use-db');
      }

      // Add zonal flag if enabled
      if (enableZonal.value) {
        demandArgs.push('--zonal');
      }

      // Add training dates for auto-train mode
      if (calibrationMode.value === 'auto' && dataSource.value === 'csv' && trainingStart.value && trainingEnd.value) {
        demandArgs.push('--training-start', trainingStart.value);
        demandArgs.push('--training-end', trainingEnd.value);
      }

      // Calibration options
      if (demandModel.value === 'hybrid-calibrated') {
        if (calibrationMode.value === 'saved' && selectedCalibrator.value) {
          demandArgs.push('--load-calibrator', `models/calibrator/${selectedCalibrator.value}.json`);
        } else if (saveCalibrator.value) {
          const modelName = `calibrator_${new Date().toISOString().split('T')[0]}`;
          demandArgs.push('--save-calibrator', `models/calibrator/${modelName}.json`);
        }
      } else {
        demandArgs.push('--no-calibrate');
      }

      // Add gateway push flag if enabled
      if (pushToGateway.value) {
        demandArgs.push('--push');
      }

      const demandResult = await window.electronAPI.runCommand(demandArgs);
      completedSteps++;
      progress.value = (completedSteps / totalSteps) * 90;

      if (demandResult.code === 0) {
        addStatus('Demand forecast completed successfully', 'success');
      } else {
        // Extract meaningful error from stderr
        const errorLines = demandResult.stderr?.split('\n').filter((l: string) => l.trim()).slice(-3) || [];
        const errorMsg = errorLines.join(' ').substring(0, 200) || demandResult.error || 'Unknown error';
        addStatus(`Demand forecast failed: ${errorMsg}`, 'error');
        hasError.value = true;
      }
    }

    // Run CFAC forecast
    if (enableCfac.value) {
      const modelName = cfacModel.value === 'hybrid'
        ? 'Hybrid (Physics + ML)'
        : cfacModel.value === 'hybrid-lstm'
        ? 'Hybrid + LSTM Correction'
        : 'Legacy XGBoost';
      addStatus(`Starting Capacity Factor Forecast (${modelName})...`);
      if (!enableDemand.value) progress.value = 5;

      const cfacFilename = generateOutputFilename('cfac');
      let cfacArgs: string[];

      let cfacResult;

      if (cfacModel.value === 'hybrid' || cfacModel.value === 'hybrid-lstm') {
        // Hybrid model - physics + ML correction, best accuracy
        cfacArgs = [
          'cfac', 'forecast2',
          '-t', cfacDataDir.value,
          '-s', forecastStart.value,
          '-e', forecastEnd.value,
          '-o', `${cfacOutputDir.value}/${cfacFilename}`,
        ];

        // Add database mode flag if using database
        if (dataSource.value === 'database') {
          cfacArgs.push('--use-db', '--db', databasePath.value);
        }

        // Add LSTM correction flag if selected
        if (cfacModel.value === 'hybrid-lstm') {
          cfacArgs.push('--lstm-correction');
        }

        if (trainingEnd.value) {
          cfacArgs.push('--training-end', trainingEnd.value);
        }

        // Add gateway push flag if enabled
        if (pushToGateway.value) {
          cfacArgs.push('--push');
        }

        cfacResult = await window.electronAPI.runCommand(cfacArgs);
      } else {
        // Legacy model - use cfac forecast2 (model options read from forecast_config.json)
        cfacArgs = [
          'cfac', 'forecast2',
          '-t', cfacDataDir.value,
          '-s', forecastStart.value,
          '-e', forecastEnd.value,
          '-o', `${cfacOutputDir.value}/${cfacFilename}`,
          // Note: --use-xgboost, --asymmetric-loss, --bias-correction removed - read from forecast_config.json
        ];

        // Add database mode flag if using database
        if (dataSource.value === 'database') {
          cfacArgs.push('--use-db', '--db', databasePath.value);
        }

        if (trainingEnd.value) {
          cfacArgs.push('--training-end', trainingEnd.value);
        }

        // Add gateway push flag if enabled
        if (pushToGateway.value) {
          cfacArgs.push('--push');
        }

        cfacResult = await window.electronAPI.runCommand(cfacArgs);
      }
      completedSteps++;
      progress.value = (completedSteps / totalSteps) * 90;

      if (cfacResult.code === 0) {
        addStatus(`Capacity Factor forecast (${modelName}) completed successfully`, 'success');
      } else {
        // Extract meaningful error from stderr
        const errorLines = cfacResult.stderr?.split('\n').filter((l: string) => l.trim()).slice(-3) || [];
        const errorMsg = errorLines.join(' ').substring(0, 200) || cfacResult.error || 'Unknown error';
        addStatus(`CFAC forecast failed: ${errorMsg}`, 'error');
        hasError.value = true;
      }
    }

    progress.value = 100;
    isComplete.value = true;

    if (hasError.value) {
      addStatus('Forecast completed with errors', 'error');
    } else {
      addStatus('All forecasts completed successfully!', 'success');
    }
  } catch (error: any) {
    addStatus(`Error: ${error.message}`, 'error');
    hasError.value = true;
  } finally {
    isRunning.value = false;
  }
}

function resetProgress() {
  isComplete.value = false;
  hasError.value = false;
  progress.value = 0;
  currentStatus.value = '';
  statusHistory.value = [];
}

// ============ SCHEDULER FUNCTIONS ============

// Browse functions for scheduler - UNUSED (commented out)
// async function browseSchedulerDemandPath() {
//   const path = await window.electronAPI.selectDirectory();
//   if (path) schedulerDemandPath.value = path;
// }

// async function browseSchedulerCfacPath() {
//   const path = await window.electronAPI.selectDirectory();
//   if (path) schedulerCfacPath.value = path;
// }

// async function browseSchedulerOutputDir() {
//   const path = await window.electronAPI.selectDirectory();
//   if (path) schedulerOutputDir.value = path;
// }

// Add scheduler status message
function addSchedulerStatus(message: string, type: 'info' | 'success' | 'error' | 'warn' | 'debug' = 'info') {
  schedulerCurrentStatus.value = message;
  schedulerStatusHistory.value.push({
    time: formatTime(new Date()),
    message,
    type
  });
}

// Schedule time management - UNUSED (commented out)
// function addScheduleTime() {
//   if (schedulerTimes.value.length < 6) {
//     schedulerTimes.value.push('06:00');
//     saveSettings();
//   }
// }

// function removeScheduleTime(index: number) {
//   if (schedulerTimes.value.length > 1) {
//     schedulerTimes.value.splice(index, 1);
//     saveSettings();
//   }
// }

// function updateScheduleTime(index: number, value: string) {
//   schedulerTimes.value[index] = value;
//   saveSettings();
// }

// Run scheduler - UNUSED (legacy function, commented out - use runSchedulerManual instead)
// async function runScheduler() {
//   // Validate inputs
//   if (schedulerMode.value === 'run' && !schedulerAsOfDate.value) {
//     addSchedulerStatus('Please select an as-of date', 'error');
//     return;
//   }
//   if (schedulerMode.value === 'backfill' && (!schedulerStartDate.value || !schedulerEndDate.value)) {
//     addSchedulerStatus('Please select start and end dates', 'error');
//     return;
//   }

//   // Reset state
//   schedulerIsRunning.value = true;
//   schedulerProgress.value = 0;
//   schedulerStatusHistory.value = [];
//   schedulerCurrentStatus.value = 'Starting scheduler...';

//   // Build CLI args
//   const args = ['scheduler', schedulerMode.value === 'run' ? 'run' : 'backfill'];

//   // Date args
//   if (schedulerMode.value === 'run') {
//     args.push('-d', schedulerAsOfDate.value);
//   } else {
//     args.push('-s', schedulerStartDate.value, '-e', schedulerEndDate.value);
//   }

//   // Forecast type flags
//   if (schedulerDailyEnabled.value && !schedulerWeeklyEnabled.value) {
//     args.push('--daily');
//   } else if (schedulerWeeklyEnabled.value && !schedulerDailyEnabled.value) {
//     args.push('--weekly');
//   }

//   if (schedulerDemandEnabled.value && !schedulerCfacEnabled.value) {
//     args.push('--demand-only');
//   } else if (schedulerCfacEnabled.value && !schedulerDemandEnabled.value) {
//     args.push('--cfac-only');
//   }

//   // Data paths
//   if (schedulerDemandPath.value) {
//     args.push('--demand-path', schedulerDemandPath.value);
//   }
//   if (schedulerCfacPath.value) {
//     args.push('--cfac-path', schedulerCfacPath.value);
//   }
//   if (schedulerOutputDir.value) {
//     args.push('--output', schedulerOutputDir.value);
//   }
//   if (schedulerDbPath.value) {
//     args.push('--db', schedulerDbPath.value);
//   }

//   // Model settings
//   if (schedulerDemandModel.value) {
//     args.push('--demand-model', schedulerDemandModel.value);
//   }
//   if (schedulerUseXgboost.value) {
//     args.push('--use-xgboost');
//   }
//   if (schedulerAsymmetricLoss.value) {
//     args.push('--asymmetric-loss');
//   }
//   if (schedulerBiasCorrection.value) {
//     args.push('--bias-correction');
//   }

//   // Zonal mode
//   if (schedulerZonalEnabled.value && schedulerDemandEnabled.value) {
//     args.push('--zonal');
//   }

//   // Calibration settings
//   args.push('--calib-days', schedulerCalibDays.value.toString());
//   args.push('--calib-threshold', schedulerCalibThreshold.value.toString());
//   args.push('--max-iterations', schedulerMaxIterations.value.toString());

//   try {
//     addSchedulerStatus('Running scheduler command...');
//     schedulerProgress.value = 10;

//     const result = await window.electronAPI.runCommand(args);

//     schedulerProgress.value = 100;

//     if (result.code === 0) {
//       addSchedulerStatus('Scheduler completed successfully!', 'success');
//     } else {
//       const errorLines = result.stderr?.split('\n').filter((l: string) => l.trim()).slice(-3) || [];
//       const errorMsg = errorLines.join(' ').substring(0, 200) || result.error || 'Unknown error';
//       addSchedulerStatus('Scheduler failed: ' + errorMsg, 'error');
//     }
//   } catch (error: any) {
//     addSchedulerStatus('Error: ' + error.message, 'error');
//   } finally {
//     schedulerIsRunning.value = false;
//   }
// }

// Scheduler configuration management
async function loadSchedulerConfig() {
  try {
    const config = await window.electronAPI.loadSchedulerConfig() as Partial<SchedulerConfig> | null;
    if (config) {
      // Ensure demandGeography has a default value for backward compatibility
      schedulerConfig.value = {
        enabled: config.enabled ?? false,
        runTimeMorning: config.runTimeMorning ?? '06:00',
        runTimeEvening: config.runTimeEvening ?? '18:00',
        secondRunEnabled: config.secondRunEnabled ?? false,
        runDays: config.runDays ?? ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
        forecastDemand: config.forecastDemand ?? true,
        forecastCfac: config.forecastCfac ?? true,
        horizonDaily: config.horizonDaily ?? true,
        horizonWeekly: config.horizonWeekly ?? true,
        demandGeography: config.demandGeography ?? 'regional',
        weatherMaxAge: config.weatherMaxAge ?? 6,
        autoPushGateway: config.autoPushGateway ?? false,
        archiveRetention: config.archiveRetention ?? 90
      };
    }
  } catch (error: any) {
    console.error('Failed to load scheduler config:', error);
  }
}

async function saveSchedulerConfig() {
  try {
    // Use toRaw() to get a plain object that can be cloned for IPC
    const plainConfig = toRaw(schedulerConfig.value);
    await window.electronAPI.saveSchedulerConfig(plainConfig);
    addSchedulerStatus('Configuration saved', 'success');
  } catch (error: any) {
    addSchedulerStatus('Failed to save configuration: ' + error.message, 'error');
  }
}

// Gateway configuration management
async function loadGatewayConfig() {
  try {
    const config = await window.electronAPI.loadGatewayConfig();
    if (config) {
      gatewayConfig.value = {
        host: config.host || '100.115.9.94',
        port: config.port || 22,
        username: config.username || 'vantage-upload',
        password: config.password || ''
      };
    }
  } catch (error: any) {
    console.error('Failed to load gateway config:', error);
  }
}

async function saveGatewayConfig() {
  try {
    // Convert reactive proxy to plain object for IPC serialization
    const config = {
      host: gatewayConfig.value.host,
      port: gatewayConfig.value.port,
      username: gatewayConfig.value.username,
      password: gatewayConfig.value.password
    };
    const result = await window.electronAPI.saveGatewayConfig(config);
    if (result.success) {
      gatewayTestStatus.value = 'success';
      gatewayTestMessage.value = 'Gateway configuration saved';
      setTimeout(() => {
        gatewayTestStatus.value = 'idle';
        gatewayTestMessage.value = '';
      }, 3000);
    } else {
      gatewayTestStatus.value = 'error';
      gatewayTestMessage.value = result.error || 'Failed to save';
    }
  } catch (error: any) {
    gatewayTestStatus.value = 'error';
    gatewayTestMessage.value = 'Failed to save: ' + error.message;
  }
}

async function testGatewayConnection() {
  gatewayTestStatus.value = 'testing';
  gatewayTestMessage.value = 'Testing connection...';

  try {
    // Convert reactive proxy to plain object for IPC serialization
    const config = {
      host: gatewayConfig.value.host,
      port: gatewayConfig.value.port,
      username: gatewayConfig.value.username,
      password: gatewayConfig.value.password
    };
    // First save the config, then test
    await window.electronAPI.saveGatewayConfig(config);
    const result = await window.electronAPI.testGatewayConnection();

    if (result.connected) {
      gatewayTestStatus.value = 'success';
      const accessibleDirs = result.directories?.filter((d: any) => d.accessible).length || 0;
      const totalDirs = result.directories?.length || 0;
      gatewayTestMessage.value = `Connected! ${accessibleDirs}/${totalDirs} directories accessible`;
    } else {
      gatewayTestStatus.value = 'error';
      gatewayTestMessage.value = result.error || 'Connection failed';
    }
  } catch (error: any) {
    gatewayTestStatus.value = 'error';
    gatewayTestMessage.value = 'Test failed: ' + error.message;
  }
}

// Gateway Storage Management Functions
async function loadGatewayStorageStats() {
  gatewayStorageLoading.value = true;
  gatewayStorageError.value = '';
  gatewayActionMessage.value = '';
  gatewayActionType.value = '';

  try {
    const result = await window.electronAPI.getGatewayStorage();
    if (result.error) {
      gatewayStorageError.value = result.error;
      gatewayStorageStats.value = null;
    } else if (result.success && result.categories) {
      gatewayStorageStats.value = {
        categories: result.categories,
        totalFiles: result.totalFiles || 0,
        totalSize: result.totalSize || 0,
        totalSizeFormatted: result.totalSizeFormatted || '0 B',
        oldestFile: result.oldestFile || '',
        newestFile: result.newestFile || ''
      };
    } else {
      gatewayStorageStats.value = null;
    }
  } catch (error: any) {
    gatewayStorageError.value = error.message || 'Failed to load storage stats';
    gatewayStorageStats.value = null;
  } finally {
    gatewayStorageLoading.value = false;
  }
}

async function archiveGatewayFiles() {
  gatewayArchiveLoading.value = true;
  gatewayActionMessage.value = '';
  gatewayActionType.value = '';

  try {
    const result = await window.electronAPI.archiveGatewayFiles({
      olderThanDays: gatewayArchiveDays.value,
      deleteAfterArchive: true
    });

    if (result.error) {
      gatewayActionMessage.value = result.error;
      gatewayActionType.value = 'error';
    } else if (result.success) {
      const count = result.results?.archived?.length || 0;
      gatewayActionMessage.value = result.message || `Archived ${count} files older than ${gatewayArchiveDays.value} days`;
      gatewayActionType.value = 'success';
      // Refresh stats
      await loadGatewayStorageStats();
    }
  } catch (error: any) {
    gatewayActionMessage.value = error.message || 'Archive failed';
    gatewayActionType.value = 'error';
  } finally {
    gatewayArchiveLoading.value = false;
  }
}

async function clearGatewayFiles() {
  if (!gatewayClearConfirm.value) {
    gatewayActionMessage.value = 'Please check the confirmation box to delete files';
    gatewayActionType.value = 'error';
    return;
  }

  gatewayClearLoading.value = true;
  gatewayActionMessage.value = '';
  gatewayActionType.value = '';

  try {
    const result = await window.electronAPI.clearGatewayFiles({
      olderThanDays: gatewayClearDays.value,
      confirm: 'DELETE'
    });

    if (result.error) {
      gatewayActionMessage.value = result.error;
      gatewayActionType.value = 'error';
    } else if (result.success) {
      const count = result.results?.deleted?.length || 0;
      gatewayActionMessage.value = result.message || `Deleted ${count} files older than ${gatewayClearDays.value} days`;
      gatewayActionType.value = 'success';
      gatewayClearConfirm.value = false;
      // Refresh stats
      await loadGatewayStorageStats();
    }
  } catch (error: any) {
    gatewayActionMessage.value = error.message || 'Clear failed';
    gatewayActionType.value = 'error';
  } finally {
    gatewayClearLoading.value = false;
  }
}

async function loadRecentRuns(limit = 20) {
  try {
    const runs = await window.electronAPI.getRecentRuns(limit);
    recentRuns.value = runs;
  } catch (error: any) {
    console.error('Failed to load recent runs:', error);
  }
}

async function loadSavedCalibrations(limit = 10) {
  try {
    const calibrations = await window.electronAPI.getCalibrations(limit);
    savedCalibrations.value = calibrations;
    // Auto-select the most recent converged calibration
    const converged = calibrations.find(c => c.converged);
    if (converged && !selectedCalibrationId.value) {
      selectedCalibrationId.value = converged.id;
    }
  } catch (error: any) {
    console.error('Failed to load saved calibrations:', error);
  }
}

async function runSchedulerManual() {
  if (!manualRunDate.value) {
    addSchedulerStatus('Please select a start date', 'error');
    return;
  }

  // Ensure config is saved before CLI runs (CLI reads from forecast_config.json)
  await syncDemandGeographyToConfig();

  // Reset scheduler terminal state and expand terminal
  schedulerStatusHistory.value = [];
  schedulerProgress.value = 0;
  schedulerCurrentStatus.value = '';
  terminalExpanded.value = true;

  schedulerIsRunning.value = true;

  // Auto-import new CSV data if enabled
  if (autoImportBeforeRun.value) {
    addSchedulerStatus('Checking for new CSV data to import...');
    try {
      // Determine which database to import to based on geography
      const dbPath = schedulerDemandGeography.value === 'zonal'
        ? globalZonalDemandDb.value
        : globalRegionalDemandDb.value;

      // Import demand data
      if (globalDemandCsvPath.value) {
        const demandResult = await window.electronAPI.importToDatabase({
          dbPath: dbPath,
          dataType: 'demand',
          sourcePath: globalDemandCsvPath.value
        });
        if (demandResult.success) {
          addSchedulerStatus(`Demand import: ${demandResult.message}`);
        }
      }

      // Import CFAC data
      if (globalCfacCsvPath.value && (manualRunType.value === 'cfac' || manualRunType.value === 'both')) {
        const cfacResult = await window.electronAPI.importToDatabase({
          dbPath: globalSchedulerDb.value,
          dataType: 'cfac',
          sourcePath: globalCfacCsvPath.value
        });
        if (cfacResult.success) {
          addSchedulerStatus(`CFAC import: ${cfacResult.message}`);
        }
      }
    } catch (error: any) {
      addSchedulerStatus(`Auto-import warning: ${error.message}`, 'error');
      // Continue with scheduler run even if import fails
    }
  }

  // Determine if this is a date range (backfill) or single date run
  const isDateRange = manualRunEndDate.value && manualRunEndDate.value !== manualRunDate.value;
  if (isDateRange) {
    addSchedulerStatus(`Starting backfill from ${manualRunDate.value} to ${manualRunEndDate.value}...`);
  } else {
    addSchedulerStatus(`Starting scheduler run for ${manualRunDate.value}...`);
  }

  try {
    const calibratorPath = schedulerCalibrationMode.value === 'saved' && schedulerSelectedCalibrator.value
      ? `models/calibrator/${schedulerSelectedCalibrator.value}.json`
      : null;

    // For auto mode, pass training period (data end date is auto-detected)
    const trainingDays = schedulerCalibrationMode.value === 'auto' ? computedTrainingDays.value : undefined;

    // For reuse mode, pass the selected calibration ID to skip recalibration
    const useCalibrationId = schedulerCalibrationMode.value === 'reuse' && selectedCalibrationId.value
      ? selectedCalibrationId.value
      : null;

    // Determine data source based on toggle
    const useDb = schedulerDataSource.value === 'database';
    let dataDbPath: string | null = null;

    if (useDb) {
      // Database mode - use configured database paths
      if (schedulerDemandGeography.value === 'regional') {
        dataDbPath = globalRegionalDemandDb.value;
      } else if (schedulerDemandGeography.value === 'zonal') {
        dataDbPath = globalZonalDemandDb.value;
      } else {
        // 'both' - use regional DB, scheduler will handle both modes
        dataDbPath = globalRegionalDemandDb.value;
      }
    }
    // CSV mode: useDb = false, dataDbPath = null (CLI will use default CSV paths)

    await window.electronAPI.runSchedulerManual({
      date: manualRunDate.value,
      type: manualRunType.value,
      horizon: manualRunHorizon.value,
      calibratorPath,
      trainingDays,
      endDate: manualRunEndDate.value || null,
      verbose: schedulerVerboseOutput.value,
      pushGateway: schedulerConfig.value.autoPushGateway,
      useCalibrationId,
      useDb,
      dataDbPath,
      maxIterations: calibrationIterations.value,
      // New options
      refreshWeather: schedulerRefreshWeather.value,
      overwrite: schedulerOverwrite.value,
      suffix: schedulerSuffix.value || null,
      outputDir: globalSchedulerOutputDir.value,
      // Note: Model options (useXgboost, asymmetricLoss, biasCorrection) removed - read from forecast_config.json
      weatherCacheDir: globalWeatherCacheDir.value,
    });
    addSchedulerStatus(isDateRange ? 'Backfill completed' : 'Manual run completed', 'success');
    await loadRecentRuns();
    await loadSavedCalibrations(); // Refresh calibrations after run (may have created new one)
  } catch (error: any) {
    addSchedulerStatus('Manual run failed: ' + error.message, 'error');
  } finally {
    schedulerIsRunning.value = false;
  }
}

// Load available calibrator models
async function loadCalibratorModels() {
  try {
    const result = await window.electronAPI.listTrainedModels();
    if (result.success && result.models) {
      availableCalibratorModels.value = result.models;
      if (result.models.length > 0 && !selectedCalibrator.value) {
        selectedCalibrator.value = result.models[0].name;
      }
    } else {
      availableCalibratorModels.value = [];
    }
  } catch (e) {
    console.error('Failed to load calibrator models:', e);
    availableCalibratorModels.value = [];
  }
}

// Generate output filename based on naming settings
function generateOutputFilename(type: 'demand' | 'cfac'): string {
  const startDate = forecastStart.value;
  const endDate = forecastEnd.value;

  if (useCustomName.value) {
    // Use custom full name if provided
    if (type === 'demand' && customDemandName.value) {
      return customDemandName.value.endsWith('.csv') ? customDemandName.value : `${customDemandName.value}.csv`;
    }
    if (type === 'cfac' && customCfacName.value) {
      return customCfacName.value.endsWith('.csv') ? customCfacName.value : `${customCfacName.value}.csv`;
    }
  }

  // Use prefix + date + suffix naming
  let prefix = '';
  if (type === 'demand') {
    prefix = enableZonal.value ? demandZonalPrefix.value : demandPrefix.value;
  } else {
    prefix = cfacPrefix.value;
  }

  const dateStr = startDate === endDate ? startDate : `${startDate}_${endDate}`;
  const suffix = outputSuffix.value || '';

  return `${prefix}${dateStr}${suffix}.csv`;
}

// Get preview of output filename
const demandFilenamePreview = computed(() => generateOutputFilename('demand'));
const cfacFilenamePreview = computed(() => generateOutputFilename('cfac'));
</script>

<template>
  <div class="app dark-theme">
    <!-- Custom Titlebar for window dragging -->
    <div class="titlebar">
      <div class="titlebar-drag-region"></div>
    </div>
    <!-- Left Sidebar -->
    <aside class="sidebar">
      <div class="sidebar-header">
        <img src="../assets/VANTAGE_LOGO-removebg-preview.png" alt="Vantage Logo" class="sidebar-logo" />
        <div class="sidebar-title">
          <span class="title-text">Vantage</span>
          <span class="title-sub">Forecaster</span>
        </div>
      </div>

      <nav class="sidebar-nav">
        <button
          class="nav-item"
          :class="{ active: activeTab === 'manual' }"
          @click="activeTab = 'manual'"
          :disabled="isRunning || schedulerIsRunning"
        >
          <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
          </svg>
          <span class="nav-text">Manual Forecast</span>
        </button>
        <button
          class="nav-item"
          :class="{ active: activeTab === 'scheduler' }"
          @click="activeTab = 'scheduler'"
          :disabled="isRunning || schedulerIsRunning"
        >
          <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"/>
            <path d="M12 6v6l4 2"/>
          </svg>
          <span class="nav-text">Scheduler</span>
        </button>
        <button
          class="nav-item"
          :class="{ active: activeTab === 'gateway' }"
          @click="activeTab = 'gateway'; loadGatewayStorageStats()"
          :disabled="isRunning || schedulerIsRunning"
        >
          <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M5 12h14M12 5l7 7-7 7"/>
          </svg>
          <span class="nav-text">Gateway</span>
        </button>
        <button
          class="nav-item"
          :class="{ active: activeTab === 'settings' }"
          @click="activeTab = 'settings'"
          :disabled="isRunning || schedulerIsRunning"
        >
          <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="3"/>
            <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z"/>
          </svg>
          <span class="nav-text">Settings</span>
        </button>
      </nav>

      <div class="sidebar-footer">
        <span class="version-text">v2.1.0</span>
      </div>
    </aside>

    <!-- Main Content Area -->
    <main class="main-content">
      <!-- ============ MANUAL FORECAST TAB ============ -->
      <div v-if="activeTab === 'manual'" class="tab-content">

        <!-- Data Format Notification -->
        <div v-if="dataFormatMessage" class="format-notification" :class="dataFormatType">
          <span class="format-icon">{{ dataFormatType === 'error' ? '✕' : dataFormatType === 'warning' ? '⚠' : 'ℹ' }}</span>
          <span>{{ dataFormatMessage }}</span>
          <button @click="clearFormatMessage" class="format-close">&times;</button>
        </div>

        <!-- Row Layout for Manual Tab -->
        <div class="manual-layout">
          <!-- Row 1: Data Source (full width) -->
          <section class="card card-full-row">
            <h2>Data Source</h2>
            <div class="data-source-content">
              <div class="source-toggle">
                <label class="radio-label">
                  <input type="radio" v-model="dataSource" value="csv" :disabled="isRunning" />
                  <span>CSV</span>
                </label>
                <label class="radio-label">
                  <input type="radio" v-model="dataSource" value="database" :disabled="isRunning" />
                  <span>Database</span>
                </label>
              </div>

              <div v-if="dataSource === 'database'" class="data-source-inputs">
                <div class="form-group compact">
                  <label>Database</label>
                  <div class="input-row">
                    <input type="text" v-model="databasePath" placeholder="Select database file..." readonly />
                    <button @click="browseDatabase" class="btn btn-secondary btn-sm" :disabled="isRunning">Browse</button>
                  </div>
                </div>
                <div v-if="databaseInfo" class="db-info-inline">
                  <span class="db-stat">Demand: {{ databaseInfo.demand?.records?.toLocaleString() || 0 }}</span>
                  <span class="db-stat">CFAC: {{ databaseInfo.cfac?.records?.toLocaleString() || 0 }}</span>
                  <span class="db-stat">Weather: {{ databaseInfo.weather?.records?.toLocaleString() || 0 }}</span>
                  <button @click="loadDatabaseInfo" class="btn btn-text btn-xs" :disabled="isLoadingDbInfo">Refresh</button>
                </div>
              </div>

              <div v-else class="data-source-inputs csv-mode">
                <div class="form-group compact" v-if="enableDemand">
                  <label>Demand</label>
                  <div class="input-row">
                    <input type="text" v-model="demandDataDir" placeholder="Demand folder..." readonly />
                    <button @click="browseDemandDir" class="btn btn-secondary btn-sm" :disabled="isRunning">Browse</button>
                  </div>
                </div>
                <div class="form-group compact" v-if="enableCfac">
                  <label>CFAC</label>
                  <div class="input-row">
                    <input type="text" v-model="cfacDataDir" placeholder="CFAC folder..." readonly />
                    <button @click="browseCfacDir" class="btn btn-secondary btn-sm" :disabled="isRunning">Browse</button>
                  </div>
                </div>
              </div>

              <div class="output-dir-inputs">
                <div class="form-group compact" v-if="enableDemand">
                  <label>Demand Out</label>
                  <div class="input-row">
                    <input type="text" v-model="demandOutputDir" placeholder="Output folder..." :disabled="isRunning" />
                    <button @click="browseDemandOutputDir" class="btn btn-secondary btn-sm" :disabled="isRunning">Browse</button>
                  </div>
                </div>
                <div class="form-group compact" v-if="enableCfac">
                  <label>CFAC Out</label>
                  <div class="input-row">
                    <input type="text" v-model="cfacOutputDir" placeholder="Output folder..." :disabled="isRunning" />
                    <button @click="browseCfacOutputDir" class="btn btn-secondary btn-sm" :disabled="isRunning">Browse</button>
                  </div>
                </div>
              </div>
            </div>
          </section>

          <!-- Row 2: 3-Column Grid -->
          <div class="cards-grid-3">
            <!-- Column 1: Output Naming Card -->
            <section class="card card-compact">
              <h2>Output Naming</h2>
              <div class="output-preview">
                <span v-if="enableDemand" class="preview-tag">{{ demandFilenamePreview }}</span>
                <span v-if="enableCfac" class="preview-tag">{{ cfacFilenamePreview }}</span>
              </div>
              <div class="naming-mode">
                <label class="radio-label">
                  <input type="radio" :value="false" v-model="useCustomName" :disabled="isRunning" />
                  <span>Prefix</span>
                </label>
                <label class="radio-label">
                  <input type="radio" :value="true" v-model="useCustomName" :disabled="isRunning" />
                  <span>Custom</span>
                </label>
              </div>
              <div v-if="!useCustomName" class="naming-grid">
                <div class="form-group compact" v-if="enableDemand">
                  <label>Dem</label>
                  <input type="text" v-model="demandPrefix" placeholder="FC_DEM_" :disabled="isRunning" />
                </div>
                <div class="form-group compact" v-if="enableCfac">
                  <label>CFAC</label>
                  <input type="text" v-model="cfacPrefix" placeholder="FC_CF_" :disabled="isRunning" />
                </div>
                <div class="form-group compact">
                  <label>Suffix</label>
                  <input type="text" v-model="outputSuffix" placeholder="_v2" :disabled="isRunning" />
                </div>
              </div>
              <div v-else class="naming-grid">
                <div class="form-group compact" v-if="enableDemand">
                  <label>Demand</label>
                  <input type="text" v-model="customDemandName" placeholder="forecast.csv" :disabled="isRunning" />
                </div>
                <div class="form-group compact" v-if="enableCfac">
                  <label>CFAC</label>
                  <input type="text" v-model="customCfacName" placeholder="cfac.csv" :disabled="isRunning" />
                </div>
              </div>
            </section>

            <!-- Column 2: Model Training Card -->
            <section class="card card-compact">
              <h2>Model Training</h2>
              <div class="calibration-mode-row">
                <label class="radio-label">
                  <input type="radio" v-model="calibrationMode" value="auto" :disabled="isRunning" />
                  <span>Auto</span>
                </label>
                <label class="radio-label">
                  <input type="radio" v-model="calibrationMode" value="saved" :disabled="isRunning || availableCalibratorModels.length === 0" />
                  <span>Saved</span>
                </label>
              </div>
              <div v-if="calibrationMode === 'auto'" class="training-period-section">
                <div class="date-row">
                  <div class="form-group compact">
                    <label>Start</label>
                    <input type="date" v-model="trainingStart" :disabled="isRunning" />
                  </div>
                  <div class="form-group compact">
                    <label>End</label>
                    <input type="date" v-model="trainingEnd" :disabled="isRunning" />
                  </div>
                </div>
                <div class="save-option">
                  <label class="checkbox-label">
                    <input type="checkbox" v-model="saveCalibrator" :disabled="isRunning" />
                    <span>Save</span>
                  </label>
                </div>
              </div>
              <div v-if="calibrationMode === 'saved'" class="saved-model-section">
                <select v-model="selectedCalibrator" :disabled="isRunning" class="calibrator-dropdown">
                  <option v-for="model in availableCalibratorModels" :key="model.name" :value="model.name">
                    {{ model.name }}
                  </option>
                </select>
              </div>
            </section>

            <!-- Column 3: Forecast Options Card (includes Period) -->
            <section class="card card-compact">
              <h2>Forecast Options</h2>
              <!-- Forecast Period -->
              <div class="forecast-period-row">
                <div class="form-group compact">
                  <label>Start</label>
                  <input type="date" v-model="forecastStart" :disabled="isRunning" />
                </div>
                <div class="form-group compact">
                  <label>End</label>
                  <input type="date" v-model="forecastEnd" :disabled="isRunning" />
                </div>
              </div>
              <!-- Toggles -->
              <div class="options-grid-2x2">
                <div class="toggle-group">
                  <label class="toggle">
                    <input type="checkbox" v-model="enableDemand" :disabled="isRunning" />
                    <span class="toggle-slider"></span>
                    <span class="toggle-label">Demand</span>
                  </label>
                  <select v-if="enableDemand" v-model="demandModel" :disabled="isRunning" class="model-dropdown-sm">
                    <option value="hybrid-calibrated">+Calib</option>
                    <option value="hybrid">Hybrid</option>
                  </select>
                </div>
                <div class="toggle-group">
                  <label class="toggle">
                    <input type="checkbox" v-model="enableCfac" :disabled="isRunning" />
                    <span class="toggle-slider"></span>
                    <span class="toggle-label">CFAC</span>
                  </label>
                  <select v-if="enableCfac" v-model="cfacModel" :disabled="isRunning" class="model-dropdown-sm">
                    <option value="hybrid">Hybrid</option>
                    <option value="hybrid-lstm">+LSTM</option>
                  </select>
                </div>
                <div class="toggle-group" :class="{ 'disabled': !enableDemand }">
                  <label class="toggle">
                    <input type="checkbox" v-model="enableZonal" :disabled="isRunning || !enableDemand" />
                    <span class="toggle-slider"></span>
                    <span class="toggle-label">Zonal</span>
                  </label>
                </div>
                <div class="scaling-group-compact" v-if="!usePerTypeScaling">
                  <label>Scale</label>
                  <div class="scaling-input">
                    <input type="number" v-model="scalingPercent" min="1" max="200" :disabled="isRunning" />
                    <span class="percent">%</span>
                  </div>
                </div>
                <div class="toggle-group gateway-toggle">
                  <label class="toggle">
                    <input type="checkbox" v-model="pushToGateway" :disabled="isRunning" />
                    <span class="toggle-slider gateway"></span>
                    <span class="toggle-label">Push to Gateway</span>
                  </label>
                </div>
              </div>

              <!-- Advanced Options -->
              <div class="advanced-options-row">
                <!-- Per-Type Scaling Toggle -->
                <div class="toggle-group" v-if="enableCfac">
                  <label class="toggle">
                    <input type="checkbox" v-model="usePerTypeScaling" :disabled="isRunning" />
                    <span class="toggle-slider"></span>
                    <span class="toggle-label">Per-Type Scaling</span>
                  </label>
                </div>

                <!-- Per-Type Scaling Inputs (shown when enabled) -->
                <template v-if="usePerTypeScaling && enableCfac">
                  <div class="scaling-group-compact">
                    <label>Wind</label>
                    <div class="scaling-input">
                      <input type="number" v-model="scalingWind" min="1" max="200" :disabled="isRunning" />
                      <span class="percent">%</span>
                    </div>
                  </div>
                  <div class="scaling-group-compact">
                    <label>Solar</label>
                    <div class="scaling-input">
                      <input type="number" v-model="scalingSolar" min="1" max="200" :disabled="isRunning" />
                      <span class="percent">%</span>
                    </div>
                  </div>
                </template>

                <!-- Demand Growth Rate -->
                <div class="form-group compact" v-if="enableDemand">
                  <label>Growth Rate</label>
                  <div class="scaling-input">
                    <input type="number" v-model.number="demandGrowthRate" step="0.001" min="-0.1" max="0.1" :disabled="isRunning" style="width: 70px;" />
                    <span class="percent" title="Daily growth rate (e.g., 0.001 = 0.1%/day)">%/d</span>
                  </div>
                </div>

                <!-- Training End Date Cutoff -->
                <div class="form-group compact">
                  <label>Training Cutoff</label>
                  <input type="date" v-model="trainingEndDate" :disabled="isRunning" placeholder="Optional" style="width: 130px;" />
                </div>
              </div>
            </section>
          </div>
        </div>

      </div><!-- End Manual Forecast Tab -->

      <!-- ============ SCHEDULER TAB ============ -->
      <div v-if="activeTab === 'scheduler'" class="tab-content">
        <h1 class="page-title">Scheduler</h1>
        <p class="page-subtitle">Run manual forecasts and configure automated scheduling</p>

        <!-- Manual Run Section - Full Width -->
        <section class="card manual-run-card">
          <h2>Manual Run</h2>
          <div class="data-source-row">
            <div class="source-toggle">
              <label class="radio-label">
                <input type="radio" v-model="schedulerDataSource" value="database" :disabled="schedulerIsRunning" />
                <span>Database</span>
              </label>
              <label class="radio-label">
                <input type="radio" v-model="schedulerDataSource" value="csv" :disabled="schedulerIsRunning" />
                <span>CSV</span>
              </label>
            </div>
            <span class="data-source-hint">
              {{ schedulerDataSource === 'database'
                ? (schedulerDemandGeography === 'regional' ? globalRegionalDemandDb : schedulerDemandGeography === 'zonal' ? globalZonalDemandDb : 'Both databases')
                : globalDemandCsvPath }}
              <span class="settings-link" @click="activeTab = 'settings'">(Settings)</span>
            </span>
          </div>
          <div class="manual-run-grid">
            <!-- Date Selection -->
            <div class="manual-run-dates">
              <div class="form-group compact">
                <label>Start Date</label>
                <input type="date" v-model="manualRunDate" :disabled="schedulerIsRunning" />
              </div>
              <div class="form-group compact">
                <label>End Date <span class="optional">(optional)</span></label>
                <input type="date" v-model="manualRunEndDate" :min="manualRunDate" :disabled="schedulerIsRunning" />
              </div>
            </div>

            <!-- Type and Horizon -->
            <div class="manual-run-options">
              <div class="form-group compact">
                <label>Type</label>
                <select v-model="manualRunType" class="calibrator-dropdown" :disabled="schedulerIsRunning">
                  <option value="both">Both</option>
                  <option value="demand">Demand Only</option>
                  <option value="cfac">CFAC Only</option>
                </select>
              </div>
              <div class="form-group compact">
                <label>Horizon</label>
                <select v-model="manualRunHorizon" class="calibrator-dropdown" :disabled="schedulerIsRunning">
                  <option value="both">Both</option>
                  <option value="daily">Daily Only</option>
                  <option value="weekly">Weekly Only</option>
                </select>
              </div>
            </div>

            <!-- Calibration Settings -->
            <div class="manual-run-calibration">
              <div class="form-group compact">
                <label>Calibration</label>
                <div class="calibration-mode-row">
                  <label class="radio-label">
                    <input type="radio" v-model="schedulerCalibrationMode" value="auto" :disabled="schedulerIsRunning" />
                    <span>Auto</span>
                  </label>
                  <label class="radio-label" :title="savedCalibrations.length === 0 ? 'No saved calibrations - run scheduler first' : 'Use saved calibration (skips calibration phase)'">
                    <input type="radio" v-model="schedulerCalibrationMode" value="reuse" :disabled="schedulerIsRunning || savedCalibrations.length === 0" />
                    <span>Reuse</span>
                  </label>
                  <label class="radio-label">
                    <input type="radio" v-model="schedulerCalibrationMode" value="saved" :disabled="schedulerIsRunning || availableCalibratorModels.length === 0" />
                    <span>Model</span>
                  </label>
                </div>
              </div>
              <!-- Reuse mode: select from saved calibrations -->
              <div v-if="schedulerCalibrationMode === 'reuse'" class="form-group compact">
                <select v-model="selectedCalibrationId" :disabled="schedulerIsRunning" class="calibrator-dropdown">
                  <option v-for="cal in savedCalibrations" :key="cal.id" :value="cal.id">
                    #{{ cal.id }} | Wind {{ cal.windScale >= 0 ? '+' : '' }}{{ cal.windScale }}%, Solar {{ cal.solarScale >= 0 ? '+' : '' }}{{ cal.solarScale }}% {{ cal.converged ? '✓' : '' }}
                  </option>
                </select>
                <span v-if="selectedCalibrationId" class="hint-inline" style="margin-left: 8px; font-size: 11px;">
                  {{ savedCalibrations.find(c => c.id === selectedCalibrationId)?.periodStart }} - {{ savedCalibrations.find(c => c.id === selectedCalibrationId)?.periodEnd }}
                </span>
              </div>
              <!-- Saved model mode -->
              <div v-if="schedulerCalibrationMode === 'saved'" class="form-group compact">
                <select v-model="schedulerSelectedCalibrator" :disabled="schedulerIsRunning" class="calibrator-dropdown">
                  <option v-for="model in availableCalibratorModels" :key="model.name" :value="model.name">
                    {{ model.name }} <span v-if="model.mape">({{ model.mape.toFixed(1) }}% MAPE)</span>
                  </option>
                </select>
              </div>
              <!-- Auto mode: select calibration period -->
              <div v-if="schedulerCalibrationMode === 'auto'" class="form-group compact">
                <select v-model="schedulerCalibrationPeriod" :disabled="schedulerIsRunning" class="calibrator-dropdown">
                  <option value="14days">2 Weeks</option>
                  <option value="1month">1 Month</option>
                  <option value="2months">2 Months</option>
                  <option value="3months">3 Months</option>
                </select>
                <span class="hint-inline" style="margin-left: 8px;">({{ computedTrainingDays }} days)</span>
              </div>
            </div>

            <!-- Advanced Options -->
            <div class="manual-run-advanced">
              <label class="checkbox-label" title="Force refresh of weather cache">
                <input type="checkbox" v-model="schedulerRefreshWeather" :disabled="schedulerIsRunning" />
                <span>Refresh Weather</span>
              </label>
              <!-- Backfill-specific options (only show when end date is set) -->
              <template v-if="manualRunEndDate && manualRunEndDate !== manualRunDate">
                <label class="checkbox-label" title="Overwrite existing forecasts">
                  <input type="checkbox" v-model="schedulerOverwrite" :disabled="schedulerIsRunning" />
                  <span>Overwrite</span>
                </label>
                <div class="form-group compact inline-suffix">
                  <label>Suffix</label>
                  <input type="text" v-model="schedulerSuffix" placeholder="_v2" :disabled="schedulerIsRunning" style="width: 80px;" />
                </div>
              </template>
            </div>

            <!-- Verbose and Run Button -->
            <div class="manual-run-actions">
              <label class="checkbox-label">
                <input type="checkbox" v-model="schedulerVerboseOutput" :disabled="schedulerIsRunning" />
                <span>Verbose</span>
              </label>
              <button @click="runSchedulerManual" class="btn btn-primary" :disabled="schedulerIsRunning || !manualRunDate">
                <span v-if="schedulerIsRunning" class="btn-content">
                  <span class="spinner"></span>
                  Running...
                </span>
                <span v-else>Run Now</span>
              </button>
            </div>
          </div>
        </section>

        <!-- Automation Settings - Combined Card -->
        <section class="card automation-card">
          <div class="automation-header">
            <h2>Automation Settings</h2>
            <button @click="saveSchedulerConfig" class="btn btn-primary btn-sm">
              Save Configuration
            </button>
          </div>

          <div class="automation-grid">
            <!-- Schedule Section -->
            <div class="automation-section">
              <h3>Schedule</h3>
              <div class="toggle-group" style="margin-bottom: 12px;">
                <label class="toggle">
                  <input type="checkbox" v-model="schedulerConfig.enabled" />
                  <span class="toggle-slider"></span>
                  <span class="toggle-label">Enable Scheduler</span>
                </label>
              </div>
              <div class="form-group compact">
                <label>Morning Run</label>
                <input type="time" v-model="schedulerConfig.runTimeMorning" />
              </div>
              <div class="toggle-group" style="margin-top: 8px;">
                <label class="toggle">
                  <input type="checkbox" v-model="schedulerConfig.secondRunEnabled" />
                  <span class="toggle-slider"></span>
                  <span class="toggle-label">Evening Run</span>
                </label>
              </div>
              <div v-if="schedulerConfig.secondRunEnabled" class="form-group compact" style="margin-top: 8px;">
                <input type="time" v-model="schedulerConfig.runTimeEvening" />
              </div>
              <div class="form-group compact" style="margin-top: 12px;">
                <label>Days</label>
                <div class="days-grid">
                  <label class="day-checkbox" v-for="day in ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']" :key="day">
                    <input
                      type="checkbox"
                      :checked="schedulerConfig.runDays.includes(day)"
                      @change="(e) => {
                        if ((e.target as HTMLInputElement).checked) {
                          schedulerConfig.runDays.push(day);
                        } else {
                          schedulerConfig.runDays = schedulerConfig.runDays.filter(d => d !== day);
                        }
                      }"
                    />
                    <span>{{ day.charAt(0) }}</span>
                  </label>
                </div>
              </div>
            </div>

            <!-- Forecast Types Section -->
            <div class="automation-section">
              <h3>Forecast Types</h3>
              <div class="toggle-group">
                <label class="toggle">
                  <input type="checkbox" v-model="schedulerConfig.forecastDemand" />
                  <span class="toggle-slider"></span>
                  <span class="toggle-label">Demand</span>
                </label>
              </div>
              <div class="toggle-group" style="margin-top: 8px;">
                <label class="toggle">
                  <input type="checkbox" v-model="schedulerConfig.forecastCfac" />
                  <span class="toggle-slider"></span>
                  <span class="toggle-label">CFAC</span>
                </label>
              </div>
              <!-- Geography dropdown for demand forecasts -->
              <div v-if="schedulerConfig.forecastDemand" class="form-group compact" style="margin-top: 12px;">
                <label>Demand Mode</label>
                <select v-model="schedulerConfig.demandGeography" @change="syncDemandGeographyToConfig" class="geography-dropdown">
                  <option value="regional">Regional (3)</option>
                  <option value="zonal">Zonal (14)</option>
                  <option value="both">Both</option>
                </select>
              </div>
            </div>

            <!-- Horizons Section -->
            <div class="automation-section">
              <h3>Horizons</h3>
              <div class="toggle-group">
                <label class="toggle">
                  <input type="checkbox" v-model="schedulerConfig.horizonDaily" />
                  <span class="toggle-slider"></span>
                  <span class="toggle-label">Daily</span>
                </label>
              </div>
              <div class="toggle-group" style="margin-top: 8px;">
                <label class="toggle">
                  <input type="checkbox" v-model="schedulerConfig.horizonWeekly" />
                  <span class="toggle-slider"></span>
                  <span class="toggle-label">Weekly</span>
                </label>
              </div>
            </div>

            <!-- Gateway Section -->
            <div class="automation-section gateway-section">
              <h3>Gateway</h3>
              <div class="toggle-group gateway-toggle">
                <label class="toggle">
                  <input type="checkbox" v-model="schedulerConfig.autoPushGateway" />
                  <span class="toggle-slider gateway"></span>
                  <span class="toggle-label">Auto-Push</span>
                </label>
              </div>
              <p class="hint">Push forecasts to Vantage-Gateway</p>

              <!-- Gateway Configuration -->
              <div class="gateway-config" v-if="schedulerConfig.autoPushGateway">
                <div class="form-row">
                  <div class="form-group compact">
                    <label>Host</label>
                    <input type="text" v-model="gatewayConfig.host" placeholder="100.115.9.94" style="width: 140px;" />
                  </div>
                  <div class="form-group compact">
                    <label>Port</label>
                    <input type="number" v-model="gatewayConfig.port" min="1" max="65535" style="width: 70px;" />
                  </div>
                </div>
                <div class="form-group compact">
                  <label>Username</label>
                  <input type="text" v-model="gatewayConfig.username" placeholder="vantage-upload" />
                </div>
                <div class="form-group compact">
                  <label>Password</label>
                  <input type="password" v-model="gatewayConfig.password" placeholder="Enter gateway password" />
                </div>
                <div class="gateway-actions">
                  <button
                    class="btn btn-sm"
                    @click="saveGatewayConfig"
                    :disabled="gatewayTestStatus === 'testing'"
                  >
                    Save
                  </button>
                  <button
                    class="btn btn-sm btn-secondary"
                    @click="testGatewayConnection"
                    :disabled="gatewayTestStatus === 'testing' || !gatewayConfig.password"
                  >
                    <span v-if="gatewayTestStatus === 'testing'">Testing...</span>
                    <span v-else>Test Connection</span>
                  </button>
                </div>
                <div v-if="gatewayTestMessage" class="gateway-status" :class="gatewayTestStatus">
                  {{ gatewayTestMessage }}
                </div>
              </div>
            </div>

            <!-- Weather Section -->
            <div class="automation-section">
              <h3>Weather</h3>
              <div class="form-group compact">
                <label>Max Age (hours)</label>
                <input type="number" v-model="schedulerConfig.weatherMaxAge" min="1" max="24" style="width: 80px;" />
              </div>
              <p class="hint">Reject stale weather data</p>
            </div>

            <!-- Archive Section -->
            <div class="automation-section">
              <h3>Archive</h3>
              <div class="form-group compact">
                <label>Retention (days)</label>
                <input type="number" v-model="schedulerConfig.archiveRetention" min="7" max="365" style="width: 80px;" />
              </div>
              <p class="hint">Auto-delete old records</p>
            </div>
          </div>
        </section>
      </div><!-- End Scheduler Tab -->

      <!-- ============ GATEWAY TAB ============ -->
      <div v-if="activeTab === 'gateway'" class="tab-content">
        <h1 class="page-title">Gateway Storage</h1>
        <p class="page-subtitle">Manage forecast files on the Vantage Gateway server</p>

        <!-- Action Message -->
        <div v-if="gatewayActionMessage" class="format-notification" :class="gatewayActionType">
          <span class="format-icon">{{ gatewayActionType === 'error' ? '✕' : '✓' }}</span>
          <span>{{ gatewayActionMessage }}</span>
          <button @click="gatewayActionMessage = ''" class="format-close">&times;</button>
        </div>

        <div class="gateway-layout">
          <!-- Storage Statistics Card -->
          <section class="card">
            <div class="card-header-row">
              <h2>Storage Statistics</h2>
              <button @click="loadGatewayStorageStats" class="btn btn-sm btn-secondary" :disabled="gatewayStorageLoading">
                <span v-if="gatewayStorageLoading">Loading...</span>
                <span v-else>Refresh</span>
              </button>
            </div>

            <div v-if="gatewayStorageError" class="error-message">
              {{ gatewayStorageError }}
            </div>

            <div v-else-if="gatewayStorageStats" class="storage-stats">
              <div class="stats-summary">
                <div class="stat-item">
                  <span class="stat-value">{{ gatewayStorageStats.totalFiles }}</span>
                  <span class="stat-label">Total Files</span>
                </div>
                <div class="stat-item">
                  <span class="stat-value">{{ gatewayStorageStats.totalSizeFormatted }}</span>
                  <span class="stat-label">Total Size</span>
                </div>
                <div class="stat-item">
                  <span class="stat-value">{{ gatewayStorageStats.oldestFile || 'N/A' }}</span>
                  <span class="stat-label">Oldest File</span>
                </div>
                <div class="stat-item">
                  <span class="stat-value">{{ gatewayStorageStats.newestFile || 'N/A' }}</span>
                  <span class="stat-label">Newest File</span>
                </div>
              </div>

              <div class="category-breakdown">
                <h3>By Category</h3>
                <table class="stats-table">
                  <thead>
                    <tr>
                      <th>Category</th>
                      <th>Files</th>
                      <th>Size</th>
                      <th>Date Range</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="(stats, category) in gatewayStorageStats.categories" :key="category">
                      <td>{{ category }}</td>
                      <td>{{ stats.files }}</td>
                      <td>{{ stats.sizeFormatted }}</td>
                      <td>{{ stats.oldest }} to {{ stats.newest }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>

            <div v-else class="empty-state">
              Click "Refresh" to load storage statistics
            </div>
          </section>

          <!-- Archive Files Card -->
          <section class="card">
            <h2>Archive Files</h2>
            <p class="hint">Move old forecast files to the archive folder on the gateway server.</p>

            <div class="form-row">
              <div class="form-group">
                <label>Archive files older than</label>
                <div class="input-with-suffix">
                  <input type="number" v-model="gatewayArchiveDays" min="1" max="365" style="width: 80px;" />
                  <span class="input-suffix">days</span>
                </div>
              </div>
            </div>

            <button
              @click="archiveGatewayFiles"
              class="btn btn-primary"
              :disabled="gatewayArchiveLoading"
            >
              <span v-if="gatewayArchiveLoading">Archiving...</span>
              <span v-else>Archive Old Files</span>
            </button>
          </section>

          <!-- Clear Files Card -->
          <section class="card card-danger">
            <h2>Clear Files</h2>
            <p class="hint warning">Permanently delete forecast files from the gateway server. This action cannot be undone.</p>

            <div class="form-row">
              <div class="form-group">
                <label>Delete files older than</label>
                <div class="input-with-suffix">
                  <input type="number" v-model="gatewayClearDays" min="1" max="365" style="width: 80px;" />
                  <span class="input-suffix">days</span>
                </div>
              </div>
            </div>

            <div class="form-group">
              <label class="checkbox-label danger">
                <input type="checkbox" v-model="gatewayClearConfirm" />
                <span>I understand this will permanently delete files</span>
              </label>
            </div>

            <button
              @click="clearGatewayFiles"
              class="btn btn-danger"
              :disabled="gatewayClearLoading || !gatewayClearConfirm"
            >
              <span v-if="gatewayClearLoading">Deleting...</span>
              <span v-else>Delete Old Files</span>
            </button>
          </section>
        </div>
      </div><!-- End Gateway Tab -->

      <!-- ============ SETTINGS TAB ============ -->
      <div v-if="activeTab === 'settings'" class="tab-content">
        <h1 class="page-title">Settings</h1>
        <p class="page-subtitle">Configure global database paths and auto-import settings</p>

        <div class="settings-grid">
          <!-- Database Paths Section -->
          <section class="card settings-section">
            <h2>Database Paths</h2>
            <p class="section-description">Configure database locations for demand and scheduler data</p>

            <div class="form-group">
              <label>Regional Demand Database</label>
              <p class="field-hint">Used for 3-region forecasts (CLUZ, CVIS, CMIN)</p>
              <div class="path-input-row">
                <input type="text" v-model="globalRegionalDemandDb" placeholder="data/iload.db" class="path-input" />
                <button @click="browseRegionalDb" class="btn btn-sm btn-secondary">Browse</button>
              </div>
            </div>

            <div class="form-group">
              <label>Zonal Demand Database</label>
              <p class="field-hint">Used for 14-zone forecasts (01NLUZ, 02METRO, etc.)</p>
              <div class="path-input-row">
                <input type="text" v-model="globalZonalDemandDb" placeholder="data/iload_zonal.db" class="path-input" />
                <button @click="browseZonalDb" class="btn btn-sm btn-secondary">Browse</button>
              </div>
            </div>

            <div class="form-group">
              <label>Scheduler Database</label>
              <p class="field-hint">Stores run history, calibrations, and scheduler config</p>
              <div class="path-input-row">
                <input type="text" v-model="globalSchedulerDb" placeholder="./forecast.db" class="path-input" />
                <button @click="browseSchedulerDb" class="btn btn-sm btn-secondary">Browse</button>
              </div>
            </div>
          </section>

          <!-- CSV Source Directories Section -->
          <section class="card settings-section">
            <h2>CSV Source Directories</h2>
            <p class="section-description">Default directories for training data and imports</p>

            <div class="form-group">
              <label>Demand Data Directory</label>
              <p class="field-hint">CSV files for demand training data</p>
              <div class="path-input-row">
                <input type="text" v-model="globalDemandCsvPath" placeholder="Data Samples/Demand" class="path-input" />
                <button @click="browseDemandCsvDir" class="btn btn-sm btn-secondary">Browse</button>
              </div>
            </div>

            <div class="form-group">
              <label>CFAC Data Directory</label>
              <p class="field-hint">CSV files for capacity factor training data</p>
              <div class="path-input-row">
                <input type="text" v-model="globalCfacCsvPath" placeholder="Data Samples/Capacity Factor" class="path-input" />
                <button @click="browseCfacCsvDir" class="btn btn-sm btn-secondary">Browse</button>
              </div>
            </div>

            <div class="import-actions">
              <button @click="importDemandToDb" class="btn btn-secondary" :disabled="isRunning">
                Import Demand CSV to Database
              </button>
              <button @click="importCfacToDb" class="btn btn-secondary" :disabled="isRunning">
                Import CFAC CSV to Database
              </button>
            </div>
          </section>

          <!-- Cache & Output Directories Section -->
          <section class="card settings-section">
            <h2>Cache & Output Directories</h2>
            <p class="section-description">Configure weather cache and default output locations</p>

            <div class="form-group">
              <label>Weather Cache Directory</label>
              <p class="field-hint">Cached weather data from Visual Crossing API</p>
              <div class="path-input-row">
                <input type="text" v-model="globalWeatherCacheDir" placeholder="./weather_cache" class="path-input" />
                <button @click="browseWeatherCacheDir" class="btn btn-sm btn-secondary">Browse</button>
              </div>
            </div>

            <div class="form-group">
              <label>Scheduler Output Directory</label>
              <p class="field-hint">Default output location for scheduled forecasts</p>
              <div class="path-input-row">
                <input type="text" v-model="globalSchedulerOutputDir" placeholder="./output/forecasts" class="path-input" />
                <button @click="browseSchedulerOutputDir" class="btn btn-sm btn-secondary">Browse</button>
              </div>
            </div>
          </section>

          <!-- CFAC Model Options -->
          <section class="card settings-section">
            <h2>CFAC Model Options</h2>
            <p class="section-description">Configure capacity factor forecasting models (applies to all station types)</p>

            <div class="toggle-group" v-if="globalConfig">
              <label class="toggle">
                <input type="checkbox" v-model="globalConfig.cfac.useXgboost" @change="markConfigDirty" />
                <span class="toggle-slider"></span>
                <span class="toggle-label">Use XGBoost for ML layer</span>
              </label>
              <p class="field-hint">Better for solar (non-linear patterns), neutral for wind</p>
            </div>

            <div class="toggle-group" v-if="globalConfig">
              <label class="toggle">
                <input type="checkbox" v-model="globalConfig.cfac.asymmetricLoss" @change="markConfigDirty" />
                <span class="toggle-slider"></span>
                <span class="toggle-label">Asymmetric loss (penalize under-predictions 2x)</span>
              </label>
              <p class="field-hint">Recommended for solar to reduce under-forecasting bias</p>
            </div>

            <div class="toggle-group" v-if="globalConfig">
              <label class="toggle">
                <input type="checkbox" v-model="globalConfig.cfac.biasCorrection" @change="markConfigDirty" />
                <span class="toggle-slider"></span>
                <span class="toggle-label">Station-specific bias correction</span>
              </label>
              <p class="field-hint">Learn per-station bias from training data</p>
            </div>
          </section>

          <!-- Auto-Update Settings Section -->
          <section class="card settings-section">
            <h2>Auto-Update Settings</h2>
            <p class="section-description">Configure automatic data updates before scheduler runs</p>

            <div class="toggle-group">
              <label class="toggle">
                <input type="checkbox" v-model="autoImportBeforeRun" />
                <span class="toggle-slider"></span>
                <span class="toggle-label">Auto-import new CSV data before scheduler runs</span>
              </label>
              <p class="field-hint">Check for new CSV files and import them to the database</p>
            </div>

            <div class="toggle-group">
              <label class="toggle">
                <input type="checkbox" v-model="autoFetchWeather" />
                <span class="toggle-slider"></span>
                <span class="toggle-label">Auto-fetch weather data</span>
              </label>
              <p class="field-hint">Fetch missing or stale weather data from Visual Crossing API</p>
            </div>
          </section>

          <!-- Calibration Settings Section -->
          <section class="card settings-section">
            <h2>Calibration Settings</h2>
            <p class="section-description">Configure auto-calibration behavior for forecasts</p>

            <div class="form-group">
              <label>Calibration Iterations</label>
              <p class="field-hint">Number of calibration iterations (0 = no calibration, 1-10 = iterations)</p>
              <div class="range-input-group">
                <input
                  type="range"
                  v-model.number="calibrationIterations"
                  min="0"
                  max="10"
                  step="1"
                  class="range-input"
                />
                <span class="range-value">{{ calibrationIterations === 0 ? 'Off' : calibrationIterations }}</span>
              </div>
            </div>

            <div class="form-group">
              <label>Training Days</label>
              <p class="field-hint">Number of historical days used for calibration (7-30 days)</p>
              <div class="range-input-group">
                <input
                  type="range"
                  v-model.number="schedulerCalibDays"
                  min="7"
                  max="30"
                  step="1"
                  class="range-input"
                />
                <span class="range-value">{{ schedulerCalibDays }} days</span>
              </div>
            </div>
          </section>

          <!-- Database Status Section -->
          <section class="card settings-section full-width">
            <h2>Database Status</h2>
            <div class="db-status-grid">
              <div class="db-status-card">
                <h3>Regional Demand</h3>
                <p class="db-path">{{ globalRegionalDemandDb }}</p>
                <button @click="checkRegionalDbStatus" class="btn btn-sm btn-outline">Check Status</button>
              </div>
              <div class="db-status-card">
                <h3>Zonal Demand</h3>
                <p class="db-path">{{ globalZonalDemandDb }}</p>
                <button @click="checkZonalDbStatus" class="btn btn-sm btn-outline">Check Status</button>
              </div>
              <div class="db-status-card">
                <h3>Scheduler</h3>
                <p class="db-path">{{ globalSchedulerDb }}</p>
                <button @click="checkSchedulerDbStatus" class="btn btn-sm btn-outline">Check Status</button>
              </div>
            </div>
          </section>

          <!-- Global Forecast Configuration (forecast_config.json) -->
          <section class="card settings-section full-width">
            <h2>Global Forecast Configuration</h2>
            <p class="section-description">Settings are saved to forecast_config.json and apply to all forecast operations</p>

            <div v-if="configLoading" class="config-loading">
              <span class="spinner"></span>
              Loading configuration...
            </div>

            <div v-else-if="globalConfig" class="config-editor-grid">
              <!-- Paths Section -->
              <div class="config-section">
                <h3>Paths</h3>
                <div class="form-group">
                  <label>Demand Training Path</label>
                  <input type="text" v-model="globalConfig.paths.demandTraining" @input="markConfigDirty" class="path-input" />
                </div>
                <div class="form-group">
                  <label>CFAC Training Path</label>
                  <input type="text" v-model="globalConfig.paths.cfacTraining" @input="markConfigDirty" class="path-input" />
                </div>
                <div class="form-group">
                  <label>Output Directory</label>
                  <input type="text" v-model="globalConfig.paths.output" @input="markConfigDirty" class="path-input" />
                </div>
                <div class="form-group">
                  <label>Weather Cache</label>
                  <input type="text" v-model="globalConfig.paths.weatherCache" @input="markConfigDirty" class="path-input" />
                </div>
              </div>

              <!-- Calibration Section -->
              <div class="config-section">
                <h3>Calibration</h3>
                <div class="toggle-group">
                  <label class="toggle">
                    <input type="checkbox" v-model="globalConfig.calibration.enabled" @change="markConfigDirty" />
                    <span class="toggle-slider"></span>
                    <span class="toggle-label">Enable Calibration</span>
                  </label>
                </div>
                <div class="form-group">
                  <label>Calibration Days</label>
                  <input type="number" v-model.number="globalConfig.calibration.days" @input="markConfigDirty" min="7" max="60" class="path-input" />
                </div>
                <div class="form-group">
                  <label>Threshold (%)</label>
                  <input type="number" v-model.number="globalConfig.calibration.threshold" @input="markConfigDirty" min="1" max="20" step="0.5" class="path-input" />
                </div>
                <div class="form-group">
                  <label>Max Iterations</label>
                  <input type="number" v-model.number="globalConfig.calibration.maxIterations" @input="markConfigDirty" min="1" max="10" class="path-input" />
                </div>
              </div>

              <!-- Demand Section -->
              <div class="config-section">
                <h3>Demand Options</h3>
                <div class="form-group">
                  <label>Model</label>
                  <select v-model="globalConfig.demand.model" @change="markConfigDirty" class="path-input">
                    <option value="hybrid">Hybrid (Recommended)</option>
                    <option value="regression">Regression</option>
                    <option value="xgboost">XGBoost</option>
                  </select>
                </div>
                <div class="form-group">
                  <label>Geography</label>
                  <select v-model="globalConfig.demand.geography" @change="markConfigDirty" class="path-input">
                    <option value="regional">Regional (3 regions)</option>
                    <option value="zonal">Zonal (14 zones)</option>
                    <option value="both">Both (Regional + Zonal)</option>
                  </select>
                </div>
                <div class="form-group">
                  <label>Growth Rate (%)</label>
                  <input type="number" v-model.number="globalConfig.demand.growthRate" @input="markConfigDirty" min="0" max="5" step="0.1" class="path-input" />
                </div>
              </div>

              <!-- Output Section -->
              <div class="config-section">
                <h3>Output</h3>
                <div class="toggle-group">
                  <label class="toggle">
                    <input type="checkbox" v-model="globalConfig.output.archiveEnabled" @change="markConfigDirty" />
                    <span class="toggle-slider"></span>
                    <span class="toggle-label">Archive Forecasts</span>
                  </label>
                </div>
                <div class="form-group">
                  <label>Retention Days</label>
                  <input type="number" v-model.number="globalConfig.output.retentionDays" @input="markConfigDirty" min="7" max="365" class="path-input" />
                </div>
                <div class="form-group">
                  <label>Naming Convention</label>
                  <select v-model="globalConfig.output.naming" @change="markConfigDirty" class="path-input">
                    <option value="gateway">Gateway Standard</option>
                    <option value="legacy">Legacy</option>
                  </select>
                </div>
              </div>

              <!-- Gateway Section -->
              <div class="config-section">
                <h3>Gateway</h3>
                <div class="toggle-group">
                  <label class="toggle">
                    <input type="checkbox" v-model="globalConfig.gateway.enabled" @change="markConfigDirty" />
                    <span class="toggle-slider"></span>
                    <span class="toggle-label">Enable Gateway</span>
                  </label>
                </div>
                <div class="toggle-group">
                  <label class="toggle">
                    <input type="checkbox" v-model="globalConfig.gateway.autoPush" @change="markConfigDirty" />
                    <span class="toggle-slider"></span>
                    <span class="toggle-label">Auto-push after runs</span>
                  </label>
                </div>
              </div>
            </div>

            <!-- Save/Reset Buttons -->
            <div v-if="globalConfig" class="config-actions">
              <button @click="saveGlobalConfig" class="btn btn-primary" :disabled="configSaveStatus === 'saving'">
                <span v-if="configSaveStatus === 'saving'">Saving...</span>
                <span v-else-if="configSaveStatus === 'saved'">Saved!</span>
                <span v-else>Save Configuration</span>
              </button>
              <button @click="resetGlobalConfig" class="btn btn-outline">Reset to Defaults</button>
              <span v-if="configDirty" class="config-dirty-indicator">Unsaved changes</span>
            </div>

            <div v-if="!globalConfig && !configLoading" class="config-error">
              Failed to load global config. Check console for errors.
            </div>
          </section>
        </div>
      </div><!-- End Settings Tab -->

    </main>

    <!-- Bottom Terminal Panel -->
    <div
      class="terminal-panel"
      :class="{ expanded: terminalExpanded, resizing: isResizing }"
      :style="terminalExpanded ? { height: terminalHeight + 'px' } : {}"
    >
      <!-- Resize Handle -->
      <div class="terminal-resize-handle" @mousedown="startTerminalResize">
        <div class="resize-grip"></div>
      </div>
      <div class="terminal-header">
        <!-- Generate Button (Left Side) - Manual Tab Only -->
        <button
          v-if="activeTab === 'manual'"
          @click.stop="runForecast"
          :disabled="!canRunForecast || isRunning"
          class="btn btn-primary btn-generate"
        >
          <span v-if="isRunning" class="btn-content">
            <span class="spinner"></span>
            Running...
          </span>
          <span v-else>Generate Forecast</span>
        </button>

        <!-- Terminal Toggle Area - Manual Tab -->
        <div v-if="activeTab === 'manual'" class="terminal-toggle-area" @click="terminalExpanded = !terminalExpanded">
          <span class="terminal-toggle">{{ terminalExpanded ? '▼' : '▲' }}</span>
          <span class="terminal-title">Terminal</span>
          <span v-if="isRunning" class="terminal-status running">
            <span class="status-dot"></span>
            Running...
          </span>
          <span v-else-if="isComplete" class="terminal-status complete">
            Complete
          </span>
        </div>

        <!-- Terminal Tabs - Scheduler Tab -->
        <div v-if="activeTab === 'scheduler'" class="terminal-tabs">
          <button
            class="terminal-tab"
            :class="{ active: terminalPanelTab === 'terminal' }"
            @click.stop="terminalPanelTab = 'terminal'; terminalExpanded = true"
          >
            <span class="terminal-toggle" v-if="terminalPanelTab === 'terminal'">{{ terminalExpanded ? '▼' : '▲' }}</span>
            Terminal
            <span v-if="schedulerIsRunning" class="terminal-status running">
              <span class="status-dot"></span>
            </span>
          </button>
          <button
            class="terminal-tab"
            :class="{ active: terminalPanelTab === 'runs' }"
            @click.stop="terminalPanelTab = 'runs'; terminalExpanded = true; loadRecentRuns()"
          >
            Recent Runs
            <span v-if="recentRuns.length > 0" class="runs-badge">{{ recentRuns.length }}</span>
          </button>
        </div>

        <span class="terminal-spacer"></span>

        <!-- Refresh button for Runs tab -->
        <button
          v-if="activeTab === 'scheduler' && terminalPanelTab === 'runs'"
          @click.stop="loadRecentRuns()"
          class="btn btn-text btn-sm"
        >
          Refresh
        </button>

        <!-- Clear button -->
        <button
          v-if="(activeTab === 'manual' && statusHistory.length > 0) || (activeTab === 'scheduler' && terminalPanelTab === 'terminal' && schedulerStatusHistory.length > 0)"
          @click.stop="activeTab === 'manual' ? resetProgress() : (schedulerStatusHistory = [])"
          class="btn btn-text btn-sm"
        >
          Clear
        </button>
      </div>

      <div class="terminal-content" v-if="terminalExpanded">
        <!-- Manual Forecast Progress -->
        <template v-if="activeTab === 'manual'">
          <div class="progress-section" v-if="isRunning || isComplete">
            <div class="progress-bar-container">
              <div
                class="progress-bar"
                :class="{ 'error': hasError, 'complete': isComplete && !hasError }"
                :style="{ width: progress + '%' }"
              ></div>
            </div>
            <div class="progress-text">{{ Math.round(progress) }}%</div>
          </div>

          <div class="current-status" :class="{ 'error': hasError }" v-if="currentStatus">
            <span class="status-indicator" :class="{ 'spinning': isRunning }"></span>
            {{ currentStatus }}
          </div>

          <div class="history-list" v-if="statusHistory.length > 0">
            <div
              v-for="(item, i) in statusHistory"
              :key="i"
              class="history-item"
              :class="item.type"
            >
              <span class="history-time">{{ item.time }}</span>
              <span class="history-message">{{ item.message }}</span>
            </div>
          </div>
        </template>

        <!-- Scheduler Progress (Terminal Tab) -->
        <template v-if="activeTab === 'scheduler' && terminalPanelTab === 'terminal'">
          <div class="progress-section" v-if="schedulerIsRunning || schedulerProgress > 0">
            <div class="progress-bar-container">
              <div
                class="progress-bar"
                :class="{ 'complete': !schedulerIsRunning && schedulerProgress === 100 }"
                :style="{ width: schedulerProgress + '%' }"
              ></div>
            </div>
            <div class="progress-details">
              <div class="progress-text">{{ Math.round(schedulerProgress) }}%</div>
              <div class="progress-info" v-if="schedulerProgressTotal > 0">
                <span class="progress-date" v-if="schedulerCurrentDate">Processing: {{ schedulerCurrentDate }}</span>
                <span class="progress-count">{{ schedulerProgressCurrent }}/{{ schedulerProgressTotal }} dates</span>
                <span class="progress-eta" v-if="schedulerProgressEta">ETA: {{ schedulerProgressEta }}</span>
              </div>
            </div>
          </div>

          <div class="current-status" v-if="schedulerCurrentStatus">
            <span class="status-indicator" :class="{ 'spinning': schedulerIsRunning }"></span>
            {{ schedulerCurrentStatus }}
          </div>

          <!-- Terminal Filters and Search -->
          <div class="terminal-filters">
            <div class="filter-toggles">
              <button
                class="filter-toggle"
                :class="{ active: terminalFilterError }"
                @click="terminalFilterError = !terminalFilterError"
              >
                <span class="filter-icon error">✕</span> Error
              </button>
              <button
                class="filter-toggle"
                :class="{ active: terminalFilterWarn }"
                @click="terminalFilterWarn = !terminalFilterWarn"
              >
                <span class="filter-icon warn">⚠</span> Warn
              </button>
              <button
                class="filter-toggle"
                :class="{ active: terminalFilterInfo }"
                @click="terminalFilterInfo = !terminalFilterInfo"
              >
                <span class="filter-icon info">ℹ</span> Info
              </button>
              <button
                class="filter-toggle"
                :class="{ active: terminalFilterDebug }"
                @click="terminalFilterDebug = !terminalFilterDebug"
              >
                <span class="filter-icon debug">🔍</span> Debug
              </button>
            </div>

            <div class="search-box">
              <input
                type="text"
                v-model="terminalSearchQuery"
                placeholder="Search messages..."
                class="search-input"
              />
              <button
                v-if="terminalSearchQuery"
                @click="terminalSearchQuery = ''"
                class="search-clear"
                title="Clear search"
              >
                ✕
              </button>
            </div>
          </div>

          <div class="history-list" v-if="filteredSchedulerHistory.length > 0">
            <div
              v-for="(item, i) in filteredSchedulerHistory"
              :key="i"
              class="history-item"
              :class="item.type"
            >
              <span class="history-time">{{ item.time }}</span>
              <span class="history-message" v-html="highlightMatch(item.message)"></span>
            </div>
          </div>

          <div v-if="!schedulerIsRunning && filteredSchedulerHistory.length === 0" class="terminal-empty">
            <template v-if="schedulerStatusHistory.length > 0">
              No messages match the current filters or search.
            </template>
            <template v-else>
              Ready. Configure options above and click Run Now to begin.
            </template>
          </div>
        </template>

        <!-- Recent Runs (Runs Tab) -->
        <template v-if="activeTab === 'scheduler' && terminalPanelTab === 'runs'">
          <div v-if="recentRuns.length === 0" class="terminal-empty">
            No recent runs found. Run a manual forecast to see run history.
          </div>

          <div v-else class="runs-table-container">
            <table class="runs-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Type</th>
                  <th>Horizon</th>
                  <th>Status</th>
                  <th>Records</th>
                  <th>Gateway</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="run in recentRuns" :key="run.id">
                  <td>{{ run.run_date }}</td>
                  <td>{{ run.forecast_type }}</td>
                  <td>{{ run.horizon }}</td>
                  <td>
                    <span class="status-badge" :class="run.status">
                      {{ run.status }}
                    </span>
                  </td>
                  <td class="text-right">{{ run.records_generated }}</td>
                  <td class="text-center">
                    <span v-if="run.pushed_to_gateway" class="gateway-check">✓</span>
                    <span v-else class="gateway-none">-</span>
                  </td>
                  <td class="text-muted">{{ run.created_at }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </template>

        <div v-if="activeTab === 'manual' && !isRunning && !isComplete && statusHistory.length === 0"
             class="terminal-empty">
          Ready. Configure options above and click the action button to begin.
        </div>
      </div>
    </div>

  </div>
</template>

<style scoped>
/* =====================================================
   DARK THEME WIDESCREEN LAYOUT
   ===================================================== */

/* Custom Titlebar for Electron window dragging */
.titlebar {
  grid-column: 1 / -1;
  height: 40px;
  background: #1e293b; /* Match Electron titleBarOverlay exactly */
  display: flex;
  align-items: center;
  padding-left: 12px;
}

.titlebar-drag-region {
  flex: 1;
  height: 100%;
  -webkit-app-region: drag;
  app-region: drag;
}

/* Base App Container - Full viewport grid */
.app {
  display: grid;
  grid-template-columns: 220px 1fr;
  grid-template-rows: 40px 1fr auto; /* Added titlebar row */
  min-height: 100vh;
  max-height: 100vh;
  overflow: hidden;
  background: #0f172a;
  color: #e2e8f0;
}

.app.dark-theme {
  --bg-primary: #0f172a;
  --bg-secondary: #1e293b;
  --bg-card: #1e293b;
  --bg-input: #0f172a;
  --border-color: #334155;
  --text-primary: #f1f5f9;
  --text-secondary: #94a3b8;
  --text-muted: #64748b;
  --accent-primary: #3b82f6;
  --accent-hover: #2563eb;
  --accent-success: #10b981;
  --accent-warning: #f59e0b;
  --accent-danger: #ef4444;
}

/* =====================================================
   LEFT SIDEBAR
   ===================================================== */
.sidebar {
  grid-column: 1;
  grid-row: 2 / -1; /* Start after titlebar */
  background: linear-gradient(180deg, #1e293b 0%, #0f172a 100%);
  display: flex;
  flex-direction: column;
  padding: 0;
  overflow: hidden;
}

.sidebar-header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 20px 16px;
}

.sidebar-logo {
  width: 40px;
  height: 40px;
  object-fit: contain;
}

.sidebar-title {
  display: flex;
  flex-direction: column;
}

.title-text {
  font-size: 1.25rem;
  font-weight: 700;
  color: var(--text-primary);
  letter-spacing: -0.02em;
}

.title-sub {
  font-size: 0.75rem;
  color: var(--text-muted);
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.sidebar-nav {
  flex: 1;
  padding: 16px 12px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  background: transparent;
  border: none;
  border-radius: 8px;
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.15s ease;
  text-align: left;
  width: 100%;
}

.nav-item:hover:not(:disabled) {
  background: rgba(59, 130, 246, 0.1);
  color: var(--text-primary);
}

.nav-item.active {
  background: var(--accent-primary);
  color: white;
}

.nav-item:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.nav-icon {
  width: 20px;
  height: 20px;
  flex-shrink: 0;
}

.nav-text {
  font-size: 0.875rem;
  font-weight: 500;
}

.sidebar-footer {
  padding: 8px 16px; /* Match terminal header height */
  display: flex;
  align-items: center;
  min-height: 40px; /* Same as titlebar height */
  box-sizing: border-box;
}

.version-text {
  font-size: 0.75rem;
  color: var(--text-muted);
}

/* =====================================================
   MAIN CONTENT AREA
   ===================================================== */
.main-content {
  grid-column: 2;
  grid-row: 2; /* Start after titlebar */
  background: var(--bg-primary);
  overflow-y: auto;
  overflow-x: hidden;
  padding: 24px;
}

.tab-content {
  height: 100%;
}

.content-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 20px;
  height: 100%;
}

.grid-column {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-width: 0;
}

/* =====================================================
   CARDS (Dark Theme)
   ===================================================== */
.card {
  background: var(--bg-card);
  border-radius: 12px;
  padding: 20px;
  border: 1px solid var(--border-color);
}

.card h2 {
  font-size: 0.875rem;
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 16px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.card h3 {
  font-size: 0.8rem;
  font-weight: 600;
  color: var(--text-secondary);
  margin-bottom: 4px;
}

/* =====================================================
   FORMS (Dark Theme)
   ===================================================== */
.source-toggle {
  display: flex;
  gap: 16px;
  margin-bottom: 16px;
}

.radio-label {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  color: var(--text-secondary);
  font-size: 0.875rem;
}

.radio-label input {
  width: 16px;
  height: 16px;
  accent-color: var(--accent-primary);
}

.form-group {
  margin-bottom: 14px;
}

.form-group label {
  display: block;
  font-size: 0.8rem;
  font-weight: 500;
  color: var(--text-secondary);
  margin-bottom: 6px;
}

.form-group input[type="text"],
.form-group input[type="number"],
.form-group input[type="date"] {
  width: 100%;
  padding: 10px 12px;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  font-size: 0.875rem;
  background: var(--bg-input);
  color: var(--text-primary);
}

.form-group input:focus {
  outline: none;
  border-color: var(--accent-primary);
  box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.2);
}

.form-group input:disabled {
  background: var(--bg-secondary);
  color: var(--text-muted);
  cursor: not-allowed;
}

.input-row {
  display: flex;
  gap: 8px;
}

.input-row input {
  flex: 1;
}

.output-dirs {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}

.output-dirs .form-group {
  margin-bottom: 0;
}

/* Output Naming Card */
.output-preview {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 16px;
  padding: 12px;
  background: var(--bg-primary);
  border-radius: 6px;
}

.preview-tag {
  font-size: 0.75rem;
  font-family: monospace;
  background: rgba(59, 130, 246, 0.1);
  border: 1px solid rgba(59, 130, 246, 0.2);
  padding: 4px 10px;
  border-radius: 4px;
  color: var(--accent-primary);
}

.naming-mode {
  display: flex;
  gap: 16px;
  margin-bottom: 16px;
}

.naming-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 12px;
}

.naming-grid .form-group {
  margin-bottom: 0;
}

.naming-grid input {
  font-family: monospace;
  font-size: 0.8rem;
}

.custom-name-options input {
  font-family: monospace;
}

/* Database section */
.database-section {
  margin-bottom: 16px;
}

.db-info-panel {
  margin-top: 12px;
  padding: 12px;
  background: var(--bg-primary);
  border-radius: 6px;
  border: 1px solid var(--border-color);
}

.db-info-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}

.db-info-header h3 {
  margin: 0;
  font-size: 0.85rem;
  color: var(--text-primary);
}

.db-info-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
}

.db-info-item {
  padding: 10px;
  background: var(--bg-secondary);
  border-radius: 6px;
  border: 1px solid var(--border-color);
}

.db-info-label {
  display: block;
  font-size: 0.7rem;
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  margin-bottom: 4px;
}

.db-info-value {
  display: block;
  font-size: 0.9rem;
  font-weight: 600;
  color: var(--text-primary);
}

.db-info-range {
  display: block;
  font-size: 0.65rem;
  color: var(--text-muted);
  margin-top: 4px;
}

.db-info-regions {
  display: block;
  font-size: 0.65rem;
  color: var(--accent-primary);
  font-weight: 500;
}

.db-info-empty {
  text-align: center;
  color: var(--text-muted);
  padding: 16px;
  font-size: 0.8rem;
}

.db-update-section {
  margin-top: 12px;
  border-top: 1px solid var(--border-color);
  padding-top: 12px;
}

.db-update-header {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  font-weight: 500;
  color: var(--text-secondary);
  padding: 4px 0;
  font-size: 0.85rem;
}

.db-update-header:hover {
  color: var(--accent-primary);
}

.db-update-panel {
  margin-top: 12px;
}

.db-update-row {
  display: flex;
  align-items: flex-end;
  gap: 12px;
  margin-bottom: 12px;
}

.db-update-row .form-group {
  flex: 1;
  margin-bottom: 0;
}

.db-update-row .btn {
  flex-shrink: 0;
  margin-bottom: 4px;
}

.btn-sm {
  padding: 6px 12px;
  font-size: 0.75rem;
}

.optional {
  font-weight: 400;
  color: var(--text-muted);
  font-size: 0.7rem;
}

.hint {
  font-size: 0.7rem;
  color: var(--text-muted);
  margin-top: 4px;
}

.hint-success {
  color: var(--accent-success);
}

.hint-error {
  color: var(--accent-danger);
}

.optional {
  font-size: 0.7rem;
  color: var(--text-muted);
  font-weight: normal;
}

/* Model Training Section */
.training-mode-container {
  padding: 12px;
  background: var(--bg-primary);
  border-radius: 6px;
}

.calibration-mode-row {
  display: flex;
  gap: 16px;
  margin-bottom: 12px;
}

.hint-inline {
  font-size: 0.7rem;
  color: var(--text-muted);
  margin-left: 4px;
}

.training-period-section {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--border-color);
}

.training-period-section h3 {
  font-size: 0.85rem;
  margin-bottom: 4px;
  color: var(--text-secondary);
}

.saved-model-section {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--border-color);
}

.saved-model-section h3 {
  font-size: 0.85rem;
  margin-bottom: 8px;
  color: var(--text-secondary);
}

.calibrator-dropdown-full {
  width: 100%;
  padding: 10px 12px;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  font-size: 0.8rem;
  background: var(--bg-input);
  color: var(--text-primary);
  cursor: pointer;
}

.calibrator-dropdown-full:focus {
  outline: none;
  border-color: var(--accent-primary);
  box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.2);
}

.calibrator-dropdown-full:disabled {
  background: var(--bg-secondary);
  cursor: not-allowed;
}

.save-option {
  margin-top: 12px;
}

.checkbox-label {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  font-size: 0.8rem;
  color: var(--text-secondary);
}

.checkbox-label input {
  width: 16px;
  height: 16px;
  accent-color: var(--accent-primary);
}

.date-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}

.date-section {
  padding: 12px;
  background: var(--bg-primary);
  border-radius: 6px;
}

.date-row {
  display: flex;
  gap: 12px;
  margin-top: 12px;
}

.date-row .form-group {
  flex: 1;
  margin-bottom: 0;
}

.options-grid {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  gap: 16px;
}

.options-grid-4 {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr 1fr;
  gap: 12px;
}

.toggle-group {
  padding: 12px;
  background: var(--bg-primary);
  border-radius: 6px;
}

.toggle-group.disabled {
  opacity: 0.5;
}

.model-select {
  margin-top: 8px;
  display: flex;
  align-items: center;
  gap: 8px;
}

.model-label {
  font-size: 0.7rem;
  color: var(--text-muted);
  font-weight: 500;
}

.model-dropdown {
  padding: 4px 8px;
  border: 1px solid var(--border-color);
  border-radius: 4px;
  font-size: 0.7rem;
  background: var(--bg-input);
  color: var(--text-primary);
  cursor: pointer;
}

.model-dropdown:focus {
  outline: none;
  border-color: var(--accent-primary);
  box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.2);
}

.model-dropdown:disabled {
  background: var(--bg-secondary);
  cursor: not-allowed;
}

.toggle {
  display: flex;
  align-items: center;
  gap: 10px;
  cursor: pointer;
}

.toggle input {
  display: none;
}

.toggle-slider {
  width: 40px;
  height: 22px;
  background: var(--border-color);
  border-radius: 11px;
  position: relative;
  transition: background 0.2s;
}

.toggle-slider::after {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: 18px;
  height: 18px;
  background: var(--text-secondary);
  border-radius: 50%;
  transition: transform 0.2s;
}

.toggle input:checked + .toggle-slider {
  background: var(--accent-primary);
}

.toggle input:checked + .toggle-slider::after {
  transform: translateX(18px);
  background: white;
}

/* Gateway toggle - distinctive cyan color */
.toggle input:checked + .toggle-slider.gateway {
  background: #00b4d8;
}

.gateway-toggle {
  margin-left: 8px;
  padding-left: 8px;
  border-left: 1px solid var(--border-color);
}

.gateway-section {
  min-width: 280px;
}

.gateway-config {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--border-color);
}

.gateway-config .form-row {
  display: flex;
  gap: 8px;
  margin-bottom: 8px;
}

.gateway-config .form-group {
  margin-bottom: 8px;
}

.gateway-config .form-group label {
  font-size: 0.75rem;
  color: var(--text-muted);
  margin-bottom: 4px;
  display: block;
}

.gateway-config input {
  width: 100%;
  padding: 6px 8px;
  font-size: 0.8rem;
  border: 1px solid var(--border-color);
  border-radius: 4px;
  background: var(--bg-primary);
  color: var(--text-primary);
}

.gateway-config input:focus {
  outline: none;
  border-color: var(--accent-primary);
}

.gateway-actions {
  display: flex;
  gap: 8px;
  margin-top: 12px;
}

.gateway-actions .btn-sm {
  padding: 6px 12px;
  font-size: 0.75rem;
}

.gateway-status {
  margin-top: 8px;
  padding: 6px 10px;
  border-radius: 4px;
  font-size: 0.75rem;
}

.gateway-status.success {
  background: rgba(76, 175, 80, 0.15);
  color: #4caf50;
  border: 1px solid rgba(76, 175, 80, 0.3);
}

.gateway-status.error {
  background: rgba(244, 67, 54, 0.15);
  color: #f44336;
  border: 1px solid rgba(244, 67, 54, 0.3);
}

.gateway-status.testing {
  background: rgba(33, 150, 243, 0.15);
  color: #2196f3;
  border: 1px solid rgba(33, 150, 243, 0.3);
}

/* Gateway Tab Styles */
.gateway-layout {
  display: flex;
  flex-direction: column;
  gap: 20px;
  padding: 20px;
}

.card-header-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
}

.card-header-row h2 {
  margin: 0;
}

.storage-stats {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.stats-summary {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 16px;
}

.stat-item {
  background: var(--bg-primary);
  padding: 16px;
  border-radius: 8px;
  text-align: center;
}

.stat-value {
  display: block;
  font-size: 1.5rem;
  font-weight: 600;
  color: var(--accent);
  margin-bottom: 4px;
}

.stat-label {
  font-size: 0.85rem;
  color: var(--text-secondary);
}

.category-breakdown h3 {
  margin-bottom: 12px;
  font-size: 1rem;
  color: var(--text-primary);
}

.stats-table {
  width: 100%;
  border-collapse: collapse;
}

.stats-table th,
.stats-table td {
  padding: 10px 12px;
  text-align: left;
  border-bottom: 1px solid var(--border);
}

.stats-table th {
  background: var(--bg-primary);
  font-weight: 500;
  color: var(--text-secondary);
  font-size: 0.85rem;
}

.stats-table td {
  font-size: 0.9rem;
}

.empty-state {
  padding: 40px;
  text-align: center;
  color: var(--text-secondary);
}

.error-message {
  padding: 12px;
  background: rgba(244, 67, 54, 0.1);
  border: 1px solid rgba(244, 67, 54, 0.3);
  border-radius: 6px;
  color: #f44336;
}

.input-with-suffix {
  display: flex;
  align-items: center;
  gap: 8px;
}

.input-suffix {
  color: var(--text-secondary);
  font-size: 0.9rem;
}

.card-danger {
  border: 1px solid rgba(244, 67, 54, 0.3);
}

.card-danger h2 {
  color: #f44336;
}

.hint.warning {
  color: #ff9800;
}

.checkbox-label.danger {
  color: #f44336;
}

.checkbox-label.danger input:checked + span {
  color: #f44336;
}

.btn-danger {
  background: #f44336;
  color: white;
  border: none;
}

.btn-danger:hover:not(:disabled) {
  background: #d32f2f;
}

.btn-danger:disabled {
  background: rgba(244, 67, 54, 0.5);
  cursor: not-allowed;
}

.toggle-label {
  font-weight: 500;
  font-size: 0.85rem;
  color: var(--text-secondary);
}

.scaling-group {
  padding: 12px;
  background: var(--bg-primary);
  border-radius: 6px;
}

.scaling-group label {
  font-weight: 500;
  color: var(--text-secondary);
  font-size: 0.8rem;
  margin-bottom: 8px;
  display: block;
}

.scaling-input {
  display: flex;
  align-items: center;
  gap: 4px;
}

.scaling-input input {
  width: 80px;
  padding: 8px 12px;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  font-size: 0.8rem;
  text-align: right;
  background: var(--bg-input);
  color: var(--text-primary);
}

.scaling-input .percent {
  font-weight: 500;
  color: var(--text-muted);
}

/* =====================================================
   TERMINAL PANEL (Bottom Expandable & Resizable)
   ===================================================== */
.terminal-panel {
  grid-column: 2;
  grid-row: 3; /* After titlebar and main content */
  background: var(--bg-secondary);
  border-top: 1px solid var(--border-color);
  display: flex;
  flex-direction: column;
  height: 50px;
  transition: height 0.2s ease;
  overflow: hidden;
  position: relative;
}

.terminal-panel.expanded {
  /* Height is now controlled via inline style for resizing */
  min-height: 100px;
  max-height: 600px;
}

.terminal-panel.resizing {
  transition: none; /* Disable transition during drag */
  user-select: none;
}

/* Resize Handle */
.terminal-resize-handle {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 6px;
  cursor: ns-resize;
  z-index: 10;
  display: flex;
  align-items: center;
  justify-content: center;
}

.terminal-resize-handle:hover,
.terminal-panel.resizing .terminal-resize-handle {
  background: rgba(59, 130, 246, 0.2);
}

.resize-grip {
  width: 40px;
  height: 3px;
  background: var(--border-color);
  border-radius: 2px;
  opacity: 0;
  transition: opacity 0.15s ease;
}

.terminal-resize-handle:hover .resize-grip,
.terminal-panel.resizing .resize-grip {
  opacity: 1;
  background: var(--accent-primary);
}

.terminal-header {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 8px 20px;
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border-color);
  flex-shrink: 0;
}

/* Generate Button in Terminal Bar */
.btn-generate {
  padding: 10px 24px;
  font-size: 0.875rem;
  font-weight: 600;
  min-width: 160px;
  flex-shrink: 0;
}

.btn-generate:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* Terminal Toggle Area (clickable) */
.terminal-toggle-area {
  display: flex;
  align-items: center;
  gap: 12px;
  cursor: pointer;
  padding: 8px 12px;
  border-radius: 6px;
  transition: background 0.15s ease;
}

.terminal-toggle-area:hover {
  background: rgba(59, 130, 246, 0.1);
}

.terminal-toggle {
  font-size: 0.7rem;
  color: var(--text-muted);
}

.terminal-title {
  font-size: 0.8rem;
  font-weight: 600;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.terminal-status {
  display: flex;
  align-items: center;
  gap: 16px;
}

.status-badge {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-radius: 4px;
  font-size: 0.7rem;
  font-weight: 500;
}

.status-badge.running {
  background: rgba(59, 130, 246, 0.15);
  color: var(--accent-primary);
}

.status-badge.complete {
  background: rgba(16, 185, 129, 0.15);
  color: var(--accent-success);
}

.status-badge.error {
  background: rgba(239, 68, 68, 0.15);
  color: var(--accent-danger);
}

.status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
}

.status-dot.spinning {
  animation: pulse 1s infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}

.btn-clear {
  padding: 4px 10px;
  font-size: 0.7rem;
  background: transparent;
  border: 1px solid var(--border-color);
  color: var(--text-muted);
  border-radius: 4px;
  cursor: pointer;
}

.btn-clear:hover {
  border-color: var(--text-secondary);
  color: var(--text-secondary);
}

.terminal-content {
  flex: 1;
  overflow-y: auto;
  padding: 12px 20px;
}

.terminal-progress {
  margin-bottom: 12px;
}

.progress-label {
  font-size: 0.7rem;
  color: var(--text-muted);
  margin-bottom: 6px;
}

/* Enhanced Progress Section */
.progress-section {
  margin-bottom: 16px;
  padding: 12px;
  background: var(--bg-card);
  border-radius: 8px;
  border: 1px solid var(--border-color);
}

.progress-bar-container {
  height: 8px;
  background: #0f172a;
  border-radius: 4px;
  overflow: hidden;
  margin-bottom: 8px;
}

.progress-bar {
  height: 100%;
  background: linear-gradient(90deg, #3b82f6 0%, #2563eb 100%);
  border-radius: 4px;
  transition: width 0.3s ease;
}

.progress-bar.complete {
  background: linear-gradient(90deg, #10b981 0%, #059669 100%);
}

.progress-bar.error {
  background: var(--accent-danger);
}

.progress-details {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  font-size: 13px;
}

.progress-text {
  font-weight: 600;
  color: var(--accent-primary);
  min-width: 40px;
}

.progress-info {
  display: flex;
  gap: 16px;
  color: var(--text-secondary);
  flex: 1;
}

.progress-date {
  color: var(--text-primary);
  font-weight: 500;
}

.progress-count {
  color: var(--text-secondary);
}

.progress-eta {
  color: var(--accent-warning);
  margin-left: auto;
}

.terminal-history {
  max-height: 180px;
  overflow-y: auto;
}

.history-item {
  display: flex;
  gap: 10px;
  padding: 6px 0;
  font-size: 0.75rem;
  border-bottom: 1px solid rgba(51, 65, 85, 0.5);
}

.history-item:last-child {
  border-bottom: none;
}

.history-time {
  color: var(--text-muted);
  font-family: monospace;
  font-size: 0.7rem;
  white-space: nowrap;
}

.history-message {
  color: var(--text-secondary);
  word-break: break-word;
}

.history-item.success .history-message {
  color: var(--accent-success);
}

.history-item.error .history-message {
  color: var(--accent-danger);
}

.history-item.warn .history-message {
  color: var(--accent-warning);
}

.history-item.debug .history-message {
  color: var(--text-muted);
}

/* Highlight search matches */
.history-message mark {
  background: #fbbf24;
  color: #000;
  padding: 1px 2px;
  border-radius: 2px;
}

/* Terminal Filters and Search */
.terminal-filters {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
  padding: 8px 12px;
  background: var(--bg-card);
  border-radius: 6px;
  border: 1px solid var(--border-color);
}

.filter-toggles {
  display: flex;
  gap: 8px;
}

.filter-toggle {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 12px;
  background: transparent;
  border: 1px solid var(--border-color);
  border-radius: 4px;
  color: var(--text-secondary);
  font-size: 12px;
  cursor: pointer;
  transition: all 0.2s;
}

.filter-toggle:hover {
  background: var(--bg-secondary);
}

.filter-toggle.active {
  background: var(--bg-secondary);
  border-color: var(--accent-primary);
  color: var(--text-primary);
}

.filter-icon {
  font-size: 14px;
}

.filter-icon.error { color: var(--accent-danger); }
.filter-icon.warn { color: var(--accent-warning); }
.filter-icon.info { color: var(--accent-primary); }
.filter-icon.debug { color: var(--text-muted); }

.search-box {
  display: flex;
  align-items: center;
  gap: 4px;
  position: relative;
  flex: 0 0 250px;
}

.search-input {
  flex: 1;
  padding: 6px 32px 6px 12px;
  background: var(--bg-input);
  border: 1px solid var(--border-color);
  border-radius: 4px;
  color: var(--text-primary);
  font-size: 13px;
}

.search-input:focus {
  outline: none;
  border-color: var(--accent-primary);
}

.search-clear {
  position: absolute;
  right: 8px;
  padding: 4px;
  background: transparent;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  font-size: 14px;
  line-height: 1;
}

.search-clear:hover {
  color: var(--text-primary);
}

.terminal-empty {
  color: var(--text-muted);
  font-size: 0.8rem;
  text-align: center;
  padding: 20px;
}

/* =====================================================
   ACTION BUTTONS
   ===================================================== */
.action-section {
  text-align: center;
}

.btn {
  padding: 10px 20px;
  border-radius: 6px;
  font-size: 0.8rem;
  font-weight: 500;
  cursor: pointer;
  border: none;
  transition: all 0.15s ease;
}

.btn-primary {
  background: var(--accent-primary);
  color: white;
}

.btn-primary:hover:not(:disabled) {
  background: var(--accent-hover);
}

.btn-primary:disabled {
  background: var(--border-color);
  color: var(--text-muted);
  cursor: not-allowed;
}

.btn-secondary {
  background: var(--bg-primary);
  color: var(--text-secondary);
  border: 1px solid var(--border-color);
}

.btn-secondary:hover:not(:disabled) {
  background: var(--border-color);
  color: var(--text-primary);
}

.btn-secondary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn-text {
  background: none;
  color: var(--accent-primary);
  padding: 4px 8px;
}

.btn-text:hover {
  background: rgba(59, 130, 246, 0.1);
}

.btn-large {
  padding: 12px 32px;
  font-size: 0.9rem;
}

.btn-content {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
}

.spinner {
  width: 16px;
  height: 16px;
  border: 2px solid rgba(255, 255, 255, 0.3);
  border-top-color: white;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

/* Format notification (Dark Theme) */
.format-notification {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
  border-radius: 6px;
  margin-bottom: 12px;
  font-size: 0.8rem;
  animation: slideIn 0.3s ease;
}

@keyframes slideIn {
  from {
    opacity: 0;
    transform: translateY(-10px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.format-notification.info {
  background: rgba(59, 130, 246, 0.15);
  border: 1px solid rgba(59, 130, 246, 0.3);
  color: var(--accent-primary);
}

.format-notification.warning {
  background: rgba(245, 158, 11, 0.15);
  border: 1px solid rgba(245, 158, 11, 0.3);
  color: var(--accent-warning);
}

.format-notification.error {
  background: rgba(239, 68, 68, 0.15);
  border: 1px solid rgba(239, 68, 68, 0.3);
  color: var(--accent-danger);
}

.format-icon {
  font-size: 1rem;
  flex-shrink: 0;
}

.format-close {
  margin-left: auto;
  background: none;
  border: none;
  font-size: 1.1rem;
  cursor: pointer;
  opacity: 0.6;
  padding: 0 4px;
  line-height: 1;
  color: currentColor;
}

.format-close:hover {
  opacity: 1;
}

/* Advanced Options Row (Manual Forecast Tab) */
.advanced-options-row {
  display: flex;
  align-items: center;
  gap: 16px;
  flex-wrap: wrap;
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--border-color);
}

.advanced-options-row .toggle-group {
  padding: 8px 12px;
  background: transparent;
}

.advanced-options-row .form-group.compact {
  margin-bottom: 0;
}

/* Manual Run Advanced Options (Scheduler Tab) */
.manual-run-advanced {
  display: flex;
  align-items: center;
  gap: 16px;
  flex-wrap: wrap;
  padding: 8px 0;
}

.manual-run-advanced .checkbox-label {
  white-space: nowrap;
}

.manual-run-advanced .form-group.compact.inline-suffix {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 0;
}

.manual-run-advanced .form-group.compact.inline-suffix label {
  margin-bottom: 0;
  font-size: 0.75rem;
}

/* Responsive adjustments for widescreen */
@media (max-width: 1400px) {
  .content-grid {
    grid-template-columns: 1fr 1fr;
  }
}

@media (max-width: 1000px) {
  .app {
    grid-template-columns: 180px 1fr;
  }

  .content-grid {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 768px) {
  .app {
    grid-template-columns: 1fr;
    grid-template-rows: auto 1fr auto;
  }

  .sidebar {
    grid-row: 1;
    flex-direction: row;
    padding: 8px;
    border-right: none;
    border-bottom: 1px solid var(--border-color);
  }

  .sidebar-nav {
    flex-direction: row;
    padding: 0 8px;
  }

  .nav-text {
    display: none;
  }

  .main-content {
    grid-column: 1;
    grid-row: 2;
  }

  .terminal-panel {
    grid-column: 1;
    grid-row: 3;
  }
}

/* Train button */
.btn-train {
  padding: 4px 10px;
  font-size: 0.7rem;
  background: var(--accent-success);
  color: white;
  border: none;
  border-radius: 4px;
  margin-left: 8px;
  cursor: pointer;
}

.btn-train:hover:not(:disabled) {
  background: #059669;
}

.btn-train:disabled {
  background: var(--border-color);
  cursor: not-allowed;
}

/* Modal styles (Dark Theme) */
.modal-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.7);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.modal {
  background: var(--bg-secondary);
  border-radius: 12px;
  width: 90%;
  max-width: 600px;
  max-height: 90vh;
  overflow-y: auto;
  box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.3);
  border: 1px solid var(--border-color);
}

.modal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px 20px;
  border-bottom: 1px solid var(--border-color);
}

.modal-header h2 {
  font-size: 1.1rem;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0;
}

.modal-close {
  background: none;
  border: none;
  font-size: 1.25rem;
  color: var(--text-muted);
  cursor: pointer;
  padding: 0;
  line-height: 1;
}

.modal-close:hover:not(:disabled) {
  color: var(--text-primary);
}

.modal-close:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

.modal-body {
  padding: 20px;
}

.modal-body h3 {
  font-size: 0.9rem;
  font-weight: 600;
  color: var(--text-secondary);
  margin-bottom: 4px;
  margin-top: 16px;
}

.modal-body h3:first-child {
  margin-top: 0;
}

.modal-footer {
  display: flex;
  justify-content: flex-end;
  gap: 12px;
  padding: 16px 20px;
  border-top: 1px solid var(--border-color);
  background: var(--bg-primary);
  border-radius: 0 0 12px 12px;
}

/* Training mode toggle */
.training-mode-section {
  margin-bottom: 16px;
}

.training-mode-toggle {
  display: flex;
  gap: 16px;
  padding: 12px;
  background: var(--bg-primary);
  border-radius: 6px;
}

/* Training options */
.training-options-section .date-row {
  display: flex;
  gap: 12px;
  margin-top: 12px;
  margin-bottom: 12px;
}

.training-options-section .date-row .form-group {
  flex: 1;
  margin-bottom: 0;
}

.params-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 12px;
  margin-top: 12px;
}

.params-grid .form-group {
  margin-bottom: 0;
}

/* Schedule times list */
.schedule-times-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.schedule-time-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.time-input {
  flex: 1;
  padding: 6px 8px;
  background: var(--bg-primary);
  border: 1px solid var(--border-color);
  border-radius: 4px;
  color: var(--text-primary);
  font-size: 13px;
}

.time-input:focus {
  outline: none;
  border-color: var(--accent-color);
}

.btn-icon {
  width: 24px;
  height: 24px;
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: bold;
}

.btn-danger {
  background: #dc3545;
  color: white;
  border: none;
}

.btn-danger:hover:not(:disabled) {
  background: #c82333;
}

.params-grid input {
  text-align: center;
}

/* Existing model section */
.existing-model-section {
  margin-top: 12px;
}

.model-list {
  margin-top: 12px;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  overflow: hidden;
}

.model-option {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
  cursor: pointer;
  border-bottom: 1px solid var(--border-color);
}

.model-option:last-child {
  border-bottom: none;
}

.model-option:hover {
  background: var(--bg-primary);
}

.model-option input {
  width: 16px;
  height: 16px;
  accent-color: var(--accent-primary);
}

.model-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.model-name {
  font-weight: 500;
  color: var(--text-primary);
}

.model-date {
  font-size: 0.7rem;
  color: var(--text-muted);
}

.model-mape {
  font-size: 0.7rem;
  color: var(--accent-success);
  font-weight: 500;
}

.no-models {
  padding: 20px;
  text-align: center;
  color: var(--text-muted);
  background: var(--bg-primary);
  border-radius: 6px;
  margin-top: 12px;
  font-size: 0.8rem;
}

/* Training progress */
.training-progress-section {
  margin-top: 16px;
  padding-top: 12px;
  border-top: 1px solid var(--border-color);
}

.training-status {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  background: rgba(59, 130, 246, 0.15);
  border-radius: 6px;
  color: var(--accent-primary);
  font-size: 0.8rem;
  margin-top: 8px;
}

.spinner-small {
  width: 14px;
  height: 14px;
  border: 2px solid rgba(59, 130, 246, 0.3);
  border-top-color: var(--accent-primary);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

.training-logs {
  margin-top: 12px;
  padding: 12px;
  background: var(--bg-primary);
  border-radius: 6px;
  max-height: 150px;
  overflow-y: auto;
  font-family: monospace;
  font-size: 0.7rem;
}

.log-line {
  color: var(--text-muted);
  line-height: 1.5;
}

.log-line:last-child {
  color: var(--text-primary);
}

/* Scheduler-specific styles */
.model-settings-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 12px;
}

.checkbox-options {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: center;
}

/* Additional utility classes */
.text-muted {
  color: var(--text-muted);
}

.text-primary {
  color: var(--text-primary);
}

.text-success {
  color: var(--accent-success);
}

.text-danger {
  color: var(--accent-danger);
}

/* =====================================================
   MANUAL LAYOUT - Row-based layout for Manual Forecast Tab
   ===================================================== */
.manual-layout {
  display: flex;
  flex-direction: column;
  gap: 16px;
  height: 100%;
}

.card-full-row {
  width: 100%;
}

.data-source-content {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  align-items: flex-start;
}

.data-source-content .source-toggle {
  margin-bottom: 0;
  padding: 8px 16px;
  background: var(--bg-primary);
  border-radius: 6px;
  flex-shrink: 0;
}

.data-source-inputs {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  flex: 1;
  min-width: 300px;
}

.data-source-inputs.csv-mode {
  flex: 2;
}

.data-source-inputs .form-group {
  flex: 1;
  min-width: 200px;
  margin-bottom: 0;
}

.output-dir-inputs {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  flex: 1;
  min-width: 300px;
}

.output-dir-inputs .form-group {
  flex: 1;
  min-width: 200px;
  margin-bottom: 0;
}

.db-info-inline {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: center;
  padding: 8px 12px;
  background: var(--bg-primary);
  border-radius: 6px;
  font-size: 0.75rem;
}

.db-info-inline .db-stat {
  color: var(--text-secondary);
}

.db-info-inline .db-stat::before {
  content: '';
  display: inline-block;
  width: 6px;
  height: 6px;
  background: var(--accent-primary);
  border-radius: 50%;
  margin-right: 6px;
}

/* 3-column grid for Manual Forecast tab */
.cards-grid-3 {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 16px;
  align-items: stretch; /* Equal height cards */
}

@media (max-width: 1200px) {
  .cards-grid-3 {
    grid-template-columns: repeat(2, 1fr);
  }

  .cards-grid-3 .stacked-cards {
    grid-column: span 2;
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 16px;
  }
}

@media (max-width: 800px) {
  .cards-grid-3 {
    grid-template-columns: 1fr;
    max-height: calc(100vh - 200px);
    overflow-y: auto;
  }

  .cards-grid-3 .stacked-cards {
    grid-column: span 1;
    grid-template-columns: 1fr;
  }

  .card-compact {
    height: auto; /* Natural height in single column */
  }
}

/* Stacked cards container (for Forecast Period + Model Training) */
.stacked-cards {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

/* Compact card - uniform height with equal content distribution */
.card-compact {
  display: flex;
  flex-direction: column;
  height: 100%; /* Fill grid cell height for equal sizing */
}

.card-compact > h2 {
  flex-shrink: 0; /* Keep header fixed size */
}

/* Forecast Period Row (inside Forecast Options card) */
.forecast-period-row {
  display: flex;
  gap: 12px;
  margin-bottom: 16px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--border-color);
}

.forecast-period-row .form-group {
  flex: 1;
}

/* 2x2 Options Grid for Forecast Options */
.options-grid-2x2 {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 12px;
}

.options-grid-2x2 .toggle-group {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

/* Small dropdown for inline model selection */
.model-dropdown-sm {
  width: 100%;
  padding: 6px 8px;
  border: 1px solid var(--border-color);
  border-radius: 4px;
  font-size: 0.7rem;
  background: var(--bg-input);
  color: var(--text-primary);
  cursor: pointer;
  margin-top: 8px;
}

.model-dropdown-sm:focus {
  outline: none;
  border-color: var(--accent-primary);
  box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.2);
}

.model-dropdown-sm:disabled {
  background: var(--bg-secondary);
  cursor: not-allowed;
}

/* Compact scaling group */
.scaling-group-compact {
  padding: 12px;
  background: var(--bg-primary);
  border-radius: 6px;
}

.scaling-group-compact label {
  display: block;
  font-size: 0.75rem;
  font-weight: 500;
  color: var(--text-muted);
  margin-bottom: 6px;
}

.scaling-group-compact .scaling-input {
  display: flex;
  align-items: center;
  gap: 4px;
}

.scaling-group-compact .scaling-input input {
  width: 60px;
  padding: 6px 8px;
  border: 1px solid var(--border-color);
  border-radius: 4px;
  font-size: 0.8rem;
  text-align: right;
  background: var(--bg-input);
  color: var(--text-primary);
}

.scaling-group-compact .percent {
  font-size: 0.75rem;
  font-weight: 500;
  color: var(--text-muted);
}

/* Compact form groups */
.form-group.compact {
  margin-bottom: 0;
}

.form-group.compact label {
  font-size: 0.7rem;
  margin-bottom: 4px;
}

.form-group.compact input {
  padding: 8px 10px;
  font-size: 0.8rem;
}

/* Button sizes */
.btn-xs {
  padding: 4px 8px;
  font-size: 0.65rem;
}

/* Calibrator dropdown */
.calibrator-dropdown {
  width: 100%;
  padding: 8px 10px;
  border: 1px solid var(--border-color);
  border-radius: 4px;
  font-size: 0.8rem;
  background: var(--bg-input);
  color: var(--text-primary);
  cursor: pointer;
}

.calibrator-dropdown:focus {
  outline: none;
  border-color: var(--accent-primary);
  box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.2);
}

.calibrator-dropdown:disabled {
  background: var(--bg-secondary);
  cursor: not-allowed;
}

.auto-calibration-options {
  margin-bottom: 8px;
}

.auto-calibration-options .form-group {
  margin-bottom: 8px;
}

/* =====================================================
   SETTINGS TAB
   ===================================================== */

.settings-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 20px;
}

.settings-section {
  padding: 20px;
}

.settings-section.full-width {
  grid-column: 1 / -1;
}

.settings-section h2 {
  margin: 0 0 8px 0;
  font-size: 1.1rem;
}

.settings-section .section-description {
  color: var(--text-muted);
  font-size: 0.85rem;
  margin: 0 0 12px 0;
}

.settings-section .preset-buttons {
  margin-bottom: 16px;
}

.settings-section .preset-buttons .btn {
  font-size: 0.8rem;
  padding: 6px 12px;
}

.settings-section .form-group {
  margin-bottom: 16px;
}

.settings-section .form-group label {
  display: block;
  margin-bottom: 4px;
  font-weight: 500;
}

.settings-section .field-hint {
  color: var(--text-muted);
  font-size: 0.75rem;
  margin: 4px 0 8px 0;
}

.settings-section .path-input-row {
  display: flex;
  gap: 8px;
}

.settings-section .path-input {
  flex: 1;
  padding: 8px 12px;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  background: var(--bg-primary);
  color: var(--text-primary);
  font-size: 0.9rem;
}

.settings-section .path-input:focus {
  outline: none;
  border-color: var(--accent-primary);
}

.import-actions {
  display: flex;
  gap: 12px;
  margin-top: 16px;
  padding-top: 16px;
  border-top: 1px solid var(--border-color);
}

.toggle-group {
  margin-bottom: 16px;
}

.toggle-group .field-hint {
  margin-left: 56px;
}

.range-input-group {
  display: flex;
  align-items: center;
  gap: 16px;
}

.range-input {
  flex: 1;
  height: 6px;
  -webkit-appearance: none;
  appearance: none;
  background: var(--border-color);
  border-radius: 3px;
  outline: none;
}

.range-input::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 18px;
  height: 18px;
  background: var(--accent-primary);
  border-radius: 50%;
  cursor: pointer;
  transition: transform 0.15s ease;
}

.range-input::-webkit-slider-thumb:hover {
  transform: scale(1.15);
}

.range-input::-moz-range-thumb {
  width: 18px;
  height: 18px;
  background: var(--accent-primary);
  border-radius: 50%;
  cursor: pointer;
  border: none;
}

.range-value {
  min-width: 60px;
  text-align: right;
  font-weight: 500;
  color: var(--text-primary);
}

.db-status-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 16px;
}

.db-status-card {
  background: var(--bg-primary);
  padding: 16px;
  border-radius: 8px;
  text-align: center;
}

.db-status-card h3 {
  margin: 0 0 8px 0;
  font-size: 0.95rem;
}

.db-status-card .db-path {
  color: var(--text-muted);
  font-size: 0.8rem;
  margin: 0 0 12px 0;
  word-break: break-all;
}

@media (max-width: 900px) {
  .settings-grid {
    grid-template-columns: 1fr;
  }
  .db-status-grid {
    grid-template-columns: 1fr;
  }
}

/* =====================================================
   SCHEDULER TAB - NEW LAYOUT
   ===================================================== */

/* Manual Run Card - Full Width */
.manual-run-card {
  margin-bottom: 20px;
}

.data-source-row {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-bottom: 16px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--border-color);
}

.data-source-row .source-toggle {
  display: flex;
  gap: 12px;
}

.data-source-hint {
  color: var(--text-muted);
  font-size: 0.85rem;
}

.settings-link {
  color: var(--accent-primary);
  cursor: pointer;
  text-decoration: underline;
}

.settings-link:hover {
  color: var(--accent-hover);
}

.manual-run-datasource {
  display: flex;
  gap: 20px;
  align-items: flex-end;
  margin-bottom: 16px;
  padding-bottom: 16px;
  border-bottom: 1px solid var(--border-color);
}

.manual-run-datasource .source-toggle {
  display: flex;
  gap: 16px;
}

.manual-run-datasource .database-path-group {
  flex: 1;
  max-width: 400px;
}

.manual-run-datasource .path-input-row {
  display: flex;
  gap: 8px;
}

.manual-run-datasource .path-input {
  flex: 1;
  min-width: 200px;
}

.manual-run-grid {
  display: grid;
  grid-template-columns: 1fr 1fr 1.5fr auto;
  gap: 20px;
  align-items: end;
}

.manual-run-dates,
.manual-run-options {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.manual-run-calibration {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.manual-run-actions {
  display: flex;
  align-items: center;
  gap: 16px;
  padding-bottom: 4px;
}

.manual-run-actions .btn {
  white-space: nowrap;
  min-width: 100px;
}

/* Automation Card */
.automation-card {
  padding: 20px;
}

.automation-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 20px;
}

.automation-header h2 {
  margin: 0;
}

.automation-grid {
  display: grid;
  grid-template-columns: repeat(6, 1fr);
  gap: 24px;
}

.automation-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.automation-section h3 {
  font-size: 0.75rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-muted);
  margin: 0 0 8px 0;
}

.automation-section .hint {
  font-size: 11px;
  color: var(--text-muted);
  margin-top: 4px;
}

/* Days Grid for Scheduler */
.days-grid {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}

.day-checkbox {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 4px;
  background: var(--bg-input);
  border: 1px solid var(--border-color);
  cursor: pointer;
  transition: all 0.15s ease;
}

.day-checkbox:hover {
  border-color: var(--accent-primary);
}

.day-checkbox input {
  display: none;
}

.day-checkbox input:checked + span {
  color: var(--accent-primary);
  font-weight: 600;
}

.day-checkbox span {
  font-size: 11px;
  color: var(--text-secondary);
}

/* Terminal Tabs for Scheduler */
.terminal-tabs {
  display: flex;
  gap: 4px;
}

.terminal-tab {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  background: transparent;
  border: none;
  border-radius: 6px 6px 0 0;
  color: var(--text-secondary);
  font-size: 0.8125rem;
  cursor: pointer;
  transition: all 0.15s ease;
}

.terminal-tab:hover {
  background: rgba(255, 255, 255, 0.05);
  color: var(--text-primary);
}

.terminal-tab.active {
  background: var(--bg-secondary);
  color: var(--text-primary);
}

.terminal-tab .terminal-toggle {
  font-size: 0.625rem;
  margin-right: 2px;
}

.runs-badge {
  background: var(--accent-primary);
  color: white;
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 10px;
  min-width: 18px;
  text-align: center;
}

/* Runs Table in Terminal */
.runs-table-container {
  overflow: auto;
  max-height: calc(100% - 20px);
}

.runs-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}

.runs-table thead {
  position: sticky;
  top: 0;
  background: var(--bg-secondary);
  z-index: 1;
}

.runs-table th {
  padding: 8px 12px;
  text-align: left;
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  font-size: 10px;
  letter-spacing: 0.05em;
  border-bottom: 1px solid var(--border-color);
}

.runs-table td {
  padding: 8px 12px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.05);
}

.runs-table tr:hover td {
  background: rgba(255, 255, 255, 0.02);
}

.runs-table .text-right {
  text-align: right;
}

.runs-table .text-center {
  text-align: center;
}

.runs-table .text-muted {
  color: var(--text-muted);
  font-size: 11px;
}

.status-badge {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 12px;
  font-size: 11px;
  font-weight: 500;
}

.status-badge.completed {
  background: rgba(16, 185, 129, 0.15);
  color: #10b981;
}

.status-badge.failed {
  background: rgba(239, 68, 68, 0.15);
  color: #ef4444;
}

.status-badge.pending {
  background: rgba(245, 158, 11, 0.15);
  color: #f59e0b;
}

.gateway-check {
  color: var(--gateway-color, #10b981);
}

.gateway-none {
  color: var(--text-muted);
}

/* Responsive adjustments for scheduler */
@media (max-width: 1400px) {
  .manual-run-grid {
    grid-template-columns: 1fr 1fr;
    gap: 16px;
  }

  .manual-run-actions {
    grid-column: span 2;
    justify-content: flex-end;
  }

  .automation-grid {
    grid-template-columns: repeat(3, 1fr);
    gap: 16px;
  }
}

@media (max-width: 1000px) {
  .automation-grid {
    grid-template-columns: repeat(2, 1fr);
  }
}

/* Global Config Editor */
.config-loading,
.config-error {
  padding: 24px;
  text-align: center;
  color: var(--text-muted);
}

.config-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
}

.config-error {
  color: #ef4444;
}

.config-editor {
  display: grid;
  gap: 20px;
}

.config-editor-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 24px;
  margin-bottom: 24px;
}

.config-section {
  background: var(--bg-tertiary);
  border-radius: 8px;
  padding: 16px;
}

.config-section h3 {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0 0 12px 0;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--border-color);
}

.config-dirty-indicator {
  color: var(--warning);
  font-size: 12px;
  margin-left: 12px;
}

.config-actions {
  display: flex;
  gap: 12px;
  margin-top: 12px;
  align-items: center;
}

.config-actions .btn {
  min-width: 150px;
}
</style>
