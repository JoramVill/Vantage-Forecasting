---
Status: Draft
Created: 2026-03-24
Updated-By: Claude
---

# Demand Forecast V2 — Shape/Level Architecture

**Vantage Forecaster — Next-Generation Demand Methodology**

Version: 2.1 Draft
Date: March 24, 2026
Classification: Technical Architecture Document

---

## 1. Design Principles

### 1.1 Unified Methodology

The pipeline is **area-agnostic**. Whether processing 3 regions or 14 zones, the code path is identical. The only difference is the input file:

| Mode     | Input Columns                  | Areas | Weather Stations |
|----------|--------------------------------|-------|------------------|
| Regional | `CLUZ, CVIS, CMIN`            | 3     | 3 (1 per region) |
| Zonal    | `01NLUZ, 02METRO, ... 14SWMIN` | 14    | 42 (3-6 per zone) |

There are **no** `if (zonal)` branches, no `enableZoneScaling` flags, no zone-to-parent hard fallbacks. Every area is treated as a first-class entity with identical processing logic.

### 1.2 Separate What From When

Every hourly forecast is the product of two independent predictions:

```
demand[area][hour] = dailyTotal[area] × shape[area][hour]
```

Where:
- `dailyTotal` answers: "How many total MW will this area consume today?"
- `shape` answers: "What fraction of that total falls in each hour?" (sums to 1.0)

### 1.3 Shape Is a First-Class Target

Shape is never an emergent side-effect. It is explicitly modeled, explicitly trained, and explicitly constrained (must sum to 1.0). This guarantees physically plausible daily profiles by construction.

### 1.4 Peaks and Troughs Are Preserved, Not Flattened

The most common failure mode in demand forecasting is peak-crushing — where peaks regress toward the mean and troughs get lifted, producing a forecast that looks statistically close but is useless for dispatch planning. The architecture prevents flattening through:

1. **Archetype-based profiles** — instead of a single blended median shape, the system clusters historical days into distinct shape patterns and selects the best match for current conditions. Each archetype retains its natural peak-to-trough amplitude.
2. **Asymmetric calibration** — calibration corrections mildly favor preserving peaks over flattening them.
3. **Amplitude monitoring** — automated checks flag when predicted shapes fall outside historical amplitude ranges.

Anti-flattening is applied at **one stage per pipeline step** to prevent overcorrection from compounding.

### 1.5 Train Once, Forecast Many

The system separates three distinct operations:

| Operation     | Frequency        | Inputs                              | Outputs            | Compute Cost |
|---------------|------------------|-------------------------------------|--------------------|--------------|
| **Train**     | Weekly/fortnightly | Months of demand + weather history | `model.vfm`        | Heavy        |
| **Calibrate** | Daily             | `model.vfm` + recent actuals (7d) | `calibration.json` | Light        |
| **Forecast**  | On demand         | `model.vfm` + `calibration.json` + weather forecast | Forecast CSV | Light |

Training is expensive and infrequent. Forecasting is cheap and stateless — it reads a saved model and calibration snapshot, applies them to new weather data, and produces output. No learning occurs during inference.

### 1.6 Operator Controllability

Every pipeline stage exposes tuning knobs that allow the operator to adjust behavior without modifying code. Defaults produce good results. Knobs provide targeted control when diagnostics indicate a specific stage needs adjustment.

---

## 2. Data Contracts

### 2.1 Input: Demand Data

Hourly demand in MW per area, hour-ending convention.

```
File: DemHr_YYYY_MMM.csv

DateTimeEnding,  01NLUZ, 02METRO, 03SLUZ, ..., 14SWMIN
12/1/2025 01:00, 3357,   2784,    2289,   ..., 383
12/1/2025 02:00, 3237,   2662,    2211,   ..., 377
...
```

- One row per hour (24 rows per day)
- Columns: `DateTimeEnding` + one column per area
- Values: integer MW
- Used during **Train** and **Calibrate** operations only — never during Forecast

### 2.2 Input: Weather Data

Hourly weather per station, hour-starting convention.

```
File: YYYY-MM-DD.csv

name,      latitude, longitude, datetime,            temp, dew, precip, windgust, windspeed, cloudcover, solarradiation, ...
Manila,    14.596,   120.977,   2026-01-01T00:00:00, 26.2, 22.8, 0,    10.4,     5.8,       95.9,       0,              ...
```

- One row per station per hour
- Timestamp alignment: weather hour-starting → demand hour-ending (add 1 hour)
- Multiple stations per area are averaged to produce area-level weather
- Historical weather used during **Train**; forecast weather used during **Forecast**

### 2.3 Output: Forecast

Same format as demand input — identical schema, forecast values instead of actuals.

```
DateTimeEnding, 01NLUZ,  02METRO, 03SLUZ, ..., 14SWMIN
3/25/2026 01:00, 3280.5, 2710.3,  2195.8, ..., 370.2
3/25/2026 02:00, 3150.1, 2590.8,  2110.2, ..., 355.7
...
```

### 2.4 Model Artifact: `model.vfm`

Serialized binary (MessagePack) produced by Train, consumed by Calibrate and Forecast.

Contains:
- Level Model weights (XGBoost)
- Shape Profile Library (archetypes per area × dayType)
- Shape Adjustment weights (Stage B regression coefficients)
- Area-to-station mapping used during training
- Training metadata (date range, area list, feature configuration)
- Configuration snapshot (all tuning parameters at time of training)

Does **not** contain calibration factors — these are stored separately.

### 2.5 Calibration Snapshot: `calibration.json`

Lightweight JSON produced by Calibrate, consumed by Forecast.

```json
{
  "calibrationDate": "2026-03-24",
  "modelVersion": "model_20260310.vfm",
  "calibrationDays": 7,
  "levelScale": {
    "01NLUZ": 1.03,
    "02METRO": 0.98,
    "03SLUZ": 1.01,
    "...": "..."
  },
  "shapeCorrection": {
    "01NLUZ": [1.01, 0.99, 0.98, "... 24 values"],
    "02METRO": [0.99, 1.00, 1.01, "... 24 values"],
    "...": "..."
  },
  "recentActuals": {
    "01NLUZ": {
      "2026-03-23": 85200,
      "2026-03-22": 87100,
      "2026-03-21": 82400,
      "...": "..."
    },
    "...": "..."
  },
  "metrics": {
    "levelMAPE": { "01NLUZ": 2.1, "02METRO": 1.8, "...": "..." },
    "shapeMAPE": { "01NLUZ": 1.5, "02METRO": 1.2, "...": "..." }
  }
}
```

The `recentActuals` field stores daily totals from the calibration period. Inference uses these to compute lag features for the first forecast day without needing access to the demand data directory.

---

## 3. Operational Lifecycle

### 3.1 Overview

