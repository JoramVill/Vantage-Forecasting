---
Status: Draft
Created: 2026-03-24
Updated-By: Claude
---

# GUI Architecture V2 — Train / Calibrate / Forecast

**Vantage Forecaster — GUI Updates for V2 Pipeline**

Version: 2.0 Draft
Date: March 24, 2026
Classification: Technical Architecture Document

---

## 1. Design Principles

### 1.1 GUI = Graphical CLI

The GUI remains a thin wrapper over CLI commands. **All forecast logic resides in the CLI.** The GUI's job is:

1. Collect user inputs (dates, paths, options, tuning knobs)
2. Construct CLI command arguments
3. Spawn Node.js child processes
4. Display real-time output and results

This principle is unchanged from V1. The GUI never runs models directly and never contains forecast logic.

### 1.2 Three Operations, Not Two

V1 had a Train/Inference toggle. V2 has three explicit operations that map directly to three CLI commands:

| Operation | CLI Command | What It Does | What It Produces |
|-----------|-------------|--------------|------------------|
| **Train** | `train` / `cfac train` | Learn model structure from history | `model.vfm` |
| **Calibrate** | `calibrate` / `cfac calibrate` | Correct recent drift from actuals | `calibration.json` |
| **Forecast** | `forecast` / `cfac forecast` | Predict using saved model + calibration | Forecast CSV |

The GUI exposes all three. Users can run each independently.

### 1.3 Scheduler = Automated Forecast + Auto-Calibrate

The scheduler runs production inference on a schedule. It uses saved models and calibration files. The only additional intelligence the scheduler adds beyond the CLI is:

1. **Auto-calibrate before forecasting** if the calibration file is stale (older than configured threshold)
2. **Schedule hourly runs** on a timer
3. **Backfill** a date range by looping the forecast command
4. **Push to gateway** after generation

This is minimal orchestration logic, not forecast logic.

---

## 2. Updated Tab Structure

### 2.1 Tab Summary

| Tab | V1 Purpose | V2 Purpose | Change |
|-----|------------|------------|--------|
| **Operations** | "Manual" — Train/Inference toggle | Train, Calibrate, Forecast — three explicit panels | Renamed, restructured |
| **Scheduler** | Run/backfill production forecasts | Same, plus auto-calibrate | Minor update |
| **Models** | View/manage .vfm files | View/manage .vfm + calibration.json | Expanded scope |
| **Gateway** | Push forecasts to clients | Unchanged | None |
| **Settings** | Configure paths and options | Updated config fields for V2 tuning knobs | Updated fields |

### 2.2 Operations Tab (formerly "Manual")

The Operations tab replaces the Manual tab. Instead of a single form with a Train/Inference toggle, it presents three clear panels:

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Operations Tab                                                         │
│                                                                         │
│  ┌─────────────────────┬──────────────────────┬──────────────────────┐  │
│  │      TRAIN          │     CALIBRATE         │     FORECAST         │  │
│  │                     │                       │                      │  │
│  │  Forecast Type:     │  Model File:          │  Model File:         │  │
│  │  [Demand ▼]         │  [model_0324.vfm ▼]   │  [model_0324.vfm ▼]  │  │
│  │                     │                       │                      │  │
│  │  Data Directory:    │  Actuals Directory:   │  Calibration:        │  │
│  │  [Data Samples/...] │  [Data Samples/...]   │  [calib_0324.json ▼] │  │
│  │                     │                       │                      │  │
│  │  Training Days:     │  Calibration Days:    │  Start Date:         │  │
│  │  [90          ]     │  [7           ]       │  [2026-03-25    ]    │  │
│  │                     │                       │                      │  │
│  │  Output:            │  Output:              │  End Date:           │  │
│  │  [models/model.vfm] │  [models/calib.json]  │  [2026-03-31    ]    │  │
│  │                     │                       │                      │  │
│  │  [▶ Run Training]   │  [▶ Run Calibration]  │  [▶ Run Forecast]    │  │
│  └─────────────────────┴──────────────────────┴──────────────────────┘  │
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────────┐ │
│  │  Terminal Output                                                    │ │
│  │  > Training demand model (90 days, zonal mode)...                   │ │
│  │  > Level Model: training on 83 days (7 warmup)...                   │ │
│  │  > Shape Model: building archetypes (3 per area × dayType)...       │ │
│  │  > Training complete. Saved to models/model_20260324.vfm            │ │
│  └─────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────┘
```

The three panels share a terminal output area at the bottom that streams CLI stdout/stderr in real time.

#### Forecast Type Selector

Applies to all three operations. Determines which CLI command prefix to use:

| Type | Train Command | Calibrate Command | Forecast Command |
|------|---------------|-------------------|------------------|
| Demand (Regional) | `train -d ... --regional` | `calibrate -m ... -d ...` | `forecast -m ... -c ...` |
| Demand (Zonal) | `train -d ... --zonal` | `calibrate -m ... -d ...` | `forecast -m ... -c ...` |
| CFAC | `cfac train -t ...` | `cfac calibrate -m ... -t ...` | `cfac forecast -m ... -c ...` |

Regional vs Zonal is inferred from the demand data columns (or can be forced with the toggle in Settings). The GUI doesn't need separate panels for regional and zonal — the CLI detects the mode from the input data.

---

## 3. CLI Command Mapping (V2)

### 3.1 Operations Tab → CLI

**Train (Demand):**
```typescript
const args = [
  'train',
  '-d', demandDataDir.value,
  '-w', weatherDataDir.value,         // or auto-fetch
  '--days', trainingDays.value,        // default 90
  '--config', configPath,              // optional
  '-o', modelOutputPath.value          // e.g., "models/model_20260324.vfm"
];

