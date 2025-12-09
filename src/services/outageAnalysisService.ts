/**
 * Outage Analysis Service
 * Provides statistical analysis and probability modeling for power plant outages
 * Supports both planned (WAPOS) and unplanned (Ev/HistDBErr) outages
 */

import { DateTime } from 'luxon';
import {
  OutageRecord,
  ParsedOutageData,
  GridRegion,
  FuelType,
  OutageSeverity,
  OutageType,
  TimePeriod,
  UnitOutageStats,
  RegionOutageStats,
  OutageProbabilityModel,
  OutagePrediction,
  OutageAnalysisReport,
  WeatherRiskMultipliers
} from '../types/outage.js';
import { getDatabase } from '../database/database.js';

/**
 * Calculate statistics for a single unit
 */
export function calculateUnitStats(
  records: OutageRecord[],
  unitId: string,
  totalHoursInPeriod: number
): UnitOutageStats | null {
  const unitRecords = records.filter(r => r.unitId === unitId);

  if (unitRecords.length === 0) return null;

  const first = unitRecords[0];

  // Separate planned and unplanned outages
  const plannedRecords = unitRecords.filter(r => r.outageType === OutageType.PLANNED);
  const unplannedRecords = unitRecords.filter(r => r.outageType === OutageType.UNPLANNED);

  const totalOutageMinutes = unitRecords.reduce((sum, r) => sum + r.durationMinutes, 0);
  const plannedOutageMinutes = plannedRecords.reduce((sum, r) => sum + r.durationMinutes, 0);
  const unplannedOutageMinutes = unplannedRecords.reduce((sum, r) => sum + r.durationMinutes, 0);

  const totalOutageHours = totalOutageMinutes / 60;
  const plannedOutageHours = plannedOutageMinutes / 60;
  const unplannedOutageHours = unplannedOutageMinutes / 60;

  // Initialize counters
  const byTimePeriod: Record<TimePeriod, number> = {
    [TimePeriod.MORNING]: 0,
    [TimePeriod.AFTERNOON]: 0,
    [TimePeriod.EVENING]: 0,
    [TimePeriod.NIGHT]: 0
  };

  const byDayOfWeek: Record<number, number> = {};
  for (let i = 0; i < 7; i++) byDayOfWeek[i] = 0;

  const bySeverity: Record<OutageSeverity, number> = {
    [OutageSeverity.MINOR]: 0,
    [OutageSeverity.MODERATE]: 0,
    [OutageSeverity.MAJOR]: 0,
    [OutageSeverity.CRITICAL]: 0
  };

  const byType: Record<OutageType, number> = {
    [OutageType.PLANNED]: plannedRecords.length,
    [OutageType.UNPLANNED]: unplannedRecords.length
  };

  for (const record of unitRecords) {
    byTimePeriod[record.timePeriod]++;
    byDayOfWeek[record.dayOfWeek]++;
    bySeverity[record.severity]++;
  }

  // Calculate months in period for rate calculation
  const monthsInPeriod = totalHoursInPeriod / (24 * 30);

  // MTBF: Mean Time Between Failures (hours between unplanned outages)
  const mtbf = unplannedRecords.length > 1
    ? (totalHoursInPeriod - unplannedOutageHours) / unplannedRecords.length
    : totalHoursInPeriod;

  // MTTR: Mean Time To Repair (average unplanned outage duration)
  const mttr = unplannedRecords.length > 0
    ? unplannedOutageHours / unplannedRecords.length
    : 0;

  return {
    unitId,
    siteId: first.siteId,
    region: first.region,
    fuelType: first.fuelType,
    capacityMW: first.capacityMW,
    totalOutages: unitRecords.length,
    plannedOutages: plannedRecords.length,
    unplannedOutages: unplannedRecords.length,
    totalOutageHours,
    plannedOutageHours,
    unplannedOutageHours,
    averageDurationHours: unitRecords.length > 0 ? totalOutageHours / unitRecords.length : 0,
    outageRate: unplannedRecords.length / monthsInPeriod,  // Only unplanned for rate
    plannedOutageRate: plannedRecords.length / monthsInPeriod,
    availabilityRate: (totalHoursInPeriod - totalOutageHours) / totalHoursInPeriod,
    mtbf,
    mttr,
    outagesByTimePeriod: byTimePeriod,
    outagesByDayOfWeek: byDayOfWeek,
    outagesBySeverity: bySeverity,
    outagesByType: byType
  };
}