```
┌────────────────────────────────────────────────────────────────────────────────┐
│                          OPERATIONAL LIFECYCLE                                  │
├────────────────────────────────────────────────────────────────────────────────┤
│                                                                                │
│   ┌─────────┐         ┌─────────────┐         ┌──────────┐                    │
│   │  TRAIN  │────────►│  CALIBRATE  │────────►│ FORECAST │                    │
│   └─────────┘         └─────────────┘         └──────────┘                    │
│   Every 2 weeks       Every day               On demand                       │
│   (or on trigger)     (when actuals arrive)   (as many times as needed)       │
│                                                                                │
│   Reads:              Reads:                  Reads:                           │
│   - Demand history    - model.vfm             - model.vfm                     │
│   - Weather history   - Recent demand         - calibration.json              │
│                         actuals (7 days)      - Weather forecast              │
│                                                                                │
│   Produces:           Produces:               Produces:                        │
│   - model.vfm         - calibration.json      - Forecast CSV                  │
│                                                                                │
│   Duration: Minutes   Duration: Seconds       Duration: Seconds               │
│                                                                                │
└────────────────────────────────────────────────────────────────────────────────┘
```

### 3.2 Train Operation

**When**: Scheduled (default every 14 days) or triggered by calibration drift.

**What it does**:
1. Loads historical demand data (default 90 days)
2. Fetches/loads corresponding weather data
3. Merges and aligns timestamps
4. Aggregates into daily records (totals + normalized shapes)
5. Trains Level Model (XGBoost on daily totals)
6. Builds Shape Profile Library (archetypes per area × dayType)
7. Trains Shape Adjustment model (Stage B weather corrections)
8. Serializes everything to `model.vfm`

**What it does NOT do**: calibration. The model artifact contains learned structure (patterns, relationships, profiles) but no recent-bias corrections.

**CLI**:
```bash
node dist/index.js train \
  -d "Data Samples/Demand" \
  -w "Data Samples/Weather" \
  --days 90 \
  -o models/model_20260324.vfm
```

### 3.3 Calibrate Operation

**When**: Daily, or whenever new actuals become available.

**What it does**:
1. Loads the saved `model.vfm`
2. Reads the most recent N days of actual demand (default 7)
3. Generates predictions for those days using the model
4. Compares predictions to actuals
5. Computes level scaling factors per area (ratio of actual/predicted daily totals)
6. Computes shape correction factors per area per hour (ratio of actual/predicted shapes)
7. Snapshots recent daily totals for lag features
8. Writes `calibration.json`

**What it does NOT do**: modify `model.vfm`. The model is read-only during calibration.

**CLI**:
```bash
node dist/index.js calibrate \
  -m models/model_20260324.vfm \
  -d "Data Samples/Demand" \
  --days 7 \
  -o models/calibration.json
```

### 3.4 Forecast Operation

**When**: On demand, as many times as needed.

**What it does**:
1. Loads `model.vfm` (structure and weights)
2. Loads `calibration.json` (recent bias corrections + lag actuals)
3. Loads weather forecast for the target period
4. For each area × day: predicts daily total, predicts shape, multiplies, applies calibration
5. Writes forecast CSV

**What it does NOT do**: any learning. No model weights change. No calibration factors change. Pure stateless prediction.

**CLI**:
```bash
node dist/index.js forecast \
  -m models/model_20260324.vfm \
  -c models/calibration.json \
  -s 2026-03-25 \
  -e 2026-03-31 \
  -o output/forecast.csv
```

**Reproducibility**: given the same `model.vfm`, `calibration.json`, and weather input, the forecast command produces identical output every time. If a forecast is questioned, the operator can reproduce it exactly by referencing the model version and calibration date.

### 3.5 Retrain Triggers

In addition to the scheduled retrain interval, the system monitors calibration factors for signs that the model is going stale.

**Automatic trigger conditions** (any one triggers a retrain alert):

| Condition | Threshold | Meaning |
|-----------|-----------|---------|
| Level scale drift | \|levelScale - 1.0\| > 0.08 for any area | Model is consistently 8%+ off on daily totals |
| Level scale persistence | Drift exceeded for 3+ consecutive calibration cycles | Not a one-off — systematic bias |
| Shape correction drift | mean(\|shapeCorrection - 1.0\|) > 0.10 for any area | Model's shape predictions are drifting |
| Calibration MAPE spike | Level or shape MAPE exceeds 2× the training validation MAPE | Performance has degraded significantly |

When triggered, the system logs a recommendation to retrain. Optionally, retraining can be automated via the lifecycle configuration.

### 3.6 Typical Operational Week

```
Monday AM:
  - Weekend actuals arrive
  - Calibration refresh runs → new calibration.json
  - Operator runs forecast for the week ahead

Wednesday:
  - Updated weather forecast available
  - Operator reruns forecast with same model.vfm + calibration.json
  - Only input changes: new weather data
  - Results in seconds

Friday:
  - Mon–Thu actuals now available
  - Calibration refresh runs → updated calibration.json
  - Operator reruns forecast for the weekend + next week

Every 2 weeks:
  - Scheduled full training runs (e.g., overnight Sunday)
  - New model.vfm produced
  - Next calibration refresh uses the new model
  - Old model.vfm archived for audit trail
```

---

## 4. System Architecture

