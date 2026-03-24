---
Status: Active
Last-Updated: 2026-03-24
Updated-By: Claude Code
---

# GUI Architecture and CLI Integration

**Technical Reference for GUI-to-CLI Command Mapping**

---

## Executive Summary

The Vantage Forecaster GUI is an Electron desktop application that provides a visual interface for forecast operations. **All forecast logic resides in the CLI** — the GUI is a thin wrapper that:

1. Collects user inputs (dates, paths, options)
2. Constructs CLI command arguments
3. Spawns Node.js child processes to execute commands
4. Displays real-time output and results

**Key Principle:** The GUI never runs forecast models directly. It always invokes the CLI via IPC.

---

## 1. Architecture Overview

### 1.1 Technology Stack

| Component | Technology | Purpose |
|-----------|-----------|---------|
| Desktop Shell | Electron | Window management, native dialogs |
| Frontend | Vue 3 + TypeScript | Reactive UI components |
| IPC Bridge | Electron IPC | Main ↔ Renderer communication |
| CLI Execution | Node.js child_process | Command spawning |
| State Persistence | electron-store | Settings, window state |
| Configuration | `forecast_config.json` | Global settings |

### 1.2 Process Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Electron Main Process                     │
│  (gui/electron/main.ts)                                         │
│                                                                 │
│  ┌─────────────────┐     ┌─────────────────────────────┐       │
│  │ IPC Handlers    │────▶│ Child Process (Node.js)     │       │
│  │ run-command     │     │ spawn(node, [dist/index.js, │       │
│  │ run-scheduler   │     │        ...args])            │       │
│  │ load-config     │     └─────────────────────────────┘       │
│  └─────────────────┘                 │                         │
│          ▲                           │ stdout/stderr           │
│          │ IPC                       ▼                         │
└──────────┼───────────────────────────┼─────────────────────────┘
           │                           │
┌──────────┼───────────────────────────┼─────────────────────────┐
│          │                           │                         │
│  ┌───────┴───────┐           ┌───────┴───────┐                │
│  │ preload.ts    │           │ Real-time     │                │
│  │ electronAPI   │◀──────────│ Output Events │                │
│  └───────┬───────┘           └───────────────┘                │
│          │                                                     │
│  ┌───────┴───────────────────────────────────────────────┐    │
│  │                   Vue Application (App.vue)            │    │
│  │  ┌─────────┐ ┌───────────┐ ┌─────────┐ ┌──────────┐   │    │
│  │  │ Manual  │ │ Scheduler │ │ Models  │ │ Settings │   │    │
│  │  │   Tab   │ │    Tab    │ │   Tab   │ │   Tab    │   │    │
│  │  └─────────┘ └───────────┘ └─────────┘ └──────────┘   │    │
│  └───────────────────────────────────────────────────────┘    │
│                     Electron Renderer Process                  │
└───────────────────────────────────────────────────────────────┘
```

### 1.3 Key Files

| File | Purpose |
|------|---------|
| `gui/electron/main.ts` | Electron main process, IPC handlers |
| `gui/electron/preload.ts` | Security bridge, exposes `electronAPI` |
| `gui/src/App.vue` | Main Vue application (all tabs) |
| `gui/src/vite-env.d.ts` | TypeScript type definitions |
| `forecast_config.json` | Global configuration (persisted) |

---

## 2. GUI Tabs Overview

### 2.1 Tab Summary

| Tab | Purpose | Primary CLI Commands |
|-----|---------|---------------------|
| **Manual** | Train models, run ad-hoc forecasts | `forecast`, `cfac forecast2` |
| **Scheduler** | Run/backfill production forecasts | `scheduler run`, `scheduler backfill` |
| **Models** | View/manage trained model instances | `models list`, `models activate` |
| **Gateway** | Push forecasts to distribution server | `gateway push` |
| **Settings** | Configure paths, options, gateway | `config get/set` |

### 2.2 Tab-to-Mode Mapping

| Tab | Mode | Model Usage |
|-----|------|-------------|
| Manual | **Training** | Trains fresh, optionally saves `.vfm` |
| Manual | Inference | Loads saved `.vfm`, no retraining |
| Scheduler | **Inference** | ALWAYS loads saved `.vfm` (no training) |
| Models | Management | View, activate, archive, delete |

---

## 3. Manual Tab

### 3.1 Purpose

The Manual tab is the **training forge** — where users:
- Train models from historical data
- Evaluate accuracy against holdout periods
- Save trained instances for production use

### 3.2 Forecast Types

| Type | Description | CLI Flag |
|------|-------------|----------|
| Regional Demand | 3 regions (CLUZ, CVIS, CMIN) | `--model hybrid` |
| Zonal Demand | 14 zones | `--model hybrid --zonal` |
| CFAC | Wind + Solar capacity factors | `cfac forecast2` |

### 3.3 Training vs Inference Mode

Each forecast type has a mode toggle:

| Mode | What Happens | When to Use |
|------|--------------|-------------|
| **Train** | Trains model, evaluates, saves `.vfm` | Weekly, when new data arrives |
| **Inference** | Loads frozen `.vfm`, applies to new weather | Testing saved models |

### 3.4 CLI Command Construction

**Regional Demand (Training Mode):**
```typescript
// App.vue: runManualForecast() → runDemandForecast()
const demandArgs = [
  'forecast',
  '-d', demandDataDir.value,           // Training data path
  '-s', forecastStart.value,           // e.g., "2026-03-01"
  '-e', forecastEnd.value,             // e.g., "2026-03-07"
  '-o', `${demandOutputDir}/${filename}`,
  '--model', 'hybrid',                 // Model type
  '--save-model',                      // Save trained instance
  '--model-name', modelName            // Optional custom name
];

