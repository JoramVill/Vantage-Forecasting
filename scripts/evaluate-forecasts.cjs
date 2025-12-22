/**
 * Evaluate Demand and Capacity Factor Forecasts Against Actuals
 *
 * Compares forecast outputs against actual data to measure accuracy.
 */

const { readFileSync, existsSync } = require('fs');
const { join } = require('path');
const { DateTime } = require('luxon');
const Database = require('better-sqlite3');

// MAPE calculation
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

// RMSE calculation
function calculateRMSE(actual, predicted) {
  let sum = 0;
  for (let i = 0; i < actual.length; i++) {
    sum += (predicted[i] - actual[i]) ** 2;
  }
  return Math.sqrt(sum / actual.length);
}

// Parse date from forecast CSV
function parseDateTime(str) {
  // Try ISO format first
  let dt = DateTime.fromISO(str);
  if (dt.isValid) return dt;

  // Try M/D/YYYY HH:mm
  dt = DateTime.fromFormat(str, 'M/d/yyyy HH:mm');
  if (dt.isValid) return dt;

  // Try MM/DD/YYYY HH:mm
  dt = DateTime.fromFormat(str, 'MM/dd/yyyy HH:mm');
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
      CLUZ: parseFloat(values[cluzIdx]) || 0,
      CVIS: parseFloat(values[cvisIdx]) || 0,
      CMIN: parseFloat(values[cminIdx]) || 0
    });
  }

  return forecasts;
}

// Anomalous dates to exclude (typhoon period with data quality issues)
const EXCLUDE_DATES = [
  '2025-11-01', '2025-11-02', '2025-11-03', '2025-11-04', '2025-11-05',
  '2025-11-06', '2025-11-07', '2025-11-08', '2025-11-09', '2025-11-10'
];

// Load actual demand from database
function loadActualDemand(startDate, endDate) {
  const dbPath = join(process.cwd(), 'data', 'iload.db');
  if (!existsSync(dbPath)) {
    console.log('Database not found at ' + dbPath);
    return new Map();
  }

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
      actuals.set(key, { CLUZ: 0, CVIS: 0, CMIN: 0 });
    }
    actuals.get(key)[row.region] = row.demand;
  }

  return actuals;
}

// Load capacity factor forecast
function loadCFacForecast(path) {
  const content = readFileSync(path, 'utf-8');
  const lines = content.split('\n').filter(l => l.trim());
  if (lines.length < 2) return { headers: [], data: new Map() };

  const headers = lines[0].split(',').map(h => h.trim());
  const dtIdx = headers.findIndex(h => h.toLowerCase().includes('datetime'));
  const stations = headers.slice(1);

  const forecasts = new Map();

  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(',').map(v => v.trim());
    const dt = parseDateTime(values[dtIdx]);
    if (!dt) continue;

    const key = dt.toFormat('yyyy-MM-dd HH:mm');
    const row = {};
    for (let j = 1; j < headers.length; j++) {
      row[headers[j]] = parseFloat(values[j]) || 0;
    }
    forecasts.set(key, row);
  }

  return { stations, data: forecasts };
}

// Load actual capacity factors
function loadActualCFac(path) {
  const content = readFileSync(path, 'utf-8');
  const lines = content.split('\n').filter(l => l.trim());
  if (lines.length < 2) return { headers: [], data: new Map() };

  const headers = lines[0].split(',').map(h => h.trim());
  const stations = headers.slice(1);

  const actuals = new Map();

  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(',').map(v => v.trim());
    const dt = DateTime.fromFormat(values[0], 'M/d/yyyy HH:mm');
    if (!dt.isValid) continue;

    const key = dt.toFormat('yyyy-MM-dd HH:mm');
    const row = {};
    for (let j = 1; j < headers.length; j++) {
      row[headers[j]] = parseFloat(values[j]) || 0;
    }
    actuals.set(key, row);
  }

  return { stations, data: actuals };
}

