# iLoad CLI Usage Guide

## Installation

After building the project:

```bash
npm run build
```

Run the CLI using:

```bash
node dist/index.js <command> [options]
```

Or install globally:

```bash
npm link
iload <command> [options]
```

---

## Command Overview

| Command | Description |
|---------|-------------|
| `train` | Train demand forecasting models on historical data |
| `forecast` | Generate demand forecasts (auto-fetches weather from API) |
| `evaluate` | Compare forecast accuracy against actual demand |
| `cfac forecast` | Generate capacity factor forecasts for renewables |
| `cfac evaluate` | Evaluate capacity factor forecast accuracy |
| `cfac info` | Display capacity factor data information |
| `outage analyze` | Analyze historical outage events |
| `outage summary` | Quick outage statistics summary |
| `outage weather-forecast` | Weather-adjusted outage probability forecast |
| `outage duration-stats` | Outage duration statistics by severity |
| `db status` | Show database statistics |
| `db import` | Import data into database |
| `db models` | List and manage saved models |
| `db clear` | Clear database data |
| `forecast-all` | Generate both demand and capacity factor forecasts |
| `info` | Display data file information |

---

## Demand Forecasting Commands

### 1. Forecast Command

Generate demand forecasts with automatic weather data fetching.

**Using Database (Recommended):**
```bash
node dist/index.js forecast \
  --start 2025-11-01 \
  --end 2025-12-31 \
  --model hybrid \
  --use-db \
  --output forecast.csv
```

**Using File:**
```bash
node dist/index.js forecast \
  --demand "Data Samples/Demand/DemandHr.csv" \
  --start 2025-11-01 \
  --end 2025-12-31 \
  --model hybrid \
  --output forecast.csv
```

**Options:**

| Option | Description | Required | Default |
|--------|-------------|----------|---------|
| `-d, --demand <file>` | Historical demand CSV file | No* | - |
| `-s, --start <date>` | Forecast start date (YYYY-MM-DD) | Yes | - |
| `-e, --end <date>` | Forecast end date (YYYY-MM-DD) | Yes | - |
| `-o, --output <file>` | Output forecast CSV file | Yes | - |
| `--model <type>` | Model: `regression`, `xgboost`, `hybrid` | No | `regression` |
| `--use-db` | Use demand data from database | No | false |
| `--use-saved` | Use saved model from database | No | false |
| `--scale <percent>` | Scale forecast (e.g., 5 for +5%) | No | `0` |
| `--growth <percent>` | Daily growth rate for hybrid model | No | `0` |
| `--train-days <days>` | Days of training data (with --use-db) | No | `90` |
| `--cache <dir>` | Weather cache directory | No | `./weather_cache` |

*Required unless using `--use-db`

**Model Types:**

| Model | Description | Best For |
|-------|-------------|----------|
| `hybrid` | Region-specific learned patterns | **Recommended** - Best shape accuracy |
| `regression` | Linear regression | Fast training, interpretable |
| `xgboost` | Gradient boosting | Complex patterns, highest R² |

---

### 2. Train Command

Train models on historical demand and weather data.

```bash
node dist/index.js train \
  --demand data/demand.csv \
  --weather data/manila.csv data/cebu.csv data/davao.csv \
  --output output \
  --model both
```

**Options:**

| Option | Description | Required | Default |
|--------|-------------|----------|---------|
| `-d, --demand <file>` | Historical demand CSV | Yes | - |
| `-w, --weather <files...>` | Weather CSV files | Yes | - |
| `-o, --output <dir>` | Output directory | No | `./output` |
| `--model <type>` | `regression`, `xgboost`, or `both` | No | `both` |

---

### 3. Evaluate Command

Compare forecast against actual demand data.

```bash
node dist/index.js evaluate \
  --forecast forecast.csv \
  --actual actual_demand.csv
```

**Options:**

| Option | Description | Required |
|--------|-------------|----------|
| `-f, --forecast <file>` | Forecast CSV file | Yes |
| `-a, --actual <file>` | Actual demand CSV file | Yes |

**Output Metrics:**
- MAPE (Mean Absolute Percentage Error)
- MAE (Mean Absolute Error)
- RMSE (Root Mean Square Error)
- Bias (over/under forecasting)
- Per-region breakdown

---

## Capacity Factor Forecasting Commands

### cfac forecast

Generate capacity factor forecasts for 117 renewable/must-run stations.

```bash
node dist/index.js cfac forecast \
  --start 2025-11-01 \
  --end 2025-12-31 \
  --training "Data Samples/Capacity Factor" \
  --output cfac_forecast.csv
```

**Options:**

| Option | Description | Required | Default |
|--------|-------------|----------|---------|
| `-s, --start <date>` | Forecast start date | Yes | - |
| `-e, --end <date>` | Forecast end date | Yes | - |
| `-t, --training <path>` | Training data (file or folder) | Yes | - |
| `-o, --output <file>` | Output CSV file | Yes | - |
| `--cache <dir>` | Weather cache directory | No | `./weather_cache` |

**Station Types Supported:**
- Solar (53 stations)
- Hydro (31 stations)
- Wind (7 stations)
- Geothermal (8 stations)
- Biomass (10 stations)
- Battery (8 stations)

---

### cfac evaluate

Evaluate capacity factor forecast accuracy.

```bash
node dist/index.js cfac evaluate \
  --forecast cfac_forecast.csv \
  --actual actual_cfac.csv
```

---

### cfac info

Display information about capacity factor data.

```bash
node dist/index.js cfac info --data "Data Samples/Capacity Factor"
```

---

## Outage Analysis Commands

### outage analyze

Analyze historical outage events with weather correlation.