// Optional flags from Settings
if (zonal) args.push('--zonal');
if (growth !== 0) args.push('--growth', growth);

await window.electronAPI.runCommand(args);
```

**Train (CFAC):**
```typescript
const args = [
  'cfac', 'train',
  '-t', cfacDataDir.value,
  '-w', weatherDataDir.value,
  '--days', trainingDays.value,        // default 120
  '-o', modelOutputPath.value
];

await window.electronAPI.runCommand(args);
```

**Calibrate (Demand):**
```typescript
const args = [
  'calibrate',
  '-m', selectedModelPath.value,       // e.g., "models/model_20260324.vfm"
  '-d', demandDataDir.value,           // recent actuals
  '--days', calibrationDays.value,     // default 7
  '-o', calibrationOutputPath.value    // e.g., "models/calibration.json"
];

await window.electronAPI.runCommand(args);
```

**Calibrate (CFAC):**
```typescript
const args = [
  'cfac', 'calibrate',
  '-m', selectedModelPath.value,
  '-t', cfacDataDir.value,
  '--days', calibrationDays.value,     // default 14
  '-o', calibrationOutputPath.value
];

await window.electronAPI.runCommand(args);
```

**Forecast (Demand):**
```typescript
const args = [
  'forecast',
  '-m', selectedModelPath.value,       // model.vfm
  '-c', selectedCalibrationPath.value, // calibration.json
  '-s', forecastStart.value,
  '-e', forecastEnd.value,
  '-o', forecastOutputPath.value
];

if (pushToGateway) args.push('--push');

await window.electronAPI.runCommand(args);
```

**Forecast (CFAC):**
```typescript
const args = [
  'cfac', 'forecast',
  '-m', selectedModelPath.value,
  '-c', selectedCalibrationPath.value,
  '-s', forecastStart.value,
  '-e', forecastEnd.value,
  '-o', forecastOutputPath.value
];

if (pushToGateway) args.push('--push');

await window.electronAPI.runCommand(args);
```

### 3.2 Scheduler Tab → CLI

**Single Date Run:**
```typescript
const args = [
  'scheduler', 'run',
  '-d', runDate.value,                  // e.g., "2026-03-24"
  '--demand-model', demandModelId,      // required
  '--demand-calibration', demandCalibPath,
  '--cfac-model', cfacModelId,          // required
  '--cfac-calibration', cfacCalibPath
];

// Type filter
if (type === 'demand') args.push('--demand-only');
else if (type === 'cfac') args.push('--cfac-only');

// Horizon
if (horizon === 'daily') args.push('--daily');
else if (horizon === 'weekly') args.push('--weekly');

// Options
if (refreshWeather) args.push('--refresh-weather');
if (pushGateway) args.push('--push-gateway');
if (autoCalibrate) args.push('--auto-calibrate');

await window.electronAPI.runSchedulerManual(args);
```

**Backfill Run:**
```typescript
const args = [
  'scheduler', 'backfill',
  '-s', startDate.value,
  '-e', endDate.value,
  '--demand-model', demandModelId,
  '--demand-calibration', demandCalibPath,
  '--cfac-model', cfacModelId,
  '--cfac-calibration', cfacCalibPath
];

if (overwrite) args.push('--overwrite');
if (type === 'demand') args.push('--demand-only');

