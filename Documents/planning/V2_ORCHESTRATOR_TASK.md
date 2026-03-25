# V2 Architecture Implementation — Orchestrator Task

## Objective

Implement the Vantage Forecaster V2 architecture across three parallel workstreams:
- **Demand V2**: Shape/Level demand forecasting model
- **CFAC V2**: Capacity factor model with hourly calibration
- **GUI V2**: Updated Electron GUI for the new Train → Calibrate → Forecast lifecycle

Architecture documents are in `Documents/planning/`:
- `DEMAND_FORECAST_V2_ARCHITECTURE.md` — Complete Demand V2 spec
- `CFAC_FORECAST_V2_ARCHITECTURE.md` — Complete CFAC V2 spec
- `GUI_V2_ARCHITECTURE.md` — Complete GUI V2 spec

**Read the full architecture document before starting any workstream. Every interface, data contract, formula, and file structure is specified. Do not deviate from the spec without documenting why.**

---

## Critical Context

- TypeScript/Node.js project. Build with `npm run build`. Must compile with zero TS errors.
- Philippine power grid (WESM). 3 regions (CLUZ, CVIS, CMIN) or 14 zones (01NLUZ...14SWMIN).
- Weather from Visual Crossing API. Hour-starting timestamps. Demand uses hour-ending. Add 1 hour to weather timestamps for alignment.
- Tropical climate: base temp 24°C for CDH. No heating demand.
- Existing V1 code is in `src/`. V2 code goes alongside — do NOT delete V1 code until V2 is validated.
- The GUI (`gui/`) is Electron + Vue 3. It calls CLI via IPC child_process. **Zero forecast logic in the GUI.**
- Test data exists: `Data Samples/Demand/` has hourly demand CSVs. `Data Samples/Capacity Factor/` has hourly CFac CSVs.
- Read `CLAUDE.md` and `Documents/AI_AGENT_GUIDE.md` before starting work.

---

## Workstream Definitions

### Workstream A: Demand V2 (Priority: Highest)

**Spec**: `Documents/planning/DEMAND_FORECAST_V2_ARCHITECTURE.md`

**Deliverables** (in order):

1. **Data Layer** — `src/data/DataMerger.ts`, `src/data/DailyAggregator.ts`
   - Parse demand CSVs (hour-ending format: `DateTimeEnding,01NLUZ,02METRO,...`)
   - Parse weather CSVs (hour-starting format: `name,latitude,longitude,datetime,temp,...`)
   - Shift weather timestamps +1 hour for alignment
   - Average weather across stations per area (using zone-to-station mapping from `src/data/zones.json`)
   - Aggregate into daily records: dailyTotal, normalized 24h shape (must sum to 1.0), daily weather summary, hourly weather trajectory
   - Calendar features: dayType (workday/saturday/sunday/holiday), month. Use existing `date-holidays` package for Philippine holidays.
   - **Validate**: shapes sum to 1.0 for every area × day. Run against December 2025 demand data.

2. **Level Model** — `src/models/LevelModel.ts`
   - XGBoost predicting daily total MW per area
   - Features: ~22 (daily weather aggregates + calendar + lags + areaIdx). See spec Section 5.3.
   - Lag features: totalYesterday, totalLastWeek, totalRolling7d, totalRolling30d, trendWeek
   - 7-day lag warmup period (skip first 7 days of training data)
   - Chronological 80/20 train/validation split
   - Fallback for <30 days: statistical median × temp coefficient
   - **Validate**: daily total MAPE < 5% on validation set

3. **Shape Model** — `src/models/ShapeModel.ts`, `src/models/ProfileLibrary.ts`, `src/models/ShapeAdjuster.ts`
   - **Stage A (ProfileLibrary)**: k-means clustering into archetypes per {area, dayType}. Default k=3.
     - Store: archetype shapes (24 values summing to 1.0), centroid weather conditions, sample counts, peak-to-trough ratios
     - Hierarchical smoothing: `α = min(1.0, sampleCount / 50)`. Blend with parent region when sparse.
     - Parent mapping: zones → CLUZ/CVIS/CMIN (see spec Section 5.4.1)
   - **Stage B (ShapeAdjuster)**: Linear regression per hour on weather trajectory features
     - Features: peakTempHour, morningRampRate, eveningCoolRate, tempRange, avgTemp, avgCloudCover, isDaytimeRain
     - Apply `weatherInfluence` multiplier (default 1.0) to adjustments
     - Renormalize to sum to 1.0 after adjustment
   - Archetype selection: Euclidean distance on normalized weather features to cluster centroids
   - Blending: `baseShape = archetypeBlending × archetype + (1-archetypeBlending) × overallMedian` (default 0.8)
   - **Validate**: shape MAPE < 4%, peak hour accuracy ±1 hour, profile correlation > 0.93

