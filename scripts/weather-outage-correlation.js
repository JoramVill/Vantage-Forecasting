/**
 * Weather-Outage Correlation Analysis
 * Analyzes the relationship between weather events (storms) and power outages
 */

import Database from 'better-sqlite3';
const db = new Database('./data/iload.db');

console.log('═══════════════════════════════════════════════════════════════');
console.log('         OUTAGE-WEATHER CORRELATION ANALYSIS');
console.log('═══════════════════════════════════════════════════════════════\n');

// Get data ranges
const weatherRange = db.prepare('SELECT MIN(datetime) as minDate, MAX(datetime) as maxDate FROM weather_records').get();
const outageRange = db.prepare('SELECT MIN(start_time) as minDate, MAX(start_time) as maxDate FROM outage_records').get();

console.log('Data Availability:');
console.log('  Weather Data: ', weatherRange.minDate.split('T')[0], 'to', weatherRange.maxDate.split('T')[0]);
console.log('  Outage Data:  ', outageRange.minDate.split('T')[0], 'to', outageRange.maxDate.split('T')[0]);

// Find overlapping period
const overlapStart = '2025-07-01';
const overlapEnd = '2025-11-28';
console.log('  Overlap Period:', overlapStart, 'to', overlapEnd, '\n');

// Get outages in overlap period
const outages = db.prepare(`
  SELECT * FROM outage_records
  WHERE outage_type = 'unplanned'
  AND start_time >= '${overlapStart}'
  AND start_time <= '${overlapEnd}'
  ORDER BY start_time
`).all();

console.log('Unplanned Outages in Overlap Period:', outages.length, '\n');

// For each outage, get weather at that time
const correlatedData = [];

for (const outage of outages) {
  const outageDateTime = outage.start_time;
  const outageDate = outageDateTime.split('T')[0];
  const outageHour = new Date(outageDateTime).getUTCHours();

  // Get weather for same region and closest hour
  const weather = db.prepare(`
    SELECT * FROM weather_records
    WHERE region = ?
    AND datetime >= ?
    AND datetime <= ?
    ORDER BY datetime
    LIMIT 1
  `).get(outage.region, outageDate + 'T00:00:00', outageDate + 'T23:59:59');

  if (weather) {
    correlatedData.push({
      outageDate,
      outageHour,
      region: outage.region,
      unitId: outage.unit_id,
      severity: outage.severity,
      capacityLost: outage.capacity_lost_mw,
      durationMin: outage.duration_minutes,
      temp: weather.temp,
      windspeed: weather.windspeed,
      windgust: weather.windgust,
      precip: weather.precip,
      cloudcover: weather.cloudcover,
      solarradiation: weather.solarradiation
    });
  }
}

console.log('Outages matched with weather data:', correlatedData.length, '\n');

// Define weather conditions
const STORM_WIND_THRESHOLD = 40;  // km/h
const STORM_GUST_THRESHOLD = 60;  // km/h
const HEAVY_RAIN_THRESHOLD = 10;  // mm
const LIGHT_RAIN_THRESHOLD = 1;   // mm

// Categorize outages by weather
const stormOutages = correlatedData.filter(d =>
  (d.windspeed > STORM_WIND_THRESHOLD || d.windgust > STORM_GUST_THRESHOLD) && d.precip > LIGHT_RAIN_THRESHOLD
);
const highWindOutages = correlatedData.filter(d =>
  d.windspeed > STORM_WIND_THRESHOLD || d.windgust > STORM_GUST_THRESHOLD
);
const rainyOutages = correlatedData.filter(d => d.precip > LIGHT_RAIN_THRESHOLD);
const heavyRainOutages = correlatedData.filter(d => d.precip > HEAVY_RAIN_THRESHOLD);
const calmOutages = correlatedData.filter(d =>
  d.windspeed <= 20 && d.windgust <= 30 && d.precip < LIGHT_RAIN_THRESHOLD
);

console.log('─────────────────────────────────────────────────────────────');
console.log('WEATHER CONDITIONS DURING OUTAGES');
console.log('─────────────────────────────────────────────────────────────\n');

console.log('Weather Category          | Count | % of Total | Avg MW Lost');
console.log('─────────────────────────────────────────────────────────────');

function printCategory(name, data, total) {
  const pct = (data.length / total * 100).toFixed(1);
  const avgMW = data.length > 0 ? (data.reduce((s, d) => s + d.capacityLost, 0) / data.length).toFixed(0) : 0;
  console.log(`${name.padEnd(25)} | ${String(data.length).padStart(5)} | ${pct.padStart(10)}% | ${String(avgMW).padStart(7)} MW`);
}

printCategory('Storm (wind+rain)', stormOutages, correlatedData.length);
printCategory('High Wind (>40 km/h)', highWindOutages, correlatedData.length);
printCategory('Heavy Rain (>10mm)', heavyRainOutages, correlatedData.length);
printCategory('Any Rain (>1mm)', rainyOutages, correlatedData.length);
printCategory('Calm Conditions', calmOutages, correlatedData.length);

// Severity analysis by weather
console.log('\n─────────────────────────────────────────────────────────────');
console.log('OUTAGE SEVERITY BY WEATHER CONDITION');
console.log('─────────────────────────────────────────────────────────────\n');

function analyzeSeverity(name, data) {
  if (data.length === 0) return;

  const minor = data.filter(d => d.severity === 'minor').length;
  const moderate = data.filter(d => d.severity === 'moderate').length;
  const major = data.filter(d => d.severity === 'major').length;
  const critical = data.filter(d => d.severity === 'critical').length;

  console.log(`${name}:`);
  console.log(`  Minor:    ${minor} (${(minor/data.length*100).toFixed(1)}%)`);
  console.log(`  Moderate: ${moderate} (${(moderate/data.length*100).toFixed(1)}%)`);
  console.log(`  Major:    ${major} (${(major/data.length*100).toFixed(1)}%)`);
  console.log(`  Critical: ${critical} (${(critical/data.length*100).toFixed(1)}%)`);
  console.log('');
}

