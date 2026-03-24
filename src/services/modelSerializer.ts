/**
 * Model Serialization Service
 *
 * Handles binary serialization and deserialization of models using MessagePack.
 * Includes header validation and checksum verification.
 */

import msgpack from 'msgpack-lite';
import crypto from 'crypto';
import { SavedModel } from '../types/models.js';

const MAGIC_BYTES = 'VFM1'; // Vantage Forecast Model v1
const HEADER_SIZE = 64;     // Fixed header size in bytes

/**
 * Binary model file header structure
 */
interface ModelHeader {
  magic: string;            // "VFM1"
  version: number;          // File format version (1)
  checksum: string;         // SHA256 of data section
  metadataOffset: number;   // Byte offset to metadata
  modelDataOffset: number;  // Byte offset to model data
}

/**
 * Serialize a model to binary format
 */
export function serialize(model: SavedModel): Buffer {
  // Serialize metadata and model data separately
  const metadataBuffer = msgpack.encode({
    id: model.metadata.id,
    entityType: model.metadata.entityType,
    entityCode: model.metadata.entityCode,
    isGroupModel: model.metadata.isGroupModel,
    modelType: model.metadata.modelType,
    version: model.metadata.version,
    trainedAt: model.metadata.trainedAt,
    trainingPeriod: model.metadata.trainingPeriod,
    holdoutDays: model.metadata.holdoutDays,
    trainingRecords: model.metadata.trainingRecords,
    testRecords: model.metadata.testRecords,
  });

  const metricsBuffer = msgpack.encode(model.metrics);
  const featureConfigBuffer = msgpack.encode(model.featureConfig);
  const modelDataBuffer = msgpack.encode(model.modelData);

  // Calculate offsets
  const metadataOffset = HEADER_SIZE;
  const metricsOffset = metadataOffset + metadataBuffer.length;
  const featureConfigOffset = metricsOffset + metricsBuffer.length;
  const modelDataOffset = featureConfigOffset + featureConfigBuffer.length;

  // Combine all data sections
  const dataSection = Buffer.concat([
    metadataBuffer,
    metricsBuffer,
    featureConfigBuffer,
    modelDataBuffer,
  ]);

  // Calculate checksum of data section
  const checksum = crypto.createHash('sha256').update(dataSection).digest('hex');

  // Create header
  const header = Buffer.alloc(HEADER_SIZE);
  let offset = 0;

  // Magic bytes
  header.write(MAGIC_BYTES, offset, 'utf8');
  offset += 4;

  // Version
  header.writeUInt32LE(1, offset);
  offset += 4;

  // Checksum (first 32 bytes of SHA256)
  header.write(checksum.substring(0, 32), offset, 'utf8');
  offset += 32;

  // Metadata offset
  header.writeUInt32LE(metadataOffset, offset);
  offset += 4;

  // Metrics offset
  header.writeUInt32LE(metricsOffset, offset);
  offset += 4;

  // Feature config offset
  header.writeUInt32LE(featureConfigOffset, offset);
  offset += 4;

  // Model data offset
  header.writeUInt32LE(modelDataOffset, offset);
  offset += 4;

  // Combine header and data
  return Buffer.concat([header, dataSection]);
}

/**
 * Deserialize a binary model file
 */
export function deserialize(buffer: Buffer): SavedModel {
  // Validate header
  const header = readHeader(buffer);

  // Verify checksum
  const dataSection = buffer.slice(HEADER_SIZE);
  const actualChecksum = crypto.createHash('sha256').update(dataSection).digest('hex');
  if (!actualChecksum.startsWith(header.checksum)) {
    throw new Error('Model file checksum mismatch - file may be corrupted');
  }

  // Extract sections
  const metadataBuffer = buffer.slice(
    header.metadataOffset,
    header.metadataOffset + (buffer.readUInt32LE(20) || 0) // Read metadata length if stored
  );

  // For simplicity, we'll use msgpack's auto-detection of message boundaries
  let offset = header.metadataOffset;

  // Decode metadata
  const metadataDecoded = msgpack.decode(buffer.slice(offset));
  offset += msgpack.encode(metadataDecoded).length;

  // Decode metrics
  const metricsDecoded = msgpack.decode(buffer.slice(offset));
  offset += msgpack.encode(metricsDecoded).length;

  // Decode feature config
  const featureConfigDecoded = msgpack.decode(buffer.slice(offset));
  offset += msgpack.encode(featureConfigDecoded).length;

  // Decode model data
  const modelDataDecoded = msgpack.decode(buffer.slice(offset));

  // Reconstruct SavedModel
  const model: SavedModel = {
    metadata: metadataDecoded,
    metrics: metricsDecoded,
    featureConfig: featureConfigDecoded,
    modelData: modelDataDecoded,
  };

  return model;
}

/**
 * Read and validate header
 */
function readHeader(buffer: Buffer): ModelHeader {
  if (buffer.length < HEADER_SIZE) {
    throw new Error('Invalid model file - too small');
  }

  let offset = 0;

  // Read magic bytes
  const magic = buffer.toString('utf8', offset, offset + 4);
  offset += 4;

  if (magic !== MAGIC_BYTES) {
    throw new Error(`Invalid model file - expected magic bytes "${MAGIC_BYTES}", got "${magic}"`);
  }

  // Read version
  const version = buffer.readUInt32LE(offset);
  offset += 4;

  if (version !== 1) {
    throw new Error(`Unsupported model file version: ${version}`);
  }

  // Read checksum
  const checksum = buffer.toString('utf8', offset, offset + 32);
  offset += 32;

  // Read offsets
  const metadataOffset = buffer.readUInt32LE(offset);
  offset += 4;

  const metricsOffset = buffer.readUInt32LE(offset);
  offset += 4;

  const featureConfigOffset = buffer.readUInt32LE(offset);
  offset += 4;

  const modelDataOffset = buffer.readUInt32LE(offset);
  offset += 4;

  return {
    magic,
    version,
    checksum,
    metadataOffset,
    modelDataOffset,
  };
}

/**
 * Calculate checksum of a buffer
 */
export function calculateChecksum(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * Validate model file integrity
 */
export function validateModelFile(buffer: Buffer): boolean {
  try {
    const header = readHeader(buffer);
    const dataSection = buffer.slice(HEADER_SIZE);
    const actualChecksum = crypto.createHash('sha256').update(dataSection).digest('hex');
    return actualChecksum.startsWith(header.checksum);
  } catch (error) {
    return false;
  }
}
