/**
 * Verify that the seasonal fix now produces identical results to default mode
 */
const fs = require('fs');

const defaultFile = 'output/cfac_dec_default_v2.csv';
const seasonalV2File = 'output/cfac_dec_seasonal_v2.csv';

function parseCSV(content) {
  const lines = content.split('\n').filter(l => l.trim());
  if (lines.length < 2) return { headers: [], rows: [] };
  const headers = lines[0].split(',').map(h => h.trim());
  const rows = lines.slice(1).map(l => l.split(',').map(v => v.trim()));
  return { headers, rows };
}

const defaultData = parseCSV(fs.readFileSync(defaultFile, 'utf-8'));
const seasonalV2 = parseCSV(fs.readFileSync(seasonalV2File, 'utf-8'));

console.log('═══════════════════════════════════════════════════════════════════════════════');
console.log('       VERIFY: Seasonal V2 should match Default exactly');
console.log('═══════════════════════════════════════════════════════════════════════════════');
console.log('');

// Compare solar columns only
const solarColumns = defaultData.headers.filter(h =>
  h.endsWith('_S') ||
  ['01LIMAY', '01CAYANGA', '01CLARK', '01HERMOSA', '01CURIMAO', '01BOTOLAN'].includes(h)
);

let totalDiff = 0;
let maxDiff = 0;
let maxDiffStation = '';
let maxDiffRow = 0;
let comparedCells = 0;

for (const station of solarColumns) {
  const defIdx = defaultData.headers.indexOf(station);
  const seaIdx = seasonalV2.headers.indexOf(station);

  if (defIdx < 0 || seaIdx < 0) continue;

  for (let i = 0; i < Math.min(defaultData.rows.length, seasonalV2.rows.length); i++) {
    const defVal = parseFloat(defaultData.rows[i][defIdx]);
    const seaVal = parseFloat(seasonalV2.rows[i][seaIdx]);

    if (!isNaN(defVal) && !isNaN(seaVal)) {
      const diff = Math.abs(defVal - seaVal);
      totalDiff += diff;
      comparedCells++;

      if (diff > maxDiff) {
        maxDiff = diff;
        maxDiffStation = station;
        maxDiffRow = i;
      }
    }
  }
}

const avgDiff = comparedCells > 0 ? totalDiff / comparedCells : 0;

console.log(`Compared ${comparedCells} solar cells across ${solarColumns.length} stations`);
console.log('');
console.log(`Average difference: ${(avgDiff * 100).toFixed(4)}% CF`);
console.log(`Maximum difference: ${(maxDiff * 100).toFixed(4)}% CF`);

if (maxDiff > 0) {
  console.log(`  at station ${maxDiffStation}, row ${maxDiffRow + 1}`);
  const defIdx = defaultData.headers.indexOf(maxDiffStation);
  const seaIdx = seasonalV2.headers.indexOf(maxDiffStation);
  const defVal = parseFloat(defaultData.rows[maxDiffRow][defIdx]);
  const seaVal = parseFloat(seasonalV2.rows[maxDiffRow][seaIdx]);
  console.log(`  Default: ${(defVal * 100).toFixed(2)}%, Seasonal V2: ${(seaVal * 100).toFixed(2)}%`);
}

console.log('');
if (maxDiff < 0.0001) {
  console.log('✓ SUCCESS: Seasonal V2 matches Default exactly (within floating point precision)');
  console.log('  The --solar-seasonal flag now has no effect on predictions.');
  console.log('  The 01LIMAY +296% error has been fixed.');
} else if (maxDiff < 0.01) {
  console.log('✓ CLOSE: Seasonal V2 nearly matches Default (diff < 1%)');
} else {
  console.log('✗ MISMATCH: Seasonal V2 differs from Default');
}

console.log('');