### 4.1 Training Pipeline

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           TRAINING PIPELINE                                 │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌──────────────┐    ┌──────────────┐                                      │
│  │ Demand CSVs  │    │ Weather CSVs │                                      │
│  └──────┬───────┘    └──────┬───────┘                                      │
│         │                   │                                               │
│         └─────────┬─────────┘                                               │
│                   ▼                                                         │
│         ┌─────────────────────┐                                             │
│         │   Data Merger       │  Align timestamps, average weather          │
│         │   (per area)        │  per area, compute derived features         │
│         └─────────┬───────────┘                                             │
│                   │                                                         │
│                   ▼                                                         │
│         ┌─────────────────────┐                                             │
│         │   Daily Aggregator  │  For each area+day:                         │
│         │                     │  → dailyTotal (sum of 24 hours)             │
│         │                     │  → normalizedShape (each hour / total)      │
│         │                     │  → dailyWeatherSummary                      │
│         └─────────┬───────────┘                                             │
│                   │                                                         │
│          ┌────────┴────────┐                                                │
│          ▼                 ▼                                                │
│  ┌───────────────┐  ┌─────────────────┐                                    │
│  │  Level Model  │  │  Shape Model    │                                    │
│  │  Training     │  │  Training       │                                    │
│  │               │  │                 │                                    │
│  │  Target:      │  │  Stage A:       │                                    │
│  │  dailyTotal   │  │  Cluster into   │                                    │
│  │  (1 value)    │  │  archetypes     │                                    │
│  │               │  │                 │                                    │
│  │               │  │  Stage B:       │                                    │
│  │               │  │  Weather adj.   │                                    │
│  └───────┬───────┘  └────────┬────────┘                                    │
│          │                   │                                              │
│          └────────┬──────────┘                                              │
│                   ▼                                                         │
│         ┌─────────────────────┐                                             │
│         │  Serialize          │                                              │
│         │  → model.vfm        │                                              │
│         └─────────────────────┘                                             │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 4.2 Calibration Pipeline

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         CALIBRATION PIPELINE                                │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌──────────────┐    ┌──────────────┐                                      │
│  │  model.vfm   │    │ Recent Demand│                                      │
│  │  (read-only) │    │ Actuals (7d) │                                      │
│  └──────┬───────┘    └──────┬───────┘                                      │
│         │                   │                                               │
│         └─────────┬─────────┘                                               │
│                   ▼                                                         │
│         ┌─────────────────────────┐                                         │
│         │  Generate Predictions   │  Run model on calibration period        │
│         │  for Calibration Period │  (identical to inference, but with      │
│         │                         │  known actuals for comparison)          │
│         └─────────┬───────────────┘                                         │
│                   │                                                         │
│                   ▼                                                         │
│         ┌─────────────────────────┐                                         │
│         │  Compare to Actuals     │                                         │
│         │                         │                                         │
│         │  Level: actual_total    │                                         │
│         │         / predicted_total│                                        │
│         │                         │                                         │
│         │  Shape: actual_shape[h] │                                         │
│         │         / pred_shape[h] │                                         │
│         └─────────┬───────────────┘                                         │
│                   │                                                         │
│                   ▼                                                         │
│         ┌─────────────────────────┐                                         │
│         │  Compute Factors        │                                         │
│         │  + Snapshot Recent      │                                         │
│         │    Actuals for Lags     │                                         │
│         │  + Compute Diagnostics  │                                         │
│         └─────────┬───────────────┘                                         │
│                   │                                                         │
│                   ▼                                                         │
│         ┌─────────────────────────┐                                         │
│         │  Write                  │                                         │
│         │  calibration.json       │                                         │
│         └─────────────────────────┘                                         │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 4.3 Inference Pipeline

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          INFERENCE PIPELINE                                  │
│                     (stateless — no learning occurs)                         │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌──────────────┐  ┌─────────────────┐  ┌──────────────┐                   │
│  │  model.vfm   │  │calibration.json │  │Weather Fcast │                   │
│  │  (read-only) │  │  (read-only)    │  │              │                   │
│  └──────┬───────┘  └───────┬─────────┘  └──────┬───────┘                   │
│         │                  │                    │                            │
│         └──────────┬───────┴────────────────────┘                           │
│                    ▼                                                         │
│         ┌──────────────────┐                                                │
│         │ Feature Engineer  │  Daily summary + hourly trajectory per area   │
│         │ + Load lags from  │  Lag features from calibration.json           │
│         │   calibration     │  recentActuals                               │
│         └────────┬─────────┘                                                │
│                  │                                                           │
│           ┌──────┴──────┐                                                   │
│           ▼             ▼                                                    │
│  ┌────────────┐  ┌────────────┐                                             │
│  │   Level    │  │   Shape    │                                             │
│  │   Model    │  │   Model    │                                             │
│  │            │  │            │                                             │
│  │ → daily   │  │ → 24h      │                                             │
│  │   total    │  │   profile  │                                             │
│  └─────┬──────┘  └─────┬──────┘                                             │
│        │               │                                                    │
│        └───────┬───────┘                                                    │
│                ▼                                                             │
│  ┌──────────────────────┐                                                   │
│  │ Combine & Calibrate   │                                                  │
│  │                       │                                                  │
│  │ total *= levelScale   │                                                  │
│  │ shape *= shapeCorr    │                                                  │
│  │ renormalize shape     │                                                  │
│  │ hourly = total × shape│                                                  │
│  └──────────┬───────────┘                                                   │
│             │                                                               │
│             ▼                                                               │
│  ┌──────────────────────┐                                                   │
│  │ Validate & Output     │  Amplitude check, sanity clamps                  │
│  │ → Forecast CSV        │                                                  │
│  └──────────────────────┘                                                   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 5. Component Design

### 5.1 Data Merger

**Responsibility**: Join demand and weather data into a unified dataset per area.

**Inputs**:
- Demand CSVs (hour-ending)
- Weather CSVs (hour-starting, per station)

**Process**:
1. Parse demand data → `Map<area, Map<datetime, MW>>`
2. Parse weather data → `Map<station, Map<datetime, WeatherRow>>`
3. Shift weather timestamps +1 hour to align with hour-ending demand convention
4. Average weather across stations belonging to each area (using area-to-station mapping)
5. Inner join on datetime: only keep hours where both demand and weather exist

**Output**: `MergedDataset` — array of `{ datetime, area, demand_mw, weather }` records

**Station-to-Area Mapping** (configuration, not code logic):

```json
{
  "01NLUZ": ["San Fernando", "Baguio", "Tuguegarao", "Laoag", "Dagupan", "Angeles"],
  "02METRO": ["Manila", "Quezon City", "Makati"],
  "03SLUZ": ["Batangas", "Lucena", "Legazpi"],
  "...": "...",
  "14SWMIN": ["General Santos", "Koronadal", "Cotabato"]
}
```

For regional mode, the mapping simply groups differently:
```json
{
  "CLUZ": ["Manila"],
  "CVIS": ["Cebu City"],
  "CMIN": ["Davao City"]
}
```

The code doesn't know or care which mode it's in. It reads the demand columns, reads the station mapping, and processes each area identically.

---

### 5.2 Daily Aggregator

**Responsibility**: Transform hourly merged data into daily training records for both models.

**Inputs**: `MergedDataset` from Data Merger

**Process** (for each area + calendar day):

1. **Daily Total**:
   ```
   dailyTotal = sum(demand_mw for hours 01:00..00:00)
   ```

2. **Normalized Shape** (24-element vector summing to 1.0):
   ```
   shape[h] = demand_mw[h] / dailyTotal    for h in 0..23
   ```

3. **Daily Weather Summary** (for Level Model):
   ```
   avgTemp, maxTemp, minTemp, tempRange, CDH, totalPrecip, avgCloudCover, totalSolar
   ```

4. **Hourly Weather Trajectory** (for Shape Model):
   ```
   tempTrajectory[0..23], cloudTrajectory[0..23], solarTrajectory[0..23]
   peakTempHour, morningRampRate, eveningCoolRate
   ```

5. **Calendar Features** (shared by both models):
   ```
   dayOfWeek, isWeekend, isSaturday, isSunday, isHoliday, isWorkday, month
   dayType = workday | saturday | sunday | holiday
   ```

**Output**: `DailyRecord[]` — one per area per day

```typescript
interface DailyRecord {
  date: string;
  area: string;
  dailyTotal: number;
  shape: number[];               // length 24, sums to 1.0
  hourlyDemand: number[];        // length 24, raw MW values
  dailyWeather: DailyWeather;    // aggregated summary
  hourlyWeather: HourlyWeather[];// 24-element trajectory
  calendar: CalendarFeatures;
}
```

---

### 5.3 Level Model

**Responsibility**: Predict total daily demand (MW) for a given area and day.

**Target**: `dailyTotal` (single number per area per day)

**Why this is easier than hourly prediction**: One stable target per day, smoothed across hourly noise, strong correlation with daily weather aggregates.

#### 5.3.1 Features

**Weather features** (~10):

| Feature          | Description                        | Rationale                                  |
|------------------|------------------------------------|--------------------------------------------|
| `avgTemp`        | Mean daily temperature             | Primary demand driver                      |
| `maxTemp`        | Peak temperature                   | Peak cooling load                          |
| `CDH`            | Cooling degree-hours (base 24°C)   | Cumulative thermal load                    |
| `totalPrecip`    | Total precipitation                | Suppresses cooling need                    |
| `avgCloudCover`  | Mean cloud cover                   | Reduces solar gain → less AC               |
| `totalSolar`     | Total solar irradiance             | Direct heating load                        |
| `tempRange`      | Max - min temperature              | Wider range → more AC cycling              |
| `avgHeatIndex`   | Mean feels-like temperature        | Captures humidity effect                   |

**Calendar features** (~6):

