# Model Cache Service - Integration Guide

The ModelCacheService provides automatic caching of trained ML models to avoid redundant training when the same training data is used.

## Quick Start

```typescript
import { getModelCache } from './services/modelCacheService.js';

// Get cache instance
const cache = getModelCache();

// Generate hash from training data path and model params
const hash = cache.hashTrainingData(
  'Data Samples/Demand',  // Training data path
  { learningRate: 0.1, maxDepth: 6 }  // Model parameters
);

// Check if valid cache exists
if (cache.hasValidCache(hash)) {
  // Load from cache
  const modelData = cache.loadModel(hash);
  console.log('Loaded model from cache');
  // Restore your model from modelData
} else {
  // Train new model
  const model = await trainModel(...);

  // Save to cache
  cache.saveModel(
    hash,
    'xgboost',  // Model type
    { /* serialized model data */ },
    'Data Samples/Demand',
    { learningRate: 0.1, maxDepth: 6 }
  );
  console.log('Model saved to cache');
}
```

## Integration Pattern for XGBoost

```typescript
export class XGBoostModel {
  async train(samples: TrainingSample[], options?: {
    maxDepth?: number;
    learningRate?: number;
    nEstimators?: number;
    validationSplit?: number;
    useCache?: boolean;  // NEW: Enable caching
    trainingDataPath?: string;  // NEW: Required for cache key
  }): Promise<ModelResult> {
    const opts = {
      maxDepth: options?.maxDepth ?? 6,
      learningRate: options?.learningRate ?? 0.1,
      nEstimators: options?.nEstimators ?? 100,
      validationSplit: options?.validationSplit ?? 0.2,
      useCache: options?.useCache ?? true,
      trainingDataPath: options?.trainingDataPath
    };

    // Generate cache key if caching enabled
    let cacheHash: string | null = null;
    if (opts.useCache && opts.trainingDataPath) {
      const cache = getModelCache();
      cacheHash = cache.hashTrainingData(opts.trainingDataPath, {
        maxDepth: opts.maxDepth,
        learningRate: opts.learningRate,
        nEstimators: opts.nEstimators
      });

      // Try to load from cache
      if (cache.hasValidCache(cacheHash)) {
        const cached = cache.loadModel(cacheHash);
        console.log('✅ Loaded model from cache (skipping training)');

        // Restore model state
        this.model = cached.model;
        this.featureImportances = new Map(cached.featureImportances);

        return cached.result;
      }
    }

    // Train model (existing code)
    const splitIdx = Math.floor(samples.length * (1 - opts.validationSplit));
    const trainSamples = samples.slice(0, splitIdx);
    const testSamples = samples.slice(splitIdx);

    // ... training code ...

    const result = {
      modelType: 'xgboost',
      ...this.calculateMetrics(y_test, predictions),
      featureImportance: this.featureImportances,
      trainingSamples: trainSamples.length,
      testingSamples: testSamples.length
    };

    // Save to cache if enabled
    if (cacheHash) {
      const cache = getModelCache();
      cache.saveModel(
        cacheHash,
        'xgboost',
        {
          model: this.model,  // Serialized model
          featureImportances: Array.from(this.featureImportances.entries()),
          result
        },
        opts.trainingDataPath!,
        {
          maxDepth: opts.maxDepth,
          learningRate: opts.learningRate,
          nEstimators: opts.nEstimators
        }
      );
      console.log('💾 Model saved to cache');
    }

    return result;
  }
}
```

## CLI Usage

```bash
# Check cache status
node dist/index.js cache status

# Clear all cached models
node dist/index.js cache clear --force

# Cached models will be used automatically when:
# 1. Same training data path
# 2. Same model parameters
# 3. Cache entry less than 7 days old
```

## Cache Features

- **Automatic invalidation**: Hash-based detection of training data changes
- **Expiration**: Cached models expire after 7 days (configurable)
- **Singleton pattern**: Single cache instance across the application
- **File-based storage**: `./model_cache/` directory with JSON manifest
- **Parameter-aware**: Different parameters generate different cache keys

## Cache Structure

```
model_cache/
├── manifest.json          # Index of all cached entries
├── a1b2c3d4e5f6g7h8.json # Cached model data (hash.json)
└── f1e2d3c4b5a6987.json # Another cached model
```

## Best Practices

1. **Include all training-affecting parameters in cache key**
   - Learning rate, max depth, number of estimators, etc.
   - Validation split ratio if it affects final model

2. **Don't cache models that depend on external state**
   - Random seeds (unless you want deterministic behavior)
   - Current timestamp-based features

3. **Clear cache when making significant code changes**
   ```bash
   node dist/index.js cache clear --force
   ```

4. **Monitor cache size**
   - Check periodically with `node dist/index.js cache status`
   - Old entries auto-expire after 7 days

## Performance Impact

**Expected speedup:**
- XGBoost training: 2-10 seconds → 50-200ms (cached load)
- Hybrid models: 5-15 seconds → 100-300ms (cached load)
- First run: No impact (cache miss)
- Subsequent runs: 10-50x faster

## Example: Scheduler Integration

```typescript
// In ForecastSchedulerService
const demandModel = new HybridModel();
await demandModel.train(samples, {
  useCache: true,
  trainingDataPath: this.config.demandTrainingPath,
  // Other params...
});
```

This will automatically use cached models when running daily forecasts with the same training data.
