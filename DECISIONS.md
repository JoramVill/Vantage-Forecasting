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
