/**
 * ModelSerializer - Save/load .vfm model files and calibration.json
 *
 * Handles binary serialization using MessagePack (same format as V1 modelSerializer.ts)
 */

import msgpack from 'msgpack-lite';
import crypto from 'crypto';
import fs from 'fs';
import { LevelModel } from '../models/LevelModel.js';
import { ShapeModel } from '../models/ShapeModel.js';
import { CalibrationFactors } from '../models/Calibrator.js';

const MAGIC_BYTES = 'VFM2'; // Vantage Forecast Model v2
const HEADER_SIZE = 64;

/**
 * Model artifact structure for serialization
 */
export interface DemandV2ModelArtifact {
  version: string;           // "2.0"
  trainedAt: string;         // ISO timestamp
  trainingPeriod: { start: string; end: string };
  areas: string[];           // List of area codes
  areaToStationMapping: Record<string, string[]>;

  // Level Model
  levelModel: any;           // Serialized XGBoost state
  levelConfig: any;

  // Shape Model
  shapeModel: {
    profileLibrary: any;     // Serialized profile library state
    shapeAdjuster: any;      // Serialized shape adjuster state
    config: any;
  };

  // Historical data for sanity checks and amplitude monitoring
  historicalMedians: Record<string, number[]>; // Area → 24-hour median MW values
  historicalShapeMedians: Record<string, number[]>; // Area → 24-hour median shapes

  // Configuration snapshot
  config: any;
}

/**
 * Calibration snapshot structure
 */
export interface CalibrationSnapshot {
  calibrationDate: string;
  modelVersion: string;      // Model file name or ID
  calibrationDays: number;
  levelScale: Record<string, number>;           // Computed scale factors (actual/predicted)
  manualLevelScale?: Record<string, number>;    // User-provided scale overrides (e.g., {"01NLUZ": 0.90})
  shapeCorrection: Record<string, number[]>;
  recentActuals: Record<string, Record<string, number>>; // Area → date → dailyTotal
  metrics: {
    levelMAPE: Record<string, number>;
    shapeMAPE: Record<string, number>;
    hourlyMAPE: Record<string, number>;
  };
}

export class ModelSerializer {
  /**
   * Save model artifact to .vfm binary file
   */
  static saveModel(artifact: DemandV2ModelArtifact, filePath: string): void {
    // Serialize artifact to MessagePack
    const dataBuffer = msgpack.encode(artifact);

    // Calculate checksum
    const checksum = crypto.createHash('sha256').update(dataBuffer).digest('hex');

    // Create header
    const header = Buffer.alloc(HEADER_SIZE);
    let offset = 0;

    // Magic bytes
    header.write(MAGIC_BYTES, offset, 'utf8');
    offset += 4;

    // Version (2)
    header.writeUInt32LE(2, offset);
    offset += 4;

    // Checksum (first 32 bytes)
    header.write(checksum.substring(0, 32), offset, 'utf8');
    offset += 32;

    // Data offset (after header)
    header.writeUInt32LE(HEADER_SIZE, offset);
    offset += 4;

    // Reserved (pad to 64 bytes)
    header.fill(0, offset);

    // Write file
    const fileBuffer = Buffer.concat([header, dataBuffer]);
    fs.writeFileSync(filePath, fileBuffer);

    console.log(`[ModelSerializer] Saved model to ${filePath} (${(fileBuffer.length / 1024).toFixed(1)} KB)`);
  }

  /**
   * Load model artifact from .vfm binary file
   */
  static loadModel(filePath: string): DemandV2ModelArtifact {
    const fileBuffer = fs.readFileSync(filePath);

    // Read header
    const magic = fileBuffer.toString('utf8', 0, 4);
    if (magic !== MAGIC_BYTES) {
      throw new Error(`Invalid model file: expected magic bytes "${MAGIC_BYTES}", got "${magic}"`);
    }

    const version = fileBuffer.readUInt32LE(4);
    if (version !== 2) {
      throw new Error(`Unsupported model version: ${version} (expected 2)`);
    }

    const storedChecksum = fileBuffer.toString('utf8', 8, 40);
    const dataOffset = fileBuffer.readUInt32LE(40);

    // Extract data section
    const dataBuffer = fileBuffer.subarray(dataOffset);

    // Verify checksum
    const computedChecksum = crypto.createHash('sha256').update(dataBuffer).digest('hex').substring(0, 32);
    if (computedChecksum !== storedChecksum) {
      throw new Error('Model file corrupted: checksum mismatch');
    }

    // Deserialize
    const artifact = msgpack.decode(dataBuffer) as DemandV2ModelArtifact;

    console.log(`[ModelSerializer] Loaded model from ${filePath} (trained ${artifact.trainedAt})`);

    return artifact;
  }

  /**
   * Save calibration snapshot to JSON file
   */
  static saveCalibration(snapshot: CalibrationSnapshot, filePath: string): void {
    const json = JSON.stringify(snapshot, null, 2);
    fs.writeFileSync(filePath, json, 'utf8');
    console.log(`[ModelSerializer] Saved calibration to ${filePath}`);
  }

  /**
   * Load calibration snapshot from JSON file
   */
  static loadCalibration(filePath: string): CalibrationSnapshot {
    const json = fs.readFileSync(filePath, 'utf8');
    const snapshot = JSON.parse(json) as CalibrationSnapshot;
    console.log(`[ModelSerializer] Loaded calibration from ${filePath} (date: ${snapshot.calibrationDate})`);
    return snapshot;
  }

  /**
   * Convert Map to Record for serialization
   */
  static mapToRecord<T>(map: Map<string, T>): Record<string, T> {
    const record: Record<string, T> = {};
    for (const [key, value] of map.entries()) {
      record[key] = value;
    }
    return record;
  }

  /**
   * Convert Record to Map for deserialization
   */
  static recordToMap<T>(record: Record<string, T>): Map<string, T> {
    const map = new Map<string, T>();
    for (const [key, value] of Object.entries(record)) {
      map.set(key, value as T);
    }
    return map;
  }
}
