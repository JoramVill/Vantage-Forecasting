/**
 * BiasCorrector - Station-specific bias correction for capacity factor forecasts
 *
 * Purpose:
 * - Learn systematic biases during training (predicted - actual)
 * - Apply corrections during forecasting to reduce under/over-forecasting
 * - Store per-station bias factors for persistence
 *
 * Usage:
 * 1. During training: call learnBias() with predicted vs actual data
 * 2. During forecasting: call applyCorrection() to adjust predictions
 * 3. Corrected CF = clamp(rawPrediction - bias, 0, 1)
 */

import { StationType, getStationTypeFromCode } from '../../types/capacityFactor.js';

export interface StationBias {
  stationCode: string;
  stationType: StationType;
  bias: number;              // Average (predicted - actual)
  sampleCount: number;       // Number of training samples
  underForecastPct: number;  // Percentage of hours under-forecasting
  overForecastPct: number;   // Percentage of hours over-forecasting
}

export interface BiasCorrection {
  enabled: boolean;
  stationBiases: Map<string, StationBias>;
  windAverageBias: number;
  solarAverageBias: number;
  learnedAt: string;         // ISO timestamp when biases were learned
}

export class BiasCorrector {
  private biasMap: Map<string, StationBias>;
  private enabled: boolean;

  constructor(enabled: boolean = false) {
    this.biasMap = new Map();
    this.enabled = enabled;
  }

  /**
   * Learn biases from training data
   *
   * @param trainingResults - Array of { stationCode, predicted, actual }
   * @returns Summary statistics
   */
  learnBias(
    trainingResults: Array<{ stationCode: string; predicted: number; actual: number }>
  ): { windAvgBias: number; solarAvgBias: number; totalStations: number } {
    // Clear existing biases
    this.biasMap.clear();

    // Group by station
    const stationData = new Map<string, Array<{ predicted: number; actual: number }>>();
    for (const result of trainingResults) {
      if (!stationData.has(result.stationCode)) {
        stationData.set(result.stationCode, []);
      }
      stationData.get(result.stationCode)!.push({
        predicted: result.predicted,
        actual: result.actual,
      });
    }

    // Calculate bias for each station
    let windBiasSum = 0;
    let windStationCount = 0;
    let solarBiasSum = 0;
    let solarStationCount = 0;

    for (const [stationCode, data] of stationData) {
      if (data.length < 10) continue; // Need minimum samples

      const stationType = getStationTypeFromCode(stationCode);
      let biasSum = 0;
      let underCount = 0;
      let overCount = 0;

      // Calculate bias (predicted - actual)
      for (const sample of data) {
        // Only consider meaningful samples (ignore very low actual CFs)
        if (sample.actual > 0.01) {
          const bias = sample.predicted - sample.actual;
          biasSum += bias;
          if (bias < 0) underCount++;
          else overCount++;
        }
      }

      const avgBias = biasSum / data.length;
      const stationBias: StationBias = {
        stationCode,
        stationType,
        bias: avgBias,
        sampleCount: data.length,
        underForecastPct: (underCount / data.length) * 100,
        overForecastPct: (overCount / data.length) * 100,
      };

      this.biasMap.set(stationCode, stationBias);

      // Accumulate type-level statistics
      if (stationType === StationType.WIND) {
        windBiasSum += avgBias;
        windStationCount++;
      } else if (stationType === StationType.SOLAR) {
        solarBiasSum += avgBias;
        solarStationCount++;
      }
    }

    return {
      windAvgBias: windStationCount > 0 ? windBiasSum / windStationCount : 0,
      solarAvgBias: solarStationCount > 0 ? solarBiasSum / solarStationCount : 0,
      totalStations: this.biasMap.size,
    };
  }

  /**
   * Apply bias correction to a prediction
   *
   * @param stationCode - Station identifier
   * @param rawPrediction - Uncorrected prediction
   * @returns Bias-corrected prediction, clamped to [0, 1]
   */
  applyCorrection(stationCode: string, rawPrediction: number): number {
    if (!this.enabled) {
      return rawPrediction;
    }

    // Dont apply bias correction to nighttime predictions (solar should be 0)
    // This prevents negative biases from creating non-zero values at night
    if (rawPrediction < 0.001) {
      return rawPrediction;
    }

    const bias = this.biasMap.get(stationCode);
    if (!bias) {
      // No bias data for this station, return as-is
      return rawPrediction;
    }

    // Corrected = raw - bias
    // If bias is negative (under-forecasting), this increases prediction
    // If bias is positive (over-forecasting), this decreases prediction
    const corrected = rawPrediction - bias.bias;

    // Clamp to valid capacity factor range
    return Math.max(0, Math.min(1, corrected));
  }

