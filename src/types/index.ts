// Export capacity factor types
export * from './capacityFactor.js';

// Export outage types
export * from './outage.js';

// Export interconnector types
export * from './interconnector.js';

// Weather data from CSV (raw hourly)
export interface RawWeatherData {
  name: string;
  latitude: number;
  longitude: number;
  datetime: string;
  temp: number;
  dew: number;
  precip: number;
  humidity?: number;
  windgust: number;
  windspeed: number;
  winddir?: number;
  cloudcover: number;
  solarradiation: number;
  solarenergy: number;
  uvindex: number;
}

// Extended weather data for capacity factor forecasting
// Includes hub-height wind data and extended solar irradiance
export interface ClusterWeatherRecord {
  locationId: string;
  datetime: string;

  // Basic weather
  temp?: number;
  dew?: number;
  humidity?: number;
  precip?: number;
  precipprob?: number;
  pressure?: number;

  // Wind (10m standard)
  windgust?: number;
  windspeed?: number;
  winddir?: number;

  // Wind hub-height (50m, 80m, 100m)
  windspeed50?: number;
  winddir50?: number;
  windspeed80?: number;
  winddir80?: number;
  windspeed100?: number;
  winddir100?: number;

  // Solar/sky
  cloudcover?: number;
  visibility?: number;
  solarradiation?: number;
  solarenergy?: number;
  uvindex?: number;

  // Extended solar irradiance (W/m²)
  dniradiation?: number;
  difradiation?: number;
  ghiradiation?: number;

  // Conditions
  conditions?: string;

  // Metadata (for forecast records)
  fetchedAt?: string;
  isForecast?: boolean;
}

// Demand data from CSV (hourly)
export interface RawDemandData {
  dateTimeEnding: string;
  demands: Map<string, number>;  // region -> demand value
}

// Processed weather with derived features
export interface ProcessedWeather {
  datetime: Date;
  region: string;
  // Raw
  temp: number;
  dew: number;
  precip: number;
  windgust: number;
  windspeed: number;
  cloudcover: number;
  solarradiation: number;
  solarenergy: number;
  uvindex: number;
  // Derived
  relativeHumidity: number;
  heatIndex: number;
  CDH: number;  // Cooling Degree Hours
  effectiveSolar: number;
  apparentTemp: number;
  isRaining: boolean;
  tempDewSpread: number;
  isDaytime: boolean;
}

// Combined sample for training/prediction
export interface TrainingSample {
  datetime: Date;
  region: string;
  demand: number;
  features: FeatureVector;
}

// Feature vector for ML models
export interface FeatureVector {
  // Basic temporal
  hour: number;
  dayOfWeek: number;
  isWeekend: number;  // 0 or 1
  isHoliday: number;  // 0 or 1
  dayOfMonth: number;
  month: number;

  // Cyclical hour encoding (preserves circular nature of hours)
  hourSin: number;  // sin(2*pi*hour/24)
  hourCos: number;  // cos(2*pi*hour/24)

  // Day type one-hot encoding
  isWorkday: number;  // Mon-Fri (non-holiday)
  isSaturday: number;
  isSunday: number;

  // Hour one-hot encoding (24 features) - allows model to learn each hour's profile
  hour_0: number; hour_1: number; hour_2: number; hour_3: number;
  hour_4: number; hour_5: number; hour_6: number; hour_7: number;
  hour_8: number; hour_9: number; hour_10: number; hour_11: number;
  hour_12: number; hour_13: number; hour_14: number; hour_15: number;
  hour_16: number; hour_17: number; hour_18: number; hour_19: number;
  hour_20: number; hour_21: number; hour_22: number; hour_23: number;

  // Hour-DayType interactions (allows different hourly patterns per day type)
  hourWorkday: number;
  hourSaturday: number;
  hourSunday: number;

  // Raw weather
  temp: number;
  tempSquared: number;  // temp^2 for non-linear temperature effects
  dew: number;
  precip: number;
  windgust: number;
  windspeed: number;
  cloudcover: number;
  solarradiation: number;
  uvindex: number;

  // Derived weather
  relativeHumidity: number;
  heatIndex: number;
  CDH: number;
  effectiveSolar: number;
  apparentTemp: number;
  isRaining: number;
  tempDewSpread: number;
  isDaytime: number;

  // Lag features (optional, may be undefined for first samples)
  demandLag1h?: number;
  demandLag24h?: number;
  demandLag168h?: number;
  tempLag1h?: number;
  tempLag24h?: number;

  // Rolling averages
  demandRolling24h?: number;
  tempRolling24h?: number;
  tempMax24h?: number;
}

// Region mapping
export interface RegionMapping {
  weatherFile: string;
  demandColumn: string;
  city: string;
}

// Model training result
export interface ModelResult {
  modelType: 'regression' | 'xgboost';
  r2Score: number;
  mape: number;
  rmse: number;
  mae: number;
  featureImportance?: Map<string, number>;
  trainingSamples: number;
  testingSamples: number;
}

// Forecast output
export interface ForecastResult {
  datetime: Date;
  region: string;
  predictedDemand: number;
  confidenceLow?: number;
  confidenceHigh?: number;
}

// Configuration
export interface ForecastConfig {
  regions: RegionMapping[];
  baseTemp: number;  // For CDH calculation (default 24 for tropics)
  trainTestSplit: number;  // e.g., 0.8 for 80% train
  holidays: string[];  // ISO date strings
}

// Zonal demand forecasting types
export interface ZonalCity {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
}

export interface ZoneConfig {
  code: string;
  name: string;
  parentRegion: string;
  cities: ZonalCity[];
}

export interface ZonalConfig {
  zones: ZoneConfig[];
}

export interface ZonalWeatherLocation {
  id: string;           // e.g., '01nluz_sanfernando'
  name: string;         // City name for Visual Crossing API
  zoneCode: string;     // e.g., '01NLUZ'
  cityIndex: number;    // 0, 1, or 2 (which of the 3 cities)
  latitude: number;
  longitude: number;
}

// Zonal merged record - demand + weather from up to 6 cities
// 01NLUZ has 6 cities (larger region), other zones have 3
export interface ZonalMergedRecord {
  datetime: Date;
  zone: string;
  demand: number;
  weather: {
    city1: RawWeatherData;
    city2: RawWeatherData;
    city3: RawWeatherData;
    city4?: RawWeatherData;  // Optional: only 01NLUZ has cities 4-6
    city5?: RawWeatherData;
    city6?: RawWeatherData;
  };
}
