// Station type classification
export enum StationType {
  WIND = 'wind',
  SOLAR = 'solar',
  HYDRO_RUN_OF_RIVER = 'hydro_ror',
  HYDRO_STORAGE = 'hydro_storage',
  GEOTHERMAL = 'geothermal',
  BIOMASS = 'biomass',
  BATTERY = 'battery',
  UNKNOWN = 'unknown'
}

// Station metadata from stations.json
export interface StationMetadata {
  name: string;
  type: StationType;
  operator?: string;
  capacity_mw?: number;
  location: {
    municipality: string;
    province: string;
    region: string;
    latitude: number;
    longitude: number;
  };
  grid: string; // CLUZ, CVIS, CMIN
  commissioned?: number;
}

// Raw capacity factor data from CSV
export interface RawCapacityFactorData {
  datetime: Date;
  stationCode: string;
  capacityFactor: number; // 0.0 to 1.0
}

// Weather features for capacity factor prediction
export interface CFacWeatherFeatures {
  // Wind features (10m standard height)
  windSpeed: number;
  windGust: number;
  windDirection?: number;

  // Wind features at multiple heights for wind farm forecasting
  windSpeed50?: number;     // Wind speed at 50m height
  windDirection50?: number; // Wind direction at 50m height
  windSpeed80?: number;     // Wind speed at 80m height
  windDirection80?: number; // Wind direction at 80m height
  windSpeed100?: number;    // Wind speed at 100m height (hub height)
  windDirection100?: number; // Wind direction at 100m height

  // Solar features
  solarRadiation: number;
  cloudCover: number;

  // Common
  temperature: number;
  humidity?: number;
  precipitation?: number;

  // Derived
  airDensity?: number; // for wind power adjustment

  // Premium weather features (Visual Crossing corporate account)
  // These improve solar forecasting accuracy by ~30%
  uvIndex?: number;         // UV index: 0-11+ (clear-sky indicator, r=0.78 with solar CF)
  visibility?: number;      // Visibility in km (haze/aerosol indicator, r=0.31 with solar CF)
  conditions?: string;      // Sky conditions text: "Clear", "Overcast", "Rain", etc.
  pressure?: number;        // Sea level pressure in hPa
  precipProb?: number;      // Precipitation probability 0-100%
}

// Training sample for capacity factor models
export interface CFacTrainingSample {
  datetime: Date;
  stationCode: string;
  stationType: StationType;
  actualCFac: number;
  weather: CFacWeatherFeatures;

  // Temporal features
  hour: number;
  dayOfWeek: number;
  month: number;
  isWeekend: boolean;

  // Lag features
  cfacLag1h?: number;
  cfacLag24h?: number;

  // Recency weight for training (exponential decay)
  // Recent data gets higher weight (1.0 = most recent, decays to ~0.1 for oldest)
  weight?: number;
}

// Profile statistics for non-weather-dependent stations
export interface CFacProfileStats {
  min: number;      // P5
  median: number;   // P50
  max: number;      // P95
  mean: number;
  stdDev: number;
  count: number;
}

// Capacity factor forecast result
export interface CFacForecastResult {
  datetime: Date;
  stationCode: string;
  predictedCFac: number;
  confidence?: {
    lower: number;
    upper: number;
  };
  modelType: string;
}

// Model metrics
export interface CFacModelMetrics {
  stationCode: string;
  stationType: StationType;
  mape: number;
  rmse: number;
  mae: number;
  r2Score: number;
  sampleCount: number;
}

/**
 * MREC (Must-Run Energy Conversion) Factors
 * Based on iPool's three-tier piecewise linear conversion system
 *
 * The system uses Probability of Exceedance (PoE) to segment wind conditions:
 * - HIGH tier: Top 10% wind conditions (PoE = 0.1)
 * - MID tier: 10%-30% wind conditions
 * - LOW tier: Below 30% (most common conditions)
 *
 * Each tier has a conversion factor: CF = MRec * WindSpeed
 */
export interface MRECFactors {
  stationCode: string;
  stationType: StationType;

  // Three-tier conversion factors (CF = MRec * WindSpeed)
  MRecH: number;   // High wind conversion factor
  MRecM: number;   // Mid wind conversion factor
  MRecL: number;   // Low wind conversion factor

  // Wind speed thresholds (m/s)
  vH: number;      // Threshold for HIGH tier (wind >= vH)
  vL: number;      // Threshold for MID tier (vH > wind >= vL), below is LOW

  // Calibration metadata
  calibrated: boolean;
  calibrationDate?: Date;
  sampleCount?: number;

  // Statistics from calibration
  stats?: {
    CFacH: number;    // Average CF in HIGH tier
    CFacM: number;    // Average CF in MID tier
    CFacL: number;    // Average CF in LOW tier
    ValH: number;     // Average wind speed in HIGH tier
    ValM: number;     // Average wind speed in MID tier
    ValL: number;     // Average wind speed in LOW tier
    maxWind: number;  // Maximum observed wind speed
    minWind: number;  // Minimum observed wind speed
  };
}

