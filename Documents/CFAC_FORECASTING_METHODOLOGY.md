---
Status: Active
Last-Updated: 2026-03-24
Updated-By: Claude Code
---

# Capacity Factor Forecasting Methodology

**Technical Reference Document**

---

## Executive Summary

This document describes Vantage Forecaster's methodology for predicting capacity factors (CFac) of renewable energy power stations in the Philippine grid. The system forecasts hourly capacity factors for:

- **Wind** - Using 4-Tier MREC + ML hybrid models
- **Solar** - Using physics-based irradiance + ML residual correction
- **Hydro** - Using historical profile matching with seasonal adjustment
- **Geothermal** - Using baseload profile with maintenance detection
- **Biomass** - Using seasonal profile patterns
- **Battery** - Using operational profile patterns

**Key Performance:**

| Station Type | Model | Typical MAPE | Notes |
|--------------|-------|--------------|-------|
| Wind | 4-Tier Hybrid | ~73% | Best on held-out test data |
| Solar | Physics+ML Hybrid | ~16% | With per-station calibration |
| Hydro | Profile-based | Variable | Seasonal patterns |
| Geothermal | Baseload | ~5% | Very stable output |

---

## 1. System Overview

### 1.1 What is Capacity Factor?

Capacity factor (CFac) is the ratio of actual generation to maximum possible generation:

```
CFac = Actual_Generation_MWh / (Rated_Capacity_MW × Hours)
```

Values range from 0.0 (no generation) to 1.0 (full capacity).

### 1.2 Data Sources

| Data Type | Source | Frequency |
|-----------|--------|-----------|
| Historical CFac | WESM MRHCFac files | Hourly |
| Weather Data | Visual Crossing API | Hourly |
| Station Metadata | `src/data/stations.json` | Static |
| Holiday Calendar | `date-holidays` package | Dynamic |

### 1.3 Station Classification

Stations are classified by suffix naming convention or explicit mapping:

| Suffix | Type | Example |
|--------|------|---------|
| `_W` | Wind | `08NABAS_W` |
| `_S` | Solar | `01CLARK_S` |
| `_H` | Hydro (Storage) | `01BAKUN_H` |
| `_BI`, `_BG`, `_BL` | Biomass | `01GAMU_BI` |
| `_B` | Battery | `03LUMBAN_B` |
| `_G`, `_GP` | Geothermal | `04TONGONA_GP` |

Non-standard naming (e.g., `01BURGOS`, `01PAGUDPUD`) is handled via explicit mapping in `src/types/capacityFactor.ts`.

---

## 2. Wind Forecasting

### 2.1 Model Selection

The recommended wind model is the **4-Tier MREC + ML Hybrid** (`Wind4TierHybridModel`):

```
Final_CFac = MREC_Base + ML_Residual
```

### 2.2 4-Tier MREC Base Model

The MREC (Must-Run Energy Conversion) system divides wind conditions into four tiers based on wind speed thresholds:

| Tier | Wind Speed Range | Behavior |
|------|-----------------|----------|
| **LOW** | 0 - vLow m/s | Near-zero generation |
| **RAMP** | vLow - vRated m/s | Linear power increase |
| **RATED** | vRated - vHigh m/s | Maximum (plateau) output |
| **HIGH** | > vHigh m/s | Cutout protection |

**Calibration Process:**

1. Collect historical `(windSpeed, actualCFac)` pairs
2. Fit piecewise linear function to data
3. Determine optimal thresholds (vLow, vRated, vHigh)
4. Calculate tier-specific conversion factors (MRecL, MRecR, MRecH)

**Code Reference:** `src/models/capacityFactor/Wind4TierMRECModel.ts`

### 2.3 ML Residual Correction

The ML layer learns systematic deviations from the MREC base:

```typescript
// Feature vector for residual prediction
features = [
  mrec_base,         // 4-Tier MREC prediction as anchor
  tier_RAMP,         // Indicator: in RAMP tier
  tier_RATED,        // Indicator: in RATED tier
  tier_HIGH,         // Indicator: in HIGH tier
  gustRatio_ramp,    // Gust ratio (only in RAMP)
  gustRatio_rated,   // Gust ratio (only in RATED)
  gustRatio_high,    // Gust ratio (only in HIGH)
  temp_deviation,    // Air density proxy
  wind_speed_norm,   // Normalized wind speed
  rated_plateau_flag,// Stabilizer for rated region
  cloud_cover        // Atmospheric conditions
]
```

