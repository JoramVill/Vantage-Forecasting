const Database = require('better-sqlite3');

// Try data/iload.db (regional demand DB)
let db;
try {
  db = new Database('data/iload.db');
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
  console.log('Using data/iload.db - Tables:', tables.map(t => t.name).join(', '));
} catch (e) {
  console.log('data/iload.db failed, trying iload.db');
  try {
    db = new Database('iload.db');
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    console.log('Using iload.db - Tables:', tables.map(t => t.name).join(', '));
  } catch (e2) {
    console.log('iload.db failed, trying forecast.db');
    db = new Database('forecast.db');
  }
}

console.log('\n=== Historical CLUZ Demand at Hour 14 (Weekdays Only) ===\n');
console.log('Date       | DoW | Demand(MW) | Diff');
console.log('-----------|-----|------------|------');

// Check which table to use
let rows = [];
try {
  rows = db.prepare("SELECT DateTimeEnding as datetime, CLUZ as demand FROM demand ORDER BY DateTimeEnding DESC LIMIT 500").all();
  console.log('Found', rows.length, 'records in demand table');
} catch (e) {
  try {
    rows = db.prepare("SELECT datetime, demand FROM demand_records WHERE region = 'CLUZ' ORDER BY datetime DESC LIMIT 500").all();
    console.log('Found', rows.length, 'records in demand_records table');
  } catch (e2) {
    console.log('No demand data found');
  }
}

const hour14 = rows.filter(x => x.datetime.includes('T14:') || x.datetime.includes(' 14:'));

let prevDemand = null;
for (const row of hour14.slice(0, 20)) {
  const date = new Date(row.datetime);
  const dow = date.getDay();
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  // Only show weekdays
  if (dow === 0 || dow === 6) continue;

  const diff = prevDemand ? (row.demand - prevDemand).toFixed(0) : 'N/A';
  console.log(`${row.datetime.slice(0, 10)} | ${dayNames[dow]} | ${row.demand.toFixed(0).padStart(10)} | ${diff}`);
  prevDemand = row.demand;
}

db.close();
