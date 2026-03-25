/**
 * TrainPipeline - Orchestrates full training flow for Demand V2
 *
 * Steps:
 * 1. Load demand and weather data
 * 2. Merge and align timestamps
 * 3. Aggregate into daily records
 * 4. Train Level Model
 * 5. Train Shape Model
 * 6. Compute historical medians for sanity checks
 * 7. Serialize to model.vfm
 */

import fs from 'fs';
import path from 'path';
import { join } from 'path';
import { DataMerger } from '../data/DataMerger.js';
import { DailyAggregator } from '../data/DailyAggregator.js';
import { LevelModel } from '../models/LevelModel.js';
import { ShapeModel } from '../models/ShapeModel.js';
import { ForecastCombiner } from '../models/ForecastCombiner.js';
import { Calibrator } from '../models/Calibrator.js';
import { ModelSerializer, DemandV2ModelArtifact } from './ModelSerializer.js';
import { LevelMetrics } from '../metrics/LevelMetrics.js';
import { ShapeMetrics } from '../metrics/ShapeMetrics.js';

export interface TrainPipelineConfig {
  demandDataPath: string;      // Path to demand CSV folder/file
  weatherDataPath: string;     // Path to weather CSV folder/file
  trainingDays: number;         // Training window (default 90)
  lagWarmupDays: number;        // Skip first N days for lag features (default 7)
  outputPath: string;           // Path to save model.vfm
  areaToStationMapping?: Record<string, string[]>; // Optional custom mapping
  isZonal?: boolean;            // Use 14-zone sub-region mode (default: false)
  configPath?: string;          // Custom config file path
  verbose?: boolean;            // Enable verbose logging (default: false)
}

export class TrainPipeline {
  private config: TrainPipelineConfig;

  constructor(config: TrainPipelineConfig) {
    this.config = config;
  }

  /**
   * Run the full training pipeline
   */
  async run(): Promise<void> {
    const verbose = this.config.verbose ?? false;

    console.log('\n========================================');
    console.log('  Demand V2 Training Pipeline');
    console.log('========================================\n');

    console.log(`Training window: ${this.config.trainingDays} days`);
    console.log(`Demand data: ${this.config.demandDataPath}`);
    console.log(`Weather data: ${this.config.weatherDataPath}`);
    if (verbose) {
      console.log(`Verbose logging: enabled`);
    }
    console.log('');

    // Step 1: Load and merge data
    if (verbose) {
      console.log(`[${new Date().toISOString()}] Step 1/7: Loading and merging data...`);
    } else {
      console.log('Step 1/7: Loading and merging data...');
    }

    // Load area mapping from zones.json
    const areaMapping = this.config.areaToStationMapping || DataMerger.loadAreaMapping(
      join(process.cwd(), 'src', 'data', 'zones.json')
    );

    if (verbose) {
      console.log(`  Areas configured: ${Object.keys(areaMapping).length}`);
      for (const [area, stations] of Object.entries(areaMapping)) {
        console.log(`    ${area}: ${stations.length} weather stations`);
      }
    }

    const merger = new DataMerger(areaMapping);
    const mergedData = merger.merge(
      this.config.demandDataPath,
      this.config.weatherDataPath
    );

    console.log(`  Loaded ${mergedData.records.length} hourly records`);
    if (verbose && mergedData.records.length > 0) {
      const firstRecord = mergedData.records[0];
      const lastRecord = mergedData.records[mergedData.records.length - 1];
      console.log(`  Date range: ${firstRecord.datetime.toISOString()} to ${lastRecord.datetime.toISOString()}`);
    }

    // Step 2: Aggregate into daily records
    if (verbose) {
      console.log(`[${new Date().toISOString()}] Step 2/7: Aggregating into daily records...`);
    } else {
      console.log('Step 2/7: Aggregating into daily records...');
    }
    const aggregator = new DailyAggregator();
    const dailyRecords = aggregator.aggregate(mergedData.records);

    console.log(`  Created ${dailyRecords.length} daily records`);

    // Filter to training window (most recent N days)
    const sortedRecords = dailyRecords.sort((a, b) => a.date.localeCompare(b.date));
    const trainingRecords = sortedRecords.slice(-this.config.trainingDays);

    console.log(`  Using ${trainingRecords.length} records for training`);

    // Extract unique areas
    const areas = Array.from(new Set(trainingRecords.map(r => r.area)));
    console.log(`  Areas: ${areas.join(', ')}`);

    // Extract training period
    const trainingStart = trainingRecords[0].date;
    const trainingEnd = trainingRecords[trainingRecords.length - 1].date;
    console.log(`  Training period: ${trainingStart} to ${trainingEnd}`);

    if (verbose) {
      // Show per-area record counts
      const areaCounts = new Map<string, number>();
      for (const record of trainingRecords) {
        areaCounts.set(record.area, (areaCounts.get(record.area) || 0) + 1);
      }
      console.log(`  Per-area record counts:`);
      for (const [area, count] of areaCounts) {
        console.log(`    ${area}: ${count} records`);
      }
    }
    console.log('');

    // Step 3: Train Level Model
    if (verbose) {
      console.log(`[${new Date().toISOString()}] Step 3/7: Training Level Model...`);
    } else {
      console.log('Step 3/7: Training Level Model...');
    }
    const levelModel = new LevelModel({ lagWarmupDays: this.config.lagWarmupDays });
    const levelTrainResult = await levelModel.train(trainingRecords);

    console.log(`  Level Model trained: MAPE ${levelTrainResult.valMAPE.toFixed(2)}%`);

    // Step 4: Train Shape Model
    if (verbose) {
      console.log(`[${new Date().toISOString()}] Step 4/7: Training Shape Model...`);
    } else {
      console.log('Step 4/7: Training Shape Model...');
    }
    const shapeModel = new ShapeModel();
    const shapeTrainResult = shapeModel.train(trainingRecords);

    console.log(`  Shape Model trained: MAPE ${shapeTrainResult.shapeMAPE.toFixed(2)}%`);

    // Step 5: Compute historical medians for sanity checks
    if (verbose) {
      console.log(`[${new Date().toISOString()}] Step 5/7: Computing historical medians...`);
    } else {
      console.log('Step 5/7: Computing historical medians...');
    }
    const combiner = new ForecastCombiner();
    combiner.computeHistoricalMedians(trainingRecords);

    const calibrator = new Calibrator();
    calibrator.setHistoricalShapeMedians(trainingRecords);

    console.log('  Historical medians computed for all areas');

    if (verbose) {
      const historicalMedians = this.extractHistoricalMedians(combiner);
      console.log(`  Historical median levels:`);
      for (const [area, medians] of Object.entries(historicalMedians)) {
        if (medians && medians.length > 0) {
          const avg = medians.reduce((a, b) => a + b, 0) / medians.length;
          console.log(`    ${area}: avg ${avg.toFixed(1)} MW (${medians.length} values)`);
        }
      }
    }
    console.log('');

    // Step 6: Serialize model
    if (verbose) {
      console.log(`[${new Date().toISOString()}] Step 6/7: Serializing model...`);
    } else {
      console.log('Step 6/7: Serializing model...');
    }

    const artifact: DemandV2ModelArtifact = {
      version: '2.0',
      trainedAt: new Date().toISOString(),
      trainingPeriod: { start: trainingStart, end: trainingEnd },
      areas,
      areaToStationMapping: this.config.areaToStationMapping || {},

      // Level Model (serialize XGBoost state)
      levelModel: this.serializeLevelModel(levelModel),
      levelConfig: levelModel['config'], // Access private config

      // Shape Model (serialize ProfileLibrary + ShapeAdjuster)
      shapeModel: {
        profileLibrary: this.serializeProfileLibrary(shapeModel['profileLibrary']),
        shapeAdjuster: this.serializeShapeAdjuster(shapeModel['shapeAdjuster']),
        config: shapeModel['config']
      },

      // Historical data
      historicalMedians: this.extractHistoricalMedians(combiner),
      historicalShapeMedians: this.extractHistoricalShapeMedians(calibrator),

      // Configuration snapshot
      config: {
        trainingDays: this.config.trainingDays,
        lagWarmupDays: this.config.lagWarmupDays
      }
    };

    ModelSerializer.saveModel(artifact, this.config.outputPath);

    // Step 7: Done
    console.log('Step 7/7: Training complete!');
    console.log('');
    console.log('========================================');
    console.log(`  Model saved: ${this.config.outputPath}`);
    console.log('========================================\n');
  }

