# Vantage Gatekeeper - License Integration Guide

**Version:** 2.2.0
**Date:** 2026-03-03
**For:** Licensing Team & Apollo Development Team

---

## Overview

This document describes how Apollo clients authenticate with the Vantage Gatekeeper using **License ID validation**.

### Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                            APOLLO CLIENT                                 │
│                                                                         │
│  1. Read license file (*.lic)                                           │
│     └─► Extract: LicenseId (GUID), ClientName, Modules                  │
│                                                                         │
│  2. Check locally: Does "Vantage" module exist and not expired?         │
│     └─► If no → Hide Vantage features                                   │
│     └─► If yes → Continue to step 3                                     │
│                                                                         │
│  3. POST /auth/license with LicenseId                                   │
│     └─► Gateway validates license is registered & enabled               │
│     └─► Returns JWT token                                               │
│                                                                         │
│  4. Use JWT token for all forecast API calls                            │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                        VANTAGE GATEKEEPER                                │
│                                                                         │
│  Endpoint: https://vantage-gateway.taile437a5.ts.net                    │
│                                                                         │
│  License validation:                                                    │
│  - Checks LicenseId against registered list in config.json              │
│  - Verifies license is enabled                                          │
│  - Verifies license not expired                                         │
│  - Issues JWT token (24h validity)                                      │
│  - Logs all access with LicenseId for audit                             │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## For Licensing Team

### License Registration Options

There are two ways to register licenses on the Gateway:

| Method | Best For |
|--------|----------|
| **Admin API** (Recommended) | Automated integration with license generator |
| **Manual SSH** | Quick one-off registrations or debugging |

---

## Admin API (Recommended)

The Gateway provides a REST API for license management, allowing your license generator to automatically register licenses when a Vantage module is issued.

### Authentication

All admin endpoints require the admin API key in the Authorization header:

```
Authorization: Bearer gatekeeper-admin-2026-x7k9m2p4
```

### Base URL

```
https://vantage-gateway.taile437a5.ts.net
```

---

### Register a New License

```http
POST /admin/licenses
Authorization: Bearer gatekeeper-admin-2026-x7k9m2p4
Content-Type: application/json

{
  "licenseId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "clientName": "ACME Corporation",
  "computerName": "ACME-WORKSTATION",
  "enabled": true,
  "tier": "standard",
  "expiresAt": "2027-06-15",
  "notes": "Issued by John on 2026-03-03"
}
```

**Request Fields:**

| Field | Required | Type | Description |
|-------|----------|------|-------------|
| `licenseId` | Yes | string | GUID from license file |
| `clientName` | Yes | string | Company or client name |
| `computerName` | No | string | Computer name from license |
| `enabled` | No | boolean | Default: `true` |
| `tier` | No | string | `"standard"`, `"premium"`, or `"enterprise"` |
| `expiresAt` | No | string | `YYYY-MM-DD` format |
| `notes` | No | string | Internal notes |

**Success Response (201):**
```json
{
  "message": "License registered successfully",
  "licenseId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "license": {
    "clientName": "ACME Corporation",
    "computerName": "ACME-WORKSTATION",
    "enabled": true,
    "tier": "standard",
    "expiresAt": "2027-06-15",
    "notes": "Issued by John on 2026-03-03",
    "createdAt": "2026-03-03T01:52:23.436Z"
  }
}
```

**Error Responses:**

| Status | Error |
|--------|-------|
| 400 | `licenseId is required` |
| 400 | `clientName is required` |
| 400 | `Invalid licenseId format` (must be GUID) |
| 400 | `Invalid tier` |
| 409 | `License already exists` |

**cURL Example:**
```bash
curl -X POST https://vantage-gateway.taile437a5.ts.net/admin/licenses \
  -H "Authorization: Bearer gatekeeper-admin-2026-x7k9m2p4" \
  -H "Content-Type: application/json" \
  -d '{
    "licenseId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "clientName": "ACME Corporation",
    "computerName": "ACME-WORKSTATION",
    "tier": "standard",
    "expiresAt": "2027-06-15"
  }'
```

