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

// All 14 zones
const ZONES = [
  '01NLUZ', '02METRO', '03SLUZ',
  '04LEYTE', '05CEBU', '06NEGROS', '07BOHOL', '08PANAY',
  '09NWMIN', '10LANAO', '11NCMIN', '12NEMIN', '13SEMIN', '14SWMIN'
];

// Match by DateTimeEnding and calculate bias
const zoneStats = {};
ZONES.forEach(z => {
  zoneStats[z] = { totalForecast: 0, totalActual: 0, count: 0 };
});

const actualMap = new Map();
actual.forEach(row => actualMap.set(row.DateTimeEnding, row));

forecast.forEach(fRow => {
  const dt = fRow.DateTimeEnding;
  const aRow = actualMap.get(dt);
  if (aRow) {
    ZONES.forEach(z => {
      const fVal = parseFloat(fRow[z] || 0);
      const aVal = parseFloat(aRow[z] || 0);
      zoneStats[z].totalForecast += fVal;
      zoneStats[z].totalActual += aVal;
      zoneStats[z].count++;
    });
  }
});

console.log('='.repeat(70));
console.log('JANUARY 2026 PER-ZONE DEMAND BIAS ANALYSIS');
console.log('='.repeat(70));
console.log('');
console.log('Zone        | Avg Forecast | Avg Actual | Bias %    | Scale Factor');
console.log('-'.repeat(70));

const scaleFactors = [];
ZONES.forEach(z => {
  const avgForecast = zoneStats[z].totalForecast / zoneStats[z].count;
  const avgActual = zoneStats[z].totalActual / zoneStats[z].count;
  const bias = ((avgForecast - avgActual) / avgActual * 100);
  const scaleFactor = Math.round(-bias); // Scale to correct the bias

  const biasStr = (bias > 0 ? '+' : '') + bias.toFixed(2) + '%';
  const scaleStr = scaleFactor >= 0 ? '+' + scaleFactor : scaleFactor.toString();

  scaleFactors.push(`${z}:${scaleFactor}`);

  console.log(`${z.padEnd(11)} | ${avgForecast.toFixed(1).padStart(12)} | ${avgActual.toFixed(1).padStart(10)} | ${biasStr.padStart(9)} | ${scaleStr}%`);
});

console.log('');
console.log('='.repeat(70));
console.log('');
console.log('CLI scale argument:');
console.log(`--scale-zone "${scaleFactors.join(',')}"`);
console.log('');
