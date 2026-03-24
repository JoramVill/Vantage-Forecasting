---
Status: Draft
Created: 2026-03-24
Updated-By: Claude
---

# Capacity Factor Forecast V2 — Architecture

**Vantage Forecaster — CFAC Methodology Refresh**

Version: 2.0 Draft
Date: March 24, 2026
Classification: Technical Architecture Document

---

## 1. Design Principles

### 1.1 Aligned Lifecycle with Demand

CFAC V2 uses the identical **Train → Calibrate → Forecast** lifecycle as Demand V2. Same operational pattern, same CLI structure, same separation of concerns.

| Operation     | Frequency         | Inputs                                    | Outputs                 | Compute Cost |
|---------------|-------------------|-------------------------------------------|-------------------------|--------------|
| **Train**     | Monthly           | Months of CFac history + weather history   | `cfac_model.vfm`        | Heavy        |
| **Calibrate** | Daily/weekly      | `cfac_model.vfm` + recent actuals (14d)   | `cfac_calibration.json` | Light        |
| **Forecast**  | On demand         | `cfac_model.vfm` + `cfac_calibration.json` + weather forecast | Forecast CSV | Light |

Training learns structural relationships (wind speed to power curves, solar physics parameters, seasonal profiles). Calibration corrects recent drift. Forecasting is stateless.

### 1.2 One Model Per Station Type

V1 accumulated 5 wind models and 4 solar models. V2 consolidates to one recommended model per type. Legacy models are archived, not deleted.

| Station Type | V2 Model | V1 Equivalent | Change |
|--------------|----------|---------------|--------|
| Wind | `WindHybridModel` | `Wind4TierHybridModel` | Renamed, minor improvements |
| Solar | `SolarHybridModel` | `SolarHybridModel` | Hourly calibration, asymmetric loss default |
| Hydro | `ProfileModel` | `ProfileBasedModel` | Unified naming |
| Geothermal | `ProfileModel` | `ProfileBasedModel` | Unified naming |
| Biomass | `ProfileModel` | `ProfileBasedModel` | Unified naming |
| Battery | `ProfileModel` | `ProfileBasedModel` | Unified naming |

### 1.3 Calibration Is Hourly, Not Scalar

The single most impactful change for solar accuracy. Instead of one bias number per station, calibration learns per-hour correction factors. This directly addresses the midday under-prediction problem without touching the underlying physics model.

### 1.4 Operator Controllability

Same philosophy as Demand V2 — every pipeline stage exposes tuning knobs with sensible defaults. An operator can adjust solar asymmetry, wind calibration windows, or profile smoothing thresholds without modifying code.

---

## 2. Data Contracts

### 2.1 Input: Historical Capacity Factor Data

Hourly capacity factors per station, hour-ending convention.

```
File: MRHCFac_YYYY_MMM.csv

DateTimeEnding,  01BURGOS, 01PAGUDPUD, 01CLARK_S, ..., 04TONGONA_GP
12/1/2025 01:00, 0.23,     0.19,       0.00,      ..., 0.92
12/1/2025 02:00, 0.25,     0.21,       0.00,      ..., 0.91
...
12/1/2025 13:00, 0.08,     0.05,       0.78,      ..., 0.93
```

- One row per hour (24 rows per day)
- Columns: `DateTimeEnding` + one column per station
- Values: capacity factor 0.0 – 1.0
- Used during **Train** and **Calibrate** only — never during Forecast

### 2.2 Input: Weather Data

Same format as Demand weather data, fetched per-station using exact coordinates.

```
File: YYYY-MM-DD.csv (per station or weather cluster)

name,      latitude, longitude, datetime,            temp, dew, windspeed, windgust, cloudcover, solarradiation, uvindex, ...
```

Wind stations additionally fetch 100m hub-height wind data when available.

### 2.3 Input: Station Metadata

```
File: stations.json

{
  "01BURGOS": {
    "name": "Burgos Wind Farm",
    "type": "wind",
    "capacity_mw": 150,
    "location": { "latitude": 18.5340, "longitude": 120.6479 },
    "grid": "CLUZ",
    "turbines": 50,
    "turbine_model": "Vestas V90 3MW"
  },
  "01CLARK_S": {
    "name": "Clark Solar",
    "type": "solar",
    "capacity_mw": 22,
    "location": { "latitude": 15.1860, "longitude": 120.5460 },
    "grid": "CLUZ"
  },
  ...
}
```

Station type is determined from the suffix convention (`_W`, `_S`, `_H`, `_G`, `_GP`, `_BI`, `_BG`, `_BL`, `_B`) or from explicit mapping for non-standard names (e.g., `01BURGOS`, `01PAGUDPUD`).

### 2.4 Output: Forecast

```
DateTimeEnding,  01BURGOS, 01PAGUDPUD, 01CLARK_S, ..., 04TONGONA_GP
3/25/2026 01:00, 0.21,     0.18,       0.00,      ..., 0.91
3/25/2026 02:00, 0.23,     0.20,       0.00,      ..., 0.92
...
3/25/2026 13:00, 0.12,     0.07,       0.82,      ..., 0.93
```

Same format as input. Capacity factors clamped to `[0.0, 1.0]`.

### 2.5 Model Artifact: `cfac_model.vfm`

Serialized binary (MessagePack) produced by Train.

Contains:
- **Wind**: Per-station MREC thresholds (vLow, vRated, vHigh), tier conversion factors, ML residual weights
- **Solar**: Physics model parameters, ML residual weights per station
- **Profile**: Statistical profiles per station (month × hour × dayType percentiles)
- Station metadata snapshot
- Training date range and configuration

