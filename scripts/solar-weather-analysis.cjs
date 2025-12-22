/**
 * Solar Weather Analysis
 * Analyze solarradiation vs solarenergy and correlation with actual capacity factor
 */

const { readFileSync, readdirSync, existsSync } = require('fs');
const { join } = require('path');
const { DateTime } = require('luxon');

// Parse CSV line handling quoted values
function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current.trim());
  return result;
}

// Pearson correlation
function pearsonCorrelation(x, y) {
  const n = x.length;
  if (n !== y.length || n === 0) return 0;

  const sumX = x.reduce((a, b) => a + b, 0);
  const sumY = y.reduce((a, b) => a + b, 0);
  const sumXY = x.reduce((sum, xi, i) => sum + xi * y[i], 0);
  const sumX2 = x.reduce((sum, xi) => sum + xi * xi, 0);
  const sumY2 = y.reduce((sum, yi) => sum + yi * yi, 0);

  const numerator = n * sumXY - sumX * sumY;
  const denominator = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));

  if (denominator === 0) return 0;
  return numerator / denominator;
}

// Load cluster weather data
function loadClusterWeather(clusterId) {
  const clusterDir = join(process.cwd(), 'weather_cache', clusterId);
  if (!existsSync(clusterDir)) return new Map();

  const weatherMap = new Map();
  const months = readdirSync(clusterDir).filter(d => d.startsWith('2025-'));

  for (const month of months) {
    const monthDir = join(clusterDir, month);
    if (!existsSync(monthDir)) continue;

    const files = readdirSync(monthDir).filter(f => f.endsWith('.csv'));

    for (const file of files) {
      const content = readFileSync(join(monthDir, file), 'utf-8');
      const lines = content.split('\n').filter(l => l.trim());

      if (lines.length < 2) continue;

      const headers = parseCSVLine(lines[0]).map(h => h.toLowerCase());
      const datetimeIdx = headers.indexOf('datetime');
      const solarradiationIdx = headers.indexOf('solarradiation');
      const solarenergyIdx = headers.indexOf('solarenergy');
      const cloudcoverIdx = headers.indexOf('cloudcover');
      const tempIdx = headers.indexOf('temp');
      const uvindexIdx = headers.indexOf('uvindex');
      const humidityIdx = headers.indexOf('humidity');

      for (let i = 1; i < lines.length; i++) {
        const values = parseCSVLine(lines[i]);
        if (values.length < headers.length) continue;

        const datetimeStr = values[datetimeIdx];
        const dt = DateTime.fromISO(datetimeStr).plus({ hours: 1 }); // Hour-ending
        if (!dt.isValid) continue;

        const key = dt.toFormat('yyyy-MM-dd HH:mm');

        weatherMap.set(key, {
          datetime: dt.toJSDate(),
          hour: dt.hour,
          solarradiation: parseFloat(values[solarradiationIdx]) || 0,
          solarenergy: parseFloat(values[solarenergyIdx]) || 0,
          cloudcover: parseFloat(values[cloudcoverIdx]) || 0,
          temperature: parseFloat(values[tempIdx]) || 25,
          uvindex: uvindexIdx >= 0 ? parseFloat(values[uvindexIdx]) || 0 : 0,
          humidity: humidityIdx >= 0 ? parseFloat(values[humidityIdx]) || 0 : 50
        });
      }
    }
  }

  return weatherMap;
}

