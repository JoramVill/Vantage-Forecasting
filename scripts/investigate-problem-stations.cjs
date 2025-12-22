const fs = require('fs');
const { parse } = require('csv-parse/sync');

// Read actual November data
const actualRaw = fs.readFileSync('Data Samples/Capacity Factor/MRHCFac_HIST_NOV.csv', 'utf8');
const actualRows = parse(actualRaw, { columns: true });

// Get all solar stations
const allCols = Object.keys(actualRows[0]).filter(c => c !== 'DateTimeEnding');
const solarStations = allCols.filter(s => s.endsWith('_S'));

console.log('═══════════════════════════════════════════════════════════════════════════════');
console.log('     INVESTIGATION: Why are 06BACOLOD_S and 01SNMANUEL_S showing low values?');
console.log('═══════════════════════════════════════════════════════════════════════════════\n');

// Calculate stats for each solar station
const stationStats = [];

for (const station of solarStations) {
  const values = [];
  const daytimeValues = [];  // 6am-6pm only
  let zeroCount = 0;
  let daytimeZeroCount = 0;

  for (const row of actualRows) {
    const val = parseFloat(row[station]);
    if (!isNaN(val)) {
      values.push(val);
      if (val === 0) zeroCount++;

      // Parse datetime for daylight check
      const dt = row['DateTimeEnding'];
      const parts = dt.match(/(\d+)\/(\d+)\/(\d+)\s+(\d+):(\d+)/);
      if (parts) {
        const hour = parseInt(parts[4]);
        if (hour >= 6 && hour <= 18) {
          daytimeValues.push(val);
          if (val === 0) daytimeZeroCount++;
        }
      }
    }
  }

  if (values.length === 0) continue;

  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  const daytimeAvg = daytimeValues.length > 0 ? daytimeValues.reduce((a, b) => a + b, 0) / daytimeValues.length : 0;
  const max = Math.max(...values);
  const nonZeroValues = values.filter(v => v > 0);
  const avgNonZero = nonZeroValues.length > 0 ? nonZeroValues.reduce((a, b) => a + b, 0) / nonZeroValues.length : 0;
  const zeroPct = (zeroCount / values.length * 100);
  const daytimeZeroPct = daytimeValues.length > 0 ? (daytimeZeroCount / daytimeValues.length * 100) : 0;

  stationStats.push({
    station,
    avg,
    daytimeAvg,
    avgNonZero,
    max,
    zeroPct,
    daytimeZeroPct,
    count: values.length,
    daytimeCount: daytimeValues.length
  });
}

// Sort by daytime average
stationStats.sort((a, b) => b.daytimeAvg - a.daytimeAvg);

console.log('SOLAR STATION COMPARISON (sorted by daytime avg CF):');
console.log('─'.repeat(100));
console.log(`${'Station'.padEnd(18)} | ${'DaytimeAvg'.padStart(10)} | ${'Avg'.padStart(8)} | ${'Max'.padStart(6)} | ${'Zero%'.padStart(6)} | ${'DayZero%'.padStart(9)} | Notes`);
console.log('─'.repeat(100));

const problemStations = ['06BACOLOD_S', '01SNMANUEL_S', '04PARANAS_S', '04TABANGO_S'];

for (const stat of stationStats) {
  const isProblem = problemStations.includes(stat.station);
  const notes = isProblem ? ' <-- PROBLEM' : '';
  console.log(
    `${stat.station.padEnd(18)} | ${stat.daytimeAvg.toFixed(4).padStart(10)} | ${stat.avg.toFixed(4).padStart(8)} | ${stat.max.toFixed(3).padStart(6)} | ${stat.zeroPct.toFixed(1).padStart(5)}% | ${stat.daytimeZeroPct.toFixed(1).padStart(8)}% |${notes}`
  );
}

// Detailed analysis of problem stations
console.log('\n\n═══════════════════════════════════════════════════════════════════════════════');
console.log('                    DETAILED ANALYSIS OF PROBLEM STATIONS');
console.log('═══════════════════════════════════════════════════════════════════════════════\n');

// Calculate overall solar average for comparison
const overallDaytimeAvg = stationStats.reduce((sum, s) => sum + s.daytimeAvg, 0) / stationStats.length;
console.log(`Overall solar station daytime average: ${overallDaytimeAvg.toFixed(4)}\n`);

