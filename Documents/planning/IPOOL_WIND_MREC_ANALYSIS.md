# iPool Wind Capacity Factor Analysis - MREC System

## Summary

iPool uses a **Three-Tier Piecewise Linear MREC (Must-Run Energy Conversion)** system that produces superior wind capacity factor forecasts compared to our current hybrid approach.

## iPool's MREC Architecture

### Core Data Structure (ESite.h:65-75)

```cpp
double m_MRecH;   // Conversion Factor at HIGH wind speed
double m_MRecM;   // Conversion Factor at MID wind speed
double m_MRecL;   // Conversion Factor at LOW wind speed
double m_MRvH;    // Wind speed threshold for HIGH tier
double m_MRvL;    // Wind speed threshold for LOW tier
BOOL   m_bUseMRec;// Flag indicating calibrated factors available
```

### PoE Constants (ConstDefinitions.cpp:112-115)

```cpp
double PoEH = 0.1;  // Top 10% (high wind conditions)
double PoEL = 0.3;  // Top 30% threshold
```

This means:
- **High tier**: Top 10% of wind conditions
- **Mid tier**: 10%-30% of wind conditions
- **Low tier**: Below 30% (most common conditions)

## Calibration Process

### Input Files Required

1. **MRGCFac** - Historical capacity factors per station (hourly)
2. **MRWind** - Historical wind speeds per station (hourly)

### CalcLevHML Algorithm (EProf.cpp:1978-2085)

The algorithm builds a cumulative distribution of wind speeds:

1. **Bin the data** into 25 buckets from min to max wind speed
2. **Iterate from highest to lowest** bucket
3. **Accumulate samples** and classify:
   - First 10% of samples → HIGH tier
   - 10%-30% of samples → MID tier
   - Remaining 70% → LOW tier
4. **Calculate averages** for each tier:
   - `ValH` = average wind speed in HIGH tier
   - `ValM` = average wind speed in MID tier
   - `ValL` = average wind speed in LOW tier
   - `CFacH` = average capacity factor in HIGH tier
   - `CFacM` = average capacity factor in MID tier
   - `CFacL` = average capacity factor in LOW tier

### Conversion Factor Calculation (DMREC.cpp:348-354)

```cpp
pSite->m_MRecH = CFacH / ValH;  // High wind conversion
pSite->m_MRecM = CFacM / ValM;  // Mid wind conversion
pSite->m_MRecL = CFacL / ValL;  // Low wind conversion
pSite->m_MRvH  = vH;            // High threshold (wind speed)
pSite->m_MRvL  = vL;            // Low threshold (wind speed)
```

## Runtime Forecasting (ESite.cpp:469-493)

```cpp
double MRVal = m_pDailyDP->GetMwCap(t);  // Get forecast wind speed

if (MRVal >= m_MRvH)
    PcCon = m_MRecH * MRVal;      // HIGH wind regime
else if (MRVal >= m_MRvL)
    PcCon = m_MRecM * MRVal;      // MID wind regime
else
    PcCon = m_MRecL * MRVal;      // LOW wind regime

// Overload protection for wind
if (PcCon > 1.1 && m_FType == WIND)
    PcCon = 0.0;  // High wind cutout!
else if (PcCon > 1.0)
    PcCon = 1.0;  // Cap at 100%
```

## Why iPool's Approach is Superior

### 1. Captures Non-Linear Power Curve

Wind turbine power curves have three distinct regions:
- **Below cut-in**: Zero power
- **Cubic region**: Power ~ wind^3
- **Rated region**: Constant power
- **Above cut-out**: Zero power (high wind shutdown)

The three-tier system captures these transitions:
- **MRecL** handles the low-wind cubic region
- **MRecM** handles transition to rated
- **MRecH** handles near-rated operation

### 2. Site-Specific Calibration

Each wind farm gets unique conversion factors calibrated from **its own historical data**, accounting for:
- Specific turbine models at that site
- Local terrain effects (wake losses, topography)
- Actual operational constraints
- Grid connection limitations

### 3. Statistical Robustness via PoE

Using Probability of Exceedance ensures:
- Representative samples at each operating regime
- Robust averaging (not skewed by outliers)
- Automatic handling of data quality issues

### 4. High Wind Cutout Logic

The `if (PcCon > 1.1) PcCon = 0.0` handles:
- High wind turbine shutdowns
- Prevents unrealistic forecasts during storms
- Matches actual operational behavior

## Our Current Approach (iLoad)

Our hybrid model uses:
- Generic power curve equation
- Single conversion factor or ML model
- Weather-based features without historical CF calibration

### Key Differences

| Aspect | iPool MREC | Our Approach |
|--------|------------|--------------|
| Conversion | 3-tier piecewise | Single equation/model |
| Calibration | Per-site from historical | Generic or cluster-based |
| Wind regimes | Explicit H/M/L tiers | Implicit in model |
| High wind cutout | Explicit logic | Not implemented |
| Input | Direct wind speed profile | Weather features |

## Recommended Implementation for iLoad

### Option 1: Direct Port of MREC

Add to our capacity factor system:

```typescript
interface MRECFactors {
    MRecH: number;   // High wind conversion
    MRecM: number;   // Mid wind conversion
    MRecL: number;   // Low wind conversion
    vH: number;      // High threshold (m/s)
    vL: number;      // Low threshold (m/s)
    calibrated: boolean;
}

function calibrateMREC(
    historicalCF: number[],      // Hourly CF values
    historicalWind: number[]     // Hourly wind speeds
): MRECFactors {
    // Sort pairs by wind speed descending
    // Calculate PoE thresholds (10%, 30%)
    // Compute average CF and wind at each tier
    // Return conversion factors
}

function applyMREC(windSpeed: number, factors: MRECFactors): number {
    let cf: number;

    if (windSpeed >= factors.vH) {
        cf = factors.MRecH * windSpeed;
    } else if (windSpeed >= factors.vL) {
        cf = factors.MRecM * windSpeed;
    } else {
        cf = factors.MRecL * windSpeed;
    }

    // High wind cutout
    if (cf > 1.1) return 0;
    if (cf > 1.0) return 1.0;
    return cf;
}
```

### Option 2: ML-Enhanced MREC

Use ML to learn the tier boundaries and factors:
1. Train on historical CF + wind speed pairs
2. Automatically find optimal tier thresholds
3. Allow non-linear relationships within tiers

### Data Requirements

To implement MREC, we need per-station:
1. **Historical capacity factors** (hourly, at least 1 year)
2. **Historical wind speeds** (hourly, hub-height preferred)

This matches what we're already collecting for the cfac command.

## Next Steps

1. Implement MREC calibration in `src/models/capacityFactor/`
2. Add per-station MREC storage to database schema
3. Create calibration command: `iload cfac calibrate-mrec`
4. Modify forecast to use MREC when available
5. Compare results with current hybrid approach