Does **not** contain calibration factors.

### 2.6 Calibration Snapshot: `cfac_calibration.json`

Lightweight JSON produced by Calibrate.

```json
{
  "calibrationDate": "2026-03-24",
  "modelVersion": "cfac_model_20260310.vfm",
  "calibrationDays": 14,
  "wind": {
    "01BURGOS": {
      "globalBias": -0.02,
      "hourlyScale": [1.05, 1.03, 1.02, "... 24 values"]
    },
    "01PAGUDPUD": {
      "globalBias": -0.01,
      "hourlyScale": [1.02, 1.01, 1.00, "... 24 values"]
    }
  },
  "solar": {
    "01CLARK_S": {
      "globalBias": -0.03,
      "hourlyScale": [0, 0, 0, 0, 0, 0, 0.92, 0.95, 1.03, 1.08, 1.12, 1.14, 1.13, 1.10, 1.06, 0.98, 0.94, 0.91, 0, 0, 0, 0, 0, 0]
    }
  },
  "profile": {
    "04TONGONA_GP": {
      "recentMedian": 0.91,
      "seasonalScale": 1.02
    },
    "01BAKUN_H": {
      "recentMedian": 0.45,
      "seasonalScale": 0.88
    }
  },
  "metrics": {
    "wind": { "01BURGOS": { "mape": 68.2 }, "01PAGUDPUD": { "mape": 72.1 } },
    "solar": { "01CLARK_S": { "mape": 14.3 } },
    "profile": { "04TONGONA_GP": { "mape": 4.8 } }
  }
}
```

---

## 3. Operational Lifecycle

### 3.1 Overview

```
┌────────────────────────────────────────────────────────────────────────────────┐
│                       CFAC OPERATIONAL LIFECYCLE                                │
│                  (mirrors Demand V2 lifecycle exactly)                           │
├────────────────────────────────────────────────────────────────────────────────┤
│                                                                                │
│   ┌─────────┐         ┌─────────────┐         ┌──────────┐                    │
│   │  TRAIN  │────────►│  CALIBRATE  │────────►│ FORECAST │                    │
│   └─────────┘         └─────────────┘         └──────────┘                    │
│   Monthly             Daily/weekly            On demand                       │
│   (or on trigger)     (when actuals arrive)   (as many times as needed)       │
│                                                                                │
│   Reads:              Reads:                  Reads:                           │
│   - CFac history      - cfac_model.vfm        - cfac_model.vfm                │
│   - Weather history   - Recent CFac           - cfac_calibration.json          │
│   - stations.json       actuals (14 days)     - Weather forecast              │
│                                                                                │
│   Produces:           Produces:               Produces:                        │
│   - cfac_model.vfm    - cfac_calibration.json - Forecast CSV                  │
│                                                                                │
│   Duration: Minutes   Duration: Seconds       Duration: Seconds               │
│                                                                                │
└────────────────────────────────────────────────────────────────────────────────┘
```

### 3.2 Train Operation

**When**: Monthly, or when new stations are added, or triggered by calibration drift.

CFAC trains less frequently than Demand because the underlying physical relationships (wind-to-power curves, solar irradiance physics) are more stable than demand patterns. Station characteristics change slowly (panel degradation, turbine aging).

**What it does**:
1. Loads historical CFac data (default 120 days)
2. Loads station metadata
3. Fetches/loads corresponding weather data per station
4. For each station, by type:
   - **Wind**: Calibrate MREC 4-tier thresholds, train ML residual model
   - **Solar**: Fit physics parameters, train ML residual model
   - **Profile stations**: Build month × hour × dayType statistical profiles
5. Serializes to `cfac_model.vfm`

**CLI**:
```bash
node dist/index.js cfac train \
  -t "Data Samples/Capacity Factor" \
  -w "Data Samples/Weather" \
  --days 120 \
  -o models/cfac_model_20260324.vfm
```

### 3.3 Calibrate Operation

**When**: Daily or weekly, whenever new actuals arrive.

**What it does**:
1. Loads `cfac_model.vfm` (read-only)
2. Reads most recent N days of actual CFac data (default 14)
3. Generates predictions for those days using the model
4. Compares predictions to actuals, per station:
   - **Wind**: Computes global bias + hourly scale factors
   - **Solar**: Computes global bias + hourly scale factors (the key improvement)
   - **Profile**: Computes recent median and seasonal scale factor
5. Computes diagnostic metrics per station
6. Writes `cfac_calibration.json`

**What it does NOT do**: modify `cfac_model.vfm`.

**CLI**:
```bash
node dist/index.js cfac calibrate \
  -m models/cfac_model_20260324.vfm \
  -t "Data Samples/Capacity Factor" \
  --days 14 \
  -o models/cfac_calibration.json
```

### 3.4 Forecast Operation

**When**: On demand. Stateless and reproducible.

**What it does**:
1. Loads `cfac_model.vfm`
2. Loads `cfac_calibration.json`
3. Fetches weather forecast for the target period (per station coordinates)
4. For each station, each hour: applies model → applies calibration → clamps to [0.0, 1.0]
5. Writes forecast CSV

**What it does NOT do**: any learning or data access to CFac actuals.

**CLI**:
```bash
node dist/index.js cfac forecast \
  -m models/cfac_model_20260324.vfm \
  -c models/cfac_calibration.json \
  -s 2026-03-25 \
  -e 2026-03-31 \
  -o output/cfac_forecast.csv
```

### 3.5 Retrain Triggers

