/**
 * ForecastCombiner - Multiplies level × shape to produce hourly MW forecasts
 *
 * Responsibilities:
 * 1. Combine daily total (from Level Model) with shape (from Shape Model)
 * 2. Apply sanity clamps (0.3× to 2.0× historical median per hour)
 * 3. Verify sum(forecast[0..23]) equals dailyTotal
 */
export class ForecastCombiner {
  private historicalMedians: Map<string, number[]>;

  /**
   * @param historicalMedians Optional historical median values per area per hour (for sanity clamping)
   */
  constructor(historicalMedians?: Map<string, number[]>) {
    this.historicalMedians = historicalMedians || new Map();
  }

  /**
   * Combine daily total with shape to produce hourly forecast
   * @param area Area code
   * @param dailyTotal Predicted daily total MW
   * @param shape Predicted 24-hour shape (must sum to 1.0)
   * @returns Hourly forecast (24 values in MW)
   */
  combine(area: string, dailyTotal: number, shape: number[]): number[] {
    if (shape.length !== 24) {
      throw new Error(`Shape must have 24 values, got ${shape.length}`);
    }

    // Verify shape sums to 1.0 (within floating point tolerance)
    const shapeSum = shape.reduce((sum, val) => sum + val, 0);
    if (Math.abs(shapeSum - 1.0) > 0.001) {
      console.warn(`[ForecastCombiner] Shape sum = ${shapeSum.toFixed(6)}, expected 1.0. Renormalizing...`);
      const normalized = shape.map(v => v / shapeSum);
      return this.combine(area, dailyTotal, normalized);
    }

    // Combine: hourly[h] = dailyTotal × shape[h]
    const hourlyForecast = shape.map(s => dailyTotal * s);

    // Apply sanity clamps if historical medians are available
    if (this.historicalMedians.has(area)) {
      const medians = this.historicalMedians.get(area)!;
      const clamped = hourlyForecast.map((val, h) => {
        const median = medians[h];
        if (median === 0) return val; // No historical data for this hour

        const lowerBound = median * 0.3;
        const upperBound = median * 2.0;

        if (val < lowerBound) {
          console.warn(`[ForecastCombiner] ${area} hour ${h}: ${val.toFixed(1)} < ${lowerBound.toFixed(1)} (0.3× median). Clamping.`);
          return lowerBound;
        }
        if (val > upperBound) {
          console.warn(`[ForecastCombiner] ${area} hour ${h}: ${val.toFixed(1)} > ${upperBound.toFixed(1)} (2.0× median). Clamping.`);
          return upperBound;
        }

        return val;
      });

      return clamped;
    }

    return hourlyForecast;
  }

  /**
   * Set historical medians for sanity clamping
   * @param area Area code
   * @param medians 24-hour median values from training data
   */
  setHistoricalMedians(area: string, medians: number[]): void {
    if (medians.length !== 24) {
      throw new Error(`Medians must have 24 values, got ${medians.length}`);
    }
    this.historicalMedians.set(area, medians);
  }

  /**
   * Compute historical medians from daily records
   * @param dailyRecords Array of daily records from training data
   */
  computeHistoricalMedians(dailyRecords: Array<{
    area: string;
    hourlyDemand: number[];
  }>): void {
    const areaHourlyValues = new Map<string, number[][]>();

    // Collect all hourly values per area per hour
    for (const record of dailyRecords) {
      if (!areaHourlyValues.has(record.area)) {
        areaHourlyValues.set(record.area, Array.from({ length: 24 }, () => []));
      }
      const hourlyArrays = areaHourlyValues.get(record.area)!;
      for (let h = 0; h < 24; h++) {
        hourlyArrays[h].push(record.hourlyDemand[h]);
      }
    }

    // Compute median for each area × hour
    for (const [area, hourlyArrays] of areaHourlyValues.entries()) {
      const medians = hourlyArrays.map(values => {
        if (values.length === 0) return 0;
        const sorted = [...values].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        if (sorted.length % 2 === 0) {
          return (sorted[mid - 1] + sorted[mid]) / 2;
        } else {
          return sorted[mid];
        }
      });
      this.setHistoricalMedians(area, medians);
    }
  }
}
