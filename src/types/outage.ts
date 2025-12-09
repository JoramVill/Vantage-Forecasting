/**
 * Outage Event Types and Interfaces
 * For analyzing power plant outages and calculating outage probabilities
 */

// Grid regions in the Philippines
export type GridRegion = 'CLUZ' | 'CVIS' | 'CMIN';

// Fuel types for power plants
export type FuelType = 'COAL' | 'CCGT' | 'OIL' | 'HYDRO' | 'GEOTHERMAL' | 'SOLAR' | 'WIND' | 'BIOMASS' | 'BATTERY' | 'OTHER';

// Outage type - distinguishes between planned and unplanned outages
export enum OutageType {
  PLANNED = 'planned',     // Scheduled maintenance (from WAPOS)
  UNPLANNED = 'unplanned'  // Out of merit/forced outages (from Ev_/HistDBErr)
}

// Outage severity levels based on capacity loss
export enum OutageSeverity {
  MINOR = 'minor',        // < 50 MW
  MODERATE = 'moderate',  // 50-200 MW
  MAJOR = 'major',        // 200-500 MW
  CRITICAL = 'critical'   // > 500 MW
}

// Time periods for analysis
export enum TimePeriod {
  MORNING = 'morning',     // 6:00 - 12:00
  AFTERNOON = 'afternoon', // 12:00 - 18:00
  EVENING = 'evening',     // 18:00 - 24:00
  NIGHT = 'night'          // 0:00 - 6:00
}

/**
 * Raw outage event from Ev_*.csv files (unplanned/forced outages)
 */
export interface RawOutageEvent {
  eventId: string;         // *EID column
  type: string;            // Type (e.g., 'SUnit')
  duid: string;            // Dispatchable Unit ID
  startTime: Date;
  endTime: Date;
  property: string;        // Property affected (e.g., '%MwCap')
  capacity: number;        // Capacity during outage (usually 0)
}

/**
 * Planned outage from WAPOS files (scheduled maintenance)
 */
export interface PlannedOutage {
  runTime: Date;           // Date when this schedule was published
  resourceName: string;    // Unit ID (e.g., '01MAGAT_U01')
  startTime: Date;
  endTime: Date;
  parameterType: string;   // Usually 'STATUS'
  status: string;          // Usually 'OUT'
}

/**
 * Detailed outage record from HistDBErr_*.csv files
 */
export interface OutageDetail {
  unitId: string;
  siteId: string;
  regionId: GridRegion;
  maxGen: number;
  maxCap: number;          // Maximum capacity (MW)
  mrEnergy: number;
  fuelType: FuelType;
  capDeficit: number;      // Capacity lost (negative MW)
  remarks: string;
  datetime: Date;          // Extracted from remarks
}

/**
 * Combined outage record for analysis
 */
export interface OutageRecord {
  eventId: string;
  unitId: string;
  siteId: string;
  region: GridRegion;
  fuelType: FuelType;
  outageType: OutageType;  // Planned (WAPOS) or Unplanned (Ev/HistDBErr)
  startTime: Date;
  endTime: Date;
  durationMinutes: number;
  capacityMW: number;      // Unit's normal capacity
  capacityLostMW: number;  // Capacity lost during outage
  severity: OutageSeverity;
  timePeriod: TimePeriod;
  dayOfWeek: number;       // 0-6 (Sunday-Saturday)
  hour: number;            // 0-23
  month: number;           // 1-12
  isWeekend: boolean;
}

/**
 * Statistics for a single unit
 */
export interface UnitOutageStats {
  unitId: string;
  siteId: string;
  region: GridRegion;
  fuelType: FuelType;
  capacityMW: number;
  totalOutages: number;
  plannedOutages: number;    // Scheduled maintenance count
  unplannedOutages: number;  // Forced outage count
  totalOutageHours: number;
  plannedOutageHours: number;
  unplannedOutageHours: number;
  averageDurationHours: number;
  outageRate: number;        // Outages per month (unplanned only)
  plannedOutageRate: number; // Planned outages per month
  availabilityRate: number;  // % of time available
  mtbf: number;              // Mean Time Between Failures (unplanned, hours)
  mttr: number;              // Mean Time To Repair (hours)
  outagesByTimePeriod: Record<TimePeriod, number>;
  outagesByDayOfWeek: Record<number, number>;
  outagesBySeverity: Record<OutageSeverity, number>;
  outagesByType: Record<OutageType, number>;
}

