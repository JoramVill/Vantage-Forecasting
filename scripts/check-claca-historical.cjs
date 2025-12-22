/**
 * Check if 03CLACA historical data has afternoon spike
 */
const fs = require('fs');
const path = require('path');

const cfacDir = 'Data Samples/Capacity Factor';
const files = fs.readdirSync(cfacDir).filter(f => f.endsWith('.csv'));

const hourlyActual = {};
const hourlyCounts = {};

for (let h = 0; h < 24; h++) {
  hourlyActual[h] = 0;
  hourlyCounts[h] = 0;
}

console.log('Checking HISTORICAL data for 03CLACA afternoon pattern...\n');

for (const file of files) {
  const content = fs.readFileSync(path.join(cfacDir, file), 'utf-8');
  const lines = content.split('\n').filter(l => l.trim());

  if (lines.length < 2) continue;

  const headers = lines[0].split(',').map(h => h.trim());
  const stationIdx = headers.indexOf('03CLACA');

  if (stationIdx === -1) continue;

  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(',');
    if (values.length < stationIdx + 1) continue;

    const dateStr = values[0].trim();
    const match = dateStr.match(/(\d+)\/(\d+)\/(\d+)\s+(\d+):(\d+)/);
    if (!match) continue;

    const hour = parseInt(match[4], 10);
    const cfac = parseFloat(values[stationIdx]);

    if (!isNaN(cfac) && cfac >= 0 && cfac <= 1) {
      hourlyActual[hour] += cfac;
      hourlyCounts[hour]++;
    }
  }
}

console.log('03CLACA Historical Average by Hour:');
console.log('='.repeat(50));

for (let h = 10; h <= 19; h++) {
  const avg = hourlyCounts[h] > 0 ? hourlyActual[h] / hourlyCounts[h] : 0;
  const bar = '█'.repeat(Math.round(avg * 50));
  console.log(`Hour ${h.toString().padStart(2)}: ${avg.toFixed(3)} ${bar} (n=${hourlyCounts[h]})`);
}

// Check for anomalies
console.log('\n\nAnomaly check:');
for (let h = 11; h <= 18; h++) {
  const prev = hourlyCounts[h-1] > 0 ? hourlyActual[h-1] / hourlyCounts[h-1] : 0;
  const curr = hourlyCounts[h] > 0 ? hourlyActual[h] / hourlyCounts[h] : 0;

  if (h >= 14 && curr > prev) {
    console.log(`Hour ${h} (${curr.toFixed(3)}) > Hour ${h-1} (${prev.toFixed(3)}) - ANOMALY in HISTORICAL!`);
  }
}
