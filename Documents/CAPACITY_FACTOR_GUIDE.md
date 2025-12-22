# Capacity Factor Forecasting Guide

**Last Updated:** December 22, 2025
**Version:** 2.1 - Station-Specific Weather & Improved Accuracy

---

## Overview

The iLoad Forecasting Utility provides advanced capacity factor (CFac) forecasting for renewable and must-run generation stations in the Philippines power grid. This guide covers the optimal forecasting approach using specialized models for each generation type.

### Key Features

- **Weather-Only MREC Hybrid** for wind stations (best accuracy)
- **Physics+ML Hybrid** for solar stations
- **Profile-based models** for hydro, geothermal, biomass, and battery
- Automatic 100m hub-height wind data for wind farms
- Cluster-based weather fetching for geographic accuracy

---

## Quick Start

### Generate Optimal Capacity Factor Forecast

```bash
# Build the application
npm run build

# Generate Nov-Dec 2025 forecast using optimal models
node dist/index.js cfac forecast2 \
  -t "Data Samples/Capacity Factor" \
  -s 2025-11-01 \
  -e 2025-12-31 \
  -o output/cfac_optimal_forecast.csv
```

This command automatically:
1. Loads 117 station metadata
2. Parses historical capacity factor training data
3. Trains the optimal model for each station type
4. Fetches forecast weather from Visual Crossing API
5. Generates hourly capacity factor predictions

---

## Model Selection by Station Type

The `cfac forecast2` command automatically selects the best-performing model for each station type based on extensive backtesting:

| Station Type | Model | Expected MAPE | Key Features |
|--------------|-------|---------------|--------------|
| **Wind** | Weather-Only MREC Hybrid | ~75.8% | MREC base + weather ML residual |
| **Solar** | Physics+ML Hybrid | ~16% | Irradiance physics + ML correction |
| **Hydro (RoR)** | Profile-based | varies | Historical hourly profiles |
| **Hydro (Storage)** | Profile-based | varies | Dispatch pattern modeling |
| **Geothermal** | Profile-based | ~15-35% | Stable baseload profiles |
| **Biomass** | Profile-based | varies | Operational patterns |
| **Battery** | Profile-based | varies | Charge/discharge cycles |

---

## Wind Capacity Factor Forecasting

### The Weather-Only MREC Hybrid Model

Wind forecasting uses a two-stage approach that combines iPool's proven MREC algorithm with machine learning:

#### Stage 1: MREC Base (iPool Algorithm)

The MREC (Must-Run Energy Conversion) algorithm uses three-tier piecewise linear conversion:

```
if windSpeed >= vH:
    PcCon = MRecH × windSpeed  (HIGH tier)
else if windSpeed >= vL:
    PcCon = MRecM × windSpeed  (MID tier)
else:
    PcCon = MRecL × windSpeed  (LOW tier)

if PcCon > 1.1:
    return 0  (High wind cutout)
```

**Calibration Process:**
1. Sort wind speed data by descending capacity factor
2. Calculate PoE (Probability of Exceedance) thresholds
3. Segment into HIGH (top 10%), MID (10-30%), LOW (bottom 70%)
4. Fit linear factors for each segment

#### Stage 2: Weather-Only ML Residual

The ML layer learns corrections using **only weather-based features** (no temporal features that cause overfitting):

| Feature | Description | Purpose |
|---------|-------------|---------|
| `mrecBase` | MREC prediction | Anchor point |
| `tierH`, `tierM` | Tier indicators | Regime identification |
| `gustRatio` | windGust / windSpeed | Turbulence indicator |
| `tempDeviation` | (temp - 25) / 20 | Air density proxy |
| `windSpeedNorm` | windSpeed / 30 | Normalized wind |
| `cloudCover` | cloudCover / 100 | Atmospheric conditions |

**Why Weather-Only?**

Our analysis showed that temporal features (month, hour encoding) cause the model to overfit to training data patterns that don't generalize across monsoon season transitions:

| Model | Training MAPE | Test MAPE | Issue |
|-------|---------------|-----------|-------|
| MREC-only | 141.3% | 96.3% | Robust baseline |
| MREC+ML (Temporal) | 110.2% | 110.8% | **Overfit** |
| MREC+ML (Weather-Only) | 122.2% | **75.8%** | Best generalization |

### Wind Station Configuration

Wind stations are identified by codes containing:
- `BURGOS`, `LAOAG`, `PAGUDPUD` (Ilocos Norte cluster)
- `NABAS_W` (Aklan cluster)
- `STBARBRA_W` (Iloilo cluster)

These stations automatically receive 100m hub-height wind data from Visual Crossing API.

---

## Solar Capacity Factor Forecasting

### Physics+ML Hybrid Model

Solar forecasting combines physical irradiance modeling with ML correction:

#### Physics Base

