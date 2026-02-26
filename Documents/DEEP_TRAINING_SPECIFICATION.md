# Deep Training System Specification

**Document Version:** 1.0
**Date:** 2026-02-26
**Status:** Proposal / Future Development
**Author:** Development Team

---

## Executive Summary

This document specifies a **Deep Training** system for the Vantage Forecaster application. Unlike the current auto-calibration (which runs quickly at forecast time), Deep Training is an intensive, periodic optimization process that discovers the best forecasting approach for each station (CFAC) or zone (Demand).

**Key Goals:**
- Achieve the best possible MAPE for each target (station/zone)
- Generate and evolve algorithms, not just tune parameters
- Save winning configurations for reuse during forecasting
- Provide version control so users can compare and roll back models
- Allow user-configurable MAPE thresholds and attempt limits

---

## Table of Contents

1. [Concept Overview](#1-concept-overview)
2. [Deep Train vs Auto-Train Comparison](#2-deep-train-vs-auto-train-comparison)
3. [Algorithm Generation Strategy](#3-algorithm-generation-strategy)
4. [Pros and Cons Analysis](#4-pros-and-cons-analysis)
5. [Technical Architecture](#5-technical-architecture)
6. [Database Schema](#6-database-schema)
7. [User Interface Design](#7-user-interface-design)
8. [Evolution Strategy](#8-evolution-strategy)
9. [Stopping Criteria](#9-stopping-criteria)
10. [Cross-Validation Strategy](#10-cross-validation-strategy)
11. [Implementation Phases](#11-implementation-phases)
12. [Open Questions](#12-open-questions)
13. [Appendix: Acceptable MAPE Thresholds](#appendix-acceptable-mape-thresholds)

---

## 1. Concept Overview

### Current State (Auto-Train)

The current system uses auto-calibration at forecast time:
- Calculates scale factors from recent data (default: 14 days before forecast)
- Applies global bias correction for wind/solar
- Per-hour solar scaling
- Per-station scaling for non-wind types
- Fast (~seconds), runs every forecast

**Limitation:** Fixed algorithm, only calibration factors are adjusted.

### Proposed State (Deep Train)

A separate, intensive training mode that:
- Runs periodically (weekly, monthly, or on-demand)
- Tests many different algorithmic approaches
- Evolves successful approaches further
- Saves winning configurations to database
- Provides model versioning and comparison

**Key Difference:** Generates and tests different algorithms, not just parameters.

---

## 2. Deep Train vs Auto-Train Comparison

| Aspect | Auto-Train (Current) | Deep Train (Proposed) |
|--------|---------------------|----------------------|
| **Purpose** | Quick calibration | Full optimization |
| **When** | Every forecast run | Periodic (weekly/monthly) |
| **Duration** | Seconds | Hours to days |
| **Scope** | Scale factors only | Full model + config |
| **Output** | Calibration factors | Trained model artifact |
| **Persistence** | Session-only | Database (versioned) |
| **User Control** | Minimal | Full (threshold, attempts, time) |
| **Algorithm** | Fixed | Generated/evolved |
| **Per-Target** | Global or per-type | Per-station / per-zone |

### Workflow Comparison

**Auto-Train Flow:**
```
Forecast Request → Load Data → Auto-Calibrate (seconds) → Generate Forecast
```

**Deep Train Flow:**
```
Deep Train Request → Load Data → Generate Algorithms → Test Each →
Evolve Winners → Repeat Until Threshold → Save Best Model
...
(Later)
Forecast Request → Load Saved Model → Generate Forecast (fast)
```

---

## 3. Algorithm Generation Strategy

### What Can Be Generated?

Deep Training doesn't just tune hyperparameters - it generates complete forecasting pipelines by combining building blocks.

#### 3.1 Feature Combinations

Different stations may benefit from different input features:

```
Feature Set A (Minimal):
  - windspeed
  - temperature

Feature Set B (Standard):
  - windspeed, windgust, winddir
  - temperature, dew
  - cloudcover, precipitation
  - solarradiation

Feature Set C (Extended):
  - All of B plus:
  - humidity (derived)
  - heat_index (derived)
  - wind_chill (derived)

Feature Set D (Derived/Interaction):
  - windspeed * temperature
  - windgust / windspeed (gust ratio)
  - cloudcover * solarradiation
  - hour_sin, hour_cos (cyclical)

Feature Set E (Lagged):
  - temperature_lag_1h, temperature_lag_24h
  - windspeed_lag_1h, windspeed_lag_24h
  - demand_lag_24h, demand_lag_168h (for demand)
```

#### 3.2 Model Architectures

Multiple model types to try:

| Model Type | Description | Best For |
|------------|-------------|----------|
| Linear Regression | Simple, interpretable | Stable patterns |
| Ridge/Lasso | Regularized linear | Many features |
| XGBoost | Gradient boosting | Non-linear patterns |
| Random Forest | Ensemble of trees | Robust, low overfit |
| Physics Model | Domain equations | Solar irradiance |
| Profile Model | Historical averages | Hydro, geothermal |
| Hybrid (Physics + ML) | Physics base + ML residual | Solar, wind |
| Stacked Ensemble | Multiple models combined | Best accuracy |

#### 3.3 Training Strategies

Different ways to use the training data:

| Strategy | Description | Use Case |
|----------|-------------|----------|
| All Data | Use entire training history | Stable patterns |
| Recent Only | Last 30/60/90 days | Changing patterns |
| Weighted | Exponential decay on older data | Gradual drift |
| Seasonal Split | Separate dry/wet season models | Seasonal variation |
| Time-of-Day Split | Separate day/night models | Diurnal patterns |
| Rolling Window | Retrain with sliding window | Continuous drift |

#### 3.4 Calibration Methods

Post-model corrections:

| Method | Description |
|--------|-------------|
| None | Raw model output |
| Global Bias | Single scale factor |
| Per-Hour | Different factor for each hour |
| Per-Station | Different factor for each station |
| Weather-Conditional | Factor depends on weather state |
| Adaptive Rolling | Factor from recent N days |

#### 3.5 Hyperparameter Spaces

For XGBoost (example):
```json
{
  "learning_rate": [0.01, 0.05, 0.1, 0.2],
  "max_depth": [3, 5, 7, 10],
  "n_estimators": [50, 100, 200, 500],
  "subsample": [0.7, 0.8, 0.9, 1.0],
  "colsample_bytree": [0.7, 0.8, 0.9, 1.0],
  "min_child_weight": [1, 3, 5, 10]
}
```

For Physics Model (solar):
```json
{
  "panel_efficiency": [0.15, 0.18, 0.20, 0.22],
  "temperature_coefficient": [-0.004, -0.003, -0.002],
  "dust_factor": [0.95, 0.97, 0.99],
  "tracking_type": ["fixed", "single_axis", "dual_axis"]
}
```

### Pipeline Specification Format

A complete algorithm is represented as a JSON pipeline:

```json
{
  "pipeline_id": "solar_hybrid_v3",
  "target": "01SNMANUEL_S",
  "stages": [
    {
      "stage": "features",
      "type": "feature_set",
      "config": {
        "base_features": ["solarradiation", "temperature", "cloudcover"],
        "derived_features": ["clear_sky_index"],
        "lag_features": ["solarradiation_lag_1h"]
      }
    },
    {
      "stage": "base_model",
      "type": "physics_solar",
      "config": {
        "panel_efficiency": 0.18,
        "include_temperature_derating": true
      }
    },
    {
      "stage": "residual_model",
      "type": "xgboost",
      "config": {
        "learning_rate": 0.1,
        "max_depth": 5,
        "n_estimators": 100
      }
    },
    {
      "stage": "calibration",
      "type": "per_hour",
      "config": {
        "hours": [6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18],
        "method": "rolling_14_day"
      }
    }
  ],
  "training": {
    "strategy": "recent_90_days",
    "validation_split": 0.2,
    "cross_validation_folds": 5
  }
}
```

---

## 4. Pros and Cons Analysis

### Pros

| Advantage | Description |
|-----------|-------------|
| **Best Accuracy** | Exhaustive search finds optimal config per target |
| **No One-Size-Fits-All** | Each station/zone gets customized approach |
| **Discovery** | Can find non-obvious combinations that work |
| **Fast Forecasting** | Heavy compute done once; forecasting is fast |
| **Versioning** | Compare models, roll back if needed |
| **Auditability** | Full log of what was tried and why |
| **Adaptability** | Retrain when patterns change |
| **Transparency** | User sees evolution of accuracy |

### Cons

| Challenge | Description | Mitigation |
|-----------|-------------|------------|
| **Compute Time** | Hours to days for full optimization | Parallelization, smart pruning, time limits |
| **Overfitting Risk** | May overfit to validation data | Robust CV, held-out test set |
| **Combinatorial Explosion** | Too many combinations to try all | Genetic algorithms, Bayesian optimization |
| **Storage** | Many models to store and manage | Cleanup policies, compression |
| **Complexity** | Harder to debug when things go wrong | Detailed logging, trial records |
| **Validation Selection** | What period to validate against? | Multiple periods, seasonal holdout |
| **Algorithm Validity** | Generated algorithms may be nonsensical | Constrained building blocks |

---

## 5. Technical Architecture

### System Components

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         DEEP TRAINING SYSTEM                            │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐              │
│  │   Pipeline   │    │   Training   │    │  Evaluation  │              │
│  │  Generator   │───▶│   Engine     │───▶│   Engine     │              │
│  └──────────────┘    └──────────────┘    └──────────────┘              │
│         │                   │                   │                       │
│         │                   │                   │                       │
│         ▼                   ▼                   ▼                       │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐              │
│  │  Building    │    │   Model      │    │   Metrics    │              │
│  │  Blocks      │    │   Registry   │    │   Store      │              │
│  └──────────────┘    └──────────────┘    └──────────────┘              │
│                                                                         │
│  ┌──────────────────────────────────────────────────────────┐          │
│  │                    Evolution Controller                   │          │
│  │  - Mutation strategies                                    │          │
│  │  - Crossover operators                                    │          │
│  │  - Selection criteria                                     │          │
│  │  - Stopping conditions                                    │          │
│  └──────────────────────────────────────────────────────────┘          │
│                                                                         │
│  ┌──────────────────────────────────────────────────────────┐          │
│  │                    Persistence Layer                      │          │
│  │  - Model storage (SQLite / files)                        │          │
│  │  - Trial history                                          │          │
│  │  - Configuration management                               │          │
│  └──────────────────────────────────────────────────────────┘          │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### Component Responsibilities

#### Pipeline Generator
- Creates new pipeline configurations
- Implements mutation operators (change one component)
- Implements crossover operators (combine two pipelines)
- Ensures generated pipelines are valid

#### Training Engine
- Executes a pipeline configuration
- Manages training data loading and preprocessing
- Handles feature engineering
- Trains models according to pipeline spec

#### Evaluation Engine
- Calculates MAPE on validation data
- Calculates MAPE on held-out test data
- Computes additional metrics (MAE, RMSE, bias)
- Handles cross-validation

#### Evolution Controller
- Orchestrates the optimization process
- Decides which pipelines to keep, mutate, or discard
- Implements stopping criteria
- Manages the population of candidate pipelines

#### Model Registry
- Stores trained model artifacts
- Manages model versions
- Handles model activation/deactivation
- Supports model comparison

#### Building Blocks
- Library of feature sets
- Library of model types
- Library of calibration methods
- Library of training strategies

---

## 6. Database Schema

### Core Tables

```sql
-- ============================================================
-- DEEP TRAINING DATABASE SCHEMA
-- ============================================================

-- Stores trained models for each target (station/zone)
CREATE TABLE deep_train_models (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  -- Target identification
  target_type TEXT NOT NULL,           -- 'cfac_station' or 'demand_zone'
  target_code TEXT NOT NULL,           -- '01BURGOS' or '01NLUZ'
  station_type TEXT,                   -- 'wind', 'solar', etc. (for CFAC)

  -- Version tracking
  model_version INTEGER NOT NULL,      -- Auto-increment per target
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  created_by TEXT,                     -- User or 'auto'

  -- Training metadata
  training_start DATE NOT NULL,
  training_end DATE NOT NULL,
  validation_start DATE,
  validation_end DATE,
  test_start DATE,                     -- Held-out test period
  test_end DATE,

  -- Performance metrics
  validation_mape REAL NOT NULL,
  test_mape REAL,                      -- May be NULL if no test data
  validation_mae REAL,
  validation_rmse REAL,
  validation_bias REAL,                -- Systematic over/under prediction

  -- Configuration
  pipeline_json TEXT NOT NULL,         -- Full pipeline specification
  hyperparameters_json TEXT,           -- Winning hyperparameters
  feature_importance_json TEXT,        -- Which features mattered most

  -- Model artifact
  model_blob BLOB,                     -- Serialized model (if small)
  model_path TEXT,                     -- File path (if large)
  model_size_bytes INTEGER,

  -- Training process info
  trials_attempted INTEGER,
  training_duration_seconds INTEGER,
  convergence_generation INTEGER,      -- Which generation found this

  -- Status
  is_active BOOLEAN DEFAULT FALSE,     -- Currently used for forecasting
  is_archived BOOLEAN DEFAULT FALSE,   -- Soft delete

  -- Notes
  notes TEXT,

  UNIQUE(target_type, target_code, model_version)
);

-- Index for quick lookups
CREATE INDEX idx_models_target ON deep_train_models(target_type, target_code);
CREATE INDEX idx_models_active ON deep_train_models(is_active) WHERE is_active = TRUE;


-- Stores individual trial results during deep training
CREATE TABLE deep_train_trials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  -- Link to training session
  session_id TEXT NOT NULL,            -- Groups trials from one deep train run
  target_type TEXT NOT NULL,
  target_code TEXT NOT NULL,

  -- Trial identification
  trial_number INTEGER NOT NULL,
  generation INTEGER,                  -- For genetic algorithm
  parent_trial_id INTEGER,             -- Which trial was mutated (if any)

  -- Configuration tried
  pipeline_json TEXT NOT NULL,

  -- Results
  validation_mape REAL,
  training_mape REAL,
  duration_ms INTEGER,

  -- Status
  status TEXT NOT NULL,                -- 'success', 'failed', 'timeout'
  error_message TEXT,

  -- Decision
  decision TEXT,                       -- 'selected', 'rejected', 'evolved'
  decision_reason TEXT,

  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_trials_session ON deep_train_trials(session_id);
CREATE INDEX idx_trials_target ON deep_train_trials(target_type, target_code);


-- Stores deep training session metadata
CREATE TABLE deep_train_sessions (
  id TEXT PRIMARY KEY,                 -- UUID

  -- Session configuration
  target_type TEXT NOT NULL,           -- 'cfac' or 'demand'
  target_codes_json TEXT,              -- List of targets (NULL = all)

  -- User settings
  mape_threshold REAL NOT NULL,
  max_attempts INTEGER NOT NULL,
  time_limit_seconds INTEGER,
  strategy TEXT NOT NULL,              -- 'quick', 'thorough', 'exhaustive'

  -- Validation period
  validation_start DATE NOT NULL,
  validation_end DATE NOT NULL,

  -- Progress
  status TEXT NOT NULL,                -- 'running', 'completed', 'cancelled', 'failed'
  started_at TIMESTAMP,
  completed_at TIMESTAMP,

  -- Results summary
  targets_processed INTEGER DEFAULT 0,
  targets_met_threshold INTEGER DEFAULT 0,
  total_trials INTEGER DEFAULT 0,

  -- Error info
  error_message TEXT,

  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);


-- Stores building block definitions (feature sets, model configs, etc.)
CREATE TABLE deep_train_building_blocks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  block_type TEXT NOT NULL,            -- 'feature_set', 'model', 'calibration', 'training'
  block_name TEXT NOT NULL,

  config_json TEXT NOT NULL,           -- Block configuration

  -- Metadata
  description TEXT,
  recommended_for TEXT,                -- 'wind', 'solar', 'demand', 'all'

  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  UNIQUE(block_type, block_name)
);
```

### Example Data

```sql
-- Example: Saved model for wind station
INSERT INTO deep_train_models (
  target_type, target_code, station_type, model_version,
  training_start, training_end, validation_start, validation_end,
  validation_mape, test_mape,
  pipeline_json, trials_attempted, training_duration_seconds, is_active
) VALUES (
  'cfac_station', '01BURGOS', 'wind', 1,
  '2025-07-01', '2025-12-31', '2026-01-01', '2026-01-14',
  38.2, 41.1,
  '{"stages":[{"stage":"features","type":"wind_extended"},{"stage":"base_model","type":"mrec_4tier"},{"stage":"residual_model","type":"xgboost","config":{"max_depth":5}}]}',
  87, 324, TRUE
);

-- Example: Trial record
INSERT INTO deep_train_trials (
  session_id, target_type, target_code, trial_number, generation,
  pipeline_json, validation_mape, duration_ms, status, decision, decision_reason
) VALUES (
  'session-2026-02-26-001', 'cfac_station', '01BURGOS', 23, 3,
  '{"stages":[{"stage":"base_model","type":"xgboost","config":{"max_depth":7}}]}',
  42.5, 2340, 'success', 'rejected', 'MAPE worse than current best (38.2%)'
);
```

---

## 7. User Interface Design

### 7.1 Deep Training Launch Panel

```
┌─────────────────────────────────────────────────────────────────────────┐
│ Deep Training                                                    [?]    │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│ Target Type:                                                            │
│   (●) CFAC Stations    ( ) Demand Zones                                │
│                                                                         │
│ Targets:                                                                │
│   [✓] Select All    [ ] Select Specific...                             │
│                                                                         │
│ ┌─────────────────────────────────────────────────────────────────────┐│
│ │ Selected: 47 stations (12 wind, 28 solar, 7 other)                 ││
│ └─────────────────────────────────────────────────────────────────────┘│
│                                                                         │
│ ─────────────────────────────────────────────────────────────────────  │
│ Optimization Settings                                                   │
│ ─────────────────────────────────────────────────────────────────────  │
│                                                                         │
│ Target MAPE:         [    15    ] %   (acceptable threshold)           │
│                      ℹ️ Wind typically achieves 40-60%, Solar 15-25%    │
│                                                                         │
│ Max Attempts:        [   100    ]     per target                       │
│                                                                         │
│ Time Limit:          [   300    ] seconds per target (0 = unlimited)   │
│                                                                         │
│ Strategy:                                                               │
│   ( ) Quick      - Basic models, limited hyperparameters (~2 min/target)│
│   (●) Thorough   - All models, moderate tuning (~10 min/target)        │
│   ( ) Exhaustive - Full search, genetic evolution (~1 hour/target)     │
│                                                                         │
│ ─────────────────────────────────────────────────────────────────────  │
│ Validation Period                                                       │
│ ─────────────────────────────────────────────────────────────────────  │
│                                                                         │
│ Validation:    [2026-01-01] to [2026-01-31]                            │
│ Held-out Test: [2026-02-01] to [2026-02-14]  (never seen by optimizer) │
│                                                                         │
│ ─────────────────────────────────────────────────────────────────────  │
│                                                                         │
│ Estimated Time: ~8 hours for 47 stations with Thorough strategy        │
│                                                                         │
│                              [Cancel]  [Start Deep Training]           │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### 7.2 Progress Panel

```
┌─────────────────────────────────────────────────────────────────────────┐
│ Deep Training Progress                                          [Stop] │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│ Overall: ████████████░░░░░░░░░░░░░░░░░░  12/47 stations (25%)         │
│ Time Elapsed: 2h 14m    Estimated Remaining: 6h 42m                    │
│                                                                         │
│ ─────────────────────────────────────────────────────────────────────  │
│ Current Target: 01BURGOS (Wind)                                        │
│ ─────────────────────────────────────────────────────────────────────  │
│                                                                         │
│ Trial: ████████████████░░░░  67/100                                    │
│ Generation: 5                                                           │
│ Current Pipeline: Physics + XGBoost(depth=7) + Per-Hour Calibration    │
│                                                                         │
│ Best MAPE so far: 38.2% (trial 52, generation 4)                       │
│ Target MAPE: 40.0%    Status: ✓ Threshold Met                          │
│                                                                         │
│ Recent Trials:                                                          │
│ ┌─────┬───────────────────────────────────┬───────┬─────────────────┐ │
│ │ #67 │ MREC 4-Tier + XGB(d=10)           │ 39.1% │ Rejected (>best)│ │
│ │ #66 │ Physics + XGB(d=7) + Hourly Cal   │ 38.2% │ ✓ Current Best  │ │
│ │ #65 │ Physics + XGB(d=5) + Hourly Cal   │ 38.9% │ Rejected        │ │
│ │ #64 │ Physics + RandomForest            │ 41.2% │ Rejected        │ │
│ │ #63 │ MREC 4-Tier only                  │ 42.5% │ Rejected        │ │
│ └─────┴───────────────────────────────────┴───────┴─────────────────┘ │
│                                                                         │
│ ─────────────────────────────────────────────────────────────────────  │
│ Completed Targets                                                       │
│ ─────────────────────────────────────────────────────────────────────  │
│                                                                         │
│ ┌────────────────┬──────┬────────┬────────┬───────────────────────────┐│
│ │ Station        │ Type │ MAPE   │ Status │ Winning Config            ││
│ ├────────────────┼──────┼────────┼────────┼───────────────────────────┤│
│ │ 01SNMANUEL_S   │Solar │ 14.2%  │ ✓ Met  │ Physics+XGB+Hourly        ││
│ │ 01CURIMAO      │Solar │ 16.8%  │ ✓ Met  │ Physics+XGB+Station       ││
│ │ 01PASUQUIN     │Solar │ 18.1%  │ ✓ Met  │ Physics+RF                ││
│ │ 01PAGUDPUD     │Wind  │ 45.1%  │ ⚠ Best │ MREC+XGB (threshold: 40%) ││
│ │ ...            │      │        │        │                           ││
│ └────────────────┴──────┴────────┴────────┴───────────────────────────┘│
│                                                                         │
│ Summary: 8 met threshold, 4 best achievable                            │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### 7.3 Model Browser Panel

```
┌─────────────────────────────────────────────────────────────────────────┐
│ Trained Models                                                   [?]    │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│ Filter: [CFAC Stations ▼]  Type: [All Types ▼]  Show: [Active Only ▼]  │
│                                                                         │
│ ┌─────────────────────────────────────────────────────────────────────┐│
│ │ Station         │ Type  │ Ver │ Val MAPE │ Test MAPE │ Active │ Date││
│ ├─────────────────┼───────┼─────┼──────────┼───────────┼────────┼─────┤│
│ │ 01BURGOS        │ Wind  │ v3  │  38.2%   │   41.1%   │   ✓    │02-26││
│ │ 01BURGOS        │ Wind  │ v2  │  42.5%   │   45.3%   │        │02-15││
│ │ 01BURGOS        │ Wind  │ v1  │  48.1%   │   52.7%   │        │02-01││
│ │ 01SNMANUEL_S    │ Solar │ v2  │  14.2%   │   15.8%   │   ✓    │02-26││
│ │ 01SNMANUEL_S    │ Solar │ v1  │  18.3%   │   20.1%   │        │02-15││
│ │ 01CURIMAO       │ Solar │ v1  │  16.8%   │   17.9%   │   ✓    │02-26││
│ │ ...             │       │     │          │           │        │     ││
│ └─────────────────────────────────────────────────────────────────────┘│
│                                                                         │
│ Selected: 01BURGOS v3                                                   │
│                                                                         │
│ ┌───────────────────────────────────────────────────────────────────┐  │
│ │ Model Details                                                      │  │
│ ├───────────────────────────────────────────────────────────────────┤  │
│ │ Pipeline: Physics Base → XGBoost Residual (depth=5) → Per-Hour Cal│  │
│ │                                                                    │  │
│ │ Features: windspeed, windgust, winddir, temperature, gust_ratio   │  │
│ │                                                                    │  │
│ │ Training Period: 2025-07-01 to 2025-12-31 (184 days)              │  │
│ │ Validation Period: 2026-01-01 to 2026-01-14 (14 days)             │  │
│ │                                                                    │  │
│ │ Trials Attempted: 87                                               │  │
│ │ Training Duration: 5 min 24 sec                                    │  │
│ │ Convergence: Generation 4                                          │  │
│ │                                                                    │  │
│ │ Feature Importance:                                                │  │
│ │   windspeed: ████████████████████ 42%                             │  │
│ │   gust_ratio: ███████████████ 31%                                 │  │
│ │   temperature: ██████ 12%                                         │  │
│ │   hour: █████ 10%                                                 │  │
│ │   winddir: ██ 5%                                                  │  │
│ └───────────────────────────────────────────────────────────────────┘  │
│                                                                         │
│ [View Full Config]  [Compare Versions]  [Activate]  [Export]  [Delete] │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### 7.4 Version Comparison Panel

```
┌─────────────────────────────────────────────────────────────────────────┐
│ Compare Model Versions: 01BURGOS                                        │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│ ┌─────────────────────┬─────────────────────┬─────────────────────────┐│
│ │       v1            │        v2           │         v3 (active)     ││
│ ├─────────────────────┼─────────────────────┼─────────────────────────┤│
│ │ Date: 2026-02-01    │ Date: 2026-02-15    │ Date: 2026-02-26        ││
│ │                     │                     │                         ││
│ │ Val MAPE: 48.1%     │ Val MAPE: 42.5%     │ Val MAPE: 38.2%         ││
│ │ Test MAPE: 52.7%    │ Test MAPE: 45.3%    │ Test MAPE: 41.1%        ││
│ │                     │                     │                         ││
│ │ Model: Linear Reg   │ Model: 4-Tier MREC  │ Model: Physics+XGB      ││
│ │ Features: 5         │ Features: 8         │ Features: 6             ││
│ │ Calibration: None   │ Calibration: Global │ Calibration: Per-Hour   ││
│ │                     │                     │                         ││
│ │ Trials: 25          │ Trials: 56          │ Trials: 87              ││
│ │ Duration: 1m 12s    │ Duration: 3m 45s    │ Duration: 5m 24s        ││
│ └─────────────────────┴─────────────────────┴─────────────────────────┘│
│                                                                         │
│ Performance Trend:                                                      │
│                                                                         │
│   52% │ ●                                                               │
│   48% │ │                                                               │
│   44% │ │       ●                                                       │
│   40% │ │       │       ●                                               │
│   36% │ │       │       │                                               │
│       └─┴───────┴───────┴───────────────────────────                   │
│          v1      v2      v3                                             │
│                                                                         │
│ Improvement: v1→v3 = -14.5% MAPE (27% better)                          │
│                                                                         │
│                                    [Close]  [Activate v2]  [Activate v3]│
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 8. Evolution Strategy

### 8.1 Genetic Algorithm Approach

The system uses a genetic algorithm to evolve pipeline configurations:

```
INITIALIZE:
  population = generate_seed_pipelines(n=10)  # Known good approaches

FOR each generation (1 to max_generations):

  EVALUATE:
    FOR each pipeline in population:
      train model with pipeline
      calculate validation_mape

  SELECT:
    survivors = select_best(population, k=5)  # Keep top 50%

  IF best_mape < threshold:
    RETURN best_pipeline  # Success!

  EVOLVE:
    new_population = []

    # Elitism: Keep best unchanged
    new_population.append(best_pipeline)

    # Mutation: Modify survivors
    FOR survivor in survivors:
      mutant = mutate(survivor)
      new_population.append(mutant)

    # Crossover: Combine good pipelines
    FOR i in range(crossover_count):
      parent1, parent2 = random_select(survivors, 2)
      child = crossover(parent1, parent2)
      new_population.append(child)

    # Random: Add some new random pipelines
    FOR i in range(random_count):
      new_population.append(generate_random_pipeline())

  population = new_population

RETURN best_pipeline_found  # Best achievable
```

### 8.2 Mutation Operators

| Operator | Description | Example |
|----------|-------------|---------|
| **change_model** | Replace model type | XGBoost → RandomForest |
| **tweak_hyperparameter** | Adjust one parameter | max_depth: 5 → 7 |
| **add_feature** | Add one feature | + gust_ratio |
| **remove_feature** | Remove one feature | - humidity |
| **change_calibration** | Change calibration method | global → per_hour |
| **change_training** | Change training strategy | all_data → recent_90 |
| **add_stage** | Add pipeline stage | + residual model |
| **remove_stage** | Remove pipeline stage | - calibration |

### 8.3 Crossover Operators

| Operator | Description |
|----------|-------------|
| **stage_swap** | Take feature stage from parent1, model from parent2 |
| **config_blend** | Average numerical hyperparameters |
| **union_features** | Combine feature sets from both parents |

### 8.4 Seed Pipelines

Initial population includes known good approaches:

```javascript
const SEED_PIPELINES = {
  wind: [
    { name: 'mrec_4tier', stages: [...] },
    { name: 'physics_hybrid', stages: [...] },
    { name: 'xgboost_default', stages: [...] },
    { name: 'linear_baseline', stages: [...] },
  ],
  solar: [
    { name: 'physics_ml_hybrid', stages: [...] },
    { name: 'mrec_solar', stages: [...] },
    { name: 'xgboost_weather', stages: [...] },
    { name: 'profile_hourly', stages: [...] },
  ],
  demand: [
    { name: 'hybrid_calibrated', stages: [...] },
    { name: 'xgboost_full', stages: [...] },
    { name: 'regression_basic', stages: [...] },
    { name: 'profile_weighted', stages: [...] },
  ]
};
```

---

## 9. Stopping Criteria

### Conditions to Stop Optimization

The optimizer stops when ANY of these conditions is met:

| Condition | Description | Priority |
|-----------|-------------|----------|
| **Threshold Met** | validation_mape < user_threshold | Highest |
| **Max Attempts** | trials >= user_max_attempts | High |
| **Time Limit** | elapsed_time >= user_time_limit | High |
| **Convergence** | no improvement for N generations | Medium |
| **User Cancel** | user clicked stop button | Immediate |

### Convergence Detection

```javascript
const CONVERGENCE_SETTINGS = {
  patience: 5,           // Generations without improvement
  min_improvement: 0.5,  // Minimum MAPE improvement to count
  min_generations: 3,    // Don't stop before this many generations
};

function isConverged(history) {
  if (history.length < CONVERGENCE_SETTINGS.min_generations) {
    return false;
  }

  const recent = history.slice(-CONVERGENCE_SETTINGS.patience);
  const best_recent = Math.min(...recent);
  const best_before = Math.min(...history.slice(0, -CONVERGENCE_SETTINGS.patience));

  return (best_before - best_recent) < CONVERGENCE_SETTINGS.min_improvement;
}
```

---

## 10. Cross-Validation Strategy

### Why Cross-Validation Matters

Single validation period can lead to:
- Overfitting to that specific period
- Models that don't generalize
- Misleading MAPE scores

### Recommended Approach: Time-Series CV

```
Training Data    │████████████████████████████████│
                 │        Period 1        │Val 1 │
                 │             Period 2          │Val 2 │
                 │                  Period 3            │Val 3│

Final Score = Average(MAPE_val1, MAPE_val2, MAPE_val3)
```

### Implementation

```javascript
function timeSeriesCrossValidation(data, n_folds = 3) {
  const fold_size = Math.floor(data.length / (n_folds + 1));
  const results = [];

  for (let i = 0; i < n_folds; i++) {
    const train_end = (i + 1) * fold_size;
    const val_start = train_end;
    const val_end = val_start + fold_size;

    const train_data = data.slice(0, train_end);
    const val_data = data.slice(val_start, val_end);

    const model = train(train_data);
    const mape = evaluate(model, val_data);
    results.push(mape);
  }

  return {
    mean_mape: average(results),
    std_mape: standardDeviation(results),
    fold_mapes: results
  };
}
```

### Held-Out Test Set

In addition to cross-validation, keep a held-out test set that the optimizer NEVER sees:

```
All Data: 2025-07-01 to 2026-02-15
├── Training Pool: 2025-07-01 to 2026-01-14 (for CV)
├── Validation: 2026-01-01 to 2026-01-14 (for optimization)
└── Test: 2026-01-15 to 2026-02-14 (NEVER seen by optimizer)
```

The test MAPE gives the true measure of generalization.

---

## 11. Implementation Phases

### Phase 1: Foundation (MVP)
**Goal:** Basic deep training with model persistence

- [ ] Database schema for models and trials
- [ ] Pipeline specification format
- [ ] Basic training engine (supports 3-4 model types)
- [ ] Simple sequential trial runner (no evolution)
- [ ] Model save/load functionality
- [ ] Basic CLI command: `deep-train`
- [ ] Model browser in GUI (view saved models)

**Deliverable:** Can train and save per-station models, forecast uses saved models

### Phase 2: Optimization
**Goal:** Smarter search and evolution

- [ ] Genetic algorithm controller
- [ ] Mutation operators
- [ ] Crossover operators
- [ ] Multiple stopping criteria
- [ ] Progress tracking and logging
- [ ] GUI: Deep training launch panel
- [ ] GUI: Progress panel

**Deliverable:** Automated optimization finds good configs per station

### Phase 3: Advanced Features
**Goal:** Full-featured system

- [ ] Cross-validation support
- [ ] Held-out test evaluation
- [ ] Feature importance tracking
- [ ] Model comparison tools
- [ ] Version rollback
- [ ] Export/import models
- [ ] GUI: Version comparison panel
- [ ] GUI: Model activation controls

**Deliverable:** Production-ready deep training system

### Phase 4: Intelligence
**Goal:** Smarter algorithm generation

- [ ] Domain-aware mutations (e.g., wind-specific features)
- [ ] Transfer learning (use similar station's config as seed)
- [ ] Ensemble model support
- [ ] Automatic feature discovery
- [ ] Anomaly detection in training data
- [ ] Recommended settings per station type

**Deliverable:** Self-improving system that learns what works

---

## 12. Open Questions

### Design Decisions Needed

1. **Pipeline Representation**
   - How complex should pipelines be allowed to get?
   - Maximum number of stages?
   - Should we allow recursive/nested pipelines?

2. **Mutation Constraints**
   - Should we prevent "nonsensical" combinations?
   - How to define what's valid?
   - Domain knowledge encoding?

3. **Resource Management**
   - How to handle very long training times?
   - Background process? Separate worker?
   - Progress persistence (resume after crash)?

4. **Multi-Station Learning**
   - Should similar stations share information?
   - Transfer learning from one station to another?
   - Cluster-based optimization (optimize once per cluster)?

5. **Seasonal Models**
   - One model per station, or seasonal variants?
   - How to handle season transitions?
   - Automatic season detection?

6. **Real-Time Adaptation**
   - Should models update continuously?
   - Trigger retraining when performance degrades?
   - Online learning vs batch retraining?

### Technical Decisions

1. **Serialization Format**
   - JSON for configs, but what for models?
   - ONNX for portability?
   - Custom binary format?

2. **Parallelization**
   - Train multiple stations in parallel?
   - Train multiple trials in parallel?
   - GPU support for deep learning models?

3. **Memory Management**
   - How to handle large training datasets?
   - Streaming vs batch loading?
   - Model caching strategy?

---

## Appendix: Acceptable MAPE Thresholds

### By Station Type (CFAC)

| Type | Excellent | Acceptable | Challenging | Notes |
|------|-----------|------------|-------------|-------|
| Solar | <15% | 15-25% | >25% | Achievable with good weather data |
| Wind | <40% | 40-60% | >60% | Inherently variable due to curtailment |
| Hydro | <15% | 15-30% | >30% | Seasonal patterns important |
| Geothermal | <10% | 10-20% | >20% | Very stable typically |
| Biomass | <15% | 15-25% | >25% | Depends on dispatch patterns |
| Battery | <20% | 20-35% | >35% | Depends on market conditions |

### By Zone (Demand)

| Zone Type | Excellent | Acceptable | Challenging |
|-----------|-----------|------------|-------------|
| Metro (02METRO) | <2.5% | 2.5-4% | >4% |
| Industrial | <3% | 3-5% | >5% |
| Mixed | <3.5% | 3.5-5.5% | >5.5% |
| Rural | <4% | 4-6% | >6% |

### Factors Affecting Achievable MAPE

**Station-Specific:**
- Data quality (missing values, outliers)
- Operational patterns (frequent outages, curtailment)
- Weather correlation (some locations more predictable)
- Historical data quantity

**System-Wide:**
- Weather forecast accuracy
- Grid conditions
- Seasonal effects
- Special events (holidays, outages)

---

## Document History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | 2026-02-26 | Development Team | Initial specification |

---

*This document is a living specification. Update as implementation progresses and decisions are made.*
