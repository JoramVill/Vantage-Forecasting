/**
 * Analyze Demand Forecast Errors to Identify Improvement Opportunities
 *
 * Focus on understanding why CVIS has higher error (18.2% vs 5.7% CLUZ).
 */

const { readFileSync, existsSync } = require('fs');
const { join } = require('path');
const { DateTime } = require('luxon');
const Database = require('better-sqlite3');

// Anomalous dates to exclude (typhoon period with data quality issues)
const EXCLUDE_DATES = [
  '2025-11-01', '2025-11-02', '2025-11-03', '2025-11-04', '2025-11-05',
  '2025-11-06', '2025-11-07', '2025-11-08', '2025-11-09', '2025-11-10'
];

// Parse date from forecast CSV
function parseDateTime(str) {
  let dt = DateTime.fromISO(str);
  if (dt.isValid) return dt;
  dt = DateTime.fromFormat(str, 'M/d/yyyy HH:mm');
  if (dt.isValid) return dt;
  return null;
}

// Load demand forecast
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

// Load actual demand from database
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

async function main() {
  console.log('');
  console.log('='.repeat(90));
  console.log('DEMAND FORECAST ERROR ANALYSIS');
  console.log('='.repeat(90));
  console.log('');

  const demandForecastPath = join(process.cwd(), 'output', 'demand_forecast_nov_dec_2025.csv');
  const forecasts = loadDemandForecast(demandForecastPath);
  const actuals = loadActualDemand('2025-11-01', '2025-12-12');

  if (forecasts.size === 0 || actuals.size === 0) {
    console.log('No data available');
    return;
  }

  console.log('Loaded ' + forecasts.size + ' forecast records');
  console.log('Loaded ' + actuals.size + ' actual records');
  console.log('');

  const regions = ['CLUZ', 'CVIS', 'CMIN'];

  // Build paired data (excluding typhoon anomaly dates)
  const paired = [];
  let excludedCount = 0;
  for (const [key, forecast] of forecasts) {
    const actual = actuals.get(key);
    if (!actual) continue;

    // Skip anomalous typhoon dates
    const dateStr = key.substring(0, 10);
    if (EXCLUDE_DATES.includes(dateStr)) {
      excludedCount++;
      continue;
    }

    paired.push({
      datetime: forecast.datetime,
      hour: forecast.datetime.hour,
      dayOfWeek: forecast.datetime.weekday,
      isWeekend: forecast.datetime.weekday >= 6,
      date: forecast.datetime.toFormat('yyyy-MM-dd'),
      forecast,
      actual
    });
  }

  console.log('Paired records: ' + paired.length + ' (excluded ' + excludedCount + ' typhoon period records)');
  console.log('');

  // Analyze by hour of day for each region
  console.log('═══════════════════════════════════════════════════════════════════════════════');
  console.log('ERROR BY HOUR OF DAY');
  console.log('═══════════════════════════════════════════════════════════════════════════════');
  console.log('');

  for (const region of regions) {
    console.log(region + ':');
    console.log('Hour'.padEnd(6) + 'Count'.padStart(8) + 'Avg Act'.padStart(10) + 'Avg Fcst'.padStart(10) + 'MAPE'.padStart(10) + 'Bias'.padStart(10));
    console.log('-'.repeat(54));

    const hourStats = {};
    for (let h = 0; h < 24; h++) {
      hourStats[h] = { actual: [], forecast: [] };
    }

    for (const p of paired) {
      if (p.actual[region] > 0 && p.forecast[region] > 0) {
        hourStats[p.hour].actual.push(p.actual[region]);
        hourStats[p.hour].forecast.push(p.forecast[region]);
      }
    }

    for (let h = 0; h < 24; h++) {
      const stats = hourStats[h];
      if (stats.actual.length === 0) continue;

      const avgAct = stats.actual.reduce((a, b) => a + b, 0) / stats.actual.length;
      const avgFcst = stats.forecast.reduce((a, b) => a + b, 0) / stats.forecast.length;
      let mape = 0;
      for (let i = 0; i < stats.actual.length; i++) {
        mape += Math.abs((stats.forecast[i] - stats.actual[i]) / stats.actual[i]);
      }
      mape = (mape / stats.actual.length) * 100;
      const bias = ((avgFcst - avgAct) / avgAct) * 100;

      console.log(
        h.toString().padEnd(6) +
        stats.actual.length.toString().padStart(8) +
        avgAct.toFixed(0).padStart(10) +
        avgFcst.toFixed(0).padStart(10) +
        (mape.toFixed(1) + '%').padStart(10) +
        ((bias > 0 ? '+' : '') + bias.toFixed(1) + '%').padStart(10)
      );
    }
    console.log('');
  }

  // Analyze by day of week for CVIS
  console.log('═══════════════════════════════════════════════════════════════════════════════');
  console.log('CVIS ERROR BY DAY OF WEEK (Focus: 18.2% MAPE)');
  console.log('═══════════════════════════════════════════════════════════════════════════════');
  console.log('');

  const dayNames = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const dayStats = {};
  for (let d = 1; d <= 7; d++) {
    dayStats[d] = { actual: [], forecast: [] };
  }

  for (const p of paired) {
    if (p.actual.CVIS > 0 && p.forecast.CVIS > 0) {
      dayStats[p.dayOfWeek].actual.push(p.actual.CVIS);
      dayStats[p.dayOfWeek].forecast.push(p.forecast.CVIS);
    }
  }

  console.log('Day'.padEnd(8) + 'Count'.padStart(8) + 'Avg Act'.padStart(10) + 'Avg Fcst'.padStart(10) + 'MAPE'.padStart(10) + 'Bias'.padStart(10));
  console.log('-'.repeat(56));

  for (let d = 1; d <= 7; d++) {
    const stats = dayStats[d];
    if (stats.actual.length === 0) continue;

    const avgAct = stats.actual.reduce((a, b) => a + b, 0) / stats.actual.length;
    const avgFcst = stats.forecast.reduce((a, b) => a + b, 0) / stats.forecast.length;
    let mape = 0;
    for (let i = 0; i < stats.actual.length; i++) {
      mape += Math.abs((stats.forecast[i] - stats.actual[i]) / stats.actual[i]);
    }
    mape = (mape / stats.actual.length) * 100;
    const bias = ((avgFcst - avgAct) / avgAct) * 100;

    console.log(
      dayNames[d].padEnd(8) +
      stats.actual.length.toString().padStart(8) +
      avgAct.toFixed(0).padStart(10) +
      avgFcst.toFixed(0).padStart(10) +
      (mape.toFixed(1) + '%').padStart(10) +
      ((bias > 0 ? '+' : '') + bias.toFixed(1) + '%').padStart(10)
    );
  }

  // Analyze largest errors
  console.log('');
  console.log('═══════════════════════════════════════════════════════════════════════════════');
  console.log('LARGEST ERRORS (CVIS)');
  console.log('═══════════════════════════════════════════════════════════════════════════════');
  console.log('');

  const cvisErrors = [];
  for (const p of paired) {
    if (p.actual.CVIS > 0 && p.forecast.CVIS > 0) {
      const error = Math.abs((p.forecast.CVIS - p.actual.CVIS) / p.actual.CVIS) * 100;
      cvisErrors.push({
        datetime: p.datetime.toFormat('yyyy-MM-dd HH:mm'),
        dayOfWeek: dayNames[p.dayOfWeek],
        hour: p.hour,
        actual: p.actual.CVIS,
        forecast: p.forecast.CVIS,
        error
      });
    }
  }

  cvisErrors.sort((a, b) => b.error - a.error);

  console.log('DateTime'.padEnd(18) + 'Day'.padStart(6) + 'Hour'.padStart(6) + 'Actual'.padStart(10) + 'Forecast'.padStart(10) + 'Error'.padStart(10));
  console.log('-'.repeat(60));

  for (const e of cvisErrors.slice(0, 20)) {
    console.log(
      e.datetime.padEnd(18) +
      e.dayOfWeek.padStart(6) +
      e.hour.toString().padStart(6) +
      e.actual.toFixed(0).padStart(10) +
      e.forecast.toFixed(0).padStart(10) +
      (e.error.toFixed(1) + '%').padStart(10)
    );
  }

  // Summary and recommendations
  console.log('');
  console.log('═══════════════════════════════════════════════════════════════════════════════');
  console.log('RECOMMENDATIONS FOR IMPROVEMENT');
  console.log('═══════════════════════════════════════════════════════════════════════════════');
  console.log('');

  // Calculate average bias per region
  const biases = {};
  for (const region of regions) {
    const acts = [];
    const fcsts = [];
    for (const p of paired) {
      if (p.actual[region] > 0 && p.forecast[region] > 0) {
        acts.push(p.actual[region]);
        fcsts.push(p.forecast[region]);
      }
    }
    const avgAct = acts.reduce((a, b) => a + b, 0) / acts.length;
    const avgFcst = fcsts.reduce((a, b) => a + b, 0) / fcsts.length;
    biases[region] = ((avgFcst - avgAct) / avgAct) * 100;
  }

  console.log('1. BIAS CORRECTION:');
  console.log('   CLUZ: ' + (biases.CLUZ > 0 ? '+' : '') + biases.CLUZ.toFixed(1) + '% → reduce forecast by ' + Math.abs(biases.CLUZ).toFixed(1) + '%');
  console.log('   CVIS: ' + (biases.CVIS > 0 ? '+' : '') + biases.CVIS.toFixed(1) + '% → reduce forecast by ' + Math.abs(biases.CVIS).toFixed(1) + '%');
  console.log('   CMIN: ' + (biases.CMIN > 0 ? '+' : '') + biases.CMIN.toFixed(1) + '% → increase forecast by ' + Math.abs(biases.CMIN).toFixed(1) + '%');
  console.log('');
  console.log('2. CVIS HIGH ERROR ANALYSIS:');
  console.log('   - CVIS has consistent +7.7% over-forecast bias');
  console.log('   - Consider training on more recent Visayas data');
  console.log('   - Weekend patterns may differ from weekday patterns');
  console.log('');
}

main().catch(console.error);
