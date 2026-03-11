# Scheduler Enhancement Implementation Plan

**Date:** 2026-02-27
**Status:** Planning
**Related:** [GATEWAY_SETUP_COMPLETE.md](../vantage-gateway/GATEWAY_SETUP_COMPLETE.md)

---

## Overview

This plan details the enhancements needed to automate day-ahead and week-ahead forecasts with:
- Configurable run times via GUI
- Weather data freshness handling (6-hour cache expiry for future dates)
- Forecast archiving separate from historical data
- Gateway push to new directory structure
- Database integration for tracking

---

## 1. Database Schema Changes

### 1.1 Modify `forecast_runs` Table

The existing table needs new columns for enhanced tracking:

```sql
-- Add to existing forecast_runs table
ALTER TABLE forecast_runs ADD COLUMN run_source TEXT DEFAULT 'manual';
-- Values: 'manual', 'scheduled', 'backfill', 'gui'

ALTER TABLE forecast_runs ADD COLUMN weather_refresh_mode TEXT DEFAULT 'cache';
-- Values: 'cache', 'refresh', 'force-refresh'

ALTER TABLE forecast_runs ADD COLUMN archive_path TEXT;
-- Path where forecast was archived (e.g., /forecasts/2026-02/2026-02-27/)

ALTER TABLE forecast_runs ADD COLUMN pushed_to_gateway INTEGER DEFAULT 0;
-- 0 = not pushed, 1 = pushed successfully

ALTER TABLE forecast_runs ADD COLUMN push_timestamp TEXT;
-- When the file was pushed to gateway

ALTER TABLE forecast_runs ADD COLUMN gateway_path TEXT;
-- Remote path on gateway (e.g., /day-ahead/demand/DA_DEM_2026-02-28.csv)

ALTER TABLE forecast_runs ADD COLUMN file_checksum TEXT;
-- SHA256 of the output file for integrity verification
```

### 1.2 New `scheduler_config` Table

```sql
CREATE TABLE IF NOT EXISTS scheduler_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),  -- Singleton row
  enabled INTEGER DEFAULT 0,
  run_time_morning TEXT DEFAULT '06:00',   -- HH:MM format (PHT)
  run_time_evening TEXT DEFAULT '18:00',   -- Optional second run
  run_days TEXT DEFAULT '1,2,3,4,5,6,7',   -- Comma-separated day numbers (1=Mon)
  forecast_types TEXT DEFAULT 'demand,cfac', -- Comma-separated
  horizons TEXT DEFAULT 'daily,weekly',      -- Comma-separated
  weather_max_age_hours INTEGER DEFAULT 6,   -- Cache expiry for future dates
  auto_push_gateway INTEGER DEFAULT 1,       -- Push on successful forecast
  archive_retention_days INTEGER DEFAULT 90, -- Days to keep local archives
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Insert default config
INSERT OR IGNORE INTO scheduler_config (id) VALUES (1);
```

### 1.3 New `forecast_archive` Table

Track archived forecasts for comparison:

```sql
CREATE TABLE IF NOT EXISTS forecast_archive (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL,
  archive_date TEXT NOT NULL,          -- Date archived (YYYY-MM-DD)
  forecast_date TEXT NOT NULL,         -- Target date being forecasted
  horizon TEXT NOT NULL,               -- 'daily' or 'weekly'
  forecast_type TEXT NOT NULL,         -- 'demand' or 'cfac'
  local_path TEXT NOT NULL,            -- Local archive path
  gateway_path TEXT,                   -- Remote gateway path (if pushed)
  file_size_bytes INTEGER,
  checksum TEXT,                       -- SHA256 for integrity
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (run_id) REFERENCES forecast_runs(id)
);

CREATE INDEX IF NOT EXISTS idx_archive_date ON forecast_archive(archive_date);
CREATE INDEX IF NOT EXISTS idx_archive_forecast_date ON forecast_archive(forecast_date);
```

### 1.4 New `hourly_forecasts` Tables

Store hourly forecast values for database-driven evaluation:

```sql
-- Demand forecasts (hourly values per region)
CREATE TABLE IF NOT EXISTS demand_forecast_hourly (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL,
  datetime TEXT NOT NULL,              -- ISO 8601 timestamp
  region TEXT NOT NULL,                -- CLUZ, CVIS, CMIN (or 14 zone codes)
  forecast_mw REAL NOT NULL,
  actual_mw REAL,                      -- Populated during evaluation
  error_mw REAL,                       -- forecast - actual
  error_pct REAL,                      -- Percentage error
  FOREIGN KEY (run_id) REFERENCES forecast_runs(id)
);

CREATE INDEX IF NOT EXISTS idx_demand_hourly_run ON demand_forecast_hourly(run_id);
CREATE INDEX IF NOT EXISTS idx_demand_hourly_dt ON demand_forecast_hourly(datetime);

-- CFAC forecasts (hourly values per station)
CREATE TABLE IF NOT EXISTS cfac_forecast_hourly (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL,
  datetime TEXT NOT NULL,
  station_code TEXT NOT NULL,          -- e.g., 01BURGOS, 01SNMANUEL_S
  station_type TEXT NOT NULL,          -- WIND, SOLAR, HYDRO, etc.
  forecast_cf REAL NOT NULL,           -- Capacity factor 0-1
  actual_cf REAL,                      -- Populated during evaluation
  error_cf REAL,
  error_pct REAL,
  FOREIGN KEY (run_id) REFERENCES forecast_runs(id)
);

CREATE INDEX IF NOT EXISTS idx_cfac_hourly_run ON cfac_forecast_hourly(run_id);
CREATE INDEX IF NOT EXISTS idx_cfac_hourly_dt ON cfac_forecast_hourly(datetime);
```

---

## 2. Weather Cache Enhancement

### 2.1 Cache Age Checking

Add to `src/services/weatherService.ts`:

```typescript
interface WeatherCacheInfo {
  path: string;
  exists: boolean;
  ageHours: number;
  isHistorical: boolean;  // Target date is fully in the past
  needsRefresh: boolean;
}

/**
 * Check if weather cache needs refresh
 *
 * Rule: Historical data (target date fully passed) never expires.
 * Future data expires after maxAgeHours (default 6).
 *
 * IMPORTANT: "Historical" is determined by comparing the target date
 * to the current date in PHT, not by current time. This handles the
 * midnight edge case correctly.
 */
function checkCacheAge(
  targetDate: string,  // YYYY-MM-DD
  cachePath: string,
  maxAgeHours: number = 6
): WeatherCacheInfo {
  const now = DateTime.now().setZone('Asia/Manila');
  const target = DateTime.fromISO(targetDate).setZone('Asia/Manila');

  // Target is historical if the entire day has passed
  // (target date < today's date, not just current time)
  const isHistorical = target.startOf('day') < now.startOf('day');

  const exists = fs.existsSync(cachePath);
  let ageHours = 0;

  if (exists) {
    const stats = fs.statSync(cachePath);
    ageHours = (now.toMillis() - stats.mtimeMs) / (1000 * 60 * 60);
  }

  // Historical data never needs refresh
  // Future data needs refresh if older than maxAgeHours
  const needsRefresh = !isHistorical && exists && ageHours > maxAgeHours;

  return { path: cachePath, exists, ageHours, isHistorical, needsRefresh };
}
```

### 2.2 Weather Refresh Modes

```typescript
type WeatherRefreshMode = 'cache' | 'refresh' | 'force-refresh';

interface FetchWeatherOptions {
  refreshMode: WeatherRefreshMode;
  maxAgeHours: number;
}

// In weatherService.fetchWeather():
async function fetchWeather(
  location: ClusterLocation,
  startDate: string,
  endDate: string,
  options: FetchWeatherOptions = { refreshMode: 'cache', maxAgeHours: 6 }
): Promise<RawWeatherData[]> {
  const cacheInfo = checkCacheAge(startDate, getCachePath(location, startDate), options.maxAgeHours);

  if (options.refreshMode === 'force-refresh') {
    // Delete cache and fetch fresh
    if (cacheInfo.exists) fs.unlinkSync(cacheInfo.path);
    return await fetchFromAPI(location, startDate, endDate);
  }

  if (options.refreshMode === 'refresh' && cacheInfo.needsRefresh) {
    // Refresh stale future data
    if (cacheInfo.exists) fs.unlinkSync(cacheInfo.path);
    return await fetchFromAPI(location, startDate, endDate);
  }

  // Default: use cache if available
  if (cacheInfo.exists) {
    return loadFromCache(cacheInfo.path);
  }

  return await fetchFromAPI(location, startDate, endDate);
}
```