// Additional flags based on UI state:
if (trainingEnd) demandArgs.push('--training-end', trainingEnd);
if (pushToGateway) demandArgs.push('--push');
if (growthRate !== 0) demandArgs.push('--growth', growthRate);

// Execute via IPC
await window.electronAPI.runCommand(demandArgs);
```

**Zonal Demand (Training Mode):**
```typescript
const demandArgs = [
  'forecast',
  '-d', demandDataDir.value,
  '-s', forecastStart.value,
  '-e', forecastEnd.value,
  '-o', `${demandOutputDir}/${filename}`,
  '--model', 'hybrid',
  '--zonal',                           // 14-zone mode
  '--save-model',
  '--model-name', modelName
];
```

**Regional Demand (Inference Mode):**
```typescript
const demandArgs = [
  'forecast',
  '-d', demandDataDir.value,
  '-s', forecastStart.value,
  '-e', forecastEnd.value,
  '-o', `${demandOutputDir}/${filename}`,
  '--model', 'hybrid',
  '--use-model', selectedInstanceId    // Load frozen model (NO training)
];
```

**CFAC (Training Mode):**
```typescript
const cfacArgs = [
  'cfac', 'forecast2',
  '-t', cfacDataDir.value,             // Training data path
  '-s', forecastStart.value,
  '-e', forecastEnd.value,
  '-o', `${cfacOutputDir}/${filename}`,
  '--save-model',
  '--model-name', modelName
];

// Additional from globalConfig.cfac:
if (useXgboost) cfacArgs.push('--use-xgboost');
if (asymmetricLoss) cfacArgs.push('--asymmetric-loss');
if (biasCorrection) cfacArgs.push('--bias-correction');
```

### 3.5 Output Files

| Type | Output Location | Format |
|------|-----------------|--------|
| Regional Demand | `output/Demand/FC_DEM_*.csv` | Hour-ending, 3 columns |
| Zonal Demand | `output/Demand/FC_ZDEM_*.csv` | Hour-ending, 14 columns |
| CFAC | `output/CFAC/FC_CF_*.csv` | Hour-ending, per-station |

---

## 4. Scheduler Tab

### 4.1 Purpose

The Scheduler tab runs **production forecasts** using saved trained models. It operates in two modes:

| Mode | Description | CLI Command |
|------|-------------|-------------|
| **Single Date** | Generate forecast for one as-of date | `scheduler run -d DATE` |
| **Backfill** | Generate forecasts for date range | `scheduler backfill -s START -e END` |

### 4.2 Key Constraint

**The Scheduler NEVER trains.** It requires `--use-model <id>`.

If no model is selected → the scheduler should refuse to run.

### 4.3 CLI Command Construction

**Single Date Run:**
```typescript
// App.vue: runSchedulerManual()
const args = [
  'scheduler', 'run',
  '-d', manualRunDate.value            // e.g., "2026-03-24"
];

