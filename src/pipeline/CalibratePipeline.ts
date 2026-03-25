/**
 * CalibratePipeline - Orchestrates calibration flow for Demand V2
 *
 * Steps:
 * 1. Load saved model.vfm
 * 2. Load recent N days of actual demand data
 * 3. Generate predictions for those days using the model
 * 4. Compute calibration factors (level + shape)
 * 5. Snapshot recent actuals for lag features
 * 6. Compute metrics
 * 7. Save calibration.json
 */

import { ModelSerializer, DemandV2ModelArtifact, CalibrationSnapshot } from './ModelSerializer.js';
import { DataMerger } from '../data/DataMerger.js';
import { DailyAggregator } from '../data/DailyAggregator.js';
import { LevelModel } from '../models/LevelModel.js';
import { ShapeModel } from '../models/ShapeModel.js';
import { Calibrator, CalibrationFactors } from '../models/Calibrator.js';
import { ForecastCombiner } from '../models/ForecastCombiner.js';
import { LevelMetrics } from '../metrics/LevelMetrics.js';
import { ShapeMetrics } from '../metrics/ShapeMetrics.js';
import { HourlyMetrics } from '../metrics/HourlyMetrics.js';
import { RetrainMonitor } from '../metrics/RetrainMonitor.js';

export interface CalibratePipelineConfig {
  modelPath: string;           // Path to model.vfm
  demandDataPath: string;      // Path to recent demand data
  calibrationDays: number;     // Number of recent days to use (default 7)
  outputPath: string;          // Path to save calibration.json
  configPath?: string;         // Custom config file path
  verbose?: boolean;           // Enable verbose logging (default: false)
  manualScaleOverrides?: Record<string, number>; // Manual per-zone/region scale factors (e.g., {"01NLUZ": -10} for -10%)
}

export class CalibratePipeline {
  private config: CalibratePipelineConfig;

  constructor(config: CalibratePipelineConfig) {
    this.config = config;
  }

