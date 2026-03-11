# iLoad Forecasting Utility - Developer Guide

A comprehensive CLI utility for electricity load and capacity factor forecasting, designed for the Philippine power grid (WESM - Wholesale Electricity Spot Market).

## Table of Contents

1. [Overview](#overview)
2. [Installation](#installation)
3. [CLI Commands](#cli-commands)
4. [Services](#services)
5. [Models](#models)
6. [Types and Interfaces](#types-and-interfaces)
7. [Data Formats](#data-formats)
8. [Weather Data](#weather-data)
9. [Architecture](#architecture)

---

## Overview

The iLoad Forecasting Utility provides two main forecasting capabilities:

1. **Demand Forecasting**: Predict electricity demand for Philippine grid regions (CLUZ, CVIS, CMIN)
2. **Capacity Factor Forecasting**: Predict capacity factors for renewable/must-run generation stations (wind, solar, hydro, geothermal, biomass, battery)

### Key Features

- Multiple model types: Regression, XGBoost, Hybrid
- Weather-integrated predictions via Visual Crossing API
- Cluster-based weather approach for 117+ power stations grouped into 29 weather clusters
- Physics-based hybrid models for wind and solar generation
- Profile-based models for stable generation sources
- SQLite database for model persistence
- WESM-compatible CSV output formats

---

## Installation

```bash
# Install dependencies
npm install

# Build the project
npm run build

# Run CLI commands
npx iload <command> [options]
```

### Environment Variables

- `VISUAL_CROSSING_API_KEY`: API key for weather data (optional, has default)

### Configuration File

Create `config.json` in the project root:

```json
{
  "visualCrossingApiKey": "YOUR_API_KEY"
}
```

---

## CLI Commands

### Main Entry Point

**File**: `src/index.ts`

```bash
npx iload <command> [options]
```

---

### 1. Train Command

Train forecasting models on historical demand and weather data.

```bash
npx iload train -d <demand_file> -w <weather_files...> [options]
```

**Required Options:**
| Option | Description |
|--------|-------------|
| `-d, --demand <file>` | Historical demand CSV file or directory |
| `-w, --weather <files...>` | Weather CSV files (one per region) |

**Optional:**
| Option | Default | Description |
|--------|---------|-------------|
| `-o, --output <dir>` | `./output` | Output directory for reports |
| `--model <type>` | `both` | Model type: `regression`, `xgboost`, or `both` |

**Example:**
```bash
npx iload train -d "Data Samples/Demand" -w weather_manila.csv weather_cebu.csv weather_davao.csv -o output
```

**Output:**
- `regression_report.md` - Regression model metrics
- `xgboost_report.md` - XGBoost model metrics
- `comparison.md` - Model comparison (if both trained)
- Models saved to SQLite database

---

### 2. Forecast Command

Generate demand forecasts (auto-fetches weather from Visual Crossing API).

```bash
npx iload forecast -d <demand_file> -s <start_date> -e <end_date> -o <output_file> [options]
```

**Required Options:**
| Option | Description |
|--------|-------------|
| `-d, --demand <file>` | Historical demand CSV file or directory |
| `-s, --start <date>` | Forecast start date (YYYY-MM-DD) |
| `-e, --end <date>` | Forecast end date (YYYY-MM-DD) |
| `-o, --output <file>` | Output forecast CSV file |

**Optional:**
| Option | Default | Description |
|--------|---------|-------------|
| `--model <type>` | `regression` | `regression`, `xgboost`, or `hybrid` |
| `--use-saved` | false | Use saved model from database |
| `--scale <percent>` | `0` | Scale forecast by percentage (+5 or -3) |
| `--growth <percent>` | `0` | Daily demand growth rate for hybrid model |
| `--cache <dir>` | `./weather_cache` | Weather cache directory |

**Example:**
```bash
npx iload forecast -d "Data Samples/Demand" -s 2024-12-01 -e 2024-12-31 -o output/dec_forecast.csv --model hybrid --growth 0.01
```

---

### 3. Info Command

Display information about data files.

```bash
npx iload info -d <demand_file> [-w <weather_files...>]
```

**Example:**
```bash
npx iload info -d "Data Samples/Demand"
```

---

### 4. Evaluate Command

Evaluate forecast accuracy against actual demand.

```bash
npx iload evaluate -f <forecast_file> -a <actual_file> [-o <report_file>]
```

**Required Options:**
| Option | Description |
|--------|-------------|
| `-f, --forecast <file>` | Forecast CSV file to evaluate |
| `-a, --actual <file>` | Actual demand CSV file |

**Optional:**
| Option | Description |
|--------|-------------|
| `-o, --output <file>` | Output evaluation report file |

**Output Metrics:**
- MAE (Mean Absolute Error)
- MAPE (Mean Absolute Percentage Error)
- RMSE (Root Mean Square Error)
- Bias (over/under-forecasting)
- Peak/Trough analysis by region

---

### 5. Database Commands

#### Status
```bash
npx iload db status
```
Shows database statistics (record counts, date ranges, regions).

#### Import
```bash
npx iload db import -t <type> -f <file> [-l <location>] [--forecast]
```

| Option | Description |
|--------|-------------|
| `-t, --type <type>` | Data type: `demand` or `weather` |
| `-f, --file <path>` | File or folder to import |
| `-l, --location <name>` | Location name for weather (Manila, Cebu, Davao) |
| `--forecast` | Mark weather as forecast data |

#### Models
```bash
npx iload db models [-a <id>]
```

| Option | Description |
|--------|-------------|
| `-a, --activate <id>` | Activate a specific model by ID |

#### Clear
```bash
npx iload db clear --confirm
```

---

### 6. Capacity Factor Commands (cfac)

#### CFAC Forecast

Generate capacity factor forecasts for renewable/must-run stations.

```bash
npx iload cfac forecast -t <training_path> -s <start_date> -e <end_date> -o <output_file> [options]
```

**Required Options:**
| Option | Description |
|--------|-------------|
| `-t, --training <path>` | Training data: MRHCFac CSV file or directory |
| `-s, --start <date>` | Forecast start date (YYYY-MM-DD) |
| `-e, --end <date>` | Forecast end date (YYYY-MM-DD) |
| `-o, --output <file>` | Output forecast CSV file |

**Optional:**
| Option | Default | Description |
|--------|---------|-------------|
| `--stations <file>` | `src/data/stations.json` | Stations metadata JSON file |
| `--cache <dir>` | `./weather_cache` | Weather cache directory |

**Example:**
```bash
npx iload cfac forecast -t "Data Samples/Capacity Factor" -s 2024-12-01 -e 2024-12-31 -o output/cfac_forecast.csv
```

**Process Flow:**
1. Load station metadata and cluster mappings
2. Parse MRHCFac training data
3. Identify wind clusters for 100m wind data (when premium API available)
4. Fetch cluster-based weather data
5. Build training samples by joining CFac + weather
6. Train station-specific models via ModelRouter
7. Generate forecasts using station-specific cluster weather
8. Output WESM-compatible CSV

---

#### CFAC Evaluate

Evaluate capacity factor forecast accuracy.

```bash
npx iload cfac evaluate -f <forecast_file> -a <actual_file> [-o <report_file>]
```

---

#### CFAC Info

Display information about capacity factor data files.

```bash
npx iload cfac info -d <data_path> [--stations <file>]
```

---

## Services

### WeatherService

**File**: `src/services/weatherService.ts`

Handles weather data fetching from Visual Crossing API with caching.

#### Key Interfaces

```typescript
interface WeatherLocation {
  id: string;
  name: string;
  region: string;
  demandColumn: string;  // CLUZ, CVIS, CMIN
}

interface ClusterLocation {
  clusterId: string;
  name: string;
  latitude: number;
  longitude: number;
  stationCodes: string[];
}

interface WeatherServiceConfig {
  apiKey: string;
  cacheDir: string;
  locations: WeatherLocation[];
}
```

#### Key Methods

| Method | Description |
|--------|-------------|
| `fetchWeatherData(location, startDate, endDate)` | Fetch weather for a named location |
| `fetchClusterWeatherData(cluster, startDate, endDate, isWindCluster)` | Fetch weather by coordinates for cluster |
| `fetchAllClusters(clusters, startDate, endDate, windClusterIds?)` | Fetch weather for all clusters |
| `getCacheStatus(startDate, endDate)` | Check cache availability |
| `clearCache(locationId?)` | Clear cached weather data |

#### Weather Elements

**Standard Elements:**
```
datetime, name, latitude, longitude, temp, dew, precip,
windgust, windspeed, cloudcover, solarradiation, solarenergy, uvindex
```

**Extended Wind Elements (Premium API):**
```
windspeed100, winddir100  // Wind at 100m hub height
```

#### Caching Structure

```
weather_cache/
  <location_id>/
    <year-month>/
      <date>.csv
```

---

### CapacityFactorService

**File**: `src/services/capacityFactorService.ts`

Handles station metadata, capacity factor data parsing, and cluster management.

#### Key Methods

| Method | Description |
|--------|-------------|
| `loadStations(path?)` | Load station metadata from JSON |
| `parseCapacityFactorCSV(filePath)` | Parse MRHCFac CSV file |
| `parseCapacityFactorDirectory(dirPath)` | Parse multiple CSV files |
| `buildTrainingSamples(cfacData, weatherData)` | Join CFac + weather into training samples |
| `writeForecastCSV(results, outputPath, stationCodes)` | Write WESM-format output |
| `getStationsByType(type)` | Get stations by StationType |
| `getClusters()` | Get all weather clusters |
| `getClusterForStation(stationCode)` | Get cluster ID for a station |

---

## Models

### ModelRouter

**File**: `src/models/capacityFactor/ModelRouter.ts`

Routes stations to appropriate model types based on station classification.

#### Station Type to Model Mapping

| StationType | Model Class |
|-------------|-------------|
| `WIND` | WindHybridModel |
| `SOLAR` | SolarHybridModel |
| `GEOTHERMAL` | GeothermalModel |
| `BIOMASS` | BiomassModel |
| `HYDRO_RUN_OF_RIVER` | HydroModel |
| `HYDRO_STORAGE` | HydroModel |
| `BATTERY` | BatteryModel |

#### Key Methods

```typescript
class ModelRouter {
  // Train all models from samples grouped by station
  async trainAllModels(samples: CFacTrainingSample[], progressCallback?): Promise<void>

  // Predict for single station
  predict(stationCode: string, weather: CFacWeatherFeatures, datetime: Date): number | null

  // Predict for multiple stations
  predictAll(stationCodes: string[], weather: Map<string, CFacWeatherFeatures>, datetime: Date): CFacForecastResult[]

  // Get training metrics
  getMetrics(): Map<string, CFacModelMetrics>

  // Get count of trained models
  getModelCount(): number
}
```

---

### WindHybridModel

**File**: `src/models/capacityFactor/WindHybridModel.ts`

Hybrid physics + ML model for wind capacity factor prediction.

#### Architecture

1. **Physics Base**: `WindPowerCurve` - Standard cubic power curve model
   - Cut-in speed: 3 m/s
   - Rated speed: 12 m/s
   - Cut-out speed: 25 m/s
   - Temperature adjustment for air density

2. **ML Residual**: Multivariate linear regression learns corrections from:
   - Wind speed (normalized)
   - Wind gust
   - Wind direction (cyclical sin/cos encoding)
   - Temperature
   - Hour (cyclical sin/cos encoding)
   - Month
   - Physics baseline
   - Lag features (1h, 24h)

3. **Final Prediction**: `physics_CFac + ML_residual`, clamped to [0, 1]

#### Key Methods

```typescript
class WindHybridModel {
  constructor(stationCode: string, powerCurveParams?: { cutIn?: number; rated?: number; cutOut?: number })

  async train(samples: CFacTrainingSample[]): Promise<{ mape: number; r2Score: number }>

  predict(weather: CFacWeatherFeatures, datetime: Date): number

  predictPhysicsOnly(windSpeed: number, temperature: number): number

  isReady(): boolean
}
```

#### Wind Speed Data Priority

The model prefers 100m hub-height wind data when available:
```typescript
const windSpeed = weather.windSpeed100 ?? weather.windSpeed;
```

---

### WindPowerCurve

**File**: `src/models/capacityFactor/WindPowerCurve.ts`

Physics-based wind power curve model.

#### Power Curve Regions

| Wind Speed | Output |
|------------|--------|
| < cut-in (3 m/s) | 0 |
| cut-in to rated | Cubic: `((V - cutIn) / (rated - cutIn))^3` |
| >= rated (12 m/s) | 1.0 |
| >= cut-out (25 m/s) | 0 (safety shutdown) |

#### Temperature Adjustment

Power is proportional to air density:
```typescript
const densityRatio = (273.15 + 15) / (273.15 + temperature);
const adjustedCFac = baseCFac * Math.pow(densityRatio, 1/3);
```

---

### SolarHybridModel

**File**: `src/models/capacityFactor/SolarHybridModel.ts`

Hybrid physics + ML model for solar capacity factor prediction.

#### Architecture

1. **Physics Base**: `SolarIrradianceModel`
   - Irradiance to power conversion
   - Temperature derating (NOCT model)

2. **ML Residual**: Corrections from:
   - Solar radiation (normalized by STC 1000 W/m²)
   - Cloud cover
   - Temperature
   - Hour (cyclical)
   - Month
   - Clear sky index

3. **Night Handling**: Returns 0 for hours < 6 or > 18

#### Key Methods

```typescript
class SolarHybridModel {
  constructor(stationCode: string, modelParams?: { tempCoeff?: number; systemLoss?: number })

  async train(samples: CFacTrainingSample[]): Promise<{ mape: number; r2Score: number }>

  predict(weather: CFacWeatherFeatures, datetime: Date): number

  predictPhysicsOnly(solarRadiation: number, temperature: number): number
}
```

---

### ProfileBasedModel

**File**: `src/models/capacityFactor/ProfileBasedModel.ts`

Base class for profile-based models (geothermal, biomass, hydro, battery).

#### Profile Key Structure

Profiles are grouped by: `hour_dayType`
- dayType: 0 = weekday, 1 = Saturday, 2 = Sunday

#### Statistics Calculated

| Statistic | Description |
|-----------|-------------|
| `min` | P5 (5th percentile) |
| `median` | P50 (50th percentile) |
| `max` | P95 (95th percentile) |
| `mean` | Average |
| `stdDev` | Standard deviation |
| `count` | Sample count |

#### Key Methods

```typescript
class ProfileBasedModel {
  buildProfiles(samples: CFacTrainingSample[]): void

  predict(datetime: Date): number  // Returns median

  predictWithBounds(datetime: Date): { prediction: number; lower: number; upper: number }

  isReady(): boolean
}
```

---

### Specialized Profile Models

| Model | File | Description |
|-------|------|-------------|
| `GeothermalModel` | `GeothermalModel.ts` | Extends ProfileBasedModel for geothermal plants |
| `BiomassModel` | `BiomassModel.ts` | Extends ProfileBasedModel for biomass plants |
| `HydroModel` | `HydroModel.ts` | Extends ProfileBasedModel for hydro (RoR/Storage) |
| `BatteryModel` | `BatteryModel.ts` | Extends ProfileBasedModel for battery storage |

---

## Types and Interfaces

**File**: `src/types/capacityFactor.ts`

### StationType Enum

```typescript
enum StationType {
  WIND = 'wind',
  SOLAR = 'solar',
  HYDRO_RUN_OF_RIVER = 'hydro_ror',
  HYDRO_STORAGE = 'hydro_storage',
  GEOTHERMAL = 'geothermal',
  BIOMASS = 'biomass',
  BATTERY = 'battery',
  UNKNOWN = 'unknown'
}
```

### CFacWeatherFeatures

```typescript
interface CFacWeatherFeatures {
  // Wind features (10m standard)
  windSpeed: number;
  windGust: number;
  windDirection?: number;

  // Wind at hub height (100m) - premium API
  windSpeed100?: number;
  windDirection100?: number;

  // Solar features
  solarRadiation: number;
  cloudCover: number;

  // Common
  temperature: number;
  humidity?: number;
  precipitation?: number;
  airDensity?: number;
}
```

### CFacTrainingSample

```typescript
interface CFacTrainingSample {
  datetime: Date;
  stationCode: string;
  stationType: StationType;
  actualCFac: number;          // 0.0 to 1.0
  weather: CFacWeatherFeatures;

  // Temporal features
  hour: number;
  dayOfWeek: number;
  month: number;
  isWeekend: boolean;

  // Lag features
  cfacLag1h?: number;
  cfacLag24h?: number;
}
```

### CFacForecastResult

```typescript
interface CFacForecastResult {
  datetime: Date;
  stationCode: string;
  predictedCFac: number;
  confidence?: {
    lower: number;
    upper: number;
  };
  modelType: string;
}
```

### Station Type Detection

The function `getStationTypeFromCode(stationCode)` determines station type by:

1. **Explicit Mapping**: Check `STATION_TYPE_MAPPING` dictionary
2. **Suffix Patterns**:
   - `_W` = Wind
   - `_S` = Solar
   - `_H` = Hydro Storage
   - `_BI` = Biomass
   - `_B` = Battery
   - `_G` or `_GP` = Geothermal
3. **Known Names**: Check `KNOWN_HYDRO_ROR_STATIONS` array
4. **Default**: `UNKNOWN`

---

## Data Formats

### MRHCFac CSV (Capacity Factor Input)

```csv
DateTimeEnding,01BAKUN,01BURGOS,01CLARK,...
11/1/2024 01:00,0.4523,0.2341,0.0000,...
11/1/2024 02:00,0.4612,0.2156,0.0000,...
```

**Notes:**
- Date format: `M/d/yyyy HH:mm` (hour-ending convention)
- Values: Capacity factor 0.0 to 1.0
- Empty cells allowed for missing data

### Forecast Output CSV

Same format as MRHCFac:
```csv
DateTimeEnding,01BAKUN,01BURGOS,01CLARK,...
12/1/2024 01:00,0.3821,0.1923,0.0000,...
```

### Demand CSV Format

```csv
DateTimeEnding,CLUZ,CVIS,CMIN
11/1/2024 01:00,8234,2156,1892
```

### stations.json Structure

```json
{
  "metadata": {
    "description": "...",
    "source": "WESM MNM_Genlist",
    "lastUpdated": "2024-XX-XX"
  },
  "stations": {
    "01BURGOS": {
      "name": "Burgos Wind",
      "type": "wind",
      "operator": "EDC",
      "capacity_mw": 150,
      "location": {
        "municipality": "Burgos",
        "province": "Ilocos Norte",
        "region": "Region I",
        "latitude": 18.5167,
        "longitude": 120.6500
      },
      "grid": "CLUZ",
      "commissioned": 2014
    }
  },
  "weatherMapping": {
    "notes": "Cluster-based weather approach",
    "clusterGroups": {
      "ILOCOS_NORTE_WIND": {
        "description": "Ilocos Norte Wind Farms",
        "stations": ["01BURGOS", "01LAOAG", "01PAGUDPUD"],
        "referenceLocation": {
          "name": "Burgos, Ilocos Norte",
          "latitude": 18.5167,
          "longitude": 120.6500
        }
      }
    }
  }
}
```

---

## Weather Data

### Visual Crossing API

**Base URL**: `https://weather.visualcrossing.com/VisualCrossingWebServices/rest/services/timeline/`

**Query Parameters:**
- `unitGroup=metric`
- `contentType=csv`
- `include=hours`
- `elements=<comma-separated list>`

### Hour Convention Handling

| Source | Convention |
|--------|------------|
| Visual Crossing | Hour-starting (00:00 = midnight to 01:00) |
| MRHCFac/WESM | Hour-ending (01:00 = midnight to 01:00) |

**Conversion Applied:**
```typescript
// When parsing weather data for CFac
const hourEndingTime = dt.plus({ hours: 1 });
```

### Cluster-Based Weather Approach

Instead of fetching weather for each station individually, stations are grouped into clusters sharing weather data from a reference location.

**Benefits:**
- Reduces API calls (29 clusters vs 117 stations)
- More efficient caching
- Consistent weather data for nearby stations

**Example Clusters:**
- `ILOCOS_NORTE_WIND`: 3 wind farms using Burgos coordinates
- `PAMPANGA_SOLAR`: 4 solar farms using Clark coordinates
- `DAVAO_HYDRO`: 5 hydro plants using Davao coordinates

---

## Architecture

### Directory Structure

```
src/
├── index.ts                    # CLI entry point
├── services/
│   ├── weatherService.ts       # Visual Crossing API client
│   ├── capacityFactorService.ts # Station/cluster management
│   └── index.ts
├── models/
│   ├── capacityFactor/
│   │   ├── ModelRouter.ts      # Station to model routing
│   │   ├── WindHybridModel.ts  # Physics + ML wind model
│   │   ├── WindPowerCurve.ts   # Physics wind model
│   │   ├── SolarHybridModel.ts # Physics + ML solar model
│   │   ├── SolarIrradianceModel.ts # Physics solar model
│   │   ├── ProfileBasedModel.ts # Base profile model
│   │   ├── GeothermalModel.ts
│   │   ├── BiomassModel.ts
│   │   ├── HydroModel.ts
│   │   ├── BatteryModel.ts
│   │   └── index.ts
│   ├── regressionModel.ts      # Demand regression
│   ├── xgboostModel.ts         # Demand XGBoost
│   └── hybridModel.ts          # Demand hybrid
├── types/
│   ├── capacityFactor.ts       # CFac types
│   └── index.ts
├── parsers/                    # CSV parsing
├── features/                   # Feature engineering
├── writers/                    # Output generation
├── database/                   # SQLite persistence
└── data/
    └── stations.json           # Station metadata
```

### Data Flow (CFAC Forecast)

```
1. Load Stations
   └── stations.json → CapacityFactorService
                       ├── stations Map
                       └── clusters Map

2. Parse Training Data
   └── MRHCFac CSV → RawCapacityFactorData[]

3. Fetch Weather Data
   └── Visual Crossing API → Cluster Weather Maps
       └── Cached by cluster/date

4. Build Training Samples
   └── CFac + Weather → CFacTrainingSample[]

5. Train Models
   └── ModelRouter.trainAllModels()
       ├── WindHybridModel.train()
       ├── SolarHybridModel.train()
       └── ProfileBasedModel.buildProfiles()

6. Generate Forecasts
   └── ModelRouter.predictAll()
       └── CFacForecastResult[]

7. Write Output
   └── WESM-format CSV
```

---

## Performance Considerations

### Current Baseline Metrics (as of last evaluation)

| Station Type | Avg MAPE | Notes |
|-------------|----------|-------|
| Wind | ~140-200% | High due to 10m vs 100m wind speed mismatch |
| Solar | ~35% | Moderate, physics model helps |
| Geothermal | ~13% | Good, stable generation pattern |
| Biomass | Varies | Profile-based |
| Hydro | Varies | Depends on type (RoR vs Storage) |

### Known Limitations

1. **Wind Forecasting**: Using 10m wind speeds instead of 100m hub-height data results in systematic underestimation. Premium Visual Crossing API provides 100m data.

2. **Weather Data Lag**: Real-time forecasting limited by weather data availability.

3. **Station Metadata**: Some stations may not have cluster mappings, falling back to averaged weather.

### Future Improvements

1. Implement wind shear correction: `V(hub) = V(10m) × ln(hub_height/z0) / ln(10/z0)`
2. Add 100m wind data when premium API available
3. Station-specific power curve calibration
4. Ensemble model approaches

---

## Usage Examples

### Basic Capacity Factor Forecast

```bash
# Generate November 2024 forecast from October training data
npx iload cfac forecast \
  -t "Data Samples/Capacity Factor/Oct2024" \
  -s 2024-11-01 \
  -e 2024-11-30 \
  -o output/nov_cfac_forecast.csv
```

### Evaluate Forecast Accuracy

```bash
npx iload cfac evaluate \
  -f output/nov_cfac_forecast.csv \
  -a "Data Samples/Capacity Factor/Nov2024/actual.csv" \
  -o output/evaluation_report.md
```

### Demand Forecast with Growth Factor

```bash
npx iload forecast \
  -d "Data Samples/Demand" \
  -s 2024-12-01 \
  -e 2024-12-31 \
  -o output/dec_demand.csv \
  --model hybrid \
  --growth 0.01 \
  --scale 2
```

---

## API Reference Summary

### Main Functions

| Function | Location | Purpose |
|----------|----------|---------|
| `createWeatherService(apiKey, cacheDir?)` | `weatherService.ts` | Create weather service instance |
| `getStationTypeFromCode(code)` | `capacityFactor.ts` | Determine station type from code |
| `capacityFactorService` | `capacityFactorService.ts` | Singleton service instance |
| `modelRouter` | `ModelRouter.ts` | Singleton router instance |

### Model Training

```typescript
// Train capacity factor models
const router = new ModelRouter();
await router.trainAllModels(trainingSamples, (msg) => console.log(msg));

// Get metrics
const metrics = router.getMetrics();
```

### Prediction

```typescript
// Single station prediction
const cfac = router.predict(stationCode, weatherFeatures, datetime);

// Multiple stations
const weatherMap = new Map<string, CFacWeatherFeatures>();
weatherMap.set('01BURGOS', { windSpeed: 8.5, ... });
const results = router.predictAll(['01BURGOS', '01CLARK'], weatherMap, new Date());
```
