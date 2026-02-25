/**
 * DemandCorrectionLSTM - LSTM-based correction layer for demand hybrid model
 *
 * This model learns the multiplicative correction factor needed to adjust
 * hybrid model predictions based on weather sequences and demand dynamics.
 * It focuses on fixing temporal dynamics that the hybrid model misses,
 * particularly morning ramp (6-9 AM) patterns.
 *
 * Architecture:
 * - Input: 48-hour sequence of weather + demand + calendar features (22 per timestep)
 * - LSTM Layers: Captures temporal patterns missed by discrete lag features
 * - Output: Multiplicative correction factor (clamped to [0.85, 1.15])
 *
 * Key differences from direct demand prediction:
 * - Learns corrections, not raw demand
 * - Uses hybrid predictions as anchor
 * - Focuses on temporal dynamics (morning ramp, day-type transitions)
 * - Simpler target (correction near 1.0)
 */

// @ts-ignore - synaptic doesn't have TypeScript definitions
import synaptic from 'synaptic';
import { DateTime } from 'luxon';
import { TrainingSample } from '../types/index.js';
import { isPhilippineHoliday } from '../constants/index.js';

const { Architect, Trainer } = synaptic;

export interface DemandCorrectionOptions {
  sequenceLength?: number;       // Past hours to use (default: 48)
  hiddenUnits?: number[];         // LSTM hidden units per layer (default: [48, 24])
  learningRate?: number;          // Learning rate (default: 0.005)
  epochs?: number;                // Training epochs (default: 100)
  errorThreshold?: number;        // Stop when error below this (default: 0.005)
  validationSplit?: number;       // Validation data split (default: 0.2)
  earlyStoppingPatience?: number; // Stop after N epochs without improvement (default: 15)
  log?: boolean;                  // Log training progress
}

export interface CorrectionMetrics {
  region: string;
  trainingError: number;
  validationMAPE: number;
  validationMAE: number;
  trainingSamples: number;
  validationSamples: number;
  trainingTime: number;  // ms
  improvementOverHybrid: number;  // MAPE improvement %
}

interface CorrectionSample {
  input: number[];   // Flattened sequence of 22 features × sequenceLength
  output: number[];  // Target correction factor [0.85, 1.15]
}

export class DemandCorrectionLSTM {
  private region: string;
  private network: any = null;
  private trainer: any = null;
  private sequenceLength: number;
  private hiddenUnits: number[];
  private trained: boolean = false;
  private metrics: CorrectionMetrics | null = null;

  // Feature normalization parameters
  private featureMeans: number[] = [];
  private featureStds: number[] = [];

  // Feature count per timestep
  private readonly featureCount = 22;

  // Feature names for documentation
  private static readonly FEATURE_NAMES = [
    // Weather (6)
    'temperature',
    'tempChange1h',
    'tempChange3h',
    'humidity',
    'heatIndex',
    'cloudCover',
    // Demand context (4)
    'demandPrev1h',
    'demandChange1h',
    'demandSameHourYesterday',
    'demandSameHourLastWeek',
    // Temporal encoding (6)
    'hourSin',
    'hourCos',
    'dayOfWeekSin',
    'dayOfWeekCos',
    'monthSin',
    'monthCos',
    // Day type (4)
    'isWeekend',
    'isHoliday',
    'daysSinceHoliday',
    'daysUntilHoliday',
    // Time period (2)
    'isMorningRamp',
    'isEveningPeak',
  ];

  constructor(region: string, options: Partial<DemandCorrectionOptions> = {}) {
    this.region = region;
    this.sequenceLength = options.sequenceLength ?? 48;  // 2 days default
    this.hiddenUnits = options.hiddenUnits ?? [48, 24];  // Two LSTM layers
  }

  /**
   * Get region code
   */
  getRegion(): string {
    return this.region;
  }

  /**
   * Check if model is trained
   */
  isTrained(): boolean {
    return this.trained;
  }

