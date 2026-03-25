# Changelog

All notable changes to the Vantage Forecaster project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased] - 2026-03-25

### Changed
- **V2 Architecture Now Default for Demand Forecasting**
  - The `forecast` command now uses V2 Level × Shape architecture by default
  - V1 HybridModel moved to `v1:forecast` command (deprecated)
  - V2 ForecastPipeline fully implemented with weather fetching, level prediction, shape prediction, and calibration
  - Auto-detection of model (.vfm) and calibration (.json) files from `models/demand/`
  - V1 HybridModel code archived to `archive/v1_models/` for reference

### Added
- **Phase C Polish - Verbose Logging for V2 Pipelines**
  - Added comprehensive verbose logging to all V2 pipeline commands
  - TrainPipeline: Logs per-area metrics, record counts, date ranges, feature importance details
  - CalibratePipeline: Logs calibration factors, per-area scale factors, shape corrections
  - ForecastPipeline: Logs weather data quality, amplitude checks, forecast statistics
  - CfacTrainPipeline: Logs station type breakdown, training metrics per station, model configurations
  - CfacCalibratePipeline: Logs global bias, hourly scale factors, per-station MAPE metrics
  - CfacForecastPipeline: Logs forecast statistics (avg/min/max CF), weather data quality
  - All pipelines include timestamps in verbose mode for step tracking
  - Verbose flag already existed in pipeline configs, now properly utilized

### Fixed
- **Phase C Polish - Minor Architecture Fixes**
  - Added type alias `ProfileModel` to `ProfileBasedModel.ts` for consistency with other capacity factor models
  - Added default export to `ProfileBasedModel.ts`
  - Created `src/pipeline/index.ts` to centralize all V2 pipeline exports (TrainPipeline, CalibratePipeline, ForecastPipeline, ModelSerializer, CfacTrainPipeline, CfacCalibratePipeline, CfacForecastPipeline, CfacModelSerializer)
  - Added V2 service exports to `src/services/index.ts` (forecastGenerator, overrideService, intradayRefresh, trainingPlanService)
  - Added `--growth <rate>` flag to `v2:train` command for daily growth rate adjustment
  - Added `--growth <rate>` flag to `v2:forecast` command for daily growth rate adjustment
  - Ensured all V2 types (CfacV2ModelData, CfacV2Calibration, DemandV2ModelArtifact, CalibrationSnapshot) are properly exported from their respective serializer files

### Added
- **Models Tab - Per-Area MAPE Display in Files View (Phase B Fix)**
  - Added `readVfmFile` IPC handler to read and deserialize .vfm model files
  - Exposes model metrics (overallMape, perZoneMape, perRegionMape, perStationMape) to GUI
  - Files View now displays per-area MAPE breakdown when viewing .vfm files
  - Overall MAPE shown in large gradient card with color-coded severity (green <3%, yellow <5%, red >=5%)
  - Per-zone MAPE for zonal demand models (14 zones: 01NLUZ, 02METRO, etc.)
  - Per-region MAPE for regional demand models (3 regions: CLUZ, CVIS, CMIN)
  - Per-station MAPE for CFAC models (all wind/solar stations with station codes)
  - Color-coded borders: Green <5%/<20%, Yellow <10%/<40%, Red >=10%/>=40% (demand/CFAC respectively)
  - Automatic loading via watcher when .vfm file is selected
  - Loading state indicator while model file is being read
  - "Calibrate Now" button already existed (no changes needed)

### Fixed
- **Scheduler CLI Geography Flag (Phase B Fix)**
  - Added missing `--geography <type>` flag to `scheduler run` command (was only in `backfill`)
  - GUI now passes `geography` parameter from `schedulerConfig.demandGeography` to IPC handler
  - IPC handler in `main.ts` accepts `geography` parameter and passes to CLI via `--geography` flag
  - CLI reads geography from: CLI flag > config file (`forecast_config.json`) > default 'both'
  - Updated TypeScript type definitions in `vite-env.d.ts` to include `geography` field
  - Scheduler now correctly respects demand geography setting from Settings tab (regional/zonal/both)

