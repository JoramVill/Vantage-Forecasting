<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue';

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
const activeTab = ref<'manual' | 'scheduler'>('manual');

// Forecast options
const enableDemand = ref(true);
const enableCfac = ref(true);
const enableZonal = ref(false);
const scalingPercent = ref(100);
const cfacModel = ref<'hybrid' | 'hybrid-lstm' | 'legacy'>('hybrid'); // Hybrid (physics + ML) is the best performer
const demandModel = ref<'hybrid' | 'hybrid-calibrated'>('hybrid-calibrated'); // Hybrid + XGBoost calibration is best (4.77% MAPE)
const pushToGateway = ref(false); // Push forecasts to Vantage-Gateway server

// Scheduler state - OLD (legacy, not used by new scheduler tab)
// const schedulerMode = ref<'run' | 'backfill'>('run');
// const schedulerAsOfDate = ref('');
// const schedulerStartDate = ref('');
// const schedulerEndDate = ref('');
const schedulerDailyEnabled = ref(true);
const schedulerWeeklyEnabled = ref(true);
const schedulerDemandEnabled = ref(true);
const schedulerCfacEnabled = ref(true);
const schedulerZonalEnabled = ref(false);
const schedulerDemandPath = ref('Data Samples/Demand');
const schedulerCfacPath = ref('Data Samples/Capacity Factor');
const schedulerOutputDir = ref('output/forecasts');
const schedulerDbPath = ref('./forecast.db');
const schedulerDemandModel = ref<'hybrid' | 'regression' | 'xgboost'>('hybrid');
const schedulerUseXgboost = ref(false);
const schedulerAsymmetricLoss = ref(false);
const schedulerBiasCorrection = ref(false);
const schedulerCalibDays = ref(7);
const schedulerCalibThreshold = ref(5);
const schedulerMaxIterations = ref(3);
const schedulerIsRunning = ref(false);
const schedulerProgress = ref(0);
const schedulerStatusHistory = ref<Array<{ time: string; message: string; type: 'info' | 'success' | 'error' }>>([]);
const schedulerCurrentStatus = ref('');

// Scheduler schedule times (for automatic runs)
const schedulerTimes = ref<string[]>(['06:00']);
const schedulerAutoEnabled = ref(false);

// Scheduler output naming
const schedulerDemandPrefix = ref('FC_DEM_');
const schedulerDemandZonalPrefix = ref('FC_ZDEM_');
const schedulerCfacPrefix = ref('FC_CF_');
const schedulerOutputSuffix = ref('');

// Scheduler training mode
const schedulerTrainingMode = ref<'auto' | 'saved'>('auto'); // auto = train on-the-fly, saved = use pre-trained model
const schedulerSelectedCalibrator = ref<string>('');

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
}

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
  weatherMaxAge: 6,
  autoPushGateway: false,
  archiveRetention: 90
});
const recentRuns = ref<ForecastRun[]>([]);
const manualRunDate = ref('');
const manualRunType = ref<'both' | 'demand' | 'cfac'>('both');
const manualRunHorizon = ref<'both' | 'daily' | 'weekly'>('both');

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
    enableZonal: enableZonal.value,
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
    schedulerZonalEnabled: schedulerZonalEnabled.value,
    schedulerDemandPath: schedulerDemandPath.value,
    schedulerCfacPath: schedulerCfacPath.value,
    schedulerOutputDir: schedulerOutputDir.value,
    schedulerDbPath: schedulerDbPath.value,
    schedulerDemandModel: schedulerDemandModel.value,
    schedulerUseXgboost: schedulerUseXgboost.value,
    schedulerAsymmetricLoss: schedulerAsymmetricLoss.value,
    schedulerBiasCorrection: schedulerBiasCorrection.value,
    schedulerCalibDays: schedulerCalibDays.value,
    schedulerCalibThreshold: schedulerCalibThreshold.value,
    schedulerMaxIterations: schedulerMaxIterations.value,
    // New scheduler settings
    schedulerTimes: [...schedulerTimes.value],
    schedulerAutoEnabled: schedulerAutoEnabled.value,
    schedulerDemandPrefix: schedulerDemandPrefix.value,
    schedulerDemandZonalPrefix: schedulerDemandZonalPrefix.value,
    schedulerCfacPrefix: schedulerCfacPrefix.value,
    schedulerOutputSuffix: schedulerOutputSuffix.value,
    schedulerTrainingMode: schedulerTrainingMode.value,
    schedulerSelectedCalibrator: schedulerSelectedCalibrator.value,
  });
}

