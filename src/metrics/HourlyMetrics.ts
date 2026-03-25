/**
 * HourlyMetrics - Compute metrics for final hourly MW forecasts
 *
 * This is the "bottom line" metric - the combined accuracy after
 * multiplying level × shape and applying calibration.
 */

export interface HourlyMetricsResult {
  area: string;
  hourlyMAPE: number;  // %
  hourlyMAE: number;   // MW
  sampleCount: number;
}

export class HourlyMetrics {
  /**
   * Compute hourly metrics for final forecasts vs actuals
   *
   * @param data Array of {area, actualHourly, predictedHourly}
   * @returns Metrics per area
   */
  static compute(data: Array<{
    area: string;
    actualHourly: number[];    // 24 MW values
    predictedHourly: number[]; // 24 MW values
  }>): Map<string, HourlyMetricsResult> {
    const areaData = new Map<string, Array<{ actual: number[]; predicted: number[] }>>();

    // Group by area
    for (const record of data) {
      if (!areaData.has(record.area)) {
        areaData.set(record.area, []);
      }
      areaData.get(record.area)!.push({
        actual: record.actualHourly,
        predicted: record.predictedHourly
      });
    }

    // Compute metrics per area
    const results = new Map<string, HourlyMetricsResult>();

    for (const [area, records] of areaData.entries()) {
      const allErrors: number[] = [];
      const allPercentErrors: number[] = [];

      for (const record of records) {
        for (let h = 0; h < 24; h++) {
          const error = Math.abs(record.actual[h] - record.predicted[h]);
          allErrors.push(error);

          if (record.actual[h] > 0) {
            const percentError = (error / record.actual[h]) * 100;
            allPercentErrors.push(percentError);
          }
        }
      }

      const hourlyMAPE = allPercentErrors.reduce((s, e) => s + e, 0) / allPercentErrors.length;
      const hourlyMAE = allErrors.reduce((s, e) => s + e, 0) / allErrors.length;

      results.set(area, {
        area,
        hourlyMAPE,
        hourlyMAE,
        sampleCount: records.length
      });
    }

    return results;
  }

  /**
   * Print hourly metrics to console
   */
  static print(metrics: Map<string, HourlyMetricsResult>): void {
    console.log('\n=== Final Hourly Forecast Metrics ===');
    console.log('Area       | MAPE   | MAE (MW) | Samples');
    console.log('-----------|--------|----------|--------');

    for (const [area, result] of metrics.entries()) {
      const areaStr = area.padEnd(10);
      const mapeStr = result.hourlyMAPE.toFixed(2).padStart(6) + '%';
      const maeStr = result.hourlyMAE.toFixed(1).padStart(8);
      const samplesStr = result.sampleCount.toString().padStart(7);

      console.log(`${areaStr} | ${mapeStr} | ${maeStr} | ${samplesStr}`);
    }

    // Overall average
    const allMape = Array.from(metrics.values()).map(m => m.hourlyMAPE);
    const avgMape = allMape.reduce((s, m) => s + m, 0) / allMape.length;
    console.log('-----------|--------|----------|--------');
    console.log(`Overall    | ${avgMape.toFixed(2).padStart(6)}% | (avg MAPE across areas)`);
    console.log('');
  }
}