### Added
- **V2 Config Schema Integration**
  - Added `V2Config` interface to `src/types/config.ts` with two sections:
    - `v2.demand`: Training days (90), lag warmup (7), calibration days (7), shape clusters (4), level features list, smoothing threshold (50), default model/calibration paths
    - `v2.cfac`: Training days (120), calibration days (14), solar alpha (0.65), wind/solar scale clamps, temperature coefficient (0.004), confidence threshold (50), default model/calibration paths, retrain monitor settings
  - Added `v2?: V2Config` field to `GlobalForecastConfig` interface
  - ConfigService updated with V2 defaults and deep merge support
  - Added getter methods: `getV2DemandConfig()`, `getV2CfacConfig()`, `getV2RetrainMonitorConfig()`
  - Updated `forecast_config.json` with V2 section showing default values

- **CFAC V2 Architecture - Phase B Implementation**
  - Implemented `CfacRetrainMonitor` service for detecting when CFAC models need retraining
  - Tracks post-calibration MAPE per station type (wind, solar, profile)
  - Alerts when MAPE exceeds configurable thresholds (Wind: 80%, Solar: 25%)
  - Detects stale weather cache files (default: 24-hour staleness threshold)
  - Provides severity levels (warning, critical) for prioritizing retraining
  - Factory function `createCfacRetrainMonitor()` for easy instantiation
  - Exported types: `RetrainAlert`, `CacheStatus`
  - Configuration loaded from `forecast_config.json` via `v2.cfac.retrainMonitor` section

- **CFAC Train/Calibrate Pipeline - Data Loading Implementation**
  - Implemented `loadTrainingSamples()` in `CfacTrainPipeline.ts` (Phase A fix)
  - Implemented `loadCalibrationSamples()` in `CfacCalibratePipeline.ts` (Phase A fix)
  - Both functions parse CFac CSV files using `CapacityFactorService.parseCapacityFactorDirectory()`
  - Filter data to specified training/calibration window (default 120 days / 14 days)
  - Load station metadata from `src/data/stations.json`
  - Fetch weather data for all stations using `weatherService.fetchAllClusters()`
    - Wind stations: 100m hub-height data with station-specific coordinates
    - Solar stations: UV index and premium features with station-specific coordinates
    - Other stations: Standard weather using cluster-based coordinates
  - Merge CFac + weather into `CFacTrainingSample[]` with temporal features (hour, day of week, month, weekend)
  - All stub data loading functions now fully functional

- **CFAC Forecast Pipeline - Weather Fetching Implementation**
  - Implemented `fetchWeatherForecast()` in `CfacForecastPipeline.ts` (Phase A fix)
  - Fetches weather data for all station types (wind, solar, hydro, geothermal, biomass, battery)
  - Wind stations: Fetches 100m hub-height data using station-specific coordinates
  - Solar stations: Fetches UV index and premium weather features using station-specific coordinates
  - Other stations: Fetches standard weather using station coordinates
  - Uses `weatherService.fetchAllClusters()` with automatic caching
  - Parses CSV weather data into `CFacWeatherFeatures[]` arrays
  - Added `getApiKey()` helper function for Visual Crossing API key resolution
  - Added `parseWeatherCsv()` helper for CSV parsing with proper type handling

- **V2 CLI Commands - Phase A Fixes**
  - Added `--zonal` flag to `v2:train` for 14-zone sub-region mode
  - Added `--regional` flag to `v2:train` for 3-region mode (default)
  - Added `-c, --config <file>` flag to all V2 commands for custom config file path
  - Added `--verbose` flag to all V2 commands for detailed logging
  - Updated `TrainPipelineConfig` interface to accept `isZonal`, `configPath`, `verbose` options
  - Updated `CalibratePipelineConfig` interface to accept `configPath`, `verbose` options
  - Updated `ForecastPipelineConfig` interface to accept `configPath`, `verbose` options
  - Changed `v2:forecast -c` flag to `-cal, --calibration` to avoid conflict with `--config`