```typescript
// Clear-sky potential
clearSkyPotential = solarRadiation / maxIrradiance

// Cloud attenuation
cloudFactor = 1 - (cloudCover / 100) * 0.75

// Temperature derating
tempFactor = 1 - 0.004 * max(0, temperature - 25)

// Base prediction
physicsBase = clearSkyPotential * cloudFactor * tempFactor
```

#### ML Residual Features

- Hour of day (solar angle proxy)
- Cloud cover variations
- Temperature effects
- Historical correction factors

### Solar Station Configuration

Solar stations are identified by codes containing `_S` suffix or solar-specific names.

---

## Other Station Types

### Hydro Stations

**Run-of-River (`_H` suffix):**
- Seasonal flow patterns
- Time-of-day profiles
- Weather correlation (precipitation)

**Storage (`_HS` suffix):**
- Dispatch optimization patterns
- Peak demand correlation
- Reservoir management profiles

### Geothermal Stations

- Near-constant baseload operation
- High availability profiles
- Minimal weather correlation

### Biomass Stations

- Fuel availability patterns
- Operational scheduling
- Seasonal variations

### Battery Stations

- Charge/discharge cycles
- Grid balancing patterns
- Price arbitrage behavior

---

## CLI Commands Reference

### cfac forecast2 (Recommended)

**Optimal model selection for each station type.**

```bash
iload cfac forecast2 \
  -t <training-path> \
  -s <start-date> \
  -e <end-date> \
  -o <output-file> \
  [--stations <file>] \
  [--cache <dir>]
```

**Options:**
| Option | Description | Default |
|--------|-------------|---------|
| `-t, --training` | Training data path (required) | - |
| `-s, --start` | Forecast start (YYYY-MM-DD) | - |
| `-e, --end` | Forecast end (YYYY-MM-DD) | - |
| `-o, --output` | Output CSV file | - |
| `--stations` | Stations JSON | `src/data/stations.json` |
| `--cache` | Weather cache dir | `./weather_cache` |

**Example:**
```bash
node dist/index.js cfac forecast2 \
  -t "Data Samples/Capacity Factor" \
  -s 2025-12-01 \
  -e 2025-12-31 \
  -o output/cfac_december_2025.csv
```

### cfac forecast (Original)

**Uses ModelRouter with generic models.**

```bash
iload cfac forecast \
  -t <training-path> \
  -s <start-date> \
  -e <end-date> \
  -o <output-file>
```

### cfac mrec compare3

**Three-way model comparison for wind stations.**

```bash
iload cfac mrec compare3 \
  -t <training-path> \
  -a <actual-path> \
  [--cache <dir>]
```

Compares:
1. MREC-only (iPool baseline)
2. MREC+ML Hybrid (Temporal features)
3. MREC+ML Hybrid (Weather-only features)

**Example:**
```bash
node dist/index.js cfac mrec compare3 \
  -t "Data Samples/Capacity Factor" \
  -a "Data Samples/Capacity Factor"
```

### cfac evaluate

**Evaluate forecast accuracy against actual data.**

```bash
iload cfac evaluate \
  -f <forecast-file> \
  -a <actual-file> \
  [-o <report-file>]
```

---

## Data Formats

### Input: Training Data (MRHCFac Format)

```csv
DateTimeEnding,01BAKUN,01BURGOS,01CLARK,01LAOAG,...
7/1/2025 1:00,0.82,0.45,0.88,0.52,...
7/1/2025 2:00,0.80,0.48,0.90,0.55,...
```

- **DateTimeEnding**: Hour-ending timestamp (M/D/YYYY H:mm)
- **Columns**: Station codes with capacity factors (0-1)

### Output: Forecast CSV

```csv
DateTimeEnding,01BAKUN,01BURGOS,01CLARK,01LAOAG,...
12/1/2025 1:00,0.78,0.42,0.85,0.48,...
12/1/2025 2:00,0.76,0.45,0.87,0.51,...
```

Same format as input for easy comparison.

### Station Metadata (stations.json)

```json
{
  "stations": [
    {
      "code": "01BURGOS",
      "name": "Burgos Wind Farm",
      "type": "wind",
      "capacity_mw": 150,
      "cluster": "ILOCOS_NORTE_WIND"
    }
  ],
  "clusters": [
    {
      "clusterId": "ILOCOS_NORTE_WIND",
      "name": "Ilocos Norte Wind Cluster",
      "latitude": 18.52,
      "longitude": 120.65
    }
  ]
}
```

---

## Weather Data Integration

### Cluster-Based Fetching

Weather data is fetched per geographic cluster, not per station:

1. **Wind clusters**: Receive 100m hub-height wind data
2. **Solar clusters**: Standard surface weather
3. **Other clusters**: Standard surface weather

### Weather Cache

Weather data is cached locally to avoid redundant API calls:

```
weather_cache/
├── ILOCOS_NORTE_WIND/
│   └── 2025-12/
│       ├── 2025-12-01.csv
│       ├── 2025-12-02.csv
│       └── ...
├── PAMPANGA_SOLAR/
│   └── 2025-12/
│       └── ...
```

### Required Weather Variables