| Feature          | Description                        |
|------------------|------------------------------------|
| `dayType`        | One-hot: workday, saturday, sunday, holiday |
| `month`          | Cyclical encoding (sin/cos)        |
| `dayOfMonth`     | Integer 1-31                       |

**Lag features** (~5):

| Feature            | Description                        |
|--------------------|------------------------------------|
| `totalYesterday`   | Yesterday's daily total            |
| `totalLastWeek`    | Same weekday last week             |
| `totalRolling7d`   | 7-day rolling average              |
| `totalRolling30d`  | 30-day rolling average             |
| `trendWeek`        | (rolling7d - rolling30d) / rolling30d |

**Area encoding** (1):

| Feature            | Description                        |
|--------------------|------------------------------------|
| `areaIdx`          | Integer index for the area         |

Total: ~22 features

#### 5.3.2 Model Type

**Primary**: Gradient-boosted trees (XGBoost) with symmetric MSE loss.

```json
{
  "maxDepth": 5,
  "nEstimators": 100,
  "learningRate": 0.1,
  "minChildWeight": 10,
  "subsample": 0.8,
  "colsampleBytree": 0.8,
  "validationSplit": 0.2
}
```

**Fallback**: If insufficient training data (<30 days), use statistical model:
```
dailyTotal = median(historicalTotals[area][dayType]) × (1 + tempCoeff × (avgTemp - baseTemp))
```

#### 5.3.3 Training

1. Generate `DailyRecord[]` from training data
2. Compute lag features (skip first 7 days for warmup)
3. Split into train (first 80%) and validation (last 20%) chronologically
4. Fit XGBoost on training set
5. Evaluate on validation set, record metrics
6. Store model weights in `model.vfm`

---

### 5.4 Shape Model

**Responsibility**: Predict the normalized 24-hour demand profile for a given area and day.

**Target**: `shape[0..23]` — 24 values that sum to 1.0

#### 5.4.1 Stage A: Profile Library with Archetypes

Instead of a single median shape per `{area, dayType}`, the system clusters historical days into **archetype profiles** that preserve the natural peak-to-trough amplitude of each pattern.

**Why archetypes prevent flattening**: Real demand days for a given area and day type don't all have the same shape. Some peak sharply at hour 14, others plateau from 13-16, others shift to evening. Taking the element-wise median across all of them blends these patterns into a flat, featureless shape that matches none of them. Archetypes preserve distinct patterns by grouping similar days together.

**Clustering process**:

For each `{area, dayType}` combination:

1. Collect all historical normalized shapes (24-element vectors)
2. Run k-means clustering with `k = archetypeCount` (default 3)
3. Each cluster centroid becomes an archetype profile
4. For each archetype, also store:
   - Mean weather conditions of the days in that cluster
   - Sample count (how many days belong to this archetype)
   - Peak-to-trough ratio (amplitude measure)

```typescript
interface ArchetypeProfile {
  shape: number[];               // 24 values, sums to 1.0
  centroidWeather: {             // average conditions for this cluster
    avgTemp: number;
    maxTemp: number;
    tempRange: number;
    avgCloudCover: number;
    totalPrecip: number;
  };
  sampleCount: number;
  peakToTroughRatio: number;     // max(shape) / min(shape)
}

interface ProfileLibraryEntry {
  area: string;
  dayType: string;
  archetypes: ArchetypeProfile[];  // length = archetypeCount
  overallMedian: number[];         // fallback: traditional median shape
}
```

**Archetype selection at inference**:

Given the weather forecast for a day, select the archetype whose `centroidWeather` is closest (Euclidean distance on normalized weather features). Then blend between the selected archetype and the overall median using `archetypeBlending`:

```
baseShape = archetypeBlending × selectedArchetype.shape
          + (1 - archetypeBlending) × overallMedian
```

At `archetypeBlending = 1.0`, you get the pure archetype (maximum peak preservation). At `0.0`, you get the flat median (V1 behavior). Default is `0.8`.

**Hierarchical smoothing** (for sparse areas):

```
effectiveShape = α × areaShape + (1 - α) × parentShape
α = min(1.0, sampleCount / confidenceThreshold)
```

Where `confidenceThreshold` defaults to 50. Parent mapping is configuration:

```json
{
  "01NLUZ": "CLUZ", "02METRO": "CLUZ", "03SLUZ": "CLUZ",
  "04LEYTE": "CVIS", "05CEBU": "CVIS", "06NEGROS": "CVIS",
  "07BOHOL": "CVIS", "08PANAY": "CVIS",
  "09NWMIN": "CMIN", "10LANAO": "CMIN", "11NCMIN": "CMIN",
  "12NEMIN": "CMIN", "13SEMIN": "CMIN", "14SWMIN": "CMIN"
}
```

For regional mode, no parent exists — `α` is always 1.0 (regions have abundant data).

#### 5.4.2 Stage B: Weather-Based Shape Adjustment

The archetype provides a strong baseline. Stage B applies small corrections based on specific weather conditions that shift the shape within the archetype's general pattern.

**Adjustment features**:

| Feature             | Description                                           |
|---------------------|-------------------------------------------------------|
| `peakTempHour`      | Hour of daily max temperature (shifts peak timing)    |
| `morningRampRate`   | °C/hour from 6 AM to noon                             |
| `eveningCoolRate`   | °C/hour from 3 PM to 9 PM                             |
| `tempRange`         | Daily max - min (wide range → sharper shape)          |
| `avgTemp`           | Mean daily temp (hot → flatter AC-driven shape)       |
| `avgCloudCover`     | Mean cloud cover (clouds → less midday solar peak)    |
| `isDaytimeRain`     | Precipitation during 09:00-18:00                      |
| `baseShape`         | The 24 values from Stage A (the starting point)       |

**Adjustment model**: Per-hour linear corrections.

```
For each hour h:
  rawAdjustment[h] = Σ(βᵢ × featureᵢ)
  adjustedShape[h] = baseShape[h] + weatherInfluence × rawAdjustment[h]

Renormalize:
  finalShape[h] = adjustedShape[h] / sum(adjustedShape)
```

The `weatherInfluence` parameter (default 1.0) controls how much Stage B modifies the archetype. At 0.0, the archetype passes through untouched.

**Model variant**: Default is `"linear"`. Can be switched to `"quantile"` in configuration if diagnostics show systematic peak flattening at this stage. Quantile mode uses asymmetric loss (α=0.70) that penalizes under-predicting peak hours more than over-predicting them.

#### 5.4.3 Training

1. For each `{area, dayType}`: collect all historical normalized shapes
2. Cluster into archetypes (k-means, k = `archetypeCount`)
3. Apply hierarchical smoothing for sparse areas
4. For each training day: select nearest archetype → compute residual (`actualShape - baseShape`)
5. Train linear regression per hour on weather features to predict residuals (Stage B)
6. Validate: all predicted shapes sum to 1.0 after renormalization

---

### 5.5 Combiner

**Responsibility**: Multiply level and shape to produce hourly MW forecasts.

**Process**:
```
For each area, for each forecast day:
  dailyTotal = LevelModel.predict(area, day, dailyWeather, lags)
  shape = ShapeModel.predict(area, day, hourlyWeather)

  For h in 0..23:
    forecast[area][h] = dailyTotal × shape[h]
```

**Post-combination validation**:
- `sum(forecast[area][0..23])` equals `dailyTotal` (by construction)
- No individual hour exceeds 2× the historical median for that area + hour (sanity clamp)
- No individual hour below 0.3× the historical median (sanity clamp)

