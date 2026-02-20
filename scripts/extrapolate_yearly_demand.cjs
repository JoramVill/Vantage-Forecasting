/**
 * Extrapolate Year-Long Hourly Demand Forecast
 * Uses historical demand patterns to generate a full year forecast
 * without requiring weather data.
 */

const fs = require('fs');
const path = require('path');

// Configuration
const DEMAND_FOLDER = path.join(__dirname, '..', 'Data Samples', 'Demand');
const OUTPUT_FILE = path.join(__dirname, '..', 'output', 'demand_yearly_2026.csv');
const START_DATE = new Date('2026-01-01T01:00:00');
const END_DATE = new Date('2027-01-01T00:00:00');

// Growth rate (annual) - adjust based on expected demand growth
const ANNUAL_GROWTH_RATE = 0.03; // 3% annual growth

// Parse date from "M/D/YYYY HH:mm" format
function parseDate(dateStr) {
  const parts = dateStr.match(/(\d+)\/(\d+)\/(\d+)\s+(\d+):(\d+)/);
  if (!parts) return null;
  const [, month, day, year, hour, minute] = parts;
  return new Date(parseInt(year), parseInt(month) - 1, parseInt(day), parseInt(hour), parseInt(minute));
}

// Format date to "M/D/YYYY HH:mm" format
function formatDate(date) {
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const year = date.getFullYear();
  const hour = String(date.getHours()).padStart(2, '0');
  const minute = String(date.getMinutes()).padStart(2, '0');
  return `${month}/${day}/${year} ${hour}:${minute}`;
}

// Load all historical demand data
function loadHistoricalData() {
  const files = fs.readdirSync(DEMAND_FOLDER).filter(f => f.endsWith('.csv'));
  const data = {};
  let zones = null;

  console.log(`Loading ${files.length} demand files...`);

  for (const file of files) {
    const content = fs.readFileSync(path.join(DEMAND_FOLDER, file), 'utf-8');
    const lines = content.trim().split('\n');

    // Parse header
    if (!zones) {
      const header = lines[0].split(',');
      zones = header.slice(1); // Skip DateTimeEnding column
      console.log(`Zones: ${zones.join(', ')}`);
    }

    // Parse data rows
    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].split(',');
      const dateStr = parts[0];
      const date = parseDate(dateStr);
      if (!date) continue;

      const key = date.toISOString();
      if (!data[key]) {
        data[key] = { date };
      }

      for (let z = 0; z < zones.length; z++) {
        const value = parseFloat(parts[z + 1]);
        if (!isNaN(value)) {
          data[key][zones[z]] = value;
        }
      }
    }
  }

  // Convert to array and sort
  const records = Object.values(data).sort((a, b) => a.date - b.date);
  console.log(`Loaded ${records.length} hourly records from ${formatDate(records[0].date)} to ${formatDate(records[records.length - 1].date)}`);

  return { records, zones };
}

// Build hourly profiles by zone, month, day-of-week, and hour
function buildProfiles(records, zones) {
  console.log('\nBuilding demand profiles...');

  // Structure: profiles[zone][month][dayOfWeek][hour] = { sum, count }
  const profiles = {};

  for (const zone of zones) {
    profiles[zone] = {};
    for (let month = 0; month < 12; month++) {
      profiles[zone][month] = {};
      for (let dow = 0; dow < 7; dow++) {
        profiles[zone][month][dow] = {};
        for (let hour = 0; hour < 24; hour++) {
          profiles[zone][month][dow][hour] = { sum: 0, count: 0 };
        }
      }
    }
  }

  // Aggregate data
  for (const record of records) {
    const month = record.date.getMonth();
    const dow = record.date.getDay();
    const hour = record.date.getHours();

    for (const zone of zones) {
      if (record[zone] !== undefined) {
        profiles[zone][month][dow][hour].sum += record[zone];
        profiles[zone][month][dow][hour].count += 1;
      }
    }
  }

  // Convert to averages
  for (const zone of zones) {
    for (let month = 0; month < 12; month++) {
      for (let dow = 0; dow < 7; dow++) {
        for (let hour = 0; hour < 24; hour++) {
          const p = profiles[zone][month][dow][hour];
          if (p.count > 0) {
            p.avg = p.sum / p.count;
          } else {
            p.avg = null;
          }
        }
      }
    }
  }

  return profiles;
}

// Build monthly averages for fallback
function buildMonthlyAverages(records, zones) {
  const monthlyAvg = {};

  for (const zone of zones) {
    monthlyAvg[zone] = {};
    for (let month = 0; month < 12; month++) {
      monthlyAvg[zone][month] = { sum: 0, count: 0, avg: 0 };
    }
  }

  for (const record of records) {
    const month = record.date.getMonth();
    for (const zone of zones) {
      if (record[zone] !== undefined) {
        monthlyAvg[zone][month].sum += record[zone];
        monthlyAvg[zone][month].count += 1;
      }
    }
  }

  for (const zone of zones) {
    for (let month = 0; month < 12; month++) {
      const m = monthlyAvg[zone][month];
      if (m.count > 0) {
        m.avg = m.sum / m.count;
      }
    }
  }

  return monthlyAvg;
}

