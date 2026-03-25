---
Status: Active
Created: 2026-03-22
Type: Decision Record (append-only)
---

# Architectural Decisions and Corrections

This document records architectural decisions, bug discoveries, and corrections for the Vantage Forecaster project. Entries are append-only — never edit past entries. If a decision is reversed, add a new entry explaining the reversal.

---

## DEC-001: Removed LSTM Components (2026-03-21)

**Decision:** Remove all LSTM-based forecasting components in favor of XGBoost-only approach.

**Context:** LSTM models were initially explored for both demand and capacity factor forecasting. After extensive testing, XGBoost and physics-based hybrid models consistently outperformed LSTM approaches.

**Rationale:**
- XGBoost hybrid models achieved better accuracy for demand forecasting (2-4% MAPE vs LSTM's higher variance)
- Wind 4-Tier Hybrid and Solar Physics+ML models outperformed LSTM for capacity factor forecasting
- LSTM training time was significantly longer with no accuracy benefit
- Model complexity and maintenance burden not justified by results

**Impact:**
- Deleted files: WindLSTMModel.ts, SolarLSTMModel.ts, LSTMForecaster.ts, WeatherCorrectionLSTM.ts, DemandCorrectionLSTM.ts
- Removed `--lstm-correction` CLI flag
- Simplified model architecture and training pipeline
- Reduced dependencies and deployment size

**Status:** Implemented

---

## DEC-002: Geography Routing for Demand Forecasts (2026-03-05)

**Decision:** Implement regional and zonal geography routing for demand forecasts.

**Context:** Vantage Gateway v2.5.0 requires demand forecasts to be separated into regional (3 regions) and zonal (14 sub-regions) subdirectories for proper routing and consumption by downstream systems.

**Rationale:**
- Apollo clients consume regional forecasts for system-wide planning
- Distribution planner requires zonal forecasts for sub-regional dispatch
- Gateway HTTP API requires explicit `geography` parameter for validation
- Mixing geographies in a single directory caused routing errors

**Impact:**
- SFTP routing: Regional files → `/demand/regional/`, Zonal files → `/demand/zonal/`
- HTTP API: Explicit `geography: "regional"` or `geography: "zonal"` parameter
- Scheduler configuration: `demandGeography` option (regional, zonal, both)
- GUI: Geography dropdown in Automation Settings

**Status:** Implemented

---

## DEC-003: GUI Calibration Architecture (2026-03-21)

**Decision:** Calibration configuration lives in GUI Settings tab only, not duplicated in Manual or Scheduler tabs.

**Context:** Auto-calibration is a global setting that affects all forecasts (manual and scheduled). Duplicating calibration controls across multiple tabs creates consistency issues and user confusion.

**Rationale:**
- Calibration is a training-time decision, not a per-run override
- Settings tab is the single source of truth for all configuration
- Manual and Scheduler tabs should not expose training hyperparameters
- Reduces UI complexity and prevents configuration drift

**Impact:**
- Settings tab: Calibration toggles for per-station, per-hour, global bias
- Manual tab: No calibration controls (uses Settings values)
- Scheduler tab: No calibration controls (uses Settings values)
- All forecasts use calibration settings from `forecast_config.json`

**Status:** Implemented

---

## DEC-004: SQLite for Local Configuration Storage (2026-03-05)

**Decision:** Use SQLite databases for local configuration, model registry, and forecast history.

**Context:** The application needed persistent storage for configuration, trained models, and forecast metadata without requiring external database infrastructure.

**Rationale:**
- SQLite provides ACID transactions for data integrity
- Zero-configuration embedded database suitable for desktop application
- Better-sqlite3 library provides synchronous API compatible with Electron main process
- Supports complex queries for model management and forecast history
- Portable — database files travel with the application

**Impact:**
- `forecast.db`: Forecast history, scheduler configuration, weather cache metadata
- `models/registry.db`: Model registry, training runs, model groups
- `iload.db`: Regional demand data (3 regions)
- `iload_zonal.db`: Zonal demand data (14 sub-regions)

**Status:** Implemented

---

## DEC-005: Wind Per-Station Calibration Disabled (2026-03-22)

**Decision:** Disable per-station calibration for wind stations, use global bias correction only.

**Context:** Initial implementation included per-station calibration for both wind and solar. Testing showed solar benefited significantly (10.7% MAPE reduction), but wind showed overcorrection issues.

**Rationale:**
- Wind patterns are highly variable between seasons (e.g., December calibration period doesn't generalize to January forecast period)
- Per-station wind calibration caused overcorrection, increasing MAPE in some cases
- Solar patterns are more stable due to predictable diurnal cycles
- Global bias correction for wind provides stable, modest improvement without overcorrection risk

**Impact:**
- Wind models use global bias correction only (applied to all wind stations uniformly)
- Solar models use global bias + per-hour + per-station calibration (all three layers)
- Calibration code paths differentiate between wind and solar station types

**Status:** Implemented

---

## DEC-006: Model Training vs Inference Separation (2026-03-22)

**Decision:** Strict separation between training mode (Manual tab) and inference mode (Scheduler tab).

**Context:** Initially, the scheduler could both train new models and run inference. This created confusion about when models were being retrained and led to unpredictable forecast behavior.

**Rationale:**
- Training is expensive (10-30 minutes) and should be deliberate, not automatic
- Users need to review model performance before activating for production
- Scheduler must be fast and predictable for daily automation
- Inference-only scheduler prevents accidental retraining with stale data

**The Pipeline:**
1. **Manual Tab** (Training) — Train model, review metrics, save as instance
2. **Models Tab** (Review) — Examine per-zone/region MAPE, activate when satisfied
3. **Scheduler Tab** (Inference) — Load frozen weights, fetch new weather, generate forecast

**Hard Rules:**
- Scheduler NEVER trains models — always requires `--use-model <id>`
- Saved model instances are immutable (frozen weights, frozen calibration)
- One active model per entity type (activating new model deactivates previous)
- GUI prevents scheduler from running without activated model

**Impact:**
- CLI: `scheduler run` requires `--use-model <id>` parameter
- GUI: Scheduler tab blocked until model is activated
- Training happens 1-2 times per week (manual), inference runs daily (automated)

**Status:** Implemented

---

## BUG-001: CFAC Inference Mode Weather Cache Issue (2026-03-22)

**Issue:** When running CFAC forecasts for future dates using saved models (inference mode), the Visual Crossing API returned incomplete weather data for 100m hub-height wind measurements. This caused wind forecasts to use fallback values, resulting in constant/flat predictions.

**Symptoms:**
- Wind forecasts showed constant values (e.g., 42-43% CF every day) instead of natural variation
- Weather cache files for future dates were significantly smaller than historical (~1.7KB vs ~3KB)
- Hourly data rows contained empty values: `2026-01-10T01:00:00,,,,,,,,,,`

**Root Cause:** The Visual Crossing API provides limited forecast data for specialized parameters (100m wind speed, hub-height data) beyond 7-15 days in the future. For dates beyond forecast horizon, API returns empty/incomplete data.

**Solution:** After forecast dates have passed, refresh the weather cache to fetch actual observed data:
```bash
# Delete incomplete future weather cache
rm -rf weather_cache/WIND_*/YYYY-MM/YYYY-MM-DD*.csv

# Re-run forecast to fetch fresh (now historical) weather
node dist/index.js cfac forecast2 ... -s YYYY-MM-DD -e YYYY-MM-DD
```

**Impact Example (Jan 2026 Wind):**
| Metric | Stale Cache | Fresh Cache | Improvement |
|--------|-------------|-------------|-------------|
| Wind MAPE | 53.24% | 48.18% | -5.1 points |
| Wind MAE | 0.1448 | 0.1135 | -21.6% |

**Best Practice:** For accurate forecast evaluation against actuals, always refresh weather cache after forecast dates have passed.

**Status:** Documented in CLAUDE.md Known Issues section

---

## BUG-002: MessagePack Array Deserialization (2026-03-22)

**Issue:** Demand model deserialization failed with "state.profiles is not iterable" error when loading saved HybridModel instances.

**Root Cause:** MessagePack serialization converts JavaScript arrays to objects with numeric keys when deserializing. The HybridModel.fromJSON() method expected arrays but received objects.

**Example:**
```javascript
// Before serialization
profiles: [{ region: 'CLUZ', data: [...] }]

// After MessagePack round-trip
profiles: { '0': { region: 'CLUZ', data: {...} } }
```

**Solution:** Added Array.isArray() checks with Object.values() fallback in HybridModel.fromJSON():
```typescript
const profiles = Array.isArray(state.profiles)
  ? state.profiles
  : Object.values(state.profiles);
```

**Files Fixed:**
- `src/models/hybridModel.ts` (lines 853-882)

**Status:** Fixed

---

## DEC-007: Remove Hardcoded Weekend Correction Factors (2026-03-24)

**Decision:** Remove all hardcoded weekend correction factors and learn them fresh from training data every time.

**Context:** The HybridModel had hardcoded weekend correction factors for CLUZ, CVIS, CMIN (lines 82-86) that were set once in the past and never updated. The `learnWeekendCorrections` method skipped these regions because they already had values.

**Previous Behavior:**
```typescript
// Hardcoded values that never updated
private weekendCorrectionFactors = new Map([
  ['CLUZ', { saturday: 0.947, sunday: 0.951 }],  // ← Always stale!
  ['CVIS', { saturday: 1.009, sunday: 0.980 }],
  ['CMIN', { saturday: 0.999, sunday: 1.018 }],
]);

// Line 227 - skipped learning for regions with hardcoded values
if (this.weekendCorrectionFactors.has(region)) continue;
```

**Rationale:**
- Hardcoded values become stale as demand patterns evolve
- Weekend behavior varies seasonally and year-to-year
- Zones needed to inherit parent region corrections but hardcoded values prevented this
- Fresh learning from training data is always more accurate than historical static values

**New Behavior:**
- All weekend corrections learned fresh from training data every time
- No hardcoded defaults — if insufficient data (< 4 samples), factor defaults to 1.0
- Zones that don't have enough data fall back to parent region corrections

**Files Changed:**
- `src/models/hybridModel.ts` (removed hardcoded Map initialization, updated learnWeekendCorrections)

**Status:** Implemented

---

## BUG-003: Zonal Demand Peak Shape Mismatch (2026-03-24)

**Issue:** Zonal demand forecasts (14 sub-regions) produced peak shapes that didn't match training data or historical actuals. Users reported flattened or averaged peak patterns instead of zone-specific demand curves.

**Symptoms:**
- Zone forecasts showed generic/averaged peak shapes instead of zone-specific patterns
- Weekend corrections weren't being applied to zones (only CLUZ, CVIS, CMIN)
- Some forecasts could silently use another zone's profile

**Root Cause:** Three issues in `src/models/hybridModel.ts`:

1. **Weekend corrections only for 3 regions** (line 82-86) — Hardcoded weekend correction factors existed only for CLUZ, CVIS, CMIN. Zones like 01NLUZ never got corrections applied.

2. **No parent region fallback** (line 558-566) — When a zone didn't have learned weekend corrections, the code simply applied no correction instead of falling back to the parent region's correction.

3. **Dangerous profile fallback** (line 517-522) — If the exact `${region}_${hour}_${dayType}` profile wasn't found, the code searched for ANY profile matching the hour/dayType pattern. This could return a profile from a completely different zone, causing incorrect peak shapes.

**Solution:**

1. Added `ZONE_TO_PARENT_REGION` mapping that maps all 14 zones to their parent regions (CLUZ, CVIS, CMIN)

2. Updated `predictForRegion()` to fall back to parent region weekend corrections when zone-specific corrections aren't available

3. Removed dangerous profile fallback in `predict()` — now returns `undefined` instead of picking the wrong zone's profile

**Files Changed:**
- `src/models/hybridModel.ts`

**Impact:**
- Zonal forecasts now maintain zone-specific peak shapes from training data
- Weekend corrections apply correctly via parent region fallback
- No more silent profile mismatches causing incorrect demand curves

**Status:** Fixed

---

## DEC-008: Demand V2 Shape/Level Architecture Adoption (2026-03-24)

**Decision:** Implement Demand V2 architecture with explicit shape/level separation for all demand forecasting (regional and zonal).

**Context:** V1 demand forecasting directly predicted hourly MW values using XGBoost with quantile loss calibration. This approach had several limitations:
- Shapes were implicit side-effects rather than explicit targets
- No guarantee that hourly predictions formed physically plausible daily profiles
- Weekend corrections required hardcoded factors that became stale
- Zone-specific shape patterns were difficult to preserve
- Peak-crushing occurred (peaks regressed toward mean, troughs lifted)

**Rationale:**
- Separating "how much" (daily total) from "when" (hourly shape) makes each prediction easier and more accurate
- Shapes normalized to sum to 1.0 by construction guarantee physical plausibility
- Archetype clustering preserves zone-specific peak patterns instead of averaging them away
- Hierarchical smoothing allows zones to inherit parent region patterns when data is sparse
- Weather-based shape adjustments capture hour-specific weather effects (morning ramp, evening cool)
- Lifecycle separation (Train → Calibrate → Forecast) enables reproducible inference without retraining

**New Architecture (V2):**

**Data Layer:**
- `DataMerger.ts`: Join demand+weather, align timestamps (weather +1hr for hour-ending), average weather per area
- `DailyAggregator.ts`: Transform hourly records into daily totals + normalized shapes + weather summaries

**Level Model** (daily total prediction):
- `LevelModel.ts`: XGBoost with 22 features (daily weather, calendar, lags, area index)
- Target: single daily total MW
- Features: avgTemp, maxTemp, CDH, totalPrecip, avgCloudCover, totalSolar, tempRange, dayType one-hot, month cyclical, lag features (yesterday, last week, rolling 7d/30d, trend)
- Statistical fallback for <30 days training data

**Shape Model** (24-hour profile prediction):
- **Stage A** (`ProfileLibrary.ts`): k-means clustering into archetypes per {area, dayType}
  - 3 archetypes by default (captures distinct peak patterns: sharp, plateau, shifted)
  - Stores centroid weather, sample count, peak-to-trough ratio
  - Hierarchical smoothing: zones blend with parent region when sample count < 50
  - At inference: select nearest archetype by weather distance, blend with overall median
- **Stage B** (`ShapeAdjuster.ts`): Per-hour linear regression on weather trajectory features
  - Features: peakTempHour, morningRampRate, eveningCoolRate, tempRange, avgTemp, avgCloudCover, isDaytimeRain
  - Learns residuals (actual shape - base shape) per hour
  - Applies `weatherInfluence` multiplier (default 1.0) for tunable adjustment strength
- **Orchestrator** (`ShapeModel.ts`): Combines Stage A+B with archetype blending (default 0.8)
  - Final shape = (total × levelScale) × (calibratedShape)
  - All shapes validated to sum to 1.0

**Phase 1 Implementation (Completed):**
- Data layer: DataMerger, DailyAggregator
- Level Model: XGBoost with lag features
- Shape Model: ProfileLibrary (k-means archetypes + hierarchical smoothing), ShapeAdjuster (per-hour linear regression)
- TypeScript compilation verified (npm run build successful)

**Phase 2 Implementation (Pending):**
- Calibration pipeline: level scale + shape correction factors
- ForecastCombiner: multiply level × shape + sanity checks
- AmplitudeMonitor: peak-to-trough validation
- TrainPipeline, CalibratePipeline, ForecastPipeline orchestrators
- ModelSerializer: .vfm binary format + calibration.json
- CLI integration: `train`, `calibrate`, `forecast` commands
- RetrainMonitor: drift detection triggers

**Implementation Files:**
- `src/data/DataMerger.ts`
- `src/data/DailyAggregator.ts`
- `src/models/LevelModel.ts`
- `src/models/ProfileLibrary.ts`
- `src/models/ShapeAdjuster.ts`
- `src/models/ShapeModel.ts`

**Architecture Reference:**
- `Documents/planning/DEMAND_FORECAST_V2_ARCHITECTURE.md` - Complete V2 specification

**V1 Components Retained (for backward compatibility during migration):**
- `src/models/hybridModel.ts` - V1 hybrid model (will be replaced by V2 in Phase 5)
- `src/models/xgboostModel.ts` - V1 XGBoost model (will be replaced by V2 in Phase 5)
- Existing CLI commands continue to use V1 until V2 cutover

**Status:** Phase 1 Implemented (Data Layer + Models), Phase 2 Pending

---

## DEC-009: CFAC V2 Phase 2 - Asymmetric Solar Loss and Model Consolidation (2026-03-24)

**Decision:** Implemented Phase 2 improvements for CFAC V2: asymmetric loss default for solar, model consolidation, and legacy file organization.

**Context:** CFAC V2 Phase 1 established the Train → Calibrate → Forecast lifecycle. Phase 2 focused on model improvements and code organization to align with the V2 architecture spec.

**Rationale:**
- **Asymmetric Loss:** Solar under-prediction is more costly for grid planning than over-prediction (committed generation that doesn't materialize forces thermal backup). Quantile loss with α=0.65 penalizes under-predictions ~1.9x more than over-predictions.
- **Model Consolidation:** V1 had 5+ wind models and 4+ solar models. V2 consolidates to ONE recommended model per type for clarity and maintainability.
- **Legacy Organization:** Moving old models to `legacy/` preserves backward compatibility while clearly marking them as deprecated.

**Implementation Details:**

1. **Asymmetric Loss (SolarHybridModel.ts):**
   - Changed `train()` method default: `asymmetricLoss = true` (was `false` in V1)
   - Added `solarAlpha` parameter (default 0.65)
   - Implemented quantile loss via weighted duplication: under-predictions get `α/(1-α)` copies
   - α=0.65 → 1.86x weight for under-predictions
   - Configurable range: 0.50 (symmetric) to 0.80 (strongly anti-under-prediction)

2. **Wind Per-Station Calibration:**
   - Already enabled in Phase 1 `CfacCalibratePipeline.ts`
   - Computes global bias + 24 hourly scale factors per wind station
   - Clamped to `windScaleClamp` [0.50, 2.00]

3. **Model Consolidation:**
   - **Wind:** `WindHybridModel.ts` now aliases `Wind4TierHybridModel` (MREC + ML hybrid)
   - **Solar:** `SolarHybridModel.ts` remains recommended (Physics + ML + hourly calibration)
   - **Profile:** `ProfileBasedModel.ts` for hydro/geothermal/biomass/battery
   - Legacy models moved to `src/models/capacityFactor/legacy/`:
     - `WindMRECModel.ts`, `WindEnhancedHybridModel.ts`, `WindWeatherHybridModel.ts`
     - `SolarIrradianceModel.ts`, `SolarMRECHybridModel.ts`, `SolarPremiumHybridModel.ts`
     - Original `WindHybridModel.ts` (power curve version → `WindHybridModelLegacy`)
   - Created `legacy/index.ts` for backward compatibility exports
   - Updated `src/models/capacityFactor/index.ts` with clear V2/Legacy sections

4. **Deferred Tasks:**
   - **Stale cache detection:** Complex weather cache metadata system with low ROI for Phase 2
   - **V2 CLI commands:** Phase 1 pipelines are fully functional; CLI registration can follow in Phase 3

**Impact:**
- Solar forecasts will now bias toward slightly higher predictions to avoid under-forecasting
- Wind calibration captures diurnal patterns (was disabled in V1 due to seasonal variability concerns)
- Codebase is cleaner with single recommended model per type
- Legacy models remain accessible for backward compatibility and reference

**Files Changed:**
- `src/models/capacityFactor/SolarHybridModel.ts` (asymmetric loss default + quantile implementation)
- `src/models/capacityFactor/WindHybridModel.ts` (created as alias to Wind4TierHybridModel)
- `src/models/capacityFactor/index.ts` (reorganized exports, added legacy section)
- `src/models/capacityFactor/legacy/*` (7 models moved)
- Import path updates in files referencing moved models

**Status:** Implemented (with 2 tasks deferred to Phase 3)

---

## DEC-009: GUI V2 Settings Tab — Nested Configuration Structure (2026-03-24)

**Decision:** Implement V2 nested configuration structure in Settings tab per `GUI_V2_ARCHITECTURE.md` Section 6.

**Context:** V2 architecture introduced detailed tuning knobs for demand forecasting (level/shape separation, archetype blending, weather influence) and CFAC forecasting (solar alpha, temperature coefficients, per-station calibration). The V1 Settings tab only exposed top-level settings (model type, geography, basic calibration).

**Rationale:**
- V2 demand pipeline has 20+ tunable parameters across level model, shape model, calibration, and training stages
- CFAC V2 has separate solar and wind tuning parameters
- Lifecycle management requires retrain schedules and drift thresholds
- Users need GUI access to these settings without editing forecast_config.json manually
- Nested structure matches V2 CLI command configuration and V2 config schema

**Implementation:**
- Added 10 new config sections to Settings tab:
  1. Demand V2: Level Model (model type, max depth, n estimators)
  2. Demand V2: Shape Model (archetype count, blending, weather influence, peak bias, confidence threshold, adjustment model)
  3. Demand V2: Calibration (days, level/shape clamps, peak bias)
  4. Demand V2: Training (training days, lag warmup days)
  5. CFAC V2: Solar (solar alpha, temperature coefficient, scale clamps)
  6. CFAC V2: Wind (per-station calibration, scale clamps)
  7. CFAC V2: Training/Calibration (training days, calibration days)
  8. Lifecycle Settings (demand/CFAC retrain schedules, auto-retrain toggle)
  9. Drift Thresholds (level, shape, solar scale, wind bias drift with consecutive cycles threshold)
  10. All sliders show real-time values with proper formatting
- Defensive initialization: `loadGlobalConfig()` adds V2 nested defaults if missing
- All settings saved to `forecast_config.json` with nested structure matching V2 config schema

**Impact:**
- Settings tab now has 40+ configuration fields (up from ~15 in V1)
- V2 config backward compatible: V1 configs get V2 defaults added automatically
- All V2 tuning knobs accessible without manual JSON editing
- Settings persist across GUI restarts via `forecast_config.json`
- GUI compilation: 0 TypeScript errors, builds successfully

**Files Changed:**
- `gui/src/App.vue`: Added V2 config sections (lines 5766-6289), updated `loadGlobalConfig()` with defensive initialization
- `CHANGELOG.md`: Added Settings Tab V2 entry
- `context.md`: Marked Settings Tab as complete

**Status:** Implemented

---

## DEC-011: V2 CLI Flag Conflict Resolution (2026-03-24)

**Decision:** Rename calibration file flag from `-c, --calibration` to `-cal, --calibration` in `v2:forecast` command.

**Context:** Phase A fixes required adding `--config <file>` flag to all V2 commands for custom config file path. This created a flag conflict in `v2:forecast` which already used `-c` for calibration file.

**Rationale:**
- Standard practice: `-c, --config` is widely used for config files across CLI tools
- Commander.js prevents duplicate short flags in the same command
- Using `-cal` for calibration file maintains clarity while avoiding conflict
- Long form `--calibration` remains unchanged for backward compatibility scripts

**Implementation:**
- Changed `v2:forecast` flag from `-c, --calibration <file>` to `-cal, --calibration <file>`
- Added `-c, --config <file>` flag to `v2:train`, `v2:calibrate`, `v2:forecast`
- Added `--verbose` flag to all V2 commands
- Added `--zonal` and `--regional` flags to `v2:train` for geography mode selection
- Updated `TrainPipelineConfig`, `CalibratePipelineConfig`, `ForecastPipelineConfig` interfaces

**Impact:**
- Breaking change: Users using `-c` shorthand for calibration file must switch to `-cal` or use `--calibration`
- New capability: All V2 commands can now load custom config files via `--config`
- Consistency: All V2 commands follow same flag pattern (--config, --verbose)

**Files Changed:**
- `src/index.ts`: Updated v2:train, v2:calibrate, v2:forecast command definitions
- `src/pipeline/TrainPipeline.ts`: Added isZonal, configPath, verbose to interface
- `src/pipeline/CalibratePipeline.ts`: Added configPath, verbose to interface
- `src/pipeline/ForecastPipeline.ts`: Added configPath, verbose to interface
- `CHANGELOG.md`: Added Phase A fixes entry
- `context.md`: Marked Phase A as complete

**Status:** Implemented

---

## DEC-012: V2 Config Schema Integration (2026-03-24)

**Decision:** Add V2-specific configuration schema to `forecast_config.json` for advanced V2 architecture tuning parameters.

**Context:** V2 architecture introduced numerous tuning parameters for demand forecasting (level/shape separation, archetype clustering, calibration clamps) and CFAC forecasting (asymmetric loss, temperature coefficients, retrain monitoring). These settings were hardcoded in pipeline files, making them difficult to adjust without code changes.

**Rationale:**
- Centralized configuration allows users to tune V2 behavior without editing code
- Default values reflect empirically tested settings from V2 architecture spec
- Settings are optional — defaults are provided if section is missing (backward compatibility)
- ConfigService getter methods provide type-safe access with guaranteed defaults
- Deep merge strategy ensures partial V2 configs work correctly

**Implementation:**
- Added `V2Config` interface with two sections:
  - `v2.demand`: Training period (90d), lag warmup (7d), calibration (7d), k-means clusters (4), level model feature list (21 features), smoothing threshold (50 samples), default model/calibration paths
  - `v2.cfac`: Training period (120d), calibration (14d), solar asymmetric loss alpha (0.65), wind/solar hourly scale clamps, temperature coefficient (0.004), confidence threshold (50 samples), default model/calibration paths, retrain monitor settings (enabled, MAPE thresholds, cache staleness)
- Added `v2?: V2Config` optional field to `GlobalForecastConfig` interface
- ConfigService.getDefaults() includes complete V2 section with all defaults
- ConfigService.mergeWithDefaults() performs deep merge including nested `retrainMonitor` object
- Added three getter methods:
  - `getV2DemandConfig()`: Returns demand V2 config with defaults
  - `getV2CfacConfig()`: Returns CFAC V2 config with defaults
  - `getV2RetrainMonitorConfig()`: Returns retrain monitor config with defaults
- Updated `forecast_config.json` with V2 section showing default values

**Impact:**
- V2 pipelines can now read configuration from centralized source instead of hardcoded values
- Users can tune V2 behavior through Settings tab or by editing `forecast_config.json`
- V1 configs remain compatible — V2 section is optional
- All V2 defaults match values specified in V2 architecture documents

**Files Changed:**
- `src/types/config.ts`: Added `V2Config` interface, updated `GlobalForecastConfig`
- `src/services/configService.ts`: Added V2 defaults, deep merge logic, getter methods
- `forecast_config.json`: Added v2 section with defaults
- `CHANGELOG.md`: Added V2 Config Schema Integration entry
- `context.md`: Updated Phase B progress

**Status:** Implemented

---
