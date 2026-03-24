---
Status: Done
Created: 2026-03-20
Last-Updated: 2026-03-22
Updated-By: codebase-documenter
Archived: 2026-03-22
---

# GUI Calibration Unification Plan

**Goal:** Make hybrid calibration the default with minimal user friction

---

## Current State Analysis

### What We Have
| Component | Location | Status |
|-----------|----------|--------|
| IterativeScalingCalibrator | `src/models/IterativeScalingCalibrator.ts` | ✅ Ready |
| DemandCalibrator (Quantile) | `src/models/DemandCalibrator.ts` | ✅ Ready |
| demand-calibration-helper.cjs | `gui/helpers/` | ✅ Ready |
| IPC handlers | `gui/electron/main.ts` | ✅ Ready |
| Settings UI | `gui/src/App.vue` | ✅ Added (not wired) |
| Scheduler refactor | `forecastSchedulerService.ts` | ✅ Partial |

### Current Pain Points
1. **Manual Forecast** - Still uses old inline calibration, not the new hybrid system
2. **Scheduler** - Uses IterativeScalingCalibrator but not integrated with GUI settings
3. **Settings not wired** - `demandCalibrationMode` and `quantileAlpha` exist but don't affect anything
4. **Multiple code paths** - Calibration logic duplicated in multiple places

---

## Proposed Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         USER INTERFACE                                   │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐   │
│  │ Manual Forecast │     │   Scheduler     │     │    Settings     │   │
│  │      Tab        │     │      Tab        │     │      Tab        │   │
│  └────────┬────────┘     └────────┬────────┘     └────────┬────────┘   │
│           │                       │                       │             │
│           └───────────────────────┴───────────────────────┘             │
│                                   │                                      │
│                                   ▼                                      │
│                    ┌──────────────────────────┐                         │
│                    │   Unified Config Store   │                         │
│                    │  - demandCalibrationMode │                         │
│                    │  - quantileAlpha         │                         │
│                    │  - enableZoneScaling     │                         │
│                    └──────────────────────────┘                         │
│                                   │                                      │
└───────────────────────────────────┼──────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         CALIBRATION SERVICE                              │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  demand-calibration-helper.cjs (subprocess)                             │
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │  runCalibration(mode, options)                                   │   │
│  │                                                                   │   │
│  │  switch(mode):                                                    │   │
│  │    'hybrid'    → Pass 1 (Iterative) + Pass 2 (XGBoost α=alpha)  │   │
│  │    'iterative' → Pass 1 only                                     │   │
│  │    'xgboost'   → Legacy XGBoost only                             │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Implementation Plan

### Phase 1: Wire Settings to Calibration (LOW EFFORT)

**Goal:** Make the existing settings actually control calibration behavior

**Changes:**

1. **forecast_config.json** - Add calibration settings to global config
   ```json
   {
     "demandCalibrationMode": "hybrid",
     "quantileAlpha": 0.80,
     "enableZoneScaling": false
   }
   ```

2. **App.vue** - Save/load calibration settings to global config (not just electron settings)
   - Connect `demandCalibrationMode` to `saveGlobalConfig()`
   - Connect `quantileAlpha` to `saveGlobalConfig()`

3. **main.ts** - Pass calibration mode to helper when running forecasts
   - Read mode from global config
   - Pass to `runDemandCalibrationCommand()`

### Phase 2: Unify Manual Forecast Calibration (MEDIUM EFFORT)

**Goal:** Manual Forecast uses the same calibration system as Scheduler

**Current Flow (Manual Forecast):**
```
User clicks "Generate Forecast"
  → runCommand(['forecast', ...])
  → CLI generates forecast
  → No calibration applied (or old inline)
```

**New Flow:**
```
User clicks "Generate Forecast"
  → Step 1: Generate raw forecast via CLI
  → Step 2: Run calibration via demand-calibration-helper.cjs
  → Step 3: Apply calibration to forecast
  → Output calibrated forecast
```

**Changes:**

1. **main.ts** - Add `run-demand-forecast-calibrated` IPC handler
   ```typescript
   ipcMain.handle('run-demand-forecast-calibrated', async (_event, options) => {
     // 1. Generate raw forecast
     const rawResult = await runCommand(['forecast', ...]);

     // 2. Get calibration settings
     const mode = globalConfig.demandCalibrationMode || 'hybrid';
     const alpha = globalConfig.quantileAlpha || 0.80;

     // 3. Run calibration if mode !== 'none'
     if (mode !== 'none') {
       const calibResult = await runDemandCalibrationCommand('runHybrid', {
         forecastPath: rawResult.outputPath,
         actualPath: options.actualPath,
         alpha,
         mode  // 'hybrid', 'iterative', or 'xgboost'
       });

       // 4. Apply calibration to forecast file
       await applyCalibrationToFile(rawResult.outputPath, calibResult);
     }

     return { success: true, outputPath: rawResult.outputPath };
   });
   ```

