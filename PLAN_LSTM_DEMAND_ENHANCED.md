# Implementation Plan: Enhanced LSTM Demand Trainer with Per-City Weather Learning

## Problem Statement

**01NLUZ** over-forecasts by 200-300 MW consistently - it needs all 6 cities.
**Other zones** are accurate overall, but could benefit from learning optimal city weighting.

The current Python LSTM trainer (`scripts/train_demand_lstm.py`) uses a simplified 22-feature set that:
1. **Single weather source** - Only loads one weather file per zone, ignoring city-specific data
2. **No city weighting** - Treats all weather equally, doesn't learn which city matters most
3. **Hardcodes holidays** - `is_holiday = 0.0` always
4. **No seasonal awareness** - Doesn't distinguish wet/dry season
5. **Simple target** - Uses moving average instead of actual hybrid model predictions

## Scope

**All 14 zones** - Each zone learns optimal weighting of its cities:
- **01NLUZ**: 6 cities (San Fernando, Baguio, Tuguegarao, Laoag, Dagupan, Angeles City)
- **Other zones**: 3 cities each (their configured demand centers)

## Goal

Create an enhanced LSTM for all zones that learns:
- **Which cities' weather data most affects demand** (per-zone weighting)
- **Temporal patterns** correlated with weather dynamics
- **Calendar effects** including real Philippines holidays
- **Seasonal patterns** (wet/dry season temperature sensitivity)

---

## Architecture: Multi-Input Attention LSTM

### Core Concept

Instead of concatenating all city weather into one flat vector, use **city-level attention** to let the model learn which cities are most important:

```
[City1 Weather] ──┐
[City2 Weather] ──┼──► Attention Layer ──► Weighted Weather ──┐
[City3 Weather] ──┤                                           │
[City4 Weather] ──┤ (optional)                               ├──► LSTM ──► Correction
[City5 Weather] ──┤ (optional)                               │
[City6 Weather] ──┘ (optional)                               │
                                                              │
[Temporal Features] ──────────────────────────────────────────┤
[Demand Features] ────────────────────────────────────────────┘
```

### Feature Groups

#### 1. Per-City Weather Features (6-8 features × up to 6 cities = 48 max)
For each city that exists:
| Feature | Description | Normalization |
|---------|-------------|---------------|
| `temp_{i}` | Temperature | (T - 20) / 20 |
| `temp_change_1h_{i}` | Temp momentum 1h | raw °C |
| `temp_change_3h_{i}` | Temp momentum 3h | raw °C |
| `humidity_{i}` | Relative humidity | / 100 |
| `cloudcover_{i}` | Cloud cover | / 100 |
| `windspeed_{i}` | Wind speed | / 50 |
| `solarradiation_{i}` | Solar radiation | / 1000 |
| `city_present_{i}` | 1 if city exists, 0 otherwise | binary |

#### 2. Aggregated Weather Features (8 features)
Cross-city summaries that capture spatial variability:
| Feature | Description |
|---------|-------------|
| `temp_mean` | Mean temp across all cities |
| `temp_max` | Max temp across all cities |
| `temp_spread` | Max - Min temp (spatial variability) |
| `humidity_mean` | Mean humidity |
| `cloud_mean` | Mean cloud cover |
| `solar_mean` | Mean solar radiation |
| `num_cities` | Number of cities with data (3 or 6) |
| `has_6_cities` | 1 if zone has 6 cities |

#### 3. Demand Features (10 features)
| Feature | Description |
|---------|-------------|
| `demand_norm` | Current hour demand / 10000 |
| `demand_change_1h` | Demand[t] - Demand[t-1] normalized |
| `demand_change_3h` | Demand[t] - Demand[t-3] normalized |
| `demand_lag_24h` | Same hour yesterday |
| `demand_lag_168h` | Same hour last week |
| `demand_rolling_24h` | 24h rolling average |
| `hybrid_prediction` | Hybrid model's prediction (if available) |
| `demand_ramp_rate` | Rate of change over last 3 hours |
| `same_hour_weekday_avg` | Average for this hour on this day type |
| `demand_percentile_24h` | Where current demand sits in 24h range |

#### 4. Temporal Features (18 features)
| Feature | Description |
|---------|-------------|
| `hour_sin`, `hour_cos` | Cyclical hour |
| `dow_sin`, `dow_cos` | Cyclical day of week |
| `month_sin`, `month_cos` | Cyclical month |
| `is_weekend` | Saturday/Sunday |
| `is_saturday` | Specific day flags |
| `is_sunday` | |
| `is_workday` | Mon-Fri non-holiday |
| `is_morning_ramp` | 6-9 AM |
| `is_evening_peak` | 17-22 |
| `is_overnight_low` | 0-5 AM |

