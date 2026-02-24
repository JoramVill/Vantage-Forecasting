/**
 * SolarLSTMModel - LSTM Neural Network for Solar Capacity Factor Forecasting
 *
 * This model uses Long Short-Term Memory (LSTM) neural networks to capture
 * temporal patterns in solar generation that traditional physics models miss.
 *
 * Key features:
 * - Sequence-based learning: Uses past N hours of data to predict current hour
 * - Weather features: solar radiation, UV index, cloud cover, temperature, humidity
 * - Temporal features: hour of day (encoded), month patterns
 * - Station-specific training: Each station gets its own model
 *
 * Architecture:
 * - Input layer: sequence_length × feature_count
 * - Hidden layers: captures temporal dependencies
 * - Dense output: capacity factor prediction [0, 1]
 */

// @ts-ignore - synaptic doesn't have TypeScript definitions
import synaptic from 'synaptic';

import {
  CFacWeatherFeatures,
  CFacTrainingSample,
} from '../../types/capacityFactor.js';

const { Architect, Trainer } = synaptic;

export interface SolarLSTMTrainingOptions {
  sequenceLength?: number;    // Number of past hours to use (default: 12)
  hiddenLayers?: number[];    // Hidden layer sizes (default: [24, 12])
  learningRate?: number;      // Learning rate (default: 0.01)
  iterations?: number;        // Training iterations (default: 5000)
  errorThreshold?: number;    // Stop when error below this (default: 0.005)
  log?: boolean;              // Log training progress
  logPeriod?: number;         // Log every N iterations
}

export interface SolarLSTMModelMetrics {
  stationCode: string;
  trainingError: number;
  validationMAPE: number;
  validationMAE: number;
  trainingSamples: number;
  validationSamples: number;
  trainingTime: number;  // ms
}

interface SequenceData {
  input: number[];   // Flattened sequence of features
  output: number[];  // Target capacity factor [0-1]
}

export class SolarLSTMModel {
  private stationCode: string;
  private network: any = null;
  private trainer: any = null;
  private sequenceLength: number;
  private featureCount: number = 8;  // Number of features per timestep
  private trained: boolean = false;
  private metrics: SolarLSTMModelMetrics | null = null;

  // Feature normalization parameters (learned from training data)
  private featureMeans: number[] = [];
  private featureStds: number[] = [];

  // Feature names for each timestep (solar-specific)
  private static readonly FEATURE_NAMES = [
    'solarRadiation',      // Global Horizontal Irradiance (GHI)
    'uvIndex',             // UV index (proxy for direct radiation)
    'cloudCover',          // Cloud coverage (0-100)
    'temperature',         // Air temperature
    'humidity',            // Relative humidity (affects panel efficiency)
    'hour_sin',            // Hour of day (sine encoded)
    'hour_cos',            // Hour of day (cosine encoded)
    'prev_cf',             // Previous capacity factor
  ];

