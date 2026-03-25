const fs = require('fs');

// Load forecast and actual data
const forecastCSV = fs.readFileSync('output/backtest_zonal_jan2026.csv', 'utf-8');
const actualCSV = fs.readFileSync('Data Samples/Demand/DemandHr_1-month Historical_JAN.csv', 'utf-8');

// Parse CSV
const parseCsv = (csv) => {
  const lines = csv.trim().split('\n');
  const headers = lines[0].split(',');
  return lines.slice(1).map(line => {
    const values = line.split(',');
    const row = {};
    headers.forEach((h, i) => row[h] = values[i]);
    return row;
  });
};

const forecast = parseCsv(forecastCSV);
const actual = parseCsv(actualCSV);

// Zone groupings
const CLUZ = ['01NLUZ', '02METRO', '03SLUZ'];
const CVIS = ['04LEYTE', '05CEBU', '06NEGROS', '07BOHOL', '08PANAY'];
const CMIN = ['09NWMIN', '10LANAO', '11NCMIN', '12NEMIN', '13SEMIN', '14SWMIN'];

// Aggregate to regional
const aggregateRegional = (row) => ({
  CLUZ: CLUZ.reduce((s, z) => s + parseFloat(row[z] || 0), 0),
  CVIS: CVIS.reduce((s, z) => s + parseFloat(row[z] || 0), 0),
  CMIN: CMIN.reduce((s, z) => s + parseFloat(row[z] || 0), 0)
});

// Match by DateTimeEnding and calculate bias
let totalForecast = { CLUZ: 0, CVIS: 0, CMIN: 0 };
let totalActual = { CLUZ: 0, CVIS: 0, CMIN: 0 };
let absoluteErrors = { CLUZ: 0, CVIS: 0, CMIN: 0 };
let matchCount = 0;

const actualMap = new Map();
actual.forEach(row => actualMap.set(row.DateTimeEnding, row));

forecast.forEach(fRow => {
  const dt = fRow.DateTimeEnding;
  const aRow = actualMap.get(dt);
  if (aRow) {
    const fReg = aggregateRegional(fRow);
    const aReg = aggregateRegional(aRow);

    ['CLUZ', 'CVIS', 'CMIN'].forEach(r => {
      totalForecast[r] += fReg[r];
      totalActual[r] += aReg[r];
      absoluteErrors[r] += Math.abs(fReg[r] - aReg[r]);
    });
    matchCount++;
  }
});

console.log('='.repeat(60));
console.log('JANUARY 2026 REGIONAL DEMAND VALIDATION');
console.log('='.repeat(60));
console.log('Matched hours:', matchCount);
console.log('');
console.log('REGIONAL BIAS (Forecast vs Actual):');
console.log('-'.repeat(60));

['CLUZ', 'CVIS', 'CMIN'].forEach(r => {
  const bias = ((totalForecast[r] - totalActual[r]) / totalActual[r] * 100).toFixed(2);
  const mape = (absoluteErrors[r] / totalActual[r] * 100).toFixed(2);
  const avgForecast = (totalForecast[r] / matchCount).toFixed(1);
  const avgActual = (totalActual[r] / matchCount).toFixed(1);
  const biasSign = parseFloat(bias) > 0 ? '+' : '';
  console.log(`${r}:`);
  console.log(`  Avg Forecast: ${avgForecast} MW`);
  console.log(`  Avg Actual:   ${avgActual} MW`);
  console.log(`  Bias:         ${biasSign}${bias}% (${parseFloat(bias) > 0 ? 'OVER' : 'UNDER'}-FORECAST)`);
  console.log(`  MAPE:         ${mape}%`);
  console.log('');
});

// Total system
const totalForecastAll = totalForecast.CLUZ + totalForecast.CVIS + totalForecast.CMIN;
const totalActualAll = totalActual.CLUZ + totalActual.CVIS + totalActual.CMIN;
const totalBias = ((totalForecastAll - totalActualAll) / totalActualAll * 100).toFixed(2);
const biasSign = parseFloat(totalBias) > 0 ? '+' : '';
console.log('TOTAL SYSTEM:');
console.log(`  Total Forecast: ${(totalForecastAll / matchCount).toFixed(1)} MW avg`);
console.log(`  Total Actual:   ${(totalActualAll / matchCount).toFixed(1)} MW avg`);
console.log(`  System Bias:    ${biasSign}${totalBias}%`);
console.log('');
console.log('='.repeat(60));