---

### Update a License

```http
PUT /admin/licenses/{licenseId}
Authorization: Bearer gatekeeper-admin-2026-x7k9m2p4
Content-Type: application/json

{
  "enabled": false,
  "notes": "Revoked on 2026-03-03 - non-payment"
}
```

Only include fields you want to update.

**Success Response (200):**
```json
{
  "message": "License updated successfully",
  "licenseId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "license": {
    "clientName": "ACME Corporation",
    "enabled": false,
    "notes": "Revoked on 2026-03-03 - non-payment",
    "updatedAt": "2026-03-03T02:15:00.000Z"
  }
}
```

**Disable (Revoke) a License:**
```bash
curl -X PUT "https://vantage-gateway.taile437a5.ts.net/admin/licenses/a1b2c3d4-e5f6-7890-abcd-ef1234567890" \
  -H "Authorization: Bearer gatekeeper-admin-2026-x7k9m2p4" \
  -H "Content-Type: application/json" \
  -d '{"enabled": false}'
```

**Re-enable a License:**
```bash
curl -X PUT "https://vantage-gateway.taile437a5.ts.net/admin/licenses/a1b2c3d4-e5f6-7890-abcd-ef1234567890" \
  -H "Authorization: Bearer gatekeeper-admin-2026-x7k9m2p4" \
  -H "Content-Type: application/json" \
  -d '{"enabled": true}'
```

---

### Delete a License

```http
DELETE /admin/licenses/{licenseId}
Authorization: Bearer gatekeeper-admin-2026-x7k9m2p4
```

**Success Response (200):**
```json
{
  "message": "License deleted successfully",
  "licenseId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "deletedLicense": { ... }
}
```

**cURL Example:**
```bash
curl -X DELETE "https://vantage-gateway.taile437a5.ts.net/admin/licenses/a1b2c3d4-e5f6-7890-abcd-ef1234567890" \
  -H "Authorization: Bearer gatekeeper-admin-2026-x7k9m2p4"
```

---

### List All Licenses

```http
GET /admin/licenses
Authorization: Bearer gatekeeper-admin-2026-x7k9m2p4
```

**Response (200):**
```json
{
  "count": 3,
  "licenses": [
    {
      "licenseId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      "clientName": "ACME Corporation",
      "computerName": "ACME-WORKSTATION",
      "enabled": true,
      "tier": "standard",
      "expiresAt": "2027-06-15",
      "notes": null,
      "createdAt": "2026-03-03T01:52:23.436Z"
    }
  ]
}
```

---

### Get Single License

```http
GET /admin/licenses/{licenseId}
Authorization: Bearer gatekeeper-admin-2026-x7k9m2p4
```

---

### Bulk Register Licenses

```http
POST /admin/licenses/bulk
Authorization: Bearer gatekeeper-admin-2026-x7k9m2p4
Content-Type: application/json

{
  "licenses": [
    {
      "licenseId": "aaaa-...",
      "clientName": "Client A",
      "expiresAt": "2027-01-01"
    },
    {
      "licenseId": "bbbb-...",
      "clientName": "Client B",
      "expiresAt": "2027-01-01"
    }
  ]
}
```

**Response (201 or 207 if partial success):**
```json
{
  "message": "Registered 2 licenses",
  "results": {
    "success": [
      { "licenseId": "aaaa-...", "clientName": "Client A" }
    ],
    "failed": [
      { "licenseId": "bbbb-...", "error": "License already exists" }
    ]
  }
}
```

---

### Get System Stats

```http
GET /admin/stats
Authorization: Bearer gatekeeper-admin-2026-x7k9m2p4
```

**Response:**
```json
{
  "version": "2.2.0",
  "uptime": 3600.5,
  "licenses": {
    "total": 5,
    "enabled": 4,
    "disabled": 1,
    "expired": 0
  },
  "storage": {
    "basePath": "/opt/vantage/csv_storage",
    "types": ["day-ahead", "week-ahead"],
    "categories": ["demand", "mhcf"]
  }
}
```

