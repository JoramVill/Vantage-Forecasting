---
Status: Done
Created: 2026-03-21
Last-Updated: 2026-03-22
Updated-By: codebase-documenter
Archived: 2026-03-22
---

# UNIFIED ARCHITECTURE - Vantage Forecaster GUI

---

## Executive Summary

This document defines the IDEAL architecture for the Vantage Forecaster GUI, establishing the **Training Instance as the central object** that links all workflows.

---

## The Unified Workflow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           THE UNIFIED PIPELINE                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   SETTINGS          MANUAL             MODELS           SCHEDULER           │
│   (Config)       (The Forge)        (The Audit)      (Production)          │
│      │                │                  │                │                 │
│      │    ┌───────────┴───────────┐     │                │                 │
│      │    │ 1. Train models       │     │                │                 │
│      │    │ 2. Run calibration    │     │                │                 │
│      │    │ 3. Test forecasts     │     │                │                 │
│      │    │ 4. SAVE INSTANCE      │─────┼────────────────┤                 │
│      │    └───────────────────────┘     │                │                 │
│      │                                  │                │                 │
│      │              ┌───────────────────┴─────────┐      │                 │
│      │              │ 5. View metrics             │      │                 │
│      │              │ 6. Validate quality         │      │                 │
│      │              │ 7. SET AS SCHEDULER ACTIVE  │──────┤                 │
│      │              └─────────────────────────────┘      │                 │
│      │                                                   │                 │
│      │                       ┌───────────────────────────┴───────┐         │
│      │                       │ 8. Load frozen weights            │         │
│      │                       │ 9. Fetch new weather data         │         │
│      │                       │ 10. INFERENCE ONLY (no retrain)   │         │
│      │                       │ 11. Generate forecast             │         │
│      │                       │ 12. Push to gateway               │         │
│      └───────────────────────┴───────────────────────────────────┘         │
│                                                                              │
│                    INSTANCE_ID = Primary Key Linking All Workflows          │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Tab Responsibilities Matrix

| Tab | MUST DO | MUST NOT DO |
|-----|---------|-------------|
| **Settings** | All paths, databases, calibration defaults, zone scaling, gateway credentials, model defaults | Run forecasts, train models |
| **Manual** | Train models, run calibration, test forecasts, save instances | Store global settings, run production |
| **Models** | View instances, show metrics, validate quality, set active for scheduler | Train models, change settings |
| **Scheduler** | Load active instance, run inference, push to gateway | Train models, configure paths, change calibration |
| **Gateway** | Browse files, push/pull, manage storage | Everything else |

---

## Critical Issue Identified: Inference Mode Broken

### Current State (BROKEN)
```javascript
// App.vue runSchedulerManual() - Line 2659
if (activeTrainingInstanceId.value && activeTrainingInstance.value) {
  // Only gets CFAC calibration ID - NOT the demand model ID!
  useCalibrationId = activeTrainingInstance.value.cfacCalibrationId || null;
  // NO useModelId is passed! Scheduler RETRAINS instead of using saved model
}
```

### Required Fix
```javascript
if (activeTrainingInstanceId.value && activeTrainingInstance.value) {
  // Get demand model ID for inference
  const demandModelId = activeTrainingInstance.value.models
    ?.find(m => m.entity_type === 'zonal' || m.entity_type === 'regional')?.id;

  if (demandModelId) {
    useTrainedDemandModel = demandModelId;  // Pass to CLI as --use-model
  }
  useCalibrationId = activeTrainingInstance.value.cfacCalibrationId || null;
}
```

---

## Elements Audit Summary

### REMOVE from Scheduler Tab (16 elements)

| Element | Reason |
|---------|--------|
| Training Period Dropdown | Scheduler should never train fresh |
| "Train Fresh" option | Violates inference-only principle |
| Zone Scaling UI | Move to Settings tab |
| Gateway Host/Port/Password | Move to Gateway tab |
| Test Connection Button | Move to Gateway tab |
| Weather Max Age | Not used by CLI |
| Archive Retention | Not used by CLI |
| Schedule Times | Background service not implemented |
| Days of Week checkboxes | Background service not implemented |
| Second Run toggle | Background service not implemented |
| Verbose checkbox | Always show verbose |
| Duplicate Model Selector (Automation) | Already in Manual Run section |
| `schedulerDailyEnabled` | Dead code |
| `schedulerWeeklyEnabled` | Dead code |
| `schedulerDemandEnabled` | Dead code |
| `schedulerCfacEnabled` | Dead code |

### MOVE to Settings Tab (6 elements)

