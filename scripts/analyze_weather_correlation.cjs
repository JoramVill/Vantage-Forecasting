/**
 * Weather-Demand Correlation Analysis Script
 *
 * Analyzes which cities' weather patterns correlate most strongly with zone demand.
 * Used to identify optimal weather sampling locations for demand forecasting.
 *
 * Usage: node scripts/analyze_weather_correlation.cjs [zone_code]
 * Example: node scripts/analyze_weather_correlation.cjs 01NLUZ
 */

const axios = require('axios');
const Database = require('better-sqlite3');
const { parse } = require('csv-parse/sync');
const fs = require('fs');
const path = require('path');

// Configuration
const API_KEY = process.env.VISUAL_CROSSING_API_KEY || ''; // Set your API key
const CACHE_DIR = './weather_cache/correlation_analysis';
const DB_PATH = 'data/iload_zonal.db';

// Candidate cities for NLUZ expansion
const CANDIDATE_CITIES = {
  '01NLUZ': [
    // Existing cities
    { id: 'sanfernando', name: 'San Fernando, Pampanga', lat: 15.03, lon: 120.69, existing: true },
    { id: 'baguio', name: 'Baguio', lat: 16.41, lon: 120.60, existing: true },
    { id: 'tuguegarao', name: 'Tuguegarao', lat: 17.61, lon: 121.73, existing: true },
    // New candidate cities - Region I (Ilocos) coverage gap
    { id: 'laoag', name: 'Laoag', lat: 18.198, lon: 120.593, existing: false },
    { id: 'vigan', name: 'Vigan', lat: 17.5747, lon: 120.387, existing: false },
    // Additional Central Luzon coverage
    { id: 'angeles', name: 'Angeles City', lat: 15.145, lon: 120.5887, existing: false },
    { id: 'dagupan', name: 'Dagupan', lat: 16.0433, lon: 120.3337, existing: false },
    // Alternative Region II coverage
    { id: 'cauayan', name: 'Cauayan, Isabela', lat: 16.9303, lon: 121.7733, existing: false },
  ],
  '03SLUZ': [
    // Existing cities
    { id: 'batangas', name: 'Batangas', lat: 13.76, lon: 121.06, existing: true },
    { id: 'lucena', name: 'Lucena', lat: 13.93, lon: 121.62, existing: true },
    { id: 'legazpi', name: 'Legazpi', lat: 13.14, lon: 123.73, existing: true },
    // New candidate cities
    { id: 'calamba', name: 'Calamba', lat: 14.2117, lon: 121.1653, existing: false },
    { id: 'sanpablo', name: 'San Pablo', lat: 14.0689, lon: 121.3256, existing: false },
    { id: 'naga', name: 'Naga City', lat: 13.6192, lon: 123.1814, existing: false },
    { id: 'puertoprincesa', name: 'Puerto Princesa', lat: 9.7392, lon: 118.7353, existing: false },
  ]
};

// Pearson correlation coefficient
function pearsonCorrelation(x, y) {
  const n = x.length;
  if (n === 0 || n !== y.length) return 0;

  const meanX = x.reduce((a, b) => a + b, 0) / n;
  const meanY = y.reduce((a, b) => a + b, 0) / n;

  let numerator = 0;
  let denomX = 0;
  let denomY = 0;

  for (let i = 0; i < n; i++) {
    const dx = x[i] - meanX;
    const dy = y[i] - meanY;
    numerator += dx * dy;
    denomX += dx * dx;
    denomY += dy * dy;
  }

  const denom = Math.sqrt(denomX * denomY);
  return denom === 0 ? 0 : numerator / denom;
}

// Compute Cooling Degree Hours (CDH) - base 24°C
function computeCDH(temp) {
  return Math.max(0, temp - 24);
}

