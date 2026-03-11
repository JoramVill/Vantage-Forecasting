# CLAUDE.md - Vantage Forecaster

This file provides guidance to Claude Code (claude.ai/code) when working with the Vantage Forecaster codebase.

---

## Orchestrator Integration

This project follows protocols from the central **Orchestrator** at `C:\Source_Codes\Orchestrator`.

### Subagent Output Template

When completing tasks as a subagent, end responses with:

```
---SUBAGENT-SUMMARY---
STATUS: [completed|partial|blocked|failed]
FILES_CHANGED:
- [file paths]
CHANGELOG_ENTRY: |
  ### Added/Changed/Fixed
  - [description]
ASSUMPTIONS:
- [assumptions made]
WARNINGS:
- [issues or concerns]
DOCS_NEEDING_REVIEW:
- [documents that may need updates]
---END-SUMMARY---
```

---

## Session Initialization

Before starting work on this codebase, read the following files:

1. **This file** (`CLAUDE.md`) - Primary command reference and architecture
2. `Documents/DOCUMENTATION_INDEX.md` - Navigate to relevant docs
3. `Documents/AI_AGENT_GUIDE.md` - Critical context for AI agents
4. `CHANGELOG.md` - Recent changes and current state
5. `context.md` - Current task context (if exists)

---

## Documentation Index

All documentation files in this project (verified 2026-03-11):

### Root Files

| File | Purpose | Last Verified |
|------|---------|---------------|
| `CLAUDE.md` | Primary AI agent reference - commands, models, architecture | 2026-03-04 |
| `README.md` | Project overview, quick start, installation | 2026-03-04 |
| `CHANGELOG.md` | Version history (Keep a Changelog format) | 2026-03-04 |
| `GATEKEEPER_LICENSE_INTEGRATION.md` | License validation for Apollo clients | 2026-03-04 |
| `context.md` | Current task tracking (temporary) | 2026-03-04 |

### Documents/ Folder (Active)

| File | Purpose | Last Verified |
|------|---------|---------------|
| `DOCUMENTATION_INDEX.md` | Master index for all documentation | 2026-03-04 |
| `QUICK_START.md` | 5-minute getting started guide | 2026-03-04 |
| `CLI_GUIDE.md` | Complete CLI command reference | 2026-03-04 |
| `GUI_GUIDE.md` | Desktop GUI user manual | 2026-03-04 |
| `MODEL_OVERVIEW.md` | Forecasting models and performance | 2026-03-04 |
| `TECHNICAL_OVERVIEW.md` | Architecture and code structure | 2026-03-04 |
| `DEPLOYMENT_GUIDE.md` | Portable Windows deployment | 2026-03-04 |
| `AI_AGENT_GUIDE.md` | AI agent onboarding guide | 2026-03-04 |
| `GATEWAY_FILE_SPECIFICATION.md` | Gateway file format and naming | 2026-03-04 |
| `FORECAST_FILE_API_SPEC.md` | Forecast file API specification | 2026-03-04 |

### Documents/archive/ (Historical)

| File | Purpose | Last Verified |
|------|---------|---------------|
| `DEVELOPER_GUIDE.md` | Legacy developer guide (superseded by CLAUDE.md) | 2026-03-04 |
| `USER_GUIDE.md` | Legacy user guide (superseded by GUI_GUIDE.md) | 2026-03-04 |
| `AI_QUICK_REFERENCE.md` | Legacy AI reference | 2026-03-04 |
| `CFAC_MODEL_COMPARISON_REPORT.md` | Historical model comparison | 2026-03-04 |
| `DEEP_TRAINING_SPECIFICATION.md` | LSTM training specs | 2026-03-04 |
| `PHASE2_IMPLEMENTATION_SUMMARY.md` | Phase 2 summary | 2026-03-04 |
| `PLAN_LSTM_*.md` | LSTM planning documents (3 files) | 2026-03-04 |
| `outage_analysis_report.md` | Historical outage analysis | 2026-03-04 |
| `plan.md` | Legacy planning document | 2026-03-04 |
| `interconnector_analysis/*.md` | Interconnector analysis reports (7 files) | 2026-03-04 |
| `planning/*.md` | Planning documents (6 files) | 2026-03-04 |
| `vantage-gateway/*.md` | Gateway setup docs (3 files) | 2026-03-04 |

---

## Documentation

**Read documentation first:** All docs in `Documents/` folder. Start with `DOCUMENTATION_INDEX.md`.

