/**
 * Feature engineering for interconnector congestion prediction
 */

import { DateTime } from 'luxon';
import { InterconnectorTrainingSample } from '../types/interconnector.js';
import { DemandRecord } from '../parsers/demandParser.js';
import { isPhilippineHoliday } from '../constants/index.js';
import { detectConstraintsByInterconnector, isRecordConstrained, ConstraintPeriod } from '../analysis/detectConstraints.js';
import { InterconnectorRecord } from '../types/interconnector.js';

/**
 * Feature names for interconnector model (45+ features)
 */
export const INTERCONNECTOR_FEATURE_NAMES = [
  // Temporal (10)
  'hour', 'dayOfWeek', 'isWeekend', 'isHoliday', 'dayOfMonth', 'month',
  'hourSin', 'hourCos', 'dayOfWeekSin', 'dayOfWeekCos',

  // Demand (9)
  'demandCLUZ', 'demandCVIS', 'demandCMIN', 'demandTotal',
  'demandRatio_CV', 'demandRatio_CM', 'demandRatio_CL',
  'demandDiff_CV', 'demandDiff_CM',

  // Weather (12)
  'tempCLUZ', 'tempCVIS', 'tempCMIN', 'tempDiff_CV', 'tempDiff_CM',
  'windCLUZ', 'windCVIS', 'windCMIN',
  'solarCLUZ', 'solarCVIS', 'solarCMIN',
  'avgTemp',

  // Flow lags (9)
  'flowLag1h', 'flowLag24h', 'flowLag168h',
  'flowRolling24h', 'flowVolatility24h',
  'congestionLag1h', 'congestionLag24h',
  'congestionCount24h', 'congestionCount168h',

  // Constraint detection features (5)
  'flowVariability', 'isFlowFlat', 'timeSinceLastConstraint',
  'constraintDuration', 'recentConstraintLevel'
];

/**
 * Weather data interface
 */
interface WeatherFeatures {
  temp: number;
  windspeed: number;
  solarradiation: number;
}

/**
 * Build feature vector for interconnector prediction
 *
 * @param datetime - The timestamp for the prediction
 * @param interconnector - Interconnector name (MINVIS1 or VISLUZ1)
 * @param demandData - Regional demand data (region -> demand in MW)
 * @param weatherData - Regional weather data (region -> weather features)
 * @param flowHistory - Historical flow data (timestamp_interconnector -> flow in MW)
 * @param congestionHistory - Historical congestion flags (timestamp_interconnector -> boolean)
 * @param constraintHistory - Historical constraint detection (timestamp_interconnector -> {isConstrained, level, duration})
 * @returns Feature vector as number array
 */