| Variable | Description | Used By |
|----------|-------------|---------|
| `windspeed` | 10m wind speed (m/s) | All |
| `windspeed100` | 100m wind speed (m/s) | Wind |
| `windgust` | Wind gust speed (m/s) | Wind |
| `solarradiation` | Solar irradiance (W/m²) | Solar |
| `cloudcover` | Cloud cover (%) | Solar, Wind |
| `temp` | Temperature (°C) | All |
| `precip` | Precipitation (mm) | Hydro |

---

## Best Practices

### 1. Use Sufficient Training Data

- **Minimum**: 3 months of hourly data
- **Recommended**: 6+ months covering different seasons
- **Ideal**: Full year for seasonal pattern capture

### 2. Validate Weather Cache

Ensure weather cache contains data for both training and forecast periods:

```bash
# Check cache coverage
ls -la weather_cache/ILOCOS_NORTE_WIND/2025-*/
```

### 3. Monitor Model Performance

Run periodic backtests using `cfac mrec compare3`:

```bash
# Compare model performance on recent data
node dist/index.js cfac mrec compare3 \
  -t "Data Samples/Capacity Factor" \
  -a "Data Samples/Capacity Factor"
```

### 4. Evaluate Forecasts

Always evaluate against actual data when available:

```bash
node dist/index.js cfac evaluate \
  -f output/cfac_forecast.csv \
  -a "Data Samples/Capacity Factor/MRHCFac_actual.csv"
```

---

## Troubleshooting

### Common Issues

#### "No weather data found in cache"

```bash
# Ensure weather is fetched for the period
# The forecast command auto-fetches, but verify API key is set
export VISUAL_CROSSING_API_KEY="your_key"
```

#### "Insufficient samples for station X"

- Station needs at least 50 training samples
- Check if station appears in training data
- Verify date range coverage

#### High MAPE for specific stations

- Check weather data quality for station's cluster
- Verify station metadata (correct cluster assignment)
- Consider station-specific operational patterns

### Performance Tips

1. **Pre-cache weather data** for frequently-used periods
2. **Use forecast2** instead of forecast for better accuracy
3. **Run compare3** periodically to validate model selection

---

## Model Performance Summary

### Wind Stations (Weather-Only MREC Hybrid)

| Station | Test MAPE | Improvement over MREC |
|---------|-----------|----------------------|
| 01BURGOS | 73.6% | +19.3% |
| 01LAOAG | 98.0% | +3.5% |
| 01PAGUDPUD | 71.7% | +6.6% |
| 08NABAS_W | 81.6% | +55.3% |
| 08STBARBRA_W | 70.0% | +0.1% |
| **Average** | **75.8%** | **+21.4%** |

### Solar Stations (Physics+ML Hybrid)

Average MAPE: ~16% (measured on December 2025 forecast vs actual)

### Key Insights

1. **Weather-Only ML avoids overfitting** across monsoon season transitions
2. **MREC provides robust baseline** even with limited data
3. **ML corrections capture** turbulence, air density, and atmospheric effects
4. **Solar benefits more from ML** due to predictable diurnal patterns

---

## Files Reference

### Source Code

| File | Description |
|------|-------------|
| `src/models/capacityFactor/WindMRECModel.ts` | iPool MREC implementation |
| `src/models/capacityFactor/WindWeatherHybridModel.ts` | Weather-Only MREC Hybrid |
| `src/models/capacityFactor/SolarHybridModel.ts` | Physics+ML Solar model |
| `src/models/capacityFactor/ModelRouter.ts` | Model selection router |
| `src/services/capacityFactorService.ts` | Data parsing and output |

### Configuration

| File | Description |
|------|-------------|
| `src/data/stations.json` | Station metadata and clusters |
| `config.json` | API keys (optional) |

### Output

| File | Description |
|------|-------------|
| `output/cfac_optimal_*.csv` | Forecast results |
| `weather_cache/` | Cached weather data |

---

## Version History

### v2.1 (December 22, 2025)
- Solar MAPE improved from 59.6% to ~16% (measured against actual data)
- Fixed `--solar-seasonal` flag over-forecasting bug (01LIMAY +296% error)
- Added station-specific weather coordinates for 117 stations
- Optimal wind height per station (10m-100m based on correlation analysis)
- XGBoost option for ML residual learning
- Asymmetric loss option for under-prediction penalty

### v2.0 (December 2025)
- Added `cfac forecast2` with optimal model selection
- Implemented Weather-Only MREC Hybrid for wind
- Added `cfac mrec compare3` for model comparison
- Achieved 21% improvement over baseline for wind

### v1.0 (November 2025)
- Initial capacity factor forecasting
- Basic physics models for solar
- Profile-based models for other types

---

## See Also

- [CLI_REFERENCE.md](CLI_REFERENCE.md) - Complete command reference
- [USER_GUIDE.md](USER_GUIDE.md) - General usage guide
- [TECHNICAL_OVERVIEW.md](TECHNICAL_OVERVIEW.md) - System architecture