---

### 5.6 Calibrator

**Responsibility**: Learn and apply bias corrections from recent known actuals.

Because shape/level separation already handles most structural bias, the calibrator's job is small — correcting recent drift and systematic residuals.

#### 5.6.1 Level Calibration

A single daily scaling factor per area:

```
levelScale[area] = mean(actualTotal[area][day] / predictedTotal[area][day])
                   for day in calibrationPeriod
```

Clamped to `levelClamp` (default `[0.90, 1.10]`).

Applied at inference:
```
calibratedTotal = predictedTotal × levelScale[area]
```

#### 5.6.2 Shape Calibration

Per-hour correction factors per area:

```
For each area, for each hour h:
  shapeCorrection[area][h] = mean(actualShape[area][day][h] / predictedShape[area][day][h])
                              for day in calibrationPeriod
```

**Asymmetric clamping** (controlled by `peakBias`):

The clamp bounds for each hour depend on whether it's a peak, trough, or shoulder hour for this area:

```
peakHours   = top 6 hours by historical shape median
troughHours = bottom 6 hours by historical shape median
shoulderHours = remaining 12 hours

For peak hours:
  lowerClamp = shapeClamp[0]                          // e.g., 0.88
  upperClamp = shapeClamp[1] + peakBias × 0.06        // e.g., 1.12 + 0.3 × 0.06 = 1.138

For trough hours:
  lowerClamp = shapeClamp[0] - peakBias × 0.06        // e.g., 0.88 - 0.3 × 0.06 = 0.862
  upperClamp = shapeClamp[1]                           // e.g., 1.12

For shoulder hours:
  lowerClamp = shapeClamp[0]                           // symmetric
  upperClamp = shapeClamp[1]                           // symmetric
```

At `peakBias = 0.0`, all hours get symmetric clamps. At `peakBias = 1.0`, peak hours can be boosted up to +18% and troughs reduced down to -18%. Default `0.3` provides mild asymmetry.

After applying corrections, renormalize shape to sum to 1.0.

#### 5.6.3 Combined Application

```
finalForecast[area][h] = (dailyTotal × levelScale[area]) × calibratedShape[h]
```

---

### 5.7 Amplitude Monitor

**Responsibility**: Detect when predicted shapes have abnormal peak-to-trough amplitude.

**Not a correction stage by default** — this is observability. The monitor compares the predicted amplitude against the historical range and flags anomalies.

```
predictedAmplitude = max(finalShape) / min(finalShape)
historicalRange = [percentile(amplitudeRange[0], historicalAmplitudes),
                   percentile(amplitudeRange[1], historicalAmplitudes)]
```

**In "monitor" mode** (default): logs a warning if predicted amplitude is outside historical range. No forecast modification.

**In "correct" mode**: if predicted amplitude is below the historical lower bound (shape is too flat), stretches the shape toward the nearest archetype's amplitude:

```
if predictedAmplitude < historicalRange.lower:
  targetAmplitude = historicalRange.lower
  stretchFactor = targetAmplitude / predictedAmplitude
  stretchedShape = stretch shape toward peaks and away from troughs by stretchFactor
  renormalize to sum to 1.0
```

This is the safety net. If archetypes and calibration both fail to preserve adequate peak-to-trough contrast, the amplitude monitor catches it.

---

## 6. Feature Engineering Detail

### 6.1 Weather Feature Pipeline

```
Raw Station Data (per station, hourly)
    │
    ▼
Average Across Stations (per area, hourly)
    │
    ├──► Hourly Features (for Shape Model)
    │    - tempTrajectory[0..23]
    │    - cloudTrajectory[0..23]
    │    - solarTrajectory[0..23]
    │    - peakTempHour
    │    - morningRampRate
    │    - eveningCoolRate
    │
    └──► Daily Features (for Level Model)
         - avgTemp, maxTemp, minTemp, tempRange
         - CDH (cooling degree hours, base 24°C)
         - totalPrecip
         - avgCloudCover, totalSolar
         - avgHeatIndex
```

### 6.2 Derived Features

**Heat Index** (Rothfusz regression):
```
If temp > 26.7°C and humidity > 40%:
  HI = -8.785 + 1.611T + 2.339RH - 0.146T×RH - 0.013T² - 0.016RH²
       + 0.002T²×RH + 0.001T×RH² - 0.000004T²×RH²
Else:
  HI = temp
```

**Cooling Degree Hours**:
```
CDH = sum(max(0, temp[h] - 24) for h in 0..23)
```

**Relative Humidity** (Magnus formula):
```
RH = 100 × exp((17.27 × dew) / (237.7 + dew)) / exp((17.27 × temp) / (237.7 + temp))
```

### 6.3 Lag Features During Inference

Lag features require recent actual demand data. During inference, these come from the `calibration.json` snapshot:

**Day 1 of forecast**: lags computed from `recentActuals` in calibration.json
**Day 2+**: lags computed from the previous day's forecast output (rolling forward)

```
Day 1: totalYesterday = recentActuals[area][calibrationDate]
Day 2: totalYesterday = forecast[area][Day 1].sum()
Day 3: totalYesterday = forecast[area][Day 2].sum()
...
```

The `totalRolling7d` feature blends actuals and forecasts as the horizon extends:
```
rolling7d[Day N] = mean(mix of actuals and forecasts for prior 7 days)
```

This naturally degrades as the horizon extends, which is appropriate — longer-horizon forecasts rely more on weather and calendar features, less on lag momentum.

---

## 7. Operator Configuration

### 7.1 Full Configuration File

```json
{
  "demand": {
    "geography": "zonal",
    "areaMapping": "zones.json",
    "growthRate": 0
  },
  "level": {
    "model": "xgboost",
    "maxDepth": 5,
    "nEstimators": 100,
    "learningRate": 0.1,
    "validationSplit": 0.2
  },
  "shape": {
    "archetypeCount": 3,
    "archetypeBlending": 0.8,
    "smoothingEnabled": true,
    "confidenceThreshold": 50,
    "recentDays": 7,
    "weatherInfluence": 1.0,
    "adjustmentModel": "linear"
  },
  "calibration": {
    "enabled": true,
    "days": 7,
    "levelClamp": [0.90, 1.10],
    "shapeClamp": [0.88, 1.12],
    "peakBias": 0.3
  },
  "validation": {
    "amplitudeCheck": "monitor",
    "amplitudeRange": [25, 75]
  },
  "training": {
    "days": 90,
    "lagWarmupDays": 7
  },
  "lifecycle": {
    "retrainSchedule": "14d",
    "calibrationSchedule": "1d",
    "retrainTrigger": {
      "levelDriftThreshold": 0.08,
      "shapeDriftThreshold": 0.10,
      "consecutiveDaysOverThreshold": 3,
      "mapeMultiplierThreshold": 2.0
    },
    "autoRetrain": false
  }
}
```

### 7.2 Stage-by-Stage Tuning Guide

Each pipeline stage has one or two primary knobs. Defaults produce good results. Adjust only when diagnostics point to a specific stage.

#### Stage 1: Profile Selection (Archetypes)