---

### Reload Config (if manually edited)

```http
POST /admin/reload
Authorization: Bearer gatekeeper-admin-2026-x7k9m2p4
```

---

## Storage Management API (v2.2.0)

These endpoints allow Vantage-Forecaster to manage storage on the Gateway - archiving old files or clearing space when needed.

### Get Storage Statistics

```http
GET /admin/storage
Authorization: Bearer gatekeeper-admin-2026-x7k9m2p4
```

**Response (200):**
```json
{
  "categories": {
    "day-ahead/demand": {
      "files": 60,
      "size": 150987,
      "sizeFormatted": "147.45 KB",
      "oldest": "2026-01-02",
      "newest": "2026-03-02"
    },
    "day-ahead/mhcf": {
      "files": 60,
      "size": 1190124,
      "sizeFormatted": "1.13 MB",
      "oldest": "2026-01-02",
      "newest": "2026-03-02"
    },
    "week-ahead/demand": { ... },
    "week-ahead/mhcf": { ... }
  },
  "totalFiles": 240,
  "totalSize": 10244573,
  "totalSizeFormatted": "9.77 MB",
  "oldestFile": "2026-01-02",
  "newestFile": "2026-03-02"
}
```

**cURL Example:**
```bash
curl -s https://vantage-gateway.taile437a5.ts.net/admin/storage \
  -H "Authorization: Bearer gatekeeper-admin-2026-x7k9m2p4"
```

---

### Archive Old Files

Move files older than N days to an archive folder.

```http
POST /admin/archive
Authorization: Bearer gatekeeper-admin-2026-x7k9m2p4
Content-Type: application/json

{
  "olderThanDays": 30,
  "types": ["day-ahead", "week-ahead"],
  "categories": ["demand", "mhcf"],
  "deleteAfterArchive": true
}
```

**Request Fields:**

| Field | Required | Type | Description |
|-------|----------|------|-------------|
| `olderThanDays` | Yes | number | Archive files older than this (minimum 1) |
| `types` | No | string[] | Filter by type (`day-ahead`, `week-ahead`). Default: all |
| `categories` | No | string[] | Filter by category (`demand`, `mhcf`). Default: all |
| `deleteAfterArchive` | No | boolean | `true` = move files, `false` = copy files (default) |

**Response (200):**
```json
{
  "message": "Archived 45 files older than 30 days",
  "cutoffDate": "2026-02-01",
  "results": {
    "archived": [
      { "file": "day-ahead/demand/DA_DEM_2026-01-15.csv", "date": "2026-01-15", "action": "moved" }
    ],
    "errors": []
  }
}
```

**cURL Example:**
```bash
curl -X POST https://vantage-gateway.taile437a5.ts.net/admin/archive \
  -H "Authorization: Bearer gatekeeper-admin-2026-x7k9m2p4" \
  -H "Content-Type: application/json" \
  -d '{"olderThanDays": 30, "deleteAfterArchive": true}'
```

---

### Clear (Delete) Files

Permanently delete files from storage. **Requires explicit confirmation.**

```http
POST /admin/clear
Authorization: Bearer gatekeeper-admin-2026-x7k9m2p4
Content-Type: application/json

{
  "olderThanDays": 90,
  "types": ["day-ahead"],
  "categories": ["demand"],
  "confirm": "DELETE"
}
```

**Request Fields:**

| Field | Required | Type | Description |
|-------|----------|------|-------------|
| `olderThanDays` | No | number | Only delete files older than this. Omit to delete all matching files |
| `types` | No | string[] | Filter by type. Default: all |
| `categories` | No | string[] | Filter by category. Default: all |
| `confirm` | Yes | string | Must be exactly `"DELETE"` to proceed |

**Response (200):**
```json
{
  "message": "Deleted 15 files",
  "cutoffDate": "2025-12-03",
  "results": {
    "deleted": [
      { "file": "day-ahead/demand/DA_DEM_2025-11-20.csv", "date": "2025-11-20" }
    ],
    "errors": []
  }
}
```

