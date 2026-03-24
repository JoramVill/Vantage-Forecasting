---
Status: Active
Last-Verified: 2026-03-22
Verified-Against: current
Updated-By: codebase-documenter
---

# Model Overview

This document provides a comprehensive technical overview of ALL forecasting models in the iLoad Forecasting Utility for the Philippine power grid (WESM).

---

## 1. Demand Forecasting

### Hybrid Model (Recommended)

**File:** `src/models/hybridModel.ts`

The hybrid model combines statistical profile-based forecasting with machine learning regression for optimal accuracy.

#### Three-Step Process

**Step 1: Profile Building**
- Groups training data by region, hour, and day-type (weekday/Saturday/Sunday)
- Calculates P5/P50/P95 percentiles as min/median/max bounds for each group
- Creates a comprehensive statistical envelope of expected demand ranges

**Step 2: Region Characteristics Learning**
- **Daily swing magnitude**: Typical peak-to-trough variation per region
- **Peak hour offset**: How peak hour shifts from 18:00 baseline
- **Trough depth ratio**: How deep overnight minimums go
- **Temperature sensitivity**: Heat-driven load increase per region

**Step 3: ML Position Prediction**
- Trains regression model to predict where demand falls within [min, max] bounds
- Uses normalized features (hour, temperature, day type, etc.)
- Final forecast = min + position × (max - min)

#### Temperature Sensitivity by Time Period

| Time Period | Sensitivity Factor | Rationale |
|-------------|-------------------|-----------|
| Night (0-5h) | 0.4 | Low cooling load |
| Morning (6-11h) | 0.6 | Moderate sensitivity |
| Midday (12-16h) | 1.0 | Peak cooling demand |
| Evening (17-23h) | 0.5 | Declining but present |

#### Weekend Correction Factors

Learned from historical data to fix systematic weekend over-forecasting:

| Region | Saturday | Sunday | Impact |
|--------|----------|--------|--------|
| CLUZ (Luzon) | 0.947 | 0.951 | ~5% reduction |
| CVIS (Visayas) | 1.009 | 0.980 | Minor adjustments |
| CMIN (Mindanao) | 0.999 | 1.018 | Minimal correction |

These factors reduced weekend MAE from 500 MW to ~250 MW.

#### Performance

- **Measured accuracy:** 2-4% MAPE
- **Best for:** All regions, all day types
- **Usage:** `--model hybrid` (default)

---

### XGBoost Model

**File:** `src/models/xgboostModel.ts`

Gradient boosted tree ensemble trained on 50+ engineered features.

- **Hyperparameters:** maxDepth=10, learningRate=0.05, nEstimators=200
- **Features:** Full feature set including weather, temporal, and lag features
- **Performance:** 3-5% MAPE
- **Best for:** Complex non-linear patterns
- **Usage:** `--model xgboost`

---

### Linear Regression Model

**File:** `src/models/regressionModel.ts`

Simple linear regression baseline.

- **Features:** Standard feature set with polynomial terms
- **Performance:** 5-7% MAPE
- **Best for:** Baseline comparisons
- **Usage:** `--model regression`

---

## 2. Capacity Factor Forecasting

### Wind Models

#### 4-Tier MREC Hybrid (Default, Recommended)

**File:** `src/models/capacityFactor/Wind4TierMRECModel.ts`

Port of iPool's MREC (Must-Run Energy Conversion) algorithm with enhancements.

**Core Algorithm:**
```
CF = MRec_tier × WindSpeed
```

**Tier Structure:**

| Tier | Wind Percentile | Usage | Notes |
|------|----------------|-------|-------|
| HIGH | Top 10% (P90+) | Strong wind events | Highest efficiency |
| MID | 10-30% (P70-P90) | Moderate winds | Standard operation |
| LOW | Bottom 70% (P0-P70) | Light winds | Reduced efficiency |
| GUST | Region-specific | Peak gusts | Multiplier adjustment |

**Calibration Process:**
1. Calculate Probability of Exceedance (PoE) from historical wind speeds
2. Determine tier thresholds (vH, vL) from PoE distribution
3. Learn MRec coefficients for each tier via linear regression
4. Apply region-specific gust ratio adjustments

**Special Features:**
- **100m hub-height wind data:** Uses Visual Crossing's elevation-corrected wind speeds
- **High-wind cutout:** CF > 1.1 returns 0 (storm shutdown simulation)
- **Station-specific calibration:** Each wind farm has unique tier thresholds
- **Gust ratio enhancement:** 4th tier adds multiplicative gust factor