  /**
   * Run the calibration pipeline
   */
  async run(): Promise<void> {
    const verbose = this.config.verbose ?? false;

    console.log('\n========================================');
    console.log('  Demand V2 Calibration Pipeline');
    console.log('========================================\n');

    console.log(`Model: ${this.config.modelPath}`);
    console.log(`Calibration days: ${this.config.calibrationDays}`);
    console.log(`Demand data: ${this.config.demandDataPath}`);
    if (verbose) {
      console.log(`Verbose logging: enabled`);
    }
    console.log('');

    // Step 1: Load model
    if (verbose) {
      console.log(`[${new Date().toISOString()}] Step 1/7: Loading model...`);
    } else {
      console.log('Step 1/7: Loading model...');
    }
    const artifact = ModelSerializer.loadModel(this.config.modelPath);
    console.log(`  Model version: ${artifact.version}`);
    console.log(`  Trained: ${artifact.trainedAt}`);
    console.log(`  Areas: ${artifact.areas.join(', ')}`);
    if (verbose) {
      console.log(`  Training period: ${artifact.trainingPeriod.start} to ${artifact.trainingPeriod.end}`);
    }
    console.log('');

    // Step 2: Deserialize models
    if (verbose) {
      console.log(`[${new Date().toISOString()}] Step 2/7: Deserializing models...`);
    } else {
      console.log('Step 2/7: Deserializing models...');
    }
    const levelModel = this.deserializeLevelModel(artifact.levelModel, artifact.levelConfig);
    const shapeModel = this.deserializeShapeModel(artifact.shapeModel);
    const combiner = new ForecastCombiner(ModelSerializer.recordToMap(artifact.historicalMedians));
    const calibrator = new Calibrator();

    console.log('  Models loaded successfully');
    if (verbose) {
      console.log(`  Level Model: ${(levelModel as any).isStatisticalFallback ? 'Statistical fallback' : 'XGBoost'}`);
      console.log(`  Shape Model: Profile library + adjusters loaded`);
    }
    console.log('');

    // Step 3: Load recent actuals
    if (verbose) {
      console.log(`[${new Date().toISOString()}] Step 3/7: Loading recent actuals...`);
    } else {
      console.log('Step 3/7: Loading recent actuals...');
    }
    const merger = new DataMerger(artifact.areaToStationMapping);

    // TODO: Weather path should be fetched automatically for calibration period
    const mergedData = merger.merge(
      this.config.demandDataPath,
      '' // Weather path - empty for now, needs implementation
    );

    const aggregator = new DailyAggregator();
    const dailyRecords = aggregator.aggregate(mergedData.records);

    // Filter to most recent N days
    const sortedRecords = dailyRecords.sort((a, b) => a.date.localeCompare(b.date));
    const calibrationRecords = sortedRecords.slice(-this.config.calibrationDays);

    console.log(`  Loaded ${calibrationRecords.length} days for calibration`);
    console.log(`  Calibration period: ${calibrationRecords[0].date} to ${calibrationRecords[calibrationRecords.length - 1].date}`);
    if (verbose) {
      const areaCounts = new Map<string, number>();
      for (const record of calibrationRecords) {
        areaCounts.set(record.area, (areaCounts.get(record.area) || 0) + 1);
      }
      console.log(`  Per-area calibration record counts:`);
      for (const [area, count] of areaCounts) {
        console.log(`    ${area}: ${count} records`);
      }
    }
    console.log('');

    // Step 4: Generate predictions for calibration period
    if (verbose) {
      console.log(`[${new Date().toISOString()}] Step 4/7: Generating predictions for calibration period...`);
    } else {
      console.log('Step 4/7: Generating predictions for calibration period...');
    }
    const calibrationData: Array<{
      area: string;
      date: string;
      actualTotal: number;
      predictedTotal: number;
      actualShape: number[];
      predictedShape: number[];
      actualHourly: number[];
      predictedHourly: number[];
    }> = [];

    for (const record of calibrationRecords) {
      // TODO: Fix API - levelModel.predict() needs proper feature construction
      // Predict daily total (placeholder)
      const predictedTotal = await levelModel.predict(record.area, {
        ...record.dailyWeather,
        ...record.calendar,
        totalYesterday: 0,
        totalLastWeek: 0,
        totalRolling7d: 0,
        totalRolling30d: 0,
        trendWeek: 0
      } as any);

      // Predict shape
      const adjustmentFeatures = {
        ...record.weatherTrajectory,
        tempRange: record.dailyWeather.tempRange,
        avgTemp: record.dailyWeather.avgTemp,
        avgCloudCover: record.dailyWeather.avgCloudCover,
        isDaytimeRain: record.dailyWeather.totalPrecip > 0 // Simple heuristic
      };

      const predictedShape = shapeModel.predict(
        record.area,
        record.calendar.dayType,
        record.dailyWeather,
        adjustmentFeatures
      );

      // Combine
      const predictedHourly = combiner.combine(record.area, predictedTotal, predictedShape);

      calibrationData.push({
        area: record.area,
        date: record.date,
        actualTotal: record.dailyTotal,
        predictedTotal,
        actualShape: record.shape,
        predictedShape,
        actualHourly: record.hourlyDemand,
        predictedHourly
      });
    }

    console.log('  Predictions generated');
    if (verbose) {
      console.log(`  Total prediction data points: ${calibrationData.length}`);
    }
    console.log('');

    // Step 5: Compute calibration factors
    if (verbose) {
      console.log(`[${new Date().toISOString()}] Step 5/7: Computing calibration factors...`);
    } else {
      console.log('Step 5/7: Computing calibration factors...');
    }
    calibrator.setHistoricalShapeMedians(calibrationRecords);
    const calibrationFactors = calibrator.computeCalibrationFactors(calibrationData);

    console.log('  Calibration factors computed');
    if (verbose) {
      console.log(`  Per-area level scale factors:`);
      for (const [area, scale] of calibrationFactors.levelScale) {
        console.log(`    ${area}: ${scale.toFixed(4)}`);
      }
      console.log(`  Per-area shape correction (avg across hours):`);
      for (const [area, corrections] of calibrationFactors.shapeCorrection) {
        const avg = corrections.reduce((a, b) => a + b, 0) / corrections.length;
        console.log(`    ${area}: ${avg.toFixed(4)} (${corrections.length} hourly values)`);
      }
    }
    console.log('');

    // Step 6: Compute metrics
    console.log('Step 6/7: Computing metrics...');
    const levelMetrics = LevelMetrics.compute(calibrationData);
    const shapeMetrics = ShapeMetrics.compute(calibrationData);
    const hourlyMetrics = HourlyMetrics.compute(calibrationData);

    LevelMetrics.print(levelMetrics);
    ShapeMetrics.print(shapeMetrics);
    HourlyMetrics.print(hourlyMetrics);

    // Check retrain triggers
    const retrainMonitor = new RetrainMonitor();
    const retrainTrigger = retrainMonitor.checkRetrainTriggers(
      calibrationFactors,
      levelMetrics,
      shapeMetrics
    );

    RetrainMonitor.print(retrainTrigger);

    // Step 7: Snapshot recent actuals and save
    console.log('Step 7/7: Saving calibration snapshot...');

    const recentActuals: Record<string, Record<string, number>> = {};
    for (const record of calibrationRecords) {
      if (!recentActuals[record.area]) {
        recentActuals[record.area] = {};
      }
      recentActuals[record.area][record.date] = record.dailyTotal;
    }

    // Convert manual scale overrides from percentage to multiplier
    // e.g., {"01NLUZ": -10} becomes {"01NLUZ": 0.90}
    let manualLevelScale: Record<string, number> | undefined;
    if (this.config.manualScaleOverrides && Object.keys(this.config.manualScaleOverrides).length > 0) {
      manualLevelScale = {};
      console.log('  Manual scale overrides:');
      for (const [area, percent] of Object.entries(this.config.manualScaleOverrides)) {
        const multiplier = 1 + (percent / 100);
        manualLevelScale[area] = multiplier;
        const sign = percent >= 0 ? '+' : '';
        console.log(`    ${area}: ${sign}${percent}% (×${multiplier.toFixed(4)})`);
      }
    }

    const snapshot: CalibrationSnapshot = {
      calibrationDate: new Date().toISOString().split('T')[0],
      modelVersion: this.config.modelPath,
      calibrationDays: this.config.calibrationDays,
      levelScale: ModelSerializer.mapToRecord(calibrationFactors.levelScale),
      manualLevelScale,
      shapeCorrection: ModelSerializer.mapToRecord(calibrationFactors.shapeCorrection),
      recentActuals,
      metrics: {
        levelMAPE: ModelSerializer.mapToRecord(new Map(Array.from(levelMetrics.entries()).map(([k, v]) => [k, v.mape]))),
        shapeMAPE: ModelSerializer.mapToRecord(new Map(Array.from(shapeMetrics.entries()).map(([k, v]) => [k, v.shapeMAPE]))),
        hourlyMAPE: ModelSerializer.mapToRecord(new Map(Array.from(hourlyMetrics.entries()).map(([k, v]) => [k, v.hourlyMAPE])))
      }
    };

    ModelSerializer.saveCalibration(snapshot, this.config.outputPath);

    console.log('');
    console.log('========================================');
    console.log(`  Calibration saved: ${this.config.outputPath}`);
    console.log('========================================\n');
  }