---

## 3. Gateway Push Service Updates

### 3.1 Update `sftpPushService.ts`

Update `getRemoteDirectory()` to match new gateway structure:

```typescript
export type ForecastCategory =
  | 'day-ahead-demand'
  | 'day-ahead-mhcf'
  | 'week-ahead-demand'
  | 'week-ahead-mhcf'
  | 'historical-scenarios-weekly'
  | 'historical-scenarios-monthly'
  | 'historical-databases';

/**
 * Get remote directory based on filename pattern or explicit category
 * Matches structure in GATEWAY_SETUP_COMPLETE.md
 */
export function getRemoteDirectory(filename: string, category?: ForecastCategory): string {
  // If explicit category provided
  if (category) {
    const pathMap: Record<ForecastCategory, string> = {
      'day-ahead-demand': '/day-ahead/demand',
      'day-ahead-mhcf': '/day-ahead/mhcf',
      'week-ahead-demand': '/week-ahead/demand',
      'week-ahead-mhcf': '/week-ahead/mhcf',
      'historical-scenarios-weekly': '/historical/scenarios/weekly',
      'historical-scenarios-monthly': '/historical/scenarios/monthly',
      'historical-databases': '/historical/databases'
    };
    return pathMap[category] || '/other';
  }

  // Auto-detect from filename
  const fn = filename.toUpperCase();

  // Day-Ahead patterns
  if (fn.startsWith('DA_DEM') || fn.includes('DAY_AHEAD_DEM')) {
    return '/day-ahead/demand';
  }
  if (fn.startsWith('DA_MHCF') || fn.startsWith('DA_CF') || fn.includes('DAY_AHEAD_MHCF')) {
    return '/day-ahead/mhcf';
  }

  // Week-Ahead patterns
  if (fn.startsWith('WA_DEM') || fn.includes('WEEK_AHEAD_DEM')) {
    return '/week-ahead/demand';
  }
  if (fn.startsWith('WA_MHCF') || fn.startsWith('WA_CF') || fn.includes('WEEK_AHEAD_MHCF')) {
    return '/week-ahead/mhcf';
  }

  // Historical patterns
  if (fn.includes('HIST') && fn.includes('WEEKLY')) {
    return '/historical/scenarios/weekly';
  }
  if (fn.includes('HIST') && fn.includes('MONTHLY')) {
    return '/historical/scenarios/monthly';
  }
  if (fn.endsWith('.MDB') || fn.endsWith('.ACCDB')) {
    return '/historical/databases';
  }

  // Default fallback
  return '/other';
}
```

### 3.2 File Naming Convention

Update scheduler to use gateway naming:

```typescript
interface ForecastFileNaming {
  horizon: 'daily' | 'weekly';
  type: 'demand' | 'cfac';
  targetDate: string;  // YYYY-MM-DD (first day of forecast)
}

function getGatewayFilename(config: ForecastFileNaming): string {
  const prefix = config.horizon === 'daily' ? 'DA' : 'WA';
  const typeCode = config.type === 'demand' ? 'DEM' : 'MHCF';
  return `${prefix}_${typeCode}_${config.targetDate}.csv`;
}

// Examples:
// Daily demand for 2026-02-28: DA_DEM_2026-02-28.csv
// Weekly MHCF for 2026-02-28: WA_MHCF_2026-02-28.csv
```

---

## 4. Scheduler Service Enhancements

### 4.1 Enhanced Configuration

Update `forecastSchedulerService.ts`:

```typescript
interface SchedulerConfig {
  // Existing
  demandDataPath: string;
  cfacDataPath: string;
  outputDir: string;
  dbPath: string;

  // New: Configurable run times
  runTimes: string[];           // ['06:00', '18:00'] (PHT)
  runDays: number[];            // [1,2,3,4,5,6,7] (1=Monday)

  // New: Weather refresh
  weatherMaxAgeHours: number;   // Default: 6
  weatherRefreshMode: 'auto' | 'always' | 'never';

  // New: Archiving
  archiveEnabled: boolean;
  archiveRetentionDays: number; // Default: 90

  // New: Gateway
  gatewayEnabled: boolean;
  gatewayNaming: 'gateway' | 'legacy';  // Use DA_DEM_* or FC_DEM_*

  // Existing...
}
```

