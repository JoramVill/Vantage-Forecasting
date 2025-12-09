# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Run Commands

```bash
# Build TypeScript to JavaScript
npm run build

# Run CLI (after build)
node dist/index.js <command> [options]

# Run in development mode
npm run dev -- <command> [options]

# Global installation (optional)
npm link
iload <command> [options]
```

### GUI Application (in gui/ directory)
```bash
cd gui
npm install
npm run dev         # Development mode
npm run build       # Production build
npm run electron:build  # Package for distribution
```

## CLI Commands Overview

| Command | Description |
|---------|-------------|
| `train` | Train XGBoost/Regression models on demand + weather data |
| `forecast` | Generate demand forecasts (auto-fetches weather from Visual Crossing API) |
| `info` | Display data file summaries |
| `evaluate` | Compare forecast accuracy against actual demand |
| `db status/import/models/clear` | SQLite database management for stored models |
| `cfac forecast` | Capacity factor forecasting for renewable/must-run stations |

## Architecture

### Data Flow
```
CSV Parsers (demand/weather) → Data Merger (timestamp alignment) →
Feature Engineering (50+ features) → ML Models → Forecast Output
```

### Key Directories
- `src/parsers/` - CSV parsing (demand hour-ending M/D/YYYY HH:mm, weather ISO 8601 hour-starting)
- `src/features/featureEngineering.ts` - Feature extraction pipeline (temporal, weather, derived, lag features)
- `src/models/` - RegressionModel, XGBoostModel, HybridModel + capacityFactor/ subdirectory
- `src/services/` - Weather API integration (Visual Crossing), capacityFactorService
- `src/database/` - SQLite persistence via better-sqlite3
- `src/constants/index.ts` - FEATURE_NAMES array, REGION_MAPPINGS, PH_HOLIDAYS_2025

### Region Mapping (Philippines Grid)
```typescript
Manila → CLUZ (Luzon)
Cebu City → CVIS (Visayas)
Davao City → CMIN (Mindanao)
```

### Weather Timestamp Alignment
Weather uses hour-starting timestamps, demand uses hour-ending. The merger adds 1 hour to weather timestamps automatically.

## Feature Engineering

50+ features in `FEATURE_NAMES` constant:
- **Temporal**: hour, dayOfWeek, isWeekend, isHoliday, dayOfMonth, month, hourSin/Cos, hour_0-23 one-hot
- **Weather**: temp, tempSquared, dew, precip, windgust, windspeed, cloudcover, solarradiation, uvindex
- **Derived**: relativeHumidity (Magnus formula), heatIndex (Rothfusz), CDH (base 24°C), effectiveSolar, apparentTemp
- **Lag**: demandLag1h/24h/168h, tempLag1h/24h, rolling 24h averages

First 168 hours (7 days) filtered during training due to lag feature requirements.

## Capacity Factor Forecasting (cfac command)

Specialized system for renewable/must-run generation forecasting:
- Station type detection from codes: `_W` (wind), `_S` (solar), `_H` (hydro), `_BI` (biomass), `_B` (battery), `_G/_GP` (geothermal)
- Cluster-based weather fetching with 100m hub-height wind data for wind farms
- Per-station models via ModelRouter
- Source types in `src/types/capacityFactor.ts`: StationType enum, explicit STATION_TYPE_MAPPING

## API Keys

Visual Crossing API key resolution order:
1. `VISUAL_CROSSING_API_KEY` environment variable
2. `config.json` file in project root (`visualCrossingApiKey` field)
3. Built-in default key

## Database

SQLite database stores models and can cache demand/weather data:
```bash
iload db status         # View statistics
iload db import -t demand -f <file>
iload db import -t weather -f <file> -l Manila
iload db models         # List saved models
iload db models --activate <id>
```

## Important Patterns

- Weather data caches to `./weather_cache/` directory
- Progressive forecasting: predictions become lag values for subsequent predictions
- "Similar days" blending: when lag data unavailable, blends model prediction with historical averages
- Hybrid model supports daily growth rate adjustment via `--growth` parameter
- read the documentation first on startup