**Error Response (400) - Missing Confirmation:**
```json
{
  "error": "Confirmation required",
  "message": "Set confirm: \"DELETE\" to proceed with file deletion"
}
```

**cURL Example:**
```bash
curl -X POST https://vantage-gateway.taile437a5.ts.net/admin/clear \
  -H "Authorization: Bearer gatekeeper-admin-2026-x7k9m2p4" \
  -H "Content-Type: application/json" \
  -d '{"olderThanDays": 90, "confirm": "DELETE"}'
```

---

### Storage Management from Vantage-Forecaster

Example integration for automatic cleanup:

```typescript
// After successful forecast push, check storage and archive if needed
async function manageGatewayStorage() {
  const adminKey = process.env.VANTAGE_ADMIN_KEY;
  const baseUrl = 'https://vantage-gateway.taile437a5.ts.net';

  // Get current stats
  const statsRes = await fetch(`${baseUrl}/admin/storage`, {
    headers: { 'Authorization': `Bearer ${adminKey}` }
  });
  const stats = await statsRes.json();

  console.log(`Gateway storage: ${stats.totalSizeFormatted}, ${stats.totalFiles} files`);

  // Archive files older than 60 days if total > 50MB
  if (stats.totalSize > 50 * 1024 * 1024) {
    const archiveRes = await fetch(`${baseUrl}/admin/archive`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${adminKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        olderThanDays: 60,
        deleteAfterArchive: true
      })
    });
    const result = await archiveRes.json();
    console.log(`Archived ${result.results.archived.length} files`);
  }
}
```

---

## C# Integration Example

```csharp
using System.Net.Http;
using System.Text;
using System.Text.Json;

public class GatewayAdminClient
{
    private readonly HttpClient _client;
    private const string BaseUrl = "https://vantage-gateway.taile437a5.ts.net";
    private const string AdminKey = "gatekeeper-admin-2026-x7k9m2p4";

    public GatewayAdminClient()
    {
        _client = new HttpClient();
        _client.DefaultRequestHeaders.Add("Authorization", $"Bearer {AdminKey}");
    }

    public async Task<bool> RegisterLicenseAsync(
        string licenseId,
        string clientName,
        string computerName = null,
        string tier = "standard",
        string expiresAt = null)
    {
        var payload = new
        {
            licenseId,
            clientName,
            computerName,
            enabled = true,
            tier,
            expiresAt
        };

        var json = JsonSerializer.Serialize(payload);
        var content = new StringContent(json, Encoding.UTF8, "application/json");

        var response = await _client.PostAsync($"{BaseUrl}/admin/licenses", content);
        return response.IsSuccessStatusCode;
    }

    public async Task<bool> RevokeLicenseAsync(string licenseId)
    {
        var payload = new { enabled = false };
        var json = JsonSerializer.Serialize(payload);
        var content = new StringContent(json, Encoding.UTF8, "application/json");

        var response = await _client.PutAsync($"{BaseUrl}/admin/licenses/{licenseId}", content);
        return response.IsSuccessStatusCode;
    }
}

// Usage in license generator:
var gateway = new GatewayAdminClient();

// When issuing a license with Vantage module:
await gateway.RegisterLicenseAsync(
    licenseId: license.LicenseId.ToString(),
    clientName: license.ClientName,
    computerName: license.ComputerName,
    tier: "standard",
    expiresAt: vantageModule.ExpiryDate?.ToString("yyyy-MM-dd")
);
```

---

## Manual SSH Method (Alternative)

For quick one-off registrations or debugging:

### Gateway Server Access

| Property | Value |
|----------|-------|
| **SSH** | `ssh root@100.115.9.94` |
| **Password** | `ienergyaustralia` |
| **Config File** | `/opt/vantage/gatekeeper/config.json` |

### Step-by-Step: Register a New License

**Step 1:** SSH into the Gateway
```bash
ssh root@100.115.9.94
```

**Step 2:** Edit the config file
```bash
nano /opt/vantage/gatekeeper/config.json
```

