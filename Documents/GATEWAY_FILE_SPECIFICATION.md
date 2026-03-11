# Vantage Forecaster - Gateway File Specification

**Version:** 1.0
**Date:** 2026-03-02
**For:** Gateway API Development Team

This document specifies how forecast files are named, organized, and structured by the Vantage Forecaster system.

---

## Table of Contents

1. [Directory Structure](#directory-structure)
2. [File Naming Convention](#file-naming-convention)
3. [Forecast Categories](#forecast-categories)
4. [CSV File Schemas](#csv-file-schemas)
5. [Path Determination Logic](#path-determination-logic)
6. [Archive Structure](#archive-structure)
7. [File Upload Patterns](#file-upload-patterns)

---

## Directory Structure

Files are uploaded via SFTP to the gateway server with the following directory structure:

```
/                                   # SFTP root (chrooted to /opt/vantage/csv_storage)
|
+-- day-ahead/                      # Daily forecasts (next day)
|   +-- demand/                     # Day-Ahead Demand forecasts
|   |   +-- regional/               # 3-region demand files (FC_DEM_*, DA_DEM_*)
|   |   +-- zonal/                  # 14-zone demand files (FC_ZDEM_*, DA_ZDEM_*)
|   +-- mhcf/                       # Day-Ahead Must-Dispatch Hourly Capacity Factors
|
+-- week-ahead/                     # Weekly forecasts (7 days out)
|   +-- demand/                     # Week-Ahead Demand forecasts
|   |   +-- regional/               # 3-region demand files (WA_DEM_*)
|   |   +-- zonal/                  # 14-zone demand files (WA_ZDEM_*)
|   +-- mhcf/                       # Week-Ahead MHCF
|
+-- historical/                     # Historical data (future use)
|   +-- scenarios/
|   |   +-- weekly/                 # Historical Analysis Scenarios (weekly)
|   |   +-- monthly/                # Historical Analysis Scenarios (monthly)
|   +-- databases/                  # Historical Databases (monthly MDB files)
|
+-- demand/                         # Legacy paths (backward compatibility)
|   +-- regional/                   # 3-region demand files
|   +-- zonal/                      # 14-zone demand files
|
+-- cfac/                           # Legacy CFAC files
+-- archive/                        # Old files (auto-archived after 30 days)
+-- other/                          # Uncategorized files
```

---

## File Naming Convention

### Primary Naming Pattern (Current Implementation)

**Day-Ahead files** use single date, **Week-Ahead files** use date range:

| Forecast Type | Horizon | Pattern | Example |
|---------------|---------|---------|---------|
| Demand | Day-Ahead | `da_demand_YYYY-MM-DD.csv` | `da_demand_2026-03-02.csv` |
| Demand | Week-Ahead | `wa_demand_YYYY-MM-DD_YYYY-MM-DD.csv` | `wa_demand_2026-03-02_2026-03-08.csv` |
| MHCF (Capacity Factor) | Day-Ahead | `da_mhcf_YYYY-MM-DD.csv` | `da_mhcf_2026-03-02.csv` |
| MHCF (Capacity Factor) | Week-Ahead | `wa_mhcf_YYYY-MM-DD_YYYY-MM-DD.csv` | `wa_mhcf_2026-03-02_2026-03-08.csv` |

### Filename Components

| Component | Description | Format |
|-----------|-------------|--------|
| `da_` | Day-Ahead prefix | Lowercase, fixed string |
| `wa_` | Week-Ahead prefix | Lowercase, fixed string |
| `demand` | Demand forecast type | Lowercase, fixed string |
| `mhcf` | Must-Dispatch Hourly Capacity Factor type | Lowercase, fixed string |
| `YYYY-MM-DD` | Start date of forecast period | ISO 8601 date |
| `_YYYY-MM-DD` | End date (week-ahead only) | ISO 8601 date |

### Filename Regex Patterns

```regex
# Day-Ahead (single date)
^(da)_(demand|mhcf)_(\d{4}-\d{2}-\d{2})\.csv$

# Week-Ahead (date range)
^(wa)_(demand|mhcf)_(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})\.csv$
```

### Optional Suffix

Files may include an optional suffix before the `.csv` extension:

```
da_demand_2026-03-02_v2.csv
da_demand_2026-03-02_revised.csv
wa_mhcf_2026-03-02_2026-03-08_calibrated.csv
```

### Legacy Patterns (Still Supported)

For backward compatibility, these patterns are also recognized:

| Pattern | Maps To |
|---------|---------|
| `DA_DEM_*.csv` | `/day-ahead/demand/` |
| `DA_MHCF_*.csv` | `/day-ahead/mhcf/` |
| `WA_DEM_*.csv` | `/week-ahead/demand/` |
| `WA_MHCF_*.csv` | `/week-ahead/mhcf/` |
| `FC_DEM_*.csv` | `/demand/regional/` |
| `FC_ZDEM_*.csv` | `/demand/zonal/` |
| `FC_CF_*.csv` | `/cfac/` |

---

## Forecast Categories

### Category Identifiers

The system uses these category identifiers internally and in API calls:

| Category ID | Description | Remote Path |
|-------------|-------------|-------------|
| `day-ahead-demand` | Next-day demand forecast (regional) | `/day-ahead/demand/regional/` |
| `day-ahead-demand-zonal` | Next-day demand forecast (zonal) | `/day-ahead/demand/zonal/` |
| `day-ahead-mhcf` | Next-day capacity factors | `/day-ahead/mhcf/` |
| `week-ahead-demand` | 7-day demand forecast (regional) | `/week-ahead/demand/regional/` |
| `week-ahead-demand-zonal` | 7-day demand forecast (zonal) | `/week-ahead/demand/zonal/` |
| `week-ahead-mhcf` | 7-day capacity factors | `/week-ahead/mhcf/` |
| `historical-scenarios-weekly` | Weekly historical analysis | `/historical/scenarios/weekly/` |
| `historical-scenarios-monthly` | Monthly historical analysis | `/historical/scenarios/monthly/` |
| `historical-databases` | Historical database files | `/historical/databases/` |

**Note:** Demand files are auto-routed to `regional/` or `zonal/` subdirectories based on filename detection:
- Files containing `ZDEM` or `ZONAL` → `zonal/`
- Files containing `DEM` but not `ZDEM` → `regional/`

---

## CSV File Schemas

### Demand Forecast - Regional (3 Regions)

**File Pattern:** `DA_DEM_*.csv`, `WA_DEM_*.csv` (when regional)

| Column | Type | Description |
|--------|------|-------------|
| `DateTimeEnding` | String | Timestamp in format `M/D/YYYY HH:mm` |
| `CLUZ` | Float | Luzon demand in MW |
| `CVIS` | Float | Visayas demand in MW |
| `CMIN` | Float | Mindanao demand in MW |

**Example:**
```csv
DateTimeEnding,CLUZ,CVIS,CMIN
3/2/2026 01:00,9379.8,1725.0,1879.5
3/2/2026 02:00,9140.3,1654.5,1802.5
3/2/2026 03:00,8823.0,1600.8,1760.0
```

### Demand Forecast - Zonal (14 Zones)

**File Pattern:** `FC_ZDEM_*.csv` or regional files with zonal data

| Column | Type | Description |
|--------|------|-------------|
| `DateTimeEnding` | String | Timestamp in format `M/D/YYYY HH:mm` |
| `01NLUZ` | Float | Northern Luzon demand in MW |
| `02METRO` | Float | Metro Manila demand in MW |
| `03SLUZ` | Float | Southern Luzon demand in MW |
| `04LEYTE` | Float | Leyte (Visayas) demand in MW |
| `05CEBU` | Float | Cebu (Visayas) demand in MW |
| `06NEGROS` | Float | Negros (Visayas) demand in MW |
| `07BOHOL` | Float | Bohol (Visayas) demand in MW |
| `08PANAY` | Float | Panay (Visayas) demand in MW |
| `09NWMIN` | Float | Northwest Mindanao demand in MW |
| `10LANAO` | Float | Lanao (Mindanao) demand in MW |
| `11NCMIN` | Float | North Central Mindanao demand in MW |
| `12NEMIN` | Float | Northeast Mindanao demand in MW |
| `13SEMIN` | Float | Southeast Mindanao demand in MW |
| `14SWMIN` | Float | Southwest Mindanao demand in MW |

**Example:**
```csv
DateTimeEnding,01NLUZ,02METRO,03SLUZ,04LEYTE,05CEBU,06NEGROS,07BOHOL,08PANAY,09NWMIN,10LANAO,11NCMIN,12NEMIN,13SEMIN,14SWMIN
3/2/2026 01:00,3260.3,2755.8,2506.1,170.5,773.0,310.9,95.4,346.8,265.3,127.7,339.2,184.1,552.0,370.7
```

### MHCF (Capacity Factor) Forecast

**File Pattern:** `DA_MHCF_*.csv`, `WA_MHCF_*.csv`

| Column | Type | Description |
|--------|------|-------------|
| `DateTimeEnding` | String | Timestamp in format `M/D/YYYY HH:mm` |
| `<STATION_CODE>` | Float | Capacity factor (0.0 to 1.0) for each station |

**Station Code Suffixes:**

| Suffix | Station Type |
|--------|--------------|
| `_W` | Wind |
| `_S` | Solar |
| `_H` | Hydro (Storage) |
| `_B` | Battery |
| `_G`, `_GP` | Geothermal |
| `_BI`, `_BG`, `_BL` | Biomass |

**Example:**
```csv
DateTimeEnding,01BURGOS,01LAOAG,01PAGUDPUD,01SNMANUEL_S,01CURIMAO,08NABAS_W,...
3/2/2026 01:00,0.7895,0.0000,0.0000,0.0000,0.0000,0.4375,...
3/2/2026 02:00,0.7895,0.0000,0.0000,0.0000,0.0000,0.4375,...
```

**Notes:**
- Capacity factors range from 0.0 (no output) to 1.0 (100% rated capacity)
- Solar stations show 0.0 during nighttime hours (typically 18:00-06:00)
- Wind stations may show high values at night when wind is strong
- File contains 100+ station columns

---

## Path Determination Logic

The system automatically routes files to the correct directory based on filename patterns:

```javascript
function getRemoteDirectory(filename, category) {
  // Helper to detect zonal demand files
  function isZonalDemandFile(fn) {
    const upper = fn.toUpperCase();
    return upper.includes('ZDEM') || upper.includes('ZONAL');
  }

  // If explicit category provided, use mapping
  if (category) {
    return {
      'day-ahead-demand': '/day-ahead/demand/regional',
      'day-ahead-demand-zonal': '/day-ahead/demand/zonal',
      'day-ahead-mhcf': '/day-ahead/mhcf',
      'week-ahead-demand': '/week-ahead/demand/regional',
      'week-ahead-demand-zonal': '/week-ahead/demand/zonal',
      'week-ahead-mhcf': '/week-ahead/mhcf',
      'historical-scenarios-weekly': '/historical/scenarios/weekly',
      'historical-scenarios-monthly': '/historical/scenarios/monthly',
      'historical-databases': '/historical/databases'
    }[category] || '/other';
  }

  // Auto-detect from filename (case-insensitive)
  const fn = filename.toUpperCase();
  const isZonal = isZonalDemandFile(filename);

  // Day-Ahead patterns
  if (fn.startsWith('DA_DEM') || fn.startsWith('DA_ZDEM') || fn.includes('DAY_AHEAD_DEM')) {
    return isZonal ? '/day-ahead/demand/zonal' : '/day-ahead/demand/regional';
  }
  if (fn.startsWith('DA_MHCF') || fn.startsWith('DA_CF')) {
    return '/day-ahead/mhcf';
  }

  // Week-Ahead patterns
  if (fn.startsWith('WA_DEM') || fn.startsWith('WA_ZDEM') || fn.includes('WEEK_AHEAD_DEM')) {
    return isZonal ? '/week-ahead/demand/zonal' : '/week-ahead/demand/regional';
  }
  if (fn.startsWith('WA_MHCF') || fn.startsWith('WA_CF')) {
    return '/week-ahead/mhcf';
  }

  // Legacy patterns with geography routing
  if (fn.startsWith('FC_ZDEM_')) return '/day-ahead/demand/zonal';
  if (fn.startsWith('FC_DEM_')) return '/day-ahead/demand/regional';
  if (fn.startsWith('FC_CF_') || fn.includes('CFAC')) return '/cfac';

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

  return '/other';
}
```

---

## Archive Structure

The forecaster maintains a local archive with the following structure:

```
output/
+-- archive/
    +-- YYYY-MM/                    # Year-Month folder
        +-- YYYY-MM-DD/             # As-of date folder (when forecast was generated)
            +-- DA_DEM_YYYY-MM-DD.csv
            +-- DA_MHCF_YYYY-MM-DD.csv
            +-- WA_DEM_YYYY-MM-DD.csv
            +-- WA_MHCF_YYYY-MM-DD.csv
```

**Example:**
```
output/archive/
+-- 2026-03/
    +-- 2026-03-01/                 # Forecasts generated on March 1st
    |   +-- DA_DEM_2026-03-02.csv   # Day-ahead demand for March 2nd
    |   +-- DA_MHCF_2026-03-02.csv  # Day-ahead MHCF for March 2nd
    |   +-- WA_DEM_2026-03-02.csv   # Week-ahead starting March 2nd
    |   +-- WA_MHCF_2026-03-02.csv  # Week-ahead starting March 2nd
    +-- 2026-03-02/
        +-- DA_DEM_2026-03-03.csv
        +-- ...
```

---

## File Upload Patterns

### Typical Daily Upload Schedule

| Time (PHT) | Files Generated | Description |
|------------|-----------------|-------------|
| 06:00 | `DA_DEM_<tomorrow>.csv` | Next-day demand forecast |
| 06:00 | `DA_MHCF_<tomorrow>.csv` | Next-day capacity factors |
| 06:00 | `WA_DEM_<tomorrow>.csv` | 7-day demand forecast |
| 06:00 | `WA_MHCF_<tomorrow>.csv` | 7-day capacity factors |

### File Size Expectations

| File Type | Typical Size | Rows | Columns |
|-----------|--------------|------|---------|
| Day-Ahead Demand (Regional) | 2-5 KB | 24 | 4 |
| Day-Ahead Demand (Zonal) | 5-10 KB | 24 | 15 |
| Week-Ahead Demand (Regional) | 15-30 KB | 168 | 4 |
| Week-Ahead Demand (Zonal) | 30-60 KB | 168 | 15 |
| Day-Ahead MHCF | 50-100 KB | 24 | 100+ |
| Week-Ahead MHCF | 300-500 KB | 168 | 100+ |

### Upload Frequency

| Forecast Type | Frequency | Retention |
|---------------|-----------|-----------|
| Day-Ahead | Daily | 30 days |
| Week-Ahead | Daily | 30 days |
| Historical Scenarios | Weekly/Monthly | 1 year |

---

## API Integration Notes

### Recommended API Endpoints

For the Gateway API, consider implementing:

```
GET  /api/forecasts/{category}                    # List files in category
GET  /api/forecasts/{category}/{filename}         # Download specific file
GET  /api/forecasts/{category}/latest             # Get most recent file
POST /api/forecasts/{category}                    # Upload new file (internal)
GET  /api/forecasts/search?date=YYYY-MM-DD        # Search by date
GET  /api/health                                  # Service health check
```

### Category Validation

Valid categories for API calls:
- `day-ahead-demand`
- `day-ahead-mhcf`
- `week-ahead-demand`
- `week-ahead-mhcf`

### Date Parsing

The `DateTimeEnding` column uses Philippines local time (PHT, UTC+8) in format `M/D/YYYY HH:mm`:
- `3/2/2026 01:00` = March 2, 2026 at 01:00 PHT
- Month and day are NOT zero-padded
- Hours are 24-hour format (00:00 to 23:00)
- Minutes are always `:00` (hourly data)

---

## Contact

For questions about this specification, contact the Vantage Forecaster team.
