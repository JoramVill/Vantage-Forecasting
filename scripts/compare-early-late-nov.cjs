const fs = require('fs');
const { parse } = require('csv-parse/sync');

// Read actual November data
const actualRaw = fs.readFileSync('Data Samples/Capacity Factor/MRHCFac_HIST_NOV.csv', 'utf8');
const actualRows = parse(actualRaw, { columns: true });

const problemStations = ['06BACOLOD_S', '01SNMANUEL_S', '04PARANAS_S', '04TABANGO_S'];
const controlStations = ['01CNCEPCN_S', '14GENSA_S', '06CADIZ_S'];  // Normal performing stations

console.log('═══════════════════════════════════════════════════════════════════════════════');
console.log('     EARLY vs LATE NOVEMBER PERFORMANCE COMPARISON');
console.log('═══════════════════════════════════════════════════════════════════════════════\n');

function analyzeStation(station, rows) {
  const earlyNov = { sum: 0, count: 0 };  // Nov 1-16
  const lateNov = { sum: 0, count: 0 };   // Nov 17-30

  for (const row of rows) {
    const val = parseFloat(row[station]);
    if (isNaN(val)) continue;

    const dt = row['DateTimeEnding'];
    const parts = dt.match(/(\d+)\/(\d+)\/(\d+)\s+(\d+):(\d+)/);
    if (!parts) continue;

    const [_, month, day, year, hour] = parts;
    const dayNum = parseInt(day);
    const hourNum = parseInt(hour);

    // Only daytime
    if (hourNum < 6 || hourNum > 18) continue;

    if (dayNum <= 16) {
      earlyNov.sum += val;
      earlyNov.count++;
    } else {
      lateNov.sum += val;
      lateNov.count++;
    }
  }

  const earlyAvg = earlyNov.count > 0 ? earlyNov.sum / earlyNov.count : 0;
  const lateAvg = lateNov.count > 0 ? lateNov.sum / lateNov.count : 0;
  const change = earlyAvg > 0 ? ((lateAvg - earlyAvg) / earlyAvg * 100) : 0;

  return { earlyAvg, lateAvg, change };
}

console.log('PROBLEM STATIONS (under-forecasting):');
console.log('─'.repeat(70));
console.log(`${'Station'.padEnd(18)} | ${'Nov 1-16'.padStart(10)} | ${'Nov 17-30'.padStart(10)} | ${'Change'.padStart(10)}`);
console.log('─'.repeat(70));

for (const station of problemStations) {
  const result = analyzeStation(station, actualRows);
  console.log(
    `${station.padEnd(18)} | ${result.earlyAvg.toFixed(4).padStart(10)} | ${result.lateAvg.toFixed(4).padStart(10)} | ${(result.change > 0 ? '+' : '') + result.change.toFixed(1).padStart(9)}%`
  );
}

console.log('\nCONTROL STATIONS (normal performance):');
console.log('─'.repeat(70));

for (const station of controlStations) {
  const result = analyzeStation(station, actualRows);
  console.log(
    `${station.padEnd(18)} | ${result.earlyAvg.toFixed(4).padStart(10)} | ${result.lateAvg.toFixed(4).padStart(10)} | ${(result.change > 0 ? '+' : '') + result.change.toFixed(1).padStart(9)}%`
  );
}

// Check ALL solar stations
console.log('\n\nALL SOLAR STATIONS - Change from Early to Late November:');
console.log('─'.repeat(70));

const allCols = Object.keys(actualRows[0]).filter(c => c !== 'DateTimeEnding');
const solarStations = allCols.filter(s => s.endsWith('_S'));

const stationChanges = [];
for (const station of solarStations) {
  const result = analyzeStation(station, actualRows);
  if (result.earlyAvg > 0.01) {  // Skip stations with no early data
    stationChanges.push({ station, ...result });
  }
}

// Sort by change (highest improvement first)
stationChanges.sort((a, b) => b.change - a.change);

console.log(`${'Station'.padEnd(18)} | ${'Nov 1-16'.padStart(10)} | ${'Nov 17-30'.padStart(10)} | ${'Change'.padStart(10)} | Note`);
console.log('─'.repeat(85));

for (const sc of stationChanges) {
  const isProblem = problemStations.includes(sc.station);
  const note = sc.change > 30 ? 'MAJOR IMPROVEMENT' : sc.change < -30 ? 'MAJOR DECLINE' : '';
  const marker = isProblem ? ' <--' : '';
  console.log(
    `${sc.station.padEnd(18)} | ${sc.earlyAvg.toFixed(4).padStart(10)} | ${sc.lateAvg.toFixed(4).padStart(10)} | ${(sc.change > 0 ? '+' : '') + sc.change.toFixed(1).padStart(9)}% | ${note}${marker}`
  );
}

// Summary
console.log('\n═══════════════════════════════════════════════════════════════════════════════');
console.log('                              DIAGNOSIS');
console.log('═══════════════════════════════════════════════════════════════════════════════\n');

const avgChange = stationChanges.reduce((s, sc) => s + sc.change, 0) / stationChanges.length;
console.log(`Average change across all solar stations: ${avgChange.toFixed(1)}%\n`);

const bigImprovers = stationChanges.filter(sc => sc.change > 30);
if (bigImprovers.length > 0) {
  console.log('Stations with >30% improvement from early to late November:');
  for (const bi of bigImprovers) {
    const isProblem = problemStations.includes(bi.station);
    console.log(`  - ${bi.station}: ${bi.change.toFixed(1)}% improvement${isProblem ? ' (PROBLEM STATION)' : ''}`);
  }
}

console.log('\nConclusion: If problem stations show significantly higher improvement than');
console.log('average stations, the model under-predicts because it learned from early');
console.log('November data which had lower CF for those stations.');