| Condition | Threshold | Meaning |
|-----------|-----------|---------|
| Solar hourly scale drift | Any hour's scale factor > 1.25 or < 0.75 for 3+ cycles | Physics model drifting from station reality |
| Wind global bias drift | \|globalBias\| > 0.10 for 3+ cycles | MREC thresholds need recalibration |
| Profile seasonal drift | \|seasonalScale - 1.0\| > 0.15 for 3+ cycles | Profile is stale for current season |
| New station added | Station in actuals not in model | Model doesn't know this station |
| Station MAPE spike | > 2× training validation MAPE for 3+ cycles | Something has changed |

### 3.6 Why CFAC Trains Monthly vs Demand Fortnightly

CFAC's underlying models learn physical relationships and operational characteristics that change slowly:

- Wind turbine power curves don't shift week-to-week
- Solar panel physics degrade over years, not weeks
- Hydro/geothermal profiles shift seasonally

Calibration handles the short-term drift (recent weather biases, seasonal transitions, maintenance events). Monthly retraining is sufficient to capture structural changes like new curtailment patterns, grid upgrades, or station additions.

---

## 4. Wind Model

### 4.1 Architecture: 4-Tier MREC + ML Hybrid

Retained from V1 — this is the best-performing wind model and doesn't need rearchitecting.

```
Wind Speed (100m or 10m)
    │
    ▼
┌─────────────────────┐
│  4-Tier MREC Base   │  Piecewise linear wind-to-power conversion
│                     │  Thresholds: vLow, vRated, vHigh
│                     │  Per-station calibrated from training data
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│  ML Residual Layer  │  Learns systematic deviations from MREC
│                     │  Features: tier indicators, gust ratios,
│                     │  temperature, cloud cover
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│  Calibration        │  Global bias + hourly scale (from calibration.json)
│  (applied at        │
│   inference only)   │
└─────────┬───────────┘
          │
          ▼
    Clamped CFac [0.0, 1.0]
```

### 4.2 4-Tier MREC Base

| Tier | Wind Speed Range | Behavior | Conversion |
|------|------------------|----------|------------|
| **LOW** | 0 – vLow | Near-zero generation | CFac ≈ 0 |
| **RAMP** | vLow – vRated | Linear power increase | CFac = MRecL × (ws - vLow) / (vRated - vLow) |
| **RATED** | vRated – vHigh | Maximum output plateau | CFac = MRecR |
| **HIGH** | > vHigh | Cutout protection | CFac = MRecH (typically 0 or low) |

Thresholds and conversion factors are calibrated per-station from historical wind speed vs CFac scatter plots during training.

### 4.3 ML Residual Features

| Feature | Description | Key Insight |
|---------|-------------|-------------|
| `mrec_base` | 4-Tier prediction as anchor | Keeps ML correction centered |
| `tier_RAMP/RATED/HIGH` | Tier indicator flags | Different physics per regime |
| `gustRatio_ramp` | Gust ratio, RAMP tier only | Higher gusts = more energy |
| `gustRatio_rated` | Gust ratio, RATED tier only | Effect inverts: gusts = instability |
| `gustRatio_high` | Gust ratio, HIGH tier only | Near-cutout turbulence |
| `temp_deviation` | Temperature relative to average | Air density proxy |
| `wind_speed_norm` | Normalized wind speed | Continuous position within tier |
| `rated_plateau_flag` | Stabilizer for rated region | Prevents over-correction at plateau |
| `cloud_cover` | Cloud cover percentage | Atmospheric stability proxy |

### 4.4 V2 Change: Enable Per-Station Calibration

V1 disabled per-station wind calibration because seasonal patterns made static biases unreliable. V2 re-enables it because **calibration now refreshes daily/weekly** with a rolling 14-day window. This tracks seasonal shifts naturally.

The calibration stores both global bias and hourly scale factors:

```json
{
  "01BURGOS": {
    "globalBias": -0.02,
    "hourlyScale": [1.05, 1.03, 1.02, 0.99, 0.97, 0.98, 1.01, ...]
  }
}
```

Hourly wind calibration matters because many wind farms show diurnal patterns — stronger generation overnight when thermal winds are more laminar, lower generation during afternoon convective turbulence. A global bias misses this pattern.

**Operator control**: if per-station wind calibration proves noisy for specific stations, it can be disabled per-station in configuration, falling back to global bias only.

### 4.5 Wind Performance Expectations

| Metric | V1 | V2 Expected | Driver |
|--------|-----|-------------|--------|
| Test MAPE | ~73% | ~65-70% | Per-station hourly calibration captures diurnal patterns |
| Gross error events (>50% off) | Frequent | Fewer | Rolling calibration catches seasonal shifts |

Wind MAPE will always be high due to the inherent unpredictability and curtailment factors. The goal is incremental improvement, not a breakthrough.

---

## 5. Solar Model

### 5.1 Architecture: Physics + ML Hybrid (with Hourly Calibration)

The core model is retained but calibration is overhauled.

```
Solar Irradiance + Station Coords
    │
    ▼
┌────────────────────────┐
│  Physics Base Model    │  Solar position → clear-sky irradiance
│                        │  Temperature derating
│                        │  Cloud factor
└──────────┬─────────────┘
           │
           ▼
┌────────────────────────┐
│  ML Residual Layer     │  Learns site-specific deviations
│                        │  Features: physics_base, hour, month,
│                        │  cloud, UV, temp, humidity, visibility
│                        │  Asymmetric loss (default for solar)
└──────────┬─────────────┘
           │
           ▼
┌────────────────────────┐
│  Hourly Calibration    │  Per-station, per-hour correction
│  (from calibration.json)│  Directly fixes midday under-prediction
└──────────┬─────────────┘
           │
           ▼
     Clamped CFac [0.0, 1.0]
```

