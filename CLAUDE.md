# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Documentation

**Read documentation first:** All docs in `Documents/` folder. Start with `DOCUMENTATION_INDEX.md`.

Key guides:
- `CAPACITY_FACTOR_GUIDE.md` - Capacity factor forecasting (primary use case)
- `METHODOLOGY_REPORT.md` - Comprehensive forecasting methodology for clients
- `CLI_REFERENCE.md` - Complete command reference
- `USER_GUIDE.md` - Workflows and examples
- `interconnector_analysis/INTERCONNECTOR_FINAL_SUMMARY.md` - Interconnector analysis

---

## Build & Run

```bash
npm run build                           # Build TypeScript
node dist/index.js <command> [options]  # Run CLI
npm run dev -- <command> [options]      # Development mode
```

### GUI (in gui/ directory)
```bash
cd gui && npm install && npm run dev    # Development
npm run electron:build                   # Package for distribution
```

---

## CLI Commands

### Capacity Factor Forecasting (Primary)
| Command | Description |
|---------|-------------|
| `cfac forecast2` | **Recommended** - Optimal model selection per station type |
| `cfac forecast3` | Enhanced Hybrid with EMA wind smoothing (`--smooth 0.5`) |
| `cfac evaluate` | Evaluate forecast accuracy vs actual |
| `cfac mrec compare3` | Compare wind model variants |

### Demand Forecasting
| Command | Description |
|---------|-------------|
| `train` | Train XGBoost/Regression on demand + weather |
| `forecast` | Generate demand forecasts |
| `evaluate` | Compare forecast vs actual |

### Scheduler (Background Service)
| Command | Description |
|---------|-------------|
| `scheduler run` | Run daily + weekly forecast for today |
| `scheduler backfill -s <start> -e <end>` | Generate forecasts for date range |
| `scheduler evaluate` | Evaluate pending forecasts against actuals |
| `scheduler status` | Show run history and metrics |
| `scheduler service` | Run as background service (daily at 6 AM) |

### Other
| Command | Description |
|---------|-------------|
| `db status/import/models/clear` | SQLite database management |
| `interconnector train/forecast` | Interconnector constraint prediction |

---

## Capacity Factor Forecasting

### Recommended Command
```bash
node dist/index.js cfac forecast2 \
  -t "Data Samples/Capacity Factor" \
  -s 2025-11-01 -e 2025-12-31 \
  -o output/cfac_forecast.csv
```

### Optional Flags
| Flag | Description |
|------|-------------|
| `--use-xgboost` | Use XGBoost instead of linear regression for ML layer (better for solar) |
| `--asymmetric-loss` | Penalize under-predictions 2x (reduces under-forecasting bias) |
| `--bias-correction` | Apply learned station-specific bias correction |
| `--smooth 0.5` | EMA smoothing for wind (0=none, 0.7=heavy) - forecast3 only |

### Best Configuration by Station Type
| Type | Recommended Flags | Notes |
|------|------------------|-------|
| **Solar** | `--use-xgboost --asymmetric-loss` | 43% bias reduction |
| **Wind** | None (default) | 4-Tier Hybrid achieves 73% MAPE on test data |
| **Mixed** | Default (no flags) | Balanced approach |

**NOTE:** Wind training MAPE (130%) is misleading - test MAPE is 73%. Validate with `cfac mrec compare-physics`.

### Auto-Calibration (IMPORTANT)

**Always run with auto-calibration enabled (default).** When the user asks for a forecast, calibration happens automatically using recent actual data.

#### What Auto-Calibration Does
1. **Global bias correction** - Calculates overall under/over-prediction bias for wind and solar
2. **Per-hour solar scaling** - Different scale factors for each hour (6AM-6PM) to handle sunrise/sunset asymmetry
3. **Per-station solar scaling** - Individual station calibration to account for panel efficiency, tracking, local conditions
4. **Per-station scaling for hydro/biomass/battery** - Adapts to seasonal patterns (e.g., wet→dry season)

#### Why Per-Station Calibration Matters (Solar)
Solar stations have highly variable characteristics that global calibration misses:
- Different panel technologies (mono/poly crystalline, thin-film)
- Different tracking systems (fixed, single-axis, dual-axis)
- Different inverter efficiencies
- Different local conditions (shading, dust, humidity)

