# Implementation Plan: LSTM Weather-to-CFAC Correction Layer

## Problem Statement

The current LSTM models (`WindLSTMModel.ts`, `SolarLSTMModel.ts`) underperform compared to hybrid models because they:
1. **Predict CFAC directly** instead of learning corrections to physics predictions
2. **Use feedforward Perceptron** (not true LSTM cells) despite the class name
3. **Don't leverage physics-based predictions** as a foundation
4. **Learn from CFAC sequences** rather than weather-to-CFAC correlations

## Proposed Architecture

### Core Concept
Instead of predicting CFAC directly, the LSTM learns the **correction factor** that should be applied to the physics-based prediction:

```
Final CFAC = Physics_Prediction × LSTM_Correction_Factor
```

Or for additive correction:
```
Final CFAC = Physics_Prediction + LSTM_Residual
```

### Why This Works Better

1. **Physics handles the baseline**: The physics models (irradiance, power curve) provide a solid foundation
2. **LSTM learns the deviations**: Focus on learning *why* physics is wrong under specific weather conditions
3. **Simpler target**: Predicting a correction factor (near 1.0) is easier than predicting raw CFAC
4. **Weather-focused**: Input emphasizes weather features, not CFAC history

---

## Implementation Details

### 1. New Model: `WeatherCorrectionLSTM.ts`

A new model class that learns corrections for any station type.

#### Input Features (per timestep)
```typescript
// Weather features (normalized)
windSpeed100: number;        // Hub-height wind speed (wind stations)
windGust: number;            // Wind gusts
solarRadiation: number;      // GHI (solar stations)
cloudCover: number;          // Cloud coverage
temperature: number;         // Air temperature
humidity: number;            // Relative humidity
uvIndex: number;             // UV index (solar indicator)
pressure: number;            // Atmospheric pressure

// Physics prediction as anchor
physicsPrediction: number;   // The hybrid model's prediction

// Temporal encoding
hourSin: number;             // Cyclical hour encoding
hourCos: number;
monthSin: number;            // Cyclical month encoding
monthCos: number;
```

#### Target Output
- **Multiplicative correction**: `actual_CFAC / physics_prediction` (clamped to [0.5, 2.0])
- **Or additive residual**: `actual_CFAC - physics_prediction` (clamped to [-0.3, 0.3])

Multiplicative is preferred because it scales proportionally (important when physics predicts low values).

#### Network Architecture (Using brain.js for True LSTM)

```
Input Layer: [features_per_timestep] per timestep
    ↓
LSTM Layer: 32 hidden units (learns temporal weather patterns)
    ↓
Output Layer: 1 unit (correction factor, scaled to [0.5, 1.5])
```

**Library**: `brain.js` - provides true LSTM cells with:
- Proper recurrent connections
- Gated memory cells (forget, input, output gates)
- Backpropagation through time (BPTT)

```typescript
import { recurrent } from 'brain.js';
const { LSTM } = recurrent;

const net = new LSTM({
  inputSize: featuresPerTimestep,
  hiddenLayers: [32],
  outputSize: 1,
  learningRate: 0.01,
  decayRate: 0.999,
});
```

**Why brain.js over synaptic**:
- True LSTM cells (not feedforward approximation)
- Active maintenance and TypeScript types
- GPU acceleration available (optional)
- Better documentation for sequence learning

### 2. Integration Points

#### 2.1 Wind Correction Layer

Integrate into `WindEnhancedHybridModel.ts`:

```typescript
// In predict() method, after hybrid prediction:
let prediction = boosted * this.factors.baseMultiplier;

// Apply ML multiplicative correction if available
if (this.residualModel) {
  // ... existing ML correction ...
}

// NEW: Apply LSTM correction if available and trained
if (this.lstmCorrector && this.lstmCorrector.isTrained()) {
  const lstmCorrection = this.lstmCorrector.predict(weatherSequence, hours);
  prediction *= lstmCorrection;  // Multiplicative
}
```

#### 2.2 Solar Correction Layer

Integrate into `SolarHybridModel.ts`:

```typescript
// In predict() method, after physics + ML:
let prediction = physicsCFac + residual;

// NEW: Apply LSTM correction if available
if (this.lstmCorrector && this.lstmCorrector.isTrained()) {
  const rawPrediction = this.predictRaw(weather, datetime);
  const lstmCorrection = this.lstmCorrector.predict(weatherSequence, hours, rawPrediction);
  prediction = rawPrediction * lstmCorrection;
}
```