### 4.2 Archive Management

```typescript
/**
 * Archive a forecast file
 *
 * Structure:
 *   output/archive/YYYY-MM/YYYY-MM-DD/
 *     ├── DA_DEM_2026-02-28.csv
 *     ├── DA_MHCF_2026-02-28.csv
 *     ├── WA_DEM_2026-02-28.csv
 *     └── WA_MHCF_2026-02-28.csv
 */
function archiveForecast(
  outputFile: string,
  asOfDate: string,
  horizon: 'daily' | 'weekly',
  type: 'demand' | 'cfac'
): string {
  const asOf = DateTime.fromISO(asOfDate);
  const monthDir = asOf.toFormat('yyyy-MM');
  const dateDir = asOfDate;

  const archiveDir = join(this.config.outputDir, 'archive', monthDir, dateDir);
  if (!existsSync(archiveDir)) {
    mkdirSync(archiveDir, { recursive: true });
  }

  // Rename to gateway format
  const targetDate = horizon === 'daily'
    ? asOf.plus({ days: 1 }).toISODate()!
    : asOf.plus({ days: 1 }).toISODate()!;  // Week starts next day
  const newFilename = getGatewayFilename({ horizon, type, targetDate });

  const archivePath = join(archiveDir, newFilename);
  fs.copyFileSync(outputFile, archivePath);

  return archivePath;
}
```

### 4.3 Database Transaction for Hourly Values

```typescript
/**
 * Store hourly forecast values in database using transaction
 * Handles thousands of rows atomically
 */
function storeHourlyForecasts(
  runId: number,
  forecastFile: string,
  type: 'demand' | 'cfac'
): void {
  const content = fs.readFileSync(forecastFile, 'utf-8');
  const data = parse(content, { columns: true, skip_empty_lines: true });

  const db = this.db;

  if (type === 'demand') {
    const insert = db.prepare(`
      INSERT INTO demand_forecast_hourly (run_id, datetime, region, forecast_mw)
      VALUES (?, ?, ?, ?)
    `);

    const transaction = db.transaction((rows: any[]) => {
      for (const row of rows) {
        const dt = row.DateTimeEnding;
        for (const region of ['CLUZ', 'CVIS', 'CMIN']) {
          const value = parseFloat(row[region]);
          if (!isNaN(value)) {
            insert.run(runId, dt, region, value);
          }
        }
      }
    });

    transaction(data);
  } else {
    // CFAC storage similar
    const insert = db.prepare(`
      INSERT INTO cfac_forecast_hourly (run_id, datetime, station_code, station_type, forecast_cf)
      VALUES (?, ?, ?, ?, ?)
    `);

    const transaction = db.transaction((rows: any[]) => {
      for (const row of rows) {
        const dt = row.DateTimeEnding;
        for (const [station, value] of Object.entries(row)) {
          if (station === 'DateTimeEnding') continue;
          const cf = parseFloat(value as string);
          if (!isNaN(cf)) {
            const stationType = getStationTypeFromCode(station);
            insert.run(runId, dt, station, stationType, cf);
          }
        }
      }
    });

    transaction(data);
  }
}
```

---

## 5. CLI Enhancements

### 5.1 Scheduler Commands

Update `src/index.ts` to add scheduler subcommands:

```typescript
// scheduler run - Run scheduled forecasts
program
  .command('scheduler')
  .description('Automated forecast scheduling')
  .addCommand(
    new Command('run')
      .description('Run scheduled forecasts for a date')
      .option('-d, --date <date>', 'As-of date (YYYY-MM-DD)', DateTime.now().setZone('Asia/Manila').toISODate())
      .option('--demand-only', 'Only generate demand forecasts')
      .option('--cfac-only', 'Only generate capacity factor forecasts')
      .option('--daily', 'Only daily (next-day) forecasts')
      .option('--weekly', 'Only weekly (7-day) forecasts')
      .option('--refresh-weather', 'Force refresh weather cache for future dates')
      .option('--no-push', 'Skip gateway push even if enabled')
      .option('-o, --output <dir>', 'Output directory', './output')
      .action(async (opts) => { /* ... */ })
  )
  .addCommand(
    new Command('backfill')
      .description('Generate forecasts for a date range (historical)')
      .requiredOption('-s, --start <date>', 'Start date (YYYY-MM-DD)')
      .requiredOption('-e, --end <date>', 'End date (YYYY-MM-DD)')
      .option('--demand-only', 'Only generate demand forecasts')
      .option('--cfac-only', 'Only generate capacity factor forecasts')
      .option('--daily', 'Only daily forecasts')
      .option('--weekly', 'Only weekly forecasts')
      .option('--overwrite', 'Overwrite existing archives')
      .option('--suffix <text>', 'Add suffix to filenames (e.g., _v2)')
      .option('--no-push', 'Skip gateway push')
      .option('-o, --output <dir>', 'Output directory', './output')
      .action(async (opts) => { /* ... */ })
  )
  .addCommand(
    new Command('config')
      .description('View or set scheduler configuration')
      .option('--show', 'Show current configuration')
      .option('--set-time <times>', 'Set run times (comma-separated, e.g., "06:00,18:00")')
      .option('--set-days <days>', 'Set run days (1=Mon, e.g., "1,2,3,4,5")')
      .option('--enable', 'Enable scheduler')
      .option('--disable', 'Disable scheduler')
      .action(async (opts) => { /* ... */ })
  )
  .addCommand(
    new Command('service')
      .description('Run scheduler as a background service')
      .option('--interval <mins>', 'Check interval in minutes', '60')
      .action(async (opts) => { /* ... */ })
  )
  .addCommand(
    new Command('status')
      .description('Show scheduler status and recent runs')
      .option('--limit <n>', 'Number of recent runs to show', '10')
      .action(async (opts) => { /* ... */ })
  );
```

### 5.2 Gateway Commands (Existing + Enhancements)

```typescript
// gateway push - Push specific file with category
program
  .command('gateway')
  .description('Gateway management')
  .addCommand(
    new Command('push')
      .description('Push file(s) to gateway')
      .argument('[file]', 'File to push (or --all for batch)')
      .option('--all', 'Push all pending forecasts from output dir')
      .option('--category <cat>', 'Explicit category (day-ahead-demand, day-ahead-mhcf, etc.)')
      .option('-o, --output <dir>', 'Output directory for --all', './output')
      .action(async (file, opts) => { /* ... */ })
  )
  .addCommand(
    new Command('test')
      .description('Test gateway connection')
      .action(async () => { /* ... */ })
  )
  .addCommand(
    new Command('status')
      .description('Show gateway configuration status')
      .action(async () => { /* ... */ })
  );
```

---

## 6. GUI Enhancements

### 6.1 Scheduler Tab

Add a new "Scheduler" tab in `gui/src/App.vue`:

```vue
<template>
  <!-- Add to tabs -->
  <button
    @click="activeTab = 'scheduler'"
    :class="{ active: activeTab === 'scheduler' }"
  >
    Scheduler
  </button>

  <!-- Scheduler Tab Content -->
  <div v-if="activeTab === 'scheduler'" class="scheduler-tab">
    <div class="scheduler-config">
      <h3>Scheduler Configuration</h3>

      <!-- Enable/Disable -->
      <div class="config-row">
        <label>Scheduler Enabled</label>
        <label class="toggle">
          <input type="checkbox" v-model="schedulerConfig.enabled">
          <span class="toggle-slider"></span>
        </label>
      </div>

      <!-- Run Times -->
      <div class="config-row">
        <label>Run Times (PHT)</label>
        <div class="time-inputs">
          <input type="time" v-model="schedulerConfig.runTime1" placeholder="06:00">
          <input type="time" v-model="schedulerConfig.runTime2" placeholder="18:00"
                 :disabled="!schedulerConfig.secondRunEnabled">
          <label class="toggle small">
            <input type="checkbox" v-model="schedulerConfig.secondRunEnabled">
            <span class="toggle-slider"></span>
          </label>
          <span>Second run</span>
        </div>
      </div>

      <!-- Run Days -->
      <div class="config-row">
        <label>Run Days</label>
        <div class="day-checkboxes">
          <label v-for="day in ['Mon','Tue','Wed','Thu','Fri','Sat','Sun']" :key="day">
            <input type="checkbox" :value="day" v-model="schedulerConfig.runDays">
            {{ day }}
          </label>
        </div>
      </div>

      <!-- Forecast Types -->
      <div class="config-row">
        <label>Forecast Types</label>
        <div class="checkbox-group">
          <label>
            <input type="checkbox" v-model="schedulerConfig.forecastDemand">
            Demand
          </label>
          <label>
            <input type="checkbox" v-model="schedulerConfig.forecastCfac">
            Capacity Factor
          </label>
        </div>
      </div>

      <!-- Horizons -->
      <div class="config-row">
        <label>Forecast Horizons</label>
        <div class="checkbox-group">
          <label>
            <input type="checkbox" v-model="schedulerConfig.horizonDaily">
            Daily (Day-Ahead)
          </label>
          <label>
            <input type="checkbox" v-model="schedulerConfig.horizonWeekly">
            Weekly (Week-Ahead)
          </label>
        </div>
      </div>

      <!-- Weather Settings -->
      <div class="config-section">
        <h4>Weather Cache</h4>
        <div class="config-row">
          <label>Max Age (hours)</label>
          <input type="number" v-model.number="schedulerConfig.weatherMaxAge" min="1" max="24">
          <span class="hint">Future date cache expires after this time</span>
        </div>
      </div>

      <!-- Gateway Settings -->
      <div class="config-section">
        <h4>Gateway Push</h4>
        <div class="config-row">
          <label>Auto-push on completion</label>
          <label class="toggle">
            <input type="checkbox" v-model="schedulerConfig.autoPushGateway">
            <span class="toggle-slider gateway"></span>
          </label>
        </div>
      </div>

      <!-- Archive Settings -->
      <div class="config-section">
        <h4>Archiving</h4>
        <div class="config-row">
          <label>Retention (days)</label>
          <input type="number" v-model.number="schedulerConfig.archiveRetention" min="7" max="365">
        </div>
      </div>

      <button class="save-btn" @click="saveSchedulerConfig">Save Configuration</button>
    </div>

    <!-- Recent Runs -->
    <div class="recent-runs">
      <h3>Recent Forecast Runs</h3>
      <table class="runs-table">
        <thead>
          <tr>
            <th>Date</th>
            <th>Type</th>
            <th>Horizon</th>
            <th>Status</th>
            <th>Records</th>
            <th>Gateway</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="run in recentRuns" :key="run.id">
            <td>{{ run.run_date }}</td>
            <td>{{ run.forecast_type }}</td>
            <td>{{ run.horizon }}</td>
            <td :class="'status-' + run.status">{{ run.status }}</td>
            <td>{{ run.records_generated || '-' }}</td>
            <td>
              <span v-if="run.pushed_to_gateway" class="pushed">✓</span>
              <span v-else class="not-pushed">-</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Manual Run -->
    <div class="manual-run">
      <h3>Manual Run</h3>
      <div class="run-form">
        <input type="date" v-model="manualRunDate">
        <select v-model="manualRunType">
          <option value="both">Demand + CFAC</option>
          <option value="demand">Demand Only</option>
          <option value="cfac">CFAC Only</option>
        </select>
        <select v-model="manualRunHorizon">
          <option value="both">Daily + Weekly</option>
          <option value="daily">Daily Only</option>
          <option value="weekly">Weekly Only</option>
        </select>
        <button @click="runManualForecast" :disabled="isRunning">
          {{ isRunning ? 'Running...' : 'Run Now' }}
        </button>
      </div>
    </div>
  </div>
</template>
```

### 6.2 GUI TypeScript Interface

```typescript
interface SchedulerConfig {
  enabled: boolean;
  runTime1: string;      // "06:00"
  runTime2: string;      // "18:00"
  secondRunEnabled: boolean;
  runDays: string[];     // ["Mon", "Tue", ...]
  forecastDemand: boolean;
  forecastCfac: boolean;
  horizonDaily: boolean;
  horizonWeekly: boolean;
  weatherMaxAge: number;
  autoPushGateway: boolean;
  archiveRetention: number;
}

interface ForecastRun {
  id: number;
  run_date: string;
  run_time: string;
  forecast_type: 'demand' | 'cfac';
  horizon: 'daily' | 'weekly';
  status: 'pending' | 'completed' | 'failed';
  records_generated: number;
  pushed_to_gateway: boolean;
  gateway_path?: string;
}
```

