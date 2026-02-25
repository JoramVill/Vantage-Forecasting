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

// Weather directory validation
const weatherDirStatus = ref<{ valid: boolean; message: string } | null>(null);

// Database info
const databaseInfo = ref<{
  demand?: { records: number; range?: string | { start: string; end: string } | null } | null;
  cfac?: { records: number; range?: string | null } | null;
  weather?: { records: number; range?: string | null } | null;
} | null>(null);
const isLoadingDbInfo = ref(false);
const isImporting = ref(false);
const showDbUpdatePanel = ref(false);

// Date ranges
const trainingStart = ref('');
const trainingEnd = ref('');
const forecastStart = ref('');
const forecastEnd = ref('');

// Forecast options
const enableDemand = ref(true);
const enableCfac = ref(true);
const enableZonal = ref(false);
const scalingPercent = ref(100);
const cfacModel = ref<'hybrid' | 'hybrid-lstm' | 'legacy'>('hybrid'); // Hybrid (physics + ML) is the best performer

// Output naming settings
const demandPrefix = ref('FC_DEM_');
const demandZonalPrefix = ref('FC_ZDEM_');
const cfacPrefix = ref('FC_CF_');
const outputSuffix = ref('');
const useCustomName = ref(false);
const customDemandName = ref('');
const customCfacName = ref('');
const showNamingOptions = ref(false);

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
const showHistory = ref(false);

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
    // Output naming
    demandPrefix: demandPrefix.value,
    demandZonalPrefix: demandZonalPrefix.value,
    cfacPrefix: cfacPrefix.value,
    outputSuffix: outputSuffix.value,
    useCustomName: useCustomName.value,
    customDemandName: customDemandName.value,
    customCfacName: customCfacName.value,
  });
}

