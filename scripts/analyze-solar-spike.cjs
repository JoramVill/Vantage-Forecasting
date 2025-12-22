/**
 * Analyze solar forecast spike issue at end of day
 */
const fs = require('fs');
const path = require('path');

// Read actual capacity factor data
const cfacDir = 'Data Samples/Capacity Factor';
const files = fs.readdirSync(cfacDir).filter(f => f.endsWith('.csv'));

// Aggregate by hour for solar stations
const hourlyActual = {};
const hourlyCounts = {};

for (let h = 0; h < 24; h++) {
  hourlyActual[h] = 0;
  hourlyCounts[h] = 0;
}

// Solar station detection
function isSolar(code) {
  const c = code.toUpperCase();
  return c.endsWith('_S') ||
    c.includes('SOLAR') ||
    ['01CAYANGA', '01CLARK', '01HERMOSA', '01LIMAY', '01SNMARCELINO', '01SNRAFAEL',
     '01SNTGO', '03CALAMBA', '03CLACA', '03DASMAEHV', '05CALUNG', '06HELIOS',
     '11KIBAW', '01CURIMAO', '01PASUQUIN', '01BOTOLAN'].includes(c);
}

console.log('Reading capacity factor files...\n');

let totalRecords = 0;
let solarStations = new Set();

for (const file of files) {
  const content = fs.readFileSync(path.join(cfacDir, file), 'utf-8');
  const lines = content.split('\n').filter(l => l.trim());

  if (lines.length < 2) continue;

  const headers = lines[0].split(',').map(h => h.trim());
  const stationCodes = headers.slice(1);

  // Find solar station indices
  const solarIndices = [];
  stationCodes.forEach((code, idx) => {
    if (isSolar(code)) {
      solarIndices.push(idx);
      solarStations.add(code);
    }
  });

  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(',');
    if (values.length < 2) continue;

    // Parse datetime
    const dateStr = values[0].trim();
    const match = dateStr.match(/(\d+)\/(\d+)\/(\d+)\s+(\d+):(\d+)/);
    if (!match) continue;

    const hour = parseInt(match[4], 10);

    // Aggregate solar station values
    for (const idx of solarIndices) {
      const cfac = parseFloat(values[idx + 1]);
      if (!isNaN(cfac) && cfac >= 0 && cfac <= 1) {
        hourlyActual[hour] += cfac;
        hourlyCounts[hour]++;
        totalRecords++;
      }
    }
  }
}

console.log(`Found ${solarStations.size} solar stations`);
console.log(`Total records analyzed: ${totalRecords}\n`);

console.log('Average Solar Capacity Factor by Hour (Actual Historical):');
console.log('='.repeat(50));

for (let h = 5; h <= 19; h++) {
  const avg = hourlyCounts[h] > 0 ? hourlyActual[h] / hourlyCounts[h] : 0;
  const bar = '█'.repeat(Math.round(avg * 50));
  console.log(`Hour ${h.toString().padStart(2)}: ${avg.toFixed(3)} ${bar} (n=${hourlyCounts[h]})`);
}

// Show the shape pattern
console.log('\n\nDaylight Profile Shape:');
console.log('-'.repeat(50));
const peakHour = 12;
const peakVal = hourlyCounts[peakHour] > 0 ? hourlyActual[peakHour] / hourlyCounts[peakHour] : 0;

for (let h = 5; h <= 19; h++) {
  const avg = hourlyCounts[h] > 0 ? hourlyActual[h] / hourlyCounts[h] : 0;
  const ratio = peakVal > 0 ? (avg / peakVal * 100).toFixed(0) : 0;
  console.log(`Hour ${h.toString().padStart(2)}: ${ratio}% of peak`);
}
