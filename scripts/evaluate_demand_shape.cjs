/**
 * Demand Shape Quality Evaluation Script
 *
 * Evaluates demand forecast quality focusing on temporal patterns:
 * - Correlation coefficient (how well forecast follows actual patterns)
 * - Direction accuracy (% of hours where forecast direction matches actual)
 * - Ramp capture (morning/evening ramp accuracy)
 * - Peak/trough timing (how well peaks and troughs are captured)
 * - Day-type accuracy (weekday vs weekend patterns)
 * - Temperature correlation (demand response to temperature)
 */

const fs = require('fs');
const path = require('path');

// Configuration
const FORECAST_FILE = 'output/FC_DEM_Jan1-14.csv';
const ACTUALS_FILE = 'Data Samples/Demand/DemandHr_1-month Historical_JAN.csv';
const DATE_RANGE = { start: '2026-01-01', end: '2026-01-14' };

// Zones to analyze
const ZONES_TO_ANALYZE = [
  '01NLUZ', '02METRO', '03SLUZ',  // Luzon
  '04LEYTE', '05CEBU', '06NEGROS', '07BOHOL', '08PANAY',  // Visayas
  '09NWMIN', '10LANAO', '11NCMIN', '12NEMIN', '13SEMIN', '14SWMIN'  // Mindanao
];

// Time periods for analysis
const TIME_PERIODS = {
  NIGHT: { start: 0, end: 5 },
  MORNING_RAMP: { start: 6, end: 9 },
  MIDDAY: { start: 10, end: 16 },
  EVENING_PEAK: { start: 17, end: 22 },
  LATE_NIGHT: { start: 23, end: 23 }
};

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

