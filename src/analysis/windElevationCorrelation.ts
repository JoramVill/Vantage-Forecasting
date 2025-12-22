/**
 * Wind Speed Elevation Correlation Analysis
 *
 * Analyzes correlation between wind speeds at different elevations (10m, 50m, 80m, 100m)
 * and actual capacity factors for each wind station.
 */

import { readFileSync, readdirSync } from 'fs';
import { join, basename } from 'path';
import { DateTime } from 'luxon';

interface WindWeatherData {
  datetime: Date;
  windspeed: number;     // 10m
  windspeed50: number;   // 50m
  windspeed80: number;   // 80m
  windspeed100: number;  // 100m
}

interface CapacityFactorData {
  datetime: Date;
  capacityFactor: number;
}

interface CorrelationResult {
  stationCode: string;
  sampleCount: number;
  correlations: {
    windspeed10m: number;
    windspeed50m: number;
    windspeed80m: number;
    windspeed100m: number;
  };
  bestElevation: string;
  avgWindSpeeds: {
    windspeed10m: number;
    windspeed50m: number;
    windspeed80m: number;
    windspeed100m: number;
  };
  avgCapacityFactor: number;
}

// Wind station codes
const WIND_STATIONS = [
  '01BURGOS',
  '01CURIMAO',
  '01LAOAG',
  '01PAGUDPUD',
  '01PASUQUIN',
  '08NABAS_W',
  '08STBARBRA_W'
];

/**
 * Calculate Pearson correlation coefficient
 */
function pearsonCorrelation(x: number[], y: number[]): number {
  const n = x.length;
  if (n !== y.length || n === 0) return 0;

  const sumX = x.reduce((a, b) => a + b, 0);
  const sumY = y.reduce((a, b) => a + b, 0);
  const sumXY = x.reduce((sum, xi, i) => sum + xi * y[i], 0);
  const sumX2 = x.reduce((sum, xi) => sum + xi * xi, 0);
  const sumY2 = y.reduce((sum, yi) => sum + yi * yi, 0);

  const numerator = n * sumXY - sumX * sumY;
  const denominator = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));

  if (denominator === 0) return 0;
  return numerator / denominator;
}

/**
 * Load weather data for a station from per-station cache
 */
function loadStationWeather(stationCode: string, cacheDir: string): Map<string, WindWeatherData> {
  const stationDir = join(cacheDir, `station_${stationCode}`);
  const weatherMap = new Map<string, WindWeatherData>();

  try {
    const months = readdirSync(stationDir).filter(d => d.startsWith('2025-'));

    for (const month of months) {
      const monthDir = join(stationDir, month);
      const files = readdirSync(monthDir).filter(f => f.endsWith('.csv'));

      for (const file of files) {
        const content = readFileSync(join(monthDir, file), 'utf-8');
        const lines = content.split('\n').filter(l => l.trim());

        if (lines.length < 2) continue;

        const headers = lines[0].split(',').map(h => h.trim());
        const windspeedIdx = headers.indexOf('windspeed');
        const windspeed50Idx = headers.indexOf('windspeed50');
        const windspeed80Idx = headers.indexOf('windspeed80');
        const windspeed100Idx = headers.indexOf('windspeed100');
        const datetimeIdx = headers.indexOf('datetime');

        for (let i = 1; i < lines.length; i++) {
          const values = lines[i].split(',').map(v => v.trim());
          if (values.length < headers.length) continue;

          const datetimeStr = values[datetimeIdx];
          // Parse ISO datetime and add 1 hour (weather is hour-starting, cfac is hour-ending)
          const dt = DateTime.fromISO(datetimeStr).plus({ hours: 1 });
          if (!dt.isValid) continue;

          const key = dt.toFormat('yyyy-MM-dd HH:mm');

          weatherMap.set(key, {
            datetime: dt.toJSDate(),
            windspeed: parseFloat(values[windspeedIdx]) || 0,
            windspeed50: parseFloat(values[windspeed50Idx]) || 0,
            windspeed80: parseFloat(values[windspeed80Idx]) || 0,
            windspeed100: parseFloat(values[windspeed100Idx]) || 0
          });
        }
      }
    }
  } catch (err) {
    console.error(`Error loading weather for ${stationCode}:`, err);
  }

  return weatherMap;
}

/**
 * Load capacity factor data from MRHCFac CSV files
 */
