---
Status: Active
Last-Updated: 2026-03-22
Updated-By: codebase-documenter
---

# Vantage Forecaster

A comprehensive electricity demand and renewable capacity factor forecasting system for the Philippines power grid. Features a desktop GUI, CLI tools, automated scheduling, and gateway integration.

## Features

- **Demand Forecasting**: Regional (3 regions) and Zonal (14 sub-regions) electricity load prediction
- **Capacity Factor Forecasting**: Wind and Solar generation forecasting with physics-based and ML hybrid models
- **Desktop GUI**: Electron-based application for easy operation
- **Automated Scheduling**: Background service for daily/weekly forecast generation
- **Gateway Integration**: SFTP push to Vantage Gateway for downstream systems
- **Portable Deployment**: Self-contained Windows distribution with no installation required

## Model Performance

| Forecast Type | Model | Typical Accuracy |
|--------------|-------|------------------|
| Demand | Hybrid (XGBoost + profiles) | 2-4% MAPE |
| Wind CFAC | 4-Tier Hybrid | ~73% MAPE |
| Solar CFAC | Physics+ML | ~16% MAPE |

## Quick Start

### Option 1: Desktop GUI (Recommended)

```bash
cd gui
npm install
npm run dev
```

### Option 2: CLI

```bash
# Build
npm install
npm run build

# Demand forecast
node dist/index.js forecast -d "Data Samples/Demand" -s 2026-01-01 -e 2026-01-31 -o output/demand.csv

# Capacity factor forecast
node dist/index.js cfac forecast2 -t "Data Samples/Capacity Factor" -s 2026-01-01 -e 2026-01-31 -o output/cfac.csv
```

### Option 3: Portable Distribution

Download the pre-built portable package, extract, and run `Vantage Forecaster.exe`.

## Documentation

| Document | Description |
|----------|-------------|
| [CLAUDE.md](CLAUDE.md) | **Primary reference** - Commands, models, architecture |
| [Documents/DOCUMENTATION_INDEX.md](Documents/DOCUMENTATION_INDEX.md) | Complete documentation index |
| [Documents/QUICK_START.md](Documents/QUICK_START.md) | 5-minute getting started guide |
| [Documents/CLI_GUIDE.md](Documents/CLI_GUIDE.md) | Complete CLI command reference |
| [Documents/GUI_GUIDE.md](Documents/GUI_GUIDE.md) | Desktop GUI user manual |
| [Documents/DEPLOYMENT_GUIDE.md](Documents/DEPLOYMENT_GUIDE.md) | Building portable distributions |

## Project Structure

```
Vantage-Forecaster/
├── src/                    # TypeScript source code
│   ├── index.ts           # CLI entry point
│   ├── models/            # Forecasting models (Hybrid, XGBoost, LSTM)
│   ├── services/          # Weather API, Scheduler, Gateway
│   ├── database/          # SQLite database layer
│   └── data/              # Station and zone configurations
├── gui/                    # Electron + Vue desktop application
├── scripts/               # Build and utility scripts
├── Documents/             # User and developer documentation
├── Data Samples/          # Training data
├── weather_cache/         # Cached weather data
├── data/                  # Database files
└── output/                # Forecast outputs
```

## Key Commands

### Forecasting

```bash
# Regional demand (3 regions: CLUZ, CVIS, CMIN)
node dist/index.js forecast -d "Data Samples/Demand" -s 2026-01-01 -e 2026-01-31 -o output/demand.csv

# Zonal demand (14 sub-regions)
node dist/index.js forecast -d "Data Samples/Demand" -s 2026-01-01 -e 2026-01-31 -o output/demand.csv --zonal

# Capacity factor (Wind + Solar)
node dist/index.js cfac forecast2 -t "Data Samples/Capacity Factor" -s 2026-01-01 -e 2026-01-31 -o output/cfac.csv
```

### Scheduler

```bash
# Run today's forecasts
node dist/index.js scheduler run

# Backfill date range
node dist/index.js scheduler backfill -s 2026-01-01 -e 2026-01-31

# View status
node dist/index.js scheduler status
```

### Deployment

```bash
# Build portable Windows distribution
node scripts/build-portable.cjs --zip --clean

# Create data update pack
node scripts/create-data-pack.cjs --type weather
```

### Database

```bash
# View database status
node dist/index.js db status

# Import data
node dist/index.js db import -t demand -f "Data Samples/Demand"
```

## Requirements

- **Node.js**: 18+ (20 LTS recommended)
- **Windows**: 10/11 for GUI and portable builds
- **Python**: 3.8+ with TensorFlow (optional, for LSTM training)

## Installation

```bash
# Clone repository
git clone https://github.com/your-org/vantage-forecaster
cd vantage-forecaster

# Install dependencies
npm install

# Build CLI
npm run build

# (Optional) Install GUI dependencies
cd gui && npm install
```

## Configuration

### Weather API

Set Visual Crossing API key in `config.json`:
```json
{
  "visualCrossingApiKey": "YOUR_API_KEY"
}
```

Or via environment variable:
```bash
export VISUAL_CROSSING_API_KEY=your_key
```

### Gateway

Configure SFTP gateway in `config.json`:
```json
{
  "gateway": {
    "host": "100.115.9.94",
    "port": 22,
    "username": "vantage-upload",
    "password": "xxx"
  }
}
```

## License

ISC

## Version

- **CLI**: 1.0.0
- **GUI**: 2.0.0
- **Last Updated**: March 2026
