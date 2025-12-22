/**
 * Type definitions for interconnector constraint prediction system
 */

/**
 * Raw interconnector data as parsed from RTDHS CSV
 */
export interface RawInterconnectorData {
  runTime: Date;
  marketType: string;
  timeInterval: Date;
  hvdcName: string;
  congestionFlag: 'Y' | 'N';
  flowFrom: number;
  flowTo: number;
  overloadMW: number | null;
}

/**
 * Interconnector record with optional source file tracking
 */
export interface InterconnectorRecord extends RawInterconnectorData {
  sourceFile?: string;
}

/**
 * Parsed interconnector data with summary statistics
 */
export interface ParsedInterconnectorData {
  records: InterconnectorRecord[];
  interconnectors: string[];
  startDate: Date;
  endDate: Date;
  filesProcessed?: number;
  totalCongestionEvents: number;
  congestionByInterconnector: Map<string, number>;
}

/**
 * Interconnector metadata
 */
export interface InterconnectorMetadata {
  name: string;
  fromRegion: string;
  toRegion: string;
  capacityMW: number;
  notes?: string;
}

/**
 * Interconnector statistics
 */
export interface InterconnectorStats {
  interconnector: string;
  totalRecords: number;
  congestionEvents: number;
  congestionRate: number;
  avgFlowFrom: number;
  avgFlowTo: number;
  peakFlowFrom: number;
  peakFlowTo: number;
  flowVolatility: number;
  dateRange: {
    start: string;
    end: string;
  };
}

/**
 * Congestion prediction result
 */
export interface InterconnectorCongestionPrediction {
  datetime: Date;
  interconnector: string;
  congestionProbability: number;
  expectedFlowFrom: number;
  expectedFlowTo: number;
  predictedFlag: 'Y' | 'N';
  confidence: number;
  features?: Record<string, number>;
}

/**
 * Training sample for congestion model
 */
export interface InterconnectorTrainingSample {
  // Target variables
  isCongested: boolean; // Original CONGESTION_FLAG
  isActuallyConstrained: boolean; // Detected via flat-line algorithm
  flowFrom: number;
  flowTo: number;

  // Features
  features: number[];
  featureNames?: string[];

  // Metadata
  datetime: Date;
  interconnector: string;
  constraintLevel?: number; // MW level if constrained
}

/**
 * Model evaluation metrics
 */
export interface InterconnectorModelMetrics {
  // Classification metrics
  accuracy: number;
  precision: number;
  recall: number;
  f1Score: number;
  confusionMatrix: {
    truePositive: number;
    trueNegative: number;
    falsePositive: number;
    falseNegative: number;
  };

  // Regression metrics (for flow prediction)
  r2Score: number;
  mape: number;
  mae: number;
  rmse: number;

  // Training info
  trainingSamples: number;
  trainingDate: string;
}
