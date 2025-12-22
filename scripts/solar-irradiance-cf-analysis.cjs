/**
 * Solar Irradiance vs Capacity Factor Analysis
 *
 * Investigates whether the seasonal CF difference is due to:
 * A) Actual irradiance differences (physics works, seasonal calibration unnecessary)
 * B) Same irradiance but different CF (something else affecting efficiency)
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

// Parse CSV (CF files)
function parseCSV(filepath) {
  const content = fs.readFileSync(filepath, 'utf-8');
  const lines = content.split('\n').filter(l => l.trim());
  const headers = lines[0].split(',').map(h => h.trim());

  return lines.slice(1).map(line => {
    const values = line.split(',');
    const row = {};
    headers.forEach((h, i) => {
      row[h] = values[i]?.trim();
    });
    return row;
  });
}

// Parse weather cache CSV files (handles quoted fields)
function loadWeatherCache(stationCode, monthDir) {
  const baseDir = path.join(__dirname, '..', 'weather_cache', `SOLAR_${stationCode}`, monthDir);
  const data = [];

  if (!fs.existsSync(baseDir)) {
    console.log(`  Weather cache not found: ${baseDir}`);
    return data;
  }

  const files = fs.readdirSync(baseDir).filter(f => f.endsWith('.csv'));

  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(baseDir, file), 'utf-8');
      const lines = content.split('\n').filter(l => l.trim());
      const headers = parseCSVLine(lines[0]);

      // Find column indices
      const datetimeIdx = headers.indexOf('datetime');
      const solarIdx = headers.indexOf('solarradiation');
      const cloudIdx = headers.indexOf('cloudcover');
      const tempIdx = headers.indexOf('temp');
      const uvIdx = headers.indexOf('uvindex');

      for (let i = 1; i < lines.length; i++) {
        const values = parseCSVLine(lines[i]);
        if (values.length < headers.length) continue;

        data.push({
          datetime: values[datetimeIdx],
          solarRadiation: parseFloat(values[solarIdx]) || 0,
          cloudCover: parseFloat(values[cloudIdx]) || 0,
          temp: parseFloat(values[tempIdx]) || 0,
          uvIndex: parseFloat(values[uvIdx]) || 0,
        });
      }
    } catch (e) {
      // Skip invalid files
    }
  }

  return data;
}

// Main analysis
function analyze() {
  const stationCode = '06BACOLOD_S';
  const months = ['2025-07', '2025-08', '2025-09', '2025-10', '2025-11'];

  console.log('=== Solar Irradiance vs Capacity Factor Analysis ===');
  console.log(`Station: ${stationCode}\n`);

  // Load CF data from training files
  const cfByMonth = {};
  const cfFiles = [
    { file: 'MRHCFac_HIST_JULY.csv', month: '07' },
    { file: 'MRHCFac_HIST_AUG.csv', month: '08' },
    { file: 'MRHCFac_HIST_SEP.csv', month: '09' },
    { file: 'MRHCFac_HIST_OCT.csv', month: '10' },
    { file: 'MRHCFac_HIST_NOV.csv', month: '11' },
  ];

  for (const { file, month } of cfFiles) {
    const filepath = path.join(__dirname, '..', 'Data Samples', 'Capacity Factor', file);
    if (fs.existsSync(filepath)) {
      const data = parseCSV(filepath);
      cfByMonth[month] = data.filter(d => d[stationCode] !== undefined)
        .map(d => ({
          datetime: d.TIME,
          cf: parseFloat(d[stationCode]) || 0,
        }))
        .filter(d => d.cf > 0); // Only daylight hours
    }
  }

  // Load weather data by month
  const weatherByMonth = {};
  for (const monthStr of months) {
    const month = monthStr.split('-')[1];
    weatherByMonth[month] = loadWeatherCache(stationCode, monthStr);
    console.log(`  Loaded ${weatherByMonth[month].length} weather records for ${monthStr}`);
  }

  // Calculate monthly averages
  console.log('\nMonthly Comparison (daylight hours 6am-6pm, irradiance > 0):');
  console.log('=' .repeat(90));
  console.log('Month\t\tAvg CF\t\tAvg Irrad (W/m²)\tAvg Cloud%\tCF Samples/Wx Samples');
  console.log('-'.repeat(90));

  const monthNames = { '07': 'Jul', '08': 'Aug', '09': 'Sep', '10': 'Oct', '11': 'Nov' };
  const results = [];

  for (const month of ['07', '08', '09', '10', '11']) {
    const cfData = cfByMonth[month] || [];
    const weatherData = weatherByMonth[month] || [];

    // Calculate CF average
    let cfSum = 0, cfCount = 0;
    for (const d of cfData) {
      if (d.cf > 0) {
        cfSum += d.cf;
        cfCount++;
      }
    }
    const avgCF = cfCount > 0 ? cfSum / cfCount : 0;

    // Calculate weather averages (daylight hours 6am-6pm)
    let irrSum = 0, cloudSum = 0, weatherCount = 0;
    for (const d of weatherData) {
      // Parse hour from datetime like "2025-07-01T08:00:00"
      const hourMatch = d.datetime.match(/T(\d{2}):/);
      const hour = hourMatch ? parseInt(hourMatch[1]) : -1;

      if (hour >= 6 && hour <= 18 && d.solarRadiation > 0) {
        irrSum += d.solarRadiation;
        cloudSum += d.cloudCover;
        weatherCount++;
      }
    }
    const avgIrr = weatherCount > 0 ? irrSum / weatherCount : 0;
    const avgCloud = weatherCount > 0 ? cloudSum / weatherCount : 0;

    results.push({ month, avgCF, avgIrr, avgCloud, cfCount, weatherCount });

    console.log(`${monthNames[month]}\t\t${avgCF.toFixed(3)}\t\t${avgIrr.toFixed(1)}\t\t\t${avgCloud.toFixed(1)}\t\t${cfCount} / ${weatherCount}`);
  }

  console.log('-'.repeat(90));

  // Calculate ratios
  const monsoonMonths = ['07', '08', '09', '10'];
  const dryMonths = ['11'];

  const monsoonCF = results.filter(r => monsoonMonths.includes(r.month));
  const dryCF = results.filter(r => dryMonths.includes(r.month));

  const avgMonsoonCF = monsoonCF.reduce((s, r) => s + r.avgCF, 0) / monsoonCF.length;
  const avgDryCF = dryCF.reduce((s, r) => s + r.avgCF, 0) / dryCF.length;
  const avgMonsoonIrr = monsoonCF.reduce((s, r) => s + r.avgIrr, 0) / monsoonCF.length;
  const avgDryIrr = dryCF.reduce((s, r) => s + r.avgIrr, 0) / dryCF.length;
  const avgMonsoonCloud = monsoonCF.reduce((s, r) => s + r.avgCloud, 0) / monsoonCF.length;
  const avgDryCloud = dryCF.reduce((s, r) => s + r.avgCloud, 0) / dryCF.length;

  console.log('\n=== Seasonal Comparison ===');
  console.log(`Monsoon (Jul-Oct) avg CF: ${avgMonsoonCF.toFixed(3)}`);
  console.log(`Dry (Nov) avg CF:         ${avgDryCF.toFixed(3)}`);
  console.log(`CF Ratio (Dry/Monsoon):   ${(avgDryCF/avgMonsoonCF).toFixed(2)}x`);

  console.log(`\nMonsoon avg Irradiance: ${avgMonsoonIrr.toFixed(1)} W/m²`);
  console.log(`Dry avg Irradiance:     ${avgDryIrr.toFixed(1)} W/m²`);
  console.log(`Irr Ratio (Dry/Monsoon): ${(avgDryIrr/avgMonsoonIrr).toFixed(2)}x`);

  console.log(`\nMonsoon avg Cloud Cover: ${avgMonsoonCloud.toFixed(1)}%`);
  console.log(`Dry avg Cloud Cover:     ${avgDryCloud.toFixed(1)}%`);

  // Key analysis
  console.log('\n=== KEY FINDING ===');
  const cfRatio = avgDryCF / avgMonsoonCF;
  const irrRatio = avgDryIrr / avgMonsoonIrr;
  const ratioDiff = Math.abs(cfRatio - irrRatio);

  if (ratioDiff < 0.3) {
    console.log(`✓ CF ratio (${cfRatio.toFixed(2)}x) ≈ Irradiance ratio (${irrRatio.toFixed(2)}x)`);
    console.log('→ The seasonal CF difference IS EXPLAINED by irradiance differences');
    console.log('→ A physics-based model SHOULD work WITHOUT seasonal calibration');
    console.log('→ The issue may be in model calibration or how irradiance is used');
  } else {
    console.log(`✗ CF ratio (${cfRatio.toFixed(2)}x) ≠ Irradiance ratio (${irrRatio.toFixed(2)}x)`);
    console.log(`→ Difference: ${ratioDiff.toFixed(2)}`);
    console.log('→ CF varies MORE/LESS than irradiance would explain');
    console.log('→ Other factors OR weather data quality issues');
  }

  // Calculate efficiency (CF per unit irradiance)
  console.log('\n=== Efficiency Analysis (CF / Irradiance × 1000) ===');
  console.log('This shows if conversion efficiency varies by season:');
  for (const r of results) {
    if (r.avgIrr > 0) {
      const eff = (r.avgCF / r.avgIrr) * 1000; // CF per 1000 W/m²
      console.log(`${monthNames[r.month]}: ${eff.toFixed(4)} (CF per 1000 W/m²)`);
    }
  }

  const avgMonsoonEff = monsoonCF.filter(r => r.avgIrr > 0).reduce((s, r) => s + (r.avgCF / r.avgIrr) * 1000, 0) / monsoonCF.filter(r => r.avgIrr > 0).length;
  const avgDryEff = dryCF.filter(r => r.avgIrr > 0).reduce((s, r) => s + (r.avgCF / r.avgIrr) * 1000, 0) / dryCF.filter(r => r.avgIrr > 0).length;

  console.log(`\nMonsoon avg efficiency: ${avgMonsoonEff.toFixed(4)}`);
  console.log(`Dry avg efficiency:     ${avgDryEff.toFixed(4)}`);
  console.log(`Efficiency ratio (Dry/Monsoon): ${(avgDryEff/avgMonsoonEff).toFixed(3)}x`);

  if (Math.abs(avgDryEff - avgMonsoonEff) / avgMonsoonEff < 0.2) {
    console.log('\n→ CONCLUSION: Efficiency is SIMILAR across seasons');
    console.log('→ The user is CORRECT - physics-based prediction should work');
    console.log('→ Weather data (irradiance) properly explains CF variation');
    console.log('→ Seasonal calibration is NOT needed if model is calibrated correctly');
  } else {
    console.log('\n→ CONCLUSION: Efficiency DIFFERS by season');
    console.log('→ This suggests factors beyond irradiance affect CF');
    console.log('→ Could be: humidity, panel degradation, soiling, temperature');
    console.log('→ Seasonal calibration MAY be needed');
  }
}

analyze();