**Performance:**
- **Measured accuracy:** ~45% MAPE (typical for wind forecasting)
- **Best for:** All wind stations
- **Usage:** Default for wind stations with `cfac forecast2`

---

#### Enhanced Hybrid (MREC + Physics + ML)

**File:** `src/models/capacityFactor/WindEnhancedHybridModel.ts`

Adds physics-inspired boost and ML correction on top of MREC.

**Three-Layer Approach:**

1. **MREC Base:** Standard tiered wind speed conversion
2. **Physics Boost:** Power law adjustment for turbulence effects
3. **ML Correction:** Multiplicative factor from weather features
   - Features: gust ratio, cloud cover, temperature, pressure
   - Learns non-linear weather interactions

**Automatic Fallback:**
- Compares MREC-only vs ML-enhanced performance on validation set
- Falls back to MREC-only if ML degrades accuracy (logged as warning)
- Ensures robustness against overfitting

**Performance:**
- **Measured accuracy:** ~40-50% MAPE (varies by validation)
- **Best for:** Experimental wind forecasting

---

### Solar Models

#### Physics+ML Hybrid (Default, Recommended)

**File:** `src/models/capacityFactor/SolarHybridModel.ts`

Combines physics-based irradiance conversion with machine learning residual correction.

**Physics Base Model:**

```
CF = (GHI × irradianceScale / 1000) × tempFactor × systemLoss
```

**Component Breakdown:**

| Component | Value | Description |
|-----------|-------|-------------|
| **GHI** | Variable | Global Horizontal Irradiance (W/m²) from API |
| **irradianceScale** | 1.4 | Visual Crossing API calibration factor |
| **tempFactor** | 1 + tempCoeff × (cellTemp - 25) | PV temperature derating |
| **tempCoeff** | -0.003 | -0.3% per °C (silicon PV standard) |
| **cellTemp** | ambient + ((NOCT - 20) / 800) × GHI | Module operating temperature |
| **NOCT** | 43°C | Nominal Operating Cell Temperature |
| **systemLoss** | 0.92 | 8% loss (inverter, wiring, soiling) |

**ML Residual Learning:**

Trains regression model on: `residual = actual - physics_prediction`

**Features:**
- Normalized GHI (0-1000 W/m²)
- Cloud cover percentage
- Ambient temperature
- Hour sin/cos (diurnal pattern)
- Month (seasonal variation)
- Clear sky index (GHI / theoretical_max)

**Advanced Techniques:**
- **Recency weighting:** Exponential decay gives more weight to recent data
- **Asymmetric loss:** Optional 2x penalty for under-predictions (reduces bias)
- **Hourly correction factors:** Per-hour multiplicative adjustments
- **Bias correction:** Station-specific systematic error removal

**Performance:**
- **Measured accuracy:** ~16% MAPE
- **Best for:** All solar stations
- **Usage:** Default for solar with `--use-xgboost --asymmetric-loss`

**XGBoost Enhancement:**
- Gradient boosting handles non-linear irradiance-CF relationships better
- Quantile regression (alpha=0.3) for asymmetric loss
- 43% bias reduction vs linear regression

---

#### Solar Irradiance Model (Physics-Only)

**File:** `src/models/capacityFactor/SolarIrradianceModel.ts`

Pure physics-based conversion of Global Horizontal Irradiance to electrical output.

- Uses same physics formula as hybrid model (without ML correction)
- Baseline for comparison
- **Performance:** ~20-25% MAPE
- **Usage:** Embedded as base layer in SolarHybridModel

---

### Profile-Based Models (Non-Weather-Dependent)

These models use historical pattern matching for generation sources with minimal weather sensitivity.

#### Geothermal Model

**File:** `src/models/capacityFactor/GeothermalModel.ts`

**Characteristics:**
- Very stable baseload operation (80-95% CF)
- Minimal hourly/seasonal variation
- Maintenance outages are primary source of variation

**Profile Structure:**
- **Key:** `{stationCode}_{hour}`
- **Values:** Mean/median/std from training data
- **Prediction:** Historical hourly average with narrow confidence bounds

**Performance:**
- **Typical accuracy:** 3-5% MAPE (highly predictable)
- **Best for:** All geothermal stations

---

#### Biomass Model

**File:** `src/models/capacityFactor/BiomassModel.ts`