/**
 * Calculate statistics for a region
 */
export function calculateRegionStats(
  records: OutageRecord[],
  region: GridRegion,
  totalDaysInPeriod: number
): RegionOutageStats {
  const regionRecords = records.filter(r => r.region === region);

  // Separate planned and unplanned
  const plannedRecords = regionRecords.filter(r => r.outageType === OutageType.PLANNED);
  const unplannedRecords = regionRecords.filter(r => r.outageType === OutageType.UNPLANNED);

  const uniqueUnits = new Set(regionRecords.map(r => r.unitId));
  const totalCapacity = regionRecords.reduce((max, r) => {
    return Math.max(max, r.capacityMW);
  }, 0) * uniqueUnits.size; // Rough estimate

  const totalOutageMinutes = regionRecords.reduce((sum, r) => sum + r.durationMinutes, 0);
  const totalCapacityLost = regionRecords.reduce((sum, r) => sum + r.capacityLostMW, 0);

  // Initialize counters
  const byFuelType: Record<FuelType, number> = {
    COAL: 0, CCGT: 0, OIL: 0, HYDRO: 0, GEOTHERMAL: 0,
    SOLAR: 0, WIND: 0, BIOMASS: 0, BATTERY: 0, OTHER: 0
  };

  const bySeverity: Record<OutageSeverity, number> = {
    [OutageSeverity.MINOR]: 0,
    [OutageSeverity.MODERATE]: 0,
    [OutageSeverity.MAJOR]: 0,
    [OutageSeverity.CRITICAL]: 0
  };

  const byTimePeriod: Record<TimePeriod, number> = {
    [TimePeriod.MORNING]: 0,
    [TimePeriod.AFTERNOON]: 0,
    [TimePeriod.EVENING]: 0,
    [TimePeriod.NIGHT]: 0
  };

  const byType: Record<OutageType, number> = {
    [OutageType.PLANNED]: plannedRecords.length,
    [OutageType.UNPLANNED]: unplannedRecords.length
  };

  const hourCounts: Record<number, number> = {};
  const dowCounts: Record<number, number> = {};
  for (let i = 0; i < 24; i++) hourCounts[i] = 0;
  for (let i = 0; i < 7; i++) dowCounts[i] = 0;

  for (const record of regionRecords) {
    byFuelType[record.fuelType]++;
    bySeverity[record.severity]++;
    byTimePeriod[record.timePeriod]++;
    hourCounts[record.hour]++;
    dowCounts[record.dayOfWeek]++;
  }

  // Find peak hour and day
  let peakHour = 0, peakHourCount = 0;
  for (const [hour, count] of Object.entries(hourCounts)) {
    if (count > peakHourCount) {
      peakHour = parseInt(hour);
      peakHourCount = count;
    }
  }

  let peakDow = 0, peakDowCount = 0;
  for (const [dow, count] of Object.entries(dowCounts)) {
    if (count > peakDowCount) {
      peakDow = parseInt(dow);
      peakDowCount = count;
    }
  }

  return {
    region,
    totalUnits: uniqueUnits.size,
    totalCapacityMW: totalCapacity,
    totalOutages: regionRecords.length,
    plannedOutages: plannedRecords.length,
    unplannedOutages: unplannedRecords.length,
    totalOutageHours: totalOutageMinutes / 60,
    averageOutagesPerDay: regionRecords.length / totalDaysInPeriod,
    averageUnplannedOutagesPerDay: unplannedRecords.length / totalDaysInPeriod,
    averageCapacityLostMW: regionRecords.length > 0 ? totalCapacityLost / regionRecords.length : 0,
    peakOutageHour: peakHour,
    peakOutageDayOfWeek: peakDow,
    outagesByFuelType: byFuelType,
    outagesBySeverity: bySeverity,
    outagesByTimePeriod: byTimePeriod,
    outagesByType: byType
  };
}

/**
 * Build a probability model from historical data
 */