**Key Insight:** The gust ratio's effect *inverts* between tiers:
- **RAMP tier:** Higher gusts = more energy capture (positive coefficient)
- **RATED tier:** Lower gusts = stable generation (negative/neutral coefficient)

This is why `gustRatio` is split into tier-specific features.

### 2.4 Weather Data for Wind

Wind stations use exact coordinates from `stations.json` for weather fetching:

| Parameter | Source | Notes |
|-----------|--------|-------|
| `windSpeed100` | Visual Crossing 100m | Hub-height data (preferred) |
| `windSpeed` | Visual Crossing 10m | Fallback |
| `windGust` | Visual Crossing | For gust ratio |
| `cloudCover` | Visual Crossing | Atmospheric proxy |
| `temperature` | Visual Crossing | Air density calculation |

**Cache Structure:** `weather_cache/WIND_{stationCode}/YYYY-MM/YYYY-MM-DD.csv`

### 2.5 Wind Model Performance

**Validated on Nov-Dec Test Data (trained on Jul-Oct):**

| Model | Test MAPE | Training MAPE | Notes |
|-------|-----------|---------------|-------|
| **4-Tier Hybrid** | **73.0%** | 130%+ | Best on test |
| Weather-Only Hybrid | 74.3% | 108% | Close second |
| Physics Hybrid | 77.2% | 119% | Doesn't match data |
| MREC-only | 78.2% | 182% | Simple baseline |

**Important:** Training MAPE is misleading for wind. Always validate on held-out test data.

### 2.6 Why Physics Models Underperform

Philippine wind stations operate at **14-22% actual CF** when physics predicts **70-90%**. Causes include:

1. **Curtailment** - Grid can't accept all power
2. **Maintenance outages** - Scheduled/unscheduled downtime
3. **Equipment issues** - Partial operation
4. **Dispatch constraints** - Economic dispatch limitations

Empirical models (4-Tier, Weather-Only) outperform pure physics because they learn these operational realities.

---

## 3. Solar Forecasting

### 3.1 Model Selection

The recommended solar model is the **Physics+ML Hybrid** (`SolarHybridModel`):

```
Final_CFac = Physics_Base + ML_Residual
```

### 3.2 Physics Base Model (Irradiance)

The solar physics model calculates expected output from solar irradiance:

```typescript
// Clear-sky solar position calculation
solarPosition = calculateSolarPosition(datetime, latitude, longitude);

// Panel output estimation
rawCFac = solarRadiation / STANDARD_IRRADIANCE;  // 1000 W/m²

// Temperature derating (panels lose efficiency in heat)
tempDerate = 1 - TEMP_COEFFICIENT * max(0, temperature - 25);

// Final physics estimate
physicsCFac = rawCFac * tempDerate * cloudFactor;
```

**Code Reference:** `src/models/capacityFactor/SolarIrradianceModel.ts`

### 3.3 ML Residual Correction

The ML layer learns site-specific deviations:

```typescript
features = [
  physics_base,        // Physics prediction as anchor
  hour,                // Hour of day (0-23)
  month,               // Month (1-12)
  cloud_cover,         // 0-100%
  uv_index,            // 0-11+ (clear-sky indicator)
  temperature,         // Panel efficiency impact
  humidity,            // Condensation effects
  visibility,          // Haze/aerosol indicator
  precip_prob,         // Rain likelihood
  sunrise_flag,        // Dawn transition
  sunset_flag          // Dusk transition
]
```

### 3.4 Per-Station Solar Calibration

Solar stations have highly variable characteristics that global calibration misses:

- Different panel technologies (mono/poly crystalline, thin-film)
- Different tracking systems (fixed, single-axis, dual-axis)
- Different inverter efficiencies
- Local conditions (shading, dust, humidity)

**Calibration Process:**

1. Calculate recent bias: `bias[station] = mean(predicted - actual)`
2. Apply correction: `corrected = raw - bias`
3. Clamp to valid range: `[0.0, 1.0]`

**Impact Example (Jan 2026):**

| Station | Before MAPE | After MAPE | Improvement |
|---------|-------------|------------|-------------|
| 01SNMANUEL_S | 35.12% | 31.53% | -3.6% |
| 01CURIMAO | 32.65% | 28.18% | -4.5% |
| 01PASUQUIN | 37.53% | 32.37% | -5.2% |
| **Overall Solar** | **32.45%** | **28.99%** | **-10.7%** |

**Code Reference:** `src/models/capacityFactor/BiasCorrector.ts`

### 3.5 Weather Data for Solar

