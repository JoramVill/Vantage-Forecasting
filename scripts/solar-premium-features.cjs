/**
 * Analyze Premium Weather Features for Solar Forecasting
 *
 * Examines additional features from Visual Crossing corporate account:
 * - uvindex: Clear-sky indicator
 * - humidity: Atmospheric water vapor
 * - visibility: Aerosol/haze levels
 * - conditions: Sky description text
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

// Load per-station weather with all premium features
function loadStationWeather(stationCode) {
  const stationDir = join(process.cwd(), 'weather_cache', 'station_' + stationCode);
  if (!existsSync(stationDir)) return new Map();

  const weatherMap = new Map();
  const months = readdirSync(stationDir).filter(d => d.startsWith('2025-'));

  for (const month of months) {
    const monthDir = join(stationDir, month);
    if (!existsSync(monthDir)) continue;

    const files = readdirSync(monthDir).filter(f => f.endsWith('.csv'));

    for (const file of files) {
      const content = readFileSync(join(monthDir, file), 'utf-8');
      const lines = content.split('\n').filter(l => l.trim());

      if (lines.length < 2) continue;

      const headers = parseCSVLine(lines[0]).map(h => h.toLowerCase());

      const getIdx = (name) => headers.indexOf(name);

      for (let i = 1; i < lines.length; i++) {
        const values = parseCSVLine(lines[i]);
        if (values.length < headers.length) continue;

        const datetimeStr = values[getIdx('datetime')];
        const dt = DateTime.fromISO(datetimeStr).plus({ hours: 1 }); // Hour-ending
        if (!dt.isValid) continue;

        const key = dt.toFormat('yyyy-MM-dd HH:mm');

        const getValue = (name) => {
          const idx = getIdx(name);
          return idx >= 0 ? parseFloat(values[idx]) || 0 : 0;
        };

        const conditions = getIdx('conditions') >= 0 ? values[getIdx('conditions')] : '';

        weatherMap.set(key, {
          datetime: dt.toJSDate(),
          hour: dt.hour,
          month: dt.month,
          // Standard features
          solarradiation: getValue('solarradiation'),
          solarenergy: getValue('solarenergy'),
          cloudcover: getValue('cloudcover'),
          temperature: getValue('temp'),
          // Premium features
          uvindex: getValue('uvindex'),
          humidity: getValue('humidity'),
          visibility: getValue('visibility'),
          precipprob: getValue('precipprob'),
          pressure: getValue('sealevelpressure') || getValue('pressure'),
          conditions: conditions.replace(/"/g, '').toLowerCase()
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

    for (let i = 1; i < lines.length; i++) {
      const values = lines[i].split(',').map(v => v.trim());
      if (values.length < 2) continue;

      const dt = DateTime.fromFormat(values[0], 'M/d/yyyy HH:mm');
      if (!dt.isValid) continue;

      const key = dt.toFormat('yyyy-MM-dd HH:mm');

      for (let j = 1; j < headers.length; j++) {
        const station = headers[j];
        if (!stationData.has(station)) {
          stationData.set(station, new Map());
        }

        const cfac = parseFloat(values[j]);
        if (!isNaN(cfac) && cfac >= 0 && cfac <= 1) {
          stationData.get(station).set(key, cfac);
        }
      }
    }
  }

  return stationData;
}

// Main analysis
async function main() {
  console.log('');
  console.log('='.repeat(90));
  console.log('PREMIUM WEATHER FEATURES ANALYSIS FOR SOLAR FORECASTING');
  console.log('='.repeat(90));
  console.log('');

  // Check which stations have per-station weather data
  const weatherCacheDir = join(process.cwd(), 'weather_cache');
  const stationDirs = readdirSync(weatherCacheDir).filter(d => d.startsWith('station_'));

  // Separate wind and solar stations
  const solarStationDirs = stationDirs.filter(d =>
    !d.includes('BURGOS') &&
    !d.includes('CURIMAO') &&
    !d.includes('LAOAG') &&
    !d.includes('PAGUDPUD') &&
    !d.includes('PASUQUIN') &&
    !d.includes('NABAS_W') &&
    !d.includes('STBARBRA_W')
  );

  console.log('Found per-station weather directories:');
  for (const dir of stationDirs) {
    console.log('  ' + dir);
  }
  console.log('');

  if (solarStationDirs.length === 0) {
    console.log('No solar station weather data found yet.');
    console.log('');
    console.log('To fetch solar station weather, run:');
    console.log('  node dist/index.js cfac weather --types solar -s 2025-07-01 -e 2025-12-02');
    console.log('');
    console.log('Analyzing wind station weather data for premium features demo...');
    console.log('');
  }

  // Use any available station data for premium features analysis
  let sampleWeather = null;
  for (const dir of stationDirs) {
    const stationCode = dir.replace('station_', '');
    const wx = loadStationWeather(stationCode);
    if (wx.size > 100) {
      console.log(`Using ${stationCode} weather data (${wx.size} records) for premium features demo`);
      sampleWeather = wx;
      break;
    }
  }

  if (sampleWeather) {
    // Sample premium features
    console.log('');
    console.log('='.repeat(90));
    console.log('SAMPLE PREMIUM WEATHER DATA');
    console.log('='.repeat(90));
    console.log('');
    console.log('DateTime'.padEnd(20) +
      'SolRad'.padStart(10) +
      'UV'.padStart(6) +
      'Humid'.padStart(8) +
      'Vis'.padStart(8) +
      'Press'.padStart(8) +
      'Cloud'.padStart(8) +
      'Conditions'.padStart(25)
    );
    console.log('-'.repeat(90));

    let count = 0;
    for (const [key, wx] of sampleWeather) {
      if (wx.hour >= 10 && wx.hour <= 14 && wx.solarradiation > 100) {
        const dt = DateTime.fromJSDate(wx.datetime);
        console.log(
          dt.toFormat('yyyy-MM-dd HH:mm').padEnd(20) +
          wx.solarradiation.toFixed(0).padStart(10) +
          wx.uvindex.toFixed(1).padStart(6) +
          (wx.humidity.toFixed(0) + '%').padStart(8) +
          (wx.visibility.toFixed(1) + 'km').padStart(8) +
          wx.pressure.toFixed(0).padStart(8) +
          (wx.cloudcover.toFixed(0) + '%').padStart(8) +
          wx.conditions.substring(0, 24).padStart(25)
        );
        count++;
        if (count >= 20) break;
      }
    }
    console.log('-'.repeat(90));

    // Analyze conditions categories
    console.log('');
    console.log('='.repeat(90));
    console.log('SKY CONDITIONS DISTRIBUTION (Daylight Hours)');
    console.log('='.repeat(90));
    console.log('');

    const conditionStats = new Map();
    for (const [key, wx] of sampleWeather) {
      if (wx.hour >= 6 && wx.hour <= 18) {
        const cond = wx.conditions || 'unknown';
        if (!conditionStats.has(cond)) {
          conditionStats.set(cond, { count: 0, totalRad: 0, totalCF: 0 });
        }
        const stats = conditionStats.get(cond);
        stats.count++;
        stats.totalRad += wx.solarradiation;
      }
    }

    const sortedConditions = [...conditionStats.entries()]
      .filter(([c, s]) => s.count > 10)
      .sort((a, b) => b[1].count - a[1].count);

    console.log('Condition'.padEnd(40) + 'Count'.padStart(10) + 'Avg SolRad'.padStart(12));
    console.log('-'.repeat(62));
    for (const [cond, stats] of sortedConditions) {
      const avgRad = stats.totalRad / stats.count;
      console.log(
        cond.substring(0, 38).padEnd(40) +
        stats.count.toString().padStart(10) +
        avgRad.toFixed(0).padStart(12)
      );
    }
    console.log('-'.repeat(62));

    // UV Index analysis
    console.log('');
    console.log('='.repeat(90));
    console.log('UV INDEX ANALYSIS (Correlates with clear-sky conditions)');
    console.log('='.repeat(90));
    console.log('');

    const uvBins = [
      { min: 0, max: 3, label: 'Low (0-3)', count: 0, totalRad: 0 },
      { min: 3, max: 6, label: 'Moderate (3-6)', count: 0, totalRad: 0 },
      { min: 6, max: 8, label: 'High (6-8)', count: 0, totalRad: 0 },
      { min: 8, max: 11, label: 'Very High (8-11)', count: 0, totalRad: 0 },
      { min: 11, max: 20, label: 'Extreme (11+)', count: 0, totalRad: 0 }
    ];

    for (const [key, wx] of sampleWeather) {
      if (wx.hour >= 10 && wx.hour <= 14) {  // Peak sun hours
        for (const bin of uvBins) {
          if (wx.uvindex >= bin.min && wx.uvindex < bin.max) {
            bin.count++;
            bin.totalRad += wx.solarradiation;
            break;
          }
        }
      }
    }

    console.log('UV Index Range'.padEnd(25) + 'Count'.padStart(10) + 'Avg SolRad'.padStart(15));
    console.log('-'.repeat(50));
    for (const bin of uvBins) {
      if (bin.count > 0) {
        const avgRad = bin.totalRad / bin.count;
        console.log(
          bin.label.padEnd(25) +
          bin.count.toString().padStart(10) +
          avgRad.toFixed(0).padStart(15)
        );
      }
    }
    console.log('-'.repeat(50));

    // Humidity analysis
    console.log('');
    console.log('='.repeat(90));
    console.log('HUMIDITY IMPACT (Affects atmospheric absorption)');
    console.log('='.repeat(90));
    console.log('');

    const humidityBins = [
      { min: 0, max: 50, label: 'Low (<50%)', count: 0, totalRad: 0 },
      { min: 50, max: 70, label: 'Moderate (50-70%)', count: 0, totalRad: 0 },
      { min: 70, max: 85, label: 'High (70-85%)', count: 0, totalRad: 0 },
      { min: 85, max: 101, label: 'Very High (>85%)', count: 0, totalRad: 0 }
    ];

    for (const [key, wx] of sampleWeather) {
      if (wx.hour >= 10 && wx.hour <= 14) {
        for (const bin of humidityBins) {
          if (wx.humidity >= bin.min && wx.humidity < bin.max) {
            bin.count++;
            bin.totalRad += wx.solarradiation;
            break;
          }
        }
      }
    }

    console.log('Humidity Range'.padEnd(25) + 'Count'.padStart(10) + 'Avg SolRad'.padStart(15));
    console.log('-'.repeat(50));
    for (const bin of humidityBins) {
      if (bin.count > 0) {
        const avgRad = bin.totalRad / bin.count;
        console.log(
          bin.label.padEnd(25) +
          bin.count.toString().padStart(10) +
          avgRad.toFixed(0).padStart(15)
        );
      }
    }
    console.log('-'.repeat(50));
  }

  // Recommendations
  console.log('');
  console.log('='.repeat(90));
  console.log('RECOMMENDATIONS FOR IMPROVING SOLAR FORECAST');
  console.log('='.repeat(90));
  console.log('');
  console.log('Based on the analysis, these premium features could improve forecasting:');
  console.log('');
  console.log('1. UV INDEX:');
  console.log('   - Strong indicator of clear-sky conditions');
  console.log('   - Higher UV typically means higher actual irradiance');
  console.log('   - Can be used to scale the base solar radiation estimate');
  console.log('');
  console.log('2. HUMIDITY:');
  console.log('   - High humidity → more atmospheric absorption → lower irradiance');
  console.log('   - Can apply humidity correction factor to physics model');
  console.log('');
  console.log('3. VISIBILITY:');
  console.log('   - Low visibility indicates aerosols/haze that block sunlight');
  console.log('   - Useful for tropical locations with frequent haze');
  console.log('');
  console.log('4. CONDITIONS TEXT:');
  console.log('   - Can detect "Rain", "Overcast" vs "Clear", "Partially cloudy"');
  console.log('   - Useful for categorical adjustments');
  console.log('');
  console.log('5. PER-STATION WEATHER:');
  console.log('   - Reduces distance error from cluster-based approach');
  console.log('   - Captures local microclimates better');
  console.log('');
}

main().catch(console.error);