export function buildInterconnectorFeatures(
  datetime: Date,
  interconnector: string,
  demandData: Map<string, number>,
  weatherData: Map<string, WeatherFeatures>,
  flowHistory: Map<string, number>,
  congestionHistory: Map<string, boolean>,
  constraintHistory?: Map<string, {isConstrained: boolean, level: number, duration: number}>
): number[] {
  const dt = DateTime.fromJSDate(datetime);
  const features: number[] = [];

  // ========== TEMPORAL FEATURES (10) ==========
  const hour = dt.hour;
  const dayOfWeek = dt.weekday % 7; // Sunday = 0
  const month = dt.month;

  features.push(
    hour,
    dayOfWeek,
    dayOfWeek >= 5 ? 1 : 0,  // isWeekend
    isPhilippineHoliday(dt.toISODate()!) ? 1 : 0,  // isHoliday (dynamic detection)
    dt.day,
    month,
    Math.sin(2 * Math.PI * hour / 24),
    Math.cos(2 * Math.PI * hour / 24),
    Math.sin(2 * Math.PI * dayOfWeek / 7),
    Math.cos(2 * Math.PI * dayOfWeek / 7)
  );

  // ========== DEMAND FEATURES (9) ==========
  const demandCLUZ = demandData.get('CLUZ') || 0;
  const demandCVIS = demandData.get('CVIS') || 0;
  const demandCMIN = demandData.get('CMIN') || 0;
  const demandTotal = demandCLUZ + demandCVIS + demandCMIN;

  features.push(
    demandCLUZ,
    demandCVIS,
    demandCMIN,
    demandTotal,
    demandCLUZ > 0 ? demandCVIS / demandCLUZ : 0,  // ratio CV
    demandCVIS > 0 ? demandCMIN / demandCVIS : 0,  // ratio CM
    demandCLUZ > 0 ? demandCMIN / demandCLUZ : 0,  // ratio CL
    demandCVIS - demandCLUZ,  // diff CV
    demandCMIN - demandCVIS   // diff CM
  );

  // ========== WEATHER FEATURES (12) ==========
  const weatherCLUZ = weatherData.get('CLUZ') || { temp: 28, windspeed: 0, solarradiation: 0 };
  const weatherCVIS = weatherData.get('CVIS') || { temp: 28, windspeed: 0, solarradiation: 0 };
  const weatherCMIN = weatherData.get('CMIN') || { temp: 28, windspeed: 0, solarradiation: 0 };

  features.push(
    weatherCLUZ.temp,
    weatherCVIS.temp,
    weatherCMIN.temp,
    weatherCVIS.temp - weatherCLUZ.temp,
    weatherCMIN.temp - weatherCVIS.temp,
    weatherCLUZ.windspeed,
    weatherCVIS.windspeed,
    weatherCMIN.windspeed,
    weatherCLUZ.solarradiation,
    weatherCVIS.solarradiation,
    weatherCMIN.solarradiation,
    (weatherCLUZ.temp + weatherCVIS.temp + weatherCMIN.temp) / 3
  );

  // ========== FLOW LAG FEATURES (9) ==========
  const ts = datetime.getTime();
  const key = (offset: number) => `${ts - offset}_${interconnector}`;

  const flowLag1h = flowHistory.get(key(3600000)) || 0;
  const flowLag24h = flowHistory.get(key(86400000)) || 0;
  const flowLag168h = flowHistory.get(key(604800000)) || 0;

  // Rolling average and volatility (last 24 hours)
  const last24Flows: number[] = [];
  for (let i = 1; i <= 24; i++) {
    const flow = flowHistory.get(key(i * 3600000));
    if (flow !== undefined) last24Flows.push(flow);
  }

  const flowRolling24h = last24Flows.length > 0
    ? last24Flows.reduce((a, b) => a + b, 0) / last24Flows.length
    : 0;

  const flowVolatility24h = last24Flows.length > 1
    ? Math.sqrt(last24Flows.reduce((sum, val) => sum + Math.pow(val - flowRolling24h, 2), 0) / last24Flows.length)
    : 0;

  // Congestion lags
  const congestionLag1h = congestionHistory.get(key(3600000)) ? 1 : 0;
  const congestionLag24h = congestionHistory.get(key(86400000)) ? 1 : 0;

  // Congestion counts
  let congestionCount24h = 0;
  let congestionCount168h = 0;
  for (let i = 1; i <= 168; i++) {
    if (congestionHistory.get(key(i * 3600000))) {
      congestionCount168h++;
      if (i <= 24) congestionCount24h++;
    }
  }

  features.push(
    flowLag1h,
    flowLag24h,
    flowLag168h,
    flowRolling24h,
    flowVolatility24h,
    congestionLag1h,
    congestionLag24h,
    congestionCount24h,
    congestionCount168h
  );

  // ========== CONSTRAINT DETECTION FEATURES (5) ==========
  // flowVariability: Standard deviation of flow over last 12 intervals (1 hour)
  const last12Flows: number[] = [];
  for (let i = 1; i <= 12; i++) {
    const flow = flowHistory.get(key(i * 300000)); // 5-min intervals
    if (flow !== undefined) last12Flows.push(flow);
  }

  const flowVariability = last12Flows.length > 1
    ? Math.sqrt(last12Flows.reduce((sum, val) => {
        const mean = last12Flows.reduce((a, b) => a + b, 0) / last12Flows.length;
        return sum + Math.pow(val - mean, 2);
      }, 0) / last12Flows.length)
    : 0;

  const isFlowFlat = flowVariability < 2 ? 1 : 0; // ±2 MW tolerance

  // Constraint history features
  let timeSinceLastConstraint = 999; // Large number if no recent constraint
  let constraintDuration = 0;
  let recentConstraintLevel = 0;

  if (constraintHistory) {
    // Search backwards for the last constraint
    for (let hours = 1; hours <= 168; hours++) {
      const constraintData = constraintHistory.get(key(hours * 3600000));
      if (constraintData?.isConstrained) {
        timeSinceLastConstraint = hours;
        constraintDuration = constraintData.duration;
        recentConstraintLevel = constraintData.level;
        break;
      }
    }
  }

  features.push(
    flowVariability,
    isFlowFlat,
    timeSinceLastConstraint,
    constraintDuration,
    recentConstraintLevel
  );

  return features;
}