---

## 7. Gateway Push Flow

### 7.1 Complete Push Sequence

```
1. Forecast Generated
   ├── Output: output/daily/Demand/demand_2026-02-28_2026-02-28.csv
   │
2. Archive Created
   ├── Archive: output/archive/2026-02/2026-02-27/DA_DEM_2026-02-28.csv
   │
3. Gateway Push
   ├── Rename to: DA_DEM_2026-02-28.csv
   ├── SFTP to: /day-ahead/demand/DA_DEM_2026-02-28.csv
   │
4. Database Updated
   ├── forecast_runs.pushed_to_gateway = 1
   ├── forecast_runs.push_timestamp = NOW()
   └── forecast_runs.gateway_path = /day-ahead/demand/DA_DEM_2026-02-28.csv
```

### 7.2 Gateway Path Mapping

| Forecast Type | Horizon | Local Output | Gateway Path |
|--------------|---------|--------------|--------------|
| Demand | Daily | `output/daily/Demand/demand_2026-02-28_2026-02-28.csv` | `/day-ahead/demand/DA_DEM_2026-02-28.csv` |
| CFAC | Daily | `output/daily/CFAC/cfac_2026-02-28_2026-02-28.csv` | `/day-ahead/mhcf/DA_MHCF_2026-02-28.csv` |
| Demand | Weekly | `output/weekly/Demand/demand_2026-02-28_2026-03-06.csv` | `/week-ahead/demand/WA_DEM_2026-02-28.csv` |
| CFAC | Weekly | `output/weekly/CFAC/cfac_2026-02-28_2026-03-06.csv` | `/week-ahead/mhcf/WA_MHCF_2026-02-28.csv` |

---

## 8. Implementation Order

### Phase 1: Database Schema
1. Add new columns to `forecast_runs`
2. Create `scheduler_config` table
3. Create `forecast_archive` table
4. Create hourly forecast tables

### Phase 2: Weather Cache
1. Implement `checkCacheAge()` function
2. Add midnight edge case handling
3. Integrate with weather service

### Phase 3: Gateway Updates
1. Update `getRemoteDirectory()` for new paths
2. Add `getGatewayFilename()` function
3. Update `pushFileToGateway()` signature

### Phase 4: Scheduler Service
1. Update `SchedulerConfig` interface
2. Add archive management
3. Add database transaction for hourly storage
4. Implement weather refresh mode

### Phase 5: CLI Commands
1. Enhance `scheduler run` command
2. Implement `scheduler backfill` with overwrite/suffix
3. Add `scheduler config` command
4. Update `gateway push` with categories

### Phase 6: GUI
1. Add Scheduler tab structure
2. Implement config save/load via IPC
3. Add recent runs display
4. Add manual run functionality

---

## 9. Testing Plan

### 9.1 Unit Tests
- [ ] Weather cache age calculation
- [ ] Midnight edge case (11:59 PM vs 12:01 AM)
- [ ] Gateway path determination
- [ ] File naming convention

### 9.2 Integration Tests
- [ ] End-to-end scheduler run
- [ ] Database transaction rollback
- [ ] Gateway push with retry
- [ ] Archive creation and cleanup

### 9.3 Manual Tests
- [ ] GUI scheduler tab functionality
- [ ] Backfill with overwrite
- [ ] Weather refresh modes
- [ ] Gateway connection failure handling

---

## 10. Rollback Plan

If issues arise:
1. Database: Keep schema changes backward compatible (new columns nullable)
2. Gateway: Old paths still work (auto-detection fallback)
3. CLI: Existing commands unchanged, new options optional
4. GUI: Tab can be hidden via config flag

---

## Appendix: File Naming Examples

```
Day-Ahead Demand for Feb 28, 2026:
  Local:   demand_2026-02-28_2026-02-28.csv
  Archive: DA_DEM_2026-02-28.csv
  Gateway: /day-ahead/demand/DA_DEM_2026-02-28.csv

Week-Ahead CFAC starting Feb 28, 2026:
  Local:   cfac_2026-02-28_2026-03-06.csv
  Archive: WA_MHCF_2026-02-28.csv
  Gateway: /week-ahead/mhcf/WA_MHCF_2026-02-28.csv
```
