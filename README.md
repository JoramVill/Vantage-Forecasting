# iLoad Forecasting Utility

A Node.js-based electricity load forecasting utility that uses XGBoost and Multiple Linear Regression with multi-variable weather data to predict electricity demand for the Philippines power grid.

## Overview

This utility provides machine learning-based demand forecasting for the Philippine electricity market, supporting three major regions:
- **CLUZ** (Luzon) - Manila weather data
- **CVIS** (Visayas) - Cebu City weather data
- **CMIN** (Mindanao) - Davao City weather data

The tool combines historical demand patterns with comprehensive weather data to generate accurate hourly demand forecasts.

## Key Features

### Multiple ML Models
- **XGBoost**: Gradient boosting for high-accuracy predictions (typical R² 0.92-0.97)
- **Multiple Linear Regression**: Fast baseline model with interpretable coefficients (typical R² 0.85-0.90)
- **Model Comparison**: Automatic side-by-side performance analysis

### Rich Weather Features (30+ features)
**Temporal Features (6)**
- hour, dayOfWeek, isWeekend, isHoliday, dayOfMonth, month

**Raw Weather Features (8)**
- temp, dew, precip, windgust, windspeed, cloudcover, solarradiation, uvindex

**Derived Weather Features (8)**
- relativeHumidity (Magnus formula from temp/dew point)
- heatIndex (Rothfusz regression for tropical climate)
- CDH (Cooling Degree Hours, base 24°C for Philippines)
- effectiveSolar (solar radiation × cloud factor)
- apparentTemp (wind-adjusted temperature)
- isRaining, tempDewSpread, isDaytime

**Lag Features (8)**
- demand_lag_1h, demand_lag_24h, demand_lag_168h (1 week)
- temp_lag_1h, temp_lag_24h
- demand_rolling_24h, temp_rolling_24h, temp_max_24h

### Multi-Region Support
Handles multiple regions simultaneously with automatic city-to-region mapping.

### CLI Interface
Easy-to-use command-line interface with three main commands:
- `train` - Train models on historical data
- `forecast` - Generate demand forecasts
- `info` - Display data file information

## Installation

### Prerequisites
- Node.js 18+
- npm or yarn

### Setup

```bash
# Navigate to project directory
cd iLoad_Forecasting_Utility

# Install dependencies
npm install

# Build TypeScript to JavaScript
npm run build
```

### Optional: Global Installation

```bash
# Link globally for system-wide access
npm link

# Now you can use 'iload' command anywhere
iload --help
```

## Quick Start

### 1. View Data Information

```bash
node dist/index.js info \
  -d "Data Samples/DemandHr_Month_Historical_1.csv" \
  -w "Data Samples/Weather_hourly_manila_2025-10-01_2025-12-03.csv" \
     "Data Samples/Weather_hourly_cebu_2025-10-01_2025-12-03.csv" \
     "Data Samples/Weather_hourly_davao_2025-10-01_2025-12-03.csv"
```

### 2. Train Models

Train both XGBoost and Regression models:

```bash
node dist/index.js train \
  -d "Data Samples/DemandHr_Month_Historical_1.csv" \
  -w "Data Samples/Weather_hourly_manila_2025-10-01_2025-12-03.csv" \
     "Data Samples/Weather_hourly_cebu_2025-10-01_2025-12-03.csv" \
     "Data Samples/Weather_hourly_davao_2025-10-01_2025-12-03.csv" \
  -o ./output \
  --model both
```

### 3. Generate Forecasts

```bash
node dist/index.js forecast \
  -d "Data Samples/DemandHr_Month_Historical_1.csv" \
  --weather-hist "Data Samples/Weather_hourly_manila_2025-10-01_2025-12-03.csv" \
                 "Data Samples/Weather_hourly_cebu_2025-10-01_2025-12-03.csv" \
                 "Data Samples/Weather_hourly_davao_2025-10-01_2025-12-03.csv" \
  --weather-forecast "Data Samples/Weather_forecast_manila.csv" \
                     "Data Samples/Weather_forecast_cebu.csv" \
                     "Data Samples/Weather_forecast_davao.csv" \
  -o forecast_output.csv \
  --model xgboost
```

## Data Formats

### Input: Demand CSV

```csv
DateTimeEnding,CLUZ,CVIS,CMIN
10/1/2025 01:00,9152,1241,1909
10/1/2025 02:00,8911,1105,1851
10/1/2025 03:00,8654,1087,1822
```

**Format:**
- `DateTimeEnding`: Hour-ending timestamp (M/D/YYYY H:mm format)
- Region columns: Demand values in MW (megawatts) for each region
- Hourly interval data

