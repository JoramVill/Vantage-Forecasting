# Documentation Index - iLoad Forecasting Utility

**Last Updated:** December 22, 2025
**Version:** 3.1 - Station-Specific Weather & Improved Accuracy

---

## Quick Navigation

### For New Users
1. **[QUICK_START.md](QUICK_START.md)** - Get running in 5 minutes
2. **[CLI_REFERENCE.md](CLI_REFERENCE.md)** - Complete command reference
3. **[USER_GUIDE.md](USER_GUIDE.md)** - Comprehensive workflows

### For Capacity Factor Forecasting
1. **[CAPACITY_FACTOR_GUIDE.md](CAPACITY_FACTOR_GUIDE.md)** - **START HERE** for CFac forecasting
2. **[CLI_REFERENCE.md](CLI_REFERENCE.md)** - `cfac` commands reference

### For Interconnector Analysis
1. **[interconnector_analysis/INTERCONNECTOR_FINAL_SUMMARY.md](interconnector_analysis/INTERCONNECTOR_FINAL_SUMMARY.md)** - Start here
2. **[CLI_REFERENCE.md](CLI_REFERENCE.md)** - `interconnector` commands

### For Developers
1. **[TECHNICAL_OVERVIEW.md](TECHNICAL_OVERVIEW.md)** - Architecture and design
2. **[APPLICATION_OVERVIEW.md](APPLICATION_OVERVIEW.md)** - System capabilities

---

## Core Documentation

### Essential User Guides

| Document | Description | When to Use |
|----------|-------------|-------------|
| **[QUICK_START.md](QUICK_START.md)** | Fast setup guide | First-time setup |
| **[USER_GUIDE.md](USER_GUIDE.md)** | Comprehensive workflows | Detailed usage |
| **[CLI_REFERENCE.md](CLI_REFERENCE.md)** | All commands with options | Command lookup |
| **[CAPACITY_FACTOR_GUIDE.md](CAPACITY_FACTOR_GUIDE.md)** | CFac forecasting guide | Renewable forecasting |

### Technical Documentation

| Document | Description | Audience |
|----------|-------------|----------|
| **[METHODOLOGY_REPORT.md](METHODOLOGY_REPORT.md)** | Forecasting methodology | Clients, Stakeholders |
| **[TECHNICAL_OVERVIEW.md](TECHNICAL_OVERVIEW.md)** | System architecture | Developers |
| **[APPLICATION_OVERVIEW.md](APPLICATION_OVERVIEW.md)** | Capabilities overview | Stakeholders |

---

## Capacity Factor Forecasting (v2.0)

### Key Features
- **Weather-Only MREC Hybrid** for wind (75.8% MAPE)
- **Physics+ML Hybrid** for solar (~16% MAPE)
- **Profile-based models** for hydro, geothermal, biomass, battery
- Automatic 100m hub-height wind data for wind farms

### Quick Command
```bash
# Generate optimal forecast using best models for each station type
node dist/index.js cfac forecast2 \
  -t "Data Samples/Capacity Factor" \
  -s 2025-11-01 \
  -e 2025-12-31 \
  -o output/cfac_optimal_forecast.csv
```

### Model Performance

| Station Type | Model | Test MAPE |
|--------------|-------|-----------|
| Wind | Weather-Only MREC Hybrid | ~75.8% |
| Solar | Physics+ML Hybrid | ~16% |
| Geothermal | Profile-based | ~15-35% |
| Others | Profile-based | varies |

See **[CAPACITY_FACTOR_GUIDE.md](CAPACITY_FACTOR_GUIDE.md)** for details.

---

## Interconnector Constraint Prediction

**Location:** `Documents/interconnector_analysis/`

### Start Here
**[INTERCONNECTOR_FINAL_SUMMARY.md](interconnector_analysis/INTERCONNECTOR_FINAL_SUMMARY.md)**

### Analysis Reports
- **[NOVEMBER_2025_CONSTRAINT_WEATHER_REPORT.md](interconnector_analysis/NOVEMBER_2025_CONSTRAINT_WEATHER_REPORT.md)** - Latest analysis
- **[CONSTRAINT_DETECTION_FINDINGS.md](interconnector_analysis/CONSTRAINT_DETECTION_FINDINGS.md)** - Detection algorithm
- **[MODEL_COMPARISON_REPORT.md](interconnector_analysis/MODEL_COMPARISON_REPORT.md)** - Model evaluation

---

## Documentation by Use Case

### "I want to forecast capacity factors"
1. **[CAPACITY_FACTOR_GUIDE.md](CAPACITY_FACTOR_GUIDE.md)** - Complete guide
2. **[CLI_REFERENCE.md](CLI_REFERENCE.md)** - `cfac forecast2` command
3. Use `cfac mrec compare3` to validate wind models

### "I want to run demand forecasting"
1. **[QUICK_START.md](QUICK_START.md)** - Fast setup
2. **[USER_GUIDE.md](USER_GUIDE.md)** - Detailed workflows
3. **[CLI_REFERENCE.md](CLI_REFERENCE.md)** - `train` and `forecast` commands

### "I want to predict interconnector constraints"
1. **[INTERCONNECTOR_FINAL_SUMMARY.md](interconnector_analysis/INTERCONNECTOR_FINAL_SUMMARY.md)**
2. **[CLI_REFERENCE.md](CLI_REFERENCE.md)** - `interconnector` commands