### 3. Training Pipeline

#### 3.1 Training Data Preparation

```typescript
interface LSTMCorrectionSample {
  // Sequence of weather features (past N hours)
  weatherSequence: CFacWeatherFeatures[];
  hours: number[];

  // Physics prediction for current timestep
  physicsPrediction: number;

  // Target: correction factor needed
  correctionFactor: number;  // actual / physics
}
```

Training process:
1. Get all training samples with actual CFAC and weather
2. Run hybrid model to get physics predictions
3. Calculate correction factor: `actual / physics_prediction`
4. Filter out extreme corrections (> 3x or < 0.25x) as outliers
5. Build sequences using sliding window
6. Train LSTM on sequences → correction factor

#### 3.2 Training Options

```typescript
interface LSTMCorrectionTrainingOptions {
  sequenceLength?: number;     // Default: 12 hours (half day)
  epochs?: number;             // Default: 100
  batchSize?: number;          // Default: 32
  learningRate?: number;       // Default: 0.001
  validationSplit?: number;    // Default: 0.2
  earlyStoppingPatience?: number;  // Default: 10 epochs
}
```

### 4. Evaluation Metrics

Compare three configurations:
1. **Hybrid Only**: Current production model
2. **Hybrid + LSTM Correction**: Proposed enhancement
3. **LSTM Only** (baseline): Current experimental model

Metrics:
- MAPE (primary)
- MAE
- Correlation coefficient
- Per-station breakdown

### 5. CLI Integration (Native - NOT a separate script)

**IMPORTANT**: This must be a natural part of the existing CLI, not a standalone script.

#### Primary CLI Command
The LSTM correction integrates seamlessly into `cfac forecast2`:

```bash
# Hybrid with LSTM correction enabled
node dist/index.js cfac forecast2 \
  -t "Data Samples/Capacity Factor" \
  -s 2026-01-01 -e 2026-03-01 \
  -o output/cfac_forecast.csv \
  --lstm-correction          # Enable LSTM correction layer
```

#### How It Works in CLI Flow
1. User runs `cfac forecast2` with `--lstm-correction` flag
2. Training phase:
   - Trains hybrid models (MREC, physics) as normal
   - **Automatically trains LSTM correction models** for each station
   - LSTM learns from: weather features → correction to hybrid prediction
3. Forecast phase:
   - Hybrid model makes prediction
   - LSTM correction layer refines prediction
   - Final output includes LSTM-corrected values

#### CLI Output Integration
The CLI output naturally shows LSTM correction status:
```
Training capacity factor models...
  Wind stations (4):
    01BURGOS: MREC MAPE 78% → Hybrid 73% → LSTM-corrected 68% (+5% improvement)
    01LAOAG: MREC MAPE 85% → Hybrid 81% → LSTM-corrected 77% (+4% improvement)
  Solar stations (8):
    01CURIMAO: Physics MAPE 22% → Hybrid 18% → LSTM-corrected 15% (+3% improvement)
```

#### No Separate Training Step
The LSTM correction layer trains **during the normal forecast flow**:
- When `--lstm-correction` is specified, LSTM trains automatically
- Uses same training data as hybrid models
- Caches trained models for reuse (like other models)

### 6. GUI Integration

Add to CFAC model section (natural dropdown extension):

```
CFAC Model: [Hybrid (Default) ▼]
            - Hybrid (Default)
            - Hybrid + LSTM Correction
            - Legacy XGBoost
```

When "Hybrid + LSTM Correction" is selected:
- CLI receives `--lstm-correction` flag
- Progress shows LSTM training steps
- Model dropdown makes it a first-class option, not a hidden checkbox

---

## File Changes Summary

### New Files
| File | Description |
|------|-------------|
| `src/models/capacityFactor/WeatherCorrectionLSTM.ts` | Core LSTM correction model |
| `src/models/capacityFactor/LSTMCorrectionTrainer.ts` | Training utilities |