// Load capacity factors for solar stations
function loadSolarCapacityFactors() {
  const cfacDir = join(process.cwd(), 'Data Samples', 'Capacity Factor');
  const stationData = new Map();

  const files = readdirSync(cfacDir).filter(f => f.toLowerCase().endsWith('.csv'));

  for (const file of files) {
    const content = readFileSync(join(cfacDir, file), 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());
    if (lines.length < 2) continue;

    const headers = lines[0].split(',').map(h => h.trim());

    // Solar stations
    const solarStations = headers.filter(h =>
      h.endsWith('_S') ||
      ['01CLARK', '01HERMOSA', '01LIMAY', '01CAYANGA', '06HELIOS', '06CADIZ'].includes(h)
    );

    for (const station of solarStations) {
      if (!stationData.has(station)) {
        stationData.set(station, new Map());
      }

      const idx = headers.indexOf(station);
      if (idx < 0) continue;

      for (let i = 1; i < lines.length; i++) {
        const values = lines[i].split(',').map(v => v.trim());
        if (values.length <= idx) continue;

        const cfac = parseFloat(values[idx]);
        if (isNaN(cfac) || cfac < 0 || cfac > 1) continue;

        const dt = DateTime.fromFormat(values[0], 'M/d/yyyy HH:mm');
        if (!dt.isValid) continue;

        const key = dt.toFormat('yyyy-MM-dd HH:mm');
        stationData.get(station).set(key, cfac);
      }
    }
  }

  return stationData;
}