**Example improvement with per-station solar calibration (Jan 2026):**
| Station | Before MAPE | After MAPE | Improvement |
|---------|-------------|------------|-------------|
| 01SNMANUEL_S | 35.12% | 31.53% | -3.6% |
| 01CURIMAO | 32.65% | 28.18% | -4.5% |
| 01PASUQUIN | 37.53% | 32.37% | -5.2% |
| **Overall Solar** | **32.45%** | **28.99%** | **-10.7%** |

#### Why Per-Station Calibration is DISABLED for Wind
Wind patterns are too variable between seasons. Calibration period patterns (e.g., Dec 18-31) often don't generalize to forecast period (e.g., Jan 1-14), causing overcorrection. Wind uses global bias correction only.

#### Calibration Period
Default: Last 14 days of training data. Override with `--no-auto-calibrate` to disable.

### Model Selection by Type
| Type | Model | Measured MAPE | Notes |
|------|-------|---------------|-------|
| Demand | Region-Aware Hybrid | 2-4% | XGBoost + temperature sensitivity + weekend correction |
| Wind | 4-Tier Hybrid | ~73% | Best on test data. Training metrics (130%) are misleading |
| Solar | Physics+ML Hybrid | ~16% | Irradiance physics + ML correction |
| Hydro/Geothermal/Biomass/Battery | Profile-based | varies | Historical pattern matching |

**NOTE:** Wind model training MAPE (130%+) is misleading. Test MAPE on held-out data is 73%. Always validate with `cfac mrec compare-physics`.

### Weekend Correction Factors
The demand hybrid model applies learned correction factors to fix systematic weekend over-forecasting:
```typescript
// src/models/hybridModel.ts
['CLUZ', { saturday: 0.947, sunday: 0.951 }]  // 5% reduction for Luzon weekends
['CVIS', { saturday: 1.009, sunday: 0.980 }]  // Minor adjustments
['CMIN', { saturday: 0.999, sunday: 1.018 }]  // Minor adjustments
```
These factors reduced weekend MAE from 500 MW to ~250 MW.

### Key Model Files
**Demand:**
- `src/models/hybridModel.ts` - Region-aware hybrid with statistical profiles + weekend correction

**Capacity Factor:**
- `src/models/capacityFactor/WindEnhancedHybridModel.ts` - Wind Enhanced Hybrid (MREC + ML)
- `src/models/capacityFactor/SolarHybridModel.ts` - Solar Physics+ML Hybrid (primary)
- `src/models/capacityFactor/WindMRECModel.ts` - iPool MREC three-tier algorithm
- `src/models/capacityFactor/SolarIrradianceModel.ts` - Solar physics base model
- `src/models/capacityFactor/CFacXGBoostRegressor.ts` - XGBoost for ML layer
- `src/models/capacityFactor/BiasCorrector.ts` - Station-specific bias correction

---

## Complete Forecast Commands

### 1. Capacity Factor Forecast (cfac forecast2)

**Basic command:**
```bash
node dist/index.js cfac forecast2 \
  -t "Data Samples/Capacity Factor" \
  -s 2025-12-01 \
  -e 2025-12-31 \
  -o output/cfac_december.csv
```

**With optimal solar settings:**
```bash
node dist/index.js cfac forecast2 \
  -t "Data Samples/Capacity Factor" \
  -s 2025-12-01 \
  -e 2025-12-31 \
  -o output/cfac_december.csv \
  --use-xgboost \
  --asymmetric-loss
```

**All available flags:**
| Flag | Description |
|------|-------------|
| `-t, --training <path>` | Training data folder (required) |
| `-s, --start <date>` | Forecast start date YYYY-MM-DD (required) |
| `-e, --end <date>` | Forecast end date YYYY-MM-DD (required) |
| `-o, --output <file>` | Output CSV file (required) |
| `--stations <file>` | Custom stations.json (default: `src/data/stations.json`) |
| `--cache <dir>` | Weather cache directory (default: `./weather_cache`) |
| `--use-xgboost` | Use XGBoost for ML layer |
| `--asymmetric-loss` | Penalize under-predictions 2x |
| `--bias-correction` | Apply station-specific bias correction |
| `--no-auto-calibrate` | Skip auto-calibration period |
| `--training-end <date>` | Limit training data to before this date |

### 2. Demand Forecast

**With auto weather fetching (recommended):**
```bash
node dist/index.js forecast \
  -d "Data Samples/Demand" \
  -s 2025-12-01 \
  -e 2025-12-31 \
  -o output/demand_december.csv \
  --model hybrid
```

