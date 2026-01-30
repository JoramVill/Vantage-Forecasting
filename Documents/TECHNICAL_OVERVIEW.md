# Technical Overview

## System Architecture

TypeScript/Node.js CLI application for Philippine power grid (WESM) forecasting. Three forecasting domains:
1. **Demand Forecasting**: 3 grid regions (Luzon, Visayas, Mindanao)
2. **Capacity Factor Forecasting**: 118+ renewable energy stations
3. **Interconnector Constraint Prediction**: 2 HVDC links (MINVIS1, VISLUZ1)

## Directory Structure

```
src/
├── index.ts                    # CLI entry point (Commander.js)
├── constants/index.ts          # FEATURE_NAMES, holidays, region mappings
├── data/stations.json          # Station metadata + weather cluster definitions
├── database/
│   ├── schema.ts               # SQLite schema (version 6, 14+ tables)
│   ├── database.ts             # DatabaseService class (2000+ lines)
│   └── index.ts                # Singleton accessor
├── features/
│   ├── featureEngineering.ts   # 50+ demand features
│   └── interconnectorFeatures.ts
├── models/
│   ├── hybridModel.ts          # Demand: Region-aware hybrid
│   ├── regressionModel.ts      # Linear regression
│   ├── xgboostModel.ts         # XGBoost wrapper
│   └── capacityFactor/         # 28 model files
│       ├── ModelRouter.ts          # Routes station → model
│       ├── Wind4TierMRECModel.ts   # Default wind model
│       ├── WindEnhancedHybridModel.ts
│       ├── WindMRECModel.ts        # iPool 3-tier MREC
│       ├── SolarHybridModel.ts     # Default solar model
│       ├── SolarIrradianceModel.ts # Physics base
│       ├── CFacXGBoostRegressor.ts # XGBoost for ML layer
│       ├── BiasCorrector.ts        # Station-specific correction
│       ├── ProfileBasedModel.ts    # Base for non-weather types
│       ├── GeothermalModel.ts
│       ├── BiomassModel.ts
│       ├── HydroModel.ts
│       └── BatteryModel.ts
├── parsers/                    # CSV parsers
│   ├── demandParser.ts         # M/d/yyyy HH:mm, hour-ending
│   ├── weatherParser.ts        # ISO 8601, hour-starting
│   ├── capacityFactorParser.ts
│   ├── interconnectorParser.ts
│   └── outageParser.ts
├── services/
│   ├── weatherService.ts       # Visual Crossing API + DB + file cache
│   ├── capacityFactorService.ts # Station/cluster management
│   ├── forecastSchedulerService.ts
│   ├── capacityUpdateService.ts
│   └── iemopDownloadService.ts
├── types/
│   ├── index.ts                # Core interfaces
│   ├── capacityFactor.ts       # Station types, MREC types
│   ├── outage.ts               # Outage types
│   └── interconnector.ts
└── utils/dataMerger.ts         # Demand + weather alignment
```

## Database Schema (SQLite, version 6)

### Core Tables
- **`schema_info`**: Key-value metadata (schema version)
- **`demand_records`**: Hourly demand by region (CLUZ/CVIS/CMIN)
  - UNIQUE(datetime, region)
- **`weather_records`**: Regional weather (3 locations: Manila/Cebu/Davao)
  - UNIQUE(datetime, location, is_forecast)
  - Fields: name, latitude, longitude, temp, dew, precip, humidity, windgust, windspeed, cloudcover, solarradiation, solarenergy, uvindex
  - Smart refresh: `is_forecast` flag, `fetched_at` timestamp
- **`saved_models`**: Trained model coefficients and metrics (R2, MAPE, RMSE, MAE)

### Cluster Weather Tables (Capacity Factor)
Support 97+ station-specific weather locations with extended fields.

- **`cluster_weather_historical`**: Permanent actual weather data
  - UNIQUE(location_id, datetime)
  - Extended fields: windspeed50/80/100, winddir50/80/100, dniradiation, difradiation, ghiradiation, visibility, pressure, conditions
  - Never overwritten once imported (ON CONFLICT DO NOTHING)