| Parameter | Source | Importance |
|-----------|--------|------------|
| `solarRadiation` | Visual Crossing | Primary driver |
| `cloudCover` | Visual Crossing | High impact |
| `uvIndex` | Visual Crossing | Clear-sky indicator (r=0.78) |
| `temperature` | Visual Crossing | Panel derating |
| `visibility` | Visual Crossing | Haze/aerosol (r=0.31) |

---

## 4. Hydro/Geothermal/Biomass Forecasting

### 4.1 Profile-Based Model

Non-weather-dependent stations use historical profile matching:

```typescript
// Group historical data by dimensions
profiles = groupBy(historicalData, [month, hour, dayType]);

// Calculate percentile statistics
profile[month][hour][dayType] = {
  p5: percentile(values, 5),    // Conservative low
  p50: percentile(values, 50),  // Median (default)
  p95: percentile(values, 95),  // Optimistic high
  mean: average(values),
  stdDev: standardDeviation(values),
  count: values.length
};

// Predict using profile
prediction = profile[month][hour][dayType].p50;
```

### 4.2 Day Types

| Day Type | Description |
|----------|-------------|
| `workday` | Monday-Friday, non-holiday |
| `saturday` | Saturday |
| `sunday` | Sunday |
| `holiday` | Philippines public holidays |

### 4.3 Hierarchical Smoothing

When per-station data is sparse, blend with type-level profile:

```typescript
alpha = min(1.0, sampleCount / CONFIDENCE_THRESHOLD);
effectiveProfile = alpha * stationProfile + (1 - alpha) * typeProfile;
```

Where `CONFIDENCE_THRESHOLD = 50` samples.

### 4.4 Station Type Characteristics

| Type | Typical CFac | Variability | Drivers |
|------|--------------|-------------|---------|
| Geothermal | 85-95% | Very low | Maintenance schedules |
| Hydro RoR | 30-60% | Moderate | Rainfall, season |
| Hydro Storage | 20-70% | High | Dispatch decisions |
| Biomass | 40-70% | Moderate | Fuel supply, maintenance |
| Battery | Variable | High | Dispatch/market signals |

**Code Reference:** `src/models/capacityFactor/ProfileBasedModel.ts`

---

## 5. Auto-Calibration System

### 5.1 Overview

Auto-calibration runs by default during `cfac forecast2` to improve predictions using recent actuals.

### 5.2 Calibration Types

| Type | Applied To | Method |
|------|-----------|--------|
| Global Bias | Wind, Solar | Mean (predicted - actual) |
| Per-Hour Solar | Solar | Scale factor per hour (6AM-6PM) |
| Per-Station Solar | Solar | Individual station bias |
| Per-Station Hydro/Biomass | Non-weather | Seasonal scale factors |

### 5.3 Wind Calibration Limitation

**Per-station calibration is DISABLED for wind** because:
- Wind patterns are too variable between seasons
- Calibration period patterns often don't generalize
- Global bias correction only is more robust

### 5.4 Calibration Period

Default: **Last 14 days** of training data.

Override with `--no-auto-calibrate` to disable.

### 5.5 Calibration Service

Calibration state is persisted for reuse:

```
models/cfac-calibration/
├── calibration_{id}.json     # Full calibration state
└── active.json               # Reference to active calibration
```

**Code Reference:** `src/services/cfacCalibrationService.ts`

---

## 6. Weather Data Integration

### 6.1 Visual Crossing API

All weather data comes from Visual Crossing API with automatic caching.

**Request Types:**

| Type | Use Case | Features |
|------|----------|----------|
| Standard | Solar, profile-based | Basic weather vars |
| 100m Hub Height | Wind stations | `windSpeed100`, `windDirection100` |
| Premium | Solar (if available) | `uvIndex`, `visibility` |

### 6.2 Station-Specific Weather

Wind and solar stations use exact coordinates:

```typescript
// Wind: uses station coordinates with 100m data
clusterID = `WIND_${stationCode}`;
weatherData = fetchWeather(station.latitude, station.longitude, { hubHeight: 100 });

// Solar: uses station coordinates with UV/visibility
clusterID = `SOLAR_${stationCode}`;
weatherData = fetchWeather(station.latitude, station.longitude, { includeUV: true });
```

### 6.3 Weather Cache Structure

```
weather_cache/
├── WIND_01BURGOS/
│   └── 2026-01/
│       ├── 2026-01-01.csv
│       └── 2026-01-02.csv
├── SOLAR_01CLARK_S/
│   └── 2026-01/
│       └── ...
└── ILOCOS_NORTE_WIND/  # Cluster-based (legacy)
    └── ...
```

