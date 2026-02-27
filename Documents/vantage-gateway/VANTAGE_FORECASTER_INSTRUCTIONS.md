# Vantage-Forecaster: SFTP Push Module Implementation

## Objective

Add an SFTP push module to Vantage-Forecaster that automatically uploads generated forecast CSV files to the Vantage-Gateway server after forecast generation.

---

## Context

### What is Vantage-Forecaster?
Vantage-Forecaster is a Node.js/TypeScript CLI application that generates electricity demand and capacity factor forecasts for the Philippines grid. It outputs CSV files that need to be distributed to client applications.

### Current State
- Forecasts are generated and saved to local `./output/` directory
- No mechanism exists to push files to a remote server
- The application has a scheduler service that can run daily

### Target State
- After generating forecasts, automatically upload to Vantage-Gateway via SFTP
- Support both manual and scheduled uploads
- Upload to appropriate subdirectories based on file type

---

## Server Details (Vantage-Gateway)

| Property | Value |
|----------|-------|
| **Hostname** | vantage-gateway |
| **Tailscale IP** | 100.115.9.94 |
| **SFTP Port** | 22 |
| **Username** | vantage-upload |
| **Auth** | Password (from environment variable) |

### Remote Directory Structure
```
/opt/vantage/csv_storage/
├── demand/
│   ├── regional/    ← FC_DEM_*.csv files
│   └── zonal/       ← FC_ZDEM_*.csv files
└── cfac/            ← FC_CF_*.csv files
```

---

## Implementation Tasks

### Task 1: Install Dependencies

Add the `ssh2-sftp-client` package:

```bash
npm install ssh2-sftp-client
npm install --save-dev @types/ssh2-sftp-client
```

---

### Task 2: Create SFTP Push Service

Create a new service file: `src/services/sftpPushService.ts`

**Requirements:**
1. Connect to Vantage-Gateway via Tailscale IP (100.115.9.94)
2. Use credentials from environment variables
3. Determine remote directory based on filename pattern:
   - `FC_DEM_*.csv` → `/demand/regional/`
   - `FC_ZDEM_*.csv` → `/demand/zonal/`
   - `FC_CF_*.csv` → `/cfac/`
4. Handle connection errors gracefully
5. Log upload progress and results

**Interface:**
```typescript
interface SftpConfig {
  host: string;
  port: number;
  username: string;
  password: string;
}

// Push a single file to the gateway
async function pushFileToGateway(localPath: string): Promise<PushResult>;

// Push all CSV files from a directory
async function pushAllForecasts(outputDir: string): Promise<PushResult[]>;

// Check connection to gateway
async function testConnection(): Promise<boolean>;
```

**Environment Variables:**
```
VANTAGE_GATEWAY_HOST=100.115.9.94
VANTAGE_GATEWAY_USER=vantage-upload
VANTAGE_GATEWAY_PASSWORD=<password>
VANTAGE_GATEWAY_ENABLED=true
```

---

### Task 3: Integrate with Forecast Commands

Modify the forecast commands to optionally push files after generation.

**Files to modify:**
- `src/index.ts` (CLI commands)

**Add new CLI flag:**
```
--push    Push generated files to gateway after completion
```

**Integration points:**

1. **Demand Forecast Command** (around line 150-250 in index.ts)
   - After writing forecast CSV, if `--push` flag is set, call `pushFileToGateway()`

2. **CFAC Forecast Command** (around line 2300-2500 in index.ts)
   - After writing forecast CSV, if `--push` flag is set, call `pushFileToGateway()`

**Example usage after implementation:**
```bash
# Generate and push demand forecast
node dist/index.js forecast -d "Data Samples/Demand" -s 2026-02-27 -e 2026-02-28 -o output/FC_DEM_2026-02-27.csv --model hybrid --push

# Generate and push zonal forecast
node dist/index.js forecast -d "Data Samples/Demand" -s 2026-02-27 -e 2026-02-28 -o output/FC_ZDEM_2026-02-27.csv --model hybrid --zonal --push

# Generate and push capacity factor forecast
node dist/index.js cfac forecast2 -t "Data Samples/Capacity Factor" -s 2026-02-27 -e 2026-02-28 -o output/FC_CF_2026-02-27.csv --push
```

---

### Task 4: Integrate with Scheduler Service

Modify the scheduler service to automatically push after generating forecasts.

**File:** `src/services/forecastSchedulerService.ts`

**Requirements:**
1. After generating daily/weekly forecasts, push to gateway
2. Only push if `VANTAGE_GATEWAY_ENABLED=true`
3. Log push results to scheduler logs
4. Continue even if push fails (non-blocking)

---

### Task 5: Add Push Status Command

Add a new CLI command to test gateway connectivity:

```bash
node dist/index.js gateway test
```