- **`cluster_weather_forecast`**: Refreshable forecast data
  - UNIQUE(location_id, datetime)
  - Same fields as historical + `fetched_at` timestamp
  - Refreshed when older than 24 hours

- **`cluster_weather_forecast_archive`**: Versioned forecast history
  - Same fields + `lead_time_hours`, `archived_at` (DEFAULT CURRENT_TIMESTAMP)
  - `lead_time_hours`: Hours between when forecast was fetched and the target datetime
  - Archived in two scenarios:
    1. **Forecast-to-historical transition**: When actual weather replaces forecast data in `importClusterWeather()` or `promoteClusterForecastToHistorical()`
    2. **Forecast refresh**: When a newer forecast overwrites an older forecast for the same datetime
  - No UNIQUE constraint (stores multiple versions per datetime for accuracy tracking)
  - Enables forecast accuracy analysis: compare archived forecast weather vs actual historical weather

### MREC & Capacity Factor Tables
- **`mrec_factors`**: iPool 3-tier conversion factors (MRecH/M/L, vH/vL thresholds)
- **`wind_cfac_history`**: Historical wind output + wind speeds for calibration

### Scheduler Tables
- **`forecast_runs`**: Run metadata (date, type, status)
- **`demand_forecasts`**: Hourly forecast records
- **`cfac_forecasts`**: Station capacity factor records
- **`forecast_evaluations`**: Summary metrics per run
- **`calibration_history`**: Calibration scaling factors by date

### Outage & Interconnector Tables
- **`outage_records`**: Unit/facility outage events
- **`interconnector_records`**: HVDC flow data
- **`interconnector_metadata`**: Link capacities (MINVIS1: 450MW, VISLUZ1: 420MW)

## Data Flow

### Demand Forecasting Pipeline
```
CSV Files (demand + weather)
  → [demandParser + weatherParser]
  → [dataMerger] (weather +1h alignment: hour-starting → hour-ending)
  → [featureEngineering] (50+ features)
  → [LAG FILTER] (remove first 168h / 7 days)
  → [hybridModel] (train profiles + ML position predictor)
  → Output CSV (DateTimeEnding, CLUZ, CVIS, CMIN)
```

### Capacity Factor Forecasting Pipeline
```
MRHCFac CSV (historical capacity factors)
  → [capacityFactorService.parseCapacityFactorCSV]
  → [weatherService.fetchClusterWeatherData]
      → Check DB (cluster_weather_historical + forecast)
      → Download missing from Visual Crossing API
      → Store in DB (auto-route historical vs forecast)
  → [capacityFactorService.buildTrainingSamples]
      → Exponential decay weighting (lambda=0.02/day)
      → Outage filtering by station type
  → [ModelRouter] (route by StationType)
      → Wind → Wind4TierMRECModel or WindEnhancedHybridModel
      → Solar → SolarHybridModel
      → Other → ProfileBasedModel subclass
  → [BiasCorrector] (optional per-station calibration)
  → Output CSV (DateTimeEnding, station1, station2, ...)
```

### Weather Data Flow (Cluster Weather)
```
Request weather for cluster (e.g., SOLAR_01BOTOLAN)
  → db.getClusterMissingDates(locationId, start, end)
      Checks:
      1. No data at all → download
      2. Past date with only forecast → download historical
      3. Future date with stale forecast (>24h) → refresh
  → For missing dates: Download from Visual Crossing API
  → db.importClusterWeather(records, locationId, fetchedAt)
      Routes:
      - Past dates → Archives existing forecast record (if any) → cluster_weather_historical (ON CONFLICT DO NOTHING)
      - Future dates → Archives existing forecast record (if any) → cluster_weather_forecast (upsert)
  → db.promoteClusterForecastToHistorical(locationId)
      For past forecast records: Archive → Insert historical → Delete forecast
      Returns { promoted, archived } counts
  → db.getClusterWeather(locationId, start, end)
      Merges: historical (precedence) + forecast
      Returns sorted records
  → Format as CSV for backward compatibility
```

