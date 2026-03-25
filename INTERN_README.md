# Vantage Forecaster - Intern Guide

Welcome! This guide will help you generate electricity demand and capacity factor forecasts for the Philippine grid.

## Quick Start (5 minutes)

### Option 1: Run the Batch File (Easiest)

```cmd
cd C:\Source_Codes\Vantage-Forecaster
scripts\generate-all-forecasts.bat 2026-04-01 2026-04-30
```

This generates all forecasts for April 2026 automatically.

### Option 2: Run Individual Commands

```cmd
cd C:\Source_Codes\Vantage-Forecaster

REM 1. Zonal Demand (14 zones)
node dist/index.js v1:forecast -d "Data Samples/Demand" -s 2026-04-01 -e 2026-04-30 -o output/demand_zonal.csv --model hybrid --zonal

REM 2. Capacity Factor (120 stations)
node dist/index.js cfac forecast2 -t "Data Samples/Capacity Factor" -s 2026-04-01 -e 2026-04-30 -o output/cfac.csv
```

---

## What Gets Generated

| File | Description | Columns |
|------|-------------|---------|
| `demand_zonal_*.csv` | Hourly demand for 14 zones | 01NLUZ, 02METRO, 03SLUZ, etc. |
| `demand_regional_*.csv` | Hourly demand for 3 regions | CLUZ, CVIS, CMIN |
| `cfac_*.csv` | Hourly capacity factor (0-1) | 120 station columns |

### Zone to Region Mapping

| Region | Zones |
|--------|-------|
| **CLUZ** (Luzon) | 01NLUZ, 02METRO, 03SLUZ |
| **CVIS** (Visayas) | 04LEYTE, 05CEBU, 06NEGROS, 07BOHOL, 08PANAY |
| **CMIN** (Mindanao) | 09NWMIN, 10LANAO, 11NCMIN, 12NEMIN, 13SEMIN, 14SWMIN |

---

## Prerequisites

1. **Node.js 18+** installed
2. **Project built**: Run `npm run build` once after cloning
3. **Training data** in place:
   - `Data Samples/Demand/DemHr_*.csv` (demand files)
   - `Data Samples/Capacity Factor/MRHCFac_*.csv` (capacity factor files)

---

## Common Tasks

### Generate Forecast for Next Week

```cmd
scripts\generate-all-forecasts.bat
```
(No arguments = tomorrow through +7 days)

### Generate Forecast for Specific Month

```cmd
scripts\generate-all-forecasts.bat 2026-05-01 2026-05-31
```

### Generate Only Demand Forecast

```cmd
node dist/index.js v1:forecast ^
  -d "Data Samples/Demand" ^
  -s 2026-04-01 ^
  -e 2026-04-30 ^
  -o output/demand.csv ^
  --model hybrid ^
  --zonal
```

### Generate Only Capacity Factor Forecast

```cmd
node dist/index.js cfac forecast2 ^
  -t "Data Samples/Capacity Factor" ^
  -s 2026-04-01 ^
  -e 2026-04-30 ^
  -o output/cfac.csv
```

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| "Out of memory" | Set `NODE_OPTIONS=--max-old-space-size=16384` before running |
| "No training samples" | Check that demand CSV files exist in Data Samples/Demand |
| "Command not found" | Run `npm run build` first |
| Forecast looks flat | Weather cache may be stale - delete `weather_cache/` folder |

---

## Need Help?

- Full CLI documentation: `Documents/CLI_GUIDE.md`
- Technical overview: `Documents/TECHNICAL_OVERVIEW.md`
- Model details: `Documents/MODEL_OVERVIEW.md`
