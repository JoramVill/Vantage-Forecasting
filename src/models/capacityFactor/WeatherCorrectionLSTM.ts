/**
 * WeatherCorrectionLSTM - LSTM-based correction layer for hybrid models
 *
 * This model learns the multiplicative correction factor needed to adjust
 * physics-based predictions based on weather sequences. It focuses on learning
 * *why* physics models are wrong under specific weather conditions.
 *
 * Architecture:
 * - Input: Weather sequence + physics prediction
 * - LSTM Layer: Captures temporal weather patterns
 * - Output: Multiplicative correction factor (clamped to [0.5, 2.0])
 *
 * Key differences from direct CFAC prediction:
 * - Learns corrections, not raw predictions
 * - Uses physics predictions as anchor
 * - Focuses on weather-to-correction mapping
 * - Simpler target (correction near 1.0)
 */

// @ts-ignore - synaptic doesn't have TypeScript definitions
import synaptic from 'synaptic';

import {
  CFacWeatherFeatures,
  CFacTrainingSample,
} from '../../types/capacityFactor.js';

const { Architect, Trainer } = synaptic;

export interface CorrectionTrainingOptions {
  sequenceLength?: number;       // Past hours to use (default: 12)
  hiddenUnits?: number;          // LSTM hidden units (default: 32)
  learningRate?: number;         // Learning rate (default: 0.01)
  epochs?: number;               // Training epochs (default: 100)
  errorThreshold?: number;       // Stop when error below this (default: 0.005)
  validationSplit?: number;      // Validation data split (default: 0.2)
  earlyStoppingPatience?: number; // Stop after N epochs without improvement (default: 10)
  log?: boolean;                 // Log training progress
}

export interface CorrectionMetrics {
  stationCode: string;
  trainingError: number;
  validationMAPE: number;
  validationMAE: number;
  trainingSamples: number;
  validationSamples: number;
  trainingTime: number;  // ms
  improvementOverHybrid: number;  // MAPE improvement %
}

interface CorrectionSample {
  input: number[];   // Flattened sequence of features
  output: number[];  // Target correction factor [0.5, 2.0]
}

export class WeatherCorrectionLSTM {
  private stationCode: string;
  private stationType: 'wind' | 'solar' | 'other';
  private network: any = null;
  private trainer: any = null;
  private sequenceLength: number;
  private hiddenUnits: number;
  private trained: boolean = false;
  private metrics: CorrectionMetrics | null = null;

  // Feature normalization parameters
  private featureMeans: number[] = [];
  private featureStds: number[] = [];

  // Feature count per timestep
  private readonly featureCount = 13;

  // Feature names for each timestep
  private static readonly FEATURE_NAMES = [
    'windSpeed100',        // Hub-height wind (wind stations)
    'windGust',            // Wind gusts
    'solarRadiation',      // GHI (solar stations)
    'cloudCover',          // Cloud coverage
    'temperature',         // Air temperature
    'humidity',            // Relative humidity
    'uvIndex',             // UV index (solar indicator)
    'pressure',            // Atmospheric pressure
    'physicsPrediction',   // Hybrid model prediction (anchor)
    'hourSin',             // Cyclical hour encoding
    'hourCos',
    'monthSin',            // Cyclical month encoding
    'monthCos',
  ];

  constructor(stationCode: string, stationType: 'wind' | 'solar' | 'other' = 'other', options: Partial<CorrectionTrainingOptions> = {}) {
    this.stationCode = stationCode;
    this.stationType = stationType;
    this.sequenceLength = options.sequenceLength ?? 12;  // Half day default
    this.hiddenUnits = options.hiddenUnits ?? 32;
  }

