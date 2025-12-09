/**
 * Capacity Factor Evaluation: Compare forecast vs actual
 */

import { readFileSync } from 'fs';
import { parse } from 'csv-parse/sync';

// Read forecast
const forecastData = readFileSync('./cfac_nov_dec_2025.csv', 'utf-8');
const forecast = parse(forecastData, { columns: true });

// Read actual
const actualData = readFileSync('C:\\Source_Codes\\iLoad_Forecasting_Utility\\Data Samples\\Capacity Factor\\MRHCFac.csv', 'utf-8');
const actual = parse(actualData, { columns: true });

console.log('='.repeat(80));
console.log('         CAPACITY FACTOR EVALUATION: Forecast vs Actual');
console.log('='.repeat(80));
console.log('');

// Get station columns (all except DateTimeEnding)
const stations = Object.keys(actual[0]).filter(k => k !== 'DateTimeEnding');

// Build lookup for actual data
const actualByDateTime = new Map();
for (const row of actual) {
  actualByDateTime.set(row.DateTimeEnding, row);
}

// Track metrics by station type
const stationTypes = {
  wind: [],
  solar: [],
  hydro: [],
  geothermal: [],
  biomass: [],
  battery: [],
  other: []
};

// Classify stations by type based on naming
function getStationType(station) {
  const name = station.toUpperCase();
  if (name.includes('_W') || name.includes('BURGOS') || name.includes('CURIMAO') ||
      name.includes('LAOAG') && !name.includes('_S') || name.includes('PAGUDPUD') ||
      name.includes('PASUQUIN') || name.includes('NABAS_W') || name.includes('STBARBRA_W')) {
    return 'wind';
  }
  if (name.includes('_S') || name.includes('SOLAR') || name.includes('CAYANGA') ||
      name.includes('CLARK') || name.includes('LIMAY') || name.includes('HELIOS') ||
      name.includes('CALASOL') || name.includes('CALUNG')) {
    return 'solar';
  }
  if (name.includes('_H') || name.includes('BAKUN') || name.includes('BOTOLAN') ||
      name.includes('BYOMBNG') || name.includes('HERMOSA') && !name.includes('_S') ||
      name.includes('LATRINI') || name.includes('PANTABA') || name.includes('SNTGO') && !name.includes('_S') && !name.includes('_B') ||
      name.includes('LUMBAN') && !name.includes('_B') || name.includes('NAGA') && !name.includes('_B') ||
      name.includes('CENTRAL') || name.includes('PARANAS') && !name.includes('_S') ||
      name.includes('AMLAN') && !name.includes('_S') && !name.includes('_B') ||
      name.includes('KABANKALAN') || name.includes('CORELLA') || name.includes('AGUS') ||
      name.includes('GNPK') || name.includes('JASAA') || name.includes('KIBAW') ||
      name.includes('MANOL') || name.includes('TAGOL_H') || name.includes('BUTUA') ||
      name.includes('NABUN') || name.includes('SIGHYDRO') || name.includes('SULTA')) {
    return 'hydro';
  }
  if (name.includes('_GP') || name.includes('BACMANGP') || name.includes('PALAYAN') ||
      name.includes('TIWI') || name.includes('TONGONA') || name.includes('PGPP')) {
    return 'geothermal';
  }
  if (name.includes('_BI') || name.includes('DUHAT') || name.includes('GAMU') && !name.includes('_S')) {
    return 'biomass';
  }
  if (name.includes('_B') || name.includes('BATTERY')) {
    return 'battery';
  }
  return 'other';
}

// Calculate metrics per station
const stationMetrics = [];
let matchedRows = 0;

