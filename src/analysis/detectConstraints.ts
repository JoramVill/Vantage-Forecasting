/**
 * Constraint detection algorithm based on flat-line analysis
 * Detects when interconnector flow is capped at a constant level
 */

import { InterconnectorRecord } from '../types/interconnector.js';

/**
 * A detected constraint period where flow is capped at a constant level
 */
export interface ConstraintPeriod {
  startTime: Date;
  endTime: Date;
  constraintLevel: number; // MW flow level
  durationHours: number;
  durationIntervals: number; // Number of 5-min intervals
  interconnector: string;
  avgFlow: number;
  flowVariance: number;
  recordIndices: number[]; // Indices into the original records array
}

/**
 * Statistics about detected constraints
 */
export interface ConstraintStats {
  totalConstraintPeriods: number;
  totalConstrainedHours: number;
  constraintLevelDistribution: Map<number, number>; // Level (MW) -> count
  avgDuration: number;
  maxDuration: number;
  minDuration: number;
  comparisonWithCongestionFlag: {
    constrainedWithFlag: number;
    constrainedWithoutFlag: number;
    flaggedWithoutConstraint: number;
    agreement: number; // Percentage
  };
}

/**
 * Configuration for constraint detection
 */
export interface ConstraintDetectionConfig {
  tolerance: number; // MW variance tolerance
  minDuration: number; // Minimum consecutive intervals to qualify as constraint
  roundingPrecision: number; // Round flow to nearest X MW for level detection
}

const DEFAULT_CONFIG: ConstraintDetectionConfig = {
  tolerance: 2, // ±2 MW
  minDuration: 12, // 12 5-min intervals = 1 hour
  roundingPrecision: 10, // Round to nearest 10 MW
};

/**
 * Detect constraint periods in interconnector data
 * @param records Sorted interconnector records (must be for single interconnector)
 * @param config Detection configuration
 * @returns Array of detected constraint periods
 */
export function detectConstraintPeriods(
  records: InterconnectorRecord[],
  config: ConstraintDetectionConfig = DEFAULT_CONFIG
): ConstraintPeriod[] {
  if (records.length === 0) {
    return [];
  }

  const constraints: ConstraintPeriod[] = [];
  let i = 0;

  while (i < records.length) {
    // Check if we have a flat period starting at index i
    const flatPeriod = findFlatPeriod(records, i, config);

    if (flatPeriod && flatPeriod.durationIntervals >= config.minDuration) {
      constraints.push(flatPeriod);
      // Skip past this constraint period
      i = flatPeriod.recordIndices[flatPeriod.recordIndices.length - 1] + 1;
    } else {
      i++;
    }
  }

  return constraints;
}

/**
 * Find a flat period starting at the given index
 */
function findFlatPeriod(
  records: InterconnectorRecord[],
  startIdx: number,
  config: ConstraintDetectionConfig
): ConstraintPeriod | null {
  if (startIdx >= records.length) {
    return null;
  }

  const baseFlow = records[startIdx].flowFrom;
  const indices: number[] = [startIdx];
  let sumFlow = baseFlow;
  let sumSquaredFlow = baseFlow * baseFlow;

  // Extend the period as long as flow stays within tolerance
  for (let i = startIdx + 1; i < records.length; i++) {
    const flow = records[i].flowFrom;

    // Check if this flow is within tolerance of the base flow
    if (Math.abs(flow - baseFlow) <= config.tolerance) {
      indices.push(i);
      sumFlow += flow;
      sumSquaredFlow += flow * flow;
    } else {
      // Period ended
      break;
    }
  }

  if (indices.length < 2) {
    return null;
  }

  const n = indices.length;
  const avgFlow = sumFlow / n;
  const variance = (sumSquaredFlow / n) - (avgFlow * avgFlow);

  // Round constraint level to nearest precision
  const constraintLevel = Math.round(avgFlow / config.roundingPrecision) * config.roundingPrecision;

  const startTime = records[indices[0]].timeInterval;
  const endTime = records[indices[indices.length - 1]].timeInterval;
  const durationMs = endTime.getTime() - startTime.getTime();
  const durationHours = durationMs / (1000 * 60 * 60);

  return {
    startTime,
    endTime,
    constraintLevel,
    durationHours,
    durationIntervals: indices.length,
    interconnector: records[startIdx].hvdcName,
    avgFlow,
    flowVariance: variance,
    recordIndices: indices,
  };
}

/**
 * Check if a record is part of any constraint period
 * @param recordIndex Index of the record to check
 * @param constraints Array of detected constraint periods
 * @returns The constraint period the record belongs to, or null
 */