await window.electronAPI.runSchedulerManual(args);
```

### 3.3 Models Tab → CLI

| GUI Action | CLI Command |
|------------|-------------|
| List all models | `models list` |
| List calibrations | `models list --calibrations` |
| View model details | `models info <id>` |
| Activate model for scheduler | `models activate <id>` |
| Delete model | `models delete <id>` |
| Delete calibration | `models delete-calibration <id>` |

### 3.4 Settings Tab → CLI

| GUI Action | CLI Command |
|------------|-------------|
| View configuration | `config get` |
| Update setting | `config set <key> <value>` |
| Reset to defaults | `config reset` |
| Validate configuration | `config validate` |

### 3.5 Gateway Tab → CLI

Unchanged from V1:

| GUI Action | CLI Command |
|------------|-------------|
| Push file | `gateway push <file>` |
| Push all pending | `gateway push --all` |
| Push by category | `gateway push --category <cat>` |

---

## 4. Scheduler Detail

### 4.1 Scheduler's Role

The scheduler is the only part of the GUI that adds logic beyond "call CLI command." Its responsibilities are:

1. **Timer**: run forecast on a schedule (default: hourly)
2. **Auto-calibrate**: before forecasting, check if calibration is stale and refresh if needed
3. **Backfill**: loop forecast command across a date range
4. **Gateway push**: push output to clients after generation
5. **Logging**: maintain run history with status and metrics

Everything else — the actual forecasting, calibration math, weather fetching — lives in the CLI.

### 4.2 Auto-Calibration Logic

The scheduler's auto-calibrate is straightforward: before running a forecast, check the age of the calibration file. If it's older than the configured threshold, run calibration first.

```typescript
async function schedulerRun(date: string, options: SchedulerOptions) {
  // Step 1: Check calibration freshness
  if (options.autoCalibrate) {
    const calibAge = daysSince(calibration.calibrationDate);
    const threshold = config.lifecycle.calibrationSchedule; // e.g., "1d"

    if (calibAge > parseDays(threshold)) {
      // Run calibration CLI command first
      await runCommand([
        'calibrate',
        '-m', activeDemandModel,
        '-d', demandDataDir,
        '--days', config.calibration.days,
        '-o', demandCalibrationPath
      ]);

      await runCommand([
        'cfac', 'calibrate',
        '-m', activeCfacModel,
        '-t', cfacDataDir,
        '--days', config.calibration.days,
        '-o', cfacCalibrationPath
      ]);
    }
  }

  // Step 2: Run forecast (demand)
  await runCommand([
    'forecast',
    '-m', activeDemandModel,
    '-c', demandCalibrationPath,
    '-s', date,
    '-e', addDays(date, horizon),
    '-o', outputPath
  ]);

  // Step 3: Run forecast (CFAC)
  await runCommand([
    'cfac', 'forecast',
    '-m', activeCfacModel,
    '-c', cfacCalibrationPath,
    '-s', date,
    '-e', addDays(date, horizon),
    '-o', cfacOutputPath
  ]);

  // Step 4: Push to gateway (if configured)
  if (options.pushGateway) {
    await runCommand(['gateway', 'push', outputPath]);
    await runCommand(['gateway', 'push', cfacOutputPath]);
  }
}
```

This is orchestration, not intelligence. Every step is a CLI command.

### 4.3 Backfill Logic

Backfill loops the forecast command across a date range. No special logic — just iteration:

```typescript
async function schedulerBackfill(startDate: string, endDate: string, options: BackfillOptions) {
  const dates = generateDateRange(startDate, endDate);

  for (const date of dates) {
    const outputExists = checkOutputExists(date);
    if (outputExists && !options.overwrite) {
      log(`Skipping ${date} — output exists`);
      continue;
    }

    // Same as schedulerRun, minus auto-calibrate (use current calibration for all)
    await runCommand([
      'forecast',
      '-m', activeDemandModel,
      '-c', demandCalibrationPath,
      '-s', date,
      '-e', addDays(date, horizon),
      '-o', outputPathFor(date)
    ]);

    if (!options.demandOnly) {
      await runCommand([
        'cfac', 'forecast',
        '-m', activeCfacModel,
        '-c', cfacCalibrationPath,
        '-s', date,
        '-e', addDays(date, horizon),
        '-o', cfacOutputPathFor(date)
      ]);
    }

    if (options.pushGateway) {
      await runCommand(['gateway', 'push', outputPathFor(date)]);
    }
  }
}
```

### 4.4 Hourly Production Schedule

For production operations, the scheduler runs hourly to deliver fresh forecasts to clients:

```
Every hour (e.g., :05 past the hour):
  1. Check: is calibration stale? → auto-calibrate if needed
  2. Fetch latest weather forecast (automatic via CLI)
  3. Run demand forecast for next 7 days
  4. Run CFAC forecast for next 7 days
  5. Push both to gateway
  6. Log run status + metrics