Key guides:
- `GUI_GUIDE.md` - Desktop GUI user manual with CLI command mappings
- `CLI_GUIDE.md` - Complete CLI command reference
- `MODEL_OVERVIEW.md` - Forecasting model descriptions and performance
- `AI_AGENT_GUIDE.md` - AI agent onboarding and critical context
- `DEPLOYMENT_GUIDE.md` - Portable Windows deployment instructions

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

### Portable Deployment (Windows)
```bash
# Full portable build with all data (~600MB ZIP)
node scripts/build-portable.cjs --zip --clean

# App-only update (no data, ~150MB)
node scripts/build-portable.cjs --no-data --zip

# Create data update packs
node scripts/create-data-pack.cjs --type weather    # Weather cache only
node scripts/create-data-pack.cjs --type training   # Training data only
node scripts/create-data-pack.cjs --type databases  # Databases only
node scripts/create-data-pack.cjs --type all        # Full data pack
```

**Output:** `portable-build/VantageForecaster/` - Self-contained folder with bundled Node.js, no installation required.

See `Documents/DEPLOYMENT_GUIDE.md` for full deployment documentation.

---

## CLI Commands

### Capacity Factor Forecasting (Primary)
| Command | Description |
|---------|-------------|
| `cfac forecast2` | **RECOMMENDED** - Hybrid model (physics + ML correction) with auto-calibration |
| `cfac forecast3` | Enhanced Hybrid with EMA wind smoothing (`--smooth 0.5`) |
| `cfac evaluate` | Evaluate forecast accuracy vs actual |
| `cfac mrec compare3` | Compare wind model variants |

**Recommended Model:** Hybrid (physics + ML correction) with auto-calibration
- Wind: ~73% MAPE (4-Tier Hybrid on test data)
- Solar: ~16% MAPE (Physics+ML with per-station calibration)

### Demand Forecasting
| Command | Description |
|---------|-------------|
| `train` | Train XGBoost/Regression on demand + weather |
| `forecast` | Generate demand forecasts (regional or zonal) |
| `evaluate` | Compare forecast vs actual |

**LSTM Trainer (Python):**
| Command | Description |
|---------|-------------|
| `python scripts/train_demand_lstm.py` | Train enhanced LSTM correction models for zonal demand |

### Scheduler (Background Service)
| Command | Description |
|---------|-------------|
| `scheduler run` | Run daily + weekly forecast for today |
| `scheduler backfill -s <start> -e <end>` | Generate forecasts for date range |
| `scheduler evaluate` | Evaluate pending forecasts against actuals |
| `scheduler status` | Show run history and metrics |
| `scheduler service` | Run as background service (daily at 6 AM) |
| `scheduler config get/set/reset` | Manage scheduler configuration |

### Gateway Integration
| Command | Description |
|---------|-------------|
| `gateway push <file>` | Push forecast to Vantage Gateway via SFTP |
| `gateway push --all` | Push all archived forecasts to gateway |
| `gateway push --category <cat>` | Push specific category (day-ahead-demand, week-ahead-demand, etc.) |

**Gateway categories:**
- `day-ahead-demand` - Next-day demand forecasts
- `day-ahead-mhcf` - Next-day capacity factor forecasts
- `week-ahead-demand` - 7-day demand forecasts
- `week-ahead-mhcf` - 7-day capacity factor forecasts

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
| **Wind** | **4-Tier Hybrid** | **~73%** | **BEST** - physics + ML with auto-calibration |
| **Solar** | **Physics+ML Hybrid** | **~16%** | **BEST** - irradiance physics + ML + per-station calibration |
| Hydro/Geothermal/Biomass/Battery | Profile-based | varies | Historical pattern matching |

**Hybrid is the recommended model for all station types.** Use `cfac forecast2` (default command).

**Note on LSTM:** LSTM models are experimental and currently underperform hybrid models. The LSTM code remains in the codebase (`src/models/capacityFactor/WindLSTMModel.ts`, `SolarLSTMModel.ts`) for future development as a weather-to-CFAC correction layer.

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
- `src/models/DemandCorrectionLSTM.ts` - LSTM correction layer (optional, enabled with --lstm-correction flag)