// Main evaluation
async function main() {
  console.log('');
  console.log('='.repeat(90));
  console.log('FORECAST EVALUATION - NOV-DEC 2025 (Excluding Typhoon Period Nov 1-10)');
  console.log('='.repeat(90));
  console.log('');

  // Evaluate Demand Forecast
  console.log('═══════════════════════════════════════════════════════════════════════════════');
  console.log('1. DEMAND FORECAST EVALUATION');
  console.log('═══════════════════════════════════════════════════════════════════════════════');
  console.log('');

  const demandForecastPath = join(process.cwd(), 'output', 'demand_forecast_nov_dec_2025.csv');
  if (existsSync(demandForecastPath)) {
    const forecasts = loadDemandForecast(demandForecastPath);
    console.log('Loaded ' + forecasts.size + ' forecast records');

    // Load actuals from database
    const actuals = loadActualDemand('2025-11-01', '2025-12-12');
    console.log('Loaded ' + actuals.size + ' actual records from database');

    if (actuals.size > 0 && forecasts.size > 0) {
      // Match forecasts to actuals
      const regions = ['CLUZ', 'CVIS', 'CMIN'];
      const results = {};

      for (const region of regions) {
        const actualVals = [];
        const predictedVals = [];

        for (const [key, forecast] of forecasts) {
          // Skip anomalous typhoon dates
          const dateStr = key.substring(0, 10);
          if (EXCLUDE_DATES.includes(dateStr)) continue;

          const actual = actuals.get(key);
          if (actual && actual[region] > 0 && forecast[region] > 0) {
            actualVals.push(actual[region]);
            predictedVals.push(forecast[region]);
          }
        }

        if (actualVals.length > 0) {
          const mape = calculateMAPE(actualVals, predictedVals);
          const rmse = calculateRMSE(actualVals, predictedVals);
          const avgActual = actualVals.reduce((a, b) => a + b, 0) / actualVals.length;
          const avgForecast = predictedVals.reduce((a, b) => a + b, 0) / predictedVals.length;
          const bias = ((avgForecast - avgActual) / avgActual) * 100;

          results[region] = {
            count: actualVals.length,
            mape,
            rmse,
            avgActual,
            avgForecast,
            bias
          };
        }
      }

      console.log('');
      console.log('Region'.padEnd(10) + 'Records'.padStart(10) + 'MAPE'.padStart(10) + 'RMSE'.padStart(12) + 'Avg Act'.padStart(12) + 'Avg Fcst'.padStart(12) + 'Bias'.padStart(10));
      console.log('-'.repeat(76));

      for (const region of regions) {
        if (results[region]) {
          const r = results[region];
          console.log(
            region.padEnd(10) +
            r.count.toString().padStart(10) +
            (r.mape.toFixed(1) + '%').padStart(10) +
            r.rmse.toFixed(0).padStart(12) +
            r.avgActual.toFixed(0).padStart(12) +
            r.avgForecast.toFixed(0).padStart(12) +
            (r.bias > 0 ? '+' : '') + r.bias.toFixed(1) + '%'.padStart(10)
          );
        }
      }
    }
  } else {
    console.log('Demand forecast not found at ' + demandForecastPath);
  }

  // Evaluate Capacity Factor Forecast
  console.log('');
  console.log('═══════════════════════════════════════════════════════════════════════════════');
  console.log('2. CAPACITY FACTOR FORECAST EVALUATION');
  console.log('═══════════════════════════════════════════════════════════════════════════════');
  console.log('');

  const cfacForecastPath = join(process.cwd(), 'output', 'cfac_forecast_nov_dec_2025.csv');
  const cfacActualPath = join(process.cwd(), 'Data Samples', 'Capacity Factor', 'MRHCFac.csv');

  if (existsSync(cfacForecastPath) && existsSync(cfacActualPath)) {
    const { stations: fStations, data: forecasts } = loadCFacForecast(cfacForecastPath);
    const { stations: aStations, data: actuals } = loadActualCFac(cfacActualPath);

    console.log('Forecast: ' + forecasts.size + ' records for ' + fStations.length + ' stations');
    console.log('Actuals: ' + actuals.size + ' records for ' + aStations.length + ' stations');

    // Match and evaluate by station type
    const stationTypes = {
      wind: ['01BURGOS', '01CURIMAO', '01LAOAG', '01PAGUDPUD', '01PASUQUIN', '08NABAS_W', '08STBARBRA_W'],
      solar: fStations.filter(s => s.includes('_S') || ['01CLARK', '01HERMOSA', '06HELIOS', '02DOLORES', '05CALUNG', '01LIMAY'].some(ss => s.startsWith(ss))),
      hydro: fStations.filter(s => s.includes('_H') || ['01BAKUN', '01BOTOLAN', '01LATRINI', '01PANTABA', '03LUMBAN'].some(ss => s.startsWith(ss))),
    };

    console.log('');
    console.log('Station Type Results:');
    console.log('');

    for (const [type, typeStations] of Object.entries(stationTypes)) {
      const allActuals = [];
      const allPredicted = [];
      let stationCount = 0;

      for (const station of typeStations) {
        const stationActuals = [];
        const stationPredicted = [];

        for (const [key, forecast] of forecasts) {
          const actual = actuals.get(key);
          if (actual && actual[station] !== undefined && forecast[station] !== undefined) {
            const av = actual[station];
            const pv = forecast[station];
            if (av > 0.01) {  // Only count when actual > 0
              stationActuals.push(av);
              stationPredicted.push(pv);
              allActuals.push(av);
              allPredicted.push(pv);
            }
          }
        }

        if (stationActuals.length > 0) {
          stationCount++;
        }
      }

      if (allActuals.length > 0) {
        const mape = calculateMAPE(allActuals, allPredicted);
        const rmse = calculateRMSE(allActuals, allPredicted);
        console.log(`  ${type.toUpperCase()}: ${stationCount} stations, ${allActuals.length} samples, MAPE=${mape.toFixed(1)}%, RMSE=${rmse.toFixed(3)}`);
      }
    }

    // Top performing and worst performing stations
    console.log('');
    console.log('Sample Station Performance (daylight hours, CF > 0.01):');
    console.log('');

    const stationMAPEs = [];
    for (const station of fStations.slice(0, 50)) {  // Check first 50
      const stationActuals = [];
      const stationPredicted = [];

      for (const [key, forecast] of forecasts) {
        const actual = actuals.get(key);
        if (actual && actual[station] !== undefined && forecast[station] !== undefined) {
          const av = actual[station];
          const pv = forecast[station];
          if (av > 0.01) {
            stationActuals.push(av);
            stationPredicted.push(pv);
          }
        }
      }

      if (stationActuals.length >= 10) {
        const mape = calculateMAPE(stationActuals, stationPredicted);
        stationMAPEs.push({ station, mape, count: stationActuals.length });
      }
    }

    stationMAPEs.sort((a, b) => a.mape - b.mape);

    console.log('Best Performing:');
    for (const s of stationMAPEs.slice(0, 5)) {
      console.log(`  ${s.station.padEnd(20)} MAPE=${s.mape.toFixed(1)}% (${s.count} samples)`);
    }

    console.log('');
    console.log('Worst Performing:');
    for (const s of stationMAPEs.slice(-5).reverse()) {
      console.log(`  ${s.station.padEnd(20)} MAPE=${s.mape.toFixed(1)}% (${s.count} samples)`);
    }
  } else {
    console.log('Missing forecast or actual capacity factor files');
  }

  console.log('');
  console.log('='.repeat(90));
  console.log('EVALUATION COMPLETE');
  console.log('='.repeat(90));
  console.log('');
}

main().catch(console.error);