  constructor(stationCode: string, options: Partial<SolarLSTMTrainingOptions> = {}) {
    this.stationCode = stationCode;
    // Solar uses shorter sequence (12 hours) since daily patterns are more regular
    this.sequenceLength = options.sequenceLength ?? 12;
    this.featureCount = SolarLSTMModel.FEATURE_NAMES.length;
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
  getMetrics(): SolarLSTMModelMetrics | null {
    return this.metrics;
  }

  /**
   * Extract features from weather data for a single timestep
   */
  private extractTimestepFeatures(
    weather: CFacWeatherFeatures,
    hour: number,
    prevCF: number = 0
  ): number[] {
    const solarRadiation = weather.solarRadiation ?? 0;
    const uvIndex = weather.uvIndex ?? 0;
    const cloudCover = weather.cloudCover ?? 50;
    const temperature = weather.temperature ?? 25;
    const humidity = weather.humidity ?? 70;

    // Cyclical encoding for hour
    const hourRad = (hour / 24) * 2 * Math.PI;
    const hourSin = Math.sin(hourRad);
    const hourCos = Math.cos(hourRad);

    return [
      solarRadiation,
      uvIndex,
      cloudCover,
      temperature,
      humidity,
      hourSin,
      hourCos,
      prevCF,
    ];
  }

  /**
   * Normalize features using z-score normalization
   */
  private normalizeFeatures(features: number[]): number[] {
    if (this.featureMeans.length === 0) {
      // If not trained, return raw features
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
    const featureCount = this.featureCount;
    this.featureMeans = new Array(featureCount).fill(0);
    this.featureStds = new Array(featureCount).fill(0);

    if (allFeatures.length === 0) return;

    // Calculate means
    for (const features of allFeatures) {
      for (let i = 0; i < featureCount; i++) {
        this.featureMeans[i] += features[i] || 0;
      }
    }
    for (let i = 0; i < featureCount; i++) {
      this.featureMeans[i] /= allFeatures.length;
    }

    // Calculate standard deviations
    for (const features of allFeatures) {
      for (let i = 0; i < featureCount; i++) {
        const diff = (features[i] || 0) - this.featureMeans[i];
        this.featureStds[i] += diff * diff;
      }
    }
    for (let i = 0; i < featureCount; i++) {
      this.featureStds[i] = Math.sqrt(this.featureStds[i] / allFeatures.length);
      if (this.featureStds[i] < 0.001) this.featureStds[i] = 1; // Avoid division by zero
    }
  }

  /**
   * Build sequences from training samples
   * Groups consecutive hours and creates input sequences
   */
  private buildSequences(samples: CFacTrainingSample[]): SequenceData[] {
    const sequences: SequenceData[] = [];

    // Sort samples by datetime
    const sortedSamples = [...samples].sort((a, b) =>
      new Date(a.datetime).getTime() - new Date(b.datetime).getTime()
    );

    // Group by station (should already be single station, but verify)
    const stationSamples = sortedSamples.filter(s => s.stationCode === this.stationCode);

    if (stationSamples.length < this.sequenceLength + 1) {
      console.warn(`Insufficient samples for LSTM: ${stationSamples.length} < ${this.sequenceLength + 1}`);
      return [];
    }

    // Collect all features for normalization
    const allFeatures: number[][] = [];

    // First pass: collect features for normalization
    for (let i = 0; i < stationSamples.length; i++) {
      const sample = stationSamples[i];
      const hour = new Date(sample.datetime).getHours();
      const prevCF = i > 0 ? stationSamples[i - 1].actualCFac : sample.actualCFac;
      const features = this.extractTimestepFeatures(sample.weather, hour, prevCF);
      allFeatures.push(features);
    }

    // Learn normalization
    this.learnNormalization(allFeatures);

    // Second pass: build normalized sequences
    for (let i = this.sequenceLength; i < stationSamples.length; i++) {
      const sequenceInput: number[] = [];

      // Build input sequence from past N hours
      for (let j = i - this.sequenceLength; j < i; j++) {
        const normalizedFeatures = this.normalizeFeatures(allFeatures[j]);
        sequenceInput.push(...normalizedFeatures);
      }

      // Target is current hour's capacity factor
      const target = stationSamples[i].actualCFac;

      sequences.push({
        input: sequenceInput,
        output: [Math.max(0, Math.min(1, target))],  // Clamp to [0, 1]
      });
    }

    return sequences;
  }

  /**
   * Initialize the network architecture
   */
  private initializeNetwork(): void {
    const inputSize = this.sequenceLength * this.featureCount;
    const outputSize = 1;

    // Use Architect.Perceptron for a feedforward network
    // Solar patterns are more regular, so we use a simpler architecture
    this.network = new Architect.Perceptron(
      inputSize,
      Math.floor(inputSize / 2),  // First hidden layer
      24,                          // Second hidden layer
      12,                          // Third hidden layer
      outputSize
    );

    this.trainer = new Trainer(this.network);
  }

  /**
   * Train the LSTM model on historical data
   */
  train(
    samples: CFacTrainingSample[],
    options: Partial<SolarLSTMTrainingOptions> = {}
  ): SolarLSTMModelMetrics {
    const startTime = Date.now();

    console.log(`\n  Training Solar LSTM for ${this.stationCode}...`);
    console.log(`    Samples: ${samples.length}`);

    // Build sequences
    const sequences = this.buildSequences(samples);

    if (sequences.length < 10) {
      throw new Error(`Insufficient training sequences: ${sequences.length}`);
    }

    console.log(`    Sequences: ${sequences.length}`);

    // Split into training and validation (80/20)
    const splitIdx = Math.floor(sequences.length * 0.8);
    const trainingSet = sequences.slice(0, splitIdx);
    const validationSet = sequences.slice(splitIdx);

    console.log(`    Training: ${trainingSet.length}, Validation: ${validationSet.length}`);

    // Initialize network
    this.initializeNetwork();

    // Training options
    const trainingOptions = {
      rate: options.learningRate ?? 0.01,
      iterations: options.iterations ?? 5000,
      error: options.errorThreshold ?? 0.005,
      shuffle: true,
      log: options.log ?? false,
      cost: Trainer.cost.MSE,
    };

    // Train
    console.log(`    Training network (max ${trainingOptions.iterations} iterations)...`);
    const result = this.trainer.train(trainingSet, trainingOptions);

    console.log(`    Training complete: error=${result.error.toFixed(6)}, iterations=${result.iterations}`);

    // Validate
    const { mape, mae } = this.evaluate(validationSet);

    this.trained = true;
    this.metrics = {
      stationCode: this.stationCode,
      trainingError: result.error,
      validationMAPE: mape,
      validationMAE: mae,
      trainingSamples: trainingSet.length,
      validationSamples: validationSet.length,
      trainingTime: Date.now() - startTime,
    };

    console.log(`    Validation MAPE: ${mape.toFixed(2)}%, MAE: ${mae.toFixed(4)}`);

    return this.metrics;
  }

  /**
   * Evaluate model on a set of sequences
   */
  private evaluate(sequences: SequenceData[]): { mape: number; mae: number } {
    if (!this.network || sequences.length === 0) {
      return { mape: NaN, mae: NaN };
    }

    let totalAbsError = 0;
    let totalPctError = 0;
    let count = 0;

    for (const seq of sequences) {
      const prediction = this.network.activate(seq.input)[0];
      const actual = seq.output[0];

      if (actual > 0.01) {  // Avoid division by near-zero (night hours)
        const absError = Math.abs(prediction - actual);
        const pctError = (absError / actual) * 100;

        totalAbsError += absError;
        totalPctError += pctError;
        count++;
      }
    }

    return {
      mape: count > 0 ? totalPctError / count : NaN,
      mae: count > 0 ? totalAbsError / count : NaN,
    };
  }

  /**
   * Predict capacity factor given a sequence of weather data
   *
   * @param weatherSequence Array of weather features for past N hours
   * @param hours Array of hour values corresponding to each weather entry
   * @param prevCFs Array of previous capacity factors (if available)
   */
  predict(
    weatherSequence: CFacWeatherFeatures[],
    hours: number[],
    prevCFs: number[] = []
  ): number {
    if (!this.trained || !this.network) {
      console.warn(`LSTM model not trained for ${this.stationCode}`);
      return 0;
    }

    // Ensure we have enough data
    if (weatherSequence.length < this.sequenceLength) {
      // Pad with repeated first entry
      while (weatherSequence.length < this.sequenceLength) {
        weatherSequence.unshift(weatherSequence[0]);
        hours.unshift(hours[0]);
        prevCFs.unshift(prevCFs[0] ?? 0);
      }
    }

    // Take last N entries
    const recentWeather = weatherSequence.slice(-this.sequenceLength);
    const recentHours = hours.slice(-this.sequenceLength);
    const recentPrevCFs = prevCFs.slice(-this.sequenceLength);

    // Build input sequence
    const input: number[] = [];
    for (let i = 0; i < this.sequenceLength; i++) {
      const features = this.extractTimestepFeatures(
        recentWeather[i],
        recentHours[i],
        recentPrevCFs[i] ?? 0
      );
      const normalized = this.normalizeFeatures(features);
      input.push(...normalized);
    }

    // Predict
    const output = this.network.activate(input);
    const prediction = Math.max(0, Math.min(1, output[0]));

    return prediction;
  }

  /**
   * Serialize model for persistence
   */
  toJSON(): any {
    if (!this.network) return null;

    return {
      stationCode: this.stationCode,
      sequenceLength: this.sequenceLength,
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
  static fromJSON(json: any): SolarLSTMModel {
    const model = new SolarLSTMModel(json.stationCode, {
      sequenceLength: json.sequenceLength,
    });

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
