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

Forecasts generation capacity for 117 renewable/must-run stations using specialized models.

**Station Types:**
| Type | Stations | Weather Dependency | Model |
|------|----------|-------------------|-------|
| Solar | 55 | High (radiation, cloud) | Physics+ML Hybrid |
| Hydro | 31 | Moderate (precipitation) | Profile-based |
| Biomass | 10 | Low | Profile-based |
| Battery | 8 | Dispatch-based | Profile-based |
| Geothermal | 8 | Low | Profile-based |
| Wind | 10 | High (wind speed) | Weather-Only MREC Hybrid |

**Station-Specific Weather:**
- Each station has individual coordinates for weather fetching
- Wind stations use optimal hub-height wind data (10m, 50m, 80m, or 100m based on correlation analysis)
- Weather cached locally to reduce API calls

#### Solar: Physics+ML Hybrid Model

**Architecture:**
```
Physics Base → ML Residual → Bias Correction → Hourly Correction → Final Prediction
```

**Physics Base (SolarIrradianceModel):**
- GHI normalization to Standard Test Conditions (1000 W/m²)
- Cell temperature calculation from ambient + irradiance
- Temperature derating: -0.3% per °C above 25°C
- System loss factor: 92%
- Irradiance scaling: 1.4x (calibrated for PH conditions)

**ML Residual Learning:**
- Multivariate Linear Regression or XGBoost
- Features: solar radiation, cloud cover, temperature, hour (cyclical), month, physics baseline, clear sky index
- Learns station-specific corrections for local effects

**Correction Layers:**
- Bias correction: Learned from training data (0.8-1.5 range)
- Hourly correction: Data-driven per-hour factors (replaces hardcoded sunset tapers)

#### Wind: Weather-Only MREC Hybrid Model

**Architecture:**
```
MREC Base (3-Tier) → Weather-Only ML Residual → High-Wind Cutout → Final Prediction
```

**MREC Base (iPool Algorithm):**
Three-tier piecewise linear conversion based on Probability of Exceedance:
```
if windSpeed >= vH:     PcCon = MRecH × windSpeed  (HIGH tier, top 10%)
else if windSpeed >= vL: PcCon = MRecM × windSpeed  (MID tier, 10-30%)
else:                    PcCon = MRecL × windSpeed  (LOW tier, bottom 70%)

if PcCon > 1.1: return 0  (High wind cutout)
```

**Calibration Methods:**
1. Standard PoE: Fixed 10%/30% thresholds
2. ML-Optimized: Grid search for optimal vH/vL per station
3. CF-Based: Learns thresholds from CF-wind relationship

**Weather-Only ML Features (NO temporal features to avoid monsoon overfitting):**
- MREC base prediction (anchor point)
- Tier indicators (H/M/L)
- Gust ratio (turbulence: windGust/windSpeed)
- Temperature deviation (air density proxy)
- Normalized wind speed
- Cloud cover (atmospheric conditions)

**Optimal Wind Height Per Station:**
| Station | Optimal Height | Correlation |
|---------|---------------|-------------|
| 01BURGOS | 50m | 0.64 |
| 08NABAS_W | 100m | 0.73 |
| 08STBARBRA_W | 10m | 0.74 |
| 01PAGUDPUD | 50m | 0.61 |
| 01LAOAG | 10m | 0.35 |

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

| Station Type | Model | Avg MAPE | Key Improvement |
|--------------|-------|----------|-----------------|
| Solar | Physics+ML Hybrid | ~16% | Station-specific bias correction |
| Wind | Weather-Only MREC Hybrid | ~76% | Avoids monsoon season overfitting |
| Geothermal | Profile-based | ~20% | Stable baseload patterns |
| Biomass | Profile-based | ~35% | Operational scheduling |
| Hydro | Profile-based | ~38% | Seasonal flow modeling |

**Wind Model Comparison:**
| Model | Training MAPE | Test MAPE | Issue |
|-------|---------------|-----------|-------|
| MREC-only | 141% | 96% | Robust baseline |
| MREC+ML (Temporal) | 110% | 111% | Overfits to season |
| MREC+ML (Weather-Only) | 122% | **76%** | Best generalization |

**Why Weather-Only for Wind?**
Temporal features (month encoding) memorize Jul-Oct monsoon patterns that don't transfer to Nov-Dec dry season. Weather-only features (gust ratio, temperature, wind speed) generalize across seasons.

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

## Key Improvements (December 2025)

### Demand Forecasting
1. **Hybrid Model v2**: Region-specific learned characteristics (CLUZ, CVIS, CMIN)
2. **Temperature Sensitivity**: Learned from data, not hardcoded per region
3. **Daily Swing Calibration**: Adapts to each region's peak-to-trough patterns
4. **Database Integration**: `--use-db` flag for streamlined workflows

### Capacity Factor Forecasting
5. **Physics+ML Hybrid for Solar**: ~16% MAPE with station-specific corrections
6. **Weather-Only MREC Hybrid for Wind**: ~76% MAPE, avoids monsoon overfitting
7. **ML-Optimized Calibration**: Grid search for optimal vH/vL thresholds per station
8. **Optimal Wind Heights**: Per-station height selection (10m-100m) based on correlation
9. **Station-Specific Weather**: Individual coordinates for 117 stations
10. **Asymmetric Loss Option**: Penalizes under-predictions more heavily for risk management

### Infrastructure
11. **Auto Weather Fetch**: Visual Crossing API with local caching
12. **XGBoost Option**: For ML residual learning in capacity factor models
13. **Outage Analysis**: ML-derived weather risk multipliers by region
