# GUI Scheduler Tab Implementation Plan

## Overview

Add a new "Scheduler" tab to the GUI that enables users to:
1. Configure automated scheduled forecasts (day-ahead and week-ahead)
2. Run historical backfill to generate past forecasts
3. View scheduler status and history
4. Configure all the same options as the main forecast tab

## Current Architecture

### Existing Components
- **GUI**: Vue 3 single-page app (`gui/src/App.vue`) - 2200+ lines
- **Electron Main**: IPC handlers (`gui/electron/main.ts`) - 586 lines
- **Scheduler Service**: `src/services/forecastSchedulerService.ts` - Full calibration + forecast automation
- **CLI Commands**: `scheduler run|backfill|status|history|service`

### Existing CLI Scheduler Flags
```bash
scheduler run:
  -d, --date <date>           # As-of date (default: today)
  --daily                     # Daily forecasts only
  --weekly                    # Weekly forecasts only
  --demand-only               # Demand forecasts only
  --cfac-only                 # CFAC forecasts only
  --demand-path <path>        # Demand training data path
  --cfac-path <path>          # CFAC training data path
  --output <dir>              # Output directory
  --db <path>                 # Scheduler database path
  --calib-days <days>         # Calibration window (default: 7)
  --calib-threshold <percent> # Max deviation threshold (default: 5%)
  --max-iterations <n>        # Max calibration iterations (default: 3)
  --demand-model <type>       # hybrid|regression|xgboost
  --use-xgboost               # Use XGBoost for CFAC
  --asymmetric-loss           # Penalize under-predictions 2x
  --bias-correction           # Apply station-specific bias

scheduler backfill:
  -s, --start <date>          # Start date (required)
  -e, --end <date>            # End date (required)
  # + all flags from scheduler run
```

---

## Implementation Plan

### Phase 1: GUI Structure Changes

#### 1.1 Convert Single-Page to Tabbed Layout
- Add tab navigation component at top of main content
- Two tabs: **"Manual Forecast"** (existing) and **"Scheduler"** (new)
- Use Vue reactive state to switch between tabs
- Persist selected tab in settings

**Files to modify:**
- `gui/src/App.vue` - Add tab navigation, refactor into sections

#### 1.2 Create Scheduler Tab UI Section
Add new section that appears when Scheduler tab is selected:

```
┌─────────────────────────────────────────────────────────────────┐
│  [Manual Forecast]  [Scheduler]                                  │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌─ Mode Selection ────────────────────────────────────────────┐│
│  │  ○ Run Now (single date)    ○ Backfill (date range)        ││
│  └──────────────────────────────────────────────────────────────┘│
│                                                                  │
│  ┌─ Date Configuration ────────────────────────────────────────┐│
│  │  As-Of Date: [2026-02-26]                                    ││
│  │  -- OR for Backfill --                                       ││
│  │  Start: [2026-01-01]    End: [2026-02-26]                   ││
│  └──────────────────────────────────────────────────────────────┘│
│                                                                  │
│  ┌─ Forecast Types ────────────────────────────────────────────┐│
│  │  [✓] Day-Ahead Forecasts    [✓] Week-Ahead Forecasts       ││
│  │  [✓] Demand                 [✓] Capacity Factor             ││
│  │  [✓] Zonal Mode (14 zones)                                  ││
│  └──────────────────────────────────────────────────────────────┘│
│                                                                  │
│  ┌─ Data Sources ──────────────────────────────────────────────┐│
│  │  Demand Data: [Data Samples/Demand        ] [Browse]        ││
│  │  CFAC Data:   [Data Samples/Capacity Factor] [Browse]       ││
│  │  Output Dir:  [output/forecasts           ] [Browse]        ││
│  └──────────────────────────────────────────────────────────────┘│
│                                                                  │
│  ┌─ Model Settings ────────────────────────────────────────────┐│
│  │  Demand Model: [Hybrid + Calibration ▼]                     ││
│  │  CFAC Model:   [Hybrid (Default) ▼]                         ││
│  │  [✓] Use XGBoost  [✓] Asymmetric Loss  [✓] Bias Correction  ││
│  └──────────────────────────────────────────────────────────────┘│
│                                                                  │
│  ┌─ Calibration Settings ──────────────────────────────────────┐│
│  │  Calibration Days: [7]   Threshold: [5]%   Iterations: [3]  ││
│  └──────────────────────────────────────────────────────────────┘│
│                                                                  │
│  [ ▶ Run Scheduler ]                                            │
│                                                                  │
│  ┌─ Status & History ──────────────────────────────────────────┐│
│  │  [View History]                                              ││
│  │  Latest runs...                                              ││
│  └──────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
```