// Type filter
if (type === 'demand') args.push('--demand-only');
else if (type === 'cfac') args.push('--cfac-only');

// Horizon filter
if (horizon === 'daily') args.push('--daily');
else if (horizon === 'weekly') args.push('--weekly');

// Model selection (REQUIRED for inference)
if (useModelId) args.push('--use-model', useModelId);

// Options
if (refreshWeather) args.push('--refresh-weather');
if (pushGateway) args.push('--push-gateway');

// IPC execution
await window.electronAPI.runSchedulerManual(options);
```

**Backfill Run (Date Range):**
```typescript
const args = [
  'scheduler', 'backfill',
  '-s', startDate,                     // e.g., "2026-03-01"
  '-e', endDate                        // e.g., "2026-03-15"
];

if (type === 'demand') args.push('--demand-only');
if (horizon === 'weekly') args.push('--weekly');
if (overwrite) args.push('--overwrite');  // Regenerate existing
if (suffix) args.push('--suffix', suffix);
if (useModelId) args.push('--use-model', useModelId);
```

### 4.4 IPC Handler (main.ts)

```typescript
// gui/electron/main.ts
ipcMain.handle('run-scheduler-manual', async (_event, options) => {
  const cliPath = getCliScriptPath();
  const projectRoot = getAppRoot();

  const isBackfill = options.endDate && options.endDate !== options.date;

  const args = isBackfill
    ? [cliPath, 'scheduler', 'backfill', '-s', options.date, '-e', options.endDate]
    : [cliPath, 'scheduler', 'run', '-d', options.date];

  // Add flags...

  const child = spawn(getNodePath(), args, {
    cwd: projectRoot,
    env: { ...process.env }
  });

  // Stream output to renderer
  child.stdout.on('data', (data) => {
    mainWindow.webContents.send('command-output', {
      type: 'stdout',
      data: data.toString()
    });
  });

  return new Promise((resolve) => {
    child.on('close', (code) => {
      resolve({ success: code === 0 });
    });
  });
});
```

### 4.5 Scheduler Options

| GUI Option | CLI Flag | Description |
|------------|----------|-------------|
| Demand Only | `--demand-only` | Skip CFAC forecasts |
| CFAC Only | `--cfac-only` | Skip demand forecasts |
| Daily Only | `--daily` | Next-day horizon only |
| Weekly Only | `--weekly` | 7-day horizon only |
| Refresh Weather | `--refresh-weather` | Force weather cache refresh |
| Overwrite | `--overwrite` | Regenerate existing (backfill) |
| Push Gateway | `--push-gateway` | Auto-push after generation |
| Use Model | `--use-model <id>` | Saved model instance ID |

---

## 5. Models Tab

### 5.1 Purpose

The Models tab displays all saved training instances and allows:
- Viewing performance metrics (MAPE, per-zone breakdown)
- Comparing models side-by-side
- Activating models for scheduler use
- Archiving/deleting old models

### 5.2 IPC Operations

| Action | IPC Call | Description |
|--------|----------|-------------|
| List | `listModels()` | Get all training instances |
| Details | `getModelById(id)` | Full model metadata |
| Activate | `activateModel(id)` | Mark as active for entity |
| Send to Scheduler | `setSchedulerActiveModel(id)` | Set as scheduler default |
| Delete | `deleteModel(id)` | Remove from registry + disk |

### 5.3 Model Instance Structure

```typescript
interface TrainingInstance {
  id: string;                    // UUID
  name: string;                  // User-provided or auto-generated
  entityType: 'demand' | 'cfac';
  entityCode: string;            // 'regional', 'zonal', or station code
  createdAt: string;
  trainingPeriod: { start: string; end: string };
  metrics: {
    mape: number;
    mae: number;
    perZoneMape?: Record<string, number>;
    perRegionMape?: Record<string, number>;
  };
  isActive: boolean;
  modelPath: string;             // Path to .vfm file
}
```

### 5.4 Pipeline Flow

```
Manual Tab (Train)  ──▶  Models Tab (Review)  ──▶  Scheduler Tab (Run)
   "The Forge"            "The Audit"             "Production"

   - Trains model         - Views metrics         - Loads frozen model
   - Evaluates            - Compares versions     - Fetches NEW weather
   - Saves .vfm           - Activates for use     - Applies model
                                                  - Outputs forecast
