# Vantage-Gateway Server Setup - Completed Configuration

**Date:** 2026-02-27
**Status:** SFTP Ready, API Pending

This document provides all details needed to push files to the Vantage-Gateway server.

---

## Server Connection Details

| Property | Value |
|----------|-------|
| **Hostname** | vantage-gateway |
| **Tailscale IP** | 100.115.9.94 |
| **SFTP Port** | 22 |
| **SFTP Username** | vantage-upload |
| **SFTP Password** | *(ask user - was set during setup)* |
| **Protocol** | SFTP (SSH File Transfer Protocol) |

---

## Directory Structure

```
/opt/vantage/csv_storage/           # SFTP root (chroot - user sees this as /)
│
├── day-ahead/                      # Daily forecasts (next day)
│   ├── demand/                     # Day-Ahead Demand forecasts
│   └── mhcf/                       # Day-Ahead Must-Dispatch Hourly Capacity Factors
│
├── week-ahead/                     # Weekly forecasts (7 days out)
│   ├── demand/                     # Week-Ahead Demand forecasts
│   └── mhcf/                       # Week-Ahead MHCF
│
├── historical/                     # Historical data (post-prototype)
│   ├── scenarios/
│   │   ├── weekly/                 # Historical Analysis Scenarios (weekly)
│   │   └── monthly/                # Historical Analysis Scenarios (monthly)
│   └── databases/                  # Historical Databases (monthly MDB files)
│
├── archive/                        # Old files (auto-archived after 30 days)
└── other/                          # Uncategorized files
```

---

## File Categories & Upload Paths

### Prototype Phase (Active Now)

| Category | Description | Remote Path | File Pattern |
|----------|-------------|-------------|--------------|
| **Day-Ahead Demand** | Next-day demand forecast | `/day-ahead/demand/` | `DA_DEM_YYYY-MM-DD.csv` |
| **Day-Ahead MHCF** | Next-day capacity factors | `/day-ahead/mhcf/` | `DA_MHCF_YYYY-MM-DD.csv` |
| **Week-Ahead Demand** | 7-day demand forecast | `/week-ahead/demand/` | `WA_DEM_YYYY-MM-DD.csv` |
| **Week-Ahead MHCF** | 7-day capacity factors | `/week-ahead/mhcf/` | `WA_MHCF_YYYY-MM-DD.csv` |

### Post-Prototype (Future)

| Category | Description | Remote Path | Frequency |
|----------|-------------|-------------|-----------|
| **Historical Scenarios (Weekly)** | Weekly analysis | `/historical/scenarios/weekly/` | Weekly |
| **Historical Scenarios (Monthly)** | Monthly analysis | `/historical/scenarios/monthly/` | Monthly |
| **Historical Databases** | MDB database files | `/historical/databases/` | Monthly |

---

## Path Determination Logic

```javascript
/**
 * Determine the remote upload path based on filename or category
 * @param {string} filename - The file being uploaded
 * @param {string} category - Optional explicit category
 * @returns {string} Remote path for SFTP upload
 */
function getRemotePath(filename, category = null) {
  // If explicit category provided
  if (category) {
    const pathMap = {
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

  // Day-Ahead
  if (fn.startsWith('DA_DEM') || fn.includes('DAY_AHEAD_DEM')) {
    return '/day-ahead/demand';
  }
  if (fn.startsWith('DA_MHCF') || fn.startsWith('DA_CF') || fn.includes('DAY_AHEAD_MHCF')) {
    return '/day-ahead/mhcf';
  }

  // Week-Ahead
  if (fn.startsWith('WA_DEM') || fn.includes('WEEK_AHEAD_DEM')) {
    return '/week-ahead/demand';
  }
  if (fn.startsWith('WA_MHCF') || fn.startsWith('WA_CF') || fn.includes('WEEK_AHEAD_MHCF')) {
    return '/week-ahead/mhcf';
  }

  // Historical (future)
  if (fn.includes('HIST') && fn.includes('WEEKLY')) {
    return '/historical/scenarios/weekly';
  }
  if (fn.includes('HIST') && fn.includes('MONTHLY')) {
    return '/historical/scenarios/monthly';
  }
  if (fn.endsWith('.MDB') || fn.endsWith('.ACCDB')) {
    return '/historical/databases';
  }

  // Default
  return '/other';
}
```

---

## SFTP Connection Details

### Connection Parameters
```
Host: 100.115.9.94
Port: 22
Username: vantage-upload
Password: <provided by user>
Protocol: SFTP
```

### Important Notes

1. **Chroot Active:** The user is chrooted to `/opt/vantage/csv_storage`
   - From SFTP client perspective, `/` = `/opt/vantage/csv_storage` on disk
   - Use paths like `/day-ahead/demand/` not full system paths

2. **Tailscale Network Required**
   - IP `100.115.9.94` is a Tailscale address
   - Pushing machine must be on the same Tailscale network
   - Connection encrypted via WireGuard

