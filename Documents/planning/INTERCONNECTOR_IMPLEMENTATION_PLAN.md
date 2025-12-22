# Interconnector Constraint Prediction - Implementation Plan

## Executive Summary

This document provides a comprehensive implementation plan for adding interconnector constraint prediction capabilities to the iLoad Forecasting Utility. The system will predict congestion probability on Philippine grid interconnectors (MINVIS1 and VISLUZ1) using historical RTDHS data combined with existing weather and demand data.

**Document Version**: 1.0
**Date**: 2025-12-11
**Project**: iLoad Forecasting Utility
**Branch**: CapacityFactorForecast

---

## Table of Contents

1. [Background](#background)
2. [Requirements](#requirements)
3. [Codebase Analysis](#codebase-analysis)
4. [Architecture Design](#architecture-design)
5. [Implementation Tasks](#implementation-tasks)
6. [Data Flow](#data-flow)
7. [File Structure](#file-structure)
8. [Testing Strategy](#testing-strategy)
9. [Documentation](#documentation)
10. [Timeline](#timeline)

---

## 1. Background

### Philippine Grid Interconnectors

The Philippine power grid consists of three main island grids connected by HVDC (High Voltage Direct Current) interconnectors:

| Interconnector | Connects | Capacity | Status |
|---------------|----------|----------|---------|
| **MINVIS1** | Mindanao - Visayas | 450 MW | Operational |
| **VISLUZ1** | Visayas - Luzon | 420 MW | Operational |

### Data Source: RTDHS Files

RTDHS (Real-Time Dispatch Historical Statistics) files contain historical interconnector flow and congestion data:

**Location**: `Z:\WESM FILES\RTDHS\RTDHS_YYYYMMDD.csv` (daily files)

**CSV Structure**:
```csv
RUN_TIME,MKT_TYPE,TIME_INTERVAL,HVDC_NAME,CONGESTION_FLAG,FLOW_FROM,FLOW_TO,OVERLOAD_MW
7/1/2025,RTD,7/1/2025 12:05:00 AM,MINVIS1,Y,450,-450,,
7/1/2025,RTD,7/1/2025 12:05:00 AM,VISLUZ1,N,361.15,-361.15,,
```

**Fields**:
- `RUN_TIME`: Date of the RTD run (M/D/YYYY format)
- `MKT_TYPE`: Market type (RTD = Real-Time Dispatch)
- `TIME_INTERVAL`: Timestamp of the data point (M/D/YYYY h:mm:ss AM/PM)
- `HVDC_NAME`: Interconnector name (MINVIS1, VISLUZ1)
- `CONGESTION_FLAG`: 'Y' if congested, 'N' if not
- `FLOW_FROM`: Power flow in MW (positive = direction 1)
- `FLOW_TO`: Power flow in MW (negative = opposite direction)
- `OVERLOAD_MW`: Amount of overload if congested (usually empty)

### Business Value

1. **Grid Operations**: Predict congestion events for better dispatch planning
2. **Market Insights**: Understand when regional price separations may occur
3. **Reliability**: Anticipate transmission constraints affecting power delivery
4. **Integration**: Combine with demand forecasting for holistic grid analysis

---

## 2. Requirements

### Functional Requirements

1. **Data Import**
   - Parse RTDHS CSV files (single file or directory)
   - Import interconnector flow records into SQLite database
   - Handle date range filtering for bulk imports
   - Validate interconnector names and data integrity

2. **Data Storage**
   - Store historical interconnector flow data
   - Maintain interconnector metadata (capacity, regions)
   - Save trained congestion prediction models
   - Track model performance metrics

3. **Statistics & Analysis**
   - Calculate congestion rates by interconnector
   - Analyze flow patterns (average, peak, volatility)
   - Identify temporal patterns (hour, day, season)
   - Correlate with demand and weather conditions

4. **ML Model Training**
   - Train classification model for congestion prediction (Y/N)
   - Train regression model for flow magnitude prediction
   - Use combined features: demand, weather, temporal, historical flow
   - Evaluate model performance (accuracy, precision, recall, F1)

5. **Forecasting**
   - Predict future congestion probability
   - Forecast expected flow magnitudes
   - Generate confidence intervals
   - Output results in CSV format

6. **CLI Interface**
   - `interconnector import` - Import RTDHS data
   - `interconnector stats` - Display statistics
   - `interconnector train` - Train prediction models
   - `interconnector forecast` - Generate predictions

### Non-Functional Requirements

1. **Performance**: Handle years of historical data efficiently (millions of records)
2. **Accuracy**: Target 80%+ classification accuracy, <10% MAPE for flow prediction
3. **Scalability**: Support addition of new interconnectors (future: Luzon-Mindanao)
4. **Maintainability**: Follow existing codebase patterns and conventions
5. **Documentation**: Comprehensive user and developer documentation

---

## 3. Codebase Analysis

### Existing Patterns Identified

#### 3.1 Database Layer (`src/database/`)

**Pattern**: Centralized schema definition + service class

**Files**:
- `schema.ts`: Single file with all CREATE TABLE SQL statements
- `database.ts`: DatabaseService class with methods for each table
- `index.ts`: Exports and singleton instance management

**Key Patterns**:
- Schema versioning via `schema_info` table (current: v2)
- Transaction-based imports for performance
- `ON CONFLICT` upsert pattern for idempotent imports
- Composite UNIQUE constraints for natural keys
- Indexes on common query patterns
- Luxon DateTime for all date conversions
- Prepared statements for repeated queries

**Example Import Pattern**:
```typescript
importDemandRecords(records: DemandRecord[], sourceFile?: string): { inserted: number; updated: number } {
  const insertStmt = this.db.prepare(`
    INSERT INTO demand_records (datetime, region, demand, source_file)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(datetime, region) DO UPDATE SET
      demand = excluded.demand,
      imported_at = CURRENT_TIMESTAMP
  `);

  const transaction = this.db.transaction(() => {
    for (const record of records) {
      insertStmt.run(...);
    }
  });

  transaction();
  return { inserted, updated };
}
```

#### 3.2 CSV Parsers (`src/parsers/`)

**Pattern**: Interface definitions + single-file parser + directory parser

**Common Structure**:
1. **Type Definitions**: Raw data interfaces, parsed data interfaces
2. **Date Parsing**: Support multiple date formats with DateTime.fromFormat()
3. **Single File Parser**: `parseSingleCsv(filePath)` helper function
4. **Main Export**: Handles both files and directories
5. **Deduplication**: Remove duplicate records by composite key
6. **Statistics**: Return summary (records, date range, unique entities)
7. **Progress Callbacks**: Optional `onProgress?: (msg: string) => void`

**Example: outageParser.ts** (most similar to interconnector needs):
- Handles multiple CSV formats in one parser
- Complex merging logic (events + details)
- Region inference from unit IDs
- Enum-based type categorization
- Extensive date format handling
- Progress reporting for long operations

#### 3.3 CLI Commands (`src/index.ts`)

**Pattern**: Commander.js with nested subcommands

**Command Hierarchy**:
```
program (root)
├── train
├── forecast
├── info
├── evaluate
├── db
│   ├── status
│   ├── import
│   ├── models
│   └── clear
├── cfac
│   ├── forecast
│   ├── evaluate
│   ├── info
│   └── forecast-all
└── outage
    ├── analyze
    ├── summary
    ├── weather-forecast
    └── duration-stats
```

**Common Options Pattern**:
- File inputs: `-d, --demand <file>`, `-f, --file <path>`
- Date ranges: `-s, --start <date>`, `-e, --end <date>`
- Output: `-o, --output <file|dir>`
- Filters: `-i, --interconnector <name>`, `-r, --region <region>`

**User Feedback Pattern**:
- Emoji progress indicators: 🔄 Loading, 📊 Data, 🌤️ Weather, ✅ Success, ❌ Error
- Step-by-step output with indentation
- Summary statistics after operations
- Error messages with actionable suggestions

#### 3.4 Model Layer (`src/models/`)

**Pattern**: Model class with train() and predict() methods

**Base Structure**:
```typescript
class SomeModel {
  train(samples: TrainingSample[], options?): MetricsObject {
    // Training logic
    return { r2Score, mape, mae, rmse, ... };
  }

  predict(features: FeatureVector): Prediction {
    // Prediction logic
    return { value, confidence, ... };
  }

  isReady(): boolean {
    // Check if model trained
  }
}
```

**Specialized Models**: `capacityFactor/` subdirectory pattern
- One model per station type
- ModelRouter for dispatching to appropriate model
- Hybrid models (physics + ML residual)
- Serialization support for database persistence

#### 3.5 Service Layer (`src/services/`)

**Pattern**: Business logic and external integrations

**Examples**:
- `weatherService.ts`: API integration, caching, batch fetching
- `capacityFactorService.ts`: Cluster-based weather, complex logic
- `outageAnalysisService.ts`: Probability calculations, report generation

**Service Characteristics**:
- Exported factory functions: `createWeatherService(apiKey, cacheDir)`
- Class-based for stateful services
- Progress callbacks for long operations
- Error handling with fallbacks

---

## 4. Architecture Design

### 4.1 Database Schema

Update `src/database/schema.ts` to add three new tables:

```sql
-- Interconnector flow records from RTDHS
CREATE TABLE IF NOT EXISTS interconnector_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  datetime TEXT NOT NULL,
  run_time TEXT NOT NULL,
  market_type TEXT NOT NULL,
  interconnector_name TEXT NOT NULL,
  congestion_flag TEXT NOT NULL,
  flow_from REAL NOT NULL,
  flow_to REAL NOT NULL,
  overload_mw REAL,
  source_file TEXT,
  imported_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(datetime, run_time, interconnector_name)
);

-- Interconnector metadata
CREATE TABLE IF NOT EXISTS interconnector_metadata (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  from_region TEXT NOT NULL,
  to_region TEXT NOT NULL,
  capacity_mw REAL NOT NULL,
  notes TEXT,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Interconnector congestion prediction models
CREATE TABLE IF NOT EXISTS interconnector_models (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  training_start TEXT,
  training_end TEXT,
  training_samples INTEGER,
  accuracy REAL,
  precision REAL,
  recall REAL,
  f1_score REAL,
  model_data TEXT,  -- JSON with model coefficients
  is_active INTEGER DEFAULT 1,
  notes TEXT
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_interconnector_datetime
  ON interconnector_records(datetime);
CREATE INDEX IF NOT EXISTS idx_interconnector_name
  ON interconnector_records(interconnector_name);
CREATE INDEX IF NOT EXISTS idx_interconnector_congestion
  ON interconnector_records(congestion_flag);
CREATE INDEX IF NOT EXISTS idx_interconnector_datetime_name
  ON interconnector_records(datetime, interconnector_name);
```

**Schema Version**: Update from 2 to 3

**Initial Metadata**:
```sql
INSERT INTO interconnector_metadata (name, from_region, to_region, capacity_mw, notes)
VALUES
  ('MINVIS1', 'CMIN', 'CVIS', 450, 'Mindanao-Visayas HVDC'),
  ('VISLUZ1', 'CVIS', 'CLUZ', 420, 'Visayas-Luzon HVDC');
```

### 4.2 Type Definitions

Create `src/types/interconnector.ts`:

```typescript
/**
 * Raw interconnector data as parsed from RTDHS CSV
 */
export interface RawInterconnectorData {
  runTime: Date;
  marketType: string;
  timeInterval: Date;
  hvdcName: string;
  congestionFlag: 'Y' | 'N';
  flowFrom: number;
  flowTo: number;
  overloadMW: number | null;
}

/**
 * Interconnector record with optional source file tracking
 */
export interface InterconnectorRecord extends RawInterconnectorData {
  sourceFile?: string;
}

/**
 * Parsed interconnector data with summary statistics
 */
export interface ParsedInterconnectorData {
  records: InterconnectorRecord[];
  interconnectors: string[];
  startDate: Date;
  endDate: Date;
  filesProcessed?: number;
  totalCongestionEvents: number;
  congestionByInterconnector: Map<string, number>;
}

/**
 * Interconnector metadata
 */
export interface InterconnectorMetadata {
  name: string;
  fromRegion: string;
  toRegion: string;
  capacityMW: number;
  notes?: string;
}

/**
 * Interconnector statistics
 */
export interface InterconnectorStats {
  interconnector: string;
  totalRecords: number;
  congestionEvents: number;
  congestionRate: number;
  avgFlowFrom: number;
  avgFlowTo: number;
  peakFlowFrom: number;
  peakFlowTo: number;
  flowVolatility: number;
  dateRange: {
    start: string;
    end: string;
  };
}

/**
 * Congestion prediction result
 */
export interface InterconnectorCongestionPrediction {
  datetime: Date;
  interconnector: string;
  congestionProbability: number;
  expectedFlowFrom: number;
  expectedFlowTo: number;
  predictedFlag: 'Y' | 'N';
  confidence: number;
  features?: Record<string, number>;
}

/**
 * Training sample for congestion model
 */
export interface InterconnectorTrainingSample {
  // Target variables
  isCongested: boolean;
  flowFrom: number;
  flowTo: number;

  // Features
  features: number[];
  featureNames?: string[];

  // Metadata
  datetime: Date;
  interconnector: string;
}

/**
 * Model evaluation metrics
 */
export interface InterconnectorModelMetrics {
  // Classification metrics
  accuracy: number;
  precision: number;
  recall: number;
  f1Score: number;
  confusionMatrix: {
    truePositive: number;
    trueNegative: number;
    falsePositive: number;
    falseNegative: number;
  };

  // Regression metrics (for flow prediction)
  r2Score: number;
  mape: number;
  mae: number;
  rmse: number;

  // Training info
  trainingSamples: number;
  trainingDate: string;
}
```

### 4.3 Feature Engineering

**Feature Categories** (40+ features total):

#### Temporal Features (10)
- `hour` (0-23)
- `dayOfWeek` (0-6, Sunday=0)
- `isWeekend` (0/1)
- `isHoliday` (0/1)
- `dayOfMonth` (1-31)
- `month` (1-12)
- `hourSin`, `hourCos` (cyclic encoding)
- `dayOfWeekSin`, `dayOfWeekCos` (cyclic encoding)

#### Regional Demand Features (9)
- `demandCLUZ` (Luzon demand in MW)
- `demandCVIS` (Visayas demand in MW)
- `demandCMIN` (Mindanao demand in MW)
- `demandTotal` (total grid demand)
- `demandRatio_CV` (CVIS/CLUZ ratio - price spread indicator)
- `demandRatio_CM` (CMIN/CVIS ratio)
- `demandRatio_CL` (CMIN/CLUZ ratio)
- `demandDiff_CV` (CVIS - CLUZ, MW)
- `demandDiff_CM` (CMIN - CVIS, MW)

#### Weather Features (12)
- `tempCLUZ`, `tempCVIS`, `tempCMIN` (regional temperatures)
- `tempDiff_CV`, `tempDiff_CM` (temperature differentials)
- `windCLUZ`, `windCVIS`, `windCMIN` (wind speeds)
- `solarCLUZ`, `solarCVIS`, `solarCMIN` (solar radiation)

#### Historical Flow Features (9)
- `flowLag1h` (flow 1 hour ago)
- `flowLag24h` (flow 24 hours ago)
- `flowLag168h` (flow 1 week ago)
- `flowRolling24h` (24-hour rolling average)
- `flowVolatility24h` (24-hour standard deviation)
- `congestionLag1h` (was congested 1h ago, 0/1)
- `congestionLag24h` (was congested 24h ago, 0/1)
- `congestionCount24h` (number of congestion events in last 24h)
- `congestionCount168h` (number of congestion events in last week)

**Feature Extraction Function**:
```typescript
export function buildInterconnectorFeatures(
  datetime: Date,
  interconnector: string,
  demandData: Map<string, number>,  // region -> demand
  weatherData: Map<string, WeatherFeatures>,  // region -> weather
  flowHistory: Map<string, number>,  // timestamp_interconnector -> flow
  congestionHistory: Map<string, boolean>  // timestamp_interconnector -> isCongested
): number[]
```

### 4.4 ML Model Architecture

Create `src/models/interconnector/InterconnectorCongestionModel.ts`:

**Approach**: Dual-model system
1. **Classification Model**: Predict congestion (Y/N) using logistic regression
2. **Regression Model**: Predict flow magnitude using linear regression

**Model Class Structure**:
```typescript
export class InterconnectorCongestionModel {
  private classificationModel: LogisticRegressionModel;  // For Y/N
  private regressionModelFrom: RegressionModel;  // For flow_from
  private regressionModelTo: RegressionModel;  // For flow_to
  private featureNames: string[];
  private ready: boolean = false;

  /**
   * Train both classification and regression models
   */
  train(samples: InterconnectorTrainingSample[]): InterconnectorModelMetrics {
    // 1. Train classification model (congested Y/N)
    // 2. Train regression models (flow magnitude)
    // 3. Evaluate on validation set
    // 4. Return comprehensive metrics
  }

  /**
   * Predict congestion and flow
   */
  predict(features: number[]): InterconnectorCongestionPrediction {
    // 1. Classify: congested or not
    // 2. Regress: expected flow magnitude
    // 3. Calculate confidence
    // 4. Return prediction
  }

  /**
   * Serialize model for database storage
   */
  serialize(): string {
    return JSON.stringify({
      classificationCoefficients: this.classificationModel.coefficients,
      regressionCoefficientsFrom: this.regressionModelFrom.coefficients,
      regressionCoefficientsTo: this.regressionModelTo.coefficients,
      featureNames: this.featureNames
    });
  }

  /**
   * Load model from serialized data
   */
  static deserialize(data: string): InterconnectorCongestionModel {
    const parsed = JSON.parse(data);
    const model = new InterconnectorCongestionModel();
    // Load coefficients into models
    return model;
  }
}
```

**Evaluation Metrics**:
- **Classification**: Accuracy, Precision, Recall, F1, Confusion Matrix
- **Regression**: R², MAPE, MAE, RMSE
- **Combined**: Overall prediction quality score

---

## 5. Implementation Tasks

### Task 1: Database Schema Extension

**File**: `src/database/schema.ts`

**Actions**:
1. Update `SCHEMA_VERSION` from 2 to 3
2. Add three new CREATE TABLE statements (see 4.1)
3. Add four new CREATE INDEX statements
4. Test schema migration

**Acceptance Criteria**:
- Schema creates successfully on fresh database
- Existing databases migrate from v2 to v3
- All indexes created properly
- Metadata table initialized with MINVIS1 and VISLUZ1

---

### Task 2: Type Definitions

**File**: `src/types/interconnector.ts` (new)

**Actions**:
1. Create all interfaces (see 4.2)
2. Add JSDoc comments for each interface
3. Export all types
4. Update `src/types/index.ts` to re-export

**Acceptance Criteria**:
- All TypeScript interfaces defined
- No compilation errors
- Proper JSDoc documentation
- Exports available from `src/types/index.ts`

---

### Task 3: RTDHS CSV Parser

**File**: `src/parsers/interconnectorParser.ts` (new)

**Actions**:
1. Implement date parsing for multiple formats
2. Create `parseSingleRTDHS(filePath)` function
3. Create `parseInterconnectorCsv(pathOrFolder)` main export
4. Add validation for interconnector names
5. Implement deduplication logic
6. Calculate summary statistics
7. Support progress callbacks

**Implementation Outline**:
```typescript
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { DateTime } from 'luxon';
import {
  RawInterconnectorData,
  InterconnectorRecord,
  ParsedInterconnectorData
} from '../types/interconnector.js';

/**
 * Parse datetime in M/D/YYYY h:mm:ss AM/PM format
 */
function parseDateTime(dateStr: string): Date | null {
  // Try M/D/YYYY h:mm:ss AM/PM
  let dt = DateTime.fromFormat(dateStr, 'M/d/yyyy h:mm:ss a');
  if (dt.isValid) return dt.toJSDate();

  // Try M/D/YYYY format
  dt = DateTime.fromFormat(dateStr, 'M/d/yyyy');
  if (dt.isValid) return dt.toJSDate();

  return null;
}

/**
 * Parse a single RTDHS CSV file
 */
function parseSingleRTDHS(filePath: string): {
  records: InterconnectorRecord[];
  interconnectors: Set<string>;
  minDate: Date | null;
  maxDate: Date | null;
  congestionCount: Map<string, number>;
} {
  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').filter(l => l.trim());

  if (lines.length < 2) return { records: [], interconnectors: new Set(), minDate: null, maxDate: null, congestionCount: new Map() };

  const headers = lines[0].split(',').map(h => h.trim().toUpperCase());
  const colIdx = (name: string) => headers.indexOf(name);

  const records: InterconnectorRecord[] = [];
  const interconnectors = new Set<string>();
  const congestionCount = new Map<string, number>();
  let minDate: Date | null = null;
  let maxDate: Date | null = null;

  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(',').map(v => v.trim());

    const runTime = parseDateTime(values[colIdx('RUN_TIME')]);
    const timeInterval = parseDateTime(values[colIdx('TIME_INTERVAL')]);

    if (!runTime || !timeInterval) continue;

    const hvdcName = values[colIdx('HVDC_NAME')];
    const congestionFlag = values[colIdx('CONGESTION_FLAG')] as 'Y' | 'N';
    const flowFrom = parseFloat(values[colIdx('FLOW_FROM')]);
    const flowTo = parseFloat(values[colIdx('FLOW_TO')]);
    const overloadMW = values[colIdx('OVERLOAD_MW')] ? parseFloat(values[colIdx('OVERLOAD_MW')]) : null;

    // Validate interconnector name
    if (!['MINVIS1', 'VISLUZ1'].includes(hvdcName)) {
      console.warn(`Unknown interconnector: ${hvdcName}`);
      continue;
    }

    interconnectors.add(hvdcName);

    if (!minDate || timeInterval < minDate) minDate = timeInterval;
    if (!maxDate || timeInterval > maxDate) maxDate = timeInterval;

    if (congestionFlag === 'Y') {
      congestionCount.set(hvdcName, (congestionCount.get(hvdcName) || 0) + 1);
    }

    records.push({
      runTime,
      marketType: values[colIdx('MKT_TYPE')],
      timeInterval,
      hvdcName,
      congestionFlag,
      flowFrom,
      flowTo,
      overloadMW
    });
  }

  return { records, interconnectors, minDate, maxDate, congestionCount };
}

/**
 * Main parser function - handles file or directory
 */
export function parseInterconnectorCsv(
  pathOrFolder: string,
  onProgress?: (msg: string) => void
): ParsedInterconnectorData {
  const stat = statSync(pathOrFolder);

  if (stat.isDirectory()) {
    // Handle directory - find all RTDHS_*.csv files
    const files = readdirSync(pathOrFolder)
      .filter(f => f.startsWith('RTDHS_') && f.endsWith('.csv'))
      .map(f => join(pathOrFolder, f));

    if (files.length === 0) {
      throw new Error(`No RTDHS_*.csv files found in ${pathOrFolder}`);
    }

    onProgress?.(`Found ${files.length} RTDHS files`);

    const allRecords: InterconnectorRecord[] = [];
    const allInterconnectors = new Set<string>();
    const congestionByInterconnector = new Map<string, number>();
    let globalMinDate: Date | null = null;
    let globalMaxDate: Date | null = null;

    for (const file of files) {
      onProgress?.(`Processing ${file}...`);
      const { records, interconnectors, minDate, maxDate, congestionCount } = parseSingleRTDHS(file);

      allRecords.push(...records);
      interconnectors.forEach(i => allInterconnectors.add(i));

      for (const [interconnector, count] of congestionCount.entries()) {
        congestionByInterconnector.set(
          interconnector,
          (congestionByInterconnector.get(interconnector) || 0) + count
        );
      }

      if (minDate && (!globalMinDate || minDate < globalMinDate)) globalMinDate = minDate;
      if (maxDate && (!globalMaxDate || maxDate > globalMaxDate)) globalMaxDate = maxDate;
    }

    // Deduplicate by datetime + interconnector
    const uniqueMap = new Map<string, InterconnectorRecord>();
    for (const record of allRecords) {
      const key = `${record.timeInterval.getTime()}_${record.runTime.getTime()}_${record.hvdcName}`;
      uniqueMap.set(key, record);
    }

    const uniqueRecords = Array.from(uniqueMap.values());
    uniqueRecords.sort((a, b) => a.timeInterval.getTime() - b.timeInterval.getTime());

    onProgress?.(`Total records: ${uniqueRecords.length} (${files.length} files)`);
    onProgress?.(`Date range: ${DateTime.fromJSDate(globalMinDate!).toISODate()} to ${DateTime.fromJSDate(globalMaxDate!).toISODate()}`);

    return {
      records: uniqueRecords,
      interconnectors: Array.from(allInterconnectors),
      startDate: globalMinDate!,
      endDate: globalMaxDate!,
      filesProcessed: files.length,
      totalCongestionEvents: Array.from(congestionByInterconnector.values()).reduce((a, b) => a + b, 0),
      congestionByInterconnector
    };
  } else {
    // Single file
    const { records, interconnectors, minDate, maxDate, congestionCount } = parseSingleRTDHS(pathOrFolder);
    return {
      records,
      interconnectors: Array.from(interconnectors),
      startDate: minDate!,
      endDate: maxDate!,
      filesProcessed: 1,
      totalCongestionEvents: Array.from(congestionCount.values()).reduce((a, b) => a + b, 0),
      congestionByInterconnector: congestionCount
    };
  }
}
```

**Acceptance Criteria**:
- Parses single RTDHS file correctly
- Parses directory of RTDHS files
- Handles multiple date formats
- Validates interconnector names
- Deduplicates records
- Calculates accurate statistics
- Progress callbacks work

---

### Task 4: Database Service Extension

**File**: `src/database/database.ts`

**Actions**:
1. Add `importInterconnectorRecords()` method
2. Add `getInterconnectorRecords()` method
3. Add `getInterconnectorStats()` method
4. Add `saveInterconnectorModel()` method
5. Add `getActiveInterconnectorModel()` method
6. Add metadata initialization in `initialize()`

**Implementation Outline**:
```typescript
// In DatabaseService class

/**
 * Import interconnector records
 */
importInterconnectorRecords(
  records: InterconnectorRecord[],
  sourceFile?: string
): { inserted: number; updated: number } {
  const insertStmt = this.db.prepare(`
    INSERT INTO interconnector_records
    (datetime, run_time, market_type, interconnector_name, congestion_flag, flow_from, flow_to, overload_mw, source_file)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(datetime, run_time, interconnector_name) DO UPDATE SET
      congestion_flag = excluded.congestion_flag,
      flow_from = excluded.flow_from,
      flow_to = excluded.flow_to,
      overload_mw = excluded.overload_mw,
      source_file = excluded.source_file,
      imported_at = CURRENT_TIMESTAMP
  `);

  let inserted = 0;

  const transaction = this.db.transaction(() => {
    for (const record of records) {
      const datetimeStr = DateTime.fromJSDate(record.timeInterval).toISO();
      const runTimeStr = DateTime.fromJSDate(record.runTime).toISO();

      insertStmt.run(
        datetimeStr,
        runTimeStr,
        record.marketType,
        record.hvdcName,
        record.congestionFlag,
        record.flowFrom,
        record.flowTo,
        record.overloadMW,
        sourceFile || null
      );
      inserted++;
    }
  });

  transaction();
  return { inserted, updated: 0 };
}

/**
 * Get interconnector records
 */
getInterconnectorRecords(
  startDate?: string,
  endDate?: string,
  interconnector?: string
): InterconnectorRecord[] {
  let sql = 'SELECT * FROM interconnector_records WHERE 1=1';
  const params: any[] = [];

  if (startDate) {
    sql += ' AND datetime >= ?';
    params.push(startDate);
  }
  if (endDate) {
    sql += ' AND datetime <= ?';
    params.push(endDate);
  }
  if (interconnector) {
    sql += ' AND interconnector_name = ?';
    params.push(interconnector);
  }

  sql += ' ORDER BY datetime, interconnector_name';

  const rows = this.db.prepare(sql).all(...params) as any[];
  return rows.map(row => ({
    runTime: new Date(row.run_time),
    marketType: row.market_type,
    timeInterval: new Date(row.datetime),
    hvdcName: row.interconnector_name,
    congestionFlag: row.congestion_flag as 'Y' | 'N',
    flowFrom: row.flow_from,
    flowTo: row.flow_to,
    overloadMW: row.overload_mw,
    sourceFile: row.source_file
  }));
}

/**
 * Get interconnector statistics
 */
getInterconnectorStats(
  interconnector?: string,
  startDate?: string,
  endDate?: string
): InterconnectorStats[] {
  let sql = `
    SELECT
      interconnector_name,
      COUNT(*) as total_records,
      SUM(CASE WHEN congestion_flag = 'Y' THEN 1 ELSE 0 END) as congestion_events,
      AVG(flow_from) as avg_flow_from,
      AVG(flow_to) as avg_flow_to,
      MAX(flow_from) as peak_flow_from,
      MIN(flow_to) as peak_flow_to,
      MIN(datetime) as start_date,
      MAX(datetime) as end_date
    FROM interconnector_records
    WHERE 1=1
  `;
  const params: any[] = [];

  if (startDate) {
    sql += ' AND datetime >= ?';
    params.push(startDate);
  }
  if (endDate) {
    sql += ' AND datetime <= ?';
    params.push(endDate);
  }
  if (interconnector) {
    sql += ' AND interconnector_name = ?';
    params.push(interconnector);
  }

  sql += ' GROUP BY interconnector_name';

  const rows = this.db.prepare(sql).all(...params) as any[];

  return rows.map(row => ({
    interconnector: row.interconnector_name,
    totalRecords: row.total_records,
    congestionEvents: row.congestion_events,
    congestionRate: row.total_records > 0 ? row.congestion_events / row.total_records : 0,
    avgFlowFrom: row.avg_flow_from,
    avgFlowTo: row.avg_flow_to,
    peakFlowFrom: row.peak_flow_from,
    peakFlowTo: row.peak_flow_to,
    flowVolatility: 0,  // Calculate separately if needed
    dateRange: {
      start: row.start_date,
      end: row.end_date
    }
  }));
}

/**
 * Save interconnector model
 */
saveInterconnectorModel(
  name: string,
  trainingStart: string,
  trainingEnd: string,
  trainingSamples: number,
  metrics: InterconnectorModelMetrics,
  modelData: string
): number {
  const stmt = this.db.prepare(`
    INSERT INTO interconnector_models
    (name, training_start, training_end, training_samples, accuracy, precision, recall, f1_score, model_data, is_active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  `);

  const result = stmt.run(
    name,
    trainingStart,
    trainingEnd,
    trainingSamples,
    metrics.accuracy,
    metrics.precision,
    metrics.recall,
    metrics.f1Score,
    modelData
  );

  return result.lastInsertRowid as number;
}

/**
 * Get active interconnector model
 */
getActiveInterconnectorModel(): any | null {
  const row = this.db.prepare(`
    SELECT * FROM interconnector_models
    WHERE is_active = 1
    ORDER BY created_at DESC
    LIMIT 1
  `).get() as any;

  if (!row) return null;

  return {
    id: row.id,
    name: row.name,
    trainingStart: row.training_start,
    trainingEnd: row.training_end,
    trainingSamples: row.training_samples,
    accuracy: row.accuracy,
    precision: row.precision,
    recall: row.recall,
    f1Score: row.f1_score,
    modelData: row.model_data
  };
}
```

**Acceptance Criteria**:
- All methods compile without errors
- Import handles duplicates correctly
- Query methods filter properly
- Stats calculation accurate
- Model save/load works

---

### Task 5: Feature Engineering

**File**: `src/features/interconnectorFeatures.ts` (new)

**Actions**:
1. Implement feature extraction function
2. Implement training sample builder
3. Add normalization helpers
4. Add lag feature calculation

**Implementation Outline**:
```typescript
import { DateTime } from 'luxon';
import { InterconnectorTrainingSample } from '../types/interconnector.js';
import { DemandRecord } from '../parsers/demandParser.js';
import { PH_HOLIDAYS_2025 } from '../constants/index.js';

const FEATURE_NAMES = [
  // Temporal (10)
  'hour', 'dayOfWeek', 'isWeekend', 'isHoliday', 'dayOfMonth', 'month',
  'hourSin', 'hourCos', 'dayOfWeekSin', 'dayOfWeekCos',

  // Demand (9)
  'demandCLUZ', 'demandCVIS', 'demandCMIN', 'demandTotal',
  'demandRatio_CV', 'demandRatio_CM', 'demandRatio_CL',
  'demandDiff_CV', 'demandDiff_CM',

  // Weather (12)
  'tempCLUZ', 'tempCVIS', 'tempCMIN', 'tempDiff_CV', 'tempDiff_CM',
  'windCLUZ', 'windCVIS', 'windCMIN',
  'solarCLUZ', 'solarCVIS', 'solarCMIN',
  'avgTemp',

  // Flow lags (9)
  'flowLag1h', 'flowLag24h', 'flowLag168h',
  'flowRolling24h', 'flowVolatility24h',
  'congestionLag1h', 'congestionLag24h',
  'congestionCount24h', 'congestionCount168h'
];

export function buildInterconnectorFeatures(
  datetime: Date,
  interconnector: string,
  demandData: Map<string, number>,
  weatherData: Map<string, any>,
  flowHistory: Map<string, number>,
  congestionHistory: Map<string, boolean>
): number[] {
  const dt = DateTime.fromJSDate(datetime);
  const features: number[] = [];

  // Temporal features
  const hour = dt.hour;
  const dayOfWeek = dt.weekday % 7;
  const month = dt.month;

  features.push(
    hour,
    dayOfWeek,
    dayOfWeek >= 5 ? 1 : 0,  // isWeekend
    PH_HOLIDAYS_2025.includes(dt.toISODate()!) ? 1 : 0,  // isHoliday
    dt.day,
    month,
    Math.sin(2 * Math.PI * hour / 24),
    Math.cos(2 * Math.PI * hour / 24),
    Math.sin(2 * Math.PI * dayOfWeek / 7),
    Math.cos(2 * Math.PI * dayOfWeek / 7)
  );

  // Demand features
  const demandCLUZ = demandData.get('CLUZ') || 0;
  const demandCVIS = demandData.get('CVIS') || 0;
  const demandCMIN = demandData.get('CMIN') || 0;
  const demandTotal = demandCLUZ + demandCVIS + demandCMIN;

  features.push(
    demandCLUZ,
    demandCVIS,
    demandCMIN,
    demandTotal,
    demandCLUZ > 0 ? demandCVIS / demandCLUZ : 0,
    demandCVIS > 0 ? demandCMIN / demandCVIS : 0,
    demandCLUZ > 0 ? demandCMIN / demandCLUZ : 0,
    demandCVIS - demandCLUZ,
    demandCMIN - demandCVIS
  );

  // Weather features
  const weatherCLUZ = weatherData.get('CLUZ') || { temp: 0, windspeed: 0, solarradiation: 0 };
  const weatherCVIS = weatherData.get('CVIS') || { temp: 0, windspeed: 0, solarradiation: 0 };
  const weatherCMIN = weatherData.get('CMIN') || { temp: 0, windspeed: 0, solarradiation: 0 };

  features.push(
    weatherCLUZ.temp,
    weatherCVIS.temp,
    weatherCMIN.temp,
    weatherCVIS.temp - weatherCLUZ.temp,
    weatherCMIN.temp - weatherCVIS.temp,
    weatherCLUZ.windspeed,
    weatherCVIS.windspeed,
    weatherCMIN.windspeed,
    weatherCLUZ.solarradiation,
    weatherCVIS.solarradiation,
    weatherCMIN.solarradiation,
    (weatherCLUZ.temp + weatherCVIS.temp + weatherCMIN.temp) / 3
  );

  // Flow lag features
  const ts = datetime.getTime();
  const key = (offset: number) => `${ts - offset}_${interconnector}`;

  const flowLag1h = flowHistory.get(key(3600000)) || 0;
  const flowLag24h = flowHistory.get(key(86400000)) || 0;
  const flowLag168h = flowHistory.get(key(604800000)) || 0;

  // Rolling average and volatility
  const last24Flows: number[] = [];
  for (let i = 1; i <= 24; i++) {
    const flow = flowHistory.get(key(i * 3600000));
    if (flow !== undefined) last24Flows.push(flow);
  }

  const flowRolling24h = last24Flows.length > 0
    ? last24Flows.reduce((a, b) => a + b, 0) / last24Flows.length
    : 0;

  const flowVolatility24h = last24Flows.length > 1
    ? Math.sqrt(last24Flows.reduce((sum, val) => sum + Math.pow(val - flowRolling24h, 2), 0) / last24Flows.length)
    : 0;

  // Congestion lags
  const congestionLag1h = congestionHistory.get(key(3600000)) ? 1 : 0;
  const congestionLag24h = congestionHistory.get(key(86400000)) ? 1 : 0;

  // Congestion counts
  let congestionCount24h = 0;
  let congestionCount168h = 0;
  for (let i = 1; i <= 168; i++) {
    if (congestionHistory.get(key(i * 3600000))) {
      congestionCount168h++;
      if (i <= 24) congestionCount24h++;
    }
  }

  features.push(
    flowLag1h,
    flowLag24h,
    flowLag168h,
    flowRolling24h,
    flowVolatility24h,
    congestionLag1h,
    congestionLag24h,
    congestionCount24h,
    congestionCount168h
  );

  return features;
}

export { FEATURE_NAMES };
```

**Acceptance Criteria**:
- Feature extraction produces correct array length
- All features normalized appropriately
- Lag features handle missing data
- Cyclic encoding correct for hour/day

---

### Task 6: ML Model Implementation

**File**: `src/models/interconnector/InterconnectorCongestionModel.ts` (new)

**Actions**:
1. Implement classification model for congestion
2. Implement regression model for flow
3. Implement training with train/validation split
4. Implement prediction with confidence
5. Implement serialization/deserialization
6. Calculate evaluation metrics

**Note**: Use existing `ml-regression-multivariate-linear` for regression, implement simple logistic regression for classification

**Acceptance Criteria**:
- Model trains successfully
- Predictions within expected ranges
- Serialization round-trip works
- Metrics calculated correctly

---

### Task 7: CLI Commands

**File**: `src/index.ts`

**Actions**:
1. Create `interconnector` command group
2. Add `import` subcommand
3. Add `stats` subcommand
4. Add `train` subcommand
5. Add `forecast` subcommand

**Implementation Outline**:
```typescript
// Add this after outage commands

const interconnectorCmd = program
  .command('interconnector')
  .description('Interconnector constraint analysis and forecasting');

// IMPORT command
interconnectorCmd
  .command('import')
  .description('Import RTDHS interconnector data into database')
  .requiredOption('-f, --file <path>', 'RTDHS CSV file or directory')
  .option('--start <date>', 'Start date YYYY-MM-DD (for directory import)')
  .option('--end <date>', 'End date YYYY-MM-DD (for directory import)')
  .action(async (options) => {
    console.log('\n🔄 Importing interconnector data...');

    try {
      const data = parseInterconnectorCsv(options.file, (msg) => console.log(`  ${msg}`));

      console.log(`\n📊 Parsed ${data.records.length} records`);
      console.log(`  Interconnectors: ${data.interconnectors.join(', ')}`);
      console.log(`  Date range: ${DateTime.fromJSDate(data.startDate).toISODate()} to ${DateTime.fromJSDate(data.endDate).toISODate()}`);
      console.log(`  Congestion events: ${data.totalCongestionEvents}`);

      const db = getDatabase();
      const result = db.importInterconnectorRecords(data.records, options.file);
      closeDatabase();

      console.log(`\n✅ Import complete!`);
      console.log(`  Inserted: ${result.inserted} records`);
    } catch (error: any) {
      console.error(`\n❌ Error: ${error.message}`);
      process.exit(1);
    }
  });

// STATS command
interconnectorCmd
  .command('stats')
  .description('Display interconnector statistics and congestion history')
  .option('-i, --interconnector <name>', 'Filter by interconnector (MINVIS1, VISLUZ1)')
  .option('--start <date>', 'Start date YYYY-MM-DD')
  .option('--end <date>', 'End date YYYY-MM-DD')
  .action(async (options) => {
    console.log('\n📊 Interconnector Statistics\n');

    try {
      const db = getDatabase();
      const stats = db.getInterconnectorStats(
        options.interconnector,
        options.start,
        options.end
      );
      closeDatabase();

      for (const stat of stats) {
        console.log(`\n${stat.interconnector}:`);
        console.log(`  Total records: ${stat.totalRecords}`);
        console.log(`  Congestion events: ${stat.congestionEvents}`);
        console.log(`  Congestion rate: ${(stat.congestionRate * 100).toFixed(2)}%`);
        console.log(`  Average flow (from): ${stat.avgFlowFrom.toFixed(2)} MW`);
        console.log(`  Average flow (to): ${stat.avgFlowTo.toFixed(2)} MW`);
        console.log(`  Peak flow (from): ${stat.peakFlowFrom.toFixed(2)} MW`);
        console.log(`  Peak flow (to): ${stat.peakFlowTo.toFixed(2)} MW`);
        console.log(`  Date range: ${stat.dateRange.start} to ${stat.dateRange.end}`);
      }
    } catch (error: any) {
      console.error(`\n❌ Error: ${error.message}`);
      process.exit(1);
    }
  });

// TRAIN command
interconnectorCmd
  .command('train')
  .description('Train congestion prediction model')
  .option('--start <date>', 'Training start date YYYY-MM-DD')
  .option('--end <date>', 'Training end date YYYY-MM-DD')
  .option('-i, --interconnector <name>', 'Train for specific interconnector (default: both)')
  .option('-o, --output <dir>', 'Output directory for reports', './output')
  .action(async (options) => {
    console.log('\n🔄 Training interconnector congestion model...\n');

    try {
      const db = getDatabase();

      // Load interconnector data
      const interconnectorRecords = db.getInterconnectorRecords(
        options.start,
        options.end,
        options.interconnector
      );

      // Load demand data
      const demandRecords = db.getDemandRecords(options.start, options.end);

      // Load weather data
      const weatherRecords = db.getWeatherRecords(options.start, options.end);

      closeDatabase();

      console.log(`  Interconnector records: ${interconnectorRecords.length}`);
      console.log(`  Demand records: ${demandRecords.length}`);
      console.log(`  Weather records: ${weatherRecords.length}`);

      // Build training samples
      console.log('\n🔧 Building training samples...');
      // ... (feature engineering logic)

      // Train model
      console.log('\n🎯 Training model...');
      const model = new InterconnectorCongestionModel();
      const metrics = model.train(samples);

      console.log(`\n✅ Training complete!`);
      console.log(`  Accuracy: ${(metrics.accuracy * 100).toFixed(2)}%`);
      console.log(`  Precision: ${(metrics.precision * 100).toFixed(2)}%`);
      console.log(`  Recall: ${(metrics.recall * 100).toFixed(2)}%`);
      console.log(`  F1 Score: ${(metrics.f1Score * 100).toFixed(2)}%`);
      console.log(`  Flow MAPE: ${metrics.mape.toFixed(2)}%`);

      // Save model to database
      const db2 = getDatabase();
      const modelId = db2.saveInterconnectorModel(
        `Interconnector ${DateTime.now().toFormat('yyyy-MM-dd HH:mm')}`,
        options.start || 'all',
        options.end || 'all',
        samples.length,
        metrics,
        model.serialize()
      );
      closeDatabase();

      console.log(`  💾 Saved to database (ID: ${modelId})`);
    } catch (error: any) {
      console.error(`\n❌ Error: ${error.message}`);
      process.exit(1);
    }
  });

// FORECAST command
interconnectorCmd
  .command('forecast')
  .description('Forecast interconnector congestion probability')
  .requiredOption('-s, --start <date>', 'Forecast start date YYYY-MM-DD')
  .requiredOption('-e, --end <date>', 'Forecast end date YYYY-MM-DD')
  .requiredOption('-o, --output <file>', 'Output forecast CSV file')
  .option('--use-saved', 'Use saved model from database')
  .option('--demand-forecast <file>', 'Use demand forecast CSV')
  .action(async (options) => {
    console.log('\n🔄 Generating interconnector congestion forecast...\n');

    try {
      // Load model
      const db = getDatabase();
      const savedModel = db.getActiveInterconnectorModel();
      closeDatabase();

      if (!savedModel) {
        console.error('❌ No saved model found. Train a model first.');
        process.exit(1);
      }

      const model = InterconnectorCongestionModel.deserialize(savedModel.modelData);

      // Load demand forecast or historical demand
      // Load weather forecast
      // Generate predictions
      // Write to CSV

      console.log('\n✅ Forecast complete!');
      console.log(`  Output: ${options.output}`);
    } catch (error: any) {
      console.error(`\n❌ Error: ${error.message}`);
      process.exit(1);
    }
  });
```

**Acceptance Criteria**:
- All commands run without errors
- Help text displays correctly
- Options parsed correctly
- Progress indicators show
- Error handling works

---

### Task 8: Documentation

**Files to Create/Update**:
1. Update `README.md` - Add interconnector section
2. Update `CLAUDE.md` - Add interconnector info
3. Create `Documents/INTERCONNECTOR_USER_GUIDE.md`

**Documentation Sections**:
- Overview of interconnector prediction
- Data sources and formats
- CLI command reference
- Interpretation guide
- Example workflows
- Troubleshooting

**Acceptance Criteria**:
- All documentation complete
- Examples tested and working
- Screenshots/diagrams included
- Links correct

---

## 6. Data Flow

```
RTDHS CSV Files (Z:\WESM FILES\RTDHS\)
  ↓
interconnectorParser.ts (parse)
  ↓
InterconnectorRecord[]
  ↓
DatabaseService.importInterconnectorRecords()
  ↓
SQLite Database (interconnector_records table)
  ↓
[TRAINING PATH]
  ↓
Query: interconnector + demand + weather data
  ↓
interconnectorFeatures.ts (build training samples)
  ↓
InterconnectorTrainingSample[]
  ↓
InterconnectorCongestionModel.train()
  ↓
Evaluate metrics (accuracy, precision, recall, F1, MAPE)
  ↓
Serialize model → database (interconnector_models table)
  ↓
[FORECASTING PATH]
  ↓
Load model from database
  ↓
Query: demand forecast + weather forecast
  ↓
Build feature vectors for forecast period
  ↓
InterconnectorCongestionModel.predict() for each timestep
  ↓
InterconnectorCongestionPrediction[]
  ↓
Write to CSV
  ↓
Output: Forecast with congestion probability, expected flow, confidence
```

---

## 7. File Structure

```
src/
├── database/
│   ├── schema.ts              [MODIFY] Add interconnector tables, bump version to 3
│   ├── database.ts            [MODIFY] Add interconnector methods
│   └── index.ts               [MODIFY] Export new types
│
├── parsers/
│   ├── interconnectorParser.ts [CREATE] Parse RTDHS files
│   └── index.ts               [MODIFY] Export interconnector parser
│
├── types/
│   ├── interconnector.ts      [CREATE] Type definitions
│   └── index.ts               [MODIFY] Re-export interconnector types
│
├── models/
│   └── interconnector/
│       ├── InterconnectorCongestionModel.ts [CREATE] Main model
│       └── index.ts           [CREATE] Exports
│
├── features/
│   └── interconnectorFeatures.ts [CREATE] Feature engineering
│
├── services/
│   └── interconnectorService.ts [CREATE] Business logic (optional)
│
├── writers/
│   └── interconnectorWriter.ts [CREATE] CSV output formatting (optional)
│
└── index.ts                   [MODIFY] Add CLI commands

Documents/
└── INTERCONNECTOR_USER_GUIDE.md [CREATE] User documentation

README.md                      [MODIFY] Add interconnector section
CLAUDE.md                      [MODIFY] Add interconnector info
```

---

## 8. Testing Strategy

**User will perform all testing as per development guidelines**

### Test Data Preparation
1. Extract 1 month of RTDHS data from `Z:\WESM FILES\RTDHS\`
2. Ensure corresponding demand and weather data available in database

### Manual Test Cases

#### TC1: Import Single File
```bash
iload interconnector import -f "Z:\WESM FILES\RTDHS\RTDHS_20250701.csv"
```
**Expected**: File imported, statistics displayed, no errors

#### TC2: Import Directory
```bash
iload interconnector import -f "Z:\WESM FILES\RTDHS\" --start 2025-07-01 --end 2025-07-31
```
**Expected**: Multiple files imported, deduplicated, statistics correct

#### TC3: View Statistics
```bash
iload interconnector stats
iload interconnector stats -i MINVIS1
iload interconnector stats --start 2025-07-01 --end 2025-07-31
```
**Expected**: Accurate congestion rates, flow statistics, date ranges

#### TC4: Train Model
```bash
iload interconnector train --start 2025-07-01 --end 2025-07-31 -o ./output
```
**Expected**: Model trains, metrics > 70% accuracy, saved to database

#### TC5: Generate Forecast
```bash
iload interconnector forecast -s 2025-08-01 -e 2025-08-07 -o forecast_interconnector.csv --use-saved
```
**Expected**: Forecast CSV generated with probabilities and flows

### Validation Criteria
- **Import**: No data loss, correct deduplication
- **Stats**: Congestion rate matches manual calculation
- **Model**: Accuracy > 70%, Precision > 70%, Recall > 60%
- **Forecast**: Reasonable probabilities (0-100%), flows within capacity

---

## 9. Documentation

### User Documentation

**File**: `Documents/INTERCONNECTOR_USER_GUIDE.md`

**Sections**:
1. Introduction to Interconnector Prediction
2. Data Requirements and Sources
3. Installation and Setup
4. Importing RTDHS Data
5. Viewing Statistics and Analysis
6. Training Prediction Models
7. Generating Forecasts
8. Interpreting Results
9. Advanced Usage
10. Troubleshooting

### Developer Documentation

**Update**: `CLAUDE.md` and README.md

**Add**:
- Interconnector command reference
- Database schema additions
- Model architecture overview
- Feature engineering details
- API reference for new functions

---

## 10. Timeline

### Phase 1: Foundation (2-3 hours)
- Task 1: Database schema extension
- Task 2: Type definitions
- Task 3: CSV parser implementation

### Phase 2: Core Logic (3-4 hours)
- Task 4: Database service extension
- Task 5: Feature engineering
- Task 6: ML model implementation

### Phase 3: Integration (2-3 hours)
- Task 7: CLI commands
- Testing and debugging

### Phase 4: Documentation (1-2 hours)
- Task 8: User documentation
- Update existing docs

**Total Estimated Time**: 8-12 hours of development

---

## Appendix A: Sample RTDHS Data

```csv
RUN_TIME,MKT_TYPE,TIME_INTERVAL,HVDC_NAME,CONGESTION_FLAG,FLOW_FROM,FLOW_TO,OVERLOAD_MW
7/1/2025,RTD,7/1/2025 12:05:00 AM,MINVIS1,Y,450,-450,,
7/1/2025,RTD,7/1/2025 12:05:00 AM,VISLUZ1,N,361.15,-361.15,,
7/1/2025,RTD,7/1/2025 12:10:00 AM,MINVIS1,Y,450,-450,,
7/1/2025,RTD,7/1/2025 12:10:00 AM,VISLUZ1,N,357.82,-357.82,,
7/1/2025,RTD,7/1/2025 12:15:00 AM,MINVIS1,Y,450,-450,,
7/1/2025,RTD,7/1/2025 12:15:00 AM,VISLUZ1,N,354.49,-354.49,,
```

---

## Appendix B: Feature Importance (Expected)

Based on electrical engineering principles and grid operations:

**High Importance** (>10% contribution):
1. Regional demand differentials (demand_diff_CV, demand_diff_CM)
2. Demand ratios (demand_ratio_CV, demand_ratio_CM)
3. Hour of day (hour, hourSin, hourCos)
4. Flow lag features (flowLag1h, flowLag24h)
5. Historical congestion (congestionLag1h, congestionCount24h)

**Medium Importance** (5-10%):
6. Temperature differentials (tempDiff_CV, tempDiff_CM)
7. Day of week (dayOfWeek)
8. Total demand (demandTotal)
9. Flow volatility (flowVolatility24h)

**Low Importance** (<5%):
10. Individual regional demands (less predictive than differentials)
11. Solar radiation (indirect effect)
12. Absolute temperature values

---

## Appendix C: Success Metrics

### Classification Performance Targets
- **Accuracy**: > 80%
- **Precision**: > 75% (minimize false congestion alarms)
- **Recall**: > 70% (catch most congestion events)
- **F1 Score**: > 0.72

### Regression Performance Targets
- **R² Score**: > 0.85
- **MAPE**: < 8%
- **MAE**: < 30 MW
- **RMSE**: < 50 MW

### Operational Targets
- **Import Speed**: > 10,000 records/second
- **Training Time**: < 5 minutes for 6 months of data
- **Forecast Generation**: < 1 minute for 7-day forecast

---

## Appendix D: Future Enhancements

### Short-term (v1.1)
1. Add hourly congestion heatmaps
2. Implement congestion duration prediction
3. Add price separation estimation
4. Create visualization dashboards

### Medium-term (v1.2)
1. Real-time prediction API
2. Ensemble methods (combine multiple models)
3. Causal analysis of congestion events
4. Integration with unit commitment optimization

### Long-term (v2.0)
1. Deep learning models (LSTM for sequence prediction)
2. Probabilistic forecasting with confidence intervals
3. Multi-horizon forecasting (5-min, hourly, daily)
4. Transfer learning for new interconnectors

---

## Document Control

**Version**: 1.0
**Date**: 2025-12-11
**Author**: Task Manager AI
**Status**: Ready for Implementation
**Next Review**: After Phase 1 completion

---

## Sign-off

This implementation plan has been reviewed and approved for execution. All tasks are clearly defined with acceptance criteria. The architecture follows existing codebase patterns and best practices.

**Ready to proceed with implementation.**
