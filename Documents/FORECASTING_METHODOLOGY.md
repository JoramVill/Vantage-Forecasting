# iLoad Forecasting Methodology Report

## Executive Summary

This document provides comprehensive documentation of the forecasting methodologies used by the iLoad Forecasting Utility for electricity demand and renewable energy capacity factor prediction in the Philippine power grid. The system employs state-of-the-art hybrid approaches combining physics-based models with machine learning to achieve optimal accuracy.

---

## Part 1: Weather Data

### 1.1 Data Source: Visual Crossing Weather API

**Provider:** Visual Crossing Corporation
**API Endpoint:** `https://weather.visualcrossing.com/VisualCrossingWebServices/rest/services/timeline/`
**Timezone:** Asia/Manila (Philippine Standard Time)

#### Why Visual Crossing?

1. **Comprehensive Coverage**: Provides hourly weather data for any location globally, including remote Philippine island locations
2. **Historical + Forecast Data**: Unified API for both historical training data and future forecasts
3. **High-Altitude Wind Data**: Unique offering of wind speed data at 50m, 80m, and 100m hub heights - critical for wind farm forecasting
4. **Reliability**: 99.9% API uptime with redundant data sources
5. **Cost-Effective**: Competitive pricing for high-volume commercial use
6. **Extended Solar Data**: Provides DNI (Direct Normal Irradiance), DHI (Diffuse Horizontal Irradiance), and GHI (Global Horizontal Irradiance)

### 1.2 Weather Parameters Fetched

#### Standard Hourly Elements
```
datetime, name, latitude, longitude, temp, dew, precip, windgust, windspeed,
cloudcover, solarradiation, solarenergy, uvindex, dniradiation, difradiation, ghiradiation
```

#### Extended Wind Elements (100m Hub Height)
```
windspeed, winddir (10m standard)
windspeed50, winddir50 (50m height)
windspeed80, winddir80 (80m height)
windspeed100, winddir100 (100m hub height - premium)
```

#### Full Elements (Per-Station Fetching)
```
All above plus: humidity, precipprob, pressure, visibility, conditions
```

### 1.3 Weather Parameters Used by Model Type

#### For Demand Forecasting
| Parameter | Unit | Description | Usage |
|-----------|------|-------------|-------|
| `temp` | °C | Air temperature at 2m | Primary cooling load driver |
| `dew` | °C | Dew point temperature | Humidity calculation |
| `precip` | mm | Precipitation amount | Activity pattern indicator |
| `windspeed` | km/h | Wind speed at 10m | Apparent temperature |
| `windgust` | km/h | Wind gust speed | Storm conditions |
| `cloudcover` | % | Cloud cover percentage | Solar heating |
| `solarradiation` | W/m² | Global horizontal irradiance (GHI) | Solar heating |
| `uvindex` | index | UV index (0-11+) | Clear-sky indicator |

#### For Wind Capacity Factor (100m Hub Height)
| Parameter | Unit | Description | Critical For |
|-----------|------|-------------|--------------|
| `windspeed100` | km/h | Wind speed at 100m hub height | Primary power predictor |
| `winddir100` | degrees | Wind direction at 100m | Wake effects |
| `windgust` | km/h | Surface wind gust | Gust ratio calculation |
| `temp` | °C | Air temperature | Air density adjustment |
| `cloudcover` | % | Cloud cover | Atmospheric stability proxy |

#### For Solar Capacity Factor
| Parameter | Unit | Description | Critical For |
|-----------|------|-------------|--------------|
| `solarradiation` | W/m² | Global Horizontal Irradiance (GHI) | Primary power predictor |
| `cloudcover` | % | Cloud cover percentage | Attenuation factor |
| `temp` | °C | Temperature | Panel efficiency derating |
| `uvindex` | 0-11+ | UV index | Clear-sky confidence (r=0.78) |
| `visibility` | km | Visibility | Haze/aerosol indicator (r=0.31) |
| `conditions` | text | Sky conditions | "Clear", "Overcast", "Rain" |

