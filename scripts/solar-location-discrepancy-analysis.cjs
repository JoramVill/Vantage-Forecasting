/**
 * Solar Location Discrepancy Analysis
 *
 * Find which solar sites have the biggest discrepancy between
 * weather API irradiance and actual capacity factor efficiency.
 * Sites with large discrepancies may have incorrect coordinates.
 */

const fs = require('fs');
const path = require('path');

// Parse CSV line handling quoted fields
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

// Parse CF CSV files
function parseCSV(filepath) {
  const content = fs.readFileSync(filepath, 'utf-8');
  const lines = content.split('\n').filter(l => l.trim());
  const headers = lines[0].split(',').map(h => h.trim());

  return { headers, lines: lines.slice(1) };
}

// Get all solar station codes from CF files
function getSolarStations() {
  const filepath = path.join(__dirname, '..', 'Data Samples', 'Capacity Factor', 'MRHCFac_HIST_NOV.csv');
  const { headers } = parseCSV(filepath);

  // Filter for solar stations (ending with _S or containing SOLAR)
  return headers.filter(h => h.endsWith('_S') || h.includes('SOLAR'));
}

// Load weather cache for a station
function loadWeatherCache(stationCode, monthDir) {
  const baseDir = path.join(__dirname, '..', 'weather_cache', `SOLAR_${stationCode}`, monthDir);
  const data = [];

  if (!fs.existsSync(baseDir)) {
    return data;
  }

  const files = fs.readdirSync(baseDir).filter(f => f.endsWith('.csv'));

  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(baseDir, file), 'utf-8');
      const lines = content.split('\n').filter(l => l.trim());
      const headers = parseCSVLine(lines[0]);

      const datetimeIdx = headers.indexOf('datetime');
      const solarIdx = headers.indexOf('solarradiation');
      const cloudIdx = headers.indexOf('cloudcover');

      for (let i = 1; i < lines.length; i++) {
        const values = parseCSVLine(lines[i]);
        if (values.length < headers.length) continue;

        data.push({
          datetime: values[datetimeIdx],
          solarRadiation: parseFloat(values[solarIdx]) || 0,
          cloudCover: parseFloat(values[cloudIdx]) || 0,
        });
      }
    } catch (e) {
      // Skip invalid files
    }
  }

  return data;
}

// Get weather location for a station
function getWeatherLocation(stationCode) {
  const baseDir = path.join(__dirname, '..', 'weather_cache', `SOLAR_${stationCode}`, '2025-11');

  if (!fs.existsSync(baseDir)) {
    return null;
  }

  const files = fs.readdirSync(baseDir).filter(f => f.endsWith('.csv'));
  if (files.length === 0) return null;

  try {
    const content = fs.readFileSync(path.join(baseDir, files[0]), 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());
    if (lines.length < 2) return null;

    const values = parseCSVLine(lines[1]);
    // First field is the location name (lat,lon in quotes)
    return values[0];
  } catch (e) {
    return null;
  }
}

// Analyze a single station
function analyzeStation(stationCode) {
  const cfFiles = [
    { file: 'MRHCFac_HIST_JULY.csv', month: '07', season: 'monsoon' },
    { file: 'MRHCFac_HIST_AUG.csv', month: '08', season: 'monsoon' },
    { file: 'MRHCFac_HIST_SEP.csv', month: '09', season: 'monsoon' },
    { file: 'MRHCFac_HIST_OCT.csv', month: '10', season: 'monsoon' },
    { file: 'MRHCFac_HIST_NOV.csv', month: '11', season: 'dry' },
  ];

  let monsoonCFSum = 0, monsoonCFCount = 0;
  let dryCFSum = 0, dryCFCount = 0;
  let monsoonIrrSum = 0, monsoonIrrCount = 0;
  let dryIrrSum = 0, dryIrrCount = 0;

  for (const { file, month, season } of cfFiles) {
    const filepath = path.join(__dirname, '..', 'Data Samples', 'Capacity Factor', file);
    if (!fs.existsSync(filepath)) continue;

    const content = fs.readFileSync(filepath, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());
    const headers = lines[0].split(',').map(h => h.trim());
    const stationIdx = headers.indexOf(stationCode);

    if (stationIdx === -1) continue;

    for (let i = 1; i < lines.length; i++) {
      const values = lines[i].split(',');
      const cf = parseFloat(values[stationIdx]) || 0;
      if (cf > 0) {
        if (season === 'monsoon') {
          monsoonCFSum += cf;
          monsoonCFCount++;
        } else {
          dryCFSum += cf;
          dryCFCount++;
        }
      }
    }

    // Load weather data for this month
    const weatherData = loadWeatherCache(stationCode, `2025-${month}`);
    for (const d of weatherData) {
      const hourMatch = d.datetime.match(/T(\d{2}):/);
      const hour = hourMatch ? parseInt(hourMatch[1]) : -1;

      if (hour >= 6 && hour <= 18 && d.solarRadiation > 0) {
        if (season === 'monsoon') {
          monsoonIrrSum += d.solarRadiation;
          monsoonIrrCount++;
        } else {
          dryIrrSum += d.solarRadiation;
          dryIrrCount++;
        }
      }
    }
  }

  const monsoonCF = monsoonCFCount > 0 ? monsoonCFSum / monsoonCFCount : 0;
  const dryCF = dryCFCount > 0 ? dryCFSum / dryCFCount : 0;
  const monsoonIrr = monsoonIrrCount > 0 ? monsoonIrrSum / monsoonIrrCount : 0;
  const dryIrr = dryIrrCount > 0 ? dryIrrSum / dryIrrCount : 0;

  const monsoonEff = monsoonIrr > 0 ? (monsoonCF / monsoonIrr) * 1000 : 0;
  const dryEff = dryIrr > 0 ? (dryCF / dryIrr) * 1000 : 0;

  const cfRatio = monsoonCF > 0 ? dryCF / monsoonCF : 0;
  const irrRatio = monsoonIrr > 0 ? dryIrr / monsoonIrr : 0;
  const effRatio = monsoonEff > 0 ? dryEff / monsoonEff : 0;
  const discrepancy = cfRatio > 0 && irrRatio > 0 ? Math.abs(cfRatio - irrRatio) : 0;

  const location = getWeatherLocation(stationCode);

  return {
    stationCode,
    location,
    monsoonCF,
    dryCF,
    cfRatio,
    monsoonIrr,
    dryIrr,
    irrRatio,
    monsoonEff,
    dryEff,
    effRatio,
    discrepancy,
    hasWeatherData: monsoonIrrCount > 0 || dryIrrCount > 0,
  };
}

