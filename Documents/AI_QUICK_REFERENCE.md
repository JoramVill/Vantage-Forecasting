# AI Quick Reference - Vantage Forecaster

Quick reference for AI agents working with Vantage Forecaster codebase.

---

## Critical Files to Read First

1. **`CLAUDE.md`** - Main AI reference with commands and configurations
2. **`Documents/CLI_GUIDE.md`** - Complete CLI command reference
3. **`Documents/MODEL_OVERVIEW.md`** - Model performance and selection
4. **`Documents/DOCUMENTATION_INDEX.md`** - Navigation to all docs

---

## Key Concepts

### Forecast Types
| Type | Output | Model | Typical MAPE |
|------|--------|-------|--------------|
| **Regional Demand** | 3 regions (CLUZ, CVIS, CMIN) | Hybrid (XGBoost + profiles) | 2-4% |
| **Zonal Demand** | 14 zones (01NLUZ, 02METRO, ...) | Hybrid + LSTM correction | 2-5% |
| **Capacity Factor** | Per-station renewable output | Wind: 4-Tier Hybrid, Solar: Physics+ML | Wind: ~73%, Solar: ~16% |

### Modes
| Mode | Database | Weather Cities | Use Case |
|------|----------|----------------|----------|
| **Regional** | `iload.db` | 3 (Manila, Cebu, Davao) | System-wide forecasting |
| **Zonal** | `iload_zonal.db` | 42 (3 per zone) | Sub-regional dispatch |

---

## Common Commands

### Demand Forecasting

**Regional (3 regions):**
```bash
node dist/index.js forecast -s 2025-12-01 -e 2025-12-31 -o output/demand.csv --model hybrid
```

**Zonal (14 sub-regions):**
```bash
node dist/index.js forecast -s 2025-12-01 -e 2025-12-31 -o output/zonal.csv --zonal
```

**With LSTM correction:**
```bash
node dist/index.js forecast -s 2025-12-01 -e 2025-12-31 -o output/demand.csv --model hybrid --lstm-correction
```

### Capacity Factor Forecasting

**Wind + Solar:**
```bash
node dist/index.js cfac forecast2 -t "Data Samples/Capacity Factor" -s 2025-12-01 -e 2025-12-31 -o output/cfac.csv
```

**Optimal solar settings:**
```bash
node dist/index.js cfac forecast2 -t "Data Samples/Capacity Factor" -s 2025-12-01 -e 2025-12-31 -o output/cfac.csv --use-xgboost --asymmetric-loss
```

### LSTM Training (Python)

**Train single zone:**
```bash
python scripts/train_demand_lstm.py --zone 01NLUZ --output models/lstm
```

**Train all 14 zones:**
```bash
python scripts/train_demand_lstm.py --all --epochs 100
```

---

## Configuration Files

| File | Purpose | Format |
|------|---------|--------|
| `config/lstm_config.json` | LSTM training parameters | JSON |
| `src/data/zones.json` | 14 zones + 42 cities configuration | JSON |
| `src/data/stations.json` | Renewable station metadata | JSON |
| `config.json` | Visual Crossing API key (optional) | JSON |

---

## Directory Structure

```
Vantage-Forecaster/
├── src/
│   ├── models/
│   │   ├── hybridModel.ts              # Regional demand model
│   │   ├── DemandLSTMInference.ts      # LSTM correction layer
│   │   └── capacityFactor/             # Wind/Solar models
│   ├── data/
│   │   ├── zones.json                  # 14 zones, 42 cities
│   │   └── stations.json               # Renewable stations
│   ├── parsers/                        # CSV parsing
│   ├── features/                       # Feature engineering
│   ├── services/                       # Weather API, CFAC service
│   └── database/                       # SQLite persistence
├── scripts/
│   └── train_demand_lstm.py            # Python LSTM trainer
├── config/
│   └── lstm_config.json                # LSTM training config
├── models/lstm/                        # Trained LSTM weights (JSON)
├── Data Samples/
│   ├── Demand/                         # Historical demand CSVs
│   └── Capacity Factor/                # Historical CFAC CSVs
├── Documents/                          # All documentation
└── CLAUDE.md                           # Main AI reference
```

---

## Zone Codes Reference

### Luzon (3 zones)
- **01NLUZ** - Northern Luzon (6 cities: San Fernando, Baguio, Tuguegarao, Laoag, Dagupan, Angeles)
- **02METRO** - Metro Manila (3 cities: Manila, Quezon City, Makati)
- **03SLUZ** - Southern Luzon (3 cities: Batangas, Lucena, Legazpi)

### Visayas (5 zones)
- **04LEYTE** - Leyte/Eastern Visayas (3 cities)
- **05CEBU** - Cebu (3 cities)
- **06NEGROS** - Negros (3 cities)
- **07BOHOL** - Bohol (3 cities)
- **08PANAY** - Panay/Western Visayas (3 cities)

### Mindanao (6 zones)
- **09NWMIN** - Northwest Mindanao (3 cities)
- **10LANAO** - Lanao (3 cities)
- **11NCMIN** - North Central Mindanao (3 cities)
- **12NEMIN** - Northeast Mindanao (3 cities)
- **13SEMIN** - Southeast Mindanao (3 cities)
- **14SWMIN** - Southwest Mindanao (3 cities)