export function buildProbabilityModel(
  records: OutageRecord[],
  totalHoursInPeriod: number
): OutageProbabilityModel {
  const totalDays = totalHoursInPeriod / 24;

  // Calculate base probability by region
  const regionCounts: Record<GridRegion, number> = { CLUZ: 0, CVIS: 0, CMIN: 0 };
  for (const record of records) {
    regionCounts[record.region]++;
  }

  const regionBaseProbability: Record<GridRegion, number> = {
    CLUZ: regionCounts.CLUZ / totalDays,
    CVIS: regionCounts.CVIS / totalDays,
    CMIN: regionCounts.CMIN / totalDays
  };

  // Calculate multipliers for each factor
  // These represent how much more/less likely outages are for each category

  // Fuel type multipliers
  const fuelCounts: Record<FuelType, number> = {
    COAL: 0, CCGT: 0, OIL: 0, HYDRO: 0, GEOTHERMAL: 0,
    SOLAR: 0, WIND: 0, BIOMASS: 0, BATTERY: 0, OTHER: 0
  };
  for (const record of records) {
    fuelCounts[record.fuelType]++;
  }
  const avgFuelCount = records.length / Object.keys(fuelCounts).filter(k => fuelCounts[k as FuelType] > 0).length;

  const fuelTypeMultiplier: Record<FuelType, number> = {} as any;
  for (const fuel of Object.keys(fuelCounts) as FuelType[]) {
    fuelTypeMultiplier[fuel] = fuelCounts[fuel] > 0 ? fuelCounts[fuel] / avgFuelCount : 0.1;
  }

  // Time period multipliers
  const periodCounts: Record<TimePeriod, number> = {
    [TimePeriod.MORNING]: 0,
    [TimePeriod.AFTERNOON]: 0,
    [TimePeriod.EVENING]: 0,
    [TimePeriod.NIGHT]: 0
  };
  for (const record of records) {
    periodCounts[record.timePeriod]++;
  }
  const avgPeriodCount = records.length / 4;

  const timePeriodMultiplier: Record<TimePeriod, number> = {
    [TimePeriod.MORNING]: periodCounts[TimePeriod.MORNING] / avgPeriodCount || 1,
    [TimePeriod.AFTERNOON]: periodCounts[TimePeriod.AFTERNOON] / avgPeriodCount || 1,
    [TimePeriod.EVENING]: periodCounts[TimePeriod.EVENING] / avgPeriodCount || 1,
    [TimePeriod.NIGHT]: periodCounts[TimePeriod.NIGHT] / avgPeriodCount || 1
  };

  // Day of week multipliers
  const dowCounts: Record<number, number> = {};
  for (let i = 0; i < 7; i++) dowCounts[i] = 0;
  for (const record of records) {
    dowCounts[record.dayOfWeek]++;
  }
  const avgDowCount = records.length / 7;

  const dayOfWeekMultiplier: Record<number, number> = {};
  for (let i = 0; i < 7; i++) {
    dayOfWeekMultiplier[i] = dowCounts[i] / avgDowCount || 1;
  }

  // Month multipliers
  const monthCounts: Record<number, number> = {};
  for (let i = 1; i <= 12; i++) monthCounts[i] = 0;
  for (const record of records) {
    monthCounts[record.month]++;
  }
  const monthsWithData = Object.values(monthCounts).filter(c => c > 0).length;
  const avgMonthCount = records.length / monthsWithData;

  const monthMultiplier: Record<number, number> = {};
  for (let i = 1; i <= 12; i++) {
    monthMultiplier[i] = monthCounts[i] > 0 ? monthCounts[i] / avgMonthCount : 1;
  }

  // Hourly distribution (normalized to probabilities)
  const hourCounts: Record<number, number> = {};
  for (let i = 0; i < 24; i++) hourCounts[i] = 0;
  for (const record of records) {
    hourCounts[record.hour]++;
  }

  const hourlyOutageDistribution: Record<number, number> = {};
  for (let i = 0; i < 24; i++) {
    hourlyOutageDistribution[i] = hourCounts[i] / records.length;
  }

  // Weekly pattern (normalized)
  const weeklyPattern: number[] = [];
  for (let i = 0; i < 7; i++) {
    weeklyPattern.push(dowCounts[i] / records.length);
  }

  // Severity distribution
  const sevCounts: Record<OutageSeverity, number> = {
    [OutageSeverity.MINOR]: 0,
    [OutageSeverity.MODERATE]: 0,
    [OutageSeverity.MAJOR]: 0,
    [OutageSeverity.CRITICAL]: 0
  };
  for (const record of records) {
    sevCounts[record.severity]++;
  }

  const severityDistribution: Record<OutageSeverity, number> = {
    [OutageSeverity.MINOR]: sevCounts[OutageSeverity.MINOR] / records.length,
    [OutageSeverity.MODERATE]: sevCounts[OutageSeverity.MODERATE] / records.length,
    [OutageSeverity.MAJOR]: sevCounts[OutageSeverity.MAJOR] / records.length,
    [OutageSeverity.CRITICAL]: sevCounts[OutageSeverity.CRITICAL] / records.length
  };

  return {
    regionBaseProbability,
    fuelTypeMultiplier,
    timePeriodMultiplier,
    dayOfWeekMultiplier,
    monthMultiplier,
    hourlyOutageDistribution,
    weeklyPattern,
    severityDistribution
  };
}

