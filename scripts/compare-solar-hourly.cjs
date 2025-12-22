/**
 * Compare forecast hourly pattern vs historical
 */
const fs = require('fs');
const path = require('path');

// Solar station detection
function isSolar(code) {
  const c = code.toUpperCase();
  return c.endsWith('_S') ||
    c.includes('SOLAR') ||
    ['01CAYANGA', '01CLARK', '01HERMOSA', '01LIMAY', '01SNMARCELINO', '01SNRAFAEL',
     '01SNTGO', '03CALAMBA', '03CLACA', '03DASMAEHV', '05CALUNG', '06HELIOS',
     '11KIBAW', '01CURIMAO', '01PASUQUIN', '01BOTOLAN'].includes(c);
}

// Read forecast
const forecastFile = 'output/cfac_december_2025.csv';
const content = fs.readFileSync(forecastFile, 'utf-8');
const lines = content.split('\n').filter(l => l.trim());

const headers = lines[0].split(',').map(h => h.trim());
const stationCodes = headers.slice(1);

// Find solar stations
const solarIndices = [];
stationCodes.forEach((code, idx) => {
  if (isSolar(code)) {
    solarIndices.push(idx);
  }
});

console.log(`Analyzing ${solarIndices.length} solar stations in forecast\n`);

// Aggregate by hour
const hourlyForecast = {};
const hourlyCounts = {};
for (let h = 0; h < 24; h++) {
  hourlyForecast[h] = 0;
  hourlyCounts[h] = 0;
}

for (let i = 1; i < lines.length; i++) {
  const values = lines[i].split(',');
  if (values.length < 2) continue;

  const dateStr = values[0].trim();
  const match = dateStr.match(/(\d+)\/(\d+)\/(\d+)\s+(\d+):(\d+)/);
  if (!match) continue;

  const hour = parseInt(match[4], 10);

  for (const idx of solarIndices) {
    const cfac = parseFloat(values[idx + 1]);
    if (!isNaN(cfac) && cfac >= 0 && cfac <= 1) {
      hourlyForecast[hour] += cfac;
      hourlyCounts[hour]++;
    }
  }
}

// Historical averages (from previous analysis)
const historical = {
  5: 0.029, 6: 0.031, 7: 0.061, 8: 0.160, 9: 0.277, 10: 0.361,
  11: 0.412, 12: 0.429, 13: 0.418, 14: 0.371, 15: 0.299, 16: 0.201,
  17: 0.101, 18: 0.040, 19: 0.029
};

console.log('Hour | Historical | Forecast | Difference | Issue?');
console.log('='.repeat(60));

for (let h = 5; h <= 19; h++) {
  const hist = historical[h] || 0;
  const fcst = hourlyCounts[h] > 0 ? hourlyForecast[h] / hourlyCounts[h] : 0;
  const diff = fcst - hist;
  const diffPct = hist > 0 ? (diff / hist * 100).toFixed(0) : 'N/A';
  const issue = Math.abs(diff) > 0.05 ? '<-- ISSUE' : '';

  console.log(
    `  ${h.toString().padStart(2)} |   ${hist.toFixed(3)}    |  ${fcst.toFixed(3)}   | ${diff >= 0 ? '+' : ''}${diff.toFixed(3)} (${diffPct}%) ${issue}`
  );
}

// Check for anomalous spikes relative to neighbors
console.log('\n\nChecking for spikes (forecast value higher than both neighbors):');
console.log('-'.repeat(60));

for (let h = 6; h <= 18; h++) {
  const prev = hourlyCounts[h-1] > 0 ? hourlyForecast[h-1] / hourlyCounts[h-1] : 0;
  const curr = hourlyCounts[h] > 0 ? hourlyForecast[h] / hourlyCounts[h] : 0;
  const next = hourlyCounts[h+1] > 0 ? hourlyForecast[h+1] / hourlyCounts[h+1] : 0;

  if (curr > prev && curr > next && h !== 12) {
    console.log(`Hour ${h}: ${curr.toFixed(3)} (prev=${prev.toFixed(3)}, next=${next.toFixed(3)}) <-- SPIKE`);
  }
}
