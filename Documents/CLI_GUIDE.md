# CLI Guide

Complete command-line reference for the iLoad Forecasting Utility.

---

## Build and Run

```bash
# Build TypeScript
npm run build

# Run CLI command
node dist/index.js <command> [options]

# Development mode (auto-rebuild)
npm run dev -- <command> [options]
```

---

## Command Reference

### 1. train - Train Demand Models

Train machine learning models on historical demand and weather data.

**Usage:**
```bash
node dist/index.js train \
  -d "Data Samples/Demand" \
  -w weather_manila.csv weather_cebu.csv weather_davao.csv \
  -o ./output \
  --model both
```

**Flags:**
| Flag | Description | Required |
|------|-------------|----------|
| `-d, --demand <file>` | Historical demand CSV file | Yes |
| `-w, --weather <files...>` | Space-separated weather CSV files | Yes |
| `-o, --output <dir>` | Output directory for reports | No (default: `./output`) |
| `--model <type>` | Model type: `regression`, `xgboost`, or `both` | No (default: `both`) |

**Output:**
- Trained model saved to database
- Evaluation metrics (MAPE, MAE, RMSE)
- Feature importance report (if `--model xgboost`)

---

### 2. forecast - Generate Demand Forecast

Generate demand forecasts with automatic weather fetching.

**Usage:**
```bash
# Basic forecast
node dist/index.js forecast \
  -s 2025-12-01 \
  -e 2025-12-31 \
  -o output/demand_forecast.csv \
  --model hybrid

# With scaling adjustments
node dist/index.js forecast \
  -s 2025-12-01 \
  -e 2025-12-31 \
  -o output/demand_forecast.csv \
  --model hybrid \
  --scale-workday 2 \
  --scale-weekend -3 \
  --growth 0.01
```

**Flags:**
| Flag | Description | Required |
|------|-------------|----------|
| `-s, --start <date>` | Forecast start date (YYYY-MM-DD) | Yes |
| `-e, --end <date>` | Forecast end date (YYYY-MM-DD) | Yes |
| `-o, --output <file>` | Output CSV file path | Yes |
| `-d, --demand <file>` | Historical demand CSV file | No |
| `--model <type>` | Model: `regression`, `xgboost`, `hybrid` | No (default: `regression`) |
| `--use-saved` | Use saved model from database | No |
| `--scale <percent>` | Scale all forecasts (e.g., `5` for +5%) | No |
| `--scale-workday <percent>` | Scale workdays only | No |
| `--scale-weekend <percent>` | Scale weekends only | No |
| `--scale-holiday <percent>` | Scale holidays (highest priority) | No |
| `--scale-peak <percent>` | Scale peak hours (09:00-21:00) | No |
| `--scale-offpeak <percent>` | Scale off-peak (21:00-09:00) | No |
| `--growth <percent>` | Daily growth rate (e.g., `0.01` = 0.01%/day) | No |
| `--cache <dir>` | Weather cache directory | No (default: `./weather_cache`) |
| `--use-db` | Use demand data from database | No |
| `--train-days <days>` | Historical training window in days | No (default: `90`) |

**Scaling Priority:**
1. Holiday scaling (highest)
2. Workday/Weekend scaling
3. Peak/Off-peak scaling
4. Global scaling
5. Growth adjustment (applied daily)

---

### 3. evaluate - Evaluate Demand Forecast

Compare forecast accuracy against actual demand data.

**Usage:**
```bash
node dist/index.js evaluate \
  -f output/demand_forecast.csv \
  -a "Data Samples/Demand/actual.csv" \
  -o output/evaluation_report.txt
```

**Flags:**
| Flag | Description | Required |
|------|-------------|----------|
| `-f, --forecast <file>` | Forecast CSV file | Yes |
| `-a, --actual <file>` | Actual demand CSV file | Yes |
| `-o, --output <file>` | Output report file | No |

**Output Metrics:**
- MAPE (Mean Absolute Percentage Error)
- MAE (Mean Absolute Error)
- RMSE (Root Mean Squared Error)
- Peak/Off-peak breakdown

---

### 4. info - Show Data Information

Display metadata about demand and weather files.