// Main analysis
function analyze() {
  console.log('=== Solar Location Discrepancy Analysis ===\n');

  const solarStations = getSolarStations();
  console.log(`Found ${solarStations.length} solar stations\n`);

  const results = [];

  for (const station of solarStations) {
    const result = analyzeStation(station);
    if (result.hasWeatherData && result.monsoonCF > 0 && result.dryCF > 0) {
      results.push(result);
    }
  }

  // Sort by discrepancy (highest first)
  results.sort((a, b) => b.discrepancy - a.discrepancy);

  console.log('Stations sorted by CF/Irradiance discrepancy (highest = most suspicious):');
  console.log('='.repeat(130));
  console.log('Station\t\t\tLocation\t\t\tCF Ratio\tIrr Ratio\tDiscrep\t\tMonsoon Eff\tDry Eff\t\tEff Ratio');
  console.log('-'.repeat(130));

  for (const r of results) {
    const loc = r.location ? r.location.substring(0, 20) : 'N/A';
    console.log(
      `${r.stationCode.padEnd(20)}\t${loc.padEnd(20)}\t${r.cfRatio.toFixed(2)}x\t\t${r.irrRatio.toFixed(2)}x\t\t${r.discrepancy.toFixed(2)}\t\t${r.monsoonEff.toFixed(3)}\t\t${r.dryEff.toFixed(3)}\t\t${r.effRatio.toFixed(2)}x`
    );
  }

  console.log('-'.repeat(130));

  // Highlight the most problematic ones
  console.log('\n=== TOP 10 MOST SUSPICIOUS LOCATIONS ===');
  console.log('(Large discrepancy = CF ratio does not match irradiance ratio)');
  console.log('');

  for (let i = 0; i < Math.min(10, results.length); i++) {
    const r = results[i];
    console.log(`${i + 1}. ${r.stationCode}`);
    console.log(`   Location: ${r.location || 'Unknown'}`);
    console.log(`   CF: Monsoon=${r.monsoonCF.toFixed(3)} → Dry=${r.dryCF.toFixed(3)} (${r.cfRatio.toFixed(2)}x increase)`);
    console.log(`   Irr: Monsoon=${r.monsoonIrr.toFixed(0)} → Dry=${r.dryIrr.toFixed(0)} W/m² (${r.irrRatio.toFixed(2)}x)`);
    console.log(`   Efficiency: ${r.monsoonEff.toFixed(3)} → ${r.dryEff.toFixed(3)} (${r.effRatio.toFixed(2)}x)`);
    console.log(`   DISCREPANCY: ${r.discrepancy.toFixed(2)}`);
    console.log('');
  }

  // Calculate average efficiency ratio
  const avgEffRatio = results.reduce((s, r) => s + r.effRatio, 0) / results.length;
  console.log(`\nAverage efficiency ratio (Dry/Monsoon): ${avgEffRatio.toFixed(2)}x`);
  console.log('(Should be ~1.0 if weather data is accurate)');

  // Count stations with inverted irradiance (dry < monsoon)
  const invertedCount = results.filter(r => r.irrRatio < 1).length;
  console.log(`\nStations with inverted irradiance (Dry < Monsoon): ${invertedCount}/${results.length}`);
  console.log('(This is physically unlikely - suggests weather data issues)');
}

analyze();
