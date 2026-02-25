import { DateTime } from 'luxon';
import { MergedRecord } from '../utils/dataMerger.js';
import { FeatureVector, TrainingSample, ZonalMergedRecord } from '../types/index.js';
import { BASE_TEMP_CELSIUS, isPhilippineHoliday, FEATURE_NAMES } from '../constants/index.js';

// Calculate relative humidity from temperature and dew point
// Using Magnus formula approximation
export function calculateRelativeHumidity(temp: number, dew: number): number {
  const a = 17.625;
  const b = 243.04;
  const rh = 100 * Math.exp((a * dew) / (b + dew)) / Math.exp((a * temp) / (b + temp));
  return Math.min(100, Math.max(0, rh));
}

// Calculate heat index (feels-like temperature) for tropical climate
// Simplified Rothfusz regression
export function calculateHeatIndex(temp: number, rh: number): number {
  // Only apply if temp >= 27°C (80°F)
  if (temp < 27) return temp;

  const T = temp;
  const R = rh;

  // Rothfusz regression
  let HI = -8.78469475556 +
    1.61139411 * T +
    2.33854883889 * R +
    -0.14611605 * T * R +
    -0.012308094 * T * T +
    -0.0164248277778 * R * R +
    0.002211732 * T * T * R +
    0.00072546 * T * R * R +
    -0.000003582 * T * T * R * R;

  return Math.round(HI * 10) / 10;
}

// Check if a date is a holiday (uses dynamic date-holidays package)
function isHoliday(date: Date): boolean {
  const dt = DateTime.fromJSDate(date);
  const dateStr = dt.toFormat('yyyy-MM-dd');
  return isPhilippineHoliday(dateStr);
}

// Check if hour is daytime (6:00 - 18:00)
function isDaytime(hour: number): boolean {
  return hour >= 6 && hour < 18;
}

// Extract temporal features from datetime
function extractTemporalFeatures(datetime: Date): {
  hour: number;
  dayOfWeek: number;
  isWeekend: number;
  isHolidayFlag: number;
  dayOfMonth: number;
  month: number;
  // Cyclical hour encoding
  hourSin: number;
  hourCos: number;
  // Day-type features
  isWorkday: number;
  isSaturday: number;
  isSunday: number;
  // Hour one-hot encoding (24 features) - lets model learn each hour's profile
  hourBins: number[];
  // Hour-DayType interaction terms (allows different profiles per day type)
  hourWorkday: number;  // hour value when workday, else 0
  hourSaturday: number; // hour value when saturday, else 0
  hourSunday: number;   // hour value when sunday, else 0
} {
  const dt = DateTime.fromJSDate(datetime);
  const hour = dt.hour;
  const dayOfWeek = dt.weekday % 7; // 0=Sunday, 1=Monday, etc. (Luxon: 1=Mon, 7=Sun)
  const isHolidayFlag = isHoliday(datetime) ? 1 : 0;

  // Determine day types
  // IMPORTANT: Holidays are treated as Sundays for demand patterns
  // This means holidays get isSunday=1, isWeekend=1, isWorkday=0
  const isActualSunday = dayOfWeek === 0;
  const isSaturday = (dayOfWeek === 6 && !isHolidayFlag) ? 1 : 0; // Saturday only if not a holiday
  const isSunday = (isActualSunday || isHolidayFlag) ? 1 : 0; // Holidays treated as Sundays
  const isWeekend = (isSunday || isSaturday) ? 1 : 0;
  // Workday = Mon-Fri AND not a holiday (already covered by isSunday including holidays)
  const isWorkday = (!isWeekend && !isHolidayFlag) ? 1 : 0;

  // Cyclical hour encoding (preserves circular nature: hour 23 is close to hour 0)
  const hourRadians = (2 * Math.PI * hour) / 24;
  const hourSin = Math.sin(hourRadians);
  const hourCos = Math.cos(hourRadians);

  // Hour one-hot encoding - creates 24 binary features (hour_0 through hour_23)
  // This allows the model to learn the exact demand pattern for each hour
  const hourBins = Array(24).fill(0);
  hourBins[hour] = 1;

  // Hour-DayType interactions (simple version)
  // These let the model learn different hourly values per day type
  const hourWorkday = hour * isWorkday;
  const hourSaturday = hour * isSaturday;
  const hourSunday = hour * isSunday;

  return {
    hour,
    dayOfWeek,
    isWeekend,
    isHolidayFlag,
    dayOfMonth: dt.day,
    month: dt.month,
    hourSin,
    hourCos,
    isWorkday,
    isSaturday,
    isSunday,
    hourBins,
    hourWorkday,
    hourSaturday,
    hourSunday
  };
}

