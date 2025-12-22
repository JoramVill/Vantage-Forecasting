/**
 * Find the 5pm spike in solar forecast
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

// Find a solar station to analyze
const solarStations = stationCodes.filter(c => isSolar(c));
console.log(`Sample solar station: ${solarStations[0]}\n`);

// Group by date, then by hour for first solar station
const stationIdx = stationCodes.indexOf(solarStations[0]);
const dailyData = {};

for (let i = 1; i < lines.length; i++) {
  const values = lines[i].split(',');
  if (values.length < 2) continue;

  const dateStr = values[0].trim();
  const match = dateStr.match(/(\d+)\/(\d+)\/(\d+)\s+(\d+):(\d+)/);
  if (!match) continue;

  const month = parseInt(match[1], 10);
  const day = parseInt(match[2], 10);
  const year = parseInt(match[3], 10);
  const hour = parseInt(match[4], 10);

  const dateKey = `${year}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`;

  const cfac = parseFloat(values[stationIdx + 1]);
  if (isNaN(cfac)) continue;

  if (!dailyData[dateKey]) {
    dailyData[dateKey] = {};
  }
  dailyData[dateKey][hour] = cfac;
}

// Look at hours 14-19 for each day
console.log('Checking for 5pm spike pattern (hours 14-19):');
console.log('Date       | H14   | H15   | H16   | H17   | H18   | Spike at 17?');
console.log('='.repeat(70));

let spikeCount = 0;
const sortedDates = Object.keys(dailyData).sort();

for (const date of sortedDates.slice(0, 15)) {  // First 15 days
  const data = dailyData[date];
  const h14 = data[14]?.toFixed(3) || 'N/A';
  const h15 = data[15]?.toFixed(3) || 'N/A';
  const h16 = data[16]?.toFixed(3) || 'N/A';
  const h17 = data[17]?.toFixed(3) || 'N/A';
  const h18 = data[18]?.toFixed(3) || 'N/A';

  // Check for spike (hour 17 > hour 16)
  const isSpike = data[17] > data[16];
  if (isSpike) spikeCount++;

  console.log(`${date} | ${h14} | ${h15} | ${h16} | ${h17} | ${h18} | ${isSpike ? '<-- SPIKE' : ''}`);
}

console.log(`\nSpikes found in first 15 days: ${spikeCount}`);

// Also check average pattern for ALL solar stations combined per day
console.log('\n\nAggregate all solar stations - checking for afternoon spikes:');
console.log('-'.repeat(70));

const solarIndices = solarStations.map(s => stationCodes.indexOf(s));
const dailyHourlyAvg = {};

for (let i = 1; i < lines.length; i++) {
  const values = lines[i].split(',');
  if (values.length < 2) continue;

  const dateStr = values[0].trim();
  const match = dateStr.match(/(\d+)\/(\d+)\/(\d+)\s+(\d+):(\d+)/);
  if (!match) continue;

  const day = parseInt(match[2], 10);
  const hour = parseInt(match[4], 10);
  const dateKey = `Dec ${day}`;

  if (!dailyHourlyAvg[dateKey]) {
    dailyHourlyAvg[dateKey] = { sums: {}, counts: {} };
  }

  for (const idx of solarIndices) {
    const cfac = parseFloat(values[idx + 1]);
    if (!isNaN(cfac) && cfac >= 0) {
      dailyHourlyAvg[dateKey].sums[hour] = (dailyHourlyAvg[dateKey].sums[hour] || 0) + cfac;
      dailyHourlyAvg[dateKey].counts[hour] = (dailyHourlyAvg[dateKey].counts[hour] || 0) + 1;
    }
  }
}

console.log('Day    | H14   | H15   | H16   | H17   | H18   | Spike?');
for (let d = 1; d <= 10; d++) {
  const dateKey = `Dec ${d}`;
  const data = dailyHourlyAvg[dateKey];
  if (!data) continue;

  const getAvg = (h) => {
    if (!data.counts[h]) return 'N/A';
    return (data.sums[h] / data.counts[h]).toFixed(3);
  };

  const h14 = getAvg(14);
  const h15 = getAvg(15);
  const h16 = getAvg(16);
  const h17 = getAvg(17);
  const h18 = getAvg(18);

  const avg16 = data.counts[16] ? data.sums[16] / data.counts[16] : 0;
  const avg17 = data.counts[17] ? data.sums[17] / data.counts[17] : 0;
  const isSpike = avg17 > avg16;

  console.log(`${dateKey.padEnd(6)} | ${h14} | ${h15} | ${h16} | ${h17} | ${h18} | ${isSpike ? '<-- SPIKE' : ''}`);
}