```bash
node dist/index.js outage analyze \
  --data "Data Samples/Outages" \
  --output outage_report.md
```

**Options:**

| Option | Description | Required |
|--------|-------------|----------|
| `-d, --data <path>` | Outage data file or folder | Yes |
| `-o, --output <file>` | Output report file | No |

---

### outage summary

Quick summary of outage statistics.

```bash
node dist/index.js outage summary --data "Data Samples/Outages"
```

---

### outage weather-forecast

Generate weather-adjusted outage probability forecast.

```bash
node dist/index.js outage weather-forecast \
  --start 2025-11-01 \
  --end 2025-12-31
```

**Options:**

| Option | Description | Required |
|--------|-------------|----------|
| `-s, --start <date>` | Forecast start date | Yes |
| `-e, --end <date>` | Forecast end date | Yes |

**Output includes:**
- Daily outage probability per region
- Weather risk multipliers (precipitation, wind)
- Risk level indicators (Low/Moderate/High/Severe)

---

### outage duration-stats

Show outage duration statistics by severity and region.

```bash
node dist/index.js outage duration-stats
```

---

## Database Commands

### db status

Show database statistics.

```bash
node dist/index.js db status
```

**Output:**
- Demand record count and date range
- Weather record count and date range
- Saved models
- Regions available

---

### db import

Import data into the database.

**Import Demand:**
```bash
node dist/index.js db import \
  --type demand \
  --file "Data Samples/Demand/DemandHr.csv"
```

**Import Weather:**
```bash
node dist/index.js db import \
  --type weather \
  --file "weather_manila.csv" \
  --location Manila
```

**Options:**

| Option | Description | Required |
|--------|-------------|----------|
| `-t, --type <type>` | Data type: `demand` or `weather` | Yes |
| `-f, --file <path>` | File or folder to import | Yes |
| `-l, --location <name>` | Location name (for weather) | For weather |

---

### db models

List and manage saved models.

```bash
node dist/index.js db models --list
node dist/index.js db models --delete <id>
```

---

### db clear

Clear database data.

```bash
node dist/index.js db clear --type demand
node dist/index.js db clear --type weather
node dist/index.js db clear --all
```

---

## Combined Forecast Command

### forecast-all

Generate both demand and capacity factor forecasts in one command.

```bash
node dist/index.js forecast-all \
  --demand "Data Samples/Demand" \
  --cfac "Data Samples/Capacity Factor" \
  --start 2025-11-01 \
  --end 2025-12-31 \
  --model hybrid \
  --output-demand demand_forecast.csv \
  --output-cfac cfac_forecast.csv
```

**Options:**

| Option | Description | Required |
|--------|-------------|----------|
| `-d, --demand <path>` | Demand data file or folder | Yes |
| `-c, --cfac <path>` | Capacity factor data | Yes |
| `-s, --start <date>` | Forecast start date | Yes |
| `-e, --end <date>` | Forecast end date | Yes |
| `--model <type>` | Demand model type | No |
| `--output-demand <file>` | Demand output file | Yes |
| `--output-cfac <file>` | Cfac output file | Yes |

---

## Data File Formats

### Demand CSV Format

```csv
DateTimeEnding,CLUZ,CVIS,CMIN
11/1/2025 1:00,9234.56,2145.32,1876.45
11/1/2025 2:00,8987.23,2034.12,1765.89
```

- `DateTimeEnding`: Hour-ending timestamp (M/D/YYYY H:mm)
- Region columns: Demand values in MW

### Weather CSV Format

```csv
name,datetime,temp,dew,precip,windgust,windspeed,cloudcover,solarradiation,uvindex
Manila,2025-11-01T00:00:00,26.5,24.2,0.0,25.3,12.5,45.2,0.0,0
```

### Capacity Factor CSV Format

```csv
DateTimeEnding,01BAKUN,01BURGOS,01CAYANGA,...
11/1/2025 1:00,0.315789,0.453333,0.000000,...
```

- Station columns: Capacity factor values (0-1 scale)

---

## Tips

1. **Use Database for Repeated Forecasts**: Import historical data once, then use `--use-db` for faster forecasting.

2. **Model Selection**:
   - Use `hybrid` for best shape accuracy (peaks/troughs)
   - Use `regression` for interpretability
   - Use `xgboost` for highest R² score

3. **Weather Data**: Weather is automatically fetched from Visual Crossing API. Data is cached to avoid repeated downloads.

4. **Capacity Factor**: Training requires historical capacity factor data. Use folder path to load multiple months at once.

5. **Outage Analysis**: Works best with multiple months of outage data for statistical significance.

---

## Error Handling

Common error messages:

- `No demand data found in database` - Import data first with `db import`
- `No training samples available` - Need more historical data for lag features
- `Weather API error` - Check API key or network connection
- `Missing required option` - Check command help with `--help`

---

## Examples by Use Case

### Daily Operations: Generate Tomorrow's Forecast
```bash
node dist/index.js forecast --start 2025-12-10 --end 2025-12-10 --model hybrid --use-db -o tomorrow.csv
```

### Weekly Planning: Generate Next Week
```bash
node dist/index.js forecast --start 2025-12-09 --end 2025-12-15 --model hybrid --use-db -o next_week.csv
```

### Monthly Planning: Full Month Forecast
```bash
node dist/index.js forecast-all \
  -d "Data Samples/Demand" \
  -c "Data Samples/Capacity Factor" \
  -s 2025-12-01 -e 2025-12-31 \
  --model hybrid \
  --output-demand demand_dec.csv \
  --output-cfac cfac_dec.csv
```

### Model Validation: Check Accuracy
```bash
node dist/index.js evaluate -f forecast.csv -a actual.csv
```
