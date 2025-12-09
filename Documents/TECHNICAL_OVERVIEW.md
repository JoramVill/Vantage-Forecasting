# Technical Overview - iLoad Forecasting Utility

## System Architecture

### High-Level Component Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              iLoad CLI                                       │
│  ┌─────────┐ ┌──────────┐ ┌────────┐ ┌────────┐ ┌────────┐ ┌─────────────┐  │
│  │forecast │ │  cfac    │ │ outage │ │   db   │ │evaluate│ │forecast-all │  │
│  └────┬────┘ └────┬─────┘ └───┬────┘ └───┬────┘ └───┬────┘ └──────┬──────┘  │
└───────┼──────────┼───────────┼──────────┼──────────┼─────────────┼──────────┘
        │          │           │          │          │             │
        ▼          ▼           ▼          ▼          ▼             ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           Service Layer                                      │
│  ┌──────────────┐  ┌────────────────────┐  ┌─────────────────────────────┐  │
│  │ Weather      │  │ Capacity Factor    │  │ Outage Analysis             │  │
│  │ Service      │  │ Service            │  │ Service                     │  │
│  │ (API Fetch)  │  │ (117 stations)     │  │ (Weather Correlation)       │  │
│  └──────────────┘  └────────────────────┘  └─────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
        │          │           │          │
        ▼          ▼           ▼          ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                            Model Layer                                       │
│  ┌────────────────┐  ┌────────────────┐  ┌────────────────────────────────┐ │
│  │ Hybrid Model   │  │ XGBoost Model  │  │ Regression Model              │ │
│  │ (Region-aware) │  │ (Gradient Boost)│  │ (Linear)                     │ │
│  └────────────────┘  └────────────────┘  └────────────────────────────────┘ │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │ Capacity Factor Models (per station type: solar, wind, hydro, etc.)   │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘
        │          │           │          │
        ▼          ▼           ▼          ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                          Data Layer                                          │
│  ┌────────────────┐  ┌────────────────┐  ┌────────────────────────────────┐ │
│  │ SQLite DB      │  │ CSV Parsers    │  │ Weather Cache                 │ │
│  │ (Demand,       │  │ (Demand,       │  │ (Visual Crossing API)         │ │
│  │  Weather,      │  │  Weather,      │  │                               │ │
│  │  Models)       │  │  CFac, Outage) │  │                               │ │
│  └────────────────┘  └────────────────┘  └────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Core Components

### 1. Demand Forecasting Models

#### Hybrid Model (Recommended)

The Hybrid Model combines statistical profiles with region-specific learned characteristics.

**Key Features:**
- **Region-specific learning**: Each region (CLUZ, CVIS, CMIN) learns its own temperature sensitivity
- **Daily swing calibration**: Learns how much each region varies peak-to-trough
- **Time-period awareness**: Different sensitivity for night, morning, midday, evening

**Architecture:**
```typescript
interface RegionCharacteristics {
  avgDailySwing: number;           // Learned daily variation
  tempSensitivityMultiplier: number; // Learned temp response
  peakHourOffset: number;          // Peak timing adjustment
  troughDepthRatio: number;        // How low troughs go
}
```

**Training Process:**
1. Build statistical profiles per (region, hour, daytype)
2. Learn region characteristics from historical daily patterns
3. Calculate temperature-demand correlations per region
4. Store learned multipliers for forecasting

**Prediction Process:**
1. Look up statistical profile for (region, hour, daytype)
2. Apply region-specific temperature adjustment
3. Scale by learned swing amplitude
4. Clamp to historical min/max bounds

#### XGBoost Model

Gradient boosted decision trees for complex pattern capture.

**Configuration:**
```typescript
{
  maxDepth: 6,
  learningRate: 0.1,
  nEstimators: 100,
  validationSplit: 0.2
}
```

#### Regression Model

Linear regression for fast, interpretable forecasting.

---

### 2. Capacity Factor Forecasting

Forecasts generation capacity for 117 renewable/must-run stations.

**Station Types:**
| Type | Stations | Weather Dependency |
|------|----------|-------------------|
| Solar | 53 | High (radiation, cloud) |
| Hydro | 31 | Moderate (precipitation) |
| Biomass | 10 | Low |
| Battery | 8 | Dispatch-based |
| Geothermal | 8 | Low |
| Wind | 7 | High (wind speed) |