### 5.2 Physics Base Model

Retained from V1:

```
solarPosition = calculateSolarPosition(datetime, latitude, longitude)
rawCFac = solarRadiation / 1000    (standard irradiance W/m²)
tempDerate = 1 - tempCoefficient × max(0, temperature - 25)
physicsCFac = rawCFac × tempDerate × cloudFactor
```

### 5.3 ML Residual Features

| Feature | Description | Importance |
|---------|-------------|------------|
| `physics_base` | Physics model output | Primary anchor |
| `hour` | Hour of day (0-23) | Captures systematic hourly bias |
| `month` | Month (1-12) | Seasonal angle-of-incidence variation |
| `cloud_cover` | Cloud cover (0-100%) | High impact on actual output |
| `uv_index` | UV index (0-11+) | Clear-sky indicator (r=0.78 with CFac) |
| `temperature` | Air temperature | Panel efficiency derating |
| `humidity` | Relative humidity | Condensation and diffuse radiation |
| `visibility` | Visibility (km) | Haze/aerosol proxy (r=0.31) |
| `precip_prob` | Precipitation probability | Rain/cloud likelihood |
| `sunrise_flag` | Dawn transition period | Physics model least accurate here |
| `sunset_flag` | Dusk transition period | Physics model least accurate here |

### 5.4 V2 Change: Asymmetric Loss as Default

V1 had `--asymmetric-loss` as an opt-in flag. V2 makes it the default for solar because under-prediction is systematically worse for grid planning — you're counting on generation that doesn't materialize.

**Quantile loss** with configurable α:

```
Loss = α × |error|       if actual > predicted  (under-prediction)
Loss = (1-α) × |error|   if actual ≤ predicted  (over-prediction)
```

Default `solarAlpha = 0.65` — penalizes under-prediction ~1.9× more than over-prediction. This is milder than Demand's 4:1 ratio because solar over-prediction also has operational cost (committed generation that doesn't appear forces thermal backup).

**Operator control**: `solarAlpha` is configurable. At 0.5 the loss is symmetric. At 0.8 it's strongly anti-under-prediction.

### 5.5 V2 Change: Hourly Calibration (Key Solar Improvement)

**The problem**: V1's per-station calibration computes a single bias:
```
bias = mean(predicted - actual) across all generating hours
corrected = raw - bias
```

A station under-predicted by 15% at noon and over-predicted by 5% at 4 PM gets a single ~5% correction. The noon under-prediction barely improves. The 4 PM over-prediction gets worse.

**The fix**: learn a scale factor per station per hour:

```
For each station, for each hour h (during generating hours):
  hourlyScale[h] = mean(actual[h] / predicted[h])
                   across calibration days where predicted[h] > 0.01
```

Non-generating hours (night) get a scale factor of 0 — effectively clamping predictions to zero when there should be no output.

**Why this fixes midday under-prediction specifically**:

The physics model systematically underestimates midday output in tropical climates because:

1. Visual Crossing's `solarRadiation` is conservative in high-humidity tropical conditions — actual panels capture diffuse radiation the model underestimates
2. The temperature derating formula over-penalizes for tropical-rated panel installations
3. Hourly cloud cover averages miss the convective partial-sun bursts that boost energy capture

Hourly calibration learns that noon in the Philippines typically has an `hourlyScale` of 1.10-1.15 — correcting for these systematic biases without touching the underlying physics.

**Example calibration for a typical Luzon solar station**:

```
Hour:    6     7     8     9    10    11    12    13    14    15    16    17    18
Scale:  0.92  0.95  1.03  1.08  1.12  1.14  1.13  1.10  1.06  0.98  0.94  0.91  0.00
        ^^^^                     ^^^^^^^^^^^^^^^^^^^^^^^^                     ^^^^
        dawn                     midday boost (the fix)                      dusk
        over-predicts            under-predicts → corrected                  over-predicts
```

Dawn and dusk hours get scale factors below 1.0 because the physics model tends to over-predict during transition periods where panel output responds non-linearly to low sun angles.

**Clamping**: hourly scale factors are clamped to `solarScaleClamp` (default `[0.50, 1.50]`). If a factor hits the clamp boundary for multiple cycles, it triggers a retrain alert — the physics model is too far off for calibration to compensate.

### 5.6 Solar Performance Expectations

| Metric | V1 | V2 Expected | Driver |
|--------|-----|-------------|--------|
| Overall MAPE | ~16% (with bias corr.) | ~10-12% | Hourly calibration + asymmetric loss |
| Midday MAPE (10-14) | ~20-25% | ~8-12% | Largest improvement — directly targeted |
| Dawn/dusk MAPE | ~30-40% | ~20-25% | Hourly calibration corrects transition bias |
| Under-prediction rate | ~60% of hours | ~45-50% | Asymmetric loss shifts distribution |

---

## 6. Profile Model (Hydro, Geothermal, Biomass, Battery)

### 6.1 Architecture

These station types are dispatch-driven, not weather-driven. Their output depends on grid operator decisions, fuel supply, maintenance schedules, and reservoir levels — none of which are predictable from weather data. A statistical profile model is the right approach.

```
Station Type + Calendar (month, hour, dayType)
    │
    ▼
┌────────────────────────┐
│  Profile Lookup        │  month × hour × dayType → percentile stats
│                        │  p5, p50, p95, mean, stdDev, count
└──────────┬─────────────┘
           │
           ▼
┌────────────────────────┐
│  Hierarchical Smoothing│  Blend station profile with type-level
│                        │  profile when samples are sparse
└──────────┬─────────────┘
           │
           ▼
┌────────────────────────┐
│  Calibration           │  Recent median + seasonal scale
│  (from calibration.json)│ (from calibration.json)
└──────────┬─────────────┘
           │
           ▼
     Clamped CFac [0.0, 1.0]
```