4. **Combiner + Calibrator + Monitor** — `src/models/ForecastCombiner.ts`, `src/models/Calibrator.ts`, `src/models/AmplitudeMonitor.ts`
   - Combiner: `hourly = dailyTotal × shape[h]`. Sanity clamp to [0.3×, 2.0×] historical median.
   - Level calibration: `levelScale[area] = mean(actualTotal / predictedTotal)` over calibration days. Clamp to `levelClamp` (default [0.90, 1.10]).
   - Shape calibration: `shapeCorrection[area][h] = mean(actualShape[h] / predictedShape[h])`. Asymmetric clamp controlled by `peakBias` (default 0.3). See spec Section 5.6.2 for clamp formula. Renormalize after applying.
   - Amplitude monitor: compute `max(shape)/min(shape)`, compare against historical percentile range. Default mode "monitor" (log only).
   - **Validate**: combined hourly MAPE < 4% on validation period

5. **Pipelines + CLI** — `src/pipeline/TrainPipeline.ts`, `src/pipeline/CalibratePipeline.ts`, `src/pipeline/ForecastPipeline.ts`, `src/pipeline/ModelSerializer.ts`
   - Three CLI commands: `train`, `calibrate`, `forecast`
   - `train` produces `model.vfm` (MessagePack serialized — use existing serialization pattern from V1 `modelStore.ts`)
   - `calibrate` produces `calibration.json` with levelScale, shapeCorrection, recentActuals (for lag features), and diagnostic metrics
   - `forecast` reads model.vfm + calibration.json + weather forecast, produces CSV in same format as demand input
   - Forecast is stateless — no access to demand data directory
   - Register commands in `src/index.ts` using Commander.js (follow existing patterns)
   - **Validate**: end-to-end `train → calibrate → forecast` produces valid CSV output

6. **Metrics** — `src/metrics/LevelMetrics.ts`, `src/metrics/ShapeMetrics.ts`, `src/metrics/HourlyMetrics.ts`, `src/metrics/RetrainMonitor.ts`
   - Level: MAPE, MAE, bias per area
   - Shape: shapeMAPE, peak hour accuracy, profile correlation, amplitude ratio per area
   - Hourly: combined MAPE (the final number)
   - Retrain monitor: check calibration factors against drift thresholds (see spec Section 3.5)

**Dependencies**: Workstream A has no dependencies on B or C. It can run fully independently.