---

### Phase 2: State Management

#### 2.1 Add Scheduler State Variables
```typescript
// Tab state
const activeTab = ref<'manual' | 'scheduler'>('manual');

// Scheduler mode
const schedulerMode = ref<'run' | 'backfill'>('run');

// Scheduler dates
const schedulerAsOfDate = ref('');      // For "run" mode
const schedulerStartDate = ref('');      // For "backfill" mode
const schedulerEndDate = ref('');        // For "backfill" mode

// Forecast type options
const schedulerDailyEnabled = ref(true);
const schedulerWeeklyEnabled = ref(true);
const schedulerDemandEnabled = ref(true);
const schedulerCfacEnabled = ref(true);
const schedulerZonalEnabled = ref(false);

// Data paths
const schedulerDemandPath = ref('Data Samples/Demand');
const schedulerCfacPath = ref('Data Samples/Capacity Factor');
const schedulerOutputDir = ref('output/forecasts');
const schedulerDbPath = ref('./forecast.db');

// Model settings
const schedulerDemandModel = ref<'hybrid' | 'regression' | 'xgboost'>('hybrid');
const schedulerUseXgboost = ref(false);
const schedulerAsymmetricLoss = ref(false);
const schedulerBiasCorrection = ref(false);

// Calibration settings
const schedulerCalibDays = ref(7);
const schedulerCalibThreshold = ref(5);
const schedulerMaxIterations = ref(3);

// Status
const schedulerIsRunning = ref(false);
const schedulerProgress = ref(0);
const schedulerHistory = ref<SchedulerRun[]>([]);
```

#### 2.2 Persist Settings
Add scheduler settings to `saveSettings()` and `loadSettings()` functions.

---

### Phase 3: Electron IPC Handlers

#### 3.1 Add New IPC Handlers in `main.ts`

```typescript
// Run scheduler command
ipcMain.handle('run-scheduler', async (_event, options: SchedulerOptions) => {
  // Build args based on options
  const args = ['scheduler', options.mode === 'run' ? 'run' : 'backfill'];

  if (options.mode === 'run') {
    args.push('-d', options.asOfDate);
  } else {
    args.push('-s', options.startDate, '-e', options.endDate);
  }

  // Add flags...
  if (options.dailyOnly) args.push('--daily');
  if (options.weeklyOnly) args.push('--weekly');
  if (options.demandOnly) args.push('--demand-only');
  if (options.cfacOnly) args.push('--cfac-only');
  // ... etc

  // Execute with real-time output streaming
  return spawnCommand(args);
});

// Get scheduler history
ipcMain.handle('get-scheduler-history', async (_event, dbPath: string, limit: number) => {
  // Query forecast.db for recent runs
  const db = new Database(dbPath);
  const runs = db.prepare(`
    SELECT * FROM forecast_runs
    ORDER BY created_at DESC
    LIMIT ?
  `).all(limit);
  db.close();
  return runs;
});

// Get calibration history
ipcMain.handle('get-calibration-history', async (_event, dbPath: string, limit: number) => {
  const db = new Database(dbPath);
  const calibrations = db.prepare(`
    SELECT * FROM calibration_history
    ORDER BY created_at DESC
    LIMIT ?
  `).all(limit);
  db.close();
  return calibrations;
});
```

#### 3.2 Update Preload Script
Add new API methods to `preload.ts`:

```typescript
contextBridge.exposeInMainWorld('electronAPI', {
  // ... existing methods ...

  // Scheduler methods
  runScheduler: (options: SchedulerOptions) => ipcRenderer.invoke('run-scheduler', options),
  getSchedulerHistory: (dbPath: string, limit: number) =>
    ipcRenderer.invoke('get-scheduler-history', dbPath, limit),
  getCalibrationHistory: (dbPath: string, limit: number) =>
    ipcRenderer.invoke('get-calibration-history', dbPath, limit),
});
```

---

### Phase 4: UI Implementation

#### 4.1 Tab Navigation Component
Add at top of `<main>` section:

```vue
<div class="tab-navigation">
  <button
    :class="{ active: activeTab === 'manual' }"
    @click="activeTab = 'manual'"
  >
    Manual Forecast
  </button>
  <button
    :class="{ active: activeTab === 'scheduler' }"
    @click="activeTab = 'scheduler'"
  >
    Scheduler
  </button>
</div>
```

