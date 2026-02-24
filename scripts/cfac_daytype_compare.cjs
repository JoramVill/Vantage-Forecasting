/**
 * CFAC Model Comparison by Day Type
 * Compares multiple CFAC model forecasts against actuals
 * Breaks down MAE and MAPE by: Weekdays, Saturdays, Sundays, and station type
 */

const { parse } = require('csv-parse/sync');
const fs = require('fs');
const path = require('path');

// Philippine holidays for 2026 (January - February)
const PH_HOLIDAYS_2026 = [
  '2026-01-01', // New Year's Day
  '2026-01-29', // Chinese New Year (estimated)
  '2026-02-25', // EDSA Revolution Anniversary
];

// Model configurations to compare
const MODELS = [
  { name: 'Default (Linear)', file: 'cfac_model1_default.csv', shortName: 'Default' },
  { name: 'XGBoost', file: 'cfac_model2_xgboost.csv', shortName: 'XGBoost' },
  { name: 'XGBoost+AsymLoss', file: 'cfac_model3_xgb_asym.csv', shortName: 'XGB+Asym' },
  { name: 'Forecast3 (EMA)', file: 'cfac_model4_forecast3.csv', shortName: 'Forecast3' },
  { name: 'Basic', file: 'cfac_model5_basic.csv', shortName: 'Basic' },
];

// Station type classification
function getStationType(stationCode) {
  if (stationCode === 'SOLAR' || stationCode === 'WIND') return stationCode.toLowerCase();

  // Wind stations
  const windStations = ['01BURGOS', '01LAOAG', '01PAGUDPUD', '02DOLORES', '02MMPP_G01',
                        '03AWOC_G01', '08PWIND_G01', '08WIND_G02', '08NABAS_W', '08BVISTA'];
  if (windStations.includes(stationCode)) return 'wind';

  // By suffix
  if (stationCode.endsWith('_W')) return 'wind';
  if (stationCode.endsWith('_S')) return 'solar';
  if (stationCode.endsWith('_H')) return 'hydro';
  if (stationCode.endsWith('_BI') || stationCode.endsWith('_BG') || stationCode.endsWith('_BL')) return 'biomass';
  if (stationCode.endsWith('_B')) return 'battery';
  if (stationCode.endsWith('_G') || stationCode.endsWith('_GP')) return 'geothermal';

  return 'other';
}

// Day type classification
function getDayType(dateStr) {
  if (!dateStr || typeof dateStr !== 'string') return 'Unknown';
  // Parse date string like "1/10/2026 01:00"
  const parts = dateStr.split(' ')[0].split('/');
  const month = parseInt(parts[0]);
  const day = parseInt(parts[1]);
  const year = parseInt(parts[2]);

  const date = new Date(year, month - 1, day);
  const dayOfWeek = date.getDay();
  const isoDate = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

  if (PH_HOLIDAYS_2026.includes(isoDate)) return 'Holiday';
  if (dayOfWeek === 0) return 'Sunday';
  if (dayOfWeek === 6) return 'Saturday';
  return 'Weekday';
}

// Load and parse CSV
function loadCsv(filePath) {
  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    return null;
  }
  const content = fs.readFileSync(filePath, 'utf-8');
  return parse(content, { columns: true, skip_empty_lines: true, trim: true, relax_column_count: true });
}

// Calculate metrics
function calculateMetrics(errors) {
  if (errors.length === 0) return { mae: NaN, mape: NaN, rmse: NaN, bias: NaN, count: 0 };

  const n = errors.length;
  const mae = errors.reduce((sum, e) => sum + e.absError, 0) / n;
  const mape = errors.reduce((sum, e) => sum + e.pctError, 0) / n;
  const mse = errors.reduce((sum, e) => sum + e.error * e.error, 0) / n;
  const rmse = Math.sqrt(mse);
  const bias = errors.reduce((sum, e) => sum + e.error, 0) / n;

  return { mae, mape, rmse, bias, count: n };
}

