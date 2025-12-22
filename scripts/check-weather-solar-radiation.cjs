/**
 * Check weather API solar radiation values by hour
 * See if late afternoon has inflated values
 */
const fs = require('fs');
const path = require('path');

// Check weather cache files
const cacheDir = 'weather_cache';
const files = fs.readdirSync(cacheDir).filter(f => f.endsWith('.json'));

console.log(`Found ${files.length} weather cache files\n`);

// Aggregate solar radiation by hour
const hourlyRadiation = {};
const hourlyCounts = {};
for (let h = 0; h < 24; h++) {
  hourlyRadiation[h] = 0;
  hourlyCounts[h] = 0;
}

let totalRecords = 0;

// Check first few files
for (const file of files.slice(0, 10)) {
  try {
    const content = fs.readFileSync(path.join(cacheDir, file), 'utf-8');
    const data = JSON.parse(content);

    if (data.days) {
      for (const day of data.days) {
        if (day.hours) {
          for (const hourData of day.hours) {
            // Parse hour from datetime string like "00:00:00"
            const hourStr = hourData.datetime?.split(':')[0];
            const hour = parseInt(hourStr, 10);

            if (!isNaN(hour) && hourData.solarradiation !== undefined) {
              hourlyRadiation[hour] += hourData.solarradiation;
              hourlyCounts[hour]++;
              totalRecords++;
            }
          }
        }
      }
    }
  } catch (e) {
    // Skip invalid files
  }
}

console.log(`Analyzed ${totalRecords} hourly records from weather cache\n`);

console.log('Average Solar Radiation by Hour (W/m²):');
console.log('='.repeat(60));

for (let h = 5; h <= 19; h++) {
  const avg = hourlyCounts[h] > 0 ? hourlyRadiation[h] / hourlyCounts[h] : 0;
  const bar = '█'.repeat(Math.round(avg / 20));
  console.log(`Hour ${h.toString().padStart(2)}: ${avg.toFixed(1).padStart(6)} W/m² ${bar} (n=${hourlyCounts[h]})`);
}

// Check for afternoon spike
console.log('\n\nHourly profile check (should peak at noon, decay symmetrically):');
const peakHour = 12;
const peakVal = hourlyCounts[peakHour] > 0 ? hourlyRadiation[peakHour] / hourlyCounts[peakHour] : 1;

for (let h = 6; h <= 18; h++) {
  const avg = hourlyCounts[h] > 0 ? hourlyRadiation[h] / hourlyCounts[h] : 0;
  const ratio = (avg / peakVal * 100).toFixed(0);
  const mirrorHour = 24 - h;  // 6am mirrors 6pm, 8am mirrors 4pm, etc.
  const mirrorAvg = hourlyCounts[mirrorHour] > 0 ? hourlyRadiation[mirrorHour] / hourlyCounts[mirrorHour] : 0;

  const isAfternoon = h > 12;
  const morningMirror = 24 - h;
  const morningAvg = hourlyCounts[morningMirror] > 0 ? hourlyRadiation[morningMirror] / hourlyCounts[morningMirror] : 0;

  let asymmetry = '';
  if (h > 12 && morningAvg > 0) {
    const asymRatio = avg / morningAvg;
    if (asymRatio > 1.2) {
      asymmetry = ` <-- AFTERNOON ${((asymRatio-1)*100).toFixed(0)}% HIGHER than morning mirror`;
    }
  }

  console.log(`Hour ${h.toString().padStart(2)}: ${ratio.padStart(3)}% of peak${asymmetry}`);
}