**Usage:**
```bash
node dist/index.js info \
  -d "Data Samples/Demand/MRHDemand.csv" \
  -w weather_manila.csv weather_cebu.csv
```

**Flags:**
| Flag | Description | Required |
|------|-------------|----------|
| `-d, --demand <file>` | Demand CSV file | Yes |
| `-w, --weather <files...>` | Weather CSV files | No |

---

### 5. db - Database Management

Manage SQLite database for models and data storage.

#### 5.1 db status
Show database statistics and contents.

```bash
node dist/index.js db status
```

#### 5.2 db import
Import demand or weather data into database.

```bash
# Import demand data
node dist/index.js db import \
  -t demand \
  -f "Data Samples/Demand/MRHDemand.csv"

# Import weather forecast
node dist/index.js db import \
  -t weather \
  -f weather_forecast_manila.csv \
  -l Manila \
  --forecast
```

**Flags:**
| Flag | Description | Required |
|------|-------------|----------|
| `-t, --type <type>` | Data type: `demand` or `weather` | Yes |
| `-f, --file <path>` | File or folder path to import | Yes |
| `-l, --location <name>` | Location name (for weather only) | Conditional |
| `--forecast` | Mark as forecast data | No |

#### 5.3 db models
List and manage saved models.

```bash
# List all models
node dist/index.js db models

# Activate a specific model
node dist/index.js db models -a 5
```

**Flags:**
| Flag | Description | Required |
|------|-------------|----------|
| `-a, --activate <id>` | Activate model by ID | No |

#### 5.4 db clear
Clear all database data.

```bash
node dist/index.js db clear --confirm
```

**Flags:**
| Flag | Description | Required |
|------|-------------|----------|
| `--confirm` | Confirm deletion | Yes |

---

### 6. cfac - Capacity Factor Forecasting

Generate capacity factor forecasts for wind, solar, and other renewable stations.

#### 6.1 cfac forecast2 (RECOMMENDED)

Optimal model selection per station type with per-station weather fetching.

**Usage:**
```bash
# Basic forecast
node dist/index.js cfac forecast2 \
  -t "Data Samples/Capacity Factor" \
  -s 2025-12-01 \
  -e 2025-12-31 \
  -o output/cfac_forecast.csv

# Optimal solar configuration
node dist/index.js cfac forecast2 \
  -t "Data Samples/Capacity Factor" \
  -s 2025-12-01 \
  -e 2025-12-31 \
  -o output/cfac_forecast.csv \
  --use-xgboost \
  --asymmetric-loss

# Optimal wind configuration
node dist/index.js cfac forecast2 \
  -t "Data Samples/Capacity Factor" \
  -s 2025-12-01 \
  -e 2025-12-31 \
  -o output/cfac_forecast.csv \
  --bias-correction
```

**Flags:**
| Flag | Description | Required |
|------|-------------|----------|
| `-t, --training <path>` | MRHCFac CSV file or directory | Yes |
| `-s, --start <date>` | Forecast start date (YYYY-MM-DD) | Yes |
| `-e, --end <date>` | Forecast end date (YYYY-MM-DD) | Yes |
| `-o, --output <file>` | Output CSV file | Yes |
| `--stations <file>` | Custom stations.json path | No (default: `src/data/stations.json`) |
| `--cache <dir>` | Weather cache directory | No (default: `./weather_cache`) |
| `--bias-correction` | Apply station-specific bias correction | No |
| `--asymmetric-loss` | Penalize under-predictions 2x | No |
| `--use-xgboost` | Use XGBoost for ML layer | No |
| `--scale <percent>` | Scale all station outputs | No |
| `--scale-solar <percent>` | Scale solar stations only | No |
| `--scale-wind <percent>` | Scale wind stations only | No |
| `--auto-calibrate [days]` | Auto-calibrate with recent data | No (default: 14 days) |
| `--no-auto-calibrate` | Disable auto-calibration | No |
| `--exclude-outages` | Exclude outage periods | No (default: true) |
| `--no-exclude-outages` | Include outage data | No |
| `--training-end <date>` | Limit training data cutoff | No |
| `--solar-physics-only` | Physics-only solar model | No |
| `--solar-weather-confidence` | Weather-confidence ML solar | No |
| `--solar-mrec` | iPool MREC solar model | No |
| `--solar-mrec-hybrid` | MREC + ML hybrid solar | No |
| `--solar-seasonal-adaptive` | Separate dry/wet season models | No |
| `--no-wind-4tier` | Disable 4-tier MREC for wind | No |
| `--wind-4tier` | 4-tier MREC for wind (DEFAULT) | No |

