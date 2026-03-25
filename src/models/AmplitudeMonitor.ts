/**
 * AmplitudeMonitor - Detects when predicted shapes have abnormal peak-to-trough amplitude
 *
 * Responsibilities:
 * 1. Compute amplitude = max(shape) / min(shape) for predicted shapes
 * 2. Compare against historical amplitude percentile range
 * 3. In "monitor" mode: log warnings only
 * 4. In "correct" mode: stretch flat shapes to match historical amplitude
 */

export interface AmplitudeMonitorConfig {
  mode: 'monitor' | 'correct';          // Monitor = log only, Correct = auto-fix
  amplitudeRange: [number, number];     // Percentile bounds [25, 75] = "normal"
}

export interface AmplitudeCheckResult {
  area: string;
  predictedAmplitude: number;
  historicalRange: [number, number];
  isFlat: boolean;        // Below lower bound
  isSpiky: boolean;       // Above upper bound
  correctedShape?: number[]; // Only present if mode = 'correct' and correction applied
}

export class AmplitudeMonitor {
  private config: AmplitudeMonitorConfig;
  private historicalAmplitudes: Map<string, number[]>; // Area → historical amplitude values

  static DEFAULT_CONFIG: AmplitudeMonitorConfig = {
    mode: 'monitor',
    amplitudeRange: [25, 75]
  };

  constructor(config: Partial<AmplitudeMonitorConfig> = {}) {
    this.config = { ...AmplitudeMonitor.DEFAULT_CONFIG, ...config };
    this.historicalAmplitudes = new Map();
  }

  /**
   * Set historical amplitudes from training data
   * @param dailyRecords Training data to compute amplitude distribution from
   */
  setHistoricalAmplitudes(dailyRecords: Array<{
    area: string;
    shape: number[];
  }>): void {
    const areaAmplitudes = new Map<string, number[]>();

    // Compute amplitude for each record
    for (const record of dailyRecords) {
      const amplitude = this.computeAmplitude(record.shape);
      if (!areaAmplitudes.has(record.area)) {
        areaAmplitudes.set(record.area, []);
      }
      areaAmplitudes.get(record.area)!.push(amplitude);
    }

    this.historicalAmplitudes = areaAmplitudes;
  }

  /**
   * Check amplitude of a predicted shape
   * @param area Area code
   * @param predictedShape Predicted 24-hour shape
   * @returns Amplitude check result with optional correction
   */
  checkAmplitude(area: string, predictedShape: number[]): AmplitudeCheckResult {
    const predictedAmplitude = this.computeAmplitude(predictedShape);

    const historicalRange = this.getHistoricalRange(area);
    const isFlat = predictedAmplitude < historicalRange[0];
    const isSpiky = predictedAmplitude > historicalRange[1];

    const result: AmplitudeCheckResult = {
      area,
      predictedAmplitude,
      historicalRange,
      isFlat,
      isSpiky
    };

    // Log warning if outside range
    if (isFlat) {
      console.warn(
        `[AmplitudeMonitor] ${area} shape is too flat: amplitude ${predictedAmplitude.toFixed(2)} < ${historicalRange[0].toFixed(2)} (historical P${this.config.amplitudeRange[0]})`
      );
    } else if (isSpiky) {
      console.warn(
        `[AmplitudeMonitor] ${area} shape is too spiky: amplitude ${predictedAmplitude.toFixed(2)} > ${historicalRange[1].toFixed(2)} (historical P${this.config.amplitudeRange[1]})`
      );
    }

    // Apply correction if in "correct" mode and shape is flat
    if (this.config.mode === 'correct' && isFlat) {
      const targetAmplitude = historicalRange[0];
      const correctedShape = this.stretchShape(predictedShape, targetAmplitude);
      result.correctedShape = correctedShape;
      console.log(`[AmplitudeMonitor] ${area} shape corrected: amplitude ${predictedAmplitude.toFixed(2)} → ${this.computeAmplitude(correctedShape).toFixed(2)}`);
    }

    return result;
  }

  /**
   * Compute amplitude = max / min for a shape
   */
  private computeAmplitude(shape: number[]): number {
    const max = Math.max(...shape);
    const min = Math.min(...shape.filter(v => v > 0)); // Ignore zeros
    return max / min;
  }

  /**
   * Get historical amplitude percentile range for an area
   */
  private getHistoricalRange(area: string): [number, number] {
    const amplitudes = this.historicalAmplitudes.get(area);
    if (!amplitudes || amplitudes.length === 0) {
      // No historical data - use default range
      return [2.0, 5.0]; // Conservative default
    }

    const sorted = [...amplitudes].sort((a, b) => a - b);
    const lower = this.percentile(sorted, this.config.amplitudeRange[0]);
    const upper = this.percentile(sorted, this.config.amplitudeRange[1]);

    return [lower, upper];
  }

  /**
   * Compute percentile of a sorted array
   */
  private percentile(sortedValues: number[], p: number): number {
    if (sortedValues.length === 0) return 0;
    const index = (p / 100) * (sortedValues.length - 1);
    const lower = Math.floor(index);
    const upper = Math.ceil(index);
    if (lower === upper) {
      return sortedValues[lower];
    }
    const weight = index - lower;
    return sortedValues[lower] * (1 - weight) + sortedValues[upper] * weight;
  }

  /**
   * Stretch a flat shape to match target amplitude
   * Preserves shape structure, just increases peak-to-trough contrast
   */
  private stretchShape(shape: number[], targetAmplitude: number): number[] {
    const currentAmplitude = this.computeAmplitude(shape);
    if (currentAmplitude >= targetAmplitude) {
      return shape; // Already meets target
    }

    const mean = shape.reduce((sum, v) => sum + v, 0) / shape.length;

    // Stretch: move each value away from mean proportionally
    const stretchFactor = targetAmplitude / currentAmplitude;

    const stretched = shape.map(val => {
      const deviation = val - mean;
      const stretchedVal = mean + deviation * stretchFactor;
      return Math.max(0, stretchedVal); // Ensure non-negative
    });

    // Renormalize to sum to 1.0
    const sum = stretched.reduce((s, v) => s + v, 0);
    return stretched.map(v => v / sum);
  }
}
