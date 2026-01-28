import Holidays from 'date-holidays';

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