**Model Selection by Type:**
- **Solar:** Physics+ML Hybrid (best with `--use-xgboost --asymmetric-loss`)
- **Wind:** Enhanced Hybrid MREC+ML (best with `--bias-correction`)
- **Hydro/Geothermal/Biomass/Battery:** Profile-based models

#### 6.2 cfac forecast (legacy)

Original cluster-based weather fetching (superseded by forecast2).

```bash
node dist/index.js cfac forecast \
  -t "Data Samples/Capacity Factor" \
  -s 2025-12-01 \
  -e 2025-12-31 \
  -o output/cfac_forecast.csv
```

**Same flags as cfac forecast2**

#### 6.3 cfac evaluate

Evaluate capacity factor forecast accuracy.

```bash
node dist/index.js cfac evaluate \
  -f output/cfac_forecast.csv \
  -a "Data Samples/Capacity Factor/MRHCFac_actual.csv" \
  -o output/cfac_evaluation.txt
```

**Flags:**
| Flag | Description | Required |
|------|-------------|----------|
| `-f, --forecast <file>` | Forecast CSV file | Yes |
| `-a, --actual <file>` | Actual capacity factor CSV | Yes |
| `-o, --output <file>` | Output report file | No |

#### 6.4 cfac info

Show capacity factor data information and station statistics.

```bash
node dist/index.js cfac info \
  -d "Data Samples/Capacity Factor" \
  --stations src/data/stations.json
```

**Flags:**
| Flag | Description | Required |
|------|-------------|----------|
| `-d, --data <path>` | Capacity factor data path | Yes |
| `--stations <file>` | Stations JSON path | No |

#### 6.5 cfac weather

Fetch per-station weather data for capacity factor modeling.

```bash
# Fetch for all wind stations
node dist/index.js cfac weather \
  -s 2025-12-01 \
  -e 2025-12-31 \
  --types wind

# Fetch for specific stations
node dist/index.js cfac weather \
  -s 2025-12-01 \
  -e 2025-12-31 \
  --only 01BURGOS,01LAOAG,01PAGUDPUD
```

**Flags:**
| Flag | Description | Required |
|------|-------------|----------|
| `-s, --start <date>` | Start date (YYYY-MM-DD) | Yes |
| `-e, --end <date>` | End date (YYYY-MM-DD) | Yes |
| `--stations <file>` | Custom stations.json | No |
| `--cache <dir>` | Weather cache directory | No |
| `--types <types>` | Comma-separated: `wind,solar,hydro,all` | No (default: `all`) |
| `--only <codes>` | Comma-separated station codes | No |

#### 6.6 cfac forecast-all

Generate both demand and capacity factor forecasts together.

```bash
node dist/index.js cfac forecast-all \
  -d "Data Samples/Demand" \
  -c "Data Samples/Capacity Factor" \
  -s 2025-12-01 \
  -e 2025-12-31 \
  -o ./output \
  --model hybrid
```

**Flags:**
| Flag | Description | Required |
|------|-------------|----------|
| `-d, --demand <path>` | Demand data path | Yes |
| `-c, --cfac <path>` | Capacity factor data path | Yes |
| `-s, --start <date>` | Forecast start date | Yes |
| `-e, --end <date>` | Forecast end date | Yes |
| `-o, --output <dir>` | Output directory | Yes |
| `--model <type>` | Demand model type | No (default: `hybrid`) |
| `--use-xgboost` | Use XGBoost for CFAC | No |

#### 6.7 cfac solar

Compare solar model variants and evaluate performance.

```bash
node dist/index.js cfac solar \
  -t "Data Samples/Capacity Factor" \
  -a "Data Samples/Capacity Factor"
```

**Flags:**
| Flag | Description | Required |
|------|-------------|----------|
| `-t, --training <path>` | Training data path | Yes |
| `-a, --actual <path>` | Actual data path | Yes |

---

### 7. cfac mrec - Wind MREC Model Commands