### 1.4 Station-Specific Weather Fetching

The system uses precise geographic coordinates for each generation station to fetch localized weather data:

**Wind Farms (100m Hub Height Data):**
| Station | Coordinates | Location |
|---------|-------------|----------|
| 01BURGOS | 18.5340°N, 120.6479°E | Burgos, Ilocos Norte |
| 01LAOAG | 18.5250°N, 120.7000°E | Bangui, Ilocos Norte |
| 01PAGUDPUD | 18.6148°N, 120.8051°E | Pagudpud, Ilocos Norte |
| 08NABAS_W | 11.8794°N, 121.9859°E | Nabas, Aklan |
| 08BVISTA | 10.5906°N, 122.6923°E | San Lorenzo, Guimaras |
| 02DOLORES | 14.4753°N, 121.3485°E | Pililla, Rizal |

**Solar Plants:** Each of 55 solar stations has individual coordinates for precise irradiance data

**Demand Regions:**
| City | Coordinates | Demand Column |
|------|-------------|---------------|
| Manila | 14.5995°N, 120.9842°E | CLUZ (Luzon) |
| Cebu City | 10.3157°N, 123.8854°E | CVIS (Visayas) |
| Davao City | 7.0731°N, 125.6128°E | CMIN (Mindanao) |

### 1.5 Weather Data Caching

**Primary Storage:** SQLite database (`weather_records` table)
**Backup Cache:** File system in `./weather_cache/` directory organized by location/year/month

**Smart Refresh Logic:**
- Historical data (past dates) is permanent, never re-downloaded
- Forecast data refreshed if >24 hours old
- Past dates with forecast data get replaced with actual historical data
- Database queries track missing dates, stale forecasts, and historical needs

### 1.6 Why 100m Hub Height Wind Data?

Modern wind turbines have hub heights of 80-100+ meters. Surface (10m) wind data:
- Under-represents actual wind speeds by 30-50%
- Misses boundary layer effects
- Cannot capture vertical wind shear

Using 100m data from Visual Crossing provides:
- Direct measurement at turbine height
- More accurate power curve correlation
- Better gust characterization

---

## Part 2: Demand Forecasting

### 2.1 Model Architecture: Hybrid Statistical + ML

The demand forecasting system uses a **hybrid approach** that combines:

1. **Statistical Profiles** - Hour/day-type specific bounds (min/median/max) with temperature coefficients
2. **ML Position Prediction** - Linear regression to predict position within statistical bounds
3. **Region-Specific Characteristics** - Learned temperature sensitivity and swing patterns per region

### 2.2 Feature Engineering (70 Features)

#### Temporal Features (11 features)
| Feature | Description | Formula |
|---------|-------------|---------|
| `hour` | Hour of day (0-23) | Direct |
| `dayOfWeek` | Day of week (0=Sunday) | Direct |
| `isWeekend` | Binary weekend indicator | 1 if Sat/Sun |
| `isHoliday` | Philippine public holidays | Dynamic detection |
| `dayOfMonth` | Day within month (1-31) | Direct |
| `month` | Month of year (1-12) | Direct |
| `hourSin` | Cyclical hour (sine) | sin(2π × hour / 24) |
| `hourCos` | Cyclical hour (cosine) | cos(2π × hour / 24) |
| `isWorkday` | Monday-Friday, non-holiday | 1 if workday |
| `isSaturday` | Saturday (non-holiday) | 1 if Saturday |
| `isSunday` | Sunday OR holiday | 1 if Sunday/holiday |

#### Hour One-Hot Encoding (24 features)
| Features | Description |
|----------|-------------|
| `hour_0` through `hour_23` | Binary indicator for each hour |