```

The timer lives in the Electron main process. Each tick spawns CLI child processes. If a run is still in progress when the next tick fires, it skips (no overlapping runs).

### 4.5 Scheduler Configuration

```json
{
  "scheduler": {
    "enabled": false,
    "intervalMinutes": 60,
    "runAtMinutesPastHour": 5,
    "autoCalibrate": true,
    "pushGateway": true,
    "horizon": "weekly",
    "demandModel": "model_20260324.vfm",
    "demandCalibration": "calibration.json",
    "cfacModel": "cfac_model_20260324.vfm",
    "cfacCalibration": "cfac_calibration.json"
  }
}
```

### 4.6 Scheduler Tab UI

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Scheduler Tab                                                          │
│                                                                         │
│  ┌─ Production Schedule ─────────────────────────────────────────────┐  │
│  │                                                                    │  │
│  │  Status: [● Running] / [○ Stopped]     [Start] [Stop]            │  │
│  │  Interval: Every [60] minutes                                     │  │
│  │  Next Run: 2026-03-24 15:05                                       │  │
│  │  Last Run: 2026-03-24 14:05 — Success (Demand: 2.3% MAPE)       │  │
│  │                                                                    │  │
│  │  Active Models:                                                    │  │
│  │    Demand: model_20260324.vfm  [Change]                           │  │
│  │    CFAC:   cfac_model_20260324.vfm  [Change]                      │  │
│  │                                                                    │  │
│  │  Calibration:                                                      │  │
│  │    Demand: calibration.json (age: 4h)  [Refresh Now]              │  │
│  │    CFAC:   cfac_calibration.json (age: 4h)  [Refresh Now]        │  │
│  │    Auto-calibrate: [✓] when older than [24] hours                 │  │
│  │                                                                    │  │
│  │  Options:                                                          │  │
│  │    [✓] Push to gateway    [✓] Demand    [✓] CFAC                 │  │
│  │    Horizon: [Weekly ▼]                                            │  │
│  │                                                                    │  │
│  └────────────────────────────────────────────────────────────────────┘  │
│                                                                         │
│  ┌─ Manual Run / Backfill ───────────────────────────────────────────┐  │
│  │                                                                    │  │
│  │  Mode: (•) Single Date  ( ) Backfill                              │  │
│  │                                                                    │  │
│  │  Date: [2026-03-25]    (Backfill: Start [____] End [____])       │  │
│  │  Type: [All ▼]         Horizon: [Weekly ▼]                       │  │
│  │  [✓] Refresh weather   [ ] Overwrite existing                    │  │
│  │                                                                    │  │
│  │  [▶ Run Now]                                                      │  │
│  └────────────────────────────────────────────────────────────────────┘  │
│                                                                         │
│  ┌─ Run History ─────────────────────────────────────────────────────┐  │
│  │                                                                    │  │
│  │  2026-03-24 14:05  ✓  Demand+CFAC  Weekly  Pushed  MAPE: 2.3%   │  │
│  │  2026-03-24 13:05  ✓  Demand+CFAC  Weekly  Pushed  MAPE: 2.4%   │  │
│  │  2026-03-24 12:05  ✗  CFAC failed: weather API timeout           │  │
│  │  2026-03-24 11:05  ✓  Demand+CFAC  Weekly  Pushed  MAPE: 2.2%   │  │
│  │  ...                                                              │  │
│  └────────────────────────────────────────────────────────────────────┘  │
│                                                                         │
│  ┌─ Terminal Output ─────────────────────────────────────────────────┐  │
│  │  > [14:05] Starting scheduled run for 2026-03-24...               │  │
│  │  > [14:05] Calibration age: 4h (threshold: 24h) — using cached   │  │
│  │  > [14:05] Running demand forecast (model_20260324.vfm)...        │  │
│  │  > [14:06] Demand forecast complete. MAPE: 2.3%                   │  │
│  │  > [14:06] Running CFAC forecast (cfac_model_20260324.vfm)...     │  │
│  │  > [14:07] CFAC forecast complete. Pushed to gateway.             │  │
│  └────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 5. Models Tab (V2)

### 5.1 Expanded Scope

V1 managed only `.vfm` model files. V2 manages two artifact types:

| Artifact | Purpose | Created By | Used By |
|----------|---------|------------|---------|
| `model.vfm` | Learned structure (weights, profiles, archetypes) | Train | Calibrate, Forecast |
| `calibration.json` | Recent bias corrections + lag actuals | Calibrate | Forecast |

### 5.2 Models Tab UI

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Models Tab                                                             │
│                                                                         │
│  ┌─ Filter ──────────────────────────────────────────────────────────┐  │
│  │  Type: [All ▼]  Entity: [All ▼]  Show: (•) Models ( ) Calibrations │
│  └────────────────────────────────────────────────────────────────────┘  │
│                                                                         │
│  ┌─ Models ──────────────────────────────────────────────────────────┐  │
│  │                                                                    │  │
│  │  ★ model_20260324.vfm                     Demand (Zonal)          │  │
│  │    Trained: Mar 24, 2026  |  Days: 90  |  Val MAPE: 2.8%         │  │
│  │    Calibrations: calibration_20260324.json (4h ago)               │  │
│  │    [Calibrate Now]  [Set as Scheduler Active]  [Delete]           │  │
│  │                                                                    │  │
│  │  ○ model_20260310.vfm                     Demand (Zonal)          │  │
│  │    Trained: Mar 10, 2026  |  Days: 90  |  Val MAPE: 3.1%         │  │
│  │    Calibrations: calibration_20260322.json (2d ago)               │  │
│  │    [Calibrate Now]  [Set as Scheduler Active]  [Delete]           │  │
│  │                                                                    │  │
│  │  ★ cfac_model_20260320.vfm                CFAC                    │  │
│  │    Trained: Mar 20, 2026  |  Days: 120  |  Solar MAPE: 14%       │  │
│  │    Calibrations: cfac_calibration_20260324.json (4h ago)          │  │
│  │    [Calibrate Now]  [Set as Scheduler Active]  [Delete]           │  │
│  │                                                                    │  │
│  └────────────────────────────────────────────────────────────────────┘  │
│                                                                         │
│  ┌─ Selected Model Detail ───────────────────────────────────────────┐  │
│  │                                                                    │  │
│  │  model_20260324.vfm — Demand (Zonal, 14 areas)                   │  │
│  │                                                                    │  │
│  │  Training Period:  Dec 25, 2025 – Mar 24, 2026 (90 days)         │  │
│  │  Validation MAPE:  2.8%                                           │  │
│  │  Shape Correlation: 0.96                                          │  │
│  │  Peak Hour Accuracy: ±0.5h                                        │  │
│  │                                                                    │  │
│  │  Per-Area MAPE:                                                    │  │
│  │    01NLUZ: 2.1%  02METRO: 1.8%  03SLUZ: 2.4%  04LEYTE: 4.2%    │  │
│  │    05CEBU: 2.9%  06NEGROS: 3.5% 07BOHOL: 5.1%  08PANAY: 3.2%   │  │
│  │    09NWMIN: 3.8% 10LANAO: 4.5%  11NCMIN: 3.1%  12NEMIN: 4.0%   │  │
│  │    13SEMIN: 2.5% 14SWMIN: 3.9%                                   │  │
│  │                                                                    │  │
│  │  Configuration Snapshot:                                           │  │
│  │    Archetypes: 3  |  Blending: 0.8  |  Level: XGBoost (d5, n100) │  │
│  │                                                                    │  │
│  │  Latest Calibration: calibration_20260324.json                    │  │
│  │    Date: Mar 24, 2026  |  Level MAPE: 1.9%  |  Shape MAPE: 1.2% │  │
│  │    Level Scales: 01NLUZ=1.03 02METRO=0.98 03SLUZ=1.01 ...       │  │
│  │    Drift Status: ✓ All within thresholds                         │  │
│  │                                                                    │  │
│  └────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────┘
```