### 6.2 Profile Key Structure

Profiles indexed by `{station}_{month}_{hour}_{dayType}`:

```typescript
interface ProfileEntry {
  p5: number;      // Conservative low (5th percentile)
  p50: number;     // Median (default prediction)
  p95: number;     // Optimistic high (95th percentile)
  mean: number;
  stdDev: number;
  count: number;   // Sample count for this bucket
}
```

The default prediction uses the **p50 (median)** value.

### 6.3 Hierarchical Smoothing

Same pattern as Demand V2 and V1 CFAC:

```
α = min(1.0, sampleCount / confidenceThreshold)
effectiveProfile = α × stationProfile + (1 - α) × typeProfile
```

Where `typeProfile` is the aggregated profile across all stations of the same type. Default `confidenceThreshold = 50`.

### 6.4 Station Type Characteristics

| Type | Typical CFac | Variability | Profile Reliability | Notes |
|------|--------------|-------------|---------------------|-------|
| Geothermal | 85-95% | Very low | High | Baseload, only deviates for maintenance |
| Hydro (Run of River) | 30-60% | Moderate | Medium | Seasonal rainfall patterns |
| Hydro (Storage) | 20-70% | High | Low-Medium | Dispatch-driven, hard to predict |
| Biomass | 40-70% | Moderate | Medium | Fuel supply and maintenance driven |
| Battery | Variable | Very High | Low | Market/dispatch driven, profiles are weak |

### 6.5 Calibration for Profile Stations

Simpler than wind/solar — these stations don't have hourly shape issues, they have level issues (running hotter or cooler than the profile median for recent days).

```json
{
  "04TONGONA_GP": {
    "recentMedian": 0.91,
    "seasonalScale": 1.02
  }
}
```

- `recentMedian`: median CFac over the calibration window (recent 14 days)
- `seasonalScale`: ratio of recent median to profile median for the current month

Applied at inference:
```
calibratedCFac = profilePrediction × seasonalScale
```

Clamped to `[0.0, 1.0]`.

### 6.6 Geothermal Special Case: Maintenance Detection

Geothermal stations are extremely stable (85-95% CFac) except during maintenance outages where output drops to 0-20%. The profile model handles this through the p5/p95 range, but calibration can be more targeted.

If the recent median drops below 50% of the profile median, the calibration flags this as a likely maintenance event and applies the recent median directly rather than a scale factor. This prevents the model from predicting 90% when the station is clearly offline.

```
if recentMedian < 0.5 × profileMedian:
  prediction = recentMedian   // Station is likely in maintenance
else:
  prediction = profilePrediction × seasonalScale
```

---

## 7. Weather Data Integration

### 7.1 Station-Specific Weather

Each weather-dependent station (wind, solar) uses its exact coordinates for weather fetching. This is a key difference from Demand, where weather is averaged across multiple stations per area.

| Station Type | Weather Source | Special Features |
|--------------|---------------|------------------|
| Wind | Per-station coordinates | 100m hub-height wind data preferred |
| Solar | Per-station coordinates | UV index, visibility |
| Profile stations | Not weather-dependent | No weather fetch needed |

### 7.2 Weather Cluster Groups

Nearby stations can share weather data to reduce API calls:

```json
{
  "ILOCOS_NORTE_WIND": {
    "stations": ["01BURGOS", "01PAGUDPUD", "01LAOAG"],
    "referenceLocation": { "latitude": 18.5340, "longitude": 120.6479 }
  }
}
```

The cluster weather is fetched once and shared. Per-station deviations are handled by the ML residual layer and calibration, not by separate weather fetches.

### 7.3 Weather Cache and Stale Data

V1 had a known issue with stale weather cache for future dates — Visual Crossing returns incomplete data for forecast periods, which gets cached and reused even after actual data becomes available.

**V2 fix**: cache entries for future dates are tagged with a `fetchedAt` timestamp. During calibration (which processes past dates with known actuals), any cache entry where the data date is before the fetch date is considered potentially stale and re-fetched.

```
weather_cache/
├── WIND_01BURGOS/
│   └── 2026-03/
│       ├── 2026-03-20.csv          # Historical: fetched after date, trustworthy
│       ├── 2026-03-25.csv          # Forecast: fetched before date, may be stale
│       └── cache_meta.json         # { "2026-03-25": { "fetchedAt": "2026-03-22" } }
```

---

## 8. Calibration Detail

### 8.1 Unified Calibration Process

For all station types, calibration follows the same structure:

```
1. Load model
2. For each station:
   a. Get recent actuals (calibrationDays window)
   b. Generate model predictions for those days
   c. Compare: compute correction factors
   d. Clamp correction factors to configured bounds
   e. Store in calibration.json
3. Compute diagnostic metrics
4. Check retrain triggers
5. Write output
```

The correction factors differ by station type but the process is identical.

### 8.2 Wind Calibration Detail

```
For each wind station:
  globalBias = mean(predicted - actual) across all hours
  
  For each hour h:
    hoursActual = filter(actual where hour == h and actual > 0.01)
    hoursPredicted = filter(predicted where hour == h and predicted > 0.01)
    hourlyScale[h] = mean(hoursActual) / mean(hoursPredicted)
    hourlyScale[h] = clamp(hourlyScale[h], windScaleClamp)
  
  Applied at inference:
    calibrated = (predicted - globalBias) × hourlyScale[hour]
    calibrated = clamp(calibrated, 0.0, 1.0)
```