  /**
   * Get training metrics
   */
  getMetrics(): CorrectionMetrics | null {
    return this.metrics;
  }

  /**
   * Calculate days since last holiday
   */
  private daysSinceHoliday(date: Date): number {
    const dt = DateTime.fromJSDate(date);
    for (let days = 1; days <= 14; days++) {
      const checkDate = dt.minus({ days });
      if (isPhilippineHoliday(checkDate.toISODate() || '')) {
        return days;
      }
    }
    return 14;  // Cap at 14 days
  }

  /**
   * Calculate days until next holiday
   */
  private daysUntilHoliday(date: Date): number {
    const dt = DateTime.fromJSDate(date);
    for (let days = 1; days <= 14; days++) {
      const checkDate = dt.plus({ days });
      if (isPhilippineHoliday(checkDate.toISODate() || '')) {
        return days;
      }
    }
    return 14;  // Cap at 14 days
  }

  /**
   * Extract features for a single timestep
   */
  private extractTimestepFeatures(
    sample: TrainingSample,
    previousSamples: TrainingSample[],
    hybridPrediction: number
  ): number[] {
    const dt = DateTime.fromJSDate(sample.datetime);
    const hour = dt.hour;
    const dayOfWeek = dt.weekday % 7; // 0=Sunday
    const month = dt.month;

    // Weather features
    const temperature = sample.features.temp;
    const humidity = sample.features.relativeHumidity;
    const heatIndex = sample.features.heatIndex;
    const cloudCover = sample.features.cloudcover;

    // Temperature momentum
    let tempChange1h = 0;
    let tempChange3h = 0;
    if (previousSamples.length > 0) {
      tempChange1h = temperature - previousSamples[previousSamples.length - 1].features.temp;
    }
    if (previousSamples.length >= 3) {
      tempChange3h = temperature - previousSamples[previousSamples.length - 3].features.temp;
    }

    // Demand context (normalized by hybrid prediction to avoid circular dependency)
    const demandPrev1h = previousSamples.length > 0 ? previousSamples[previousSamples.length - 1].demand / (hybridPrediction || 1) : 1.0;
    let demandChange1h = 0;
    if (previousSamples.length > 1) {
      const prev1 = previousSamples[previousSamples.length - 1].demand;
      const prev2 = previousSamples[previousSamples.length - 2].demand;
      demandChange1h = (prev1 - prev2) / (prev1 || 1);
    }

    // Same hour yesterday and last week (normalized)
    let demandSameHourYesterday = 1.0;
    let demandSameHourLastWeek = 1.0;
    if (sample.features.demandLag24h !== undefined) {
      demandSameHourYesterday = sample.features.demandLag24h / (hybridPrediction || 1);
    }
    if (sample.features.demandLag168h !== undefined) {
      demandSameHourLastWeek = sample.features.demandLag168h / (hybridPrediction || 1);
    }

    // Cyclical temporal encoding
    const hourSin = Math.sin((2 * Math.PI * hour) / 24);
    const hourCos = Math.cos((2 * Math.PI * hour) / 24);
    const dayOfWeekSin = Math.sin((2 * Math.PI * dayOfWeek) / 7);
    const dayOfWeekCos = Math.cos((2 * Math.PI * dayOfWeek) / 7);
    const monthSin = Math.sin((2 * Math.PI * (month - 1)) / 12);
    const monthCos = Math.cos((2 * Math.PI * (month - 1)) / 12);

    // Day type indicators
    const isWeekend = sample.features.isWeekend;
    const isHoliday = sample.features.isHoliday;
    const daysSinceHol = this.daysSinceHoliday(sample.datetime) / 14;  // Normalize to [0, 1]
    const daysUntilHol = this.daysUntilHoliday(sample.datetime) / 14;

    // Time period flags
    const isMorningRamp = (hour >= 6 && hour <= 9) ? 1 : 0;
    const isEveningPeak = (hour >= 17 && hour <= 22) ? 1 : 0;

    return [
      // Weather (6)
      temperature,
      tempChange1h,
      tempChange3h,
      humidity,
      heatIndex,
      cloudCover,
      // Demand context (4)
      demandPrev1h,
      demandChange1h,
      demandSameHourYesterday,
      demandSameHourLastWeek,
      // Temporal encoding (6)
      hourSin,
      hourCos,
      dayOfWeekSin,
      dayOfWeekCos,
      monthSin,
      monthCos,
      // Day type (4)
      isWeekend,
      isHoliday,
      daysSinceHol,
      daysUntilHol,
      // Time period (2)
      isMorningRamp,
      isEveningPeak,
    ];
  }