| Parameter | Default | Range | Effect |
|-----------|---------|-------|--------|
| `archetypeCount` | 3 | 1-5 | How many distinct shape patterns per {area, dayType}. 1 = single median (V1 behavior). Higher = finer distinction but needs more data per cluster. |
| `archetypeBlending` | 0.8 | 0.0-1.0 | **Primary sharpness control.** 1.0 = pure archetype (maximum peak preservation). 0.0 = flat median. This is the first knob to turn if shapes are too flat or too sharp. |

**Mental model**: "I have 3 typical day shapes for this area. Blending controls how committed I am to picking one versus hedging toward the average."

#### Stage 2: Weather Adjustment (Shape Model Stage B)

| Parameter | Default | Range | Effect |
|-----------|---------|-------|--------|
| `weatherInfluence` | 1.0 | 0.0-2.0 | How much weather modifies the archetype shape. 0.0 = archetype passes through untouched. Reduce if weather forecasts in your region are unreliable. |
| `adjustmentModel` | "linear" | "linear" / "quantile" | Loss function for Stage B training. "quantile" uses asymmetric loss that protects peaks. Switch to this if linear is systematically flattening after Stage B. |

**Mental model**: "How much do I trust today's weather forecast to change the shape? And should the correction be symmetric or peak-protective?"

#### Stage 3: Calibration

| Parameter | Default | Range | Effect |
|-----------|---------|-------|--------|
| `calibrationDays` | 7 | 3-30 | Days of recent actuals used. Fewer = faster adaptation, noisier. More = more stable, slower to adapt. |
| `levelClamp` | [0.90, 1.10] | [0.80, 1.20] max | How far daily total can be adjusted. Widen if seeing consistent level errors. |
| `shapeClamp` | [0.88, 1.12] | [0.80, 1.20] max | How far individual hours can be adjusted. |
| `peakBias` | 0.3 | 0.0-1.0 | **Peak protection control.** 0.0 = fully symmetric clamps. Higher = peak hours get wider upward clamps, trough hours get wider downward clamps. Increase if calibration is flattening peaks. |

**Mental model**: "How much do I let recent days adjust the forecast, and how much do I want to protect the natural contrast between peaks and troughs?"

#### Stage 4: Validation (Amplitude Monitoring)

| Parameter | Default | Range | Effect |
|-----------|---------|-------|--------|
| `amplitudeCheck` | "monitor" | "monitor" / "correct" | Monitor = log warnings only. Correct = auto-stretch flat shapes to match historical amplitude range. |
| `amplitudeRange` | [25, 75] | [10, 90] max | Percentile range of historical amplitudes considered "normal." Narrower = more sensitive, more corrections/warnings. |

**Mental model**: "Should the system auto-fix weird-looking shapes, or just tell me about them?"

### 7.3 Troubleshooting Guide

#### Shape Issues

| Symptom | Likely Cause | First Fix | Second Fix | Third Fix |
|---------|-------------|-----------|------------|-----------|
| Peaks too flat overall | Archetype blending too conservative | ↑ `archetypeBlending` → 1.0 | ↑ `peakBias` → 0.5 | Switch `adjustmentModel` to "quantile" |
| Peaks too sharp / exaggerated | Overcorrection compounding | ↓ `archetypeBlending` → 0.5 | ↓ `peakBias` → 0.0 | ↓ `archetypeCount` to 2 |
| Morning ramp timing off | Weather adjustment underfit | ↑ `weatherInfluence` → 1.5 | Check `morningRampRate` feature quality | Consider "quantile" adjustment model |
| Weekend shape wrong | Weekend archetypes insufficient | ↑ `archetypeCount` to 4-5 | Check weekend sample counts per area | Increase training data window |

#### Level Issues

| Symptom | Likely Cause | First Fix | Second Fix | Third Fix |
|---------|-------------|-----------|------------|-----------|
| Total MW consistently high/low | Model drift | Widen `levelClamp` | ↑ `calibrationDays` for stability | Trigger retrain |
| Level good Day 1, degrades Day 3+ | Lag propagation decay | Expected (normal) | Improve weather forecast quality | N/A |
| Calibration factors hitting clamps | Model is stale | Trigger retrain | Widen clamps temporarily | ↑ `calibrationDays` |

#### Area-Specific Issues

| Symptom | Likely Cause | First Fix | Second Fix |
|---------|-------------|-----------|------------|
| One zone bad, others fine | Sparse data or weather station issue | Check `confidenceThreshold` is met | Check weather station data quality |
| Small zone volatile | Insufficient samples for stable archetypes | ↓ `confidenceThreshold` | ↑ training data window |
| Calibration drift alert firing | Demand patterns have shifted | Run full retrain | Check for structural grid changes |

#### Lifecycle Issues

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| Forecasts not reproducible | Using different calibration.json | Ensure same model.vfm + calibration.json + weather input |
| Calibration taking too long | Too many calibration days | ↓ `calibrationDays` |
| Retrain alerts too frequent | Thresholds too tight | ↑ `levelDriftThreshold` and `shapeDriftThreshold` |
| Retrain alerts never fire | Thresholds too loose | ↓ thresholds, or check if calibration is masking drift |

---

## 8. Comparison With V1

| Aspect                   | V1 (Current)                           | V2 (Shape/Level)                     |
|--------------------------|----------------------------------------|--------------------------------------|
| **Prediction target**    | Hourly MW directly                     | Daily total × hourly fraction        |
| **Shape modeling**       | Implicit (side-effect of bounds)       | Explicit (first-class target)        |
| **Shape guarantee**      | None (hours are independent)           | Sums to 1.0 by construction         |
| **Peak preservation**    | Quantile loss in XGBoost cal.          | Archetypes + mild asymmetric cal.    |
| **Weekend correction**   | Single scalar per day type             | Separate archetype profiles per day type |
| **Zone vs region logic** | Divergent code paths                   | Identical pipeline                   |
| **Zone scaling**         | `enableZoneScaling` flag               | None needed (unified)                |
| **Zone fallback**        | Hard switch to parent                  | Hierarchical smoothing (weighted)    |
| **Calibration**          | 2-pass (iterative + XGBoost)           | Simple level + shape corrections     |
| **Weather in shape**     | Per-hour temp adjustment (independent) | Daily trajectory (cross-hour aware)  |
| **Operational lifecycle**| Train-and-forecast every time          | Train once, calibrate daily, forecast on demand |
| **Reproducibility**      | Non-reproducible (retrain each run)    | Fully reproducible (model + cal. + weather = output) |
| **Operator control**     | Limited config options                 | Stage-by-stage tuning knobs          |

### What V1 Components Are Retained

| V1 Component                       | V2 Status                                      |
|------------------------------------|-------------------------------------------------|
| Feature engineering (weather)      | Retained, split into daily vs hourly            |
| Statistical profiles               | Evolved into Shape Profile Library (archetypes) |
| Temperature coefficients           | Absorbed into Level Model features              |
| Holiday detection                  | Retained unchanged                              |
| Weather fetching (Visual Crossing) | Retained unchanged                              |
| Model serialization (.vfm)         | Retained, updated schema                        |

### What V1 Components Are Removed