```

---

## 6. Settings Tab

### 6.1 Configuration Sections

| Section | Purpose | Persisted To |
|---------|---------|--------------|
| Data Paths | Training data, databases | `forecast_config.json` |
| Demand Options | Model type, geography, scaling | `forecast_config.json` |
| CFAC Options | XGBoost, asymmetric loss, bias | `forecast_config.json` |
| Weather | Cache directory, refresh mode | `forecast_config.json` |
| Output | Archive settings, naming | `forecast_config.json` |
| Gateway | SFTP/HTTP credentials | `forecast_config.json` |

### 6.2 Configuration Flow

```
Settings Tab UI
      │
      ▼
saveGlobalConfig()
      │
      ▼
ipcMain.handle('save-global-config')
      │
      ▼
LocalConfigService.save()
      │
      ▼
forecast_config.json (disk)
```

### 6.3 Configuration Structure

```json
{
  "version": 1,
  "paths": {
    "demandTraining": "Data Samples/Demand",
    "cfacTraining": "Data Samples/Capacity Factor",
    "output": "./output",
    "archive": "./output/archive",
    "weatherCache": "./weather_cache"
  },
  "databases": {
    "scheduler": "./forecast.db",
    "regionalDemand": "./data/iload.db",
    "zonalDemand": "./data/iload_zonal.db"
  },
  "demand": {
    "model": "hybrid",
    "geography": "regional",
    "growthRate": 0
  },
  "cfac": {
    "useXgboost": false,
    "asymmetricLoss": false,
    "biasCorrection": false
  },
  "gateway": {
    "enabled": false,
    "autoPush": false
  }
}
```

---

## 7. Gateway Tab

### 7.1 Purpose

The Gateway tab manages forecast distribution:
- View uploaded files
- Push pending forecasts
- Archive/clear old files

### 7.2 IPC Operations

| Action | IPC Call | Description |
|--------|----------|-------------|
| List Files | `getGatewayFiles()` | Get uploaded forecasts |
| Storage Stats | `getGatewayStorage()` | Size, counts by category |
| Push | `runCommand(['gateway', 'push', ...])` | Upload forecast file |
| Archive | `archiveGatewayFiles()` | Move old files |
| Clear | `clearGatewayFiles()` | Delete old files |

---

## 8. IPC API Reference

### 8.1 Command Execution

```typescript
// Generic CLI command execution
window.electronAPI.runCommand(args: string[]): Promise<{
  stdout: string;
  stderr: string;
  code: number;
  error?: string;
}>

// Scheduler-specific execution (with streaming output)
window.electronAPI.runSchedulerManual(options): Promise<{
  success: boolean;
  output?: string;
  error?: string;
}>
```

### 8.2 Real-Time Output

```typescript
// Listen for CLI output during execution
window.electronAPI.onCommandOutput((data) => {
  if (data.type === 'stdout') {
    // Normal output
  } else if (data.type === 'stderr') {
    // Error output
  }
});