/**
 * Generate outage predictions for a date range
 */
export function generatePredictions(
  model: OutageProbabilityModel,
  unitStats: UnitOutageStats[],
  startDate: Date,
  endDate: Date,
  intervalHours: number = 24
): OutagePrediction[] {
  const predictions: OutagePrediction[] = [];

  let current = DateTime.fromJSDate(startDate);
  const end = DateTime.fromJSDate(endDate);

  while (current <= end) {
    const hour = current.hour;
    const dayOfWeek = current.weekday % 7;
    const month = current.month;

    // Determine time period
    let timePeriod: TimePeriod;
    if (hour >= 6 && hour < 12) timePeriod = TimePeriod.MORNING;
    else if (hour >= 12 && hour < 18) timePeriod = TimePeriod.AFTERNOON;
    else if (hour >= 18 && hour < 24) timePeriod = TimePeriod.EVENING;
    else timePeriod = TimePeriod.NIGHT;

    for (const region of ['CLUZ', 'CVIS', 'CMIN'] as GridRegion[]) {
      // Calculate base probability
      let probability = model.regionBaseProbability[region];

      // Apply multipliers
      probability *= model.timePeriodMultiplier[timePeriod];
      probability *= model.dayOfWeekMultiplier[dayOfWeek];
      probability *= model.monthMultiplier[month] || 1;

      // Normalize to reasonable range (0-1)
      probability = Math.min(1, Math.max(0, probability));

      // Expected outages and capacity loss
      const expectedOutages = probability * 2; // Average ~2 outages when one occurs
      const avgCapacityLoss = unitStats
        .filter(u => u.region === region)
        .reduce((sum, u) => sum + u.capacityMW / u.totalOutages, 0) / unitStats.filter(u => u.region === region).length || 100;

      // Determine risk level
      let riskLevel: 'low' | 'medium' | 'high' | 'critical';
      if (probability < 0.1) riskLevel = 'low';
      else if (probability < 0.3) riskLevel = 'medium';
      else if (probability < 0.5) riskLevel = 'high';
      else riskLevel = 'critical';

      // Top risk units for this region
      const regionUnits = unitStats
        .filter(u => u.region === region)
        .sort((a, b) => b.outageRate - a.outageRate)
        .slice(0, 5)
        .map(u => ({
          unitId: u.unitId,
          probability: Math.min(1, u.outageRate / 30) * probability, // Scale by outage rate
          expectedCapacityLossMW: u.capacityMW
        }));

      predictions.push({
        datetime: current.toJSDate(),
        region,
        probabilityOfOutage: probability,
        expectedOutages,
        expectedCapacityLossMW: expectedOutages * avgCapacityLoss,
        severityProbabilities: model.severityDistribution,
        riskLevel,
        topRiskUnits: regionUnits
      });
    }

    current = current.plus({ hours: intervalHours });
  }

  return predictions;
}

/**
 * Generate a comprehensive analysis report
 */