**Capacity Factor (Production - RECOMMENDED):**
- `src/models/capacityFactor/WindEnhancedHybridModel.ts` - **BEST** Wind 4-Tier Hybrid (MREC + ML) ~73% MAPE
- `src/models/capacityFactor/SolarHybridModel.ts` - **BEST** Solar Physics+ML Hybrid ~16% MAPE
- `src/models/capacityFactor/WindMRECModel.ts` - iPool MREC three-tier algorithm
- `src/models/capacityFactor/SolarIrradianceModel.ts` - Solar physics base model
- `src/models/capacityFactor/CFacXGBoostRegressor.ts` - XGBoost for ML layer (legacy option)
- `src/models/capacityFactor/BiasCorrector.ts` - Station-specific bias correction

**Capacity Factor (Experimental - NOT RECOMMENDED):**
- `src/models/capacityFactor/WindLSTMModel.ts` - Wind LSTM (experimental, underperforms hybrid)
- `src/models/capacityFactor/SolarLSTMModel.ts` - Solar LSTM (experimental, underperforms hybrid)
- `scripts/cfac_forecast_lstm.cjs` - LSTM forecasting script (experimental)

---

## Complete Forecast Commands

### 1. Capacity Factor Forecast (cfac forecast2) - RECOMMENDED

**Hybrid model (physics + ML correction) provides the best accuracy for Wind and Solar forecasting.**

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

**Model Performance:**
| Station Type | Hybrid MAPE | Notes |
|--------------|-------------|-------|
| Wind | ~73% | 4-Tier Hybrid with auto-calibration |
| Solar | ~16% | Physics+ML with per-station calibration |

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

**With LSTM correction layer (improved morning ramp dynamics):**
```bash
node dist/index.js forecast \
  -d "Data Samples/Demand" \
  -s 2025-12-01 \
  -e 2025-12-31 \
  -o output/demand_december.csv \
  --model hybrid \
  --lstm-correction
```

The LSTM correction layer improves temporal dynamics, particularly:
- Morning ramp (6-9 AM) correlation
- Evening ramp (5-7 PM) patterns
- Peak timing accuracy
- Day-type transitions (Friday→Saturday patterns)

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
| `--lstm-correction` | Enable LSTM correction layer for hybrid model (improves morning ramp) |
| `--zonal` | Use 14-zone sub-region mode instead of 3 regions (Luzon: 01NLUZ, 02METRO, 03SLUZ; Visayas: 04LEYTE, 05CEBU, 06NEGROS, 07BOHOL, 08PANAY; Mindanao: 09NWMIN, 10LANAO, 11NCMIN, 12NEMIN, 13SEMIN, 14SWMIN) |
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

**Run with weather refresh (recommended for future dates):**
```bash
node dist/index.js scheduler run \
  -d 2025-10-15 \
  --refresh-weather
```

**Backfill date range:**
```bash
node dist/index.js scheduler backfill \
  -s 2025-10-01 -e 2025-10-31 \
  --daily --demand-only
```

**Backfill with overwrite (regenerate existing forecasts):**
```bash
node dist/index.js scheduler backfill \
  -s 2025-10-01 -e 2025-10-31 \
  --overwrite \
  --suffix "revised"
```

**View status and history:**
```bash
node dist/index.js scheduler status
```

**Manage configuration:**
```bash
# View current configuration
node dist/index.js scheduler config get

# Set configuration values
node dist/index.js scheduler config set demand_training_path "Data Samples/Demand"
node dist/index.js scheduler config set cfac_training_path "Data Samples/Capacity Factor"
node dist/index.js scheduler config set auto_push_gateway true

# Reset to defaults
node dist/index.js scheduler config reset
```

**All scheduler run flags:**
| Flag | Description |
|------|-------------|
| `-d, --date <date>` | As-of date (YYYY-MM-DD), default: today |
| `--demand-only` | Only generate demand forecasts |
| `--daily` | Daily (next-day) forecasts only |
| `--weekly` | Weekly (7-day) forecasts only |
| `--output <dir>` | Output directory (default: `./output`) |
| `--db <path>` | Database path (default: `./forecast.db`) |
| `--refresh-weather` | Force weather cache refresh (recommended for future dates) |
| `--no-push` | Skip gateway push |
| `--no-archive` | Skip forecast archiving |

**All scheduler backfill flags:**
| Flag | Description |
|------|-------------|
| `-s, --start <date>` | Backfill start date (required) |
| `-e, --end <date>` | Backfill end date (required) |
| `--demand-only` | Only generate demand forecasts |
| `--daily` | Daily (next-day) forecasts only |
| `--weekly` | Weekly (7-day) forecasts only |
| `--output <dir>` | Output directory (default: `./output`) |
| `--db <path>` | Database path (default: `./forecast.db`) |
| `--overwrite` | Regenerate existing forecasts |
| `--suffix <text>` | Append custom suffix to archived filenames |

