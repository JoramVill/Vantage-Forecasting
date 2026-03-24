---
Status: Done
Created: 2026-03-20
Last-Updated: 2026-03-22
Updated-By: codebase-documenter
---

# Settings Tab Overhaul - Implementation Summary

## Overview
Refactored the Settings tab in the GUI to use `globalConfig` (forecast_config.json) as the single source of truth, eliminating duplicate and conflicting settings.

## Changes Made

### 1. Unified CFAC Model Options Section

**Before:** Separate "Wind Model Options" and "Solar Model Options" sections with local ref variables that didn't persist to config.

**After:** Single "CFAC Model Options" section that directly edits `globalConfig.cfac.*`:
- `globalConfig.cfac.useXgboost` - Use XGBoost for ML layer
- `globalConfig.cfac.asymmetricLoss` - Penalize under-predictions 2x
- `globalConfig.cfac.biasCorrection` - Station-specific bias correction

**Location:** Lines 2741-2769 in App.vue

### 2. Comprehensive Global Configuration Editor

**Before:** Minimal "Global Forecast Configuration" section with only calibration settings (days, threshold, maxIterations).

**After:** Comprehensive config editor with grid layout covering all forecast_config.json sections:

#### Sections Added:
1. **Paths Section**
   - Demand Training Path
   - CFAC Training Path
   - Output Directory
   - Weather Cache

2. **Calibration Section** (expanded)
   - Enable Calibration (toggle)
   - Calibration Days
   - Threshold (%)
   - Max Iterations

3. **Demand Options Section**
   - Model (Hybrid/Regression/XGBoost)
   - Geography (Regional/Zonal)
   - Growth Rate (%)

4. **Output Section**
   - Archive Forecasts (toggle)
   - Retention Days
   - Naming Convention (Gateway/Legacy)

5. **Gateway Section**
   - Enable Gateway (toggle)
   - Auto-push after runs (toggle)

**Location:** Lines 2809-2910 in App.vue

### 3. Dirty Tracking for Unsaved Changes

**Added:**
- `configDirty` ref variable to track unsaved changes
- `markConfigDirty()` function called on all input changes
- Visual indicator "Unsaved changes" displayed when config is modified
- Clear dirty flag on save and reset operations

**Location:**
- Ref declaration: Line 216 in App.vue
- Function: Lines 955-957 in App.vue
- Clear on save: Line 963 in App.vue
- Clear on reset: Line 972 in App.vue

### 4. Removed Deprecated Local Settings

**Removed ref variables:**
- `windUseXgboost`
- `windAsymmetricLoss`
- `windBiasCorrection`
- `solarUseXgboost`
- `solarAsymmetricLoss`
- `solarBiasCorrection`

**Removed from:**
- Ref declarations (lines 80-86) - replaced with comment
- `saveSettings()` function - removed from saved object
- `watch()` array - removed from watched variables
- `loadSettings()` function - removed loading logic and backward compatibility migration

**Location:** Lines 75-88 in App.vue (replaced with single comment)

### 5. Enhanced CSS Styling

**Added styles:**
```css
.config-editor-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 24px;
  margin-bottom: 24px;
}

.config-section {
  background: var(--bg-tertiary);
  border-radius: 8px;
  padding: 16px;
}

.config-section h3 {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0 0 12px 0;
  padding-bottom: 8px;
  border-border: 1px solid var(--border-color);
}

.config-dirty-indicator {
  color: var(--warning);
  font-size: 12px;
  margin-left: 12px;
}
```

**Enhanced:** `.config-actions` now has `align-items: center` for proper alignment with dirty indicator.

**Location:** Lines 5767-5800 in App.vue (style section)

## Benefits

1. **Single Source of Truth:** All CFAC model options and global settings are now stored in forecast_config.json
2. **No Duplicate Settings:** Eliminated local ref variables that conflicted with global config
3. **Better UX:**
   - Grid layout for easier scanning of all config options
   - Grouped sections by category
   - Unsaved changes indicator prevents accidental data loss
4. **Maintainability:** Easier to add new config options in the future
5. **Consistency:** All forecast operations use the same config values

## Testing Checklist

- [x] Build succeeds without errors
- [ ] Settings tab loads and displays all config sections
- [ ] Changes to inputs trigger dirty indicator
- [ ] Save button persists changes to forecast_config.json
- [ ] Reset button restores defaults
- [ ] CFAC model options reflect in forecast runs
- [ ] All config fields bind correctly to globalConfig

## Files Modified

- `C:\Source_Codes\Vantage-Forecaster\gui\src\App.vue`
  - Lines 75-88: Removed deprecated ref variables
  - Lines 210-216: Added configDirty ref
  - Lines 343-344: Removed from saveSettings
  - Lines 375-378: Removed from watch array
  - Lines 461-462: Removed from loadSettings
  - Lines 955-982: Added markConfigDirty, updated save/reset functions
  - Lines 2741-2769: Replaced Wind/Solar sections with unified CFAC section
  - Lines 2809-2910: Replaced minimal config section with comprehensive editor
  - Lines 5767-5800: Added CSS for grid layout and styling

## Migration Notes

**For users upgrading from previous versions:**
- Old local settings (`windUseXgboost`, etc.) will no longer be saved or loaded
- CFAC model options must now be configured in the "Global Forecast Configuration" section
- Default values from forecast_config.json will be used if no previous config exists

## Next Steps

1. Update user documentation to reflect new Settings tab structure
2. Consider adding tooltips for config fields
3. Add validation for path inputs (directory existence checks)
4. Consider adding import/export for entire config