### 6.4 Stale Weather Cache Issue

**Problem:** When forecasting future dates, Visual Crossing may return incomplete data.

**Symptoms:**
- Constant/flat predictions (e.g., 42-43% every day)
- Small cache files (~1.7KB vs ~3KB for historical)
- Empty values in hourly data rows

**Solution:** After forecast dates pass, refresh cache:

```bash
# Delete incomplete cache
rm -rf weather_cache/WIND_*/2026-01/2026-01-1*.csv

# Re-run forecast with fresh data
node dist/index.js cfac forecast2 -t "Data Samples/Capacity Factor" -s 2026-01-01 -e 2026-01-14 -o output/cfac_refreshed.csv
```

---

## 7. Station Configuration

### 7.1 stations.json Structure

```json
{
  "01BURGOS": {
    "name": "Burgos Wind Farm",
    "type": "wind",
    "operator": "EDC Burgos Wind Power Corporation",
    "capacity_mw": 150,
    "location": {
      "municipality": "Burgos",
      "province": "Ilocos Norte",
      "region": "Region I",
      "latitude": 18.5340,
      "longitude": 120.6479
    },
    "grid": "CLUZ",
    "commissioned": 2014,
    "turbines": 50,
    "turbine_model": "Vestas V90 3MW"
  }
}
```

### 7.2 Weather Cluster Groups

Nearby stations share weather data to reduce API calls:

```json
{
  "ILOCOS_NORTE_WIND": {
    "description": "Wind farms in Ilocos Norte",
    "stations": ["01BURGOS", "01PAGUDPUD", "01LAOAG"],
    "referenceLocation": {
      "name": "Burgos, Ilocos Norte",
      "latitude": 18.5340,
      "longitude": 120.6479
    }
  }
}
```

### 7.3 Grid Regions

| Grid Code | Region | Coverage |
|-----------|--------|----------|
| `CLUZ` | Luzon | Northern, Central, Southern Luzon |
| `CVIS` | Visayas | Cebu, Negros, Panay, Leyte, Bohol |
| `CMIN` | Mindanao | All Mindanao regions |

---

## 8. Model Architecture

### 8.1 Model Hierarchy

```
src/models/capacityFactor/
├── index.ts                      # Model exports
│
├── Wind Models
│   ├── WindMRECModel.ts          # Three-tier piecewise (iPool port)
│   ├── Wind4TierMRECModel.ts     # Four-tier MREC base
│   ├── Wind4TierHybridModel.ts   # MREC + region-specific ML
│   ├── WindEnhancedHybridModel.ts# MREC + physics boost + ML
│   └── WindWeatherHybridModel.ts # Weather-only approach
│
├── Solar Models
│   ├── SolarIrradianceModel.ts   # Physics-based
│   ├── SolarHybridModel.ts       # Physics + ML residual
│   ├── SolarMRECHybridModel.ts   # MREC-style for solar
│   └── SolarPremiumHybridModel.ts# With premium weather features
│
├── Profile Models
│   └── ProfileBasedModel.ts      # Hydro, geothermal, biomass
│
├── Support Classes
│   ├── BiasCorrector.ts          # Per-station bias correction
│   └── CFacXGBoostRegressor.ts   # XGBoost ML layer
│
└── Legacy Models
    ├── CFacHybridModel.ts        # General hybrid
    └── CFacRegressionModel.ts    # Simple regression
```

### 8.2 Model Selection Logic

```typescript
function selectModel(stationType: StationType): CFacModel {
  switch (stationType) {
    case StationType.WIND:
      return new Wind4TierHybridModel(stationCode);

    case StationType.SOLAR:
      return new SolarHybridModel(stationCode, { useXGBoost: true });

    case StationType.HYDRO_RUN_OF_RIVER:
    case StationType.HYDRO_STORAGE:
    case StationType.GEOTHERMAL:
    case StationType.BIOMASS:
    case StationType.BATTERY:
      return new ProfileBasedModel(stationCode, stationType);

    default:
      return new ProfileBasedModel(stationCode, StationType.UNKNOWN);
  }
}
```

---

## 9. Training and Inference Flow

### 9.1 Training Flow (Manual Tab)

```
1. Load historical CFac data (MRHCFac_*.csv)
2. Load station metadata (stations.json)
3. For each station:
   a. Fetch historical weather data
   b. Build training samples (datetime, CFac, weather features)
   c. Train appropriate model:
      - Wind: Calibrate MREC thresholds, train ML residual
      - Solar: Train irradiance physics, train ML residual
      - Others: Build statistical profiles
   d. Calculate calibration factors
   e. Evaluate on holdout period
4. Save training instance (.vfm file)
5. Report metrics (MAPE per station, overall)
```