// Build overall zone averages for fallback
function buildZoneAverages(records, zones) {
  const zoneAvg = {};

  for (const zone of zones) {
    zoneAvg[zone] = { sum: 0, count: 0, avg: 0 };
  }

  for (const record of records) {
    for (const zone of zones) {
      if (record[zone] !== undefined) {
        zoneAvg[zone].sum += record[zone];
        zoneAvg[zone].count += 1;
      }
    }
  }

  for (const zone of zones) {
    if (zoneAvg[zone].count > 0) {
      zoneAvg[zone].avg = zoneAvg[zone].sum / zoneAvg[zone].count;
    }
  }

  return zoneAvg;
}

// Get demand for a specific datetime and zone
function getDemand(date, zone, profiles, monthlyAvg, zoneAvg, hourlyPatterns) {
  const month = date.getMonth();
  const dow = date.getDay();
  const hour = date.getHours();

  // Try exact profile first
  let demand = profiles[zone][month]?.[dow]?.[hour]?.avg;

  if (!demand) {
    // Try same month, any weekday/weekend
    const isWeekend = dow === 0 || dow === 6;
    const fallbackDows = isWeekend ? [0, 6] : [1, 2, 3, 4, 5];

    for (const d of fallbackDows) {
      const val = profiles[zone][month]?.[d]?.[hour]?.avg;
      if (val) {
        demand = val;
        break;
      }
    }
  }

  if (!demand) {
    // Try nearby months with same dow/hour
    const nearbyMonths = [
      (month + 1) % 12,
      (month + 11) % 12,
      (month + 2) % 12,
      (month + 10) % 12
    ];

    for (const m of nearbyMonths) {
      const val = profiles[zone][m]?.[dow]?.[hour]?.avg;
      if (val) {
        // Apply seasonal adjustment
        const targetMonthAvg = monthlyAvg[zone][month]?.avg || zoneAvg[zone]?.avg;
        const sourceMonthAvg = monthlyAvg[zone][m]?.avg || zoneAvg[zone]?.avg;

        if (targetMonthAvg && sourceMonthAvg && sourceMonthAvg > 0) {
          demand = val * (targetMonthAvg / sourceMonthAvg);
        } else {
          demand = val;
        }
        break;
      }
    }
  }

  if (!demand) {
    // Use monthly average with hourly pattern
    const monthAvg = monthlyAvg[zone][month]?.avg;
    const hourPattern = hourlyPatterns[zone]?.[hour];

    if (monthAvg && hourPattern) {
      demand = monthAvg * hourPattern;
    } else if (monthAvg) {
      demand = monthAvg;
    } else {
      demand = zoneAvg[zone]?.avg || 0;
    }
  }

  return demand;
}

// Build hourly patterns (relative to daily average)
function buildHourlyPatterns(records, zones) {
  const hourlySum = {};
  const hourlyCount = {};
  const dailyAvg = {};

  for (const zone of zones) {
    hourlySum[zone] = {};
    hourlyCount[zone] = {};
    for (let h = 0; h < 24; h++) {
      hourlySum[zone][h] = 0;
      hourlyCount[zone][h] = 0;
    }
    dailyAvg[zone] = { sum: 0, count: 0 };
  }

  for (const record of records) {
    const hour = record.date.getHours();
    for (const zone of zones) {
      if (record[zone] !== undefined) {
        hourlySum[zone][hour] += record[zone];
        hourlyCount[zone][hour] += 1;
        dailyAvg[zone].sum += record[zone];
        dailyAvg[zone].count += 1;
      }
    }
  }

  const patterns = {};
  for (const zone of zones) {
    patterns[zone] = {};
    const overallAvg = dailyAvg[zone].sum / (dailyAvg[zone].count || 1);

    for (let h = 0; h < 24; h++) {
      const hourAvg = hourlySum[zone][h] / (hourlyCount[zone][h] || 1);
      patterns[zone][h] = overallAvg > 0 ? hourAvg / overallAvg : 1;
    }
  }

  return patterns;
}

// Calculate growth factor based on date
function getGrowthFactor(date) {
  const baseDate = new Date('2025-07-01');
  const daysDiff = (date - baseDate) / (1000 * 60 * 60 * 24);
  const dailyGrowth = Math.pow(1 + ANNUAL_GROWTH_RATE, 1 / 365) - 1;
  return 1 + (dailyGrowth * daysDiff);
}

// Philippines holidays for 2026
const HOLIDAYS_2026 = [
  '2026-01-01', // New Year's Day
  '2026-01-25', // Chinese New Year
  '2026-02-25', // EDSA Revolution Anniversary
  '2026-04-03', // Good Friday
  '2026-04-04', // Black Saturday
  '2026-04-09', // Araw ng Kagitingan
  '2026-05-01', // Labor Day
  '2026-06-12', // Independence Day
  '2026-07-17', // Eid'l Adha (approx)
  '2026-08-21', // Ninoy Aquino Day
  '2026-08-31', // National Heroes Day
  '2026-11-01', // All Saints Day
  '2026-11-30', // Bonifacio Day
  '2026-12-24', // Christmas Eve
  '2026-12-25', // Christmas Day
  '2026-12-30', // Rizal Day
  '2026-12-31', // New Year's Eve
  '2027-01-01', // New Year's Day
];