- **GUI V2 Settings Tab - V2 Configuration Fields**
  - Added V2 nested configuration structure support in Settings tab
  - Demand V2 settings: Level model (XGBoost/Linear, max depth, n estimators)
  - Demand V2 settings: Shape model (archetype count, blending, weather influence, peak bias, confidence threshold, adjustment model)
  - Demand V2 settings: Calibration (days, level/shape clamps, peak bias)
  - Demand V2 settings: Training (days, lag warmup days)
  - CFAC V2 settings: Solar (alpha, temperature coefficient, scale clamps)
  - CFAC V2 settings: Wind (per-station calibration, scale clamps)
  - CFAC V2 settings: Training and calibration days
  - Lifecycle settings: Retrain schedules for demand and CFAC (7d/14d/30d/60d options)
  - Lifecycle settings: Auto-retrain toggle
  - Drift thresholds: Level, shape, solar scale, wind bias drift with consecutive cycles threshold
  - Defensive initialization: V2 config fields default to spec values if missing in forecast_config.json
  - All V2 settings saved to forecast_config.json with nested structure per `Documents/planning/GUI_V2_ARCHITECTURE.md` Section 6

- **GUI V2 Operations Tab**
  - New "Operations" tab replacing "Manual" tab for V2 workflow
  - Three-panel layout: TRAIN, CALIBRATE, FORECAST (per architecture spec)
  - Forecast type selector: Demand (Regional), Demand (Zonal), CFAC
  - Direct mapping to V2 CLI commands: `v2:train`, `v2:calibrate`, `v2:forecast`, `v2:cfac-train`, `v2:cfac-calibrate`, `v2:cfac-forecast`
  - Model file browser: Lists .vfm files from models/ directory
  - Calibration file browser: Lists calibration.json files from models/ directory
  - New IPC handlers: `list-vfm-files`, `list-calibration-files`
  - Shared terminal output panel with existing Manual tab
  - "Manual (V1)" tab retained for backward compatibility with old workflow

- **GUI V2 Models Tab Enhancements**
  - View mode toggle: Switch between "Instances" (database view) and "Files" (filesystem view)
  - Files view: Browse .vfm and calibration.json files separately
  - File detail panel: Display file metadata (path, size, modified date)
  - "Calibrate Now" action: Run calibration for selected .vfm file
  - File deletion: Delete .vfm or calibration.json files with confirmation
  - New IPC handler: `delete-file` for secure file deletion (restricted to .vfm and calibration.json)
  - Dual view supports both structured Training Instances and raw file management

- **GUI V2 Scheduler Tab Updates**
  - Active Model & Calibration Card: Select .vfm model file and calibration.json for Demand and CFAC forecasts
  - Calibration age display: Shows time since calibration file was last modified (e.g., "4h ago", "2d ago")
  - "Refresh Calibration Now" buttons: Immediately run `v2:calibrate` or `v2:cfac-calibrate` for active model
  - Auto-calibrate feature: Checkbox to enable automatic re-calibration when calibration is older than configured threshold (default: 24 hours)
  - Auto-calibrate logic integrated into scheduler run workflow: Checks calibration staleness before forecast and refreshes if needed
  - New IPC handler: `get-file-stats` to retrieve file modification time for age calculation
  - New computed properties: `schedulerV2DemandCalibrationAge`, `schedulerV2CfacCalibrationAge` for real-time age calculation
  - Implements V2 Scheduler architecture per `Documents/planning/GUI_V2_ARCHITECTURE.md` Section 4