export function generateAnalysisReport(
  data: ParsedOutageData,
  onProgress?: (message: string) => void
): OutageAnalysisReport {
  const { records, dateRange } = data;

  onProgress?.('Calculating period statistics...');

  const totalHours = (dateRange.end.getTime() - dateRange.start.getTime()) / (1000 * 60 * 60);
  const totalDays = totalHours / 24;

  onProgress?.(`Analysis period: ${totalDays.toFixed(1)} days`);

  // Calculate region stats
  onProgress?.('Calculating region statistics...');
  const regionStats: Record<GridRegion, RegionOutageStats> = {
    CLUZ: calculateRegionStats(records, 'CLUZ', totalDays),
    CVIS: calculateRegionStats(records, 'CVIS', totalDays),
    CMIN: calculateRegionStats(records, 'CMIN', totalDays)
  };

  // Calculate unit stats
  onProgress?.('Calculating unit statistics...');
  const uniqueUnits = [...new Set(records.map(r => r.unitId))];
  const unitStats: UnitOutageStats[] = [];

  for (const unitId of uniqueUnits) {
    const stats = calculateUnitStats(records, unitId, totalHours);
    if (stats) {
      unitStats.push(stats);
    }
  }

  // Sort units by outage rate
  unitStats.sort((a, b) => b.outageRate - a.outageRate);

  onProgress?.(`Analyzed ${unitStats.length} units`);

  // Build probability model
  onProgress?.('Building probability model...');
  const probabilityModel = buildProbabilityModel(records, totalHours);

  // Calculate summary statistics
  const totalCapacityLostMWh = records.reduce(
    (sum, r) => sum + (r.capacityLostMW * r.durationMinutes / 60),
    0
  );

  // Find most affected region
  let mostAffectedRegion: GridRegion = 'CLUZ';
  let maxOutages = 0;
  for (const [region, stats] of Object.entries(regionStats)) {
    if (stats.totalOutages > maxOutages) {
      maxOutages = stats.totalOutages;
      mostAffectedRegion = region as GridRegion;
    }
  }

  // Find most affected fuel type
  const fuelOutages: Record<FuelType, number> = {
    COAL: 0, CCGT: 0, OIL: 0, HYDRO: 0, GEOTHERMAL: 0,
    SOLAR: 0, WIND: 0, BIOMASS: 0, BATTERY: 0, OTHER: 0
  };
  for (const record of records) {
    fuelOutages[record.fuelType]++;
  }
  let mostAffectedFuel: FuelType = 'COAL';
  let maxFuelOutages = 0;
  for (const [fuel, count] of Object.entries(fuelOutages)) {
    if (count > maxFuelOutages) {
      maxFuelOutages = count;
      mostAffectedFuel = fuel as FuelType;
    }
  }

  // Find peak outage hour
  const hourOutages: Record<number, number> = {};
  for (let i = 0; i < 24; i++) hourOutages[i] = 0;
  for (const record of records) {
    hourOutages[record.hour]++;
  }
  let peakHour = 0;
  let maxHourOutages = 0;
  for (const [hour, count] of Object.entries(hourOutages)) {
    if (count > maxHourOutages) {
      maxHourOutages = count;
      peakHour = parseInt(hour);
    }
  }

  // Generate predictions for the next 7 days from end of data
  onProgress?.('Generating predictions...');
  const predictionStart = dateRange.end;
  const predictionEnd = new Date(predictionStart.getTime() + 7 * 24 * 60 * 60 * 1000);
  const predictions = generatePredictions(probabilityModel, unitStats, predictionStart, predictionEnd, 24);

  onProgress?.('Report generation complete!');

  return {
    generatedAt: new Date(),
    dataRange: dateRange,
    summary: {
      totalOutages: records.length,
      totalCapacityLostMWh,
      averageOutagesPerDay: records.length / totalDays,
      mostAffectedRegion,
      mostAffectedFuelType: mostAffectedFuel,
      peakOutageHour: peakHour
    },
    regionStats,
    unitStats,
    probabilityModel,
    predictions
  };
}

/**
 * Format probability as percentage
 */
export function formatProbability(p: number): string {
  return `${(p * 100).toFixed(2)}%`;
}

/**
 * Get risk color for display
 */
export function getRiskColor(riskLevel: string): string {
  switch (riskLevel) {
    case 'low': return '\x1b[32m';      // Green
    case 'medium': return '\x1b[33m';   // Yellow
    case 'high': return '\x1b[31m';     // Red
    case 'critical': return '\x1b[35m'; // Magenta
    default: return '\x1b[0m';          // Reset
  }
}

/**
 * Store outage data and model in database
 */
export function saveOutageDataToDatabase(
  data: ParsedOutageData,
  model: OutageProbabilityModel,
  onProgress?: (message: string) => void
): { recordsImported: number; modelId: number } {
  const db = getDatabase();

  onProgress?.('Saving outage records to database...');
  const { inserted } = db.importOutageRecords(data.records);
  onProgress?.(`  Imported ${inserted} outage records`);

  // Update unit metadata
  onProgress?.('Updating unit metadata...');
  const seenUnits = new Set<string>();
  for (const record of data.records) {
    if (!seenUnits.has(record.unitId)) {
      db.updateUnitMetadata(
        record.unitId,
        record.siteId,
        record.region,
        record.fuelType,
        record.capacityMW
      );
      seenUnits.add(record.unitId);
    }
  }
  onProgress?.(`  Updated ${seenUnits.size} units`);

  // Save the probability model
  onProgress?.('Saving probability model...');
  const modelId = db.saveOutageModel(
    `Outage Model ${DateTime.now().toFormat('yyyy-MM-dd HH:mm')}`,
    data.dateRange.start.toISOString(),
    data.dateRange.end.toISOString(),
    data.records.length,
    data.totalPlannedOutages,
    data.totalUnplannedOutages,
    model
  );
  onProgress?.(`  Saved model with ID ${modelId}`);

  return { recordsImported: inserted, modelId };
}

