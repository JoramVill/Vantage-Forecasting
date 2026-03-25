# V1 Models Archive

This directory contains archived V1 model implementations that have been superseded by V2.

## Archived Files

- `hybridModel.ts` - The V1 HybridModel that used min/median/max profiles with temperature-based interpolation. This has been replaced by the V2 Level × Shape architecture.

## V1 vs V2 Architecture

### V1 (HybridModel) - DEPRECATED
- Used statistical profiles (min/median/max) per hour/daytype
- Temperature affected prediction within profile bounds
- Lag-based trend adjustment
- Single model handled both level and shape together

### V2 (Level × Shape) - CURRENT
- **Level Model**: XGBoost predicts daily total demand from weather + calendar + lags
- **Shape Model**: ProfileLibrary + ShapeAdjuster predicts normalized 24-hour profile
- **Final Forecast**: `dailyTotal × shape24h`
- Better weather responsiveness and cleaner separation of concerns

## Migration

The V1 commands are still available as `v1:forecast` but are deprecated. Use the V2 pipeline:

```bash
# V2 workflow (recommended)
node dist/index.js v2:train -d "Data Samples/Demand" -o models/demand.vfm
node dist/index.js v2:calibrate -m models/demand.vfm -d "Data Samples/Demand" -o models/calibration.json
node dist/index.js forecast -s 2026-03-01 -e 2026-03-30 -o output/forecast.csv

# Or use the simple forecast command (auto-detects models)
node dist/index.js forecast -s 2026-03-01 -e 2026-03-30 -o output/forecast.csv
```

## Date Archived

2026-03-25
