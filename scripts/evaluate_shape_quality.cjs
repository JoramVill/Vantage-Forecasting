/**
 * Shape Quality Evaluation Script
 *
 * Evaluates forecast quality beyond MAPE:
 * - Correlation coefficient (how well forecast follows actual patterns)
 * - Direction accuracy (% of hours where forecast direction matches actual)
 * - Peak capture (how well peaks are captured in timing and magnitude)
 * - Variability ratio (forecast variability vs actual variability)
 */

const fs = require('fs');
const path = require('path');

// Configuration
const FORECAST_FILE = 'output/FC_CFAC_Hybrid_Jan1-14.csv';
const ACTUALS_FILE = 'Data Samples/Capacity Factor/MRHCFac_1-month Historical_JAN.csv';
const STATIONS_TO_ANALYZE = [
  // Wind stations (all 6)
  '01BURGOS', '01LAOAG', '01PAGUDPUD', '02DOLORES', '08BVISTA', '08NABAS_W',
  // Solar stations (12 representative)
  '01CURIMAO', '01PASUQUIN', '01CLARK', '01SBMA', '03CALAMBA', '03CALACA',
  '06CADIZ_S', '06HELIOS', '11KIBAW', '13DAVAO', '14GENSA_S', '01BOTOLAN'
];
const DATE_RANGE = { start: '2026-01-01', end: '2026-01-14' };

// Parse date from various formats
function parseDate(dateStr) {
  // Handle M/D/YYYY HH:MM format (e.g., "1/1/2026 01:00")
  const match = dateStr.match(/^(\d+)\/(\d+)\/(\d+)\s+(\d+):(\d+)/);
  if (match) {
    const [, month, day, year, hour, minute] = match.map(Number);
    return new Date(year, month - 1, day, hour, minute);
  }
  // Handle ISO format
  return new Date(dateStr);
}

// Read CSV file
function readCSV(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.trim().split('\n');
  const header = lines[0].split(',').map(h => h.trim());

  const data = [];
  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(',');
    const row = {};
    for (let j = 0; j < header.length; j++) {
      row[header[j]] = values[j]?.trim() || '';
    }
    data.push(row);
  }
  return { header, data };
}

// Extract station data for a specific station and date range
function extractStationData(csvData, stationCode, startDate, endDate) {
  const start = new Date(startDate);
  start.setHours(0, 0, 0, 0);
  const end = new Date(endDate);
  end.setHours(23, 59, 59, 999);

  // Determine date column and value column format
  const header = csvData.header;
  const dateCol = header[0]; // First column is always DateTimeEnding

  // Wide format: datetime in first column, stations as columns
  const stationIdx = header.indexOf(stationCode);
  if (stationIdx === -1) {
    console.log(`  Station ${stationCode} not found in headers`);
    return [];
  }

  const results = [];
  for (const row of csvData.data) {
    const dateStr = row[dateCol];
    if (!dateStr) continue;

    const dt = parseDate(dateStr);
    if (isNaN(dt.getTime())) continue;
    if (dt < start || dt > end) continue;

    const valueStr = row[stationCode];
    const value = parseFloat(valueStr);
    if (!isNaN(value)) {
      results.push({ datetime: dt, value });
    }
  }

  return results.sort((a, b) => a.datetime - b.datetime);
}

// Calculate Pearson correlation coefficient
function correlation(x, y) {
  const n = x.length;
  if (n === 0) return NaN;

  const sumX = x.reduce((a, b) => a + b, 0);
  const sumY = y.reduce((a, b) => a + b, 0);
  const sumXY = x.reduce((sum, xi, i) => sum + xi * y[i], 0);
  const sumX2 = x.reduce((sum, xi) => sum + xi * xi, 0);
  const sumY2 = y.reduce((sum, yi) => sum + yi * yi, 0);

  const numerator = n * sumXY - sumX * sumY;
  const denominator = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));

  return denominator === 0 ? 0 : numerator / denominator;
}

// Calculate direction accuracy (% of hours where direction matches)
function directionAccuracy(forecast, actual) {
  if (forecast.length < 2) return NaN;

  let matches = 0;
  let total = 0;

  for (let i = 1; i < forecast.length; i++) {
    const fDir = Math.sign(forecast[i] - forecast[i-1]);
    const aDir = Math.sign(actual[i] - actual[i-1]);

    // Ignore flat periods in actual
    if (aDir !== 0) {
      total++;
      if (fDir === aDir) matches++;
    }
  }

  return total > 0 ? (matches / total) * 100 : NaN;
}

// Calculate MAPE
function mape(forecast, actual) {
  let sum = 0;
  let count = 0;

  for (let i = 0; i < forecast.length; i++) {
    if (actual[i] > 0.01) { // Avoid division by near-zero
      sum += Math.abs(forecast[i] - actual[i]) / actual[i];
      count++;
    }
  }

  return count > 0 ? (sum / count) * 100 : NaN;
}