MREC (iPool three-tier wind algorithm) specific commands.

#### 7.1 cfac mrec calibrate

Calibrate MREC factors for wind stations.

```bash
node dist/index.js cfac mrec calibrate \
  -c "Data Samples/Capacity Factor" \
  --save
```

**Flags:**
| Flag | Description | Required |
|------|-------------|----------|
| `-c, --cfac <path>` | Historical capacity factor data | Yes |
| `-w, --wind <path>` | Wind speed data path | No |
| `--stations <file>` | Custom stations.json | No |
| `--cache <dir>` | Weather cache directory | No |
| `--save` | Save factors to database | No |

#### 7.2 cfac mrec status

Show calibrated MREC factors for all wind stations.

```bash
node dist/index.js cfac mrec status
```

#### 7.3 cfac mrec predict

Predict capacity factor for a specific wind speed.

```bash
node dist/index.js cfac mrec predict \
  -s 01BURGOS \
  -w 8.5
```

**Flags:**
| Flag | Description | Required |
|------|-------------|----------|
| `-s, --station <code>` | Station code | Yes |
| `-w, --windspeed <value>` | Wind speed in m/s | Yes |

#### 7.4 cfac mrec clear

Clear all calibrated MREC factors from database.

```bash
node dist/index.js cfac mrec clear
```

#### 7.5 cfac mrec forecast

Generate wind forecast using MREC model only.

```bash
node dist/index.js cfac mrec forecast \
  -t "Data Samples/Capacity Factor" \
  -s 2025-12-01 \
  -e 2025-12-31 \
  -o output/mrec_forecast.csv
```

**Flags:**
| Flag | Description | Required |
|------|-------------|----------|
| `-t, --training <path>` | Training data path | Yes |
| `-s, --start <date>` | Start date | Yes |
| `-e, --end <date>` | End date | Yes |
| `-o, --output <file>` | Output CSV file | Yes |
| `--cache <dir>` | Weather cache directory | No |

#### 7.6 cfac mrec hybrid

Generate wind forecast using MREC + ML hybrid.

```bash
node dist/index.js cfac mrec hybrid \
  -t "Data Samples/Capacity Factor" \
  -s 2025-12-01 \
  -e 2025-12-31 \
  -o output/mrec_hybrid_forecast.csv
```

**Same flags as `cfac mrec forecast` plus:**
| Flag | Description |
|------|-------------|
| `--use-xgboost` | Use XGBoost for ML layer |
| `--asymmetric-loss` | Penalize under-predictions 2x |

#### 7.7 cfac mrec evaluate

Evaluate MREC forecast accuracy.

```bash
node dist/index.js cfac mrec evaluate \
  -f output/mrec_forecast.csv \
  -a "Data Samples/Capacity Factor/MRHCFac_actual.csv"
```

**Flags:**
| Flag | Description | Required |
|------|-------------|----------|
| `-f, --forecast <file>` | Forecast CSV | Yes |
| `-a, --actual <file>` | Actual CSV | Yes |

#### 7.8 cfac mrec compare3

Compare three wind model variants: MREC, Enhanced Hybrid, Basic Hybrid.

```bash
node dist/index.js cfac mrec compare3 \
  -t "Data Samples/Capacity Factor" \
  -a "Data Samples/Capacity Factor"
```

**Flags:**
| Flag | Description | Required |
|------|-------------|----------|
| `-t, --training <path>` | Training data path | Yes |
| `-a, --actual <path>` | Actual data path | Yes |

---

### 8. outage - Outage Analysis

Analyze and manage power plant outage data.

#### 8.1 outage analyze

Analyze outage patterns and impacts.

```bash
node dist/index.js outage analyze \
  -d "Data Samples/Outages/outage_data.csv" \
  -o output/outage_analysis.txt \
  --severity HIGH \
  --region LUZON
```

**Flags:**
| Flag | Description | Required |
|------|-------------|----------|
| `-d, --data <path>` | Outage data path | Yes |
| `-o, --output <file>` | Output report file | Yes |
| `--severity <level>` | Filter: `CRITICAL`, `HIGH`, `MEDIUM`, `LOW` | No |
| `--region <region>` | Filter: `LUZON`, `VISAYAS`, `MINDANAO` | No |

