# GUI Overhaul Implementation Plan

**Status:** Ready for Implementation
**Created:** 2026-03-12
**Parent Plan:** UNIFIED_FORECAST_SYSTEM_PLAN.md (Phase 5)

---

## Executive Summary

The GUI needs to be overhauled to align with the Unified Forecast System. Currently, the GUI has duplicate state variables, passes invalid CLI options, and doesn't properly integrate with `forecast_config.json`.

### Goals
1. **Single Source of Truth** - All settings come from `forecast_config.json`
2. **Remove Duplicate State** - No more separate `ref()` variables for settings
3. **Fix CLI Compatibility** - Stop passing options that don't exist
4. **Simplify User Experience** - Cleaner, more intuitive interface

---

## Current Problems

### 1. Invalid CLI Options (Critical Bug)
The GUI passes these options to `scheduler backfill`, but they don't exist:
- `--use-xgboost`
- `--asymmetric-loss`
- `--bias-correction`
- `--refresh-weather`

**Location:** `gui/electron/main.ts` lines 1329-1339

### 2. Duplicate State Variables
The GUI has ~50+ `ref()` variables that duplicate what's in `globalConfig`:

| GUI Variable | Should Use |
|--------------|------------|
| `schedulerCalibDays` | `globalConfig.calibration.days` |
| `schedulerCalibThreshold` | `globalConfig.calibration.threshold` |
| `schedulerMaxIterations` | `globalConfig.calibration.maxIterations` |
| `schedulerUseXgboost` | `globalConfig.cfac.useXgboost` |
| `schedulerAsymmetricLoss` | `globalConfig.cfac.asymmetricLoss` |
| `schedulerBiasCorrection` | `globalConfig.cfac.biasCorrection` |
| `schedulerDemandModel` | `globalConfig.demand.model` |
| `globalDemandCsvPath` | `globalConfig.paths.demandTraining` |
| `globalCfacCsvPath` | `globalConfig.paths.cfacTraining` |
| `globalWeatherCacheDir` | `globalConfig.paths.weatherCache` |
| `globalSchedulerOutputDir` | `globalConfig.paths.output` |

### 3. Settings Not Synced
- Settings tab edits `globalConfig` but other tabs use local state
- Changes in Settings don't affect Manual/Scheduler tabs until page reload

### 4. Unused/Legacy Code
- Per-station-type settings (`windUseXgboost`, `solarUseXgboost`) - not in config schema
- Legacy scheduler functions commented out but still present
- Multiple calibration modes that aren't needed

---

## Implementation Tasks

### Task 1: Fix IPC Handler (Critical - Immediate)
**File:** `gui/electron/main.ts`

Remove invalid CLI options from `run-scheduler-manual` handler:
```typescript
// REMOVE these lines (1329-1339):
if (useXgboost === true) {
  args.push('--use-xgboost');
}
if (asymmetricLoss === true) {
  args.push('--asymmetric-loss');
}
if (biasCorrection === true) {
  args.push('--bias-correction');
}
```

Also remove from the options interface (lines 1248-1251):
```typescript
// REMOVE:
useXgboost?: boolean;
asymmetricLoss?: boolean;
biasCorrection?: boolean;
```

### Task 2: Simplify App.vue State
**File:** `gui/src/App.vue`

#### 2.1 Remove Duplicate Variables
Delete these refs and use `globalConfig` instead:
```typescript
// DELETE these (lines 62-96):
const globalRegionalDemandDb = ref('data/iload.db');
const globalZonalDemandDb = ref('data/iload_zonal.db');
const globalSchedulerDb = ref('./forecast.db');
const globalDemandCsvPath = ref('Data Samples/Demand');
const globalCfacCsvPath = ref('Data Samples/Capacity Factor');
const globalWeatherCacheDir = ref('./weather_cache');
const globalSchedulerOutputDir = ref('./output/forecasts');
const schedulerDemandModel = ref<'hybrid' | 'regression' | 'xgboost'>('hybrid');
const windUseXgboost = ref(false);
const windAsymmetricLoss = ref(false);
const windBiasCorrection = ref(false);
const solarUseXgboost = ref(true);
const solarAsymmetricLoss = ref(true);
const solarBiasCorrection = ref(false);
const schedulerCalibDays = ref(7);
const schedulerCalibThreshold = ref(5);
const schedulerMaxIterations = ref(3);
const calibrationIterations = ref(3);
```

#### 2.2 Create Computed Properties
Replace with computed properties that read from `globalConfig`:
```typescript
// Computed properties for config access
const calibrationDays = computed(() => globalConfig.value?.calibration?.days ?? 7);
const calibrationThreshold = computed(() => globalConfig.value?.calibration?.threshold ?? 5);
const calibrationMaxIterations = computed(() => globalConfig.value?.calibration?.maxIterations ?? 10);
const cfacUseXgboost = computed(() => globalConfig.value?.cfac?.useXgboost ?? false);
const cfacAsymmetricLoss = computed(() => globalConfig.value?.cfac?.asymmetricLoss ?? false);
const cfacBiasCorrection = computed(() => globalConfig.value?.cfac?.biasCorrection ?? false);
const demandModel = computed(() => globalConfig.value?.demand?.model ?? 'hybrid');
const demandGeography = computed(() => globalConfig.value?.demand?.geography ?? 'regional');
const outputDir = computed(() => globalConfig.value?.paths?.output ?? './output');
const weatherCacheDir = computed(() => globalConfig.value?.paths?.weatherCache ?? './weather_cache');
const demandTrainingPath = computed(() => globalConfig.value?.paths?.demandTraining ?? 'Data Samples/Demand');
const cfacTrainingPath = computed(() => globalConfig.value?.paths?.cfacTraining ?? 'Data Samples/Capacity Factor');
```