// Main analysis
async function main() {
  console.log('');
  console.log('='.repeat(80));
  console.log('SOLAR WEATHER DATA ANALYSIS');
  console.log('='.repeat(80));
  console.log('');

  // Load cluster weather (use a representative solar cluster)
  const solarClusters = [
    'PAMPANGA_SOLAR',
    'BATANGAS_SOLAR',
    'NCR_SOLAR',
    'NEGROS_SOLAR',
    'CEBU_SOLAR'
  ];

  let weatherData = new Map();
  for (const cluster of solarClusters) {
    const data = loadClusterWeather(cluster);
    if (data.size > weatherData.size) {
      weatherData = data;
      console.log(`Using cluster: ${cluster} (${data.size} records)`);
    }
  }

  if (weatherData.size === 0) {
    console.log('No cluster weather data found. Checking per-station data...');
    // Try per-station data
    const stationDirs = readdirSync(join(process.cwd(), 'weather_cache'))
      .filter(d => d.startsWith('station_01CLARK') || d.startsWith('station_01HERMOSA'));

    for (const dir of stationDirs) {
      console.log(`Found per-station dir: ${dir}`);
    }
  }

  // Load capacity factors
  console.log('');
  console.log('Loading capacity factor data...');
  const cfacData = loadSolarCapacityFactors();
  console.log(`Loaded ${cfacData.size} solar stations`);

  // Analyze solarradiation vs solarenergy consistency
  console.log('');
  console.log('='.repeat(80));
  console.log('SOLAR RADIATION VS SOLAR ENERGY ANALYSIS');
  console.log('='.repeat(80));
  console.log('');
  console.log('Visual Crossing provides two solar metrics:');
  console.log('  - solarradiation: Instantaneous irradiance (W/m²)');
  console.log('  - solarenergy: Cumulative energy over the hour (MJ/m²)');
  console.log('');
  console.log('Theoretical relationship: solarenergy ≈ solarradiation * 3600 / 1e6');
  console.log('  (since 1 W = 1 J/s, and 1 hour = 3600 seconds)');
  console.log('');

  // Sample data from daylight hours
  const daylightSamples = [];
  for (const [key, wx] of weatherData) {
    if (wx.hour >= 6 && wx.hour <= 18 && wx.solarradiation > 10) {
      daylightSamples.push(wx);
    }
  }

  if (daylightSamples.length > 0) {
    // Calculate consistency
    let totalError = 0;
    let ratios = [];

    for (const wx of daylightSamples) {
      // Expected solarenergy from solarradiation
      const expectedEnergy = wx.solarradiation * 3600 / 1e6;
      const ratio = wx.solarenergy > 0 ? wx.solarradiation * 3600 / 1e6 / wx.solarenergy : 0;
      if (ratio > 0) {
        ratios.push(ratio);
      }
    }

    if (ratios.length > 0) {
      const avgRatio = ratios.reduce((a, b) => a + b, 0) / ratios.length;
      console.log(`Daylight samples: ${daylightSamples.length}`);
      console.log(`Average ratio (expected/actual energy): ${avgRatio.toFixed(3)}`);
      console.log('  (1.0 = perfectly consistent, >1 = solarenergy under-reports, <1 = over-reports)');
    }

    // Sample output
    console.log('');
    console.log('Sample hourly data (daylight hours):');
    console.log('-'.repeat(80));
    console.log('DateTime'.padEnd(20) + 'SolRad(W/m²)'.padStart(15) + 'SolEnergy(MJ/m²)'.padStart(18) + 'ExpectedEnergy'.padStart(15) + 'CloudCover'.padStart(12));
    console.log('-'.repeat(80));

    for (const wx of daylightSamples.slice(0, 15)) {
      const dt = DateTime.fromJSDate(wx.datetime);
      const expected = (wx.solarradiation * 3600 / 1e6).toFixed(2);
      console.log(
        dt.toFormat('yyyy-MM-dd HH:mm').padEnd(20) +
        wx.solarradiation.toFixed(1).padStart(15) +
        wx.solarenergy.toFixed(2).padStart(18) +
        expected.padStart(15) +
        (wx.cloudcover.toFixed(0) + '%').padStart(12)
      );
    }
    console.log('-'.repeat(80));
  }

  // Correlation analysis with capacity factor
  console.log('');
  console.log('='.repeat(80));
  console.log('CORRELATION WITH CAPACITY FACTOR');
  console.log('='.repeat(80));
  console.log('');

  // Pick a few stations with good data
  const testStations = ['01CLARK', '01HERMOSA_S', '06HELIOS', '02DOLORES_S', '01SNTGO_S'];

  for (const station of testStations) {
    const stationCfac = cfacData.get(station);
    if (!stationCfac || stationCfac.size < 100) continue;

    // Join with weather data
    const solarRad = [];
    const solarEn = [];
    const cloudCov = [];
    const cfs = [];

    for (const [key, cfac] of stationCfac) {
      const wx = weatherData.get(key);
      if (!wx || wx.hour < 6 || wx.hour > 18) continue;

      if (cfac > 0 && wx.solarradiation > 0) {
        solarRad.push(wx.solarradiation);
        solarEn.push(wx.solarenergy * 1e6 / 3600); // Convert to W/m² equivalent
        cloudCov.push(wx.cloudcover);
        cfs.push(cfac);
      }
    }

    if (cfs.length < 100) continue;

    const corrRad = pearsonCorrelation(solarRad, cfs);
    const corrEnergy = pearsonCorrelation(solarEn, cfs);
    const corrCloud = pearsonCorrelation(cloudCov, cfs);

    console.log(`${station}:`);
    console.log(`  Samples: ${cfs.length}`);
    console.log(`  Correlation with solarradiation: ${corrRad.toFixed(4)}`);
    console.log(`  Correlation with solarenergy:    ${corrEnergy.toFixed(4)}`);
    console.log(`  Correlation with cloudcover:     ${corrCloud.toFixed(4)}`);
    console.log('');
  }

  // Analysis of under-prediction issue
  console.log('='.repeat(80));
  console.log('UNDER-PREDICTION ANALYSIS');
  console.log('='.repeat(80));
  console.log('');
  console.log('The solar model under-predicts because:');
  console.log('');
  console.log('1. Visual Crossing solar radiation may be satellite-derived estimates');
  console.log('   that differ from actual ground-level irradiance');
  console.log('');
  console.log('2. Local atmospheric conditions (aerosols, water vapor) affect');
  console.log('   actual irradiance but may not be captured in the weather data');
  console.log('');
  console.log('Premium data elements that could help:');
  console.log('  - uvindex: Correlates with clear-sky conditions');
  console.log('  - humidity: Affects atmospheric absorption');
  console.log('  - visibility: Indicates aerosol/haze levels');
  console.log('  - conditions: Text description of sky conditions');
  console.log('');
}

main().catch(console.error);