analyzeSeverity('During Storms', stormOutages);
analyzeSeverity('During High Wind', highWindOutages);
analyzeSeverity('During Heavy Rain', heavyRainOutages);
analyzeSeverity('During Calm Weather', calmOutages);

// Regional analysis
console.log('─────────────────────────────────────────────────────────────');
console.log('STORM-RELATED OUTAGES BY REGION');
console.log('─────────────────────────────────────────────────────────────\n');

for (const region of ['CLUZ', 'CVIS', 'CMIN']) {
  const regionData = correlatedData.filter(d => d.region === region);
  const regionStorms = stormOutages.filter(d => d.region === region);
  const regionHighWind = highWindOutages.filter(d => d.region === region);

  console.log(`${region}:`);
  console.log(`  Total outages in period: ${regionData.length}`);
  console.log(`  Storm-related:           ${regionStorms.length} (${(regionStorms.length/regionData.length*100).toFixed(1)}%)`);
  console.log(`  High wind-related:       ${regionHighWind.length} (${(regionHighWind.length/regionData.length*100).toFixed(1)}%)`);

  if (regionStorms.length > 0) {
    const avgCap = regionStorms.reduce((s, d) => s + d.capacityLost, 0) / regionStorms.length;
    console.log(`  Avg storm outage size:   ${avgCap.toFixed(0)} MW`);
  }
  console.log('');
}

// Show example storm-related outages
if (stormOutages.length > 0) {
  console.log('─────────────────────────────────────────────────────────────');
  console.log('SAMPLE STORM-RELATED OUTAGES');
  console.log('─────────────────────────────────────────────────────────────\n');

  console.log('Date       | Region | Unit              | MW Lost | Wind  | Gust  | Rain');
  console.log('───────────────────────────────────────────────────────────────────────────');

  for (const o of stormOutages.slice(0, 15)) {
    console.log(`${o.outageDate} | ${o.region}   | ${o.unitId.substring(0, 17).padEnd(17)} | ${String(o.capacityLost).padStart(7)} | ${String(o.windspeed?.toFixed(0)).padStart(5)} | ${String(o.windgust?.toFixed(0)).padStart(5)} | ${String(o.precip?.toFixed(1)).padStart(5)}mm`);
  }
}

// Weather extremes during outages
console.log('\n─────────────────────────────────────────────────────────────');
console.log('WEATHER EXTREMES DURING OUTAGES');
console.log('─────────────────────────────────────────────────────────────\n');

const maxWind = correlatedData.reduce((max, d) => d.windspeed > max.windspeed ? d : max, correlatedData[0]);
const maxGust = correlatedData.reduce((max, d) => d.windgust > max.windgust ? d : max, correlatedData[0]);
const maxRain = correlatedData.reduce((max, d) => d.precip > max.precip ? d : max, correlatedData[0]);

console.log('Highest Wind Speed During Outage:');
console.log(`  ${maxWind.windspeed?.toFixed(1)} km/h on ${maxWind.outageDate} in ${maxWind.region}`);
console.log(`  Unit: ${maxWind.unitId}, Capacity Lost: ${maxWind.capacityLost} MW\n`);

console.log('Highest Wind Gust During Outage:');
console.log(`  ${maxGust.windgust?.toFixed(1)} km/h on ${maxGust.outageDate} in ${maxGust.region}`);
console.log(`  Unit: ${maxGust.unitId}, Capacity Lost: ${maxGust.capacityLost} MW\n`);

console.log('Highest Precipitation During Outage:');
console.log(`  ${maxRain.precip?.toFixed(1)} mm on ${maxRain.outageDate} in ${maxRain.region}`);
console.log(`  Unit: ${maxRain.unitId}, Capacity Lost: ${maxRain.capacityLost} MW\n`);

// Statistical correlation
console.log('─────────────────────────────────────────────────────────────');
console.log('CORRELATION SUMMARY');
console.log('─────────────────────────────────────────────────────────────\n');

// Calculate average capacity lost by weather
const avgAllOutages = correlatedData.reduce((s, d) => s + d.capacityLost, 0) / correlatedData.length;
const avgStormOutages = stormOutages.length > 0 ? stormOutages.reduce((s, d) => s + d.capacityLost, 0) / stormOutages.length : 0;
const avgCalmOutages = calmOutages.length > 0 ? calmOutages.reduce((s, d) => s + d.capacityLost, 0) / calmOutages.length : 0;

console.log('Average Capacity Lost:');
console.log(`  All Outages:     ${avgAllOutages.toFixed(0)} MW`);
console.log(`  Storm Outages:   ${avgStormOutages.toFixed(0)} MW ${avgStormOutages > avgAllOutages ? '(+' + ((avgStormOutages/avgAllOutages-1)*100).toFixed(0) + '% higher)' : ''}`);
console.log(`  Calm Outages:    ${avgCalmOutages.toFixed(0)} MW\n`);

const stormPct = (stormOutages.length / correlatedData.length * 100).toFixed(1);
console.log(`Storm-Related Outages: ${stormPct}% of all unplanned outages\n`);

console.log('Key Finding:');
if (stormOutages.length > 0 && avgStormOutages > avgAllOutages) {
  console.log(`  Storm conditions are associated with ${((avgStormOutages/avgAllOutages-1)*100).toFixed(0)}% larger outages on average.`);
} else {
  console.log('  Most outages occur during non-storm conditions, suggesting');
  console.log('  equipment/operational issues are the primary cause.');
}

db.close();