### "I need to prepare data files"
1. **[CLI_REFERENCE.md](CLI_REFERENCE.md)** - Data format specifications
2. **[USER_GUIDE.md](USER_GUIDE.md)** - Data management

---

## File Organization

```
iLoad_Forecasting_Utility/
├── Documents/
│   ├── DOCUMENTATION_INDEX.md      # This file
│   │
│   ├── QUICK_START.md              # Fast setup
│   ├── USER_GUIDE.md               # Comprehensive guide
│   ├── CLI_REFERENCE.md            # Command reference
│   ├── CAPACITY_FACTOR_GUIDE.md    # CFac forecasting (NEW)
│   │
│   ├── APPLICATION_OVERVIEW.md     # System overview
│   ├── TECHNICAL_OVERVIEW.md       # Architecture
│   │
│   ├── interconnector_analysis/    # Interconnector docs
│   │   ├── INTERCONNECTOR_FINAL_SUMMARY.md
│   │   ├── CONSTRAINT_DETECTION_FINDINGS.md
│   │   ├── MODEL_COMPARISON_REPORT.md
│   │   └── ...
│   │
│   └── planning/                   # Archived planning docs
│       ├── INTERCONNECTOR_IMPLEMENTATION_PLAN.md
│       ├── iPool_Renewable_Generation_Analysis.md
│       └── MREC_ML_HYBRID_DESIGN.md
```

---

## Quick Command Reference

### Capacity Factor Forecasting
```bash
# Optimal forecast (recommended)
iload cfac forecast2 -t "Data Samples/Capacity Factor" -s 2025-12-01 -e 2025-12-31 -o cfac.csv

# Compare wind models
iload cfac mrec compare3 -t "Data Samples/Capacity Factor" -a "Data Samples/Capacity Factor"

# Evaluate forecast
iload cfac evaluate -f forecast.csv -a actual.csv
```

### Demand Forecasting
```bash
# Train model
iload train -d demand.csv -w weather.csv --model hybrid

# Generate forecast
iload forecast -s 2025-12-01 -e 2025-12-07 --use-db -o forecast.csv
```

### Interconnector Analysis
```bash
# Import data
iload interconnector import -f "RTDHS_folder" --start 2025-11-01 --end 2025-11-30

# Train model
iload interconnector train --start 2025-07-01 --end 2025-11-30 --model xgboost
```

---

## Feature Status

| Feature | Status | Documentation |
|---------|--------|---------------|
| Demand Forecasting | Production | USER_GUIDE.md |
| **Capacity Factor (v2)** | **Production** | **CAPACITY_FACTOR_GUIDE.md** |
| Weather Integration | Production | CLI_REFERENCE.md |
| Database Management | Production | CLI_REFERENCE.md |
| Outage Analysis | Production | CLI_REFERENCE.md |
| Interconnector Detection | Complete | interconnector_analysis/ |
| Interconnector Prediction | Experimental | INTERCONNECTOR_FINAL_SUMMARY.md |

---

## Recent Updates

### December 22, 2025 - Station-Specific Weather & Improved Accuracy (v2.1)

**Performance Improvements:**
- Solar MAPE improved from 59.6% to ~16% (measured against actual data)
- Fixed `--solar-seasonal` flag over-forecasting bug (01LIMAY +296% error)

**New Features:**
- Station-specific weather coordinates for 117 stations
- Optimal wind height per station (10m-100m based on correlation analysis)
- XGBoost option for ML residual learning
- Asymmetric loss option for under-prediction penalty

**New Documentation:**
- **[METHODOLOGY_REPORT.md](METHODOLOGY_REPORT.md)** - Comprehensive forecasting methodology

### December 11, 2025 - Optimal Capacity Factor Forecasting (v2.0)

**New Features:**
- `cfac forecast2` command with optimal model selection
- Weather-Only MREC Hybrid for wind (21% improvement over baseline)
- Physics+ML Hybrid for solar
- `cfac mrec compare3` for three-way model comparison

**New Documentation:**
- **[CAPACITY_FACTOR_GUIDE.md](CAPACITY_FACTOR_GUIDE.md)** - Comprehensive CFac guide
- Updated **[CLI_REFERENCE.md](CLI_REFERENCE.md)** with new commands

**Key Finding:**
Weather-only ML features avoid overfitting across monsoon season transitions, achieving 75.8% MAPE vs 110.8% for temporal features.

---

## Archived/Planning Documents

Located in `Documents/planning/`:
- **INTERCONNECTOR_IMPLEMENTATION_PLAN.md** - Original implementation plan
- **iPool_Renewable_Generation_Analysis.md** - iPool algorithm analysis
- **MREC_ML_HYBRID_DESIGN.md** - Hybrid model design notes

These documents are historical and may not reflect current implementation.

---

## Getting Help

1. **Check documentation** - Start with this index
2. **Quick start** - See [QUICK_START.md](QUICK_START.md)
3. **Command help** - Run `iload <command> --help`
4. **Troubleshooting** - See [USER_GUIDE.md](USER_GUIDE.md)
5. **Sample data** - Check `Data Samples/` directory

---

**Documentation Version:** 3.1
**Last Updated:** December 22, 2025