#### Hour-DayType Interactions (3 features)
| Feature | Description |
|---------|-------------|
| `hourWorkday` | hour × isWorkday |
| `hourSaturday` | hour × isSaturday |
| `hourSunday` | hour × isSunday |

#### Raw Weather Features (9 features)
| Feature | Description |
|---------|-------------|
| `temp` | Temperature (°C) |
| `tempSquared` | temp² (non-linear AC demand) |
| `dew` | Dew point (°C) |
| `precip` | Precipitation (mm) |
| `windgust` | Wind gust speed (km/h) |
| `windspeed` | Wind speed (km/h) |
| `cloudcover` | Cloud cover (%) |
| `solarradiation` | Solar radiation (W/m²) |
| `uvindex` | UV index (0-11+) |

#### Derived Weather Features (8 features)
| Feature | Formula | Purpose |
|---------|---------|---------|
| `relativeHumidity` | Magnus formula: 100 × exp((17.625×dew)/(243.04+dew)) / exp((17.625×temp)/(243.04+temp)) | Discomfort index |
| `heatIndex` | Rothfusz regression (if temp ≥ 27°C) | Perceived temperature |
| `CDH` | max(0, temp - 24°C) | Cooling degree hours |
| `effectiveSolar` | solarradiation × (1 - cloudcover/100) | Net solar heat gain |
| `apparentTemp` | temp - windspeed × 0.05 | Wind chill effect |
| `isRaining` | 1 if precip > 0.1 mm | Activity pattern |
| `tempDewSpread` | temp - dew | Atmospheric moisture |
| `isDaytime` | 1 if 6:00-18:00 | Day/night indicator |

#### Lag Features (5 features)
| Feature | Description | Purpose |
|---------|-------------|---------|
| `demandLag1h` | Demand 1 hour ago | Short-term trend |
| `demandLag24h` | Demand same hour yesterday | Daily pattern |
| `demandLag168h` | Demand same hour last week | Weekly seasonality |
| `tempLag1h` | Temperature 1 hour ago | Weather persistence |
| `tempLag24h` | Temperature yesterday | Daily weather cycle |

#### Rolling Averages (3 features)
| Feature | Description |
|---------|-------------|
| `demandRolling24h` | 24-hour rolling average demand |
| `tempRolling24h` | 24-hour rolling average temperature |
| `tempMax24h` | Maximum temperature in last 24 hours |

### 2.3 Statistical Profile System

The hybrid model builds statistical profiles for each combination of:
- **Region** (CLUZ, CVIS, CMIN)
- **Hour** (0-23)
- **Day Type** (0=Workday, 1=Saturday, 2=Sunday/Holiday)

**Profile Statistics per Combination:**
| Statistic | Calculation |
|-----------|-------------|
| `min` | 5th percentile (P5) |
| `median` | 50th percentile (P50) |
| `max` | 95th percentile (P95) |
| `tempCoefficient` | Covariance(temp, demand) / Variance(temp) |
| `baseTemp` | Average temperature for this profile |
| `swingAmplitude` | max - min |

### 2.4 Time Period Temperature Sensitivity

Different time periods have different temperature-demand relationships:

| Time Period | Hours | Base Sensitivity | Rationale |
|-------------|-------|------------------|-----------|
| NIGHT | 0-5 | 0.4 | Base load, low variation |
| MORNING_RAMP | 6-9 | 0.6 | Wake-up patterns |
| MIDDAY | 10-16 | 1.0 | Cooling load dominant |
| EVENING_PEAK | 17-22 | 0.5 | Residential patterns |
| LATE_NIGHT | 23 | 0.4 | Transition period |

**Note:** Actual sensitivity is multiplied by region-specific learned multiplier (0.3-1.0).

### 2.5 Region-Specific Characteristics (Learned)

Instead of hardcoded values, the model learns these characteristics from training data:

| Characteristic | Description |
|----------------|-------------|
| `avgDailySwing` | Average daily max-min demand variation |
| `tempSensitivityMultiplier` | Learned from temp-demand correlation (0.3-1.0) |
| `peakHourOffset` | Peak hour deviation from typical 3pm |
| `troughDepthRatio` | Minimum demand relative to average |

### 2.6 Prediction Algorithm

1. **Start with Profile Median** for the hour/daytype combination
2. **Apply Temperature Adjustment:**
   ```
   adjustment = tempCoefficient × (current_temp - base_temp) × time_period_sensitivity × region_multiplier
   prediction += adjustment
   ```
3. **Apply Swing Scaling** based on region characteristics
4. **Apply Lag-Based Trend** (±5% max based on demandLag24h ratio)
5. **Clamp to [min, max] Bounds**
6. **Apply Growth Factor** for multi-day forecasts

### 2.7 Philippine Holiday Detection

Dynamic holiday detection using `date-holidays` npm package:
- Regular Holidays
- Special Non-Working Days
- Presidential Proclamations (manually added)

**Holiday Treatment:** Holidays are treated as Sundays for demand pattern purposes.

### 2.8 Why This Approach?

**Statistical Profiles Provide:**
- Stable bounds based on historical patterns
- Resistance to overfitting
- Interpretable min/median/max ranges

**ML Position Prediction Provides:**
- Adaptation to current conditions
- Complex interaction modeling
- Temperature-driven adjustments

**Hybrid Benefits:**
- Predictions always within reasonable bounds
- Avoids "death spiral" from lag feature feedback
- Maintains hourly shape integrity

---

## Part 3: Capacity Factor Forecasting

### 3.1 Generation Types and Models

| Generation Type | Model | Expected MAPE | Model Class |
|----------------|-------|---------------|-------------|
| Wind | 4-Tier MREC Hybrid | ~50% | Weather-dependent |
| Solar | Physics+ML Hybrid | ~16% | Weather-dependent |
| Geothermal | Profile-based | ~8% | Stable generation |
| Battery | Profile-based | ~9% | Dispatch-dependent |
| Hydro (RoR) | Profile-based | ~30% | Water flow dependent |
| Hydro (Storage) | Profile-based | ~40% | Dispatch-dependent |
| Biomass | Profile-based | ~25% | Fuel-dependent |

### 3.2 Wind Model: 4-Tier MREC Hybrid

#### Architecture Overview

The wind model uses a **4-tier piecewise MREC base** combined with **region-specific ML residual correction**:

```
CFac = MREC_4Tier(windSpeed) + ML_Residual(weather_features, tier)
```

#### The Four Tiers (Power Curve Regions)

```
CF
1.0 |                    _____[RATED PLATEAU]_____
    |                   /                         \
    |                  / [RAMP]                    \[DERATE]
0.5 |                 /                             |
    |    [LOW/CUBIC] /                              |
0.0 |_______________/                               |[CUT-OUT]
    0    4    8    12   16   20   24   28   32   36
                    Wind Speed (m/s)
```

| Tier | Wind Speed Range | Physical Behavior | Default Threshold |
|------|-----------------|-------------------|-------------------|
| **LOW** | 0 - vLow | Below cut-in, minimal generation | vLow = 5 m/s |
| **RAMP** | vLow - vRated | Cubic power relationship, CF climbing | vRated = 12 m/s |
| **RATED** | vRated - vHigh | Near-rated output, plateau ~75% CF | vHigh = 25 m/s |
| **HIGH** | > vHigh | Near cut-out, feathering/curtailment | vCutOut = 28 m/s |

#### MREC Factor Calculation

**MREC (Marginal Rate of Energy Conversion)** factors are calibrated per tier:

```
For each tier:
  MRec_tier = Average_CF_tier / Average_WindSpeed_tier

Prediction:
  CF = MRec_tier × windSpeed (clamped to [0, 1])
```

#### Threshold Optimization

