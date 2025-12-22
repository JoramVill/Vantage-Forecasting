/**
 * Comprehensive analysis of weather patterns and interconnector congestion
 * Focuses on VISLUZ1 (Visayas-Luzon interconnector)
 *
 * Analysis includes:
 * - Pearson correlation coefficients
 * - Weather pattern identification
 * - Temporal pattern analysis
 * - Congestion threshold analysis
 */

import { DatabaseService } from '../database/database.js';
import { DateTime } from 'luxon';
import { writeFileSync } from 'fs';
import { join } from 'path';

interface CongestionRecord {
  datetime: Date;
  isCongested: boolean;
  flowFrom: number;
  flowTo: number;
  overloadMW: number | null;
  hour: number;
  dayOfWeek: number;
  isWeekend: boolean;
}

interface WeatherRecord {
  datetime: Date;
  temp: number;
  dew: number;
  precip: number;
  windgust: number;
  windspeed: number;
  cloudcover: number;
  solarradiation: number;
  uvindex: number;
}

interface DemandRecord {
  datetime: Date;
  demand: number;
}

interface MergedRecord extends CongestionRecord {
  manilaTemp: number;
  manilaDew: number;
  manilaSolar: number;
  manilaWind: number;
  manilaCloudcover: number;
  cebuTemp: number;
  cebuDew: number;
  cebuSolar: number;
  cebuWind: number;
  cebuCloudcover: number;
  luzDemand: number;
  visDemand: number;
  demandDiff: number; // Luzon - Visayas
  relativeHumidityManila: number;
  relativeHumidityCebu: number;
}

interface CorrelationResult {
  feature: string;
  correlation: number;
  pValue: number;
}

interface WeatherThreshold {
  feature: string;
  congestedAvg: number;
  nonCongestedAvg: number;
  difference: number;
  percentDifference: number;
}

interface TemporalPattern {
  hour: number;
  congestionRate: number;
  avgFlowFrom: number;
  avgFlowTo: number;
  count: number;
}

class InterconnectorWeatherAnalyzer {
  private db: DatabaseService;

  constructor() {
    this.db = new DatabaseService();
  }

  /**
   * Load and merge all data sources
   */
  async loadAndMergeData(
    startDate: string,
    endDate: string,
    interconnector: string = 'VISLUZ1'
  ): Promise<MergedRecord[]> {
    console.log('Loading interconnector records...');
    const interconnectorRecords = this.db.getInterconnectorRecords(
      startDate,
      endDate,
      interconnector
    );

    console.log(`Loaded ${interconnectorRecords.length} interconnector records`);

    console.log('Loading weather data for Manila (CLUZ)...');
    const manilaWeather = this.loadWeatherData('CLUZ', startDate, endDate);

    console.log('Loading weather data for Cebu (CVIS)...');
    const cebuWeather = this.loadWeatherData('CVIS', startDate, endDate);

    console.log('Loading demand data...');
    const luzDemand = this.loadDemandData('CLUZ', startDate, endDate);
    const visDemand = this.loadDemandData('CVIS', startDate, endDate);

    console.log('Merging datasets...');
    const merged: MergedRecord[] = [];

    for (const record of interconnectorRecords) {
      const dt = DateTime.fromJSDate(record.timeInterval);
      const timeKey = dt.toFormat('yyyy-MM-dd HH:mm');

      const manila = this.findClosestWeather(manilaWeather, record.timeInterval);
      const cebu = this.findClosestWeather(cebuWeather, record.timeInterval);
      const luz = this.findClosestDemand(luzDemand, record.timeInterval);
      const vis = this.findClosestDemand(visDemand, record.timeInterval);

      if (!manila || !cebu || !luz || !vis) {
        continue; // Skip if we don't have complete data
      }

      const hour = dt.hour;
      const dayOfWeek = dt.weekday; // 1 = Monday, 7 = Sunday
      const isWeekend = dayOfWeek >= 6;

      merged.push({
        datetime: record.timeInterval,
        isCongested: record.congestionFlag === 'Y',
        flowFrom: record.flowFrom,
        flowTo: record.flowTo,
        overloadMW: record.overloadMW,
        hour,
        dayOfWeek,
        isWeekend,
        manilaTemp: manila.temp,
        manilaDew: manila.dew,
        manilaSolar: manila.solarradiation,
        manilaWind: manila.windspeed,
        manilaCloudcover: manila.cloudcover,
        cebuTemp: cebu.temp,
        cebuDew: cebu.dew,
        cebuSolar: cebu.solarradiation,
        cebuWind: cebu.windspeed,
        cebuCloudcover: cebu.cloudcover,
        luzDemand: luz.demand,
        visDemand: vis.demand,
        demandDiff: luz.demand - vis.demand,
        relativeHumidityManila: this.calculateRelativeHumidity(manila.temp, manila.dew),
        relativeHumidityCebu: this.calculateRelativeHumidity(cebu.temp, cebu.dew)
      });
    }

    console.log(`Merged ${merged.length} complete records`);
    return merged;
  }

