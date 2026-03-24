---
Status: Active
Last-Updated: 2026-03-24
Updated-By: Claude Code
---

# Demand Forecasting Methodology

**Vantage Forecaster - Technical Methodology Report**

Version: 1.0
Date: March 24, 2026
Classification: Technical Reference Document

---

## Executive Summary

Vantage Forecaster uses a **Hybrid Interpolation Model** with **two-pass calibration** for electricity demand forecasting in the Philippine power grid. The system supports both:

- **Regional Mode**: 3 regions (Luzon, Visayas, Mindanao)
- **Zonal Mode**: 14 sub-regions for granular dispatch planning

The methodology achieves **2-4% MAPE** on demand forecasts through:
1. Statistical profile-based bounds learning
2. Temperature-demand relationship modeling
3. Dynamic weekend correction factor learning
4. Two-pass hybrid calibration (Iterative Scaling + XGBoost)

---

## Table of Contents

1. [Model Architecture](#1-model-architecture)
2. [Feature Engineering](#2-feature-engineering)
3. [Statistical Profile System](#3-statistical-profile-system)
4. [Temperature Sensitivity Modeling](#4-temperature-sensitivity-modeling)
5. [Weekend Correction System](#5-weekend-correction-system)
6. [Two-Pass Calibration](#6-two-pass-calibration)
7. [Regional vs Zonal Mode](#7-regional-vs-zonal-mode)
8. [Training Process](#8-training-process)
9. [Inference Process](#9-inference-process)
10. [Performance Metrics](#10-performance-metrics)
11. [Configuration Parameters](#11-configuration-parameters)

---

## 1. Model Architecture

### Overview

The forecasting system uses a **Hybrid Interpolation Model** (`HybridModel` class) that combines:

1. **Statistical Profile Learning**: Builds min/median/max demand bounds per hour/daytype/region
2. **Multivariate Linear Regression**: Predicts position within statistical bounds
3. **Region-Specific Characteristics**: Learns daily swing patterns, temperature sensitivity per region
4. **Dynamic Weekend Corrections**: Learns Saturday/Sunday adjustment factors from training data
5. **Two-Pass Calibration**: Corrects systematic bias and residual patterns

### Architectural Diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        TRAINING PIPELINE                                │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  Historical Data                                                        │
│       │                                                                 │
│       ▼                                                                 │
│  ┌─────────────────────┐                                               │
│  │ Feature Engineering │ ──► 50+ features (temporal, weather, lags)    │
│  └─────────────────────┘                                               │
│       │                                                                 │
│       ▼                                                                 │
│  ┌─────────────────────┐     ┌──────────────────────┐                  │
│  │ Build Profiles      │ ──► │ Min/Median/Max bounds │                  │
│  │ (per region/hour/   │     │ per {region, hour,    │                  │
│  │  daytype)           │     │ daytype} combination  │                  │
│  └─────────────────────┘     └──────────────────────┘                  │
│       │                                                                 │
│       ▼                                                                 │
│  ┌─────────────────────┐     ┌──────────────────────┐                  │
│  │ Train ML Regression │ ──► │ Position prediction   │                  │
│  │                     │     │ (0=min, 1=max)        │                  │
│  └─────────────────────┘     └──────────────────────┘                  │
│       │                                                                 │
│       ▼                                                                 │
│  ┌─────────────────────┐     ┌──────────────────────┐                  │
│  │ Learn Region Chars  │ ──► │ Daily swing, temp     │                  │
│  │                     │     │ sensitivity, peak     │                  │
│  └─────────────────────┘     │ hour offset           │                  │
│       │                      └──────────────────────┘                  │
│       ▼                                                                 │
│  ┌─────────────────────┐     ┌──────────────────────┐                  │
│  │ Learn Weekend       │ ──► │ Saturday/Sunday       │                  │
│  │ Corrections         │     │ scaling factors       │                  │
│  └─────────────────────┘     │ per region            │                  │
│       │                      └──────────────────────┘                  │
│       ▼                                                                 │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                    TWO-PASS CALIBRATION                         │   │
│  │  ┌────────────────────┐      ┌────────────────────┐            │   │
│  │  │ Pass 1: Iterative  │ ──►  │ Pass 2: XGBoost    │            │   │
│  │  │ Scaling            │      │ Quantile Loss      │            │   │
│  │  │ (Peak/Off-peak)    │      │ (Residual patterns)│            │   │
│  │  └────────────────────┘      └────────────────────┘            │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│                        INFERENCE PIPELINE                               │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  New Weather Forecast                                                   │
│       │                                                                 │
│       ▼                                                                 │
│  ┌─────────────────────┐                                               │
│  │ Feature Engineering │                                                │
│  └─────────────────────┘                                               │
│       │                                                                 │
│       ▼                                                                 │
│  ┌─────────────────────┐                                               │
│  │ Look up profile     │ ──► Get {min, median, max} for this           │
│  │ for region/hour/day │     region/hour/daytype combination           │
│  └─────────────────────┘                                               │
│       │                                                                 │
│       ▼                                                                 │
│  ┌─────────────────────┐                                               │
│  │ Interpolate within  │ ──► Base prediction using temperature,        │
│  │ bounds              │     lags, and region characteristics          │
│  └─────────────────────┘                                               │
│       │                                                                 │
│       ▼                                                                 │
│  ┌─────────────────────┐                                               │
│  │ Apply Weekend       │ ──► Multiply by Saturday/Sunday factor        │
│  │ Correction          │     if applicable                             │
│  └─────────────────────┘                                               │
│       │                                                                 │
│       ▼                                                                 │
│  ┌─────────────────────┐                                               │
│  │ Apply Pass 1        │ ──► Scale by peak/off-peak factors            │
│  │ (Iterative Scaling) │                                               │
│  └─────────────────────┘                                               │
│       │                                                                 │
│       ▼                                                                 │
│  ┌─────────────────────┐                                               │
│  │ Apply Pass 2        │ ──► XGBoost residual correction               │
│  │ (XGBoost)           │                                               │
│  └─────────────────────┘                                               │
│       │                                                                 │
│       ▼                                                                 │
│  Final Demand Forecast (MW)                                             │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Feature Engineering

### Feature Categories

The model uses **50+ engineered features** organized into categories:

#### 2.1 Temporal Features

| Feature | Description | Encoding |
|---------|-------------|----------|
| `hour` | Hour of day (0-23) | Integer |
| `hourSin`, `hourCos` | Cyclical hour encoding | sin(hour × 2π/24), cos(hour × 2π/24) |
| `dayOfWeek` | Day of week (0=Sunday, 6=Saturday) | Integer |
| `isWeekend` | Weekend indicator | Binary (0/1) |
| `isHoliday` | Philippine holiday indicator | Binary (0/1) |
| `isWorkday` | Non-holiday weekday | Binary (0/1) |
| `isSaturday`, `isSunday` | Day type indicators | Binary (0/1) |
| `dayOfMonth` | Day of month (1-31) | Integer |
| `month` | Month (1-12) | Integer |
| `hour_0` to `hour_23` | One-hot hour encoding | Binary (24 features) |

#### 2.2 Weather Features

| Feature | Description | Units |
|---------|-------------|-------|
| `temp` | Temperature | °C |
| `tempSquared` | Temperature squared | °C² |
| `dew` | Dew point temperature | °C |
| `precip` | Precipitation | mm |
| `windgust` | Wind gust speed | km/h |
| `windspeed` | Wind speed | km/h |
| `cloudcover` | Cloud cover | % |
| `solarradiation` | Solar radiation | W/m² |
| `uvindex` | UV index | 0-11 |

#### 2.3 Derived Weather Features

| Feature | Description | Formula |
|---------|-------------|---------|
| `relativeHumidity` | Relative humidity | Magnus formula from temp/dew |
| `heatIndex` | Feels-like temperature | Rothfusz regression |
| `CDH` | Cooling Degree Hours | max(0, temp - 24°C) |
| `effectiveSolar` | Effective solar radiation | solarradiation × (1 - cloudcover/100) |
| `apparentTemp` | Apparent temperature | Combined heat/wind chill |
| `isRaining` | Rain indicator | precip > 0 |
| `tempDewSpread` | Temp-dew spread | temp - dew |
| `isDaytime` | Daytime indicator | hour 6-18 |

#### 2.4 Lag Features

| Feature | Description | Purpose |
|---------|-------------|---------|
| `demandLag1h` | Demand 1 hour ago | Short-term momentum |
| `demandLag24h` | Demand 24 hours ago | Same hour yesterday |
| `demandLag168h` | Demand 168 hours ago | Same hour last week |
| `tempLag1h` | Temperature 1 hour ago | Temperature trend |
| `tempLag24h` | Temperature 24 hours ago | Daily temperature pattern |
| `demandRolling24h` | 24-hour rolling average demand | Smoothed trend |
| `tempRolling24h` | 24-hour rolling average temp | Smoothed weather |
| `tempMax24h` | 24-hour max temperature | Peak cooling load |

#### 2.5 Interaction Features

| Feature | Description |
|---------|-------------|
| `hourWorkday` | hour × isWorkday |
| `hourSaturday` | hour × isSaturday |
| `hourSunday` | hour × isSunday |

### Holiday Detection

Philippines holidays are detected dynamically using the `date-holidays` npm package:

- **Public Holidays**: Christmas, New Year, Independence Day, etc.
- **Optional Holidays**: All Saints' Day, Ninoy Aquino Day, etc.
- **Special Proclamations**: One-time presidential declarations

Holiday status significantly affects demand patterns (typically 10-20% lower than workdays).

---

## 3. Statistical Profile System

### Profile Key Structure

Profiles are built for each unique combination of:

```
{region}_{hour}_{dayType}
```

Where:
- `region`: CLUZ, CVIS, CMIN (regional) or 01NLUZ...14SWMIN (zonal)
- `hour`: 0-23
- `dayType`: 0 (weekday), 1 (Saturday), 2 (Sunday)

**Example keys**: `CLUZ_14_0` (Luzon, 2PM, weekday), `01NLUZ_18_1` (Northern Luzon, 6PM, Saturday)

### Profile Contents

Each profile stores:

```typescript
interface StatisticalBounds {
  min: number;           // 5th percentile demand (robust to outliers)
  median: number;        // 50th percentile demand
  max: number;           // 95th percentile demand
  count: number;         // Number of training samples
  recentDays: Array<{    // Last 7 similar days for dynamic bounds
    date: string;
    demand: number;
    temp: number;
  }>;
  tempCoefficient: number;  // MW per °C relationship
  baseTemp: number;         // Reference temperature for this profile
  timePeriod: TimePeriod;   // NIGHT/MORNING/MIDDAY/EVENING/LATE
  swingAmplitude: number;   // Daily variation (max - min)
  region: string;           // Region code
}
```

### Profile Building Process

1. **Group samples** by `region_hour_dayType` key
2. **Sort by date** (most recent first)
3. **Calculate percentiles**: 5th, 50th, 95th (not min/max to avoid outliers)
4. **Calculate temperature coefficient** using linear regression
5. **Store recent 7 days** for dynamic bounds adjustment

---

## 4. Temperature Sensitivity Modeling

### Time-Period Based Sensitivity

Different hours have different temperature sensitivity:

| Time Period | Hours | Base Sensitivity | Rationale |
|-------------|-------|------------------|-----------|
| NIGHT | 0-5 | 0.4 | Low variation, base load |
| MORNING_RAMP | 6-9 | 0.6 | Wake-up patterns dominate |
| MIDDAY | 10-16 | 1.0 | Full cooling load impact |
| EVENING_PEAK | 17-22 | 0.5 | Residential patterns dominate |
| LATE_NIGHT | 23 | 0.4 | Transition period |

### Region-Specific Multipliers

Each region learns its own temperature sensitivity multiplier from training data:

```typescript
tempSensitivityMultiplier = 0.3 + (|avgTempCorrelation| × 0.7)
```

- High correlation (>0.7): Region strongly affected by temperature
- Low correlation (<0.3): Other factors dominate (industrial load, etc.)

### Temperature Adjustment Formula

```
tempAdjustment = tempCoefficient × (currentTemp - baseTemp) × effectiveSensitivity
```

Where:
```
effectiveSensitivity = timePeriodSensitivity × regionMultiplier
```

---

## 5. Weekend Correction System

### Problem

Weekend demand patterns differ from weekdays:
- Lower overall demand (10-15% typically)
- Different hourly shape (later morning ramp, extended evening)
- Regional variation (industrial vs residential mix)

### Solution: Dynamic Learning

Weekend corrections are **learned fresh from training data** each time:

```typescript
// For each region/zone:
saturdayFactor = sum(saturdayActuals) / sum(saturdayPredictions)
sundayFactor = sum(sundayActuals) / sum(sundayPredictions)
```

### Factor Clamping

Factors are clamped to reasonable range to prevent overfitting:

```typescript
factor = clamp(factor, 0.85, 1.15)  // ±15% maximum adjustment
```

### Zone-to-Parent Region Fallback

For 14-zone mode, if a zone doesn't have enough weekend samples:

```
01NLUZ, 02METRO, 03SLUZ  → Falls back to CLUZ correction
04LEYTE...08PANAY        → Falls back to CVIS correction
09NWMIN...14SWMIN        → Falls back to CMIN correction
```

---

## 6. Two-Pass Calibration

### Overview

The calibration system uses a **two-pass hybrid approach**:

```
Raw Hybrid Prediction
        │
        ▼
┌───────────────────────┐
│ Pass 1: Iterative     │  Corrects systematic peak/off-peak bias
│ Scaling               │  (deterministic, fast)
└───────────────────────┘
        │
        ▼
┌───────────────────────┐
│ Pass 2: XGBoost       │  Corrects residual patterns
│ Quantile Loss         │  (ML-based, prevents peak crushing)
└───────────────────────┘
        │
        ▼
Final Calibrated Prediction
```

### Pass 1: Iterative Scaling Calibrator

**Purpose**: Correct systematic over/under-forecasting for peak vs off-peak hours.

**Algorithm**:
1. Generate forecast for calibration period (with known actuals)
2. Calculate deviation: `(actual - forecast) / actual × 100%`
3. Separate into peak hours (09:00-21:00) and off-peak hours
4. Calculate scaling factors:
   - `peakScale = round(peakDeviation)`
   - `offpeakScale = round(offpeakDeviation)`
5. Repeat until deviation < threshold (default 5%)

**Application**:
```typescript
scaledPrediction = prediction × (1 + (peakScale + zoneScale) / 100)
```

**Example output**:
```
Pass 1 trained: Peak +3%, Off-peak -2%
```

### Pass 2: XGBoost Quantile Loss Calibrator

**Purpose**: Learn residual correction patterns that iterative scaling misses.

**Key Innovation: Quantile Loss**

Unlike symmetric MSE loss, quantile loss with α > 0.5 penalizes under-predictions more:

```
Loss = α × error      if actual > predicted (under-prediction)
Loss = (1-α) × error  if actual < predicted (over-prediction)
```

Default α = 0.80 creates a **4:1 penalty ratio** (under vs over), preventing "peak crushing".

**Features used by XGBoost calibrator**:

| Feature | Description |
|---------|-------------|
| `zoneIdx` | Zone one-hot encoding |
| `hour`, `hourSin`, `hourCos` | Temporal |
| `dayTypeWorkday/Saturday/Sunday/Holiday` | Day type one-hot |
| `temp`, `humidity`, `cloudCover` | Weather |
| `hybridPrediction` | Raw hybrid model output |
| `demandLag24h` | Yesterday same hour |
| `month`, `monthSin`, `monthCos` | Seasonal |
| `momentum24h` | Rolling 24h error average |
| `errorTrend` | Recent vs older error comparison |
| `forecastHorizon` | Hours ahead in prediction |
| `tempRamp` | Rate of temperature change |

**Model Configuration**:
- Max depth: 4
- Number of trees: 50
- Learning rate: 0.1
- Min child weight: 10
- Validation split: 20%

**Correction Clamping**:
```typescript
correction = clamp(correction, 0.50, 1.50)  // ±50% max (safety only)
```

---

## 7. Regional vs Zonal Mode

### Regional Mode (3 Regions)

| Region | Code | Weather City |
|--------|------|--------------|
| Luzon | CLUZ | Manila |
| Visayas | CVIS | Cebu City |
| Mindanao | CMIN | Davao City |

- Uses 3 weather stations
- Faster training and inference
- Suitable for system-wide planning

### Zonal Mode (14 Sub-Regions)

| Zone | Name | Parent Region | Weather Cities |
|------|------|---------------|----------------|
| 01NLUZ | Northern Luzon | Luzon | San Fernando, Baguio, Tuguegarao, Laoag, Dagupan, Angeles |
| 02METRO | Metro Manila | Luzon | Manila, Quezon City, Makati |
| 03SLUZ | Southern Luzon | Luzon | Batangas, Lucena, Legazpi |
| 04LEYTE | Leyte/Eastern Visayas | Visayas | Tacloban, Ormoc, Catbalogan |
| 05CEBU | Cebu | Visayas | Cebu City, Mandaue, Lapu-Lapu |
| 06NEGROS | Negros | Visayas | Bacolod, Dumaguete, Kabankalan |
| 07BOHOL | Bohol | Visayas | Tagbilaran, Ubay, Talibon |
| 08PANAY | Panay/Western Visayas | Visayas | Iloilo City, Roxas, Kalibo |
| 09NWMIN | Northwest Mindanao | Mindanao | Zamboanga, Pagadian, Dipolog |
| 10LANAO | Lanao | Mindanao | Iligan, Marawi, Ozamiz |
| 11NCMIN | North Central Mindanao | Mindanao | Cagayan de Oro, Malaybalay, Valencia |
| 12NEMIN | Northeast Mindanao | Mindanao | Butuan, Surigao, Bislig |
| 13SEMIN | Southeast Mindanao | Mindanao | Davao City, Tagum, Panabo |
| 14SWMIN | Southwest Mindanao | Mindanao | General Santos, Koronadal, Cotabato |

- Uses 42 weather stations (3 per zone)
- More accurate local forecasts
- Required for sub-regional dispatch planning

---

## 8. Training Process

### Step-by-Step Training Flow

1. **Load Training Data**
   - Historical demand (hourly MW per region/zone)
   - Weather data (auto-fetched from Visual Crossing API)

2. **Merge and Align Timestamps**
   - Weather uses hour-starting, demand uses hour-ending
   - Add 1 hour to weather timestamps for alignment

3. **Engineer Features**
   - Calculate all 50+ features for each sample
   - First 168 hours (7 days) filtered for lag feature warmup

4. **Build Statistical Profiles**
   - Group by `region_hour_dayType`
   - Calculate min/median/max bounds
   - Calculate temperature coefficients

5. **Train ML Position Predictor**
   - Multivariate linear regression
   - Predicts position within bounds (0 = min, 1 = max)

6. **Learn Region Characteristics**
   - Daily swing amplitude
   - Temperature sensitivity multiplier
   - Peak hour offset

7. **Learn Weekend Corrections**
   - Calculate Saturday/Sunday factors per region
   - Clamp to ±15% range

8. **Two-Pass Calibration Training**
   - Pass 1: Iterative scaling (peak/off-peak)
   - Pass 2: XGBoost quantile loss (residual patterns)

9. **Save Model Instance** (optional)
   - Serialized to `.vfm` file (MessagePack binary)
   - Includes all weights, profiles, calibration

### Training Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `trainDays` | 90 | Days of historical data |
| `recentDaysCount` | 7 | Days for dynamic bounds |
| `growthFactor` | 0 | Daily demand growth rate |
| `calibrationMode` | hybrid | none, iterative, xgboost, or hybrid |
| `quantileAlpha` | 0.80 | XGBoost under-prediction penalty |
| `enableZoneScaling` | true | Per-zone adjustments in calibration |

---

## 9. Inference Process

### Step-by-Step Inference Flow

1. **Load Saved Model** (if using inference mode)
   - Deserialize `.vfm` file
   - Restore profiles, weights, calibration

2. **Fetch Weather Forecast**
   - Visual Crossing API for forecast period
   - Cached locally for repeated runs

3. **For Each Forecast Hour**:

   a. **Engineer Features** from weather forecast

   b. **Look Up Profile** for `region_hour_dayType`

   c. **Interpolate Within Bounds**:
      - Start with median demand
      - Apply temperature adjustment
      - Apply region swing characteristics
      - Apply lag-based trend adjustment
      - Clamp to min/max bounds

   d. **Apply Weekend Correction** (if Saturday/Sunday)

   e. **Apply Pass 1 Scaling** (peak/off-peak)

   f. **Apply Pass 2 XGBoost** (residual correction)

4. **Output Forecast**
   - CSV format with DateTimeEnding column
   - Columns for each region/zone

### Output Format

**Regional Mode**:
```csv
DateTimeEnding,CLUZ,CVIS,CMIN
2026-03-25 01:00,8500.5,2100.3,1800.7
2026-03-25 02:00,8200.1,2050.8,1750.2
...
```

**Zonal Mode**:
```csv
DateTimeEnding,01NLUZ,02METRO,03SLUZ,04LEYTE,05CEBU,06NEGROS,07BOHOL,08PANAY,09NWMIN,10LANAO,11NCMIN,12NEMIN,13SEMIN,14SWMIN
2026-03-25 01:00,1250.5,3200.8,1800.3,250.1,450.2,300.5,100.2,350.1,200.5,150.3,400.2,180.1,500.3,250.2
...
```

---

## 10. Performance Metrics

### Primary Metrics

| Metric | Formula | Target |
|--------|---------|--------|
| **MAPE** | mean(\|actual - forecast\| / actual × 100) | < 5% |
| **MAE** | mean(\|actual - forecast\|) | < 200 MW |
| **R²** | 1 - (SS_res / SS_tot) | > 0.95 |

### Per-Region/Zone MAPE

The system calculates demand-weighted MAPE per region/zone:

```
Region MAPE = (sum of absolute errors) / (sum of actual demand) × 100
```

This gives more weight to high-demand periods (peaks) vs low-demand periods (overnight).

### Historical Performance

| Mode | Typical MAPE | Notes |
|------|--------------|-------|
| Regional (3) | 2-3% | Best for system-wide |
| Zonal (14) | 3-4% | More granular, slightly higher error |

### Calibration Impact

| Stage | Typical MAPE Improvement |
|-------|-------------------------|
| Raw Hybrid | ~8-10% |
| + Pass 1 (Iterative) | ~6-8% |
| + Pass 2 (XGBoost) | ~2-4% |

---

## 11. Configuration Parameters

### Global Configuration (`forecast_config.json`)

```json
{
  "calibration": {
    "enabled": true,
    "days": 7,
    "threshold": 5,
    "maxIterations": 10,
    "mode": "hybrid",
    "quantileAlpha": 0.8,
    "enableZoneScaling": true
  },
  "demand": {
    "model": "hybrid",
    "geography": "zonal",
    "growthRate": 0
  }
}
```

### CLI Options

```bash
node dist/index.js forecast \
  -d "Data Samples/Demand" \      # Training data path
  -s 2026-03-25 \                 # Forecast start date
  -e 2026-03-31 \                 # Forecast end date
  -o output/forecast.csv \        # Output file
  --model hybrid \                # Model type
  --zonal \                       # 14-zone mode
  --growth 0.01 \                 # 0.01% daily growth
  --no-calibrate                  # Disable calibration (optional)
```

---

## Appendix A: Mathematical Formulas

### Temperature Coefficient Calculation

Using least squares regression:

```
tempCoefficient = Cov(temp, demand) / Var(temp)
```

Where:
```
Cov(temp, demand) = Σ(temp - meanTemp)(demand - meanDemand) / n
Var(temp) = Σ(temp - meanTemp)² / n
```

### Quantile Loss Function

```
L(y, ŷ, α) = {
  α × (y - ŷ)        if y > ŷ  (under-prediction)
  (1-α) × (ŷ - y)    if y ≤ ŷ  (over-prediction)
}
```

For α = 0.80:
- Under-prediction penalty: 0.80 × error
- Over-prediction penalty: 0.20 × error
- Penalty ratio: 4:1

### Interpolation Formula

```
prediction = median + tempAdjustment + swingAdjustment + trendAdjustment
prediction = clamp(prediction, min, max)
```

Where:
```
tempAdjustment = tempCoefficient × (currentTemp - baseTemp) × effectiveSensitivity
swingAdjustment = (max - median) × normalizedTempDev × swingFactor × 0.5  (if hot)
trendAdjustment = prediction × clamp((lag24hRatio - 1) × 0.3, -0.05, 0.05)
```

---

## Appendix B: Source Code References

| Component | File |
|-----------|------|
| Hybrid Model | `src/models/hybridModel.ts` |
| Iterative Calibrator | `src/models/IterativeScalingCalibrator.ts` |
| XGBoost Calibrator | `src/models/DemandCalibrator.ts` |
| Feature Engineering | `src/constants/index.ts`, `src/features/` |
| Weather Service | `src/services/weatherService.ts` |
| Zone Configuration | `src/data/zones.json` |

---

## Document History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | 2026-03-24 | Claude Code | Initial methodology documentation |
