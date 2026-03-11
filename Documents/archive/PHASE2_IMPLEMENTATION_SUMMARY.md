# Phase 2: Scheduler Service Enhancements - Implementation Summary

## Overview
Phase 2 successfully implements scheduler service enhancements for `forecastSchedulerService.ts`, adding configuration management, archiving, hourly storage, and gateway integration features.

## Files Modified

### `src/services/forecastSchedulerService.ts`
Main implementation file with all Phase 2 enhancements.

## Changes Implemented

### 1. Updated Imports
- Added `statSync` from 'fs' for file size calculation
- Added `createHash` from 'crypto' for checksum generation
- Updated SFTP service imports to use `pushFileToGateway` and `PushResult`
- Added `ForecastCategory` type import

### 2. Extended SchedulerConfig Interface
Added new configuration options:
```typescript
// Configurable run times (PHT)
runTimes?: string[];           // e.g., ['06:00', '18:00']
runDays?: number[];            // 1-7 (1=Monday)

// Weather refresh
weatherMaxAgeHours?: number;   // Default: 6
weatherRefreshMode?: 'auto' | 'always' | 'never';

// Archiving
archiveEnabled?: boolean;
archiveRetentionDays?: number; // Default: 90

// Gateway naming
gatewayNaming?: 'gateway' | 'legacy';  // Use DA_DEM_* or FC_DEM_*
```

### 3. Added SchedulerConfigDB Interface
New interface for database-stored scheduler configuration:
```typescript
interface SchedulerConfigDB {
  id: number;
  enabled: boolean;
  run_time_morning: string;
  run_time_evening: string | null;
  run_days: string;  // Comma-separated
  forecast_types: string;  // Comma-separated
  horizons: string;  // Comma-separated
  weather_max_age_hours: number;
  auto_push_gateway: boolean;
  archive_retention_days: number;
  updated_at: string;
}
```

### 4. Updated Database Schema
Enhanced `ensureTables()` method to create new tables:
- `scheduler_config` - Singleton table for scheduler configuration
- `forecast_archive` - Tracks archived forecast files
- `demand_forecast_hourly` - Stores hourly demand forecast values
- `cfac_forecast_hourly` - Stores hourly CFAC forecast values

Also added new columns to `forecast_runs`:
- `gateway_path` - Remote gateway path after push
- `gateway_category` - Forecast category (day-ahead-demand, etc.)

### 5. Configuration Management Functions

#### loadSchedulerConfig()
Loads scheduler configuration from database singleton row.

#### saveSchedulerConfig(config)
Saves partial or full scheduler configuration updates to database.

### 6. Archive Management Functions

#### getGatewayFilename(config)
Generates gateway-compatible filenames based on horizon, type, and naming convention:
- Gateway naming: `DA_DEM_2026-01-15.csv`, `WA_MHCF_2026-01-15.csv`
- Legacy naming: `FC_DEM_2026-01-15.csv`

#### getForecastCategory(horizon, type)
Maps horizon and type to ForecastCategory enum for gateway push.

#### calculateChecksum(filePath)
Calculates SHA256 checksum for file integrity verification.

#### archiveForecast(outputFile, asOfDate, horizon, type)
Archives forecast files with structure:
```
output/archive/YYYY-MM/YYYY-MM-DD/DA_DEM_YYYY-MM-DD.csv
```

#### cleanupOldArchives()
Removes archived files older than retention policy (default: 90 days).

### 7. Hourly Forecast Storage Functions

#### storeHourlyDemandForecasts(runId, forecastFile)
Parses CSV and stores hourly demand forecasts in `demand_forecast_hourly` table using transactions.

#### storeHourlyCfacForecasts(runId, forecastFile)
Parses CSV and stores hourly CFAC forecasts in `cfac_forecast_hourly` table with station type detection.

#### storeHourlyForecasts(runId, forecastFile, type)
Internal helper that routes to demand or CFAC storage based on type.

### 8. Enhanced Forecast Generation

#### runCfacForecastWithCalibration()
Now includes:
- Hourly forecast storage to database
- Automatic archiving with gateway-compatible naming
- Gateway push with category detection
- Archive tracking in `forecast_archive` table
- Checksum calculation for integrity
- Updated `forecast_runs` with gateway metadata

#### runDemandForecast()
Now includes:
- Hourly forecast storage to database
- Automatic archiving with gateway-compatible naming
- Gateway push with category detection
- Archive tracking in `forecast_archive` table
- Checksum calculation for integrity
- Updated `forecast_runs` with gateway metadata

#### generateCfacForecast()
Added support for:
- `--weather-max-age` parameter from config

#### generateDemandForecast()
Added support for:
- `--weather-max-age` parameter from config

## Database Schema Updates

### New Tables

#### scheduler_config
Singleton table for scheduler settings:
- `id` (1) - Singleton row
- `enabled` - Service enabled flag
- `run_time_morning` / `run_time_evening` - Run times in HH:MM format (PHT)
- `run_days` - Comma-separated day numbers (1=Monday)
- `forecast_types` - Comma-separated: 'demand,cfac'
- `horizons` - Comma-separated: 'daily,weekly'
- `weather_max_age_hours` - Cache expiry for future dates
- `auto_push_gateway` - Auto-push on successful forecast
- `archive_retention_days` - Days to keep local archives