2. **App.vue** - Update Manual Forecast to use new IPC
   - Change from `runCommand(['forecast', ...])` to `runDemandForecastCalibrated(...)`
   - Show calibration progress in output

### Phase 3: Unify Scheduler Calibration (MEDIUM EFFORT)

**Goal:** Scheduler respects GUI calibration settings

**Changes:**

1. **forecastSchedulerService.ts** - Read calibration mode from config
   ```typescript
   const mode = this.config.demandCalibrationMode || 'hybrid';
   const alpha = this.config.quantileAlpha || 0.80;

   if (mode === 'hybrid') {
     // Use IterativeScalingCalibrator (Pass 1)
     // Then DemandCalibrator (Pass 2)
   } else if (mode === 'iterative') {
     // Use IterativeScalingCalibrator only
   } else if (mode === 'xgboost') {
     // Use DemandCalibrator only (legacy)
   }
   ```

2. **config.ts types** - Add calibration settings to ForecastConfig
   ```typescript
   interface ForecastConfig {
     // ... existing
     demandCalibrationMode?: 'hybrid' | 'iterative' | 'xgboost' | 'none';
     quantileAlpha?: number;
     enableZoneScaling?: boolean;
   }
   ```

### Phase 4: Simplify UI (LOW EFFORT)

**Goal:** Make it easy for users - hybrid is default, advanced options hidden

**Changes:**

1. **App.vue Settings** - Simplify calibration section
   ```vue
   <!-- Simple mode: just show recommendation -->
   <div class="calibration-simple">
     <label>
       <input type="checkbox" v-model="useHybridCalibration" />
       Use Hybrid Calibration (Recommended)
     </label>
     <p class="help-text">
       Automatically adjusts forecasts to reduce bias. Achieved 99% improvement in testing.
     </p>
     <button @click="showAdvancedCalibration = true">Advanced Settings</button>
   </div>

   <!-- Advanced mode: show full options -->
   <div v-if="showAdvancedCalibration" class="calibration-advanced">
     <!-- Mode selector, alpha slider, etc. -->
   </div>
   ```

2. **Manual Forecast Tab** - Show calibration status
   - "Calibration: Hybrid (α=0.80)" indicator
   - Results show: "Applied +8% peak, +3% off-peak scaling"

3. **Scheduler Tab** - Show calibration mode being used
   - Same indicator as Manual Forecast
   - History shows calibration applied

---

## Default Behavior

After implementation, the default (zero-config) behavior:

| Scenario | Calibration Applied |
|----------|---------------------|
| New install | Hybrid (α=0.80) |
| Manual Forecast "Generate" | Hybrid (α=0.80) |
| Scheduler daily run | Hybrid (α=0.80) |
| User disables calibration | None |

---

## Files to Modify

| File | Changes | Effort |
|------|---------|--------|
| `src/types/config.ts` | Add calibration types | Low |
| `forecast_config.json` | Add default values | Low |
| `gui/electron/main.ts` | Add unified IPC handler | Medium |
| `gui/src/App.vue` | Wire settings, simplify UI | Medium |
| `src/services/forecastSchedulerService.ts` | Read config, use unified flow | Medium |
| `gui/helpers/demand-calibration-helper.cjs` | Add mode parameter | Low |

---

## Design Decisions (Approved 2026-03-20)

| Question | Decision | Rationale |
|----------|----------|-----------|
| Default mode | **hybrid** | Best accuracy - the whole point of the 2-pass architecture |
| Alpha default | **0.80** | 4:1 penalty tested successfully; can dial to 0.75 if needed |
| Zone scaling | **Yes** for zonal | Demand profiles vary across grid nodes |
| Backwards compat | **No retroactive** | Preserve audit trail for benchmarking |
| UI complexity | **Progressive disclosure** | Simple checkbox default, advanced hidden |

---

## Estimated Effort

| Phase | Effort | Dependencies |
|-------|--------|--------------|
| Phase 1: Wire Settings | 1-2 hours | None |
| Phase 2: Manual Forecast | 2-3 hours | Phase 1 |
| Phase 3: Scheduler | 2-3 hours | Phase 1 |
| Phase 4: Simplify UI | 1-2 hours | Phase 2, 3 |

**Total:** 6-10 hours

---

## Success Criteria

- [ ] User runs Manual Forecast → Hybrid calibration applied automatically
- [ ] User runs Scheduler → Same calibration as Manual Forecast
- [ ] Settings change → Both Manual and Scheduler use new settings
- [ ] Zero-config experience → Works out of the box with good defaults
- [ ] Advanced users → Can still tune alpha and mode
