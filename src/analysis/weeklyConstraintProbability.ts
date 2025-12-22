/**
 * Weekly Constraint Probability Analysis
 *
 * Analyzes constraint probability on a per-week, per-day, per-hour basis
 * Uses historical data to determine statistical likelihood of constraints
 */

import { getDatabase, DatabaseService } from '../database/database.js';
import { detectConstraintPeriods } from './detectConstraints.js';
import * as fs from 'fs';
import * as path from 'path';

interface HourlyProbability {
  datetime: string;
  dayOfWeek: string;
  hour: number;
  temp: number;
  solar: number;
  wind: number;
  humidity: number;
  cloudcover: number;
  actuallyConstrained: boolean;
  constraintLevel?: number;
  constraintProbability: number;
  riskLevel: 'LOW' | 'MODERATE' | 'HIGH' | 'VERY HIGH';
}

interface DailyStats {
  date: string;
  dayOfWeek: string;
  totalHours: number;
  constrainedHours: number;
  constraintProbability: number;
  avgTemp: number;
  avgSolar: number;
  avgWind: number;
  peakConstraintHours: number[];
  riskLevel: 'LOW' | 'MODERATE' | 'HIGH' | 'VERY HIGH';
}

interface WeeklySummary {
  weekStart: string;
  weekEnd: string;
  totalHours: number;
  constrainedHours: number;
  constraintProbability: number;
  totalConstraintEvents: number;
  avgConstraintDuration: number;
  mostCommonConstraintLevel: number;
  highRiskHours: HourlyProbability[];
  dailyStats: DailyStats[];
}

export class WeeklyConstraintProbabilityAnalyzer {
  private db: DatabaseService;

  constructor() {
    this.db = getDatabase();
  }

  /**
   * Analyze a specific week
   */
  public async analyzeWeek(
    weekStartDate: Date,
    interconnectorName: string = 'VISLUZ1'
  ): Promise<WeeklySummary> {
    const weekEndDate = new Date(weekStartDate.getTime() + 7 * 24 * 60 * 60 * 1000);

    console.log(`\n=== Analyzing Week: ${weekStartDate.toISOString().slice(0, 10)} to ${weekEndDate.toISOString().slice(0, 10)} ===\n`);

    // Get interconnector records for the week
    const records = this.db.getInterconnectorRecords(
      weekStartDate.toISOString(),
      weekEndDate.toISOString(),
      interconnectorName
    );

    console.log(`Found ${records.length} interconnector records`);

    // Detect constraints
    const constraints = detectConstraintPeriods(records);
    console.log(`Detected ${constraints.length} constraint periods`);

    // Get weather data for the week
    const weatherData = this.getWeatherData(weekStartDate, weekEndDate);
    console.log(`Found ${weatherData.length} weather records`);

    // Calculate hourly probabilities
    const hourlyProbabilities = this.calculateHourlyProbabilities(
      weekStartDate,
      weekEndDate,
      records,
      constraints,
      weatherData
    );

    // Calculate daily statistics
    const dailyStats = this.calculateDailyStats(hourlyProbabilities);

    // Calculate weekly summary
    const totalConstrainedHours = constraints.reduce((sum, c) => sum + c.durationHours, 0);
    const totalHours = 168; // 7 days * 24 hours
    const weeklyProbability = totalConstrainedHours / totalHours;

    const avgConstraintDuration = constraints.length > 0
      ? totalConstrainedHours / constraints.length
      : 0;

    const constraintLevels = constraints.map(c => c.constraintLevel);
    const mostCommonLevel = this.getMostCommonValue(constraintLevels);

    const highRiskHours = hourlyProbabilities.filter(h => h.riskLevel === 'HIGH' || h.riskLevel === 'VERY HIGH');

    return {
      weekStart: weekStartDate.toISOString().slice(0, 10),
      weekEnd: weekEndDate.toISOString().slice(0, 10),
      totalHours,
      constrainedHours: totalConstrainedHours,
      constraintProbability: weeklyProbability,
      totalConstraintEvents: constraints.length,
      avgConstraintDuration,
      mostCommonConstraintLevel: mostCommonLevel,
      highRiskHours,
      dailyStats
    };
  }