// Main evaluation function
function evaluateModels() {
  const outputDir = path.join(__dirname, '..', 'output');
  const actualFile = path.join(__dirname, '..', 'Data Samples', 'Capacity Factor', 'MRHCFac_1-month Historical_JAN.csv');

  // Load actual data
  console.log('Loading actual data...');
  const actualRows = loadCsv(actualFile);
  if (!actualRows) {
    console.error('Failed to load actual data');
    return;
  }

  // Build actual data map: datetime_station -> value
  const actualMap = new Map();
  const stations = Object.keys(actualRows[0]).filter(k => k !== 'DateTimeEnding');

  for (const row of actualRows) {
    const dt = row['DateTimeEnding'];
    for (const station of stations) {
      const value = parseFloat(row[station]);
      if (!isNaN(value) && value >= 0) {
        actualMap.set(`${dt}_${station}`, value);
      }
    }
  }
  console.log(`Loaded ${actualMap.size} actual data points`);
  console.log(`Stations: ${stations.length}`);

  // Classify stations
  const stationTypes = {};
  for (const station of stations) {
    stationTypes[station] = getStationType(station);
  }

  // Count station types
  const typeCount = {};
  for (const station of stations) {
    const type = stationTypes[station];
    typeCount[type] = (typeCount[type] || 0) + 1;
  }
  console.log('\nStation type distribution:');
  for (const [type, count] of Object.entries(typeCount).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${type}: ${count} stations`);
  }

  // Results structure
  const results = {};

  // Process each model
  for (const model of MODELS) {
    console.log(`\nProcessing ${model.name}...`);
    const forecastFile = path.join(outputDir, model.file);
    const forecastRows = loadCsv(forecastFile);

    if (!forecastRows) {
      console.warn(`Skipping ${model.name} - file not found`);
      continue;
    }

    results[model.shortName] = {
      byDayType: { Weekday: [], Saturday: [], Sunday: [], Holiday: [], Unknown: [], All: [] },
      byStationType: { wind: [], solar: [], hydro: [], geothermal: [], biomass: [], battery: [], other: [], all: [] }
    };

    let matched = 0, unmatched = 0;

    for (const row of forecastRows) {
      const dt = row['DateTimeEnding'];
      const dayType = getDayType(dt);

      for (const station of stations) {
        const forecast = parseFloat(row[station]);
        if (isNaN(forecast)) continue;

        const key = `${dt}_${station}`;
        const actual = actualMap.get(key);

        if (actual !== undefined && actual > 0) {
          const error = forecast - actual;
          const absError = Math.abs(error);
          const pctError = (absError / actual) * 100;

          const errorObj = { error, absError, pctError, forecast, actual, station, dayType };

          // Add to day type buckets
          results[model.shortName].byDayType[dayType].push(errorObj);
          results[model.shortName].byDayType['All'].push(errorObj);

          // Add to station type buckets
          const stationType = stationTypes[station];
          results[model.shortName].byStationType[stationType].push(errorObj);
          results[model.shortName].byStationType['all'].push(errorObj);

          matched++;
        } else {
          unmatched++;
        }
      }
    }

    console.log(`  Matched: ${matched}, Unmatched: ${unmatched}`);
  }

  // Generate report
  console.log('\n');
  console.log('='.repeat(120));
  console.log('                    CFAC MODEL COMPARISON REPORT - BY DAY TYPE');
  console.log('                    Evaluation Period: Jan 10 - Feb 2, 2026');
  console.log('='.repeat(120));

  // Table 1: Overall metrics by model
  console.log('\n### OVERALL METRICS (ALL STATIONS, ALL DAY TYPES)');
  console.log('-'.repeat(100));
  console.log('Model'.padEnd(20) + 'MAE'.padStart(10) + 'MAPE%'.padStart(10) + 'RMSE'.padStart(10) +
              'Bias'.padStart(10) + 'Count'.padStart(12));
  console.log('-'.repeat(100));

  for (const model of MODELS) {
    if (!results[model.shortName]) continue;
    const m = calculateMetrics(results[model.shortName].byStationType['all']);
    console.log(
      model.shortName.padEnd(20) +
      m.mae.toFixed(4).padStart(10) +
      m.mape.toFixed(2).padStart(10) +
      m.rmse.toFixed(4).padStart(10) +
      m.bias.toFixed(4).padStart(10) +
      String(m.count).padStart(12)
    );
  }

  // Table 2: Metrics by day type
  const dayTypes = ['Weekday', 'Saturday', 'Sunday', 'Holiday'];

  console.log('\n\n### MAE BY DAY TYPE');
  console.log('-'.repeat(80));
  console.log('Model'.padEnd(20) + dayTypes.map(d => d.padStart(12)).join(''));
  console.log('-'.repeat(80));

  for (const model of MODELS) {
    if (!results[model.shortName]) continue;
    let row = model.shortName.padEnd(20);
    for (const dayType of dayTypes) {
      const m = calculateMetrics(results[model.shortName].byDayType[dayType]);
      row += (m.count > 0 ? m.mae.toFixed(4) : 'N/A').padStart(12);
    }
    console.log(row);
  }

  console.log('\n\n### MAPE% BY DAY TYPE');
  console.log('-'.repeat(80));
  console.log('Model'.padEnd(20) + dayTypes.map(d => d.padStart(12)).join(''));
  console.log('-'.repeat(80));

  for (const model of MODELS) {
    if (!results[model.shortName]) continue;
    let row = model.shortName.padEnd(20);
    for (const dayType of dayTypes) {
      const m = calculateMetrics(results[model.shortName].byDayType[dayType]);
      row += (m.count > 0 ? m.mape.toFixed(2) + '%' : 'N/A').padStart(12);
    }
    console.log(row);
  }

  // Table 3: Metrics by station type
  const stationTypeOrder = ['wind', 'solar', 'hydro', 'geothermal', 'biomass', 'battery', 'other'];

  console.log('\n\n### MAE BY STATION TYPE');
  console.log('-'.repeat(110));
  console.log('Model'.padEnd(18) + stationTypeOrder.map(t => t.padStart(12)).join(''));
  console.log('-'.repeat(110));

  for (const model of MODELS) {
    if (!results[model.shortName]) continue;
    let row = model.shortName.padEnd(18);
    for (const stationType of stationTypeOrder) {
      const m = calculateMetrics(results[model.shortName].byStationType[stationType]);
      row += (m.count > 0 ? m.mae.toFixed(4) : 'N/A').padStart(12);
    }
    console.log(row);
  }

  console.log('\n\n### MAPE% BY STATION TYPE');
  console.log('-'.repeat(110));
  console.log('Model'.padEnd(18) + stationTypeOrder.map(t => t.padStart(12)).join(''));
  console.log('-'.repeat(110));

  for (const model of MODELS) {
    if (!results[model.shortName]) continue;
    let row = model.shortName.padEnd(18);
    for (const stationType of stationTypeOrder) {
      const m = calculateMetrics(results[model.shortName].byStationType[stationType]);
      row += (m.count > 0 ? m.mape.toFixed(2) + '%' : 'N/A').padStart(12);
    }
    console.log(row);
  }

  // Table 4: Combined - Best model per day type per station type
  console.log('\n\n### BEST MODEL BY DAY TYPE AND STATION TYPE (MAPE%)');
  console.log('-'.repeat(120));

  for (const stationType of ['wind', 'solar', 'all']) {
    console.log(`\n${stationType.toUpperCase()} Stations:`);
    console.log('DayType'.padEnd(12) + MODELS.map(m => m.shortName.padStart(14)).join('') + '  Best'.padStart(16));
    console.log('-'.repeat(100));

    for (const dayType of [...dayTypes, 'All']) {
      let row = dayType.padEnd(12);
      let bestMape = Infinity;
      let bestModel = '';

      for (const model of MODELS) {
        if (!results[model.shortName]) continue;

        // Filter by station type and day type
        let errors;
        if (stationType === 'all') {
          errors = results[model.shortName].byDayType[dayType];
        } else {
          errors = results[model.shortName].byStationType[stationType].filter(e =>
            dayType === 'All' || e.dayType === dayType
          );
        }

        const m = calculateMetrics(errors);
        const mapeStr = m.count > 0 ? m.mape.toFixed(2) + '%' : 'N/A';
        row += mapeStr.padStart(14);

        if (m.count > 0 && m.mape < bestMape) {
          bestMape = m.mape;
          bestModel = model.shortName;
        }
      }

      row += ('  ' + bestModel).padStart(16);
      console.log(row);
    }
  }

  // Summary
  console.log('\n\n' + '='.repeat(120));
  console.log('                                    SUMMARY');
  console.log('='.repeat(120));

  // Find overall best model
  let overallBest = { model: '', mape: Infinity };
  let windBest = { model: '', mape: Infinity };
  let solarBest = { model: '', mape: Infinity };

  for (const model of MODELS) {
    if (!results[model.shortName]) continue;

    const allM = calculateMetrics(results[model.shortName].byStationType['all']);
    const windM = calculateMetrics(results[model.shortName].byStationType['wind']);
    const solarM = calculateMetrics(results[model.shortName].byStationType['solar']);

    if (allM.mape < overallBest.mape) {
      overallBest = { model: model.shortName, mape: allM.mape, mae: allM.mae };
    }
    if (windM.mape < windBest.mape) {
      windBest = { model: model.shortName, mape: windM.mape, mae: windM.mae };
    }
    if (solarM.mape < solarBest.mape) {
      solarBest = { model: model.shortName, mape: solarM.mape, mae: solarM.mae };
    }
  }

  console.log(`\nBest Overall Model: ${overallBest.model} (MAPE: ${overallBest.mape.toFixed(2)}%, MAE: ${overallBest.mae.toFixed(4)})`);
  console.log(`Best Wind Model:    ${windBest.model} (MAPE: ${windBest.mape.toFixed(2)}%, MAE: ${windBest.mae.toFixed(4)})`);
  console.log(`Best Solar Model:   ${solarBest.model} (MAPE: ${solarBest.mape.toFixed(2)}%, MAE: ${solarBest.mae.toFixed(4)})`);

  // Day type insights
  console.log('\nDay Type Insights:');
  for (const dayType of dayTypes) {
    let bestModel = '';
    let bestMape = Infinity;

    for (const model of MODELS) {
      if (!results[model.shortName]) continue;
      const m = calculateMetrics(results[model.shortName].byDayType[dayType]);
      if (m.count > 0 && m.mape < bestMape) {
        bestMape = m.mape;
        bestModel = model.shortName;
      }
    }

    if (bestModel) {
      console.log(`  ${dayType.padEnd(10)}: Best = ${bestModel} (MAPE: ${bestMape.toFixed(2)}%)`);
    }
  }

  console.log('\n' + '='.repeat(120));
}

// Run evaluation
evaluateModels();
