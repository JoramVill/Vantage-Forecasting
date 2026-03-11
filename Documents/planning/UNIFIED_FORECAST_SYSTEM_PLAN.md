# Unified Forecast System Implementation Plan

**Status:** Approved - Ready for Implementation
**Created:** 2026-03-11
**Last Updated:** 2026-03-11
**Version:** 2.0

---

## Executive Summary

This plan unifies the three forecast entry points (Manual, Scheduler, Backfill) into a single system with global configuration stored in a human-editable JSON file.

### Goals
1. **Unify** - One way to generate forecasts
2. **Simplify** - Remove redundant code, unused features, and failed experiments
3. **Standardize** - Global settings apply everywhere

### Key Decisions (Confirmed)
- **Config Storage:** JSON file only (`forecast_config.json`) - no database config table
- **Calibration:** System B (iterative, convergent) - remove System A (single-pass)
- **Models:** Keep proven performers (Hybrid, 4-Tier MREC, Physics+ML)
- **Remove:** EMA smoothing, CFAC LSTM, legacy commands

---

## Table of Contents

1. [What to Keep](#1-what-to-keep)
2. [What to Remove](#2-what-to-remove)
3. [Architecture Overview](#3-architecture-overview)
4. [Global Configuration](#4-global-configuration)
5. [CLI Commands](#5-cli-commands)
6. [GUI Overhaul](#6-gui-overhaul)
7. [Implementation Plan](#7-implementation-plan)
8. [Files Reference](#8-files-reference)

---

## 1. What to Keep

### 1.1 Models (Proven Performers)

| Model | Type | Performance | Location |
|-------|------|-------------|----------|
| **4-Tier MREC Hybrid** | Wind CFAC | ~73% MAPE (best) | `WindEnhancedHybridModel.ts` |
| **Physics+ML Hybrid** | Solar CFAC | ~16% MAPE (best) | `SolarHybridModel.ts` |
| **Profile-based** | Hydro/Geo/Bio/Battery | Varies (good) | `capacityFactorService.ts` |
| **Region-Aware Hybrid** | Demand | 2-4% MAPE | `hybridModel.ts` |
| **XGBoost Calibrator** | Demand correction | Improves hybrid | `DemandCalibrator.ts` |

### 1.2 Calibration System

**Keep System B** (Scheduler's iterative calibration):
- Location: `forecastSchedulerService.ts` lines 569-847
- Features:
  - Iterates until convergence (up to 10 iterations)
  - Auto-detects most recent actual data
  - Per-station scaling for CFAC
  - Peak/off-peak scaling for demand
  - Stores history in `calibration_history` table (for audit)
  - Convergence threshold (default 5%)

### 1.3 Database Tables (Runtime Data)

| Table | Purpose | Keep |
|-------|---------|------|
| `calibration_history` | Audit trail of calibration runs | Yes |
| `forecast_runs` | Record of forecast executions | Yes |
| `forecast_archive` | Archived forecast files | Yes |
| `demand_forecast_hourly` | Hourly demand forecasts | Yes |
| `cfac_forecast_hourly` | Hourly CFAC forecasts | Yes |

### 1.4 Core Commands

| Command | Purpose |
|---------|---------|
| `cfac forecast2` | CFAC forecasting (simplified) |
| `cfac evaluate` | Evaluate CFAC accuracy |
| `cfac mrec compare3` | Compare wind models |
| `forecast` | Demand forecasting (simplified) |
| `train` | Train demand model |
| `evaluate` | Evaluate demand accuracy |
| `scheduler run` | Automated daily/weekly |
| `scheduler backfill` | Historical fill |
| `scheduler service` | Background service |
| `scheduler status` | View status |
| `scheduler evaluate` | Evaluate pending |
| `db *` | Database management |
| `gateway push` | Push to gateway |
| `interconnector *` | Interconnector forecast |

---

## 2. What to Remove

### 2.1 Failed/Unused Features

| Feature | Reason for Removal | Files to Delete |
|---------|-------------------|-----------------|
| **EMA Smoothing** | Never evaluated, no evidence of helping | Remove `cfac forecast3` command |
| **CFAC LSTM** | Underperforms hybrid (documented) | `WindLSTMModel.ts`, `SolarLSTMModel.ts` |
| **Demand LSTM** | Already removed (Hybrid 3.3x better) | Already deleted |
| **`--lstm-correction` flag** | Based on removed functionality | Remove from `forecast` command |

### 2.2 Legacy/Redundant Commands

| Command | Reason for Removal |
|---------|-------------------|
| `cfac forecast` | Superseded by `cfac forecast2` |
| `cfac forecast3` | EMA smoothing doesn't help |
| `scheduler config` | Replaced by `config` command |

### 2.3 Redundant Calibration (System A)

**Remove System A** (built-in CLI calibration):
- Location: `src/index.ts` lines 3270-3500
- Reason: Redundant with System B, causes inconsistency
- Impact: `cfac forecast2` will use unified service with System B

### 2.4 Database Config Table

**Do NOT create `global_config` table** - use JSON file instead.

Remove/don't create:
- `scheduler_config` table (migrate to JSON, deprecate)

---

## 3. Architecture Overview

### 3.1 Unified System Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                    forecast_config.json                          │
│                                                                   │
│  Single source of truth for all settings                         │
│  Human-editable, Git-trackable, portable                         │
└─────────────────────────────────────────────────────────────────┘
                              │
                    Loaded on startup
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                  UnifiedForecastService                          │
│                                                                   │
│  Single entry point: generateForecast(request)                   │
│                                                                   │
│  • Reads config from JSON                                        │
│  • Runs System B calibration (iterative, convergent)             │
│  • Generates demand and/or CFAC forecasts                        │
│  • Uses proven models only (Hybrid, 4-Tier, Physics+ML)          │
│  • Handles archiving and gateway push                            │
└─────────────────────────────────────────────────────────────────┘
                              │
          ┌───────────────────┼───────────────────┐
          ▼                   ▼                   ▼
    ┌──────────┐        ┌──────────┐        ┌──────────┐
    │  Manual  │        │ Scheduler│        │ Backfill │
    │  CLI     │        │ Run      │        │          │
    └──────────┘        └──────────┘        └──────────┘
```

### 3.2 Data Flow

```
1. User runs command (manual/scheduler/backfill)
           │
           ▼
2. Load config from forecast_config.json
           │
           ▼
3. UnifiedForecastService.generateForecast()
           │
           ├─► Run calibration (System B)
           │   • Auto-detect recent actuals
           │   • Iterate until convergence
           │   • Store in calibration_history
           │
           ├─► Generate CFAC forecast
           │   • Wind: 4-Tier MREC Hybrid
           │   • Solar: Physics+ML Hybrid
           │   • Other: Profile-based
           │
           ├─► Generate Demand forecast
           │   • Hybrid model
           │   • XGBoost calibration
           │
           └─► Output
               • Save to output directory
               • Archive (if enabled)
               • Push to gateway (if enabled)
```

---

## 4. Global Configuration

### 4.1 Config File Location

```
project_root/
├── forecast_config.json    ← Global settings (NEW)
├── config.json             ← Gateway credentials (existing)
├── forecast.db             ← Runtime data only
└── ...
```

### 4.2 Config Schema

```json
{
  "version": 1,

  "paths": {
    "demandTraining": "Data Samples/Demand",
    "cfacTraining": "Data Samples/Capacity Factor",
    "output": "./output",
    "archive": "./output/archive",
    "weatherCache": "./weather_cache"
  },

  "databases": {
    "scheduler": "./forecast.db",
    "regionalDemand": "./data/iload.db",
    "zonalDemand": "./data/iload_zonal.db"
  },

  "calibration": {
    "enabled": true,
    "days": 7,
    "threshold": 5,
    "maxIterations": 10
  },

  "cfac": {
    "useXgboost": false,
    "asymmetricLoss": false,
    "biasCorrection": false
  },

  "demand": {
    "model": "hybrid",
    "geography": "regional",
    "growthRate": 0
  },

  "weather": {
    "maxAgeHours": 6,
    "refreshMode": "auto"
  },

  "output": {
    "archiveEnabled": true,
    "retentionDays": 90,
    "naming": "gateway"
  },

  "gateway": {
    "enabled": false,
    "autoPush": false
  },

  "scheduler": {
    "enabled": false,
    "runTimes": ["06:00"],
    "runDays": [1, 2, 3, 4, 5, 6, 7],
    "forecastTypes": ["demand", "cfac"],
    "horizons": ["daily", "weekly"]
  }
}
```

### 4.3 TypeScript Interface

```typescript
// src/types/config.ts

export interface GlobalForecastConfig {
  version: number;

  paths: {
    demandTraining: string;
    cfacTraining: string;
    output: string;
    archive: string;
    weatherCache: string;
  };

  databases: {
    scheduler: string;
    regionalDemand: string;
    zonalDemand: string;
  };

  calibration: {
    enabled: boolean;
    days: number;
    threshold: number;
    maxIterations: number;
  };

  cfac: {
    useXgboost: boolean;
    asymmetricLoss: boolean;
    biasCorrection: boolean;
  };

  demand: {
    model: 'hybrid' | 'regression' | 'xgboost';
    geography: 'regional' | 'zonal';
    growthRate: number;
  };

  weather: {
    maxAgeHours: number;
    refreshMode: 'auto' | 'always' | 'never';
  };

  output: {
    archiveEnabled: boolean;
    retentionDays: number;
    naming: 'gateway' | 'legacy';
  };

  gateway: {
    enabled: boolean;
    autoPush: boolean;
  };

  scheduler: {
    enabled: boolean;
    runTimes: string[];
    runDays: number[];
    forecastTypes: ('demand' | 'cfac')[];
    horizons: ('daily' | 'weekly')[];
  };
}
```

### 4.4 Config Service

```typescript
// src/services/configService.ts

export class ConfigService {
  private configPath: string;
  private config: GlobalForecastConfig;

  constructor(configPath?: string);

  // Load config from JSON file
  load(): GlobalForecastConfig;

  // Save config to JSON file
  save(): void;

  // Get current config
  get(): GlobalForecastConfig;

  // Update config values (dot notation: "calibration.days")
  set(key: string, value: any): void;

  // Reset to defaults
  reset(): void;

  // Validate config structure
  validate(): { valid: boolean; errors: string[] };

  // Get default config
  static getDefaults(): GlobalForecastConfig;
}
```

---

## 5. CLI Commands

### 5.1 New `config` Command Group

```bash
# View all settings
node dist/index.js config get

# View specific section
node dist/index.js config get calibration
node dist/index.js config get cfac

# Set values (dot notation)
node dist/index.js config set calibration.days 14
node dist/index.js config set cfac.useXgboost true
node dist/index.js config set demand.geography zonal

# Reset to defaults
node dist/index.js config reset

# Validate config
node dist/index.js config validate
```

### 5.2 Simplified `cfac forecast2`

**Before:**
```bash
node dist/index.js cfac forecast2 \
  -t "Data Samples/Capacity Factor" \
  -s 2026-01-01 -e 2026-01-31 \
  -o output/cfac.csv \
  --auto-calibrate 14 \
  --use-xgboost \
  --asymmetric-loss \
  --cache ./weather_cache
```

**After:**
```bash
# Uses global config - much simpler
node dist/index.js cfac forecast2 \
  -s 2026-01-01 -e 2026-01-31 \
  -o output/cfac.csv

# Per-run overrides still available
node dist/index.js cfac forecast2 \
  -s 2026-01-01 -e 2026-01-31 \
  -o output/cfac.csv \
  --no-calibrate \
  --use-xgboost
```

**Options kept (per-run):**
- `-s, --start` (required)
- `-e, --end` (required)
- `-o, --output` (required)
- `--no-calibrate` (skip for this run)
- `--use-xgboost` (override)
- `--asymmetric-loss` (override)
- `--bias-correction` (override)

**Options removed (now in config):**
- `-t, --training` → `config.paths.cfacTraining`
- `--cache` → `config.paths.weatherCache`
- `--auto-calibrate [days]` → `config.calibration.days`
- `--scale-wind`, `--scale-solar` → Handled by calibration

### 5.3 Simplified `forecast` (Demand)

**Before:**
```bash
node dist/index.js forecast \
  -d "Data Samples/Demand" \
  -s 2026-01-01 -e 2026-01-31 \
  -o output/demand.csv \
  --model hybrid \
  --lstm-correction
```

**After:**
```bash
# Uses global config
node dist/index.js forecast \
  -s 2026-01-01 -e 2026-01-31 \
  -o output/demand.csv

# Per-run overrides
node dist/index.js forecast \
  -s 2026-01-01 -e 2026-01-31 \
  -o output/demand.csv \
  --zonal \
  --model xgboost
```

**Options removed:**
- `-d, --demand` → `config.paths.demandTraining`
- `--lstm-correction` → Feature removed (didn't help)

### 5.4 Simplified `scheduler backfill`

**Before:**
```bash
node dist/index.js scheduler backfill \
  -s 2026-01-01 -e 2026-01-15 \
  --calib-days 7 \
  --calib-threshold 5 \
  --max-iterations 3 \
  --demand-only
```

**After:**
```bash
# Uses global config - just specify dates
node dist/index.js scheduler backfill \
  -s 2026-01-01 -e 2026-01-15

# With filters
node dist/index.js scheduler backfill \
  -s 2026-01-01 -e 2026-01-15 \
  --demand-only \
  --daily
```

**Options removed:**
- `--calib-days` → `config.calibration.days`
- `--calib-threshold` → `config.calibration.threshold`
- `--max-iterations` → `config.calibration.maxIterations`
- `--use-saved-calibration` → Removed (always fresh calibration)

### 5.5 Commands to Remove

| Command | Action |
|---------|--------|
| `cfac forecast` | Delete entirely |
| `cfac forecast3` | Delete entirely |
| `scheduler config` | Replace with `config` command |

---

## 6. GUI Overhaul

### 6.1 New Tab Structure

```
┌─────────────────────────────────────────────────────────────────┐
│  Tabs: Dashboard | Forecast | Settings | History | Logs         │
└─────────────────────────────────────────────────────────────────┘
```

### 6.2 Settings Tab (Global Config)

All settings in one place - applies to manual, scheduler, and backfill.

```
┌─────────────────────────────────────────────────────────────────┐
│                        SETTINGS                                  │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌─ Calibration ────────────┐  ┌─ CFAC Options ───────────────┐ │
│  │  [✓] Enabled             │  │  [ ] Use XGBoost             │ │
│  │  Days: [7]               │  │  [ ] Asymmetric Loss         │ │
│  │  Threshold: [5] %        │  │  [ ] Bias Correction         │ │
│  │  Max Iterations: [10]    │  │                              │ │
│  └──────────────────────────┘  └──────────────────────────────┘ │
│                                                                  │
│  ┌─ Demand Options ─────────┐  ┌─ Output ─────────────────────┐ │
│  │  Model: [Hybrid ▼]       │  │  [✓] Archive Forecasts       │ │
│  │  Geography: [Regional ▼] │  │  Retention: [90] days        │ │
│  │  Growth Rate: [0] %      │  │  Naming: [Gateway ▼]         │ │
│  └──────────────────────────┘  └──────────────────────────────┘ │
│                                                                  │
│  ┌─ Paths ──────────────────┐  ┌─ Gateway ────────────────────┐ │
│  │  Demand: [Data Samples/] │  │  [✓] Enabled                 │ │
│  │  CFAC: [Data Samples/]   │  │  [ ] Auto-push after run     │ │
│  │  Output: [./output]      │  │  Host: [gateway.example.com] │ │
│  │  Weather: [./weather_ca] │  │  [Test Connection]           │ │
│  └──────────────────────────┘  └──────────────────────────────┘ │
│                                                                  │
│  [Save Settings]  [Reset to Defaults]  [Export...]  [Import...] │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### 6.3 Forecast Tab (Unified Interface)

```
┌─────────────────────────────────────────────────────────────────┐
│                        FORECAST                                  │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Mode: (•) Manual  ( ) Scheduler  ( ) Backfill                  │
│                                                                  │
│  ═══════════════════════════════════════════════════════════════│
│                                                                  │
│  Date Range                                                      │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │  Start: [2026-03-12]  End: [2026-03-18]  (7 days)          ││
│  └─────────────────────────────────────────────────────────────┘│
│                                                                  │
│  Forecast Types                                                  │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │  [✓] Demand    [✓] Capacity Factor (CFAC)                  ││
│  └─────────────────────────────────────────────────────────────┘│
│                                                                  │
│  Horizons                                                        │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │  [✓] Daily (D+1)    [✓] Weekly (D+7)                       ││
│  └─────────────────────────────────────────────────────────────┘│
│                                                                  │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │                    [▶ Run Forecast]                         ││
│  └─────────────────────────────────────────────────────────────┘│
│                                                                  │
│  Output Preview                                                  │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │  • demand_daily_2026-03-13.csv                              ││
│  │  • demand_weekly_2026-03-13_2026-03-19.csv                  ││
│  │  • cfac_daily_2026-03-13.csv                                ││
│  │  • cfac_weekly_2026-03-13_2026-03-19.csv                    ││
│  └─────────────────────────────────────────────────────────────┘│
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### 6.4 Scheduler Mode (Same Tab, Different Options)

```
│  Mode: ( ) Manual  (•) Scheduler  ( ) Backfill                  │
│                                                                  │
│  ═══════════════════════════════════════════════════════════════│
│                                                                  │
│  Schedule                                                        │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │  Run at: [06:00 ▼] PHT                                      ││
│  │  Days: [✓]M [✓]T [✓]W [✓]T [✓]F [✓]S [✓]S                  ││
│  └─────────────────────────────────────────────────────────────┘│
│                                                                  │
│  Status: ● Running | Next: 2026-03-12 06:00 PHT                 │
│                                                                  │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │  [▶ Start Service]  [⏸ Stop]  [▶ Run Now]                  ││
│  └─────────────────────────────────────────────────────────────┘│
```

---

## 7. Implementation Plan

### Phase 1: Foundation (No Breaking Changes)

**Estimated scope:** Create infrastructure, keep existing code working

**Tasks:**
1. Create `src/types/config.ts` - GlobalForecastConfig interface
2. Create `src/services/configService.ts` - Config management
3. Create `forecast_config.json` with defaults
4. Add `config` CLI command group to `src/index.ts`
5. Update documentation

**Test:** All existing commands still work unchanged

### Phase 2: Unified Forecast Service

**Estimated scope:** Create single forecast entry point

**Tasks:**
1. Create `src/services/unifiedForecastService.ts`
2. Extract calibration logic from ForecastSchedulerService
3. Integrate config service
4. Add methods: `generateForecast()`, `runCalibration()`

**Test:** New service produces identical output to existing

### Phase 3: CLI Migration

**Estimated scope:** Connect CLI to unified service

**Tasks:**
1. Modify `cfac forecast2` to use UnifiedForecastService
2. Modify `forecast` to use UnifiedForecastService
3. Modify `scheduler run` to use UnifiedForecastService
4. Modify `scheduler backfill` to use UnifiedForecastService
5. Remove deprecated options from commands
6. Delete `cfac forecast` command
7. Delete `cfac forecast3` command
8. Remove System A calibration code (lines 3270-3500)

**Test:** Full CLI test suite

### Phase 4: Code Cleanup

**Estimated scope:** Remove unused code

**Tasks:**
1. Delete `src/models/capacityFactor/WindLSTMModel.ts`
2. Delete `src/models/capacityFactor/SolarLSTMModel.ts`
3. Delete `scripts/cfac_forecast_lstm.cjs` (if exists)
4. Remove `--lstm-correction` from demand forecast
5. Remove `scheduler config` command (replaced by `config`)
6. Clean up unused imports

**Test:** Build succeeds, no dead code

### Phase 5: GUI Overhaul

**Estimated scope:** Restructure GUI

**Tasks:**
1. Create Settings component
2. Create unified Forecast component with mode selector
3. Update IPC handlers in `main.ts`
4. Remove duplicate settings from old components
5. Update state management

**Test:** Full GUI testing

### Phase 6: Documentation

**Estimated scope:** Update all docs

**Tasks:**
1. Update `CLAUDE.md`
2. Update `CLI_GUIDE.md`
3. Update `GUI_GUIDE.md`
4. Update `QUICK_START.md`
5. Archive old planning docs

---

## 8. Files Reference

### 8.1 Files to Create

| File | Purpose |
|------|---------|
| `forecast_config.json` | Global configuration |
| `src/types/config.ts` | Config interface |
| `src/services/configService.ts` | Config management |
| `src/services/unifiedForecastService.ts` | Unified forecast entry |

### 8.2 Files to Modify

| File | Changes |
|------|---------|
| `src/index.ts` | Add config commands, simplify forecast commands, remove legacy |
| `src/services/forecastSchedulerService.ts` | Refactor to use unified service |
| `gui/electron/main.ts` | Update IPC handlers |
| `gui/src/App.vue` | Restructure tabs and state |

### 8.3 Files to Delete

| File | Reason |
|------|--------|
| `src/models/capacityFactor/WindLSTMModel.ts` | Underperforms hybrid |
| `src/models/capacityFactor/SolarLSTMModel.ts` | Underperforms hybrid |
| `scripts/cfac_forecast_lstm.cjs` | Based on deleted models |

### 8.4 Code to Remove (in src/index.ts)

| Lines | Description |
|-------|-------------|
| ~1796-2198 | `cfac forecast` command (legacy) |
| ~3270-3500 | System A calibration (inline in cfac forecast2) |
| **8441+** | `cfac forecast3` command (EMA smoothing) |
| 2232 | `--lstm-correction` option (in demand forecast) |

### 8.5 CFAC Model Files Audit (33 files)

**KEEP - Production Models (11 files):**
| File | Purpose |
|------|---------|
| `WindEnhancedHybridModel.ts` | **PRIMARY** - 4-Tier MREC Hybrid for wind |
| `Wind4TierMRECModel.ts` | MREC tier logic |
| `Wind4TierHybridModel.ts` | 4-Tier hybrid variant |
| `SolarHybridModel.ts` | **PRIMARY** - Physics+ML Hybrid for solar |
| `SolarIrradianceModel.ts` | Physics base for solar |
| `ProfileBasedModel.ts` | Profile-based for other types |
| `HydroModel.ts` | Hydro-specific |
| `GeothermalModel.ts` | Geothermal-specific |
| `BiomassModel.ts` | Biomass-specific |
| `BatteryModel.ts` | Battery-specific |
| `BiasCorrector.ts` | Station-specific bias correction |

**KEEP - Supporting (8 files):**
| File | Purpose |
|------|---------|
| `WindMRECModel.ts` | Base MREC algorithm |
| `WindPowerCurve.ts` | Power curve calculations |
| `CFacXGBoostRegressor.ts` | XGBoost ML layer |
| `ModelRouter.ts` | Model selection logic |
| `index.ts` | Exports |
| `SolarMRECModel.ts` | Solar MREC variant |
| `WindShearModel.ts` | Wind shear calculations |
| `WindBiasCorrectionModel.ts` | Wind bias helper |

**DELETE - LSTM (4 files):**
| File | Reason |
|------|--------|
| `WindLSTMModel.ts` | Underperforms hybrid |
| `SolarLSTMModel.ts` | Underperforms hybrid |
| `LSTMForecaster.ts` | LSTM infrastructure |
| `WeatherCorrectionLSTM.ts` | LSTM correction layer |

**REVIEW - Possibly Obsolete (10 files):**
| File | Status |
|------|--------|
| `WindMRECHybridModel.ts` | May be superseded by Enhanced |
| `WindWeatherHybridModel.ts` | May be superseded |
| `WindHybridModel.ts` | May be superseded |
| `WindPhysicsMRECModel.ts` | May be superseded |
| `WindPhysicsHybridModel.ts` | May be superseded |
| `WindCubicModel.ts` | Experimental |
| `WindWeibullModel.ts` | Experimental |
| `SolarMRECHybridModel.ts` | May be superseded |
| `SolarPremiumHybridModel.ts` | May be superseded |
| `SolarSeasonalMRECModel.ts` | May be superseded |

**Action:** Audit usage in Phase 4 before deletion. Check if imported anywhere.

---

## Appendix A: Additional Considerations

### A.1 Config Migration Strategy

**Current state:** `scheduler_config` table in `forecast.db`

**Migration approach:**
1. On first run of new version, detect if `scheduler_config` exists
2. If exists and `forecast_config.json` doesn't exist:
   - Export `scheduler_config` values to `forecast_config.json`
   - Log migration success
3. If both exist:
   - JSON takes precedence (user may have edited it)
4. `scheduler_config` table remains for backward compatibility but is READ-ONLY
5. Future versions can delete the table

```typescript
// In configService.ts
migrateFromDatabase(): void {
  const dbConfig = this.loadSchedulerConfigFromDb();
  if (dbConfig && !existsSync(this.configPath)) {
    const jsonConfig = this.convertDbToJson(dbConfig);
    this.save(jsonConfig);
    console.log('Migrated scheduler_config to forecast_config.json');
  }
}
```

### A.2 Weather Refresh Mode Integration

**Current System A modes:**
- `cache` - Use cached weather only
- `refresh` - Refresh if older than maxAgeHours (default)
- `force-refresh` - Always fetch fresh weather

**Integration into unified service:**
```typescript
// In forecast_config.json
"weather": {
  "maxAgeHours": 6,
  "refreshMode": "auto"  // auto | always | never
}

// Mapping:
// "auto" = current "refresh" behavior (check age)
// "always" = current "force-refresh"
// "never" = current "cache"
```

**Per-run override:** `--refresh-weather` flag forces fresh fetch regardless of config.

### A.3 Interconnector Commands

**Status:** Keep as-is (not part of this refactoring)

| Command | Purpose | Change |
|---------|---------|--------|
| `interconnector train` | Train interconnector model | None |
| `interconnector forecast` | Generate interconnector forecast | None |

**Rationale:**
- Interconnector is a separate forecasting domain
- Uses different data (not demand/CFAC)
- Not part of the scheduler automation
- Can be unified later if needed

### A.4 GUI IPC Handler Audit (for Phase 5)

**Key handlers to update in `gui/electron/main.ts`:**

| Handler | Current | After |
|---------|---------|-------|
| `load-scheduler-config` | Reads from DB | Read from JSON |
| `save-scheduler-config` | Writes to DB | Write to JSON |
| `run-scheduler-manual` | Spawns CLI with many args | Spawns CLI with fewer args |
| `get-recent-runs` | Unchanged | Unchanged |
| `get-calibrations` | Unchanged | Unchanged |

**New handlers to add:**
| Handler | Purpose |
|---------|---------|
| `load-global-config` | Load `forecast_config.json` |
| `save-global-config` | Save `forecast_config.json` |
| `validate-config` | Validate config structure |
| `reset-config` | Reset to defaults |

---

## Appendix B: Migration Checklist

### Before Starting
- [ ] Backup current codebase
- [ ] Document current test outputs for comparison
- [ ] Note any custom configurations users might have

### Phase 1 Checklist
- [ ] `src/types/config.ts` created
- [ ] `src/services/configService.ts` created
- [ ] `forecast_config.json` created with defaults
- [ ] `config get/set/reset/validate` commands working
- [ ] Existing commands unchanged

### Phase 2 Checklist
- [ ] `UnifiedForecastService` created
- [ ] Calibration logic extracted
- [ ] Service produces correct output

### Phase 3 Checklist
- [ ] `cfac forecast2` uses unified service
- [ ] `forecast` uses unified service
- [ ] `scheduler run` uses unified service
- [ ] `scheduler backfill` uses unified service
- [ ] `cfac forecast` deleted
- [ ] `cfac forecast3` deleted
- [ ] System A calibration removed

### Phase 4 Checklist
- [ ] `WindLSTMModel.ts` deleted
- [ ] `SolarLSTMModel.ts` deleted
- [ ] `--lstm-correction` removed
- [ ] Build succeeds
- [ ] No unused imports

### Phase 5 Checklist
- [ ] Settings tab created
- [ ] Forecast tab unified
- [ ] IPC handlers updated
- [ ] GUI fully functional

### Phase 6 Checklist
- [ ] `CLAUDE.md` updated
- [ ] `CLI_GUIDE.md` updated
- [ ] `GUI_GUIDE.md` updated
- [ ] `QUICK_START.md` updated

---

## Appendix C: Rollback Plan

If issues arise during implementation:

1. **Phase 1-2:** No risk - additive changes only
2. **Phase 3:** Keep backup of original command handlers
3. **Phase 4:** Git history preserves deleted files
4. **Phase 5:** GUI changes can be reverted via git

---

*Document maintained by: Development Team*
*Approved for implementation: 2026-03-11*