### 5.3 Updated Model Instance Structure

```typescript
interface ModelInstance {
  id: string;                      // UUID
  name: string;                    // Filename (model_20260324.vfm)
  entityType: 'demand' | 'cfac';
  geography?: 'regional' | 'zonal'; // Demand only
  createdAt: string;
  trainingPeriod: { start: string; end: string };
  trainingDays: number;
  configSnapshot: object;           // V2 config at time of training
  metrics: {
    mape: number;
    shapeMape?: number;             // Demand V2 only
    shapeCorrelation?: number;      // Demand V2 only
    peakHourAccuracy?: number;      // Demand V2 only
    perAreaMape?: Record<string, number>;
    perStationMape?: Record<string, number>; // CFAC only
  };
  modelPath: string;                // Path to .vfm file
  isSchedulerActive: boolean;       // Currently used by scheduler
  calibrations: CalibrationInstance[]; // Associated calibration files
}

interface CalibrationInstance {
  id: string;
  calibrationDate: string;
  calibrationDays: number;
  modelId: string;                  // Which model this calibration is for
  calibrationPath: string;          // Path to calibration.json
  metrics: {
    levelMape?: Record<string, number>;
    shapeMape?: Record<string, number>;
    solarMape?: Record<string, number>;
    windMape?: Record<string, number>;
  };
  driftStatus: 'ok' | 'warning' | 'retrain_recommended';
  isSchedulerActive: boolean;       // Currently used by scheduler
}
```