#### 8.2 outage summary

Generate outage summary statistics.

```bash
node dist/index.js outage summary \
  -d "Data Samples/Outages/outage_data.csv"
```

**Flags:**
| Flag | Description | Required |
|------|-------------|----------|
| `-d, --data <path>` | Outage data path | Yes |

#### 8.3 outage weather-forecast

Correlate outages with weather forecasts.

```bash
node dist/index.js outage weather-forecast \
  -d "Data Samples/Outages/outage_data.csv" \
  -w weather_forecast.csv \
  -o output/outage_weather_correlation.txt
```

**Flags:**
| Flag | Description | Required |
|------|-------------|----------|
| `-d, --data <path>` | Outage data path | Yes |
| `-w, --weather <file>` | Weather forecast file | Yes |
| `-o, --output <file>` | Output file | Yes |

#### 8.4 outage duration-stats

Calculate outage duration statistics.

```bash
node dist/index.js outage duration-stats \
  -d "Data Samples/Outages/outage_data.csv"
```

**Flags:**
| Flag | Description | Required |
|------|-------------|----------|
| `-d, --data <path>` | Outage data path | Yes |

---

### 9. interconnector - Interconnector Forecasting

Manage and forecast interconnector flows and constraints.

#### 9.1 interconnector import

Import RTDHS interconnector data into database.

```bash
node dist/index.js interconnector import \
  -d "Data Samples/Interconnector/RTDHS_data.csv" \
  --db ./forecast.db
```

**Flags:**
| Flag | Description | Required |
|------|-------------|----------|
| `-d, --data <path>` | RTDHS data path | Yes |
| `--db <path>` | Database path | No (default: `./forecast.db`) |

#### 9.2 interconnector stats

Show interconnector data statistics.

```bash
node dist/index.js interconnector stats \
  --db ./forecast.db
```

**Flags:**
| Flag | Description | Required |
|------|-------------|----------|
| `--db <path>` | Database path | No |

#### 9.3 interconnector train

Train interconnector constraint prediction model.

```bash
node dist/index.js interconnector train \
  --start 2025-07-01 \
  --end 2025-11-30 \
  --model xgboost
```

**Flags:**
| Flag | Description | Required |
|------|-------------|----------|
| `--start <date>` | Training start date | Yes |
| `--end <date>` | Training end date | Yes |
| `--model <type>` | Model: `xgboost` or `regression` | No (default: `xgboost`) |

#### 9.4 interconnector detect-constraints

Detect constraint patterns in interconnector data.

```bash
node dist/index.js interconnector detect-constraints \
  -d "Data Samples/Interconnector"
```

**Flags:**
| Flag | Description | Required |
|------|-------------|----------|
| `-d, --data <path>` | Interconnector data path | Yes |

#### 9.5 interconnector forecast

Generate interconnector flow forecasts.

```bash
node dist/index.js interconnector forecast \
  -s 2025-12-01 \
  -e 2025-12-31 \
  -o output/interconnector_forecast.csv
```

**Flags:**
| Flag | Description | Required |
|------|-------------|----------|
| `-s, --start <date>` | Forecast start date | Yes |
| `-e, --end <date>` | Forecast end date | Yes |
| `-o, --output <file>` | Output CSV file | Yes |

---

### 10. scheduler - Automated Forecast Scheduling

Run automated daily/weekly forecasts with calibration.

#### 10.1 scheduler run

Execute scheduled forecasts for a specific date.

**Usage:**
```bash
# Run all forecasts for today
node dist/index.js scheduler run

# Run demand-only forecast for specific date
node dist/index.js scheduler run \
  -d 2025-10-15 \
  --demand-only \
  --output ./output

# Run with custom calibration settings
node dist/index.js scheduler run \
  -d 2025-10-15 \
  --calib-days 7 \
  --calib-threshold 5 \
  --max-iterations 3
```

