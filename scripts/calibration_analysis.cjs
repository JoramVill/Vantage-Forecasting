const fs = require('fs');
const { parse } = require('csv-parse/sync');

// Read forecast
const fcContent = fs.readFileSync('Z:/Forecast_DEM_MRHC/calibration/cfac_calibrated.csv', 'utf-8');
const fcData = parse(fcContent, { columns: true, skip_empty_lines: true });

// Read actual
const actContent = fs.readFileSync('Data Samples/Capacity Factor/MRHCFac_HIST_DEC.csv', 'utf-8');
const actData = parse(actContent, { columns: true, skip_empty_lines: true });

// Wind stations
const windStations = ['01BURGOS', '01LAOAG', '01PAGUDPUD', '02DOLORES', '08BVISTA', '08NABAS_W'];

// Get all solar stations (ending with _S)
const allColumns = Object.keys(fcData[0] || {});
const solarStations = allColumns.filter(k => k.endsWith('_S') && k !== 'DateTimeEnding');

let windFcSum = 0, windActSum = 0, windCount = 0;
let solarFcSum = 0, solarActSum = 0, solarCount = 0;

// Match by datetime
const actMap = new Map();
for (const row of actData) {
  actMap.set(row.DateTimeEnding, row);
}

for (const fcRow of fcData) {
  const dt = fcRow.DateTimeEnding;
  const actRow = actMap.get(dt);
  if (!actRow) continue;

  // Wind
  for (const station of windStations) {
    const fcVal = parseFloat(fcRow[station]) || 0;
    const actVal = parseFloat(actRow[station]) || 0;
    if (actVal > 0.01) {
      windFcSum += fcVal;
      windActSum += actVal;
      windCount++;
    }
  }

  // Solar (only daytime hours 6-18)
  const hour = parseInt(dt.split(' ')[1].split(':')[0]);
  if (hour >= 6 && hour <= 18) {
    for (const station of solarStations) {
      const fcVal = parseFloat(fcRow[station]) || 0;
      const actVal = parseFloat(actRow[station]) || 0;
      if (actVal > 0.01) {
        solarFcSum += fcVal;
        solarActSum += actVal;
        solarCount++;
      }
    }
  }
}

const windRatio = windFcSum > 0 ? windActSum / windFcSum : 1;
const solarRatio = solarFcSum > 0 ? solarActSum / solarFcSum : 1;
const windScaling = (windRatio - 1) * 100;
const solarScaling = (solarRatio - 1) * 100;

console.log('=== CALIBRATION ANALYSIS ===');
console.log('');
console.log('WIND:');
console.log('  Matched Records:', windCount);
console.log('  Forecast Sum:', windFcSum.toFixed(4));
console.log('  Actual Sum:', windActSum.toFixed(4));
console.log('  Ratio (Actual/Forecast):', windRatio.toFixed(4));
console.log('  Scaling Adjustment:', windScaling.toFixed(1) + '%');
console.log('');
console.log('SOLAR:');
console.log('  Matched Records:', solarCount);
console.log('  Forecast Sum:', solarFcSum.toFixed(4));
console.log('  Actual Sum:', solarActSum.toFixed(4));
console.log('  Ratio (Actual/Forecast):', solarRatio.toFixed(4));
console.log('  Scaling Adjustment:', solarScaling.toFixed(1) + '%');
console.log('');
console.log('RECOMMENDED SCALING:');
console.log('  --scale-wind', Math.round(windScaling));
console.log('  --scale-solar', Math.round(solarScaling));