**Output:**
```
Testing connection to Vantage Gateway...
Host: 100.115.9.94:22
User: vantage-upload
Status: Connected successfully
Remote directories:
  /demand/regional/ - accessible
  /demand/zonal/ - accessible
  /cfac/ - accessible
```

---

### Task 6: Update GUI (Optional)

If time permits, add a "Push to Gateway" button to the GUI.

**File:** `gui/src/App.vue`

**Requirements:**
1. Add checkbox "Push to Gateway after forecast"
2. Show push status in progress UI
3. Display success/failure message

---

## File Naming Conventions

The service must correctly categorize files based on their names:

| Pattern | Remote Directory | Description |
|---------|------------------|-------------|
| `FC_DEM_*.csv` | `/demand/regional/` | Regional demand (3 regions) |
| `FC_ZDEM_*.csv` | `/demand/zonal/` | Zonal demand (14 zones) |
| `FC_CF_*.csv` | `/cfac/` | Capacity factors |
| Other `*.csv` | `/other/` | Fallback for unknown types |

---

## Error Handling

The service should handle these scenarios:

1. **Connection refused** - Gateway not reachable
   - Log error, continue without pushing
   - Suggest checking Tailscale connection

2. **Authentication failed** - Wrong credentials
   - Log error with clear message
   - Do not retry automatically

3. **Directory not found** - Remote path doesn't exist
   - Log warning
   - Attempt to create directory (if permissions allow)

4. **Upload timeout** - Large file or slow connection
   - Set timeout to 60 seconds per file
   - Log progress for large files

5. **Partial failure** - Some files uploaded, some failed
   - Report each file's status
   - Return summary with success/failure counts

---

## Testing Checklist

Before considering this complete:

- [ ] SFTP connection works via Tailscale IP
- [ ] Files upload to correct remote directories
- [ ] `--push` flag works on demand forecast command
- [ ] `--push` flag works on cfac forecast command
- [ ] Scheduler pushes files when enabled
- [ ] `gateway test` command works
- [ ] Errors are logged clearly
- [ ] Environment variables are documented

---

## Code Template

Here's a starting template for the SFTP service:

```typescript
// src/services/sftpPushService.ts
import SftpClient from 'ssh2-sftp-client';
import * as fs from 'fs';
import * as path from 'path';

export interface PushResult {
  success: boolean;
  localPath: string;
  remotePath: string;
  error?: string;
  bytesTransferred?: number;
}

interface SftpConfig {
  host: string;
  port: number;
  username: string;
  password: string;
}

function getConfig(): SftpConfig {
  return {
    host: process.env.VANTAGE_GATEWAY_HOST || '100.115.9.94',
    port: parseInt(process.env.VANTAGE_GATEWAY_PORT || '22'),
    username: process.env.VANTAGE_GATEWAY_USER || 'vantage-upload',
    password: process.env.VANTAGE_GATEWAY_PASSWORD || ''
  };
}

function getRemoteDirectory(filename: string): string {
  if (filename.startsWith('FC_ZDEM_')) return '/demand/zonal';
  if (filename.startsWith('FC_DEM_')) return '/demand/regional';
  if (filename.startsWith('FC_CF_')) return '/cfac';
  return '/other';
}

export async function pushFileToGateway(localPath: string): Promise<PushResult> {
  const config = getConfig();
  const sftp = new SftpClient();
  const filename = path.basename(localPath);
  const remoteDir = getRemoteDirectory(filename);
  const remotePath = `${remoteDir}/${filename}`;

  try {
    console.log(`[SFTP] Connecting to ${config.host}...`);
    await sftp.connect(config);

    console.log(`[SFTP] Uploading ${filename} to ${remotePath}...`);
    const stats = fs.statSync(localPath);
    await sftp.put(localPath, remotePath);

    console.log(`[SFTP] Upload complete: ${filename} (${stats.size} bytes)`);
    return {
      success: true,
      localPath,
      remotePath,
      bytesTransferred: stats.size
    };
  } catch (error: any) {
    console.error(`[SFTP] Upload failed: ${error.message}`);
    return {
      success: false,
      localPath,
      remotePath,
      error: error.message
    };
  } finally {
    await sftp.end();
  }
}

export async function pushAllForecasts(outputDir: string): Promise<PushResult[]> {
  // Implementation here
}

export async function testConnection(): Promise<boolean> {
  // Implementation here
}

export function isGatewayEnabled(): boolean {
  return process.env.VANTAGE_GATEWAY_ENABLED === 'true';
}
```

---

## Notes

- The gateway server setup is being done separately - assume it will be ready
- Use Tailscale IP (100.115.9.94), not local IP, for connectivity across networks
- Password will be provided via environment variable - never hardcode
- This is Phase 4 of the overall Distribution Planner project