// Calculate MAE
function mae(forecast, actual) {
  const n = forecast.length;
  if (n === 0) return NaN;

  const sum = forecast.reduce((s, f, i) => s + Math.abs(f - actual[i]), 0);
  return sum / n;
}

// Calculate variability ratio (forecast std / actual std)
function variabilityRatio(forecast, actual) {
  const stdF = standardDeviation(forecast);
  const stdA = standardDeviation(actual);
  return stdA > 0 ? stdF / stdA : NaN;
}

function standardDeviation(arr) {
  const n = arr.length;
  if (n === 0) return 0;
  const mean = arr.reduce((a, b) => a + b, 0) / n;
  const variance = arr.reduce((s, x) => s + (x - mean) ** 2, 0) / n;
  return Math.sqrt(variance);
}

// Peak analysis
function analyzePeaks(forecast, actual, datetimes) {
  // Find daily peaks in actual data
  const dailyPeaks = {};

  datetimes.forEach((dt, i) => {
    const dateKey = dt.toISOString().split('T')[0];
    if (!dailyPeaks[dateKey] || actual[i] > dailyPeaks[dateKey].actualValue) {
      dailyPeaks[dateKey] = {
        actualValue: actual[i],
        actualHour: dt.getHours(),
        forecastAtPeak: forecast[i],
        forecastValue: forecast[i]
      };
    }
  });

  // Update forecast values at actual peak hours
  datetimes.forEach((dt, i) => {
    const dateKey = dt.toISOString().split('T')[0];
    if (dailyPeaks[dateKey] && dt.getHours() === dailyPeaks[dateKey].actualHour) {
      dailyPeaks[dateKey].forecastAtPeak = forecast[i];
    }
  });

  // Find daily peaks in forecast
  datetimes.forEach((dt, i) => {
    const dateKey = dt.toISOString().split('T')[0];
    if (!dailyPeaks[dateKey].forecastPeakValue || forecast[i] > dailyPeaks[dateKey].forecastPeakValue) {
      dailyPeaks[dateKey].forecastPeakValue = forecast[i];
      dailyPeaks[dateKey].forecastPeakHour = dt.getHours();
    }
  });

  // Calculate peak timing error and magnitude error
  const days = Object.keys(dailyPeaks);
  let timingErrors = 0;
  let magnitudeErrors = 0;

  days.forEach(day => {
    const peak = dailyPeaks[day];
    if (peak.actualValue > 0.1) { // Only analyze significant days
      timingErrors += Math.abs(peak.forecastPeakHour - peak.actualHour);
      magnitudeErrors += Math.abs(peak.forecastPeakValue - peak.actualValue);
    }
  });

  return {
    avgTimingError: timingErrors / days.length,
    avgMagnitudeError: magnitudeErrors / days.length,
    peakCount: days.length
  };
}

