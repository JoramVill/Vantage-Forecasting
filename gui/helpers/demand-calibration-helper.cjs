/**
 * Demand Calibration Service Helper
 *
 * Standalone script to interact with demand calibration from Electron main process.
 * Supports both IterativeScalingCalibrator (Pass 1) and DemandCalibrator (Pass 2).
 *
 * Runs in a subprocess to avoid ESM/CJS compatibility issues with better-sqlite3.
 */

const path = require('path');
const fs = require('fs');

// Regional demand columns (3 regions)
const REGIONAL_COLUMNS = ['CLUZ', 'CVIS', 'CMIN'];

// Zonal demand columns (14 zones)
const ZONAL_COLUMNS = [
  '01NLUZ', '02METRO', '03SLUZ', '04LEYTE', '05CEBU', '06NEGROS',
  '07BOHOL', '08PANAY', '09NWMIN', '10LANAO', '11NCMIN', '12NEMIN',
  '13SEMIN', '14SWMIN'
];

/**
 * Parse CSV file into array of objects
 */
function parseCSV(filepath) {
  const content = fs.readFileSync(filepath, 'utf-8');
  const lines = content.trim().split('\n');
  const headers = lines[0].split(',').map(h => h.trim());

  const data = [];
  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(',').map(v => v.trim());
    const row = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = values[j];
    }
    data.push(row);
  }

  return data;
}

/**
 * Run iterative scaling calibration only (Pass 1)
 */
async function runIterativeCalibration(options, IterativeScalingCalibrator, fs) {
  const { forecastPath, actualPath, enableZoneScaling } = options;

  console.error(`  Loading data...`);
  const forecastData = parseCSV(forecastPath);
  const actualData = parseCSV(actualPath);

  console.error(`  Creating calibrator...`);
  const calibrator = new IterativeScalingCalibrator();

  console.error(`  Analyzing deviation...`);
  const analysis = calibrator.analyzeDeviation(forecastData, actualData);

  console.error(`  Setting scaling factors...`);
  const startDate = forecastData[0]?.DateTimeEnding || forecastData[0]?.datetime;
  const endDate = forecastData[forecastData.length - 1]?.DateTimeEnding || forecastData[forecastData.length - 1]?.datetime;

  calibrator.trainFromAnalysis(analysis, {
    start: startDate,
    end: endDate
  }, {
    enableZoneScaling: enableZoneScaling ?? false
  });

  const result = calibrator.getResult();

  return {
    success: true,
    type: 'iterative',
    factors: result.factors,
    analysis: result.finalAnalysis,
    calibrationPeriod: result.calibrationPeriod,
    trainedAt: result.trainedAt,
    iterations: result.iterations,
    converged: result.converged
  };
}

/**
 * Run XGBoost calibration only (legacy mode)
 *
 * Trains directly on raw forecasts without Pass 1 iterative scaling
 */
async function runXGBoostOnly(options, DemandCalibrator, fs) {
  const { forecastPath, actualPath, alpha } = options;

  console.error(`  === XGBoost Only Mode (Legacy) ===`);

  const forecastData = parseCSV(forecastPath);
  const actualData = parseCSV(actualPath);
  const columns = detectColumns(forecastData[0] || actualData[0] || {});

  // Build actual lookup
  const actualMap = new Map();
  for (const row of actualData) {
    const key = row.DateTimeEnding || row.datetime;
    if (key) actualMap.set(key, row);
  }

  // Build training samples
  const samples = [];
  for (const fcRow of forecastData) {
    const dt = fcRow.DateTimeEnding || fcRow.datetime;
    const actRow = actualMap.get(dt);
    if (!actRow) continue;

    const datetime = parseDateTime(dt);

    for (const region of columns) {
      const fcVal = parseFloat(fcRow[region]);
      const actVal = parseFloat(actRow[region]);

      if (!isNaN(fcVal) && !isNaN(actVal) && actVal > 0 && fcVal > 0) {
        samples.push({
          datetime: datetime,
          region: region,
          demand: actVal,
          features: buildFeatures(datetime, region)
        });
      }
    }
  }

  console.error(`  Samples: ${samples.length}`);

  const calibrator = new DemandCalibrator({ alpha: alpha ?? 0.80 });

  // Predictor returns raw forecast values
  const predictor = (sample) => {
    for (const fcRow of forecastData) {
      const fcDt = parseDateTime(fcRow.DateTimeEnding || fcRow.datetime);
      if (fcDt && fcDt.getTime() === sample.datetime.getTime()) {
        const val = parseFloat(fcRow[sample.region]);
        if (!isNaN(val)) return val;
      }
    }
    return sample.demand;
  };

  const metrics = await calibrator.train(samples, predictor, {
    alpha: alpha ?? 0.80,
    maxDepth: 4,
    nEstimators: 50,
    learningRate: 0.1,
    validationSplit: 0.2
  });

  console.error(`  Train MAPE: ${metrics.trainMAPE.toFixed(2)}%`);
  console.error(`  Validation MAPE: ${metrics.validationMAPE.toFixed(2)}%`);

  return {
    success: true,
    type: 'xgboost',
    metrics: {
      trainMAPE: metrics.trainMAPE,
      validationMAPE: metrics.validationMAPE,
      alpha: calibrator.getAlpha()
    },
    trainedAt: new Date().toISOString()
  };
}