**Weather Clusters:**
- 29 geographic clusters for weather data
- Each cluster covers multiple nearby stations
- Wind stations use 100m hub-height wind data

**Model Architecture:**
- Individual regression model per station
- Features: solar radiation, temperature, wind speed, cloud cover, humidity
- Training on historical capacity factor data

---

### 3. Outage Analysis

Analyzes historical outages and forecasts probability based on weather.

**Weather Risk Multipliers (ML-derived):**
```typescript
precipitationThresholds: [
  { minPrecipMm: 100, multiplier: 3.40, label: 'Extreme Rain' },
  { minPrecipMm: 50,  multiplier: 2.61, label: 'Heavy Rain' },
  { minPrecipMm: 20,  multiplier: 1.34, label: 'Moderate Rain' }
]

windSpeedThresholds: [
  { minWindKmh: 50, multiplier: 3.35, label: 'Storm' },
  { minWindKmh: 40, multiplier: 2.24, label: 'High Wind' }
]

regionalPrecipSensitivity: {
  CLUZ: 1.199,
  CVIS: 1.225,
  CMIN: 1.000
}
```

---

### 4. Database System

SQLite database for persistent storage.

**Tables:**
- `demand` - Historical demand records
- `weather` - Historical and forecast weather
- `models` - Saved trained models
- `outages` - Historical outage events

**Key Operations:**
```typescript
db.getDemandData(startDate, endDate)
db.getWeatherForDateRegion(date, region)
db.saveModel(modelData)
db.importDemand(records)
```

---

### 5. Weather Service

Automatic weather data fetching from Visual Crossing API.

**Features:**
- Auto-fetches missing weather data
- Caches downloaded data to database
- Supports historical and forecast periods
- Multiple location support (Manila, Cebu, Davao + 29 clusters)

**API Integration:**
```typescript
const weatherService = createWeatherService(apiKey, cacheDir);
await weatherService.fetchWeatherData(location, startDate, endDate);
```

---

## Feature Engineering

### Temporal Features (6)
```typescript
{
  hour: 0-23,
  dayOfWeek: 0-6,
  isWeekend: 0|1,
  isHoliday: 0|1,
  isSaturday: 0|1,
  isSunday: 0|1
}
```

### Weather Features (8)
```typescript
{
  temp: number,           // °C
  dew: number,            // °C
  precip: number,         // mm
  windgust: number,       // km/h
  windspeed: number,      // km/h
  cloudcover: number,     // %
  solarradiation: number, // W/m²
  uvindex: number         // 0-11+
}
```

### Derived Features (8)
```typescript
{
  relativeHumidity: number,  // Magnus formula
  heatIndex: number,         // Rothfusz regression
  CDH: number,               // Cooling degree hours (base 24°C)
  effectiveSolar: number,    // Cloud-adjusted solar
  apparentTemp: number,      // Wind-adjusted temp
  isRaining: number,         // Binary flag
  tempDewSpread: number,     // Humidity indicator
  isDaytime: number          // 6am-6pm flag
}
```

### Lag Features (8)
```typescript
{
  demandLag1h: number,
  demandLag24h: number,
  demandLag168h: number,     // 7 days
  tempLag1h: number,
  tempLag24h: number,
  demandRolling24h: number,
  tempRolling24h: number,
  tempMax24h: number
}
```

---

## Data Flow

### Forecast Generation Flow

```
┌─────────────┐    ┌──────────────┐    ┌─────────────────┐
│ Load Demand │───>│ Fetch Weather│───>│ Build Features  │
│ (DB/File)   │    │ (API/Cache)  │    │                 │
└─────────────┘    └──────────────┘    └────────┬────────┘
                                                │
                                                ▼
┌─────────────┐    ┌──────────────┐    ┌─────────────────┐
│ Write CSV   │<───│ Generate     │<───│ Train Model     │
│ Output      │    │ Predictions  │    │                 │
└─────────────┘    └──────────────┘    └─────────────────┘
```

### Database-First Workflow

```
1. Import Data:
   iload db import -t demand -f demand.csv
   iload db import -t weather -f weather.csv -l Manila

2. Generate Forecast:
   iload forecast --use-db --start 2025-12-01 --end 2025-12-31 -o forecast.csv

3. Evaluate:
   iload evaluate -f forecast.csv -a actual.csv
```