**Scheduler configuration keys:**
| Key | Description | Default |
|-----|-------------|---------|
| `demand_training_path` | Path to demand training data | `Data Samples/Demand` |
| `cfac_training_path` | Path to capacity factor training data | `Data Samples/Capacity Factor` |
| `weather_cache_dir` | Weather cache directory | `./weather_cache` |
| `auto_push_gateway` | Auto-push to Vantage Gateway | `false` |
| `archive_forecasts` | Enable forecast archiving | `true` |
| `archive_path` | Archive directory path | `./output/archive` |

**Output Structure:**
```
output/forecasts/
└── 2025-10-15/           # As-of date folder
    ├── demand_daily.csv   # Next-day forecast (Oct 16)
    └── demand_weekly.csv  # 7-day forecast (Oct 16-22)

output/archive/
├── D+1_demand_2025-10-15_2025-10-16_2025-10-16.csv
└── D+7_demand_2025-10-15_2025-10-16_2025-10-22.csv
```

---

## LSTM Demand Correction Training (Python)

### Overview
The LSTM V2 trainer learns temporal patterns and multi-city weather correlations to improve demand forecasts, particularly for morning ramp dynamics (6-9 AM) and peak timing accuracy.

### Prerequisites
```bash
pip install tensorflow pandas holidays
```

### Training Command
```bash
# Train LSTM for a specific zone
python scripts/train_demand_lstm.py \
  --zone 01NLUZ \
  --output models/lstm

# Train all 14 zones
python scripts/train_demand_lstm.py \
  --all \
  --output models/lstm \
  --epochs 100
```

### Command Flags
| Flag | Description | Required |
|------|-------------|----------|
| `--zone <code>` | Zone code to train (e.g., 01NLUZ, 02METRO) | Yes (unless --all) |
| `--all` | Train all 14 zones sequentially | No |
| `--config <path>` | Configuration file path | No (default: `config/lstm_config.json`) |
| `--output <dir>` | Output directory for models | No (default: from config) |
| `--epochs <n>` | Training epochs | No (default: from config, typically 100) |

### Configuration Files

**`config/lstm_config.json`** - LSTM training configuration
- **Training parameters**: sequence_length (48 hours), batch_size (64), learning_rate (0.0005)
- **Model architecture**: LSTM(64) → LSTM(32) → Dense(32) → Dense(16) → Output
- **Feature groups**: 98 features (6-city zones) or 74 features (3-city zones)
- **Normalization**: Weather (temp, humidity, solar), demand (10000 MW scale)
- **Correction range**: 0.85-1.15 (±15% adjustment to hybrid model base forecast)

**`src/data/zones.json`** - Zone and city configuration
- **14 zones**: Each with 3-6 cities for weather learning
- **Per-zone LSTM config**: Enabled/disabled flag, priority cities, performance notes
- **City metadata**: Coordinates, location IDs for weather fetching

### Feature Engineering
The LSTM trainer extracts 74-98 features per timestep:

| Feature Group | Count | Description |
|---------------|-------|-------------|
| **Per-city weather** | 48 (6×8) | Temperature, humidity, cloudcover, solar radiation (×6 cities, padded) |
| **Aggregated weather** | 8 | Mean/max/spread temperature, city coverage metrics |
| **Demand features** | 10 | Current demand, lags (1h/24h/168h), rolling averages, ramp rate |
| **Temporal features** | 18 | Hour/day/month cyclical encoding, weekend/holiday flags, time periods |
| **Calendar features** | 8 | Holiday detection, days until/since holiday, special periods |
| **Seasonal features** | 6 | Wet/dry season (Philippines), El Niño/La Niña flags |

### Output
The trainer exports:
- **Model weights** (JSON): `models/lstm/lstm_<ZONE>_v2.json`
- **Training summary**: Validation/test metrics, epochs trained, sample counts
- **Summary report**: `models/lstm/training_summary_v2.json` with all zone results

### Using LSTM Correction in Forecasting
```bash
# Enable LSTM correction for demand forecast
node dist/index.js forecast \
  -d "Data Samples/Demand" \
  -s 2025-12-01 \
  -e 2025-12-31 \
  -o output/demand_forecast.csv \
  --model hybrid \
  --lstm-correction
```