| V1 Component                   | Reason for Removal                              |
|--------------------------------|-------------------------------------------------|
| `enableZoneScaling`            | Unified methodology — no zone-specific logic    |
| `zoneScale` in iterative cal.  | No separate zone calibration needed             |
| Zone-to-parent hard fallback   | Replaced by hierarchical smoothing              |
| `isPeakHour()` binary split    | No longer needed — shape model handles timing   |
| `getTimePeriodSensitivity()`   | Absorbed into shape model weather adjustments   |
| `weekendCorrectionFactors` map | Replaced by day-type archetype profiles         |
| Iterative Scaling Calibrator   | Replaced by simple level calibration            |
| XGBoost Quantile Calibrator    | Replaced by simple shape calibration            |
| Combined train+forecast flow   | Separated into three distinct operations        |

---

## 9. Performance & Diagnostics

### 9.1 Expected Metrics

| Metric           | V1 Zonal | V2 Expected | Rationale                               |
|------------------|----------|-------------|-----------------------------------------|
| Overall MAPE     | 3-4%     | 2-3%        | Better shape → fewer large hourly errors |
| Weekend MAPE     | 5-7%     | 2-4%        | Largest improvement — explicit profiles  |
| Peak hour error  | 4-6%     | 2-3%        | Shape model + archetypes preserve peaks  |
| Shape correlation| ~0.92    | >0.97       | Direct shape optimization               |

### 9.2 Diagnostic Metrics

V2 introduces shape-specific metrics that enable targeted debugging ("Is the level wrong?" vs "Is the shape wrong?").

**Level diagnostics** (computed during calibration):

| Metric          | Formula                                              | Good   | Investigate |
|-----------------|------------------------------------------------------|--------|-------------|
| Level MAPE      | mean(\|actualTotal - predictedTotal\| / actualTotal) | < 3%   | > 5%        |
| Level bias       | mean((predictedTotal - actualTotal) / actualTotal)   | ±0.5%  | > ±2%       |

**Shape diagnostics** (computed during calibration):

| Metric             | Formula                                           | Good   | Investigate |
|--------------------|---------------------------------------------------|--------|-------------|
| Shape MAPE         | mean(\|actualShape[h] - predShape[h]\| / actualShape[h]) | < 2% | > 4% |
| Peak hour accuracy | \|argmax(actualShape) - argmax(predShape)\|       | 0 hours | > 1 hour   |
| Profile correlation | pearsonCorrelation(actualShape, predShape)       | > 0.97 | < 0.93     |
| Amplitude ratio    | predicted(max/min) / actual(max/min)               | 0.9-1.1 | < 0.8 or > 1.2 |

**Retrain trigger diagnostics** (computed each calibration cycle):

| Metric          | Threshold                              | Action             |
|-----------------|----------------------------------------|--------------------|
| Level drift     | \|levelScale - 1.0\| > 0.08 for 3+ days | Recommend retrain |
| Shape drift     | mean(\|shapeCorr - 1.0\|) > 0.10        | Recommend retrain |
| MAPE spike      | > 2× training validation MAPE           | Recommend retrain |

---

## 10. File & Module Structure

```
src/
├── models/
│   ├── LevelModel.ts              # Daily total prediction (XGBoost)
│   ├── ShapeModel.ts              # 24h profile prediction
│   │   ├── ProfileLibrary.ts      #   Stage A: archetype clustering + smoothing
│   │   └── ShapeAdjuster.ts       #   Stage B: weather-based corrections
│   ├── Calibrator.ts              # Level scale + shape correction factors
│   ├── ForecastCombiner.ts        # Multiply level × shape + sanity checks
│   └── AmplitudeMonitor.ts        # Peak-to-trough validation
│
├── features/
│   ├── DailyFeatures.ts           # Weather/calendar features for Level Model
│   ├── ShapeFeatures.ts           # Trajectory features for Shape Model
│   ├── LagProvider.ts             # Lag computation with forecast propagation
│   └── CalendarFeatures.ts        # Holiday detection, day type classification
│
├── data/
│   ├── DataMerger.ts              # Join demand + weather, align timestamps
│   ├── DailyAggregator.ts         # Compute daily totals + normalized shapes
│   ├── zones.json                 # Area-to-station mapping (zonal)
│   └── regions.json               # Area-to-station mapping (regional)
│
├── pipeline/
│   ├── TrainPipeline.ts           # Orchestrates full training flow
│   ├── CalibratePipeline.ts       # Orchestrates calibration refresh
│   ├── ForecastPipeline.ts        # Orchestrates stateless inference
│   └── ModelSerializer.ts         # Save/load .vfm and calibration.json
│
├── metrics/
│   ├── LevelMetrics.ts            # Daily total MAPE, MAE, bias
│   ├── ShapeMetrics.ts            # Shape MAPE, peak accuracy, correlation, amplitude
│   ├── HourlyMetrics.ts           # Combined hourly MAPE (final output)
│   └── RetrainMonitor.ts          # Drift detection and retrain triggers
│
├── services/
│   └── weatherService.ts          # Visual Crossing API (retained from V1)
│
├── cli/
│   ├── train.ts                   # CLI handler for train command
│   ├── calibrate.ts               # CLI handler for calibrate command
│   └── forecast.ts                # CLI handler for forecast command
│
└── constants/
    └── index.ts                   # Defaults, thresholds, configuration schema
```

---

## 11. CLI Interface

### 11.1 Train Command

```bash
node dist/index.js train \
  -d "Data Samples/Demand" \         # Historical demand data directory
  -w "Data Samples/Weather" \        # Historical weather data directory
  --days 90 \                        # Training window (days)
  --config forecast_config.json \    # Configuration file (optional)
  -o models/model_20260324.vfm       # Output model file
```

**Produces**: `model.vfm` containing all learned structure.

### 11.2 Calibrate Command

```bash
node dist/index.js calibrate \
  -m models/model_20260324.vfm \     # Trained model (read-only)
  -d "Data Samples/Demand" \         # Recent actual demand data
  --days 7 \                         # Calibration window (days)
  -o models/calibration.json         # Output calibration snapshot
```

**Produces**: `calibration.json` containing bias corrections and recent actuals for lag features.

### 11.3 Forecast Command

```bash
node dist/index.js forecast \
  -m models/model_20260324.vfm \     # Trained model (read-only)
  -c models/calibration.json \       # Calibration snapshot (read-only)
  -s 2026-03-25 \                    # Forecast start date
  -e 2026-03-31 \                    # Forecast end date
  -o output/forecast.csv             # Output forecast file
```

**Reads**: model + calibration + weather forecast (fetched automatically via Visual Crossing API for the forecast date range).

**Produces**: Forecast CSV in same format as demand input data.

**Note**: This command does not access the demand data directory. All information it needs comes from the model file and calibration snapshot. This ensures forecasts are reproducible and stateless.

### 11.4 Optional Flags (all commands)

| Flag | Description | Default |
|------|-------------|---------|
| `--config <path>` | Custom configuration file | Built-in defaults |
| `--zonal` | Use 14-zone mode | Inferred from demand data columns |
| `--regional` | Use 3-region mode | Inferred from demand data columns |
| `--growth <rate>` | Daily demand growth factor | 0 |
| `--verbose` | Print detailed diagnostics | false |
| `--no-calibrate` | Skip calibration in forecast (use model only) | false |

---

## 12. Migration Path

### Phase 1: Data Layer + Daily Aggregator (2-3 days)
- Implement `DataMerger` and `DailyAggregator`
- Build and validate normalized shapes from historical data
- Verify shapes sum to 1.0 and match actuals visually
- Validate against December 2025 data