**With manual weather files:**
```bash
node dist/index.js forecast \
  -d "Data Samples/Demand" \
  --weather-hist weather_manila.csv weather_cebu.csv weather_davao.csv \
  --weather-forecast weather_forecast_manila.csv weather_forecast_cebu.csv weather_forecast_davao.csv \
  -o output/demand_forecast.csv \
  --model xgboost
```

**All available flags:**
| Flag | Description |
|------|-------------|
| `-d, --demand <path>` | Historical demand data folder/file (required) |
| `-s, --start <date>` | Forecast start date (required with auto-fetch) |
| `-e, --end <date>` | Forecast end date (required with auto-fetch) |
| `-o, --output <file>` | Output CSV file (required) |
| `--model <type>` | Model type: `xgboost`, `regression`, `hybrid` (default: hybrid) |
| `--weather-hist <files...>` | Historical weather CSV files |
| `--weather-forecast <files...>` | Forecast weather CSV files |
| `--use-db` | Use database-stored model |
| `--growth <rate>` | Daily growth rate adjustment (e.g., 0.001 for 0.1%) |

### 3. Train Demand Model

```bash
node dist/index.js train \
  -d "Data Samples/Demand" \
  -w weather_manila.csv weather_cebu.csv weather_davao.csv \
  -o ./output \
  --model both
```

**Flags:**
| Flag | Description |
|------|-------------|
| `-d, --demand <file>` | Historical demand CSV (required) |
| `-w, --weather <files...>` | Weather CSV files (required) |
| `-o, --output <dir>` | Output directory for reports |
| `--model <type>` | Model type: `regression`, `xgboost`, `both` |

### 4. Evaluate Forecasts

**Capacity factor evaluation:**
```bash
node dist/index.js cfac evaluate \
  -f output/cfac_forecast.csv \
  -a "Data Samples/Capacity Factor/MRHCFac_actual.csv" \
  -o output/cfac_evaluation.txt
```

**Demand evaluation:**
```bash
node dist/index.js evaluate \
  -f output/demand_forecast.csv \
  -a "Data Samples/Demand/actual.csv"
```

### 5. Compare Wind Models

```bash
node dist/index.js cfac mrec compare3 \
  -t "Data Samples/Capacity Factor" \
  -a "Data Samples/Capacity Factor"
```

### 6. Interconnector Forecasting

**Train:**
```bash
node dist/index.js interconnector train \
  --start 2025-07-01 \
  --end 2025-11-30 \
  --model xgboost
```

**Forecast:**
```bash
node dist/index.js interconnector forecast \
  -s 2025-12-01 \
  -e 2025-12-31 \
  -o output/interconnector_forecast.csv
```

### 7. Scheduler (Automated Forecasting)

**Run daily + weekly forecast:**
```bash
node dist/index.js scheduler run \
  -d 2025-10-15 \
  --demand-only \
  --output ./output
```

**Backfill date range:**
```bash
node dist/index.js scheduler backfill \
  -s 2025-10-01 -e 2025-10-31 \
  --daily --demand-only
```

**View status and history:**
```bash
node dist/index.js scheduler status
```

**All scheduler flags:**
| Flag | Description |
|------|-------------|
| `-d, --date <date>` | As-of date (YYYY-MM-DD), default: today |
| `-s, --start <date>` | Backfill start date |
| `-e, --end <date>` | Backfill end date |
| `--demand-only` | Only generate demand forecasts |
| `--daily` | Daily (next-day) forecasts only |
| `--weekly` | Weekly (7-day) forecasts only |
| `--output <dir>` | Output directory (default: `./output`) |
| `--db <path>` | Database path (default: `./forecast.db`) |

**Output Structure:**
```
output/forecasts/
└── 2025-10-15/           # As-of date folder
    ├── demand_daily.csv   # Next-day forecast (Oct 16)
    └── demand_weekly.csv  # 7-day forecast (Oct 16-22)
```

---

## Architecture

### Data Flow
```
CSV Parsers → Data Merger (timestamp alignment) → Feature Engineering → ML Models → Forecast Output
```

### Key Directories
| Directory | Purpose |
|-----------|---------|
| `src/parsers/` | CSV parsing (demand: hour-ending M/D/YYYY, weather: ISO 8601 hour-starting) |
| `src/features/` | Feature engineering (50+ features) |
| `src/models/` | Demand models (Regression, XGBoost, Hybrid) |
| `src/models/capacityFactor/` | Wind/Solar/Profile capacity factor models |
| `src/services/` | Weather API (Visual Crossing), capacityFactorService |
| `src/database/` | SQLite persistence via better-sqlite3 |
| `src/data/stations.json` | Station metadata, coordinates, weather clusters |