### 5.4 Workflow Through Tabs

```
Operations Tab          Models Tab              Scheduler Tab
─────────────          ──────────              ──────────────

[Train] ──────────────► New model appears ──► [Set as Scheduler Active]
                        with metrics                    │
                             │                          │
[Calibrate] ──────────► Calibration attached            │
  (select model)        to model entry                  │
                             │                          │
                             └──────────────────► Scheduler uses
                                                  active model +
                                                  active calibration
                                                        │
                                                  [▶ Run / Backfill]
                                                        │
                                                  Forecast CSV
                                                        │
                                                  Gateway Tab
                                                  [Push to clients]
```

---

## 6. Settings Tab (V2)

### 6.1 Updated Configuration Structure

```json
{
  "version": 2,
  "paths": {
    "demandData": "Data Samples/Demand",
    "cfacData": "Data Samples/Capacity Factor",
    "weatherData": "Data Samples/Weather",
    "models": "./models",
    "output": "./output",
    "archive": "./output/archive",
    "weatherCache": "./weather_cache"
  },
  "demand": {
    "geography": "zonal",
    "growthRate": 0,
    "level": {
      "model": "xgboost",
      "maxDepth": 5,
      "nEstimators": 100
    },
    "shape": {
      "archetypeCount": 3,
      "archetypeBlending": 0.8,
      "confidenceThreshold": 50,
      "weatherInfluence": 1.0,
      "adjustmentModel": "linear"
    },
    "calibration": {
      "days": 7,
      "levelClamp": [0.90, 1.10],
      "shapeClamp": [0.88, 1.12],
      "peakBias": 0.3
    },
    "validation": {
      "amplitudeCheck": "monitor",
      "amplitudeRange": [25, 75]
    },
    "training": {
      "days": 90,
      "lagWarmupDays": 7
    }
  },
  "cfac": {
    "wind": {
      "perStationCalibration": true,
      "windScaleClamp": [0.50, 2.00]
    },
    "solar": {
      "solarAlpha": 0.65,
      "solarScaleClamp": [0.50, 1.50],
      "tempCoefficient": 0.004
    },
    "profile": {
      "defaultPercentile": "p50",
      "confidenceThreshold": 50,
      "maintenanceThreshold": 0.50
    },
    "calibration": {
      "days": 14
    },
    "training": {
      "days": 120
    }
  },
  "scheduler": {
    "enabled": false,
    "intervalMinutes": 60,
    "autoCalibrate": true,
    "autoCalibrateStalenessHours": 24,
    "pushGateway": true,
    "horizon": "weekly"
  },
  "lifecycle": {
    "demandRetrainSchedule": "14d",
    "cfacRetrainSchedule": "30d",
    "retrainTrigger": {
      "levelDriftThreshold": 0.08,
      "shapeDriftThreshold": 0.10,
      "solarScaleDriftThreshold": 0.25,
      "windBiasDriftThreshold": 0.10,
      "consecutiveCyclesOverThreshold": 3
    },
    "autoRetrain": false
  },
  "gateway": {
    "enabled": false,
    "autoPush": false,
    "endpoint": ""
  }
}
```

### 6.2 Settings Tab Sections

| Section | Fields | Maps To |
|---------|--------|---------|
| **Data Paths** | Demand data dir, CFAC data dir, Weather dir, Models dir, Output dir | `paths.*` |
| **Demand Model** | Geography, growth rate, archetype count, archetype blending, weather influence, peak bias | `demand.*` |
| **CFAC Model** | Solar alpha, temp coefficient, wind per-station cal., profile percentile | `cfac.*` |
| **Calibration** | Demand cal. days, CFAC cal. days, clamp ranges | `demand.calibration.*`, `cfac.calibration.*` |
| **Scheduler** | Interval, auto-calibrate, auto-push, horizon | `scheduler.*` |
| **Lifecycle** | Retrain schedules, drift thresholds, auto-retrain | `lifecycle.*` |
| **Gateway** | Endpoint, credentials, auto-push | `gateway.*` |

The Settings tab should group these logically and show the V2 tuning knobs with their default values. Tooltips or a "?" icon can link to the troubleshooting guide from the architecture documents.