for (const problemStation of problemStations) {
  const stat = stationStats.find(s => s.station === problemStation);
  if (!stat) {
    console.log(`${problemStation}: NOT FOUND IN DATA\n`);
    continue;
  }

  console.log(`📍 ${problemStation}`);
  console.log('─'.repeat(50));
  console.log(`  Daytime Average CF:     ${stat.daytimeAvg.toFixed(4)}`);
  console.log(`  Overall Average CF:     ${stat.avg.toFixed(4)}`);
  console.log(`  Max CF Observed:        ${stat.max.toFixed(4)}`);
  console.log(`  Zero% (all hours):      ${stat.zeroPct.toFixed(1)}%`);
  console.log(`  Zero% (daytime only):   ${stat.daytimeZeroPct.toFixed(1)}%`);
  console.log(`  Compared to avg:        ${((stat.daytimeAvg / overallDaytimeAvg - 1) * 100).toFixed(1)}%`);

  // Analyze daily patterns
  const dailyAvgs = new Map();
  for (const row of actualRows) {
    const val = parseFloat(row[problemStation]);
    if (isNaN(val)) continue;

    const dt = row['DateTimeEnding'];
    const parts = dt.match(/(\d+)\/(\d+)\/(\d+)\s+(\d+):(\d+)/);
    if (!parts) continue;

    const [_, month, day, year, hour] = parts;
    const dateKey = `${month}/${day}`;
    const hourNum = parseInt(hour);

    // Only daytime hours
    if (hourNum < 6 || hourNum > 18) continue;

    if (!dailyAvgs.has(dateKey)) {
      dailyAvgs.set(dateKey, { sum: 0, count: 0, zeros: 0 });
    }
    const entry = dailyAvgs.get(dateKey);
    entry.sum += val;
    entry.count++;
    if (val === 0) entry.zeros++;
  }

  // Find days with very low production
  console.log(`\n  Daily patterns (daytime hours only):`);
  let lowDays = 0;
  let zeroDays = 0;
  let normalDays = 0;

  for (const [date, data] of dailyAvgs) {
    const dayAvg = data.sum / data.count;
    const zeroPct = data.zeros / data.count * 100;

    if (dayAvg < 0.05) {
      zeroDays++;
    } else if (dayAvg < overallDaytimeAvg * 0.5) {
      lowDays++;
    } else {
      normalDays++;
    }
  }

  console.log(`    Normal days (>50% of avg):  ${normalDays}`);
  console.log(`    Low days (<50% of avg):     ${lowDays}`);
  console.log(`    Near-zero days (<5% CF):    ${zeroDays}`);

  // Check if there's a pattern (outages vs consistently low)
  const sortedDays = [...dailyAvgs.entries()]
    .map(([date, data]) => ({ date, avg: data.sum / data.count }))
    .sort((a, b) => a.avg - b.avg);

  console.log(`\n  Lowest 5 days:`);
  for (let i = 0; i < Math.min(5, sortedDays.length); i++) {
    const d = sortedDays[i];
    console.log(`    ${d.date}: ${d.avg.toFixed(4)} avg CF`);
  }

  console.log(`\n  Highest 5 days:`);
  for (let i = sortedDays.length - 1; i >= Math.max(0, sortedDays.length - 5); i--) {
    const d = sortedDays[i];
    console.log(`    ${d.date}: ${d.avg.toFixed(4)} avg CF`);
  }

  console.log('\n');
}

// Compare forecast vs actual for problem stations
console.log('═══════════════════════════════════════════════════════════════════════════════');
console.log('                    FORECAST VS ACTUAL FOR PROBLEM STATIONS');
console.log('═══════════════════════════════════════════════════════════════════════════════\n');

// Try to read the latest forecast file
const forecastFile = 'output/cfac_nov_outage_filtered.csv';
try {
  const forecastRaw = fs.readFileSync(forecastFile, 'utf8');
  const forecastRows = parse(forecastRaw, { columns: true });

  // Filter for Nov 17-30
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

  for (const problemStation of problemStations) {
    let predSum = 0, actSum = 0, pairCount = 0;
    let underCount = 0, overCount = 0;
    const errors = [];

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

      const pred = parseFloat(row[problemStation]);
      const act = parseFloat(actual[problemStation]);

      // Only daytime hours
      const hour = date.getHours();
      if (hour < 6 || hour > 18) continue;

      if (!isNaN(pred) && !isNaN(act) && act > 0.01) {
        predSum += pred;
        actSum += act;
        pairCount++;
        if (pred < act) underCount++;
        else overCount++;
        errors.push({ pred, act, error: pred - act });
      }
    }

    if (pairCount > 0) {
      const avgPred = predSum / pairCount;
      const avgAct = actSum / pairCount;
      const avgBias = avgPred - avgAct;

      console.log(`📍 ${problemStation}`);
      console.log('─'.repeat(50));
      console.log(`  Avg Predicted (daytime):  ${avgPred.toFixed(4)}`);
      console.log(`  Avg Actual (daytime):     ${avgAct.toFixed(4)}`);
      console.log(`  Bias:                     ${avgBias.toFixed(4)} (${avgBias > 0 ? 'OVER' : 'UNDER'})`);
      console.log(`  Under-predict hours:      ${underCount} (${(underCount/pairCount*100).toFixed(1)}%)`);
      console.log(`  Over-predict hours:       ${overCount} (${(overCount/pairCount*100).toFixed(1)}%)`);
      console.log('');
    }
  }
} catch (e) {
  console.log(`Could not read forecast file ${forecastFile}: ${e.message}`);
}

// Final diagnosis
console.log('\n═══════════════════════════════════════════════════════════════════════════════');
console.log('                              DIAGNOSIS');
console.log('═══════════════════════════════════════════════════════════════════════════════\n');

console.log('Key insight: If the ACTUAL CF values for these stations are consistently low');
console.log('compared to other solar stations, then the model is correctly learning from');
console.log('the training data. The issue is that these stations genuinely produce less.');
console.log('');
console.log('Possible reasons for genuinely low CF at specific stations:');
console.log('  1. Equipment degradation (inverter issues, panel soiling)');
console.log('  2. Partial capacity - not all units operational');
console.log('  3. Curtailment by grid operator');
console.log('  4. Site-specific shading or weather patterns');
console.log('  5. Newer installation still being commissioned');
console.log('');
console.log('If the model is UNDER-predicting compared to their actual values,');
console.log('then there may be a data or weather mismatch issue.');