function loadCapacityFactors(cfacDir: string): Map<string, Map<string, number>> {
  // Map of stationCode -> (datetime key -> capacity factor)
  const stationData = new Map<string, Map<string, number>>();

  // Initialize maps for each wind station
  for (const station of WIND_STATIONS) {
    stationData.set(station, new Map());
  }

  const files = readdirSync(cfacDir).filter(f => f.toLowerCase().endsWith('.csv'));

  for (const file of files) {
    const content = readFileSync(join(cfacDir, file), 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());

    if (lines.length < 2) continue;

    const headers = lines[0].split(',').map(h => h.trim());
    const stationIndices = new Map<string, number>();

    // Find column indices for wind stations
    for (const station of WIND_STATIONS) {
      const idx = headers.indexOf(station);
      if (idx !== -1) {
        stationIndices.set(station, idx);
      }
    }

    for (let i = 1; i < lines.length; i++) {
      const values = lines[i].split(',').map(v => v.trim());
      if (values.length < 2) continue;

      // Parse datetime: "M/d/yyyy HH:mm"
      const dt = DateTime.fromFormat(values[0], 'M/d/yyyy HH:mm');
      if (!dt.isValid) continue;

      const key = dt.toFormat('yyyy-MM-dd HH:mm');

      for (const [station, idx] of stationIndices) {
        const cfac = parseFloat(values[idx]);
        if (!isNaN(cfac) && cfac >= 0 && cfac <= 1) {
          stationData.get(station)!.set(key, cfac);
        }
      }
    }
  }

  return stationData;
}

/**
 * Analyze correlation for a single station
 */
function analyzeStation(
  stationCode: string,
  weatherData: Map<string, WindWeatherData>,
  cfacData: Map<string, number>
): CorrelationResult | null {

  // Join data by datetime
  const windspeed10m: number[] = [];
  const windspeed50m: number[] = [];
  const windspeed80m: number[] = [];
  const windspeed100m: number[] = [];
  const capacityFactors: number[] = [];

  for (const [key, cfac] of cfacData) {
    const weather = weatherData.get(key);
    if (weather && weather.windspeed > 0) {
      windspeed10m.push(weather.windspeed);
      windspeed50m.push(weather.windspeed50);
      windspeed80m.push(weather.windspeed80);
      windspeed100m.push(weather.windspeed100);
      capacityFactors.push(cfac);
    }
  }

  if (capacityFactors.length < 100) {
    console.log(`  ${stationCode}: Insufficient data (${capacityFactors.length} samples)`);
    return null;
  }

  // Calculate correlations
  const corr10m = pearsonCorrelation(windspeed10m, capacityFactors);
  const corr50m = pearsonCorrelation(windspeed50m, capacityFactors);
  const corr80m = pearsonCorrelation(windspeed80m, capacityFactors);
  const corr100m = pearsonCorrelation(windspeed100m, capacityFactors);

  // Find best elevation
  const correlations = {
    windspeed10m: corr10m,
    windspeed50m: corr50m,
    windspeed80m: corr80m,
    windspeed100m: corr100m
  };

  let bestElevation = 'windspeed10m';
  let maxCorr = Math.abs(corr10m);

  for (const [elev, corr] of Object.entries(correlations)) {
    if (Math.abs(corr) > maxCorr) {
      maxCorr = Math.abs(corr);
      bestElevation = elev;
    }
  }

  // Calculate averages
  const avgWindSpeeds = {
    windspeed10m: windspeed10m.reduce((a, b) => a + b, 0) / windspeed10m.length,
    windspeed50m: windspeed50m.reduce((a, b) => a + b, 0) / windspeed50m.length,
    windspeed80m: windspeed80m.reduce((a, b) => a + b, 0) / windspeed80m.length,
    windspeed100m: windspeed100m.reduce((a, b) => a + b, 0) / windspeed100m.length
  };

  const avgCapacityFactor = capacityFactors.reduce((a, b) => a + b, 0) / capacityFactors.length;

  return {
    stationCode,
    sampleCount: capacityFactors.length,
    correlations,
    bestElevation,
    avgWindSpeeds,
    avgCapacityFactor
  };
}

/**
 * Main analysis function
 */
