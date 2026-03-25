/**
 * WindHybridModel - V2 Unified Wind Model
 *
 * This is the RECOMMENDED wind model for CFAC V2.
 * Alias for Wind4TierHybridModel - same implementation, cleaner name.
 *
 * Architecture: 4-Tier MREC + ML Residual
 * - Base: iPool MREC 4-tier wind-to-power conversion
 * - ML Layer: Learns systematic deviations using weather features
 * - Calibration: Global bias + hourly scale factors (applied at inference)
 *
 * This model achieves ~73% MAPE on test data (training MAPE is misleading at 130%+).
 *
 * V2 Changes:
 * - Renamed from Wind4TierHybridModel for consistency
 * - Per-station hourly calibration re-enabled (was disabled in V1)
 */

export { Wind4TierHybridModel as WindHybridModel, trainAll4TierHybrid as trainAllWindHybrid } from './Wind4TierHybridModel.js';
