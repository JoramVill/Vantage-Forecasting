/**
 * Check 03CLACA historical pattern by month
 */
const fs = require('fs');
const path = require('path');

const cfacDir = 'Data Samples/Capacity Factor';
const files = fs.readdirSync(cfacDir).filter(f => f.endsWith('.csv'));

// Group by month
const monthlyHourly = {};

console.log('Checking 03CLACA pattern by MONTH...\n');

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

    const month = parseInt(match[1], 10);
    const year = parseInt(match[3], 10);
    const hour = parseInt(match[4], 10);
    const cfac = parseFloat(values[stationIdx]);

    if (isNaN(cfac) || cfac < 0 || cfac > 1) continue;

    const monthKey = `${year}-${month.toString().padStart(2, '0')}`;

    if (!monthlyHourly[monthKey]) {
      monthlyHourly[monthKey] = { sums: {}, counts: {} };
      for (let h = 0; h < 24; h++) {
        monthlyHourly[monthKey].sums[h] = 0;
        monthlyHourly[monthKey].counts[h] = 0;
      }
    }

    monthlyHourly[monthKey].sums[hour] += cfac;
    monthlyHourly[monthKey].counts[hour]++;
  }
}

const sortedMonths = Object.keys(monthlyHourly).sort();

console.log('Month     | H08   | H10   | H12   | H14   | H16   | H18   | Pattern');
console.log('='.repeat(80));

for (const month of sortedMonths) {
  const data = monthlyHourly[month];
  const getAvg = (h) => data.counts[h] > 0 ? data.sums[h] / data.counts[h] : 0;

  const h08 = getAvg(8);
  const h10 = getAvg(10);
  const h12 = getAvg(12);
  const h14 = getAvg(14);
  const h16 = getAvg(16);
  const h18 = getAvg(18);

  // Detect pattern type
  let pattern = '';
  const peak = Math.max(h08, h10, h12, h14, h16, h18);
  const valley = Math.min(h08, h10, h12, h14, h16, h18);
  const variation = peak - valley;

  if (variation < 0.1) {
    pattern = 'FLAT (battery-backed?)';
  } else if (h12 >= h10 && h12 >= h14) {
    pattern = 'Normal solar bell';
  } else {
    pattern = 'Irregular';
  }

  console.log(`${month} | ${h08.toFixed(3)} | ${h10.toFixed(3)} | ${h12.toFixed(3)} | ${h14.toFixed(3)} | ${h16.toFixed(3)} | ${h18.toFixed(3)} | ${pattern}`);
}

console.log('\n\nDetailed view for each month (hours 6-19):');
for (const month of sortedMonths) {
  const data = monthlyHourly[month];
  const getAvg = (h) => data.counts[h] > 0 ? data.sums[h] / data.counts[h] : 0;

  console.log(`\n${month}:`);
  let line = '';
  for (let h = 6; h <= 19; h++) {
    const avg = getAvg(h);
    line += `H${h.toString().padStart(2)}:${avg.toFixed(2)} `;
  }
  console.log(line);
}
