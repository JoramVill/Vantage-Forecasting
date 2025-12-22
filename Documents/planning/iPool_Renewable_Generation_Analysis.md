# iPool Renewable Energy Generation Forecasting Analysis

## Executive Summary

This document analyzes how iPool (iPoolVS19) predicts wind and solar generation using weather data. The system uses a **Point of Exceedance (POE)** approach combined with **Must-Run Energy Conversion (MREC) factors** to translate weather metrics (wind speed, solar irradiance) into capacity factors.

---

## 1. Core Concept: Point of Exceedance (POE)

### What is POE?

Point of Exceedance represents the probability that a value will be exceeded. In iPool:

| POE Level | Meaning | Weather Conditions |
|-----------|---------|-------------------|
| POE 10% (High) | Value exceeded only 10% of the time | High wind/strong solar |
| POE 20% (Medium) | Value exceeded 20% of the time | Moderate conditions |
| POE 30% (Low) | Value exceeded 30% of the time | Low wind/weak solar |

### POE Constants (ConstDefinitions.cpp)

```cpp
double PoEH  = 0.1;    // Wind: High energy elbow (10% exceedance)
double PoEL  = 0.3;    // Wind: Low energy elbow (30% exceedance)
double PoEHs = 0.1;    // Solar: High energy elbow (10% exceedance)
double PoELs = 0.3;    // Solar: Low energy elbow (30% exceedance)
```

---

## 2. Must-Run Energy Conversion (MREC) System

### Overview

MREC factors are conversion coefficients that translate weather values into capacity factors. The system uses a **three-segment piecewise linear model**:

```
Capacity Factor = Weather_Value × MREC_Factor
```

### MREC Factor Storage (ESite.h)

```cpp
double m_MRecH;    // Conversion factor at HIGH energy (above vH threshold)
double m_MRecM;    // Conversion factor at MEDIUM energy (between vL and vH)
double m_MRecL;    // Conversion factor at LOW energy (below vL threshold)
double m_MRvH;     // High elbow point (wind speed or irradiance threshold)
double m_MRvL;     // Low elbow point threshold
```

### The Piecewise Linear Curve

```
Capacity Factor (0-1.0)
    ^
1.0 |════════════════════════════════════  (100% cap limit)
    |          ╱
    |         ╱  MREC_H slope (high energy zone)
    |        ╱
    |═══════╱────────────────────────────  vH threshold
    |      ╱
    |     ╱  MREC_M slope (medium energy zone)
    |    ╱
    |═══╱────────────────────────────────  vL threshold
    |  ╱
    | ╱  MREC_L slope (low energy zone)
    |╱
0.0 └────────────────────────────────────> Weather Value
         vL        vH                        (wind m/s or solar W/m²)
```

---

## 3. Generation Calculation Algorithm

### Core Formula (ESite.cpp, lines 475-485)

```cpp
double MRVal = m_pDailyDP->GetMwCap(t);  // Weather input (wind speed or solar irradiance)

if (MRVal >= m_MRvH)                      // Above high threshold
    PcCon = m_MRecH * MRVal;               // Use high conversion factor
else if (MRVal >= m_MRvL)                 // Between thresholds
    PcCon = m_MRecM * MRVal;               // Use medium conversion factor
else                                       // Below low threshold
    PcCon = m_MRecL * MRVal;               // Use low conversion factor

// Safety limits
if (PcCon > 1.1 && m_FType == WIND)       // Wind turbine over-speed protection
    PcCon = 0.0;                           // Turbine shuts down
else if (PcCon > 1.0)                     // Hard cap at 100%
    PcCon = 1.0;

// Final generation = Site_Capacity_MW × PcCon
```

### Example Calculations

**Wind Farm (100 MW installed capacity):**

