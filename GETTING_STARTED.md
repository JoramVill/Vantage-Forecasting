# Getting Started with Vantage Forecaster CLI

This guide teaches you how to generate electricity forecasts using the command line.

---

## 1. Setup (One-Time)

```cmd
cd C:\Source_Codes\Vantage-Forecaster
npm install
npm run build
```

Verify it works:
```cmd
node dist/index.js --help
```

---

## 2. Understanding the Forecasts

Vantage Forecaster produces two types of forecasts:

### Demand Forecasts
Predicts hourly electricity consumption (in MW) for regions/zones.

- **Regional**: 3 regions (CLUZ, CVIS, CMIN)
- **Zonal**: 14 sub-regions (01NLUZ, 02METRO, etc.)

### Capacity Factor Forecasts
Predicts hourly generation capacity (0-1 scale) for 120 power plants.

- **Wind**: 6 stations (4-Tier MREC model)
- **Solar**: 51 stations (Physics+ML hybrid)
- **Hydro/Geothermal/Biomass/Battery**: 63 stations (Profile-based)

---

## 3. Generate Your First Forecast

### Step 1: Demand Forecast (Zonal)

```cmd
node dist/index.js v1:forecast ^
  -d "Data Samples/Demand" ^
  -s 2026-04-01 ^
  -e 2026-04-07 ^
  -o output/my_demand_forecast.csv ^
  --model hybrid ^
  --zonal
```

**What this does:**
- `-d` = Training data folder
- `-s` = Start date (YYYY-MM-DD)
- `-e` = End date (YYYY-MM-DD)
- `-o` = Output file path
- `--model hybrid` = Use hybrid model (best accuracy)
- `--zonal` = Output 14 zones (omit for 3 regions)

### Step 2: Capacity Factor Forecast

```cmd
node dist/index.js cfac forecast2 ^
  -t "Data Samples/Capacity Factor" ^
  -s 2026-04-01 ^
  -e 2026-04-07 ^
  -o output/my_cfac_forecast.csv
```

**What this does:**
- `-t` = Training data folder
- `-s`, `-e`, `-o` = Same as above
- Auto-calibrates using last 14 days of data

---

## 4. Command Reference

### Demand Forecast Options

```cmd
node dist/index.js v1:forecast --help
```

| Flag | Description | Default |
|------|-------------|---------|
| `-d, --demand <path>` | Training data folder | Required |
| `-s, --start <date>` | Forecast start (YYYY-MM-DD) | Required |
| `-e, --end <date>` | Forecast end (YYYY-MM-DD) | Required |
| `-o, --output <file>` | Output CSV file | Required |
| `--model <type>` | `hybrid`, `xgboost`, or `regression` | `hybrid` |
| `--zonal` | Use 14 zones instead of 3 regions | Off |
| `--train-days <n>` | Days of training data | 90 |

### Capacity Factor Options

```cmd
node dist/index.js cfac forecast2 --help
```

| Flag | Description | Default |
|------|-------------|---------|
| `-t, --training <path>` | Training data folder | Required |
| `-s, --start <date>` | Forecast start | Required |
| `-e, --end <date>` | Forecast end | Required |
| `-o, --output <file>` | Output CSV file | Required |
| `--auto-calibrate <days>` | Calibration window | 14 |
| `--no-auto-calibrate` | Skip calibration | Off |

---

## 5. Output File Format

### Demand CSV

```csv
DateTimeEnding,01NLUZ,02METRO,03SLUZ,04LEYTE,05CEBU,...
4/1/2026 01:00,3500.2,3100.5,2800.1,210.3,850.2,...
4/1/2026 02:00,3400.1,3000.3,2750.0,205.1,830.1,...
```

- **DateTimeEnding**: Hour-ending timestamp
- **Values**: MW demand per zone/region

### Capacity Factor CSV

```csv
DateTimeEnding,01BURGOS,01BOTOLAN,01CLARK_S,...,SOLAR,WIND
4/1/2026 01:00,0.15,0.00,0.00,...,0.00,0.12
4/1/2026 06:00,0.20,0.35,0.40,...,0.25,0.18
```

- **Values**: 0.0 to 1.0 (0% to 100% capacity)
- **SOLAR/WIND**: Aggregate columns at the end

---

## 6. Tips for Good Forecasts

1. **Use recent training data** - More recent = better accuracy
2. **Don't forecast too far ahead** - 7 days is reliable, 30 days is less so
3. **Check weather cache** - Delete `weather_cache/` if forecasts look wrong
4. **Memory issues?** - Set `NODE_OPTIONS=--max-old-space-size=16384`

---

## 7. Example Workflows

### Weekly Day-Ahead Forecasts

Run every Monday morning:
```cmd
scripts\generate-all-forecasts.bat
```

### Monthly Forecast for Planning

```cmd
scripts\generate-all-forecasts.bat 2026-05-01 2026-05-31
```

### Just Wind and Solar

```cmd
node dist/index.js cfac forecast2 ^
  -t "Data Samples/Capacity Factor" ^
  -s 2026-04-01 -e 2026-04-07 ^
  -o output/renewables.csv
```
Then filter the CSV for columns ending in `_W` (wind) or `_S` (solar).

---

## 8. Where to Learn More

| Document | What it covers |
|----------|----------------|
| `Documents/CLI_GUIDE.md` | Full command reference |
| `Documents/MODEL_OVERVIEW.md` | How the models work |
| `Documents/TECHNICAL_OVERVIEW.md` | Architecture details |
| `CLAUDE.md` | AI agent instructions (advanced) |

---

## Quick Reference Card

```
DEMAND FORECAST:
  node dist/index.js v1:forecast -d "Data Samples/Demand" -s YYYY-MM-DD -e YYYY-MM-DD -o output.csv --model hybrid [--zonal]

CAPACITY FACTOR:
  node dist/index.js cfac forecast2 -t "Data Samples/Capacity Factor" -s YYYY-MM-DD -e YYYY-MM-DD -o output.csv

BATCH (ALL):
  scripts\generate-all-forecasts.bat [START_DATE] [END_DATE]
```