Thresholds are optimized per station using grid search:
- Search over 10×10×10 combinations
- Require minimum samples per tier (LOW: 10, RAMP: 10, RATED: 5)
- Asymmetric penalty: 2× for under-predicting high CF hours
- Objective: Minimize weighted MAE

#### ML Residual Features (11 features)

The key innovation is **region-specific gust ratio features** that address behavior inversion:

| Feature | Description | Purpose |
|---------|-------------|---------|
| `mrec_base` | 4-Tier MREC prediction | Anchor value |
| `tier_RAMP` | 1 if in RAMP tier | Tier indicator |
| `tier_RATED` | 1 if in RATED tier | Tier indicator |
| `tier_HIGH` | 1 if in HIGH tier | Tier indicator |
| `gustRatio_ramp` | gustRatio × tier_RAMP | RAMP-specific gust (positive coef) |
| `gustRatio_rated` | gustRatio × tier_RATED | RATED-specific gust (near-zero coef) |
| `gustRatio_high` | gustRatio × tier_HIGH | HIGH-specific gust |
| `temp_deviation` | (temp - 25°C) / 20 | Air density proxy |
| `wind_speed_norm` | windSpeed / 30 | Normalized wind |
| `rated_plateau_flag` | 1 if in RATED tier | Plateau stabilizer |
| `cloud_cover` | cloudCover / 100 | Atmospheric conditions |

#### GustRatio Behavior Inversion

**Key Insight:** GustRatio has **inverted correlation** across power curve regions:

| Region | GustRatio Effect | Coefficient Sign | Physical Reason |
|--------|------------------|------------------|-----------------|
| RAMP | Higher gusts → higher output | Positive | Capturing more energy from gusts |
| RATED | Lower gusts → stable output | Near-zero/Negative | Consistent max generation |
| HIGH | Complex | Variable | Near cut-out dynamics |

By creating separate features per region, the model learns appropriate coefficients without conflict.

#### Training Options

| Option | Description | When to Use |
|--------|-------------|-------------|
| Linear Regression | MultivariateLinearRegression | Default, fast training |
| XGBoost | CFacXGBoostRegressor | Optional, better for complex patterns |
| Asymmetric Loss | 2:1 under-prediction penalty | When high CF hours matter most |

**XGBoost Hyperparameters (if used):**
```typescript
maxDepth: 4
learningRate: 0.05
nEstimators: 150
minChildWeight: 5
subsample: 0.8
alpha: 0.65 (asymmetric) or 0.5 (standard)
```

### 3.3 Solar Model: Physics+ML Hybrid

#### Architecture

```
CFac = Physics_Base(GHI, temp) + ML_Residual(features) × Corrections
```

#### Physics Base: SolarIrradianceModel

**Model Constants:**
| Parameter | Value | Description |
|-----------|-------|-------------|
| `GHI_STC` | 1000 W/m² | Standard Test Conditions irradiance |
| `tempCoeff` | -0.003 | -0.3% efficiency per °C above 25°C |
| `systemLoss` | 0.92 | 92% system efficiency (modern inverters) |
| `NOCT` | 43°C | Nominal Operating Cell Temperature |
| `irradianceScale` | 1.4 | API under-reporting correction |

**Cell Temperature Calculation:**
```
Tcell = Tambient + (NOCT - 20) × (GHI / 800)
```

**Temperature Derating:**
```
tempFactor = 1 + tempCoeff × (Tcell - 25)
```

**Capacity Factor Prediction:**
```
CF = (GHI_scaled / GHI_STC) × tempFactor × systemLoss
GHI_scaled = GHI × irradianceScale
```

#### ML Residual Features (8 features)