// Clean up listener
window.electronAPI.removeCommandOutputListener();
```

### 8.3 Configuration Management

```typescript
// Load/save global configuration
window.electronAPI.loadGlobalConfig(): Promise<GlobalForecastConfig>
window.electronAPI.saveGlobalConfig(config): Promise<{ success: boolean }>
window.electronAPI.resetGlobalConfig(): Promise<GlobalForecastConfig>
window.electronAPI.validateGlobalConfig(config): Promise<{ valid: boolean; errors: string[] }>
```

### 8.4 Model Management

```typescript
// Training instances
window.electronAPI.listModels(filters?): Promise<TrainingInstance[]>
window.electronAPI.getModelById(id): Promise<TrainingInstance | null>
window.electronAPI.activateModel(id): Promise<void>
window.electronAPI.deleteModel(id): Promise<void>
window.electronAPI.setSchedulerActiveModel(id): Promise<{ success: boolean }>
```

---

## 9. Portable Mode

### 9.1 Detection

The GUI detects portable mode by:
1. Presence of `.portable` marker file
2. Presence of bundled `cli/node/node.exe`

### 9.2 Path Resolution

| Component | Development | Portable |
|-----------|-------------|----------|
| Node.js | System `node` | `cli/node/node.exe` |
| CLI Script | `dist/index.js` | `cli/dist/index.js` |
| Project Root | Parent of `gui/` | Directory containing `.exe` |

```typescript
function getNodePath(): string {
  if (isPortableMode()) {
    return path.join(getAppRoot(), 'cli', 'node', 'node.exe');
  }
  return 'node';
}

function getCliScriptPath(): string {
  const appRoot = getAppRoot();
  if (isPortableMode()) {
    return path.join(appRoot, 'cli', 'dist', 'index.js');
  }
  return path.join(appRoot, 'dist', 'index.js');
}
```

---

## 10. Complete CLI Mapping

### 10.1 Manual Tab

| GUI Action | CLI Command |
|------------|-------------|
| Run Regional Demand (Train) | `forecast -d PATH -s DATE -e DATE -o FILE --model hybrid --save-model` |
| Run Zonal Demand (Train) | `forecast -d PATH -s DATE -e DATE -o FILE --model hybrid --zonal --save-model` |
| Run Demand (Inference) | `forecast -d PATH -s DATE -e DATE -o FILE --use-model ID` |
| Run CFAC (Train) | `cfac forecast2 -t PATH -s DATE -e DATE -o FILE --save-model` |
| Run CFAC (Inference) | `cfac forecast2 -t PATH -s DATE -e DATE -o FILE --use-wind-model ID --use-solar-model ID` |

### 10.2 Scheduler Tab

| GUI Action | CLI Command |
|------------|-------------|
| Run Single Date | `scheduler run -d DATE --use-model ID` |
| Run Backfill | `scheduler backfill -s START -e END --use-model ID` |
| Demand Only | Add `--demand-only` |
| CFAC Only | Add `--cfac-only` |
| Daily Only | Add `--daily` |
| Weekly Only | Add `--weekly` |
| Refresh Weather | Add `--refresh-weather` |
| Push to Gateway | Add `--push-gateway` |
| Overwrite Existing | Add `--overwrite` (backfill only) |

### 10.3 Models Tab

| GUI Action | CLI Equivalent |
|------------|----------------|
| View Models | `models list` |
| View Details | `models info <id>` |
| Activate | `models activate <id>` |
| Archive | `models archive <id>` |
| Delete | `models delete <id>` |

### 10.4 Settings Tab

| GUI Action | CLI Equivalent |
|------------|----------------|
| View Settings | `config get` |
| Update Setting | `config set KEY VALUE` |
| Reset All | `config reset` |
| Validate | `config validate` |

### 10.5 Gateway Tab

| GUI Action | CLI Command |
|------------|-------------|
| Push File | `gateway push FILE` |
| Push All | `gateway push --all` |
| Push Category | `gateway push --category CATEGORY` |

---

## 11. Error Handling

### 11.1 CLI Exit Codes

| Code | Meaning | GUI Behavior |
|------|---------|--------------|
| 0 | Success | Show success message |
| 1 | General error | Show error in terminal |
| 2 | Configuration error | Show specific error |
| 3 | Missing data | Prompt user for path |

### 11.2 Error Display

```typescript
// App.vue error handling
if (result.code !== 0) {
  const errorLines = result.stderr?.split('\n')
    .filter(l => l.trim())
    .slice(-3);  // Last 3 lines
  const errorMsg = errorLines.join(' ').substring(0, 200);
  addStatus(`Forecast failed: ${errorMsg}`, 'error');
}
```

---

## Document History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | 2026-03-24 | Claude Code | Initial document |
