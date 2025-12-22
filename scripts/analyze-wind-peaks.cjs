const fs = require('fs');
const { parse } = require('csv-parse/sync');

// Read forecast
const forecastRaw = fs.readFileSync('output/cfac_nov_mlopt.csv', 'utf8');
const forecastRows = parse(forecastRaw, { columns: true });

// Read actual November data
const actualRaw = fs.readFileSync('Data Samples/Capacity Factor/MRHCFac_HIST_NOV.csv', 'utf8');
const actualRows = parse(actualRaw, { columns: true });

// Filter for Nov 15-30
const startDate = new Date('2025-11-15T00:00:00');
const endDate = new Date('2025-11-30T23:59:59');

// Wind stations to analyze
const windStations = ['01BURGOS','01LAOAG','01PAGUDPUD','02DOLORES','08NABAS_W','08BVISTA'];

// Build actual lookup
const actualLookup = {};
for (const row of actualRows) {
  const dt = row['DateTimeEnding'] || row['datetime'];
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

console.log('═══════════════════════════════════════════════════════════════════════════════');
console.log('         WIND PEAK ANALYSIS: NOV 15-30, 2025');
console.log('═══════════════════════════════════════════════════════════════════════════════\n');

// Analyze each wind station
for (const station of windStations) {
  const pairs = [];

  for (const row of forecastRows) {
    const dt = row['DateTimeEnding'] || row['datetime'];
    if (!dt) continue;

    const usDateParts = dt.match(/(\d+)\/(\d+)\/(\d+)\s+(\d+):(\d+)/);
    let date;
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

    if (!isNaN(pred) && !isNaN(act)) {
      pairs.push({ datetime: date, pred, act });
    }
  }

  // Sort by actual value descending
  pairs.sort((a, b) => b.act - a.act);

  // Analyze top 10% (peaks)
  const top10Pct = Math.ceil(pairs.length * 0.1);
  const peaks = pairs.slice(0, top10Pct);

  // Also get top 20 peaks
  const top20 = pairs.slice(0, 20);

  // Calculate metrics for peaks
  const peakActualMax = Math.max(...peaks.map(p => p.act));
  const peakPredMax = Math.max(...peaks.map(p => p.pred));
  const peakActualAvg = peaks.reduce((s, p) => s + p.act, 0) / peaks.length;
  const peakPredAvg = peaks.reduce((s, p) => s + p.pred, 0) / peaks.length;
  const peakMAPE = peaks.filter(p => p.act > 0.01).reduce((s, p) => s + Math.abs((p.pred - p.act) / p.act), 0) / peaks.filter(p => p.act > 0.01).length * 100;

  // Calculate capture ratio (how much of peaks we capture)
  const captureRatio = peakPredAvg / peakActualAvg;

  // Calculate overall stats
  const overallActualAvg = pairs.reduce((s, p) => s + p.act, 0) / pairs.length;
  const overallPredAvg = pairs.reduce((s, p) => s + p.pred, 0) / pairs.length;

  console.log(`\n📍 ${station}`);
  console.log('─'.repeat(60));
  console.log(`  Overall avg:  Actual=${overallActualAvg.toFixed(3)}  Predicted=${overallPredAvg.toFixed(3)}`);
  console.log(`  Peak avg:     Actual=${peakActualAvg.toFixed(3)}  Predicted=${peakPredAvg.toFixed(3)}`);
  console.log(`  Peak max:     Actual=${peakActualMax.toFixed(3)}  Predicted=${peakPredMax.toFixed(3)}`);
  console.log(`  Peak capture: ${(captureRatio * 100).toFixed(1)}%`);
  console.log(`  Peak MAPE:    ${peakMAPE.toFixed(1)}%`);
  console.log(`\n  Top 10 Peak Hours:`);
  console.log(`  ${'DateTime'.padEnd(18)} │ Actual  │ Predicted │ Error`);
  console.log('  ' + '─'.repeat(55));
  for (let i = 0; i < Math.min(10, top20.length); i++) {
    const p = top20[i];
    const errPct = p.act > 0.01 ? ((p.pred - p.act) / p.act * 100).toFixed(0) : 'N/A';
    const dateStr = `${p.datetime.getMonth()+1}/${p.datetime.getDate()} ${p.datetime.getHours().toString().padStart(2,'0')}:00`;
    console.log(`  ${dateStr.padEnd(18)} │ ${p.act.toFixed(4).padStart(6)} │ ${p.pred.toFixed(4).padStart(9)} │ ${errPct.toString().padStart(5)}%`);
  }
}

// Overall summary
console.log('\n');
console.log('═══════════════════════════════════════════════════════════════════════════════');
console.log('                           OVERALL PEAK SUMMARY');
console.log('═══════════════════════════════════════════════════════════════════════════════\n');

let totalPeakCapture = 0;
let stationCount = 0;

for (const station of windStations) {
  const pairs = [];

  for (const row of forecastRows) {
    const dt = row['DateTimeEnding'] || row['datetime'];
    if (!dt) continue;
    const usDateParts = dt.match(/(\d+)\/(\d+)\/(\d+)\s+(\d+):(\d+)/);
    let date;
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
    if (!isNaN(pred) && !isNaN(act)) {
      pairs.push({ pred, act });
    }
  }

  pairs.sort((a, b) => b.act - a.act);
  const top10Pct = Math.ceil(pairs.length * 0.1);
  const peaks = pairs.slice(0, top10Pct);
  const peakActualAvg = peaks.reduce((s, p) => s + p.act, 0) / peaks.length;
  const peakPredAvg = peaks.reduce((s, p) => s + p.pred, 0) / peaks.length;
  const captureRatio = peakPredAvg / peakActualAvg;

  console.log(`  ${station.padEnd(12)}: ${(captureRatio * 100).toFixed(1)}% peak capture`);
  totalPeakCapture += captureRatio;
  stationCount++;
}

console.log(`\n  Average Peak Capture: ${(totalPeakCapture / stationCount * 100).toFixed(1)}%`);
console.log(`  (100% = perfectly capturing peaks, <100% = under-predicting peaks)`);
