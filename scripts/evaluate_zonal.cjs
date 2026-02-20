const { parse } = require('csv-parse/sync');
const fs = require('fs');
const Database = require('better-sqlite3');

function evaluate(forecastFile, periodName, dbStartDate, dbEndDate) {
  const forecastCsv = fs.readFileSync(forecastFile, 'utf-8');
  const forecastRows = parse(forecastCsv, { columns: true, skip_empty_lines: true, trim: true, relax_column_count: true });

  const db = new Database('data/iload_zonal.db');
  const actuals = db.prepare(
    `SELECT datetime, region, demand FROM demand_records WHERE datetime >= ? AND datetime < ? ORDER BY datetime, region`
  ).all(dbStartDate, dbEndDate);
  db.close();

  const actualMap = new Map();
  for (const row of actuals) {
    const dt = new Date(row.datetime);
    const m = dt.getMonth() + 1;
    const d = dt.getDate();
    const y = dt.getFullYear();
    const hh = String(dt.getHours()).padStart(2, '0');
    const mm = String(dt.getMinutes()).padStart(2, '0');
    const key = m + '/' + d + '/' + y + ' ' + hh + ':' + mm + '_' + row.region;
    actualMap.set(key, row.demand);
  }

  console.log('Actual records loaded:', actuals.length);
  console.log('Forecast rows:', forecastRows.length);

  const zones = Object.keys(forecastRows[0]).filter(k => k !== 'DateTimeEnding');
  console.log('Forecast zones:', zones.join(', '));

  const zoneMetrics = {};
  for (const zone of zones) {
    zoneMetrics[zone] = { errors: [], absErrors: [], pctErrors: [], count: 0, forecastSum: 0, actualSum: 0 };
  }

  let totalMatched = 0;
  let totalUnmatched = 0;

  for (const row of forecastRows) {
    const dtStr = row['DateTimeEnding'];
    for (const zone of zones) {
      const forecast = parseFloat(row[zone]);
      if (isNaN(forecast)) continue;
      const key = dtStr + '_' + zone;
      const actual = actualMap.get(key);
      if (actual !== undefined && actual > 0) {
        const error = forecast - actual;
        const absError = Math.abs(error);
        const pctError = (absError / actual) * 100;
        zoneMetrics[zone].errors.push(error);
        zoneMetrics[zone].absErrors.push(absError);
        zoneMetrics[zone].pctErrors.push(pctError);
        zoneMetrics[zone].count++;
        zoneMetrics[zone].forecastSum += forecast;
        zoneMetrics[zone].actualSum += actual;
        totalMatched++;
      } else {
        totalUnmatched++;
      }
    }
  }

  console.log('\nMatched records:', totalMatched);
  console.log('Unmatched records:', totalUnmatched);

  if (totalMatched === 0) {
    console.log('\nNo matched records for evaluation.');
    return;
  }

  console.log('\n' + '='.repeat(105));
  console.log(periodName + ' ZONAL FORECAST EVALUATION');
  console.log('='.repeat(105));
  console.log(
    'Zone'.padEnd(12) + 'MAPE%'.padStart(8) + 'MAE(MW)'.padStart(10) +
    'RMSE(MW)'.padStart(10) + 'Bias(MW)'.padStart(10) + 'Bias%'.padStart(8) +
    'AvgFcst'.padStart(10) + 'AvgAct'.padStart(10) + 'Count'.padStart(8)
  );
  console.log('-'.repeat(105));

  let allPctErrors = [];
  let allAbsErrors = [];
  let allErrors = [];
  let totalFcst = 0;
  let totalAct = 0;

  for (const zone of zones) {
    const m = zoneMetrics[zone];
    if (m.count === 0) {
      console.log(zone.padEnd(12) + 'No data');
      continue;
    }

    const mape = m.pctErrors.reduce((a, b) => a + b, 0) / m.count;
    const mae = m.absErrors.reduce((a, b) => a + b, 0) / m.count;
    const mse = m.errors.reduce((a, b) => a + b * b, 0) / m.count;
    const rmse = Math.sqrt(mse);
    const bias = m.errors.reduce((a, b) => a + b, 0) / m.count;
    const avgFcst = m.forecastSum / m.count;
    const avgAct = m.actualSum / m.count;
    const biasPct = ((avgFcst - avgAct) / avgAct * 100);

    console.log(
      zone.padEnd(12) +
      mape.toFixed(2).padStart(8) +
      mae.toFixed(1).padStart(10) +
      rmse.toFixed(1).padStart(10) +
      bias.toFixed(1).padStart(10) +
      biasPct.toFixed(1).padStart(8) +
      avgFcst.toFixed(1).padStart(10) +
      avgAct.toFixed(1).padStart(10) +
      String(m.count).padStart(8)
    );

    allPctErrors.push(...m.pctErrors);
    allAbsErrors.push(...m.absErrors);
    allErrors.push(...m.errors);
    totalFcst += m.forecastSum;
    totalAct += m.actualSum;
  }

  console.log('-'.repeat(105));
  const n = allPctErrors.length;
  const overallMape = allPctErrors.reduce((a, b) => a + b, 0) / n;
  const overallMae = allAbsErrors.reduce((a, b) => a + b, 0) / n;
  const overallRmse = Math.sqrt(allErrors.reduce((a, b) => a + b * b, 0) / n);
  const overallBias = allErrors.reduce((a, b) => a + b, 0) / n;
  const overallBiasPct = ((totalFcst/n - totalAct/n) / (totalAct/n) * 100);
  console.log(
    'OVERALL'.padEnd(12) +
    overallMape.toFixed(2).padStart(8) +
    overallMae.toFixed(1).padStart(10) +
    overallRmse.toFixed(1).padStart(10) +
    overallBias.toFixed(1).padStart(10) +
    overallBiasPct.toFixed(1).padStart(8) +
    (totalFcst/n).toFixed(1).padStart(10) +
    (totalAct/n).toFixed(1).padStart(10) +
    String(n).padStart(8)
  );
  console.log('='.repeat(105));

  // Weekend vs weekday analysis
  const dayTypes = { weekday: { pctErrors: [], count: 0 }, saturday: { pctErrors: [], count: 0 }, sunday: { pctErrors: [], count: 0 } };

  for (const row of forecastRows) {
    const dtStr = row['DateTimeEnding'];
    const parts = dtStr.split(' ');
    const dateParts = parts[0].split('/');
    const dt = new Date(parseInt(dateParts[2]), parseInt(dateParts[0]) - 1, parseInt(dateParts[1]));
    const dow = dt.getDay();
    const dayType = dow === 0 ? 'sunday' : dow === 6 ? 'saturday' : 'weekday';

    for (const zone of zones) {
      const forecast = parseFloat(row[zone]);
      if (isNaN(forecast)) continue;
      const key = dtStr + '_' + zone;
      const actual = actualMap.get(key);
      if (actual !== undefined && actual > 0) {
        const pctError = (Math.abs(forecast - actual) / actual) * 100;
        dayTypes[dayType].pctErrors.push(pctError);
        dayTypes[dayType].count++;
      }
    }
  }

  console.log('\nWeekend Analysis:');
  for (const [type, data] of Object.entries(dayTypes)) {
    if (data.count > 0) {
      const mape = data.pctErrors.reduce((a, b) => a + b, 0) / data.count;
      console.log('  ' + type.padEnd(12) + 'MAPE: ' + mape.toFixed(2) + '%  (n=' + data.count + ')');
    }
  }
}

// Run evaluations
console.log('\n');
evaluate('output/zonal_dec.csv', 'DECEMBER 2025', '2025-12-01', '2026-01-01');
console.log('\n\n');
evaluate('output/zonal_jan.csv', 'JANUARY 2026', '2026-01-01', '2026-02-01');