### Phase 2: Level Model (2-3 days)
- Implement `LevelModel` with XGBoost
- Train and validate daily total predictions
- Compare daily total accuracy against V1 (sum of 24 hourly predictions)

### Phase 3: Shape Model (4-5 days)
- Implement `ProfileLibrary` with archetype clustering (Stage A)
- Implement hierarchical smoothing
- Implement `ShapeAdjuster` with weather corrections (Stage B)
- Validate shape accuracy, peak hour timing, amplitude preservation
- Iterate on Stage B — may need nonlinear adjustments (start linear)

### Phase 4: Integration + Calibration + Lifecycle (3-4 days)
- Implement `ForecastCombiner`, `Calibrator`, `AmplitudeMonitor`
- Wire up `TrainPipeline`, `CalibratePipeline`, `ForecastPipeline`
- Implement CLI commands for all three operations
- Implement `ModelSerializer` for .vfm and calibration.json
- Implement `RetrainMonitor` for drift detection

### Phase 5: Validation & Cutover (3-4 days)
- Run both V1 and V2 in parallel on recent data
- Compare MAPE, shape metrics, peak hour accuracy
- Test the full lifecycle: train → calibrate → forecast → re-calibrate
- Test operator knobs: verify each parameter has expected effect
- Cut over when V2 meets or exceeds V1 on all metrics

### Phase 6: Operational Hardening (2-3 days)
- Add logging and alerting for amplitude warnings and retrain triggers
- Document operational procedures
- Test edge cases: missing weather stations, holidays, sparse zones
- Archive V1 code (do not delete — keep for reference)

**Total estimated effort: 17-22 days**

---

## Appendix A: Mathematical Formulas

### Daily Total Prediction (Level Model)
```
dailyTotal = XGBoost(weatherFeatures, calendarFeatures, lagFeatures, areaIdx)
```

### Shape Construction
```
baseShape = archetypeBlending × nearestArchetype + (1 - archetypeBlending) × overallMedian
adjustedShape[h] = baseShape[h] + weatherInfluence × Σ(βᵢ × featureᵢ)
finalShape[h] = adjustedShape[h] / sum(adjustedShape)
```

### Calibration Application
```
calibratedTotal = dailyTotal × levelScale[area]
calibratedShape[h] = finalShape[h] × shapeCorrection[area][h]
calibratedShape = calibratedShape / sum(calibratedShape)   // renormalize
hourlyForecast[h] = calibratedTotal × calibratedShape[h]
```

### Hierarchical Smoothing
```
α = min(1.0, sampleCount / confidenceThreshold)
effectiveProfile = α × areaProfile + (1 - α) × parentProfile
```

### Asymmetric Shape Clamp
```
For peak hours:    clamp to [shapeClamp[0], shapeClamp[1] + peakBias × 0.06]
For trough hours:  clamp to [shapeClamp[0] - peakBias × 0.06, shapeClamp[1]]
For shoulder hours: clamp to [shapeClamp[0], shapeClamp[1]]
```

### Amplitude Check
```
predictedAmplitude = max(shape) / min(shape)
historicalLower = percentile(amplitudeRange[0], allHistoricalAmplitudes)
historicalUpper = percentile(amplitudeRange[1], allHistoricalAmplitudes)
isFlat = predictedAmplitude < historicalLower
isSpiky = predictedAmplitude > historicalUpper
```

---

## Appendix B: Anti-Flattening Design Rationale

### The Problem

Flattening is the most common failure mode in demand forecasting. Peaks regress toward the mean, troughs get lifted, and the resulting forecast — while statistically "close" by MAPE — is useless for dispatch planning because it understates both the peak (where you need to commit generation) and the valley (where you can back off).

### Why It Happens

| Cause | Mechanism |
|-------|-----------|
| Median profiles | Element-wise median across days with different peak times produces a flattened plateau |
| Renormalization dampening | Boosting one hour forces all others down slightly, diluting corrections |
| Linear regression | Mean-seeking by nature — predicts moderate adjustments even for extreme conditions |
| Symmetric clamping | Treats under-predicting peaks the same as over-predicting troughs |

### The V2 Anti-Flattening Strategy

**One fix per pipeline stage, no compounding**:

| Stage | Anti-Flattening Mechanism | Strength | Risk of Overcorrection |
|-------|---------------------------|----------|------------------------|
| Profile selection | Archetypes (Fix D) — cluster into distinct patterns | **Primary** — does the heavy lifting | Low: data-driven selection |
| Weather adjustment | None (keep symmetric linear) | None needed — archetype already matched | N/A |
| Calibration | Mild asymmetric clamps (Fix E) | **Secondary** — gentle safety net | Low: mild bias (peakBias=0.3) |
| Validation | Amplitude monitoring (Fix C) | **Observability** — doesn't modify output by default | None in monitor mode |

### Why Fixes A and B Were Dropped

| Dropped Fix | Reason |
|-------------|--------|
| Fix A: Percentile sharpness pull | Redundant with archetypes — the selected archetype already has the right amplitude for current conditions |
| Fix B: Asymmetric shape loss in Stage B | Compounds with archetype selection and asymmetric calibration — triple peak-boosting causes overshooting |

### Overcorrection Scenario (prevented by this design)

If all five anti-flattening fixes fired simultaneously on a hot workday:
1. Archetype selects sharp-peak pattern (peak ratio 1.8 vs median 1.5) ← +20% peak
2. Percentile pull further sharpens ← +5% peak (FIX A: dropped)
3. Asymmetric shape loss boosts peak ← +2% peak (FIX B: dropped)
4. Asymmetric calibration allows upward correction ← +3% peak
5. Amplitude correction stretches further ← +5% peak (only in "correct" mode)

With all five: peak overshoots by ~35%. With only D + mild E: peak adjustment is ~23%, which is within realistic range.

---

## Appendix C: V1 → V2 Source Code Mapping

| V1 File | V1 Component | V2 Replacement |
|---------|-------------|----------------|
| `hybridModel.ts` | Profile building | `ShapeModel.ts` → `ProfileLibrary.ts` |
| `hybridModel.ts` | Interpolation within bounds | `ForecastCombiner.ts` (level × shape) |
| `hybridModel.ts` | Weekend corrections | `ProfileLibrary.ts` (dayType archetypes) |
| `hybridModel.ts` | Time-period sensitivity | `ShapeAdjuster.ts` (weather adjustments) |
| `hybridModel.ts` | Region characteristics | `ProfileLibrary.ts` (per-area archetypes) |
| `IterativeScalingCalibrator.ts` | Peak/off-peak scaling | `Calibrator.ts` (level calibration) |
| `DemandCalibrator.ts` | XGBoost residual correction | `Calibrator.ts` (shape calibration) |
| `index.ts` (CLI) | Single train+forecast command | `train.ts`, `calibrate.ts`, `forecast.ts` |

---

## Document History

| Version | Date       | Author | Changes                                       |
|---------|------------|--------|-----------------------------------------------|
| 2.0     | 2026-03-24 | Claude | Initial V2 architecture                       |
| 2.1     | 2026-03-24 | Claude | Added anti-flattening design (archetypes, asymmetric calibration, amplitude monitor), operator tuning knobs with mental models, troubleshooting guide, train/calibrate/forecast lifecycle separation, retrain triggers, calibration.json snapshot with lag actuals, operational week example, revised effort estimate to 17-22 days |