// Main evaluation
async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('             SHAPE QUALITY EVALUATION                           ');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`\nForecast: ${FORECAST_FILE}`);
  console.log(`Actuals:  ${ACTUALS_FILE}`);
  console.log(`Period:   ${DATE_RANGE.start} to ${DATE_RANGE.end}\n`);

  // Read files
  const forecastCSV = readCSV(FORECAST_FILE);
  const actualsCSV = readCSV(ACTUALS_FILE);

  console.log(`Forecast headers (first 10): ${forecastCSV.header.slice(0, 10).join(', ')}`);
  console.log(`Actuals headers (first 10): ${actualsCSV.header.slice(0, 10).join(', ')}`);
  console.log(`Forecast rows: ${forecastCSV.data.length}`);
  console.log(`Actuals rows: ${actualsCSV.data.length}\n`);

  const results = [];

  for (const station of STATIONS_TO_ANALYZE) {
    console.log(`\n────────────────────────────────────────────────────────────────`);
    console.log(`Station: ${station}`);
    console.log(`────────────────────────────────────────────────────────────────`);

    const forecastData = extractStationData(forecastCSV, station, DATE_RANGE.start, DATE_RANGE.end);
    const actualsData = extractStationData(actualsCSV, station, DATE_RANGE.start, DATE_RANGE.end);

    console.log(`  Forecast points: ${forecastData.length}`);
    console.log(`  Actuals points:  ${actualsData.length}`);

    if (forecastData.length === 0 || actualsData.length === 0) {
      console.log(`  ⚠️  Insufficient data for analysis`);
      continue;
    }

    // Align by datetime
    const aligned = [];
    const forecastMap = new Map(forecastData.map(d => [d.datetime.getTime(), d.value]));

    for (const actual of actualsData) {
      const fValue = forecastMap.get(actual.datetime.getTime());
      if (fValue !== undefined) {
        aligned.push({
          datetime: actual.datetime,
          forecast: fValue,
          actual: actual.value
        });
      }
    }

    console.log(`  Aligned points:  ${aligned.length}`);

    if (aligned.length < 24) {
      console.log(`  ⚠️  Too few aligned points for analysis`);
      continue;
    }

    const forecasts = aligned.map(a => a.forecast);
    const actuals = aligned.map(a => a.actual);
    const datetimes = aligned.map(a => a.datetime);

    // Calculate metrics
    const corr = correlation(forecasts, actuals);
    const dirAcc = directionAccuracy(forecasts, actuals);
    const mapeVal = mape(forecasts, actuals);
    const maeVal = mae(forecasts, actuals);
    const varRatio = variabilityRatio(forecasts, actuals);
    const peaks = analyzePeaks(forecasts, actuals, datetimes);

    // Determine station type
    const isWind = ['01BURGOS', '01LAOAG', '01PAGUDPUD', '02DOLORES', '08BVISTA', '08NABAS_W'].includes(station);

    console.log(`\n  📊 Shape Quality Metrics:`);
    console.log(`     Correlation:      ${corr.toFixed(3)} ${corr > 0.7 ? '✅' : corr > 0.5 ? '⚠️' : '❌'}`);
    console.log(`     Direction Acc:    ${dirAcc.toFixed(1)}% ${dirAcc > 60 ? '✅' : dirAcc > 45 ? '⚠️' : '❌'}`);
    console.log(`     Variability:      ${varRatio.toFixed(2)}x ${varRatio > 0.7 && varRatio < 1.3 ? '✅' : '⚠️'}`);
    console.log(`     Peak Timing:      ±${peaks.avgTimingError.toFixed(1)} hours`);

    console.log(`\n  📈 Accuracy Metrics:`);
    console.log(`     MAPE:             ${mapeVal.toFixed(1)}%`);
    console.log(`     MAE:              ${maeVal.toFixed(4)}`);

    // Sample of hourly data
    console.log(`\n  📅 Sample Day (${datetimes[0].toISOString().split('T')[0]}):`);
    console.log(`     Hour  | Forecast | Actual  | Error`);
    console.log(`     ──────┼──────────┼─────────┼────────`);
    for (let i = 0; i < Math.min(12, aligned.length); i++) {
      const hour = datetimes[i].getHours().toString().padStart(2, '0');
      const f = forecasts[i].toFixed(3).padStart(7);
      const a = actuals[i].toFixed(3).padStart(7);
      const err = ((forecasts[i] - actuals[i]) * 100).toFixed(1).padStart(6);
      console.log(`       ${hour}  |  ${f} |  ${a} | ${err}%`);
    }

    results.push({
      station,
      type: isWind ? 'Wind' : 'Solar',
      correlation: corr,
      directionAccuracy: dirAcc,
      variabilityRatio: varRatio,
      peakTimingError: peaks.avgTimingError,
      mape: mapeVal,
      mae: maeVal
    });
  }

  // Summary
  console.log(`\n\n═══════════════════════════════════════════════════════════════`);
  console.log(`                         SUMMARY                                `);
  console.log(`═══════════════════════════════════════════════════════════════`);

  const windStations = results.filter(r => r.type === 'Wind');
  const solarStations = results.filter(r => r.type === 'Solar');

  if (windStations.length > 0) {
    const avgCorr = windStations.reduce((s, r) => s + r.correlation, 0) / windStations.length;
    const avgDir = windStations.reduce((s, r) => s + r.directionAccuracy, 0) / windStations.length;
    const avgMape = windStations.reduce((s, r) => s + r.mape, 0) / windStations.length;

    console.log(`\n🌬️  WIND STATIONS (${windStations.length}):`);
    console.log(`    Avg Correlation:     ${avgCorr.toFixed(3)}`);
    console.log(`    Avg Direction Acc:   ${avgDir.toFixed(1)}%`);
    console.log(`    Avg MAPE:            ${avgMape.toFixed(1)}%`);
  }

  if (solarStations.length > 0) {
    const avgCorr = solarStations.reduce((s, r) => s + r.correlation, 0) / solarStations.length;
    const avgDir = solarStations.reduce((s, r) => s + r.directionAccuracy, 0) / solarStations.length;
    const avgMape = solarStations.reduce((s, r) => s + r.mape, 0) / solarStations.length;

    console.log(`\n☀️  SOLAR STATIONS (${solarStations.length}):`);
    console.log(`    Avg Correlation:     ${avgCorr.toFixed(3)}`);
    console.log(`    Avg Direction Acc:   ${avgDir.toFixed(1)}%`);
    console.log(`    Avg MAPE:            ${avgMape.toFixed(1)}%`);
  }

  console.log(`\n\n📋 KEY SHAPE QUALITY INDICATORS:`);
  console.log(`   ✅ Correlation > 0.7    = Forecast tracks actual pattern well`);
  console.log(`   ✅ Direction Acc > 60%  = Captures up/down movements`);
  console.log(`   ✅ Variability 0.7-1.3x = Similar amplitude to actual`);
  console.log(`   ⚠️  Peak Timing > 2hrs  = Missing peak timing`);
  console.log(`\n`);
}

main().catch(console.error);
