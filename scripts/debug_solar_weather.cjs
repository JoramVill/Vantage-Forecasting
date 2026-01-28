const fs = require('fs');
const path = require('path');

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

function getNoonData(filepath) {
  const content = fs.readFileSync(filepath, 'utf-8');
  const lines = content.split('\n').filter(l => l.trim());
  const hdr = parseCSVLine(lines[0]).map(h => h.toLowerCase());
  const srIdx = hdr.indexOf('solarradiation');
  const vals = parseCSVLine(lines[13]); // line 13 is hour 12:00
  return parseFloat(vals[srIdx]) || 0;
}

// Compare training vs forecast periods
const base = 'weather_cache/SOLAR_01SNMANUEL_S';
const months = ['2025-07', '2025-08', '2025-09', '2025-10', '2025-11', '2025-12', '2026-01'];

console.log('Average noon solar radiation by month for 01SNMANUEL_S:');
console.log('Month    | Avg Solar (W/m2) | Days');
console.log('---------|------------------|------');

for (const month of months) {
  const dir = path.join(base, month);
  if (!fs.existsSync(dir)) continue;

  const files = fs.readdirSync(dir);
  let sum = 0, count = 0;

  for (const f of files) {
    try {
      const sr = getNoonData(path.join(dir, f));
      if (sr > 0) { sum += sr; count++; }
    } catch (e) {}
  }

  if (count > 0) {
    console.log(month + ' |      ' + (sum/count).toFixed(1).padStart(6) + '       | ' + count);
  }
}

// Now check actual CF vs physics prediction correlation for training data
console.log('\n--- Checking if training actuals match weather data ---');

// Load December training actuals
const cfacContent = fs.readFileSync('Data Samples/Capacity Factor/MRHCFac_HIST-14D-0101.csv', 'utf-8');
const cfacLines = cfacContent.split('\n').filter(l => l.trim());
const cfacHeaders = cfacLines[0].split(',').map(h => h.trim());
const stationIdx = cfacHeaders.indexOf('01SNMANUEL_S');

// Get Dec 2025 actuals
const decRecords = [];
for (let i = 1; i < cfacLines.length; i++) {
  const vals = cfacLines[i].split(',');
  const dt = vals[0];
  if (dt.includes('12/') && dt.includes('/2025')) {
    const cf = parseFloat(vals[stationIdx]) || 0;
    const hour = parseInt(dt.split(' ')[1].split(':')[0]);
    if (hour === 12 && cf > 0) {
      decRecords.push({ date: dt, cf });
    }
  }
}

console.log('December 2025 noon actual CFs for 01SNMANUEL_S:');
for (const r of decRecords.slice(0, 5)) {
  console.log('  ' + r.date + ' -> ' + (r.cf * 100).toFixed(1) + '%');
}
if (decRecords.length > 5) {
  console.log('  ... (' + decRecords.length + ' total noon records)');
}

// Calculate average December actual
const avgDecCF = decRecords.reduce((s, r) => s + r.cf, 0) / decRecords.length;
console.log('\nAverage Dec 2025 noon actual CF: ' + (avgDecCF * 100).toFixed(1) + '%');