// Watch for settings changes and persist them
watch([dataSource, databasePath, demandDataDir, cfacDataDir, weatherDataDir, demandOutputDir, cfacOutputDir, enableDemand, enableCfac, enableZonal, scalingPercent, cfacModel, demandPrefix, demandZonalPrefix, cfacPrefix, outputSuffix, useCustomName, customDemandName, customCfacName], () => {
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
    if (typeof settings.scalingPercent === 'number') scalingPercent.value = settings.scalingPercent;
    if (settings.cfacModel === 'hybrid' || settings.cfacModel === 'hybrid-lstm' || settings.cfacModel === 'legacy') cfacModel.value = settings.cfacModel;
    // Migration: convert old 'lstm' setting to 'hybrid'
    if (settings.cfacModel === 'lstm') cfacModel.value = 'hybrid';
    // Output naming
    if (settings.demandPrefix) demandPrefix.value = settings.demandPrefix;
    if (settings.demandZonalPrefix) demandZonalPrefix.value = settings.demandZonalPrefix;
    if (settings.cfacPrefix) cfacPrefix.value = settings.cfacPrefix;
    if (settings.outputSuffix !== undefined) outputSuffix.value = settings.outputSuffix;
    if (typeof settings.useCustomName === 'boolean') useCustomName.value = settings.useCustomName;
    if (settings.customDemandName) customDemandName.value = settings.customDemandName;
    if (settings.customCfacName) customCfacName.value = settings.customCfacName;

    // Load database info if in database mode
    if (dataSource.value === 'database' && databasePath.value) {
      loadDatabaseInfo();
    }
  } catch (e) {
    console.error('Failed to load settings:', e);
  }

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

async function browseWeatherDir() {
  const path = await window.electronAPI.selectDirectory();
  if (path) {
    weatherDataDir.value = path;
    // Validate weather directory structure
    const result = await window.electronAPI.checkWeatherDirectory(path);
    weatherDirStatus.value = result;
    if (!result.valid) {
      dataFormatMessage.value = result.message;
      dataFormatType.value = 'warning';
      setTimeout(clearFormatMessage, 5000);
    }
  }
}

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

async function importData(dataType: 'demand' | 'cfac' | 'weather') {
  let sourcePath = '';
  if (dataType === 'demand') sourcePath = demandDataDir.value;
  else if (dataType === 'cfac') sourcePath = cfacDataDir.value;
  else if (dataType === 'weather') sourcePath = weatherDataDir.value;

  if (!sourcePath || !databasePath.value) {
    dataFormatMessage.value = `Please select a ${dataType} data directory first`;
    dataFormatType.value = 'warning';
    setTimeout(clearFormatMessage, 5000);
    return;
  }

  isImporting.value = true;
  addStatus(`Importing ${dataType} data...`);

  try {
    const result = await window.electronAPI.importToDatabase({
      dbPath: databasePath.value,
      dataType,
      sourcePath
    });

    if (result.success) {
      addStatus(`${dataType} import completed`, 'success');
      // Refresh database info
      await loadDatabaseInfo();
    } else {
      addStatus(`${dataType} import failed: ${result.message}`, 'error');
    }
  } catch (e: any) {
    addStatus(`${dataType} import error: ${e.message}`, 'error');
  } finally {
    isImporting.value = false;
  }
}

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

      // Add zonal flag if enabled
      if (enableZonal.value) {
        demandArgs.push('--zonal');
      }

      if (dataSource.value === 'csv' && trainingStart.value && trainingEnd.value) {
        demandArgs.push('--training-start', trainingStart.value);
        demandArgs.push('--training-end', trainingEnd.value);
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
          '-t', dataSource.value === 'database' ? databasePath.value : cfacDataDir.value,
          '-s', forecastStart.value,
          '-e', forecastEnd.value,
          '-o', `${cfacOutputDir.value}/${cfacFilename}`,
        ];

        // Add LSTM correction flag if selected
        if (cfacModel.value === 'hybrid-lstm') {
          cfacArgs.push('--lstm-correction');
        }

        if (dataSource.value === 'csv' && trainingEnd.value) {
          cfacArgs.push('--training-end', trainingEnd.value);
        }

        cfacResult = await window.electronAPI.runCommand(cfacArgs);
      } else {
        // Legacy model - use cfac forecast2 with XGBoost
        cfacArgs = [
          'cfac', 'forecast2',
          '-t', dataSource.value === 'database' ? databasePath.value : cfacDataDir.value,
          '-s', forecastStart.value,
          '-e', forecastEnd.value,
          '-o', `${cfacOutputDir.value}/${cfacFilename}`,
          '--use-xgboost',
          '--asymmetric-loss',
          '--bias-correction',
        ];

        if (dataSource.value === 'csv' && trainingEnd.value) {
          cfacArgs.push('--training-end', trainingEnd.value);
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
  <div class="app">
    <header class="header">
      <div class="header-content">
        <img src="../assets/VANTAGE_LOGO-removebg-preview.png" alt="Vantage Logo" class="header-logo" />
        <div class="header-text">
          <h1>Vantage Forecaster</h1>
          <p class="subtitle">Demand & Capacity Factor Forecasting</p>
        </div>
      </div>
    </header>

    <main class="main">
      <!-- Data Format Notification -->
      <div v-if="dataFormatMessage" class="format-notification" :class="dataFormatType">
        <span class="format-icon">{{ dataFormatType === 'error' ? '✕' : dataFormatType === 'warning' ? '⚠' : 'ℹ' }}</span>
        <span>{{ dataFormatMessage }}</span>
        <button @click="clearFormatMessage" class="format-close">&times;</button>
      </div>

      <!-- Data Source Section -->
      <section class="card">
        <h2>Data Source</h2>
        <div class="source-toggle">
          <label class="radio-label">
            <input type="radio" v-model="dataSource" value="csv" :disabled="isRunning" />
            <span>CSV Directory</span>
          </label>
          <label class="radio-label">
            <input type="radio" v-model="dataSource" value="database" :disabled="isRunning" />
            <span>Database</span>
          </label>
        </div>

        <div v-if="dataSource === 'database'" class="database-section">
          <div class="form-group">
            <label>Database Path</label>
            <div class="input-row">
              <input type="text" v-model="databasePath" placeholder="Select database file..." readonly />
              <button @click="browseDatabase" class="btn btn-secondary" :disabled="isRunning">Browse</button>
            </div>
          </div>

          <!-- Database Info Panel -->
          <div v-if="databasePath" class="db-info-panel">
            <div class="db-info-header">
              <h3>Database Contents</h3>
              <button @click="loadDatabaseInfo" class="btn btn-text" :disabled="isLoadingDbInfo">
                {{ isLoadingDbInfo ? 'Loading...' : 'Refresh' }}
              </button>
            </div>

            <div v-if="databaseInfo" class="db-info-grid">
              <div class="db-info-item">
                <span class="db-info-label">Demand</span>
                <span class="db-info-value">
                  {{ databaseInfo.demand?.records?.toLocaleString() || 0 }} records
                </span>
                <span v-if="databaseInfo.demand?.range" class="db-info-range">
                  {{ typeof databaseInfo.demand.range === 'string' ? databaseInfo.demand.range : `${databaseInfo.demand.range.start} to ${databaseInfo.demand.range.end}` }}
                </span>
                <span v-if="databaseInfo.demand?.regions?.length" class="db-info-regions">
                  {{ databaseInfo.demand.regions.length }} {{ databaseInfo.demand.regions.length === 3 ? 'regions' : 'zones' }}
                </span>
              </div>
              <div class="db-info-item">
                <span class="db-info-label">CFAC</span>
                <span class="db-info-value">
                  {{ databaseInfo.cfac?.records?.toLocaleString() || 0 }} records
                </span>
                <span v-if="databaseInfo.cfac?.range" class="db-info-range">{{ databaseInfo.cfac.range }}</span>
              </div>
              <div class="db-info-item">
                <span class="db-info-label">Weather</span>
                <span class="db-info-value">
                  {{ databaseInfo.weather?.records?.toLocaleString() || 0 }} records
                </span>
                <span v-if="databaseInfo.weather?.range" class="db-info-range">{{ databaseInfo.weather.range }}</span>
              </div>
            </div>

            <div v-else-if="!isLoadingDbInfo" class="db-info-empty">
              No database info available. Click Refresh to load.
            </div>

            <!-- Update Database Panel -->
            <div class="db-update-section">
              <div class="db-update-header" @click="showDbUpdatePanel = !showDbUpdatePanel">
                <span class="naming-toggle">{{ showDbUpdatePanel ? '▼' : '▶' }}</span>
                <span>Update Database</span>
              </div>

              <div v-if="showDbUpdatePanel" class="db-update-panel">
                <p class="hint">Import new data from directories into the database</p>

                <div class="db-update-row">
                  <div class="form-group">
                    <label>Demand Data Directory</label>
                    <div class="input-row">
                      <input type="text" v-model="demandDataDir" placeholder="Select demand data folder..." readonly />
                      <button @click="browseDemandDir" class="btn btn-secondary btn-sm" :disabled="isImporting">Browse</button>
                    </div>
                  </div>
                  <button @click="importData('demand')" class="btn btn-primary btn-sm" :disabled="isImporting || !demandDataDir">
                    Import
                  </button>
                </div>

                <div class="db-update-row">
                  <div class="form-group">
                    <label>CFAC Data Directory</label>
                    <div class="input-row">
                      <input type="text" v-model="cfacDataDir" placeholder="Select CFAC data folder..." readonly />
                      <button @click="browseCfacDir" class="btn btn-secondary btn-sm" :disabled="isImporting">Browse</button>
                    </div>
                  </div>
                  <button @click="importData('cfac')" class="btn btn-primary btn-sm" :disabled="isImporting || !cfacDataDir">
                    Import
                  </button>
                </div>

                <div class="db-update-row">
                  <div class="form-group">
                    <label>Weather Cache Directory <span class="optional">(default: ./weather_cache)</span></label>
                    <div class="input-row">
                      <input type="text" v-model="weatherDataDir" placeholder="Default: ./weather_cache" readonly />
                      <button @click="browseWeatherDir" class="btn btn-secondary btn-sm" :disabled="isImporting">Browse</button>
                    </div>
                    <p v-if="weatherDirStatus" class="hint" :class="{ 'hint-error': !weatherDirStatus.valid, 'hint-success': weatherDirStatus.valid }">
                      {{ weatherDirStatus.message }}
                    </p>
                  </div>
                  <button @click="importData('weather')" class="btn btn-primary btn-sm" :disabled="isImporting || !weatherDataDir || !weatherDirStatus?.valid">
                    Import
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div v-else class="csv-inputs">
          <div class="form-group" v-if="enableDemand">
            <label>Demand Data Directory</label>
            <div class="input-row">
              <input type="text" v-model="demandDataDir" placeholder="Select demand data folder..." readonly />
              <button @click="browseDemandDir" class="btn btn-secondary" :disabled="isRunning">Browse</button>
            </div>
          </div>
          <div class="form-group" v-if="enableCfac">
            <label>CFAC Data Directory</label>
            <div class="input-row">
              <input type="text" v-model="cfacDataDir" placeholder="Select capacity factor data folder..." readonly />
              <button @click="browseCfacDir" class="btn btn-secondary" :disabled="isRunning">Browse</button>
            </div>
          </div>
          <div class="form-group">
            <label>Weather Cache Directory <span class="optional">(auto-created by CLI)</span></label>
            <div class="input-row">
              <input type="text" v-model="weatherDataDir" placeholder="Default: ./weather_cache" readonly />
              <button @click="browseWeatherDir" class="btn btn-secondary" :disabled="isRunning">Browse</button>
            </div>
            <p v-if="weatherDirStatus" class="hint" :class="{ 'hint-success': weatherDirStatus.valid, 'hint-error': !weatherDirStatus.valid }">
              {{ weatherDirStatus.message }}
            </p>
            <p v-else class="hint">Weather data is auto-fetched from Visual Crossing API and cached here</p>
          </div>
        </div>

        <div class="output-dirs">
          <div class="form-group" v-if="enableDemand">
            <label>Demand Output Directory</label>
            <div class="input-row">
              <input type="text" v-model="demandOutputDir" placeholder="Demand output folder..." :disabled="isRunning" />
              <button @click="browseDemandOutputDir" class="btn btn-secondary" :disabled="isRunning">Browse</button>
            </div>
          </div>
          <div class="form-group" v-if="enableCfac">
            <label>CFAC Output Directory</label>
            <div class="input-row">
              <input type="text" v-model="cfacOutputDir" placeholder="CFAC output folder..." :disabled="isRunning" />
              <button @click="browseCfacOutputDir" class="btn btn-secondary" :disabled="isRunning">Browse</button>
            </div>
          </div>
        </div>

        <!-- Output Naming -->
        <div class="naming-section">
          <div class="naming-header" @click="showNamingOptions = !showNamingOptions">
            <span class="naming-toggle">{{ showNamingOptions ? '▼' : '▶' }}</span>
            <span>Output Naming</span>
            <span class="naming-preview">
              <span v-if="enableDemand" class="preview-tag">{{ demandFilenamePreview }}</span>
              <span v-if="enableCfac" class="preview-tag">{{ cfacFilenamePreview }}</span>
            </span>
          </div>

          <div v-if="showNamingOptions" class="naming-options">
            <div class="naming-mode">
              <label class="radio-label">
                <input type="radio" :value="false" v-model="useCustomName" :disabled="isRunning" />
                <span>Use prefix/suffix</span>
              </label>
              <label class="radio-label">
                <input type="radio" :value="true" v-model="useCustomName" :disabled="isRunning" />
                <span>Custom filenames</span>
              </label>
            </div>

            <div v-if="!useCustomName" class="prefix-suffix-options">
              <div class="naming-grid">
                <div class="form-group" v-if="enableDemand">
                  <label>Demand Prefix</label>
                  <input type="text" v-model="demandPrefix" placeholder="FC_DEM_" :disabled="isRunning" />
                </div>
                <div class="form-group" v-if="enableDemand && enableZonal">
                  <label>Zonal Demand Prefix</label>
                  <input type="text" v-model="demandZonalPrefix" placeholder="FC_ZDEM_" :disabled="isRunning" />
                </div>
                <div class="form-group" v-if="enableCfac">
                  <label>CFAC Prefix</label>
                  <input type="text" v-model="cfacPrefix" placeholder="FC_CF_" :disabled="isRunning" />
                </div>
                <div class="form-group">
                  <label>Suffix (optional)</label>
                  <input type="text" v-model="outputSuffix" placeholder="_v2" :disabled="isRunning" />
                </div>
              </div>
              <p class="hint">Format: [prefix][date][suffix].csv</p>
            </div>

            <div v-else class="custom-name-options">
              <div class="form-group" v-if="enableDemand">
                <label>Demand Filename</label>
                <input type="text" v-model="customDemandName" placeholder="my_demand_forecast.csv" :disabled="isRunning" />
              </div>
              <div class="form-group" v-if="enableCfac">
                <label>CFAC Filename</label>
                <input type="text" v-model="customCfacName" placeholder="my_cfac_forecast.csv" :disabled="isRunning" />
              </div>
            </div>
          </div>
        </div>
      </section>

      <!-- Date Ranges Section -->
      <section class="card">
        <h2>Date Ranges</h2>
        <div class="date-grid">
          <div class="date-section">
            <h3>Training Period</h3>
            <p class="hint">Historical data used for model calibration</p>
            <div class="date-row">
              <div class="form-group">
                <label>Start</label>
                <input type="date" v-model="trainingStart" :disabled="isRunning" />
              </div>
              <div class="form-group">
                <label>End</label>
                <input type="date" v-model="trainingEnd" :disabled="isRunning" />
              </div>
            </div>
          </div>
          <div class="date-section">
            <h3>Forecast Period</h3>
            <p class="hint">Dates to generate predictions for</p>
            <div class="date-row">
              <div class="form-group">
                <label>Start</label>
                <input type="date" v-model="forecastStart" :disabled="isRunning" />
              </div>
              <div class="form-group">
                <label>End</label>
                <input type="date" v-model="forecastEnd" :disabled="isRunning" />
              </div>
            </div>
          </div>
        </div>
      </section>

      <!-- Forecast Options Section -->
      <section class="card">
        <h2>Forecast Options</h2>
        <div class="options-grid-4">
          <div class="toggle-group">
            <label class="toggle">
              <input type="checkbox" v-model="enableDemand" :disabled="isRunning" />
              <span class="toggle-slider"></span>
              <span class="toggle-label">Demand Forecast</span>
            </label>
            <p class="hint">Regional electricity demand</p>
          </div>
          <div class="toggle-group">
            <label class="toggle">
              <input type="checkbox" v-model="enableCfac" :disabled="isRunning" />
              <span class="toggle-slider"></span>
              <span class="toggle-label">Capacity Factor</span>
            </label>
            <p class="hint">Solar, wind, hydro output</p>
            <div v-if="enableCfac" class="model-select">
              <label class="model-label">Model:</label>
              <select v-model="cfacModel" :disabled="isRunning" class="model-dropdown">
                <option value="hybrid">Hybrid (Default)</option>
                <option value="hybrid-lstm">Hybrid + LSTM Correction</option>
                <option value="legacy">Legacy XGBoost</option>
              </select>
            </div>
          </div>
          <div class="toggle-group" :class="{ 'disabled': !enableDemand }">
            <label class="toggle">
              <input type="checkbox" v-model="enableZonal" :disabled="isRunning || !enableDemand" />
              <span class="toggle-slider"></span>
              <span class="toggle-label">Zonal Mode</span>
            </label>
            <p class="hint">14 sub-regions instead of 3</p>
          </div>
          <div class="scaling-group">
            <label>Scaling Factor</label>
            <div class="scaling-input">
              <input type="number" v-model="scalingPercent" min="1" max="200" :disabled="isRunning" />
              <span class="percent">%</span>
            </div>
            <p class="hint">Apply to demand (100% = none)</p>
          </div>
        </div>
      </section>

      <!-- Progress Section -->
      <section class="card progress-card" v-if="isRunning || isComplete">
        <div class="progress-header">
          <h2>Progress</h2>
          <button
            v-if="statusHistory.length > 0"
            @click="showHistory = !showHistory"
            class="btn btn-text"
          >
            {{ showHistory ? 'Hide History' : 'View History' }}
          </button>
        </div>

        <!-- Progress Bar -->
        <div class="progress-bar-container">
          <div
            class="progress-bar"
            :class="{ 'error': hasError, 'complete': isComplete && !hasError }"
            :style="{ width: progress + '%' }"
          ></div>
        </div>
        <div class="progress-text">{{ Math.round(progress) }}%</div>

        <!-- Current Status -->
        <div class="current-status" :class="{ 'error': hasError }">
          <span class="status-indicator" :class="{ 'spinning': isRunning }"></span>
          {{ currentStatus }}
        </div>

        <!-- Status History Modal -->
        <div class="history-panel" v-if="showHistory">
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

        <!-- Reset button when complete -->
        <button
          v-if="isComplete"
          @click="resetProgress"
          class="btn btn-secondary btn-reset"
        >
          Clear
        </button>
      </section>

      <!-- Action Section -->
      <section class="action-section">
        <button
          @click="runForecast"
          :disabled="!canRunForecast || isRunning"
          class="btn btn-primary btn-large"
        >
          <span v-if="isRunning" class="btn-content">
            <span class="spinner"></span>
            Running...
          </span>
          <span v-else>Generate Forecast</span>
        </button>
      </section>
    </main>
  </div>
</template>

<style scoped>
.app {
  min-height: 100vh;
  background: #f8fafc;
}

.header {
  background: linear-gradient(135deg, #1e293b 0%, #334155 100%);
  color: white;
  padding: 24px 32px;
}

.header-content {
  display: flex;
  align-items: center;
  gap: 16px;
}

.header-logo {
  height: 48px;
  width: auto;
}

.header-text {
  display: flex;
  flex-direction: column;
}

.header h1 {
  font-size: 1.5rem;
  font-weight: 600;
  margin: 0;
}

.header .subtitle {
  font-size: 0.875rem;
  color: #94a3b8;
  margin-top: 4px;
}

.main {
  max-width: 900px;
  margin: 0 auto;
  padding: 24px;
}

.card {
  background: white;
  border-radius: 12px;
  padding: 24px;
  margin-bottom: 24px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
}

.card h2 {
  font-size: 1.1rem;
  font-weight: 600;
  color: #1e293b;
  margin-bottom: 16px;
}

.card h3 {
  font-size: 0.95rem;
  font-weight: 600;
  color: #334155;
  margin-bottom: 4px;
}

.source-toggle {
  display: flex;
  gap: 24px;
  margin-bottom: 16px;
}

.radio-label {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
}

.radio-label input {
  width: 18px;
  height: 18px;
  accent-color: #3b82f6;
}

.form-group {
  margin-bottom: 16px;
}

.form-group label {
  display: block;
  font-size: 0.875rem;
  font-weight: 500;
  color: #334155;
  margin-bottom: 6px;
}

.form-group input[type="text"],
.form-group input[type="number"],
.form-group input[type="date"] {
  width: 100%;
  padding: 10px 12px;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  font-size: 0.875rem;
}

.form-group input:focus {
  outline: none;
  border-color: #3b82f6;
  box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.1);
}

.form-group input:disabled {
  background: #f1f5f9;
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
  gap: 16px;
}

.output-dirs .form-group {
  margin-bottom: 0;
}

/* Naming section */
.naming-section {
  margin-top: 16px;
  border-top: 1px solid #e2e8f0;
  padding-top: 16px;
}

.naming-header {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  font-weight: 500;
  color: #334155;
  padding: 8px 0;
}

.naming-header:hover {
  color: #3b82f6;
}

.naming-toggle {
  font-size: 0.75rem;
  color: #64748b;
}

.naming-preview {
  margin-left: auto;
  display: flex;
  gap: 8px;
}

.preview-tag {
  font-size: 0.75rem;
  font-family: monospace;
  background: #f1f5f9;
  padding: 2px 8px;
  border-radius: 4px;
  color: #64748b;
}

.naming-options {
  padding: 16px;
  background: #f8fafc;
  border-radius: 8px;
  margin-top: 8px;
}

.naming-mode {
  display: flex;
  gap: 24px;
  margin-bottom: 16px;
}

.naming-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 12px;
}

.naming-grid .form-group {
  margin-bottom: 0;
}

.naming-grid input {
  font-family: monospace;
  font-size: 0.875rem;
}

.custom-name-options .form-group {
  margin-bottom: 12px;
}

.custom-name-options .form-group:last-child {
  margin-bottom: 0;
}

.custom-name-options input {
  font-family: monospace;
}

/* Database section */
.database-section {
  margin-bottom: 16px;
}

.db-info-panel {
  margin-top: 16px;
  padding: 16px;
  background: #f8fafc;
  border-radius: 8px;
  border: 1px solid #e2e8f0;
}

.db-info-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}

