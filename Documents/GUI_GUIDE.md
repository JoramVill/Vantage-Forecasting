# Vantage Forecaster - GUI User Guide

Vantage Forecaster includes an Electron-based desktop GUI that provides a streamlined interface for running demand and capacity factor forecasts.

## Quick Start

```bash
# Navigate to GUI directory
cd gui

# Install dependencies (first time only)
npm install

# Start in development mode
npm run dev

# Or start production build
npm run start
```

## Overview

The GUI is a single-page application built with:
- **Electron** - Desktop application framework
- **Vue 3** - Reactive UI framework
- **TypeScript** - Type-safe JavaScript
- **electron-store** - Encrypted settings persistence

The GUI serves as a visual wrapper around the CLI commands, providing:
- Point-and-click data source configuration
- Visual progress tracking
- Real-time CLI output display
- Persistent settings between sessions

---

## Interface Layout

### Main Sections

1. **Data Source Selection** - Toggle between CSV directories and SQLite database
2. **Configuration Panel** - Set paths, dates, and forecast options
3. **Output Naming** - Customize output file names
4. **Forecast Execution** - Run button with progress display
5. **Status Panel** - Real-time output and history

---

## Data Source Configuration

### CSV Directory Mode

When using CSV files as the data source:

| Field | Description | Example |
|-------|-------------|---------|
| **Demand Data Directory** | Folder containing demand CSV files | `Data Samples/Demand` |
| **CFAC Data Directory** | Folder containing capacity factor CSVs | `Data Samples/Capacity Factor` |
| **Weather Cache Directory** | Cached weather data from Visual Crossing | `./weather_cache` |
| **Training Start Date** | Start of historical data for training | `2025-01-01` |
| **Training End Date** | End of historical data for training | `2025-11-30` |

### Database Mode

When using a SQLite database:

| Field | Description | Example |
|-------|-------------|---------|
| **Database Path** | Path to `.db` file | `data/iload.db` or `data/iload_zonal.db` |
| **Weather Cache Directory** | Cached weather data | `./weather_cache` |

#### Database Info Panel

When a database is loaded, the GUI displays:
- **Demand Records**: Total count, date range, and detected regions/zones
- **Weather Records**: Count and date range
- **CFAC Records**: Cluster weather historical + forecast counts

#### Auto-Detection of Zonal Mode

The GUI automatically detects the data format:
- **3 regions** (CLUZ, CVIS, CMIN) → Regional mode
- **14 zones** (01NLUZ, 02METRO, etc.) → Zonal mode enabled automatically

A notification appears when the mode is auto-switched.

#### Database Update Panel

Click "Update Database" to import new data:
- **Demand**: Import demand CSV files
- **Weather**: Import weather data
- **CFAC**: Import capacity factor training data

---

## Forecast Options

| Option | Description | Default |
|--------|-------------|---------|
| **Enable Demand Forecast** | Generate demand predictions | Enabled |
| **Enable CFAC Forecast** | Generate capacity factor predictions | Enabled |
| **CFAC Model** | Select forecasting model (Hybrid or Legacy XGBoost) | Hybrid |
| **Demand Mode** | Select geography mode (Regional, Zonal, or Both) | Regional |
| **Scaling Percentage** | Scale output values (for growth scenarios) | 100% |

### Demand Mode Selection

When Demand forecast is enabled, you can choose between three modes:

| Mode | Description | Output Files |
|------|-------------|--------------|
| **Regional (3)** | 3-region format (CLUZ, CVIS, CMIN) | `FC_DEM_*.csv` |
| **Zonal (14)** | 14-zone format (01NLUZ through 14SWMIN) | `FC_ZDEM_*.csv` |
| **Both** | Generate both regional and zonal forecasts | Both file types |

**Note:** When "Both" is selected, the scheduler generates two forecast files per run - one regional and one zonal. This is useful when different downstream systems require different granularities.

### CFAC Model Selection

When CFAC forecast is enabled, you can choose between three models:

| Model | Description | Performance |
|-------|-------------|-------------|
| **Hybrid (Default)** | Physics-based models + ML correction with auto-calibration | Wind: ~73% MAPE, Solar: ~16% MAPE |
| **Hybrid + LSTM Correction** | Hybrid model with additional LSTM layer for temporal dynamics | Experimental - improves temporal patterns |
| **Legacy XGBoost** | XGBoost with physics features, asymmetric loss, bias correction | Wind: ~78% MAPE, Solar: ~55% MAPE |

**Hybrid is recommended** for most use cases as it combines physics-based predictions with machine learning correction for best accuracy.