for (const station of stations) {
  let sumAbsError = 0;
  let sumSquaredError = 0;
  let sumActual = 0;
  let sumForecast = 0;
  let count = 0;
  let sumAbsPercentError = 0;
  let percentCount = 0;

  for (const fRow of forecast) {
    const dt = fRow.DateTimeEnding;
    const aRow = actualByDateTime.get(dt);

    if (!aRow) continue;

    const fVal = parseFloat(fRow[station]);
    const aVal = parseFloat(aRow[station]);

    if (isNaN(fVal) || isNaN(aVal)) continue;

    matchedRows++;
    count++;
    sumActual += aVal;
    sumForecast += fVal;

    const error = fVal - aVal;
    sumAbsError += Math.abs(error);
    sumSquaredError += error * error;

    // MAPE (only for non-zero actuals)
    if (aVal > 0.01) {
      sumAbsPercentError += Math.abs(error / aVal) * 100;
      percentCount++;
    }
  }

  if (count === 0) continue;

  const mae = sumAbsError / count;
  const rmse = Math.sqrt(sumSquaredError / count);
  const mape = percentCount > 0 ? sumAbsPercentError / percentCount : null;
  const bias = (sumForecast - sumActual) / count;
  const avgActual = sumActual / count;
  const avgForecast = sumForecast / count;

  const stationType = getStationType(station);

  const metrics = {
    station,
    type: stationType,
    mae,
    rmse,
    mape,
    bias,
    avgActual,
    avgForecast,
    count
  };

  stationMetrics.push(metrics);
  stationTypes[stationType].push(metrics);
}

console.log(`Matched ${matchedRows} forecast-actual pairs across ${stationMetrics.length} stations`);
console.log('');

// Summary by station type
console.log('-'.repeat(80));
console.log('SUMMARY BY STATION TYPE');
console.log('-'.repeat(80));
console.log('');
console.log('Type         | Stations |  Avg MAE  |  Avg RMSE |  Avg MAPE |  Avg Bias');
console.log('-'.repeat(80));

for (const [type, metrics] of Object.entries(stationTypes)) {
  if (metrics.length === 0) continue;

  const avgMAE = metrics.reduce((s, m) => s + m.mae, 0) / metrics.length;
  const avgRMSE = metrics.reduce((s, m) => s + m.rmse, 0) / metrics.length;
  const validMAPE = metrics.filter(m => m.mape !== null);
  const avgMAPE = validMAPE.length > 0 ? validMAPE.reduce((s, m) => s + m.mape, 0) / validMAPE.length : null;
  const avgBias = metrics.reduce((s, m) => s + m.bias, 0) / metrics.length;

  const mapeStr = avgMAPE !== null ? avgMAPE.toFixed(1) + '%' : 'N/A';
  console.log(`${type.padEnd(12)} | ${metrics.length.toString().padStart(8)} | ${avgMAE.toFixed(4).padStart(9)} | ${avgRMSE.toFixed(4).padStart(9)} | ${mapeStr.padStart(9)} | ${(avgBias >= 0 ? '+' : '') + avgBias.toFixed(4)}`);
}

// Overall metrics
const allMAE = stationMetrics.reduce((s, m) => s + m.mae, 0) / stationMetrics.length;
const allRMSE = stationMetrics.reduce((s, m) => s + m.rmse, 0) / stationMetrics.length;
const validMAPE = stationMetrics.filter(m => m.mape !== null);
const allMAPE = validMAPE.length > 0 ? validMAPE.reduce((s, m) => s + m.mape, 0) / validMAPE.length : null;
const allBias = stationMetrics.reduce((s, m) => s + m.bias, 0) / stationMetrics.length;

console.log('-'.repeat(80));
const allMAPEStr = allMAPE !== null ? allMAPE.toFixed(1) + '%' : 'N/A';
console.log(`${'OVERALL'.padEnd(12)} | ${stationMetrics.length.toString().padStart(8)} | ${allMAE.toFixed(4).padStart(9)} | ${allRMSE.toFixed(4).padStart(9)} | ${allMAPEStr.padStart(9)} | ${(allBias >= 0 ? '+' : '') + allBias.toFixed(4)}`);
console.log('');