### 8.3 Solar Calibration Detail

```
For each solar station:
  globalBias = mean(predicted - actual) across generating hours
  
  For each hour h:
    if mean(actual[h]) < 0.01:   // Night hour
      hourlyScale[h] = 0
    else:
      hourlyScale[h] = mean(actual[h]) / mean(predicted[h])
      hourlyScale[h] = clamp(hourlyScale[h], solarScaleClamp)
  
  Applied at inference:
    calibrated = (predicted - globalBias) × hourlyScale[hour]
    calibrated = clamp(calibrated, 0.0, 1.0)
```

### 8.4 Profile Calibration Detail

```
For each profile station:
  recentMedian = median(actual across calibration window)
  profileMedian = profile[currentMonth][allHours][currentDayType].p50 (averaged)
  seasonalScale = recentMedian / profileMedian
  seasonalScale = clamp(seasonalScale, profileScaleClamp)
  
  // Maintenance detection (geothermal)
  if recentMedian < 0.5 × profileMedian:
    maintenanceFlag = true
  
  Applied at inference:
    if maintenanceFlag:
      calibrated = recentMedian
    else:
      calibrated = profilePrediction × seasonalScale
    calibrated = clamp(calibrated, 0.0, 1.0)
```

---

## 9. Operator Configuration

### 9.1 Full Configuration File

```json
{
  "wind": {
    "model": "4tier_hybrid",
    "mlResidual": "xgboost",
    "hubHeightPreferred": true,
    "perStationCalibration": true,
    "windScaleClamp": [0.50, 2.00]
  },
  "solar": {
    "model": "physics_hybrid",
    "mlResidual": "xgboost",
    "solarAlpha": 0.65,
    "solarScaleClamp": [0.50, 1.50],
    "tempCoefficient": 0.004,
    "standardIrradiance": 1000
  },
  "profile": {
    "defaultPercentile": "p50",
    "confidenceThreshold": 50,
    "profileScaleClamp": [0.50, 1.50],
    "maintenanceThreshold": 0.50
  },
  "calibration": {
    "enabled": true,
    "days": 14,
    "minGeneratingHours": 5
  },
  "training": {
    "days": 120,
    "validationSplit": 0.2,
    "holdoutDays": 30
  },
  "lifecycle": {
    "retrainSchedule": "30d",
    "calibrationSchedule": "7d",
    "retrainTrigger": {
      "solarScaleDriftThreshold": 0.25,
      "windBiasDriftThreshold": 0.10,
      "profileSeasonalDriftThreshold": 0.15,
      "consecutiveCyclesOverThreshold": 3
    },
    "autoRetrain": false
  }
}
```

### 9.2 Tuning Guide by Station Type

#### Wind Tuning

| Parameter | Default | Range | Effect |
|-----------|---------|-------|--------|
| `perStationCalibration` | true | true/false | Enable per-station hourly correction. Disable for stations where it adds noise. |
| `windScaleClamp` | [0.50, 2.00] | wider = more aggressive | How far hourly corrections can go. Wind is variable, so wider than solar. |

**Mental model**: "Wind is inherently noisy. Per-station calibration helps if the station has consistent diurnal patterns. If a specific station's calibration is making things worse, disable it for that station."

#### Solar Tuning

| Parameter | Default | Range | Effect |
|-----------|---------|-------|--------|
| `solarAlpha` | 0.65 | 0.50-0.80 | **Under-prediction protection.** Higher = model biases toward higher predictions. This is the primary knob for "solar always under." |
| `solarScaleClamp` | [0.50, 1.50] | narrower = safer | How far hourly corrections can go. |
| `tempCoefficient` | 0.004 | 0.002-0.006 | Panel efficiency loss per °C above 25°C. Reduce for tropical-rated panels. |

**Mental model**: "If solar is consistently under-predicting, first check calibration hourly scales — they should be above 1.0 for midday hours. If they're hitting the 1.50 clamp, the physics model is too far off and you need to either reduce `tempCoefficient` or trigger a retrain."

#### Profile Tuning

| Parameter | Default | Range | Effect |
|-----------|---------|-------|--------|
| `defaultPercentile` | p50 | p5/p50/p95 | Which percentile to use as default prediction. p50 is balanced, p95 is optimistic, p5 is conservative. |
| `confidenceThreshold` | 50 | 20-200 | Samples needed for full station confidence before blending with type-level profile. |
| `maintenanceThreshold` | 0.50 | 0.30-0.70 | How far below profile median before flagging as maintenance. Lower = more tolerant of dips. |
| `profileScaleClamp` | [0.50, 1.50] | — | Seasonal scale factor bounds. |

**Mental model**: "Profile stations are stable (especially geothermal). If a station is consistently off, it's probably seasonal drift or maintenance. Check the seasonal scale factor first. If it's hitting the clamp, the profile is stale — retrain."

### 9.3 Troubleshooting Guide

#### Solar Issues

| Symptom | Likely Cause | First Fix | Second Fix | Third Fix |
|---------|-------------|-----------|------------|-----------|
| Solar always under-predicting | Physics model conservative for tropical conditions | Check hourly scales — midday should be >1.0 | ↑ `solarAlpha` → 0.70 | ↓ `tempCoefficient` → 0.003 |
| Solar over-predicting at dawn/dusk | Physics model overestimates at low sun angles | Hourly scales should be <1.0 for hours 6-7, 17-18 | Check if dawn/dusk hours have enough calibration samples | ↓ `solarAlpha` toward 0.50 (less bias) |
| Specific solar station is bad | Station-specific issue (shading, degradation) | Check per-station hourly scales | If scales are at clamp limits, station needs retrain | Consider removing station from forecast |
| Solar flat/constant predictions | Stale weather cache | Delete cache for affected dates and re-fetch | Check weather API response completeness | Verify `solarRadiation` field is populated |

