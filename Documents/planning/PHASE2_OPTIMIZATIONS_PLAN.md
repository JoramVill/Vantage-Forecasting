# Phase 2: Performance Optimizations Plan

## Overview
After completing GUI enhancements (Phase 1), these optimizations will reduce forecast generation time and improve efficiency.

## Task 1: Combine Daily/Weekly Forecasts

### Current Behavior
For each date, the scheduler spawns 4 separate CLI processes:
1. Daily demand forecast
2. Weekly demand forecast
3. Daily CFAC forecast
4. Weekly CFAC forecast

**Problem:** Each process trains models independently, wasting computation time.

### Proposed Solution
Modify `src/services/forecastSchedulerService.ts` to:
1. Train models once per forecast type (demand/cfac)
2. Generate both daily and weekly outputs from the same trained model
3. Reduce CLI spawns from 4 to 2 per date

**Expected Impact:**
- 50% reduction in model training time
- Faster scheduler runs (especially for backfill)
- Lower CPU usage during forecast generation

### Implementation Steps

1. **Update `runCalibratedForecasts()` function:**
   ```typescript
   // Before:
   await runDemandForecast(date, 'daily');
   await runDemandForecast(date, 'weekly');

   // After:
   await runDemandForecast(date, ['daily', 'weekly']); // Both horizons
   ```

2. **Modify forecast CLI commands:**
   - Add `--horizons daily,weekly` flag
   - Update forecast service to accept multiple horizons
   - Generate both outputs in one pass

3. **Update database tracking:**
   - Track both horizons in single run record
   - Archive both files together

## Task 2: Model Caching Service

### Current Behavior
Every forecast run trains models from scratch, even when using the same training data.

**Problem:** Redundant training wastes time, especially during frequent scheduler runs.

### Proposed Solution
Create a model caching service that:
1. Saves trained models to disk after first training
2. Loads from cache if training data hasn't changed
3. Invalidates cache when data changes (hash-based detection)

### Implementation Steps

1. **Create `src/services/modelCacheService.ts`:**
   ```typescript
   export class ModelCacheService {
     private cacheDir: string;

     async saveModel(key: string, model: any, metadata: any): Promise<void>
     async loadModel(key: string): Promise<{ model: any; metadata: any } | null>
     async getCacheKey(dataPath: string, config: any): Promise<string>
     async invalidateCache(pattern?: string): Promise<void>
   }
   ```

2. **Cache Key Generation:**
   - Hash training data file contents (MD5 or SHA256)
   - Include model configuration in hash
   - Format: `{type}_{dataHash}_{configHash}.cache`

3. **Integration Points:**
   - Demand model training (`src/models/hybridModel.ts`)
   - CFAC model training (`src/models/capacityFactor/*.ts`)
   - CLI forecast commands

4. **Cache Invalidation:**
   - Check file modification time
   - Compare hash of current data vs cached metadata
   - Auto-cleanup old cache files (>30 days)

5. **Storage Structure:**
   ```
   models/cache/
   ├── demand_abc123_xyz789.cache
   ├── cfac_def456_uvw012.cache
   └── metadata.json
   ```

**Expected Impact:**
- 70-90% faster forecast generation for unchanged data
- Instant forecasts when using recent training data
- Configurable cache expiration

### Cache Metadata Format
```json
{
  "type": "demand",
  "created": "2026-03-12T10:30:00Z",
  "dataHash": "abc123...",
  "configHash": "xyz789...",
  "trainingPeriod": {
    "start": "2025-01-01",
    "end": "2026-01-31"
  },
  "performance": {
    "mape": 4.77,
    "mae": 120.5
  }
}
```

## Task 3: CLI Progress Output Enhancement

### Current Behavior
CLI outputs verbose messages but no structured progress data.

**Problem:** GUI can't accurately track progress, ETA calculation impossible.

### Proposed Solution
Add structured progress messages to CLI output:
```
[PROGRESS] 3/10 dates | Current: 2026-01-03 | ETA: 5m 30s
```

### Implementation Steps

1. **Update scheduler backfill logic:**
   ```typescript
   const startTime = Date.now();
   for (let i = 0; i < dates.length; i++) {
     const avgTimePerDate = (Date.now() - startTime) / (i || 1);
     const remaining = dates.length - i;
     const eta = formatDuration(avgTimePerDate * remaining);

     console.log(`[PROGRESS] ${i+1}/${dates.length} dates | Current: ${dates[i]} | ETA: ${eta}`);

     await processDate(dates[i]);
   }
   ```

2. **Add ETA calculation helper:**
   ```typescript
   function formatDuration(ms: number): string {
     const minutes = Math.floor(ms / 60000);
     const seconds = Math.floor((ms % 60000) / 1000);
     return `${minutes}m ${seconds}s`;
   }
   ```

3. **Files to modify:**
   - `src/services/forecastSchedulerService.ts`
   - `src/commands/schedulerCommands.ts`

**Expected Impact:**
- Accurate progress tracking in GUI
- Better user experience with ETA display
- Easier to estimate long-running backfill operations

## Implementation Priority

1. **CLI Progress Output** (Quickest win)
   - Estimated time: 30 minutes
   - Immediate GUI benefit
   - No architecture changes

2. **Combine Daily/Weekly** (Medium complexity)
   - Estimated time: 2-3 hours
   - Significant performance gain
   - Requires testing both horizons

3. **Model Caching** (Most complex)
   - Estimated time: 4-6 hours
   - Largest performance gain
   - Requires careful cache invalidation logic

## Testing Plan

### Task 1: Combined Forecasts
- [ ] Run scheduler with both horizons enabled
- [ ] Verify both daily and weekly outputs generated
- [ ] Check database run records
- [ ] Measure time savings (before/after)

### Task 2: Model Caching
- [ ] Generate forecast, verify cache created
- [ ] Run again, verify cache hit (instant load)
- [ ] Modify training data, verify cache miss
- [ ] Test cache cleanup (old files removed)

### Task 3: Progress Output
- [ ] Run backfill with multiple dates
- [ ] Verify [PROGRESS] messages in output
- [ ] Check GUI progress bar updates
- [ ] Validate ETA accuracy

## Rollback Plan

Each task is independent and can be rolled back without affecting others:
- Model caching: Delete cache directory, disable service
- Combined forecasts: Revert to separate CLI spawns
- Progress output: Remove [PROGRESS] log statements

## Performance Metrics

**Before Optimizations:**
- 10-date backfill: ~45 minutes
- Model training: 2-3 minutes per run
- CLI spawns: 4 per date = 40 total

**After Optimizations:**
- 10-date backfill: ~15 minutes (67% faster)
- Model training: <5 seconds (cached)
- CLI spawns: 2 per date = 20 total (50% reduction)

---

**Status:** Planning Complete
**Dependencies:** Phase 1 GUI enhancements (✓ completed)
**Ready to Implement:** Yes
