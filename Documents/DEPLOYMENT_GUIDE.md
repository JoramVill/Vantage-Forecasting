---
Status: Active
Last-Verified: 2026-03-22
Verified-Against: current
Updated-By: codebase-documenter
---

# Vantage Forecaster - Deployment Guide

This guide covers creating and distributing portable Windows builds of Vantage Forecaster.

## Quick Start

```bash
# Build portable distribution with all data
node scripts/build-portable.cjs --zip

# Output: portable-build/VantageForecaster-portable.zip
```

## Build Options

### Full Portable Build (Recommended)

Creates a complete self-contained folder with app, data, and bundled Node.js:

```bash
node scripts/build-portable.cjs --zip --clean
```

**Output:** `portable-build/VantageForecaster-portable.zip` (~600MB compressed)

### App-Only Build (No Data)

For updates where users keep their existing data:

```bash
node scripts/build-portable.cjs --no-data --zip
```

**Output:** Smaller package (~150MB) without databases or weather cache.

### Build Flags

| Flag | Description |
|------|-------------|
| `--zip` | Create ZIP archive after building |
| `--no-data` | Skip data files (app update only) |
| `--clean` | Clean output directory first |

## Data Packs

For updating data separately from the application:

```bash
# Full data pack (all data files)
node scripts/create-data-pack.cjs --type all

# Weather cache only
node scripts/create-data-pack.cjs --type weather

# Training data only
node scripts/create-data-pack.cjs --type training

# Databases only
node scripts/create-data-pack.cjs --type databases
```

**Output:** `data-packs/<type>-<date>.zip`

## Distribution Structure

```
VantageForecaster/
├── Vantage Forecaster.exe    # Main application
├── Start Vantage Forecaster.bat  # Optional launcher
├── README.txt                # User instructions
├── .portable                 # Portable mode marker
├── config.json              # API keys & settings
├── forecast.db              # Scheduler database
│
├── cli/                     # CLI Backend
│   ├── node/
│   │   └── node.exe        # Bundled Node.js (v20 LTS)
│   ├── dist/               # Compiled TypeScript
│   ├── node_modules/       # Dependencies
│   ├── data/
│   │   ├── stations.json   # Station metadata
│   │   └── zones.json      # Zone configuration
│   └── config/
│
├── data/                    # Databases (updateable)
│   ├── iload.db            # Regional demand data
│   └── iload_zonal.db      # Zonal demand data
│
├── weather_cache/           # Cached weather (updateable)
│   ├── manila/
│   ├── cebu/
│   ├── davao/
│   ├── WIND_*/             # Per-station wind data
│   └── SOLAR_*/            # Per-station solar data
│
├── Data Samples/            # Training data (updateable)
│   ├── Demand/
│   └── Capacity Factor/
│
└── models/                  # Trained models (updateable)
    └── calibrator/
```

## User Installation

1. Download `VantageForecaster-portable.zip`
2. Extract to desired location (e.g., `C:\Tools\VantageForecaster\`)
3. Double-click `Vantage Forecaster.exe`

**No admin rights required. No installation needed.**

## Updating

### Application Update

1. Download new app-only package
2. Extract over existing installation (keep data folders)
3. Restart application

### Data Update

1. Download relevant data pack
2. Close Vantage Forecaster
3. Extract data pack over existing installation
4. Restart application

### Preserving User Data

When updating, these user files should be preserved:
- `config.json` - API keys, gateway settings
- `forecast.db` - Scheduler history (can be regenerated)

## Configuration

### First Run Setup

1. Set data paths in Settings tab:
   - Demand Data: `Data Samples\Demand` (relative to app)
   - CFAC Data: `Data Samples\Capacity Factor`
   - Weather Cache: `weather_cache`

2. Configure Gateway (if using):
   - Host: `100.115.9.94`
   - Username: `vantage-upload`
   - Password: (provided separately)

### API Keys

Edit `config.json` to add:
```json
{
  "visualCrossingApiKey": "YOUR_API_KEY",
  "gateway": {
    "host": "100.115.9.94",
    "port": 22,
    "username": "vantage-upload",
    "password": "xxx"
  }
}
```

## Network Requirements

| Feature | Requirement |
|---------|-------------|
| Weather Fetching | Internet access to Visual Crossing API |
| Gateway Push | Tailscale VPN connection |
| Offline Operation | Works with cached weather data |

## Troubleshooting

### App Won't Start

1. Check Windows Defender isn't blocking the app
2. Ensure you extracted the full ZIP (not running from within)
3. Check for missing `cli/node/node.exe`

### CLI Commands Fail

1. Check `cli/dist/index.js` exists
2. Verify `cli/node_modules/better-sqlite3` is present
3. Run from Command Prompt to see detailed errors:
   ```cmd
   cd C:\path\to\VantageForecaster
   cli\node\node.exe cli\dist\index.js db status
   ```

### Weather Fetch Fails

1. Check internet connection
2. Verify API key in `config.json`
3. Check `weather_cache` folder is writable

### Database Errors

1. Ensure `data/iload.db` exists
2. Check file isn't locked by another process
3. Verify `forecast.db` isn't corrupted (delete to regenerate)

## Building from Source

### Prerequisites

- Node.js 20+ (LTS)
- npm
- Windows 10/11

### Build Steps

```bash
# Clone repository
git clone https://github.com/your-org/vantage-forecaster
cd vantage-forecaster

# Install dependencies
npm install
cd gui && npm install && cd ..

# Build CLI
npm run build

# Build portable distribution
node scripts/build-portable.cjs --zip --clean
```

### Development Mode

```bash
# Terminal 1: CLI development
npm run build -- --watch

# Terminal 2: GUI development
cd gui && npm run dev
```

## Size Reference

| Component | Size |
|-----------|------|
| Electron app | ~150 MB |
| Bundled Node.js | ~50 MB |
| node_modules | ~100 MB |
| Databases | ~950 MB |
| Weather cache | ~300 MB |
| Training data | ~36 MB |
| **Total (uncompressed)** | **~1.5 GB** |
| **ZIP (compressed)** | **~600 MB** |

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 2.0.0 | 2026-03 | Initial portable deployment system |