// Fetch weather data for a city
async function fetchWeatherData(city, startDate, endDate) {
  const cacheFile = path.join(CACHE_DIR, `${city.id}_${startDate}_${endDate}.csv`);

  // Check cache
  if (fs.existsSync(cacheFile)) {
    console.log(`  [CACHE] Loading ${city.name} from cache`);
    const content = fs.readFileSync(cacheFile, 'utf-8');
    return parseWeatherCSV(content);
  }

  if (!API_KEY) {
    console.log(`  [SKIP] No API key, skipping ${city.name}`);
    return null;
  }

  // Fetch from API
  console.log(`  [API] Fetching ${city.name} (${city.lat}, ${city.lon})...`);
  const url = `https://weather.visualcrossing.com/VisualCrossingWebServices/rest/services/timeline/${city.lat},${city.lon}/${startDate}/${endDate}`;

  try {
    const response = await axios.get(url, {
      params: {
        unitGroup: 'metric',
        include: 'hours',
        key: API_KEY,
        contentType: 'csv',
        elements: 'datetime,temp,dew,humidity,precip,windgust,windspeed,cloudcover,solarradiation,uvindex'
      }
    });

    // Cache the response
    if (!fs.existsSync(CACHE_DIR)) {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
    }
    fs.writeFileSync(cacheFile, response.data);

    return parseWeatherCSV(response.data);
  } catch (error) {
    console.error(`  [ERROR] Failed to fetch ${city.name}: ${error.message}`);
    return null;
  }
}

// Parse weather CSV
function parseWeatherCSV(content) {
  const records = parse(content, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true
  });

  const hourlyData = [];
  for (const row of records) {
    const dt = new Date(row.datetime);
    if (isNaN(dt.getTime())) continue;

    hourlyData.push({
      datetime: dt,
      temp: parseFloat(row.temp) || 0,
      dew: parseFloat(row.dew) || 0,
      humidity: parseFloat(row.humidity) || 0,
      precip: parseFloat(row.precip) || 0,
      windspeed: parseFloat(row.windspeed) || 0,
      cloudcover: parseFloat(row.cloudcover) || 0,
      solarradiation: parseFloat(row.solarradiation) || 0,
      uvindex: parseFloat(row.uvindex) || 0,
      cdh: computeCDH(parseFloat(row.temp) || 0)
    });
  }

  return hourlyData;
}

// Load demand data from database
function loadDemandData(zoneCode, startDate, endDate) {
  const db = new Database(DB_PATH);
  const rows = db.prepare(`
    SELECT datetime, demand
    FROM demand_records
    WHERE region = ? AND datetime >= ? AND datetime < ?
    ORDER BY datetime
  `).all(zoneCode, startDate, endDate);
  db.close();

  return rows.map(r => ({
    datetime: new Date(r.datetime),
    demand: r.demand
  }));
}

// Align weather and demand data by timestamp
function alignData(weatherData, demandData) {
  const demandMap = new Map();
  for (const d of demandData) {
    // Demand is hour-ending, weather is hour-starting
    // Add 1 hour to weather timestamp to match demand
    const key = d.datetime.toISOString();
    demandMap.set(key, d.demand);
  }

  const aligned = [];
  for (const w of weatherData) {
    // Shift weather time by +1 hour to match hour-ending demand
    const shiftedDt = new Date(w.datetime.getTime() + 3600000);
    const key = shiftedDt.toISOString();
    const demand = demandMap.get(key);
    if (demand !== undefined) {
      aligned.push({ weather: w, demand });
    }
  }

  return aligned;
}

// Compute correlations for a city
function computeCorrelations(alignedData) {
  const temps = alignedData.map(d => d.weather.temp);
  const cdhs = alignedData.map(d => d.weather.cdh);
  const demands = alignedData.map(d => d.demand);
  const humidities = alignedData.map(d => d.weather.humidity);
  const windspeeds = alignedData.map(d => d.weather.windspeed);
  const cloudcovers = alignedData.map(d => d.weather.cloudcover);

  return {
    temp: pearsonCorrelation(temps, demands),
    cdh: pearsonCorrelation(cdhs, demands),
    humidity: pearsonCorrelation(humidities, demands),
    windspeed: pearsonCorrelation(windspeeds, demands),
    cloudcover: pearsonCorrelation(cloudcovers, demands),
    n: alignedData.length
  };
}