**Characteristics:**
- Strong seasonal pattern tied to sugar milling season
- **High season (Oct-May):** Bagasse available, 60-80% CF
- **Low season (Jun-Sep):** Limited fuel, 10-30% CF

**Profile Structure:**
- **Key:** `{stationCode}_{month}_{hour}`
- **Seasonal adjustment:** Month is critical grouping dimension
- **Hourly variation:** Moderate (follows baseload dispatch)

**Performance:**
- **Typical accuracy:** 15-25% MAPE (seasonal transitions add uncertainty)
- **Best for:** Sugar mill cogeneration plants

---

#### Hydro Model

**File:** `src/models/capacityFactor/HydroModel.ts`

**Two Types:**

**Run-of-River Hydro:**
- Follows seasonal rainfall patterns
- Optional precipitation adjustment from weather data
- **Profile key:** `{stationCode}_{month}_{hour}`

**Pumped Storage Hydro:**
- Dispatch-driven operation (arbitrage strategy)
- Morning pump, evening generation
- **Profile key:** `{stationCode}_{hour}`

**Performance:**
- **Run-of-river:** 20-30% MAPE (rainfall variability)
- **Storage:** 10-20% MAPE (more predictable dispatch)

---

#### Battery Model

**File:** `src/models/capacityFactor/BatteryModel.ts`

**Characteristics:**
- Price-driven charge/discharge arbitrage
- **Charging period:** Solar hours (10:00-14:00), CF < 0
- **Discharging period:** Evening peak (17:00-21:00), CF > 0
- Grid stabilization dispatch

**Profile Structure:**
- **Key:** `{stationCode}_{hour}`
- **Negative CF:** Charging (energy consumption)
- **Positive CF:** Discharging (energy injection)

**Performance:**
- **Typical accuracy:** 25-40% MAPE (dispatch uncertainty)
- **Best for:** Grid-scale battery storage systems

---

### Supporting Components

#### Bias Corrector

**File:** `src/models/capacityFactor/BiasCorrector.ts`

Learns and corrects systematic per-station forecasting bias.

**Process:**
1. Calculate bias during training: `bias = mean(predicted - actual)`
2. Store bias coefficient per station
3. Apply correction: `corrected = prediction - bias`

**When to Use:**
- Wind stations with consistent over/under-forecasting
- Stations with equipment degradation
- Enable with `--bias-correction` flag

**Impact:**
- 5-15% MAPE reduction for biased stations
- No impact on unbiased stations

---

#### XGBoost Regressor

**File:** `src/models/capacityFactor/CFacXGBoostRegressor.ts`

Lightweight gradient boosting implementation for ML layers.

**Hyperparameters:**

| Parameter | Default | Purpose |
|-----------|---------|---------|
| maxDepth | 6 | Tree depth (prevents overfitting) |
| learningRate | 0.1 | Step size shrinkage |
| nEstimators | 100 | Number of boosting rounds |
| minChildWeight | 1 | Minimum samples per leaf |
| subsample | 0.8 | Row sampling ratio |

**Special Features:**
- **Asymmetric loss:** Quantile regression (alpha=0.3) penalizes under-predictions 2x
- **Feature importance:** Tracks which features drive predictions
- **Early stopping:** Prevents overfitting on small datasets

**Usage:**
- Solar ML layer (with `--use-xgboost`)
- Wind Enhanced Hybrid ML correction
- Demand XGBoost model

---

#### Model Router

**File:** `src/models/capacityFactor/ModelRouter.ts`

Routes each station to its appropriate model based on station type detection.

**Detection Logic:**

1. **Suffix-based:** `_W`=Wind, `_S`=Solar, `_H`=Hydro, `_B`=Battery, `_G`=Geothermal, `_BI/_BG/_BL`=Biomass
2. **Explicit mappings:** Non-standard names (e.g., `01BURGOS`, `01LAOAG` → Wind)
3. **Default:** Profile-based fallback

**Routing Table:**

| Station Type | Model | File |
|--------------|-------|------|
| Wind | 4-Tier MREC Hybrid | Wind4TierMRECModel.ts |
| Solar | Physics+ML Hybrid | SolarHybridModel.ts |
| Geothermal | Profile | GeothermalModel.ts |
| Biomass | Profile | BiomassModel.ts |
| Hydro | Profile | HydroModel.ts |
| Battery | Profile | BatteryModel.ts |

---

## 3. Best Configuration by Station Type