.db-info-header h3 {
  margin: 0;
  font-size: 0.9rem;
}

.db-info-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 12px;
}

.db-info-item {
  padding: 12px;
  background: white;
  border-radius: 6px;
  border: 1px solid #e2e8f0;
}

.db-info-label {
  display: block;
  font-size: 0.75rem;
  font-weight: 600;
  color: #64748b;
  text-transform: uppercase;
  margin-bottom: 4px;
}

.db-info-value {
  display: block;
  font-size: 1rem;
  font-weight: 600;
  color: #1e293b;
}

.db-info-range {
  display: block;
  font-size: 0.7rem;
  color: #94a3b8;
  margin-top: 4px;
}

.db-info-regions {
  display: block;
  font-size: 0.7rem;
  color: #3b82f6;
  font-weight: 500;
}

.db-info-empty {
  text-align: center;
  color: #94a3b8;
  padding: 16px;
  font-size: 0.875rem;
}

.db-update-section {
  margin-top: 16px;
  border-top: 1px solid #e2e8f0;
  padding-top: 12px;
}

.db-update-header {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  font-weight: 500;
  color: #334155;
  padding: 4px 0;
}

.db-update-header:hover {
  color: #3b82f6;
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
  font-size: 0.8rem;
}

.optional {
  font-weight: 400;
  color: #94a3b8;
  font-size: 0.75rem;
}

