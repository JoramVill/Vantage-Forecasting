/**
 * Check weather API solar radiation values by hour from CSV cache
 * See if afternoon has inflated values
 */
const fs = require('fs');
const path = require('path');

const cacheDir = 'weather_cache';

// Simple CSV parser that handles quoted fields
function parseCSVLine(line) {
  const result = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      result.push(field);
      field = '';
    } else {
      field += char;
    }
  }
  result.push(field);
  return result;
}

// Find all SOLAR_xxx directories (per-station)
const allDirs = fs.readdirSync(cacheDir).filter(d => {
  const fullPath = path.join(cacheDir, d);
  return fs.statSync(fullPath).isDirectory() && d.startsWith('SOLAR_');
});

console.log(`Found ${allDirs.length} solar station directories\n`);

// Aggregate solar radiation by hour
const hourlyRadiation = {};
const hourlyCounts = {};
for (let h = 0; h < 24; h++) {
  hourlyRadiation[h] = 0;
  hourlyCounts[h] = 0;
}

let totalRecords = 0;
let filesProcessed = 0;

// Process each solar directory
for (const dir of allDirs) {
  const dirPath = path.join(cacheDir, dir);

  // Get all month directories (like 2025-10)
  const monthDirs = fs.readdirSync(dirPath).filter(d => {
    const fullPath = path.join(dirPath, d);
    return fs.statSync(fullPath).isDirectory() && d.match(/^\d{4}-\d{2}$/);
  });

  for (const monthDir of monthDirs) {
    const monthPath = path.join(dirPath, monthDir);
    const csvFiles = fs.readdirSync(monthPath).filter(f => f.endsWith('.csv'));

    for (const file of csvFiles) {
      try {
        const content = fs.readFileSync(path.join(monthPath, file), 'utf-8');
        const lines = content.split('\n').filter(l => l.trim());

        if (lines.length < 2) continue;

        // Parse header to find solarradiation column
        const headers = parseCSVLine(lines[0]);
        const radIdx = headers.indexOf('solarradiation');
        const dtIdx = headers.indexOf('datetime');

        if (radIdx === -1 || dtIdx === -1) continue;

        filesProcessed++;

        for (let i = 1; i < lines.length; i++) {
          const values = parseCSVLine(lines[i]);
          if (values.length <= radIdx) continue;

          const datetime = values[dtIdx];
          const hourMatch = datetime.match(/T(\d{2}):/);
          if (!hourMatch) continue;

          const hour = parseInt(hourMatch[1], 10);
          const radiation = parseFloat(values[radIdx]);

          if (!isNaN(hour) && !isNaN(radiation) && radiation >= 0) {
            hourlyRadiation[hour] += radiation;
            hourlyCounts[hour]++;
            totalRecords++;
          }
        }
      } catch (e) {
        // Skip invalid files
      }
    }
  }
}

console.log(`Processed ${filesProcessed} CSV files`);
console.log(`Analyzed ${totalRecords} hourly records from weather cache\n`);

console.log('Average Solar Radiation by Hour (W/m²):');
console.log('='.repeat(70));

for (let h = 5; h <= 19; h++) {
  const avg = hourlyCounts[h] > 0 ? hourlyRadiation[h] / hourlyCounts[h] : 0;
  const bar = '#'.repeat(Math.round(avg / 15));
  console.log(`Hour ${h.toString().padStart(2)}: ${avg.toFixed(1).padStart(6)} W/m² ${bar} (n=${hourlyCounts[h]})`);
}

// Check for afternoon asymmetry relative to morning mirror
console.log('\n\nMorning vs Afternoon Asymmetry Check:');
console.log('='.repeat(70));
console.log('(Comparing afternoon hours with their morning mirrors)');
console.log('Hour 13 mirrors Hour 11, Hour 14 mirrors Hour 10, etc.\n');