## Weather API Integration

### Visual Crossing API
- **Base URL**: `https://weather.visualcrossing.com/VisualCrossingWebServices/rest/services/timeline/`
- **Response format**: CSV (hourly)
- **Timezone**: Asia/Manila (forced for Philippine grid)

### Weather Element Sets
- **Standard (15 elements)**: datetime, name, lat, lon, temp, dew, precip, windgust, windspeed, cloudcover, solarradiation, solarenergy, uvindex, dniradiation, difradiation, ghiradiation
- **Wind (20 elements)**: Standard + winddir, windspeed50/winddir50, windspeed80/winddir80, windspeed100/winddir100
- **Full (24 elements)**: Wind + humidity, precipprob, pressure, visibility, conditions

### Validation
Cached/downloaded data validated for completeness:
- **Solar clusters**: >80% daylight hours must have solarradiation > 0
- **Wind clusters**: >50% of rows must have windspeed data
- **General**: >50% of rows must have non-empty data

## Station Metadata

Defined in `src/data/stations.json`:
```json
{
  "stations": {
    "01BURGOS": {
      "name": "Burgos Wind Farm",
      "type": "wind",
      "capacity_mw": 150,
      "location": {
        "municipality": "Burgos",
        "province": "Ilocos Norte",
        "region": "Region I",
        "latitude": 18.534,
        "longitude": 120.648
      },
      "grid": "CLUZ"
    }
  },
  "weatherMapping": {
    "clusterGroups": {
      "WIND_01BURGOS": {
        "stations": ["01BURGOS"],
        "referenceLocation": {
          "latitude": 18.534,
          "longitude": 120.648
        }
      }
    }
  }
}
```

### Station Type Detection (src/types/capacityFactor.ts)
Priority order:
1. **Explicit mapping**: `STATION_TYPE_MAPPING` lookup table
2. **Suffix pattern**: `_W`=Wind, `_S`=Solar, `_H`=Hydro Storage, `_BI/_BG`=Biomass, `_B`=Battery, `_G/_GP`=Geothermal
3. **Known names**: e.g., BAKUN → Hydro RoR
4. **Default**: Unknown

## Feature Engineering (Demand)

50+ features defined in `FEATURE_NAMES` (src/constants/index.ts):
- **Temporal (6)**: hour, dayOfWeek, isWeekend, isHoliday, dayOfMonth, month
- **Cyclical (2)**: hourSin, hourCos (preserves 23→0 circularity)
- **Day type (3)**: isWorkday, isSaturday, isSunday
- **Hour one-hot (24)**: hour_0 through hour_23
- **Interactions (3)**: hourWorkday, hourSaturday, hourSunday
- **Weather (9)**: temp, tempSquared, dew, precip, windgust, windspeed, cloudcover, solarradiation, uvindex
- **Derived (8)**: relativeHumidity (Magnus), heatIndex (Rothfusz), CDH (base 24°C), effectiveSolar, apparentTemp, isRaining, tempDewSpread, isDaytime
- **Lag (5)**: demandLag1h/24h/168h, tempLag1h/24h
- **Rolling (3)**: demandRolling24h, tempRolling24h, tempMax24h

**Lag filter**: First 168 hours (7 days) removed during training to ensure complete lag features.

## Philippines Grid Regions

| Region Code | Area | Weather City | Interconnector |
|-------------|------|--------------|----------------|
| CLUZ | Luzon | Manila | VISLUZ1 (420 MW) |
| CVIS | Visayas | Cebu City | MINVIS1 (450 MW), VISLUZ1 |
| CMIN | Mindanao | Davao City | MINVIS1 |

## Holiday Detection

Uses `date-holidays` npm package for dynamic Philippines holiday detection:
- Covers public, bank, and optional holidays
- Cached by year for performance
- Custom proclamations via `PH_HOLIDAYS_PROCLAIMED` in constants
- Holidays treated like Sundays in demand patterns