#### 4.2 Conditional Section Rendering
Wrap existing sections in `v-if="activeTab === 'manual'"` and add new scheduler sections with `v-if="activeTab === 'scheduler'"`.

#### 4.3 Scheduler Sections
Implement each card section for the scheduler tab following the existing styling patterns.

#### 4.4 History Display
Add collapsible history panel showing:
- Recent forecast runs (date, type, status, records, duration)
- Calibration results (wind/solar scales, deviations)
- Output file locations

---

### Phase 5: Run Scheduler Function

```typescript
async function runScheduler() {
  schedulerIsRunning.value = true;
  schedulerProgress.value = 0;

  const options: SchedulerOptions = {
    mode: schedulerMode.value,
    asOfDate: schedulerAsOfDate.value,
    startDate: schedulerStartDate.value,
    endDate: schedulerEndDate.value,
    dailyEnabled: schedulerDailyEnabled.value,
    weeklyEnabled: schedulerWeeklyEnabled.value,
    demandEnabled: schedulerDemandEnabled.value,
    cfacEnabled: schedulerCfacEnabled.value,
    zonalEnabled: schedulerZonalEnabled.value,
    demandPath: schedulerDemandPath.value,
    cfacPath: schedulerCfacPath.value,
    outputDir: schedulerOutputDir.value,
    dbPath: schedulerDbPath.value,
    demandModel: schedulerDemandModel.value,
    useXgboost: schedulerUseXgboost.value,
    asymmetricLoss: schedulerAsymmetricLoss.value,
    biasCorrection: schedulerBiasCorrection.value,
    calibDays: schedulerCalibDays.value,
    calibThreshold: schedulerCalibThreshold.value,
    maxIterations: schedulerMaxIterations.value,
  };

  try {
    const result = await window.electronAPI.runScheduler(options);
    if (result.code === 0) {
      addSchedulerStatus('Scheduler completed successfully', 'success');
    } else {
      addSchedulerStatus('Scheduler failed: ' + result.stderr, 'error');
    }
  } catch (error) {
    addSchedulerStatus('Error: ' + error.message, 'error');
  } finally {
    schedulerIsRunning.value = false;
    // Refresh history
    loadSchedulerHistory();
  }
}
```

---

## Implementation Steps

### Step 1: Modify App.vue Structure
1. Add tab navigation at top of main
2. Add `activeTab` state variable
3. Wrap existing content in `v-if="activeTab === 'manual'"`
4. Add empty scheduler section with `v-if="activeTab === 'scheduler'"`

### Step 2: Add Scheduler State
1. Add all scheduler-related ref variables
2. Add to settings persistence
3. Initialize defaults on mount

### Step 3: Build Scheduler UI Sections
1. Mode selection (Run Now / Backfill)
2. Date configuration
3. Forecast type toggles
4. Data source inputs
5. Model settings
6. Calibration settings
7. Run button and progress
8. History panel

### Step 4: Add IPC Handlers
1. `run-scheduler` handler in main.ts
2. `get-scheduler-history` handler
3. Update preload.ts with new methods
4. Update TypeScript declarations

### Step 5: Implement Run Function
1. Build CLI args from state
2. Execute via IPC
3. Stream output to UI
4. Handle completion/errors
5. Refresh history

### Step 6: Add Styling
1. Tab navigation styles
2. Scheduler section styles (reuse existing card patterns)
3. History table styles

---

## Output File Structure

The scheduler generates files in the following structure:
```
{outputDir}/
├── daily/
│   ├── Demand/
│   │   └── demand_{date}.csv
│   └── CFAC/
│       └── cfac_{date}.csv
├── weekly/
│   ├── Demand/
│   │   └── demand_{start}_{end}.csv
│   └── CFAC/
│       └── cfac_{start}_{end}.csv
└── calibration/
    └── {asOfDate}/
        └── (calibration intermediate files)
```

---

## Testing Checklist

- [ ] Tab switching works correctly
- [ ] Settings persist between sessions
- [ ] Run Now mode executes single-date forecast
- [ ] Backfill mode executes date range
- [ ] Daily/Weekly/Both options work
- [ ] Demand/CFAC/Both options work
- [ ] Zonal mode flag is passed correctly
- [ ] Model settings are applied
- [ ] Calibration settings are applied
- [ ] Real-time output streaming works
- [ ] Progress bar updates
- [ ] History displays correctly
- [ ] Error handling works
- [ ] Cancel/stop works (if implemented)

---

## Future Enhancements (Out of Scope)

- Background service mode with Windows Task Scheduler integration
- Email notifications on completion
- Forecast comparison view
- Accuracy metrics dashboard
