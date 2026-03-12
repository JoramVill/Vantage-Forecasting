# Gateway API Improvement Request: Explicit Geography Routing

**Date:** 2026-03-12
**Requested By:** Vantage Forecaster Team
**Priority:** Medium
**Status:** Proposal

---

## Executive Summary

Vantage Forecaster now generates both **regional** (3 regions) and **zonal** (14 sub-regions) demand forecasts. The current gateway push mechanism uses filename pattern matching to route files to the correct folders, which is fragile. We request explicit `geography` parameter support in the Gateway API.

---

## Current Vantage Forecaster Output

### Demand Forecast Types

| Type | Regions | Description | Filename Pattern |
|------|---------|-------------|------------------|
| **Regional** | 3 | CLUZ, CVIS, CMIN | `da_demand_regional_YYYY-MM-DD.csv` |
| **Zonal** | 14 | 01NLUZ through 14SWMIN | `da_demand_zonal_YYYY-MM-DD.csv` |

### File Output Structure

```
output/
├── daily/
│   └── Demand/
│       ├── regional/
│       │   └── da_demand_regional_2026-01-15.csv
│       └── zonal/
│           └── da_demand_zonal_2026-01-15.csv
└── weekly/
    └── Demand/
        ├── regional/
        │   └── wa_demand_regional_2026-01-15_2026-01-21.csv
        └── zonal/
            └── wa_demand_zonal_2026-01-15_2026-01-21.csv
```

### Forecast File Format

**Regional (3 columns):**
```csv
datetime,CLUZ,CVIS,CMIN
2026-01-15 00:00,8500.5,2100.3,1800.7
2026-01-15 01:00,8200.1,2050.8,1750.2
...
```

**Zonal (14 columns):**
```csv
datetime,01NLUZ,02METRO,03SLUZ,04LEYTE,05CEBU,06NEGROS,07BOHOL,08PANAY,09NWMIN,10LANAO,11NCMIN,12NEMIN,13SEMIN,14SWMIN
2026-01-15 00:00,1250.5,3200.8,1800.3,450.2,680.5,520.1,180.3,390.7,280.4,220.1,350.6,180.2,290.8,310.5
...
```

### Configuration Setting

In `forecast_config.json`:
```json
{
  "demand": {
    "geography": "both"  // Options: "regional", "zonal", "both"
  }
}
```

When `geography = "both"`, Vantage generates TWO separate forecasts:
1. Regional forecast → should go to `/day-ahead/demand/regional/`
2. Zonal forecast → should go to `/day-ahead/demand/zonal/`

---

## Current Gateway Routing (Client-Side)

### How It Works Now

The Vantage SFTP push service (`src/services/sftpPushService.ts`) determines the remote folder by parsing the filename:

```typescript
function isZonalDemandFile(filename: string): boolean {
  const fn = filename.toUpperCase();
  return fn.includes('ZDEM') || fn.includes('ZONAL');
}

function getRemoteDirectory(filename: string, category: string): string {
  if (category === 'day-ahead-demand') {
    if (isZonalDemandFile(filename)) {
      return '/day-ahead/demand/zonal';
    }
    return '/day-ahead/demand/regional';
  }
  // ... other categories
}
```

### Problems with This Approach

1. **Fragile:** Relies on filename conventions that could change
2. **No Validation:** Wrong filename = wrong folder, silently
3. **Implicit:** Data type is inferred, not explicit
4. **Error-Prone:** Easy to break with naming changes
5. **Hard to Debug:** No clear indication of routing decision

---

## Proposed Gateway API Changes

### Option A: Separate Endpoints (Recommended)

Create distinct endpoints for regional vs zonal data:

```
POST /api/forecasts/demand/regional
POST /api/forecasts/demand/zonal
POST /api/forecasts/cfac/regional
POST /api/forecasts/cfac/zonal
```

**Benefits:**
- Clear, explicit routing
- Easy to validate and document
- No filename parsing needed
- API is self-documenting

### Option B: Explicit Query Parameter

Add `geography` parameter to existing endpoint:

```
POST /api/forecasts/demand?geography=zonal
POST /api/forecasts/demand?geography=regional
```

**Benefits:**
- Minimal API changes
- Backwards compatible (default to regional)
- Client explicitly declares intent

### Option C: Metadata in Request Body

Include geography in the upload metadata:

```json
{
  "category": "day-ahead-demand",
  "geography": "zonal",
  "forecastDate": "2026-01-15",
  "file": "<base64 or multipart>"
}
```

**Benefits:**
- Rich metadata support
- Extensible for future attributes
- Single endpoint with flexible routing

---

## Recommended Implementation

### Gateway Server Changes

1. **Add geography routing logic:**
```python
# Example (Flask/FastAPI style)
@app.post("/api/forecasts/demand")
def upload_demand_forecast(
    file: UploadFile,
    geography: str = Query(..., enum=["regional", "zonal"]),
    horizon: str = Query(..., enum=["daily", "weekly"])
):
    # Route based on explicit geography parameter
    if geography == "zonal":
        dest_path = f"/forecasts/demand/zonal/{horizon}/"
    else:
        dest_path = f"/forecasts/demand/regional/{horizon}/"

    # Save file to destination
    save_forecast(file, dest_path)
```

2. **Update SFTP folder structure:**
```
/forecasts/
├── demand/
│   ├── regional/
│   │   ├── daily/
│   │   └── weekly/
│   └── zonal/
│       ├── daily/
│       └── weekly/
└── cfac/
    ├── regional/
    └── zonal/
```

3. **Add validation:**
- Validate that zonal files have 14 region columns
- Validate that regional files have 3 region columns
- Return clear error if mismatch

### Vantage Forecaster Changes (After Gateway Update)

Update `sftpPushService.ts` to use explicit geography:

```typescript
async pushForecast(
  filePath: string,
  category: string,
  geography: 'regional' | 'zonal'
): Promise<void> {
  // Use explicit geography parameter in API call
  await this.apiClient.post('/api/forecasts/demand', {
    file: filePath,
    geography: geography,
    horizon: this.detectHorizon(filePath)
  });
}
```

---

## Migration Path

### Phase 1: Gateway API Update
1. Add new endpoints with explicit geography parameter
2. Keep old filename-based routing as fallback
3. Log when fallback is used for monitoring

### Phase 2: Vantage Forecaster Update
1. Update push service to use new explicit API
2. Pass geography from forecast generation context
3. Remove filename-based routing logic

### Phase 3: Deprecation
1. Remove filename-based fallback in Gateway
2. Require explicit geography parameter
3. Update documentation

---

## Testing Checklist

- [ ] Regional demand pushes to `/demand/regional/`
- [ ] Zonal demand pushes to `/demand/zonal/`
- [ ] Daily/weekly horizons route correctly within geography folders
- [ ] API validates file format matches declared geography
- [ ] Clear error messages for mismatches
- [ ] Backwards compatibility during migration

---

## Contact

**Vantage Forecaster Repository:** `Vantage-Forecaster`
**Related Files:**
- `src/services/sftpPushService.ts` - Current push implementation
- `src/services/forecastSchedulerService.ts` - Forecast generation with geography
- `forecast_config.json` - Geography configuration

---

*Document created: 2026-03-12*