### Input: Weather CSV

```csv
name,latitude,longitude,datetime,temp,dew,precip,windgust,windspeed,cloudcover,solarradiation,solarenergy,uvindex
Manila,14.596,120.977,2025-10-01T00:00:00,27,26,0,6.8,5.4,99.9,0,0,0
Manila,14.596,120.977,2025-10-01T01:00:00,27,26,0,7.2,5.8,100,0,0,0
```

**Format:**
- `datetime`: Hour-starting timestamp (ISO 8601 format: YYYY-MM-DDTHH:mm:ss)
- `temp`: Temperature (°C)
- `dew`: Dew point (°C)
- `precip`: Precipitation (mm)
- `windgust`: Wind gust speed (km/h)
- `windspeed`: Wind speed (km/h)
- `cloudcover`: Cloud cover percentage (0-100)
- `solarradiation`: Solar radiation (W/m²)
- `solarenergy`: Solar energy (MJ/m²)
- `uvindex`: UV index (0-11+)

**Note:** Weather data uses hour-starting timestamps while demand uses hour-ending. The tool automatically aligns these by adding 1 hour to weather timestamps.

### Output: Forecast CSV

```csv
datetime,region,predictedDemand
2025-12-04T01:00:00.000Z,CLUZ,9234.56
2025-12-04T01:00:00.000Z,CVIS,1345.32
2025-12-04T01:00:00.000Z,CMIN,1976.45
```

**Format:**
- `datetime`: ISO 8601 timestamp
- `region`: Region code (CLUZ, CVIS, CMIN)
- `predictedDemand`: Forecasted demand in MW

## CLI Reference

### `train` Command

Train forecasting models on historical data and generate performance reports.

**Usage:**
```bash
node dist/index.js train -d <demand_file> -w <weather_files...> [options]
```

**Options:**

| Option | Description | Required | Default |
|--------|-------------|----------|---------|
| `-d, --demand <file>` | Historical demand CSV file | Yes | - |
| `-w, --weather <files...>` | Weather CSV files (space-separated) | Yes | - |
| `-o, --output <dir>` | Output directory for reports | No | `./output` |
| `--model <type>` | Model type: `regression`, `xgboost`, or `both` | No | `both` |

**Output Files:**
- `regression_report.md` - Detailed regression model metrics and analysis
- `xgboost_report.md` - Detailed XGBoost model metrics and analysis
- `comparison.md` - Side-by-side model comparison (when using `--model both`)

**Example Output:**
```
🔄 Loading data...
  📊 Demand: 1512 records, regions: CLUZ, CVIS, CMIN
  🌤️  Weather: Manila - 1512 records
  🌤️  Weather: Cebu City - 1512 records
  🌤️  Weather: Davao City - 1512 records

🔗 Merging datasets...
  ✅ Matched: 4536 records
  ⚠️  Unmatched demand: 0, weather: 0

🔧 Engineering features...
  📐 Training samples: 3969 (after lag filtering)

📈 Training Regression model...
  R² = 0.8542, MAPE = 5.23%
  📄 Report: output/regression_report.md

🌲 Training XGBoost model...
  R² = 0.9124, MAPE = 3.87%
  📄 Report: output/xgboost_report.md

📊 Comparison: output/comparison.md

✅ Training complete!
```

### `forecast` Command

Generate demand forecasts using weather forecast data.

**Usage:**
```bash
node dist/index.js forecast -d <demand_file> -w <hist_weather...> -f <forecast_weather...> -o <output_file> [options]
```

**Options:**

| Option | Description | Required | Default |
|--------|-------------|----------|---------|
| `-d, --demand <file>` | Historical demand CSV (for model training) | Yes | - |
| `-w, --weather-hist <files...>` | Historical weather CSV files | Yes | - |
| `-f, --weather-forecast <files...>` | Forecast weather CSV files | Yes | - |
| `-o, --output <file>` | Output forecast CSV file path | Yes | - |
| `--model <type>` | Model type: `regression` or `xgboost` | No | `xgboost` |

**Process:**
1. Trains the selected model on historical data
2. Generates forecasts for each hour in the forecast weather data
3. Uses lag features from both history and progressively generated forecasts
4. Outputs predictions in standard CSV format

**Example Output:**
```
🔄 Loading historical data for training...
  📐 Training samples: 3969

🎯 Training xgboost model...

🌤️  Loading forecast weather...

🔮 Generating forecasts...

✅ Forecast written to: forecast_output.csv
   📊 72 predictions across 3 regions
```

### `info` Command

Display summary information about data files.

**Usage:**
```bash
node dist/index.js info -d <demand_file> [-w <weather_files...>]
```

