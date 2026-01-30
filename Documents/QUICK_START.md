# Quick Start Guide

Get running with the iLoad Forecasting Utility in 5 minutes. This tool forecasts power generation and demand for the Philippine grid.

---

## Prerequisites

- Node.js 16+ and npm
- Windows/Linux/macOS

---

## Install & Build

```bash
npm install
npm run build
```

---

## Most Common Commands

### 1. Capacity Factor Forecast (Primary Use Case)

**Basic forecast:**
```bash
node dist/index.js cfac forecast2 \
  -t "Data Samples/Capacity Factor" \
  -s 2026-01-01 -e 2026-01-31 \
  -o output/cfac_january.csv
```

**Optimal for solar stations:**
```bash
node dist/index.js cfac forecast2 \
  -t "Data Samples/Capacity Factor" \
  -s 2026-01-01 -e 2026-01-31 \
  -o output/cfac_january.csv \
  --use-xgboost --asymmetric-loss
```

**Bias correction for wind:**
```bash
node dist/index.js cfac forecast2 \
  -t "Data Samples/Capacity Factor" \
  -s 2026-01-01 -e 2026-01-31 \
  -o output/cfac_january.csv \
  --bias-correction
```

### 2. Demand Forecast

```bash
node dist/index.js forecast \
  -d "Data Samples/Demand" \
  -s 2026-01-01 -e 2026-01-31 \
  -o output/demand_january.csv \
  --model hybrid
```

### 3. Evaluate Forecast Accuracy

**Capacity factor evaluation:**
```bash
node dist/index.js cfac evaluate \
  -f output/cfac_january.csv \
  -a "Data Samples/Capacity Factor/MRHCFac_actual.csv" \
  -o output/evaluation.txt
```

**Demand evaluation:**
```bash
node dist/index.js evaluate \
  -f output/demand_january.csv \
  -a "Data Samples/Demand/actual.csv"
```

### 4. Scheduler (Automated Daily Forecasts)

**Run today's forecasts:**
```bash
node dist/index.js scheduler run
```

**Backfill date range:**
```bash
node dist/index.js scheduler backfill -s 2026-01-01 -e 2026-01-31
```

**Check scheduler status:**
```bash
node dist/index.js scheduler status
```

### 5. Database Management

**Check database status:**
```bash
node dist/index.js db status
```

**Import new data:**
```bash
node dist/index.js db import -d "Data Samples/Demand" -c "Data Samples/Capacity Factor"
```

---

## Key Concepts

### Philippine Grid Regions
| Region Code | Region Name | Weather City |
|-------------|-------------|--------------|
| CLUZ | Luzon | Manila |
| CVIS | Visayas | Cebu City |
| CMIN | Mindanao | Davao City |

### Station Types
- **Wind** - Turbines (suffix `_W` or specific codes like `01BURGOS`)
- **Solar** - PV arrays (suffix `_S`)
- **Hydro** - Run-of-river and storage (suffix `_H`)
- **Geothermal** - Steam plants (suffix `_G`, `_GP`)
- **Biomass** - Bio-fueled plants (suffix `_BI`, `_BG`, `_BL`)
- **Battery** - Energy storage (suffix `_B`)

### Weather Data
- Automatically fetched from Visual Crossing API
- Station-specific coordinates for wind/solar (100m hub-height for wind)
- Cluster-based for other station types
- Cached locally in `./weather_cache/`

### Auto-Calibration
- 14-day lookback period adjusts forecasts to recent patterns
- Reduces systematic bias in predictions
- Automatically enabled (use `--no-auto-calibrate` to disable)

### Data Storage
- SQLite database: `data/iload.db` or `forecast.db`
- Stores historical data, forecasts, and model metadata
- View with SQLite browser or CLI

---

## Output Format

CSV files with columns:
- **DateTimeEnding** - Hour-ending timestamp (M/D/YYYY H:MM format)
- **Station/Region columns** - Capacity factor (0-1) or demand (MW)

Example:
```csv
DateTimeEnding,01BURGOS_W,01LAOAG_W,CLUZ,CVIS,CMIN
1/1/2026 1:00,0.45,0.52,8500,2100,1800
1/1/2026 2:00,0.48,0.55,8200,2050,1750
```

---

## GUI (Optional)

Launch graphical interface:
```bash
cd gui
npm install
npm run dev
```

Package for distribution:
```bash
npm run electron:build
```

---

## Model Performance (Typical MAPE)

| Type | Model | MAPE | Notes |
|------|-------|------|-------|
| Demand | Region-Aware Hybrid | 2-4% | XGBoost + weekend correction |
| Wind | Enhanced Hybrid | ~76% | MREC + ML with 100m data |
| Solar | Physics+ML Hybrid | ~16% | Irradiance + XGBoost |
| Hydro/Geo/Bio | Profile-based | varies | Historical patterns |

---

## Need Help?

### Full Documentation
- **CLI_REFERENCE.md** - Complete command reference with all flags
- **CAPACITY_FACTOR_GUIDE.md** - Deep dive into capacity factor forecasting
- **METHODOLOGY_REPORT.md** - Comprehensive methodology for clients
- **USER_GUIDE.md** - Workflows and advanced examples
- **TECHNICAL_OVERVIEW.md** - Architecture and internals
- **AI_AGENT_GUIDE.md** - Guide for AI assistants working with this codebase

### Quick Reference
Start with: **DOCUMENTATION_INDEX.md** in `Documents/` folder

---

## Common Issues

**Weather cache errors?**
```bash
rm -rf weather_cache
```

**Database locked?**
Close any open database connections or viewers.

**Import failures?**
Check CSV format matches expected schema (see CLI_REFERENCE.md).

---

## Example Workflow

1. **Import historical data:**
   ```bash
   node dist/index.js db import -d "Data Samples/Demand" -c "Data Samples/Capacity Factor"
   ```

2. **Generate capacity factor forecast:**
   ```bash
   node dist/index.js cfac forecast2 -t "Data Samples/Capacity Factor" -s 2026-02-01 -e 2026-02-28 -o output/cfac_feb.csv --use-xgboost --asymmetric-loss
   ```

3. **Generate demand forecast:**
   ```bash
   node dist/index.js forecast -d "Data Samples/Demand" -s 2026-02-01 -e 2026-02-28 -o output/demand_feb.csv --model hybrid
   ```

4. **Evaluate when actuals arrive:**
   ```bash
   node dist/index.js cfac evaluate -f output/cfac_feb.csv -a "Data Samples/Capacity Factor/actuals_feb.csv" -o output/feb_eval.txt
   ```

---

**You're ready to forecast!** Run your first command and check the `output/` folder for results.