| Type | Model | Recommended Flags | Measured Accuracy | Notes |
|------|-------|-------------------|-------------------|-------|
| **Demand** | Hybrid | `--model hybrid` | 2-4% MAPE | Default, best all-around |
| **Wind** | 4-Tier MREC Hybrid | `--bias-correction` | ~45% MAPE | Hub-height wind data critical |
| **Solar** | Physics+ML Hybrid | `--use-xgboost --asymmetric-loss` | ~16% MAPE | XGBoost + asymmetric = 43% bias reduction |
| **Geothermal** | Profile | (none) | 3-5% MAPE | Highly stable baseload |
| **Biomass** | Profile | (none) | 15-25% MAPE | Seasonal milling pattern |
| **Hydro** | Profile | (none) | 10-30% MAPE | Run-of-river vs storage |
| **Battery** | Profile | (none) | 25-40% MAPE | Price arbitrage driven |

---

## 4. Feature Engineering (Demand Model)

The demand forecasting model uses **50+ engineered features** combining temporal, weather, derived, and lag variables.

### Temporal Features (11)

| Feature | Type | Description |
|---------|------|-------------|
| hour | Integer (0-23) | Hour of day |
| dayOfWeek | Integer (0-6) | Day of week (0=Sunday) |
| isWeekend | Boolean | Saturday or Sunday |
| isHoliday | Boolean | Philippine public/bank/optional holiday |
| month | Integer (1-12) | Month of year |
| hourSin | Float | sin(2π × hour/24) - cyclical encoding |
| hourCos | Float | cos(2π × hour/24) - cyclical encoding |
| daySin | Float | sin(2π × dayOfWeek/7) |
| dayCos | Float | cos(2π × dayOfWeek/7) |
| monthSin | Float | sin(2π × month/12) |
| monthCos | Float | cos(2π × month/12) |

### Weather Features (9)

| Feature | Unit | Source | Description |
|---------|------|--------|-------------|
| temp | °C | Visual Crossing | Ambient temperature |
| tempSquared | °C² | Derived | Non-linear temp response |
| dew | °C | Visual Crossing | Dew point temperature |
| precip | mm | Visual Crossing | Precipitation |
| windgust | km/h | Visual Crossing | Wind gust speed |
| windspeed | km/h | Visual Crossing | Average wind speed |
| cloudcover | % | Visual Crossing | Cloud coverage |
| solarradiation | W/m² | Visual Crossing | Global Horizontal Irradiance |
| uvindex | Index | Visual Crossing | UV index |

### Derived Features (9)

| Feature | Formula | Description |
|---------|---------|-------------|
| relativeHumidity | Magnus formula | RH = 100 × exp((17.27×Td)/(237.3+Td)) / exp((17.27×T)/(237.3+T)) |
| heatIndex | Rothfusz equation | Apparent temperature from temp + humidity |
| CDH | max(0, T - 24) | Cooling Degree Hours (base 24°C) |
| effectiveSolar | radiation × (1 - cloudcover/100) | Cloud-adjusted solar |
| apparentTemp | temp + 0.33×humidity - 0.7×windspeed | Feels-like temperature |
| tempHumidityInteraction | temp × relativeHumidity | Combined heat stress |
| windChillFactor | Computed | Wind chill effect |
| solarHourlyFactor | hour-based multiplier | Solar contribution by hour |
| precipIntensity | precip / hour | Rainfall rate |

### Lag Features (8)

| Feature | Lag Period | Description |
|---------|------------|-------------|
| demandLag1h | 1 hour | Previous hour demand |
| demandLag24h | 24 hours | Same hour yesterday |
| demandLag168h | 168 hours (7 days) | Same hour last week |
| tempLag1h | 1 hour | Previous hour temperature |
| tempLag24h | 24 hours | Same hour yesterday temp |
| demandRolling24h | 24-hour window | Rolling average demand |
| tempRolling24h | 24-hour window | Rolling average temperature |
| tempMax24h | 24-hour window | Maximum temperature |

### Feature Filtering

**First 168 hours (7 days) filtered during training** to avoid lag feature initialization issues.

This ensures all lag features have valid historical data and prevents training on incomplete feature vectors.

---

## 5. Auto-Calibration

Auto-calibration reduces systematic forecast bias by comparing predictions vs actuals for a calibration period immediately before the forecast period.

### Calibration Process

**Step 1: Calibration Period Selection**
- Default: 14 days before forecast start date
- Requires actual data availability for this period
- Skip with `--no-auto-calibrate` flag

**Step 2: Bias Calculation**