---

## 7. Process Architecture (V2)

### 7.1 Updated Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                      Electron Main Process                       │
│  (gui/electron/main.ts)                                         │
│                                                                 │
│  ┌─────────────────┐     ┌─────────────────────────────┐       │
│  │ IPC Handlers    │────▶│ Child Process (Node.js)     │       │
│  │ run-command     │     │                              │       │
│  │ run-scheduler   │     │ train / calibrate / forecast │       │
│  │ load-config     │     │ cfac train / cfac calibrate  │       │
│  │ save-config     │     │ cfac forecast                │       │
│  │ list-models     │     │ scheduler run / backfill     │       │
│  │ gateway-push    │     │ models list / activate       │       │
│  └─────────────────┘     └─────────────────────────────┘       │
│          ▲                           │                         │
│          │ IPC                       │ stdout/stderr           │
│          │                           ▼                         │
│  ┌───────┴───────────────────────────────────────────┐         │
│  │ Scheduler Timer                                    │         │
│  │ - Checks calibration staleness                     │         │
│  │ - Spawns calibrate + forecast CLIs                 │         │
│  │ - Manages run history                              │         │
│  └───────────────────────────────────────────────────┘         │
│                                                                 │
└──────────┬───────────────────────────┬─────────────────────────┘
           │                           │
┌──────────┼───────────────────────────┼─────────────────────────┐
│          │                           │                         │
│  ┌───────┴───────┐           ┌───────┴───────┐                │
│  │ preload.ts    │           │ Real-time     │                │
│  │ electronAPI   │◀──────────│ Output Events │                │
│  └───────┬───────┘           └───────────────┘                │
│          │                                                     │
│  ┌───────┴───────────────────────────────────────────────┐    │
│  │                   Vue Application (App.vue)            │    │
│  │  ┌───────────┐ ┌───────────┐ ┌────────┐ ┌──────────┐  │    │
│  │  │Operations │ │ Scheduler │ │ Models │ │ Settings │  │    │
│  │  │   Tab     │ │    Tab    │ │  Tab   │ │   Tab    │  │    │
│  │  │           │ │           │ │        │ │          │  │    │
│  │  │ Train     │ │ Schedule  │ │ .vfm   │ │ Demand   │  │    │
│  │  │ Calibrate │ │ Manual    │ │ files  │ │ CFAC     │  │    │
│  │  │ Forecast  │ │ Backfill  │ │ calib  │ │ Schedule │  │    │
│  │  │           │ │           │ │ files  │ │ Lifecyc. │  │    │
│  │  └───────────┘ └───────────┘ └────────┘ └──────────┘  │    │
│  │                                                        │    │
│  │  ┌──────────┐                                         │    │
│  │  │ Gateway  │                                         │    │
│  │  │   Tab    │                                         │    │
│  │  └──────────┘                                         │    │
│  └───────────────────────────────────────────────────────┘    │
│                     Electron Renderer Process                  │
└───────────────────────────────────────────────────────────────┘
```

### 7.2 IPC API (V2 Additions)

```typescript
// V2 additions to electronAPI

// Operations
window.electronAPI.runTrain(args: string[]): Promise<CommandResult>
window.electronAPI.runCalibrate(args: string[]): Promise<CommandResult>
window.electronAPI.runForecast(args: string[]): Promise<CommandResult>

// These are convenience wrappers — they all call runCommand() internally
// with the appropriate CLI prefix. The separation exists so the GUI
// can show operation-specific progress indicators.

// Model management (expanded)
window.electronAPI.listCalibrations(modelId?: string): Promise<CalibrationInstance[]>
window.electronAPI.getCalibrationById(id: string): Promise<CalibrationInstance | null>
window.electronAPI.deleteCalibration(id: string): Promise<void>
window.electronAPI.setSchedulerActiveCalibration(id: string): Promise<{ success: boolean }>

// Scheduler (expanded)
window.electronAPI.getSchedulerStatus(): Promise<{
  running: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastRunStatus: 'success' | 'failed' | null;
  demandModel: string | null;
  demandCalibration: string | null;
  cfacModel: string | null;
  cfacCalibration: string | null;
  calibrationAge: { demand: number; cfac: number }; // hours
}>

