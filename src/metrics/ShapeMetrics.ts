/**
 * ShapeMetrics - Compute metrics for 24-hour shape predictions
 *
 * Metrics:
 * - Shape MAPE: Mean absolute percentage error for normalized shapes
 * - Peak hour accuracy: Hours difference between predicted and actual peak
 * - Profile correlation: Pearson correlation between shapes
 * - Amplitude ratio: Predicted amplitude / actual amplitude
 */

export interface ShapeMetricsResult {
  area: string;
  shapeMAPE: number;           // %
  peakHourAccuracy: number;    // Average hours off
  profileCorrelation: number;  // Pearson r (0-1)
  amplitudeRatio: number;      // Predicted/actual (1.0 = perfect match)
  sampleCount: number;
}

export class ShapeMetrics {
  /**
   * Compute shape metrics for a set of predictions vs actuals
   *
   * @param data Array of {area, actualShape, predictedShape}
   * @returns Metrics per area
   */
  static compute(data: Array<{
    area: string;
    actualShape: number[];    // 24 values summing to 1.0
    predictedShape: number[]; // 24 values summing to 1.0
  }>): Map<string, ShapeMetricsResult> {
    const areaData = new Map<string, Array<{ actual: number[]; predicted: number[] }>>();

    // Group by area
    for (const record of data) {
      if (!areaData.has(record.area)) {
        areaData.set(record.area, []);
      }
      areaData.get(record.area)!.push({
        actual: record.actualShape,
        predicted: record.predictedShape
      });
    }

    // Compute metrics per area
    const results = new Map<string, ShapeMetricsResult>();

    for (const [area, records] of areaData.entries()) {
      // Shape MAPE: element-wise percentage error across all hours
      const allShapeMAPE: number[] = [];
      for (const record of records) {
        for (let h = 0; h < 24; h++) {
          if (record.actual[h] > 0) {
            const error = Math.abs((record.actual[h] - record.predicted[h]) / record.actual[h]) * 100;
            allShapeMAPE.push(error);
          }
        }
      }
      const shapeMAPE = allShapeMAPE.reduce((s, e) => s + e, 0) / allShapeMAPE.length;

      // Peak hour accuracy: hours difference
      const peakHourDiffs: number[] = [];
      for (const record of records) {
        const actualPeakHour = this.findPeakHour(record.actual);
        const predictedPeakHour = this.findPeakHour(record.predicted);
        peakHourDiffs.push(Math.abs(actualPeakHour - predictedPeakHour));
      }
      const peakHourAccuracy = peakHourDiffs.reduce((s, d) => s + d, 0) / peakHourDiffs.length;

      // Profile correlation: average Pearson correlation
      const correlations: number[] = [];
      for (const record of records) {
        const corr = this.pearsonCorrelation(record.actual, record.predicted);
        correlations.push(corr);
      }
      const profileCorrelation = correlations.reduce((s, c) => s + c, 0) / correlations.length;

      // Amplitude ratio: predicted/actual
      const amplitudeRatios: number[] = [];
      for (const record of records) {
        const actualAmp = this.computeAmplitude(record.actual);
        const predictedAmp = this.computeAmplitude(record.predicted);
        if (actualAmp > 0) {
          amplitudeRatios.push(predictedAmp / actualAmp);
        }
      }
      const amplitudeRatio = amplitudeRatios.reduce((s, r) => s + r, 0) / amplitudeRatios.length;

      results.set(area, {
        area,
        shapeMAPE,
        peakHourAccuracy,
        profileCorrelation,
        amplitudeRatio,
        sampleCount: records.length
      });
    }

    return results;
  }

  /**
   * Print shape metrics to console
   */
  static print(metrics: Map<string, ShapeMetricsResult>): void {
    console.log('\n=== Shape Model Metrics (24h Profiles) ===');
    console.log('Area       | MAPE   | Peak Δ (h) | Corr  | Amp Ratio | Samples');
    console.log('-----------|--------|------------|-------|-----------|--------');

    for (const [area, result] of metrics.entries()) {
      const areaStr = area.padEnd(10);
      const mapeStr = result.shapeMAPE.toFixed(2).padStart(6) + '%';
      const peakStr = result.peakHourAccuracy.toFixed(1).padStart(10);
      const corrStr = result.profileCorrelation.toFixed(3).padStart(5);
      const ampStr = result.amplitudeRatio.toFixed(2).padStart(9);
      const samplesStr = result.sampleCount.toString().padStart(7);

      console.log(`${areaStr} | ${mapeStr} | ${peakStr} | ${corrStr} | ${ampStr} | ${samplesStr}`);
    }

    // Overall average
    const allMape = Array.from(metrics.values()).map(m => m.shapeMAPE);
    const avgMape = allMape.reduce((s, m) => s + m, 0) / allMape.length;
    const allCorr = Array.from(metrics.values()).map(m => m.profileCorrelation);
    const avgCorr = allCorr.reduce((s, c) => s + c, 0) / allCorr.length;

    console.log('-----------|--------|------------|-------|-----------|--------');
    console.log(`Overall    | ${avgMape.toFixed(2).padStart(6)}% | (avg)      | ${avgCorr.toFixed(3).padStart(5)} | (avg)     |`);
    console.log('');
  }

  /**
   * Find hour with maximum value
   */
  private static findPeakHour(shape: number[]): number {
    let maxHour = 0;
    let maxVal = shape[0];
    for (let h = 1; h < shape.length; h++) {
      if (shape[h] > maxVal) {
        maxVal = shape[h];
        maxHour = h;
      }
    }
    return maxHour;
  }

  /**
   * Compute amplitude = max / min
   */
  private static computeAmplitude(shape: number[]): number {
    const max = Math.max(...shape);
    const min = Math.min(...shape.filter(v => v > 0));
    return max / min;
  }

  /**
   * Compute Pearson correlation coefficient
   */
  private static pearsonCorrelation(x: number[], y: number[]): number {
    if (x.length !== y.length) {
      throw new Error('Arrays must have same length');
    }

    const n = x.length;
    const meanX = x.reduce((s, v) => s + v, 0) / n;
    const meanY = y.reduce((s, v) => s + v, 0) / n;

    let numerator = 0;
    let sumSqX = 0;
    let sumSqY = 0;

    for (let i = 0; i < n; i++) {
      const dx = x[i] - meanX;
      const dy = y[i] - meanY;
      numerator += dx * dy;
      sumSqX += dx * dx;
      sumSqY += dy * dy;
    }

    const denominator = Math.sqrt(sumSqX * sumSqY);
    if (denominator === 0) return 0;

    return numerator / denominator;
  }
}
