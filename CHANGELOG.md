# Changelog

All notable changes to the Vantage Forecaster project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased] - 2026-03-11

### Added
- **Global Configuration System (Phases 1-5)**
  - `forecast_config.json` at project root - single source of truth for all settings
  - `config` CLI command group: `config get/set/reset/validate`
  - ConfigService for loading/saving/validating configuration
  - GUI Settings tab loads/saves global config via IPC
  - Type-safe configuration with validation and defaults
  - Settings categories: training paths, weather, output, gateway, models

- **Unified Forecast Service**
  - Single entry point for all forecast operations
  - Reads settings from global config (forecast_config.json)
  - Simplified CLI commands - paths/options now use config defaults
  - Consistent configuration across CLI and GUI

### Removed
- **Legacy LSTM Components**
  - Deleted `src/models/capacityFactor/WindLSTMModel.ts`
  - Deleted `src/models/capacityFactor/SolarLSTMModel.ts`
  - Deleted `src/models/capacityFactor/LSTMForecaster.ts`
  - Deleted `src/models/capacityFactor/WeatherCorrectionLSTM.ts`
  - Deleted `src/models/DemandCorrectionLSTM.ts`
  - Deleted several LSTM training scripts
  - Removed `--lstm-correction` option from demand forecast CLI
  - Removed LSTM documentation sections from CLAUDE.md and CLI_GUIDE.md

- **Deprecated CLI Commands**
  - Removed `cfac forecast` (superseded by `cfac forecast2`)
  - Removed `cfac forecast3` (EMA smoothing didn't provide improvement)
  - Removed `scheduler config` (replaced by global `config` command)

### Changed
- **Documentation Updates**
  - CLAUDE.md: Removed references to deleted commands and LSTM models
  - CLI_GUIDE.md: Added config command section, removed LSTM training documentation
  - QUICK_START.md: Simplified examples to use global config
  - All guides now reference `forecast_config.json` for settings

- **Model Files**
  - Hybrid demand model is now the only production model (no LSTM correction layer)
  - Capacity factor models unchanged (Wind 4-Tier Hybrid, Solar Physics+ML)

### Technical
- Configuration stored in `forecast_config.json` (root directory)
- ConfigService provides type-safe access to all settings
- GUI integrates with config via Electron IPC handlers
- Backward-compatible: old CLI flags still work, override config values

---

## [Previous] - 2026-03-05

### Added
- **Geography-Based SFTP Routing for Demand Forecasts**
  - Demand files now route to geography subdirectories based on filename detection
  - Regional demand files (`FC_DEM_*`, `DA_DEM_*`, `WA_DEM_*`) → `/demand/regional/`
  - Zonal demand files (`FC_ZDEM_*`, `DA_ZDEM_*`, `WA_ZDEM_*`) → `/demand/zonal/`
  - MHCF paths unchanged (no geography split needed)
  - New `isZonalDemandFile()` helper function for pattern detection

- **Demand Mode Configuration (Scheduler)**
  - Added `demandGeography` configuration option: `'regional'` | `'zonal'` | `'both'`
  - Database migration adds `demand_geography` column to `scheduler_config` table
  - Backward compatible with legacy `schedulerZonalEnabled` boolean settings

- **GUI Demand Mode Dropdown**
  - Converted boolean zonal toggle to dropdown in Automation Settings
  - Options: "Regional (3)", "Zonal (14)", "Both"
  - Only visible when Demand forecasting is enabled

### Changed
- **SFTP Push Service**
  - `getRemoteDirectory()` now routes demand files to geography subdirectories
  - Updated `testGatewayConnection()` to verify new directory structure

- **Scheduler Service**
  - Added `demand_geography` field to `SchedulerConfigDB` interface
  - Config methods handle new geography setting with `'regional'` default

### Added
- **Scheduler Configuration Management**
  - `scheduler config` CLI command with get/set/reset operations
  - GUI Scheduler tab with editable configuration form
  - Database persistence for scheduler settings (scheduler_config table)
  - Configurable settings: training data paths, weather cache, auto-push, archive settings

- **Forecast Archiving**
  - Day-ahead and week-ahead forecast archiving with gateway-compatible naming
  - Archive naming: `{horizon}_{category}_{issuance}_{start}_{end}.csv`
  - Examples: `D+1_demand_2025-10-15_2025-10-16_2025-10-16.csv`, `D+7_demand_2025-10-15_2025-10-16_2025-10-22.csv`
  - Forecast archive tracking in database (forecast_archive table)
  - Archive cleanup and management via CLI

- **Weather Cache Management**
  - Weather cache age checking with 6-hour expiry for future dates
  - Historical weather cache never expires
  - PHT timezone handling for midnight edge cases
  - `--refresh-weather` flag to force weather re-fetch

- **Gateway Integration Enhancements**
  - Gateway push categories: `day-ahead-demand`, `day-ahead-mhcf`, `week-ahead-demand`, `week-ahead-mhcf`
  - Category-specific directory structure in Vantage Gateway
  - Improved `--all` support to push all archived forecasts
  - `--category` filter for selective pushing

- **GUI Scheduler Tab**
  - Configuration editor with real-time validation
  - Recent runs display with status, timestamps, and error messages
  - Manual run controls for day-ahead and week-ahead forecasts
  - Auto-refresh with configurable interval
  - Save/reset configuration buttons

- **GUI Layout Improvements**
  - Uniform card sizing for Output Naming, Model Training, and Forecast Options
  - Equal-height cards using CSS Grid with flexbox stretch alignment
  - Responsive single-column layout with scrollable container on narrow screens (<800px)
  - Dark blue Electron window background (#0f172a) matching app theme
  - Styled titlebar overlay with matching colors and contrast symbols

- **Electron IPC Integration**
  - `load-scheduler-config` handler for retrieving scheduler settings
  - `save-scheduler-config` handler for persisting configuration changes
  - `get-recent-runs` handler for fetching forecast run history
  - `run-scheduler-manual` handler for triggering manual forecast runs
  - TypeScript declarations for type-safe API access

- **Database Enhancements**
  - `scheduler_config` table for persistent settings
  - `forecast_archive` table for tracking generated forecasts
  - `demand_forecast_hourly` table for hourly demand storage
  - `cfac_forecast_hourly` table for hourly capacity factor storage
  - Database schema version 8
  - Transaction support for bulk hourly inserts

### Changed
- **Enhanced `scheduler run` command**
  - Added `--refresh-weather` to force weather cache refresh
  - Added `--no-push` to skip gateway push
  - Added `--no-archive` to skip forecast archiving
  - Improved logging with detailed progress messages

- **Enhanced `scheduler backfill` command**
  - Added `--overwrite` to regenerate existing forecasts
  - Added `--suffix` to append custom suffix to archived filenames
  - Better date range validation and error handling

- **Enhanced `gateway push` command**
  - Added `--category` option to filter by forecast category
  - Improved `--all` to push all archived forecasts with category grouping
  - Better error handling and progress reporting

- **SFTP Push Service**
  - Updated to support new gateway directory structure
  - Category-based subdirectories: `day-ahead/demand/`, `week-ahead/demand/`, etc.
  - Improved connection handling and error reporting

### Technical
- Database schema version upgraded from 7 to 8
- PHT (UTC+8) timezone handling for weather cache expiry
- Atomic database transactions for forecast storage
- Type-safe configuration with validation
- Improved error handling across scheduler operations
- Weather cache age calculation with timezone awareness

### Fixed
- Weather cache stale data issue for future forecast dates
- Midnight edge cases in PHT timezone conversion
- Database transaction rollback on forecast insert failures
- Archive filename consistency with gateway expectations