**Hybrid + LSTM Correction** adds an optional LSTM neural network layer that learns to correct hybrid predictions based on weather sequences. This can improve temporal dynamics like morning ramp patterns, though it increases training time.

### SFTP Gateway Routing

Demand files are automatically routed to geography-specific directories when pushed to the gateway:

| File Pattern | Gateway Path |
|--------------|--------------|
| `FC_DEM_*`, `DA_DEM_*` | `/day-ahead/demand/regional/` |
| `FC_ZDEM_*`, `DA_ZDEM_*` | `/day-ahead/demand/zonal/` |
| `WA_DEM_*` | `/week-ahead/demand/regional/` |
| `WA_ZDEM_*` | `/week-ahead/demand/zonal/` |

MHCF (capacity factor) files are not split by geography and go directly to `/day-ahead/mhcf/` or `/week-ahead/mhcf/`.

### Date Range

| Field | Description |
|-------|-------------|
| **Forecast Start Date** | First day to generate predictions |
| **Forecast End Date** | Last day to generate predictions |

---

## Output Naming

Click "Naming Options" to customize output file names.

### Default Naming Convention

| Forecast Type | Default Prefix | Example Output |
|---------------|----------------|----------------|
| Demand (Regional) | `FC_DEM_` | `FC_DEM_2025-12-01_2025-12-31.csv` |
| Demand (Zonal) | `FC_ZDEM_` | `FC_ZDEM_2025-12-01_2025-12-31.csv` |
| Capacity Factor | `FC_CF_` | `FC_CF_2025-12-01_2025-12-31.csv` |

### Customization Options

| Option | Description |
|--------|-------------|
| **Demand Prefix** | Prefix for regional demand output |
| **Zonal Demand Prefix** | Prefix for zonal demand output |
| **CFAC Prefix** | Prefix for capacity factor output |
| **Suffix** | Text appended before `.csv` extension |
| **Use Custom Names** | Override with completely custom filenames |

### Example

With settings:
- Prefix: `FORECAST_`
- Suffix: `_v2`
- Dates: 2025-12-01 to 2025-12-31

Output: `FORECAST_2025-12-01_2025-12-31_v2.csv`

---

## CLI Command Mapping

The GUI translates user inputs into CLI commands. Understanding this mapping helps with troubleshooting.

### Demand Forecast

**GUI Settings:**
- Data Source: Database (`data/iload.db`)
- Forecast Start: `2025-12-01`
- Forecast End: `2025-12-31`
- Output Directory: `output/Demand`
- Zonal Mode: Disabled

**Generated CLI Command:**
```bash
node dist/index.js forecast \
  -d data/iload.db \
  -s 2025-12-01 \
  -e 2025-12-31 \
  -o output/Demand/FC_DEM_2025-12-01_2025-12-31.csv \
  --model hybrid
```

**With Zonal Mode Enabled:**
```bash
node dist/index.js forecast \
  -d data/iload_zonal.db \
  -s 2025-12-01 \
  -e 2025-12-31 \
  -o output/Demand/FC_ZDEM_2025-12-01_2025-12-31.csv \
  --model hybrid \
  --zonal
```

### Capacity Factor Forecast

**GUI Settings:**
- Data Source: CSV (`Data Samples/Capacity Factor`)
- Forecast Start: `2025-12-01`
- Forecast End: `2025-12-31`
- Model: Hybrid (default)
- Output Directory: `output/CFAC`

**Generated CLI Command (Hybrid - Default):**
```bash
node dist/index.js cfac forecast2 \
  -t "Data Samples/Capacity Factor" \
  -s 2025-12-01 \
  -e 2025-12-31 \
  -o output/CFAC/FC_CF_2025-12-01_2025-12-31.csv
```

**Generated CLI Command (Legacy XGBoost):**
```bash
node dist/index.js cfac forecast2 \
  -t "Data Samples/Capacity Factor" \
  -s 2025-12-01 \
  -e 2025-12-31 \
  -o output/CFAC/FC_CF_2025-12-01_2025-12-31.csv \
  --use-xgboost \
  --asymmetric-loss \
  --bias-correction \
  --training-end 2025-11-30
```

### Database Import

**GUI Action:** Update Database → Import Demand

**Generated CLI Command:**
```bash
node dist/index.js db import \
  -t demand \
  -f "path/to/demand/files" \
  --db data/iload.db
```

---

## Settings Persistence

All settings are automatically saved to disk using `electron-store` with encryption:

**Persisted Settings:**
- Data source type (CSV/database)
- All directory/file paths
- Forecast options (demand, CFAC, zonal mode)
- Output naming preferences
- Scaling percentage