/**
 * Load outage records from database
 */
export function loadOutageDataFromDatabase(options?: {
  startDate?: string;
  endDate?: string;
  region?: GridRegion;
  outageType?: OutageType;
}): ParsedOutageData {
  const db = getDatabase();
  const records = db.getOutageRecords(options);

  // Calculate date range
  let minDate = new Date();
  let maxDate = new Date(0);

  for (const record of records) {
    if (record.startTime < minDate) minDate = record.startTime;
    if (record.endTime > maxDate) maxDate = record.endTime;
  }

  const plannedCount = records.filter(r => r.outageType === OutageType.PLANNED).length;
  const unplannedCount = records.filter(r => r.outageType === OutageType.UNPLANNED).length;
  const uniqueUnits = new Set(records.map(r => r.unitId)).size;

  return {
    events: [],  // Not available from DB
    details: [],
    plannedOutages: [],
    records,
    dateRange: {
      start: minDate,
      end: maxDate
    },
    totalEvents: records.length,
    totalPlannedOutages: plannedCount,
    totalUnplannedOutages: unplannedCount,
    uniqueUnits
  };
}

/**
 * Get the active outage model from database
 */
export function getActiveOutageModelFromDatabase(): OutageProbabilityModel | null {
  const db = getDatabase();
  const storedModel = db.getActiveOutageModel();
  return storedModel?.modelData || null;
}

/**
 * Default weather risk multipliers based on ML analysis
 * These are derived from correlation analysis of historical weather-outage data
 */
export const DEFAULT_WEATHER_MULTIPLIERS: WeatherRiskMultipliers = {
  // Precipitation thresholds from ML threshold analysis
  precipitationThresholds: [
    { minPrecipMm: 100, multiplier: 3.40, label: 'Extreme Rain' },
    { minPrecipMm: 50, multiplier: 2.61, label: 'Heavy Rain' },
    { minPrecipMm: 20, multiplier: 1.34, label: 'Moderate Rain' },
    { minPrecipMm: 10, multiplier: 1.21, label: 'Light Rain' },
    { minPrecipMm: 5, multiplier: 1.20, label: 'Drizzle' },
    { minPrecipMm: 0, multiplier: 1.00, label: 'Dry' }
  ],

  // Wind speed thresholds from ML analysis
  windSpeedThresholds: [
    { minWindKmh: 50, multiplier: 3.35, label: 'Storm' },
    { minWindKmh: 40, multiplier: 2.24, label: 'High Wind' },
    { minWindKmh: 30, multiplier: 0.79, label: 'Moderate Wind' },
    { minWindKmh: 20, multiplier: 1.31, label: 'Light Wind' },
    { minWindKmh: 0, multiplier: 1.00, label: 'Calm' }
  ],

  // Regional sensitivity to precipitation (correlation coefficients from ML)
  regionalPrecipSensitivity: {
    CLUZ: 1.199,  // +0.199 correlation -> 19.9% more sensitive
    CVIS: 1.225,  // +0.225 correlation -> 22.5% more sensitive (most sensitive)
    CMIN: 1.000   // Baseline (different weather pattern - less correlated)
  }
};

/**
 * Get weather risk multiplier based on forecasted precipitation
 */
export function getPrecipitationMultiplier(
  precipMm: number,
  region: GridRegion,
  multipliers: WeatherRiskMultipliers = DEFAULT_WEATHER_MULTIPLIERS
): { multiplier: number; label: string } {
  // Find the appropriate threshold (sorted descending by minPrecipMm)
  const sortedThresholds = [...multipliers.precipitationThresholds]
    .sort((a, b) => b.minPrecipMm - a.minPrecipMm);

  for (const threshold of sortedThresholds) {
    if (precipMm >= threshold.minPrecipMm) {
      // Apply regional sensitivity adjustment
      const regionalSensitivity = multipliers.regionalPrecipSensitivity[region] || 1.0;
      const adjustedMultiplier = 1 + (threshold.multiplier - 1) * regionalSensitivity;

      return {
        multiplier: adjustedMultiplier,
        label: threshold.label
      };
    }
  }

  return { multiplier: 1.0, label: 'Unknown' };
}