#### Wind Issues

| Symptom | Likely Cause | First Fix | Second Fix |
|---------|-------------|-----------|------------|
| Wind always off by 10%+ in same direction | MREC thresholds need recalibration | Check `globalBias` in calibration.json | Trigger retrain |
| Wind accuracy varies by time of day | Diurnal pattern not captured | Check hourly scales — should show day/night variation | Verify `perStationCalibration` is enabled |
| Wind forecast flat/constant | Stale 100m wind data in cache | Clear cache, re-fetch | Fall back to 10m data if 100m unavailable |

#### Profile Issues

| Symptom | Likely Cause | First Fix | Second Fix |
|---------|-------------|-----------|------------|
| Geothermal showing 90% when station is offline | Calibration hasn't caught maintenance | ↓ `maintenanceThreshold` → 0.40 | Wait for calibration refresh with recent actuals |
| Hydro off by 30%+ | Seasonal shift (dry/wet season transition) | Check `seasonalScale` | Trigger retrain to rebuild profiles with recent data |
| Battery predictions useless | Dispatch-driven, profile model is wrong approach | Accept high error | Consider flat-rate or exclude from forecast |

---

## 10. Comparison With V1

| Aspect | V1 | V2 |
|--------|-----|-----|
| **Lifecycle** | Combined train+forecast | Train → Calibrate → Forecast (mirrors Demand V2) |
| **Calibration refresh** | Only during training | Independent, daily/weekly |
| **Solar calibration** | Single scalar bias per station | Hourly scale factors per station |
| **Solar loss function** | Symmetric (asymmetric opt-in) | Asymmetric default (configurable α) |
| **Wind per-station cal.** | Disabled | Enabled (rolling calibration tracks seasons) |
| **Model count** | 5 wind + 4 solar + 1 profile | 1 wind + 1 solar + 1 profile |
| **Weather cache** | No stale detection | Stale detection + auto-refresh |
| **Operator config** | CLI flags only | Full configuration file with per-type tuning |
| **Retrain triggers** | None | Calibration drift monitoring |
| **Reproducibility** | Non-reproducible | model.vfm + calibration.json + weather = exact output |

### What V1 Components Are Retained

| Component | Status |
|-----------|--------|
| 4-Tier MREC wind model | Retained as sole wind model |
| Solar physics base (irradiance) | Retained |
| Solar ML residual layer | Retained, asymmetric loss now default |
| Profile-based model (hydro/geo/bio) | Retained |
| Weather clustering | Retained |
| stations.json metadata | Retained |
| BiasCorrector | Evolved into hourly calibration |
| CFacXGBoostRegressor | Retained as ML layer |

### What V1 Components Are Removed/Archived

| Component | Reason |
|-----------|--------|
| `WindMRECModel.ts` (3-tier) | Superseded by 4-tier |
| `WindEnhancedHybridModel.ts` | Consolidated into single hybrid |
| `WindWeatherHybridModel.ts` | Consolidated |
| `SolarIrradianceModel.ts` (standalone) | Physics layer retained within hybrid only |
| `SolarMRECHybridModel.ts` | Consolidated |
| `SolarPremiumHybridModel.ts` | Premium features absorbed into main model |
| `CFacHybridModel.ts` (legacy) | Archived |
| `CFacRegressionModel.ts` (legacy) | Archived |

---

## 11. File & Module Structure

```
src/models/capacityFactor/
├── WindHybridModel.ts          # 4-Tier MREC + ML hybrid (sole wind model)
├── SolarHybridModel.ts         # Physics + ML hybrid (sole solar model)
├── ProfileModel.ts             # Hydro, geothermal, biomass, battery
├── CFacXGBoostRegressor.ts     # ML layer (shared by wind + solar)
└── index.ts                    # Model selection and exports

src/pipeline/
├── CfacTrainPipeline.ts        # Orchestrates full CFAC training
├── CfacCalibratePipeline.ts    # Orchestrates calibration refresh
├── CfacForecastPipeline.ts     # Orchestrates stateless inference
└── CfacModelSerializer.ts      # Save/load cfac_model.vfm + calibration.json

src/services/
├── weatherService.ts           # Visual Crossing API (shared with Demand)
└── cfacCalibrationService.ts   # Calibration computation logic

src/metrics/
├── CfacMetrics.ts              # MAPE, MAE, RMSE per station and type
└── CfacRetrainMonitor.ts       # Drift detection and retrain triggers

src/cli/
├── cfacTrain.ts                # CLI handler for cfac train
├── cfacCalibrate.ts            # CLI handler for cfac calibrate
└── cfacForecast.ts             # CLI handler for cfac forecast

src/data/
├── stations.json               # Station metadata
└── weatherClusters.json        # Weather sharing groups

legacy/                         # Archived V1 models (reference only)
├── WindMRECModel.ts
├── WindEnhancedHybridModel.ts
├── WindWeatherHybridModel.ts
├── SolarIrradianceModel.ts
├── SolarMRECHybridModel.ts
├── SolarPremiumHybridModel.ts
├── CFacHybridModel.ts
└── CFacRegressionModel.ts
```

---

## 12. CLI Interface

### 12.1 Train Command

```bash
node dist/index.js cfac train \
  -t "Data Samples/Capacity Factor" \  # Historical CFac data directory
  -w "Data Samples/Weather" \          # Historical weather data (or auto-fetch)
  --days 120 \                         # Training window
  --config cfac_config.json \          # Configuration (optional)
  -o models/cfac_model_20260324.vfm    # Output model
```

