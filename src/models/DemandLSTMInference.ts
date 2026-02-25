/**
 * LSTM Inference for Demand Correction
 *
 * Loads pre-trained TensorFlow model weights (from Python trainer) and runs inference.
 * This is a forward-pass only implementation - training is done in Python for speed.
 *
 * Usage:
 *   1. Train models with: python scripts/train_demand_lstm.py --all --output models/lstm
 *   2. Load weights: const lstm = new DemandLSTMInference('01NLUZ');
 *   3. Predict: const correction = lstm.predict(featureSequence);
 */

import * as fs from 'fs';
import * as path from 'path';

// Feature configuration (must match Python trainer)
const SEQUENCE_LENGTH = 24;
const FEATURES_PER_TIMESTEP = 22;
const CORRECTION_MIN = 0.85;
const CORRECTION_MAX = 1.15;

interface LayerWeights {
  type: string;
  weights: number[][][];  // Layer weights in TensorFlow format
}

interface ModelConfig {
  zone: string;
  sequence_length: number;
  features_per_timestep: number;
  correction_min: number;
  correction_max: number;
  architecture: string[];
  weights: Record<string, LayerWeights>;
  metrics: {
    val_loss: number;
    val_mae: number;
    epochs_trained: number;
    training_samples: number;
    validation_samples: number;
  };
  trained_at: string;
}

/**
 * Simple matrix operations for LSTM inference
 */
class MatrixOps {
  static dotProduct(a: number[], b: number[]): number {
    let sum = 0;
    for (let i = 0; i < a.length; i++) {
      sum += a[i] * b[i];
    }
    return sum;
  }

  static matVecMul(matrix: number[][], vec: number[]): number[] {
    return matrix.map(row => this.dotProduct(row, vec));
  }

  static vecAdd(a: number[], b: number[]): number[] {
    return a.map((v, i) => v + b[i]);
  }

  static sigmoid(x: number): number {
    return 1 / (1 + Math.exp(-Math.max(-500, Math.min(500, x))));
  }

  static tanh(x: number): number {
    return Math.tanh(x);
  }

  static relu(x: number): number {
    return Math.max(0, x);
  }

  static applySigmoid(arr: number[]): number[] {
    return arr.map(x => this.sigmoid(x));
  }

  static applyTanh(arr: number[]): number[] {
    return arr.map(x => this.tanh(x));
  }

  static applyRelu(arr: number[]): number[] {
    return arr.map(x => this.relu(x));
  }

  static elementwiseMul(a: number[], b: number[]): number[] {
    return a.map((v, i) => v * b[i]);
  }
}

/**
 * LSTM Cell implementation for inference
 */
class LSTMCell {
  private units: number;
  private Wi: number[][];  // Input gate weights
  private Wf: number[][];  // Forget gate weights
  private Wc: number[][];  // Cell gate weights
  private Wo: number[][];  // Output gate weights
  private Ui: number[][];  // Input gate recurrent weights
  private Uf: number[][];  // Forget gate recurrent weights
  private Uc: number[][];  // Cell gate recurrent weights
  private Uo: number[][];  // Output gate recurrent weights
  private bi: number[];    // Input gate bias
  private bf: number[];    // Forget gate bias
  private bc: number[];    // Cell gate bias
  private bo: number[];    // Output gate bias

  constructor(kernel: number[][], recurrentKernel: number[][], bias: number[]) {
    // Keras LSTM stores weights as [input_dim, 4*units] for kernel
    // and [units, 4*units] for recurrent_kernel
    const inputDim = kernel.length;
    this.units = bias.length / 4;

    // Split kernel into 4 gates: i, f, c, o
    this.Wi = this.extractGate(kernel, 0);
    this.Wf = this.extractGate(kernel, 1);
    this.Wc = this.extractGate(kernel, 2);
    this.Wo = this.extractGate(kernel, 3);

    // Split recurrent kernel
    this.Ui = this.extractGate(recurrentKernel, 0);
    this.Uf = this.extractGate(recurrentKernel, 1);
    this.Uc = this.extractGate(recurrentKernel, 2);
    this.Uo = this.extractGate(recurrentKernel, 3);

    // Split bias
    this.bi = bias.slice(0, this.units);
    this.bf = bias.slice(this.units, 2 * this.units);
    this.bc = bias.slice(2 * this.units, 3 * this.units);
    this.bo = bias.slice(3 * this.units, 4 * this.units);
  }