### Added
- **Demand V2 Architecture - Phase 1 + Phase 2 Implementation (COMPLETE)**
  - **Phase 1 (Complete):** New data layer: `DataMerger.ts` for demand+weather alignment, `DailyAggregator.ts` for daily shape extraction
  - **Phase 1 (Complete):** Level Model: `LevelModel.ts` - XGBoost predicting daily total MW with 22 features (weather, calendar, lags)
  - **Phase 1 (Complete):** Shape Model Stage A: `ProfileLibrary.ts` - k-means clustering into archetypes with hierarchical smoothing
  - **Phase 1 (Complete):** Shape Model Stage B: `ShapeAdjuster.ts` - per-hour linear regression for weather-based corrections
  - **Phase 1 (Complete):** Shape Model Orchestrator: `ShapeModel.ts` - combines Stage A+B with archetype blending
  - **Phase 1 (Complete):** All shapes validated to sum to 1.0 by construction
  - **Phase 2 (Complete):** Combiner + Calibrator + Monitor: `ForecastCombiner.ts`, `Calibrator.ts`, `AmplitudeMonitor.ts`
  - **Phase 2 (Complete):** Pipelines: `TrainPipeline.ts`, `CalibratePipeline.ts`, `ForecastPipeline.ts` (lifecycle separation)
  - **Phase 2 (Complete):** Model Serialization: `ModelSerializer.ts` (MessagePack .vfm + calibration.json)
  - **Phase 2 (Complete):** Metrics: `LevelMetrics.ts`, `ShapeMetrics.ts`, `HourlyMetrics.ts`, `RetrainMonitor.ts`
  - **Phase 2 (Complete):** CLI Commands: `v2:train`, `v2:calibrate`, `v2:forecast` registered in `src/index.ts`
  - Implements full architecture spec from `Documents/planning/DEMAND_FORECAST_V2_ARCHITECTURE.md`
  - Stateless inference: model.vfm + calibration.json + weather = reproducible output
  - NOTE: API alignment with Phase 1 models needs refinement (weather fetch, lag features)

- **CFAC V2 Architecture - Phase 1 + Phase 2 Implementation**
  - **Phase 1 (Complete):** Pipeline architecture: `CfacTrainPipeline.ts`, `CfacCalibratePipeline.ts`, `CfacForecastPipeline.ts`
  - **Phase 1 (Complete):** Model serialization: `CfacModelSerializer.ts` for .vfm binary and .json calibration files
  - **Phase 1 (Complete):** Lifecycle separation: Train → Calibrate → Forecast (mirrors Demand V2)
  - **Phase 1 (Complete):** Hourly solar calibration: Per-station, per-hour scale factors (key V2 improvement)
  - **Phase 1 (Complete):** Calibration structure: Global bias + 24 hourly scale factors for wind/solar
  - **Phase 2 (Complete):** Asymmetric loss DEFAULT for solar (quantile α=0.65, configurable)
  - **Phase 2 (Complete):** Wind per-station hourly calibration re-enabled (was disabled in V1)
  - **Phase 2 (Complete):** Model consolidation: `WindHybridModel.ts` alias for `Wind4TierHybridModel`
  - **Phase 2 (Complete):** Legacy models moved to `src/models/capacityFactor/legacy/` with backward compatibility exports
  - **Phase 2 (Complete):** CLI Commands: `v2:cfac-train`, `v2:cfac-calibrate`, `v2:cfac-forecast` registered in `src/index.ts`
  - **Phase 2 (Deferred):** Stale weather cache detection (low priority, complex implementation)
  - Stateless inference: model.vfm + calibration.json + weather = reproducible output

### Added
- **GUI Architecture and CLI Integration Guide**
  - New technical document: `Documents/GUI_CLI_INTEGRATION.md`
  - Explains Electron GUI architecture and IPC bridge
  - Documents how each GUI tab maps to CLI commands
  - Covers Manual tab (training/inference modes), Scheduler tab (run/backfill)
  - Includes complete CLI command mapping for all GUI actions
  - Details portable mode detection and path resolution
  - Reference for developers working on GUI-CLI integration

- **CFAC Forecasting Methodology Report**
  - New comprehensive technical document: `Documents/CFAC_FORECASTING_METHODOLOGY.md`
  - Covers wind 4-tier MREC + ML hybrid models
  - Documents solar physics + ML residual correction approach
  - Explains profile-based models for hydro, geothermal, biomass
  - Details auto-calibration system and per-station bias correction
  - Includes station configuration, weather integration, and output format
  - Suitable for external technical review

- **Demand Forecasting Methodology Report**
  - New comprehensive technical document: `Documents/DEMAND_FORECASTING_METHODOLOGY.md`
  - Covers model architecture, feature engineering, calibration system
  - Includes mathematical formulas and configuration parameters
  - Suitable for external technical review

