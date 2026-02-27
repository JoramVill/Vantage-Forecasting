# Changelog

All notable changes to the Vantage Forecaster project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased] - 2026-02-27

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