#### 5. Calendar Features (8 features)
| Feature | Description |
|---------|-------------|
| `is_holiday` | Philippines public holiday (from date-holidays) |
| `is_special_nonworking` | Optional/bank holidays |
| `days_since_holiday` | Days since last holiday / 14 |
| `days_until_holiday` | Days to next holiday / 14 |
| `day_after_holiday` | Monday after Sunday holiday, etc. |
| `holiday_bridge` | Day between holiday and weekend |
| `is_christmas_week` | Dec 24 - Jan 2 |
| `is_holy_week` | Maundy Thursday to Easter Sunday |

#### 6. Seasonal Features (6 features)
| Feature | Description |
|---------|-------------|
| `is_wet_season` | Jun-Nov (typhoon season) |
| `is_dry_hot` | Mar-May (hottest, highest demand) |
| `is_dry_cool` | Dec-Feb (coolest) |
| `season_temp_sensitivity` | Learned per-season temp coefficient |
| `is_el_nino_year` | Manual flag for extreme years |
| `is_la_nina_year` | Manual flag |

### Total Features per Timestep

| Zone Type | Per-City | Agg | Demand | Temporal | Calendar | Seasonal | **Total** |
|-----------|----------|-----|--------|----------|----------|----------|-----------|
| **01NLUZ** (6 cities) | 48 | 8 | 10 | 18 | 8 | 6 | **98** |
| **Other zones** (3 cities) | 24 | 8 | 10 | 18 | 8 | 6 | **74** |

Each zone gets its own trained LSTM that learns:
- Which of its cities (3 or 6) has most influence on demand
- How weather-demand correlation varies by hour/season

---

## Implementation Phases

### Phase 1: Data Loading Enhancement
**File:** `scripts/train_demand_lstm.py`

1. Load `zones.json` to get city configurations
2. Load weather data for ALL cities per zone (not just first file)
3. Merge weather by city index (city1, city2, etc.)
4. Handle missing city data gracefully (fill with zone mean)

```python
def load_all_city_weather(weather_dir: str, zone_config: dict) -> Dict[int, pd.DataFrame]:
    """Load weather for all cities in a zone."""
    city_weather = {}
    for i, city in enumerate(zone_config['cities']):
        city_id = city['id']
        # Try multiple path patterns...
        city_weather[i] = load_city_weather_data(weather_dir, city_id, zone_config['code'])
    return city_weather
```

### Phase 2: Feature Engineering
**File:** `scripts/train_demand_lstm.py`

1. Implement `extract_per_city_features()` - 8 features per city
2. Implement `extract_aggregated_weather_features()` - cross-city stats
3. Implement `extract_temporal_features()` - with real PH holiday detection
4. Implement `extract_seasonal_features()` - wet/dry season flags
5. Implement `extract_demand_features()` - lag, rolling, percentile

```python
def extract_all_features(
    demand_df: pd.DataFrame,
    city_weather: Dict[int, pd.DataFrame],
    zone: str,
    dt: datetime
) -> np.ndarray:
    """Extract complete feature vector for one timestep."""
    features = []

    # Per-city weather (pad to 6 cities)
    for i in range(6):
        features.extend(extract_per_city_features(city_weather.get(i), dt))

    # Aggregated weather
    features.extend(extract_aggregated_weather(city_weather, dt))

    # Demand features
    features.extend(extract_demand_features(demand_df, zone, dt))

    # Temporal
    features.extend(extract_temporal_features(dt))

    # Calendar (with date-holidays)
    features.extend(extract_calendar_features(dt))

    # Seasonal
    features.extend(extract_seasonal_features(dt))

    return np.array(features, dtype=np.float32)
```

### Phase 3: Model Architecture
**File:** `scripts/train_demand_lstm.py`

Enhanced architecture with attention:

```python
def build_enhanced_model(num_features: int, sequence_length: int = 48) -> keras.Model:
    """Build LSTM with city attention mechanism."""

    # Input
    inputs = layers.Input(shape=(sequence_length, num_features))

    # First LSTM layer
    x = layers.LSTM(64, return_sequences=True, dropout=0.2, recurrent_dropout=0.1)(inputs)

    # Second LSTM layer
    x = layers.LSTM(32, return_sequences=False, dropout=0.2)(x)

    # Dense layers with residual connection
    x = layers.Dense(32, activation='relu')(x)
    x = layers.Dropout(0.2)(x)
    x = layers.Dense(16, activation='relu')(x)
    x = layers.Dropout(0.1)(x)

    # Output: correction factor (sigmoid scaled to [0.85, 1.15])
    outputs = layers.Dense(1, activation='sigmoid')(x)

    model = keras.Model(inputs=inputs, outputs=outputs)

    model.compile(
        optimizer=keras.optimizers.Adam(learning_rate=0.0005),
        loss='mse',
        metrics=['mae']
    )

    return model
```