| Wind Speed | Zone | MREC Factor | Capacity Factor | Generation |
|------------|------|-------------|-----------------|------------|
| 3 m/s | Low (< vL) | 0.060 | 0.18 | 18 MW |
| 8 m/s | Medium | 0.075 | 0.60 | 60 MW |
| 12 m/s | High (> vH) | 0.080 | 0.96 | 96 MW |
| 15 m/s | High | 0.080 | 1.00 (capped) | 100 MW |

**Solar Plant (50 MW installed capacity):**

| Irradiance | Zone | MREC Factor | Capacity Factor | Generation |
|------------|------|-------------|-----------------|------------|
| 200 W/m² | Low | 0.0005 | 0.10 | 5 MW |
| 600 W/m² | Medium | 0.0007 | 0.42 | 21 MW |
| 950 W/m² | High | 0.0008 | 0.76 | 38 MW |

---

## 4. Calibration Process

### How MREC Factors Are Derived (DMREC.cpp)

The calibration algorithm uses historical data to calculate optimal MREC factors:

```
INPUT FILES:
├── CFacFile:   Historical capacity factors (actual generation / capacity)
├── SolarFile:  Historical solar irradiance measurements
├── WindFile:   Historical wind speed measurements
└── RestFile:   Other resource data

CALIBRATION STEPS:

1. Load all CSV data into profiles (EProfs)

2. For each renewable site:

   a. Calculate POE statistics from historical data:
      - CFacH = Average capacity factor at POE 10% (high conditions)
      - CFacM = Average capacity factor at POE 20% (medium)
      - CFacL = Average capacity factor at POE 30% (low)

      - WindH/SolarH = Weather value at POE 10%
      - WindM/SolarM = Weather value at POE 20%
      - WindL/SolarL = Weather value at POE 30%

   b. Determine elbow points:
      - vH = Weather value threshold at POE 10%
      - vL = Weather value threshold at POE 30%

   c. Calculate MREC conversion factors:
      - MREC_H = CFacH / WeatherH
      - MREC_M = CFacM / WeatherM
      - MREC_L = CFacL / WeatherL

3. Store factors to database for simulation use
```

### POE Calculation Algorithm (EProf.cpp, CalcLevHML)

```cpp
void EProfs::CalcLevHML(double& ValH, double& ValM, double& ValL,
                         double& vH, double& vL, int ftype)
{
    // 1. Build 25-bin histogram of all values
    // 2. Calculate cumulative distribution (highest to lowest)
    // 3. Find values at POE thresholds:
    //    - ValH = Average of top 10% values
    //    - ValM = Average of values between 10%-30%
    //    - ValL = Average of bottom 30% values
    // 4. vH, vL = Threshold values at elbow points
}
```

---

