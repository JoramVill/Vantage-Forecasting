/**
 * Check Training Data Distribution by Day Type
 *
 * Verify that we have sufficient data for each day type, especially Sunday
 */

const Database = require('better-sqlite3');
const { join } = require('path');
const { existsSync } = require('fs');
const { DateTime } = require('luxon');

async function main() {
  console.log('');
  console.log('='.repeat(80));
  console.log('TRAINING DATA DISTRIBUTION BY DAY TYPE');
  console.log('='.repeat(80));
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

  console.log('Total records: ' + rows.length);
  console.log('');

  // Group by region and day type
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const regions = ['CLUZ', 'CVIS', 'CMIN'];

  for (const region of regions) {
    const regionRows = rows.filter(r => r.region === region);
    console.log('-'.repeat(60));
    console.log(region + ' - ' + regionRows.length + ' records');
    console.log('-'.repeat(60));

    // Count by day of week
    const dayCounts = [0, 0, 0, 0, 0, 0, 0]; // Sun, Mon, ..., Sat
    const dayDemands = [[], [], [], [], [], [], []];

    for (const row of regionRows) {
      const dt = DateTime.fromISO(row.datetime);
      const dow = dt.weekday % 7; // Convert Luxon weekday (1=Mon, 7=Sun) to (0=Sun, 1=Mon, ...)
      dayCounts[dow]++;
      dayDemands[dow].push(row.demand);
    }

    console.log('');
    console.log('Day       Records    Avg Demand   Min        Max        Samples/Day');
    console.log('-'.repeat(70));

    for (let dow = 0; dow < 7; dow++) {
      const demands = dayDemands[dow];
      if (demands.length === 0) {
        console.log(dayNames[dow].padEnd(10) + '0'.padStart(8));
        continue;
      }

      const avg = demands.reduce((a, b) => a + b, 0) / demands.length;
      const min = Math.min(...demands);
      const max = Math.max(...demands);
      const uniqueDays = new Set(
        regionRows.filter(r => {
          const dt = DateTime.fromISO(r.datetime);
          return dt.weekday % 7 === dow;
        }).map(r => DateTime.fromISO(r.datetime).toISODate())
      ).size;

      console.log(
        dayNames[dow].padEnd(10) +
        demands.length.toString().padStart(8) +
        avg.toFixed(0).padStart(12) +
        min.toFixed(0).padStart(10) +
        max.toFixed(0).padStart(10) +
        uniqueDays.toString().padStart(14)
      );
    }

    console.log('');

    // Check for Sunday-specific issues
    const sundayDemands = dayDemands[0];
    const weekdayDemands = [...dayDemands[1], ...dayDemands[2], ...dayDemands[3], ...dayDemands[4], ...dayDemands[5]];

    if (sundayDemands.length > 0 && weekdayDemands.length > 0) {
      const sundayAvg = sundayDemands.reduce((a, b) => a + b, 0) / sundayDemands.length;
      const weekdayAvg = weekdayDemands.reduce((a, b) => a + b, 0) / weekdayDemands.length;
      const sundayRatio = (sundayAvg / weekdayAvg) * 100;

      console.log('Sunday vs Weekday Comparison:');
      console.log('  Sunday avg:   ' + sundayAvg.toFixed(0) + ' MW');
      console.log('  Weekday avg:  ' + weekdayAvg.toFixed(0) + ' MW');
      console.log('  Sunday/Weekday ratio: ' + sundayRatio.toFixed(1) + '%');
      if (sundayRatio < 95) {
        console.log('  >>> Sunday demand is ' + (100 - sundayRatio).toFixed(1) + '% LOWER than weekday');
      }
    }
    console.log('');
  }

  // Check date range
  const minDate = DateTime.fromISO(rows[0].datetime);
  const maxDate = DateTime.fromISO(rows[rows.length - 1].datetime);
  console.log('='.repeat(80));
  console.log('Date Range: ' + minDate.toISODate() + ' to ' + maxDate.toISODate());
  console.log('='.repeat(80));

  db.close();
}

main().catch(console.error);
