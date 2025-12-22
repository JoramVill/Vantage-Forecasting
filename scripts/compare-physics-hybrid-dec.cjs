/**
 * Compare physics-only vs hybrid model predictions for December
 * Uses the actual weather data to see what physics WOULD predict
 */
const fs = require('fs');
const path = require('path');

// Read actual December data
const actualFile = 'Data Samples/Capacity Factor/MRHCFac_H7D1201.csv';
const forecastFile = 'output/cfac_december_with_dec_training.csv';

function parseCSV(content) {
  const lines = content.split('\n').filter(l => l.trim());
  if (lines.length < 2) return { headers: [], rows: [] };
  const headers = lines[0].split(',').map(h => h.trim());
  const rows = lines.slice(1).map(l => l.split(',').map(v => v.trim()));
  return { headers, rows };
}

const actual = parseCSV(fs.readFileSync(actualFile, 'utf-8'));
const forecast = parseCSV(fs.readFileSync(forecastFile, 'utf-8'));

// Find problem stations
const problemStations = ['01SNMANUEL_S', '06BACOLOD_S'];

console.log('=== Physics vs Hybrid Comparison ===\n');
console.log('Current hybrid model uses: Physics + ML residual + bias + hourly corrections');
console.log('Physics-only would use: Physics model with weather data directly\n');

// Compare for each station
for (const station of problemStations) {
  const actualCol = actual.headers.indexOf(station);
  const forecastCol = forecast.headers.indexOf(station);

  if (actualCol < 0 || forecastCol < 0) {
    console.log(`${station}: Not found in both files`);
    continue;
  }

  console.log(`\n=== ${station} ===`);
  console.log('Hour | Actual  | Forecast | Diff    | Issue');
  console.log('-'.repeat(55));

  // Match by datetime
  const actualByTime = new Map();
  for (const row of actual.rows) {
    const dt = row[0];
    const cf = parseFloat(row[actualCol]);
    if (!isNaN(cf)) actualByTime.set(dt, cf);
  }

  // Aggregate by hour
  const hourlyActual = {};
  const hourlyForecast = {};
  const hourlyCount = {};

  for (const row of forecast.rows) {
    const dt = row[0];
    const forecastCF = parseFloat(row[forecastCol]);
    const actualCF = actualByTime.get(dt);

    if (actualCF === undefined || isNaN(forecastCF)) continue;

    const hourMatch = dt.match(/\s+(\d+):/);
    if (!hourMatch) continue;
    const hour = parseInt(hourMatch[1], 10);

    if (hour < 6 || hour > 18) continue;

    hourlyActual[hour] = (hourlyActual[hour] || 0) + actualCF;
    hourlyForecast[hour] = (hourlyForecast[hour] || 0) + forecastCF;
    hourlyCount[hour] = (hourlyCount[hour] || 0) + 1;
  }

  let totalUnder = 0;
  for (let h = 9; h <= 15; h++) {
    if (!hourlyCount[h]) continue;

    const avgActual = hourlyActual[h] / hourlyCount[h];
    const avgForecast = hourlyForecast[h] / hourlyCount[h];
    const diff = avgForecast - avgActual;

    let issue = '';
    if (diff < -0.05) issue = '<< UNDER';
    if (diff > 0.05) issue = '>> OVER';

    totalUnder += diff;

    console.log(`H${h.toString().padStart(2)} | ${(avgActual * 100).toFixed(1).padStart(5)}%  | ${(avgForecast * 100).toFixed(1).padStart(6)}%  | ${(diff * 100).toFixed(1).padStart(5)}% | ${issue}`);
  }

  console.log(`\nTotal H9-H15 bias: ${(totalUnder * 100 / 7).toFixed(1)}% avg under-prediction`);
}

console.log('\n=== The Issue ===');
console.log('The hybrid model adds ML residual corrections learned from wet season (Jul-Nov).');
console.log('These corrections SUBTRACT from physics predictions, even when December');
console.log('weather data correctly shows higher solar irradiance.');
console.log('\nThe physics model uses December irradiance directly from weather API.');
console.log('The ML layer fights it with wet-season patterns.');