### 9.2 Inference Flow (Scheduler)

```
1. Load saved training instance (.vfm)
2. Load frozen model weights (NO retraining)
3. Load saved calibration factors
4. Fetch NEW weather data for forecast period
5. For each station, each hour:
   a. Apply model to weather data
   b. Apply calibration correction
   c. Clamp to [0.0, 1.0]
6. Generate output CSV
7. Archive and push to gateway
```

### 9.3 Key Files

| Component | File |
|-----------|------|
| Training logic | `src/services/forecastGenerator.ts` |
| Model store | `src/services/modelStore.ts` |
| Calibration | `src/services/cfacCalibrationService.ts` |
| Weather fetch | `src/services/weatherService.ts` |
| CLI handler | `src/index.ts` (cfac commands) |

---

## 10. Output Format

### 10.1 CSV Structure

```csv
DateTimeEnding,01BURGOS,01PAGUDPUD,01LAOAG,08NABAS_W,...
1/1/2026 01:00,0.23,0.19,0.21,0.15,...
1/1/2026 02:00,0.25,0.21,0.23,0.17,...
```

- **DateTimeEnding:** Hour-ending timestamp (M/D/YYYY HH:MM)
- **Columns:** One per station code
- **Values:** Capacity factors (0.0 - 1.0)

### 10.2 Evaluation Metrics

| Metric | Formula | Notes |
|--------|---------|-------|
| MAPE | `mean(abs(pred - actual) / actual) × 100` | Percentage error |
| MAE | `mean(abs(pred - actual))` | Absolute CFac error |
| RMSE | `sqrt(mean((pred - actual)²))` | Root mean squared |
| R² | `1 - SS_res / SS_tot` | Variance explained |

---

## 11. Configuration Options

### 11.1 CLI Flags

| Flag | Description | Default |
|------|-------------|---------|
| `--use-xgboost` | Use XGBoost for ML layer | Linear |
| `--asymmetric-loss` | Penalize under-predictions 2x | Off |
| `--bias-correction` | Apply per-station bias | Off |
| `--no-auto-calibrate` | Skip auto-calibration | On |
| `--training-end <date>` | Limit training data | None |

### 11.2 Recommended Settings by Type

| Type | Recommended Flags | Notes |
|------|------------------|-------|
| Solar | `--use-xgboost --asymmetric-loss` | 43% bias reduction |
| Wind | (default) | Per-station disabled |
| Mixed | (default) | Balanced approach |

---

## 12. Known Limitations

### 12.1 Wind Accuracy

Wind forecasting is inherently difficult due to:
- Chaotic atmospheric dynamics
- Turbine curtailment (grid constraints)
- Maintenance outages
- Local terrain effects

**Mitigation:** Use empirical models that learn operational patterns.

### 12.2 Solar Station Variability

Different stations have vastly different characteristics:
- Panel technology, age, maintenance
- Tracking systems
- Local shading, dust

**Mitigation:** Per-station calibration (enabled by default).

### 12.3 Weather Data Limitations

- Future dates may have incomplete/empty data
- 100m hub-height data not always available
- API rate limits apply

**Mitigation:** Cache validation, fallback to 10m data.

### 12.4 Profile Sparsity

Rare day types (holidays) may have sparse data:
- Only ~45 holidays over 24 months
- Some are region-specific

**Mitigation:** Hierarchical smoothing with type-level fallback.

---

## 13. References

### 13.1 Code References

| Component | Location |
|-----------|----------|
| Wind 4-Tier Hybrid | `src/models/capacityFactor/Wind4TierHybridModel.ts` |
| Solar Hybrid | `src/models/capacityFactor/SolarHybridModel.ts` |
| Profile Model | `src/models/capacityFactor/ProfileBasedModel.ts` |
| Bias Corrector | `src/models/capacityFactor/BiasCorrector.ts` |
| Station Types | `src/types/capacityFactor.ts` |
| Station Metadata | `src/data/stations.json` |
| Calibration Service | `src/services/cfacCalibrationService.ts` |

### 13.2 External References

- Visual Crossing Weather API: https://www.visualcrossing.com/weather-api
- WESM Market Data: https://www.wesm.ph
- iPool MREC methodology (proprietary, ported implementation)

---

## Document History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | 2026-03-24 | Claude Code | Initial methodology document |