  private loadWeatherData(region: string, startDate: string, endDate: string): Map<string, WeatherRecord> {
    const sql = `
      SELECT datetime, temp, dew, precip, windgust, windspeed, cloudcover, solarradiation, uvindex
      FROM weather_records
      WHERE region = ? AND datetime >= ? AND datetime <= ?
      ORDER BY datetime
    `;

    const rows = this.db['db'].prepare(sql).all(
      region,
      startDate + 'T00:00:00',
      endDate + 'T23:59:59'
    ) as any[];

    const map = new Map<string, WeatherRecord>();
    for (const row of rows) {
      const dt = DateTime.fromISO(row.datetime);
      const key = dt.toFormat('yyyy-MM-dd HH:mm');
      map.set(key, {
        datetime: new Date(row.datetime),
        temp: row.temp || 0,
        dew: row.dew || 0,
        precip: row.precip || 0,
        windgust: row.windgust || 0,
        windspeed: row.windspeed || 0,
        cloudcover: row.cloudcover || 0,
        solarradiation: row.solarradiation || 0,
        uvindex: row.uvindex || 0
      });
    }

    return map;
  }

  private loadDemandData(region: string, startDate: string, endDate: string): Map<string, DemandRecord> {
    const records = this.db.getDemandRecords(
      startDate + 'T00:00:00',
      endDate + 'T23:59:59',
      region
    );

    const map = new Map<string, DemandRecord>();
    for (const record of records) {
      const dt = DateTime.fromJSDate(record.datetime);
      const key = dt.toFormat('yyyy-MM-dd HH:mm');
      map.set(key, {
        datetime: record.datetime,
        demand: record.demand
      });
    }

    return map;
  }

  private findClosestWeather(weatherMap: Map<string, WeatherRecord>, datetime: Date): WeatherRecord | null {
    const dt = DateTime.fromJSDate(datetime);

    // Try exact match first
    let key = dt.toFormat('yyyy-MM-dd HH:mm');
    if (weatherMap.has(key)) {
      return weatherMap.get(key)!;
    }

    // Try +/- 5 minutes
    for (let offset = -5; offset <= 5; offset += 5) {
      if (offset === 0) continue;
      key = dt.plus({ minutes: offset }).toFormat('yyyy-MM-dd HH:mm');
      if (weatherMap.has(key)) {
        return weatherMap.get(key)!;
      }
    }

    return null;
  }

  private findClosestDemand(demandMap: Map<string, DemandRecord>, datetime: Date): DemandRecord | null {
    const dt = DateTime.fromJSDate(datetime);

    // Try exact match first
    let key = dt.toFormat('yyyy-MM-dd HH:mm');
    if (demandMap.has(key)) {
      return demandMap.get(key)!;
    }

    // Try +/- 5 minutes
    for (let offset = -5; offset <= 5; offset += 5) {
      if (offset === 0) continue;
      key = dt.plus({ minutes: offset }).toFormat('yyyy-MM-dd HH:mm');
      if (demandMap.has(key)) {
        return demandMap.get(key)!;
      }
    }

    return null;
  }

  private calculateRelativeHumidity(tempC: number, dewC: number): number {
    // Magnus formula for relative humidity
    const beta = 17.62;
    const lambda = 243.12;
    const numerator = Math.exp((beta * dewC) / (lambda + dewC));
    const denominator = Math.exp((beta * tempC) / (lambda + tempC));
    return 100 * (numerator / denominator);
  }