  private extractGate(weights: number[][], gateIdx: number): number[][] {
    return weights.map(row => row.slice(gateIdx * this.units, (gateIdx + 1) * this.units));
  }

  /**
   * Run one timestep of LSTM
   */
  step(x: number[], hPrev: number[], cPrev: number[]): [number[], number[]] {
    // Input gate: i = sigmoid(Wi*x + Ui*h + bi)
    const xi = MatrixOps.vecAdd(
      MatrixOps.vecAdd(MatrixOps.matVecMul(this.Wi, x), MatrixOps.matVecMul(this.Ui, hPrev)),
      this.bi
    );
    const i = MatrixOps.applySigmoid(xi);

    // Forget gate: f = sigmoid(Wf*x + Uf*h + bf)
    const xf = MatrixOps.vecAdd(
      MatrixOps.vecAdd(MatrixOps.matVecMul(this.Wf, x), MatrixOps.matVecMul(this.Uf, hPrev)),
      this.bf
    );
    const f = MatrixOps.applySigmoid(xf);

    // Cell gate: c_tilde = tanh(Wc*x + Uc*h + bc)
    const xc = MatrixOps.vecAdd(
      MatrixOps.vecAdd(MatrixOps.matVecMul(this.Wc, x), MatrixOps.matVecMul(this.Uc, hPrev)),
      this.bc
    );
    const cTilde = MatrixOps.applyTanh(xc);

    // Cell state: c = f * c_prev + i * c_tilde
    const cNew = MatrixOps.vecAdd(
      MatrixOps.elementwiseMul(f, cPrev),
      MatrixOps.elementwiseMul(i, cTilde)
    );

    // Output gate: o = sigmoid(Wo*x + Uo*h + bo)
    const xo = MatrixOps.vecAdd(
      MatrixOps.vecAdd(MatrixOps.matVecMul(this.Wo, x), MatrixOps.matVecMul(this.Uo, hPrev)),
      this.bo
    );
    const o = MatrixOps.applySigmoid(xo);

    // Hidden state: h = o * tanh(c)
    const hNew = MatrixOps.elementwiseMul(o, MatrixOps.applyTanh(cNew));

    return [hNew, cNew];
  }

  getUnits(): number {
    return this.units;
  }
}

/**
 * Dense layer implementation
 */
class DenseLayer {
  private weights: number[][];
  private bias: number[];
  private activation: 'relu' | 'sigmoid' | 'linear';

  constructor(weights: number[][], bias: number[], activation: 'relu' | 'sigmoid' | 'linear' = 'linear') {
    // Keras stores dense weights as [input_dim, units], need to transpose for our matVecMul
    this.weights = this.transpose(weights);
    this.bias = bias;
    this.activation = activation;
  }

  private transpose(matrix: number[][]): number[][] {
    if (matrix.length === 0) return [];
    return matrix[0].map((_, i) => matrix.map(row => row[i]));
  }

  forward(x: number[]): number[] {
    let output = MatrixOps.vecAdd(MatrixOps.matVecMul(this.weights, x), this.bias);

    switch (this.activation) {
      case 'relu':
        output = MatrixOps.applyRelu(output);
        break;
      case 'sigmoid':
        output = MatrixOps.applySigmoid(output);
        break;
    }

    return output;
  }
}

/**
 * Main inference class for demand LSTM correction
 */