/**
 * Statistics for a region
 */
export interface RegionOutageStats {
  region: GridRegion;
  totalUnits: number;
  totalCapacityMW: number;
  totalOutages: number;
  plannedOutages: number;
  unplannedOutages: number;
  totalOutageHours: number;
  averageOutagesPerDay: number;
  averageUnplannedOutagesPerDay: number;
  averageCapacityLostMW: number;
  peakOutageHour: number;
  peakOutageDayOfWeek: number;
  outagesByFuelType: Record<FuelType, number>;
  outagesBySeverity: Record<OutageSeverity, number>;
  outagesByTimePeriod: Record<TimePeriod, number>;
  outagesByType: Record<OutageType, number>;
}

/**
 * Probability model for outage prediction
 */
export interface OutageProbabilityModel {
  // Base probability by region
  regionBaseProbability: Record<GridRegion, number>;

  // Conditional probabilities
  fuelTypeMultiplier: Record<FuelType, number>;
  timePeriodMultiplier: Record<TimePeriod, number>;
  dayOfWeekMultiplier: Record<number, number>;
  monthMultiplier: Record<number, number>;

  // Historical patterns
  hourlyOutageDistribution: Record<number, number>;  // Hour -> probability
  weeklyPattern: number[];  // 7 days

  // Severity distribution
  severityDistribution: Record<OutageSeverity, number>;

  // Weather-based multipliers (from ML analysis)
  weatherMultipliers?: WeatherRiskMultipliers;
}

/**
 * Weather-based risk multipliers derived from ML correlation analysis
 */
export interface WeatherRiskMultipliers {
  // Precipitation thresholds (mm/day) -> risk multiplier
  precipitationThresholds: Array<{
    minPrecipMm: number;
    multiplier: number;
    label: string;
  }>;

  // Wind speed thresholds (km/h) -> risk multiplier
  windSpeedThresholds: Array<{
    minWindKmh: number;
    multiplier: number;
    label: string;
  }>;

  // Regional sensitivity adjustments
  regionalPrecipSensitivity: Record<GridRegion, number>;
}

/**
 * Outage forecast/prediction result
 */
export interface OutagePrediction {
  datetime: Date;
  region: GridRegion;
  probabilityOfOutage: number;        // 0-1
  expectedOutages: number;            // Expected count
  expectedCapacityLossMW: number;
  severityProbabilities: Record<OutageSeverity, number>;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  topRiskUnits: Array<{
    unitId: string;
    probability: number;
    expectedCapacityLossMW: number;
  }>;
}

/**
 * Parsed outage data container
 */
export interface ParsedOutageData {
  events: RawOutageEvent[];           // Unplanned events from Ev_*.csv
  details: OutageDetail[];            // Details from HistDBErr_*.csv
  plannedOutages: PlannedOutage[];    // Planned outages from WAPOS
  records: OutageRecord[];            // Combined unified records
  dateRange: {
    start: Date;
    end: Date;
  };
  totalEvents: number;
  totalPlannedOutages: number;
  totalUnplannedOutages: number;
  uniqueUnits: number;
}

/**
 * Analysis report
 */
export interface OutageAnalysisReport {
  generatedAt: Date;
  dataRange: {
    start: Date;
    end: Date;
  };
  summary: {
    totalOutages: number;
    totalCapacityLostMWh: number;
    averageOutagesPerDay: number;
    mostAffectedRegion: GridRegion;
    mostAffectedFuelType: FuelType;
    peakOutageHour: number;
  };
  regionStats: Record<GridRegion, RegionOutageStats>;
  unitStats: UnitOutageStats[];
  probabilityModel: OutageProbabilityModel;
  predictions: OutagePrediction[];
}