### 12.2 Calibrate Command

```bash
node dist/index.js cfac calibrate \
  -m models/cfac_model_20260324.vfm \  # Trained model (read-only)
  -t "Data Samples/Capacity Factor" \  # Recent CFac actuals
  --days 14 \                          # Calibration window
  -o models/cfac_calibration.json      # Output calibration snapshot
```

### 12.3 Forecast Command

```bash
node dist/index.js cfac forecast \
  -m models/cfac_model_20260324.vfm \  # Trained model (read-only)
  -c models/cfac_calibration.json \    # Calibration (read-only)
  -s 2026-03-25 \                      # Start date
  -e 2026-03-31 \                      # End date
  -o output/cfac_forecast.csv          # Output forecast
```

### 12.4 Shared Flags

| Flag | Description | Default |
|------|-------------|---------|
| `--config <path>` | Configuration file | Built-in defaults |
| `--verbose` | Detailed diagnostics | false |
| `--stations <list>` | Forecast specific stations only | All stations in model |
| `--no-calibrate` | Skip calibration during forecast | false |

---

## 13. Migration Path

### Phase 1: Lifecycle Separation (2-3 days)
- Implement `CfacTrainPipeline`, `CfacCalibratePipeline`, `CfacForecastPipeline`
- Implement `CfacModelSerializer` for .vfm and calibration.json
- Wire up three CLI commands
- Verify: train → calibrate → forecast produces same results as V1

### Phase 2: Solar Hourly Calibration (2-3 days)
- Replace scalar BiasCorrector with hourly scale factors
- Implement per-station per-hour calibration logic
- Enable asymmetric loss as default
- Validate: solar MAPE improvement, especially midday hours

### Phase 3: Wind Calibration Re-enable (1-2 days)
- Enable per-station hourly calibration for wind
- Implement rolling 14-day window
- Validate: wind MAPE on stations with strong diurnal patterns

### Phase 4: Model Consolidation + Stale Cache Fix (2-3 days)
- Archive legacy models to `legacy/` folder
- Clean up model selection to single model per type
- Implement cache staleness detection and auto-refresh
- Implement retrain trigger monitoring

### Phase 5: Validation & Cutover (2-3 days)
- Run V1 and V2 in parallel
- Compare per-station MAPE across all types
- Verify lifecycle: train → calibrate → re-calibrate → forecast consistency
- Cut over when V2 meets or exceeds V1

**Total estimated effort: 10-14 days**

(Shorter than Demand V2 because the core models are retained — only the lifecycle and calibration are overhauled.)

---

## Appendix A: Solar Under-Prediction Analysis

### Why Solar Systematically Under-Predicts in the Philippines

The physics base model uses:
```
rawCFac = solarRadiation / 1000
tempDerate = 1 - 0.004 × max(0, temp - 25)
physicsCFac = rawCFac × tempDerate × cloudFactor
```

Each component introduces conservative bias in tropical conditions:

| Component | Bias Direction | Magnitude | Explanation |
|-----------|---------------|-----------|-------------|
| `solarRadiation` | Under-estimates | -5 to -15% | Visual Crossing models are calibrated globally, conservative in tropical high-humidity conditions where diffuse radiation is higher |
| `tempDerate` | Over-penalizes | -3 to -8% | Standard coefficient (0.004/°C) is for temperate-climate panels. Tropical installations use heat-tolerant panels with lower derating |
| `cloudFactor` | Over-penalizes | -2 to -5% | Hourly average cloud cover misses partial-sun bursts from convective cloud patterns common in tropics |
| **Combined** | **Under-predicts** | **-10 to -25%** | **Worst at midday when all three biases peak simultaneously** |

### Why Hourly Calibration Is the Right Fix

Fixing the physics model directly (better irradiance data, tropical-tuned derating) would require either:
- Switching weather providers (expensive, risky)
- Per-station panel specifications (unavailable for most stations)
- Custom tropical physics (research project, not engineering)

Hourly calibration is empirical and self-correcting: whatever the physics model gets wrong, the calibration absorbs it as a scale factor. If Visual Crossing improves their tropical irradiance estimates, the midday scale factors will naturally drift toward 1.0, and the system adapts without code changes.

---

## Appendix B: V1 → V2 Source Code Mapping

| V1 File | V1 Role | V2 Replacement |
|---------|---------|----------------|
| `Wind4TierHybridModel.ts` | Recommended wind model | `WindHybridModel.ts` (renamed) |
| `Wind4TierMRECModel.ts` | MREC base layer | Folded into `WindHybridModel.ts` |
| `SolarHybridModel.ts` | Recommended solar model | `SolarHybridModel.ts` (enhanced) |
| `SolarIrradianceModel.ts` | Physics base layer | Folded into `SolarHybridModel.ts` |
| `ProfileBasedModel.ts` | Hydro/geo/bio | `ProfileModel.ts` (renamed) |
| `BiasCorrector.ts` | Scalar bias correction | Replaced by hourly calibration in `CfacCalibratePipeline.ts` |
| `cfacCalibrationService.ts` | Calibration logic | `CfacCalibratePipeline.ts` |
| `forecastGenerator.ts` | Combined train+forecast | Split into 3 pipeline files |
| `modelStore.ts` | Model persistence | `CfacModelSerializer.ts` |

---

## Document History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 2.0 | 2026-03-24 | Claude | V2 architecture: lifecycle alignment with Demand, hourly solar calibration, wind calibration re-enable, model consolidation, operator configuration, troubleshooting guide |