  /**
   * Serialize Level Model (XGBoost state)
   */
  private serializeLevelModel(levelModel: LevelModel): any {
    // Access private fields using bracket notation
    const model = levelModel as any;

    return {
      areaToIndex: Array.from(model.areaToIndex.entries()),
      indexToArea: Array.from(model.indexToArea.entries()),
      isStatisticalFallback: model.isStatisticalFallback,
      statisticalModel: model.statisticalModel ? Array.from(model.statisticalModel.entries()) : null,
      xgboostModel: model.model // XGBoost model object (will be serialized by msgpack)
    };
  }

  /**
   * Serialize ProfileLibrary
   */
  private serializeProfileLibrary(profileLibrary: any): any {
    return {
      profiles: Array.from(profileLibrary.profiles.entries()),
      config: profileLibrary.config
    };
  }

  /**
   * Serialize ShapeAdjuster
   */
  private serializeShapeAdjuster(shapeAdjuster: any): any {
    return {
      adjustmentWeights: shapeAdjuster.adjustmentWeights ? Array.from(shapeAdjuster.adjustmentWeights.entries()) : null,
      config: shapeAdjuster.config,
      isTrained: shapeAdjuster.isTrained
    };
  }

  /**
   * Extract historical medians from combiner
   */
  private extractHistoricalMedians(combiner: ForecastCombiner): Record<string, number[]> {
    const medians: Record<string, number[]> = {};
    const mediansMap = (combiner as any).historicalMedians as Map<string, number[]>;

    for (const [area, values] of mediansMap.entries()) {
      medians[area] = values;
    }

    return medians;
  }

  /**
   * Extract historical shape medians from calibrator
   */
  private extractHistoricalShapeMedians(calibrator: Calibrator): Record<string, number[]> {
    const medians: Record<string, number[]> = {};
    const mediansMap = (calibrator as any).areaShapeMedians as Map<string, any>;

    for (const [area, data] of mediansMap.entries()) {
      medians[area] = data.medianShape;
    }

    return medians;
  }
}