#### forecast_archive
Tracks archived forecast files:
- `run_id` - Foreign key to forecast_runs
- `archive_date` - Date archived (YYYY-MM-DD)
- `forecast_date` - Target date being forecasted
- `horizon` - 'daily' or 'weekly'
- `forecast_type` - 'demand' or 'cfac'
- `local_path` - Local archive path
- `gateway_path` - Remote gateway path (if pushed)
- `file_size_bytes` - File size
- `checksum` - SHA256 checksum

#### demand_forecast_hourly
Hourly demand forecast values:
- `run_id` - Foreign key to forecast_runs
- `datetime` - ISO 8601 timestamp
- `region` - CLUZ, CVIS, CMIN (or 14 zone codes)
- `forecast_mw` - Forecasted demand in MW
- `actual_mw` - Actual value (populated during evaluation)
- `error_mw` / `error_pct` - Error metrics

#### cfac_forecast_hourly
Hourly CFAC forecast values:
- `run_id` - Foreign key to forecast_runs
- `datetime` - ISO 8601 timestamp
- `station_code` - e.g., 01BURGOS, 01SNMANUEL_S
- `station_type` - WIND, SOLAR, HYDRO, etc.
- `forecast_cf` - Capacity factor 0-1
- `actual_cf` - Actual value (populated during evaluation)
- `error_cf` / `error_pct` - Error metrics

### Updated Tables

#### forecast_runs
Added columns:
- `gateway_path` - Remote path after gateway push
- `gateway_category` - Forecast category for gateway routing

## Station Type Detection

Implemented automatic station type detection in `storeHourlyCfacForecasts()`:
- Suffix-based: `_W` (Wind), `_S` (Solar), `_H` (Hydro), `_B` (Battery), `_G/_GP` (Geothermal), `_BI/_BG/_BL` (Biomass)
- Explicit mapping for non-standard wind stations: 01BURGOS, 01LAOAG, 01PAGUDPUD, 02DOLORES, etc.

## Gateway Integration

### Forecast Categories
Maps horizon + type to gateway directory:
- `day-ahead-demand` - Daily demand forecasts
- `day-ahead-mhcf` - Daily CFAC forecasts
- `week-ahead-demand` - Weekly demand forecasts
- `week-ahead-mhcf` - Weekly CFAC forecasts

### File Naming
Gateway naming convention (default):
- Daily demand: `DA_DEM_2026-01-15.csv`
- Weekly demand: `WA_DEM_2026-01-15.csv`
- Daily CFAC: `DA_MHCF_2026-01-15.csv`
- Weekly CFAC: `WA_MHCF_2026-01-15.csv`

Legacy naming (optional):
- `FC_DEM_2026-01-15.csv`
- `FC_MHCF_2026-01-15.csv`

## Usage Examples

### Load/Save Configuration
```typescript
const service = new ForecastSchedulerService(config);

// Load current config
const dbConfig = service.loadSchedulerConfig();

// Update config
service.saveSchedulerConfig({
  enabled: true,
  run_time_morning: '06:00',
  run_time_evening: '18:00',
  weather_max_age_hours: 6,
  archive_retention_days: 90,
  auto_push_gateway: true
});
```

### Archive Management
```typescript
// Archive a forecast
const archivePath = service.archiveForecast(
  'output/daily/Demand/demand_2026-01-15_2026-01-15.csv',
  '2026-01-14',
  'daily',
  'demand'
);
// Result: output/archive/2026-01/2026-01-14/DA_DEM_2026-01-15.csv

// Cleanup old archives
const { deleted, errors } = service.cleanupOldArchives();
console.log(`Deleted ${deleted} old archive files`);
```

### Hourly Storage
Automatically called during forecast runs:
```typescript
// Stored in demand_forecast_hourly table
service.storeHourlyDemandForecasts(runId, forecastFile);

// Stored in cfac_forecast_hourly table
service.storeHourlyCfacForecasts(runId, forecastFile);
```

## Backward Compatibility

All existing methods maintain backward compatibility:
- `runCalibratedForecasts()` - Enhanced with archiving and hourly storage
- `runDailyForecast()` - Legacy wrapper still works
- `runWeeklyForecast()` - Legacy wrapper still works
- `runAsService()` - Background service mode unchanged

New features are opt-in:
- Archiving enabled by default (disable with `archiveEnabled: false`)
- Gateway push respects existing `pushToGateway` config
- Weather max age defaults to 6 hours if not specified

## Testing

Build verification:
```bash
npm run build
```

Status: ✅ Compilation successful with no TypeScript errors

## Next Steps

Phase 2 is complete. The scheduler service now has:
1. ✅ Database-backed configuration management
2. ✅ Automatic archiving with gateway-compatible naming
3. ✅ Hourly forecast value storage for detailed analysis
4. ✅ Enhanced gateway integration with proper categorization
5. ✅ Weather cache age management
6. ✅ Archive retention policies

The service is ready for integration with Phase 3 (GUI enhancements) if needed.
