# iLoad Forecasting Utility - Application Overview

## Executive Summary

The iLoad Forecasting Utility is a comprehensive TypeScript-based command-line application designed for electricity demand forecasting and renewable energy capacity factor prediction. Built for the Philippine electricity market, it integrates historical demand data, real-time weather information, and advanced machine learning models to generate accurate short-term and medium-term forecasts.

**Version:** 1.0.0
**Technology Stack:** Node.js, TypeScript, XGBoost, SQLite, Visual Crossing Weather API

---

## Core Capabilities

### 1. Demand Forecasting
- Multi-variable regression and XGBoost models
- Hybrid forecasting combining statistical and ML approaches
- Support for multiple grid regions (Luzon, Visayas, Mindanao)
- 1-day and 1-week ahead predictions
- Historical data-driven lag feature engineering

### 2. Capacity Factor Forecasting
- Technology-specific models for renewable generation:
  - Wind power (with 100m hub-height wind data)
  - Solar photovoltaic (irradiance-based)
  - Hydro storage
  - Geothermal
  - Biomass
  - Battery storage
- Cluster-based weather mapping for distributed stations
- Individual station-level forecasts

### 3. Outage Analysis
- Historical outage pattern analysis
- Probability-based risk assessment
- Time-period and region-specific insights
- Severity classification (Critical, High, Medium, Low)

### 4. Weather Integration
- Automated weather data fetching (Visual Crossing API)
- Intelligent caching system
- Multi-location support
- Historical and forecast weather data
- Specialized 100m wind data for wind farms

### 5. Database Management
- SQLite-based data persistence
- Demand and weather record storage
- Model version management
- Automated data import/export
- Historical data archival

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                    iLoad Forecasting Utility                    │
└───────────────────────────┬─────────────────────────────────────┘
                            │
        ┌───────────────────┼───────────────────┐
        │                   │                   │
        v                   v                   v
┌───────────────┐   ┌──────────────┐   ┌──────────────┐
│  CLI Interface│   │   Services   │   │   Database   │
│  (Commander)  │   │              │   │   (SQLite)   │
└───────┬───────┘   └──────┬───────┘   └──────┬───────┘
        │                  │                   │
        │                  │                   │
        v                  v                   v
┌───────────────────────────────────────────────────────┐
│  Core Components                                       │
├────────────────┬────────────────┬─────────────────────┤
│  Parsers       │  Models        │  Feature Engine     │
│  - Demand CSV  │  - Regression  │  - Lag features     │
│  - Weather CSV │  - XGBoost     │  - Time features    │
│  - CFac CSV    │  - Hybrid      │  - Weather features │
│  - Outage CSV  │  - CFac Models │  - Rolling averages │
└────────────────┴────────────────┴─────────────────────┘
```

### Key Architectural Patterns

1. **Modular Design**: Clear separation of concerns (parsers, models, services, writers)
2. **Dependency Injection**: Service instances passed through function parameters
3. **Type Safety**: Comprehensive TypeScript type definitions
4. **Data Pipeline**: CSV → Parse → Feature Engineering → Model → Forecast → Output
5. **Caching Strategy**: Weather data cached locally to minimize API calls

---

## Technology Stack Details

### Core Technologies
- **Node.js v20+**: JavaScript runtime environment
- **TypeScript v5.3+**: Type-safe language
- **Commander.js**: CLI framework
- **Luxon**: DateTime manipulation
- **Better-SQLite3**: Synchronous SQLite database

### Machine Learning
- **@fractal-solutions/xgboost-js**: XGBoost implementation for Node.js
- **ml-regression-multivariate-linear**: Multivariate linear regression

### Data Processing
- **csv-parse**: CSV parsing
- **csv-stringify**: CSV writing
- **Axios**: HTTP client for weather API

---

## Data Flow

### Training Workflow
```
Historical CSV Files → Parse Data → Merge with Weather
                                           ↓
                                    Feature Engineering
                                           ↓
                                    Train Models (Regression/XGBoost)
                                           ↓
                                    Evaluate & Save Models
                                           ↓
                                    Generate Reports
```

### Forecasting Workflow
```
Load/Train Model ← Historical Data (for lag features)
        ↓
