#!/usr/bin/env node
/**
 * Simple script to get database info for the GUI
 * Usage: node scripts/db-info.cjs <database-path>
 */

const Database = require('better-sqlite3');
const path = require('path');

const dbPath = process.argv[2];

if (!dbPath) {
  console.error(JSON.stringify({ success: false, message: 'No database path provided' }));
  process.exit(1);
}

try {
  const fullPath = path.isAbsolute(dbPath) ? dbPath : path.join(process.cwd(), dbPath);
  const db = new Database(fullPath, { readonly: true });

  const result = {
    success: true,
    demand: { records: 0, range: null, regions: [] },
    cfac: { records: 0, range: null },
    weather: { records: 0, range: null }
  };

  // Get demand info (table: demand_records)
  try {
    const demandCount = db.prepare('SELECT COUNT(*) as count FROM demand_records').get();
    const demandRange = db.prepare('SELECT MIN(datetime) as min_date, MAX(datetime) as max_date FROM demand_records').get();
    const regions = db.prepare('SELECT DISTINCT region FROM demand_records ORDER BY region').all();
    result.demand.records = demandCount?.count || 0;
    if (demandRange?.min_date && demandRange?.max_date) {
      result.demand.range = `${demandRange.min_date.substring(0, 10)} to ${demandRange.max_date.substring(0, 10)}`;
    }
    result.demand.regions = regions.map(r => r.region);
  } catch (e) {
    // Table might not exist
  }

  // Get weather info (table: weather_records)
  try {
    const weatherCount = db.prepare('SELECT COUNT(*) as count FROM weather_records').get();
    const weatherRange = db.prepare('SELECT MIN(datetime) as min_date, MAX(datetime) as max_date FROM weather_records').get();
    result.weather.records = weatherCount?.count || 0;
    if (weatherRange?.min_date && weatherRange?.max_date) {
      result.weather.range = `${weatherRange.min_date.substring(0, 10)} to ${weatherRange.max_date.substring(0, 10)}`;
    }
  } catch (e) {
    // Table might not exist
  }

  // Get cluster weather info (for CFAC - tables: cluster_weather_historical + cluster_weather_forecast)
  try {
    const histCount = db.prepare('SELECT COUNT(*) as count FROM cluster_weather_historical').get();
    const fcstCount = db.prepare('SELECT COUNT(*) as count FROM cluster_weather_forecast').get();
    result.cfac.records = (histCount?.count || 0) + (fcstCount?.count || 0);

    const histRange = db.prepare('SELECT MIN(datetime) as min_date, MAX(datetime) as max_date FROM cluster_weather_historical').get();
    if (histRange?.min_date && histRange?.max_date) {
      result.cfac.range = `${histRange.min_date.substring(0, 10)} to ${histRange.max_date.substring(0, 10)}`;
    }
  } catch (e) {
    // Table might not exist
  }

  db.close();
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(JSON.stringify({ success: false, message: error.message }));
  process.exit(1);
}