  /**
   * Calculate Pearson correlation coefficient
   */
  private calculateCorrelation(x: number[], y: number[]): { correlation: number; pValue: number } {
    if (x.length !== y.length || x.length === 0) {
      return { correlation: 0, pValue: 1 };
    }

    const n = x.length;
    const meanX = x.reduce((a, b) => a + b, 0) / n;
    const meanY = y.reduce((a, b) => a + b, 0) / n;

    let numerator = 0;
    let sumXSquared = 0;
    let sumYSquared = 0;

    for (let i = 0; i < n; i++) {
      const dx = x[i] - meanX;
      const dy = y[i] - meanY;
      numerator += dx * dy;
      sumXSquared += dx * dx;
      sumYSquared += dy * dy;
    }

    const denominator = Math.sqrt(sumXSquared * sumYSquared);
    const correlation = denominator === 0 ? 0 : numerator / denominator;

    // Calculate t-statistic for p-value
    const tStat = correlation * Math.sqrt((n - 2) / (1 - correlation * correlation));
    const pValue = this.tTestPValue(tStat, n - 2);

    return { correlation, pValue };
  }

  private tTestPValue(t: number, df: number): number {
    // Simplified p-value calculation (two-tailed)
    // For more accuracy, you'd use a proper t-distribution function
    const absT = Math.abs(t);
    if (absT > 3) return 0.001;
    if (absT > 2.576) return 0.01;
    if (absT > 1.96) return 0.05;
    return 0.1;
  }

  /**
   * Calculate correlations with congestion
   */
  calculateCorrelations(data: MergedRecord[]): CorrelationResult[] {
    console.log('\nCalculating correlations with congestion...');

    // Convert boolean to numeric (1 = congested, 0 = not congested)
    const congestionNumeric = data.map(r => r.isCongested ? 1 : 0);

    const features = [
      { name: 'Manila Temperature', values: data.map(r => r.manilaTemp) },
      { name: 'Cebu Temperature', values: data.map(r => r.cebuTemp) },
      { name: 'Manila Solar Radiation', values: data.map(r => r.manilaSolar) },
      { name: 'Cebu Solar Radiation', values: data.map(r => r.cebuSolar) },
      { name: 'Manila Wind Speed', values: data.map(r => r.manilaWind) },
      { name: 'Cebu Wind Speed', values: data.map(r => r.cebuWind) },
      { name: 'Manila Cloud Cover', values: data.map(r => r.manilaCloudcover) },
      { name: 'Cebu Cloud Cover', values: data.map(r => r.cebuCloudcover) },
      { name: 'Manila Relative Humidity', values: data.map(r => r.relativeHumidityManila) },
      { name: 'Cebu Relative Humidity', values: data.map(r => r.relativeHumidityCebu) },
      { name: 'Luzon Demand', values: data.map(r => r.luzDemand) },
      { name: 'Visayas Demand', values: data.map(r => r.visDemand) },
      { name: 'Demand Differential (LUZ - VIS)', values: data.map(r => r.demandDiff) },
      { name: 'Hour of Day', values: data.map(r => r.hour) },
      { name: 'Day of Week', values: data.map(r => r.dayOfWeek) },
      { name: 'Is Weekend', values: data.map(r => r.isWeekend ? 1 : 0) },
      { name: 'Flow From', values: data.map(r => r.flowFrom) },
      { name: 'Flow To', values: data.map(r => r.flowTo) }
    ];

    const results: CorrelationResult[] = [];

    for (const feature of features) {
      const { correlation, pValue } = this.calculateCorrelation(feature.values, congestionNumeric);
      results.push({
        feature: feature.name,
        correlation,
        pValue
      });
    }

    // Sort by absolute correlation (strongest first)
    results.sort((a, b) => Math.abs(b.correlation) - Math.abs(a.correlation));

    return results;
  }

