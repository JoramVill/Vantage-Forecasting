const fs = require('fs');
const path = require('path');

// Physics model simulation
const IRRADIANCE_SCALE = 1.4;
const SYSTEM_EFFICIENCY = 0.92;
const TEMP_COEFF = -0.004;
const TEMP_REF = 25;

function predictPhysics(solarRadiation, temperature) {
  if (solarRadiation <= 0) return 0;
  const scaledRadiation = solarRadiation * IRRADIANCE_SCALE;
  const baseOutput = scaledRadiation / 1000;
  const tempDelta = temperature - TEMP_REF;
  const tempFactor = 1 + (TEMP_COEFF * tempDelta);
  let cfac = baseOutput * tempFactor * SYSTEM_EFFICIENCY;
  return Math.max(0, Math.min(1, cfac));
}

// Parse CSV properly with quote handling
function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (const char of line) {
    if (char === '"') { inQuotes = !inQuotes; }
    else if (char === ',' && !inQuotes) { result.push(current.trim()); current = ''; }
    else { current += char; }
  }
  result.push(current.trim());
  return result;
}

// Load December weather for 01SNMANUEL_S
function loadWeather(monthDir) {
  const base = 'weather_cache/SOLAR_01SNMANUEL_S/' + monthDir;
  const weatherByDate = new Map();

  const files = fs.readdirSync(base);
  for (const f of files) {
    const content = fs.readFileSync(path.join(base, f), 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());
    const headers = parseCSVLine(lines[0]).map(h => h.toLowerCase());
    const dtIdx = headers.indexOf('datetime');
    const srIdx = headers.indexOf('solarradiation');
    const tempIdx = headers.indexOf('temp');

    for (let i = 1; i < lines.length; i++) {
      const vals = parseCSVLine(lines[i]);
      const dt = vals[dtIdx];
      const sr = parseFloat(vals[srIdx]) || 0;
      const temp = parseFloat(vals[tempIdx]) || 25;
      weatherByDate.set(dt, { solarRadiation: sr, temp });
    }
  }
  return weatherByDate;
}

// Load December actual CFs for 01SNMANUEL_S
const cfacContent = fs.readFileSync('Data Samples/Capacity Factor/MRHCFac_HIST_DEC.csv', 'utf-8');
const cfacLines = cfacContent.split('\n').filter(l => l.trim());
const cfacHeaders = cfacLines[0].split(',').map(h => h.trim());
const stationIdx = cfacHeaders.indexOf('01SNMANUEL_S');

const decWeather = loadWeather('2025-12');

console.log('Training data analysis for 01SNMANUEL_S (December 2025)');
console.log('=========================================================');
console.log('');
console.log('Date        | Hour | Weather SR | Temp  | Physics | Actual | Residual');
console.log('------------|------|------------|-------|---------|--------|----------');

let totalResidual = 0;
let residualCount = 0;
let noonResiduals = [];

for (let i = 1; i < cfacLines.length; i++) {
  const vals = cfacLines[i].split(',');
  const dtStr = vals[0]; // M/d/yyyy HH:mm
  const actualCF = parseFloat(vals[stationIdx]) || 0;

  // Convert to ISO format for weather lookup
  const [datePart, timePart] = dtStr.split(' ');
  const [month, day, year] = datePart.split('/');
  const [hour, min] = timePart.split(':');
  const isoDate = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}T${hour.padStart(2, '0')}:00:00`;

  const weather = decWeather.get(isoDate);
  if (!weather) continue;

  const hourNum = parseInt(hour);

  // Only look at daylight hours (where physics prediction is meaningful)
  if (hourNum >= 6 && hourNum <= 18 && weather.solarRadiation > 0) {
    const physicsPred = predictPhysics(weather.solarRadiation, weather.temp);
    const residual = actualCF - physicsPred;

    if (actualCF > 0.05) {  // Skip outage hours
      totalResidual += residual;
      residualCount++;

      // Show a sample of noon hours (12:00)
      if (hourNum === 12 && noonResiduals.length < 10) {
        console.log(`${dtStr.padEnd(12)}| ${hourNum.toString().padStart(4)} | ${weather.solarRadiation.toFixed(1).padStart(10)} | ${weather.temp.toFixed(1).padStart(5)} | ${(physicsPred*100).toFixed(1).padStart(7)}% | ${(actualCF*100).toFixed(1).padStart(6)}% | ${(residual*100).toFixed(1)}%`);
        noonResiduals.push(residual);
      }
    }
  }
}

console.log('');
console.log('Summary:');
console.log(`  Total daylight samples: ${residualCount}`);
console.log(`  Average residual: ${(totalResidual/residualCount*100).toFixed(1)}%`);
console.log(`  Average noon residual: ${(noonResiduals.reduce((a,b)=>a+b,0)/noonResiduals.length*100).toFixed(1)}%`);
console.log('');
console.log('If residual is negative, physics OVER-predicts → model learns to subtract');
console.log('If residual is positive, physics UNDER-predicts → model learns to add');