export async function runWindElevationAnalysis(
  cfacDir?: string,
  weatherCacheDir?: string
): Promise<CorrelationResult[]> {
  const cacheDir = weatherCacheDir || join(process.cwd(), 'weather_cache');
  const capacityFactorDir = cfacDir || join(process.cwd(), 'Data Samples', 'Capacity Factor');

  console.log('\n=== Wind Speed Elevation Correlation Analysis ===\n');
  console.log(`Weather cache: ${cacheDir}`);
  console.log(`Capacity factor data: ${capacityFactorDir}`);

  // Load capacity factor data
  console.log('\nLoading capacity factor data...');
  const cfacData = loadCapacityFactors(capacityFactorDir);

  const results: CorrelationResult[] = [];

  console.log('\nAnalyzing each wind station:\n');

  for (const stationCode of WIND_STATIONS) {
    console.log(`Processing ${stationCode}...`);

    // Load per-station weather data
    const weatherData = loadStationWeather(stationCode, cacheDir);

    if (weatherData.size === 0) {
      console.log(`  No weather data found for ${stationCode}`);
      continue;
    }

    console.log(`  Loaded ${weatherData.size} hourly weather records`);

    const stationCfac = cfacData.get(stationCode);
    if (!stationCfac || stationCfac.size === 0) {
      console.log(`  No capacity factor data found for ${stationCode}`);
      continue;
    }

    console.log(`  Loaded ${stationCfac.size} capacity factor records`);

    const result = analyzeStation(stationCode, weatherData, stationCfac);
    if (result) {
      results.push(result);
    }
  }

  // Print summary table
  console.log('\n' + '='.repeat(120));
  console.log('CORRELATION ANALYSIS RESULTS');
  console.log('='.repeat(120));
  console.log('\nCorrelation coefficients (higher = better predictor of capacity factor):');
  console.log('-'.repeat(120));
  console.log(
    'Station'.padEnd(15) +
    'Samples'.padStart(10) +
    '10m Corr'.padStart(12) +
    '50m Corr'.padStart(12) +
    '80m Corr'.padStart(12) +
    '100m Corr'.padStart(12) +
    'Best Height'.padStart(15) +
    'Avg CF'.padStart(10)
  );
  console.log('-'.repeat(120));

  for (const r of results) {
    console.log(
      r.stationCode.padEnd(15) +
      r.sampleCount.toString().padStart(10) +
      r.correlations.windspeed10m.toFixed(4).padStart(12) +
      r.correlations.windspeed50m.toFixed(4).padStart(12) +
      r.correlations.windspeed80m.toFixed(4).padStart(12) +
      r.correlations.windspeed100m.toFixed(4).padStart(12) +
      r.bestElevation.replace('windspeed', '').padStart(15) +
      (r.avgCapacityFactor * 100).toFixed(1).padStart(9) + '%'
    );
  }

  console.log('-'.repeat(120));

  // Average wind speeds table
  console.log('\nAverage wind speeds by elevation (m/s):');
  console.log('-'.repeat(80));
  console.log(
    'Station'.padEnd(15) +
    'Avg 10m'.padStart(12) +
    'Avg 50m'.padStart(12) +
    'Avg 80m'.padStart(12) +
    'Avg 100m'.padStart(12)
  );
  console.log('-'.repeat(80));

  for (const r of results) {
    console.log(
      r.stationCode.padEnd(15) +
      r.avgWindSpeeds.windspeed10m.toFixed(2).padStart(12) +
      r.avgWindSpeeds.windspeed50m.toFixed(2).padStart(12) +
      r.avgWindSpeeds.windspeed80m.toFixed(2).padStart(12) +
      r.avgWindSpeeds.windspeed100m.toFixed(2).padStart(12)
    );
  }

  console.log('-'.repeat(80));

  // Summary recommendations
  console.log('\n=== RECOMMENDATIONS ===\n');

  for (const r of results) {
    const bestHeight = r.bestElevation.replace('windspeed', '');
    const bestCorr = r.correlations[r.bestElevation as keyof typeof r.correlations];
    console.log(`${r.stationCode}: Use ${bestHeight} wind speed (r=${bestCorr.toFixed(4)})`);
  }

  // Overall recommendation
  const avgCorr10m = results.reduce((sum, r) => sum + r.correlations.windspeed10m, 0) / results.length;
  const avgCorr50m = results.reduce((sum, r) => sum + r.correlations.windspeed50m, 0) / results.length;
  const avgCorr80m = results.reduce((sum, r) => sum + r.correlations.windspeed80m, 0) / results.length;
  const avgCorr100m = results.reduce((sum, r) => sum + r.correlations.windspeed100m, 0) / results.length;

  console.log('\nOverall average correlations:');
  console.log(`  10m: ${avgCorr10m.toFixed(4)}`);
  console.log(`  50m: ${avgCorr50m.toFixed(4)}`);
  console.log(`  80m: ${avgCorr80m.toFixed(4)}`);
  console.log(`  100m: ${avgCorr100m.toFixed(4)}`);

  return results;
}

// CLI runner
if (process.argv[1].includes('windElevationCorrelation')) {
  runWindElevationAnalysis().catch(console.error);
}
