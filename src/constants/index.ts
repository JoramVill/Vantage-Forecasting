import Holidays from 'date-holidays';
import { readFileSync } from 'fs';
import { join } from 'path';
import { ZonalConfig, ZoneConfig } from '../types/index.js';

// Region mappings (weather city -> demand column)
export const REGION_MAPPINGS: Record<string, { demandColumn: string; city: string }> = {
  'manila': { demandColumn: 'CLUZ', city: 'Manila' },
  'cebu': { demandColumn: 'CVIS', city: 'Cebu City' },
  'davao': { demandColumn: 'CMIN', city: 'Davao City' }
};

// Tropical climate base temperature for CDH
export const BASE_TEMP_CELSIUS = 24;

// Initialize Philippines holiday detector
const phHolidays = new Holidays('PH');

// Feature names for model (order matters for XGBoost)
export const FEATURE_NAMES = [
  // Basic temporal
  'hour', 'dayOfWeek', 'isWeekend', 'isHoliday', 'dayOfMonth', 'month',

  // Cyclical hour encoding (captures hour patterns without linearity assumption)
  'hourSin', 'hourCos',

  // Day type one-hot encoding
  'isWorkday', 'isSaturday', 'isSunday',

  // Hour one-hot encoding (24 features) - lets model learn each hour's demand profile
  'hour_0', 'hour_1', 'hour_2', 'hour_3', 'hour_4', 'hour_5',
  'hour_6', 'hour_7', 'hour_8', 'hour_9', 'hour_10', 'hour_11',
  'hour_12', 'hour_13', 'hour_14', 'hour_15', 'hour_16', 'hour_17',
  'hour_18', 'hour_19', 'hour_20', 'hour_21', 'hour_22', 'hour_23',

  // Hour-DayType interactions (allows different hourly patterns per day type)
  'hourWorkday', 'hourSaturday', 'hourSunday',

  // Weather features
  'temp', 'tempSquared', 'dew', 'precip', 'windgust', 'windspeed', 'cloudcover', 'solarradiation', 'uvindex',

  // Derived weather
  'relativeHumidity', 'heatIndex', 'CDH', 'effectiveSolar', 'apparentTemp', 'isRaining', 'tempDewSpread', 'isDaytime',

  // Lag features
  'demandLag1h', 'demandLag24h', 'demandLag168h', 'tempLag1h', 'tempLag24h',

  // Rolling averages
  'demandRolling24h', 'tempRolling24h', 'tempMax24h'
] as const;

// Philippines Holidays - Dynamic detection using date-holidays package
// Supports both Regular Holidays and Special Non-Working Days
// Source: date-holidays npm package with Philippines (PH) data

// Cache for holidays by year to avoid repeated calculations
const holidayCache: Map<number, string[]> = new Map();

// Special proclaimed holidays (one-time presidential proclamations not in date-holidays package)
// Add holidays here that are declared by special proclamation
// NOTE: Only add holidays that are ACTUALLY observed (verify with demand data patterns)
// Dec 9, 2025 was removed - actual demand showed normal workday levels, not holiday behavior
const PH_HOLIDAYS_PROCLAIMED: Record<number, string[]> = {
  2024: [],
  2025: [],
  2026: ['2026-01-02', '2026-01-03'], // New Year extended - most people returned to work on Monday Jan 5
};

/**
 * Get all Philippine holidays for a given year using date-holidays package
 * Results are cached for performance
 * @param year The year to get holidays for
 * @returns Array of holiday date strings in YYYY-MM-DD format
 */
export function getHolidaysForYear(year: number): string[] {
  // Check cache first
  if (holidayCache.has(year)) {
    return holidayCache.get(year)!;
  }

  // Get holidays from the package (includes both public and bank holidays)
  const holidays = phHolidays.getHolidays(year);

  // Convert to YYYY-MM-DD format and filter for public/bank holidays only
  const holidayDates = holidays
    .filter(h => h.type === 'public' || h.type === 'bank' || h.type === 'optional')
    .map(h => {
      // date-holidays returns date as string "YYYY-MM-DD HH:MM:SS" or start as Date object
      let dateStr: string;
      if (typeof h.date === 'string') {
        dateStr = h.date.split(' ')[0]; // Extract YYYY-MM-DD from "YYYY-MM-DD HH:MM:SS"
      } else if (h.start instanceof Date) {
        const d = h.start;
        const yyyy = d.getFullYear();
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        const dd = String(d.getDate()).padStart(2, '0');
        dateStr = `${yyyy}-${mm}-${dd}`;
      } else {
        // Fallback: try to parse as date string
        const d = new Date(h.date || h.start);
        const yyyy = d.getFullYear();
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        const dd = String(d.getDate()).padStart(2, '0');
        dateStr = `${yyyy}-${mm}-${dd}`;
      }
      return dateStr;
    });

  // Merge with static holidays (for special proclamations not in the package)
  const staticHolidays = PH_HOLIDAYS_PROCLAIMED[year] || [];
  const mergedHolidays = [...new Set([...holidayDates, ...staticHolidays])].sort();

  // Cache the result
  holidayCache.set(year, mergedHolidays);

  return mergedHolidays;
}