**Flags:**
| Flag | Description | Required |
|------|-------------|----------|
| `-d, --date <date>` | As-of date (YYYY-MM-DD) | No (default: today) |
| `--daily` | Generate daily forecast only | No |
| `--weekly` | Generate weekly forecast only | No |
| `--demand-only` | Only generate demand forecasts | No |
| `--cfac-only` | Only generate CFAC forecasts | No |
| `--demand-path <path>` | Demand training data path | No (default: `Data Samples/Demand`) |
| `--cfac-path <path>` | CFAC training data path | No (default: `Data Samples/Capacity Factor`) |
| `--output <dir>` | Output directory | No (default: `./output`) |
| `--db <path>` | Scheduler database path | No (default: `./forecast.db`) |
| `--calib-days <days>` | Calibration window in days | No (default: `7`) |
| `--calib-threshold <percent>` | Max deviation threshold % | No (default: `5`) |
| `--max-iterations <n>` | Max calibration iterations | No (default: `3`) |
| `--demand-model <type>` | Demand model type | No (default: `hybrid`) |
| `--use-xgboost` | Use XGBoost for CFAC | No |
| `--asymmetric-loss` | Penalize CFAC under-predictions 2x | No |
| `--bias-correction` | Apply station-specific bias correction | No |

**Output Structure:**
```
output/forecasts/
└── 2025-10-15/           # As-of date folder
    ├── demand_daily.csv   # Next-day forecast (Oct 16)
    ├── demand_weekly.csv  # 7-day forecast (Oct 16-22)
    ├── cfac_daily.csv
    └── cfac_weekly.csv
```

#### 10.2 scheduler backfill

Generate forecasts for a historical date range.

```bash
# Backfill October 2025 daily forecasts
node dist/index.js scheduler backfill \
  -s 2025-10-01 \
  -e 2025-10-31 \
  --daily \
  --demand-only
```

**Flags:**
| Flag | Description | Required |
|------|-------------|----------|
| `-s, --start <date>` | Backfill start date | Yes |
| `-e, --end <date>` | Backfill end date | Yes |
| `--daily` | Daily forecasts only | No |
| `--weekly` | Weekly forecasts only | No |
| `--demand-only` | Demand forecasts only | No |
| `--cfac-only` | CFAC forecasts only | No |

**All flags from `scheduler run` are also supported.**

#### 10.3 scheduler history / status

View scheduler run history and performance metrics.

```bash
# Show last 10 runs
node dist/index.js scheduler status

# Show last 25 runs
node dist/index.js scheduler history -n 25
```

**Flags:**
| Flag | Description | Required |
|------|-------------|----------|
| `--db <path>` | Database path | No |
| `-n, --limit <number>` | Number of records to show | No (default: `10`) |

#### 10.4 scheduler service

Run scheduler as a background service.

```bash
# Run daily at 6 AM
node dist/index.js scheduler service

# Run daily at 8 AM, check every 30 minutes
node dist/index.js scheduler service \
  --hour 8 \
  --interval 30
```

**Flags:**
| Flag | Description | Required |
|------|-------------|----------|
| `--hour <hour>` | Hour to run (0-23) | No (default: `6`) |
| `--interval <minutes>` | Check interval in minutes | No (default: `60`) |

**All flags from `scheduler run` are also supported.**

---

### 11. capacity - Station Capacity Management

Manage station metadata and synchronize with IEMOP data.

#### 11.1 capacity check

Check IEMOP for station capacity changes.

```bash
node dist/index.js capacity check \
  --force \
  -o output/capacity_changes.txt \
  -v
```

**Flags:**
| Flag | Description | Required |
|------|-------------|----------|
| `--force` | Force refresh from IEMOP | No |
| `--cache <dir>` | Cache directory | No |
| `--stations <path>` | Custom stations.json path | No |
| `-o, --output <file>` | Output report file | No |
| `-v, --verbose` | Detailed output | No |

#### 11.2 capacity compare

Compare IEMOP genlist against stations.json.

```bash
node dist/index.js capacity compare \
  -g genlist.csv \
  --stations src/data/stations.json \
  -v
```

**Flags:**
| Flag | Description | Required |
|------|-------------|----------|
| `-g, --genlist <file>` | Genlist CSV file | Yes |
| `--stations <path>` | Stations JSON path | No |
| `-v, --verbose` | Detailed output | No |

#### 11.3 capacity research

Generate research prompt for new station.

```bash
node dist/index.js capacity research \
  -s 01NEWSTATION \
  -g genlist.csv
```

