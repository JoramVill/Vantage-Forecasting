# iLoad Forecasting Utility - CLI Reference

## Table of Contents
1. [Installation & Setup](#installation--setup)
2. [Global Options](#global-options)
3. [train Command](#train-command)
4. [forecast Command](#forecast-command)
5. [evaluate Command](#evaluate-command)
6. [db Commands](#db-commands)
7. [weather Command](#weather-command)
8. [cfac Commands](#cfac-commands)
9. [outage Command](#outage-command)
10. [info Command](#info-command)

---

## Installation & Setup

### Install Dependencies
```bash
npm install
```

### Build Application
```bash
npm run build
```

### Run CLI
```bash
# Development mode
npm run dev -- <command>

# Production mode (after build)
node dist/index.js <command>

# Or use installed binary
iload <command>
```

### Set API Key
```bash
# Environment variable (recommended)
export VISUAL_CROSSING_API_KEY="your_key_here"

# Or create config.json
echo '{"visualCrossingApiKey":"your_key_here"}' > config.json
```

---

## Global Options

```bash
iload --version          # Show version number
iload --help             # Show help information
iload <command> --help   # Show command-specific help
```

---

## train Command

Train forecasting models on historical demand and weather data.

### Syntax
```bash
iload train -d <demand-file> -w <weather-files...> [options]
```

### Required Options
- `-d, --demand <file>` - Historical demand CSV file or folder path
- `-w, --weather <files...>` - Weather CSV files (one per region/location)

### Optional Options
- `-o, --output <dir>` - Output directory for reports (default: `./output`)
- `--model <type>` - Model type: `regression`, `xgboost`, or `both` (default: `both`)

### Examples

**Train both models:**
```bash
iload train \
  -d "Data Samples/Training Historical Demand Data/" \
  -w weather_manila.csv weather_cebu.csv weather_davao.csv \
  -o output/training
```

**Train only regression model:**
```bash
iload train \
  -d demand_2024.csv \
  -w weather_combined.csv \
  --model regression
```

**Train with folder of demand files:**
```bash
iload train \
  -d "Data Samples/Training Historical Demand Data/" \
  -w weather_data/*.csv
```

### Output
- Console: Training progress, metrics (R², MAPE, RMSE, MAE)
- Files:
  - `output/regression_report.md` - Regression model report
  - `output/xgboost_report.md` - XGBoost model report
  - `output/comparison.md` - Model comparison (if both trained)
- Database: Models saved with metrics for future use

### Model Metrics Explained
- **R² Score**: Coefficient of determination (0-1, higher is better)
- **MAPE**: Mean Absolute Percentage Error (%, lower is better)
- **RMSE**: Root Mean Square Error (MW, lower is better)
- **MAE**: Mean Absolute Error (MW, lower is better)

---

## forecast Command

Generate demand forecasts using weather data from Visual Crossing API.

### Syntax
```bash
iload forecast -s <start-date> -e <end-date> -o <output-file> [options]
```

### Required Options
- `-s, --start <date>` - Forecast start date (YYYY-MM-DD format)
- `-e, --end <date>` - Forecast end date (YYYY-MM-DD format)
- `-o, --output <file>` - Output forecast CSV file path

### Optional Options
- `-d, --demand <file>` - Historical demand CSV file (if not using database)
- `--model <type>` - Model type: `regression`, `xgboost`, or `hybrid` (default: `regression`)
- `--use-saved` - Use saved model from database instead of training new one
- `--use-db` - Use demand data from database instead of file
- `--train-days <days>` - Number of days of historical data for training (default: `90`)
- `--scale <percent>` - Scale forecast by percentage (e.g., `5` for +5%, `-3` for -3%)
- `--growth <percent>` - Daily demand growth rate for hybrid model (e.g., `0.01` for 0.01%/day)
- `--cache <dir>` - Weather cache directory (default: `./weather_cache`)

### Examples

**1-day ahead forecast with saved model:**
```bash
iload forecast \
  -s 2025-12-10 \
  -e 2025-12-10 \
  -o forecast_1day.csv \
  --use-db \
  --use-saved \
  --model regression
```

**1-week ahead forecast with hybrid model:**
```bash
iload forecast \
  -s 2025-12-10 \
  -e 2025-12-16 \
  -o forecast_1week.csv \
  --use-db \
  --model hybrid \
  --growth 0.01
```

**Forecast with demand file and scaling:**
```bash
iload forecast \
  -d "Data Samples/Training Historical Demand Data/" \
  -s 2025-12-10 \
  -e 2025-12-12 \
  -o forecast_scaled.csv \
  --model regression \
  --scale 5
```

**Forecast with custom training period:**
```bash
iload forecast \
  -s 2025-12-10 \
  -e 2025-12-16 \
  -o forecast.csv \
  --use-db \
  --train-days 180 \
  --model xgboost
```

### Workflow
1. Load or train model with historical data
2. Fetch weather forecast from Visual Crossing API
3. Build feature vectors with lag values
4. Generate hour-by-hour predictions
5. Apply scaling if specified
6. Write forecast CSV

### Output Format
```csv
DateTimeEnding,Luzon,Visayas,Mindanao
12/10/2025 1:00,7850.5,1250.3,1520.2
12/10/2025 2:00,7620.8,1180.5,1450.7
...
```

---

## evaluate Command

Evaluate forecast accuracy by comparing against actual demand data.

### Syntax
```bash
iload evaluate -f <forecast-file> -a <actual-file> [options]
```

### Required Options
- `-f, --forecast <file>` - Forecast CSV file to evaluate
- `-a, --actual <file>` - Actual demand CSV file

### Optional Options
- `-o, --output <file>` - Output evaluation report file (Markdown)

### Examples

**Evaluate and display metrics:**
```bash
iload evaluate \
  -f forecast_1day.csv \
  -a actual_demand.csv
```

**Evaluate and save report:**
```bash
iload evaluate \
  -f forecast_1week.csv \
  -a "Data Samples/Training Historical Demand Data/" \
  -o evaluation_report.md
```

### Output Metrics

**By Region:**
- MAE (Mean Absolute Error) in MW
- MAPE (Mean Absolute Percentage Error) in %
- RMSE (Root Mean Square Error) in MW
- Bias (over/under-forecasting) in MW

**Analysis:**
- Largest errors by region
- Peak and trough accuracy
- Recommendations for improvement

### Interpretation

- **MAPE < 5%**: Excellent accuracy
- **MAPE 5-10%**: Acceptable for load forecasting
- **MAPE > 10%**: Room for improvement

**Bias:**
- Positive bias: Over-forecasting
- Negative bias: Under-forecasting
- Use `--scale` option in forecast to compensate

---

## db Commands

Database management for demand, weather, and model data.

### db status

Show database statistics and contents.

```bash
iload db status
```

**Output:**
- Record counts (demand, weather, models)
- Date ranges
- Regions covered
- Weather data breakdown (historical vs forecast)

### db import

Import demand or weather data into database.

#### Import Demand Data

```bash
iload db import -t demand -f <file-or-folder>
```

**Examples:**
```bash
# Import single demand file
iload db import -t demand -f demand_2024.csv

# Import folder of demand files
iload db import -t demand -f "Data Samples/Training Historical Demand Data/"
```

#### Import Weather Data

```bash
iload db import -t weather -f <file> -l <location> [--forecast]
```

**Options:**
- `-l, --location <name>` - Location name (e.g., Manila, Cebu, Davao)
- `--forecast` - Mark as forecast data (not historical)

**Examples:**
```bash
# Import historical weather
iload db import -t weather -f weather_manila.csv -l Manila

# Import forecast weather
iload db import -t weather -f weather_forecast.csv -l Manila --forecast
```

### db models

List and manage saved models.

```bash
iload db models                    # List all saved models
iload db models --activate <id>    # Activate specific model for forecasting
```

**Example Output:**
```
ID │ Active │   Type     │    R²    │   MAPE   │  Samples  │    Created
───┼────────┼────────────┼──────────┼──────────┼───────────┼────────────────
  1 │   ✓    │ regression │  0.9245  │   3.82%  │     2160  │ 2025-12-09 15:30
  2 │        │ xgboost    │  0.9456  │   2.95%  │     2160  │ 2025-12-09 15:35
```

### db clear

Clear all data from database.

```bash
iload db clear --confirm
```

**Warning:** This deletes ALL data. Use with caution!

---

## weather Command

Fetch and manage weather data from Visual Crossing API.

### Syntax
```bash
iload weather -s <start-date> -e <end-date> [options]
```

### Options
- `-s, --start <date>` - Start date (YYYY-MM-DD)
- `-e, --end <date>` - End date (YYYY-MM-DD)
- `-o, --output <dir>` - Output directory (default: `./weather_cache`)
- `-l, --locations <names...>` - Specific locations (default: all configured)

### Examples

**Fetch weather for all default locations:**
```bash
iload weather -s 2025-12-01 -e 2025-12-07 -o weather_data
```

**Fetch weather for specific location:**
```bash
iload weather -s 2025-12-10 -e 2025-12-16 -l Manila
```

### Output
- CSV files per location
- Cached in specified directory
- Includes: temp, wind, solar, precipitation, cloud cover

---

## cfac Commands

Capacity factor forecasting for renewable and must-run generation.

> **Recommended**: Use `cfac forecast2` for optimal model selection and best accuracy.
> See [CAPACITY_FACTOR_GUIDE.md](CAPACITY_FACTOR_GUIDE.md) for detailed documentation.

---

### cfac forecast2 (Recommended)

Generate capacity factor forecasts using **optimal models** for each station type:
- **Wind**: Weather-Only MREC Hybrid (~75.8% MAPE)
- **Solar**: Physics+ML Hybrid (~59.6% MAPE)
- **Other**: Profile-based models

#### Syntax
```bash
iload cfac forecast2 -t <training-path> -s <start-date> -e <end-date> -o <output-file> [options]
```

#### Required Options
- `-t, --training <path>` - MRHCFac CSV file or directory
- `-s, --start <date>` - Forecast start date (YYYY-MM-DD)
- `-e, --end <date>` - Forecast end date (YYYY-MM-DD)
- `-o, --output <file>` - Output forecast CSV file

#### Optional Options
- `--stations <file>` - Stations JSON file (default: `src/data/stations.json`)
- `--cache <dir>` - Weather cache directory (default: `./weather_cache`)

#### Examples

**Full month forecast (recommended):**
```bash
iload cfac forecast2 \
  -t "Data Samples/Capacity Factor/" \
  -s 2025-12-01 \
  -e 2025-12-31 \
  -o output/cfac_december_2025.csv
```

**Week-ahead forecast:**
```bash
iload cfac forecast2 \
  -t "Data Samples/Capacity Factor/" \
  -s 2025-12-10 \
  -e 2025-12-16 \
  -o cfac_1week_forecast.csv
```

#### Model Selection (Automatic)

| Station Type | Model | Expected MAPE |
|--------------|-------|---------------|
| Wind | Weather-Only MREC Hybrid | ~75.8% |
| Solar | Physics+ML Hybrid | ~59.6% |
| Hydro | Profile-based | varies |
| Geothermal | Profile-based | ~15-35% |
| Biomass | Profile-based | varies |
| Battery | Profile-based | varies |

---

### cfac forecast (Original)

Generate capacity factor forecasts using generic ModelRouter.

#### Syntax
```bash
iload cfac forecast -t <training-path> -s <start-date> -e <end-date> -o <output-file> [options]
```

#### Required Options
- `-t, --training <path>` - MRHCFac CSV file or directory
- `-s, --start <date>` - Forecast start date (YYYY-MM-DD)
- `-e, --end <date>` - Forecast end date (YYYY-MM-DD)
- `-o, --output <file>` - Output forecast CSV file

#### Optional Options
- `--stations <file>` - Stations JSON file (default: `src/data/stations.json`)
- `--cache <dir>` - Weather cache directory (default: `./weather_cache`)

#### Example
```bash
iload cfac forecast \
  -t "Data Samples/Capacity Factor/" \
  -s 2025-12-10 \
  -e 2025-12-16 \
  -o cfac_forecast.csv
```

---

### cfac mrec compare3

Compare three wind capacity factor models to validate performance.

#### Syntax
```bash
iload cfac mrec compare3 -t <training-path> -a <actual-path> [options]
```

#### Required Options
- `-t, --training <path>` - Training data (July-October)
- `-a, --actual <path>` - Test/actual data (November-December)

#### Optional Options
- `--cache <dir>` - Weather cache directory (default: `./weather_cache`)
- `--stations <file>` - Stations JSON file (default: `src/data/stations.json`)

#### Example
```bash
iload cfac mrec compare3 \
  -t "Data Samples/Capacity Factor" \
  -a "Data Samples/Capacity Factor"
```

#### Output
Compares three models on test data:
1. **MREC-only** - iPool baseline (three-tier piecewise)
2. **MREC+ML (Temporal)** - With month/hour features (may overfit)
3. **MREC+ML (Weather-Only)** - Best generalization

```
┌───────────────────┬─────────────┬──────────────────┬───────────────────┬─────────┐
│ Station           │  MREC MAPE  │  Temporal Hybrid │  Weather Hybrid   │ Samples │
├───────────────────┼─────────────┼──────────────────┼───────────────────┼─────────┤
│ 01BURGOS          │      91.2% │          136.7% │            73.6%*│     660 │
│ 01LAOAG           │     101.6% │          185.1% │            98.0%*│     693 │
...
```

---

### cfac evaluate

Evaluate forecast accuracy against actual capacity factor data.

#### Syntax
```bash
iload cfac evaluate -f <forecast-file> -a <actual-file> [-o <report-file>]
```

#### Required Options
- `-f, --forecast <file>` - Forecast CSV file to evaluate
- `-a, --actual <file>` - Actual capacity factor CSV (MRHCFac format)

#### Optional Options
- `-o, --output <file>` - Output evaluation report (Markdown)

#### Example
```bash
iload cfac evaluate \
  -f output/cfac_december_2025.csv \
  -a "Data Samples/Capacity Factor/MRHCFac_December.csv" \
  -o output/evaluation_report.md
```

#### Output Metrics
- **MAE**: Mean Absolute Error
- **MAPE**: Mean Absolute Percentage Error
- **RMSE**: Root Mean Square Error
- Per-station breakdown
- Summary by station type

---

### cfac mrec calibrate

Calibrate MREC factors for wind stations from historical data.

#### Syntax
```bash
iload cfac mrec calibrate -t <training-path> [options]
```

#### Example
```bash
iload cfac mrec calibrate \
  -t "Data Samples/Capacity Factor" \
  --cache ./weather_cache
```

---

### Station Types Supported

| Type | Code Pattern | Model | Weather Data |
|------|-------------|-------|--------------|
| Wind | `_W`, `BURGOS`, `LAOAG`, `PAGUDPUD` | Weather-Only MREC Hybrid | 100m hub-height |
| Solar | `_S` | Physics+ML Hybrid | Surface |
| Hydro (RoR) | `_H` | Profile-based | Surface |
| Hydro (Storage) | `_HS` | Profile-based | Surface |
| Geothermal | `_G`, `_GP` | Profile-based | - |
| Biomass | `_BI`, `_BG`, `_BL` | Profile-based | - |
| Battery | `_B` | Profile-based | - |

---

### Output Format

All cfac commands produce CSV in MRHCFac format:
```csv
DateTimeEnding,01BAKUN,01BURGOS,01CLARK,...
12/10/2025 1:00,0.82,0.45,0.88,...
12/10/2025 2:00,0.80,0.48,0.90,...
...
```

- **DateTimeEnding**: Hour-ending timestamp (M/D/YYYY H:mm)
- **Columns**: Station codes with capacity factors (0.0 - 1.0)

---

## outage Command

Analyze historical outage patterns and generate probability reports.

### Syntax
```bash
iload outage -d <directory> -o <output-file> [options]
```

### Required Options
- `-d, --directory <path>` - Directory containing outage CSV files
- `-o, --output <file>` - Output analysis report (Markdown)

### Optional Options
- `--window <days>` - Analysis window in days (default: 30)
- `--threshold <severity>` - Minimum severity: low, medium, high, critical (default: medium)

### Examples

**Generate outage analysis report:**
```bash
iload outage \
  -d "Data Samples/Outage Events/" \
  -o outage_analysis.md
```

**30-day analysis with custom threshold:**
```bash
iload outage \
  -d "Data Samples/Outage Events/" \
  -o outage_report.md \
  --window 30 \
  --threshold high
```

### Output Report Contains
- **Overall Statistics**: Total outages, MW lost, affected hours
- **By Time Period**: Morning, Afternoon, Evening, Night
- **By Region**: Luzon, Visayas, Mindanao
- **By Severity**: Critical, High, Medium, Low
- **Risk Assessment**: Probability and expected impact
- **Recommendations**: Based on historical patterns

### Time Period Definitions
- **Morning**: 06:00 - 11:59
- **Afternoon**: 12:00 - 17:59
- **Evening**: 18:00 - 23:59
- **Night**: 00:00 - 05:59

---

## info Command

Display information about data files without processing.

### Syntax
```bash
iload info -d <demand-file> [-w <weather-files...>]
```

### Options
- `-d, --demand <file>` - Demand CSV file (required)
- `-w, --weather <files...>` - Weather CSV files (optional)

### Example

```bash
iload info \
  -d demand_2024.csv \
  -w weather_manila.csv weather_cebu.csv
```

### Output
- Record counts
- Date ranges
- Regions/locations covered
- File paths

---

## Common Workflows

### Daily Forecasting Workflow

1. **Import latest demand data:**
   ```bash
   iload db import -t demand -f demand_latest.csv
   ```

2. **Generate 1-day forecast:**
   ```bash
   iload forecast \
     -s $(date -I) \
     -e $(date -I) \
     -o forecast_1day.csv \
     --use-db \
     --use-saved
   ```

3. **Generate capacity factor forecast:**
   ```bash
   iload cfac forecast \
     -t "Data Samples/Capacity Factor/" \
     -s $(date -I) \
     -e $(date -I) \
     -o cfac_1day.csv
   ```

### Weekly Planning Workflow

1. **Train fresh models:**
   ```bash
   iload train \
     -d "Data Samples/Training Historical Demand Data/" \
     -w weather_cache/combined/*.csv
   ```

2. **Generate 1-week forecast:**
   ```bash
   iload forecast \
     -s 2025-12-10 \
     -e 2025-12-16 \
     -o forecast_1week.csv \
     --use-db \
     --use-saved \
     --model hybrid \
     --growth 0.01
   ```

3. **Evaluate previous week:**
   ```bash
   iload evaluate \
     -f forecast_last_week.csv \
     -a actual_last_week.csv \
     -o evaluation_last_week.md
   ```

### Model Optimization Workflow

1. **Train and compare models:**
   ```bash
   iload train \
     -d demand_data/ \
     -w weather_data/*.csv \
     --model both
   ```

2. **Test different forecast horizons:**
   ```bash
   iload forecast -s 2025-12-10 -e 2025-12-10 -o test_1day.csv --use-saved
   iload forecast -s 2025-12-10 -e 2025-12-13 -o test_3day.csv --use-saved
   iload forecast -s 2025-12-10 -e 2025-12-16 -o test_1week.csv --use-saved
   ```

3. **Evaluate and adjust:**
   ```bash
   iload evaluate -f test_1day.csv -a actual.csv
   # If bias detected, use --scale in next forecast
   ```

---

## Troubleshooting

### Error: "No training samples available"
**Cause:** Insufficient historical data or mismatched dates
**Solution:**
- Ensure demand data has at least 30 days
- Verify weather and demand date ranges overlap
- Check date formats (YYYY-MM-DD)

### Error: "Failed to fetch weather data"
**Cause:** API key issues or network problems
**Solution:**
- Verify API key is set correctly
- Check internet connection
- Verify Visual Crossing API quota

### Error: "No matching records" in evaluate
**Cause:** Date/time mismatch between forecast and actual
**Solution:**
- Verify both files cover same date range
- Check datetime format consistency
- Ensure region column names match

### Performance: Slow forecast generation
**Cause:** Large forecast horizon or cold start
**Solution:**
- Use weather caching (automatic)
- Use --use-saved to skip training
- Consider shorter forecast horizons

---

## Environment Variables

| Variable | Purpose | Example |
|----------|---------|---------|
| `VISUAL_CROSSING_API_KEY` | Weather API authentication | `BJYBHG8K3YS8EFK46233M8L75` |
| `NODE_ENV` | Environment mode | `production` |

---

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Error (check console output) |

---

**Document Version:** 1.0
**Last Updated:** 2025-12-10
**For More Information:** See APPLICATION_OVERVIEW.md and USER_GUIDE.md