---

## Model Selection Guide

### Demand Forecasting
| Scenario | Model | Flags |
|----------|-------|-------|
| **Quick baseline** | Hybrid | `--model hybrid` |
| **Best accuracy** | Hybrid + LSTM | `--model hybrid --lstm-correction` |
| **Zonal forecast** | Hybrid (14 zones) | `--zonal` |
| **Zonal + best accuracy** | Hybrid + LSTM | `--zonal --lstm-correction` |

### Capacity Factor Forecasting
| Station Type | Recommended Flags | Expected MAPE |
|--------------|------------------|---------------|
| **Solar** | `--use-xgboost --asymmetric-loss` | ~16% |
| **Wind** | None (default 4-Tier Hybrid) | ~73% |
| **Mixed** | Default | Varies |

---

## LSTM Feature Engineering

**Total features: 74-98 per timestep**

| Group | Count | Examples |
|-------|-------|----------|
| **Per-city weather** | 48 (6×8) | Temperature, humidity, cloudcover, solar radiation |
| **Aggregated weather** | 8 | Mean/max/spread temperature, city coverage |
| **Demand** | 10 | Current demand, lags (1h/24h/168h), ramp rate |
| **Temporal** | 18 | Hour/day/month cyclical, weekend/holiday flags |
| **Calendar** | 8 | Philippines holidays, holiday distance |
| **Seasonal** | 6 | Wet/dry season (Jun-Nov/Mar-May/Dec-Feb) |

---

## Weather Fetching

**Automatic weather fetching via Visual Crossing API:**
- Regional mode: 3 cities (Manila, Cebu, Davao)
- Zonal mode: 42 cities (3 per zone from `zones.json`)
- Wind stations: 100m hub-height data
- Solar stations: UV index included
- Cache location: `./weather_cache/`

**API key priority:**
1. `VISUAL_CROSSING_API_KEY` environment variable
2. `config.json` → `visualCrossingApiKey` field
3. Built-in default key

---

## Database Management

**Regional database (`iload.db`):**
```bash
# Import demand data
node dist/index.js db import -t demand -f "Data Samples/Demand"

# View status
node dist/index.js db status
```

**Zonal database (`iload_zonal.db`):**
```bash
# Import zonal demand data
node dist/index.js db import -t demand -f "Data Samples/Demand" --db iload_zonal.db

# Use in forecast
node dist/index.js forecast -s 2025-12-01 -e 2025-12-31 -o output/zonal.csv --zonal --use-db
```

---

## Troubleshooting

### LSTM Not Working
1. Check if models exist: `ls models/lstm/lstm_*_v2.json`
2. Verify weather cache: `ls weather_cache/zonal/`
3. Ensure TensorFlow installed: `pip install tensorflow`

### Zonal Mode Missing Columns
1. Verify CSV has 14 zone columns (01NLUZ, 02METRO, ...)
2. Check parser output: should detect 14 regions
3. Use correct database: `--db iload_zonal.db`

### Weather Cache Issues
1. Delete cache: `rm -rf weather_cache/<CLUSTER_NAME>`
2. Re-run forecast to fetch fresh data
3. For future dates, refresh cache after dates pass

### Capacity Factor Flat Forecasts
1. Check weather cache completeness
2. For past dates: delete cache and re-fetch
3. Verify weather files are not empty (~3KB per file)

---

## Quick Testing

**Test regional forecast:**
```bash
npm run build
node dist/index.js forecast -s 2025-12-01 -e 2025-12-07 -o test_regional.csv --model hybrid
```

**Test zonal forecast:**
```bash
node dist/index.js forecast -s 2025-12-01 -e 2025-12-07 -o test_zonal.csv --zonal
```

**Test CFAC forecast:**
```bash
node dist/index.js cfac forecast2 -t "Data Samples/Capacity Factor" -s 2025-12-01 -e 2025-12-07 -o test_cfac.csv
```

---

## When to Use Each Document

| Question | Document |
|----------|----------|
| "What command do I run?" | `CLAUDE.md` or `Documents/CLI_GUIDE.md` |
| "How accurate is this model?" | `Documents/MODEL_OVERVIEW.md` |
| "How does the code work?" | `Documents/TECHNICAL_OVERVIEW.md` |
| "Quick start guide?" | `Documents/QUICK_START.md` |
| "How to use the GUI?" | `Documents/GUI_GUIDE.md` |

---

## Best Practices

1. **Always read CLAUDE.md first** for context and command reference
2. **Check model performance** in MODEL_OVERVIEW.md before choosing models
3. **Use --zonal for sub-regional forecasts**, regional for system-wide
4. **Train LSTM models once**, then use `--lstm-correction` in forecasts
5. **Refresh weather cache** after forecast dates pass for accurate evaluation
6. **Use cfac forecast2** (not forecast) for capacity factor forecasting
7. **Enable auto-calibration** (default) for CFAC forecasts
8. **Check database mode** (regional vs zonal) before importing/forecasting

---

Last updated: 2026-02-25
