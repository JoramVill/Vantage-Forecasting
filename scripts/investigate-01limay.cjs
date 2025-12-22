/**
 * Investigate 01LIMAY_S station - Why is it showing +296% error?
 */
const fs = require('fs');

const actualFile = 'Data Samples/Capacity Factor/MRHCFac_H7D1201.csv';
const defaultFile = 'output/cfac_dec_default.csv';
const seasonal096File = 'output/cfac_dec_seasonal_096.csv';

function parseCSV(content) {
  const lines = content.split('\n').filter(l => l.trim());
  if (lines.length < 2) return { headers: [], rows: [] };
  const headers = lines[0].split(',').map(h => h.trim());
  const rows = lines.slice(1).map(l => l.split(',').map(v => v.trim()));
  return { headers, rows };
}

const actual = parseCSV(fs.readFileSync(actualFile, 'utf-8'));
const defaultForecast = parseCSV(fs.readFileSync(defaultFile, 'utf-8'));
let seasonal096 = null;
try {
  seasonal096 = parseCSV(fs.readFileSync(seasonal096File, 'utf-8'));
} catch (e) {
  console.log('Note: seasonal 0.96 file not found');
}

// Find 01LIMAY_S column index in each file
function findColumnIndex(headers, stationCode) {
  return headers.findIndex(h => h === stationCode || h.includes(stationCode));
}

const stationCode = '01LIMAY';

const actualIdx = findColumnIndex(actual.headers, stationCode);
const defaultIdx = findColumnIndex(defaultForecast.headers, stationCode);
const seasonal096Idx = seasonal096 ? findColumnIndex(seasonal096.headers, stationCode) : -1;

console.log('═══════════════════════════════════════════════════════════════════════════════');
console.log('       01LIMAY_S STATION INVESTIGATION');
console.log('═══════════════════════════════════════════════════════════════════════════════');
console.log('');

console.log(`Column indices:`);
console.log(`  Actual file:      ${actualIdx >= 0 ? actualIdx : 'NOT FOUND'}`);
console.log(`  Default file:     ${defaultIdx >= 0 ? defaultIdx : 'NOT FOUND'}`);
console.log(`  Seasonal 0.96:    ${seasonal096Idx >= 0 ? seasonal096Idx : 'NOT FOUND'}`);
console.log('');

if (actualIdx < 0) {
  console.log('ERROR: 01LIMAY_S not found in actual data!');
  console.log('Available headers:', actual.headers.slice(0, 20));
  process.exit(1);
}

// Show row-by-row comparison for daylight hours
console.log('Hourly comparison (daytime hours 6:00-18:00):');
console.log('─'.repeat(85));
console.log('Datetime                | Actual  | Default | Seasonal| Def Err | Sea Err');
console.log('─'.repeat(85));

let sumActual = 0, sumDefault = 0, sumSeasonal = 0, count = 0;
let sumAbsErrDefault = 0, sumAbsErrSeasonal = 0;

for (let i = 0; i < actual.rows.length; i++) {
  const actualRow = actual.rows[i];
  const datetime = actualRow[0];

  // Parse hour
  const hourMatch = datetime.match(/\s+(\d+):/);
  if (!hourMatch) continue;
  const hour = parseInt(hourMatch[1], 10);
  if (hour < 6 || hour > 18) continue;

  const actualCf = parseFloat(actualRow[actualIdx]);
  if (isNaN(actualCf) || actualCf < 0.01) continue;

  // Find matching row in default
  const defaultRow = defaultForecast.rows.find(r => r[0] === datetime);
  const seasonal096Row = seasonal096 ? seasonal096.rows.find(r => r[0] === datetime) : null;

  const defaultCf = defaultRow && defaultIdx >= 0 ? parseFloat(defaultRow[defaultIdx]) : NaN;
  const seasonal096Cf = seasonal096Row && seasonal096Idx >= 0 ? parseFloat(seasonal096Row[seasonal096Idx]) : NaN;

  if (!isNaN(defaultCf)) {
    const defErr = ((defaultCf - actualCf) / actualCf * 100);
    const seaErr = !isNaN(seasonal096Cf) ? ((seasonal096Cf - actualCf) / actualCf * 100) : NaN;

    console.log(`${datetime.padEnd(23)} | ${(actualCf * 100).toFixed(1).padStart(5)}%  | ${(defaultCf * 100).toFixed(1).padStart(5)}%   | ${!isNaN(seasonal096Cf) ? (seasonal096Cf * 100).toFixed(1).padStart(5) + '%  ' : '  N/A   '}| ${defErr >= 0 ? '+' : ''}${defErr.toFixed(0).padStart(4)}%   | ${!isNaN(seaErr) ? (seaErr >= 0 ? '+' : '') + seaErr.toFixed(0).padStart(4) + '%' : ' N/A'}`);

    sumActual += actualCf;
    sumDefault += defaultCf;
    sumAbsErrDefault += Math.abs(defaultCf - actualCf);
    if (!isNaN(seasonal096Cf)) {
      sumSeasonal += seasonal096Cf;
      sumAbsErrSeasonal += Math.abs(seasonal096Cf - actualCf);
    }
    count++;
  }
}