### Modified Files
| File | Changes |
|------|---------|
| `src/models/capacityFactor/WindEnhancedHybridModel.ts` | Add optional LSTM corrector integration |
| `src/models/capacityFactor/SolarHybridModel.ts` | Add optional LSTM corrector integration |
| `src/index.ts` | Add `--lstm-correction` CLI flag |
| `gui/src/App.vue` | Add LSTM correction checkbox |
| `package.json` | Add `brain.js` dependency (if using true LSTM) |

### Files to Deprecate (but keep for reference)
| File | Reason |
|------|--------|
| `src/models/capacityFactor/WindLSTMModel.ts` | Replaced by WeatherCorrectionLSTM |
| `src/models/capacityFactor/SolarLSTMModel.ts` | Replaced by WeatherCorrectionLSTM |

---

## Implementation Steps

### Phase 1: Core LSTM Correction Model
1. Install `brain.js` for true LSTM support:
   ```bash
   npm install brain.js
   ```

2. Create `WeatherCorrectionLSTM.ts` with:
   - Feature extraction focused on weather-to-correction mapping
   - True LSTM architecture using brain.js
   - Training method that takes physics predictions + actuals
   - Prediction method that returns correction factor
   - Model serialization/deserialization for persistence

### Phase 2: Integration with Hybrid Models
3. Modify `WindEnhancedHybridModel.ts`:
   - Add optional `lstmCorrector` property
   - Modify `predict()` to apply LSTM correction when available
   - Add `setLSTMCorrector()` method
   - Add `trainLSTMCorrection()` method for integrated training

4. Modify `SolarHybridModel.ts`:
   - Same changes as wind model

### Phase 3: CLI Integration (Primary Focus)
5. Modify `src/index.ts` - `cfac forecast2` command:
   - Add `--lstm-correction` flag option
   - When flag is set:
     - Train hybrid models as normal
     - Automatically train LSTM correction for each station
     - Apply LSTM correction during forecast generation
   - Update progress messages to show LSTM training status
   - Update metrics output to show LSTM improvement

6. Modify training flow in CLI:
   ```typescript
   // In cfac forecast2 handler:
   if (options.lstmCorrection) {
     // After hybrid training completes...
     progressCallback?.('Training LSTM correction layers...');
     for (const [stationCode, hybridModel] of windModels) {
       const correction = await trainLSTMCorrection(hybridModel, samples);
       hybridModel.setLSTMCorrector(correction);
     }
   }
   ```

### Phase 4: GUI Integration
7. Update `gui/src/App.vue`:
   - Change model dropdown to include "Hybrid + LSTM Correction"
   - When selected, add `--lstm-correction` to CLI args
   - Update model description text

### Phase 5: Evaluation (Built into CLI)
8. Evaluation is built into the normal training output:
   - Shows MREC → Hybrid → LSTM-corrected MAPE progression
   - Automatically falls back to hybrid-only if LSTM degrades performance
   - No separate evaluation scripts needed

---

## Expected Outcomes

### Success Criteria
- LSTM correction improves MAPE by at least 5% over hybrid alone
- Training completes in < 5 minutes per station
- Inference adds < 10ms per prediction

### Risk Mitigation
- **LSTM makes things worse**: Auto-fallback to hybrid-only (similar to current ML fallback)
- **Training too slow**: Reduce sequence length, batch size
- **Overfitting**: Early stopping, regularization, validation split

---

## Dependencies

### Required
- `brain.js` (new) - For true LSTM neural network with proper recurrent cells

### brain.js Features

| Feature | Capability |
|---------|------------|
| True LSTM | Full LSTM cells with gates (forget, input, output) |
| GRU Support | Also supports GRU cells as alternative |
| TypeScript | Types available via `@types/brain.js` |
| Serialization | Built-in `toJSON()` / `fromJSON()` for model persistence |
| Training | Backpropagation through time (BPTT) |
| GPU support | Optional GPU acceleration for larger models |

### Installation
```bash
npm install brain.js
```

### Why brain.js
The current synaptic-based approach uses a feedforward Perceptron which cannot capture true temporal dependencies. brain.js provides actual LSTM cells that:
- Maintain memory across timesteps
- Learn which past information to retain/forget
- Handle variable-length sequences properly

---

## Validation Plan

1. **Unit Tests**: Test feature extraction, normalization, prediction clamping
2. **Integration Tests**: Test hybrid + LSTM correction flow
3. **Performance Tests**: Measure training time, inference time
4. **Accuracy Tests**: Compare MAPE against baseline