// Calculate derived weather features
function calculateDerivedWeather(
  temp: number,
  dew: number,
  cloudcover: number,
  solarradiation: number,
  precip: number,
  windspeed: number,
  hour: number
): {
  relativeHumidity: number;
  heatIndex: number;
  CDH: number;
  effectiveSolar: number;
  apparentTemp: number;
  isRaining: number;
  tempDewSpread: number;
  isDaytimeFlag: number;
} {
  const relativeHumidity = calculateRelativeHumidity(temp, dew);
  const heatIndex = calculateHeatIndex(temp, relativeHumidity);
  const CDH = Math.max(0, temp - BASE_TEMP_CELSIUS);
  const effectiveSolar = solarradiation * (1 - cloudcover / 100);
  const apparentTemp = temp - (windspeed * 0.05); // Simplified wind chill

  return {
    relativeHumidity,
    heatIndex,
    CDH,
    effectiveSolar,
    apparentTemp,
    isRaining: precip > 0.1 ? 1 : 0,
    tempDewSpread: temp - dew,
    isDaytimeFlag: isDaytime(hour) ? 1 : 0
  };
}

// Build feature vector from merged record
export function buildFeatureVector(
  record: MergedRecord,
  lagData?: {
    demandLag1h?: number;
    demandLag24h?: number;
    demandLag168h?: number;
    tempLag1h?: number;
    tempLag24h?: number;
    demandRolling24h?: number;
    tempRolling24h?: number;
    tempMax24h?: number;
  }
): FeatureVector {
  const temporal = extractTemporalFeatures(record.datetime);
  const derived = calculateDerivedWeather(
    record.weather.temp,
    record.weather.dew,
    record.weather.cloudcover,
    record.weather.solarradiation,
    record.weather.precip,
    record.weather.windspeed,
    temporal.hour
  );

  return {
    // Basic temporal
    hour: temporal.hour,
    dayOfWeek: temporal.dayOfWeek,
    isWeekend: temporal.isWeekend,
    isHoliday: temporal.isHolidayFlag,
    dayOfMonth: temporal.dayOfMonth,
    month: temporal.month,

    // Cyclical hour encoding
    hourSin: temporal.hourSin,
    hourCos: temporal.hourCos,

    // Day type one-hot
    isWorkday: temporal.isWorkday,
    isSaturday: temporal.isSaturday,
    isSunday: temporal.isSunday,

    // Hour one-hot encoding (24 features)
    hour_0: temporal.hourBins[0],
    hour_1: temporal.hourBins[1],
    hour_2: temporal.hourBins[2],
    hour_3: temporal.hourBins[3],
    hour_4: temporal.hourBins[4],
    hour_5: temporal.hourBins[5],
    hour_6: temporal.hourBins[6],
    hour_7: temporal.hourBins[7],
    hour_8: temporal.hourBins[8],
    hour_9: temporal.hourBins[9],
    hour_10: temporal.hourBins[10],
    hour_11: temporal.hourBins[11],
    hour_12: temporal.hourBins[12],
    hour_13: temporal.hourBins[13],
    hour_14: temporal.hourBins[14],
    hour_15: temporal.hourBins[15],
    hour_16: temporal.hourBins[16],
    hour_17: temporal.hourBins[17],
    hour_18: temporal.hourBins[18],
    hour_19: temporal.hourBins[19],
    hour_20: temporal.hourBins[20],
    hour_21: temporal.hourBins[21],
    hour_22: temporal.hourBins[22],
    hour_23: temporal.hourBins[23],

    // Hour-DayType interactions
    hourWorkday: temporal.hourWorkday,
    hourSaturday: temporal.hourSaturday,
    hourSunday: temporal.hourSunday,

    // Raw weather
    temp: record.weather.temp,
    tempSquared: record.weather.temp * record.weather.temp,
    dew: record.weather.dew,
    precip: record.weather.precip,
    windgust: record.weather.windgust,
    windspeed: record.weather.windspeed,
    cloudcover: record.weather.cloudcover,
    solarradiation: record.weather.solarradiation,
    uvindex: record.weather.uvindex,

    // Derived weather
    relativeHumidity: derived.relativeHumidity,
    heatIndex: derived.heatIndex,
    CDH: derived.CDH,
    effectiveSolar: derived.effectiveSolar,
    apparentTemp: derived.apparentTemp,
    isRaining: derived.isRaining,
    tempDewSpread: derived.tempDewSpread,
    isDaytime: derived.isDaytimeFlag,

    // Lag features
    demandLag1h: lagData?.demandLag1h,
    demandLag24h: lagData?.demandLag24h,
    demandLag168h: lagData?.demandLag168h,
    tempLag1h: lagData?.tempLag1h,
    tempLag24h: lagData?.tempLag24h,

    // Rolling averages
    demandRolling24h: lagData?.demandRolling24h,
    tempRolling24h: lagData?.tempRolling24h,
    tempMax24h: lagData?.tempMax24h
  };
}

