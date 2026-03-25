/**
 * LevelMetrics - Compute metrics for daily total predictions
 *
 * Metrics:
 * - MAPE: Mean Absolute Percentage Error
 * - MAE: Mean Absolute Error
 * - Bias: Mean signed percentage error (positive = over-prediction)
 */

export interface LevelMetricsResult {
  area: string;
  mape: number;    // %
  mae: number;     // MW
  bias: number;    // % (positive = over-prediction, negative = under-prediction)
  sampleCount: number;
}

export class LevelMetrics {
  /**
   * Compute level metrics for a set of predictions vs actuals
   *
   * @param data Array of {area, actualTotal, predictedTotal}
   * @returns Metrics per area
   */
  static compute(data: Array<{
    area: string;
    actualTotal: number;
    predictedTotal: number;
  }>): Map<string, LevelMetricsResult> {
    const areaData = new Map<string, Array<{ actual: number; predicted: number }>>();

    // Group by area
    for (const record of data) {
      if (!areaData.has(record.area)) {
        areaData.set(record.area, []);
      }
      areaData.get(record.area)!.push({
        actual: record.actualTotal,
        predicted: record.predictedTotal
      });
    }

    // Compute metrics per area
    const results = new Map<string, LevelMetricsResult>();

    for (const [area, records] of areaData.entries()) {
      const errors = records.map(r => Math.abs(r.actual - r.predicted));
      const percentErrors = records.map(r =>
        Math.abs((r.actual - r.predicted) / r.actual) * 100
      );
      const signedPercentErrors = records.map(r =>
        ((r.predicted - r.actual) / r.actual) * 100
      );

      const mape = percentErrors.reduce((sum, e) => sum + e, 0) / percentErrors.length;
      const mae = errors.reduce((sum, e) => sum + e, 0) / errors.length;
      const bias = signedPercentErrors.reduce((sum, e) => sum + e, 0) / signedPercentErrors.length;

      results.set(area, {
        area,
        mape,
        mae,
        bias,
        sampleCount: records.length
      });
    }

    return results;
  }

  /**
   * Print level metrics to console
   */
  static print(metrics: Map<string, LevelMetricsResult>): void {
    console.log('\n=== Level Model Metrics (Daily Totals) ===');
    console.log('Area       | MAPE   | MAE (MW) | Bias   | Samples');
    console.log('-----------|--------|----------|--------|--------');

    for (const [area, result] of metrics.entries()) {
      const areaStr = area.padEnd(10);
      const mapeStr = result.mape.toFixed(2).padStart(6) + '%';
      const maeStr = result.mae.toFixed(1).padStart(8);
      const biasStr = (result.bias >= 0 ? '+' : '') + result.bias.toFixed(2).padStart(5) + '%';
      const samplesStr = result.sampleCount.toString().padStart(7);

      console.log(`${areaStr} | ${mapeStr} | ${maeStr} | ${biasStr} | ${samplesStr}`);
    }

    // Overall average
    const allMape = Array.from(metrics.values()).map(m => m.mape);
    const avgMape = allMape.reduce((s, m) => s + m, 0) / allMape.length;
    console.log('-----------|--------|----------|--------|--------');
    console.log(`Overall    | ${avgMape.toFixed(2).padStart(6)}% | (avg MAPE across areas)`);
    console.log('');
  }
}