**Step 3:** Add the license entry to the `"licenses"` section:
```json
{
  "licenses": {
    "existing-license-guid": { ... },

    "a1b2c3d4-e5f6-7890-abcd-ef1234567890": {
      "clientName": "ACME Corporation",
      "computerName": "ACME-WORKSTATION",
      "enabled": true,
      "tier": "standard",
      "expiresAt": "2027-06-15"
    }
  }
}
```

**Step 4:** Reload config (no restart needed)
```bash
curl -X POST http://127.0.0.1:8080/admin/reload \
  -H "Authorization: Bearer gatekeeper-admin-2026-x7k9m2p4"
```

### License Entry Fields

| Field | Required | Description |
|-------|----------|-------------|
| `clientName` | Yes | Company or client name (for logging) |
| `computerName` | No | Computer name from license (for reference) |
| `enabled` | Yes | `true` to allow access, `false` to revoke |
| `tier` | No | Access tier: `"standard"`, `"premium"`, `"enterprise"` (default: standard) |
| `expiresAt` | Yes | Expiry date in `YYYY-MM-DD` format |
| `notes` | No | Internal notes (not used by system) |

### Checking Registered Licenses

```bash
# Via API
curl -s http://127.0.0.1:8080/admin/licenses \
  -H "Authorization: Bearer gatekeeper-admin-2026-x7k9m2p4"

# Check recent authentication logs
tail -50 /opt/vantage/logs/gatekeeper.log | grep "Auth:License"
```

---

## For Apollo Development Team

### Authentication Flow

```typescript
// 1. Read license file and extract LicenseId
const licenseInfo = await validateLicense(); // Your existing license validation
const licenseId = licenseInfo.licenseId; // GUID string

// 2. Check if Vantage module is active
if (!licenseInfo.hasModule('Vantage')) {
  // Hide Vantage features in UI
  return;
}

// 3. Authenticate with Gateway
const authResponse = await fetch('https://vantage-gateway.taile437a5.ts.net/auth/license', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ licenseId })
});

if (!authResponse.ok) {
  const error = await authResponse.json();
  // Handle: "License not registered", "License has been revoked", "License has expired"
  throw new Error(error.error);
}

const { token, clientName, tier, expiresIn, licenseExpiresAt } = await authResponse.json();

// 4. Use token for API calls
const forecastResponse = await fetch('https://vantage-gateway.taile437a5.ts.net/forecasts/query', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`
  },
  body: JSON.stringify({
    types: ['day-ahead'],
    categories: ['demand']
  })
});
```

### API Endpoints

#### Authenticate with License ID

```http
POST /auth/license
Content-Type: application/json

{
  "licenseId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
}
```

**Success Response (200):**
```json
{
  "token": "eyJhbGciOiJIUzI1NiIs...",
  "clientName": "ACME Corporation",
  "tier": "standard",
  "expiresIn": "24h",
  "licenseExpiresAt": "2027-06-15"
}
```

**Error Responses:**

| Status | Error | Meaning |
|--------|-------|---------|
| 400 | `License ID is required` | Missing licenseId in request |
| 401 | `License not registered` | LicenseId not in Gateway config |
| 401 | `License has been revoked` | License exists but `enabled: false` |
| 401 | `License has expired` | Current date past `expiresAt` |

#### Query Forecasts

```http
POST /forecasts/query
Authorization: Bearer <token>
Content-Type: application/json

{
  "types": ["day-ahead", "week-ahead"],
  "categories": ["demand", "mhcf"],
  "dateFrom": "2026-02-28",
  "dateTo": "2026-03-03"
}
```

#### Get Latest Forecasts

```http
GET /forecasts/latest
Authorization: Bearer <token>
```

#### Download Single File

```http
GET /forecasts/file/{type}/{category}/{filename}
Authorization: Bearer <token>
```

Example:
```
GET /forecasts/file/day-ahead/demand/DA_DEM_2026-03-03.csv
```

#### Bulk Download (ZIP)

```http
POST /forecasts/bulk
Authorization: Bearer <token>
Content-Type: application/json

