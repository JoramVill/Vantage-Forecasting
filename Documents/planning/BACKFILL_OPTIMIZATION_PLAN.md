# Backfill Optimization & Gateway Fix Plan

**Created:** 2026-03-12
**Status:** Ready for Implementation
**Priority:** High

---

## Executive Summary

This plan addresses critical inefficiencies in the backfill system and fixes the zonal/regional demand generation issue. The current backfill retrains models unnecessarily, lacks progress visibility, and has a gateway bug where zonal demand isn't generated when "both" is selected.

---

## Problems Identified

### Problem 1: Redundant Model Training (Critical)
- **Issue:** Each CLI spawn trains models from scratch
- **Impact:** 4-19x slower than necessary
- **Location:** `forecastSchedulerService.ts` spawns CLI via `execSync`

### Problem 2: Daily/Weekly Duplicate Training
- **Issue:** Daily and weekly forecasts train identical models separately
- **Impact:** 2x unnecessary training per date
- **Location:** `runCalibratedForecasts()` calls separate CLI for each horizon

### Problem 3: No Progress Bar
- **Issue:** User has no visibility into backfill progress
- **Impact:** Poor UX, can't estimate completion time
- **Location:** Backfill loop in `src/index.ts` lines 8578-8602

### Problem 4: Poor Terminal Output
- **Issue:** Verbose output with no filtering/sorting options
- **Impact:** Hard to find errors, overwhelming output
- **Location:** Various console.log statements

### Problem 5: Gateway Zonal Bug (Critical)
- **Issue:** Only regional demand generated, not zonal when "both" selected
- **Impact:** Missing zonal forecasts for gateway
- **Location:** `forecastSchedulerService.ts` - demand geography handling

---

## Implementation Tasks

### Phase 1: Investigation & Quick Fixes

#### Task 1.1: Fix Gateway Zonal Bug
**Priority:** Critical
**Files:**
- `src/services/forecastSchedulerService.ts`
- `src/index.ts` (scheduler commands)

**Investigation:**
- Find where `demand_geography` is read from config
- Check if "both" mode generates two forecasts or one
- Verify database path selection logic

**Expected Fix:**
- When geography = "both", run demand forecast twice (regional + zonal)
- Ensure correct database paths are used for each

#### Task 1.2: Add Progress Bar
**Priority:** High
**Files:**
- `src/index.ts` (backfill command)
- New: progress bar utility

**Implementation:**
- Add `cli-progress` or similar package
- Show: current date, total dates, elapsed time, ETA
- Display per-phase progress (calibration, forecasts)

#### Task 1.3: Add Terminal Filtering Options
**Priority:** Medium
**Files:**
- `src/index.ts` (scheduler backfill)

**Implementation:**
- Add `--quiet` flag (already exists, verify working)
- Add `--log-level <level>` (error, warn, info, debug)
- Add `--summary-only` (only show final summary)

### Phase 2: Efficiency Optimizations

#### Task 2.1: Combine Daily/Weekly Forecasts
**Priority:** High
**Files:**
- `src/services/forecastSchedulerService.ts`
- `src/index.ts`

**Implementation:**
- Modify `runCalibratedForecasts()` to train once per type
- Generate both horizons from same trained model
- Pass trained model object instead of spawning CLI twice

#### Task 2.2: Add Model Caching
**Priority:** High
**Files:**
- `src/models/capacityFactor/SolarHybridModel.ts`
- `src/models/capacityFactor/WindEnhancedHybridModel.ts`
- `src/models/hybridModel.ts`
- New: `src/services/modelCacheService.ts`

**Implementation:**
- Create model serialization/deserialization
- Hash training data to create cache keys
- Load cached models if training data unchanged
- Save models after training

#### Task 2.3: Batch Mode for Backfill
**Priority:** Medium
**Files:**
- `src/services/forecastSchedulerService.ts`
- `src/index.ts`

**Implementation:**
- New `--batch` flag for backfill
- Train models once at start
- Apply to all dates in range
- Only fetch weather per-date (cached anyway)

### Phase 3: Architecture Improvements

#### Task 3.1: Direct Service Calls (Remove execSync)
**Priority:** Medium
**Files:**
- `src/services/forecastSchedulerService.ts`
- `src/services/unifiedForecastService.ts`

**Implementation:**
- Replace `execSync` calls with direct service method calls
- Keep models in memory across forecast runs
- Significant performance improvement

#### Task 3.2: Parallel Execution
**Priority:** Low
**Files:**
- `src/services/forecastSchedulerService.ts`

**Implementation:**
- Run demand and CFAC forecasts in parallel (different models)
- Use Promise.all for concurrent execution
- Respect system resources

---

## Task Checklist

### Phase 1: Quick Fixes
- [ ] 1.1 Fix Gateway Zonal Bug - generate both regional AND zonal when "both" selected
- [ ] 1.2 Add progress bar to backfill command
- [ ] 1.3 Add `--log-level` and `--summary-only` flags

### Phase 2: Efficiency
- [ ] 2.1 Combine daily/weekly forecast generation (train once)
- [ ] 2.2 Implement model caching service
- [ ] 2.3 Add batch mode for backfill

### Phase 3: Architecture
- [ ] 3.1 Replace execSync with direct service calls
- [ ] 3.2 Enable parallel demand/CFAC execution

---

## Success Metrics

| Metric | Current | Target |
|--------|---------|--------|
| CLI spawns per date (no saved calib) | ~19 | ~2 |
| CLI spawns per date (saved calib) | 4 | 1 |
| Training per 7-day backfill | ~28-133 | 2 |
| Zonal forecasts when "both" | 0 | Generated |
| Progress visibility | None | Full progress bar |

---

## Risk Assessment

| Risk | Mitigation |
|------|------------|
| Model caching produces stale results | Hash training data, invalidate cache on change |
| Breaking existing CLI interface | Maintain backward compatibility, add new flags |
| Performance regression | Benchmark before/after each change |

---

## Implementation Order

1. **Task 1.1** - Fix zonal bug (critical functionality)
2. **Task 1.2** - Add progress bar (quick UX win)
3. **Task 2.1** - Combine horizons (biggest efficiency gain)
4. **Task 1.3** - Terminal filtering (quick UX improvement)
5. **Task 2.2** - Model caching (significant speedup)
6. **Task 3.1** - Direct service calls (architecture improvement)
7. **Task 2.3** - Batch mode (additional optimization)
8. **Task 3.2** - Parallel execution (final polish)

---

*Document created: 2026-03-12*