/**
 * Get weather risk multiplier based on forecasted wind speed
 */
export function getWindSpeedMultiplier(
  windKmh: number,
  multipliers: WeatherRiskMultipliers = DEFAULT_WEATHER_MULTIPLIERS
): { multiplier: number; label: string } {
  const sortedThresholds = [...multipliers.windSpeedThresholds]
    .sort((a, b) => b.minWindKmh - a.minWindKmh);

  for (const threshold of sortedThresholds) {
    if (windKmh >= threshold.minWindKmh) {
      return {
        multiplier: threshold.multiplier,
        label: threshold.label
      };
    }
  }

  return { multiplier: 1.0, label: 'Unknown' };
}

/**
 * Combined weather risk multiplier
 * Uses the maximum of precipitation and wind multipliers (worst case)
 */
export function getCombinedWeatherMultiplier(
  precipMm: number,
  windKmh: number,
  region: GridRegion,
  multipliers: WeatherRiskMultipliers = DEFAULT_WEATHER_MULTIPLIERS
): { multiplier: number; precipLabel: string; windLabel: string; dominantFactor: string } {
  const precipResult = getPrecipitationMultiplier(precipMm, region, multipliers);
  const windResult = getWindSpeedMultiplier(windKmh, multipliers);

  // Use the maximum multiplier (worst case scenario)
  const dominantFactor = precipResult.multiplier >= windResult.multiplier ? 'precipitation' : 'wind';
  const multiplier = Math.max(precipResult.multiplier, windResult.multiplier);

  return {
    multiplier,
    precipLabel: precipResult.label,
    windLabel: windResult.label,
    dominantFactor
  };
}

/**
 * Weather-adjusted outage probability for a specific day and region
 */
export interface WeatherAdjustedProbability {
  date: string;
  region: GridRegion;
  baseProbability: number;
  weatherMultiplier: number;
  adjustedProbability: number;
  precipMm: number;
  windKmh: number;
  precipLabel: string;
  windLabel: string;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  expectedOutages: number;
  expectedCapacityLossMW: number;
}

/**
 * Calculate weather-adjusted outage probability per region
 * Uses forecasted weather data from database
 */
export function calculateWeatherAdjustedProbability(
  forecastDate: string,
  region: GridRegion,
  model: OutageProbabilityModel,
  averageCapacityLossMW: number = 150
): WeatherAdjustedProbability | null {
  const db = getDatabase();

  // Get forecasted weather for this date and region
  const weather = db.getWeatherForDateRegion(forecastDate, region);

  if (!weather) {
    return null;
  }

  // Get base probability from model
  const baseProbability = model.regionBaseProbability[region] || 0.3;

  // Get weather multiplier
  const precipMm = weather.precip || 0;
  const windKmh = Math.max(weather.windspeed || 0, weather.windgust || 0);

  const weatherResult = getCombinedWeatherMultiplier(
    precipMm,
    windKmh,
    region,
    model.weatherMultipliers || DEFAULT_WEATHER_MULTIPLIERS
  );

  // Calculate adjusted probability (capped at 1.0)
  const adjustedProbability = Math.min(1.0, baseProbability * weatherResult.multiplier);

  // Determine risk level
  let riskLevel: 'low' | 'medium' | 'high' | 'critical';
  if (adjustedProbability < 0.2) riskLevel = 'low';
  else if (adjustedProbability < 0.4) riskLevel = 'medium';
  else if (adjustedProbability < 0.6) riskLevel = 'high';
  else riskLevel = 'critical';

  // Expected outages based on historical average
  const expectedOutages = adjustedProbability * 2.5; // Average ~2.5 outages when probability is 1

  return {
    date: forecastDate,
    region,
    baseProbability,
    weatherMultiplier: weatherResult.multiplier,
    adjustedProbability,
    precipMm,
    windKmh,
    precipLabel: weatherResult.precipLabel,
    windLabel: weatherResult.windLabel,
    riskLevel,
    expectedOutages,
    expectedCapacityLossMW: expectedOutages * averageCapacityLossMW
  };
}

/**
 * Generate weather-adjusted outage forecast for multiple days and all regions
 */
