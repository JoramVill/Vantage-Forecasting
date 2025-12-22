/**
 * Analyze problem stations (01SNMANUEL_S, 06BACOLOD_S)
 * Compare historical training data vs December actual
 */
const fs = require('fs');
const path = require('path');

const cfacDir = 'Data Samples/Capacity Factor';
const problemStations = ['01SNMANUEL_S', '06BACOLOD_S', '01HERMOSA_S', '03CLACA_S'];

// Collect data by station
const stationData = {};
for (const station of problemStations) {
  stationData[station] = {
    training: [],  // July-November (excluding Dec)
    december: [],  // December only
  };
}

// Parse all CFac files
const files = fs.readdirSync(cfacDir).filter(f => f.endsWith('.csv'));

for (const file of files) {
  const content = fs.readFileSync(path.join(cfacDir, file), 'utf-8');
  const lines = content.split('\n').filter(l => l.trim());

  if (lines.length < 2) continue;

  const headers = lines[0].split(',').map(h => h.trim());
  const stationCols = {};

  for (const station of problemStations) {
    const idx = headers.indexOf(station);
    if (idx >= 0) stationCols[station] = idx;
  }

  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(',');
    if (values.length < 2) continue;

    const dateStr = values[0].trim();
    const match = dateStr.match(/(\d+)\/(\d+)\/(\d+)\s+(\d+):/);
    if (!match) continue;

    const month = parseInt(match[1], 10);
    const day = parseInt(match[2], 10);
    const year = parseInt(match[3], 10);
    const hour = parseInt(match[4], 10);

    // Only daylight hours
    if (hour < 6 || hour > 18) continue;

    for (const [station, colIdx] of Object.entries(stationCols)) {
      if (values.length <= colIdx) continue;
      const cfac = parseFloat(values[colIdx]);
      if (isNaN(cfac) || cfac < 0 || cfac > 1) continue;

      const entry = { month, day, hour, cfac };

      if (month === 12) {
        stationData[station].december.push(entry);
      } else {
        stationData[station].training.push(entry);
      }
    }
  }
}

// Analyze each station
console.log('=== Problem Station Analysis ===\n');

for (const station of problemStations) {
  const data = stationData[station];

  if (data.training.length === 0 && data.december.length === 0) {
    console.log(`${station}: No data found\n`);
    continue;
  }

  console.log(`\n=== ${station} ===`);
  console.log(`Training samples (Jul-Nov): ${data.training.length}`);
  console.log(`December samples: ${data.december.length}`);

  // Calculate average by hour
  console.log('\nHourly comparison (Training avg vs December avg):');
  console.log('Hour | Training | December | Diff');
  console.log('-'.repeat(40));

  for (let h = 6; h <= 18; h++) {
    const trainH = data.training.filter(d => d.hour === h);
    const decH = data.december.filter(d => d.hour === h);

    const trainAvg = trainH.length > 0
      ? trainH.reduce((s, d) => s + d.cfac, 0) / trainH.length
      : 0;
    const decAvg = decH.length > 0
      ? decH.reduce((s, d) => s + d.cfac, 0) / decH.length
      : 0;

    const diff = decAvg - trainAvg;
    let marker = '';
    if (diff > 0.05) marker = ' << DEC HIGHER';
    if (diff < -0.05) marker = ' (Dec lower)';

    console.log(`H${h.toString().padStart(2)} | ${(trainAvg * 100).toFixed(1).padStart(6)}%  | ${(decAvg * 100).toFixed(1).padStart(6)}%  | ${(diff * 100 > 0 ? '+' : '') + (diff * 100).toFixed(1).padStart(6)}%${marker}`);
  }

  // Overall averages
  const trainOverall = data.training.reduce((s, d) => s + d.cfac, 0) / data.training.length;
  const decOverall = data.december.reduce((s, d) => s + d.cfac, 0) / data.december.length;
  const overallDiff = decOverall - trainOverall;

  console.log(`\nOverall avg: Training=${(trainOverall * 100).toFixed(1)}%, December=${(decOverall * 100).toFixed(1)}%, Diff=${(overallDiff * 100 > 0 ? '+' : '') + (overallDiff * 100).toFixed(1)}%`);
  console.log(`If trained on Jul-Nov, model learns ${(trainOverall * 100).toFixed(1)}% but Dec has ${(decOverall * 100).toFixed(1)}%`);
}