  /**
   * Normalize features using z-score normalization
   */
  private normalizeFeatures(features: number[]): number[] {
    if (this.featureMeans.length === 0) {
      return features;
    }

    return features.map((val, i) => {
      const mean = this.featureMeans[i] || 0;
      const std = this.featureStds[i] || 1;
      return (val - mean) / (std || 1);
    });
  }

  /**
   * Learn normalization parameters from training data
   */
  private learnNormalization(allFeatures: number[][]): void {
    this.featureMeans = new Array(this.featureCount).fill(0);
    this.featureStds = new Array(this.featureCount).fill(0);

    if (allFeatures.length === 0) return;

    // Calculate means
    for (const features of allFeatures) {
      for (let i = 0; i < this.featureCount; i++) {
        this.featureMeans[i] += features[i] || 0;
      }
    }
    for (let i = 0; i < this.featureCount; i++) {
      this.featureMeans[i] /= allFeatures.length;
    }

    // Calculate standard deviations
    for (const features of allFeatures) {
      for (let i = 0; i < this.featureCount; i++) {
        const diff = (features[i] || 0) - this.featureMeans[i];
        this.featureStds[i] += diff * diff;
      }
    }
    for (let i = 0; i < this.featureCount; i++) {
      this.featureStds[i] = Math.sqrt(this.featureStds[i] / allFeatures.length);
      if (this.featureStds[i] < 0.001) this.featureStds[i] = 1;
    }
  }

  /**
   * Build correction training sequences
   * Each sequence contains historical features + hybrid prediction → correction factor
   */
  private buildCorrectionSequences(
    samples: TrainingSample[],
    hybridPredictor: (sample: TrainingSample) => number
  ): CorrectionSample[] {
    const sequences: CorrectionSample[] = [];

    // Sort samples by datetime
    const sortedSamples = [...samples].sort((a, b) =>
      a.datetime.getTime() - b.datetime.getTime()
    );

    // Filter for this region
    const regionSamples = sortedSamples.filter(s => s.region === this.region);

    if (regionSamples.length < this.sequenceLength + 1) {
      console.warn(`Insufficient samples for LSTM correction: ${regionSamples.length} < ${this.sequenceLength + 1}`);
      return [];
    }

    // Collect all features for normalization
    const allFeatures: number[][] = [];

    // First pass: get hybrid predictions and collect features
    const hybridAndFeatures: Array<{ hybrid: number; features: number[] }> = [];

    for (let i = 0; i < regionSamples.length; i++) {
      const sample = regionSamples[i];
      const previousSamples = regionSamples.slice(Math.max(0, i - 48), i);

      // Get hybrid prediction
      const hybridPrediction = hybridPredictor(sample);

      // Extract features
      const features = this.extractTimestepFeatures(
        sample,
        previousSamples,
        hybridPrediction
      );

      allFeatures.push(features);
      hybridAndFeatures.push({ hybrid: hybridPrediction, features });
    }

    // Learn normalization
    this.learnNormalization(allFeatures);

    // Second pass: build normalized sequences
    for (let i = this.sequenceLength; i < regionSamples.length; i++) {
      const sequenceInput: number[] = [];

      // Build input sequence from past N hours
      for (let j = i - this.sequenceLength; j < i; j++) {
        const normalizedFeatures = this.normalizeFeatures(hybridAndFeatures[j].features);
        sequenceInput.push(...normalizedFeatures);
      }

      // Calculate correction factor needed
      const actual = regionSamples[i].demand;
      const hybrid = hybridAndFeatures[i].hybrid;

      // Skip if hybrid prediction is near zero (undefined correction)
      if (Math.abs(hybrid) < 0.1) continue;

      // Calculate multiplicative correction: actual / hybrid
      let correctionFactor = actual / hybrid;

      // Clamp correction to [0.85, 1.15] (tighter than CFAC because demand is more predictable)
      correctionFactor = Math.max(0.85, Math.min(1.15, correctionFactor));

      // Filter out outliers (corrections > 1.5x or < 0.5x indicate bad data)
      const rawCorrection = actual / hybrid;
      if (rawCorrection > 1.5 || rawCorrection < 0.5) {
        continue;  // Skip outlier
      }

      sequences.push({
        input: sequenceInput,
        output: [correctionFactor],
      });
    }

    return sequences;
  }