// Process all merged records into training samples with lag features
export function buildTrainingSamples(
  records: MergedRecord[],
  includePartialLags: boolean = false
): TrainingSample[] {
  const samples: TrainingSample[] = [];

  // Group records by region
  const byRegion = new Map<string, MergedRecord[]>();
  for (const record of records) {
    if (!byRegion.has(record.region)) {
      byRegion.set(record.region, []);
    }
    byRegion.get(record.region)!.push(record);
  }

  // Process each region separately for lag calculations
  for (const [region, regionRecords] of byRegion) {
    // Sort by datetime
    regionRecords.sort((a, b) => a.datetime.getTime() - b.datetime.getTime());

    // Build index for quick lookup
    const demandByTime = new Map<number, number>();
    const tempByTime = new Map<number, number>();

    for (const record of regionRecords) {
      const ts = record.datetime.getTime();
      demandByTime.set(ts, record.demand);
      tempByTime.set(ts, record.weather.temp);
    }

    // Process each record
    for (let i = 0; i < regionRecords.length; i++) {
      const record = regionRecords[i];
      const ts = record.datetime.getTime();

      // Calculate lag values
      const lag1h = ts - 1 * 60 * 60 * 1000;
      const lag24h = ts - 24 * 60 * 60 * 1000;
      const lag168h = ts - 168 * 60 * 60 * 1000; // 7 days

      const demandLag1h = demandByTime.get(lag1h);
      const demandLag24h = demandByTime.get(lag24h);
      const demandLag168h = demandByTime.get(lag168h);
      const tempLag1h = tempByTime.get(lag1h);
      const tempLag24h = tempByTime.get(lag24h);

      // Calculate rolling averages (last 24 hours)
      let demandSum = 0, tempSum = 0, tempMax = -Infinity, count = 0;
      for (let h = 1; h <= 24; h++) {
        const lagTs = ts - h * 60 * 60 * 1000;
        const d = demandByTime.get(lagTs);
        const t = tempByTime.get(lagTs);
        if (d !== undefined && t !== undefined) {
          demandSum += d;
          tempSum += t;
          tempMax = Math.max(tempMax, t);
          count++;
        }
      }

      const demandRolling24h = count > 0 ? demandSum / count : undefined;
      const tempRolling24h = count > 0 ? tempSum / count : undefined;
      const tempMax24h = count > 0 ? tempMax : undefined;

      // Skip if missing required lag data (unless includePartialLags)
      if (!includePartialLags && (demandLag24h === undefined || demandLag168h === undefined)) {
        continue;
      }

      const features = buildFeatureVector(record, {
        demandLag1h,
        demandLag24h,
        demandLag168h,
        tempLag1h,
        tempLag24h,
        demandRolling24h,
        tempRolling24h,
        tempMax24h
      });

      samples.push({
        datetime: record.datetime,
        region,
        demand: record.demand,
        features
      });
    }
  }

  // Sort all samples by datetime
  samples.sort((a, b) => a.datetime.getTime() - b.datetime.getTime());

  return samples;
}

