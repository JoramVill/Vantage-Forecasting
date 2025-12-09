/**
 * Shape Analysis: Compare forecast vs actual demand patterns
 * Analyzes amplitude, peak/trough timing, and daily swing
 */

import { readFileSync } from 'fs';
import { parse } from 'csv-parse/sync';

// Read forecast
const forecastData = readFileSync('./forecast_nov25_dec01_v2.csv', 'utf-8');
const forecast = parse(forecastData, { columns: true });

// Read actual
const actualData = readFileSync('C:\\Source_Codes\\iLoad_Forecasting_Utility\\Data Samples\\Demand\\DemandHr_H7D1125.csv', 'utf-8');
const actual = parse(actualData, { columns: true });

console.log('='.repeat(70));
console.log('         DEMAND SHAPE ANALYSIS: Forecast vs Actual');
console.log('='.repeat(70));
console.log('');

// Parse datetime like "11/25/2025 01:00"
function parseDateTime(dt) {
  const match = dt.match(/(\d+)\/(\d+)\/(\d+)\s+(\d+):(\d+)/);
  if (!match) return null;
  const [_, month, day, year, hour, min] = match;
  return {
    date: `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`,
    hour: parseInt(hour)
  };
}

// Group by date and region
const dailyData = {};

for (let i = 0; i < forecast.length; i++) {
  const fRow = forecast[i];
  const aRow = actual[i];

  if (!fRow || !aRow) continue;

  const parsed = parseDateTime(fRow.DateTimeEnding);
  if (!parsed) continue;

  const { date, hour } = parsed;

  for (const region of ['CLUZ', 'CVIS', 'CMIN']) {
    const key = `${date}_${region}`;
    if (!dailyData[key]) {
      dailyData[key] = {
        date,
        region,
        forecastValues: [],
        actualValues: [],
        hours: []
      };
    }

    dailyData[key].forecastValues.push(parseFloat(fRow[region]));
    dailyData[key].actualValues.push(parseFloat(aRow[region]));
    dailyData[key].hours.push(hour);
  }
}

// Calculate daily metrics
const regionMetrics = { CLUZ: [], CVIS: [], CMIN: [] };

for (const [key, stats] of Object.entries(dailyData)) {
  if (stats.forecastValues.length < 20) continue; // Skip incomplete days

  const fMax = Math.max(...stats.forecastValues);
  const fMin = Math.min(...stats.forecastValues);
  const fSwing = fMax - fMin;
  const fPeakHour = stats.hours[stats.forecastValues.indexOf(fMax)];
  const fTroughHour = stats.hours[stats.forecastValues.indexOf(fMin)];

  const aMax = Math.max(...stats.actualValues);
  const aMin = Math.min(...stats.actualValues);
  const aSwing = aMax - aMin;
  const aPeakHour = stats.hours[stats.actualValues.indexOf(aMax)];
  const aTroughHour = stats.hours[stats.actualValues.indexOf(aMin)];

  regionMetrics[stats.region].push({
    date: stats.date,
    forecastPeak: fMax,
    forecastTrough: fMin,
    forecastSwing: fSwing,
    forecastPeakHour: fPeakHour,
    forecastTroughHour: fTroughHour,
    actualPeak: aMax,
    actualTrough: aMin,
    actualSwing: aSwing,
    actualPeakHour: aPeakHour,
    actualTroughHour: aTroughHour,
    peakError: fMax - aMax,
    troughError: fMin - aMin,
    swingError: fSwing - aSwing,
    swingRatio: fSwing / aSwing
  });
}