/**
 * Check if a date string (YYYY-MM-DD) is a Philippine holiday
 * Uses date-holidays package for dynamic detection
 * @param dateStr Date string in YYYY-MM-DD format
 * @returns true if the date is a holiday
 */
export function isPhilippineHoliday(dateStr: string): boolean {
  const year = parseInt(dateStr.substring(0, 4), 10);
  const holidays = getHolidaysForYear(year);
  return holidays.includes(dateStr);
}

/**
 * Get holiday details for a specific date
 * @param dateStr Date string in YYYY-MM-DD format
 * @returns Holiday object with name and type, or null if not a holiday
 */
export function getHolidayDetails(dateStr: string): { name: string; type: string } | null {
  const date = new Date(dateStr);
  const holidays = phHolidays.isHoliday(date);

  if (holidays && holidays.length > 0) {
    // Return the first matching holiday
    return {
      name: holidays[0].name,
      type: holidays[0].type
    };
  }

  return null;
}

// Legacy export - dynamically generates for backward compatibility
export const PH_HOLIDAYS_2025 = getHolidaysForYear(2025);

// Static fallback holidays (comprehensive list if date-holidays package fails)
// These are manually maintained as a backup
export const PH_HOLIDAYS_STATIC: Record<number, string[]> = {
  2024: [
    '2024-01-01', '2024-02-10', '2024-02-25', '2024-03-28', '2024-03-29',
    '2024-03-30', '2024-04-09', '2024-04-10', '2024-05-01', '2024-06-12',
    '2024-06-17', '2024-08-21', '2024-08-26', '2024-11-01', '2024-11-02',
    '2024-11-30', '2024-12-08', '2024-12-24', '2024-12-25', '2024-12-30', '2024-12-31'
  ],
  2025: [
    '2025-01-01', '2025-01-29', '2025-02-25', '2025-04-01', '2025-04-09',
    '2025-04-17', '2025-04-18', '2025-04-19', '2025-05-01', '2025-05-12',
    '2025-06-06', '2025-06-12', '2025-08-21', '2025-08-25', '2025-11-01',
    '2025-11-02', '2025-11-30', '2025-12-08', '2025-12-24', '2025-12-25',
    '2025-12-30', '2025-12-31'
  ],
  2026: [
    '2026-01-01', '2026-02-17', '2026-02-25', '2026-03-20', '2026-04-02',
    '2026-04-03', '2026-04-04', '2026-04-09', '2026-05-01', '2026-05-27',
    '2026-06-12', '2026-08-21', '2026-08-31', '2026-11-01', '2026-11-02',
    '2026-11-30', '2026-12-08', '2026-12-24', '2026-12-25', '2026-12-30', '2026-12-31'
  ],
};

// Train/test split ratio
export const DEFAULT_TRAIN_SPLIT = 0.8;

// Date format for parsing demand CSV
export const DEMAND_DATE_FORMAT = 'M/d/yyyy HH:mm';

// Date format for parsing weather CSV
export const WEATHER_DATE_FORMAT = "yyyy-MM-dd'T'HH:mm:ss";

// Zonal configuration loader
let _zonalConfig: ZonalConfig | null = null;

export function loadZonalConfig(): ZonalConfig {
  if (_zonalConfig) return _zonalConfig;

  // Try multiple paths to find zones.json
  const possiblePaths = [
    join(process.cwd(), 'src', 'data', 'zones.json'),
    join(process.cwd(), 'dist', 'data', 'zones.json'),
  ];

  for (const p of possiblePaths) {
    try {
      const raw = readFileSync(p, 'utf-8');
      _zonalConfig = JSON.parse(raw) as ZonalConfig;
      return _zonalConfig;
    } catch {
      continue;
    }
  }

  throw new Error('Could not find zones.json configuration file');
}