  /**
   * Deserialize Level Model
   */
  private deserializeLevelModel(serialized: any, config: any): LevelModel {
    const levelModel = new LevelModel(config);

    // Restore internal state
    (levelModel as any).areaToIndex = new Map(serialized.areaToIndex);
    (levelModel as any).indexToArea = new Map(serialized.indexToArea);
    (levelModel as any).isStatisticalFallback = serialized.isStatisticalFallback;
    (levelModel as any).statisticalModel = serialized.statisticalModel ?
      new Map(serialized.statisticalModel) : null;
    (levelModel as any).model = serialized.xgboostModel;

    return levelModel;
  }

  /**
   * Deserialize Shape Model
   */
  private deserializeShapeModel(serialized: any): ShapeModel {
    const shapeModel = new ShapeModel(serialized.config);

    // Restore ProfileLibrary
    (shapeModel as any).profileLibrary.profiles = new Map(serialized.profileLibrary.profiles);

    // Restore ShapeAdjuster
    if (serialized.shapeAdjuster.adjustmentWeights) {
      (shapeModel as any).shapeAdjuster.adjustmentWeights = new Map(serialized.shapeAdjuster.adjustmentWeights);
    }
    (shapeModel as any).shapeAdjuster.isTrained = serialized.shapeAdjuster.isTrained;

    return shapeModel;
  }
}
