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
| **Wind** | `--bias-correction` | XGBoost degrades wind performance |
| **Mixed** | Default (no flags) | Balanced approach |

### Model Selection by Type
| Type | Model | Measured MAPE | Notes |
|------|-------|---------------|-------|
| Demand | Region-Aware Hybrid | 2-4% | XGBoost + temperature sensitivity |
| Wind | Enhanced Hybrid (MREC + ML) | ~76% | 100m hub-height wind data |
| Solar | Physics+ML Hybrid | ~16% | Irradiance physics + ML correction |
| Hydro/Geothermal/Biomass/Battery | Profile-based | varies | Historical pattern matching |

### Key Model Files
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

---

## Known Issues

### Under-Forecasting Stations
Some Visayas solar stations severely under-forecast due to equipment/data issues (not model problems):
- `04TABANGO_S`: 88% performance deficit (best solar radiation, worst output)
- `06BACOLOD_S`: 50% lower efficiency than nearby stations
- These require station-specific degradation factors, not model fixes

### Wind Model Fallback
Enhanced Hybrid automatically falls back to MREC-only if ML layer degrades performance (logged as warning).

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
If a special proclamation creates a one-time holiday, add it to `PH_HOLIDAYS_STATIC` in `src/constants/index.ts`:
```typescript
export const PH_HOLIDAYS_STATIC: Record<number, string[]> = {
  2025: [..., '2025-12-09'], // Add special proclaimed holidays here
};
```