.hint {
  font-size: 0.75rem;
  color: #64748b;
  margin-top: 4px;
}

.hint-success {
  color: #16a34a;
}

.hint-error {
  color: #dc2626;
}

.date-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 24px;
}

.date-section {
  padding: 16px;
  background: #f8fafc;
  border-radius: 8px;
}

.date-row {
  display: flex;
  gap: 16px;
  margin-top: 12px;
}

.date-row .form-group {
  flex: 1;
  margin-bottom: 0;
}

.options-grid {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  gap: 24px;
}

.options-grid-4 {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr 1fr;
  gap: 16px;
}

.toggle-group {
  padding: 16px;
  background: #f8fafc;
  border-radius: 8px;
}

.toggle-group.disabled {
  opacity: 0.5;
}

.model-select {
  margin-top: 12px;
  display: flex;
  align-items: center;
  gap: 8px;
}

.model-label {
  font-size: 0.75rem;
  color: #64748b;
  font-weight: 500;
}

.model-dropdown {
  padding: 4px 8px;
  border: 1px solid #e2e8f0;
  border-radius: 6px;
  font-size: 0.75rem;
  background: white;
  color: #334155;
  cursor: pointer;
}

.model-dropdown:focus {
  outline: none;
  border-color: #3b82f6;
  box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.1);
}