console.log('─'.repeat(85));
console.log('');
console.log('Summary for 01LIMAY_S:');
console.log(`  Total samples: ${count}`);
console.log(`  Avg Actual CF: ${(sumActual / count * 100).toFixed(1)}%`);
console.log(`  Avg Default CF: ${(sumDefault / count * 100).toFixed(1)}%`);
if (sumSeasonal > 0) {
  console.log(`  Avg Seasonal CF: ${(sumSeasonal / count * 100).toFixed(1)}%`);
}
console.log('');
console.log(`  Default MAPE: ${(sumAbsErrDefault / sumActual * 100).toFixed(1)}%`);
console.log(`  Default Bias: ${((sumDefault - sumActual) / count * 100 >= 0 ? '+' : '')}${((sumDefault - sumActual) / count * 100).toFixed(1)}% CF`);
if (sumSeasonal > 0) {
  console.log(`  Seasonal MAPE: ${(sumAbsErrSeasonal / sumActual * 100).toFixed(1)}%`);
  console.log(`  Seasonal Bias: ${((sumSeasonal - sumActual) / count * 100 >= 0 ? '+' : '')}${((sumSeasonal - sumActual) / count * 100).toFixed(1)}% CF`);
}

// Check if 01LIMAY_S is in all files with different headers
console.log('');
console.log('─'.repeat(85));
console.log('Checking header names in each file:');
console.log('  Actual headers containing LIMAY:', actual.headers.filter(h => h.includes('LIMAY')));
console.log('  Default headers containing LIMAY:', defaultForecast.headers.filter(h => h.includes('LIMAY')));
if (seasonal096) {
  console.log('  Seasonal headers containing LIMAY:', seasonal096.headers.filter(h => h.includes('LIMAY')));
}

// Check all solar stations with extreme errors
console.log('');
console.log('═══════════════════════════════════════════════════════════════════════════════');
console.log('       ALL SOLAR STATIONS WITH EXTREME ERRORS (>50% MAPE)');
console.log('═══════════════════════════════════════════════════════════════════════════════');

const solarStations = actual.headers.filter(h => h.endsWith('_S'));
const extremeErrors = [];

for (const station of solarStations) {
  const stIdx = actual.headers.indexOf(station);
  const defIdx = defaultForecast.headers.indexOf(station);
  if (stIdx < 0 || defIdx < 0) continue;

  let sSum = 0, dSum = 0, errSum = 0, cnt = 0;

  for (const actualRow of actual.rows) {
    const datetime = actualRow[0];
    const hourMatch = datetime.match(/\s+(\d+):/);
    if (!hourMatch) continue;
    const hour = parseInt(hourMatch[1], 10);
    if (hour < 6 || hour > 18) continue;

    const aCf = parseFloat(actualRow[stIdx]);
    if (isNaN(aCf) || aCf < 0.01) continue;

    const defRow = defaultForecast.rows.find(r => r[0] === datetime);
    if (!defRow) continue;
    const dCf = parseFloat(defRow[defIdx]);
    if (isNaN(dCf)) continue;

    sSum += aCf;
    dSum += dCf;
    errSum += Math.abs(dCf - aCf);
    cnt++;
  }

  if (cnt > 5) {
    const mape = (errSum / sSum) * 100;
    const bias = ((dSum - sSum) / cnt) * 100;
    if (mape > 50 || Math.abs(bias) > 20) {
      extremeErrors.push({ station, mape, bias, count: cnt });
    }
  }
}

extremeErrors.sort((a, b) => b.mape - a.mape);

console.log('Station          | MAPE     | Bias      | Samples');
console.log('─'.repeat(55));
for (const e of extremeErrors) {
  console.log(`${e.station.padEnd(16)} | ${e.mape.toFixed(1).padStart(6)}%  | ${e.bias >= 0 ? '+' : ''}${e.bias.toFixed(1).padStart(5)}% CF | ${e.count}`);
}
console.log('');