---

## Performance Characteristics

### Model Accuracy (Typical)

| Model | R² | MAPE | Best For |
|-------|-----|------|----------|
| Hybrid | 0.99+ | 2-4% | Shape accuracy (peaks/troughs) |
| XGBoost | 0.95+ | 3-5% | Complex patterns |
| Regression | 0.85+ | 5-8% | Fast baseline |

### Capacity Factor Accuracy (by Type)

| Station Type | Avg MAE | Avg MAPE |
|--------------|---------|----------|
| Solar | 0.045 | 50% |
| Biomass | 0.020 | 35% |
| Geothermal | 0.083 | 20% |
| Hydro | 0.148 | 38% |
| Wind | 0.364 | 500%+ |

### Computational Performance

| Operation | 1 Week | 1 Month | 3 Months |
|-----------|--------|---------|----------|
| Data Load | <0.1s | <0.2s | <0.5s |
| Training | <1s | <2s | <5s |
| Forecast | <0.1s | <0.2s | <0.5s |

---

## Configuration

### Region Mappings
```typescript
REGION_MAPPINGS = {
  'manila': { demandColumn: 'CLUZ', city: 'Manila' },
  'cebu': { demandColumn: 'CVIS', city: 'Cebu City' },
  'davao': { demandColumn: 'CMIN', city: 'Davao City' }
}
```

### Weather API
- Provider: Visual Crossing
- API Key: Environment variable `VISUAL_CROSSING_API_KEY`
- Rate Limit: 1000 requests/day (free tier)

### Database
- Type: SQLite
- Location: `data/iload.db`
- Auto-created on first use

---

## File Structure

```
src/
├── index.ts              # CLI entry point
├── parsers/              # CSV parsing
│   ├── demandParser.ts
│   ├── weatherParser.ts
│   ├── capacityFactorParser.ts
│   └── outageParser.ts
├── models/               # Forecasting models
│   ├── hybridModel.ts    # Region-aware hybrid
│   ├── regressionModel.ts
│   ├── xgboostModel.ts
│   └── capacityFactor/   # CFac models
├── services/             # Business logic
│   ├── weatherService.ts
│   ├── capacityFactorService.ts
│   └── outageAnalysisService.ts
├── database/             # SQLite integration
│   └── database.ts
├── features/             # Feature engineering
│   └── featureEngineering.ts
├── types/                # TypeScript interfaces
├── utils/                # Utilities
└── writers/              # Output formatters
```

---

## Error Handling

### Common Errors

| Error | Cause | Solution |
|-------|-------|----------|
| "No demand data in database" | Empty DB | Import data with `db import` |
| "No training samples" | <168h of data | Provide more historical data |
| "Weather API error" | API key/network | Check API key, retry |
| "Missing required option" | CLI args | Use `--help` for options |

### Validation

- **Data Quality**: Missing values, outliers, duplicates
- **Timestamp Alignment**: Demand (hour-ending) vs Weather (hour-starting)
- **Feature Bounds**: Temperature 15-45°C, demand >0

---

## Extension Points

### Adding New Regions
1. Add to `REGION_MAPPINGS` in constants
2. Ensure demand CSV has column
3. Configure weather location

### Adding Features
1. Calculate in `featureEngineering.ts`
2. Add to `FeatureVector` interface
3. Include in `FEATURE_NAMES` array

### Adding Station Types
1. Add type to `StationType` enum
2. Implement station classifier
3. Configure weather cluster mapping

---

## Deployment

### Requirements
- Node.js 18+
- 200 MB RAM minimum
- 100 MB disk space

### Installation
```bash
npm install
npm run build
npm link  # Optional global install
```

### Production Recommendations
- Use `--model hybrid` for demand forecasting
- Import ≥3 months historical data
- Retrain monthly for best accuracy
- Monitor forecast vs actual metrics

---

## Key Improvements (2025)

1. **Hybrid Model**: Region-specific learned characteristics replace hardcoded values
2. **Database Integration**: `--use-db` flag for streamlined workflows
3. **Capacity Factor**: 117 station forecasting with cluster-based weather
4. **Outage Analysis**: ML-derived weather risk multipliers
5. **Auto Weather Fetch**: API integration eliminates manual weather file management