.model-dropdown:disabled {
  background: #f1f5f9;
  cursor: not-allowed;
}

.toggle {
  display: flex;
  align-items: center;
  gap: 12px;
  cursor: pointer;
}

.toggle input {
  display: none;
}

.toggle-slider {
  width: 44px;
  height: 24px;
  background: #cbd5e1;
  border-radius: 12px;
  position: relative;
  transition: background 0.2s;
}

.toggle-slider::after {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: 20px;
  height: 20px;
  background: white;
  border-radius: 50%;
  transition: transform 0.2s;
}

.toggle input:checked + .toggle-slider {
  background: #3b82f6;
}

.toggle input:checked + .toggle-slider::after {
  transform: translateX(20px);
}

.toggle-label {
  font-weight: 500;
  color: #334155;
}

.scaling-group {
  padding: 16px;
  background: #f8fafc;
  border-radius: 8px;
}

.scaling-group label {
  font-weight: 500;
  color: #334155;
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
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  font-size: 0.875rem;
  text-align: right;
}

.scaling-input .percent {
  font-weight: 500;
  color: #64748b;
}

/* Progress Section */
.progress-card {
  border: 2px solid #e2e8f0;
}

.progress-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
}

.progress-header h2 {
  margin-bottom: 0;
}

.progress-bar-container {
  height: 8px;
  background: #e2e8f0;
  border-radius: 4px;
  overflow: hidden;
}

