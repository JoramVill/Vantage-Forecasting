# MREC + ML Hybrid Model Design

## Problem Analysis

### Current Results
| Model | Wind Avg MAPE | Methodology |
|-------|---------------|-------------|
| Pure Hybrid (Physics + ML) | ~256% | Single power curve + ML residual |
| Pure MREC (iPool-style) | ~168% | Three-tier piecewise linear |

### Why Both Have High Error
1. **10m wind speed data** - Using surface wind when hub height is 80-100m
2. **No wind shear correction** - Missing log/power law extrapolation
3. **Generic conversion** - Not accounting for site-specific turbine performance
4. **Weather vs hub-height mismatch** - API returns 10m, turbines operate at 100m

### Why MREC is Better (But Not Great)
MREC's advantage: It **implicitly calibrates** for the 10m vs hub-height mismatch by learning the conversion factors from historical data. When it calculates `MRec = avgCF / avg10mWind`, it's essentially learning a combined factor that includes:
- Power curve characteristics
- Wind shear effects (10m → hub height)
- Site-specific losses
- Operational constraints

However, MREC is still limited because the relationship between 10m and hub-height wind varies with atmospheric stability, which changes hourly.

## Proposed Solution: MREC-ML Hybrid

### Concept
Keep MREC's three-tier structure as the **base prediction**, then use ML to learn the **residual correction** that accounts for:
- Atmospheric stability variations
- Temporal patterns (diurnal wind patterns)
- Other weather factors (temperature affects air density)
- Recent lag behavior

### Architecture

```
Wind Speed (10m) → MREC Base Prediction → ML Residual → Final CF
                          ↑                    ↑
                     Tier (H/M/L)        + Features:
                     MRec factor           - Hour (sin/cos)
                                          - Month
                                          - Temperature
                                          - Wind gust ratio
                                          - Cloud cover
                                          - Previous hour CF
                                          - MREC base value
```

### Mathematical Formulation

```
CF_final = MREC(wind) + ML_residual(features)

Where:
  MREC(wind) = {
    MRecH × wind,  if wind >= vH
    MRecM × wind,  if vL <= wind < vH
    MRecL × wind,  if wind < vL
  }

  ML_residual = regression(
    mrec_base,       # MREC prediction
    tier_H,          # 1 if HIGH tier, else 0
    tier_M,          # 1 if MID tier, else 0
    hour_sin,        # sin(2π × hour / 24)
    hour_cos,        # cos(2π × hour / 24)
    temp_norm,       # temperature / 50
    gust_ratio,      # windgust / windspeed
    cfac_lag_1h,     # Previous hour CF
    cfac_lag_24h     # Same hour yesterday
  )

Final: clamp(CF_final, 0, 1)
       If CF_final > 1.1: return 0 (high wind cutout)
```

### Why This Should Work Better

1. **MREC provides stable base** - Already calibrated for wind speed → CF relationship
2. **ML corrects systematic errors** - Learns patterns MREC misses:
   - Morning vs evening wind patterns differ (stability)
   - Temperature affects air density → actual power
   - Gust ratio indicates turbulence → reduced efficiency
3. **Lag features capture persistence** - Wind is autocorrelated; if CF was high last hour, likely high now
4. **Tier indicators** - ML can learn tier-specific corrections

### Implementation Plan

#### Phase 1: WindMRECHybridModel
```typescript
class WindMRECHybridModel {
  private mrecModel: WindMRECModel;
  private residualModel: MultivariateLinearRegression | null;

  calibrateMREC(data: MRECCalibrationData[]): void;
  trainResidual(samples: CFacTrainingSample[]): void;

  predict(weather: CFacWeatherFeatures, datetime: Date): number {
    const mrecBase = this.mrecModel.predict(weather.windSpeed);
    if (!this.residualModel) return mrecBase;

    const features = this.buildResidualFeatures(mrecBase, weather, datetime);
    const residual = this.residualModel.predict([features])[0];

    let final = mrecBase + residual;
    if (final > 1.1) return 0;  // High wind cutout
    return Math.max(0, Math.min(1, final));
  }
}
```

#### Phase 2: Feature Engineering
```typescript
buildResidualFeatures(mrecBase, weather, datetime): number[] {
  const tier = this.getTier(weather.windSpeed);
  const hour = datetime.getHours();

  return [
    mrecBase,
    tier === 'H' ? 1 : 0,
    tier === 'M' ? 1 : 0,
    Math.sin(2 * Math.PI * hour / 24),
    Math.cos(2 * Math.PI * hour / 24),
    weather.temp / 50,
    weather.windGust ? weather.windGust / weather.windSpeed : 1,
    this.lagCF1h || mrecBase,  // Use MREC as fallback
    this.lagCF24h || mrecBase
  ];
}
```

#### Phase 3: Training Flow
1. Calibrate MREC first (already done)
2. For each historical sample:
   - Compute MREC prediction
   - Compute residual = actual - mrec_prediction
   - Build feature vector
3. Train regression on (features → residual)
4. Evaluate: should have lower MAPE than pure MREC

### Expected Improvements

| Aspect | MREC Only | MREC + ML Hybrid |
|--------|-----------|------------------|
| Base calibration | ✓ | ✓ (same) |
| Temporal patterns | ✗ | ✓ (hour encoding) |
| Atmospheric stability proxy | ✗ | ✓ (temp, gust ratio) |
| Persistence | ✗ | ✓ (lag features) |
| Tier-specific corrections | ✗ | ✓ (tier indicators) |

### Alternative: Wind Shear Correction

If we can't improve much with ML, consider explicit wind shear:

```typescript
// Power law extrapolation
windSpeed100 = windSpeed10 * Math.pow(100 / 10, alpha);

// Alpha varies with stability:
// - Stable (night): alpha ≈ 0.4
// - Neutral: alpha ≈ 0.2
// - Unstable (day): alpha ≈ 0.1

// Estimate stability from hour and temperature
function estimateAlpha(hour: number, temp: number): number {
  const isDay = hour >= 7 && hour <= 17;
  const isWarm = temp > 25;

  if (isDay && isWarm) return 0.12;  // Convective, unstable
  if (isDay) return 0.16;            // Daytime neutral
  if (isWarm) return 0.20;           // Night, still warm
  return 0.30;                        // Night, cool, stable
}
```

Then recalibrate MREC with shear-corrected wind speeds.

## Next Steps

1. **Implement WindMRECHybridModel** with residual learning
2. **Train and evaluate** on historical data
3. **Compare**: Pure MREC vs MREC+ML vs MREC+WindShear
4. **Choose best** for production

## Files to Create/Modify

- `src/models/capacityFactor/WindMRECHybridModel.ts` - New hybrid model
- `src/types/capacityFactor.ts` - Add residual features interface
- `src/index.ts` - Add training/evaluation commands

## Success Criteria

Target: Reduce wind MAPE from 168% (pure MREC) to <100% with hybrid approach.
Stretch goal: <50% with wind shear correction + ML residuals.