  /**
   * Get weather data for a period
   */
  private getWeatherData(startDate: Date, endDate: Date): any[] {
    const sql = `
      SELECT
        datetime,
        temp,
        dew,
        precip,
        windspeed,
        windgust,
        cloudcover,
        solarradiation,
        uvindex
      FROM weather_records
      WHERE region = 'CVIS'
        AND datetime >= ?
        AND datetime <= ?
      ORDER BY datetime
    `;

    const startStr = startDate.toISOString().slice(0, 19);
    const endStr = endDate.toISOString().slice(0, 19);

    const rows = (this.db as any).db.prepare(sql).all(startStr, endStr) as any[];

    // Calculate humidity
    return rows.map(row => ({
      ...row,
      humidity: this.calculateRelativeHumidity(row.temp, row.dew)
    }));
  }

  private calculateRelativeHumidity(temp: number, dew: number): number {
    if (!temp || !dew) return 0;
    const a = 17.27;
    const b = 237.7;
    const alphaTDew = (a * dew) / (b + dew);
    const alphaT = (a * temp) / (b + temp);
    return 100 * (Math.exp(alphaTDew) / Math.exp(alphaT));
  }

  /**
   * Calculate hourly constraint probabilities
   */
  private calculateHourlyProbabilities(
    weekStart: Date,
    weekEnd: Date,
    records: any[],
    constraints: any[],
    weatherData: any[]
  ): HourlyProbability[] {
    const hourlyProbs: HourlyProbability[] = [];

    // Create a map of constrained hours
    const constraintMap = new Map<string, { level: number }>();
    for (const c of constraints) {
      let current = new Date(c.startTime);
      while (current <= c.endTime) {
        const hourKey = current.toISOString().slice(0, 13); // YYYY-MM-DDTHH
        constraintMap.set(hourKey, { level: c.constraintLevel });
        current = new Date(current.getTime() + 60 * 60 * 1000);
      }
    }

    // Create weather map
    const weatherMap = new Map<string, any>();
    for (const w of weatherData) {
      const hourKey = w.datetime.slice(0, 13);
      weatherMap.set(hourKey, w);
    }

    // Iterate through each hour of the week
    let current = new Date(weekStart);
    while (current < weekEnd) {
      const hourKey = current.toISOString().slice(0, 13);
      const weather = weatherMap.get(hourKey);

      if (weather) {
        const isConstrained = constraintMap.has(hourKey);
        const constraint = constraintMap.get(hourKey);

        // Calculate probability based on historical patterns
        const probability = this.calculateProbabilityForConditions(
          current.getHours(),
          current.getDay(),
          weather.temp,
          weather.solarradiation,
          weather.windspeed,
          weather.humidity
        );

        const riskLevel = this.getRiskLevel(probability, weather.solarradiation, weather.temp);

        hourlyProbs.push({
          datetime: current.toISOString(),
          dayOfWeek: this.getDayName(current.getDay()),
          hour: current.getHours(),
          temp: weather.temp,
          solar: weather.solarradiation,
          wind: weather.windspeed,
          humidity: weather.humidity,
          cloudcover: weather.cloudcover,
          actuallyConstrained: isConstrained,
          constraintLevel: constraint?.level,
          constraintProbability: probability,
          riskLevel
        });
      }

      current = new Date(current.getTime() + 60 * 60 * 1000);
    }

    return hourlyProbs;
  }