function isHoliday(date) {
  const dateStr = date.toISOString().split('T')[0];
  return HOLIDAYS_2026.includes(dateStr);
}

// Apply holiday adjustment (reduce demand similar to Sunday)
function applyHolidayAdjustment(demand, date, zone, profiles) {
  if (!isHoliday(date)) return demand;

  const month = date.getMonth();
  const hour = date.getHours();
  const dow = date.getDay();

  // Get Sunday (dow=0) profile for same month/hour
  const sundayDemand = profiles[zone][month]?.[0]?.[hour]?.avg;
  const regularDemand = profiles[zone][month]?.[dow]?.[hour]?.avg;

  if (sundayDemand && regularDemand && regularDemand > 0) {
    const ratio = sundayDemand / regularDemand;
    return demand * ratio;
  }

  // Default: reduce by 8%
  return demand * 0.92;
}

// Main execution
function main() {
  console.log('=== Year-Long Demand Extrapolation ===\n');
  console.log(`Forecast period: ${formatDate(START_DATE)} to ${formatDate(END_DATE)}`);
  console.log(`Annual growth rate: ${(ANNUAL_GROWTH_RATE * 100).toFixed(1)}%\n`);

  // Load historical data
  const { records, zones } = loadHistoricalData();

  // Build profiles
  const profiles = buildProfiles(records, zones);
  const monthlyAvg = buildMonthlyAverages(records, zones);
  const zoneAvg = buildZoneAverages(records, zones);
  const hourlyPatterns = buildHourlyPatterns(records, zones);

  // Log profile coverage
  console.log('\nProfile coverage by month:');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  for (let m = 0; m < 12; m++) {
    const count = profiles[zones[0]][m][1][12]?.count || 0;
    const status = count > 0 ? `✓ ${count} samples` : '✗ interpolated';
    console.log(`  ${months[m]}: ${status}`);
  }

  // Generate forecast
  console.log('\nGenerating hourly forecast...');
  const forecast = [];
  let currentDate = new Date(START_DATE);

  while (currentDate <= END_DATE) {
    const row = { date: new Date(currentDate) };
    const growthFactor = getGrowthFactor(currentDate);

    for (const zone of zones) {
      let demand = getDemand(currentDate, zone, profiles, monthlyAvg, zoneAvg, hourlyPatterns);
      demand = applyHolidayAdjustment(demand, currentDate, zone, profiles);
      demand *= growthFactor;
      row[zone] = Math.round(demand);
    }

    forecast.push(row);
    currentDate = new Date(currentDate.getTime() + 60 * 60 * 1000); // Add 1 hour
  }

  console.log(`Generated ${forecast.length} hourly records`);

  // Write output
  const outputDir = path.dirname(OUTPUT_FILE);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const header = ['DateTimeEnding', ...zones].join(',');
  const rows = forecast.map(row => {
    const values = [formatDate(row.date)];
    for (const zone of zones) {
      values.push(row[zone]);
    }
    return values.join(',');
  });

  fs.writeFileSync(OUTPUT_FILE, [header, ...rows].join('\n'));
  console.log(`\nOutput written to: ${OUTPUT_FILE}`);

  // Summary statistics
  console.log('\n=== Summary Statistics ===');
  const totalZones = {};
  for (const zone of zones) {
    totalZones[zone] = { min: Infinity, max: -Infinity, sum: 0 };
  }

  for (const row of forecast) {
    for (const zone of zones) {
      const val = row[zone];
      totalZones[zone].min = Math.min(totalZones[zone].min, val);
      totalZones[zone].max = Math.max(totalZones[zone].max, val);
      totalZones[zone].sum += val;
    }
  }

  console.log('\nZone statistics (MW):');
  console.log('Zone         Min     Max     Avg');
  console.log('-'.repeat(40));
  for (const zone of zones) {
    const avg = Math.round(totalZones[zone].sum / forecast.length);
    console.log(`${zone.padEnd(12)} ${String(totalZones[zone].min).padStart(6)} ${String(totalZones[zone].max).padStart(7)} ${String(avg).padStart(7)}`);
  }

  // Calculate total system demand
  let totalMin = Infinity, totalMax = -Infinity, totalSum = 0;
  for (const row of forecast) {
    let hourTotal = 0;
    for (const zone of zones) {
      hourTotal += row[zone];
    }
    totalMin = Math.min(totalMin, hourTotal);
    totalMax = Math.max(totalMax, hourTotal);
    totalSum += hourTotal;
  }

  console.log('-'.repeat(40));
  console.log(`${'TOTAL'.padEnd(12)} ${String(totalMin).padStart(6)} ${String(totalMax).padStart(7)} ${String(Math.round(totalSum / forecast.length)).padStart(7)}`);

  console.log('\n✓ Year-long demand forecast complete!');
}

main();