for (let h = 13; h <= 17; h++) {
  const morningMirror = 24 - h;  // 13pm mirrors 11am, 14pm mirrors 10am, etc.
  const afternoonAvg = hourlyCounts[h] > 0 ? hourlyRadiation[h] / hourlyCounts[h] : 0;
  const morningAvg = hourlyCounts[morningMirror] > 0 ? hourlyRadiation[morningMirror] / hourlyCounts[morningMirror] : 0;

  const ratio = morningAvg > 0 ? (afternoonAvg / morningAvg * 100).toFixed(0) : 'N/A';
  const diff = afternoonAvg - morningAvg;

  let status = '';
  if (morningAvg > 0) {
    const asymRatio = afternoonAvg / morningAvg;
    if (asymRatio > 1.1) {
      status = `AFTERNOON ${((asymRatio-1)*100).toFixed(0)}% HIGHER`;
    } else if (asymRatio < 0.9) {
      status = `Morning ${((1-asymRatio)*100).toFixed(0)}% higher`;
    } else {
      status = 'Symmetric';
    }
  }

  console.log(`Hour ${h} (${afternoonAvg.toFixed(0).padStart(3)} W/m²) vs Hour ${morningMirror} (${morningAvg.toFixed(0).padStart(3)} W/m²) : ${ratio}% -> ${status}`);
}

// Now compare with historical CF pattern
console.log('\n\n=== Comparison with Historical Capacity Factor Profile ===');
console.log('If weather radiation is symmetric but CF forecast is NOT, the issue is in the model.\n');

// Try loading historical CF analysis
const cfacDir = 'Data Samples/Capacity Factor';
if (fs.existsSync(cfacDir)) {
  const cfHourly = {};
  const cfCounts = {};
  for (let h = 0; h < 24; h++) {
    cfHourly[h] = 0;
    cfCounts[h] = 0;
  }

  const files = fs.readdirSync(cfacDir).filter(f => f.endsWith('.csv'));

  // Get all station columns that are solar (ending with _S)
  for (const file of files) {
    const content = fs.readFileSync(path.join(cfacDir, file), 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());

    if (lines.length < 2) continue;

    const headers = lines[0].split(',').map(h => h.trim());
    const solarCols = headers.map((h, i) => ({ name: h, idx: i }))
      .filter(c => c.name.endsWith('_S'));

    if (solarCols.length === 0) continue;

    for (let i = 1; i < lines.length; i++) {
      const values = lines[i].split(',');
      if (values.length < 2) continue;

      const dateStr = values[0].trim();
      const match = dateStr.match(/\d+\/\d+\/\d+\s+(\d+):/);
      if (!match) continue;

      const hour = parseInt(match[1], 10);

      for (const col of solarCols) {
        if (values.length <= col.idx) continue;
        const cfac = parseFloat(values[col.idx]);
        if (!isNaN(cfac) && cfac >= 0 && cfac <= 1) {
          cfHourly[hour] += cfac;
          cfCounts[hour]++;
        }
      }
    }
  }

  console.log('Historical Solar CF vs Weather Radiation (normalized to H12 peak):');
  console.log('Hour   | Weather Rad | Historical CF | Ratio Analysis');
  console.log('-'.repeat(65));

  const peakRad = hourlyRadiation[12] / hourlyCounts[12];
  const peakCF = cfHourly[12] / cfCounts[12];

  for (let h = 6; h <= 18; h++) {
    const rad = hourlyCounts[h] > 0 ? hourlyRadiation[h] / hourlyCounts[h] : 0;
    const cf = cfCounts[h] > 0 ? cfHourly[h] / cfCounts[h] : 0;

    const radPct = (rad / peakRad * 100).toFixed(0);
    const cfPct = (cf / peakCF * 100).toFixed(0);

    const diff = parseInt(cfPct) - parseInt(radPct);
    let analysis = '';
    if (Math.abs(diff) > 10) {
      if (diff > 0) {
        analysis = `CF ${diff}% HIGHER than weather suggests`;
      } else {
        analysis = `CF ${-diff}% LOWER than weather suggests`;
      }
    } else {
      analysis = 'OK';
    }

    console.log(`H${h.toString().padStart(2)}   | ${radPct.padStart(4)}%       | ${cfPct.padStart(4)}%          | ${analysis}`);
  }

  // Afternoon asymmetry in CF
  console.log('\n\nHistorical CF Afternoon Asymmetry:');
  for (let h = 13; h <= 17; h++) {
    const morning = 24 - h;
    const afternoonCF = cfCounts[h] > 0 ? cfHourly[h] / cfCounts[h] : 0;
    const morningCF = cfCounts[morning] > 0 ? cfHourly[morning] / cfCounts[morning] : 0;
    const ratio = morningCF > 0 ? (afternoonCF / morningCF * 100).toFixed(0) : 'N/A';
    console.log(`Hour ${h} CF (${(afternoonCF*100).toFixed(1)}%) vs Hour ${morning} CF (${(morningCF*100).toFixed(1)}%): ${ratio}%`);
  }
}