// Extract zone data for a specific zone and date range
function extractZoneData(csvData, zoneCode, startDate, endDate) {
  const start = new Date(startDate);
  start.setHours(0, 0, 0, 0);
  const end = new Date(endDate);
  end.setHours(23, 59, 59, 999);

  const header = csvData.header;
  const dateCol = header[0];
  const zoneIdx = header.indexOf(zoneCode);

  if (zoneIdx === -1) {
    console.log(`  Zone ${zoneCode} not found in headers`);
    return [];
  }

  const results = [];
  for (const row of csvData.data) {
    const dateStr = row[dateCol];
    if (!dateStr) continue;

    const dt = parseDate(dateStr);
    if (isNaN(dt.getTime())) continue;
    if (dt < start || dt > end) continue;

    const valueStr = row[zoneCode];
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
    if (actual[i] > 10) { // Avoid division by near-zero
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

// Analyze ramp accuracy (morning 6-9 AM and evening 5-7 PM)
function analyzeRamps(forecasts, actuals, datetimes) {
  const morningRamps = { forecast: [], actual: [] };
  const eveningRamps = { forecast: [], actual: [] };

  // Group by day
  const days = {};
  datetimes.forEach((dt, i) => {
    const dateKey = dt.toISOString().split('T')[0];
    if (!days[dateKey]) days[dateKey] = [];
    days[dateKey].push({ hour: dt.getHours(), f: forecasts[i], a: actuals[i] });
  });

  // Calculate ramps for each day
  for (const [day, hours] of Object.entries(days)) {
    const byHour = {};
    hours.forEach(h => { byHour[h.hour] = h; });

    // Morning ramp (6 AM to 9 AM)
    if (byHour[6] && byHour[9]) {
      morningRamps.forecast.push(byHour[9].f - byHour[6].f);
      morningRamps.actual.push(byHour[9].a - byHour[6].a);
    }

    // Evening ramp (5 PM to 7 PM)
    if (byHour[17] && byHour[19]) {
      eveningRamps.forecast.push(byHour[19].f - byHour[17].f);
      eveningRamps.actual.push(byHour[19].a - byHour[17].a);
    }
  }

  return {
    morningCorr: correlation(morningRamps.forecast, morningRamps.actual),
    eveningCorr: correlation(eveningRamps.forecast, eveningRamps.actual),
    morningAvgError: mae(morningRamps.forecast, morningRamps.actual),
    eveningAvgError: mae(eveningRamps.forecast, eveningRamps.actual)
  };
}

// Analyze peak and trough timing
function analyzePeaksTroughs(forecasts, actuals, datetimes) {
  const days = {};
  datetimes.forEach((dt, i) => {
    const dateKey = dt.toISOString().split('T')[0];
    if (!days[dateKey]) days[dateKey] = [];
    days[dateKey].push({ hour: dt.getHours(), f: forecasts[i], a: actuals[i] });
  });

  let peakTimingError = 0;
  let troughTimingError = 0;
  let peakMagError = 0;
  let troughMagError = 0;
  let dayCount = 0;

  for (const hours of Object.values(days)) {
    if (hours.length < 20) continue; // Need most of the day

    // Find actual peak/trough
    let actualPeak = { hour: 0, value: -Infinity };
    let actualTrough = { hour: 0, value: Infinity };
    let forecastPeak = { hour: 0, value: -Infinity };
    let forecastTrough = { hour: 0, value: Infinity };

    hours.forEach(h => {
      if (h.a > actualPeak.value) actualPeak = { hour: h.hour, value: h.a };
      if (h.a < actualTrough.value) actualTrough = { hour: h.hour, value: h.a };
      if (h.f > forecastPeak.value) forecastPeak = { hour: h.hour, value: h.f };
      if (h.f < forecastTrough.value) forecastTrough = { hour: h.hour, value: h.f };
    });

    peakTimingError += Math.abs(forecastPeak.hour - actualPeak.hour);
    troughTimingError += Math.abs(forecastTrough.hour - actualTrough.hour);
    peakMagError += Math.abs(forecastPeak.value - actualPeak.value);
    troughMagError += Math.abs(forecastTrough.value - actualTrough.value);
    dayCount++;
  }

  return {
    avgPeakTimingError: dayCount > 0 ? peakTimingError / dayCount : NaN,
    avgTroughTimingError: dayCount > 0 ? troughTimingError / dayCount : NaN,
    avgPeakMagError: dayCount > 0 ? peakMagError / dayCount : NaN,
    avgTroughMagError: dayCount > 0 ? troughMagError / dayCount : NaN
  };
}

// Analyze day-type patterns (weekday vs weekend)
function analyzeDayTypes(forecasts, actuals, datetimes) {
  const weekday = { f: [], a: [] };
  const weekend = { f: [], a: [] };

  datetimes.forEach((dt, i) => {
    const dow = dt.getDay();
    if (dow === 0 || dow === 6) {
      weekend.f.push(forecasts[i]);
      weekend.a.push(actuals[i]);
    } else {
      weekday.f.push(forecasts[i]);
      weekday.a.push(actuals[i]);
    }
  });

  return {
    weekdayCorr: correlation(weekday.f, weekday.a),
    weekendCorr: correlation(weekend.f, weekend.a),
    weekdayMAPE: mape(weekday.f, weekday.a),
    weekendMAPE: mape(weekend.f, weekend.a)
  };
}

// Analyze time period accuracy
function analyzeTimePeriods(forecasts, actuals, datetimes) {
  const periods = {};
  for (const [name, range] of Object.entries(TIME_PERIODS)) {
    periods[name] = { f: [], a: [] };
  }

  datetimes.forEach((dt, i) => {
    const hour = dt.getHours();
    for (const [name, range] of Object.entries(TIME_PERIODS)) {
      if (hour >= range.start && hour <= range.end) {
        periods[name].f.push(forecasts[i]);
        periods[name].a.push(actuals[i]);
        break;
      }
    }
  });

  const results = {};
  for (const [name, data] of Object.entries(periods)) {
    if (data.f.length > 0) {
      results[name] = {
        correlation: correlation(data.f, data.a),
        mape: mape(data.f, data.a),
        samples: data.f.length
      };
    }
  }
  return results;
}

// Main evaluation
async function main() {
  console.log('=====================================================================');
  console.log('            DEMAND SHAPE QUALITY EVALUATION                          ');
  console.log('=====================================================================');
  console.log(`\nForecast: ${FORECAST_FILE}`);
  console.log(`Actuals:  ${ACTUALS_FILE}`);
  console.log(`Period:   ${DATE_RANGE.start} to ${DATE_RANGE.end}\n`);

  // Read files
  const forecastCSV = readCSV(FORECAST_FILE);
  const actualsCSV = readCSV(ACTUALS_FILE);

  console.log(`Forecast headers: ${forecastCSV.header.slice(0, 5).join(', ')}...`);
  console.log(`Actuals headers: ${actualsCSV.header.slice(0, 5).join(', ')}...`);
  console.log(`Forecast rows: ${forecastCSV.data.length}`);
  console.log(`Actuals rows: ${actualsCSV.data.length}\n`);

  const results = [];
  const aggregated = {
    luzon: { f: [], a: [], dt: [] },
    visayas: { f: [], a: [], dt: [] },
    mindanao: { f: [], a: [], dt: [] }
  };

  for (const zone of ZONES_TO_ANALYZE) {
    console.log(`\n--------------------------------------------------------------------`);
    console.log(`Zone: ${zone}`);
    console.log(`--------------------------------------------------------------------`);

    const forecastData = extractZoneData(forecastCSV, zone, DATE_RANGE.start, DATE_RANGE.end);
    const actualsData = extractZoneData(actualsCSV, zone, DATE_RANGE.start, DATE_RANGE.end);

    console.log(`  Forecast points: ${forecastData.length}`);
    console.log(`  Actuals points:  ${actualsData.length}`);

    if (forecastData.length === 0 || actualsData.length === 0) {
      console.log(`  Warning: Insufficient data for analysis`);
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
      console.log(`  Warning: Too few aligned points for analysis`);
      continue;
    }

    const forecasts = aligned.map(a => a.forecast);
    const actuals = aligned.map(a => a.actual);
    const datetimes = aligned.map(a => a.datetime);

    // Aggregate by region
    const zoneNum = parseInt(zone.slice(0, 2));
    if (zoneNum <= 3) {
      aggregated.luzon.f.push(...forecasts);
      aggregated.luzon.a.push(...actuals);
      aggregated.luzon.dt.push(...datetimes);
    } else if (zoneNum <= 8) {
      aggregated.visayas.f.push(...forecasts);
      aggregated.visayas.a.push(...actuals);
      aggregated.visayas.dt.push(...datetimes);
    } else {
      aggregated.mindanao.f.push(...forecasts);
      aggregated.mindanao.a.push(...actuals);
      aggregated.mindanao.dt.push(...datetimes);
    }

    // Calculate metrics
    const corr = correlation(forecasts, actuals);
    const dirAcc = directionAccuracy(forecasts, actuals);
    const mapeVal = mape(forecasts, actuals);
    const maeVal = mae(forecasts, actuals);
    const ramps = analyzeRamps(forecasts, actuals, datetimes);
    const peaks = analyzePeaksTroughs(forecasts, actuals, datetimes);
    const dayTypes = analyzeDayTypes(forecasts, actuals, datetimes);
    const timePeriods = analyzeTimePeriods(forecasts, actuals, datetimes);

    console.log(`\n  Shape Quality Metrics:`);
    console.log(`     Correlation:      ${corr.toFixed(3)} ${corr > 0.95 ? 'EXCELLENT' : corr > 0.9 ? 'GOOD' : corr > 0.8 ? 'OK' : 'POOR'}`);
    console.log(`     Direction Acc:    ${dirAcc.toFixed(1)}% ${dirAcc > 70 ? 'EXCELLENT' : dirAcc > 60 ? 'GOOD' : 'NEEDS WORK'}`);

    console.log(`\n  Accuracy Metrics:`);
    console.log(`     MAPE:             ${mapeVal.toFixed(2)}%`);
    console.log(`     MAE:              ${maeVal.toFixed(1)} MW`);

    console.log(`\n  Ramp Analysis:`);
    console.log(`     Morning ramp corr: ${ramps.morningCorr.toFixed(3)}`);
    console.log(`     Evening ramp corr: ${ramps.eveningCorr.toFixed(3)}`);

    console.log(`\n  Peak/Trough Timing:`);
    console.log(`     Peak timing:  +/- ${peaks.avgPeakTimingError.toFixed(1)} hours`);
    console.log(`     Trough timing: +/- ${peaks.avgTroughTimingError.toFixed(1)} hours`);

    console.log(`\n  Day Type Analysis:`);
    console.log(`     Weekday corr: ${dayTypes.weekdayCorr.toFixed(3)}, MAPE: ${dayTypes.weekdayMAPE.toFixed(2)}%`);
    console.log(`     Weekend corr: ${dayTypes.weekendCorr.toFixed(3)}, MAPE: ${dayTypes.weekendMAPE.toFixed(2)}%`);

    console.log(`\n  Time Period Analysis:`);
    for (const [period, metrics] of Object.entries(timePeriods)) {
      console.log(`     ${period.padEnd(14)}: corr=${metrics.correlation.toFixed(3)}, MAPE=${metrics.mape.toFixed(1)}%`);
    }

    results.push({
      zone,
      correlation: corr,
      directionAccuracy: dirAcc,
      mape: mapeVal,
      mae: maeVal,
      ramps,
      peaks,
      dayTypes,
      timePeriods
    });
  }

  // Regional summary
  console.log(`\n\n=====================================================================`);
  console.log(`                      REGIONAL SUMMARY                               `);
  console.log(`=====================================================================`);

  for (const [region, data] of Object.entries(aggregated)) {
    if (data.f.length === 0) continue;

    const corr = correlation(data.f, data.a);
    const dirAcc = directionAccuracy(data.f, data.a);
    const mapeVal = mape(data.f, data.a);
    const ramps = analyzeRamps(data.f, data.a, data.dt);
    const peaks = analyzePeaksTroughs(data.f, data.a, data.dt);
    const dayTypes = analyzeDayTypes(data.f, data.a, data.dt);

    console.log(`\n${region.toUpperCase()} (${data.f.length} hours):`);
    console.log(`   Correlation:     ${corr.toFixed(3)}`);
    console.log(`   Direction Acc:   ${dirAcc.toFixed(1)}%`);
    console.log(`   MAPE:            ${mapeVal.toFixed(2)}%`);
    console.log(`   Morning ramp:    ${ramps.morningCorr.toFixed(3)} corr`);
    console.log(`   Evening ramp:    ${ramps.eveningCorr.toFixed(3)} corr`);
    console.log(`   Peak timing:     +/- ${peaks.avgPeakTimingError.toFixed(1)} hours`);
    console.log(`   Weekday/Weekend: ${dayTypes.weekdayMAPE.toFixed(1)}% / ${dayTypes.weekendMAPE.toFixed(1)}%`);
  }

  // Overall summary
  console.log(`\n\n=====================================================================`);
  console.log(`                      SHAPE QUALITY FINDINGS                         `);
  console.log(`=====================================================================`);

  const avgCorr = results.reduce((s, r) => s + r.correlation, 0) / results.length;
  const avgDirAcc = results.reduce((s, r) => s + r.directionAccuracy, 0) / results.length;
  const avgMAPE = results.reduce((s, r) => s + r.mape, 0) / results.length;

  console.log(`\n  OVERALL AVERAGES:`);
  console.log(`     Correlation:      ${avgCorr.toFixed(3)}`);
  console.log(`     Direction Acc:    ${avgDirAcc.toFixed(1)}%`);
  console.log(`     MAPE:             ${avgMAPE.toFixed(2)}%`);

  // Identify problem areas
  console.log(`\n  AREAS FOR LSTM IMPROVEMENT:`);

  // Check ramp correlation
  const lowMorningRamp = results.filter(r => r.ramps.morningCorr < 0.7);
  const lowEveningRamp = results.filter(r => r.ramps.eveningCorr < 0.7);

  if (lowMorningRamp.length > 0) {
    console.log(`\n  1. Morning Ramp (6-9 AM) - ${lowMorningRamp.length} zones with corr < 0.7:`);
    console.log(`     Zones: ${lowMorningRamp.map(r => r.zone).join(', ')}`);
    console.log(`     -> LSTM can learn temperature-demand relationship during ramp-up`);
  }

  if (lowEveningRamp.length > 0) {
    console.log(`\n  2. Evening Ramp (5-7 PM) - ${lowEveningRamp.length} zones with corr < 0.7:`);
    console.log(`     Zones: ${lowEveningRamp.map(r => r.zone).join(', ')}`);
    console.log(`     -> LSTM can learn lighting demand + cooling persistence`);
  }

  // Check weekend accuracy
  const weekendIssues = results.filter(r => r.dayTypes.weekendMAPE > r.dayTypes.weekdayMAPE * 1.2);
  if (weekendIssues.length > 0) {
    console.log(`\n  3. Weekend patterns - ${weekendIssues.length} zones with 20%+ higher weekend MAPE:`);
    console.log(`     Zones: ${weekendIssues.map(r => r.zone).join(', ')}`);
    console.log(`     -> LSTM can learn day-type transitions and calendar effects`);
  }

  // Check peak timing
  const peakTimingIssues = results.filter(r => r.peaks.avgPeakTimingError > 1.5);
  if (peakTimingIssues.length > 0) {
    console.log(`\n  4. Peak timing - ${peakTimingIssues.length} zones with > 1.5hr avg error:`);
    console.log(`     Zones: ${peakTimingIssues.map(r => r.zone).join(', ')}`);
    console.log(`     -> LSTM can learn seasonal peak hour shifts`);
  }

  console.log(`\n\n  LSTM ENHANCEMENT OPPORTUNITIES:`);
  console.log(`   - Temperature momentum (rate of temp change affects demand lag)`);
  console.log(`   - Demand ramp dynamics (rate of change patterns)`);
  console.log(`   - Day-type transitions (Friday->Saturday, Sunday->Monday patterns)`);
  console.log(`   - Season-specific temp sensitivity (heating vs cooling degree hours)`);
  console.log(`   - Holiday recovery patterns (demand bounce-back after holidays)`);
  console.log(`\n`);
}

main().catch(console.error);