| Element | Currently In | Why Move |
|---------|--------------|----------|
| Data Source Toggle | Manual + Scheduler | Global preference |
| Zone Scaling | Manual + Scheduler | Global configuration |
| Weather Max Age | Scheduler | Global weather setting |
| Archive Retention | Scheduler | Global archive policy |
| Default Models | Manual | Global defaults |
| Output Naming | Manual | Global preference |

### KEEP in Scheduler Tab (Simplified)

| Element | Purpose |
|---------|---------|
| Active Model Display | Show which instance will be used |
| Change Model Button | Navigate to Models tab |
| Date Picker | Single date or range |
| Type Selector | Demand/CFAC/Both |
| Horizon Selector | Daily/Weekly/Both |
| Refresh Weather | Checkbox |
| Push to Gateway | Checkbox |
| Run Button | Primary action |
| Recent Runs Table | History |

---

## Simplified Scheduler Layout

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  SCHEDULER                                                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌── ACTIVE MODEL ──────────────────────────────────────────────────────┐   │
│  │  🟢 Zonal Demand Model - Mar 21, 2026                                │   │
│  │     MAPE: 2.1% regional | 2.8% zonal                                 │   │
│  │     Training Period: 2026-02-01 to 2026-03-20                        │   │
│  │                                                                       │   │
│  │  [Change Model →]                                                     │   │
│  └───────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
│  ┌── RUN FORECAST ──────────────────────────────────────────────────────┐   │
│  │  Date: [2026-03-22]  to  [          ] (optional for backfill)        │   │
│  │                                                                       │   │
│  │  Output:  ○ Demand  ○ CFAC  ● Both                                   │   │
│  │  Horizon: ○ Daily   ○ Weekly  ● Both                                 │   │
│  │                                                                       │   │
│  │  ☐ Refresh Weather    ☐ Push to Gateway                              │   │
│  │                                                                       │   │
│  │                                          [ Run Forecast ]             │   │
│  └───────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
│  ┌── RECENT RUNS ───────────────────────────────────────────────────────┐   │
│  │  Date       Type    Horizon   Status   Duration   Files              │   │
│  │  Mar 21     Both    Both      ✓        2m 34s     4 files            │   │
│  │  Mar 20     Demand  Daily     ✓        45s        2 files            │   │
│  └───────────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Models Tab Enhancements Needed

### Missing for "Audit" Role - ALL IMPLEMENTED

| Feature | Priority | Status |
|---------|----------|--------|
| Segmented Evaluation (Peak/Off-Peak) | HIGH | ✅ Implemented |
| Day Type Breakdown (Weekday/Weekend/Holiday) | HIGH | ✅ Implemented |
| Backtest Against Recent Data | HIGH | ✅ Implemented |
| "Send to Scheduler" explicit workflow | HIGH | ✅ Implemented |
| Per-Zone MAPE breakdown | MEDIUM | ✅ Implemented |
| Model Comparison View | MEDIUM | ✅ Implemented |

---

## Implementation Phases

### Phase 1: Fix Inference Mode (CRITICAL)
- Pass `--use-model` flag when instance selected
- Enable true inference-only mode
- **Files:** App.vue (runSchedulerManual), main.ts (IPC handler)

### Phase 2: Simplify Scheduler UI
- Remove 16 dead/duplicate elements
- Add Active Model display card
- Add Change Model navigation
- **Files:** App.vue (Scheduler tab template)

### Phase 3: Consolidate Settings
- Move zone scaling to Settings
- Move data source toggle to Settings
- Add default model selection
- **Files:** App.vue (Settings tab template)

### Phase 4: Enhance Models Tab
- Add segmented evaluation
- Add "Send to Scheduler" button
- Add backtest workflow
- **Files:** App.vue (Models tab template), model-store-helper.cjs

---

## Success Criteria

- [x] Scheduler uses `--use-model` when instance selected (inference mode)
- [x] No "Train Fresh" capability in Scheduler
- [x] Models tab has "Send to Scheduler" workflow
- [x] Scheduler UI reduced by 50%+ elements
- [x] Zone scaling consolidated in Settings
- [x] All paths consolidated in Settings
- [x] No duplicate controls across tabs

---

## Approval

**Status:** FULLY IMPLEMENTED (2026-03-21)

All phases completed:
- Phase 1: Inference mode fix (`--use-model` flag)
- Phase 2: Scheduler UI cleanup (~220 lines removed)
- Phase 3: Settings consolidation (Data Source, Zone Scaling, Weather, Archive, Defaults, Output)
- Phase 4: Models tab Send to Scheduler/Manual workflow
- Phase 5: Models tab audit features (Segmented Evaluation, Per-Zone MAPE, Backtest, Comparison)