  /**
   * Get bias for a specific station
   */
  getStationBias(stationCode: string): StationBias | undefined {
    return this.biasMap.get(stationCode);
  }

  /**
   * Get all station biases
   */
  getAllBiases(): Map<string, StationBias> {
    return new Map(this.biasMap);
  }

  /**
   * Enable or disable bias correction
   */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  /**
   * Check if bias correction is enabled
   */
  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Export bias correction data for persistence
   */
  exportBiases(): BiasCorrection {
    return {
      enabled: this.enabled,
      stationBiases: new Map(this.biasMap),
      windAverageBias: this.getAverageBiasByType(StationType.WIND),
      solarAverageBias: this.getAverageBiasByType(StationType.SOLAR),
      learnedAt: new Date().toISOString(),
    };
  }

  /**
   * Import bias correction data
   */
  importBiases(data: BiasCorrection): void {
    this.enabled = data.enabled;
    this.biasMap = new Map(data.stationBiases);
  }

  /**
   * Get average bias for a station type
   */
  private getAverageBiasByType(stationType: StationType): number {
    let sum = 0;
    let count = 0;

    for (const [, bias] of this.biasMap) {
      if (bias.stationType === stationType) {
        sum += bias.bias;
        count++;
      }
    }

    return count > 0 ? sum / count : 0;
  }

  /**
   * Print bias summary to console
   */
  printSummary(logger: (msg: string) => void = console.log): void {
    if (this.biasMap.size === 0) {
      logger('   No bias data available');
      return;
    }

    // Group by type
    const windBiases: StationBias[] = [];
    const solarBiases: StationBias[] = [];
    const otherBiases: StationBias[] = [];

    for (const [, bias] of this.biasMap) {
      if (bias.stationType === StationType.WIND) {
        windBiases.push(bias);
      } else if (bias.stationType === StationType.SOLAR) {
        solarBiases.push(bias);
      } else {
        otherBiases.push(bias);
      }
    }

    if (windBiases.length > 0) {
      const avgBias = windBiases.reduce((sum, b) => sum + b.bias, 0) / windBiases.length;
      logger(`   🌬️  Wind: ${windBiases.length} stations, avg bias = ${avgBias.toFixed(4)} (${avgBias < 0 ? 'UNDER' : 'OVER'}-forecasting)`);

      // Show top 5 most biased
      const sorted = [...windBiases].sort((a, b) => Math.abs(b.bias) - Math.abs(a.bias));
      for (let i = 0; i < Math.min(5, sorted.length); i++) {
        const b = sorted[i];
        logger(`      ${b.stationCode}: ${b.bias.toFixed(4)} (${b.underForecastPct.toFixed(1)}% under)`);
      }
    }

    if (solarBiases.length > 0) {
      const avgBias = solarBiases.reduce((sum, b) => sum + b.bias, 0) / solarBiases.length;
      logger(`   ☀️  Solar: ${solarBiases.length} stations, avg bias = ${avgBias.toFixed(4)} (${avgBias < 0 ? 'UNDER' : 'OVER'}-forecasting)`);

      // Show top 5 most biased
      const sorted = [...solarBiases].sort((a, b) => Math.abs(b.bias) - Math.abs(a.bias));
      for (let i = 0; i < Math.min(5, sorted.length); i++) {
        const b = sorted[i];
        logger(`      ${b.stationCode}: ${b.bias.toFixed(4)} (${b.underForecastPct.toFixed(1)}% under)`);
      }
    }

    if (otherBiases.length > 0) {
      const avgBias = otherBiases.reduce((sum, b) => sum + b.bias, 0) / otherBiases.length;
      logger(`   📊 Other: ${otherBiases.length} stations, avg bias = ${avgBias.toFixed(4)}`);
    }
  }
}