// Main analysis function
async function analyzeZone(zoneCode) {
  console.log(`\n${'='.repeat(80)}`);
  console.log(`WEATHER-DEMAND CORRELATION ANALYSIS: ${zoneCode}`);
  console.log(`${'='.repeat(80)}\n`);

  const candidates = CANDIDATE_CITIES[zoneCode];
  if (!candidates) {
    console.log(`No candidate cities defined for zone ${zoneCode}`);
    console.log('Available zones:', Object.keys(CANDIDATE_CITIES).join(', '));
    return;
  }

  // Date range for analysis (use available data)
  const startDate = '2025-07-01';
  const endDate = '2025-12-31';

  console.log(`Analysis period: ${startDate} to ${endDate}`);
  console.log(`Loading demand data for ${zoneCode}...\n`);

  const demandData = loadDemandData(zoneCode, startDate, endDate);
  console.log(`Loaded ${demandData.length} demand records\n`);

  if (demandData.length === 0) {
    console.log('No demand data found. Check database.');
    return;
  }

  const results = [];

  console.log('Fetching weather data and computing correlations...\n');

  for (const city of candidates) {
    const weatherData = await fetchWeatherData(city, startDate, endDate);

    if (!weatherData || weatherData.length === 0) {
      console.log(`  [SKIP] No weather data for ${city.name}`);
      continue;
    }

    const aligned = alignData(weatherData, demandData);
    if (aligned.length === 0) {
      console.log(`  [SKIP] No aligned data for ${city.name}`);
      continue;
    }

    const corr = computeCorrelations(aligned);
    results.push({
      city: city.name,
      id: city.id,
      existing: city.existing,
      lat: city.lat,
      lon: city.lon,
      ...corr
    });

    console.log(`  [OK] ${city.name}: temp r=${corr.temp.toFixed(3)}, cdh r=${corr.cdh.toFixed(3)} (n=${corr.n})`);
  }

  // Sort by CDH correlation (most relevant for demand)
  results.sort((a, b) => Math.abs(b.cdh) - Math.abs(a.cdh));

  console.log(`\n${'='.repeat(80)}`);
  console.log(`RESULTS - Cities ranked by CDH-Demand correlation`);
  console.log(`${'='.repeat(80)}\n`);

  console.log('City'.padEnd(25) + 'Status'.padEnd(12) + 'Temp r'.padStart(10) + 'CDH r'.padStart(10) +
              'Humidity r'.padStart(12) + 'Wind r'.padStart(10) + 'Cloud r'.padStart(10) + 'N'.padStart(8));
  console.log('-'.repeat(97));

  for (const r of results) {
    const status = r.existing ? 'EXISTING' : 'CANDIDATE';
    console.log(
      r.city.padEnd(25) +
      status.padEnd(12) +
      r.temp.toFixed(3).padStart(10) +
      r.cdh.toFixed(3).padStart(10) +
      r.humidity.toFixed(3).padStart(12) +
      r.windspeed.toFixed(3).padStart(10) +
      r.cloudcover.toFixed(3).padStart(10) +
      String(r.n).padStart(8)
    );
  }

  console.log('-'.repeat(97));

  // Recommendations
  console.log('\nRECOMMENDATIONS:');
  console.log('-'.repeat(40));

  const existingAvgCDH = results.filter(r => r.existing).reduce((sum, r) => sum + Math.abs(r.cdh), 0) /
                         results.filter(r => r.existing).length;
  const candidatesAboveAvg = results.filter(r => !r.existing && Math.abs(r.cdh) >= existingAvgCDH);

  console.log(`\nExisting cities average CDH correlation: ${existingAvgCDH.toFixed(3)}`);

  if (candidatesAboveAvg.length > 0) {
    console.log(`\nCandidate cities with correlation >= existing average:`);
    for (const c of candidatesAboveAvg) {
      console.log(`  + ${c.city} (r=${c.cdh.toFixed(3)}) - ADD TO ${zoneCode}`);
    }
  } else {
    console.log('\nNo candidate cities show stronger correlation than existing cities.');
    console.log('Current weather sampling may be optimal for this zone.');
  }

  // Export results to JSON
  const outputFile = `output/correlation_${zoneCode}.json`;
  if (!fs.existsSync('output')) {
    fs.mkdirSync('output');
  }
  fs.writeFileSync(outputFile, JSON.stringify({ zone: zoneCode, results, analysis: { existingAvgCDH, candidatesAboveAvg } }, null, 2));
  console.log(`\nResults saved to: ${outputFile}`);
}

// Run analysis
const zoneArg = process.argv[2] || '01NLUZ';
analyzeZone(zoneArg).catch(console.error);
