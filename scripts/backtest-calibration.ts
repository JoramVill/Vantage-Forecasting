/**
 * Backtest: Hybrid Calibration vs 9.12% MAPE Benchmark
 *
 * Simplified test that directly evaluates calibration approaches
 * using actual demand data.
 */

import { IterativeScalingCalibrator } from '../src/models/IterativeScalingCalibrator.js';
import { DemandCalibrator } from '../src/models/DemandCalibrator.js';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

// Configuration
const DEMAND_DATA_PATH = 'Data Samples/Demand';

// Zonal columns
const ZONAL_COLUMNS = [
  '01NLUZ', '02METRO', '03SLUZ', '04LEYTE', '05CEBU', '06NEGROS',
  '07BOHOL', '08PANAY', '09NWMIN', '10LANAO', '11NCMIN', '12NEMIN',
  '13SEMIN', '14SWMIN'
];

// Regional mapping for aggregation
const LUZON_ZONES = ['01NLUZ', '02METRO', '03SLUZ'];
const VISAYAS_ZONES = ['04LEYTE', '05CEBU', '06NEGROS', '07BOHOL', '08PANAY'];
const MINDANAO_ZONES = ['09NWMIN', '10LANAO', '11NCMIN', '12NEMIN', '13SEMIN', '14SWMIN'];

// Regional columns (for output)
const REGIONS = ['CLUZ', 'CVIS', 'CMIN'];

interface DemandRecord {
  DateTimeEnding: string;
  CLUZ: number;  // Aggregated from zonal
  CVIS: number;
  CMIN: number;
  [key: string]: string | number;
}

/**
 * Load demand data from CSV files (aggregates zonal to regional)
 */
function loadDemandData(startDate: string, endDate: string): DemandRecord[] {
  const startDt = new Date(startDate);
  const endDt = new Date(endDate);
  endDt.setDate(endDt.getDate() + 1);

  const allData: DemandRecord[] = [];
  const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

  // Load from both 2025 and 2024 data
  for (const year of [2025, 2024]) {
    for (const month of months) {
      const file = join(DEMAND_DATA_PATH, `DemHr_${year}_${month}.csv`);
      if (!existsSync(file)) continue;

      const content = readFileSync(file, 'utf-8');
      const lines = content.trim().split('\n');
      const headers = lines[0].split(',').map(h => h.trim());

      for (let i = 1; i < lines.length; i++) {
        const values = lines[i].split(',').map(v => v.trim());
        const rawRecord: any = {};

        for (let j = 0; j < headers.length; j++) {
          const header = headers[j];
          const value = values[j];

          if (header === 'DateTimeEnding' || header === 'datetime') {
            rawRecord.DateTimeEnding = value;
          } else if (ZONAL_COLUMNS.includes(header)) {
            rawRecord[header] = parseFloat(value) || 0;
          }
        }

        if (!rawRecord.DateTimeEnding) continue;

        const dt = parseDateTime(rawRecord.DateTimeEnding);
        if (dt && dt >= startDt && dt < endDt) {
          // Aggregate zonal to regional
          const CLUZ = LUZON_ZONES.reduce((sum, z) => sum + (rawRecord[z] || 0), 0);
          const CVIS = VISAYAS_ZONES.reduce((sum, z) => sum + (rawRecord[z] || 0), 0);
          const CMIN = MINDANAO_ZONES.reduce((sum, z) => sum + (rawRecord[z] || 0), 0);

          allData.push({
            DateTimeEnding: rawRecord.DateTimeEnding,
            CLUZ,
            CVIS,
            CMIN
          });
        }
      }
    }
  }

  return allData.sort((a, b) =>
    parseDateTime(a.DateTimeEnding)!.getTime() - parseDateTime(b.DateTimeEnding)!.getTime()
  );
}