/**
 * Run hybrid calibration (Pass 1 + Pass 2)
 *
 * CRITICAL: Pass 2 must train on residuals from Pass 1
 */
async function runHybridCalibration(options, IterativeScalingCalibrator, DemandCalibrator, fs) {
  const { forecastPath, actualPath, alpha, enableZoneScaling } = options;

  console.error(`  === PASS 1: Iterative Scaling ===`);

  // Step 1: Run Pass 1 (Iterative Scaling)
  const forecastData = parseCSV(forecastPath);
  const actualData = parseCSV(actualPath);

  const iterativeCalibrator = new IterativeScalingCalibrator();
  const analysis = iterativeCalibrator.analyzeDeviation(forecastData, actualData);

  const startDate = forecastData[0]?.DateTimeEnding || forecastData[0]?.datetime;
  const endDate = forecastData[forecastData.length - 1]?.DateTimeEnding || forecastData[forecastData.length - 1]?.datetime;

  iterativeCalibrator.trainFromAnalysis(analysis, {
    start: startDate,
    end: endDate
  }, {
    enableZoneScaling: enableZoneScaling ?? false
  });

  const pass1Result = iterativeCalibrator.getResult();

  console.error(`  Pass 1 MAPE: ${pass1Result.finalAnalysis.mape.toFixed(2)}%`);
  console.error(`  Peak scale: ${pass1Result.factors.peakScale >= 0 ? '+' : ''}${pass1Result.factors.peakScale}%`);
  console.error(`  Off-peak scale: ${pass1Result.factors.offpeakScale >= 0 ? '+' : ''}${pass1Result.factors.offpeakScale}%`);

  // Step 2: Apply Pass 1 to forecasts
  console.error(`\n  === PASS 2: XGBoost Residual Learning ===`);
  console.error(`  Applying Pass 1 factors to forecasts...`);

  const pass1ScaledData = iterativeCalibrator.applyToDataset(forecastData);

  // Step 3: Train Pass 2 (DemandCalibrator) with CORRECTED targets
  // CRITICAL: Targets must be Actual / Pass1_Scaled_Prediction (not Raw_Prediction)
  console.error(`  Training XGBoost on residuals...`);

  // Convert data to TrainingSample format for DemandCalibrator
  const columns = detectColumns(forecastData[0] || actualData[0] || {});
  const samples = [];

  // Build actual lookup map
  const actualMap = new Map();
  for (const row of actualData) {
    const key = row.DateTimeEnding || row.datetime;
    if (key) actualMap.set(key, row);
  }

  for (let i = 0; i < pass1ScaledData.length; i++) {
    const fcRow = pass1ScaledData[i];
    const dt = fcRow.DateTimeEnding || fcRow.datetime;
    const actRow = actualMap.get(dt);
    if (!actRow) continue;

    const datetime = parseDateTime(dt);

    for (const region of columns) {
      const pass1Pred = parseFloat(fcRow[region]);
      const actVal = parseFloat(actRow[region]);

      if (!isNaN(pass1Pred) && !isNaN(actVal) && actVal > 0 && pass1Pred > 0) {
        samples.push({
          datetime: datetime,
          region: region,
          demand: actVal,
          features: buildFeatures(datetime, region)
        });
      }
    }
  }

  console.error(`  Samples: ${samples.length}`);

  const demandCalibrator = new DemandCalibrator({ alpha: alpha ?? 0.80 });

  // Hybrid predictor function: Returns Pass 1 scaled prediction
  const hybridPredictor = (sample) => {
    const hour = sample.datetime.getHours();

    // Find corresponding Pass 1 forecast
    for (const fcRow of pass1ScaledData) {
      const dt = parseDateTime(fcRow.DateTimeEnding || fcRow.datetime);
      if (dt.getTime() === sample.datetime.getTime()) {
        const val = parseFloat(fcRow[sample.region]);
        if (!isNaN(val)) return val;
      }
    }

    // Fallback (shouldn't happen)
    return sample.demand;
  };

  const pass2Metrics = await demandCalibrator.train(samples, hybridPredictor, {
    alpha: alpha ?? 0.80,
    maxDepth: 4,
    nEstimators: 50,
    learningRate: 0.1,
    validationSplit: 0.2
  });

  console.error(`  Pass 2 Train MAPE: ${pass2Metrics.trainMAPE.toFixed(2)}%`);
  console.error(`  Pass 2 Validation MAPE: ${pass2Metrics.validationMAPE.toFixed(2)}%`);

  return {
    success: true,
    type: 'hybrid',
    pass1: {
      factors: pass1Result.factors,
      analysis: pass1Result.finalAnalysis
    },
    pass2: {
      metrics: pass2Metrics,
      alpha: demandCalibrator.getAlpha()
    },
    calibrationPeriod: pass1Result.calibrationPeriod,
    trainedAt: new Date().toISOString(),
    // Combined calibrator (includes both passes)
    combined: {
      iterativeFactors: pass1Result.factors,
      xgboostMetrics: pass2Metrics
    }
  };
}