  /**
   * Calculate probability based on historical patterns from November 2025 data
   */
  private calculateProbabilityForConditions(
    hour: number,
    dayOfWeek: number,
    temp: number,
    solar: number,
    wind: number,
    humidity: number
  ): number {
    let probability = 0.0;

    // Base probability from November 2025: 30.8% of time was constrained
    const baseProbability = 0.308;

    // Hour-based adjustment (from hourly distribution)
    // Peak hours: 09:00 (6 events), 12:00 (5 events), 00:00 (4 events)
    const hourMultipliers: { [key: number]: number } = {
      0: 1.3,  // midnight - 4 events
      7: 1.3,  // 7am - 4 events
      8: 1.3,  // 8am - 4 events
      9: 2.0,  // 9am - 6 events (peak)
      12: 1.7, // noon - 5 events
      13: 1.3  // 1pm - 4 events
    };

    const hourMult = hourMultipliers[hour] || 0.5;

    // Wind-based adjustment (higher wind = higher probability, +29.2% during constraints)
    const windMult = wind > 12.8 ? 1.5 : wind > 10 ? 1.2 : 0.8;

    // Temperature-based adjustment (lower temp during constraints, -2.2%)
    const tempMult = temp < 28 ? 1.2 : temp < 29 ? 1.0 : 0.8;

    // Solar-based adjustment (lower solar during constraints, -10.4%)
    // This is counterintuitive but reflects November storm patterns
    const solarMult = solar < 166 ? 1.3 : solar < 200 ? 1.0 : 0.7;

    probability = baseProbability * hourMult * windMult * tempMult * solarMult;

    return Math.min(probability, 1.0);
  }

  /**
   * Get risk level based on probability and conditions
   */
  private getRiskLevel(
    probability: number,
    solar: number,
    temp: number
  ): 'LOW' | 'MODERATE' | 'HIGH' | 'VERY HIGH' {
    if (probability > 0.6 || (probability > 0.4 && solar < 150)) return 'VERY HIGH';
    if (probability > 0.4 || (probability > 0.3 && solar < 200)) return 'HIGH';
    if (probability > 0.2) return 'MODERATE';
    return 'LOW';
  }

  /**
   * Calculate daily statistics
   */
  private calculateDailyStats(hourlyProbs: HourlyProbability[]): DailyStats[] {
    const dailyMap = new Map<string, HourlyProbability[]>();

    for (const hour of hourlyProbs) {
      const date = hour.datetime.slice(0, 10);
      if (!dailyMap.has(date)) {
        dailyMap.set(date, []);
      }
      dailyMap.get(date)!.push(hour);
    }

    const dailyStats: DailyStats[] = [];

    for (const [date, hours] of dailyMap.entries()) {
      const constrainedHours = hours.filter(h => h.actuallyConstrained).length;
      const totalHours = hours.length;
      const probability = constrainedHours / totalHours;

      const avgTemp = hours.reduce((sum, h) => sum + h.temp, 0) / hours.length;
      const avgSolar = hours.reduce((sum, h) => sum + h.solar, 0) / hours.length;
      const avgWind = hours.reduce((sum, h) => sum + h.wind, 0) / hours.length;

      const peakConstraintHours = hours
        .filter(h => h.actuallyConstrained)
        .map(h => h.hour)
        .filter((hour, idx, arr) => arr.indexOf(hour) === idx)
        .sort((a, b) => a - b);

      const riskLevel = probability > 0.5 ? 'VERY HIGH' : probability > 0.3 ? 'HIGH' : probability > 0.15 ? 'MODERATE' : 'LOW';

      dailyStats.push({
        date,
        dayOfWeek: hours[0].dayOfWeek,
        totalHours,
        constrainedHours,
        constraintProbability: probability,
        avgTemp,
        avgSolar,
        avgWind,
        peakConstraintHours,
        riskLevel
      });
    }

    return dailyStats;
  }

  /**
   * Generate a detailed report
   */
  public generateReport(
    summary: WeeklySummary,
    outputPath: string
  ): void {
    const report = this.createMarkdownReport(summary);
    fs.writeFileSync(outputPath, report, 'utf-8');
    console.log(`\n✓ Report saved to: ${outputPath}`);

    // Also export CSV
    const csvPath = outputPath.replace('.md', '_hourly.csv');
    this.exportHourlyCSV(summary.highRiskHours, csvPath);
    console.log(`✓ Hourly data exported to: ${csvPath}`);
  }

