# iLoad Forecasting Utility - Quick Start Guide

## Build & Run

```bash
# 1. Build the project
npm run build

# 2. Run CLI commands
node dist/index.js <command> [options]

# Or install globally
npm link
iload <command> [options]
```

## Available Commands

| Command | Description |
|---------|-------------|
| `train` | Train demand forecasting models |
| `forecast` | Generate demand forecasts (auto-fetches weather) |
| `evaluate` | Compare forecast vs actual demand |
| `cfac` | Capacity factor forecasting for renewables |
| `outage` | Outage analysis and probability forecasting |
| `db` | Database management |
| `forecast-all` | Generate both demand and capacity factor forecasts |
| `info` | Display data file information |

---

## Quick Examples

### 1. Generate Demand Forecast (Simplest)

```bash
# Using database data (recommended)
node dist/index.js forecast \
  --start 2025-11-01 \
  --end 2025-12-31 \
  --model hybrid \
  --use-db \
  --output forecast_nov_dec.csv
```

### 2. Generate Demand Forecast (from file)

```bash
node dist/index.js forecast \
  --demand "Data Samples/Demand/DemandHr_November.csv" \
  --start 2025-12-01 \
  --end 2025-12-07 \
  --model hybrid \
  --output forecast.csv
```

### 3. Generate Capacity Factor Forecast

```bash
node dist/index.js cfac forecast \
  --start 2025-11-01 \
  --end 2025-12-31 \
  --training "Data Samples/Capacity Factor" \
  --output cfac_forecast.csv
```

### 4. Generate Both Forecasts at Once

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

### 5. Evaluate Forecast Accuracy

```bash
node dist/index.js evaluate \
  --forecast forecast.csv \
  --actual "Data Samples/Demand/DemandHr_Actual.csv"
```

### 6. Outage Analysis

```bash
# Analyze historical outages
node dist/index.js outage analyze \
  --data "Data Samples/Outages"

# Weather-adjusted outage probability forecast
node dist/index.js outage weather-forecast \
  --start 2025-11-01 \
  --end 2025-12-31
```

---

## Database Management

### Import Data

```bash
# Import demand data
node dist/index.js db import -t demand -f "Data Samples/Demand/DemandHr.csv"

# Import weather data
node dist/index.js db import -t weather -f "weather_manila.csv" -l Manila
```

### Check Database Status

```bash
node dist/index.js db status
```

---

## Model Types

| Model | Best For | Description |
|-------|----------|-------------|
| `hybrid` | **Recommended** | Region-specific learned patterns, best shape accuracy |
| `regression` | Fast training | Linear regression, interpretable coefficients |
| `xgboost` | Complex patterns | Gradient boosting, highest R² but slower |

---

## Key Features

- **Auto Weather Fetching**: Automatically downloads weather data from Visual Crossing API
- **Database Storage**: Store demand/weather data for reuse
- **Three Demand Models**: Hybrid (recommended), Regression, XGBoost
- **Capacity Factor Forecasting**: 117 renewable/must-run stations
- **Outage Probability**: Weather-adjusted outage forecasting
- **Region-Specific Learning**: Hybrid model learns each region's unique patterns

---

## Getting Help

```bash
# General help
node dist/index.js --help

# Command-specific help
node dist/index.js forecast --help
node dist/index.js cfac --help
node dist/index.js outage --help
node dist/index.js db --help
```

---

## Next Steps

See [CLI_USAGE.md](./CLI_USAGE.md) for detailed documentation of all commands and options.
