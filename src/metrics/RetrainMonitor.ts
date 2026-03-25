import { CalibrationFactors } from '../models/Calibrator.js';
import { LevelMetricsResult } from './LevelMetrics.js';
import { ShapeMetricsResult } from './ShapeMetrics.js';

/**
 * RetrainMonitor - Detects when model has gone stale and recommends retraining
 *
 * Trigger conditions (any one triggers alert):
 * 1. Level scale drift: |levelScale - 1.0| > threshold for any area
 * 2. Level scale persistence: Drift exceeded for N consecutive cycles
 * 3. Shape correction drift: mean(|shapeCorrection - 1.0|) > threshold
 * 4. MAPE spike: Current MAPE > multiplier × training validation MAPE
 */

export interface RetrainTriggerConfig {
  levelDriftThreshold: number;          // Default 0.08 (8%)
  shapeDriftThreshold: number;          // Default 0.10 (10%)
  consecutiveDaysOverThreshold: number; // Default 3
  mapeMultiplierThreshold: number;      // Default 2.0 (2× training MAPE)
}

export interface RetrainTriggerResult {
  shouldRetrain: boolean;
  reasons: string[];
  levelDrift: Map<string, number>;         // Area → drift value
  shapeDrift: Map<string, number>;         // Area → mean drift
  mapeSpike: Map<string, { current: number; baseline: number }>;
}

export class RetrainMonitor {
  private config: RetrainTriggerConfig;
  private levelDriftHistory: Map<string, number[]>; // Area → history of drift values
  private trainingValidationMAPE: Map<string, number>; // Area → baseline MAPE from training

  static DEFAULT_CONFIG: RetrainTriggerConfig = {
    levelDriftThreshold: 0.08,
    shapeDriftThreshold: 0.10,
    consecutiveDaysOverThreshold: 3,
    mapeMultiplierThreshold: 2.0
  };

  constructor(config: Partial<RetrainTriggerConfig> = {}) {
    this.config = { ...RetrainMonitor.DEFAULT_CONFIG, ...config };
    this.levelDriftHistory = new Map();
    this.trainingValidationMAPE = new Map();
  }

  /**
   * Set baseline validation MAPE from training
   * (used to detect MAPE spikes)
   */
  setTrainingValidationMAPE(areaMAP: Map<string, number>): void {
    this.trainingValidationMAPE = new Map(areaMAP);
  }

  /**
   * Check if retraining is needed based on calibration factors and metrics
   *
   * @param calibrationFactors Current calibration factors
   * @param levelMetrics Current level metrics (from calibration period)
   * @param shapeMetrics Current shape metrics (from calibration period)
   * @returns Trigger result with reasons
   */
  checkRetrainTriggers(
    calibrationFactors: CalibrationFactors,
    levelMetrics: Map<string, LevelMetricsResult>,
    shapeMetrics: Map<string, ShapeMetricsResult>
  ): RetrainTriggerResult {
    const reasons: string[] = [];
    const levelDrift = new Map<string, number>();
    const shapeDrift = new Map<string, number>();
    const mapeSpike = new Map<string, { current: number; baseline: number }>();

    // Check 1: Level scale drift
    for (const [area, scale] of calibrationFactors.levelScale.entries()) {
      const drift = Math.abs(scale - 1.0);
      levelDrift.set(area, drift);

      if (drift > this.config.levelDriftThreshold) {
        // Add to history
        if (!this.levelDriftHistory.has(area)) {
          this.levelDriftHistory.set(area, []);
        }
        this.levelDriftHistory.get(area)!.push(drift);

        // Check for persistence
        const history = this.levelDriftHistory.get(area)!;
        const recentHistory = history.slice(-this.config.consecutiveDaysOverThreshold);

        if (recentHistory.length >= this.config.consecutiveDaysOverThreshold &&
            recentHistory.every(d => d > this.config.levelDriftThreshold)) {
          reasons.push(
            `Level drift in ${area}: ${(drift * 100).toFixed(1)}% for ${recentHistory.length} consecutive days (threshold: ${(this.config.levelDriftThreshold * 100).toFixed(1)}%)`
          );
        }
      } else {
        // Reset history if drift is within bounds
        if (this.levelDriftHistory.has(area)) {
          this.levelDriftHistory.set(area, []);
        }
      }
    }

    // Check 2: Shape correction drift
    for (const [area, corrections] of calibrationFactors.shapeCorrection.entries()) {
      const deviations = corrections.map(c => Math.abs(c - 1.0));
      const meanDrift = deviations.reduce((s, d) => s + d, 0) / deviations.length;
      shapeDrift.set(area, meanDrift);

      if (meanDrift > this.config.shapeDriftThreshold) {
        reasons.push(
          `Shape drift in ${area}: mean correction ${(meanDrift * 100).toFixed(1)}% (threshold: ${(this.config.shapeDriftThreshold * 100).toFixed(1)}%)`
        );
      }
    }

    // Check 3: MAPE spike
    for (const [area, metrics] of levelMetrics.entries()) {
      const baseline = this.trainingValidationMAPE.get(area);
      if (baseline && metrics.mape > baseline * this.config.mapeMultiplierThreshold) {
        mapeSpike.set(area, { current: metrics.mape, baseline });
        reasons.push(
          `Level MAPE spike in ${area}: ${metrics.mape.toFixed(2)}% (baseline: ${baseline.toFixed(2)}%, threshold: ${this.config.mapeMultiplierThreshold}×)`
        );
      }
    }

    for (const [area, metrics] of shapeMetrics.entries()) {
      const baseline = this.trainingValidationMAPE.get(area);
      if (baseline && metrics.shapeMAPE > baseline * this.config.mapeMultiplierThreshold) {
        const existing = mapeSpike.get(area);
        if (!existing) {
          mapeSpike.set(area, { current: metrics.shapeMAPE, baseline });
        }
        reasons.push(
          `Shape MAPE spike in ${area}: ${metrics.shapeMAPE.toFixed(2)}% (baseline: ${baseline.toFixed(2)}%, threshold: ${this.config.mapeMultiplierThreshold}×)`
        );
      }
    }

    const shouldRetrain = reasons.length > 0;

    return {
      shouldRetrain,
      reasons,
      levelDrift,
      shapeDrift,
      mapeSpike
    };
  }

  /**
   * Print retrain trigger result
   */
  static print(result: RetrainTriggerResult): void {
    if (!result.shouldRetrain) {
      console.log('\n[RetrainMonitor] No retrain triggers detected. Model is stable.');
      return;
    }

    console.log('\n========================================');
    console.log('  RETRAIN RECOMMENDED');
    console.log('========================================');
    console.log('');
    console.log('Reasons:');
    for (const reason of result.reasons) {
      console.log(`  - ${reason}`);
    }
    console.log('');
    console.log('Recommended action: Run training pipeline to generate new model.');
    console.log('========================================\n');
  }

  /**
   * Clear drift history (call after successful retrain)
   */
  clearHistory(): void {
    this.levelDriftHistory.clear();
  }
}