function parseDateTime(dtStr: string): Date | null {
  if (!dtStr) return null;
  if (dtStr.includes('T')) return new Date(dtStr);

  const [datePart, timePart] = dtStr.split(' ');
  if (!datePart) return null;

  const [month, day, year] = datePart.split('/').map(Number);
  const [hours, minutes] = timePart ? timePart.split(':').map(Number) : [0, 0];

  return new Date(year, month - 1, day, hours || 0, minutes || 0);
}

/**
 * Simulate forecast by applying a systematic bias to actuals
 * This mimics typical under-forecasting patterns
 */
function simulateForecast(actuals: DemandRecord[]): DemandRecord[] {
  return actuals.map(act => {
    const dt = parseDateTime(act.DateTimeEnding);
    const hour = dt?.getHours() || 0;
    const isPeak = hour >= 9 && hour < 21;

    // Simulate typical under-forecasting: -8% peak, -3% off-peak
    const peakBias = isPeak ? 0.92 : 0.97;

    return {
      DateTimeEnding: act.DateTimeEnding,
      CLUZ: act.CLUZ * peakBias,
      CVIS: act.CVIS * peakBias,
      CMIN: act.CMIN * peakBias
    };
  });
}

/**
 * Calculate MAPE and bias
 */
function calculateMetrics(forecasts: DemandRecord[], actuals: DemandRecord[]): {
  mape: number;
  bias: number;
  peakMape: number;
  offpeakMape: number;
  peakBias: number;
  offpeakBias: number;
} {
  let totalError = 0, totalBias = 0, count = 0;
  let peakError = 0, peakBiasSum = 0, peakCount = 0;
  let offpeakError = 0, offpeakBiasSum = 0, offpeakCount = 0;

  const actualMap = new Map<string, DemandRecord>();
  for (const rec of actuals) actualMap.set(rec.DateTimeEnding, rec);

  for (const fc of forecasts) {
    const act = actualMap.get(fc.DateTimeEnding);
    if (!act) continue;

    const dt = parseDateTime(fc.DateTimeEnding);
    const hour = dt?.getHours() || 0;
    const isPeak = hour >= 9 && hour < 21;

    for (const region of REGIONS) {
      const fcVal = fc[region as keyof DemandRecord] as number;
      const actVal = act[region as keyof DemandRecord] as number;

      if (actVal > 0) {
        const error = Math.abs(fcVal - actVal) / actVal * 100;
        const bias = fcVal - actVal;

        totalError += error;
        totalBias += bias;
        count++;

        if (isPeak) {
          peakError += error;
          peakBiasSum += bias;
          peakCount++;
        } else {
          offpeakError += error;
          offpeakBiasSum += bias;
          offpeakCount++;
        }
      }
    }
  }

  return {
    mape: count > 0 ? totalError / count : 0,
    bias: count > 0 ? totalBias / count : 0,
    peakMape: peakCount > 0 ? peakError / peakCount : 0,
    offpeakMape: offpeakCount > 0 ? offpeakError / offpeakCount : 0,
    peakBias: peakCount > 0 ? peakBiasSum / peakCount : 0,
    offpeakBias: offpeakCount > 0 ? offpeakBiasSum / offpeakCount : 0
  };
}

/**
 * Apply scaling factors to forecasts
 */
function applyScaling(forecasts: DemandRecord[], peakScale: number, offpeakScale: number): DemandRecord[] {
  return forecasts.map(fc => {
    const dt = parseDateTime(fc.DateTimeEnding);
    const hour = dt?.getHours() || 0;
    const isPeak = hour >= 9 && hour < 21;
    const scale = 1 + (isPeak ? peakScale : offpeakScale) / 100;

    return {
      DateTimeEnding: fc.DateTimeEnding,
      CLUZ: (fc.CLUZ as number) * scale,
      CVIS: (fc.CVIS as number) * scale,
      CMIN: (fc.CMIN as number) * scale
    };
  });
}

