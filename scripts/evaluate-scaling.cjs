const fs = require('fs');

// Scale factors based on January 2026 bias analysis
const SCALE_FACTORS = {
  '01NLUZ': -10,
  '02METRO': -22,
  '03SLUZ': -16,
  '04LEYTE': -28,
  '05CEBU': -8,
  '06NEGROS': 9,
  '07BOHOL': -1,
  '08PANAY': -10,
  '09NWMIN': -1,
  '10LANAO': -6,
  '11NCMIN': -11,
  '12NEMIN': -6,
  '13SEMIN': 1,
  '14SWMIN': 5
};

// Zone groupings
const CLUZ = ['01NLUZ', '02METRO', '03SLUZ'];
const CVIS = ['04LEYTE', '05CEBU', '06NEGROS', '07BOHOL', '08PANAY'];
const CMIN = ['09NWMIN', '10LANAO', '11NCMIN', '12NEMIN', '13SEMIN', '14SWMIN'];
const ZONES = [...CLUZ, ...CVIS, ...CMIN];

// Load data
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

// Match by DateTimeEnding
const actualMap = new Map();
actual.forEach(row => actualMap.set(row.DateTimeEnding, row));

// Calculate metrics for BEFORE and AFTER scaling
const calcMetrics = (useScaling) => {
  let totalForecast = { CLUZ: 0, CVIS: 0, CMIN: 0 };
  let totalActual = { CLUZ: 0, CVIS: 0, CMIN: 0 };
  let absErrors = { CLUZ: 0, CVIS: 0, CMIN: 0 };
  let count = 0;

  forecast.forEach(fRow => {
    const aRow = actualMap.get(fRow.DateTimeEnding);
    if (aRow) {
      // Get regional totals
      let fCluz = 0, fCvis = 0, fCmin = 0;
      let aCluz = 0, aCvis = 0, aCmin = 0;

      CLUZ.forEach(z => {
        let fVal = parseFloat(fRow[z] || 0);
        if (useScaling) fVal *= (1 + SCALE_FACTORS[z] / 100);
        fCluz += fVal;
        aCluz += parseFloat(aRow[z] || 0);
      });

      CVIS.forEach(z => {
        let fVal = parseFloat(fRow[z] || 0);
        if (useScaling) fVal *= (1 + SCALE_FACTORS[z] / 100);
        fCvis += fVal;
        aCvis += parseFloat(aRow[z] || 0);
      });

      CMIN.forEach(z => {
        let fVal = parseFloat(fRow[z] || 0);
        if (useScaling) fVal *= (1 + SCALE_FACTORS[z] / 100);
        fCmin += fVal;
        aCmin += parseFloat(aRow[z] || 0);
      });

      totalForecast.CLUZ += fCluz;
      totalForecast.CVIS += fCvis;
      totalForecast.CMIN += fCmin;
      totalActual.CLUZ += aCluz;
      totalActual.CVIS += aCvis;
      totalActual.CMIN += aCmin;

      absErrors.CLUZ += Math.abs(fCluz - aCluz);
      absErrors.CVIS += Math.abs(fCvis - aCvis);
      absErrors.CMIN += Math.abs(fCmin - aCmin);

      count++;
    }
  });

  return { totalForecast, totalActual, absErrors, count };
};

const before = calcMetrics(false);
const after = calcMetrics(true);

console.log('='.repeat(70));
console.log('JANUARY 2026 REGIONAL FORECAST EVALUATION');
console.log('Comparing BEFORE vs AFTER per-zone scaling');
console.log('='.repeat(70));
console.log('');

['CLUZ', 'CVIS', 'CMIN'].forEach(r => {
  const biasBefore = ((before.totalForecast[r] - before.totalActual[r]) / before.totalActual[r] * 100).toFixed(2);
  const biasAfter = ((after.totalForecast[r] - after.totalActual[r]) / after.totalActual[r] * 100).toFixed(2);
  const mapeBefore = (before.absErrors[r] / before.totalActual[r] * 100).toFixed(2);
  const mapeAfter = (after.absErrors[r] / after.totalActual[r] * 100).toFixed(2);

  const biasImprovement = Math.abs(parseFloat(biasBefore)) - Math.abs(parseFloat(biasAfter));
  const mapeImprovement = parseFloat(mapeBefore) - parseFloat(mapeAfter);

  console.log(`${r}:`);
  console.log(`  BEFORE: Bias ${biasBefore > 0 ? '+' : ''}${biasBefore}%, MAPE ${mapeBefore}%`);
  console.log(`  AFTER:  Bias ${biasAfter > 0 ? '+' : ''}${biasAfter}%, MAPE ${mapeAfter}%`);
  console.log(`  Improvement: Bias ${biasImprovement > 0 ? '↓' : '↑'}${Math.abs(biasImprovement).toFixed(2)}pp, MAPE ${mapeImprovement > 0 ? '↓' : '↑'}${Math.abs(mapeImprovement).toFixed(2)}pp`);
  console.log('');
});

// Total system
const totalBefore = before.totalForecast.CLUZ + before.totalForecast.CVIS + before.totalForecast.CMIN;
const totalAfter = after.totalForecast.CLUZ + after.totalForecast.CVIS + after.totalForecast.CMIN;
const totalActual = before.totalActual.CLUZ + before.totalActual.CVIS + before.totalActual.CMIN;
const totalAbsBefore = before.absErrors.CLUZ + before.absErrors.CVIS + before.absErrors.CMIN;
const totalAbsAfter = after.absErrors.CLUZ + after.absErrors.CVIS + after.absErrors.CMIN;

const sysBiasBefore = ((totalBefore - totalActual) / totalActual * 100).toFixed(2);
const sysBiasAfter = ((totalAfter - totalActual) / totalActual * 100).toFixed(2);
const sysMapeBefore = (totalAbsBefore / totalActual * 100).toFixed(2);
const sysMapeAfter = (totalAbsAfter / totalActual * 100).toFixed(2);

console.log('TOTAL SYSTEM:');
console.log(`  BEFORE: Bias ${sysBiasBefore > 0 ? '+' : ''}${sysBiasBefore}%, MAPE ${sysMapeBefore}%`);
console.log(`  AFTER:  Bias ${sysBiasAfter > 0 ? '+' : ''}${sysBiasAfter}%, MAPE ${sysMapeAfter}%`);

const biasImprove = Math.abs(parseFloat(sysBiasBefore)) - Math.abs(parseFloat(sysBiasAfter));
const mapeImprove = parseFloat(sysMapeBefore) - parseFloat(sysMapeAfter);
console.log(`  Improvement: Bias ${biasImprove > 0 ? '↓' : '↑'}${Math.abs(biasImprove).toFixed(2)}pp, MAPE ${mapeImprove > 0 ? '↓' : '↑'}${Math.abs(mapeImprove).toFixed(2)}pp`);

console.log('');
console.log('='.repeat(70));