**Options:**

| Option | Description | Required | Default |
|--------|-------------|----------|---------|
| `-d, --demand <file>` | Demand CSV file | Yes | - |
| `-w, --weather <files...>` | Weather CSV files (optional) | No | - |

**Example Output:**
```
📊 Data Summary

Demand Data:
  File: Data Samples/DemandHr_Month_Historical_1.csv
  Records: 1512
  Regions: CLUZ, CVIS, CMIN
  Date Range: 2025-10-01T00:00:00.000Z to 2025-12-03T23:00:00.000Z

Weather Data:
  Manila:
    File: Data Samples/Weather_hourly_manila_2025-10-01_2025-12-03.csv
    Records: 1512
    Date Range: 2025-10-01T00:00:00.000Z to 2025-12-03T23:00:00.000Z
  Cebu City:
    File: Data Samples/Weather_hourly_cebu_2025-10-01_2025-12-03.csv
    Records: 1512
    Date Range: 2025-10-01T00:00:00.000Z to 2025-12-03T23:00:00.000Z
  Davao City:
    File: Data Samples/Weather_hourly_davao_2025-10-01_2025-12-03.csv
    Records: 1512
    Date Range: 2025-10-01T00:00:00.000Z to 2025-12-03T23:00:00.000Z
```

## Model Performance

Expected performance on Philippines electricity demand data:

| Model | R² Score | MAPE | Training Time | Use Case |
|-------|----------|------|---------------|----------|
| XGBoost | 0.92-0.97 | 2-4% | Moderate | Production forecasting, best accuracy |
| Multiple Regression | 0.85-0.90 | 4-8% | Fast | Quick baseline, interpretability |

**Performance Notes:**
- Metrics vary based on data quality, date range, and weather variability
- XGBoost handles non-linear relationships better (heat stress, humidity effects)
- Regression provides interpretable coefficients for feature importance
- Both models use identical feature engineering pipeline

## Project Structure

```
iLoad_Forecasting_Utility/
├── src/
│   ├── index.ts                 # CLI entry point
│   ├── types/
│   │   ├── index.ts             # TypeScript interfaces
│   │   └── xgboost.d.ts         # XGBoost type declarations
│   ├── constants/
│   │   └── index.ts             # Configuration constants
│   ├── parsers/
│   │   ├── demandParser.ts      # Demand CSV parser
│   │   ├── weatherParser.ts     # Weather CSV parser
│   │   └── index.ts
│   ├── utils/
│   │   ├── dataMerger.ts        # Merge demand + weather
│   │   └── index.ts
│   ├── features/
│   │   ├── featureEngineering.ts # Feature extraction
│   │   └── index.ts
│   ├── models/
│   │   ├── regressionModel.ts   # Multiple Linear Regression
│   │   ├── xgboostModel.ts      # XGBoost implementation
│   │   └── index.ts
│   └── writers/
│       ├── forecastWriter.ts    # Forecast CSV writer
│       ├── reportWriter.ts      # Model report generator
│       └── index.ts
├── Data Samples/                # Sample data files
├── output/                      # Generated reports (created on train)
├── dist/                        # Compiled JavaScript (after build)
├── package.json                 # Dependencies and scripts
├── tsconfig.json               # TypeScript configuration
├── README.md                    # This file
├── CLI_USAGE.md                # Detailed CLI documentation
├── context.md                   # Implementation context
└── *.md                         # Additional documentation
```

## Region Mapping

The utility automatically maps weather cities to demand regions:

| Weather City | Demand Column | Region Name |
|--------------|---------------|-------------|
| Manila | CLUZ | Luzon |
| Cebu City | CVIS | Visayas |
| Davao City | CMIN | Mindanao |

Cities are matched case-insensitively during data merging.

## Feature Engineering Details

### Temporal Features
- **hour** (0-23): Hour of day, captures daily demand patterns
- **dayOfWeek** (0-6): Day of week (0=Sunday), captures weekly cycles
- **isWeekend** (0/1): Binary flag for weekend vs weekday
- **isHoliday** (0/1): Philippines public holidays (2025 calendar)
- **dayOfMonth** (1-31): Day number for monthly patterns
- **month** (1-12): Month number for seasonal patterns

### Derived Weather Features
- **relativeHumidity**: Calculated using Magnus formula from temp and dew point
- **heatIndex**: Rothfusz regression for feels-like temperature (tropical climate)
- **CDH**: Cooling Degree Hours (temp - 24°C base, tropical standard)
- **effectiveSolar**: Solar radiation adjusted for cloud cover
- **apparentTemp**: Temperature adjusted for wind chill
- **isRaining**: Binary flag for precipitation > 0.1mm
- **tempDewSpread**: Temperature minus dew point (humidity indicator)
- **isDaytime**: Hour between 6:00-18:00