| Feature | Calculation | Purpose |
|---------|-------------|---------|
| `solarRadiation_norm` | solarRadiation / 1000 | Normalized by STC |
| `cloudCover_norm` | cloudCover / 100 | Normalized percentage |
| `temperature_norm` | temperature / 50 | Normalized temperature |
| `hourSin` | sin(2π × hour / 24) | Cyclical hour |
| `hourCos` | cos(2π × hour / 24) | Cyclical hour |
| `month_norm` | month / 12 | Seasonal indicator |
| `physicsCFac` | Physics baseline | Anchor value |
| `clearSkyIndex` | actual / theoretical clear-sky | Cloud impact ratio |

#### Clear-Sky Index Calculation

Simplified solar geometry for Philippines (~12°N latitude):
```
declination = 23.45 × sin((2π × (dayOfYear - 81)) / 365)
hourAngle = (hour - 12) × 15 degrees
elevationAngle = arcsin(sin(lat) × sin(dec) + cos(lat) × cos(dec) × cos(hourAngle))
clearSkyRadiation = 1000 × sin(elevationAngle)
clearSkyIndex = min(1, actualRadiation / clearSkyRadiation)
```

#### Correction Factors

| Correction | Calculation | Purpose |
|------------|-------------|---------|
| `biasCorrection` | totalActual / totalPredicted | Systematic error fix |
| `hourlyCorrection` | Median(actual/predicted) per hour | Sunrise/sunset asymmetry |

**Bias Correction Range:** Clamped to [0.8, 1.5]
**Hourly Correction Range:** Clamped to [0.5, 1.5]

#### Operating Modes

| Mode | Flag | Behavior |
|------|------|----------|
| Standard | Default | Physics + full ML residual |
| Physics-Only | `--solar-physics-only` | Skip ML, use physics directly |
| Weather-Confidence | `--solar-weather-confidence` | Scale ML by weather confidence |
| Seasonal-Adaptive | `--solar-seasonal` | Auto-switch for dry/wet season |

#### Daylight Hours

Conservative 6am-5pm (hours 6-17) to avoid sunrise/sunset over-prediction where weather API reports low radiation but actual generation is near-zero.

#### Philippines Seasons

| Season | Months | Characteristics |
|--------|--------|-----------------|
| Dry | Nov-Apr | Higher irradiance, clearer skies |
| Wet (Monsoon) | May-Oct | Cloud cover, reduced irradiance |

### 3.4 Profile-Based Models

For generation types without strong weather dependencies:

#### Used For
- Geothermal (~15-35% MAPE)
- Biomass (fuel-dependent)
- Hydro Run-of-River (water flow dependent)
- Hydro Storage (dispatch-dependent)
- Battery (dispatch-dependent)

#### Profile Grouping
- By hour (0-23)
- By day type: Workday (0), Saturday (1), Sunday (2)
- Optional seasonal dimension

#### Statistics Per Profile
| Statistic | Calculation |
|-----------|-------------|
| `min` | 5th percentile |
| `median` | 50th percentile |
| `max` | 95th percentile |
| `mean` | Arithmetic mean |
| `stdDev` | Standard deviation |
| `count` | Sample count |

---

## Part 4: Station Type Detection

### 4.1 Detection Logic

Station types are detected in order of priority:

1. **Explicit Mapping** (highest priority) - Check `STATION_TYPE_MAPPING` dictionary
2. **Suffix Patterns:**
   - `_W` → WIND
   - `_S` → SOLAR
   - `_H` → HYDRO_STORAGE
   - `_BI` → BIOMASS
   - `_B` → BATTERY
   - `_G` or `_GP` → GEOTHERMAL
3. **Known Hydro Names** - BAKUN, AGUS, PULANGI, MAGAT, etc.
4. **Default** → UNKNOWN (skipped in forecasting)

### 4.2 Station Type Enum

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

### 4.3 Example Explicit Mappings

| Station Code | Type | Notes |
|--------------|------|-------|
| 01BURGOS | WIND | No _W suffix |
| 01PAGUDPUD | WIND | No _W suffix |
| 01CLARK | SOLAR | No _S suffix |
| 03BACMANGP | GEOTHERMAL | Bacman |
| 01DUHAT | BIOMASS | No _BI suffix |

