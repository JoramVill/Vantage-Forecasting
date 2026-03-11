# Implementation Plan: LSTM Demand Correction Layer

## Problem Statement

The current demand hybrid model achieves good overall accuracy (5.53% avg MAPE, 0.897 correlation) but struggles with **temporal dynamics**:

### Critical Weaknesses Identified

| Issue | Zones Affected | Severity |
|-------|----------------|----------|
| **Morning ramp (6-9 AM)** | 10/14 zones with < 0.7 corr | HIGH |
| **Evening ramp (5-7 PM)** | 4 zones with < 0.7 corr | MEDIUM |
| **Peak timing** | 7 zones with > 1.5hr error | MEDIUM |
| **Weekend patterns** | 2 zones with 20%+ higher error | LOW |

### Worst Performers

| Zone | Correlation | Morning Ramp | Peak Timing |
|------|-------------|--------------|-------------|
| **03SLUZ** | 0.681 | **-0.170** | 5.1 hours |
| **10LANAO** | 0.717 | 0.355 | 3.5 hours |
| **11NCMIN** | 0.701 | **-0.046** | 5.2 hours |

### What Current Model Misses

1. **Temperature momentum**: Rate of temperature change affects demand lag
2. **Demand ramp dynamics**: Current model uses discrete snapshots (1h, 24h, 168h lags)
3. **Day-type transitions**: Friday→Saturday, Sunday→Monday behavior changes
4. **Season-specific sensitivity**: Different temp sensitivity in hot vs cool periods

---

## Proposed Architecture

### Core Concept

Like CFAC, learn a **correction factor** for the hybrid model's prediction:

```
Final_Demand = Hybrid_Prediction × LSTM_Correction_Factor
```

Or additive:
```
Final_Demand = Hybrid_Prediction + LSTM_Residual
```

**Multiplicative is preferred** for demand because errors tend to scale with magnitude (high demand hours have larger absolute errors).

### Why This Works Better Than Direct Prediction

1. **Hybrid handles baseline patterns**: Time periods, weekend corrections, regional profiles
2. **LSTM learns temporal dynamics**: What the hybrid misses - continuous sequences
3. **Simpler target**: Correction factor near 1.0 is easier to learn than raw demand
4. **Preserves calibration**: Auto-calibration still applies, LSTM fine-tunes

---

## Implementation Details

### 1. New Model: `DemandCorrectionLSTM.ts`

#### Input Features (per timestep, sequence of 24-48 hours)

```typescript
interface DemandLSTMFeatures {
  // Weather (normalized)
  temperature: number;          // Current temperature
  tempChange1h: number;         // Temp change from 1h ago (momentum)
  tempChange3h: number;         // Temp change from 3h ago
  humidity: number;             // Relative humidity
  heatIndex: number;            // Calculated heat index
  cloudCover: number;           // Cloud coverage

  // Demand context
  demandPrev1h: number;         // Previous hour demand (normalized)
  demandChange1h: number;       // Demand change rate
  demandSameHourYesterday: number;  // Same hour, previous day
  demandSameHourLastWeek: number;   // Same hour, week ago

  // Temporal encoding (cyclical)
  hourSin: number;              // Hour sin encoding
  hourCos: number;              // Hour cos encoding
  dayOfWeekSin: number;         // Day of week sin
  dayOfWeekCos: number;         // Day of week cos
  monthSin: number;             // Month sin encoding
  monthCos: number;             // Month cos encoding

  // Day type indicators
  isWeekend: number;            // 0/1 flag
  isHoliday: number;            // 0/1 flag
  daysSinceHoliday: number;     // Days since last holiday (recovery pattern)
  daysUntilHoliday: number;     // Days until next holiday (pre-holiday pattern)

  // Time period indicators
  isMorningRamp: number;        // 6-9 AM flag
  isEveningPeak: number;        // 17-22 flag

  // Hybrid model prediction as anchor
  hybridPrediction: number;     // The hybrid model's prediction (normalized)
}
```

**Total features per timestep: 22**

#### Target Output

- **Multiplicative correction**: `actual_demand / hybrid_prediction` (clamped to [0.85, 1.15])
- Tighter clamp than CFAC because demand is more predictable

#### Network Architecture

Using **brain.js** for true LSTM with proper recurrent cells:

```typescript
import { recurrent } from 'brain.js';
const { LSTM } = recurrent;

const net = new LSTM({
  inputSize: 22,                // Features per timestep
  hiddenLayers: [48, 24],       // Two LSTM layers
  outputSize: 1,                // Correction factor
  learningRate: 0.005,          // Lower LR for stability
  decayRate: 0.999,
});
```

#### Sequence Length

- **48 hours** (2 days) for morning ramp learning
- This captures:
  - Full day-type transitions (weekday→weekend)
  - Temperature momentum over longer period
  - Demand ramping patterns

### 2. Training Pipeline

#### Training Data Preparation

```typescript
interface DemandLSTMTrainingSample {
  // Sequence of features (past 48 hours)
  featureSequence: DemandLSTMFeatures[];

  // Hybrid prediction for current timestep
  hybridPrediction: number;

  // Target: correction factor needed
  correctionFactor: number;  // actual / hybrid
}
```

**Process:**
1. Get historical demand + weather data
2. Run hybrid model to get predictions for each hour
3. Calculate correction factor: `actual / hybrid_prediction`
4. Filter extreme corrections (> 1.2 or < 0.8) as outliers
5. Build sequences using sliding window
6. Train LSTM on sequences → correction factor

#### Training Options

```typescript
interface DemandLSTMTrainingOptions {
  sequenceLength?: number;     // Default: 48 hours
  epochs?: number;             // Default: 100
  batchSize?: number;          // Default: 64
  learningRate?: number;       // Default: 0.005
  validationSplit?: number;    // Default: 0.2
  earlyStoppingPatience?: number;  // Default: 15 epochs
}
```