- **iEnergy Documentation Protocol v1.0 Adoption**
  - Created `DOCUMENTATION_PROTOCOL.md` with full protocol specification
  - Created `DECISIONS.md` with historical decisions (DEC-001 through DEC-006, BUG-001, BUG-002)
  - Created `archive/` directory for completed/abandoned plans
  - Added metadata headers to all .md files (Category A/B/C/D classification)
  - Added Session Initialization protocol to CLAUDE.md (mandatory 6-step process)
  - Added Document Maintenance rules to CLAUDE.md
  - Updated Documentation Index with Category column and full project coverage
  - Moved 5 completed plans to archive/ (.agent-task-phase1.md, .agent-task-phase-e1.md, SETTINGS_TAB_OVERHAUL_SUMMARY.md, HYBRID_CALIBRATION_IMPLEMENTATION.md, MODELS_PAGE_REDESIGN.md)

### Added
- **Full Model Details with Per-Zone/Region Metrics**
  - CLI `--model-name <name>` option for custom model naming with `--save-model`
  - GUI model name input field in Manual tab Training Settings section
  - Per-zone MAPE calculation for zonal forecasts (all 14 zones)
  - Per-region MAPE calculation for regional forecasts (CLUZ, CVIS, CMIN)
  - Database columns `per_zone_mape` and `per_region_mape` storing JSON breakdowns
  - Models tab displays per-zone/region performance grids with color-coded MAPE values

- **Model Management System (Phases 1-4)**
  - New SQLite-based model registry (`models/registry.db`) for tracking trained forecast models
  - Binary model file storage using MessagePack serialization (.vfm files)
  - Model metadata tracking: entity type/code, version, training period, performance metrics
  - Support for regional demand (3), zonal demand (14), and CFAC models (wind, solar, hydro, etc.)
  - Group model capability for CFAC (e.g., "all_solar" applies to all solar stations)
  - Model lifecycle management: save, activate, archive, delete operations
  - Training run history tracking with status and metrics

- **Model Management CLI Commands**
  - `models init` - Initialize model store (database + directory structure)
  - `models list` - List all models with filtering by entity type/code/status
  - `models info <id>` - Show detailed model information including metrics
  - `models activate <id>` - Activate a model (deactivates others for same entity)
  - `models archive <id>` - Archive a model
  - `models delete <id>` - Delete a model (removes registry + binary file)
  - `models groups` - List model groups
  - `models runs` - List recent training runs
  - `models train` - Train new models (stub - full integration pending)

- **Model Management GUI Tab**
  - New "Models" tab in GUI with model browser and management controls
  - Model summary cards: total models, active models, entities covered
  - Filterable model list by entity type and status
  - Model actions: activate, view details, delete
  - Initialize model store button for first-time setup
  - IPC handlers for all model operations

- **Model Storage Services**
  - `src/services/modelStore.ts` - Core model registry and file operations
  - `src/services/modelSerializer.ts` - Binary serialization with MessagePack and checksum validation
  - `src/services/modelTrainer.ts` - Training pipeline framework (stub)
  - `src/services/forecastGenerator.ts` - Fast forecast generation using pre-trained models (stub)
  - `src/services/intradayRefresh.ts` - Hourly forecast refresh logic (stub)

- **Model Type Definitions**
  - `src/types/models.ts` - Complete type system for model management
  - Interfaces: SavedModel, ModelMetadata, ModelMetrics, ModelRegistry, ModelGroup, TrainingRun
  - Entity types: regional, zonal, wind, solar, hydro, biomass, geothermal, battery
  - Model types: xgboost, hybrid, regression (demand), 4tier, mrec, physics (CFAC)

### Added
- **Gateway File Listing in GUI (Phase 2)**
  - New file listing table in Gateway Storage tab showing individual files on gateway
  - Filter dropdowns for type (day-ahead/week-ahead), category (demand/mhcf), geography (regional/zonal)
  - Geography badges: green "REG (3)" for regional, yellow "ZONAL (14)" for zonal files
  - IPC handler `get-gateway-files` calls gateway `GET /admin/files` endpoint
  - Preload bridge `getGatewayFiles()` method with filter parameters
  - Auto-loads file listing when Gateway tab is activated

