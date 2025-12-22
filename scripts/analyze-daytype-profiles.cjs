/**
 * Analyze Demand Forecast by Day Type with Peak/Valley Analysis
 *
 * Provides detailed analysis of:
 * - Sunday profiles (under-forecasting check)
 * - Peak hours vs valley hours by day type
 * - Day type specific MAPE and bias
 */

const { readFileSync, existsSync } = require('fs');
const { join } = require('path');
const { DateTime } = require('luxon');
const Database = require('better-sqlite3');

// Anomalous dates to exclude (typhoon period)
const EXCLUDE_DATES = [
  '2025-11-01', '2025-11-02', '2025-11-03', '2025-11-04', '2025-11-05',
  '2025-11-06', '2025-11-07', '2025-11-08', '2025-11-09', '2025-11-10'
];

// Day type definitions
const DAY_TYPES = {
  WEEKDAY: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'],
  SATURDAY: ['Sat'],
  SUNDAY: ['Sun']
};

const DAY_NAMES = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

// Time period definitions
const TIME_PERIODS = {
  OVERNIGHT: { start: 0, end: 5, name: 'Overnight (00-05)' },
  MORNING_RAMP: { start: 6, end: 9, name: 'Morning Ramp (06-09)' },
  MIDDAY_PEAK: { start: 10, end: 14, name: 'Midday Peak (10-14)' },
  AFTERNOON_PEAK: { start: 15, end: 18, name: 'Afternoon Peak (15-18)' },
  EVENING: { start: 19, end: 23, name: 'Evening (19-23)' }
};

function parseDateTime(str) {
  let dt = DateTime.fromISO(str);
  if (dt.isValid) return dt;
  dt = DateTime.fromFormat(str, 'M/d/yyyy HH:mm');
  if (dt.isValid) return dt;
  return null;
}

function loadDemandForecast(path) {
  const content = readFileSync(path, 'utf-8');
  const lines = content.split('\n').filter(l => l.trim());
  if (lines.length < 2) return new Map();

  const headers = lines[0].split(',').map(h => h.trim());
  const dtIdx = headers.findIndex(h => h.toLowerCase().includes('datetime'));
  const cluzIdx = headers.indexOf('CLUZ');
  const cvisIdx = headers.indexOf('CVIS');
  const cminIdx = headers.indexOf('CMIN');

  const forecasts = new Map();

  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(',').map(v => v.trim());
    const dt = parseDateTime(values[dtIdx]);
    if (!dt) continue;

    const key = dt.toFormat('yyyy-MM-dd HH:mm');
    forecasts.set(key, {
      datetime: dt,
      CLUZ: parseFloat(values[cluzIdx]) || 0,
      CVIS: parseFloat(values[cvisIdx]) || 0,
      CMIN: parseFloat(values[cminIdx]) || 0
    });
  }

  return forecasts;
}

function loadActualDemand(startDate, endDate) {
  const dbPath = join(process.cwd(), 'data', 'iload.db');
  if (!existsSync(dbPath)) return new Map();

  const db = new Database(dbPath);
  const stmt = db.prepare(`
    SELECT datetime, region, demand
    FROM demand_records
    WHERE datetime >= ? AND datetime <= ?
    ORDER BY datetime, region
  `);

  const rows = stmt.all(startDate, endDate);
  db.close();

  const actuals = new Map();
  for (const row of rows) {
    const dt = DateTime.fromISO(row.datetime);
    const key = dt.toFormat('yyyy-MM-dd HH:mm');

    if (!actuals.has(key)) {
      actuals.set(key, { datetime: dt, CLUZ: 0, CVIS: 0, CMIN: 0 });
    }
    actuals.get(key)[row.region] = row.demand;
  }

  return actuals;
}

function getDayType(dayOfWeek) {
  const dayName = DAY_NAMES[dayOfWeek];
  if (DAY_TYPES.SUNDAY.includes(dayName)) return 'Sunday';
  if (DAY_TYPES.SATURDAY.includes(dayName)) return 'Saturday';
  return 'Weekday';
}

function getTimePeriod(hour) {
  for (const [key, period] of Object.entries(TIME_PERIODS)) {
    if (hour >= period.start && hour <= period.end) {
      return { key, ...period };
    }
  }
  return { key: 'UNKNOWN', name: 'Unknown', start: 0, end: 23 };
}

function calculateMAPE(actual, predicted) {
  let errorSum = 0;
  let count = 0;
  for (let i = 0; i < actual.length; i++) {
    if (actual[i] > 0) {
      errorSum += Math.abs((predicted[i] - actual[i]) / actual[i]);
      count++;
    }
  }
  return count > 0 ? (errorSum / count) * 100 : 0;
}