export function generateWeatherAdjustedForecast(
  startDate: string,
  days: number = 7,
  onProgress?: (message: string) => void
): WeatherAdjustedProbability[] {
  const db = getDatabase();
  const forecasts: WeatherAdjustedProbability[] = [];

  // Get active outage model
  const storedModel = db.getActiveOutageModel();
  if (!storedModel) {
    onProgress?.('No outage model found. Please run outage analysis first.');
    return [];
  }

  const model = storedModel.modelData;

  // Get average capacity loss by region from historical data
  const regionAvgCapacity: Record<GridRegion, number> = {
    CLUZ: 180,  // From historical analysis
    CVIS: 120,
    CMIN: 150
  };

  const regions: GridRegion[] = ['CLUZ', 'CVIS', 'CMIN'];
  const start = DateTime.fromISO(startDate);

  for (let d = 0; d < days; d++) {
    const currentDate = start.plus({ days: d });
    const dateStr = currentDate.toISODate()!;

    onProgress?.(`Processing ${dateStr}...`);

    for (const region of regions) {
      const result = calculateWeatherAdjustedProbability(
        dateStr,
        region,
        model,
        regionAvgCapacity[region]
      );

      if (result) {
        forecasts.push(result);
      }
    }
  }

  onProgress?.(`Generated ${forecasts.length} forecasts`);
  return forecasts;
}

/**
 * Format weather-adjusted forecast for display
 */
export function formatWeatherForecastReport(forecasts: WeatherAdjustedProbability[]): string {
  if (forecasts.length === 0) {
    return 'No forecast data available. Ensure weather forecast data is imported.';
  }

  const lines: string[] = [];

  lines.push('═══════════════════════════════════════════════════════════════════════════════');
  lines.push('           WEATHER-ADJUSTED OUTAGE PROBABILITY FORECAST');
  lines.push('═══════════════════════════════════════════════════════════════════════════════');
  lines.push('');

  // Group by date
  const byDate = new Map<string, WeatherAdjustedProbability[]>();
  for (const f of forecasts) {
    const existing = byDate.get(f.date) || [];
    existing.push(f);
    byDate.set(f.date, existing);
  }

  for (const [date, regionForecasts] of byDate) {
    lines.push(`─── ${date} ───────────────────────────────────────────────────────────────`);
    lines.push('');
    lines.push('Region │ Base Prob │ Weather    │ Adj Prob  │ Risk     │ Expected │ Precip  │ Wind');
    lines.push('───────┼───────────┼────────────┼───────────┼──────────┼──────────┼─────────┼─────────');

    for (const f of regionForecasts.sort((a, b) => b.adjustedProbability - a.adjustedProbability)) {
      const basePct = (f.baseProbability * 100).toFixed(1).padStart(5);
      const multStr = `x${f.weatherMultiplier.toFixed(2)}`.padStart(10);
      const adjPct = (f.adjustedProbability * 100).toFixed(1).padStart(5);
      const risk = f.riskLevel.toUpperCase().padEnd(8);
      const expected = f.expectedOutages.toFixed(1).padStart(8);
      const precip = `${f.precipMm.toFixed(0)}mm`.padStart(7);
      const wind = `${f.windKmh.toFixed(0)}km/h`.padStart(8);

      lines.push(`${f.region}   │ ${basePct}%    │ ${multStr} │ ${adjPct}%    │ ${risk} │ ${expected} │ ${precip} │ ${wind}`);
    }
    lines.push('');
  }

  // Summary statistics
  lines.push('═══════════════════════════════════════════════════════════════════════════════');
  lines.push('SUMMARY');
  lines.push('───────────────────────────────────────────────────────────────────────────────');

  const highRiskDays = forecasts.filter(f => f.riskLevel === 'high' || f.riskLevel === 'critical');
  const totalExpectedOutages = forecasts.reduce((sum, f) => sum + f.expectedOutages, 0);
  const totalExpectedCapacity = forecasts.reduce((sum, f) => sum + f.expectedCapacityLossMW, 0);

  lines.push(`  High/Critical Risk Day-Regions: ${highRiskDays.length}`);
  lines.push(`  Total Expected Outages:         ${totalExpectedOutages.toFixed(1)}`);
  lines.push(`  Total Expected Capacity Loss:   ${totalExpectedCapacity.toFixed(0)} MW`);
  lines.push('');

  // Risk legend
  lines.push('Risk Levels: LOW (<20%) │ MEDIUM (20-40%) │ HIGH (40-60%) │ CRITICAL (>60%)');
  lines.push('');

  return lines.join('\n');
}