async function runBacktest() {
  console.log('═══════════════════════════════════════════════════════════════════════════════');
  console.log('              HYBRID CALIBRATION BACKTEST vs 9.12% MAPE BENCHMARK              ');
  console.log('═══════════════════════════════════════════════════════════════════════════════\n');

  // Try different date ranges until we find data
  const dateRanges = [
    { calib: ['2025-11-01', '2025-11-14'], test: ['2025-11-15', '2025-11-21'] },
    { calib: ['2025-10-01', '2025-10-14'], test: ['2025-10-15', '2025-10-21'] },
    { calib: ['2025-09-01', '2025-09-14'], test: ['2025-09-15', '2025-09-21'] },
    { calib: ['2024-11-01', '2024-11-14'], test: ['2024-11-15', '2024-11-21'] },
  ];

  let calibData: DemandRecord[] = [];
  let testData: DemandRecord[] = [];
  let selectedRange: any = null;

  for (const range of dateRanges) {
    const calib = loadDemandData(range.calib[0], range.calib[1]);
    const test = loadDemandData(range.test[0], range.test[1]);

    if (calib.length > 100 && test.length > 100) {
      calibData = calib;
      testData = test;
      selectedRange = range;
      break;
    }
  }

  if (!selectedRange) {
    console.log('ERROR: No sufficient data found for backtest.');
    return;
  }

  console.log(`Calibration: ${selectedRange.calib[0]} to ${selectedRange.calib[1]} (${calibData.length} hourly samples)`);
  console.log(`Test: ${selectedRange.test[0]} to ${selectedRange.test[1]} (${testData.length} hourly samples)\n`);

  // Simulate forecasts with typical under-forecasting bias
  const calibForecasts = simulateForecast(calibData);
  const testForecasts = simulateForecast(testData);

  // ═══════════════════════════════════════════════════════════════════════════════
  // TEST 1: No Calibration (Baseline with systematic bias)
  // ═══════════════════════════════════════════════════════════════════════════════
  console.log('───────────────────────────────────────────────────────────────────────────────');
  console.log('TEST 1: No Calibration (Baseline)');
  console.log('───────────────────────────────────────────────────────────────────────────────');

  const baselineMetrics = calculateMetrics(testForecasts, testData);
  console.log(`  MAPE: ${baselineMetrics.mape.toFixed(2)}%`);
  console.log(`  Bias: ${baselineMetrics.bias >= 0 ? '+' : ''}${baselineMetrics.bias.toFixed(1)} MW`);
  console.log(`  Peak MAPE: ${baselineMetrics.peakMape.toFixed(2)}% (bias: ${baselineMetrics.peakBias >= 0 ? '+' : ''}${baselineMetrics.peakBias.toFixed(1)} MW)`);
  console.log(`  Off-peak MAPE: ${baselineMetrics.offpeakMape.toFixed(2)}% (bias: ${baselineMetrics.offpeakBias >= 0 ? '+' : ''}${baselineMetrics.offpeakBias.toFixed(1)} MW)\n`);

  // ═══════════════════════════════════════════════════════════════════════════════
  // TEST 2: Iterative Scaling Only (Pass 1)
  // ═══════════════════════════════════════════════════════════════════════════════
  console.log('───────────────────────────────────────────────────────────────────────────────');
  console.log('TEST 2: Iterative Scaling Only (Pass 1)');
  console.log('───────────────────────────────────────────────────────────────────────────────');

  const iterativeCalibrator = new IterativeScalingCalibrator();

  // Analyze calibration period
  const analysis = iterativeCalibrator.analyzeDeviation(
    calibForecasts.map(r => ({ ...r, CLUZ: String(r.CLUZ), CVIS: String(r.CVIS), CMIN: String(r.CMIN) })),
    calibData.map(r => ({ ...r, CLUZ: String(r.CLUZ), CVIS: String(r.CVIS), CMIN: String(r.CMIN) }))
  );

  console.log(`  Calibration Analysis:`);
  console.log(`    MAPE: ${analysis.mape.toFixed(2)}%`);
  console.log(`    Peak deviation: ${analysis.peakDeviation >= 0 ? '+' : ''}${analysis.peakDeviation.toFixed(1)}%`);
  console.log(`    Off-peak deviation: ${analysis.offpeakDeviation >= 0 ? '+' : ''}${analysis.offpeakDeviation.toFixed(1)}%`);

  iterativeCalibrator.trainFromAnalysis(analysis, {
    start: selectedRange.calib[0],
    end: selectedRange.calib[1]
  });

  const factors = iterativeCalibrator.getFactors();
  console.log(`  Scaling: Peak ${factors.peakScale >= 0 ? '+' : ''}${factors.peakScale}%, Off-peak ${factors.offpeakScale >= 0 ? '+' : ''}${factors.offpeakScale}%`);

  // Apply to test data
  const iterativeForecasts = applyScaling(testForecasts, factors.peakScale, factors.offpeakScale);
  const iterativeMetrics = calculateMetrics(iterativeForecasts, testData);

  const iterativeImprovement = ((baselineMetrics.mape - iterativeMetrics.mape) / baselineMetrics.mape * 100);
  console.log(`\n  Test Results:`);
  console.log(`  MAPE: ${iterativeMetrics.mape.toFixed(2)}% (${iterativeImprovement > 0 ? `↓${iterativeImprovement.toFixed(1)}%` : `↑${Math.abs(iterativeImprovement).toFixed(1)}%`})`);
  console.log(`  Bias: ${iterativeMetrics.bias >= 0 ? '+' : ''}${iterativeMetrics.bias.toFixed(1)} MW`);
  console.log(`  Peak MAPE: ${iterativeMetrics.peakMape.toFixed(2)}%`);
  console.log(`  Off-peak MAPE: ${iterativeMetrics.offpeakMape.toFixed(2)}%\n`);

  // ═══════════════════════════════════════════════════════════════════════════════
  // TEST 3: XGBoost Only (Legacy α=0.50 symmetric)
  // ═══════════════════════════════════════════════════════════════════════════════
  console.log('───────────────────────────────────────────────────────────────────────────────');
  console.log('TEST 3: XGBoost Only (Legacy α=0.50 symmetric loss)');
  console.log('───────────────────────────────────────────────────────────────────────────────');

  const xgboostLegacy = new DemandCalibrator({ alpha: 0.50 });

  // Build training samples
  const xgboostSamples = calibData.map((record, i) => {
    const dt = parseDateTime(record.DateTimeEnding)!;
    return {
      datetime: dt,
      region: 'ALL',
      demand: (record.CLUZ + record.CVIS + record.CMIN),
      features: {
        hour: dt.getHours(),
        dayOfWeek: dt.getDay(),
        isSaturday: dt.getDay() === 6,
        isSunday: dt.getDay() === 0,
        month: dt.getMonth() + 1,
        temp: 28,
        relativeHumidity: 70,
        cloudcover: 50
      }
    };
  });

  const xgboostPredictor = (sample: any) => {
    const idx = calibForecasts.findIndex(fc => {
      const fcDt = parseDateTime(fc.DateTimeEnding);
      return fcDt && fcDt.getTime() === sample.datetime.getTime();
    });
    if (idx >= 0) {
      const fc = calibForecasts[idx];
      return fc.CLUZ + fc.CVIS + fc.CMIN;
    }
    return sample.demand * 0.95;
  };

  try {
    const xgboostMetrics = await xgboostLegacy.train(xgboostSamples, xgboostPredictor, {
      maxDepth: 4,
      nEstimators: 50,
      learningRate: 0.1,
      validationSplit: 0.2
    });

    console.log(`  Training MAPE: ${xgboostMetrics.trainMAPE.toFixed(2)}%`);
    console.log(`  Validation MAPE: ${xgboostMetrics.validationMAPE.toFixed(2)}%`);
    console.log(`  Alpha: 0.50 (symmetric - equal penalty for over/under)`);
  } catch (err: any) {
    console.log(`  Error: ${err.message}`);
  }

  // Test on held-out data
  const xgboostTestSamples = testData.map((record, i) => {
    const dt = parseDateTime(record.DateTimeEnding)!;
    return {
      datetime: dt,
      region: 'ALL',
      demand: (record.CLUZ + record.CVIS + record.CMIN),
      features: {
        hour: dt.getHours(),
        dayOfWeek: dt.getDay(),
        isSaturday: dt.getDay() === 6,
        isSunday: dt.getDay() === 0,
        month: dt.getMonth() + 1,
        temp: 28,
        relativeHumidity: 70,
        cloudcover: 50
      }
    };
  });

  let xgboostTestMape = 0;
  let xgboostTestBias = 0;
  let xgboostCount = 0;

  for (let i = 0; i < xgboostTestSamples.length; i++) {
    const sample = xgboostTestSamples[i];
    const fc = testForecasts[i];
    if (!fc) continue;

    const fcTotal = fc.CLUZ + fc.CVIS + fc.CMIN;
    // calibrate() returns the calibrated VALUE, not a correction factor
    const calibrated = xgboostLegacy.calibrate(fcTotal, sample);
    const actual = sample.demand;

    if (actual > 0) {
      xgboostTestMape += Math.abs(calibrated - actual) / actual * 100;
      xgboostTestBias += calibrated - actual;
      xgboostCount++;
    }
  }

  xgboostTestMape = xgboostCount > 0 ? xgboostTestMape / xgboostCount : 0;
  xgboostTestBias = xgboostCount > 0 ? xgboostTestBias / xgboostCount : 0;

  const xgboostImprovement = ((baselineMetrics.mape - xgboostTestMape) / baselineMetrics.mape * 100);
  console.log(`\n  Test Results:`);
  console.log(`  MAPE: ${xgboostTestMape.toFixed(2)}% (${xgboostImprovement > 0 ? `↓${xgboostImprovement.toFixed(1)}%` : `↑${Math.abs(xgboostImprovement).toFixed(1)}%`})`);
  console.log(`  Bias: ${xgboostTestBias >= 0 ? '+' : ''}${xgboostTestBias.toFixed(1)} MW\n`);

  // ═══════════════════════════════════════════════════════════════════════════════
  // TEST 4: XGBoost with Quantile Loss (α=0.80)
  // ═══════════════════════════════════════════════════════════════════════════════
  console.log('───────────────────────────────────────────────────────────────────────────────');
  console.log('TEST 4: XGBoost with Quantile Loss (α=0.80)');
  console.log('───────────────────────────────────────────────────────────────────────────────');

  const xgboostQuantile = new DemandCalibrator({ alpha: 0.80 });

  try {
    const quantileMetrics = await xgboostQuantile.train(xgboostSamples, xgboostPredictor, {
      maxDepth: 4,
      nEstimators: 50,
      learningRate: 0.1,
      validationSplit: 0.2
    });

    console.log(`  Training MAPE: ${quantileMetrics.trainMAPE.toFixed(2)}%`);
    console.log(`  Validation MAPE: ${quantileMetrics.validationMAPE.toFixed(2)}%`);
    console.log(`  Alpha: 0.80 (4:1 under-prediction penalty)`);
  } catch (err: any) {
    console.log(`  Error: ${err.message}`);
  }

  // Test
  let quantileTestMape = 0;
  let quantileTestBias = 0;
  let quantileCount = 0;

  for (let i = 0; i < xgboostTestSamples.length; i++) {
    const sample = xgboostTestSamples[i];
    const fc = testForecasts[i];
    if (!fc) continue;

    const fcTotal = fc.CLUZ + fc.CVIS + fc.CMIN;
    // calibrate() returns the calibrated VALUE, not a correction factor
    const calibrated = xgboostQuantile.calibrate(fcTotal, sample);
    const actual = sample.demand;

    if (actual > 0) {
      quantileTestMape += Math.abs(calibrated - actual) / actual * 100;
      quantileTestBias += calibrated - actual;
      quantileCount++;
    }
  }

  quantileTestMape = quantileCount > 0 ? quantileTestMape / quantileCount : 0;
  quantileTestBias = quantileCount > 0 ? quantileTestBias / quantileCount : 0;

  const quantileImprovement = ((baselineMetrics.mape - quantileTestMape) / baselineMetrics.mape * 100);
  console.log(`\n  Test Results:`);
  console.log(`  MAPE: ${quantileTestMape.toFixed(2)}% (${quantileImprovement > 0 ? `↓${quantileImprovement.toFixed(1)}%` : `↑${Math.abs(quantileImprovement).toFixed(1)}%`})`);
  console.log(`  Bias: ${quantileTestBias >= 0 ? '+' : ''}${quantileTestBias.toFixed(1)} MW\n`);

  // ═══════════════════════════════════════════════════════════════════════════════
  // TEST 5: Hybrid (Iterative + XGBoost α=0.80)
  // ═══════════════════════════════════════════════════════════════════════════════
  console.log('───────────────────────────────────────────────────────────────────────────────');
  console.log('TEST 5: HYBRID (Iterative Pass 1 + XGBoost α=0.80 Pass 2)');
  console.log('───────────────────────────────────────────────────────────────────────────────');

  // Pass 1 already done - apply iterative scaling to calibration forecasts
  const pass1CalibForecasts = applyScaling(calibForecasts, factors.peakScale, factors.offpeakScale);

  // Train Pass 2 on RESIDUALS from Pass 1
  const hybridCalibrator = new DemandCalibrator({ alpha: 0.80 });

  // CRITICAL: hybridPredictor returns Pass 1 scaled values
  const hybridPredictor = (sample: any) => {
    const idx = pass1CalibForecasts.findIndex(fc => {
      const fcDt = parseDateTime(fc.DateTimeEnding);
      return fcDt && fcDt.getTime() === sample.datetime.getTime();
    });
    if (idx >= 0) {
      const fc = pass1CalibForecasts[idx];
      return fc.CLUZ + fc.CVIS + fc.CMIN;
    }
    return sample.demand;
  };

  console.log(`  Pass 1: Peak ${factors.peakScale >= 0 ? '+' : ''}${factors.peakScale}%, Off-peak ${factors.offpeakScale >= 0 ? '+' : ''}${factors.offpeakScale}%`);

  try {
    const hybridMetrics = await hybridCalibrator.train(xgboostSamples, hybridPredictor, {
      maxDepth: 4,
      nEstimators: 50,
      learningRate: 0.1,
      validationSplit: 0.2
    });

    console.log(`  Pass 2 Training MAPE: ${hybridMetrics.trainMAPE.toFixed(2)}%`);
    console.log(`  Pass 2 Validation MAPE: ${hybridMetrics.validationMAPE.toFixed(2)}%`);
  } catch (err: any) {
    console.log(`  Pass 2 Error: ${err.message}`);
  }

  // Apply hybrid calibration to test forecasts
  // Step 1: Apply Pass 1 iterative scaling
  const hybridTestForecasts = applyScaling(testForecasts, factors.peakScale, factors.offpeakScale);

  // Step 2: Apply Pass 2 XGBoost corrections
  let hybridTestMape = 0;
  let hybridTestBias = 0;
  let hybridCount = 0;

  for (let i = 0; i < xgboostTestSamples.length; i++) {
    const sample = xgboostTestSamples[i];
    const fc = hybridTestForecasts[i];
    if (!fc) continue;

    const fcTotal = fc.CLUZ + fc.CVIS + fc.CMIN;
    // calibrate() returns the calibrated VALUE, not a correction factor
    const calibrated = hybridCalibrator.calibrate(fcTotal, sample);
    const actual = sample.demand;

    if (actual > 0) {
      hybridTestMape += Math.abs(calibrated - actual) / actual * 100;
      hybridTestBias += calibrated - actual;
      hybridCount++;
    }
  }

  hybridTestMape = hybridCount > 0 ? hybridTestMape / hybridCount : 0;
  hybridTestBias = hybridCount > 0 ? hybridTestBias / hybridCount : 0;

  const hybridImprovement = ((baselineMetrics.mape - hybridTestMape) / baselineMetrics.mape * 100);
  console.log(`\n  Test Results:`);
  console.log(`  MAPE: ${hybridTestMape.toFixed(2)}% (${hybridImprovement > 0 ? `↓${hybridImprovement.toFixed(1)}%` : `↑${Math.abs(hybridImprovement).toFixed(1)}%`})`);
  console.log(`  Bias: ${hybridTestBias >= 0 ? '+' : ''}${hybridTestBias.toFixed(1)} MW\n`);

  // ═══════════════════════════════════════════════════════════════════════════════
  // SUMMARY
  // ═══════════════════════════════════════════════════════════════════════════════
  console.log('═══════════════════════════════════════════════════════════════════════════════');
  console.log('                                  SUMMARY                                       ');
  console.log('═══════════════════════════════════════════════════════════════════════════════\n');

  console.log('| Approach                  | Test MAPE | Improvement | Bias       |');
  console.log('|---------------------------|-----------|-------------|------------|');
  console.log(`| No Calibration (Baseline) | ${baselineMetrics.mape.toFixed(2).padStart(7)}%  |     --      | ${(baselineMetrics.bias >= 0 ? '+' : '') + baselineMetrics.bias.toFixed(0).padStart(5)} MW  |`);
  console.log(`| Iterative Only (Pass 1)   | ${iterativeMetrics.mape.toFixed(2).padStart(7)}%  | ${iterativeImprovement > 0 ? '↓' : '↑'}${Math.abs(iterativeImprovement).toFixed(1).padStart(7)}%   | ${(iterativeMetrics.bias >= 0 ? '+' : '') + iterativeMetrics.bias.toFixed(0).padStart(5)} MW  |`);
  console.log(`| XGBoost α=0.50 (Legacy)   | ${xgboostTestMape.toFixed(2).padStart(7)}%  | ${xgboostImprovement > 0 ? '↓' : '↑'}${Math.abs(xgboostImprovement).toFixed(1).padStart(7)}%   | ${(xgboostTestBias >= 0 ? '+' : '') + xgboostTestBias.toFixed(0).padStart(5)} MW  |`);
  console.log(`| XGBoost α=0.80 (Quantile) | ${quantileTestMape.toFixed(2).padStart(7)}%  | ${quantileImprovement > 0 ? '↓' : '↑'}${Math.abs(quantileImprovement).toFixed(1).padStart(7)}%   | ${(quantileTestBias >= 0 ? '+' : '') + quantileTestBias.toFixed(0).padStart(5)} MW  |`);
  console.log(`| HYBRID (Iter + XGB α=0.80)| ${hybridTestMape.toFixed(2).padStart(7)}%  | ${hybridImprovement > 0 ? '↓' : '↑'}${Math.abs(hybridImprovement).toFixed(1).padStart(7)}%   | ${(hybridTestBias >= 0 ? '+' : '') + hybridTestBias.toFixed(0).padStart(5)} MW  |`);
  console.log(`| Benchmark (9.12% MAPE)    |   9.12%   |     --      |  +52 MW    |`);
  console.log('');

  // Determine best approach
  const results = [
    { name: 'Iterative Only', mape: iterativeMetrics.mape, bias: iterativeMetrics.bias },
    { name: 'XGBoost α=0.50', mape: xgboostTestMape, bias: xgboostTestBias },
    { name: 'XGBoost α=0.80', mape: quantileTestMape, bias: quantileTestBias },
    { name: 'HYBRID', mape: hybridTestMape, bias: hybridTestBias }
  ];

  const best = results.reduce((a, b) => a.mape < b.mape ? a : b);

  console.log(`BEST APPROACH: ${best.name} with ${best.mape.toFixed(2)}% MAPE\n`);

  if (best.mape < 9.12) {
    const improvement = ((9.12 - best.mape) / 9.12 * 100);
    console.log(`✓ ${best.name} beats benchmark by ${improvement.toFixed(1)}% (${best.mape.toFixed(2)}% vs 9.12%)`);
  } else {
    console.log(`✗ No approach beat the 9.12% benchmark in this test`);
  }
}

runBacktest().catch(console.error);