## Model Selection by Type

| Type | Model | Measured MAPE | Notes |
|------|-------|---------------|-------|
| Demand | Region-Aware Hybrid | 2-4% | XGBoost + temperature sensitivity + weekend correction |
| Wind | 4-Tier MREC | ~76% | 100m hub-height wind data, 4 capacity tiers |
| Solar | Physics+ML Hybrid | ~16% | Irradiance physics + ML correction |
| Hydro/Geothermal/Biomass/Battery | Profile-based | varies | Historical pattern matching |

### Weekend Correction Factors (Demand)
Applied in `src/models/hybridModel.ts`:
```typescript
['CLUZ', { saturday: 0.947, sunday: 0.951 }]  // 5% reduction for Luzon weekends
['CVIS', { saturday: 1.009, sunday: 0.980 }]  // Minor adjustments
['CMIN', { saturday: 0.999, sunday: 1.018 }]  // Minor adjustments
```
Reduced weekend MAE from 500 MW to ~250 MW.

## Dependencies

- **better-sqlite3**: SQLite database engine
- **luxon**: DateTime handling (ISO 8601)
- **axios**: HTTP requests (Visual Crossing API)
- **commander**: CLI framework
- **date-holidays**: Philippines holiday detection
- **xgboost-node**: XGBoost machine learning

## Configuration

### API Key Resolution
1. `VISUAL_CROSSING_API_KEY` environment variable
2. `config.json` → `visualCrossingApiKey`
3. Built-in default key

### Database Paths
- **Primary**: `./data/iload.db` (demand, weather, models)
- **Scheduler**: `./forecast.db` (forecast runs, evaluations)

### Weather Cache
- **Directory**: `./weather_cache/`
- **Structure**: `{clusterOrLocationId}/{YYYY-MM}/{YYYY-MM-DD}.csv`
- **Purpose**: Reduce API calls, persist downloaded data

## Timestamp Conventions

### Demand Data
- **Format**: `M/d/yyyy HH:mm` (e.g., `1/1/2025 1:00`)
- **Convention**: Hour-ending (1:00 = 00:00-01:00 average)

### Weather Data
- **Format**: ISO 8601 (e.g., `2025-01-01T00:00:00`)
- **Convention**: Hour-starting (00:00 = 00:00-01:00 conditions)

### Alignment
`dataMerger.ts` adds 1 hour to weather timestamps to align with hour-ending demand:
```
Weather 2025-01-01T00:00:00 → Demand 2025-01-01 1:00
```

## Performance Characteristics

### Training Speed
- **Demand models**: ~1-2 seconds for 1 year of hourly data
- **Capacity factor models**: ~5-15 seconds for 118 stations (parallel processing)
- **XGBoost**: 2-3x slower than linear regression, better accuracy for solar

### Forecast Generation
- **Demand**: <1 second for 7-day forecast
- **Capacity factor**: ~30-60 seconds for 7-day forecast (118 stations)
- **Weather API**: Rate-limited to 1000 records/day on free tier

### Database Size
- **1 year demand data**: ~50 KB
- **1 year weather data (3 locations)**: ~200 KB
- **1 year cluster weather (97+ locations)**: ~50 MB
- **Typical iload.db**: 100-200 MB with full history

## Error Handling

### Missing Data
- **Weather**: Interpolated if <5% gaps, otherwise error
- **Demand**: Skipped during training, flagged during forecasting
- **Capacity factor**: Station excluded if >20% missing training data

### API Failures
- **Retry logic**: 3 attempts with exponential backoff
- **Fallback**: Use cached data if available
- **Graceful degradation**: Skip station if weather unavailable

### Model Failures
- **Auto-fallback**: Enhanced Hybrid → MREC if ML layer degrades performance
- **Logging**: Warnings logged but don't halt pipeline
- **Validation**: Predictions clamped to [0, 1] for capacity factors