**Flags:**
| Flag | Description | Required |
|------|-------------|----------|
| `-s, --station <code>` | Station code | Yes |
| `-g, --genlist <file>` | Genlist CSV file | No |
| `--cache <dir>` | Cache directory | No |

#### 11.4 capacity add

Add new station to stations.json.

```bash
# Add from JSON file
node dist/index.js capacity add \
  -s 01NEWSTATION \
  -d station_data.json

# Add with inline data
node dist/index.js capacity add \
  -s 01NEWSTATION \
  -n "New Station Name"
```

**Flags:**
| Flag | Description | Required |
|------|-------------|----------|
| `-s, --station <code>` | Station code | Yes |
| `-d, --data <file>` | JSON file with station data | No |
| `-n, --name <name>` | Station name | No |

#### 11.5 capacity download

Download IEMOP MNM (Must Not Miss) data.

```bash
# Download all regions
node dist/index.js capacity download

# Download specific region
node dist/index.js capacity download \
  --region LUZON \
  --cache ./iemop_cache
```

**Flags:**
| Flag | Description | Required |
|------|-------------|----------|
| `--region <region>` | Region: `ALL`, `LUZON`, `VISAYAS`, `MINDANAO` | No (default: `ALL`) |
| `--cache <dir>` | Cache directory | No |

#### 11.6 capacity cfac-check

Verify CFAC CSV columns match stations.json.

```bash
node dist/index.js capacity cfac-check \
  -f "Data Samples/Capacity Factor/MRHCFac.csv" \
  --stations src/data/stations.json
```

**Flags:**
| Flag | Description | Required |
|------|-------------|----------|
| `-f, --file <path>` | CFAC CSV file | Yes |
| `--stations <path>` | Stations JSON path | No |

---

## Common Workflows

### Complete Forecast Pipeline
```bash
# 1. Train demand model
npm run build
node dist/index.js train \
  -d "Data Samples/Demand" \
  -w weather_manila.csv weather_cebu.csv weather_davao.csv \
  --model both

# 2. Generate demand forecast
node dist/index.js forecast \
  -s 2025-12-01 -e 2025-12-31 \
  -o output/demand_forecast.csv \
  --model hybrid

# 3. Generate capacity factor forecast
node dist/index.js cfac forecast2 \
  -t "Data Samples/Capacity Factor" \
  -s 2025-12-01 -e 2025-12-31 \
  -o output/cfac_forecast.csv \
  --use-xgboost --asymmetric-loss

# 4. Evaluate both forecasts
node dist/index.js evaluate \
  -f output/demand_forecast.csv \
  -a "Data Samples/Demand/actual.csv"

node dist/index.js cfac evaluate \
  -f output/cfac_forecast.csv \
  -a "Data Samples/Capacity Factor/actual.csv"
```

### Automated Daily Forecasting
```bash
# Set up scheduler service
node dist/index.js scheduler service \
  --hour 6 \
  --demand-model hybrid \
  --use-xgboost \
  --bias-correction \
  --calib-days 7
```

### Wind Model Calibration
```bash
# 1. Calibrate MREC factors
node dist/index.js cfac mrec calibrate \
  -c "Data Samples/Capacity Factor" \
  --save

# 2. Check calibration status
node dist/index.js cfac mrec status

# 3. Generate forecast with calibrated factors
node dist/index.js cfac forecast2 \
  -t "Data Samples/Capacity Factor" \
  -s 2025-12-01 -e 2025-12-31 \
  -o output/wind_forecast.csv \
  --bias-correction
```

---

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `VISUAL_CROSSING_API_KEY` | Visual Crossing weather API key | Built-in key |
| `NODE_ENV` | Environment mode (`development`, `production`) | `production` |

---

## Notes

- All date formats use ISO 8601: `YYYY-MM-DD`
- Weather data automatically fetched via Visual Crossing API
- Database location: `./forecast.db` (configurable via `--db` flag)
- Weather cache: `./weather_cache/` (configurable via `--cache` flag)
- Output defaults to `./output/` directory

---

## Getting Help

```bash
# Show global help
node dist/index.js --help

# Show command-specific help
node dist/index.js <command> --help

# Examples:
node dist/index.js forecast --help
node dist/index.js cfac forecast2 --help
node dist/index.js scheduler run --help
```