### Lag Features
Provide temporal context from historical data:
- **demandLag1h, demandLag24h, demandLag168h**: Previous demand at 1h, 24h, 7d ago
- **tempLag1h, tempLag24h**: Previous temperature
- **demandRolling24h, tempRolling24h**: 24-hour rolling averages
- **tempMax24h**: Maximum temperature in last 24 hours

**Note:** First 168 hours (7 days) of data are filtered during training due to missing lag features.

## Configuration

### Philippines Holidays (2025)
Configured in `src/constants/index.ts`:
- New Year, Chinese New Year, EDSA Revolution, Araw ng Kagitingan
- Holy Week (Maundy Thursday, Good Friday, Black Saturday)
- Labor Day, Independence Day, National Heroes Day
- All Saints Day, Bonifacio Day, Rizal Day, Christmas, New Year's Eve

### Temperature Base
- Cooling Degree Hours base: **24°C** (tropical climate standard)

### Model Defaults
- XGBoost: maxDepth=6, learningRate=0.1, nEstimators=100, validationSplit=0.2
- Train/Test Split: 80/20

## Tips and Best Practices

### Data Requirements
1. **Minimum Data**: At least 7 days (168 hours) of historical data for lag features
2. **Data Quality**: Ensure no missing timestamps in demand or weather data
3. **Alignment**: Weather and demand data should cover the same date ranges

### Model Selection
- **Use XGBoost when**:
  - Accuracy is critical
  - You have sufficient training data (1000+ hours)
  - Non-linear relationships are expected

- **Use Regression when**:
  - Fast training/predictions needed
  - Interpretability is important
  - Quick baseline comparison

### Forecasting
1. **Lag Feature Availability**: First forecast hours use historical lags, subsequent hours use generated forecasts
2. **Weather Forecast Quality**: Model accuracy depends heavily on weather forecast accuracy
3. **Progressive Forecasting**: Each prediction becomes part of lag history for next prediction

### File Management
- Use descriptive filenames for weather data (city names help with auto-matching)
- Keep output directory organized (separate folders for different experiments)
- Archive training reports for model performance tracking

## Troubleshooting

### "No training samples available"
- **Cause**: Insufficient historical data for lag features
- **Solution**: Provide at least 7 days (168 hours) of continuous data

### "Unmatched demand/weather records"
- **Cause**: Timestamp misalignment between demand and weather files
- **Solution**: Check date ranges match and timestamps are continuous

### Low Model Performance
- **Check**: Data quality (missing values, outliers)
- **Check**: Date range consistency across files
- **Check**: Weather city names match expected values (Manila/Cebu City/Davao City)
- **Try**: Increasing training data volume (more historical months)
- **Try**: Using `--model both` to compare regression vs XGBoost

### Module Import Errors
- **Solution**: Run `npm run build` after any code changes
- **Solution**: Ensure `"type": "module"` is in package.json

## Development

### Scripts

```bash
# Build TypeScript to JavaScript
npm run build

# Run directly (development)
npm run dev -- <command> [options]

# Start compiled version
npm start -- <command> [options]
```

### Adding Features
1. Add feature calculation to `src/features/featureEngineering.ts`
2. Add feature name to `FEATURE_NAMES` in `src/constants/index.ts`
3. Update `FeatureVector` interface in `src/types/index.ts`
4. Rebuild: `npm run build`

### Adding New Regions
1. Add city mapping to `REGION_MAPPINGS` in `src/constants/index.ts`
2. Ensure demand CSV has corresponding region column
3. Provide weather data for the new city

## Dependencies

**Production:**
- `commander` - CLI framework
- `csv-parse` - CSV parsing
- `csv-stringify` - CSV writing
- `luxon` - Date/time handling
- `ml-regression-multivariate-linear` - Multiple linear regression
- `@fractal-solutions/xgboost-js` - XGBoost implementation

**Development:**
- `typescript` - TypeScript compiler
- `@types/node`, `@types/luxon` - Type definitions
- `ts-node` - TypeScript execution

## License

ISC

## Support

For issues, questions, or contributions:
1. Check existing documentation (README.md, CLI_USAGE.md, context.md)
2. Review sample data in `Data Samples/` folder
3. Examine output reports for model diagnostics

## Version History

**v1.0.0** - Initial release
- XGBoost and Multiple Linear Regression models
- 30+ engineered features
- Three-region support (Luzon, Visayas, Mindanao)
- CLI interface with train/forecast/info commands
- Comprehensive model performance reports