### 3. Integration with Hybrid Model

#### Modify `hybridModel.ts`

```typescript
// In predict() method:
let prediction = this.hybridPredict(data);

// Apply LSTM correction if available
if (this.lstmCorrector && this.lstmCorrector.isTrained()) {
  const featureSequence = this.buildFeatureSequence(
    historicalDemand,
    historicalWeather,
    currentHour
  );
  const correction = this.lstmCorrector.predict(featureSequence, prediction);
  prediction *= correction;  // Multiplicative correction
}

return prediction;
```

### 4. CLI Integration

#### Add flag to `forecast` command

```bash
# Standard hybrid forecast
node dist/index.js forecast -d "Data Samples/Demand" -s 2026-01-01 -e 2026-01-31 -o output/demand.csv

# With LSTM correction
node dist/index.js forecast -d "Data Samples/Demand" -s 2026-01-01 -e 2026-01-31 -o output/demand.csv --lstm-correction
```

#### CLI Flow with `--lstm-correction`

1. Train hybrid models as normal
2. **Automatically train LSTM correction** for each zone
3. Apply LSTM correction during forecast generation
4. Show improvement metrics in output

#### Output Format

```
Training demand models...
  Zone 01NLUZ: Hybrid MAPE 12.66% → LSTM-corrected 9.82% (+2.8% improvement)
  Zone 02METRO: Hybrid MAPE 5.62% → LSTM-corrected 4.91% (+0.7% improvement)
  Zone 03SLUZ: Hybrid MAPE 8.84% → LSTM-corrected 6.15% (+2.7% improvement)
  ...
```

### 5. GUI Integration

Add to model dropdown:

```
Model: [Hybrid (Default) ▼]
       - Hybrid (Default)
       - Hybrid + LSTM Correction
       - Legacy XGBoost
```

---

## Expected Improvements

### Target Metrics

| Metric | Current | Target | Notes |
|--------|---------|--------|-------|
| Morning ramp corr | 0.43 avg | > 0.70 | Priority 1 |
| Evening ramp corr | 0.75 avg | > 0.85 | Priority 2 |
| Peak timing error | 2.0 hr | < 1.0 hr | Priority 3 |
| Overall MAPE | 5.53% | < 4.5% | Secondary |

### Problem Zone Targets

| Zone | Current MAPE | Target MAPE | Current Corr | Target Corr |
|------|--------------|-------------|--------------|-------------|
| 03SLUZ | 8.84% | < 6.5% | 0.681 | > 0.85 |
| 10LANAO | 5.17% | < 4.0% | 0.717 | > 0.85 |
| 11NCMIN | 7.24% | < 5.5% | 0.701 | > 0.85 |

---

## File Changes Summary

### New Files

| File | Description |
|------|-------------|
| `src/models/DemandCorrectionLSTM.ts` | Core LSTM correction model |
| `src/models/LSTMDemandTrainer.ts` | Training utilities |

### Modified Files

| File | Changes |
|------|---------|
| `src/models/hybridModel.ts` | Add LSTM corrector integration |
| `src/index.ts` | Add `--lstm-correction` flag to forecast command |
| `gui/src/App.vue` | Add LSTM correction to model dropdown |
| `package.json` | Add `brain.js` dependency (if not already) |

---

## Implementation Steps

### Phase 1: Core LSTM Model
1. Create `DemandCorrectionLSTM.ts` with brain.js
2. Implement feature extraction (22 features per timestep)
3. Implement sequence building (48-hour windows)
4. Implement training with validation

### Phase 2: Integration
5. Modify `hybridModel.ts` to support LSTM correction
6. Add `setLSTMCorrector()` and `trainLSTMCorrection()` methods
7. Implement sequence building helper

### Phase 3: CLI Integration
8. Add `--lstm-correction` flag to forecast command
9. Train LSTM during forecast flow when flag set
10. Update progress messages and metrics output

### Phase 4: GUI Integration
11. Update `App.vue` model dropdown
12. Pass `--lstm-correction` flag when selected

### Phase 5: Evaluation
13. Create comparison script (hybrid vs hybrid+LSTM)
14. Validate on held-out test data
15. Document improvements

---

## Risk Mitigation

### LSTM Makes Things Worse
- Auto-fallback to hybrid-only if LSTM degrades MAPE by > 5%
- Per-zone fallback (some zones use LSTM, others don't)

### Training Too Slow
- Reduce sequence length from 48 to 24 hours
- Smaller batch size, fewer epochs
- Train only on problematic zones initially

### Overfitting
- Early stopping with patience=15
- Validation split 20%
- Regularization in LSTM layers

---

## Success Criteria

1. **Morning ramp correlation > 0.70** for at least 10/14 zones
2. **Peak timing error < 1.5 hours** for at least 10/14 zones
3. **Overall MAPE improvement** of at least 10% (5.53% → < 5.0%)
4. **Training time < 2 minutes** per zone
5. **Inference overhead < 5ms** per prediction

---

## Dependencies

- `brain.js` - For true LSTM neural network
- Already using `date-holidays` for Philippines holiday detection
- Existing weather caching and feature engineering

---

## Key Differences from CFAC LSTM

| Aspect | CFAC LSTM | Demand LSTM |
|--------|-----------|-------------|
| Sequence length | 12 hours | 48 hours |
| Features | Weather-focused (13) | Weather + demand + calendar (22) |
| Correction clamp | [0.5, 2.0] | [0.85, 1.15] |
| Primary target | Wind variability | Morning ramp dynamics |
| Integration point | Per-station | Per-zone |