### Phase 4: Holiday Integration
**File:** `scripts/train_demand_lstm.py`

Use Python's `holidays` library for Philippines:

```python
import holidays

# Initialize Philippines holidays
ph_holidays = holidays.Philippines(years=range(2024, 2028))

def is_philippines_holiday(dt: datetime) -> tuple[bool, bool]:
    """Check if date is a PH holiday."""
    date = dt.date()
    is_holiday = date in ph_holidays
    holiday_name = ph_holidays.get(date, '')
    is_special = 'optional' in holiday_name.lower() if holiday_name else False
    return is_holiday, is_special

def get_holiday_distance(dt: datetime) -> tuple[int, int]:
    """Get days since last and until next holiday."""
    date = dt.date()

    # Days since last holiday
    days_since = 0
    for i in range(1, 31):
        check_date = date - timedelta(days=i)
        if check_date in ph_holidays:
            days_since = i
            break

    # Days until next holiday
    days_until = 0
    for i in range(1, 31):
        check_date = date + timedelta(days=i)
        if check_date in ph_holidays:
            days_until = i
            break

    return days_since, days_until
```

### Phase 5: JavaScript Inference Update
**File:** `src/models/DemandLSTMInference.ts`

Update to handle new feature count:

```typescript
// Update constants
const FEATURES_PER_TIMESTEP_V2 = 98;  // Full 6-city
const FEATURES_PER_TIMESTEP_V2_3CITY = 74;  // 3-city zones

// Update feature interface
export interface DemandLSTMFeaturesV2 {
    // Per-city weather (6 cities × 8 features)
    cityWeather: Array<{
        temp: number;
        tempChange1h: number;
        tempChange3h: number;
        humidity: number;
        cloudcover: number;
        windspeed: number;
        solarradiation: number;
        cityPresent: number;
    }>;

    // Aggregated weather
    tempMean: number;
    tempMax: number;
    tempSpread: number;
    humidityMean: number;
    cloudMean: number;
    solarMean: number;
    numCities: number;
    has6Cities: number;

    // Demand features
    demandNorm: number;
    demandChange1h: number;
    demandChange3h: number;
    demandLag24h: number;
    demandLag168h: number;
    demandRolling24h: number;
    hybridPrediction: number;
    demandRampRate: number;
    sameHourWeekdayAvg: number;
    demandPercentile24h: number;

    // Temporal
    hourSin: number;
    hourCos: number;
    // ... etc
}
```

### Phase 6: Training Pipeline Update

1. Add CLI flags for feature version:
```bash
python scripts/train_demand_lstm.py --zone 01NLUZ --version v2 --epochs 100
```

2. Add cross-validation:
```python
# Time-series CV: train on months 1-6, validate on 7-8, test on 9+
```

3. Add learning rate scheduling:
```python
lr_scheduler = keras.callbacks.ReduceLROnPlateau(
    monitor='val_loss',
    factor=0.5,
    patience=5,
    min_lr=0.00001
)
```

---

## File Changes Summary

### Modified Files
| File | Changes |
|------|---------|
| `scripts/train_demand_lstm.py` | Rewrite with multi-city weather per zone |
| `src/models/DemandLSTMInference.ts` | Update feature handling for V2 models |
| `context.md` | Document implementation progress |

### New Files
| File | Purpose |
|------|---------|
| `models/lstm/lstm_*_v2.json` | Enhanced model weights for all 14 zones |
| `models/lstm/city_weights.json` | Learned city importance per zone (for analysis) |

---

## Success Criteria

1. **01NLUZ improvement**: Reduce over-forecasting bias by at least 50% (from +20% to +10%)
2. **Other zones**: Maintain or improve current accuracy
3. **Morning ramp**: Improve correlation for problem zones (03SLUZ, 11NCMIN)
4. **City weights**: Each zone learns which of its cities matters most
5. **Interpretability**: Export city importance weights for analysis

---

## Dependencies

Python:
- `tensorflow >= 2.10`
- `holidays` (for Philippines holiday detection)
- `pandas`
- `numpy`

---

## Estimated Effort

| Phase | Description | Complexity |
|-------|-------------|------------|
| 1 | Data loading enhancement | Medium |
| 2 | Feature engineering | High |
| 3 | Model architecture | Medium |
| 4 | Holiday integration | Low |
| 5 | JS inference update | Medium |
| 6 | Training pipeline | Medium |

---

## Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| Too many features → overfitting | Use dropout, early stopping, L2 regularization |
| Missing city weather data | Fill with zone mean, add `city_present` flag |
| Feature explosion | Consider PCA or feature selection |
| Python/JS sync issues | Version field in JSON, backward compatibility |