.progress-bar {
  height: 100%;
  background: #3b82f6;
  border-radius: 4px;
  transition: width 0.3s ease;
}

.progress-bar.complete {
  background: #22c55e;
}

.progress-bar.error {
  background: #ef4444;
}

.progress-text {
  text-align: right;
  font-size: 0.75rem;
  color: #64748b;
  margin-top: 4px;
}

.current-status {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 16px;
  padding: 12px 16px;
  background: #f0f9ff;
  border-radius: 8px;
  font-size: 0.875rem;
  color: #0369a1;
}

.current-status.error {
  background: #fef2f2;
  color: #dc2626;
}

.status-indicator {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #3b82f6;
}

.status-indicator.spinning {
  animation: pulse 1s infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}

.history-panel {
  margin-top: 16px;
  max-height: 200px;
  overflow-y: auto;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
}

.history-item {
  display: flex;
  gap: 12px;
  padding: 8px 12px;
  font-size: 0.8rem;
  border-bottom: 1px solid #f1f5f9;
}

.history-item:last-child {
  border-bottom: none;
}

.history-item.success {
  background: #f0fdf4;
}

.history-item.error {
  background: #fef2f2;
}

.history-time {
  color: #64748b;
  font-family: monospace;
  white-space: nowrap;
}

.history-message {
  color: #334155;
}