// Build ZONAL_REGION_MAPPINGS from zones.json
// Maps weather city ID -> { demandColumn (zone code), city name }
export function getZonalRegionMappings(): Record<string, { demandColumn: string; city: string }> {
  const config = loadZonalConfig();
  const mappings: Record<string, { demandColumn: string; city: string }> = {};

  for (const zone of config.zones) {
    for (const city of zone.cities) {
      mappings[city.id] = { demandColumn: zone.code, city: city.name };
    }
  }

  return mappings;
}

// Get all zone codes
export function getZoneCodes(): string[] {
  const config = loadZonalConfig();
  return config.zones.map(z => z.code);
}

// Get zone config by code
export function getZoneByCode(code: string): ZoneConfig | undefined {
  const config = loadZonalConfig();
  return config.zones.find(z => z.code === code);
}

// Get all region codes from config
export function getRegionCodes(): string[] {
  const config = loadZonalConfig();
  if (config.regions && config.regions.length > 0) {
    return config.regions.map(r => r.code);
  }
  // Fallback: derive from zones
  const parentRegions = new Set(config.zones.map(z => z.parentRegion));
  const regionMap: Record<string, string> = {
    'luzon': 'CLUZ',
    'visayas': 'CVIS',
    'mindanao': 'CMIN'
  };
  return [...parentRegions].map(p => regionMap[p] || p.toUpperCase());
}

// Get zone-to-parent-region mapping
export function getZoneToRegionMap(): Record<string, string> {
  const config = loadZonalConfig();
  const mapping: Record<string, string> = {};

  // Build parentKey -> regionCode lookup from regions config
  const parentKeyToRegion: Record<string, string> = {};
  if (config.regions) {
    for (const region of config.regions) {
      parentKeyToRegion[region.parentKey] = region.code;
    }
  } else {
    // Fallback for backwards compatibility
    parentKeyToRegion['luzon'] = 'CLUZ';
    parentKeyToRegion['visayas'] = 'CVIS';
    parentKeyToRegion['mindanao'] = 'CMIN';
  }

  // Map each zone code to its parent region code
  for (const zone of config.zones) {
    const regionCode = parentKeyToRegion[zone.parentRegion] || zone.parentRegion.toUpperCase();
    mapping[zone.code] = regionCode;
  }

  return mapping;
}

// Get full zones config for GUI (includes regions array)
export function getZonesConfigForGUI(): {
  zones: Array<{ code: string; name: string; parentRegion: string }>;
  regions: Array<{ code: string; name: string; parentKey: string }>;
  zoneToRegion: Record<string, string>;
} {
  const config = loadZonalConfig();

  const zones = config.zones.map(z => ({
    code: z.code,
    name: z.name,
    parentRegion: z.parentRegion
  }));

  const regions = config.regions || [
    { code: 'CLUZ', name: 'Luzon', parentKey: 'luzon' },
    { code: 'CVIS', name: 'Visayas', parentKey: 'visayas' },
    { code: 'CMIN', name: 'Mindanao', parentKey: 'mindanao' }
  ];

  const zoneToRegion = getZoneToRegionMap();

  return { zones, regions, zoneToRegion };
}

// Zonal feature names - extends base FEATURE_NAMES with 3-city weather
export const ZONAL_WEATHER_FEATURES = [
  // City 1 weather
  'temp_c1', 'dew_c1', 'precip_c1', 'windgust_c1', 'windspeed_c1',
  'cloudcover_c1', 'solarradiation_c1', 'uvindex_c1',
  // City 1 derived
  'relativeHumidity_c1', 'heatIndex_c1', 'CDH_c1',
  // City 2 weather
  'temp_c2', 'dew_c2', 'precip_c2', 'windgust_c2', 'windspeed_c2',
  'cloudcover_c2', 'solarradiation_c2', 'uvindex_c2',
  // City 2 derived
  'relativeHumidity_c2', 'heatIndex_c2', 'CDH_c2',
  // City 3 weather
  'temp_c3', 'dew_c3', 'precip_c3', 'windgust_c3', 'windspeed_c3',
  'cloudcover_c3', 'solarradiation_c3', 'uvindex_c3',
  // City 3 derived
  'relativeHumidity_c3', 'heatIndex_c3', 'CDH_c3',
  // Cross-city features
  'temp_spread', 'temp_avg', 'windspeed_avg', 'cloudcover_avg',
  'precip_max', 'solarradiation_avg'
];