// Watch for settings changes and persist them (schedulerMode removed - legacy)
watch([dataSource, databasePath, demandDataDir, cfacDataDir, weatherDataDir, demandOutputDir, cfacOutputDir, enableDemand, enableCfac, enableZonal, scalingPercent, cfacModel, demandModel, pushToGateway, calibrationMode, selectedCalibrator, saveCalibrator, demandPrefix, demandZonalPrefix, cfacPrefix, outputSuffix, useCustomName, customDemandName, customCfacName, activeTab, schedulerDailyEnabled, schedulerWeeklyEnabled, schedulerDemandEnabled, schedulerCfacEnabled, schedulerZonalEnabled, schedulerDemandPath, schedulerCfacPath, schedulerOutputDir, schedulerDbPath, schedulerDemandModel, schedulerUseXgboost, schedulerAsymmetricLoss, schedulerBiasCorrection, schedulerCalibDays, schedulerCalibThreshold, schedulerMaxIterations], () => {
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
    if (typeof settings.enableZonal === 'boolean') enableZonal.value = settings.enableZonal;
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
    if (settings.activeTab === 'manual' || settings.activeTab === 'scheduler') activeTab.value = settings.activeTab;
    // Scheduler settings (schedulerMode removed - legacy)
    // if (settings.schedulerMode === 'run' || settings.schedulerMode === 'backfill') schedulerMode.value = settings.schedulerMode;
    if (typeof settings.schedulerDailyEnabled === 'boolean') schedulerDailyEnabled.value = settings.schedulerDailyEnabled;
    if (typeof settings.schedulerWeeklyEnabled === 'boolean') schedulerWeeklyEnabled.value = settings.schedulerWeeklyEnabled;
    if (typeof settings.schedulerDemandEnabled === 'boolean') schedulerDemandEnabled.value = settings.schedulerDemandEnabled;
    if (typeof settings.schedulerCfacEnabled === 'boolean') schedulerCfacEnabled.value = settings.schedulerCfacEnabled;
    if (typeof settings.schedulerZonalEnabled === 'boolean') schedulerZonalEnabled.value = settings.schedulerZonalEnabled;
    if (settings.schedulerDemandPath) schedulerDemandPath.value = settings.schedulerDemandPath;
    if (settings.schedulerCfacPath) schedulerCfacPath.value = settings.schedulerCfacPath;
    if (settings.schedulerOutputDir) schedulerOutputDir.value = settings.schedulerOutputDir;
    if (settings.schedulerDbPath) schedulerDbPath.value = settings.schedulerDbPath;
    if (settings.schedulerDemandModel) schedulerDemandModel.value = settings.schedulerDemandModel;
    if (typeof settings.schedulerUseXgboost === 'boolean') schedulerUseXgboost.value = settings.schedulerUseXgboost;
    if (typeof settings.schedulerAsymmetricLoss === 'boolean') schedulerAsymmetricLoss.value = settings.schedulerAsymmetricLoss;
    if (typeof settings.schedulerBiasCorrection === 'boolean') schedulerBiasCorrection.value = settings.schedulerBiasCorrection;
    if (typeof settings.schedulerCalibDays === 'number') schedulerCalibDays.value = settings.schedulerCalibDays;
    if (typeof settings.schedulerCalibThreshold === 'number') schedulerCalibThreshold.value = settings.schedulerCalibThreshold;
    if (typeof settings.schedulerMaxIterations === 'number') schedulerMaxIterations.value = settings.schedulerMaxIterations;
    // New scheduler settings
    if (Array.isArray(settings.schedulerTimes) && settings.schedulerTimes.length > 0) schedulerTimes.value = settings.schedulerTimes;
    if (typeof settings.schedulerAutoEnabled === 'boolean') schedulerAutoEnabled.value = settings.schedulerAutoEnabled;
    if (settings.schedulerDemandPrefix) schedulerDemandPrefix.value = settings.schedulerDemandPrefix;
    if (settings.schedulerDemandZonalPrefix) schedulerDemandZonalPrefix.value = settings.schedulerDemandZonalPrefix;
    if (settings.schedulerCfacPrefix) schedulerCfacPrefix.value = settings.schedulerCfacPrefix;
    if (settings.schedulerOutputSuffix) schedulerOutputSuffix.value = settings.schedulerOutputSuffix;
    if (settings.schedulerTrainingMode === 'auto' || settings.schedulerTrainingMode === 'saved') schedulerTrainingMode.value = settings.schedulerTrainingMode;
    if (settings.schedulerSelectedCalibrator) schedulerSelectedCalibrator.value = settings.schedulerSelectedCalibrator;

    // Load database info if in database mode
    if (dataSource.value === 'database' && databasePath.value) {
      loadDatabaseInfo();
    }
  } catch (e) {
    console.error('Failed to load settings:', e);
  }

  // Load available calibrator models
  loadCalibratorModels();

  // Load scheduler configuration and recent runs
  loadSchedulerConfig();
  loadRecentRuns();

  // Set up real-time output listener
  window.electronAPI.onCommandOutput((data) => {
    parseOutput(data.data, data.type === 'stderr');
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
        // Legacy model - use cfac forecast2 with XGBoost
        cfacArgs = [
          'cfac', 'forecast2',
          '-t', cfacDataDir.value,
          '-s', forecastStart.value,
          '-e', forecastEnd.value,
          '-o', `${cfacOutputDir.value}/${cfacFilename}`,
          '--use-xgboost',
          '--asymmetric-loss',
          '--bias-correction',
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
function addSchedulerStatus(message: string, type: 'info' | 'success' | 'error' = 'info') {
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
    const config = await window.electronAPI.loadSchedulerConfig();
    if (config) {
      schedulerConfig.value = config;
    }
  } catch (error: any) {
    console.error('Failed to load scheduler config:', error);
  }
}

async function saveSchedulerConfig() {
  try {
    await window.electronAPI.saveSchedulerConfig(schedulerConfig.value);
    addSchedulerStatus('Configuration saved', 'success');
  } catch (error: any) {
    addSchedulerStatus('Failed to save configuration: ' + error.message, 'error');
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

async function runSchedulerManual() {
  if (!manualRunDate.value) {
    addSchedulerStatus('Please select a date', 'error');
    return;
  }

  schedulerIsRunning.value = true;
  try {
    await window.electronAPI.runSchedulerManual(
      manualRunDate.value,
      manualRunType.value,
      manualRunHorizon.value
    );
    addSchedulerStatus('Manual run completed', 'success');
    await loadRecentRuns();
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
                <div class="scaling-group-compact">
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
            </section>
          </div>
        </div>

      </div><!-- End Manual Forecast Tab -->

      <!-- ============ SCHEDULER TAB ============ -->
      <div v-if="activeTab === 'scheduler'" class="tab-content">
        <h1 class="page-title">Scheduler Configuration</h1>
        <p class="page-subtitle">Configure automated forecast scheduling and view run history</p>
        <!-- Main Grid Layout for Scheduler Tab -->
        <div class="content-grid">
          <!-- Left Column -->
          <div class="grid-column">
            <!-- Configuration Section -->
            <section class="card">
              <h2>Automated Schedule</h2>
              <div class="toggle-group" style="margin-bottom: 12px;">
                <label class="toggle">
                  <input type="checkbox" v-model="schedulerConfig.enabled" />
                  <span class="toggle-slider"></span>
                  <span class="toggle-label">Enable Scheduler</span>
                </label>
              </div>

              <div class="form-group compact">
                <label>Morning Run Time</label>
                <input type="time" v-model="schedulerConfig.runTimeMorning" />
              </div>

              <div class="toggle-group" style="margin-top: 12px; margin-bottom: 8px;">
                <label class="toggle">
                  <input type="checkbox" v-model="schedulerConfig.secondRunEnabled" />
                  <span class="toggle-slider"></span>
                  <span class="toggle-label">Enable Evening Run</span>
                </label>
              </div>

              <div v-if="schedulerConfig.secondRunEnabled" class="form-group compact">
                <label>Evening Run Time</label>
                <input type="time" v-model="schedulerConfig.runTimeEvening" />
              </div>

              <div class="form-group compact" style="margin-top: 12px;">
                <label>Run Days</label>
                <div class="checkbox-options" style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px;">
                  <label class="checkbox-label" v-for="day in ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']" :key="day">
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
                    <span>{{ day }}</span>
                  </label>
                </div>
              </div>
            </section>

            <!-- Weather Settings -->
            <section class="card">
              <h2>Weather Settings</h2>
              <div class="form-group compact">
                <label>Max Weather Age (hours)</label>
                <input type="number" v-model="schedulerConfig.weatherMaxAge" min="1" max="24" />
              </div>
              <p class="hint">Reject weather data older than this many hours</p>
            </section>

            <!-- Manual Run Section -->
            <section class="card">
              <h2>Manual Run</h2>
              <div class="form-group compact">
                <label>Date</label>
                <input type="date" v-model="manualRunDate" />
              </div>
              <div class="form-group compact">
                <label>Type</label>
                <select v-model="manualRunType" class="calibrator-dropdown">
                  <option value="both">Both</option>
                  <option value="demand">Demand Only</option>
                  <option value="cfac">CFAC Only</option>
                </select>
              </div>
              <div class="form-group compact">
                <label>Horizon</label>
                <select v-model="manualRunHorizon" class="calibrator-dropdown">
                  <option value="both">Both</option>
                  <option value="daily">Daily Only</option>
                  <option value="weekly">Weekly Only</option>
                </select>
              </div>
              <button @click="runSchedulerManual" class="btn btn-primary" style="width: 100%; margin-top: 8px;">
                Run Now
              </button>
            </section>
          </div>

          <!-- Center Column -->
          <div class="grid-column">
            <!-- Forecast Types Configuration -->
            <section class="card">
              <h2>Forecast Types</h2>
              <div class="options-grid-2x2">
                <div class="toggle-group">
                  <label class="toggle">
                    <input type="checkbox" v-model="schedulerConfig.forecastDemand" />
                    <span class="toggle-slider"></span>
                    <span class="toggle-label">Demand</span>
                  </label>
                </div>
                <div class="toggle-group">
                  <label class="toggle">
                    <input type="checkbox" v-model="schedulerConfig.forecastCfac" />
                    <span class="toggle-slider"></span>
                    <span class="toggle-label">CFAC</span>
                  </label>
                </div>
              </div>
            </section>

            <!-- Horizons Configuration -->
            <section class="card">
              <h2>Horizons</h2>
              <div class="options-grid-2x2">
                <div class="toggle-group">
                  <label class="toggle">
                    <input type="checkbox" v-model="schedulerConfig.horizonDaily" />
                    <span class="toggle-slider"></span>
                    <span class="toggle-label">Daily</span>
                  </label>
                </div>
                <div class="toggle-group">
                  <label class="toggle">
                    <input type="checkbox" v-model="schedulerConfig.horizonWeekly" />
                    <span class="toggle-slider"></span>
                    <span class="toggle-label">Weekly</span>
                  </label>
                </div>
              </div>
            </section>

            <!-- Gateway Settings -->
            <section class="card">
              <h2>Gateway Integration</h2>
              <div class="toggle-group gateway-toggle">
                <label class="toggle">
                  <input type="checkbox" v-model="schedulerConfig.autoPushGateway" />
                  <span class="toggle-slider gateway"></span>
                  <span class="toggle-label">Auto-Push to Gateway</span>
                </label>
              </div>
              <p class="hint">Automatically push forecasts to Vantage-Gateway server</p>
            </section>

            <!-- Save Configuration Button -->
            <button @click="saveSchedulerConfig" class="btn btn-primary" style="width: 100%;">
              Save Configuration
            </button>
          </div>

          <!-- Right Column -->
          <div class="grid-column">
            <!-- Archive Settings -->
            <section class="card">
              <h2>Archive Settings</h2>
              <div class="form-group compact">
                <label>Retention Days</label>
                <input type="number" v-model="schedulerConfig.archiveRetention" min="7" max="365" />
              </div>
              <p class="hint">Delete forecast records older than this many days</p>
            </section>

            <!-- Recent Runs -->
            <section class="card" style="grid-row: span 2;">
              <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
                <h2 style="margin: 0;">Recent Runs</h2>
                <button @click="loadRecentRuns()" class="btn btn-text btn-sm">Refresh</button>
              </div>

              <div v-if="recentRuns.length === 0" class="hint" style="text-align: center; padding: 20px;">
                No recent runs found
              </div>

              <div v-else style="overflow-x: auto; max-height: 400px; overflow-y: auto;">
                <table class="runs-table" style="width: 100%; font-size: 12px;">
                  <thead style="position: sticky; top: 0; background: var(--bg-primary); z-index: 1;">
                    <tr>
                      <th style="padding: 8px; text-align: left; border-bottom: 1px solid var(--border-color);">Date</th>
                      <th style="padding: 8px; text-align: left; border-bottom: 1px solid var(--border-color);">Type</th>
                      <th style="padding: 8px; text-align: left; border-bottom: 1px solid var(--border-color);">Horizon</th>
                      <th style="padding: 8px; text-align: center; border-bottom: 1px solid var(--border-color);">Status</th>
                      <th style="padding: 8px; text-align: right; border-bottom: 1px solid var(--border-color);">Records</th>
                      <th style="padding: 8px; text-align: center; border-bottom: 1px solid var(--border-color);">Gateway</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="run in recentRuns" :key="run.id" style="border-bottom: 1px solid var(--border-color-light);">
                      <td style="padding: 6px 8px;">{{ run.run_date }}</td>
                      <td style="padding: 6px 8px;">{{ run.forecast_type }}</td>
                      <td style="padding: 6px 8px;">{{ run.horizon }}</td>
                      <td style="padding: 6px 8px; text-align: center;">
                        <span :style="{
                          padding: '2px 8px',
                          borderRadius: '12px',
                          fontSize: '11px',
                          backgroundColor: run.status === 'completed' ? 'var(--success-bg)' : run.status === 'failed' ? 'var(--error-bg)' : 'var(--warning-bg)',
                          color: run.status === 'completed' ? 'var(--success-color)' : run.status === 'failed' ? 'var(--error-color)' : 'var(--warning-color)'
                        }">
                          {{ run.status }}
                        </span>
                      </td>
                      <td style="padding: 6px 8px; text-align: right;">{{ run.records_generated }}</td>
                      <td style="padding: 6px 8px; text-align: center;">
                        <span v-if="run.pushed_to_gateway" style="color: var(--gateway-color);">✓</span>
                        <span v-else style="color: var(--text-muted);">-</span>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </section>

          </div>
        </div>
      </div><!-- End Scheduler Tab -->

    </main>

    <!-- Bottom Terminal Panel -->
    <div class="terminal-panel" :class="{ expanded: terminalExpanded }">
      <div class="terminal-header">
        <!-- Generate Button (Left Side) -->
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

        <!-- Terminal Toggle Area -->
        <div class="terminal-toggle-area" @click="terminalExpanded = !terminalExpanded">
          <span class="terminal-toggle">{{ terminalExpanded ? '▼' : '▲' }}</span>
          <span class="terminal-title">Terminal</span>
          <span v-if="isRunning || schedulerIsRunning" class="terminal-status running">
            <span class="status-dot"></span>
            Running...
          </span>
          <span v-else-if="(activeTab === 'manual' && isComplete) || (activeTab === 'scheduler' && schedulerStatusHistory.length > 0)" class="terminal-status complete">
            Complete
          </span>
        </div>

        <span class="terminal-spacer"></span>
        <button
          v-if="(activeTab === 'manual' && statusHistory.length > 0) || (activeTab === 'scheduler' && schedulerStatusHistory.length > 0)"
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

        <!-- Scheduler Progress -->
        <template v-if="activeTab === 'scheduler'">
          <div class="progress-section" v-if="schedulerIsRunning || schedulerProgress > 0">
            <div class="progress-bar-container">
              <div
                class="progress-bar"
                :class="{ 'complete': !schedulerIsRunning && schedulerProgress === 100 }"
                :style="{ width: schedulerProgress + '%' }"
              ></div>
            </div>
            <div class="progress-text">{{ Math.round(schedulerProgress) }}%</div>
          </div>

          <div class="current-status" v-if="schedulerCurrentStatus">
            <span class="status-indicator" :class="{ 'spinning': schedulerIsRunning }"></span>
            {{ schedulerCurrentStatus }}
          </div>

          <div class="history-list" v-if="schedulerStatusHistory.length > 0">
            <div
              v-for="(item, i) in schedulerStatusHistory"
              :key="i"
              class="history-item"
              :class="item.type"
            >
              <span class="history-time">{{ item.time }}</span>
              <span class="history-message">{{ item.message }}</span>
            </div>
          </div>
        </template>

        <div v-if="(activeTab === 'manual' && !isRunning && !isComplete && statusHistory.length === 0) ||
                   (activeTab === 'scheduler' && !schedulerIsRunning && schedulerStatusHistory.length === 0)"
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

/* Base App Container - Full viewport grid */
.app {
  display: grid;
  grid-template-columns: 220px 1fr;
  grid-template-rows: 1fr auto;
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
  grid-row: 1 / -1;
  background: linear-gradient(180deg, #1e293b 0%, #0f172a 100%);
  border-right: 1px solid var(--border-color);
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
  border-bottom: 1px solid var(--border-color);
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
  padding: 16px;
  border-top: 1px solid var(--border-color);
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
  grid-row: 1;
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
   TERMINAL PANEL (Bottom Expandable)
   ===================================================== */
.terminal-panel {
  grid-column: 2;
  grid-row: 2;
  background: var(--bg-secondary);
  border-top: 1px solid var(--border-color);
  display: flex;
  flex-direction: column;
  max-height: 50px;
  transition: max-height 0.3s ease;
  overflow: hidden;
}

.terminal-panel.expanded {
  max-height: 300px;
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

.progress-bar-container {
  height: 6px;
  background: var(--bg-primary);
  border-radius: 3px;
  overflow: hidden;
}

.progress-bar {
  height: 100%;
  background: var(--accent-primary);
  border-radius: 3px;
  transition: width 0.3s ease;
}

.progress-bar.complete {
  background: var(--accent-success);
}

.progress-bar.error {
  background: var(--accent-danger);
}

.progress-text {
  text-align: right;
  font-size: 0.65rem;
  color: var(--text-muted);
  margin-top: 4px;
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
</style>
