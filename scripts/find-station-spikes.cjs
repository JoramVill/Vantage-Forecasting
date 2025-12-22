/**
 * Find which stations have 5pm spikes
 */
const fs = require('fs');

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
const solarStations = stationCodes.filter(c => isSolar(c));

// For each station, calculate average CFac per hour
const stationHourlyAvg = {};

for (const station of solarStations) {
  stationHourlyAvg[station] = { sums: {}, counts: {} };
  for (let h = 0; h < 24; h++) {
    stationHourlyAvg[station].sums[h] = 0;
    stationHourlyAvg[station].counts[h] = 0;
  }
}

const stationIdx = {};
solarStations.forEach(s => {
  stationIdx[s] = stationCodes.indexOf(s);
});

for (let i = 1; i < lines.length; i++) {
  const values = lines[i].split(',');
  if (values.length < 2) continue;

  const dateStr = values[0].trim();
  const match = dateStr.match(/(\d+)\/(\d+)\/(\d+)\s+(\d+):(\d+)/);
  if (!match) continue;

  const hour = parseInt(match[4], 10);

  for (const station of solarStations) {
    const cfac = parseFloat(values[stationIdx[station] + 1]);
    if (!isNaN(cfac) && cfac >= 0) {
      stationHourlyAvg[station].sums[hour] += cfac;
      stationHourlyAvg[station].counts[hour]++;
    }
  }
}

// Check for stations with hour 15 spike (higher than hour 14 AND hour 16)
console.log('Stations with anomalous patterns (H15 > H14 OR H16 > H15):');
console.log('='.repeat(80));

const anomalies = [];

for (const station of solarStations) {
  const data = stationHourlyAvg[station];
  const getAvg = (h) => data.counts[h] > 0 ? data.sums[h] / data.counts[h] : 0;

  const h14 = getAvg(14);
  const h15 = getAvg(15);
  const h16 = getAvg(16);
  const h17 = getAvg(17);
  const h18 = getAvg(18);

  // Check various anomaly patterns
  const issues = [];
  if (h15 > h14) issues.push('H15>H14');
  if (h16 > h15) issues.push('H16>H15');
  if (h17 > h16) issues.push('H17>H16');
  if (h18 > h17) issues.push('H18>H17');

  if (issues.length > 0) {
    anomalies.push({
      station,
      h14, h15, h16, h17, h18,
      issues: issues.join(', ')
    });
  }
}

console.log(`Found ${anomalies.length} stations with afternoon anomalies:\n`);

for (const a of anomalies) {
  console.log(`${a.station.padEnd(20)} H14:${a.h14.toFixed(3)} H15:${a.h15.toFixed(3)} H16:${a.h16.toFixed(3)} H17:${a.h17.toFixed(3)} H18:${a.h18.toFixed(3)} [${a.issues}]`);
}

// Also show the normal pattern for comparison (stations with proper decay)
console.log('\n\nNormal stations (for comparison):');
const normal = solarStations.filter(s => !anomalies.find(a => a.station === s)).slice(0, 5);
for (const station of normal) {
  const data = stationHourlyAvg[station];
  const getAvg = (h) => data.counts[h] > 0 ? data.sums[h] / data.counts[h] : 0;
  console.log(`${station.padEnd(20)} H14:${getAvg(14).toFixed(3)} H15:${getAvg(15).toFixed(3)} H16:${getAvg(16).toFixed(3)} H17:${getAvg(17).toFixed(3)} H18:${getAvg(18).toFixed(3)}`);
}