## 5. Data Flow Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        INPUT LAYER                               │
├─────────────────────────────────────────────────────────────────┤
│  CSV Files:                                                      │
│  ├── Wind Speed (m/s) per site per half-hour                    │
│  ├── Solar Irradiance (W/m²) per site per half-hour             │
│  └── Historical Capacity Factors per site                        │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                     CALIBRATION LAYER                            │
├─────────────────────────────────────────────────────────────────┤
│  DMREC Module:                                                   │
│  ├── LoadCsvFile() → SafeArray2D<double>                        │
│  ├── CreateProfs2() → EProfs collection                          │
│  ├── CalcLevHML() → POE statistics (H/M/L values + thresholds)  │
│  └── SetMRecHML() → Store MREC factors per site                 │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                     STORAGE LAYER                                │
├─────────────────────────────────────────────────────────────────┤
│  Per Site (ESite):                                               │
│  ├── m_MRecH, m_MRecM, m_MRecL  (conversion factors)            │
│  ├── m_MRvH, m_MRvL             (elbow thresholds)              │
│  ├── m_FType                     (WIND=3, SOL=4)                │
│  └── m_bMustRun                  (must-run flag)                │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    SIMULATION LAYER                              │
├─────────────────────────────────────────────────────────────────┤
│  For each time step t:                                           │
│  ├── MRVal = GetMwCap(t)         (weather value from profile)   │
│  ├── Apply MREC conversion:                                      │
│  │   if MRVal >= vH: PcCon = MRVal × MREC_H                     │
│  │   elif MRVal >= vL: PcCon = MRVal × MREC_M                   │
│  │   else: PcCon = MRVal × MREC_L                               │
│  ├── Clamp PcCon to [0, 1.0]                                    │
│  └── Generation = Site_Capacity × PcCon                          │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                      OUTPUT LAYER                                │
├─────────────────────────────────────────────────────────────────┤
│  ├── Hourly/Half-hourly generation (MW) per site                │
│  ├── Capacity factors per site                                   │
│  └── Dispatch to market simulation                               │
└─────────────────────────────────────────────────────────────────┘
```

---

## 6. Key Source Files

| File | Purpose |
|------|---------|
| `ESite.cpp` | Main generation calculation, MREC application |
| `ESite.h` | Site class with MREC factor storage |
| `EProf.cpp` | Profile management, CalcLevHML POE calculation |
| `EProf.h` | Profile class definition |
| `DMREC.cpp` | Calibration dialog and algorithm |
| `ConstDefinitions.cpp` | POE threshold constants |
| `EWeibulSet.cpp` | Weibull distribution for wind modeling |

---

## 7. Wind-Specific Features

### Weibull Distribution Support

iPool stores Weibull parameters for stochastic wind modeling:

```cpp
struct EWeibul {
    double a;    // Shape parameter
    double b;    // Scale parameter
    double S;    // Additional parameter
};

// Database: SELECT [ID], [a], [b], [s] FROM [WeibulParams]
```

### Wind Turbine Over-Speed Protection

```cpp
if (PcCon > 1.1 && m_FType == WIND)
    PcCon = 0.0;  // Turbine shuts down at excessive wind speeds
```

### Wind Randomization

```cpp
if (GetSim()->m_bRandOut && GetSim()->m_bRandWth && m_FType == WIND)
{
    // Draw random profile from surrounding 7-14 days
    // Adds realistic variability to wind generation
}
```

---

## 8. Solar-Specific Features

### Solar POE Thresholds

Solar can have different POE thresholds than wind (though currently set to same values):

```cpp
double PoEHs = 0.1;    // Solar high energy threshold
double PoELs = 0.3;    // Solar low energy threshold
```

### Solar Diurnal Pattern

Solar irradiance naturally follows a diurnal pattern (zero at night), which is captured in the historical profiles used for calibration.

---

## 9. Limitations of Current Approach

### Strengths

1. **Simple and Fast**: Piecewise linear model is computationally efficient
2. **POE-Based**: Captures statistical distribution of weather conditions
3. **Site-Specific**: Each site has its own calibrated MREC factors
4. **Historical Calibration**: Factors derived from actual generation data

### Weaknesses

1. **Linear Assumption**: Real power curves are non-linear (especially wind)
2. **Only 3 Segments**: Coarse approximation of actual weather-generation relationship
3. **No Time-of-Day Effects**: Doesn't capture hour-specific variations beyond weather
4. **No Temperature Correction**: Solar efficiency varies with temperature
5. **Static Factors**: MREC factors don't adapt to seasonal changes
6. **No Machine Learning**: Doesn't leverage patterns in historical data

---

## 10. Proposed ML-Based Approach for iLoad

### Key Improvements

| Current (iPool) | Proposed (iLoad) |
|-----------------|------------------|
| 3-segment piecewise linear | ML regression model |
| POE-based thresholds | Data-driven feature engineering |
| Manual calibration | Automatic training from historical data |
| Single weather variable | Multiple features (temp, humidity, etc.) |
| Site-specific hardcoded factors | Learned per-site models |

### Proposed Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        TRAINING PHASE                            │
├─────────────────────────────────────────────────────────────────┤
│  Inputs:                                                         │
│  ├── Historical capacity factors (from WESM data)               │
│  ├── Historical weather data (Visual Crossing API)              │
│  │   ├── Wind speed, gusts                                      │
│  │   ├── Solar irradiance (GHI, DNI, DHI)                       │
│  │   ├── Temperature, humidity                                  │
│  │   └── Cloud cover                                            │
│  └── Temporal features (hour, month, day type)                   │
│                                                                  │
│  Model: Hybrid approach per station type                         │
│  ├── Wind: Regression with wind speed features + lag patterns   │
│  ├── Solar: Regression with irradiance + temperature correction │
│  └── Hydro: Profile-based with seasonal adjustment               │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                       PREDICTION PHASE                           │
├─────────────────────────────────────────────────────────────────┤
│  1. Fetch forecast weather for station coordinates               │
│  2. Engineer features (same as training)                         │
│  3. Apply trained model to predict capacity factor               │
│  4. Clamp to [0, 1.0] and apply to installed capacity           │
└─────────────────────────────────────────────────────────────────┘
```