Fetch Weather Forecast (Visual Crossing API)
        ↓
Build Feature Vectors (with lag values)
        ↓
Generate Predictions (hour-by-hour)
        ↓
Scale & Adjust (optional)
        ↓
Write Forecast CSV + Update Database
```

### Capacity Factor Workflow
```
Parse CFac Historical Data → Load Station Metadata
                                    ↓
            Fetch Cluster Weather (100m wind for wind stations)
                                    ↓
            Build Training Samples (station + weather)
                                    ↓
            Train Technology-Specific Models
                                    ↓
            Fetch Forecast Weather
                                    ↓
            Generate Station Forecasts
                                    ↓
            Write CFac Forecast CSV
```

---

## Key Features

### Multi-Region Support
- **Luzon**: Northern Philippines grid (largest)
- **Visayas**: Central Philippines grid
- **Mindanao**: Southern Philippines grid
- Automatic region mapping from location names

### Time-Aware Features
- Hour of day (0-23)
- Day of week (Monday=1, Sunday=7)
- Weekend/workday distinction
- Seasonal patterns

### Lag Feature Engineering
- 1-hour lag (most recent demand)
- 24-hour lag (same hour yesterday)
- 168-hour lag (same hour last week)
- 24-hour rolling averages
- Temperature lags

### Model Types

1. **Regression Model**
   - Fast training
   - Interpretable coefficients
   - Good baseline performance
   - Linear relationships

2. **XGBoost Model**
   - Non-linear patterns
   - Feature importance analysis
   - Higher accuracy potential
   - Longer training time

3. **Hybrid Model**
   - Combines regression + recent patterns
   - Demand growth factor
   - Adaptive to trends
   - Best for evolving demand

### Capacity Factor Models

- **Wind**: Power curve + hub-height wind + direction
- **Solar**: Clear-sky irradiance + cloud cover + geometry
- **Hydro**: Profile-based + seasonal patterns
- **Geothermal**: Stable baseload + minor weather effects
- **Biomass**: Profile-based generation
- **Battery**: Charge/discharge patterns

---

## Input Data Requirements

### Demand Data Format
```csv
DateTimeEnding,Luzon,Visayas,Mindanao
1/1/2024 1:00,7500.5,1200.3,1450.2
1/1/2024 2:00,7200.1,1150.8,1400.5
```

### Weather Data Format
Visual Crossing API format:
```csv
datetime,temp,dew,precip,windgust,windspeed,cloudcover,solarradiation,solarenergy,uvindex
2024-01-01T00:00:00,27.5,24.2,0,35.6,12.5,45,0,0,0
```

### Capacity Factor Format
```csv
DateTimeEnding,01BAKUN,01BURGOS,01CLARK,...
1/1/2024 1:00,0.85,0.42,0.91,...
```

### Outage Events Format
```csv
DateTimeEnding,Region,OutageType,Severity,MW_Lost
1/15/2024 14:00,Luzon,Transmission,High,500
```

---

## Output Formats

### Demand Forecast
```csv
DateTimeEnding,Luzon,Visayas,Mindanao
12/10/2025 1:00,7850.5,1250.3,1520.2
```

### Capacity Factor Forecast
```csv
DateTimeEnding,01BAKUN,01BURGOS,01CLARK,...
12/10/2025 1:00,0.82,0.45,0.88,...
```

### Training Reports
- Markdown format with model metrics
- Coefficient/feature importance tables
- Performance comparisons
- Validation results

### Outage Analysis
- Risk assessment by time period
- Region-specific probabilities
- Historical pattern analysis
- Severity distribution

---

## Configuration

### Environment Variables
- `VISUAL_CROSSING_API_KEY`: Weather API authentication

### Config File (config.json)
```json
{
  "visualCrossingApiKey": "your_key_here"
}
```

### Database Location
- Default: `data/iload.db`
- Stores demand, weather, models, outages

### Cache Directory
- Default: `weather_cache/`
- Reduces API calls
- Organized by location and date range

---

## Performance Characteristics

### Model Training
- Regression: < 1 second (90 days data)
- XGBoost: 10-30 seconds (90 days data)
- Capacity Factor: 1-2 minutes (all stations)

### Forecasting Speed
- 1-day ahead: < 5 seconds
- 1-week ahead: < 15 seconds
- Capacity factor: < 30 seconds

### Database Performance
- Import: ~1000 records/second
- Query: Sub-millisecond for indexed queries
- Storage: ~1 MB per month of hourly data

---

## Accuracy Expectations

### Demand Forecasting
- **1-day ahead MAPE**: 2-5% (excellent)
- **1-week ahead MAPE**: 5-10% (good)
- **Peak demand accuracy**: Typically within 3-7%

### Capacity Factor Forecasting
- **Wind**: 10-15% MAPE (weather-dependent)
- **Solar**: 8-12% MAPE (more predictable)
- **Hydro/Geothermal/Biomass**: 5-10% MAPE (stable)

---

## Use Cases

### 1. Daily Grid Operations
- Next-day demand planning
- Unit commitment scheduling
- Reserve requirement calculation

### 2. Weekly Planning
- Maintenance scheduling
- Fuel procurement
- Contract management

### 3. Renewable Integration
- Variable RE output prediction
- Grid stability planning
- Storage dispatch optimization

### 4. Risk Management
- Outage probability assessment
- Contingency planning
- Reliability analysis

### 5. Market Operations
- Price forecasting inputs
- Bidding strategy support
- Load settlement

---

## Limitations and Considerations

### Weather Dependency
- Forecast accuracy limited by weather forecast accuracy
- Extreme weather events may exceed model training range
- Visual Crossing API has daily request limits

### Data Requirements
- Minimum 30 days historical data for training
- 90 days recommended for robust models
- Weather and demand must be time-aligned

### Model Assumptions
- Linear/non-linear relationships in training data persist
- No major structural changes (new large loads/generation)
- Historical patterns remain relevant

### Geographic Scope
- Designed for Philippine electricity market
- Location mappings specific to Luzon/Visayas/Mindanao
- Station metadata for Philippine renewable assets

---

## Extensibility

### Adding New Regions
1. Update `REGION_MAPPINGS` in constants
2. Add location to `DEFAULT_LOCATIONS` in services
3. Ensure demand CSV includes region column

### Adding New Models
1. Implement model class extending base model interface
2. Add training and prediction methods
3. Register in CLI command handlers

### Adding New Capacity Factor Technologies
1. Create model class in `src/models/capacityFactor/`
2. Implement technology-specific physics
3. Register in `ModelRouter`

### Custom Weather Sources
1. Implement weather service interface
2. Add parser for new format
3. Update weather service factory

---

## Best Practices

### For Training
- Use at least 90 days of recent data
- Include diverse weather conditions
- Validate data quality before training
- Compare multiple model types

### For Forecasting
- Retrain models monthly with latest data
- Monitor forecast accuracy
- Use ensemble/hybrid approaches for critical forecasts
- Apply scale adjustments based on recent errors

### For Production Use
- Implement automated daily workflows
- Monitor API usage and costs
- Maintain database backups
- Log all operations for audit

---

## Support and Maintenance

### Regular Maintenance Tasks
- Monthly model retraining
- Quarterly data cleanup
- Annual station metadata updates
- Weather API key rotation

### Monitoring Recommendations
- Track forecast vs actual MAPE
- Monitor database size growth
- Check weather API quota usage
- Verify daily forecast generation

### Troubleshooting Resources
- Check `CLAUDE.md` for development notes
- Review service logs in `logs/`
- Inspect database with `iload db status`
- Validate configuration with `iload service config`

---

## Roadmap

### Current Version (1.0.0)
- Core demand and capacity factor forecasting
- Database management
- CLI interface
- Manual execution

### Planned Features (2.0.0)
- Automated daily service
- Web dashboard
- Email notifications
- Real-time API
- Enhanced model versioning

### Future Considerations
- Cloud deployment
- Multi-market support
- Advanced ML models (LSTM, Transformer)
- Ensemble forecasting
- Probabilistic forecasts

---

**Document Version:** 1.0
**Last Updated:** 2025-12-10
**Maintained By:** Development Team