// Print analysis by region
for (const region of ['CLUZ', 'CVIS', 'CMIN']) {
  const metrics = regionMetrics[region];
  if (metrics.length === 0) continue;

  console.log('-'.repeat(70));
  console.log(`${region} - Daily Shape Analysis`);
  console.log('-'.repeat(70));
  console.log('');
  console.log('Date       | Peak Err | Trough Err | Swing Err | Swing Ratio | Shape Issue');
  console.log('-'.repeat(70));

  let totalPeakErr = 0, totalTroughErr = 0, totalSwingErr = 0, totalSwingRatio = 0;

  for (const m of metrics) {
    const peakErrStr = (m.peakError >= 0 ? '+' : '') + m.peakError.toFixed(0);
    const troughErrStr = (m.troughError >= 0 ? '+' : '') + m.troughError.toFixed(0);
    const swingErrStr = (m.swingError >= 0 ? '+' : '') + m.swingError.toFixed(0);
    const swingRatioStr = m.swingRatio.toFixed(2) + 'x';

    let shapeIssue = '';
    if (m.swingRatio < 0.9) shapeIssue = 'TOO FLAT';
    else if (m.swingRatio > 1.1) shapeIssue = 'TOO EXTREME';
    else shapeIssue = 'OK';

    if (m.peakError > 200) shapeIssue += ', Peak HIGH';
    if (m.peakError < -200) shapeIssue += ', Peak LOW';
    if (m.troughError > 200) shapeIssue += ', Trough HIGH';
    if (m.troughError < -200) shapeIssue += ', Trough LOW';

    console.log(`${m.date} | ${peakErrStr.padStart(8)} | ${troughErrStr.padStart(10)} | ${swingErrStr.padStart(9)} | ${swingRatioStr.padStart(11)} | ${shapeIssue}`);

    totalPeakErr += m.peakError;
    totalTroughErr += m.troughError;
    totalSwingErr += m.swingError;
    totalSwingRatio += m.swingRatio;
  }

  const n = metrics.length;
  console.log('-'.repeat(70));
  console.log(`AVERAGE    | ${(totalPeakErr/n >= 0 ? '+' : '') + (totalPeakErr/n).toFixed(0).padStart(7)} | ${(totalTroughErr/n >= 0 ? '+' : '') + (totalTroughErr/n).toFixed(0).padStart(9)} | ${(totalSwingErr/n >= 0 ? '+' : '') + (totalSwingErr/n).toFixed(0).padStart(8)} | ${(totalSwingRatio/n).toFixed(2).padStart(10)}x |`);
  console.log('');

  // Summary interpretation
  const avgSwingRatio = totalSwingRatio / n;
  const avgPeakErr = totalPeakErr / n;
  const avgTroughErr = totalTroughErr / n;

  console.log('INTERPRETATION:');
  if (avgSwingRatio < 0.95) {
    console.log(`  - Forecast is ${((1 - avgSwingRatio) * 100).toFixed(0)}% FLATTER than actual (not enough daily variation)`);
  } else if (avgSwingRatio > 1.05) {
    console.log(`  - Forecast is ${((avgSwingRatio - 1) * 100).toFixed(0)}% MORE EXTREME than actual (too much daily variation)`);
  } else {
    console.log('  - Daily swing amplitude is WELL CALIBRATED');
  }

  if (avgPeakErr > 100) {
    console.log(`  - Peaks are over-forecast by ${avgPeakErr.toFixed(0)} MW on average`);
  } else if (avgPeakErr < -100) {
    console.log(`  - Peaks are under-forecast by ${Math.abs(avgPeakErr).toFixed(0)} MW on average`);
  }

  if (avgTroughErr > 100) {
    console.log(`  - Troughs are over-forecast by ${avgTroughErr.toFixed(0)} MW on average (not going low enough)`);
  } else if (avgTroughErr < -100) {
    console.log(`  - Troughs are under-forecast by ${Math.abs(avgTroughErr).toFixed(0)} MW on average`);
  }

  console.log('');
}

// Overall summary
console.log('='.repeat(70));
console.log('OVERALL SHAPE ISSUES SUMMARY');
console.log('='.repeat(70));
console.log('');

