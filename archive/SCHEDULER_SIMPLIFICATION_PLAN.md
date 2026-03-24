---
Status: Done
Created: 2026-03-21
Last-Updated: 2026-03-22
Updated-By: codebase-documenter
Archived: 2026-03-22
---

# Scheduler Simplification Plan

## Executive Summary

The Scheduler tab is overcomplicated with duplicate controls, leftover elements, and a broken Training Instance workflow. This plan proposes a radical simplification aligned with Gemini's "Unified Pipeline" vision:

```
Manual Forecast (The Forge) → Models Page (The Audit) → Scheduler (Production)
                    ↓                    ↓                      ↓
              Creates Instance    Validates & Approves    Inference Only
```

---

## Current State Analysis

### Scheduler Tab Elements Audit

| Element | Purpose | Status | Recommendation |
|---------|---------|--------|----------------|
| **Data Source Toggle** | Database vs CSV | FUNCTIONAL | KEEP - but move to Settings |
| **Date Selection** | Start/End dates | FUNCTIONAL | KEEP - simplify |
| **Type Selector** | Both/Demand/CFAC | FUNCTIONAL | KEEP |
| **Horizon Selector** | Both/Daily/Weekly | FUNCTIONAL | KEEP |
| **Model Selector** | Training Instance | BROKEN | FIX - enable inference mode |
| **Training Period** | 2wk/1mo/2mo/3mo | FUNCTIONAL | REMOVE - use saved instances only |
| **Refresh Weather** | Force cache refresh | FUNCTIONAL | KEEP |
| **Overwrite/Suffix** | Backfill options | FUNCTIONAL | KEEP (when backfilling) |
| **Verbose** | Detailed output | FUNCTIONAL | REMOVE - always verbose |
| **Automation Schedule** | Morning/Evening times | NOT CONNECTED | REMOVE or FIX |
| **Days of Week** | Which days to run | NOT CONNECTED | REMOVE or FIX |
| **Zone Scaling** | Per-zone adjustment | FUNCTIONAL | MOVE to Settings tab |
| **Gateway Config** | Host/port/password | DUPLICATE | REMOVE - already in Gateway tab |
| **Weather Max Age** | Stale data rejection | NOT USED | REMOVE |
| **Archive Retention** | Auto-delete old | NOT USED | REMOVE |
| **Active Model Section** | Training Instance | DUPLICATE | REMOVE - already in Manual Run |

### Critical Issues

1. **"Train Fresh" Still Default** - Despite having saved instances, the default is still to retrain
2. **No Inference Mode** - Even when instance selected, `--use-model` is NOT passed to CLI
3. **Duplicate Controls** - Training Instance selector appears twice
4. **Orphan Automation** - Schedule/Days settings don't connect to any background service
5. **Gateway Duplication** - Full gateway config exists here AND in Gateway tab

---

## Proposed Architecture

### The Unified Pipeline

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           UNIFIED WORKFLOW                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌──────────────┐      ┌──────────────┐      ┌──────────────────────────┐   │
│  │   MANUAL     │      │    MODELS    │      │       SCHEDULER          │   │
│  │   FORECAST   │ ───▶ │    (AUDIT)   │ ───▶ │     (PRODUCTION)         │   │
│  │              │      │              │      │                          │   │
│  │ • Train      │      │ • Evaluate   │      │ • Inference Only         │   │
│  │ • Calibrate  │      │ • Validate   │      │ • Load frozen weights    │   │
│  │ • Save       │      │ • Approve    │      │ • Apply new weather      │   │
│  │              │      │ • Send →     │      │ • Generate forecast      │   │
│  └──────────────┘      └──────────────┘      └──────────────────────────┘   │
│         │                     │                          │                   │
│         ▼                     ▼                          ▼                   │
│   Instance_ID ────────▶ Instance_ID ─────────────▶ Instance_ID              │
│   (weights + config)   (validated metrics)        (frozen model)            │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Tab Responsibilities

| Tab | Responsibility | Operations |
|-----|----------------|------------|
| **Manual** | Training & Calibration | Train models, run calibration, save instances |
| **Models** | Validation & Selection | View metrics, backtest, send to scheduler |
| **Scheduler** | Production Forecasts | Run inference using approved instances |
| **Gateway** | File Distribution | Push/manage files on gateway server |
| **Settings** | Configuration | Data paths, zone scaling, global options |