  /**
   * Initialize the LSTM network architecture
   */
  private initializeNetwork(): void {
    const inputSize = this.sequenceLength * this.featureCount;
    const outputSize = 1;

    // Build LSTM architecture with multiple layers
    // Input → LSTM(48) → LSTM(24) → Output
    this.network = new Architect.LSTM(
      inputSize,
      ...this.hiddenUnits,
      outputSize
    );

    this.trainer = new Trainer(this.network);
  }

  /**
   * Train the correction model
   *
   * @param samples Training samples with actual demand
   * @param hybridPredictor Function that returns hybrid prediction for a sample
   * @param options Training options
   */
  train(
    samples: TrainingSample[],
    hybridPredictor: (sample: TrainingSample) => number,
    options: Partial<DemandCorrectionOptions> = {}
  ): CorrectionMetrics {
    const startTime = Date.now();

    console.log(`\n  Training LSTM correction for ${this.region}...`);
    console.log(`    Samples: ${samples.length}`);

    // Build correction sequences
    const sequences = this.buildCorrectionSequences(samples, hybridPredictor);

    if (sequences.length < 10) {
      throw new Error(`Insufficient training sequences: ${sequences.length}`);
    }

    console.log(`    Correction sequences: ${sequences.length}`);

    // Split into training and validation
    const splitIdx = Math.floor(sequences.length * (1 - (options.validationSplit ?? 0.2)));
    const trainingSet = sequences.slice(0, splitIdx);
    const validationSet = sequences.slice(splitIdx);

    console.log(`    Training: ${trainingSet.length}, Validation: ${validationSet.length}`);

    // Initialize network
    this.initializeNetwork();

    // Training options
    const trainingOptions = {
      rate: options.learningRate ?? 0.005,
      iterations: options.epochs ?? 100,
      error: options.errorThreshold ?? 0.005,
      shuffle: true,
      log: options.log ?? false,
      cost: Trainer.cost.MSE,
    };

    // Train
    console.log(`    Training LSTM network (max ${trainingOptions.iterations} epochs)...`);
    const result = this.trainer.train(trainingSet, trainingOptions);

    console.log(`    Training complete: error=${result.error.toFixed(6)}, iterations=${result.iterations}`);

    // Validate
    const { mape, mae } = this.evaluate(validationSet);

    // Calculate improvement over hybrid (if available)
    const hybridMAPE = this.calculateHybridMAPE(samples, hybridPredictor);
    const improvement = hybridMAPE - mape;

    this.trained = true;
    this.metrics = {
      region: this.region,
      trainingError: result.error,
      validationMAPE: mape,
      validationMAE: mae,
      trainingSamples: trainingSet.length,
      validationSamples: validationSet.length,
      trainingTime: Date.now() - startTime,
      improvementOverHybrid: improvement,
    };

    console.log(`    Validation MAPE: ${mape.toFixed(2)}%`);
    console.log(`    Improvement over hybrid: ${improvement >= 0 ? '+' : ''}${improvement.toFixed(2)}%`);

    return this.metrics;
  }