---

## Part 5: Auto-Calibration System

### 5.1 Rolling 14-Day Calibration

The system automatically calibrates models using the most recent 14 days of actual data:

```
Training Period: July - October (historical base)
Calibration Period: Last 14 days (recent actuals)
Forecast Period: Future dates
```

### 5.2 Calibration Process

1. **Train base model** on historical data
2. **Calculate bias** from recent 14 days: `bias = totalActual / totalPredicted`
3. **Learn hourly corrections** from recent data
4. **Apply corrections** during forecasting

### 5.3 Calibration Benefits

| Benefit | Description |
|---------|-------------|
| Drift Correction | Adjusts for systematic over/under-prediction |
| Seasonal Adaptation | Captures current seasonal patterns |
| Plant Changes | Adapts to capacity changes or maintenance |
| Weather Model Updates | Compensates for API accuracy changes |

---

## Part 6: Model Performance Summary

### 6.1 Evaluated Performance (December 2025)

| Station Type | Stations | Avg MAPE | Status |
|-------------|----------|----------|--------|
| Solar | 49 | 15.79% | Excellent |
| Geothermal | 5 | 7.97% | Excellent |
| Battery | 9 | 9.44% | Excellent |
| Biomass | 10 | 25.52% | Good |
| Hydro (RoR) | 17 | 29.99% | Moderate |
| Hydro (Storage) | 5 | 39.73% | Moderate |
| Wind | 6 | 50.01% | Acceptable |

### 6.2 Wind Model Evolution

| Model | Avg MAPE | Notes |
|-------|----------|-------|
| Legacy Enhanced-Hybrid | 107.10% | Conflicting gustRatio coefficients |
| 4-Tier MREC Hybrid | 50.01% | Region-specific features |
| **Improvement** | **+57%** | From gustRatio inversion fix |

### 6.3 Wind Model Per-Station Results

| Station | Legacy MAPE | 4-Tier MAPE | Improvement |
|---------|-------------|-------------|-------------|
| 01BURGOS | 95.83% | 33.39% | +62.4% |
| 01LAOAG | 80.18% | 56.51% | +23.7% |
| 01PAGUDPUD | 67.68% | 37.89% | +29.8% |
| 02DOLORES | 173.81% | 80.92% | +92.9% |
| 08BVISTA | 107.15% | 45.61% | +61.5% |
| 08NABAS_W | 117.96% | 45.73% | +72.2% |

---

## Part 7: Technical Implementation

### 7.1 Technology Stack

| Component | Technology | Version |
|-----------|------------|---------|
| Runtime | Node.js | 18+ |
| Language | TypeScript | 5.x |
| ML Framework | ml-regression-multivariate-linear | Latest |
| Database | SQLite (better-sqlite3) | Latest |
| Weather API | Visual Crossing | RESTful |
| Date Handling | Luxon | 3.x |
| Holiday Detection | date-holidays | Latest |

### 7.2 Key Source Files

| File | Purpose |
|------|---------|
| `src/models/capacityFactor/Wind4TierHybridModel.ts` | 4-tier wind + region-specific residual |
| `src/models/capacityFactor/Wind4TierMRECModel.ts` | Physics-based 4-tier MREC |
| `src/models/capacityFactor/SolarHybridModel.ts` | Physics+ML solar model |
| `src/models/capacityFactor/SolarIrradianceModel.ts` | Clear-sky physics model |
| `src/models/capacityFactor/ProfileBasedModel.ts` | Stable generation types |
| `src/models/capacityFactor/ModelRouter.ts` | Model selection router |
| `src/models/hybridModel.ts` | Demand hybrid model |
| `src/features/featureEngineering.ts` | 70-feature extraction |
| `src/services/weatherService.ts` | Visual Crossing API client |
| `src/constants/index.ts` | Feature names, holidays, mappings |
| `src/types/capacityFactor.ts` | Type definitions, station detection |