---

## Simplified Scheduler Tab Design

### New Layout

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  SCHEDULER                                                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌── ACTIVE MODEL ──────────────────────────────────────────────────────┐   │
│  │                                                                       │   │
│  │  ┌─────────────────────────────────────────────────────────────────┐ │   │
│  │  │  🟢 Zonal Demand Model - Mar 21, 2026                           │ │   │
│  │  │     MAPE: 2.1% regional | 2.8% zonal                            │ │   │
│  │  │     Period: 2026-01-01 to 2026-03-20                            │ │   │
│  │  │     Status: ACTIVE FOR SCHEDULER                                │ │   │
│  │  └─────────────────────────────────────────────────────────────────┘ │   │
│  │                                                                       │   │
│  │  [Change Model] ← Opens Models tab                                   │   │
│  │                                                                       │   │
│  └───────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
│  ┌── RUN FORECAST ──────────────────────────────────────────────────────┐   │
│  │                                                                       │   │
│  │  Date: [2026-03-22 ▼]  to  [          ] (optional for backfill)      │   │
│  │                                                                       │   │
│  │  Output:  ○ Demand Only   ○ CFAC Only   ● Both                       │   │
│  │  Horizon: ○ Daily Only    ○ Weekly Only ● Both                       │   │
│  │                                                                       │   │
│  │  ☐ Refresh Weather Cache   ☐ Push to Gateway                         │   │
│  │                                                                       │   │
│  │                                    [ Run Forecast ]                   │   │
│  │                                                                       │   │
│  └───────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
│  ┌── RECENT RUNS ───────────────────────────────────────────────────────┐   │
│  │  Date        Type    Horizon   Status   Duration   Files             │   │
│  │  Mar 21      Both    Both      ✓        2m 34s     4 files           │   │
│  │  Mar 20      Demand  Daily     ✓        45s        2 files           │   │
│  │  ...                                                                  │   │
│  └───────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Elements to REMOVE

| Element | Reason |
|---------|--------|
| Data Source Toggle | Move to Settings - rarely changes |
| Training Period Dropdown | Scheduler should never train fresh |
| "Train Fresh" option | Violates inference-only principle |
| Zone Scaling UI | Move to Settings or Manual tab |
| Gateway Configuration | Already exists in Gateway tab |
| Weather Max Age | Not actually used by CLI |
| Archive Retention | Not actually used by CLI |
| Schedule Times | Background service not implemented |
| Days of Week | Background service not implemented |
| Verbose Checkbox | Always show full output |
| Duplicate Model Selector | One selector is enough |

### Elements to KEEP

| Element | Location | Notes |
|---------|----------|-------|
| Active Model Display | Top card | Show currently active instance |
| Change Model Button | Top card | Navigates to Models tab |
| Date Picker | Run card | Single date or range |
| Type Selector | Run card | Demand/CFAC/Both |
| Horizon Selector | Run card | Daily/Weekly/Both |
| Refresh Weather | Run card | Checkbox |
| Push to Gateway | Run card | Checkbox |
| Run Button | Run card | Primary action |
| Recent Runs | Bottom | History table |

---

## Models Tab Enhancements

### New Features for "Audit" Role

1. **Backtest Against Recent Data**
   - Button: "Evaluate Last 14 Days"
   - Shows segmented results by day type

2. **Segmented Evaluation Table**
   ```
   ┌─────────────────────────────────────────────────────────────────┐
   │  EVALUATION: Zonal Demand Model (Mar 21, 2026)                  │
   ├─────────────────────────────────────────────────────────────────┤
   │  Day Type    Peak MAPE    Off-Peak MAPE    Correlation (R²)    │
   │  ─────────────────────────────────────────────────────────────  │
   │  Weekday     2.3%         1.8%             0.94                 │
   │  Saturday    3.1%         2.4%             0.91                 │
   │  Sunday      2.9%         2.2%             0.92                 │
   │  Holiday     4.2%         3.1%             0.87                 │
   ├─────────────────────────────────────────────────────────────────┤
   │  Overall     2.7%         2.1%             0.92                 │
   └─────────────────────────────────────────────────────────────────┘
   ```