3. **File Permissions**
   - User can write to all subdirectories
   - Cannot access anything outside the chroot

---

## Environment Variables

Set these in Vantage-Forecaster:

```env
VANTAGE_GATEWAY_HOST=100.115.9.94
VANTAGE_GATEWAY_PORT=22
VANTAGE_GATEWAY_USER=vantage-upload
VANTAGE_GATEWAY_PASSWORD=<password set during setup>
VANTAGE_GATEWAY_ENABLED=true
```

---

## Implementation Example (Node.js)

### Install Dependency
```bash
npm install ssh2-sftp-client
```

### Upload Service
```javascript
const SftpClient = require('ssh2-sftp-client');
const path = require('path');

const config = {
  host: process.env.VANTAGE_GATEWAY_HOST || '100.115.9.94',
  port: parseInt(process.env.VANTAGE_GATEWAY_PORT || '22'),
  username: process.env.VANTAGE_GATEWAY_USER || 'vantage-upload',
  password: process.env.VANTAGE_GATEWAY_PASSWORD
};

/**
 * Upload a forecast file to the gateway
 * @param {string} localPath - Full path to local file
 * @param {string} category - One of: 'day-ahead-demand', 'day-ahead-mhcf',
 *                            'week-ahead-demand', 'week-ahead-mhcf'
 */
async function uploadForecast(localPath, category) {
  const sftp = new SftpClient();
  const filename = path.basename(localPath);
  const remotePath = getRemotePath(filename, category);
  const remoteFile = `${remotePath}/${filename}`;

  try {
    console.log(`[SFTP] Connecting to ${config.host}...`);
    await sftp.connect(config);

    console.log(`[SFTP] Uploading ${filename} to ${remoteFile}...`);
    await sftp.put(localPath, remoteFile);

    console.log(`[SFTP] Upload complete: ${filename}`);
    return { success: true, remotePath: remoteFile };
  } catch (error) {
    console.error(`[SFTP] Upload failed: ${error.message}`);
    return { success: false, error: error.message };
  } finally {
    await sftp.end();
  }
}

// Usage examples:
// uploadForecast('./output/DA_DEM_2026-02-27.csv', 'day-ahead-demand');
// uploadForecast('./output/WA_MHCF_2026-02-27.csv', 'week-ahead-mhcf');
```

---

## Suggested File Naming Convention

| Type | Pattern | Example |
|------|---------|---------|
| Day-Ahead Demand | `DA_DEM_YYYY-MM-DD.csv` | `DA_DEM_2026-02-27.csv` |
| Day-Ahead MHCF | `DA_MHCF_YYYY-MM-DD.csv` | `DA_MHCF_2026-02-27.csv` |
| Week-Ahead Demand | `WA_DEM_YYYY-MM-DD.csv` | `WA_DEM_2026-02-27.csv` |
| Week-Ahead MHCF | `WA_MHCF_YYYY-MM-DD.csv` | `WA_MHCF_2026-02-27.csv` |
| Historical Weekly | `HIST_WEEKLY_YYYY-WNN.csv` | `HIST_WEEKLY_2026-W08.csv` |
| Historical Monthly | `HIST_MONTHLY_YYYY-MM.csv` | `HIST_MONTHLY_2026-02.csv` |
| Historical Database | `HIST_DB_YYYY-MM.mdb` | `HIST_DB_2026-02.mdb` |

---

## Testing SFTP Connection

### Manual Test (PowerShell)
```bash
sftp vantage-upload@100.115.9.94

# Once connected:
ls                          # Should show: archive, day-ahead, historical, other, week-ahead
cd day-ahead/demand
put "C:\path\to\test.csv"
ls                          # Verify file uploaded
exit
```

### Verify on Server (SSH as root)
```bash
ls -la /opt/vantage/csv_storage/day-ahead/demand/
ls -la /opt/vantage/csv_storage/day-ahead/mhcf/
ls -la /opt/vantage/csv_storage/week-ahead/demand/
ls -la /opt/vantage/csv_storage/week-ahead/mhcf/
```

---

## What's Completed

- [x] Node.js v20.20.0 installed
- [x] Directory structure created
- [x] SFTP user (`vantage-upload`) configured
- [x] SSH chroot jail configured
- [x] SFTP tested and working
- [x] Permissions set correctly

## What's Pending

- [ ] Gatekeeper API (Node.js Express server)
- [ ] Tailscale Funnel (public HTTPS access)
- [ ] Systemd service for API
- [ ] Maintenance scripts (archive, backup)
- [ ] Client credential management

---

## Quick Reference

| Action | Command/Path |
|--------|--------------|
| SFTP Connect | `sftp vantage-upload@100.115.9.94` |
| Day-Ahead Demand | `/day-ahead/demand/` |
| Day-Ahead MHCF | `/day-ahead/mhcf/` |
| Week-Ahead Demand | `/week-ahead/demand/` |
| Week-Ahead MHCF | `/week-ahead/mhcf/` |
| Archive | `/archive/` |