### Fixed
- **Zonal Demand Peak Shape Mismatch (BUG-003)**
  - Fixed 14-zone demand forecasts producing generic/averaged peak shapes instead of zone-specific patterns
  - Added `ZONE_TO_PARENT_REGION` mapping for weekend correction fallback
  - Weekend corrections now apply to zones via parent region fallback (01NLUZ→CLUZ, etc.)
  - Removed dangerous profile fallback that could silently use wrong zone's profile
  - Zonal forecasts now maintain zone-specific demand curves from training data

- **Hardcoded Weekend Corrections (DEC-007)**
  - Removed stale hardcoded weekend correction factors for CLUZ/CVIS/CMIN
  - All weekend corrections now learned fresh from training data every run
  - Added calibration settings visibility banner showing mode, alpha, zone scaling status
  - Improved diagnostic output to confirm calibration is running

- **Solar Hour Constraints Expanded for Seasonal Variation**
  - Changed daylight hour constraints from 6 AM - 6 PM to 5 AM - 7 PM
  - Allows solar forecasts to capture earlier sunrise during summer months
  - Updated in: SolarMRECHybridModel.ts, SolarHybridModel.ts, SolarPremiumHybridModel.ts, index.ts
  - Fixes user-reported issue where solar forecasts always started at hour 7

- **Geography Option in Scheduler Backfill Command**
  - Added `--geography <type>` CLI option (regional, zonal, both) with default "both"
  - CLI now properly passes `demandGeography` from config to ForecastSchedulerService
  - Fixed issue where zonal forecasts were not generated when `geography: "both"` was configured

### Changed
- **Default Geography Mode**
  - Changed default `demand.geography` in `forecast_config.json` from "regional" to "both"
  - Both regional (3 regions) and zonal (14 sub-regions) forecasts now generated by default

### Added
- **Gateway HTTP Service for Gateway v2.5.0 (Phase 2)**
  - New `src/services/gatewayHttpService.ts` implementing HTTP-based forecast uploads
  - Explicit `geography` parameter for demand forecasts (`regional` or `zonal`)
  - JWT-based authentication using license ID with automatic token refresh (23-hour validity)
  - Retry logic with exponential backoff for transient network errors
  - Non-retryable validation errors handled gracefully (INVALID_GEOGRAPHY, CONTENT_GEOGRAPHY_MISMATCH, etc.)
  - Factory functions: `getGatewayHttpService()`, `isHttpGatewayConfigured()`
  - HTTP upload preferred when license configured, SFTP retained as fallback

- **Extended Gateway Configuration**
  - New config fields in `GatewayConfig`: `httpUrl`, `licenseId`, `preferHttp`
  - Environment variable support: `VANTAGE_GATEWAY_URL`, `VANTAGE_LICENSE_ID`
  - Backward compatible with existing SFTP configuration

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
- **Gateway Push Service Updates**
  - `sftpPushService.ts` now supports optional `geography` parameter in `pushFileToGateway()`
  - HTTP upload attempted first when `preferHttp: true` (default) and license is configured
  - SFTP fallback when HTTP unavailable or fails
  - New `httpUpload` field in `PushResult` indicates upload method used

- **Forecast Scheduler Service Updates**
  - `forecastSchedulerService.ts` passes geography from forecast context to gateway push
  - CFAC forecasts pass `undefined` geography (not applicable)
  - Demand forecasts pass explicit `regional` or `zonal` based on config

- **Documentation Updates**
  - CLAUDE.md: Removed references to deleted commands and LSTM models
  - CLI_GUIDE.md: Added config command section, removed LSTM training documentation
  - QUICK_START.md: Simplified examples to use global config
  - All guides now reference `forecast_config.json` for settings

- **Model Files**
  - Hybrid demand model is now the only production model (no LSTM correction layer)
  - Capacity factor models unchanged (Wind 4-Tier Hybrid, Solar Physics+ML)

### Technical
- New `GatewayHttpService` class with full TypeScript type definitions
- Types exported: `ForecastType`, `ForecastCategory`, `Geography`, `UploadConfig`, `UploadResponse`, `HttpPushResult`
- Singleton pattern with `getGatewayHttpService()` factory function
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
