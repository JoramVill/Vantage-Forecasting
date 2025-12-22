const fs = require('fs');
const { parse } = require('csv-parse/sync');

// Read training data
const files = [
  'Data Samples/Capacity Factor/MRHCFac_HIST_JULY.csv',
  'Data Samples/Capacity Factor/MRHCFac_HIST_AUG.csv',
  'Data Samples/Capacity Factor/MRHCFac_HIST_SEP.csv',
  'Data Samples/Capacity Factor/MRHCFac_HIST_OCT.csv',
  'Data Samples/Capacity Factor/MRHCFac_HIST_NOV.csv'
];

// Read weather data for ILOCOS_NORTE_WIND cluster (for 01LAOAG)
const weatherDir = 'weather_cache/ILOCOS_NORTE_WIND';

const windStations = ['01BURGOS', '01LAOAG', '01PAGUDPUD'];

console.log('═══════════════════════════════════════════════════════════════════════════════');
console.log('         TRAINING DATA PEAK ANALYSIS');
console.log('═══════════════════════════════════════════════════════════════════════════════\n');

// Load all capacity factor data
const cfData = {};
for (const file of files) {
  const raw = fs.readFileSync(file, 'utf8');
  const rows = parse(raw, { columns: true });

  for (const row of rows) {
    const dt = row['DateTimeEnding'];
    if (!dt) continue;

    const parts = dt.match(/(\d+)\/(\d+)\/(\d+)\s+(\d+):(\d+)/);
    if (!parts) continue;
    const [_, month, day, year, hour, min] = parts;
    const date = new Date(year, month-1, day, hour, min);
    const key = date.toISOString();

    for (const station of windStations) {
      const cf = parseFloat(row[station]);
      if (!isNaN(cf)) {
        if (!cfData[station]) cfData[station] = {};
        cfData[station][key] = cf;
      }
    }
  }
}

// Load weather data (recursive through subdirs)
const weatherData = {};
const monthDirs = fs.readdirSync(weatherDir).filter(f => f.startsWith('2025-'));

for (const monthDir of monthDirs) {
  const monthPath = `${weatherDir}/${monthDir}`;
  const weatherFiles = fs.readdirSync(monthPath).filter(f => f.endsWith('.csv'));

  for (const wf of weatherFiles) {
    const raw = fs.readFileSync(`${monthPath}/${wf}`, 'utf8');
    const rows = parse(raw, { columns: true });

    for (const row of rows) {
      const dt = row['datetime'];
      if (!dt) continue;

      // Weather is hour-starting, CF is hour-ending
      // Add 1 hour to align
      const date = new Date(dt);
      date.setHours(date.getHours() + 1);
      const key = date.toISOString();

      const wind100 = parseFloat(row['windspeed100']);
      const windGust = parseFloat(row['windgust']);

      if (!isNaN(wind100)) {
        weatherData[key] = { wind100, windGust };
      }
    }
  }
}

console.log(`Loaded ${Object.keys(weatherData).length} weather records`);

// Analyze each station
for (const station of windStations) {
  const stationCF = cfData[station];
  if (!stationCF) continue;

  // Match CF with weather
  const pairs = [];
  for (const [key, cf] of Object.entries(stationCF)) {
    const weather = weatherData[key];
    if (weather) {
      pairs.push({ cf, wind: weather.wind100, gust: weather.windGust });
    }
  }

  console.log(`\n📍 ${station} (${pairs.length} matched samples)`);
  console.log('─'.repeat(60));

  // Sort by CF to find peaks
  pairs.sort((a, b) => b.cf - a.cf);

  // Get peak stats (top 10%)
  const top10Pct = Math.ceil(pairs.length * 0.1);
  const peaks = pairs.slice(0, top10Pct);

  const peakCFAvg = peaks.reduce((s, p) => s + p.cf, 0) / peaks.length;
  const peakWindAvg = peaks.reduce((s, p) => s + p.wind, 0) / peaks.length;
  const peakWindMax = Math.max(...peaks.map(p => p.wind));
  const peakWindMin = Math.min(...peaks.map(p => p.wind));

  console.log(`  Peak CF avg:     ${peakCFAvg.toFixed(3)}`);
  console.log(`  Peak wind avg:   ${peakWindAvg.toFixed(1)} m/s`);
  console.log(`  Peak wind range: ${peakWindMin.toFixed(1)} - ${peakWindMax.toFixed(1)} m/s`);

  // Show wind speed distribution for different CF ranges
  const cfRanges = [
    { min: 0.7, max: 1.0, label: 'CF 0.7-1.0 (peaks)' },
    { min: 0.5, max: 0.7, label: 'CF 0.5-0.7 (high)' },
    { min: 0.3, max: 0.5, label: 'CF 0.3-0.5 (medium)' },
    { min: 0.1, max: 0.3, label: 'CF 0.1-0.3 (low)' },
  ];

  console.log('\n  Wind speed by CF range:');
  for (const range of cfRanges) {
    const inRange = pairs.filter(p => p.cf >= range.min && p.cf < range.max);
    if (inRange.length > 0) {
      const avgWind = inRange.reduce((s, p) => s + p.wind, 0) / inRange.length;
      const minWind = Math.min(...inRange.map(p => p.wind));
      const maxWind = Math.max(...inRange.map(p => p.wind));
      console.log(`  ${range.label}: avg=${avgWind.toFixed(1)} m/s, range=${minWind.toFixed(1)}-${maxWind.toFixed(1)} m/s (n=${inRange.length})`);
    }
  }

  // Show top 10 individual peaks
  console.log('\n  Top 10 actual peaks:');
  console.log('  CF      │ Wind (m/s) │ Gust (m/s)');
  console.log('  ' + '─'.repeat(40));
  for (let i = 0; i < Math.min(10, peaks.length); i++) {
    const p = peaks[i];
    console.log(`  ${p.cf.toFixed(4)} │ ${p.wind.toFixed(1).padStart(10)} │ ${p.gust.toFixed(1).padStart(10)}`);
  }

  // Check: what's the EXPECTED CF based on MREC at peak wind speeds?
  // MREC formula: CF = MRec × windSpeed
  // For LAOAG, MRecM = 0.0098 (mid tier)
  console.log(`\n  MREC analysis:`);
  console.log(`  If MRec = 0.01 and wind = ${peakWindAvg.toFixed(1)} m/s`);
  console.log(`  MREC prediction = ${(0.01 * peakWindAvg).toFixed(3)}`);
  console.log(`  Actual peak avg = ${peakCFAvg.toFixed(3)}`);
  console.log(`  Required multiplier = ${(peakCFAvg / (0.01 * peakWindAvg)).toFixed(2)}x`);
}