**Impact:**
- **Morning ramp (6-9 AM)**: Improved correlation from negative to positive
- **Peak timing**: Reduced error from 3-5 hours to <1 hour
- **Day transitions**: Better Friday→Saturday, weekend→workday patterns

### Zone Codes Reference
| Region | Zones |
|--------|-------|
| **Luzon** | 01NLUZ (Northern), 02METRO (Manila), 03SLUZ (Southern) |
| **Visayas** | 04LEYTE, 05CEBU, 06NEGROS, 07BOHOL, 08PANAY |
| **Mindanao** | 09NWMIN (Northwest), 10LANAO, 11NCMIN (North Central), 12NEMIN (Northeast), 13SEMIN (Southeast), 14SWMIN (Southwest) |

---

## Zonal Mode (14 Sub-Regions)

### Overview
Zonal mode provides demand forecasts for 14 sub-regions instead of 3 main regions, enabling granular grid analysis. Uses 42 weather cities (3 per zone) for improved local accuracy.

### Zonal vs Regional Mode
| Aspect | Regional (3) | Zonal (14) |
|--------|--------------|------------|
| **Regions** | CLUZ, CVIS, CMIN | 01NLUZ, 02METRO, 03SLUZ, 04LEYTE, 05CEBU, 06NEGROS, 07BOHOL, 08PANAY, 09NWMIN, 10LANAO, 11NCMIN, 12NEMIN, 13SEMIN, 14SWMIN |
| **Weather cities** | 3 (Manila, Cebu, Davao) | 42 (3 per zone) |
| **Database** | `iload.db` | `iload_zonal.db` |
| **Use case** | System-wide forecasting | Sub-regional dispatch planning |

### Zonal Forecast Command
```bash
# Basic zonal forecast
node dist/index.js forecast \
  -d "Data Samples/Demand" \
  -s 2025-12-01 \
  -e 2025-12-31 \
  -o output/zonal_demand_forecast.csv \
  --zonal

# With LSTM correction
node dist/index.js forecast \
  -d "Data Samples/Demand" \
  -s 2025-12-01 \
  -e 2025-12-31 \
  -o output/zonal_demand_forecast.csv \
  --zonal \
  --lstm-correction
```

### Database Import for Zonal Mode
```bash
# Import zonal demand data
node dist/index.js db import \
  -t demand \
  -f "Data Samples/Demand" \
  --db iload_zonal.db

# Use zonal database in forecast
node dist/index.js forecast \
  -s 2025-12-01 \
  -e 2025-12-31 \
  -o output/zonal_forecast.csv \
  --zonal \
  --use-db
```

### Weather Fetching (Zonal Mode)
Zonal mode automatically fetches weather for 42 cities defined in `ZONAL_LOCATIONS` (src/services/weatherService.ts). Weather is cached in `weather_cache/zonal/` directory.

**Zone-to-Cities Mapping** (from `src/data/zones.json`):
- **01NLUZ**: San Fernando, Baguio, Tuguegarao, Laoag, Dagupan, Angeles
- **02METRO**: Manila, Quezon City, Makati
- **03SLUZ**: Batangas, Lucena, Legazpi
- (See zones.json for complete list)

### Zonal Output Format
CSV file with columns:
```
datetime,01NLUZ,02METRO,03SLUZ,04LEYTE,05CEBU,06NEGROS,07BOHOL,08PANAY,09NWMIN,10LANAO,11NCMIN,12NEMIN,13SEMIN,14SWMIN
2025-12-01 00:00,1250.5,3200.8,1800.3,...
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
| `src/models/` | Demand models (Regression, XGBoost, Hybrid, LSTM inference) |
| `src/models/capacityFactor/` | Wind/Solar/Profile capacity factor models |
| `src/services/` | Weather API (Visual Crossing), capacityFactorService |
| `src/database/` | SQLite persistence via better-sqlite3 (iload.db, iload_zonal.db) |
| `src/data/stations.json` | Station metadata, coordinates, weather clusters |
| `src/data/zones.json` | Zonal configuration (14 zones, 42 cities) |
| `config/lstm_config.json` | LSTM training configuration |
| `scripts/train_demand_lstm.py` | Python LSTM trainer (requires TensorFlow) |
| `models/lstm/` | Trained LSTM weights (exported as JSON) |

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