async function main() {
  console.log('');
  console.log('='.repeat(95));
  console.log('DAY TYPE PROFILE ANALYSIS - DEMAND FORECAST');
  console.log('='.repeat(95));
  console.log('');

  const demandForecastPath = join(process.cwd(), 'output', 'demand_forecast_nov_dec_2025.csv');
  const forecasts = loadDemandForecast(demandForecastPath);
  const actuals = loadActualDemand('2025-11-01', '2025-12-12');

  if (forecasts.size === 0 || actuals.size === 0) {
    console.log('No data available');
    return;
  }

  // Build paired data
  const paired = [];
  for (const [key, forecast] of forecasts) {
    const actual = actuals.get(key);
    if (!actual) continue;

    const dateStr = key.substring(0, 10);
    if (EXCLUDE_DATES.includes(dateStr)) continue;

    paired.push({
      datetime: forecast.datetime,
      hour: forecast.datetime.hour,
      dayOfWeek: forecast.datetime.weekday,
      dayName: DAY_NAMES[forecast.datetime.weekday],
      dayType: getDayType(forecast.datetime.weekday),
      timePeriod: getTimePeriod(forecast.datetime.hour),
      date: dateStr,
      forecast,
      actual
    });
  }

  console.log('Analyzing ' + paired.length + ' records (excluding typhoon period)');
  console.log('');

  const regions = ['CLUZ', 'CVIS', 'CMIN'];

  // ═══════════════════════════════════════════════════════════════════════════
  // SECTION 1: SUNDAY PROFILE ANALYSIS
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('═══════════════════════════════════════════════════════════════════════════════════════════');
  console.log('1. SUNDAY PROFILE ANALYSIS (Checking for Under-Forecasting)');
  console.log('═══════════════════════════════════════════════════════════════════════════════════════════');
  console.log('');

  const sundayData = paired.filter(p => p.dayType === 'Sunday');

  for (const region of regions) {
    console.log(region + ' - Sunday Hourly Profile:');
    console.log('Hour'.padEnd(6) + 'Count'.padStart(6) + 'Actual'.padStart(10) + 'Forecast'.padStart(10) + 'Error'.padStart(10) + 'Bias'.padStart(10) + '  Direction');
    console.log('-'.repeat(70));

    for (let h = 0; h < 24; h++) {
      const hourData = sundayData.filter(p => p.hour === h);
      if (hourData.length === 0) continue;

      const actuals = hourData.map(p => p.actual[region]).filter(v => v > 0);
      const forecasted = hourData.map(p => p.forecast[region]).filter(v => v > 0);

      if (actuals.length === 0) continue;

      const avgAct = actuals.reduce((a, b) => a + b, 0) / actuals.length;
      const avgFcst = forecasted.reduce((a, b) => a + b, 0) / forecasted.length;
      const mape = calculateMAPE(actuals, forecasted);
      const bias = ((avgFcst - avgAct) / avgAct) * 100;
      const direction = bias < -2 ? '<<< UNDER' : (bias > 2 ? '>>> OVER' : '');

      console.log(
        h.toString().padEnd(6) +
        actuals.length.toString().padStart(6) +
        avgAct.toFixed(0).padStart(10) +
        avgFcst.toFixed(0).padStart(10) +
        (mape.toFixed(1) + '%').padStart(10) +
        ((bias > 0 ? '+' : '') + bias.toFixed(1) + '%').padStart(10) +
        '  ' + direction
      );
    }
    console.log('');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SECTION 2: DAY TYPE COMPARISON
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('═══════════════════════════════════════════════════════════════════════════════════════════');
  console.log('2. DAY TYPE COMPARISON (Weekday vs Saturday vs Sunday)');
  console.log('═══════════════════════════════════════════════════════════════════════════════════════════');
  console.log('');

  const dayTypes = ['Weekday', 'Saturday', 'Sunday'];

  for (const region of regions) {
    console.log(region + ':');
    console.log('Day Type'.padEnd(12) + 'Records'.padStart(8) + 'Avg Act'.padStart(10) + 'Avg Fcst'.padStart(10) + 'MAPE'.padStart(10) + 'Bias'.padStart(10) + '  Status');
    console.log('-'.repeat(75));

    for (const dayType of dayTypes) {
      const typeData = paired.filter(p => p.dayType === dayType);
      const actuals = typeData.map(p => p.actual[region]).filter(v => v > 0);
      const forecasted = typeData.map(p => p.forecast[region]).filter(v => v > 0);

      if (actuals.length === 0) continue;

      const avgAct = actuals.reduce((a, b) => a + b, 0) / actuals.length;
      const avgFcst = forecasted.reduce((a, b) => a + b, 0) / forecasted.length;
      const mape = calculateMAPE(actuals, forecasted);
      const bias = ((avgFcst - avgAct) / avgAct) * 100;

      let status = '';
      if (mape > 5) status = '!!! HIGH ERROR';
      else if (bias < -3) status = '<<< UNDER-FORECAST';
      else if (bias > 3) status = '>>> OVER-FORECAST';

      console.log(
        dayType.padEnd(12) +
        actuals.length.toString().padStart(8) +
        avgAct.toFixed(0).padStart(10) +
        avgFcst.toFixed(0).padStart(10) +
        (mape.toFixed(1) + '%').padStart(10) +
        ((bias > 0 ? '+' : '') + bias.toFixed(1) + '%').padStart(10) +
        '  ' + status
      );
    }
    console.log('');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SECTION 3: PEAK/VALLEY ANALYSIS BY DAY TYPE
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('═══════════════════════════════════════════════════════════════════════════════════════════');
  console.log('3. PEAK/VALLEY ANALYSIS BY DAY TYPE AND TIME PERIOD');
  console.log('═══════════════════════════════════════════════════════════════════════════════════════════');
  console.log('');

  for (const region of regions) {
    console.log(region + ':');
    console.log('');

    for (const dayType of dayTypes) {
      console.log('  ' + dayType + ':');
      console.log('  ' + 'Time Period'.padEnd(24) + 'Samples'.padStart(8) + 'Avg Act'.padStart(10) + 'Avg Fcst'.padStart(10) + 'MAPE'.padStart(8) + 'Bias'.padStart(10));
      console.log('  ' + '-'.repeat(70));

      const typeData = paired.filter(p => p.dayType === dayType);

      for (const [periodKey, period] of Object.entries(TIME_PERIODS)) {
        const periodData = typeData.filter(p => p.timePeriod.key === periodKey);
        if (periodData.length === 0) continue;

        const actuals = periodData.map(p => p.actual[region]).filter(v => v > 0);
        const forecasted = periodData.map(p => p.forecast[region]).filter(v => v > 0);

        if (actuals.length === 0) continue;

        const avgAct = actuals.reduce((a, b) => a + b, 0) / actuals.length;
        const avgFcst = forecasted.reduce((a, b) => a + b, 0) / forecasted.length;
        const mape = calculateMAPE(actuals, forecasted);
        const bias = ((avgFcst - avgAct) / avgAct) * 100;

        console.log(
          '  ' + period.name.padEnd(24) +
          actuals.length.toString().padStart(8) +
          avgAct.toFixed(0).padStart(10) +
          avgFcst.toFixed(0).padStart(10) +
          (mape.toFixed(1) + '%').padStart(8) +
          ((bias > 0 ? '+' : '') + bias.toFixed(1) + '%').padStart(10)
        );
      }
      console.log('');
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SECTION 4: DAILY PEAK AND VALLEY ANALYSIS
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('═══════════════════════════════════════════════════════════════════════════════════════════');
  console.log('4. DAILY PEAK AND VALLEY ACCURACY');
  console.log('═══════════════════════════════════════════════════════════════════════════════════════════');
  console.log('');

  // Group by date
  const dateGroups = new Map();
  for (const p of paired) {
    if (!dateGroups.has(p.date)) {
      dateGroups.set(p.date, []);
    }
    dateGroups.get(p.date).push(p);
  }

  for (const region of regions) {
    const peakErrors = { Weekday: [], Saturday: [], Sunday: [] };
    const valleyErrors = { Weekday: [], Saturday: [], Sunday: [] };
    const peakBias = { Weekday: [], Saturday: [], Sunday: [] };
    const valleyBias = { Weekday: [], Saturday: [], Sunday: [] };

    for (const [date, dayData] of dateGroups) {
      if (dayData.length < 20) continue; // Need most of the day

      const dayType = dayData[0].dayType;

      // Find actual peak and valley
      let maxActual = -Infinity, minActual = Infinity;
      let maxActualHour = 0, minActualHour = 0;
      let peakForecast = 0, valleyForecast = 0;

      for (const p of dayData) {
        const actual = p.actual[region];
        const forecast = p.forecast[region];
        if (actual <= 0) continue;

        if (actual > maxActual) {
          maxActual = actual;
          maxActualHour = p.hour;
          peakForecast = forecast;
        }
        if (actual < minActual) {
          minActual = actual;
          minActualHour = p.hour;
          valleyForecast = forecast;
        }
      }

      if (maxActual > 0 && minActual < Infinity) {
        const peakErr = Math.abs((peakForecast - maxActual) / maxActual) * 100;
        const valleyErr = Math.abs((valleyForecast - minActual) / minActual) * 100;
        const peakB = ((peakForecast - maxActual) / maxActual) * 100;
        const valleyB = ((valleyForecast - minActual) / minActual) * 100;

        peakErrors[dayType].push(peakErr);
        valleyErrors[dayType].push(valleyErr);
        peakBias[dayType].push(peakB);
        valleyBias[dayType].push(valleyB);
      }
    }

    console.log(region + ' - Peak/Valley Accuracy by Day Type:');
    console.log('Day Type'.padEnd(12) + 'Peak MAPE'.padStart(12) + 'Peak Bias'.padStart(12) + 'Valley MAPE'.padStart(14) + 'Valley Bias'.padStart(14));
    console.log('-'.repeat(64));

    for (const dayType of dayTypes) {
      if (peakErrors[dayType].length === 0) continue;

      const avgPeakErr = peakErrors[dayType].reduce((a, b) => a + b, 0) / peakErrors[dayType].length;
      const avgValleyErr = valleyErrors[dayType].reduce((a, b) => a + b, 0) / valleyErrors[dayType].length;
      const avgPeakBias = peakBias[dayType].reduce((a, b) => a + b, 0) / peakBias[dayType].length;
      const avgValleyBias = valleyBias[dayType].reduce((a, b) => a + b, 0) / valleyBias[dayType].length;

      console.log(
        dayType.padEnd(12) +
        (avgPeakErr.toFixed(1) + '%').padStart(12) +
        ((avgPeakBias > 0 ? '+' : '') + avgPeakBias.toFixed(1) + '%').padStart(12) +
        (avgValleyErr.toFixed(1) + '%').padStart(14) +
        ((avgValleyBias > 0 ? '+' : '') + avgValleyBias.toFixed(1) + '%').padStart(14)
      );
    }
    console.log('');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SECTION 5: INDIVIDUAL DAY ANALYSIS (Per-day breakdown)
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('═══════════════════════════════════════════════════════════════════════════════════════════');
  console.log('5. INDIVIDUAL DAY OF WEEK ANALYSIS');
  console.log('═══════════════════════════════════════════════════════════════════════════════════════════');
  console.log('');

  for (const region of regions) {
    console.log(region + ':');
    console.log('Day'.padEnd(6) + 'Records'.padStart(8) + 'Avg Act'.padStart(10) + 'Avg Fcst'.padStart(10) + 'MAPE'.padStart(8) + 'Bias'.padStart(10) + '  Issue');
    console.log('-'.repeat(70));

    for (let d = 1; d <= 7; d++) {
      const dayData = paired.filter(p => p.dayOfWeek === d);
      if (dayData.length === 0) continue;

      const actuals = dayData.map(p => p.actual[region]).filter(v => v > 0);
      const forecasted = dayData.map(p => p.forecast[region]).filter(v => v > 0);

      if (actuals.length === 0) continue;

      const avgAct = actuals.reduce((a, b) => a + b, 0) / actuals.length;
      const avgFcst = forecasted.reduce((a, b) => a + b, 0) / forecasted.length;
      const mape = calculateMAPE(actuals, forecasted);
      const bias = ((avgFcst - avgAct) / avgAct) * 100;

      let issue = '';
      if (mape > 5) issue = 'HIGH ERROR';
      if (bias < -2) issue += (issue ? ', ' : '') + 'UNDER';
      if (bias > 2) issue += (issue ? ', ' : '') + 'OVER';

      console.log(
        DAY_NAMES[d].padEnd(6) +
        actuals.length.toString().padStart(8) +
        avgAct.toFixed(0).padStart(10) +
        avgFcst.toFixed(0).padStart(10) +
        (mape.toFixed(1) + '%').padStart(8) +
        ((bias > 0 ? '+' : '') + bias.toFixed(1) + '%').padStart(10) +
        '  ' + issue
      );
    }
    console.log('');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SECTION 6: SUMMARY AND RECOMMENDATIONS
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('═══════════════════════════════════════════════════════════════════════════════════════════');
  console.log('6. SUMMARY AND RECOMMENDATIONS');
  console.log('═══════════════════════════════════════════════════════════════════════════════════════════');
  console.log('');

  // Calculate overall stats by day type for summary
  for (const region of regions) {
    console.log(region + ' Summary:');

    for (const dayType of dayTypes) {
      const typeData = paired.filter(p => p.dayType === dayType);
      const actuals = typeData.map(p => p.actual[region]).filter(v => v > 0);
      const forecasted = typeData.map(p => p.forecast[region]).filter(v => v > 0);

      if (actuals.length === 0) continue;

      const avgAct = actuals.reduce((a, b) => a + b, 0) / actuals.length;
      const avgFcst = forecasted.reduce((a, b) => a + b, 0) / forecasted.length;
      const bias = ((avgFcst - avgAct) / avgAct) * 100;

      if (Math.abs(bias) > 2) {
        const action = bias > 0 ? 'REDUCE' : 'INCREASE';
        console.log(`  ${dayType}: ${action} forecast by ${Math.abs(bias).toFixed(1)}%`);
      }
    }
    console.log('');
  }

  console.log('='.repeat(95));
  console.log('ANALYSIS COMPLETE');
  console.log('='.repeat(95));
}

main().catch(console.error);