const cluzAvgSwing = regionMetrics.CLUZ.reduce((s, m) => s + m.swingRatio, 0) / regionMetrics.CLUZ.length;
const cvisAvgSwing = regionMetrics.CVIS.reduce((s, m) => s + m.swingRatio, 0) / regionMetrics.CVIS.length;
const cminAvgSwing = regionMetrics.CMIN.reduce((s, m) => s + m.swingRatio, 0) / regionMetrics.CMIN.length;

const cluzAvgPeak = regionMetrics.CLUZ.reduce((s, m) => s + m.peakError, 0) / regionMetrics.CLUZ.length;
const cvisAvgPeak = regionMetrics.CVIS.reduce((s, m) => s + m.peakError, 0) / regionMetrics.CVIS.length;
const cminAvgPeak = regionMetrics.CMIN.reduce((s, m) => s + m.peakError, 0) / regionMetrics.CMIN.length;

const cluzAvgTrough = regionMetrics.CLUZ.reduce((s, m) => s + m.troughError, 0) / regionMetrics.CLUZ.length;
const cvisAvgTrough = regionMetrics.CVIS.reduce((s, m) => s + m.troughError, 0) / regionMetrics.CVIS.length;
const cminAvgTrough = regionMetrics.CMIN.reduce((s, m) => s + m.troughError, 0) / regionMetrics.CMIN.length;

console.log('Region | Swing Ratio | Peak Error | Trough Error | Diagnosis');
console.log('-'.repeat(70));
console.log(`CLUZ   | ${cluzAvgSwing.toFixed(2)}x        | ${(cluzAvgPeak >= 0 ? '+' : '') + cluzAvgPeak.toFixed(0).padStart(6)} MW | ${(cluzAvgTrough >= 0 ? '+' : '') + cluzAvgTrough.toFixed(0).padStart(8)} MW | ${cluzAvgSwing < 0.95 ? 'TOO FLAT' : cluzAvgSwing > 1.05 ? 'TOO EXTREME' : 'OK'}`);
console.log(`CVIS   | ${cvisAvgSwing.toFixed(2)}x        | ${(cvisAvgPeak >= 0 ? '+' : '') + cvisAvgPeak.toFixed(0).padStart(6)} MW | ${(cvisAvgTrough >= 0 ? '+' : '') + cvisAvgTrough.toFixed(0).padStart(8)} MW | ${cvisAvgSwing < 0.95 ? 'TOO FLAT' : cvisAvgSwing > 1.05 ? 'TOO EXTREME' : 'OK'}`);
console.log(`CMIN   | ${cminAvgSwing.toFixed(2)}x        | ${(cminAvgPeak >= 0 ? '+' : '') + cminAvgPeak.toFixed(0).padStart(6)} MW | ${(cminAvgTrough >= 0 ? '+' : '') + cminAvgTrough.toFixed(0).padStart(8)} MW | ${cminAvgSwing < 0.95 ? 'TOO FLAT' : cminAvgSwing > 1.05 ? 'TOO EXTREME' : 'OK'}`);
console.log('');
console.log('User Observation: "Flatter in LUZ, higher peaks in CMIN, lower troughs in CVIS"');
console.log('');

// Recommendations
console.log('='.repeat(70));
console.log('RECOMMENDATIONS');
console.log('='.repeat(70));
console.log('');
if (cluzAvgSwing < 0.95) {
  console.log('CLUZ: Model needs more sensitivity to temperature/time-of-day features');
  console.log('      Consider increasing weight of hourly pattern coefficients');
}
if (cvisAvgTrough > 50) {
  console.log('CVIS: Troughs are too high - model not capturing overnight demand drop');
  console.log('      Consider adding minimum demand constraints or night-time adjustment');
}
if (cminAvgPeak > 200) {
  console.log('CMIN: Peaks are over-forecast - model may be over-reacting to temperature');
  console.log('      Consider capping temperature sensitivity or adding peak damping');
}
console.log('');