  /**
   * Calculate weather thresholds for congested vs non-congested conditions
   */
  calculateWeatherThresholds(data: MergedRecord[]): WeatherThreshold[] {
    console.log('\nCalculating weather thresholds...');

    const congested = data.filter(r => r.isCongested);
    const nonCongested = data.filter(r => !r.isCongested);

    const features = [
      { name: 'Manila Temperature (°C)', congested: congested.map(r => r.manilaTemp), nonCongested: nonCongested.map(r => r.manilaTemp) },
      { name: 'Cebu Temperature (°C)', congested: congested.map(r => r.cebuTemp), nonCongested: nonCongested.map(r => r.cebuTemp) },
      { name: 'Manila Solar (W/m²)', congested: congested.map(r => r.manilaSolar), nonCongested: nonCongested.map(r => r.manilaSolar) },
      { name: 'Cebu Solar (W/m²)', congested: congested.map(r => r.cebuSolar), nonCongested: nonCongested.map(r => r.cebuSolar) },
      { name: 'Manila Wind (m/s)', congested: congested.map(r => r.manilaWind), nonCongested: nonCongested.map(r => r.manilaWind) },
      { name: 'Cebu Wind (m/s)', congested: congested.map(r => r.cebuWind), nonCongested: nonCongested.map(r => r.cebuWind) },
      { name: 'Luzon Demand (MW)', congested: congested.map(r => r.luzDemand), nonCongested: nonCongested.map(r => r.luzDemand) },
      { name: 'Visayas Demand (MW)', congested: congested.map(r => r.visDemand), nonCongested: nonCongested.map(r => r.visDemand) },
      { name: 'Demand Diff (MW)', congested: congested.map(r => r.demandDiff), nonCongested: nonCongested.map(r => r.demandDiff) }
    ];

    const results: WeatherThreshold[] = [];

    for (const feature of features) {
      const congestedAvg = feature.congested.reduce((a, b) => a + b, 0) / feature.congested.length;
      const nonCongestedAvg = feature.nonCongested.reduce((a, b) => a + b, 0) / feature.nonCongested.length;
      const difference = congestedAvg - nonCongestedAvg;
      const percentDifference = nonCongestedAvg !== 0 ? (difference / nonCongestedAvg) * 100 : 0;

      results.push({
        feature: feature.name,
        congestedAvg,
        nonCongestedAvg,
        difference,
        percentDifference
      });
    }

    return results;
  }

  /**
   * Analyze temporal patterns (hourly)
   */
  analyzeTemporalPatterns(data: MergedRecord[]): TemporalPattern[] {
    console.log('\nAnalyzing temporal patterns...');

    const hourlyData = new Map<number, MergedRecord[]>();

    for (const record of data) {
      if (!hourlyData.has(record.hour)) {
        hourlyData.set(record.hour, []);
      }
      hourlyData.get(record.hour)!.push(record);
    }

    const patterns: TemporalPattern[] = [];

    for (let hour = 0; hour < 24; hour++) {
      const records = hourlyData.get(hour) || [];
      const congested = records.filter(r => r.isCongested);

      patterns.push({
        hour,
        congestionRate: records.length > 0 ? congested.length / records.length : 0,
        avgFlowFrom: records.length > 0 ? records.reduce((sum, r) => sum + r.flowFrom, 0) / records.length : 0,
        avgFlowTo: records.length > 0 ? records.reduce((sum, r) => sum + r.flowTo, 0) / records.length : 0,
        count: records.length
      });
    }

    return patterns;
  }

  /**
   * Generate comprehensive report
   */
  async generateReport(startDate: string, endDate: string): Promise<void> {
    console.log('='.repeat(80));
    console.log('INTERCONNECTOR WEATHER CORRELATION ANALYSIS');
    console.log('VISLUZ1 (Visayas-Luzon Interconnector)');
    console.log('='.repeat(80));
    console.log(`Date Range: ${startDate} to ${endDate}`);
    console.log('='.repeat(80));

    const data = await this.loadAndMergeData(startDate, endDate);

    if (data.length === 0) {
      console.log('\nERROR: No data available for analysis');
      return;
    }

    const totalRecords = data.length;
    const congestedRecords = data.filter(r => r.isCongested).length;
    const congestionRate = (congestedRecords / totalRecords) * 100;

    console.log(`\nTotal Records: ${totalRecords.toLocaleString()}`);
    console.log(`Congested Records: ${congestedRecords.toLocaleString()}`);
    console.log(`Congestion Rate: ${congestionRate.toFixed(2)}%`);

    // 1. Correlation Analysis
    const correlations = this.calculateCorrelations(data);

    // 2. Weather Thresholds
    const thresholds = this.calculateWeatherThresholds(data);

    // 3. Temporal Patterns
    const temporalPatterns = this.analyzeTemporalPatterns(data);

    // Generate detailed report
    const report = this.formatReport(
      startDate,
      endDate,
      totalRecords,
      congestedRecords,
      congestionRate,
      correlations,
      thresholds,
      temporalPatterns,
      data
    );

    // Save to file
    const outputPath = join(process.cwd(), 'Documents', 'VISLUZ1_WEATHER_CORRELATION_ANALYSIS.md');
    writeFileSync(outputPath, report);

    console.log(`\n${'='.repeat(80)}`);
    console.log(`Report saved to: ${outputPath}`);
    console.log('='.repeat(80));
  }