// Top 10 best performing stations
console.log('-'.repeat(80));
console.log('TOP 10 BEST PERFORMING STATIONS (by MAE)');
console.log('-'.repeat(80));
const sortedByMAE = [...stationMetrics].sort((a, b) => a.mae - b.mae);
console.log('Station                | Type       |    MAE   |   RMSE   |   MAPE   |   Bias');
console.log('-'.repeat(80));
for (const m of sortedByMAE.slice(0, 10)) {
  const mapeStr = m.mape !== null ? m.mape.toFixed(1) + '%' : 'N/A';
  console.log(`${m.station.padEnd(22)} | ${m.type.padEnd(10)} | ${m.mae.toFixed(4).padStart(8)} | ${m.rmse.toFixed(4).padStart(8)} | ${mapeStr.padStart(8)} | ${(m.bias >= 0 ? '+' : '') + m.bias.toFixed(4)}`);
}
console.log('');

// Top 10 worst performing stations
console.log('-'.repeat(80));
console.log('TOP 10 WORST PERFORMING STATIONS (by MAE)');
console.log('-'.repeat(80));
console.log('Station                | Type       |    MAE   |   RMSE   |   MAPE   |   Bias');
console.log('-'.repeat(80));
for (const m of sortedByMAE.slice(-10).reverse()) {
  const mapeStr = m.mape !== null ? m.mape.toFixed(1) + '%' : 'N/A';
  console.log(`${m.station.padEnd(22)} | ${m.type.padEnd(10)} | ${m.mae.toFixed(4).padStart(8)} | ${m.rmse.toFixed(4).padStart(8)} | ${mapeStr.padStart(8)} | ${(m.bias >= 0 ? '+' : '') + m.bias.toFixed(4)}`);
}
console.log('');

// Solar stations detail (since they're the most common)
console.log('-'.repeat(80));
console.log('SOLAR STATIONS DETAIL');
console.log('-'.repeat(80));
const solarStations = stationMetrics.filter(m => m.type === 'solar').sort((a, b) => a.mae - b.mae);
console.log('Station                |    MAE   |   RMSE   |   MAPE   | Avg Actual | Avg Fcst |   Bias');
console.log('-'.repeat(80));
for (const m of solarStations) {
  const mapeStr = m.mape !== null ? m.mape.toFixed(1) + '%' : 'N/A';
  console.log(`${m.station.padEnd(22)} | ${m.mae.toFixed(4).padStart(8)} | ${m.rmse.toFixed(4).padStart(8)} | ${mapeStr.padStart(8)} | ${m.avgActual.toFixed(4).padStart(10)} | ${m.avgForecast.toFixed(4).padStart(8)} | ${(m.bias >= 0 ? '+' : '') + m.bias.toFixed(4)}`);
}
console.log('');

// Recommendations
console.log('='.repeat(80));
console.log('EVALUATION SUMMARY');
console.log('='.repeat(80));
console.log('');
console.log(`Overall MAE: ${allMAE.toFixed(4)} (capacity factor units, 0-1 scale)`);
console.log(`Overall RMSE: ${allRMSE.toFixed(4)}`);
console.log(`Overall MAPE: ${allMAPEStr}`);
console.log(`Overall Bias: ${(allBias >= 0 ? '+' : '') + allBias.toFixed(4)} (${allBias > 0 ? 'over-forecasting' : 'under-forecasting'})`);
console.log('');

// Interpretation
if (allMAE < 0.1) {
  console.log('INTERPRETATION: Model performance is GOOD (MAE < 0.10)');
} else if (allMAE < 0.2) {
  console.log('INTERPRETATION: Model performance is MODERATE (MAE 0.10-0.20)');
} else {
  console.log('INTERPRETATION: Model performance NEEDS IMPROVEMENT (MAE > 0.20)');
}
console.log('');