### 7.3 Database Schema

**Core Tables:**
- `demand_records` - Historical demand data
- `weather_records` - Weather data (historical + forecast)
- `models` - Saved demand forecasting models
- `mrec_factors` - Per-station MREC calibration
- `wind_cfac_history` - Historical capacity factor data

---

## Appendix A: Philippine Grid Regions

| Region Code | Coverage | Representative City |
|-------------|----------|---------------------|
| CLUZ | Central Luzon | Manila |
| SLUZ | Southern Luzon | Batangas |
| CVIS | Central Visayas | Cebu City |
| EVIS | Eastern Visayas | Tacloban |
| WVIS | Western Visayas | Iloilo |
| NMIN | Northern Mindanao | Cagayan de Oro |
| SMIN | Southern Mindanao | Davao City |

---

## Appendix B: Feature Names Constant

Complete ordered list of 70 features for demand forecasting:

```typescript
[
  // Basic temporal (6)
  'hour', 'dayOfWeek', 'isWeekend', 'isHoliday', 'dayOfMonth', 'month',

  // Cyclical encoding (2)
  'hourSin', 'hourCos',

  // Day type one-hot (3)
  'isWorkday', 'isSaturday', 'isSunday',

  // Hour one-hot encoding (24)
  'hour_0', 'hour_1', 'hour_2', 'hour_3', 'hour_4', 'hour_5',
  'hour_6', 'hour_7', 'hour_8', 'hour_9', 'hour_10', 'hour_11',
  'hour_12', 'hour_13', 'hour_14', 'hour_15', 'hour_16', 'hour_17',
  'hour_18', 'hour_19', 'hour_20', 'hour_21', 'hour_22', 'hour_23',

  // Hour-DayType interactions (3)
  'hourWorkday', 'hourSaturday', 'hourSunday',

  // Raw weather (9)
  'temp', 'tempSquared', 'dew', 'precip', 'windgust', 'windspeed',
  'cloudcover', 'solarradiation', 'uvindex',

  // Derived weather (8)
  'relativeHumidity', 'heatIndex', 'CDH', 'effectiveSolar', 'apparentTemp',
  'isRaining', 'tempDewSpread', 'isDaytime',

  // Lag features (5)
  'demandLag1h', 'demandLag24h', 'demandLag168h', 'tempLag1h', 'tempLag24h',

  // Rolling averages (3)
  'demandRolling24h', 'tempRolling24h', 'tempMax24h'
]
```

---

## Appendix C: Formula Reference

### Relative Humidity (Magnus Approximation)
```
RH = 100 × exp((17.625 × dew) / (243.04 + dew)) / exp((17.625 × temp) / (243.04 + temp))
```

### Heat Index (Rothfusz Regression)
```
HI = -8.78469475556 + 1.61139411×T + 2.33854883889×R
     - 0.14611605×T×R - 0.012308094×T² - 0.0164248277778×R²
     + 0.002211732×T²×R + 0.00072546×T×R² - 0.000003582×T²×R²

where T = temperature (°C), R = relative humidity (%)
Only applied when temp ≥ 27°C
```

### Cooling Degree Hours
```
CDH = max(0, temp - 24°C)
```

### Solar Cell Temperature
```
Tcell = Tambient + (NOCT - 20) × (GHI / 800)
where NOCT = 43°C (Nominal Operating Cell Temperature)
```

### MREC Conversion
```
CF = MRec_tier × windSpeed (clamped to [0, 1])
MRec_tier = Average_CF_tier / Average_WindSpeed_tier
```

### Gust Ratio
```
gustRatio = min(windGust / windSpeed100, 3.0)
If windSpeed100 < 0.1, gustRatio = 1.0
```

---

*Document Version: 2.0*
*Last Updated: December 2025*
*Generated from codebase analysis*