3. **"Send to Scheduler" Button**
   - Sets instance as scheduler active
   - Enables inference-only mode
   - Shows confirmation with key metrics

---

## Technical Implementation

### Phase 1: Enable Inference Mode (Critical)

**File:** `gui/src/App.vue` - `runSchedulerManual()`

```javascript
// BEFORE (broken):
if (activeTrainingInstanceId.value && activeTrainingInstance.value) {
  useCalibrationId = activeTrainingInstance.value.cfacCalibrationId || null;
}

// AFTER (inference mode):
if (activeTrainingInstanceId.value && activeTrainingInstance.value) {
  // Get demand model ID for inference
  const demandModelId = activeTrainingInstance.value.models
    ?.find(m => m.entity_type === 'zonal' || m.entity_type === 'regional')?.id;

  if (demandModelId) {
    useTrainedDemandModel = demandModelId;  // NEW: Pass to CLI as --use-model
  }

  // Keep CFAC calibration
  useCalibrationId = activeTrainingInstance.value.cfacCalibrationId || null;
}
```

**File:** `gui/electron/main.ts` - `runSchedulerManual` handler

```javascript
// Add --use-model flag when demandModelId is provided
if (options.useTrainedDemandModel) {
  args.push('--use-model', options.useTrainedDemandModel);
}
```

### Phase 2: Simplify Scheduler UI

1. Remove duplicate elements
2. Remove non-functional automation settings
3. Move zone scaling to Settings
4. Remove gateway config (use Gateway tab)
5. Add "Active Model" display card
6. Add "Change Model" navigation button

### Phase 3: Models Tab Enhancements

1. Add "Evaluate Last 14 Days" button
2. Implement segmented evaluation (peak/off-peak, day types)
3. Add "Send to Scheduler" button
4. Add confirmation modal with metrics

### Phase 4: Settings Tab Reorganization

Move to Settings:
- Data source toggle (Database/CSV)
- Zone/Region scaling
- Training period defaults
- Weather cache settings

---

## Migration Plan

### Backward Compatibility

1. Preserve `forecast_config.json` structure
2. Keep CLI flags unchanged
3. Default to "Train Fresh" only if no active instance

### User Communication

1. Show tooltip: "Select a trained model from the Models tab"
2. Warning if running without active model: "Running in training mode (slower)"

---

## Success Criteria

- [ ] Scheduler uses `--use-model` when instance selected (inference mode)
- [ ] No "Train Fresh" in Scheduler - must use trained instance
- [ ] Models tab has "Send to Scheduler" button
- [ ] Models tab shows segmented evaluation
- [ ] Scheduler UI reduced by 50%+ elements
- [ ] Zone scaling moved to Settings

---

## Appendix: CLI Flags Reference

### Used by Scheduler

| Flag | Used | Notes |
|------|------|-------|
| `-d, --date` | YES | Date to run |
| `-s, -e` | YES | Backfill range |
| `--daily/--weekly` | YES | Horizon |
| `--demand-only/--cfac-only` | YES | Type |
| `--use-db` | YES | Data source |
| `--data-db` | YES | DB path |
| `--refresh-weather` | YES | Force refresh |
| `--push-gateway` | YES | Gateway push |
| `--use-model` | NO ← FIX | Inference mode |
| `--overwrite` | YES | Backfill |
| `--suffix` | YES | Backfill |

### NOT Used by GUI (Dead Options)

| Flag | Notes |
|------|-------|
| `--calib-days` | Calibration days - not used |
| `--calib-threshold` | Calibration threshold - not used |
| `--max-iterations` | Max iterations - not used |
| `--use-calibration` | Use saved calibration - not properly implemented |
| `--training-days` | Training days - not used |
| `--load-calibrator` | Load calibrator - not used |
| `--no-archive` | Skip archive - not used |
| `-v, -q` | Verbose/quiet - not properly wired |

---

## Approval Required

Please review this plan and approve or request changes before implementation begins.

**Questions for approval:**
1. Should we remove "Train Fresh" from Scheduler entirely?
2. Should zone scaling live in Settings or Manual tab?
3. Should we implement a background scheduler service, or remove those UI elements?