window.electronAPI.startScheduler(): Promise<void>
window.electronAPI.stopScheduler(): Promise<void>
window.electronAPI.forceCalibrationRefresh(type: 'demand' | 'cfac' | 'all'): Promise<void>
```

---

## 8. Complete V2 CLI Mapping

### 8.1 Operations Tab

| GUI Action | CLI Command |
|------------|-------------|
| Train Demand (Regional) | `train -d PATH -w PATH --days 90 --regional -o FILE` |
| Train Demand (Zonal) | `train -d PATH -w PATH --days 90 --zonal -o FILE` |
| Train CFAC | `cfac train -t PATH -w PATH --days 120 -o FILE` |
| Calibrate Demand | `calibrate -m MODEL -d PATH --days 7 -o FILE` |
| Calibrate CFAC | `cfac calibrate -m MODEL -t PATH --days 14 -o FILE` |
| Forecast Demand | `forecast -m MODEL -c CALIB -s DATE -e DATE -o FILE` |
| Forecast CFAC | `cfac forecast -m MODEL -c CALIB -s DATE -e DATE -o FILE` |

### 8.2 Scheduler Tab

| GUI Action | CLI Command(s) |
|------------|----------------|
| Run Single Date | `[auto-calibrate if stale]` then `forecast ...` then `cfac forecast ...` then `gateway push ...` |
| Run Backfill | Loop: `forecast -m M -c C -s DATE -e DATE+H -o FILE` for each date in range |
| Refresh Calibration Now | `calibrate -m MODEL -d PATH --days 7 -o FILE` |
| Start/Stop Scheduler | GUI-internal timer (no CLI equivalent) |

### 8.3 Models Tab

| GUI Action | CLI Command |
|------------|-------------|
| List Models | `models list` |
| List Calibrations | `models list --calibrations` |
| Model Details | `models info ID` |
| Activate for Scheduler | `models activate ID` |
| Activate Calibration | `models activate-calibration ID` |
| Delete Model | `models delete ID` |
| Delete Calibration | `models delete-calibration ID` |

### 8.4 Settings + Gateway (unchanged pattern)

| GUI Action | CLI Command |
|------------|-------------|
| View/Edit Config | `config get` / `config set KEY VALUE` |
| Push Forecast | `gateway push FILE` |

---

## 9. Migration from V1 GUI

### 9.1 What Changes

| Component | V1 | V2 | Effort |
|-----------|-----|-----|--------|
| Manual Tab | Train/Inference toggle | Three-panel Operations tab | Medium — UI restructure |
| Scheduler | `--use-model` only | `--demand-model` + `--demand-calibration` + cfac equivalents | Medium — arg changes |
| Models Tab | .vfm only | .vfm + calibration.json | Medium — expanded data model |
| Settings | V1 config fields | V2 config with tuning knobs | Low — field additions |
| Gateway | Unchanged | Unchanged | None |
| IPC API | `runCommand` | Same + convenience wrappers + calibration management | Low |
| Scheduler timer | Basic | + auto-calibrate check | Low |

### 9.2 What Stays the Same

- Electron + Vue technology stack
- IPC child process spawning pattern
- Real-time terminal output streaming
- Portable mode detection and path resolution
- Gateway push mechanics
- Error handling (exit codes, stderr display)

### 9.3 Implementation Order

1. **Update CLI commands first** — V2 CLI must work before GUI can wrap it
2. **Update Settings config structure** — new fields, migration from V1 config
3. **Restructure Manual → Operations tab** — three panels, new command construction
4. **Update Models tab** — add calibration artifact management
5. **Update Scheduler** — add `--demand-calibration`, `--cfac-calibration` args, auto-calibrate logic
6. **Test end-to-end**: Operations (Train) → Models (Review) → Operations (Calibrate) → Scheduler (Run) → Gateway (Push)

**Estimated GUI effort: 5-7 days** (after CLI V2 is complete)

---

## 10. Key Constraint: No Forecast Logic in GUI

To reiterate the foundational principle: **the GUI contains zero forecast logic.** Every button click constructs a CLI argument array and spawns a child process. The scheduler's auto-calibrate check is the only "intelligence" in the GUI, and even that is just "check file date, if stale → run CLI command."

This means:

- All V2 model improvements (archetypes, shape/level split, hourly calibration) are invisible to the GUI. They live in the CLI.
- The GUI doesn't need to know what archetypes are or how shape normalization works.
- GUI tests are about "does clicking Train construct the right CLI args?" — not about forecast accuracy.
- A developer can use the CLI directly for everything the GUI does, including scheduled production runs (via cron/Task Scheduler instead of Electron timer).

---

## Document History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | 2026-03-24 | Claude Code | Initial V1 GUI architecture |
| 2.0 | 2026-03-24 | Claude | V2 update: three-operation lifecycle, Operations tab, calibration management, scheduler auto-calibrate, updated config, V2 CLI mapping |