export function isRecordConstrained(
  recordIndex: number,
  constraints: ConstraintPeriod[]
): ConstraintPeriod | null {
  for (const constraint of constraints) {
    if (constraint.recordIndices.includes(recordIndex)) {
      return constraint;
    }
  }
  return null;
}

/**
 * Calculate statistics about detected constraints
 */
export function calculateConstraintStats(
  constraints: ConstraintPeriod[],
  records: InterconnectorRecord[]
): ConstraintStats {
  if (constraints.length === 0) {
    return {
      totalConstraintPeriods: 0,
      totalConstrainedHours: 0,
      constraintLevelDistribution: new Map(),
      avgDuration: 0,
      maxDuration: 0,
      minDuration: 0,
      comparisonWithCongestionFlag: {
        constrainedWithFlag: 0,
        constrainedWithoutFlag: 0,
        flaggedWithoutConstraint: 0,
        agreement: 0,
      },
    };
  }

  const levelDistribution = new Map<number, number>();
  let totalHours = 0;
  let maxDuration = 0;
  let minDuration = Infinity;

  // Build a set of constrained record indices for quick lookup
  const constrainedIndices = new Set<number>();
  for (const constraint of constraints) {
    for (const idx of constraint.recordIndices) {
      constrainedIndices.add(idx);
    }

    // Update distribution
    const level = constraint.constraintLevel;
    levelDistribution.set(level, (levelDistribution.get(level) || 0) + 1);

    totalHours += constraint.durationHours;
    maxDuration = Math.max(maxDuration, constraint.durationHours);
    minDuration = Math.min(minDuration, constraint.durationHours);
  }

  // Compare with CONGESTION_FLAG
  let constrainedWithFlag = 0;
  let constrainedWithoutFlag = 0;
  let flaggedWithoutConstraint = 0;

  for (let i = 0; i < records.length; i++) {
    const isConstrained = constrainedIndices.has(i);
    const isFlagged = records[i].congestionFlag === 'Y';

    if (isConstrained && isFlagged) {
      constrainedWithFlag++;
    } else if (isConstrained && !isFlagged) {
      constrainedWithoutFlag++;
    } else if (!isConstrained && isFlagged) {
      flaggedWithoutConstraint++;
    }
  }

  const totalAgreement = (constrainedWithFlag + (records.length - constrainedIndices.size - flaggedWithoutConstraint));
  const agreementPct = (totalAgreement / records.length) * 100;

  return {
    totalConstraintPeriods: constraints.length,
    totalConstrainedHours: totalHours,
    constraintLevelDistribution: levelDistribution,
    avgDuration: totalHours / constraints.length,
    maxDuration,
    minDuration: minDuration === Infinity ? 0 : minDuration,
    comparisonWithCongestionFlag: {
      constrainedWithFlag,
      constrainedWithoutFlag,
      flaggedWithoutConstraint,
      agreement: agreementPct,
    },
  };
}

/**
 * Group records by interconnector and detect constraints for each
 */
export function detectConstraintsByInterconnector(
  records: InterconnectorRecord[],
  config: ConstraintDetectionConfig = DEFAULT_CONFIG
): Map<string, ConstraintPeriod[]> {
  // Group by interconnector
  const recordsByInterconnector = new Map<string, InterconnectorRecord[]>();

  for (const record of records) {
    const name = record.hvdcName;
    if (!recordsByInterconnector.has(name)) {
      recordsByInterconnector.set(name, []);
    }
    recordsByInterconnector.get(name)!.push(record);
  }

  // Detect constraints for each interconnector
  const constraintsByInterconnector = new Map<string, ConstraintPeriod[]>();

  for (const [name, interconnectorRecords] of recordsByInterconnector.entries()) {
    // Sort by time
    interconnectorRecords.sort((a, b) => a.timeInterval.getTime() - b.timeInterval.getTime());

    const constraints = detectConstraintPeriods(interconnectorRecords, config);
    constraintsByInterconnector.set(name, constraints);
  }

  return constraintsByInterconnector;
}

/**
 * Export constraint periods to CSV format
 */
export function exportConstraintsToCSV(constraints: ConstraintPeriod[]): string {
  const lines: string[] = [
    'Interconnector,Start Time,End Time,Duration (hours),Constraint Level (MW),Intervals,Avg Flow,Variance',
  ];

  for (const c of constraints) {
    lines.push(
      `${c.interconnector},${c.startTime.toISOString()},${c.endTime.toISOString()},` +
      `${c.durationHours.toFixed(2)},${c.constraintLevel},${c.durationIntervals},` +
      `${c.avgFlow.toFixed(2)},${c.flowVariance.toFixed(4)}`
    );
  }

  return lines.join('\n');
}