**Key libraries**: Use existing project dependencies. `mathjs` for statistics, `luxon` for dates, `better-sqlite3` if DB needed. For k-means, implement a simple version (it's 24-dimensional vectors, small datasets — no library needed). For XGBoost, check if `xgboost-node` or equivalent is already in the project, otherwise use the linear regression approach from V1 as a starting point and note that XGBoost needs to be added.

---

### Workstream B: CFAC V2 (Priority: High)

**Spec**: `Documents/planning/CFAC_FORECAST_V2_ARCHITECTURE.md`

**Deliverables** (in order):

1. **Lifecycle Separation** — `src/pipeline/CfacTrainPipeline.ts`, `src/pipeline/CfacCalibratePipeline.ts`, `src/pipeline/CfacForecastPipeline.ts`, `src/pipeline/CfacModelSerializer.ts`
   - Three CLI commands: `cfac train`, `cfac calibrate`, `cfac forecast`
   - `cfac train` trains all station models, saves to `cfac_model.vfm`
   - `cfac calibrate` computes per-station correction factors, saves to `cfac_calibration.json`
   - `cfac forecast` is stateless inference: model + calibration + weather → CSV
   - Reuse existing model code: `Wind4TierHybridModel`, `SolarHybridModel`, `ProfileBasedModel`
   - The models themselves don't change — only the lifecycle wrapping changes
   - Register new commands in `src/index.ts`
   - **Validate**: `cfac train → cfac calibrate → cfac forecast` produces same-format CSV as V1 `cfac forecast2`

2. **Hourly Solar Calibration** — Update calibration logic in `CfacCalibratePipeline.ts`
   - Replace scalar bias with per-hour scale factors per solar station
   - `hourlyScale[h] = mean(actual[h] / predicted[h])` for generating hours; 0 for night hours
   - Clamp to `solarScaleClamp` (default [0.50, 1.50])
   - Store in `cfac_calibration.json` solar section
   - **Validate**: solar midday MAPE improves by 3-5 percentage points vs V1

3. **Asymmetric Solar Loss** — Update `SolarHybridModel.ts` or the XGBoost training
   - Make asymmetric loss the default for solar ML residual layer
   - Quantile loss with α = 0.65 (configurable as `solarAlpha`)
   - **Validate**: under-prediction rate drops from ~60% to ~50% of generating hours

4. **Wind Per-Station Calibration** — Update calibration logic
   - Enable per-station hourly calibration for wind (V1 had this disabled)
   - Same structure as solar: globalBias + hourlyScale[24] per station
   - Clamp to `windScaleClamp` (default [0.50, 2.00])
   - **Validate**: wind stations with strong diurnal patterns show MAPE improvement

5. **Model Consolidation** — File reorganization
   - Rename `Wind4TierHybridModel.ts` → `WindHybridModel.ts`
   - Keep `SolarHybridModel.ts`, `ProfileBasedModel.ts`
   - Move all other model files to `src/models/capacityFactor/legacy/`
   - Update `ModelRouter.ts` (or equivalent) to use consolidated models
   - Update imports throughout

6. **Stale Cache Detection** — Update `src/services/weatherService.ts`
   - Tag cache entries with `fetchedAt` timestamp
   - During calibration (processing past dates), re-fetch if the data date is before the fetch date
   - Add `cache_meta.json` alongside weather cache files

**Dependencies**: Workstream B has no dependencies on A or C. Existing V1 model code is sufficient.

**Important**: Do NOT rewrite the wind or solar models. The core forecasting logic is retained. The work is lifecycle wrapping, calibration improvements, and file organization.

---

### Workstream C: GUI V2 (Priority: Normal — starts after A and B CLI commands exist)

**Spec**: `Documents/planning/GUI_V2_ARCHITECTURE.md`

**Deliverables** (in order):

1. **Operations Tab** — Replace Manual tab in `gui/src/App.vue` (or component equivalent)
   - Three panels: Train, Calibrate, Forecast
   - Each panel constructs CLI args and calls `window.electronAPI.runCommand(args)`
   - Shared terminal output area at bottom
   - Forecast type selector: Demand (Regional), Demand (Zonal), CFAC
   - See spec Section 2.2 for wireframe, Section 3.1 for CLI command construction

2. **Updated Models Tab** — Expand to manage both .vfm and calibration.json
   - List models with associated calibrations
   - Show V2 metrics: shapeMAPE, peakHourAccuracy, profileCorrelation (for demand)
   - "Calibrate Now" button per model
   - "Set as Scheduler Active" for both model and calibration
   - See spec Section 5 for wireframe and data model

3. **Scheduler Updates** — Add auto-calibrate + calibration file reference
   - Scheduler now requires both `--demand-model` + `--demand-calibration` + cfac equivalents
   - Auto-calibrate check: if calibration file age > threshold, run `calibrate` CLI before `forecast`
   - "Refresh Calibration Now" button
   - Calibration age display
   - See spec Section 4 for full logic

4. **Settings Updates** — New V2 configuration fields
   - Add demand shape tuning knobs: archetypeCount, archetypeBlending, weatherInfluence, peakBias
   - Add CFAC tuning knobs: solarAlpha, tempCoefficient, perStationCalibration toggle
   - Add lifecycle settings: retrainSchedule, calibrationSchedule, drift thresholds
   - Map to updated `forecast_config.json` structure (spec Section 6)

**Dependencies**: C depends on A and B CLI commands existing. The GUI wraps CLI — if the commands don't exist, the GUI has nothing to call. Start C only after workstreams A and B have their CLI commands registered and building.

**Workaround**: C can start on Settings tab and Models tab structure (data model updates) while waiting for A/B CLI commands. The Operations tab and Scheduler wiring require working CLI commands.

---

## Shared Constraints

### Configuration

All three workstreams read from a single `forecast_config.json`. The V2 schema is defined in `GUI_V2_ARCHITECTURE.md` Section 6.1. Ensure the config structure is consistent across all workstreams. If workstream A reads `config.demand.shape.archetypeCount`, workstream C must write to the same path.

### Model Serialization

Both Demand and CFAC produce `.vfm` files using MessagePack. Use the same serialization approach as V1 (`src/services/modelStore.ts`). The `.vfm` format should include a version field and entityType so the system can distinguish demand models from CFAC models.

### CLI Registration

All new CLI commands go in `src/index.ts` using Commander.js. Follow existing patterns. Do not create a separate entry point. The command structure:

```
node dist/index.js train ...           (Demand V2 train)
node dist/index.js calibrate ...       (Demand V2 calibrate)
node dist/index.js forecast ...        (Demand V2 forecast — replaces V1 forecast)
node dist/index.js cfac train ...      (CFAC V2 train)
node dist/index.js cfac calibrate ...  (CFAC V2 calibrate)
node dist/index.js cfac forecast ...   (CFAC V2 forecast — replaces V1 cfac forecast2)
```

V1 commands (`forecast` with `--model hybrid`, `cfac forecast2`) must continue to work during migration. Add V2 commands alongside, don't overwrite.

### TypeScript Compilation

**Every deliverable must compile with `npm run build` and zero errors.** If you're adding new files, ensure they're properly imported and exported. If you're using a new npm package, add it with `npm install`.

### Testing

No automated test suite exists. Validate by:
1. `npm run build` — compiles
2. Run CLI command with test data — produces output
3. Output matches expected format (CSV schema, value ranges)
4. Metrics are in expected ranges (MAPE < target for each model)

Test data locations:
- Demand: `Data Samples/Demand/DemHr_2025_DEC.csv` (and other months)
- CFAC: `Data Samples/Capacity Factor/MRHCFac_*.csv`
- Weather: fetched via Visual Crossing API (cache in `weather_cache/`)

---

## Execution Order

```
Phase 1 (Parallel): Workstream A steps 1-3 + Workstream B steps 1-2
  - Demand data layer, level model, shape model
  - CFAC lifecycle separation, hourly solar calibration
  - These have zero overlap in files touched

Phase 2 (Parallel): Workstream A steps 4-6 + Workstream B steps 3-5
  - Demand combiner, calibrator, pipelines, CLI
  - CFAC asymmetric loss, wind calibration, model consolidation
  - Start Workstream C settings + models tab structure

Phase 3 (Sequential): Workstream C steps 1-4
  - GUI Operations tab (requires A+B CLI commands)
  - Scheduler updates
  - Integration testing

Phase 4: End-to-end validation
  - train → calibrate → forecast for both demand and CFAC
  - GUI wraps all commands correctly
  - Scheduler auto-calibrate works
```

---

## File Ownership (Conflict Prevention)

**Workstream A owns:**
```
src/models/LevelModel.ts (new)
src/models/ShapeModel.ts (new)
src/models/ProfileLibrary.ts (new)
src/models/ShapeAdjuster.ts (new)
src/models/ForecastCombiner.ts (new)
src/models/Calibrator.ts (new)
src/models/AmplitudeMonitor.ts (new)
src/data/DataMerger.ts (new)
src/data/DailyAggregator.ts (new)
src/features/DailyFeatures.ts (new)
src/features/ShapeFeatures.ts (new)
src/features/LagProvider.ts (new)
src/features/CalendarFeatures.ts (new)
src/pipeline/TrainPipeline.ts (new)
src/pipeline/CalibratePipeline.ts (new)
src/pipeline/ForecastPipeline.ts (new)
src/pipeline/ModelSerializer.ts (new)
src/metrics/LevelMetrics.ts (new)
src/metrics/ShapeMetrics.ts (new)
src/metrics/HourlyMetrics.ts (new)
src/metrics/RetrainMonitor.ts (new)
```

**Workstream B owns:**
```
src/pipeline/CfacTrainPipeline.ts (new)
src/pipeline/CfacCalibratePipeline.ts (new)
src/pipeline/CfacForecastPipeline.ts (new)
src/pipeline/CfacModelSerializer.ts (new)
src/metrics/CfacMetrics.ts (new)
src/metrics/CfacRetrainMonitor.ts (new)
src/models/capacityFactor/WindHybridModel.ts (rename from Wind4TierHybridModel.ts)
src/models/capacityFactor/ProfileModel.ts (rename from ProfileBasedModel.ts)
src/models/capacityFactor/legacy/ (new directory, moved files)
```

**Workstream C owns:**
```
gui/src/App.vue (modify)
gui/src/components/ (modify/add)
gui/electron/main.ts (modify — IPC handlers)
gui/electron/preload.ts (modify — new API methods)
```

**Shared files (coordinate changes):**
```
src/index.ts — A adds demand V2 commands, B adds cfac V2 commands. Do not edit simultaneously.
forecast_config.json — Config schema. A and B read, C writes the Settings UI. Agree on schema first.
src/services/weatherService.ts — B may modify for stale cache. A reads only.
src/data/zones.json — Read-only for both A and B.
```

For `src/index.ts`: Workstream A adds its commands first (in a block), then Workstream B adds its commands (in a separate block). Do not interleave.

---

## Completion Criteria

Each workstream is complete when:

1. All deliverables compile with `npm run build` (zero TS errors)
2. CLI commands execute against test data and produce valid output
3. Output CSV format matches the data contracts in the architecture docs
4. Metrics meet targets specified in each deliverable's validate step
5. V1 commands still work (no regressions)
6. Files are in the locations specified in the architecture docs
7. Subagent summary is provided with FILES_CHANGED, WARNINGS, and DOCS_NEEDING_REVIEW

---

## Post-Implementation

After all three workstreams complete:

1. Run full integration test: `train → calibrate → forecast` for demand and CFAC
2. Compare V2 output vs V1 output on same date range
3. Update `CLAUDE.md` with V2 pipeline rules (replace Train/Inference with Train/Calibrate/Forecast)
4. Update `Documents/AI_AGENT_GUIDE.md` with new file locations and commands
5. Update `CHANGELOG.md`
6. Archive V1 methodology docs to `Documents/archive/`