  /**
   * Create markdown report
   */
  private createMarkdownReport(summary: WeeklySummary): string {
    const report = `# Weekly Constraint Probability Analysis - VISLUZ1
**Week:** ${summary.weekStart} to ${summary.weekEnd}
**Generated:** ${new Date().toISOString().slice(0, 10)}

---

## Executive Summary

### Weekly Statistics

- **Total Hours in Week:** ${summary.totalHours}
- **Constrained Hours:** ${summary.constrainedHours.toFixed(2)} hours
- **Weekly Constraint Probability:** ${(summary.constraintProbability * 100).toFixed(1)}%
- **Number of Constraint Events:** ${summary.totalConstraintEvents}
- **Average Event Duration:** ${summary.avgConstraintDuration.toFixed(2)} hours
- **Most Common Constraint Level:** ${summary.mostCommonConstraintLevel} MW

**Interpretation:** On average during this week, the interconnector was constrained for **${(summary.constraintProbability * 100).toFixed(1)}%** of the time.

---

## Daily Breakdown

${summary.dailyStats.map((day, idx) => `
### ${idx + 1}. ${day.date} (${day.dayOfWeek})

| Metric | Value |
|--------|-------|
| **Constraint Probability** | **${(day.constraintProbability * 100).toFixed(1)}%** |
| **Risk Level** | **${day.riskLevel}** |
| **Constrained Hours** | ${day.constrainedHours} / ${day.totalHours} hours |
| **Peak Constraint Hours** | ${day.peakConstraintHours.length > 0 ? day.peakConstraintHours.map(h => `${h.toString().padStart(2, '0')}:00`).join(', ') : 'None'} |
| **Avg Temperature** | ${day.avgTemp.toFixed(1)}°C |
| **Avg Solar Radiation** | ${day.avgSolar.toFixed(0)} W/m² |
| **Avg Wind Speed** | ${day.avgWind.toFixed(1)} km/h |

`).join('\n')}

---

## High-Risk Hours (${summary.highRiskHours.length} hours)

Hours with HIGH or VERY HIGH constraint risk:

${summary.highRiskHours.slice(0, 20).map((h, idx) => `
### ${idx + 1}. ${h.datetime.slice(0, 16).replace('T', ' ')} (${h.dayOfWeek})

| Metric | Value |
|--------|-------|
| **Risk Level** | **${h.riskLevel}** ${h.actuallyConstrained ? '✓ ACTUAL CONSTRAINT' : ''} |
| **Probability** | ${(h.constraintProbability * 100).toFixed(1)}% |
${h.actuallyConstrained ? `| **Constraint Level** | ${h.constraintLevel} MW |` : ''}
| **Temperature** | ${h.temp.toFixed(1)}°C |
| **Solar Radiation** | ${h.solar.toFixed(0)} W/m² |
| **Wind Speed** | ${h.wind.toFixed(1)} km/h |
| **Humidity** | ${h.humidity.toFixed(0)}% |
| **Cloud Cover** | ${h.cloudcover}% |

`).join('\n')}

${summary.highRiskHours.length > 20 ? `\n_...and ${summary.highRiskHours.length - 20} more high-risk hours (see CSV export)_\n` : ''}

---

## Statistical Likelihood Patterns

Based on November 2025 historical data:

### Most Likely Constraint Times

1. **09:00** - Highest probability (peak hour with 6 events in November)
2. **12:00** - Second highest (5 events)
3. **00:00** - Third highest (4 events)
4. **07:00-08:00, 13:00** - Elevated probability (4 events each)

### Conditions Most Likely to Cause Constraints

1. **High Wind Speed** (>12.8 km/h) - Storm/typhoon conditions
   - 29.2% higher wind during constraints
   - Strong correlation with weather disturbances

2. **Lower Solar Radiation** (<166 W/m²) - Cloudy/overcast
   - Constraints occurred during storms, not sunny periods
   - Atypical pattern for November 2025

3. **Cooler Temperatures** (<28°C)
   - 2.2% lower temperature during constraints
   - Associated with storm fronts

### Risk Assessment Formula

**Constraint Probability** = Base (30.8%) × Hour Multiplier × Wind Factor × Temp Factor × Solar Factor

Where:
- **Hour Multiplier:** 2.0 at 09:00, 1.7 at 12:00, 1.3 at 00:00/07:00/08:00/13:00, 0.5 otherwise
- **Wind Factor:** 1.5 if wind >12.8 km/h, 1.2 if >10 km/h, 0.8 otherwise
- **Temp Factor:** 1.2 if temp <28°C, 1.0 if <29°C, 0.8 otherwise
- **Solar Factor:** 1.3 if solar <166 W/m², 1.0 if <200 W/m², 0.7 otherwise

---

## Recommendations for Week of ${summary.weekStart}

### For Grid Operators

1. **Monitor closely during high-risk hours** identified above
2. **Pay special attention to:**
   - Morning hours (07:00-09:00)
   - Midday (12:00-13:00)
   - Midnight period (00:00-01:00)
3. **Weather indicators to watch:**
   - Increasing wind speeds (>12 km/h indicates higher risk)
   - Storm systems approaching Visayas
   - Cloud cover increasing (lower solar radiation)

### For Load Forecasters

1. **Apply elevated risk factors** for identified high-probability hours
2. **Consider weather-driven scenarios:**
   - Storm conditions: 50%+ constraint probability
   - Normal conditions: 10-20% constraint probability
3. **Plan for potential ${summary.mostCommonConstraintLevel} MW constraint level** as most common

---

**Analysis Method:** Statistical analysis of November 2025 RTDHS data with weather correlation
**Constraint Detection:** Flat-line flow detection (±2 MW tolerance, 1+ hour duration)
**Data Source:** VISLUZ1 interconnector records + Cebu City weather (CVIS region)

`;

    return report;
  }