  /**
   * Calculate hybrid model MAPE for comparison
   */
  private calculateHybridMAPE(
    samples: TrainingSample[],
    hybridPredictor: (sample: TrainingSample) => number
  ): number {
    let totalPctError = 0;
    let count = 0;

    for (const sample of samples) {
      if (sample.region !== this.region) continue;

      const prediction = hybridPredictor(sample);
      const actual = sample.demand;

      if (actual > 1) {
        const pctError = (Math.abs(prediction - actual) / actual) * 100;
        totalPctError += pctError;
        count++;
      }
    }

    return count > 0 ? totalPctError / count : NaN;
  }

  /**
   * Evaluate model on a set of sequences
   */
  private evaluate(sequences: CorrectionSample[]): { mape: number; mae: number } {
    if (!this.network || sequences.length === 0) {
      return { mape: NaN, mae: NaN };
    }

    let totalAbsError = 0;
    let totalPctError = 0;
    let count = 0;

    for (const seq of sequences) {
      const predictedCorrection = this.network.activate(seq.input)[0];
      const actualCorrection = seq.output[0];

      // MAPE for correction factors (should be near 1.0)
      const absError = Math.abs(predictedCorrection - actualCorrection);
      const pctError = (absError / actualCorrection) * 100;

      totalAbsError += absError;
      totalPctError += pctError;
      count++;
    }

    return {
      mape: count > 0 ? totalPctError / count : NaN,
      mae: count > 0 ? totalAbsError / count : NaN,
    };
  }

  /**
   * Predict correction factor for a feature sequence
   *
   * @param samples Historical samples for building sequence (last sequenceLength samples)
   * @param currentSample Current sample to predict correction for
   * @param hybridPrediction Hybrid model's prediction for current sample
   * @returns Multiplicative correction factor [0.85, 1.15]
   */
  predict(
    samples: TrainingSample[],
    currentSample: TrainingSample,
    hybridPrediction: number
  ): number {
    if (!this.trained || !this.network) {
      console.warn(`LSTM correction not trained for ${this.region}`);
      return 1.0;  // No correction
    }

    // Ensure we have enough historical data
    let historicalSamples = samples.slice(-this.sequenceLength);

    // Pad if insufficient
    while (historicalSamples.length < this.sequenceLength) {
      historicalSamples.unshift(historicalSamples[0] || currentSample);
    }

    // Build input sequence
    const input: number[] = [];
    for (let i = 0; i < historicalSamples.length; i++) {
      const sample = historicalSamples[i];
      const previousSamples = historicalSamples.slice(0, i);

      const features = this.extractTimestepFeatures(
        sample,
        previousSamples,
        hybridPrediction
      );
      const normalized = this.normalizeFeatures(features);
      input.push(...normalized);
    }

    // Predict correction factor
    const output = this.network.activate(input);
    const correction = Math.max(0.85, Math.min(1.15, output[0]));

    return correction;
  }

  /**
   * Serialize model for persistence
   */
  toJSON(): any {
    if (!this.network) return null;

    return {
      region: this.region,
      sequenceLength: this.sequenceLength,
      hiddenUnits: this.hiddenUnits,
      featureCount: this.featureCount,
      featureMeans: this.featureMeans,
      featureStds: this.featureStds,
      network: this.network.toJSON(),
      metrics: this.metrics,
      trained: this.trained,
    };
  }

  /**
   * Deserialize model from JSON
   */
  static fromJSON(json: any): DemandCorrectionLSTM {
    const model = new DemandCorrectionLSTM(
      json.region,
      {
        sequenceLength: json.sequenceLength,
        hiddenUnits: json.hiddenUnits,
      }
    );

    model.featureMeans = json.featureMeans;
    model.featureStds = json.featureStds;
    model.metrics = json.metrics;
    model.trained = json.trained;

    if (json.network) {
      model.network = synaptic.Network.fromJSON(json.network);
      model.trainer = new Trainer(model.network);
    }

    return model;
  }
}