// Convert feature vector to array (for ML models)
export function featureVectorToArray(fv: FeatureVector): number[] {
  return FEATURE_NAMES.map(name => {
    const value = fv[name as keyof FeatureVector];
    return typeof value === 'number' ? value : 0; // Replace undefined with 0
  });
}

// Get feature names (for model interpretation)
export function getFeatureNames(): string[] {
  return [...FEATURE_NAMES];
}

/**
 * Extract features from a zonal merged record (demand + 3-city weather).
 * Generates temporal features (same as base) + 3x weather features + cross-city features.
 */
export function extractZonalFeatures(record: ZonalMergedRecord): Record<string, number> {
  const features: Record<string, number> = {};
  const dt = record.datetime instanceof Date ? record.datetime : new Date(record.datetime);

  // === Temporal features (same as base) ===
  const hour = dt.getHours();
  const dayOfWeek = dt.getDay();
  const month = dt.getMonth() + 1;
  const dayOfMonth = dt.getDate();

  features['hour'] = hour;
  features['dayOfWeek'] = dayOfWeek;
  features['isWeekend'] = (dayOfWeek === 0 || dayOfWeek === 6) ? 1 : 0;
  features['isHoliday'] = 0; // Will be set externally if needed
  features['dayOfMonth'] = dayOfMonth;
  features['month'] = month;

  // Cyclical encoding
  features['hourSin'] = Math.sin(2 * Math.PI * hour / 24);
  features['hourCos'] = Math.cos(2 * Math.PI * hour / 24);
  features['daySin'] = Math.sin(2 * Math.PI * dayOfWeek / 7);
  features['dayCos'] = Math.cos(2 * Math.PI * dayOfWeek / 7);
  features['monthSin'] = Math.sin(2 * Math.PI * month / 12);
  features['monthCos'] = Math.cos(2 * Math.PI * month / 12);

  // Day type
  features['isWorkday'] = (dayOfWeek >= 1 && dayOfWeek <= 5) ? 1 : 0;
  features['isSaturday'] = dayOfWeek === 6 ? 1 : 0;
  features['isSunday'] = dayOfWeek === 0 ? 1 : 0;

  // Hour one-hot
  for (let h = 0; h < 24; h++) {
    features[`hour_${h}`] = hour === h ? 1 : 0;
  }

  // Hour interactions
  features['hourWorkday'] = hour * features['isWorkday'];
  features['hourSaturday'] = hour * features['isSaturday'];
  features['hourSunday'] = hour * features['isSunday'];

  // === Per-city weather features (up to 6 sets for 01NLUZ, 3 for others) ===
  // Build city array - include optional cities 4-6 if they exist
  const cities: (typeof record.weather.city1 | undefined)[] = [
    record.weather.city1,
    record.weather.city2,
    record.weather.city3,
    record.weather.city4,  // Optional: only 01NLUZ
    record.weather.city5,  // Optional: only 01NLUZ
    record.weather.city6   // Optional: only 01NLUZ
  ];
  const suffixes = ['_c1', '_c2', '_c3', '_c4', '_c5', '_c6'];

  // Track which cities exist for averaging
  const cityCount = cities.filter(c => c !== undefined).length;

  for (let i = 0; i < 6; i++) {
    const w = cities[i];
    const s = suffixes[i];

    // For missing cities (4-6 for non-NLUZ zones), use 0 values
    // The ML model will learn to ignore these zeros
    const temp = w?.temp || 0;
    const dew = w?.dew || 0;
    const precip = w?.precip || 0;
    const windgust = w?.windgust || 0;
    const windspeed = w?.windspeed || 0;
    const cloudcover = w?.cloudcover || 0;
    const solarradiation = w?.solarradiation || 0;
    const uvindex = w?.uvindex || 0;

    // Raw weather
    features[`temp${s}`] = temp;
    features[`dew${s}`] = dew;
    features[`precip${s}`] = precip;
    features[`windgust${s}`] = windgust;
    features[`windspeed${s}`] = windspeed;
    features[`cloudcover${s}`] = cloudcover;
    features[`solarradiation${s}`] = solarradiation;
    features[`uvindex${s}`] = uvindex;

    // Derived: Relative Humidity (Magnus formula)
    if (w) {
      const RH_NUM = Math.exp((17.27 * dew) / (237.3 + dew));
      const RH_DEN = Math.exp((17.27 * temp) / (237.3 + temp));
      features[`relativeHumidity${s}`] = RH_DEN > 0 ? 100 * (RH_NUM / RH_DEN) : 50;

      // Derived: Heat Index (Rothfusz simplified)
      const rh = features[`relativeHumidity${s}`];
      if (temp >= 27) {
        const HI = -8.78469476 + 1.61139411 * temp + 2.33854884 * rh
          - 0.14611605 * temp * rh - 0.012308094 * temp * temp
          - 0.0164248278 * rh * rh + 0.002211732 * temp * temp * rh
          + 0.00072546 * temp * rh * rh - 0.000003582 * temp * temp * rh * rh;
        features[`heatIndex${s}`] = HI;
      } else {
        features[`heatIndex${s}`] = temp;
      }

      // Derived: Cooling Degree Hours (base 24C for tropical Philippines)
      features[`CDH${s}`] = Math.max(0, temp - 24);
    } else {
      // Missing city: use 0 for derived features
      features[`relativeHumidity${s}`] = 0;
      features[`heatIndex${s}`] = 0;
      features[`CDH${s}`] = 0;
    }
  }

  // Indicator for whether zone has 6 cities (helps model distinguish 01NLUZ)
  features['has_6_cities'] = cityCount > 3 ? 1 : 0;

  // === Cross-city features (using all available cities) ===
  const temps: number[] = [];
  const winds: number[] = [];
  const clouds: number[] = [];
  const precips: number[] = [];
  const solars: number[] = [];

  for (let i = 0; i < cityCount; i++) {
    temps.push(features[`temp_c${i + 1}`]);
    winds.push(features[`windspeed_c${i + 1}`]);
    clouds.push(features[`cloudcover_c${i + 1}`]);
    precips.push(features[`precip_c${i + 1}`]);
    solars.push(features[`solarradiation_c${i + 1}`]);
  }

  features['temp_spread'] = Math.max(...temps) - Math.min(...temps);
  features['temp_avg'] = temps.reduce((a, b) => a + b, 0) / cityCount;
  features['windspeed_avg'] = winds.reduce((a, b) => a + b, 0) / cityCount;
  features['cloudcover_avg'] = clouds.reduce((a, b) => a + b, 0) / cityCount;
  features['precip_max'] = Math.max(...precips);
  features['solarradiation_avg'] = solars.reduce((a, b) => a + b, 0) / cityCount;

  return features;
}