  /**
   * Export hourly data to CSV
   */
  private exportHourlyCSV(hours: HourlyProbability[], filePath: string): void {
    const headers = [
      'Datetime',
      'Day of Week',
      'Hour',
      'Temp (°C)',
      'Solar (W/m²)',
      'Wind (km/h)',
      'Humidity (%)',
      'Cloud Cover (%)',
      'Actually Constrained',
      'Constraint Level (MW)',
      'Probability (%)',
      'Risk Level'
    ];

    const rows = hours.map(h => [
      h.datetime,
      h.dayOfWeek,
      h.hour.toString(),
      h.temp.toFixed(1),
      h.solar.toFixed(0),
      h.wind.toFixed(1),
      h.humidity.toFixed(0),
      h.cloudcover.toString(),
      h.actuallyConstrained ? 'YES' : 'NO',
      h.constraintLevel?.toString() || '',
      (h.constraintProbability * 100).toFixed(1),
      h.riskLevel
    ]);

    const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    fs.writeFileSync(filePath, csv, 'utf-8');
  }

  // Helper methods

  private getDayName(dayOfWeek: number): string {
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    return days[dayOfWeek];
  }

  private getMostCommonValue(values: number[]): number {
    if (values.length === 0) return 0;
    const counts: { [key: number]: number } = {};
    for (const val of values) {
      counts[val] = (counts[val] || 0) + 1;
    }
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    return parseInt(sorted[0][0]);
  }
}

// CLI execution
if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`) {
  const analyzer = new WeeklyConstraintProbabilityAnalyzer();

  // Week starting November 25, 2025
  const weekStart = new Date('2025-11-25T00:00:00');

  analyzer.analyzeWeek(weekStart, 'VISLUZ1')
    .then(summary => {
      const outputPath = './Documents/interconnector_analysis/WEEK_2025_11_25_PROBABILITY_ANALYSIS.md';
      analyzer.generateReport(summary, outputPath);
      console.log('\n✓ Analysis complete!');
      process.exit(0);
    })
    .catch(err => {
      console.error('Error:', err);
      process.exit(1);
    });
}