### Weather Timestamp Alignment
Weather uses hour-starting, demand uses hour-ending. The merger adds 1 hour to weather timestamps.

---

## Station Type Detection

Defined in `src/types/capacityFactor.ts`:

**By suffix:** `_W`→Wind, `_S`→Solar, `_H`→Hydro(Storage), `_BI/_BG/_BL`→Biomass, `_B`→Battery, `_G/_GP`→Geothermal

**Explicit mappings (non-standard naming):**
- Wind: `01BURGOS`, `01LAOAG`, `01PAGUDPUD`, `02DOLORES`, `02MMPP_G01`, `03AWOC_G01`, `08PWIND_G01`, `08WIND_G02`

---

## Weather Fetching

### Station-Specific Weather
Wind and solar stations use their exact coordinates (from `stations.json`) instead of cluster centers:
- Wind: `WIND_${stationCode}` cluster ID, 100m hub-height data
- Solar: `SOLAR_${stationCode}` cluster ID, standard weather + UV
- Other types: Cluster-based fetching

### Weather Cache
Cached in `./weather_cache/`. Delete cache folder if cluster issues occur:
```bash
rm -rf weather_cache/<CLUSTER_NAME>
```

### Weather Cache for Future Dates (IMPORTANT)

**Problem:** When forecasting future dates, the Visual Crossing API may return incomplete or empty data, especially for specialized 100m hub-height wind data. This causes forecasts to use fallback values, resulting in constant/flat predictions that don't track actual weather patterns.

**Symptoms:**
- Wind forecasts show constant values (e.g., 42-43% every day) instead of natural variation
- Weather cache files for future dates are much smaller (~1.7KB vs ~3KB for historical)
- Hourly data rows contain empty values: `2026-01-10T01:00:00,,,,,,,,,,`

**Solution:** After the forecast dates have passed, refresh the weather cache to get actual observed data:
```bash
# Delete incomplete weather cache for wind stations
rm -rf weather_cache/WIND_*/2026-01/2026-01-1*.csv
rm -rf weather_cache/*_WIND/2026-01/2026-01-1*.csv

# Re-run forecast to fetch fresh (now historical) weather data
node dist/index.js cfac forecast2 -t "Data Samples/Capacity Factor" -s 2026-01-01 -e 2026-01-14 -o output/cfac_refreshed.csv
```

**Impact Example (Jan 2026 Wind):**
| Metric | Stale Cache | Fresh Cache | Improvement |
|--------|-------------|-------------|-------------|
| Wind MAPE | 53.24% | 48.18% | -5.1 points |
| Wind MAE | 0.1448 | 0.1135 | -21.6% |

**Best Practice:** For accurate forecast evaluation against actuals, always refresh the weather cache after the forecast dates have passed.

---

## Known Issues

### Solar Station Variability
Solar stations have highly variable characteristics. Per-station calibration (enabled by default in `cfac forecast2`) addresses most under-forecasting issues by applying station-specific scale factors. If a station consistently under/over-forecasts:
1. Check if per-station calibration is showing significant adjustments in the output
2. Verify weather data is correct for that station's coordinates
3. Check for station outages or maintenance in actual data

### Wind Model Fallback
Enhanced Hybrid automatically falls back to MREC-only if ML layer degrades performance (logged as warning).

### Wind Per-Station Calibration Disabled
Per-station calibration is intentionally disabled for wind because wind patterns are too variable between seasons. The calibration period patterns often don't generalize to the forecast period, causing overcorrection. Wind uses global bias correction only.

### Wind Model Performance Analysis (Jan 2026)

**IMPORTANT: Training MAPE is misleading. Always validate on held-out test data.**

#### Model Comparison (Validated on Nov-Dec Test Data)

| Model | Test MAPE | Training MAPE | Notes |
|-------|-----------|---------------|-------|
| **4-Tier Hybrid** | **73.0%** | 130%+ | **BEST on test** (training metrics misleading) |
| Weather-Only Hybrid | 74.3% | 108% | Close second |
| Physics Hybrid | 77.2% | 119% | Doesn't match actual data |
| MREC-only (baseline) | 78.2% | 182% | Simple but robust |

**Key Insight:** The 4-Tier model shows 130%+ MAPE during training but only 73% on held-out test data. Training metrics can be misleading - always validate on test data.

