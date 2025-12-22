/**
 * Check Model Profile Stats for Sunday vs Weekday
 *
 * Verify what median/min/max values the model learns for each day type
 */

const { readFileSync, existsSync, readdirSync } = require('fs');
const { join } = require('path');
const Database = require('better-sqlite3');
const { DateTime } = require('luxon');

async function main() {
  console.log('');
  console.log('='.repeat(90));
  console.log('MODEL PROFILE ANALYSIS - SUNDAY VS WEEKDAY');
  console.log('='.repeat(90));
  console.log('');

  const dbPath = join(process.cwd(), 'data', 'iload.db');
  if (!existsSync(dbPath)) {
    console.log('Database not found');
    return;
  }

  const db = new Database(dbPath);

  // Get all demand records
  const stmt = db.prepare(`
    SELECT datetime, region, demand
    FROM demand_records
    ORDER BY datetime
  `);
  const rows = stmt.all();

  const regions = ['CLUZ', 'CVIS', 'CMIN'];
  const dayTypes = { 0: 'Weekday', 1: 'Saturday', 2: 'Sunday' };

  // Build profiles exactly like the HybridModel does
  for (const region of regions) {
    console.log('═'.repeat(80));
    console.log(region);
    console.log('═'.repeat(80));
    console.log('');

    // Build grouped data by hour_dayType
    const grouped = new Map();

    for (const row of rows) {
      if (row.region !== region) continue;

      const dt = DateTime.fromISO(row.datetime);
      const hour = dt.hour;

      // Match EXACTLY how HybridModel calculates dayType
      // Luxon: weekday 1=Mon, 7=Sun
      // After mod 7: Sun becomes 0, Mon=1, ... Sat=6
      const dayOfWeek = dt.weekday % 7;
      const isSunday = dayOfWeek === 0 ? 1 : 0;
      const isSaturday = dayOfWeek === 6 ? 1 : 0;
      const dayType = isSunday ? 2 : isSaturday ? 1 : 0;

      const key = `${hour}_${dayType}`;

      if (!grouped.has(key)) {
        grouped.set(key, []);
      }
      grouped.get(key).push(row.demand);
    }

    // Calculate profiles
    const profiles = new Map();
    for (const [key, demands] of grouped) {
      demands.sort((a, b) => a - b);
      const p5Index = Math.floor(demands.length * 0.05);
      const p95Index = Math.min(demands.length - 1, Math.floor(demands.length * 0.95));
      const medianIndex = Math.floor(demands.length / 2);

      profiles.set(key, {
        min: demands[p5Index],
        median: demands[medianIndex],
        max: demands[p95Index],
        count: demands.length
      });
    }

    // Compare Sunday vs Weekday for peak hours (10-16)
    console.log('MIDDAY PEAK (10-16) Comparison:');
    console.log('');
    console.log('Hour   ' + 'Weekday Median'.padStart(16) + 'Sunday Median'.padStart(16) + 'Difference'.padStart(14) + 'Sun/WD Ratio'.padStart(14));
    console.log('-'.repeat(72));

    let totalWeekdayMedian = 0;
    let totalSundayMedian = 0;
    let peakHoursCount = 0;

    for (let hour = 10; hour <= 16; hour++) {
      const weekdayProfile = profiles.get(`${hour}_0`);
      const sundayProfile = profiles.get(`${hour}_2`);

      if (weekdayProfile && sundayProfile) {
        const diff = sundayProfile.median - weekdayProfile.median;
        const ratio = (sundayProfile.median / weekdayProfile.median) * 100;

        totalWeekdayMedian += weekdayProfile.median;
        totalSundayMedian += sundayProfile.median;
        peakHoursCount++;

        console.log(
          hour.toString().padEnd(7) +
          weekdayProfile.median.toFixed(0).padStart(16) +
          sundayProfile.median.toFixed(0).padStart(16) +
          diff.toFixed(0).padStart(14) +
          (ratio.toFixed(1) + '%').padStart(14)
        );
      }
    }

    if (peakHoursCount > 0) {
      const avgWeekday = totalWeekdayMedian / peakHoursCount;
      const avgSunday = totalSundayMedian / peakHoursCount;
      console.log('-'.repeat(72));
      console.log(
        'AVG'.padEnd(7) +
        avgWeekday.toFixed(0).padStart(16) +
        avgSunday.toFixed(0).padStart(16) +
        (avgSunday - avgWeekday).toFixed(0).padStart(14) +
        ((avgSunday / avgWeekday * 100).toFixed(1) + '%').padStart(14)
      );
    }

    console.log('');

    // Show full day profile comparison
    console.log('FULL DAY Profile Comparison (Median values):');
    console.log('');
    console.log('Hour   ' + 'Weekday'.padStart(10) + 'Saturday'.padStart(10) + 'Sunday'.padStart(10) + '  Sun as % of WD');
    console.log('-'.repeat(60));

    for (let hour = 0; hour < 24; hour++) {
      const wd = profiles.get(`${hour}_0`);
      const sat = profiles.get(`${hour}_1`);
      const sun = profiles.get(`${hour}_2`);

      if (wd && sat && sun) {
        const ratio = (sun.median / wd.median) * 100;
        console.log(
          hour.toString().padEnd(7) +
          wd.median.toFixed(0).padStart(10) +
          sat.median.toFixed(0).padStart(10) +
          sun.median.toFixed(0).padStart(10) +
          '  ' + ratio.toFixed(1) + '%' + (ratio < 95 ? ' <<< LOWER' : '')
        );
      }
    }

    console.log('');
  }

  db.close();
}

main().catch(console.error);