/**
 * Run calibration with specified mode
 *
 * @param options - { forecastPath, actualPath, mode, alpha, enableZoneScaling }
 *   mode: 'hybrid' | 'iterative' | 'xgboost' | 'none'
 */
async function runCalibration(options, IterativeScalingCalibrator, DemandCalibrator, fs) {
  const { forecastPath, actualPath, mode, alpha, enableZoneScaling } = options;

  if (mode === 'none') {
    return { success: true, type: 'none', message: 'Calibration disabled' };
  }

  if (mode === 'iterative') {
    // Pass 1 only
    return await runIterativeCalibration(
      { forecastPath, actualPath, enableZoneScaling },
      IterativeScalingCalibrator,
      fs
    );
  }

  if (mode === 'xgboost') {
    // XGBoost only (legacy) - train directly on raw forecasts
    return await runXGBoostOnly(
      { forecastPath, actualPath, alpha: alpha ?? 0.80 },
      DemandCalibrator,
      fs
    );
  }

  // Default: hybrid (Pass 1 + Pass 2)
  return await runHybridCalibration(
    { forecastPath, actualPath, alpha: alpha ?? 0.80, enableZoneScaling },
    IterativeScalingCalibrator,
    DemandCalibrator,
    fs
  );
}

/**
 * List saved demand calibrations
 */
function listCalibrations() {
  const modelsDir = path.join(process.cwd(), 'models', 'demand');

  if (!fs.existsSync(modelsDir)) {
    return { success: true, calibrations: [] };
  }

  const files = fs.readdirSync(modelsDir).filter(f => f.endsWith('.json'));

  const calibrations = files.map(filename => {
    try {
      const filepath = path.join(modelsDir, filename);
      const content = fs.readFileSync(filepath, 'utf-8');
      const data = JSON.parse(content);

      return {
        name: filename.replace('.json', ''),
        date: data.trainedAt || 'Unknown',
        mape: data.pass2?.metrics?.validationMAPE || data.analysis?.mape || 0,
        type: data.type || 'unknown'
      };
    } catch (err) {
      return null;
    }
  }).filter(Boolean);

  return { success: true, calibrations };
}

/**
 * Load calibration by filename
 */