#### Per-Station Test Results

| Station | Weather-Only | 4-Tier | Physics | Best |
|---------|--------------|--------|---------|------|
| 01BURGOS | 59.0% | **53.9%** | 64.3% | 4-Tier |
| 01LAOAG | 83.7% | **83.2%** | 85.9% | 4-Tier |
| 01PAGUDPUD | 47.5% | **45.1%** | 64.5% | 4-Tier |
| 08NABAS_W | 55.9% | **54.1%** | 54.9% | 4-Tier |

#### Why Physics-Based Models Don't Help

The data shows wind stations operating at **14-22% rated CF** when physics predicts **70-90%**. This suggests:

1. **Curtailment** - Grid can't accept all power, forcing turbines offline
2. **Maintenance outages** - Scheduled/unscheduled downtime
3. **Equipment issues** - Partial operation or degradation
4. **Dispatch constraints** - Economic dispatch limitations

Because actual CFs don't follow theoretical power curves, empirical models (4-Tier, Weather-Only) outperform physics-based models.

#### Model Recommendations

| Scenario | Recommended Model | Notes |
|----------|-------------------|-------|
| **General use** | 4-Tier Hybrid | Best test accuracy (73%) |
| **Avoid overfitting** | Weather-Only Hybrid | More stable (74.3%) |
| **Quick baseline** | MREC-only | Simple, robust (78.2%) |

#### Validation Command

Always validate wind models using held-out test data:
```bash
node dist/index.js cfac mrec compare-physics \
  -t "Data Samples/Capacity Factor" \
  -a "Data Samples/Capacity Factor"
```
This trains on Jul-Oct and tests on Nov-Dec for proper out-of-sample validation.

---

## Feature Engineering

50+ features in `FEATURE_NAMES` (`src/constants/index.ts`):
- **Temporal**: hour, dayOfWeek, isWeekend, isHoliday, month, hourSin/Cos
- **Weather**: temp, dew, precip, windgust, windspeed, cloudcover, solarradiation, uvindex
- **Derived**: relativeHumidity (Magnus), heatIndex (Rothfusz), CDH (base 24°C)
- **Lag**: demandLag1h/24h/168h, tempLag1h/24h, rolling 24h averages

First 168 hours (7 days) filtered during training for lag features.

---

## API Keys

Visual Crossing API key resolution:
1. `VISUAL_CROSSING_API_KEY` environment variable
2. `config.json` → `visualCrossingApiKey` field
3. Built-in default key

---

## Region Mapping (Philippines Grid)

| Weather City | Region Code | Region Name |
|--------------|-------------|-------------|
| Manila | CLUZ | Luzon |
| Cebu City | CVIS | Visayas |
| Davao City | CMIN | Mindanao |

---

## Philippines Holiday Detection

Holiday detection uses the `date-holidays` npm package for dynamic detection of Philippines holidays.

### Features
- **Automatic detection** of all Philippines public, bank, and optional holidays
- **Multi-year support** - works for any year without manual updates
- **Cached results** - holidays are calculated once per year and cached
- **Affects `isHoliday` feature** in demand forecasting model

### How It Works
```typescript
// src/constants/index.ts
import Holidays from 'date-holidays';
const phHolidays = new Holidays('PH');

// Check if date is a holiday
isPhilippineHoliday('2025-12-25'); // true - Christmas Day

// Get all holidays for a year
getHolidaysForYear(2025); // ['2025-01-01', '2025-12-25', ...]

// Get holiday details
getHolidayDetails('2025-12-08'); // { name: 'Feast of the Immaculate Conception', type: 'optional' }
```

### Holiday Types Detected
| Type | Examples |
|------|----------|
| **public** | Christmas Day, Independence Day, Labor Day |
| **optional** | All Saints' Day, Ninoy Aquino Day, Christmas Eve |
| **bank** | Bank-specific holidays |

### Test Holiday Detection
```bash
node scripts/test-holidays.cjs
```

### Adding Custom Holidays
If a special proclamation creates a one-time holiday, add it to `PH_HOLIDAYS_PROCLAIMED` in `src/constants/index.ts`:
```typescript
const PH_HOLIDAYS_PROCLAIMED: Record<number, string[]> = {
  2025: ['2025-12-09'], // Add special proclaimed holidays here
};
```

**Important:** Only add holidays that are ACTUALLY observed. Verify with demand data that the holiday shows lower demand patterns. Presidential proclamations may not always result in actual holiday behavior.