/**
 * Build training samples from historical data
 *
 * @param interconnectorRecords - Historical interconnector flow and congestion records
 * @param demandRecords - Historical demand records
 * @param weatherRecords - Historical weather records
 * @returns Array of training samples
 */
export function buildInterconnectorTrainingSamples(
  interconnectorRecords: any[],
  demandRecords: DemandRecord[],
  weatherRecords: any[]
): InterconnectorTrainingSample[] {
  // Build lookup maps for efficient access
  const demandMap = new Map<string, Map<string, number>>();
  for (const record of demandRecords) {
    const key = record.datetime.getTime().toString();
    if (!demandMap.has(key)) {
      demandMap.set(key, new Map());
    }
    demandMap.get(key)!.set(record.region, record.demand);
  }

  const weatherMap = new Map<string, Map<string, WeatherFeatures>>();
  for (const record of weatherRecords) {
    const dt = new Date(record.datetime);
    const key = dt.getTime().toString();
    if (!weatherMap.has(key)) {
      weatherMap.set(key, new Map());
    }
    weatherMap.get(key)!.set(record.region, {
      temp: record.temp,
      windspeed: record.windspeed,
      solarradiation: record.solarradiation
    });
  }

  // Build flow and congestion history maps
  const flowHistory = new Map<string, number>();
  const congestionHistory = new Map<string, boolean>();

  for (const record of interconnectorRecords) {
    const ts = record.timeInterval.getTime();
    const key = `${ts}_${record.hvdcName}`;
    flowHistory.set(key, record.flowFrom);
    congestionHistory.set(key, record.congestionFlag === 'Y');
  }

  // DETECT CONSTRAINTS using flat-line algorithm
  console.log('Running constraint detection on historical data...');
  const constraintsByInterconnector = detectConstraintsByInterconnector(interconnectorRecords);

  let totalConstraints = 0;
  for (const constraints of constraintsByInterconnector.values()) {
    totalConstraints += constraints.length;
  }
  console.log(`Detected ${totalConstraints} constraint periods across all interconnectors`);

  // Build constraint history map (timestamp_interconnector -> constraint info)
  const constraintHistory = new Map<string, {isConstrained: boolean, level: number, duration: number}>();
  const recordIndexToConstraint = new Map<number, ConstraintPeriod>();

  for (const [interconnectorName, constraints] of constraintsByInterconnector.entries()) {
    for (const constraint of constraints) {
      for (const idx of constraint.recordIndices) {
        recordIndexToConstraint.set(idx, constraint);
        const record = interconnectorRecords[idx];
        const ts = record.timeInterval.getTime();
        const key = `${ts}_${record.hvdcName}`;
        constraintHistory.set(key, {
          isConstrained: true,
          level: constraint.constraintLevel,
          duration: constraint.durationHours
        });
      }
    }
  }

  // Build training samples
  const samples: InterconnectorTrainingSample[] = [];

  for (let i = 0; i < interconnectorRecords.length; i++) {
    const record = interconnectorRecords[i];
    const datetime = record.timeInterval;
    const ts = datetime.getTime();
    const key = ts.toString();

    const demandData = demandMap.get(key) || new Map();
    const weatherData = weatherMap.get(key) || new Map();

    // Skip if missing critical data
    if (demandData.size === 0 && weatherData.size === 0) {
      continue;
    }

    const features = buildInterconnectorFeatures(
      datetime,
      record.hvdcName,
      demandData,
      weatherData,
      flowHistory,
      congestionHistory,
      constraintHistory
    );

    const constraint = recordIndexToConstraint.get(i);
    const isActuallyConstrained = constraint !== undefined;

    samples.push({
      isCongested: record.congestionFlag === 'Y',
      isActuallyConstrained,
      flowFrom: record.flowFrom,
      flowTo: record.flowTo,
      features,
      featureNames: INTERCONNECTOR_FEATURE_NAMES,
      datetime,
      interconnector: record.hvdcName,
      constraintLevel: constraint?.constraintLevel
    });
  }

  return samples;
}
