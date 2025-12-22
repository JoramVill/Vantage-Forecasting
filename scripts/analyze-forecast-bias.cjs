const fs = require('fs');
const { parse } = require('csv-parse/sync');

// Determine which forecast file to analyze (from command line argument)
const forecastFile = process.argv[2] || 'output/cfac_nov_dec_asymmetric.csv';

// Read forecast
const forecastRaw = fs.readFileSync(forecastFile, 'utf8');
const forecastRows = parse(forecastRaw, { columns: true });

// Read actual November data
const actualRaw = fs.readFileSync('Data Samples/Capacity Factor/MRHCFac_HIST_NOV.csv', 'utf8');
const actualRows = parse(actualRaw, { columns: true });

// Filter for Nov 17-30 (overlap period)
const startDate = new Date('2025-11-17T00:00:00');
const endDate = new Date('2025-11-30T23:59:59');

// Get all station columns (skip DateTimeEnding)
const forecastCols = Object.keys(forecastRows[0]).filter(c => c !== 'DateTimeEnding');
const actualCols = Object.keys(actualRows[0]).filter(c => c !== 'DateTimeEnding');
const commonStations = forecastCols.filter(c => actualCols.includes(c));

// Build actual lookup
const actualLookup = {};
for (const row of actualRows) {
  const dt = row['DateTimeEnding'];
  if (!dt) continue;
  const parts = dt.match(/(\d+)\/(\d+)\/(\d+)\s+(\d+):(\d+)/);
  if (!parts) continue;
  const [_, month, day, year, hour, min] = parts;
  const date = new Date(year, month-1, day, hour, min);
  if (date >= startDate && date <= endDate) {
    const key = date.toISOString();
    actualLookup[key] = row;
  }
}

// Separate wind and solar stations
const windStations = ['01BURGOS','01LAOAG','01PAGUDPUD','02DOLORES','08NABAS_W','08BVISTA'];
const solarStations = commonStations.filter(s => s.endsWith('_S') && !windStations.includes(s));

console.log('============================================================');
console.log('        FORECAST BIAS ANALYSIS: Nov 17-30, 2025');
console.log(`        Forecast file: ${forecastFile}`);
console.log('============================================================\n');

function analyzeBias(stations, label) {
  let totalBias = 0;
  let totalAbsBias = 0;
  let totalPairs = 0;
  let underCount = 0;
  let overCount = 0;
  const stationBiases = [];

  for (const station of stations) {
    let stationBias = 0;
    let stationPairs = 0;
    let stationUnder = 0;
    let stationOver = 0;

    for (const row of forecastRows) {
      const dt = row['DateTimeEnding'];
      if (!dt) continue;

      // Parse forecast date
      let date;
      const usDateParts = dt.match(/(\d+)\/(\d+)\/(\d+)\s+(\d+):(\d+)/);
      if (usDateParts) {
        const [_, month, day, year, hour, min] = usDateParts;
        date = new Date(year, month-1, day, hour, min);
      } else {
        date = new Date(dt.replace(' ', 'T') + ':00');
      }

      if (date < startDate || date > endDate) continue;

      const key = date.toISOString();
      const actual = actualLookup[key];
      if (!actual) continue;

      const pred = parseFloat(row[station]);
      const act = parseFloat(actual[station]);

      if (!isNaN(pred) && !isNaN(act) && act > 0.01) {
        const bias = pred - act;  // Positive = over-forecast, Negative = under-forecast
        stationBias += bias;
        stationPairs++;
        if (bias < 0) stationUnder++;
        else stationOver++;
      }
    }

    if (stationPairs > 0) {
      const avgBias = stationBias / stationPairs;
      stationBiases.push({
        station,
        avgBias,
        pairs: stationPairs,
        underPct: (stationUnder / stationPairs * 100).toFixed(1),
        overPct: (stationOver / stationPairs * 100).toFixed(1)
      });
      totalBias += stationBias;
      totalPairs += stationPairs;
      underCount += stationUnder;
      overCount += stationOver;
    }
  }

  // Sort by bias (most under-forecast first)
  stationBiases.sort((a, b) => a.avgBias - b.avgBias);

  console.log(`\n--- ${label} STATIONS ---`);
  console.log(`Total data points: ${totalPairs}`);
  console.log(`Average bias: ${(totalBias / totalPairs).toFixed(4)} (${totalBias / totalPairs > 0 ? 'OVER' : 'UNDER'}-forecasting)`);
  console.log(`Under-forecast hours: ${underCount} (${(underCount/totalPairs*100).toFixed(1)}%)`);
  console.log(`Over-forecast hours: ${overCount} (${(overCount/totalPairs*100).toFixed(1)}%)`);

  console.log(`\nPer-station bias (sorted by bias):`);
  console.log(`${'Station'.padEnd(15)} | ${'Avg Bias'.padStart(10)} | ${'Under%'.padStart(7)} | ${'Over%'.padStart(7)} | Direction`);
  console.log('-'.repeat(65));

  for (const sb of stationBiases) {
    const direction = sb.avgBias < -0.01 ? 'UNDER' : (sb.avgBias > 0.01 ? 'OVER' : 'OK');
    console.log(`${sb.station.padEnd(15)} | ${sb.avgBias.toFixed(4).padStart(10)} | ${sb.underPct.padStart(6)}% | ${sb.overPct.padStart(6)}% | ${direction}`);
  }

  return { totalBias: totalBias / totalPairs, underPct: underCount/totalPairs*100, overPct: overCount/totalPairs*100 };
}

const solarResults = analyzeBias(solarStations, 'SOLAR');
const windResults = analyzeBias(windStations, 'WIND');

console.log('\n============================================================');
console.log('                        SUMMARY');
console.log('============================================================');
console.log(`\nSOLAR: Avg bias ${solarResults.totalBias.toFixed(4)} | ${solarResults.underPct.toFixed(1)}% under, ${solarResults.overPct.toFixed(1)}% over`);
console.log(`WIND:  Avg bias ${windResults.totalBias.toFixed(4)} | ${windResults.underPct.toFixed(1)}% under, ${windResults.overPct.toFixed(1)}% over`);

if (solarResults.totalBias < -0.02) {
  console.log('\n>> SOLAR is still UNDER-forecasting');
} else if (solarResults.totalBias > 0.02) {
  console.log('\n>> SOLAR is now OVER-forecasting');
} else {
  console.log('\n>> SOLAR bias is minimal (within +/- 0.02)');
}

if (windResults.totalBias < -0.02) {
  console.log('>> WIND is still UNDER-forecasting');
} else if (windResults.totalBias > 0.02) {
  console.log('>> WIND is now OVER-forecasting');
} else {
  console.log('>> WIND bias is minimal (within +/- 0.02)');
}