  /**
   * Get station code
   */
  getStationCode(): string {
    return this.stationCode;
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
   * Extract features from weather data for a single timestep
   */
  private extractTimestepFeatures(
    weather: CFacWeatherFeatures,
    hour: number,
    month: number,
    physicsPrediction: number
  ): number[] {
    const windSpeed = weather.windSpeed100 ?? weather.windSpeed ?? 0;
    const windGust = weather.windGust ?? windSpeed;
    const solarRad = weather.solarRadiation ?? 0;
    const cloudCover = weather.cloudCover ?? 50;
    const temperature = weather.temperature ?? 25;
    const humidity = weather.humidity ?? 60;
    const uvIndex = weather.uvIndex ?? 0;
    const pressure = weather.pressure ?? 1013;

    // Cyclical encoding for hour (0-23)
    const hourRad = (hour / 24) * 2 * Math.PI;
    const hourSin = Math.sin(hourRad);
    const hourCos = Math.cos(hourRad);

    // Cyclical encoding for month (1-12)
    const monthRad = ((month - 1) / 12) * 2 * Math.PI;
    const monthSin = Math.sin(monthRad);
    const monthCos = Math.cos(monthRad);

    return [
      windSpeed,
      windGust,
      solarRad,
      cloudCover,
      temperature,
      humidity,
      uvIndex,
      pressure,
      physicsPrediction,
      hourSin,
      hourCos,
      monthSin,
      monthCos,
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
   * Each sequence contains weather history + physics prediction → correction factor
   */
  private buildCorrectionSequences(
    samples: CFacTrainingSample[],
    physicsPredictor: (sample: CFacTrainingSample) => number
  ): CorrectionSample[] {
    const sequences: CorrectionSample[] = [];

    // Sort samples by datetime
    const sortedSamples = [...samples].sort((a, b) =>
      new Date(a.datetime).getTime() - new Date(b.datetime).getTime()
    );

    // Filter for this station
    const stationSamples = sortedSamples.filter(s => s.stationCode === this.stationCode);

    if (stationSamples.length < this.sequenceLength + 1) {
      console.warn(`Insufficient samples for LSTM correction: ${stationSamples.length} < ${this.sequenceLength + 1}`);
      return [];
    }

    // Collect all features for normalization
    const allFeatures: number[][] = [];

    // First pass: get physics predictions and collect features
    const physicsAndFeatures: Array<{ physics: number; features: number[] }> = [];

    for (let i = 0; i < stationSamples.length; i++) {
      const sample = stationSamples[i];
      const dt = new Date(sample.datetime);
      const hour = dt.getHours();
      const month = dt.getMonth() + 1;

      // Get physics prediction
      const physicsPrediction = physicsPredictor(sample);

      // Extract features
      const features = this.extractTimestepFeatures(
        sample.weather,
        hour,
        month,
        physicsPrediction
      );

      allFeatures.push(features);
      physicsAndFeatures.push({ physics: physicsPrediction, features });
    }

    // Learn normalization
    this.learnNormalization(allFeatures);

    // Second pass: build normalized sequences
    for (let i = this.sequenceLength; i < stationSamples.length; i++) {
      const sequenceInput: number[] = [];

      // Build input sequence from past N hours
      for (let j = i - this.sequenceLength; j < i; j++) {
        const normalizedFeatures = this.normalizeFeatures(physicsAndFeatures[j].features);
        sequenceInput.push(...normalizedFeatures);
      }

      // Calculate correction factor needed
      const actual = stationSamples[i].actualCFac;
      const physics = physicsAndFeatures[i].physics;

      // Skip if physics prediction is near zero (undefined correction)
      if (Math.abs(physics) < 0.001) continue;

      // Calculate multiplicative correction: actual / physics
      let correctionFactor = actual / physics;

      // Clamp correction to [0.5, 2.0] to avoid extremes
      correctionFactor = Math.max(0.5, Math.min(2.0, correctionFactor));

      // Filter out outliers (corrections > 3x or < 0.25x indicate bad data)
      const rawCorrection = actual / physics;
      if (rawCorrection > 3.0 || rawCorrection < 0.25) {
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

    // Use LSTM architecture for true temporal learning
    // Unlike the old models that use Perceptron (feedforward),
    // this uses actual LSTM with memory cells
    this.network = new Architect.LSTM(inputSize, this.hiddenUnits, outputSize);

    this.trainer = new Trainer(this.network);
  }

  /**
   * Train the correction model
   *
   * @param samples Training samples with actual CFAC
   * @param physicsPredictor Function that returns physics prediction for a sample
   * @param options Training options
   */
  train(
    samples: CFacTrainingSample[],
    physicsPredictor: (sample: CFacTrainingSample) => number,
    options: Partial<CorrectionTrainingOptions> = {}
  ): CorrectionMetrics {
    const startTime = Date.now();

    console.log(`\n  Training LSTM correction for ${this.stationCode} (${this.stationType})...`);
    console.log(`    Samples: ${samples.length}`);

    // Build correction sequences
    const sequences = this.buildCorrectionSequences(samples, physicsPredictor);

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
      rate: options.learningRate ?? 0.01,
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
    const hybridMAPE = this.calculateHybridMAPE(samples, physicsPredictor);
    const improvement = hybridMAPE - mape;

    this.trained = true;
    this.metrics = {
      stationCode: this.stationCode,
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
    samples: CFacTrainingSample[],
    physicsPredictor: (sample: CFacTrainingSample) => number
  ): number {
    let totalPctError = 0;
    let count = 0;

    for (const sample of samples) {
      if (sample.stationCode !== this.stationCode) continue;

      const prediction = physicsPredictor(sample);
      const actual = sample.actualCFac;

      if (actual > 0.01) {
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
   * Predict correction factor for a weather sequence
   *
   * @param weatherSequence Array of weather features for past N hours
   * @param hours Array of hour values corresponding to each weather entry
   * @param months Array of month values corresponding to each weather entry
   * @param physicsSequence Array of physics predictions for each timestep
   * @returns Multiplicative correction factor [0.5, 2.0]
   */
  predict(
    weatherSequence: CFacWeatherFeatures[],
    hours: number[],
    months: number[],
    physicsSequence: number[]
  ): number {
    if (!this.trained || !this.network) {
      console.warn(`LSTM correction not trained for ${this.stationCode}`);
      return 1.0;  // No correction
    }

    // Ensure we have enough data
    if (weatherSequence.length < this.sequenceLength) {
      // Pad with repeated first entry
      while (weatherSequence.length < this.sequenceLength) {
        weatherSequence.unshift(weatherSequence[0]);
        hours.unshift(hours[0]);
        months.unshift(months[0]);
        physicsSequence.unshift(physicsSequence[0]);
      }
    }

    // Take last N entries
    const recentWeather = weatherSequence.slice(-this.sequenceLength);
    const recentHours = hours.slice(-this.sequenceLength);
    const recentMonths = months.slice(-this.sequenceLength);
    const recentPhysics = physicsSequence.slice(-this.sequenceLength);

    // Build input sequence
    const input: number[] = [];
    for (let i = 0; i < this.sequenceLength; i++) {
      const features = this.extractTimestepFeatures(
        recentWeather[i],
        recentHours[i],
        recentMonths[i],
        recentPhysics[i]
      );
      const normalized = this.normalizeFeatures(features);
      input.push(...normalized);
    }

    // Predict correction factor
    const output = this.network.activate(input);
    const correction = Math.max(0.5, Math.min(2.0, output[0]));

    return correction;
  }

  /**
   * Serialize model for persistence
   */
  toJSON(): any {
    if (!this.network) return null;

    return {
      stationCode: this.stationCode,
      stationType: this.stationType,
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
  static fromJSON(json: any): WeatherCorrectionLSTM {
    const model = new WeatherCorrectionLSTM(
      json.stationCode,
      json.stationType,
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