### Task 3: Update Settings Tab
**File:** `gui/src/App.vue`

The Settings tab should be the ONLY place to edit global config. Structure:

```
Settings Tab Layout:
├── Paths Section
│   ├── Demand Training Path
│   ├── CFAC Training Path
│   ├── Output Directory
│   ├── Archive Directory
│   └── Weather Cache Directory
├── Calibration Section
│   ├── Enabled toggle
│   ├── Days input
│   ├── Threshold input
│   └── Max Iterations input
├── CFAC Options Section
│   ├── Use XGBoost toggle
│   ├── Asymmetric Loss toggle
│   └── Bias Correction toggle
├── Demand Options Section
│   ├── Model dropdown (hybrid/regression/xgboost)
│   ├── Geography dropdown (regional/zonal)
│   └── Growth Rate input
├── Output Section
│   ├── Archive Enabled toggle
│   ├── Retention Days input
│   └── Naming Convention dropdown
├── Gateway Section
│   ├── Enabled toggle
│   └── Auto-push toggle
└── Actions
    ├── Save Settings button
    ├── Reset to Defaults button
    └── Status indicator
```

### Task 4: Simplify Scheduler Tab
**File:** `gui/src/App.vue`

Remove settings that are now in Settings tab. Scheduler tab should only have:
- Date selection (single date or range for backfill)
- Forecast type checkboxes (Demand, CFAC)
- Horizon checkboxes (Daily, Weekly)
- Run button
- Output terminal

Remove from Scheduler tab:
- Calibration settings (use global config)
- Model settings (use global config)
- Path settings (use global config)

### Task 5: Simplify runSchedulerManual Function
**File:** `gui/src/App.vue`

The function should NOT pass settings that come from config:
```typescript
async function runSchedulerManual() {
  // Only pass runtime options, not config options
  await window.electronAPI.runSchedulerManual({
    date: manualRunDate.value,
    endDate: manualRunEndDate.value || null,
    type: manualRunType.value,
    horizon: manualRunHorizon.value,
    verbose: schedulerVerboseOutput.value,
    overwrite: schedulerOverwrite.value,
    suffix: schedulerSuffix.value || null,
    // REMOVED: useXgboost, asymmetricLoss, biasCorrection, etc.
  });
}
```

### Task 6: Clean Up Manual Forecast Tab
**File:** `gui/src/App.vue`

The manual forecast tab (lines 1195-1250) hardcodes CLI options:
```typescript
// CURRENT (line 1230-1232):
'--use-xgboost',
'--asymmetric-loss',
'--bias-correction',
```

Change to read from global config or remove entirely (let CLI use config).

### Task 7: Remove Legacy Code
**File:** `gui/src/App.vue`

Delete commented-out legacy code:
- Old `runScheduler()` function (lines 1337-1430)
- Unused scheduler state variables
- Per-station-type settings (wind/solar separate toggles)

### Task 8: Update electron-store Settings
**File:** `gui/src/App.vue`

The `saveSettings()` function saves all state to electron-store. This should be simplified:
- Only save UI preferences (window state, active tab, etc.)
- Forecast settings should come from `forecast_config.json` only

---

## File Changes Summary

### gui/electron/main.ts
- Remove invalid CLI options from `run-scheduler-manual` (lines 1329-1339)
- Remove corresponding interface properties (lines 1248-1251)
- Simplify options interface

### gui/src/App.vue
- Remove ~30 duplicate `ref()` variables
- Add computed properties for config access
- Simplify `runSchedulerManual()` function
- Simplify manual forecast function
- Clean up Settings tab to be single source of truth
- Remove legacy commented code
- Update `saveSettings()` to only save UI state

### gui/electron/preload.ts
- No changes needed (IPC is already set up)

---

## Testing Checklist

After implementation:
- [ ] `scheduler backfill` runs without "unknown option" error
- [ ] Settings tab saves to `forecast_config.json`
- [ ] Changes in Settings tab reflect immediately in other tabs
- [ ] Manual forecast uses config settings
- [ ] Scheduler run uses config settings
- [ ] No duplicate state between tabs
- [ ] App starts without errors
- [ ] Config loads on startup

---

## Rollback Plan

If issues arise:
1. Git revert the commits
2. Original App.vue and main.ts are in git history

---

## Implementation Order

1. **Task 1** (Critical) - Fix IPC handler to stop the error
2. **Task 2** - Simplify state variables
3. **Task 3** - Update Settings tab
4. **Task 4** - Simplify Scheduler tab
5. **Task 5** - Simplify runSchedulerManual
6. **Task 6** - Fix Manual forecast tab
7. **Task 7** - Remove legacy code
8. **Task 8** - Update electron-store

---

*Document created: 2026-03-12*
