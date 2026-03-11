# AI Agent Onboarding Guide

**Start Here:** This guide provides essential context for AI agents working with this codebase.

## Documentation Navigation

| Need | Document |
|------|----------|
| **Quick command reference** | [../CLAUDE.md](../CLAUDE.md) - Primary reference |
| **All documentation** | [DOCUMENTATION_INDEX.md](DOCUMENTATION_INDEX.md) |
| **CLI commands** | [CLI_GUIDE.md](CLI_GUIDE.md) |
| **GUI usage** | [GUI_GUIDE.md](GUI_GUIDE.md) |
| **Deployment** | [DEPLOYMENT_GUIDE.md](DEPLOYMENT_GUIDE.md) |
| **Models explained** | [MODEL_OVERVIEW.md](MODEL_OVERVIEW.md) |

## What This Project Is

Vantage Forecaster - a TypeScript/Node.js application (CLI + Electron GUI) for forecasting Philippine power grid (WESM) electricity demand and renewable energy capacity factors. Built for iPool energy trading operations.

## Critical Context

- **Philippine power grid** with 3 regions: CLUZ (Luzon), CVIS (Visayas), CMIN (Mindanao)
- **Capacity factor** = actual output / nameplate capacity (0.0 to 1.0)
- **MREC** = Must-Run Energy Conversion (iPool's proprietary algorithm)
- **MRHCFac** = Market Resource Hourly Capacity Factor (the CSV format used by WESM)
- **WESM** = Wholesale Electricity Spot Market (Philippines)
- **Visual Crossing** = Weather data API provider
- **Timestamp convention**: Demand uses hour-ending (M/d/yyyy HH:mm), weather uses hour-starting (ISO 8601). The merger adds 1 hour to weather to align.
- **Tropical climate**: Base temperature 24°C for cooling degree hours. No heating demand.

## Project Structure (Key Files)

### Entry Point
- `src/index.ts` (~9000 lines) - All CLI commands. This is HUGE. Read relevant command sections, not the whole file.

### Models (Read These First)
- `src/models/hybridModel.ts` - Demand forecasting (the main demand model)
- `src/models/capacityFactor/Wind4TierMRECModel.ts` - Wind power (default)
- `src/models/capacityFactor/WindEnhancedHybridModel.ts` - Wind hybrid
- `src/models/capacityFactor/WindMRECModel.ts` - iPool 3-tier MREC base algorithm
- `src/models/capacityFactor/SolarHybridModel.ts` - Solar power (default, largest model file)
- `src/models/capacityFactor/SolarIrradianceModel.ts` - Physics base for solar
- `src/models/capacityFactor/ModelRouter.ts` - Routes stations to models by type
- `src/models/capacityFactor/ProfileBasedModel.ts` - Base for hydro/geo/biomass/battery
- `src/models/capacityFactor/BiasCorrector.ts` - Station-specific correction

### Database
- `src/database/schema.ts` - All table definitions (schema version 6)
- `src/database/database.ts` (~2000 lines) - DatabaseService. Read in chunks of 1000.

### Services
- `src/services/weatherService.ts` - Weather API + DB + file cache + validation
- `src/services/capacityFactorService.ts` - Station metadata, parsing, training sample building

### Types
- `src/types/index.ts` - Core interfaces (RawWeatherData, ClusterWeatherRecord, FeatureVector, etc.)
- `src/types/capacityFactor.ts` - StationType enum, station detection, MREC types
- `src/constants/index.ts` - FEATURE_NAMES (50+ features), holiday detection

### Data
- `src/data/stations.json` - Station metadata with coordinates, weather clusters

## Architecture Patterns

### Singleton Database
```typescript
import { getDatabase } from '../database/index.js';
const db = getDatabase();  // Always returns same instance
```

### Transaction-Based Imports
```typescript
const transaction = this.db.transaction(() => {
  for (const record of records) {
    insertStmt.run(...values);
  }
});
transaction();  // Atomic
```

### Weather Data Storage (3-Table Architecture)
```
cluster_weather_historical  - Permanent past data (never overwritten)
cluster_weather_forecast    - Future/current forecasts (refreshed when >24h old)
cluster_weather_forecast_archive - Old forecast versions (for accuracy tracking)
```
Smart refresh: `db.getClusterMissingDates()` returns dates needing fetch (missing, stale, or needs historical replacement).

**Archive Lifecycle**: Forecast records are archived (with `lead_time_hours`) before being replaced by either:
1. Historical actual data (`importClusterWeather()` historical path)
2. Promotion to historical (`promoteClusterForecastToHistorical()`)
3. Newer forecast data (forecast refresh/upsert)

This preserves forecast versions for accuracy analysis (forecast weather vs actual weather).

### Model Routing
Station type detected from code suffix: `_W`=Wind, `_S`=Solar, `_H`=Hydro Storage, `_BI`=Biomass, `_B`=Battery, `_G`=Geothermal. Explicit mappings override for non-standard names (e.g., 01BURGOS=Wind).

## Common Tasks and How to Do Them

### Adding a New Station
1. Add entry to `src/data/stations.json` with name, type, capacity, coordinates, grid
2. Add weather cluster in `weatherMapping.clusterGroups` with station-specific lat/lon
3. If non-standard naming, add to `STATION_TYPE_MAPPING` in `src/types/capacityFactor.ts`

### Modifying a Forecasting Model
- Wind models: `src/models/capacityFactor/Wind*.ts`
- Solar models: `src/models/capacityFactor/Solar*.ts`
- Demand model: `src/models/hybridModel.ts`
- The Model Router (`ModelRouter.ts`) decides which model runs for each station

### Adding a New CLI Command
- All commands defined in `src/index.ts` using Commander.js
- Pattern: `program.command('name').description('...').option('...').action(async (options) => { ... })`
- Build with `npm run build`, run with `node dist/index.js <command>`

### Changing Database Schema
1. Update `src/database/schema.ts` - add CREATE TABLE / ALTER statements
2. Increment `SCHEMA_VERSION`
3. Add methods to `src/database/database.ts`
4. Rebuild: `npm run build`

### Running a Forecast
```bash
npm run build
# Capacity factor (primary use case):
node dist/index.js cfac forecast2 -t "Data Samples/Capacity Factor" -s 2026-01-01 -e 2026-01-31 -o output/cfac.csv
# Demand:
node dist/index.js forecast -d "Data Samples/Demand" -s 2026-01-01 -e 2026-01-31 -o output/demand.csv --model hybrid
```

## Key Algorithms to Understand

### MREC 3-Tier Wind Model
Converts wind speed to capacity factor using piecewise linear model:
- LOW tier (wind < vL): CF = MRecL × windSpeed
- MID tier (vL ≤ wind < vH): CF = MRecM × windSpeed
- HIGH tier (wind ≥ vH): CF = MRecH × windSpeed
- vH/vL calibrated from Probability of Exceedance (top 10% / top 30%)

### MREC 4-Tier Wind Model (Default)
Enhanced version with four tiers for better accuracy:
- CALM tier (wind < vCalm): CF = MRecCalm × windSpeed
- LOW tier (vCalm ≤ wind < vL): CF = MRecL × windSpeed
- MID tier (vL ≤ wind < vH): CF = MRecM × windSpeed
- HIGH tier (wind ≥ vH): CF = MRecH × windSpeed
- Thresholds: vCalm=3.8 m/s, vL from P70, vH from P10

### Solar Physics Model
```
CF = (GHI × 1.4 / 1000) × (1 - 0.003 × (cellTemp - 25)) × 0.92
```
- 1.4 = irradiance correction for Visual Crossing API under-reporting
- cellTemp = ambient + (43-20) × GHI/800
- 0.92 = 8% system losses

### Demand Hybrid Model
1. Build P5/P50/P95 profiles per (region, hour, dayType)
2. Learn temperature sensitivity per region
3. ML predicts position within [min, max] bounds
4. Apply weekend correction factors (CLUZ: Sat=0.947, Sun=0.951)

## Things That Will Trip You Up

1. **index.ts is ~9000 lines** - Don't read it all. Search for the specific command you need.
2. **database.ts is ~2000 lines** - Read in chunks of 1000. Methods grouped by domain.
3. **Timestamp alignment** - Weather is hour-starting, demand is hour-ending. Merger adds 1 hour to weather.
4. **Two weather paths**: Regional (3 cities for demand) uses `weather_records` table. Station-specific (97+ clusters for capacity factor) uses `cluster_weather_*` tables.
5. **File cache still exists** alongside DB storage. The DB is primary; file cache is backup.
6. **irradianceScale=1.4** in solar model is a calibration constant, not a bug. Visual Crossing under-reports GHI.
7. **Holiday detection** is dynamic via `date-holidays` package. Don't hardcode holiday lists.
8. **Outage filtering** varies by station type. Wind removes all zeros, Solar only removes daytime zeros, Hydro removes long consecutive zero streaks.
9. **Recency weighting**: Training samples weighted by exponential decay (lambda=0.02/day, half-life ~35 days).
10. **Weekend correction factors** are learned from data and hardcoded in hybridModel.ts. They may need updating if demand patterns change.

## Debugging Common Issues

### "No weather data found for cluster X"
- Check if cluster exists in `stations.json` weatherMapping
- Verify coordinates are valid (lat/lon)
- Check database: `SELECT * FROM cluster_weather_historical WHERE cluster_id = 'X'`
- Delete cache if corrupted: `rm -rf weather_cache/X`

### "Training data filter removed all samples"
- Check date range - need >7 days for lag features
- Verify CSV format matches expected (hour-ending for demand, MRHCFac format for capacity)
- Check for timezone issues (Philippines = UTC+8)

### "Model predicts all zeros or NaN"
- Check if training data has actual non-zero values
- Verify feature engineering didn't create NaN values
- Check weather data quality (missing fields)
- For solar: ensure daytime hours have solarradiation > 0

### "Forecast differs wildly from actuals"
- Check if model was calibrated (auto-calibrate uses recent 14 days by default)
- Verify weather forecast quality (Visual Crossing API can be inaccurate)
- Check for station-specific issues (equipment degradation, outages)
- Review evaluation metrics to identify systematic bias

## File Size Reference (Largest Files)

| File | Lines | Notes |
|------|-------|-------|
| src/index.ts | ~9000 | CLI entry - read by section |
| src/database/database.ts | ~2000 | Read in chunks of 1000 |
| src/services/weatherService.ts | ~1000 | Weather fetch + cache + DB |
| src/models/capacityFactor/SolarHybridModel.ts | ~500 | Largest model file |
| src/services/capacityFactorService.ts | ~700 | Station management |

## Key Dependencies

| Package | Purpose |
|---------|---------|
| better-sqlite3 | SQLite database |
| luxon | DateTime handling |
| axios | HTTP requests (weather API) |
| commander | CLI framework |
| date-holidays | Philippines holiday detection |
| mathjs | Statistical functions |

## Testing Approach

- Build: `npm run build` (must pass with no TypeScript errors)
- Manual testing: Run forecast commands and evaluate output
- No automated test suite currently
- Evaluation commands compare forecast vs actual: `cfac evaluate`, `evaluate`

## Important Code Conventions

### Error Handling
```typescript
// Always use try-catch for external operations
try {
  const data = await weatherService.fetch(...);
} catch (error) {
  console.error(`Error: ${error.message}`);
  throw error;  // Re-throw or handle gracefully
}
```

### Logging
```typescript
// Use console.log for user-facing progress
console.log(`Processing ${stationCount} stations...`);
// Use console.error for errors
console.error(`Failed to process: ${error.message}`);
// Use console.warn for non-critical issues
console.warn(`No data for station ${code}, using fallback`);
```

### Date Formatting
```typescript
// Always use luxon DateTime
import { DateTime } from 'luxon';
const dt = DateTime.fromISO('2026-01-01', { zone: 'utc' });
const formatted = dt.toFormat('yyyy-MM-dd HH:mm:ss');
```

## Performance Optimization Tips

1. **Use database transactions** for bulk inserts (100x faster)
2. **Cache weather data** - don't re-fetch unless >24h old
3. **Batch API requests** - Visual Crossing allows multiple locations per call
4. **Filter early** - remove invalid samples before feature engineering
5. **Prepared statements** - reuse for multiple executions

## Deployment

### Portable Windows Build

```bash
# Full portable build with all data (~600MB ZIP)
node scripts/build-portable.cjs --zip --clean

# App-only update (no data)
node scripts/build-portable.cjs --no-data --zip

# Create data update packs
node scripts/create-data-pack.cjs --type weather    # Weather cache only
node scripts/create-data-pack.cjs --type training   # Training data only
node scripts/create-data-pack.cjs --type all        # Full data pack
```

### Portable Mode Detection

The Electron app detects portable mode via:
1. `.portable` marker file in app directory
2. Presence of `cli/node/node.exe` (bundled Node.js)

When portable, paths are relative to the exe directory instead of project root.

### Key Deployment Files

- `scripts/build-portable.cjs` - Main build script
- `scripts/create-data-pack.cjs` - Data pack generator
- `gui/electron/main.ts` - Portable mode path detection (`isPortableMode()`, `getAppRoot()`)

## GUI Application

The desktop GUI is in `gui/` directory (Electron + Vue 3):

```bash
cd gui && npm install && npm run dev  # Development
npm run electron:build                 # Build for distribution
```

Key GUI files:
- `gui/electron/main.ts` - Electron main process, IPC handlers
- `gui/src/App.vue` - Main Vue component
- `gui/src/components/` - UI components

## Zonal Mode (14 Sub-Regions)

The system supports two data modes:

| Mode | Regions | Database | Weather Cities |
|------|---------|----------|----------------|
| **Regional** | 3 (CLUZ, CVIS, CMIN) | `iload.db` | 3 (Manila, Cebu, Davao) |
| **Zonal** | 14 sub-regions | `iload_zonal.db` | 42 (3 per zone) |

Zonal codes: 01NLUZ, 02METRO, 03SLUZ, 04LEYTE, 05CEBU, 06NEGROS, 07BOHOL, 08PANAY, 09NWMIN, 10LANAO, 11NCMIN, 12NEMIN, 13SEMIN, 14SWMIN

Zone configuration: `src/data/zones.json`

## Related Documentation

| Document | Description |
|----------|-------------|
| `../CLAUDE.md` | **Primary reference** - Commands, models, architecture |
| `DOCUMENTATION_INDEX.md` | Complete documentation index |
| `QUICK_START.md` | Getting started in 5 minutes |
| `CLI_GUIDE.md` | Complete command reference |
| `GUI_GUIDE.md` | Desktop GUI user manual |
| `MODEL_OVERVIEW.md` | All models explained |
| `TECHNICAL_OVERVIEW.md` | Architecture and code structure |
| `DEPLOYMENT_GUIDE.md` | Building portable distributions |

Historical documents are in `Documents/archive/`.

## Quick Reference: Common CLI Commands

```bash
# Build
npm run build

# Capacity factor forecast (recommended)
node dist/index.js cfac forecast2 -t "Data Samples/Capacity Factor" -s 2026-01-01 -e 2026-01-31 -o output/cfac.csv

# Demand forecast
node dist/index.js forecast -d "Data Samples/Demand" -s 2026-01-01 -e 2026-01-31 -o output/demand.csv --model hybrid

# Evaluate forecast accuracy
node dist/index.js cfac evaluate -f output/cfac.csv -a "Data Samples/Capacity Factor/actuals.csv"

# Database status
node dist/index.js db status

# Scheduler (automated daily forecasts)
node dist/index.js scheduler run -d 2026-01-29 --demand-only --output ./output
```

## First Steps as a New Agent

1. **Read CLAUDE.md** in root directory - this is the primary reference
2. **Check git status** to see current branch and changes
3. **Identify the task type**:
   - Demand forecasting → `src/models/hybridModel.ts`
   - Capacity factor → `src/models/capacityFactor/`
   - GUI changes → `gui/`
   - Deployment → `scripts/build-portable.cjs`
4. **Read relevant model/service files** for your task
5. **Run `npm run build`** to verify TypeScript compiles
6. **Test your changes** with appropriate CLI command
7. **Update documentation** if you changed user-facing behavior

## Quick Command Reference

```bash
# Build CLI
npm run build

# Demand forecast (regional)
node dist/index.js forecast -d "Data Samples/Demand" -s 2026-01-01 -e 2026-01-31 -o output/demand.csv

# Demand forecast (zonal - 14 zones)
node dist/index.js forecast -d "Data Samples/Demand" -s 2026-01-01 -e 2026-01-31 -o output/demand.csv --zonal

# Capacity factor forecast
node dist/index.js cfac forecast2 -t "Data Samples/Capacity Factor" -s 2026-01-01 -e 2026-01-31 -o output/cfac.csv

# Scheduler run
node dist/index.js scheduler run -d 2026-01-01

# Database status
node dist/index.js db status

# Build portable distribution
node scripts/build-portable.cjs --zip --clean

# GUI development
cd gui && npm run dev
```