function loadCalibration(filename) {
  const filepath = path.join(process.cwd(), 'models', 'demand', filename);

  if (!fs.existsSync(filepath)) {
    throw new Error(`Calibration file not found: ${filename}`);
  }

  const content = fs.readFileSync(filepath, 'utf-8');
  const data = JSON.parse(content);

  return { success: true, calibration: data };
}

/**
 * Save calibration result
 */
function saveCalibration(data, filename) {
  const modelsDir = path.join(process.cwd(), 'models', 'demand');

  if (!fs.existsSync(modelsDir)) {
    fs.mkdirSync(modelsDir, { recursive: true });
  }

  const filepath = path.join(modelsDir, filename);
  fs.writeFileSync(filepath, JSON.stringify(data, null, 2));

  return { success: true, path: filepath };
}

/**
 * Detect if data is zonal (14 zones) or regional (3 regions)
 */
function detectColumns(sampleRow) {
  const hasZonal = ZONAL_COLUMNS.some(col => col in sampleRow);
  const hasRegional = REGIONAL_COLUMNS.some(col => col in sampleRow);

  if (hasZonal) return ZONAL_COLUMNS;
  if (hasRegional) return REGIONAL_COLUMNS;
  return REGIONAL_COLUMNS; // Default
}

/**
 * Parse datetime string (supports M/D/YYYY HH:mm and ISO 8601)
 */
function parseDateTime(dateTimeStr) {
  // Try ISO format first
  if (dateTimeStr.includes('T')) {
    return new Date(dateTimeStr);
  }

  // Try M/D/YYYY HH:mm format
  const [datePart, timePart] = dateTimeStr.split(' ');
  const [month, day, year] = datePart.split('/');
  const [hours, minutes] = timePart ? timePart.split(':') : ['12', '00'];

  return new Date(parseInt(year), parseInt(month) - 1, parseInt(day), parseInt(hours), parseInt(minutes));
}

/**
 * Build basic features for DemandCalibrator
 */
function buildFeatures(datetime, region) {
  const hour = datetime.getHours();
  const dayOfWeek = datetime.getDay();
  const month = datetime.getMonth();

  return {
    hour: hour,
    dayOfWeek: dayOfWeek,
    isSaturday: dayOfWeek === 6,
    isSunday: dayOfWeek === 0,
    month: month + 1,
    temp: 28,  // Default values (not used in calibration)
    relativeHumidity: 70,
    cloudcover: 50
  };
}

/**
 * Main entry point
 */
async function main() {
  const method = process.argv[2];
  const args = process.argv.slice(3).map(arg => JSON.parse(arg));

  // Dynamically import ESM modules
  const { IterativeScalingCalibrator } = await import('../../dist/models/IterativeScalingCalibrator.js');
  const { DemandCalibrator } = await import('../../dist/models/DemandCalibrator.js');

  let result;

  switch (method) {
    case 'runCalibration':
      // Unified calibration method with mode parameter
      // args[0] = { forecastPath, actualPath, mode, alpha, enableZoneScaling }
      result = await runCalibration(args[0], IterativeScalingCalibrator, DemandCalibrator, fs);
      break;

    case 'runIterative':
      // Run iterative scaling calibration only (Pass 1)
      // args[0] = { forecastPath, actualPath, enableZoneScaling }
      // DEPRECATED: Use runCalibration with mode='iterative' instead
      result = await runIterativeCalibration(args[0], IterativeScalingCalibrator, fs);
      break;

    case 'runHybrid':
      // Run hybrid calibration (Pass 1 + Pass 2)
      // args[0] = { forecastPath, actualPath, alpha, enableZoneScaling }
      // DEPRECATED: Use runCalibration with mode='hybrid' instead
      result = await runHybridCalibration(args[0], IterativeScalingCalibrator, DemandCalibrator, fs);
      break;

    case 'list':
      // List saved demand calibrations
      result = listCalibrations();
      break;

    case 'load':
      // Load calibration by filename
      // args[0] = filename
      result = loadCalibration(args[0]);
      break;

    case 'save':
      // Save calibration result
      // args[0] = data, args[1] = filename
      result = saveCalibration(args[0], args[1]);
      break;

    default:
      throw new Error(`Unknown method: ${method}`);
  }

  // Output result as JSON
  console.log(JSON.stringify(result));
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
