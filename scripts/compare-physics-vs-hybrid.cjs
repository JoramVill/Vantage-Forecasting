/**
 * Compare physics-only vs full hybrid predictions for December
 * to see how much the ML residual is hurting us
 */
const fs = require('fs');
const path = require('path');

// Read actual December data
const actualFile = 'Data Samples/Capacity Factor/MRHCFac_H7D1201.csv';
const content = fs.readFileSync(actualFile, 'utf-8');
const lines = content.split('\n').filter(l => l.trim());

const headers = lines[0].split(',').map(h => h.trim());
const solarCols = headers
  .map((h, i) => ({ name: h, idx: i }))
  .filter(c => c.name.endsWith('_S'));

console.log('Problem stations in actual data:');
const problemStations = ['01SNMANUEL_S', '06BACOLOD_S'];

for (const station of problemStations) {
  const col = solarCols.find(c => c.name === station);
  if (!col) {
    console.log(`  ${station}: NOT FOUND`);
    continue;
  }

  // Calculate average CF by hour
  const hourlySum = {};
  const hourlyCount = {};

  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(',');
    const datetime = values[0];
    const cfac = parseFloat(values[col.idx]);

    if (isNaN(cfac) || cfac < 0 || cfac > 1) continue;

    const hourMatch = datetime.match(/\s+(\d+):/);
    if (!hourMatch) continue;

    const hour = parseInt(hourMatch[1], 10);
    if (hour < 6 || hour > 18) continue;

    hourlySum[hour] = (hourlySum[hour] || 0) + cfac;
    hourlyCount[hour] = (hourlyCount[hour] || 0) + 1;
  }

  console.log(`\n${station} - Actual December CF by hour:`);
  for (let h = 9; h <= 15; h++) {
    if (hourlyCount[h]) {
      const avg = hourlySum[h] / hourlyCount[h];
      console.log(`  H${h}: ${(avg * 100).toFixed(1)}%`);
    }
  }
}

console.log('\n=== Key Question ===');
console.log('If the weather API gives us December solar irradiance,');
console.log('the PHYSICS model should predict higher CF directly.');
console.log('The ML residual learned from wet season is SUBTRACTING from it.');
console.log('\nSolution: For stations with huge seasonal swing,');
console.log('trust physics more than ML residual.');