export class DemandLSTMInference {
  private zone: string;
  private config: ModelConfig | null = null;
  private lstm1: LSTMCell | null = null;
  private lstm2: LSTMCell | null = null;
  private dense1: DenseLayer | null = null;
  private dense2: DenseLayer | null = null;
  private lstm1Units: number = 32;
  private lstm2Units: number = 16;

  constructor(zone: string, modelsDir: string = 'models/lstm') {
    this.zone = zone;
    this.loadWeights(modelsDir);
  }

  private loadWeights(modelsDir: string): void {
    const modelPath = path.join(modelsDir, `lstm_${this.zone}.json`);

    if (!fs.existsSync(modelPath)) {
      console.warn(`  LSTM model not found for zone ${this.zone}: ${modelPath}`);
      return;
    }

    try {
      const content = fs.readFileSync(modelPath, 'utf-8');
      this.config = JSON.parse(content);

      if (!this.config) return;

      // Parse layers from config
      // Architecture: Input -> LSTM(32) -> Dropout -> LSTM(16) -> Dropout -> Dense(8, relu) -> Dense(1, sigmoid)
      const weightKeys = Object.keys(this.config.weights);

      for (const key of weightKeys) {
        const layer = this.config.weights[key];

        if (layer.type === 'LSTM') {
          // LSTM weights: [kernel, recurrent_kernel, bias]
          if (key.includes('lstm') && !this.lstm1) {
            // First LSTM layer
            const kernel = layer.weights[0] as unknown as number[][];
            const recurrentKernel = layer.weights[1] as unknown as number[][];
            const bias = layer.weights[2] as unknown as number[];
            this.lstm1 = new LSTMCell(kernel, recurrentKernel, bias);
            this.lstm1Units = this.lstm1.getUnits();
          } else if (layer.type === 'LSTM' && this.lstm1 && !this.lstm2) {
            // Second LSTM layer
            const kernel = layer.weights[0] as unknown as number[][];
            const recurrentKernel = layer.weights[1] as unknown as number[][];
            const bias = layer.weights[2] as unknown as number[];
            this.lstm2 = new LSTMCell(kernel, recurrentKernel, bias);
            this.lstm2Units = this.lstm2.getUnits();
          }
        } else if (layer.type === 'Dense') {
          // Dense weights: [kernel, bias]
          const weights = layer.weights[0] as unknown as number[][];
          const bias = layer.weights[1] as unknown as number[];

          if (!this.dense1) {
            this.dense1 = new DenseLayer(weights, bias, 'relu');
          } else if (!this.dense2) {
            this.dense2 = new DenseLayer(weights, bias, 'sigmoid');
          }
        }
      }

      console.log(`  Loaded LSTM weights for ${this.zone} (MAE: ${this.config.metrics.val_mae.toFixed(4)})`);
    } catch (error) {
      console.warn(`  Failed to load LSTM weights for ${this.zone}: ${error}`);
    }
  }

  isReady(): boolean {
    return this.lstm1 !== null && this.dense2 !== null;
  }

  /**
   * Run inference on a feature sequence
   * @param sequence Array of feature vectors, shape [SEQUENCE_LENGTH, FEATURES_PER_TIMESTEP]
   * @returns Correction factor between CORRECTION_MIN and CORRECTION_MAX
   */
  predict(sequence: number[][]): number {
    if (!this.isReady()) {
      return 1.0;  // No correction if model not loaded
    }

    // Initialize hidden states
    let h1 = new Array(this.lstm1Units).fill(0);
    let c1 = new Array(this.lstm1Units).fill(0);
    let h2 = this.lstm2 ? new Array(this.lstm2Units).fill(0) : [];
    let c2 = this.lstm2 ? new Array(this.lstm2Units).fill(0) : [];

    // Process sequence through first LSTM
    for (const features of sequence) {
      [h1, c1] = this.lstm1!.step(features, h1, c1);

      // If we have a second LSTM, feed h1 to it (for return_sequences=True on first LSTM)
      if (this.lstm2) {
        [h2, c2] = this.lstm2.step(h1, h2, c2);
      }
    }

    // Use the last hidden state
    let output = this.lstm2 ? h2 : h1;

    // Pass through dense layers
    if (this.dense1) {
      output = this.dense1.forward(output);
    }
    if (this.dense2) {
      output = this.dense2.forward(output);
    }

    // Convert from normalized output [0, 1] to correction factor [CORRECTION_MIN, CORRECTION_MAX]
    const normalizedOutput = output[0];
    const correction = CORRECTION_MIN + normalizedOutput * (CORRECTION_MAX - CORRECTION_MIN);

    return Math.max(CORRECTION_MIN, Math.min(CORRECTION_MAX, correction));
  }