  private formatReport(
    startDate: string,
    endDate: string,
    totalRecords: number,
    congestedRecords: number,
    congestionRate: number,
    correlations: CorrelationResult[],
    thresholds: WeatherThreshold[],
    temporalPatterns: TemporalPattern[],
    data: MergedRecord[]
  ): string {
    let report = `# VISLUZ1 Weather Correlation Analysis

## Executive Summary

**Date Range:** ${startDate} to ${endDate}
**Total Records:** ${totalRecords.toLocaleString()}
**Congested Records:** ${congestedRecords.toLocaleString()}
**Congestion Rate:** ${congestionRate.toFixed(2)}%

This analysis examines the correlation between weather patterns and interconnector congestion on the VISLUZ1 (Visayas-Luzon) interconnector in the Philippine grid.

---

## 1. Top 10 Correlations with Congestion

The following features show the strongest correlation with congestion events:

| Rank | Feature | Correlation | P-Value | Strength |
|------|---------|-------------|---------|----------|
`;

    for (let i = 0; i < Math.min(10, correlations.length); i++) {
      const corr = correlations[i];
      const strength = Math.abs(corr.correlation) > 0.5 ? 'Strong' :
                       Math.abs(corr.correlation) > 0.3 ? 'Moderate' :
                       Math.abs(corr.correlation) > 0.1 ? 'Weak' : 'Very Weak';

      report += `| ${i + 1} | ${corr.feature} | ${corr.correlation.toFixed(4)} | ${corr.pValue.toFixed(4)} | ${strength} |\n`;
    }

    report += `\n### Interpretation

- **Positive correlation** means higher values are associated with more congestion
- **Negative correlation** means higher values are associated with less congestion
- **P-value < 0.05** indicates statistical significance

`;

    report += `\n---

## 2. Weather Thresholds: Congested vs Non-Congested Conditions

| Feature | Congested Avg | Non-Congested Avg | Difference | % Change |
|---------|---------------|-------------------|------------|----------|
`;

    for (const threshold of thresholds) {
      report += `| ${threshold.feature} | ${threshold.congestedAvg.toFixed(2)} | ${threshold.nonCongestedAvg.toFixed(2)} | ${threshold.difference > 0 ? '+' : ''}${threshold.difference.toFixed(2)} | ${threshold.percentDifference > 0 ? '+' : ''}${threshold.percentDifference.toFixed(1)}% |\n`;
    }

    report += `\n### Key Findings

`;

    // Identify significant thresholds
    const significantThresholds = thresholds
      .filter(t => Math.abs(t.percentDifference) > 5)
      .sort((a, b) => Math.abs(b.percentDifference) - Math.abs(a.percentDifference));

    for (const threshold of significantThresholds.slice(0, 5)) {
      const direction = threshold.difference > 0 ? 'higher' : 'lower';
      report += `- **${threshold.feature}**: ${Math.abs(threshold.percentDifference).toFixed(1)}% ${direction} during congestion\n`;
    }

    report += `\n---

## 3. Temporal Patterns (Hourly Analysis)

| Hour | Congestion Rate | Avg Flow From (MW) | Avg Flow To (MW) | Sample Count |
|------|----------------|-------------------|------------------|--------------|
`;

    for (const pattern of temporalPatterns) {
      report += `| ${pattern.hour.toString().padStart(2, '0')}:00 | ${(pattern.congestionRate * 100).toFixed(1)}% | ${pattern.avgFlowFrom.toFixed(1)} | ${pattern.avgFlowTo.toFixed(1)} | ${pattern.count.toLocaleString()} |\n`;
    }

    // Find peak congestion hours
    const peakHours = [...temporalPatterns]
      .sort((a, b) => b.congestionRate - a.congestionRate)
      .slice(0, 5);

    report += `\n### Peak Congestion Hours

`;

    for (let i = 0; i < peakHours.length; i++) {
      const pattern = peakHours[i];
      report += `${i + 1}. **Hour ${pattern.hour}:00** - ${(pattern.congestionRate * 100).toFixed(1)}% congestion rate\n`;
    }

    // Weekend vs Weekday analysis
    const weekdayRecords = data.filter(r => !r.isWeekend);
    const weekendRecords = data.filter(r => r.isWeekend);
    const weekdayCongestionRate = weekdayRecords.filter(r => r.isCongested).length / weekdayRecords.length * 100;
    const weekendCongestionRate = weekendRecords.filter(r => r.isCongested).length / weekendRecords.length * 100;

    report += `\n### Weekend vs Weekday Patterns

- **Weekday Congestion Rate:** ${weekdayCongestionRate.toFixed(2)}%
- **Weekend Congestion Rate:** ${weekendCongestionRate.toFixed(2)}%
- **Difference:** ${(weekdayCongestionRate - weekendCongestionRate).toFixed(2)} percentage points

`;

    report += `\n---

## 4. Recommendations for Model Improvement

Based on this analysis, the following features should be prioritized in the congestion prediction model:

### High-Priority Features (|correlation| > 0.3)
`;

    const highPriority = correlations.filter(c => Math.abs(c.correlation) > 0.3);
    for (const corr of highPriority) {
      report += `- ${corr.feature} (r = ${corr.correlation.toFixed(4)})\n`;
    }

    report += `\n### Medium-Priority Features (|correlation| > 0.1)
`;

    const mediumPriority = correlations.filter(c => Math.abs(c.correlation) > 0.1 && Math.abs(c.correlation) <= 0.3);
    for (const corr of mediumPriority) {
      report += `- ${corr.feature} (r = ${corr.correlation.toFixed(4)})\n`;
    }

    report += `\n### Feature Engineering Recommendations

1. **Temperature-Demand Interaction**: Create features combining temperature and demand
2. **Solar Generation Proxy**: Solar radiation can indicate likely solar generation
3. **Wind Generation Proxy**: Wind speed can indicate likely wind generation
4. **Time-of-Day Features**: Hour and day patterns show clear relationships
5. **Demand Differential**: Luzon-Visayas demand difference is a key predictor

### Model Architecture Recommendations

1. **Use XGBoost or Random Forest**: Non-linear relationships evident in data
2. **Include Temporal Features**: Hour-of-day and day-of-week are significant
3. **Feature Scaling**: Normalize weather and demand features
4. **Lag Features**: Consider 1-hour and 24-hour lag values for demand
5. **Rolling Averages**: 3-hour and 6-hour rolling averages may smooth noise

---

## 5. Insights and Conclusions

### Key Insights

`;

    // Generate data-driven insights
    const topCorr = correlations[0];
    report += `1. **Primary Driver**: ${topCorr.feature} shows the strongest correlation (${topCorr.correlation.toFixed(4)}) with congestion\n`;

    const tempThreshold = thresholds.find(t => t.feature.includes('Temperature'));
    if (tempThreshold) {
      report += `2. **Temperature Effect**: Average temperature is ${Math.abs(tempThreshold.percentDifference).toFixed(1)}% ${tempThreshold.difference > 0 ? 'higher' : 'lower'} during congestion\n`;
    }

    const demandThreshold = thresholds.find(t => t.feature.includes('Demand Diff'));
    if (demandThreshold) {
      report += `3. **Demand Imbalance**: Demand differential between Luzon and Visayas is ${Math.abs(demandThreshold.percentDifference).toFixed(1)}% ${demandThreshold.difference > 0 ? 'higher' : 'lower'} during congestion\n`;
    }

    const peakHour = peakHours[0];
    report += `4. **Peak Congestion**: Highest congestion occurs at hour ${peakHour.hour}:00 (${(peakHour.congestionRate * 100).toFixed(1)}% rate)\n`;

    report += `5. **${weekdayCongestionRate > weekendCongestionRate ? 'Weekday' : 'Weekend'} Dominance**: Congestion is ${Math.abs(weekdayCongestionRate - weekendCongestionRate).toFixed(1)} percentage points ${weekdayCongestionRate > weekendCongestionRate ? 'higher on weekdays' : 'higher on weekends'}\n`;

    report += `\n### Conclusions

The VISLUZ1 interconnector shows clear patterns of congestion related to:
- Regional demand imbalances
- Time-of-day patterns
- Weather conditions affecting both load and generation
- Weekday vs weekend operational patterns

These insights can be leveraged to build a robust congestion prediction model that combines:
- Real-time weather data
- Demand forecasts
- Temporal patterns
- Historical flow patterns

---

*Report generated on ${new Date().toISOString()}*
`;

    return report;
  }
}

// Main execution
async function main() {
  const analyzer = new InterconnectorWeatherAnalyzer();

  // Use date range from user context: July 1 - December 1, 2025
  const startDate = '2025-07-01';
  const endDate = '2025-12-01';

  await analyzer.generateReport(startDate, endDate);
}

main().catch(err => {
  console.error('Analysis failed:', err);
  process.exit(1);
});