{
  "types": ["day-ahead"],
  "categories": ["demand"],
  "dateFrom": "2026-02-25",
  "dateTo": "2026-03-03"
}
```

### Complete TypeScript Client Example

```typescript
interface LicenseInfo {
  licenseId: string;
  clientName: string;
  hasModule: (name: string) => boolean;
}

interface GatewayAuthResponse {
  token: string;
  clientName: string;
  tier: string;
  expiresIn: string;
  licenseExpiresAt: string | null;
}

interface ForecastFile {
  type: string;
  category: string;
  filename: string;
  date: string;
  size: number;
  modified: string;
}

class VantageGatewayClient {
  private baseUrl = 'https://vantage-gateway.taile437a5.ts.net';
  private token: string | null = null;
  private tokenExpiry: Date | null = null;
  private licenseId: string;

  constructor(licenseId: string) {
    this.licenseId = licenseId;
  }

  async authenticate(): Promise<GatewayAuthResponse> {
    const response = await fetch(`${this.baseUrl}/auth/license`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ licenseId: this.licenseId })
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error);
    }

    const data: GatewayAuthResponse = await response.json();
    this.token = data.token;
    this.tokenExpiry = new Date(Date.now() + 23 * 60 * 60 * 1000); // 23 hours

    return data;
  }

  private async ensureAuthenticated(): Promise<string> {
    if (!this.token || !this.tokenExpiry || new Date() >= this.tokenExpiry) {
      await this.authenticate();
    }
    return this.token!;
  }

  async queryForecasts(options: {
    types?: string[];
    categories?: string[];
    dateFrom?: string;
    dateTo?: string;
  } = {}): Promise<ForecastFile[]> {
    const token = await this.ensureAuthenticated();

    const response = await fetch(`${this.baseUrl}/forecasts/query`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify(options)
    });

    if (!response.ok) {
      throw new Error(`Query failed: ${response.status}`);
    }

    const data = await response.json();
    return data.files;
  }

  async getLatest(): Promise<Record<string, ForecastFile>> {
    const token = await this.ensureAuthenticated();

    const response = await fetch(`${this.baseUrl}/forecasts/latest`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });

    const data = await response.json();
    return data.latest;
  }

  async downloadFile(file: ForecastFile): Promise<string> {
    const token = await this.ensureAuthenticated();

    const url = `${this.baseUrl}/forecasts/file/${file.type}/${file.category}/${file.filename}`;
    const response = await fetch(url, {
      headers: { 'Authorization': `Bearer ${token}` }
    });

    if (!response.ok) {
      throw new Error(`Download failed: ${response.status}`);
    }

    return await response.text();
  }
}