/**
 * MREC Calibration input data
 * Requires paired historical capacity factors and wind speeds
 */
export interface MRECCalibrationData {
  datetime: Date;
  stationCode: string;
  capacityFactor: number;  // 0.0 to 1.0
  windSpeed: number;       // m/s (preferably hub-height)
}

/**
 * PoE (Probability of Exceedance) constants
 * Matches iPool's ConstDefinitions.cpp values
 */
export const MREC_POE_CONSTANTS = {
  PoEH: 0.1,   // Top 10% for HIGH tier
  PoEL: 0.3,   // Top 30% for MID tier cutoff
  PoEHs: 0.1,  // Solar HIGH tier (same as wind)
  PoELs: 0.3,  // Solar LOW tier (same as wind)
} as const;

/**
 * Wind capacity factor methodology options
 */
export enum WindCFacMethodology {
  MREC = 'mrec',           // iPool-style three-tier piecewise
  HYBRID = 'hybrid',       // Physics + ML residual learning
  POWER_CURVE = 'power_curve',  // Pure physics power curve
}

// Known hydro run-of-river station names (partial matching)
const KNOWN_HYDRO_ROR_STATIONS = [
  'BAKUN',
  'LATRINI',
  'PANTABA',
  'AGUS',
  'PULANGI',
  'MAGAT',
  'ANGAT',
  'AMBUKLAO',
  'BINGA',
  'SAN_ROQUE',
  'CALIRAYA',
  'BOTOCAN',
  'MASIWAY',
  'NAGSIGIT'
];

/**
 * Explicit station type mapping from MNM Genlist
 * Maps station codes that don't follow standard naming conventions
 * Source: WESM MNM_Genlist (Market Network Model Generator List)
 */
