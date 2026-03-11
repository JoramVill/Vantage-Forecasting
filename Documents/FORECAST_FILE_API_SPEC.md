# Vantage Forecaster - File API Specification

**Version:** 1.0
**Date:** 2026-03-03
**For:** APOLLO (Front-End) & Vantage Gateway API Teams

This document specifies the forecast file naming conventions, directory structure, and data formats for consuming forecast files from the Vantage Gateway.

---

## Table of Contents

1. [Quick Reference](#quick-reference)
2. [File Naming Convention](#file-naming-convention)
3. [Directory Structure](#directory-structure)
4. [Identifying Forecast Horizon](#identifying-forecast-horizon)
5. [CSV File Schemas](#csv-file-schemas)
6. [Suggested API Endpoints](#suggested-api-endpoints)
7. [Date/Time Handling](#datetime-handling)
8. [Example Workflows](#example-workflows)

---

## Quick Reference

### Filename Patterns at a Glance

| Horizon | Type | Pattern | Example |
|---------|------|---------|---------|
| Day-Ahead | Demand | `da_demand_YYYY-MM-DD.csv` | `da_demand_2026-03-02.csv` |
| Day-Ahead | MHCF | `da_mhcf_YYYY-MM-DD.csv` | `da_mhcf_2026-03-02.csv` |
| Week-Ahead | Demand | `wa_demand_START_END.csv` | `wa_demand_2026-03-02_2026-03-08.csv` |
| Week-Ahead | MHCF | `wa_mhcf_START_END.csv` | `wa_mhcf_2026-03-02_2026-03-08.csv` |

### Directory Paths

| Category | Path |
|----------|------|
| Day-Ahead Demand | `/day-ahead/demand/` |
| Day-Ahead MHCF | `/day-ahead/mhcf/` |
| Week-Ahead Demand | `/week-ahead/demand/` |
| Week-Ahead MHCF | `/week-ahead/mhcf/` |

---

## File Naming Convention

### Pattern Structure

```
{horizon}_{type}_{start_date}[_{end_date}].csv
```

| Component | Values | Description |
|-----------|--------|-------------|
| `horizon` | `da`, `wa` | `da` = Day-Ahead, `wa` = Week-Ahead |
| `type` | `demand`, `mhcf` | Forecast type |
| `start_date` | `YYYY-MM-DD` | First day of forecast period |
| `end_date` | `YYYY-MM-DD` | Last day (week-ahead only) |

### Regex Patterns for Parsing

```javascript
// Day-Ahead: da_demand_2026-03-02.csv
const DA_PATTERN = /^(da)_(demand|mhcf)_(\d{4}-\d{2}-\d{2})\.csv$/;

// Week-Ahead: wa_demand_2026-03-02_2026-03-08.csv
const WA_PATTERN = /^(wa)_(demand|mhcf)_(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})\.csv$/;

// Combined pattern
const FORECAST_PATTERN = /^(da|wa)_(demand|mhcf)_(\d{4}-\d{2}-\d{2})(?:_(\d{4}-\d{2}-\d{2}))?\.csv$/;
```

### Parsing Example (JavaScript)

```javascript
function parseFilename(filename) {
  const match = filename.match(
    /^(da|wa)_(demand|mhcf)_(\d{4}-\d{2}-\d{2})(?:_(\d{4}-\d{2}-\d{2}))?\.csv$/
  );

  if (!match) return null;

  return {
    horizon: match[1] === 'da' ? 'day-ahead' : 'week-ahead',
    type: match[2],           // 'demand' or 'mhcf'
    startDate: match[3],      // '2026-03-02'
    endDate: match[4] || match[3],  // Week-ahead has end date, day-ahead uses start
    isWeekAhead: match[1] === 'wa'
  };
}

// Examples:
parseFilename('da_demand_2026-03-02.csv')
// { horizon: 'day-ahead', type: 'demand', startDate: '2026-03-02', endDate: '2026-03-02', isWeekAhead: false }

parseFilename('wa_mhcf_2026-03-02_2026-03-08.csv')
// { horizon: 'week-ahead', type: 'mhcf', startDate: '2026-03-02', endDate: '2026-03-08', isWeekAhead: true }
```

### Parsing Example (Python)

```python
import re
from dataclasses import dataclass
from typing import Optional

@dataclass
class ForecastFile:
    horizon: str      # 'day-ahead' or 'week-ahead'
    type: str         # 'demand' or 'mhcf'
    start_date: str   # 'YYYY-MM-DD'
    end_date: str     # 'YYYY-MM-DD'
    is_week_ahead: bool

def parse_filename(filename: str) -> Optional[ForecastFile]:
    pattern = r'^(da|wa)_(demand|mhcf)_(\d{4}-\d{2}-\d{2})(?:_(\d{4}-\d{2}-\d{2}))?\.csv$'
    match = re.match(pattern, filename)

    if not match:
        return None

    horizon_code, forecast_type, start_date, end_date = match.groups()

    return ForecastFile(
        horizon='day-ahead' if horizon_code == 'da' else 'week-ahead',
        type=forecast_type,
        start_date=start_date,
        end_date=end_date or start_date,
        is_week_ahead=(horizon_code == 'wa')
    )
```

---

## Directory Structure

```
/                                   # API/SFTP root
|
+-- day-ahead/
|   +-- demand/                     # Day-ahead demand forecasts
|   |   +-- da_demand_2026-03-01.csv
|   |   +-- da_demand_2026-03-02.csv
|   |   +-- da_demand_2026-03-03.csv
|   |
|   +-- mhcf/                       # Day-ahead capacity factors
|       +-- da_mhcf_2026-03-01.csv
|       +-- da_mhcf_2026-03-02.csv
|
+-- week-ahead/
|   +-- demand/                     # Week-ahead demand forecasts
|   |   +-- wa_demand_2026-03-01_2026-03-07.csv
|   |   +-- wa_demand_2026-03-02_2026-03-08.csv
|   |
|   +-- mhcf/                       # Week-ahead capacity factors
|       +-- wa_mhcf_2026-03-01_2026-03-07.csv
|       +-- wa_mhcf_2026-03-02_2026-03-08.csv
|
+-- archive/                        # Old files (30+ days)
```

---

## Identifying Forecast Horizon

### Method 1: By Directory Path (Recommended)

| Path Contains | Horizon |
|---------------|---------|
| `/day-ahead/` | Day-Ahead (next day only) |
| `/week-ahead/` | Week-Ahead (7 days) |

### Method 2: By Filename Prefix

| Prefix | Horizon | Date Format |
|--------|---------|-------------|
| `da_` | Day-Ahead | Single date |
| `wa_` | Week-Ahead | Date range (start_end) |

### Method 3: By Date Count in Filename

```javascript
function getHorizonFromFilename(filename) {
  const dates = filename.match(/\d{4}-\d{2}-\d{2}/g);
  if (!dates) return null;

  // Day-ahead has 1 date, week-ahead has 2
  return dates.length === 1 ? 'day-ahead' : 'week-ahead';
}
```

---

## CSV File Schemas

### Demand Forecast - Regional (3 Regions)

**Applies to:** `da_demand_*.csv`, `wa_demand_*.csv`

| Column | Type | Unit | Description |
|--------|------|------|-------------|
| `DateTimeEnding` | String | - | Timestamp: `M/D/YYYY HH:mm` |
| `CLUZ` | Float | MW | Luzon region demand |
| `CVIS` | Float | MW | Visayas region demand |
| `CMIN` | Float | MW | Mindanao region demand |

**Example:**
```csv
DateTimeEnding,CLUZ,CVIS,CMIN
3/2/2026 01:00,9379.8,1725.0,1879.5
3/2/2026 02:00,9140.3,1654.5,1802.5
3/2/2026 03:00,8823.0,1600.8,1760.0
```

**Row Count:**
- Day-Ahead: 24 rows (one per hour)
- Week-Ahead: 168 rows (24 hours x 7 days)

### Demand Forecast - Zonal (14 Zones)

**Applies to:** Files with 14 zone columns

| Column | Type | Unit | Description |
|--------|------|------|-------------|
| `DateTimeEnding` | String | - | Timestamp: `M/D/YYYY HH:mm` |
| `01NLUZ` | Float | MW | Northern Luzon |
| `02METRO` | Float | MW | Metro Manila |
| `03SLUZ` | Float | MW | Southern Luzon |
| `04LEYTE` | Float | MW | Leyte |
| `05CEBU` | Float | MW | Cebu |
| `06NEGROS` | Float | MW | Negros |
| `07BOHOL` | Float | MW | Bohol |
| `08PANAY` | Float | MW | Panay |
| `09NWMIN` | Float | MW | Northwest Mindanao |
| `10LANAO` | Float | MW | Lanao |
| `11NCMIN` | Float | MW | North Central Mindanao |
| `12NEMIN` | Float | MW | Northeast Mindanao |
| `13SEMIN` | Float | MW | Southeast Mindanao |
| `14SWMIN` | Float | MW | Southwest Mindanao |

### MHCF (Capacity Factor) Forecast

**Applies to:** `da_mhcf_*.csv`, `wa_mhcf_*.csv`

| Column | Type | Range | Description |
|--------|------|-------|-------------|
| `DateTimeEnding` | String | - | Timestamp: `M/D/YYYY HH:mm` |
| `<STATION_CODE>` | Float | 0.0 - 1.0 | Capacity factor per station |

**Station Type Identification (by suffix):**

| Suffix | Type | Example |
|--------|------|---------|
| `_W` | Wind | `08NABAS_W` |
| `_S` | Solar | `01SNMANUEL_S` |
| `_H` | Hydro | `14SIGHYDRO` |
| `_B` | Battery | `01SNTGO_B` |
| `_G`, `_GP` | Geothermal | `03TIWI-C` |
| `_BI`, `_BG`, `_BL` | Biomass | `01CBNTUAN_BI` |

**Example:**
```csv
DateTimeEnding,01BURGOS,01SNMANUEL_S,08NABAS_W,03TIWI-C
3/2/2026 01:00,0.7895,0.0000,0.4375,0.8500
3/2/2026 02:00,0.8123,0.0000,0.3892,0.8500
3/2/2026 06:00,0.6542,0.1200,0.4100,0.8500
3/2/2026 12:00,0.3210,0.9500,0.2800,0.8500
```

**Notes:**
- Solar stations = 0.0 during night hours (approx 18:00-06:00)
- Geothermal typically constant (~0.85)
- Wind varies based on weather conditions
- File contains 100+ station columns

---

## Suggested API Endpoints

### For Vantage Gateway API

```
# List available forecasts
GET /api/forecasts
GET /api/forecasts?type=demand&horizon=day-ahead
GET /api/forecasts?date=2026-03-02

# Get latest forecast
GET /api/forecasts/day-ahead/demand/latest
GET /api/forecasts/week-ahead/mhcf/latest

# Get specific forecast by date
GET /api/forecasts/day-ahead/demand/2026-03-02
GET /api/forecasts/week-ahead/demand/2026-03-02

# Download file directly
GET /api/files/day-ahead/demand/da_demand_2026-03-02.csv

# Get forecast metadata
GET /api/forecasts/day-ahead/demand/2026-03-02/metadata

# Health check
GET /api/health
```

### Example Response: List Forecasts

```json
{
  "forecasts": [
    {
      "filename": "da_demand_2026-03-02.csv",
      "horizon": "day-ahead",
      "type": "demand",
      "startDate": "2026-03-02",
      "endDate": "2026-03-02",
      "path": "/day-ahead/demand/da_demand_2026-03-02.csv",
      "size": 2048,
      "uploadedAt": "2026-03-01T22:00:00Z"
    },
    {
      "filename": "wa_demand_2026-03-02_2026-03-08.csv",
      "horizon": "week-ahead",
      "type": "demand",
      "startDate": "2026-03-02",
      "endDate": "2026-03-08",
      "path": "/week-ahead/demand/wa_demand_2026-03-02_2026-03-08.csv",
      "size": 15360,
      "uploadedAt": "2026-03-01T22:00:00Z"
    }
  ]
}
```

### Example Response: Get Metadata

```json
{
  "filename": "da_demand_2026-03-02.csv",
  "horizon": "day-ahead",
  "type": "demand",
  "startDate": "2026-03-02",
  "endDate": "2026-03-02",
  "rows": 24,
  "columns": ["DateTimeEnding", "CLUZ", "CVIS", "CMIN"],
  "regions": ["CLUZ", "CVIS", "CMIN"],
  "timeRange": {
    "first": "3/2/2026 01:00",
    "last": "3/3/2026 00:00"
  },
  "uploadedAt": "2026-03-01T22:00:00Z",
  "checksum": "sha256:abc123..."
}
```

---

## Date/Time Handling

### Timezone

All timestamps are in **Philippines Standard Time (PHT, UTC+8)**.

### DateTimeEnding Format

```
M/D/YYYY HH:mm
```

| Component | Format | Example |
|-----------|--------|---------|
| Month | 1-12 (no leading zero) | `3` for March |
| Day | 1-31 (no leading zero) | `2` for 2nd |
| Year | 4-digit | `2026` |
| Hour | 00-23 (24-hour, zero-padded) | `01`, `14`, `23` |
| Minute | Always `00` (hourly data) | `00` |

### Hour-Ending Convention

The `DateTimeEnding` column uses **hour-ending** timestamps:
- `3/2/2026 01:00` = Data for the hour **00:00 to 01:00** on March 2nd
- `3/2/2026 24:00` or `3/3/2026 00:00` = Data for **23:00 to 00:00**

### Parsing Examples

```javascript
// JavaScript
function parseDateTimeEnding(str) {
  // "3/2/2026 14:00" → Date object
  const [datePart, timePart] = str.split(' ');
  const [month, day, year] = datePart.split('/').map(Number);
  const [hour, minute] = timePart.split(':').map(Number);

  // Note: Month is 0-indexed in JavaScript Date
  return new Date(year, month - 1, day, hour, minute);
}
```

```python
# Python
from datetime import datetime

def parse_datetime_ending(s: str) -> datetime:
    # "3/2/2026 14:00" → datetime object
    return datetime.strptime(s, "%m/%d/%Y %H:%M")
```

---

## Example Workflows

### APOLLO: Fetch Latest Day-Ahead Demand

```javascript
async function getLatestDayAheadDemand() {
  // 1. Get latest file info
  const response = await fetch('/api/forecasts/day-ahead/demand/latest');
  const metadata = await response.json();

  // 2. Download the CSV
  const csvResponse = await fetch(`/api/files${metadata.path}`);
  const csvText = await csvResponse.text();

  // 3. Parse CSV
  const rows = csvText.split('\n');
  const headers = rows[0].split(',');

  const data = rows.slice(1).filter(r => r.trim()).map(row => {
    const values = row.split(',');
    return {
      datetime: values[0],
      CLUZ: parseFloat(values[1]),
      CVIS: parseFloat(values[2]),
      CMIN: parseFloat(values[3])
    };
  });

  return { metadata, data };
}
```

### APOLLO: Get Forecast for Specific Date

```javascript
async function getForecastForDate(date, type = 'demand', horizon = 'day-ahead') {
  // date format: 'YYYY-MM-DD'
  const response = await fetch(
    `/api/forecasts/${horizon}/${type}/${date}`
  );

  if (!response.ok) {
    if (response.status === 404) {
      throw new Error(`No ${horizon} ${type} forecast available for ${date}`);
    }
    throw new Error(`API error: ${response.status}`);
  }

  return response.json();
}
```

### Vantage API: Route File to Correct Directory

```javascript
function getDirectoryForFile(filename) {
  const parsed = parseFilename(filename);
  if (!parsed) return '/other/';

  return `/${parsed.horizon}/${parsed.type}/`;
}

// Examples:
getDirectoryForFile('da_demand_2026-03-02.csv')     // '/day-ahead/demand/'
getDirectoryForFile('wa_mhcf_2026-03-02_2026-03-08.csv')  // '/week-ahead/mhcf/'
```

---

## File Size Reference

| File Type | Typical Size | Rows | Columns |
|-----------|--------------|------|---------|
| Day-Ahead Demand (Regional) | 1-2 KB | 24 | 4 |
| Day-Ahead Demand (Zonal) | 3-5 KB | 24 | 15 |
| Week-Ahead Demand (Regional) | 8-15 KB | 168 | 4 |
| Week-Ahead Demand (Zonal) | 20-40 KB | 168 | 15 |
| Day-Ahead MHCF | 30-60 KB | 24 | 100+ |
| Week-Ahead MHCF | 200-400 KB | 168 | 100+ |

---

## Upload Schedule

Forecasts are typically generated and uploaded daily at **06:00 PHT**:

| Forecast | Generated | Covers |
|----------|-----------|--------|
| Day-Ahead (da_*) | 06:00 on Day N | Day N+1 |
| Week-Ahead (wa_*) | 06:00 on Day N | Day N+1 through N+7 |

---

## Contact

For questions about this specification, contact the Vantage Forecaster team.