### Feature Engineering for Wind

```typescript
interface WindFeatures {
  windSpeed: number;           // Primary driver
  windGust: number;            // Peak gusts
  windDirection: number;       // May affect turbine efficiency
  hourSin: number;             // Cyclical hour encoding
  hourCos: number;
  isNight: boolean;            // Night-time wind patterns differ
  lag1h: number;               // Previous hour wind
  lag24h: number;              // Same hour yesterday
  rollingAvg6h: number;        // Recent trend
}
```

### Feature Engineering for Solar

```typescript
interface SolarFeatures {
  solarIrradiance: number;     // Primary driver (GHI)
  cloudCover: number;          // Direct impact on generation
  temperature: number;         // Panel efficiency decreases at high temp
  humidity: number;            // Affects atmospheric clarity
  hourSin: number;             // Solar angle proxy
  hourCos: number;
  elevation: number;           // Sun elevation angle
  azimuth: number;             // Sun azimuth angle
  clearSkyIndex: number;       // Actual vs theoretical max
}
```

---

## 11. Next Steps

1. **Data Preparation**
   - Parse historical capacity factor CSVs
   - Map station codes to coordinates
   - Fetch matching weather data from Visual Crossing

2. **Model Development**
   - Implement WindCapacityModel class
   - Implement SolarCapacityModel class
   - Train on historical data

3. **Validation**
   - Compare ML predictions vs actual capacity factors
   - Compare against iPool's MREC approach

4. **Integration**
   - Add `cfac forecast` command to iLoad CLI
   - Generate capacity factor CSVs in WESM format

---

## References

### iPool Source Files Analyzed

- `C:\Source_Codes\iPoolVS19\iPool2019\iPool\App\ESite.cpp` (lines 475-493)
- `C:\Source_Codes\iPoolVS19\iPool2019\iPool\App\ESite.h` (lines 65-76)
- `C:\Source_Codes\iPoolVS19\iPool2019\iPool\App\EProf.cpp` (lines 1978-2069)
- `C:\Source_Codes\iPoolVS19\iPool2019\iPool\DMREC.cpp` (lines 91-179)
- `C:\Source_Codes\iPoolVS19\iPool2019\iPool\ConstDefinitions.cpp` (lines 112-115)
- `C:\Source_Codes\iPoolVS19\iPool2019\iPool\Database\EWeibulSet.cpp`

### External Sources

- [Burgos Wind Farm - Global Energy Monitor](https://www.gem.wiki/Burgos_Wind_Power_Project)
- [Cadiz Solar Power Plant - Wikipedia](https://en.wikipedia.org/wiki/Cadiz_Solar_Power_Plant)
- [Tiwi Geothermal - Global Energy Observatory](https://globalenergyobservatory.org/geoid/41711)

---

*Document created: 2025-12-04*
*For: iLoad Forecasting Utility - Capacity Factor Module Planning*