// Usage in Apollo
async function initializeVantage(licenseInfo: LicenseInfo) {
  // Check if Vantage module is active
  if (!licenseInfo.hasModule('Vantage')) {
    console.log('Vantage module not available');
    return null;
  }

  // Create Gateway client
  const gateway = new VantageGatewayClient(licenseInfo.licenseId);

  try {
    // Authenticate
    const auth = await gateway.authenticate();
    console.log(`Authenticated as: ${auth.clientName} (${auth.tier})`);

    // Get latest forecasts
    const latest = await gateway.getLatest();
    console.log('Latest forecasts:', latest);

    return gateway;
  } catch (error) {
    console.error('Gateway authentication failed:', error);
    return null;
  }
}
```

---

## Error Handling

### Authentication Errors

| Error | Cause | User Message |
|-------|-------|--------------|
| `License not registered` | LicenseId not in Gateway | "Please contact support to activate Vantage access" |
| `License has been revoked` | License disabled | "Your Vantage access has been suspended" |
| `License has expired` | Past expiry date | "Your Vantage license has expired" |
| `Token expired` | JWT expired | Re-authenticate automatically |

### Recommended Error Handling

```typescript
try {
  await gateway.authenticate();
} catch (error) {
  if (error.message === 'License not registered') {
    showDialog('Vantage Not Activated',
      'Your license does not include Vantage access. Please contact support.');
  } else if (error.message === 'License has been revoked') {
    showDialog('Access Suspended',
      'Your Vantage access has been suspended. Please contact support.');
  } else if (error.message === 'License has expired') {
    showDialog('License Expired',
      'Your Vantage license has expired. Please renew your subscription.');
  } else {
    showDialog('Connection Error',
      'Unable to connect to Vantage server. Please check your internet connection.');
  }
}
```

---

## Security Model

| Layer | Responsibility |
|-------|----------------|
| **License File** | Contains LicenseId, proves legitimate Apollo install |
| **Local Validation** | Apollo checks Vantage module exists & not expired |
| **Gateway Validation** | Verifies LicenseId is registered & enabled |
| **JWT Token** | Authorizes API access for 24 hours |

### Revocation Flow

1. **Immediate:** Licensing team sets `enabled: false` in Gateway
2. **Within 24h:** All existing JWT tokens expire
3. **Client sees:** "License has been revoked" on next auth attempt

---

## Audit Trail

All Gateway access is logged with LicenseId:

```
[Auth:License] Token issued for: ACME Corporation (a1b2c3d4...)
[Query] ACME Corporation (license:a1b2c3d4...) - types:day-ahead categories:demand
[Download] ACME Corporation (license:a1b2c3d4...) - day-ahead/demand/DA_DEM_2026-03-03.csv
```

View logs:
```bash
ssh root@100.115.9.94 "tail -100 /opt/vantage/logs/gatekeeper.log"
```

---

## Summary

| Question | Answer |
|----------|--------|
| What identifies a client? | `LicenseId` (GUID from license file) |
| Where are licenses registered? | Gateway `config.json` |
| Who registers licenses? | Licensing team (via Admin API or manual) |
| How does Apollo authenticate? | `POST /auth/license` with LicenseId |
| How is access revoked? | `PUT /admin/licenses/:id` with `enabled: false` |
| How long is a token valid? | 24 hours |

---

## Quick Reference

### Gateway URL
```
https://vantage-gateway.taile437a5.ts.net
```

### Admin API Key
```
gatekeeper-admin-2026-x7k9m2p4
```

### Apollo Authentication
```bash
curl -X POST https://vantage-gateway.taile437a5.ts.net/auth/license \
  -H "Content-Type: application/json" \
  -d '{"licenseId": "YOUR-LICENSE-GUID-HERE"}'
```

### Register License (Admin)
```bash
curl -X POST https://vantage-gateway.taile437a5.ts.net/admin/licenses \
  -H "Authorization: Bearer gatekeeper-admin-2026-x7k9m2p4" \
  -H "Content-Type: application/json" \
  -d '{"licenseId": "GUID", "clientName": "Name", "expiresAt": "2027-01-01"}'
```

### Revoke License (Admin)
```bash
curl -X PUT "https://vantage-gateway.taile437a5.ts.net/admin/licenses/GUID" \
  -H "Authorization: Bearer gatekeeper-admin-2026-x7k9m2p4" \
  -H "Content-Type: application/json" \
  -d '{"enabled": false}'
```

### Test License (for development)
```
LicenseId: 550e8400-e29b-41d4-a716-446655440000
Status: Disabled (template only)
```

### Server Access (SSH)
```
SSH: root@100.115.9.94
Password: ienergyaustralia
Config: /opt/vantage/gatekeeper/config.json
```

---

## Admin API Endpoint Summary

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/admin/licenses` | List all licenses |
| `GET` | `/admin/licenses/:id` | Get single license |
| `POST` | `/admin/licenses` | Register new license |
| `PUT` | `/admin/licenses/:id` | Update license |
| `DELETE` | `/admin/licenses/:id` | Delete license |
| `POST` | `/admin/licenses/bulk` | Bulk register |
| `POST` | `/admin/reload` | Reload config from disk |
| `GET` | `/admin/stats` | System statistics |
| `GET` | `/admin/storage` | Storage statistics (v2.2.0) |
| `POST` | `/admin/archive` | Archive old files (v2.2.0) |
| `POST` | `/admin/clear` | Delete files (v2.2.0) |
