# User Guide - iLoad Forecasting Utility

A step-by-step guide for complete beginners. No prior experience with forecasting tools is assumed.

---

## Table of Contents

1. [What Does This Program Do?](#what-does-this-program-do)
2. [Installation](#installation)
3. [Your First Forecast](#your-first-forecast)
4. [Understanding the Output](#understanding-the-output)
5. [Evaluating Your Forecast](#evaluating-your-forecast)
6. [The Generate-Evaluate-Adjust Workflow](#the-generate-evaluate-adjust-workflow)
7. [Scaling and Adjusting Forecasts](#scaling-and-adjusting-forecasts)
8. [Auto-Calibration](#auto-calibration)
9. [Advanced Flags](#advanced-flags)
10. [Complete CLI Command Reference](#complete-cli-command-reference)
11. [Scheduler (Automated Forecasting)](#scheduler-automated-forecasting)
12. [Database Management](#database-management)
13. [Weather Data and Caching](#weather-data-and-caching)
14. [Troubleshooting](#troubleshooting)

---

## What Does This Program Do?

The iLoad Forecasting Utility predicts two things for the Philippine power grid (WESM):

1. **Capacity Factor (CFAC)** - How much power each renewable energy station will generate, expressed as a value between 0 (no output) and 1 (maximum output). Covers wind, solar, hydro, geothermal, biomass, and battery stations.

2. **Demand** - How much electricity consumers will use, measured in megawatts (MW), across three grid regions: Luzon (CLUZ), Visayas (CVIS), and Mindanao (CMIN).

### Key Terminology

| Term | Meaning |
|------|---------|
| **Capacity Factor** | A station's actual output divided by its maximum possible output (0.0 to 1.0) |
| **WESM** | Wholesale Electricity Spot Market (Philippine electricity market) |
| **MRHCFac** | Market Resource Hourly Capacity Factor - the standard CSV format for capacity factor data |
| **CLUZ / CVIS / CMIN** | Philippine grid regions: Luzon, Visayas, Mindanao |
| **Station Code** | Unique identifier for each power station (e.g. `01BURGOS` for a wind farm) |
| **Training Data** | Historical data the model learns from |
| **Calibration** | Adjusting predictions based on recent actual performance |

---

## Installation

### Prerequisites

- **Node.js** version 16 or higher
- **npm** (comes with Node.js)
- Windows, Linux, or macOS

### Setup

Open a terminal and run:

```bash
npm install
npm run build
```

That's it. The program is ready to use.

### Verify Installation

```bash
node dist/index.js --help
```

You should see a list of available commands.

---

## Your First Forecast

### Capacity Factor Forecast (Most Common)

This predicts how much power each renewable station will generate.

```bash
node dist/index.js cfac forecast2 ^
  -t "Data Samples/Capacity Factor" ^
  -s 2026-02-01 ^
  -e 2026-02-28 ^
  -o output/cfac_february.csv
```

**What each flag means:**

| Flag | What It Does |
|------|-------------|
| `cfac forecast2` | The command to run (recommended capacity factor model) |
| `-t "Data Samples/Capacity Factor"` | Path to the folder containing historical training data |
| `-s 2026-02-01` | Forecast start date (YYYY-MM-DD format) |
| `-e 2026-02-28` | Forecast end date |
| `-o output/cfac_february.csv` | Where to save the result |

**What happens behind the scenes:**
1. Loads historical capacity factor data from the training folder
2. Fetches weather data (temperature, wind, solar radiation) from the Visual Crossing API
3. Trains separate models for each station type (wind, solar, hydro, etc.)
4. Auto-calibrates using the 14 days before the forecast period
5. Generates hourly predictions and saves them to the output CSV

### Demand Forecast

This predicts how much electricity consumers will use.

```bash
node dist/index.js forecast ^
  -d "Data Samples/Demand" ^
  -s 2026-02-01 ^
  -e 2026-02-28 ^
  -o output/demand_february.csv ^
  --model hybrid
```

| Flag | What It Does |
|------|-------------|
| `forecast` | The demand forecast command |
| `-d "Data Samples/Demand"` | Path to historical demand data |
| `-s` / `-e` | Start and end dates |
| `-o` | Output file path |
| `--model hybrid` | Use the hybrid model (recommended, most accurate at 2-4% MAPE) |

---

## Understanding the Output

### Capacity Factor Output CSV

The output CSV looks like this:

```
DateTimeEnding,01BURGOS,01LAOAG,01PAGUDPUD,01BOTOLAN_S,01CLARK_S,...
1/1/2026 1:00,0.3542,0.4128,0.2891,0.0000,0.0000,...
1/1/2026 2:00,0.3812,0.4521,0.3104,0.0000,0.0000,...
...
1/1/2026 13:00,0.1205,0.0892,0.0543,0.5234,0.4891,...
```

- **DateTimeEnding** - The timestamp in hour-ending format (1:00 means the hour from 00:00 to 01:00)
- **Station columns** - Each column is a station code, values are capacity factors from 0 to 1
- Solar stations show 0 at night (no sunlight) and higher values during the day
- Wind stations can produce at any hour
- Values are formatted to 4 decimal places

### Demand Output CSV

```
DateTimeEnding,CLUZ,CVIS,CMIN
1/1/2026 1:00,8500.5,3200.3,1850.2
1/1/2026 2:00,7950.2,2950.1,1720.4
```

- **CLUZ** - Luzon demand in MW
- **CVIS** - Visayas demand in MW
- **CMIN** - Mindanao demand in MW

### How to Read Capacity Factor Values

| Value | Meaning |
|-------|---------|
| 0.00 | Station producing nothing (solar at night, station offline) |
| 0.10 | Station at 10% of maximum capacity |
| 0.50 | Station at half capacity |
| 0.85 | Station running near full capacity |
| 1.00 | Station at maximum output |

---

## Evaluating Your Forecast

After actuals become available, compare your forecast against them:

### Capacity Factor Evaluation

```bash
node dist/index.js cfac evaluate ^
  -f output/cfac_february.csv ^
  -a "Data Samples/Capacity Factor/MRHCFac_actual.csv" ^
  -o output/february_eval.txt
```

| Flag | What It Does |
|------|-------------|
| `-f` | Your forecast file |
| `-a` | The actual data file to compare against |
| `-o` | Where to save the evaluation report |

### Demand Evaluation

```bash
node dist/index.js evaluate ^
  -f output/demand_february.csv ^
  -a "Data Samples/Demand/actual.csv"
```

### Understanding Evaluation Metrics

The evaluation report contains these metrics:

| Metric | What It Means | Good Values |
|--------|--------------|-------------|
| **MAE** (Mean Absolute Error) | Average size of errors, in the same units as the data | Lower is better. For CFAC: < 0.05 is excellent |
| **MAPE** (Mean Absolute Percentage Error) | Average error as a percentage | Lower is better. < 10% is good for solar, < 5% for demand |
| **RMSE** (Root Mean Squared Error) | Like MAE but penalizes large errors more | Lower is better |

**Example evaluation output:**
```
Station     | Type   | MAE    | MAPE (%) | RMSE
01BURGOS    | wind   | 0.0631 | 44.85    | 0.0885
01BOTOLAN_S | solar  | 0.0259 | 22.17    | 0.0527
01GAMU_BI   | biomass| 0.0145 | 3.41     | 0.0186
```

**What's "good" varies by station type:**

| Type | Typical MAPE | Notes |
|------|-------------|-------|
| Demand | 2-4% | Very predictable |
| Solar | 15-25% | Weather-dependent but patterns are clear |
| Wind | 40-80% | Highly variable, hardest to predict |
| Geothermal | 2-10% | Very stable output |
| Biomass | 3-40% | Depends on operations |
| Battery | 5-20% | Depends on dispatch |
| Hydro | 15-60% | Seasonal, water level dependent |

---

## The Generate-Evaluate-Adjust Workflow

This is the recommended iterative process:

### Step 1: Generate Your First Forecast

```bash
node dist/index.js cfac forecast2 ^
  -t "Data Samples/Capacity Factor" ^
  -s 2026-02-01 -e 2026-02-14 ^
  -o output/cfac_v1.csv
```

### Step 2: Evaluate Against Actuals

Once actuals are available:

```bash
node dist/index.js cfac evaluate ^
  -f output/cfac_v1.csv ^
  -a "Data Samples/Capacity Factor/MRHCFac_actual.csv" ^
  -o output/cfac_v1_eval.txt
```

### Step 3: Review the Evaluation

Look at the evaluation report. Common patterns:

- **Solar MAPE > 25%?** Try adding `--use-xgboost --asymmetric-loss`
- **Wind MAPE very high?** Try adding `--bias-correction`
- **Systematic over/under-forecasting?** Use manual scaling flags (see next section)

### Step 4: Adjust and Re-Run

```bash
node dist/index.js cfac forecast2 ^
  -t "Data Samples/Capacity Factor" ^
  -s 2026-02-01 -e 2026-02-14 ^
  -o output/cfac_v2.csv ^
  --use-xgboost --asymmetric-loss
```

### Step 5: Compare Versions

Evaluate the new version:

```bash
node dist/index.js cfac evaluate ^
  -f output/cfac_v2.csv ^
  -a "Data Samples/Capacity Factor/MRHCFac_actual.csv" ^
  -o output/cfac_v2_eval.txt
```

Compare the MAPE values between v1 and v2 to see if your adjustments improved accuracy.

---

## Scaling and Adjusting Forecasts

Scaling lets you manually increase or decrease forecast values by a percentage. This is useful when you know the model has a consistent bias.

### How Scaling Works

Scale values are **percentages**:
- `--scale 5` means **+5%** (multiply forecast by 1.05)
- `--scale -3` means **-3%** (multiply forecast by 0.97)
- `--scale 0` means no change (default)

### Demand Scaling Flags

```bash
node dist/index.js forecast ^
  -d "Data Samples/Demand" ^
  -s 2026-02-01 -e 2026-02-28 ^
  -o output/demand.csv ^
  --model hybrid ^
  --scale 2 ^
  --scale-weekend -5 ^
  --scale-holiday -10 ^
  --scale-peak 1.5
```

| Flag | What It Does | Example |
|------|-------------|---------|
| `--scale <percent>` | Base scale for all forecasts | `--scale 3` adds 3% to everything |
| `--scale-workday <percent>` | Override for Monday-Friday (non-holiday) | `--scale-workday 2` |
| `--scale-weekend <percent>` | Override for Saturday and Sunday | `--scale-weekend -5` reduces weekends by 5% |
| `--scale-holiday <percent>` | Override for Philippine holidays (highest priority) | `--scale-holiday -10` |
| `--scale-peak <percent>` | Additional adjustment for peak hours (09:00-21:00) | `--scale-peak 1.5` |
| `--scale-offpeak <percent>` | Additional adjustment for off-peak hours (21:00-09:00) | `--scale-offpeak -1` |

#### Demand Scaling Priority Rules

The flags follow a **priority hierarchy**:

1. **Holiday** (highest priority) - If it's a Philippine holiday, `--scale-holiday` replaces the base `--scale`
2. **Weekend** - If Saturday or Sunday, `--scale-weekend` replaces the base `--scale`
3. **Workday** - If Monday-Friday and not a holiday, `--scale-workday` replaces the base `--scale`
4. **Base** - `--scale` is used if no specific day-type override applies

Peak/off-peak scales are then **multiplied on top** of the day-type scale.

#### Demand Scaling Examples

**Example 1: Uniform increase**
```bash
--scale 3
```
All forecasts increased by 3%. Simple and straightforward.

**Example 2: Reduce weekend forecasts**
```bash
--scale 2 --scale-weekend -4
```
- Weekdays: +2%
- Weekends: -4% (overrides the base +2%)

**Example 3: Combined day-type and peak adjustments**
```bash
--scale 2 --scale-weekend -3 --scale-holiday -8 --scale-peak 1.5
```

Here's what happens for different time slots:

| Scenario | Day-Type Scale | Peak Scale | Final |
|----------|---------------|------------|-------|
| Tuesday 10:00 AM (peak) | 1.02 (+2%) | 1.015 (+1.5%) | 1.02 x 1.015 = **1.035** (+3.5%) |
| Tuesday 22:00 PM (off-peak) | 1.02 (+2%) | 1.0 (none) | **1.02** (+2%) |
| Saturday 14:00 (peak) | 0.97 (-3%) | 1.015 (+1.5%) | 0.97 x 1.015 = **0.985** (-1.5%) |
| Christmas 12:00 (peak holiday) | 0.92 (-8%) | 1.015 (+1.5%) | 0.92 x 1.015 = **0.934** (-6.6%) |

### Capacity Factor Scaling Flags

```bash
node dist/index.js cfac forecast2 ^
  -t "Data Samples/Capacity Factor" ^
  -s 2026-02-01 -e 2026-02-28 ^
  -o output/cfac.csv ^
  --scale-solar 5 ^
  --scale-wind -3
```

| Flag | What It Does | Example |
|------|-------------|---------|
| `--scale <percent>` | Base scale for all station types | `--scale 3` |
| `--scale-solar <percent>` | Override for solar stations only | `--scale-solar 5` adds 5% to solar |
| `--scale-wind <percent>` | Override for wind stations only | `--scale-wind -3` reduces wind by 3% |

**Priority:** `--scale-solar` and `--scale-wind` override `--scale` for their respective types. Other station types (hydro, geothermal, biomass, battery) always use `--scale`.

**Important:** Setting a manual scale disables auto-calibration for that type. See the [Auto-Calibration](#auto-calibration) section.

---

## Auto-Calibration

Auto-calibration is the program's built-in intelligence for adjusting forecasts based on recent performance. It is **enabled by default**.

### How It Works

1. The program looks at the **14 days before your forecast start date**
2. It generates predictions for that period and compares them to actual data
3. It calculates how much it over- or under-predicted
4. It applies correction factors to your forecast

**Example:** If the model consistently under-predicted solar by 8% during the calibration period, it will scale up solar forecasts by approximately 8%.

### What Gets Calibrated

| Station Type | Calibration Method | Details |
|-------------|-------------------|---------|
| **Solar** | Per-hour + Per-station | Each daylight hour (6-18) gets its own scale factor. Each station also gets an individual scale. Minimum 10 samples per hour required. |
| **Wind** | Global only | One scale factor for all wind stations combined. Per-station wind calibration is disabled because wind patterns change too much between seasons. |
| **Other** (hydro, geothermal, biomass, battery) | Per-station | Each station gets its own scale based on recent performance. |

### Calibration Scale Limits

To prevent extreme corrections, all calibration scales are clamped:

| Type | Minimum Scale | Maximum Scale |
|------|--------------|--------------|
| Solar (per-hour) | 0.70 (cap at -30%) | 1.50 (cap at +50%) |
| Solar (per-station) | 0.50 (cap at -50%) | 2.00 (cap at +100%) |
| Wind (global) | No explicit clamp | No explicit clamp |
| Other (per-station) | 0.20 (cap at -80%) | 2.00 (cap at +100%) |

### Disabling Auto-Calibration

If you want full manual control:

```bash
node dist/index.js cfac forecast2 ^
  -t "Data Samples/Capacity Factor" ^
  -s 2026-02-01 -e 2026-02-28 ^
  -o output/cfac.csv ^
  --no-auto-calibrate ^
  --scale-solar 5 ^
  --scale-wind -3
```

### Manual Scale vs Auto-Calibration

These two interact as follows:

- **If you set `--scale-solar` or `--scale-wind`:** Auto-calibration is skipped for that type, and your manual value is used instead
- **If you leave them at 0 (default):** Auto-calibration runs and sets the scale automatically
- **`--no-auto-calibrate`:** Disables all auto-calibration; only manual scales apply

**Recommendation:** Leave auto-calibration on (the default) unless you have a specific reason to override it. It generally improves accuracy.

### Changing the Calibration Period

The default is 14 days. To use a different number:

```bash
node dist/index.js cfac forecast2 ^
  -t "Data Samples/Capacity Factor" ^
  -s 2026-02-01 -e 2026-02-28 ^
  -o output/cfac.csv ^
  --auto-calibrate 7
```

This uses only the 7 days before the forecast start.

---

## Advanced Flags

These flags modify how the forecasting models work internally.

### --use-xgboost

**What it does:** Switches the machine learning layer from linear regression to XGBoost (gradient boosted decision trees). XGBoost is better at capturing non-linear relationships in the data.

**Best for:** Solar stations (43% bias reduction reported).

**Not recommended for:** Wind stations (can degrade performance due to overfitting).

```bash
node dist/index.js cfac forecast2 ^
  -t "Data Samples/Capacity Factor" ^
  -s 2026-02-01 -e 2026-02-28 ^
  -o output/cfac.csv ^
  --use-xgboost
```

### --asymmetric-loss

**What it does:** Penalizes under-predictions approximately 1.86x more than over-predictions during model training. This pushes the model to forecast slightly higher rather than risk under-forecasting.

**Best for:** Solar stations where under-forecasting is a common problem.

**How it works internally:**
- For solar: Duplicates under-prediction training samples (gives them 2x weight)
- For wind: Adjusts the XGBoost quantile parameter from 0.5 to 0.65

```bash
node dist/index.js cfac forecast2 ^
  -t "Data Samples/Capacity Factor" ^
  -s 2026-02-01 -e 2026-02-28 ^
  -o output/cfac.csv ^
  --use-xgboost --asymmetric-loss
```

### --bias-correction

**What it does:** Learns station-specific systematic biases from the full training history and subtracts them from predictions. Different from auto-calibration, which uses only the recent 14 days.

**Best for:** Wind stations that have consistent long-term biases.

| Feature | Bias Correction | Auto-Calibration |
|---------|----------------|-----------------|
| Data source | Full training history | Last 14 days |
| Method | Subtraction (`prediction - bias`) | Multiplication (`prediction x scale`) |
| Scope | Per-station | Per-hour (solar), per-station, or global (wind) |
| Enabled by | `--bias-correction` flag | Default (disable with `--no-auto-calibrate`) |

Both can be used together - bias correction runs first, then auto-calibration scales the corrected value.

```bash
node dist/index.js cfac forecast2 ^
  -t "Data Samples/Capacity Factor" ^
  -s 2026-02-01 -e 2026-02-28 ^
  -o output/cfac.csv ^
  --bias-correction
```

### Recommended Flag Combinations by Station Type

| Station Type | Recommended Flags | Why |
|-------------|------------------|-----|
| **Solar** | `--use-xgboost --asymmetric-loss` | 43% bias reduction, handles non-linear irradiance patterns |
| **Wind** | `--bias-correction` | Corrects long-term model bias; XGBoost degrades wind accuracy |
| **Mixed fleet** | No extra flags (defaults) | Auto-calibration handles most adjustments |

---

## Complete CLI Command Reference

### Capacity Factor Commands

#### cfac forecast2 (Recommended)

```bash
node dist/index.js cfac forecast2 [options]
```

| Flag | Required | Default | Description |
|------|----------|---------|-------------|
| `-t, --training <path>` | Yes | - | Folder with historical capacity factor CSVs |
| `-s, --start <date>` | Yes | - | Forecast start date (YYYY-MM-DD) |
| `-e, --end <date>` | Yes | - | Forecast end date (YYYY-MM-DD) |
| `-o, --output <file>` | Yes | - | Output CSV file path |
| `--stations <file>` | No | `src/data/stations.json` | Custom station metadata file |
| `--cache <dir>` | No | `./weather_cache` | Weather cache directory |
| `--use-xgboost` | No | off | Use XGBoost for ML layer |
| `--asymmetric-loss` | No | off | Penalize under-predictions 2x |
| `--bias-correction` | No | off | Apply learned station biases |
| `--no-auto-calibrate` | No | (calibrate on) | Skip auto-calibration |
| `--auto-calibrate <days>` | No | 14 | Number of calibration days |
| `--scale <percent>` | No | 0 | Scale all types by percentage |
| `--scale-solar <percent>` | No | 0 | Scale solar by percentage |
| `--scale-wind <percent>` | No | 0 | Scale wind by percentage |
| `--training-end <date>` | No | - | Limit training data to before this date |

#### cfac forecast3 (Enhanced Hybrid with EMA smoothing)

Same flags as forecast2, plus:

| Flag | Default | Description |
|------|---------|-------------|
| `--smooth <value>` | 0.5 | EMA smoothing for wind (0=none, 0.7=heavy) |

#### cfac evaluate

```bash
node dist/index.js cfac evaluate [options]
```

| Flag | Required | Description |
|------|----------|-------------|
| `-f, --forecast <file>` | Yes | Forecast CSV to evaluate |
| `-a, --actual <file>` | Yes | Actual data CSV to compare against |
| `-o, --output <file>` | No | Save evaluation report to file |

#### cfac mrec compare3

```bash
node dist/index.js cfac mrec compare3 [options]
```

| Flag | Required | Description |
|------|----------|-------------|
| `-t, --training <path>` | Yes | Training data folder |
| `-a, --actual <path>` | Yes | Actual data folder |

Compares different wind model variants side-by-side.

### Demand Commands

#### forecast

```bash
node dist/index.js forecast [options]
```

| Flag | Required | Default | Description |
|------|----------|---------|-------------|
| `-d, --demand <path>` | Yes | - | Historical demand data folder/file |
| `-s, --start <date>` | Yes | - | Forecast start date |
| `-e, --end <date>` | Yes | - | Forecast end date |
| `-o, --output <file>` | Yes | - | Output CSV file |
| `--model <type>` | No | hybrid | Model: `xgboost`, `regression`, or `hybrid` |
| `--weather-hist <files...>` | No | (auto-fetch) | Historical weather CSVs |
| `--weather-forecast <files...>` | No | (auto-fetch) | Forecast weather CSVs |
| `--use-db` | No | off | Use database-stored model |
| `--growth <rate>` | No | 0 | Daily growth rate (e.g. 0.001 for 0.1%/day) |
| `--scale <percent>` | No | 0 | Base scale for all forecasts |
| `--scale-workday <percent>` | No | - | Scale for workdays |
| `--scale-weekend <percent>` | No | - | Scale for weekends |
| `--scale-holiday <percent>` | No | - | Scale for holidays (highest priority) |
| `--scale-peak <percent>` | No | - | Additional peak hour scale (09:00-21:00) |
| `--scale-offpeak <percent>` | No | - | Additional off-peak scale (21:00-09:00) |

#### train

```bash
node dist/index.js train [options]
```

| Flag | Required | Description |
|------|----------|-------------|
| `-d, --demand <file>` | Yes | Historical demand CSV |
| `-w, --weather <files...>` | Yes | Weather CSV files |
| `-o, --output <dir>` | No | Output directory for reports |
| `--model <type>` | No | Model: `regression`, `xgboost`, or `both` |

#### evaluate (demand)

```bash
node dist/index.js evaluate [options]
```

| Flag | Required | Description |
|------|----------|-------------|
| `-f, --forecast <file>` | Yes | Forecast CSV |
| `-a, --actual <file>` | Yes | Actual data CSV |

### Database Commands

```bash
node dist/index.js db <subcommand> [options]
```

| Subcommand | Description |
|------------|-------------|
| `status` | Show database statistics (record counts, date ranges) |
| `import` | Import demand or weather data into the database |
| `models` | List saved models and their accuracy metrics |
| `clear --confirm` | Delete all data (requires --confirm flag) |

### Scheduler Commands

```bash
node dist/index.js scheduler <subcommand> [options]
```

| Subcommand | Description |
|------------|-------------|
| `run` | Run daily + weekly forecasts for today |
| `backfill -s <start> -e <end>` | Generate forecasts for a date range |
| `evaluate` | Evaluate pending forecasts against actuals |
| `status` | Show run history and metrics |
| `service` | Run as background service (daily at 6 AM) |

### Other Commands

| Command | Description |
|---------|-------------|
| `interconnector train` | Train interconnector constraint model |
| `interconnector forecast` | Generate interconnector forecasts |
| `info` | Show system information |

---

## Scheduler (Automated Forecasting)

The scheduler automates the generate-evaluate cycle.

### Run Today's Forecasts

```bash
node dist/index.js scheduler run
```

This generates:
- **Daily forecast** for tomorrow
- **Weekly forecast** for the next 7 days

### Backfill Historical Periods

Generate forecasts retroactively for a date range:

```bash
node dist/index.js scheduler backfill ^
  -s 2026-01-01 -e 2026-01-31 ^
  --daily --demand-only
```

| Flag | Description |
|------|-------------|
| `--daily` | Generate daily (next-day) forecasts only |
| `--weekly` | Generate weekly (7-day) forecasts only |
| `--demand-only` | Skip capacity factor, only do demand |

### Output Structure

The scheduler organizes files by date:

```
output/
  daily/
    Demand/
      demand_2026-01-15_2026-01-15.csv
      demand_2026-01-16_2026-01-16.csv
    CFAC/
      cfac_2026-01-15_2026-01-15.csv
  weekly/
    Demand/
      demand_2026-01-15_2026-01-21.csv
```

### Check Scheduler History

```bash
node dist/index.js scheduler status
```

Shows recent runs, their accuracy metrics, and any failures.

---

## Database Management

The program uses SQLite to store historical data and trained models.

### Check What's in the Database

```bash
node dist/index.js db status
```

Output shows:
- Database file path
- Number of demand, weather, and model records
- Date ranges covered
- Regions available

### Import Data

```bash
# Import demand data
node dist/index.js db import -t demand -f "Data Samples/Demand/demand_2025.csv"

# Import weather data (must specify location)
node dist/index.js db import -t weather -f weather_manila.csv -l "Manila"
```

### View Saved Models

```bash
node dist/index.js db models
```

Lists all trained models with their accuracy metrics. Use `--activate <id>` to set a model as active.

### Clear Database

```bash
node dist/index.js db clear --confirm
```

Deletes all stored data. Cannot be undone. The `--confirm` flag is required as a safety measure.

---

## Weather Data and Caching

### How Weather Fetching Works

The program automatically fetches weather data from the Visual Crossing API. You generally don't need to manage this manually.

- **Wind stations** get weather for their exact coordinates at 100m hub height
- **Solar stations** get weather for their exact coordinates with solar irradiance data
- **Other station types** use cluster-based weather (grouped by geographic proximity)

### Weather Cache

Downloaded weather data is cached locally in `./weather_cache/` to avoid re-downloading:

```
weather_cache/
  manila/
    2026-01/
      2026-01-01.csv
      2026-01-02.csv
  WIND_01BURGOS/
    2026-01/
      2026-01-01.csv
  SOLAR_01CLARK/
    2026-01/
      2026-01-01.csv
```

### When to Clear the Cache

Clear the weather cache if you experience:
- Consistent "incomplete data" errors
- Station cluster mappings have changed
- Stale forecast data causing accuracy issues

**Clear all:**
```bash
rmdir /s /q weather_cache
```

**Clear a specific location:**
```bash
rmdir /s /q weather_cache\WIND_01BURGOS
```

### API Key

The Visual Crossing API key is resolved in this order:
1. `VISUAL_CROSSING_API_KEY` environment variable
2. `config.json` file (field: `visualCrossingApiKey`)
3. Built-in default key

---

## Troubleshooting

### "Failed to fetch weather data"

**Cause:** Weather API is unreachable or API key is invalid.

**Fix:**
1. Check your internet connection
2. Verify the API key: `echo %VISUAL_CROSSING_API_KEY%`
3. Try a smaller date range
4. Clear the weather cache and retry

### "No training samples available"

**Cause:** Not enough historical data. The model needs at least 7 days of data for lag features.

**Fix:** Provide more historical data in the training folder or use `--train-days` to adjust.

### "No matching records found" (during evaluation)

**Cause:** The forecast and actual data files don't have overlapping dates or matching column names.

**Fix:**
1. Check that date ranges overlap between forecast and actual files
2. Verify column names match (station codes or region codes)
3. Ensure both files use the same datetime format

### Database locked

**Cause:** Another process or a database viewer has the file open.

**Fix:** Close SQLite Browser or any other program accessing the database file.

### Build fails after code changes

**Fix:**
```bash
npm run build
```

If that fails, try:
```bash
rm -rf dist
npm run build
```

### Weather data seems wrong

**Fix:** Clear the cache for the affected location and re-run:
```bash
rmdir /s /q weather_cache\<LOCATION_NAME>
```

### Forecast values seem too high or too low

**Options:**
1. Check if auto-calibration is running (it should be, by default)
2. Use manual scaling flags to adjust: `--scale-solar 5` or `--scale-wind -3`
3. Try different model flags: `--use-xgboost`, `--asymmetric-loss`, `--bias-correction`
4. Evaluate and compare different flag combinations

### Station missing from output

**Cause:** Station may not be in `src/data/stations.json` or may not have training data.

**Fix:**
1. Check that the station code appears in your training data files
2. Verify the station exists in `src/data/stations.json`
3. Use `--stations <file>` to point to a custom stations file

---

## Quick Reference Card

### Most Used Commands

```bash
# Capacity factor forecast (recommended)
node dist/index.js cfac forecast2 -t "Data Samples/Capacity Factor" -s 2026-02-01 -e 2026-02-28 -o output/cfac.csv

# With best solar settings
node dist/index.js cfac forecast2 -t "Data Samples/Capacity Factor" -s 2026-02-01 -e 2026-02-28 -o output/cfac.csv --use-xgboost --asymmetric-loss

# With wind bias correction
node dist/index.js cfac forecast2 -t "Data Samples/Capacity Factor" -s 2026-02-01 -e 2026-02-28 -o output/cfac.csv --bias-correction

# Demand forecast
node dist/index.js forecast -d "Data Samples/Demand" -s 2026-02-01 -e 2026-02-28 -o output/demand.csv --model hybrid

# Evaluate capacity factor
node dist/index.js cfac evaluate -f output/cfac.csv -a "Data Samples/Capacity Factor/actuals.csv" -o output/eval.txt

# Evaluate demand
node dist/index.js evaluate -f output/demand.csv -a "Data Samples/Demand/actual.csv"

# Database status
node dist/index.js db status

# Scheduler
node dist/index.js scheduler run
node dist/index.js scheduler status
```

### Flag Quick Reference

```
Capacity Factor Tuning:
  --use-xgboost          Better ML model (best for solar)
  --asymmetric-loss      Penalize under-predictions (best for solar)
  --bias-correction      Long-term bias fix (best for wind)
  --no-auto-calibrate    Disable automatic calibration
  --scale-solar <pct>    Manual solar adjustment (%)
  --scale-wind <pct>     Manual wind adjustment (%)

Demand Tuning:
  --scale <pct>          Base adjustment for all forecasts
  --scale-workday <pct>  Mon-Fri override
  --scale-weekend <pct>  Sat-Sun override
  --scale-holiday <pct>  Holiday override (highest priority)
  --scale-peak <pct>     Peak hours multiplier (09-21)
  --scale-offpeak <pct>  Off-peak multiplier (21-09)
```