const STATION_TYPE_MAPPING: Record<string, StationType> = {
  // Wind stations (without _W suffix)
  '01BURGOS': StationType.WIND,
  '01LAOAG': StationType.WIND,
  '01PAGUDPUD': StationType.WIND,
  '02DOLORES': StationType.WIND,     // Dolores Wind Farm (units: 02MMPP_G01, 03AWOC_G01)
  '02MMPP_G01': StationType.WIND,    // MM Pililla Wind unit (parent: 02DOLORES)
  '03AWOC_G01': StationType.WIND,    // AWOC Wind unit (parent: 02DOLORES)
  '08PWIND_G01': StationType.WIND,   // Pililla Wind unit (parent: 08NABAS_W)
  '08WIND_G02': StationType.WIND,    // Wind Farm unit (parent: 08NABAS_W)
  '08BVISTA': StationType.WIND,      // San Lorenzo Wind Farm, Guimaras (08SLWIND_G01)

  // Solar stations (without _S suffix) - additional
  '01CURIMAO': StationType.SOLAR,    // Curimao Solar, Ilocos Norte
  '01PASUQUIN': StationType.SOLAR,   // Pasuquin Solar, Ilocos Norte
  '01BOTOLAN': StationType.SOLAR,    // Botolan Solar, Zambales

  // Solar stations (without _S suffix)
  '01CASTILEHV': StationType.SOLAR,  // Castillejos Solar (HV) - Zambales
  '01CAYANGA': StationType.SOLAR,
  '01CLARK': StationType.SOLAR,
  // '01HERMOSA': StationType.SOLAR, // REMOVED - 01HERMOSA is hydro, 01HERMOSA_S is solar
  '01LIMAY': StationType.SOLAR,
  '01SNMARCELINO': StationType.SOLAR,
  '01SNRAFAEL': StationType.SOLAR,
  // '01SNTGO': StationType.SOLAR, // REMOVED - 01SNTGO is hydro, 01SNTGO_S is solar
  '03CALAMBA': StationType.SOLAR,
  '03CALACA': StationType.SOLAR,   // Calaca Solar Power Plant (not coal)
  // '03CLACA': StationType.SOLAR,  // REMOVED - this is aggregated coal+solar+battery, use 03CLACA_S for solar
  '03DASMAEHV': StationType.SOLAR,
  '05CALUNG': StationType.SOLAR,
  '06HELIOS': StationType.SOLAR,
  '11KIBAW': StationType.SOLAR,

  // Biomass stations (non-standard naming)
  '01HERMOSA': StationType.BIOMASS,  // Hermosa Biomass (01HERMOSA_S is the solar)

  // Hydro stations (without _H suffix) - run-of-river
  '01BYOMBNG': StationType.HYDRO_RUN_OF_RIVER,
  '01SNTGO': StationType.HYDRO_RUN_OF_RIVER,    // Santiago Hydro (01SNTGO_S is the solar)
  '03CALAUAN': StationType.HYDRO_RUN_OF_RIVER,
  '03LABO': StationType.HYDRO_RUN_OF_RIVER,
  '03NAGA': StationType.HYDRO_RUN_OF_RIVER,
  '04PARANAS': StationType.HYDRO_RUN_OF_RIVER,
  '06AMLAN': StationType.HYDRO_RUN_OF_RIVER,
  '11JASAA': StationType.HYDRO_RUN_OF_RIVER,
  '11MANOL': StationType.HYDRO_RUN_OF_RIVER,
  '12BUTUA': StationType.HYDRO_RUN_OF_RIVER,
  '13DAVAO': StationType.HYDRO_RUN_OF_RIVER,
  '13NABUN': StationType.HYDRO_RUN_OF_RIVER,
  '14SULTA': StationType.HYDRO_RUN_OF_RIVER,

  // Geothermal stations
  '03BACMANGP': StationType.GEOTHERMAL,
  '03TIWI-C': StationType.GEOTHERMAL,
  '04TONGONA': StationType.GEOTHERMAL,
  '06PGPP1': StationType.GEOTHERMAL,
  '06PGPP2': StationType.GEOTHERMAL,

  // Biomass stations (without _BI suffix)
  '01DUHAT': StationType.BIOMASS,
  '01GAMU': StationType.BIOMASS,
  '06CADIZ': StationType.BIOMASS,
  '06KABANKALAN': StationType.BIOMASS,
  '06MABINAY': StationType.BIOMASS,

  // Battery stations (without _B suffix)
  '03LUMBAN': StationType.BATTERY,
  '03PALAYAN': StationType.BATTERY,

  // Additional solar stations with non-standard naming
  '01MEXICO_S_A': StationType.SOLAR,  // Mexico Solar - section A
  '01MEXICO_S_R': StationType.SOLAR,  // Mexico Solar - section R
  '01SJSOLAR': StationType.SOLAR,     // San Jose Solar
  '02QUEZON_S_E': StationType.SOLAR,  // Quezon Solar - E
  '02QUEZON_S_V': StationType.SOLAR,  // Quezon Solar - V
  '06CALASOL': StationType.SOLAR,     // Calatrava Solar

  // Additional biomass stations
  '01GAMU_BG': StationType.BIOMASS,   // Gamu Biogas
  '01GAMU_BL': StationType.BIOMASS,   // Gamu Biomass

  // Additional hydro stations
  '14SIGHYDRO': StationType.HYDRO_RUN_OF_RIVER,  // Siguil Hydro

  // SBMA Solar
  '01SBMA': StationType.SOLAR,        // Subic Bay Solar

  // Metro Manila Solar
  '02DONAIMELDA': StationType.SOLAR,  // Doña Imelda Solar (likely rooftop)

  // Laguna Battery stations
  '03LUMBAN_BL': StationType.BATTERY, // Lumban Battery Large
  '03STAROSA': StationType.SOLAR,     // Santa Rosa Solar

  // Visayas stations
  '04CENTRAL': StationType.HYDRO_RUN_OF_RIVER, // Central Visayas Hydro
  '07CORELLA': StationType.HYDRO_RUN_OF_RIVER, // Corella Hydro (Bohol)

  // Dispatchable/unknown stations (excluded from must-run forecasting)
  // Note: 03CALACA is now mapped to SOLAR above (Calaca Solar Power Plant)
  '03CLACA': StationType.UNKNOWN,     // Calaca Coal (dispatchable) - 03CLACA_S is the solar
  '10GNPK': StationType.UNKNOWN,      // GNPower Kauswagan Coal (dispatchable)
};

/**
 * Determines station type from station code based on naming conventions
 * @param stationCode - The station code to analyze
 * @returns The determined StationType
 */
export function getStationTypeFromCode(stationCode: string): StationType {
  const code = stationCode.toUpperCase();

  // Check explicit mapping first (highest priority)
  if (STATION_TYPE_MAPPING[code]) {
    return STATION_TYPE_MAPPING[code];
  }

  // Check suffixes (most specific patterns)
  if (code.endsWith('_W')) {
    return StationType.WIND;
  }

  if (code.endsWith('_S')) {
    return StationType.SOLAR;
  }

  if (code.endsWith('_H')) {
    return StationType.HYDRO_STORAGE;
  }

  if (code.endsWith('_BI')) {
    return StationType.BIOMASS;
  }

  if (code.endsWith('_B')) {
    return StationType.BATTERY;
  }

  if (code.endsWith('_G') || code.endsWith('_GP')) {
    return StationType.GEOTHERMAL;
  }

  // Check for known hydro run-of-river stations
  for (const hydroName of KNOWN_HYDRO_ROR_STATIONS) {
    if (code.includes(hydroName)) {
      return StationType.HYDRO_RUN_OF_RIVER;
    }
  }

  // Default to unknown
  return StationType.UNKNOWN;
}