**Storage Location:**
- Windows: `%APPDATA%/vantage-forecaster/vantage-forecaster-settings.json`
- macOS: `~/Library/Application Support/vantage-forecaster/vantage-forecaster-settings.json`
- Linux: `~/.config/vantage-forecaster/vantage-forecaster-settings.json`

---

## Progress and Status

### Progress Bar

Shows completion percentage based on enabled forecasts:
- 0-45%: First forecast (Demand if enabled)
- 45-90%: Second forecast (CFAC if enabled)
- 90-100%: Completion

### Status Messages

| Icon | Meaning |
|------|---------|
| Blue info | Operation starting |
| Green checkmark | Operation succeeded |
| Red X | Operation failed |

### Real-Time Output

The GUI streams CLI output in real-time:
- **stdout**: Normal output (model training progress, results)
- **stderr**: Warnings and errors

Click "Show Full Output" to see the complete CLI output history.

---

## Weather Cache Validation

The GUI validates weather directory structure when you select a path:

**Expected Structure:**
```
weather_cache/
├── combined/           # Combined regional weather
│   ├── 2025-01/
│   ├── 2025-02/
│   └── ...
├── zonal/              # Per-zone weather (if using zonal mode)
├── WIND_01BURGOS/      # Per-station wind data
├── WIND_01LAOAG/
├── SOLAR_01CURIMAO/    # Per-station solar data
└── ...
```

**Validation Messages:**
- "Weather cache: combined, 12 wind, 8 solar (2025-01 to 2025-12)" → Valid
- "Directory does not appear to contain weather data" → Invalid path

---

## Building for Distribution

### Development Build
```bash
cd gui
npm run dev          # Start Vite dev server + Electron
```

### Production Build
```bash
cd gui
npm run build        # Build Vue app
npm run electron:build  # Package Electron app
```

**Output:**
- Windows: `gui/release/*.exe` installer
- macOS: `gui/release/*.dmg`
- Linux: `gui/release/*.AppImage`

---

## Troubleshooting

### "No database path configured"

**Cause:** Database mode selected but no `.db` file chosen.
**Solution:** Click "Select Database" and choose a valid SQLite database file.

### "Database file not found"

**Cause:** The configured database path no longer exists.
**Solution:** Select a valid database file or switch to CSV mode.

### Weather cache shows "Directory does not exist"

**Cause:** Relative path `./weather_cache` resolves to wrong location.
**Solution:** Use absolute path or ensure GUI is run from project root.

### "Forecast completed with errors"

**Cause:** CLI returned non-zero exit code.
**Solution:** Check the status history for specific error messages. Common issues:
- Missing training data
- Invalid date ranges
- Weather data not available for forecast dates

### Auto-detection shows wrong mode

**Cause:** Database has unexpected region format.
**Solution:** Manually toggle Zonal Mode checkbox to override auto-detection.

---

## Architecture

### Process Communication

```
┌─────────────────┐         IPC          ┌─────────────────┐
│   Renderer      │◄─────────────────────►│     Main        │
│   (Vue App)     │   invoke/handle       │   (Electron)    │
│   App.vue       │                       │   main.ts       │
└─────────────────┘                       └────────┬────────┘
                                                   │
                                                   │ spawn
                                                   ▼
                                          ┌─────────────────┐
                                          │   CLI Process   │
                                          │ dist/index.js   │
                                          └─────────────────┘
```

### IPC Handlers (main.ts)

| Handler | Purpose |
|---------|---------|
| `run-command` | Execute CLI with args, stream output |
| `run-script` | Execute node script directly (deprecated - use run-command with --model flag) |
| `select-directory` | Open folder picker dialog |
| `select-file` | Open file picker dialog |
| `save-file` | Open save dialog |
| `load-settings` | Read from electron-store |
| `save-settings` | Write to electron-store |
| `check-data-format` | Detect zonal vs regional CSV |
| `check-weather-directory` | Validate weather cache structure |
| `get-database-info` | Query database for stats |
| `import-to-database` | Run CLI db import command |

### Key Files

| File | Purpose |
|------|---------|
| `gui/electron/main.ts` | Electron main process, IPC handlers |
| `gui/electron/preload.ts` | Secure bridge between main/renderer |
| `gui/src/App.vue` | Single-page Vue application |
| `gui/src/vite-env.d.ts` | TypeScript declarations for window.electronAPI |
| `scripts/db-info.cjs` | Helper script for database queries |

---

## Version History

**v2.0.0** - GUI Overhaul
- Single-page interface replacing multi-view router
- Database mode with info panel and import
- Customizable output naming
- Auto-detection of zonal mode
- Real-time CLI output streaming
- Weather directory validation
- Persistent settings with encryption
