const fs = require('fs');
const { parse } = require('csv-parse/sync');

// Use the outage-filtered forecast
const forecastFile = 'output/cfac_nov17_OUTAGE_FILTERED.csv';

// Read forecast
const forecastRaw = fs.readFileSync(forecastFile, 'utf8');
const forecastRows = parse(forecastRaw, { columns: true });

// Read actual November data
const actualRaw = fs.readFileSync('Data Samples/Capacity Factor/MRHCFac_HIST_NOV.csv', 'utf8');
const actualRows = parse(actualRaw, { columns: true });

// Filter for Nov 17-30 (overlap period)
const startDate = new Date('2025-11-17T00:00:00');
const endDate = new Date('2025-11-30T23:59:59');

// Build actual lookup
const actualLookup = {};
for (const row of actualRows) {
  const dt = row['DateTimeEnding'];
  const parts = dt.match(/(\d+)\/(\d+)\/(\d+)\s+(\d+):(\d+)/);
  if (!parts) continue;
  const [_, month, day, year, hour, min] = parts;
  const date = new Date(year, month-1, day, hour, min);
  if (date >= startDate && date <= endDate) {
    actualLookup[date.toISOString()] = row;
  }
}

const stationsToAnalyze = ['06BACOLOD_S', '01SNMANUEL_S', '04PARANAS_S', '04TABANGO_S'];

console.log('═══════════════════════════════════════════════════════════════════════════════');
console.log('     FORECAST VS ACTUAL BIAS FOR SPECIFIC STATIONS (Nov 17-30)');
console.log(`     Forecast file: ${forecastFile}`);
console.log('═══════════════════════════════════════════════════════════════════════════════\n');

for (const station of stationsToAnalyze) {
  let predSum = 0, actSum = 0, pairCount = 0;
  let underCount = 0, overCount = 0;
  const hourlyData = [];

  for (const row of forecastRows) {
    const dt = row['DateTimeEnding'];
    if (!dt) continue;

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

    // Only daytime hours (6am-6pm) for solar
    const hour = date.getHours();
    if (hour < 6 || hour > 18) continue;

    if (!isNaN(pred) && !isNaN(act) && act > 0.01) {
      predSum += pred;
      actSum += act;
      pairCount++;
      if (pred < act) underCount++;
      else overCount++;
      hourlyData.push({ date, pred, act, error: pred - act });
    }
  }

  if (pairCount > 0) {
    const avgPred = predSum / pairCount;
    const avgAct = actSum / pairCount;
    const avgBias = avgPred - avgAct;
    const biasPct = (avgBias / avgAct * 100);

    console.log(`📍 ${station}`);
    console.log('─'.repeat(60));
    console.log(`  Avg Predicted (daytime):  ${avgPred.toFixed(4)}`);
    console.log(`  Avg Actual (daytime):     ${avgAct.toFixed(4)}`);
    console.log(`  Bias:                     ${avgBias.toFixed(4)} (${avgBias > 0 ? 'OVER' : 'UNDER'} by ${Math.abs(biasPct).toFixed(1)}%)`);
    console.log(`  Under-predict hours:      ${underCount} (${(underCount/pairCount*100).toFixed(1)}%)`);
    console.log(`  Over-predict hours:       ${overCount} (${(overCount/pairCount*100).toFixed(1)}%)`);

    // Show worst under-predictions
    hourlyData.sort((a, b) => a.error - b.error);
    console.log(`\n  Worst 5 under-predictions:`);
    for (let i = 0; i < Math.min(5, hourlyData.length); i++) {
      const d = hourlyData[i];
      const dateStr = `${d.date.getMonth()+1}/${d.date.getDate()} ${d.date.getHours().toString().padStart(2,'0')}:00`;
      console.log(`    ${dateStr}: Pred=${d.pred.toFixed(3)}, Act=${d.act.toFixed(3)}, Error=${d.error.toFixed(3)}`);
    }
    console.log('\n');
  }
}

// Also check: what are the best performing solar stations (to compare model behavior)
console.log('═══════════════════════════════════════════════════════════════════════════════');
console.log('     COMPARISON: ALL SOLAR STATIONS BIAS');
console.log('═══════════════════════════════════════════════════════════════════════════════\n');

const allCols = Object.keys(forecastRows[0]).filter(c => c !== 'DateTimeEnding');
const solarStations = allCols.filter(s => s.endsWith('_S'));

const stationBiases = [];

for (const station of solarStations) {
  let predSum = 0, actSum = 0, pairCount = 0;

  for (const row of forecastRows) {
    const dt = row['DateTimeEnding'];
    if (!dt) continue;

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

    // Only daytime hours
    const hour = date.getHours();
    if (hour < 6 || hour > 18) continue;

    if (!isNaN(pred) && !isNaN(act) && act > 0.01) {
      predSum += pred;
      actSum += act;
      pairCount++;
    }
  }

  if (pairCount > 0) {
    const avgPred = predSum / pairCount;
    const avgAct = actSum / pairCount;
    const avgBias = avgPred - avgAct;
    const biasPct = (avgBias / avgAct * 100);
    stationBiases.push({ station, avgPred, avgAct, avgBias, biasPct, pairCount });
  }
}

// Sort by bias (most under-forecast first)
stationBiases.sort((a, b) => a.biasPct - b.biasPct);

console.log(`${'Station'.padEnd(18)} | ${'Avg Pred'.padStart(9)} | ${'Avg Act'.padStart(9)} | ${'Bias'.padStart(8)} | ${'Bias%'.padStart(8)} | Status`);
console.log('─'.repeat(80));

const problemStations = ['06BACOLOD_S', '01SNMANUEL_S', '04PARANAS_S', '04TABANGO_S'];

for (const sb of stationBiases) {
  const isProblem = problemStations.includes(sb.station);
  const status = sb.biasPct < -15 ? 'SEVERE UNDER' : sb.biasPct < -5 ? 'UNDER' : sb.biasPct > 5 ? 'OVER' : 'OK';
  const marker = isProblem ? ' <--' : '';
  console.log(
    `${sb.station.padEnd(18)} | ${sb.avgPred.toFixed(4).padStart(9)} | ${sb.avgAct.toFixed(4).padStart(9)} | ${sb.avgBias.toFixed(4).padStart(8)} | ${sb.biasPct.toFixed(1).padStart(7)}% | ${status}${marker}`
  );
}

// Summary
const totalBias = stationBiases.reduce((s, sb) => s + sb.avgBias, 0) / stationBiases.length;
console.log('─'.repeat(80));
console.log(`Overall avg bias: ${totalBias.toFixed(4)}`);