**Per-Station Scaling:**
```
stationScale = mean(actual / predicted) for each station
```

**Per-Hour Scaling:**
```
hourScale[h] = mean(actual / predicted) for hour h across all stations
```

**Step 3: Correction Application**

```
corrected = prediction × stationScale × hourScale[hour]
```

**Step 4: Outlier Filtering**

Scaling factors are capped to prevent overcorrection:
- **Min scale:** 0.5 (don't reduce by more than 50%)
- **Max scale:** 1.5 (don't increase by more than 50%)

### Outage Filtering

**Purpose:** Remove zero-output periods from training data to prevent learning shutdown patterns as normal operation.

**Logic by Station Type:**

| Station Type | Filter Rule | Rationale |
|--------------|-------------|-----------|
| **Wind** | Remove all CF = 0 records | Zero wind is valid, but turbine shutdowns skew training |
| **Geothermal** | Remove all CF = 0 records | Baseload should never be zero (maintenance only) |
| **Solar** | Remove daytime zeros (6am-6pm) | Nighttime zero is normal; daytime zero is outage |
| **Hydro/Biomass/Battery** | Remove consecutive zero streaks >24 hours | Short zeros are dispatch; long zeros are outages |

**Implementation:**
- Applied during training data preparation
- Logged to console: "Filtered X outage records for station Y"
- Does NOT filter forecast period (predictions allowed to be zero)

### Calibration Impact

**Typical improvements:**
- **Demand:** 0.5-1.5% MAPE reduction
- **Solar:** 2-5% MAPE reduction (corrects seasonal GHI drift)
- **Wind:** 3-8% MAPE reduction (corrects short-term wind regime shifts)

**When calibration helps most:**
- Recent equipment changes (efficiency drift)
- Seasonal transitions (biomass, hydro)
- Weather regime changes (persistent high/low wind periods)

**When to disable:**
- No recent actual data available
- Forecasting for past periods (backtesting)
- Use `--no-auto-calibrate` flag

---

## 6. Model Selection Guide

### Quick Decision Tree

```
Are you forecasting demand or capacity factor?
├─ DEMAND
│  ├─ Need best accuracy? → Hybrid Model
│  ├─ Complex non-linear patterns? → XGBoost Model
│  └─ Simple baseline? → Linear Regression
│
└─ CAPACITY FACTOR
   ├─ Wind station?
   │  ├─ Production use? → 4-Tier MREC Hybrid (default)
   │  └─ Experimental? → Enhanced Hybrid with --smooth 0.5
   │
   ├─ Solar station?
   │  └─ Always use Physics+ML Hybrid with --use-xgboost --asymmetric-loss
   │
   └─ Other type (Geo/Biomass/Hydro/Battery)?
      └─ Profile-based model (automatic)
```

### Performance Summary

| Model Family | Best MAPE | Worst MAPE | Median MAPE | Notes |
|--------------|-----------|------------|-------------|-------|
| Demand Models | 2% | 7% | 3% | Hybrid consistently best |
| Wind Models | 35% | 60% | 45% | High variance typical for wind |
| Solar Models | 12% | 25% | 16% | XGBoost+asymmetric crucial |
| Geothermal | 2% | 8% | 4% | Most predictable |
| Biomass | 10% | 35% | 20% | Seasonal transitions tricky |
| Hydro | 8% | 40% | 18% | Run-of-river more variable |
| Battery | 20% | 50% | 30% | Dispatch uncertainty |

---

## Summary

The iLoad Forecasting Utility employs a **hybrid approach** combining physics-based models, statistical profiling, and machine learning to achieve state-of-the-art forecasting accuracy across diverse generation types in the Philippine power grid.

**Key Strengths:**
- Region-aware demand forecasting with weekend correction
- Physics-grounded capacity factor models (not pure ML black boxes)
- Station-type-specific optimization (solar ≠ wind ≠ biomass)
- Automatic calibration and bias correction
- Robust outage filtering

**Recommended Starting Point:**
```bash
# Demand forecast
node dist/index.js forecast -d "Data Samples/Demand" \
  -s 2025-12-01 -e 2025-12-31 -o output/demand.csv --model hybrid

# Capacity factor forecast
node dist/index.js cfac forecast2 -t "Data Samples/Capacity Factor" \
  -s 2025-12-01 -e 2025-12-31 -o output/cfac.csv \
  --use-xgboost --asymmetric-loss --bias-correction
```

For detailed command reference, see `CLI_GUIDE.md`.