.history-item.success .history-message {
  color: #16a34a;
}

.history-item.error .history-message {
  color: #dc2626;
}

.btn-reset {
  margin-top: 16px;
}

.action-section {
  text-align: center;
  margin-bottom: 24px;
}

.btn {
  padding: 10px 20px;
  border-radius: 8px;
  font-size: 0.875rem;
  font-weight: 500;
  cursor: pointer;
  border: none;
  transition: all 0.2s;
}

.btn-primary {
  background: #3b82f6;
  color: white;
}

.btn-primary:hover:not(:disabled) {
  background: #2563eb;
}

.btn-primary:disabled {
  background: #94a3b8;
  cursor: not-allowed;
}

.btn-secondary {
  background: #e2e8f0;
  color: #334155;
}

.btn-secondary:hover:not(:disabled) {
  background: #cbd5e1;
}

.btn-secondary:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.btn-text {
  background: none;
  color: #3b82f6;
  padding: 4px 8px;
}

.btn-text:hover {
  background: #f0f9ff;
}

.btn-large {
  padding: 14px 48px;
  font-size: 1rem;
}

.btn-content {
  display: flex;
  align-items: center;
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

/* Format notification */
.format-notification {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  border-radius: 8px;
  margin-bottom: 16px;
  font-size: 0.875rem;
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
  background: #f0f9ff;
  border: 1px solid #bae6fd;
  color: #0369a1;
}

.format-notification.warning {
  background: #fffbeb;
  border: 1px solid #fde68a;
  color: #92400e;
}

.format-notification.error {
  background: #fef2f2;
  border: 1px solid #fecaca;
  color: #dc2626;
}

.format-icon {
  font-size: 1rem;
  flex-shrink: 0;
}

.format-close {
  margin-left: auto;
  background: none;
  border: none;
  font-size: 1.25rem;
  cursor: pointer;
  opacity: 0.6;
  padding: 0 4px;
  line-height: 1;
}

.format-close:hover {
  opacity: 1;
}

@media (max-width: 768px) {
  .date-grid,
  .options-grid,
  .options-grid-4,
  .output-dirs {
    grid-template-columns: 1fr;
  }
}
</style>