  getMetrics(): { val_mae: number; val_loss: number } | null {
    return this.config?.metrics || null;
  }
}

/**
 * Manager class to handle multiple zone LSTM models
 */
export class DemandLSTMManager {
  private models: Map<string, DemandLSTMInference> = new Map();
  private modelsDir: string;

  constructor(modelsDir: string = 'models/lstm') {
    this.modelsDir = modelsDir;
  }

  /**
   * Load LSTM model for a zone
   */
  loadZone(zone: string): DemandLSTMInference | null {
    if (this.models.has(zone)) {
      return this.models.get(zone)!;
    }

    const model = new DemandLSTMInference(zone, this.modelsDir);
    if (model.isReady()) {
      this.models.set(zone, model);
      return model;
    }
    return null;
  }

  /**
   * Load all available zone models
   */
  loadAllZones(): number {
    const zones = [
      '01NLUZ', '02METRO', '03SLUZ', '04LEYTE', '05CEBU', '06NEGROS',
      '07BOHOL', '08PANAY', '09NWMIN', '10LANAO', '11NCMIN', '12NEMIN',
      '13SEMIN', '14SWMIN'
    ];

    let loaded = 0;
    for (const zone of zones) {
      if (this.loadZone(zone)) {
        loaded++;
      }
    }
    return loaded;
  }

  /**
   * Get correction factor for a zone
   */
  getCorrection(zone: string, sequence: number[][]): number {
    const model = this.models.get(zone);
    if (!model) {
      return 1.0;  // No correction if model not available
    }
    return model.predict(sequence);
  }

  /**
   * Check if a zone has LSTM model loaded
   */
  hasModel(zone: string): boolean {
    return this.models.has(zone) && this.models.get(zone)!.isReady();
  }
}

// Feature extraction helper matching Python trainer
export interface DemandLSTMFeatures {
  temperature: number;      // Normalized temp
  tempChange1h: number;
  tempChange3h: number;
  humidity: number;
  heatIndex: number;
  cloudCover: number;
  demandPrev1h: number;     // Normalized demand
  demandChange1h: number;
  demandSameHourYesterday: number;
  demandSameHourLastWeek: number;
  hourSin: number;
  hourCos: number;
  dayOfWeekSin: number;
  dayOfWeekCos: number;
  monthSin: number;
  monthCos: number;
  isWeekend: number;
  isHoliday: number;
  daysSinceHoliday: number;
  daysUntilHoliday: number;
  isMorningRamp: number;
  isEveningPeak: number;
}

export function featuresToArray(f: DemandLSTMFeatures): number[] {
  return [
    f.temperature,
    f.tempChange1h,
    f.tempChange3h,
    f.humidity,
    f.heatIndex,
    f.cloudCover,
    f.demandPrev1h,
    f.demandChange1h,
    f.demandSameHourYesterday,
    f.demandSameHourLastWeek,
    f.hourSin,
    f.hourCos,
    f.dayOfWeekSin,
    f.dayOfWeekCos,
    f.monthSin,
    f.monthCos,
    f.isWeekend,
    f.isHoliday,
    f.daysSinceHoliday,
    f.daysUntilHoliday,
    f.isMorningRamp,
    f.isEveningPeak
  ];
}
