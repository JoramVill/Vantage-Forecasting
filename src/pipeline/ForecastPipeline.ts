/**
 * ForecastPipeline - Orchestrates stateless inference for Demand V2
 *
 * Steps:
 * 1. Load model.vfm
 * 2. Load calibration.json
 * 3. Fetch weather forecast for target period
 * 4. For each area × day: predict level, predict shape, combine, apply calibration
 * 5. Write forecast CSV
 *
 * This is STATELESS - no learning occurs. Given the same inputs, produces identical output.
 */

import fs from 'fs';
import path from 'path';
import { DateTime } from 'luxon';
import { ModelSerializer, DemandV2ModelArtifact, CalibrationSnapshot } from './ModelSerializer.js';
import { LevelModel, LevelFeatures } from '../models/LevelModel.js';
import { ShapeModel } from '../models/ShapeModel.js';
import { ShapeAdjuster, ShapeAdjustmentFeatures } from '../models/ShapeAdjuster.js';
import { DailyWeather } from '../data/DailyAggregator.js';
import { Calibrator } from '../models/Calibrator.js';
import { ForecastCombiner } from '../models/ForecastCombiner.js';
import { AmplitudeMonitor } from '../models/AmplitudeMonitor.js';
import { createWeatherService, WeatherService } from '../services/weatherService.js';
import { parseWeatherCsv } from '../parsers/weatherParser.js';
import { RawWeatherData } from '../types/index.js';
import { isPhilippineHoliday } from '../constants/index.js';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

// Default API key (can be overridden by env or config)
const DEFAULT_API_KEY = 'BJYBHG8K3YS8EFK46233M8L75';

function getApiKey(): string {
  // Check environment variable first
  if (process.env.VISUAL_CROSSING_API_KEY) {
    return process.env.VISUAL_CROSSING_API_KEY;
  }
  // Check config file
  const configPath = join(process.cwd(), 'config.json');
  if (existsSync(configPath)) {
    try {
      const config = JSON.parse(readFileSync(configPath, 'utf8'));
      if (config.visualCrossingApiKey) {
        return config.visualCrossingApiKey;
      }
    } catch { /* ignore */ }
  }
  return DEFAULT_API_KEY;
}

export interface ForecastPipelineConfig {
  modelPath: string;           // Path to model.vfm
  calibrationPath: string;     // Path to calibration.json
  startDate: string;           // YYYY-MM-DD
  endDate: string;             // YYYY-MM-DD
  outputPath: string;          // Path to save forecast CSV
  weatherCacheDir?: string;    // Weather cache directory (default: './weather_cache')
  skipCalibration?: boolean;   // Use model only (no calibration)
  amplitudeCheckMode?: 'monitor' | 'correct'; // Default 'monitor'
  configPath?: string;         // Custom config file path
  verbose?: boolean;           // Enable verbose logging (default: false)
}

/**
 * Weather data aggregated for a single day
 */
interface DailyWeatherData {
  date: string;
  avgTemp: number;
  maxTemp: number;
  minTemp: number;
  totalPrecip: number;
  avgCloudCover: number;
  totalSolar: number;
  avgHeatIndex: number;
  hourlyData: RawWeatherData[];
}

export class ForecastPipeline {
  private config: ForecastPipelineConfig;

  constructor(config: ForecastPipelineConfig) {
    this.config = config;
  }

  /**
   * Run the forecast pipeline
   */
  async run(): Promise<void> {
    const verbose = this.config.verbose ?? false;

    console.log('\n========================================');
    console.log('  Demand V2 Forecast Pipeline');
    console.log('========================================\n');

    console.log(`Model: ${this.config.modelPath}`);
    console.log(`Calibration: ${this.config.calibrationPath}`);
    console.log(`Forecast period: ${this.config.startDate} to ${this.config.endDate}`);
    if (verbose) {
      console.log(`Verbose logging: enabled`);
      console.log(`Skip calibration: ${this.config.skipCalibration ?? false}`);
      console.log(`Amplitude check mode: ${this.config.amplitudeCheckMode ?? 'monitor'}`);
    }
    console.log('');

    // Step 1: Load model
    if (verbose) {
      console.log(`[${new Date().toISOString()}] Step 1/6: Loading model...`);
    } else {
      console.log('Step 1/6: Loading model...');
    }
    const artifact = ModelSerializer.loadModel(this.config.modelPath);
    console.log(`  Model version: ${artifact.version}`);
    console.log(`  Trained: ${artifact.trainedAt}`);
    if (verbose) {
      console.log(`  Training period: ${artifact.trainingPeriod.start} to ${artifact.trainingPeriod.end}`);
      console.log(`  Areas: ${artifact.areas.join(', ')}`);
    }
    console.log('');

    // Step 2: Load calibration
    if (verbose) {
      console.log(`[${new Date().toISOString()}] Step 2/6: Loading calibration...`);
    } else {
      console.log('Step 2/6: Loading calibration...');
    }
    const calibration = ModelSerializer.loadCalibration(this.config.calibrationPath);
    console.log(`  Calibration date: ${calibration.calibrationDate}`);
    if (verbose) {
      console.log(`  Calibration days: ${calibration.calibrationDays}`);
    }
    console.log('');

    // Step 3: Deserialize models
    if (verbose) {
      console.log(`[${new Date().toISOString()}] Step 3/6: Deserializing models...`);
    } else {
      console.log('Step 3/6: Deserializing models...');
    }
    const levelModel = this.deserializeLevelModel(artifact.levelModel, artifact.levelConfig);
    const shapeModel = this.deserializeShapeModel(artifact.shapeModel);
    const combiner = new ForecastCombiner(ModelSerializer.recordToMap(artifact.historicalMedians));
    const calibrator = new Calibrator();
    calibrator.setHistoricalShapeMedians(
      artifact.areas.map(area => ({
        area,
        shape: artifact.historicalShapeMedians[area]
      }))
    );

    const amplitudeMonitor = new AmplitudeMonitor({
      mode: this.config.amplitudeCheckMode || 'monitor'
    });
    amplitudeMonitor.setHistoricalAmplitudes(
      artifact.areas.map(area => ({
        area,
        shape: artifact.historicalShapeMedians[area]
      }))
    );

    console.log('  Models loaded successfully');
    if (verbose) {
      console.log(`  Level Model: ${(levelModel as any).isStatisticalFallback ? 'Statistical fallback' : 'XGBoost'}`);
      console.log(`  Amplitude monitor mode: ${this.config.amplitudeCheckMode || 'monitor'}`);
    }
    console.log('');

    // Step 4: Fetch weather forecast
    if (verbose) {
      console.log(`[${new Date().toISOString()}] Step 4/6: Fetching weather forecast...`);
    } else {
      console.log('Step 4/6: Fetching weather forecast...');
    }
    const weatherByArea = await this.fetchWeatherForPeriod(
      this.config.startDate,
      this.config.endDate,
      artifact.areas,
      artifact.areaToStationMapping,
      verbose
    );
    console.log(`  Weather data fetched for ${Object.keys(weatherByArea).length} areas`);
    if (verbose) {
      for (const area of Object.keys(weatherByArea)) {
        const days = weatherByArea[area].length;
        console.log(`    ${area}: ${days} days of weather data`);
      }
    }
    console.log('');

    // Step 5: Generate forecasts
    if (verbose) {
      console.log(`[${new Date().toISOString()}] Step 5/6: Generating forecasts...`);
    } else {
      console.log('Step 5/6: Generating forecasts...');
    }
    const forecasts = await this.generateForecasts(
      artifact.areas,
      this.config.startDate,
      this.config.endDate,
      weatherByArea,
      levelModel,
      shapeModel,
      combiner,
      calibrator,
      calibration,
      amplitudeMonitor,
      verbose
    );

    console.log(`  Generated ${forecasts.length} hourly forecasts`);
    console.log('');

    // Step 6: Write output CSV
    console.log('Step 6/6: Writing forecast CSV...');
    this.writeForecastCSV(forecasts, this.config.outputPath, artifact.areas);

    console.log('');
    console.log('========================================');
    console.log(`  Forecast saved: ${this.config.outputPath}`);
    console.log('========================================\n');
  }

  /**
   * Fetch weather forecast for the period using Visual Crossing API
   */
  private async fetchWeatherForPeriod(
    startDate: string,
    endDate: string,
    areas: string[],
    areaToStationMapping: Record<string, string[]>,
    verbose: boolean
  ): Promise<Record<string, DailyWeatherData[]>> {
    const cacheDir = this.config.weatherCacheDir || './weather_cache';
    const apiKey = getApiKey();
    const weatherService = createWeatherService(apiKey, cacheDir);

    // Fetch weather files for the forecast period
    const weatherFiles = await weatherService.saveWeatherFiles(
      startDate,
      endDate,
      path.join(cacheDir, 'combined'),
      verbose ? (msg: string) => console.log(`    ${msg}`) : undefined
    );

    // Parse weather files and organize by area
    const weatherByArea: Record<string, DailyWeatherData[]> = {};

    for (const area of areas) {
      weatherByArea[area] = [];
    }

    // Map weather files to areas based on location mapping
    for (const filePath of weatherFiles) {
      const weatherData = parseWeatherCsv(filePath);

      // Find which areas this weather file applies to
      for (const area of areas) {
        const stations = areaToStationMapping[area] || [];
        const matchesArea = stations.some(station =>
          weatherData.city.toLowerCase().includes(station.toLowerCase())
        ) || this.cityMatchesArea(weatherData.city, area);

        if (matchesArea) {
          // Aggregate hourly data into daily
          const dailyData = this.aggregateHourlyToDaily(weatherData.records, startDate, endDate);
          weatherByArea[area] = dailyData;
        }
      }
    }

    return weatherByArea;
  }

  /**
   * Check if a weather city matches an area based on known mappings
   */
  private cityMatchesArea(city: string, area: string): boolean {
    const cityLower = city.toLowerCase();
    const areaLower = area.toLowerCase();

    // Regional mappings
    const regionMappings: Record<string, string[]> = {
      'cluz': ['manila', 'quezon', 'batangas', 'baguio'],
      'cvis': ['cebu', 'iloilo', 'bacolod', 'tacloban'],
      'cmin': ['davao', 'cagayan de oro', 'general santos', 'zamboanga'],
      // Zonal mappings
      '01nluz': ['baguio', 'laoag', 'tuguegarao'],
      '02metro': ['manila', 'quezon', 'makati'],
      '03sluz': ['batangas', 'lucena', 'legazpi'],
      '04leyte': ['tacloban', 'ormoc'],
      '05cebu': ['cebu'],
      '06negros': ['bacolod', 'dumaguete'],
      '07bohol': ['tagbilaran'],
      '08panay': ['iloilo', 'kalibo'],
      '09nwmin': ['zamboanga', 'dipolog'],
      '10lanao': ['marawi', 'iligan'],
      '11ncmin': ['cagayan de oro', 'bukidnon'],
      '12nemin': ['butuan', 'surigao'],
      '13semin': ['davao', 'digos'],
      '14swmin': ['general santos', 'koronadal']
    };

    const cities = regionMappings[areaLower] || [];
    return cities.some(c => cityLower.includes(c));
  }

  /**
   * Aggregate hourly weather records into daily summaries
   */
  private aggregateHourlyToDaily(
    hourlyRecords: RawWeatherData[],
    startDate: string,
    endDate: string
  ): DailyWeatherData[] {
    // Group by date
    const byDate = new Map<string, RawWeatherData[]>();

    for (const record of hourlyRecords) {
      const date = record.datetime.split('T')[0];
      if (date >= startDate && date <= endDate) {
        if (!byDate.has(date)) {
          byDate.set(date, []);
        }
        byDate.get(date)!.push(record);
      }
    }

    // Aggregate each day
    const dailyData: DailyWeatherData[] = [];

    for (const [date, hourly] of byDate) {
      if (hourly.length === 0) continue;

      const temps = hourly.map(h => h.temp);
      const avgTemp = temps.reduce((a, b) => a + b, 0) / temps.length;
      const maxTemp = Math.max(...temps);
      const minTemp = Math.min(...temps);

      const totalPrecip = hourly.reduce((sum, h) => sum + h.precip, 0);
      const avgCloudCover = hourly.reduce((sum, h) => sum + h.cloudcover, 0) / hourly.length;
      const totalSolar = hourly.reduce((sum, h) => sum + (h.solarradiation || 0), 0);

      // Calculate heat index (simplified)
      const avgHeatIndex = this.calculateHeatIndex(avgTemp, avgCloudCover);

      dailyData.push({
        date,
        avgTemp,
        maxTemp,
        minTemp,
        totalPrecip,
        avgCloudCover,
        totalSolar,
        avgHeatIndex,
        hourlyData: hourly
      });
    }

    // Sort by date
    dailyData.sort((a, b) => a.date.localeCompare(b.date));

    return dailyData;
  }

  /**
   * Calculate heat index from temperature and humidity proxy
   */
  private calculateHeatIndex(temp: number, cloudCover: number): number {
    // Simplified heat index calculation
    // Use cloud cover as inverse humidity proxy
    const humidity = Math.max(40, 100 - cloudCover);

    if (temp < 27) return temp;

    // Rothfusz regression
    const T = temp;
    const R = humidity;

    let HI = -8.78469475556 + 1.61139411 * T + 2.33854883889 * R
           - 0.14611605 * T * R - 0.012308094 * T * T
           - 0.0164248277778 * R * R + 0.002211732 * T * T * R
           + 0.00072546 * T * R * R - 0.000003582 * T * T * R * R;

    return HI;
  }

  /**
   * Generate forecasts for all areas and days
   */
  private async generateForecasts(
    areas: string[],
    startDate: string,
    endDate: string,
    weatherByArea: Record<string, DailyWeatherData[]>,
    levelModel: LevelModel,
    shapeModel: ShapeModel,
    combiner: ForecastCombiner,
    calibrator: Calibrator,
    calibration: CalibrationSnapshot,
    amplitudeMonitor: AmplitudeMonitor,
    verbose: boolean
  ): Promise<Array<{ datetime: string; values: Record<string, number> }>> {
    const forecasts: Array<{ datetime: string; values: Record<string, number> }> = [];

    // Build lag features from calibration's recent actuals
    const recentActuals = calibration.recentActuals || {};

    // Iterate over each day
    let currentDate = DateTime.fromISO(startDate);
    const endDt = DateTime.fromISO(endDate);

    while (currentDate <= endDt) {
      const dateStr = currentDate.toISODate()!;
      const dow = currentDate.weekday; // 1=Mon, 7=Sun
      const month = currentDate.month;
      const dayOfMonth = currentDate.day;

      // Calendar features
      const isHoliday = isPhilippineHoliday(dateStr) ? 1 : 0;
      const isSunday = dow === 7 ? 1 : 0;
      const isSaturday = dow === 6 ? 1 : 0;
      const isWorkday = (dow >= 1 && dow <= 5 && !isHoliday) ? 1 : 0;

      // Cyclical month encoding
      const monthSin = Math.sin(2 * Math.PI * month / 12);
      const monthCos = Math.cos(2 * Math.PI * month / 12);

      // Determine day type for shape model
      let dayType: string;
      if (isHoliday) {
        dayType = 'holiday';
      } else if (isSunday) {
        dayType = 'sunday';
      } else if (isSaturday) {
        dayType = 'saturday';
      } else {
        dayType = 'workday';
      }

      // For each area
      for (const area of areas) {
        const dailyWeather = weatherByArea[area]?.find(d => d.date === dateStr);

        // Build level features
        const lagFeatures = this.computeLagFeaturesForDay(area, dateStr, recentActuals);

        // Use weather data or defaults
        const avgTemp = dailyWeather?.avgTemp ?? 28;
        const maxTemp = dailyWeather?.maxTemp ?? 32;
        const CDH = Math.max(0, (avgTemp - 24) * 24); // Cooling degree hours
        const totalPrecip = dailyWeather?.totalPrecip ?? 0;
        const avgCloudCover = dailyWeather?.avgCloudCover ?? 50;
        const totalSolar = dailyWeather?.totalSolar ?? 4000;
        const tempRange = (dailyWeather?.maxTemp ?? 32) - (dailyWeather?.minTemp ?? 24);
        const avgHeatIndex = dailyWeather?.avgHeatIndex ?? avgTemp;

        const levelFeatures: Omit<LevelFeatures, 'areaIdx'> = {
          avgTemp,
          maxTemp,
          CDH,
          totalPrecip,
          avgCloudCover,
          totalSolar,
          tempRange,
          avgHeatIndex,
          isWorkday,
          isSaturday,
          isSunday,
          isHoliday,
          monthSin,
          monthCos,
          dayOfMonth,
          ...lagFeatures
        };

        // Predict daily total using Level Model
        let predictedTotal: number;
        try {
          predictedTotal = await levelModel.predict(area, levelFeatures);
        } catch (e) {
          // Fallback to a reasonable default based on area type
          const defaultDailyTotals: Record<string, number> = {
            'CLUZ': 200000, 'CVIS': 35000, 'CMIN': 40000,  // Regional
            '01NLUZ': 25000, '02METRO': 80000, '03SLUZ': 45000,  // Luzon zones
            '04LEYTE': 6000, '05CEBU': 12000, '06NEGROS': 8000, '07BOHOL': 3000, '08PANAY': 7000,  // Visayas
            '09NWMIN': 6000, '10LANAO': 4000, '11NCMIN': 8000, '12NEMIN': 5000, '13SEMIN': 12000, '14SWMIN': 5000  // Mindanao
          };
          predictedTotal = defaultDailyTotals[area] ?? 50000;
          if (verbose) {
            console.log(`    Warning: Using fallback for ${area} on ${dateStr}`);
          }
        }

        // Build shape adjustment features - compute from hourly weather data
        const hourlyData = dailyWeather?.hourlyData || [];
        const temps = hourlyData.map(h => h.temp);
        const peakTempHour = temps.length > 0 ? temps.indexOf(Math.max(...temps)) : 14;

        // Morning ramp rate: temperature change from 6 AM to noon
        const temp6am = hourlyData[6]?.temp ?? avgTemp - 4;
        const temp12pm = hourlyData[12]?.temp ?? avgTemp + 4;
        const morningRampRate = (temp12pm - temp6am) / 6;

        // Evening cool rate: temperature change from 3 PM to 9 PM
        const temp3pm = hourlyData[15]?.temp ?? maxTemp;
        const temp9pm = hourlyData[21]?.temp ?? avgTemp - 2;
        const eveningCoolRate = (temp3pm - temp9pm) / 6;

        // Check for daytime rain (6 AM to 6 PM)
        const daytimeHours = hourlyData.slice(6, 18);
        const isDaytimeRain = daytimeHours.some(h => h.precip > 0.5);

        const shapeFeatures: ShapeAdjustmentFeatures = {
          peakTempHour,
          morningRampRate,
          eveningCoolRate,
          tempRange,
          avgTemp,
          avgCloudCover,
          isDaytimeRain
        };

        // Build daily weather for shape model (matching DailyWeather interface)
        const dailyWeatherForShape: DailyWeather = {
          avgTemp,
          maxTemp,
          minTemp: dailyWeather?.minTemp ?? 24,
          tempRange,
          CDH,
          totalPrecip,
          avgCloudCover,
          totalSolar,
          avgHeatIndex
        };

        // Predict shape using Shape Model
        let predictedShape: number[];
        try {
          predictedShape = shapeModel.predict(area, dayType, dailyWeatherForShape, shapeFeatures);
        } catch (e) {
          // Fallback to flat shape
          predictedShape = Array(24).fill(1 / 24);
          if (verbose) {
            console.log(`    Warning: Using flat shape for ${area} on ${dateStr}`);
          }
        }

        // Combine level × shape
        let hourlyForecast = combiner.combine(area, predictedTotal, predictedShape);

        // Apply calibration (unless skipped)
        if (!this.config.skipCalibration && calibration.levelScale && calibration.shapeCorrection) {
          // Start with computed calibration factors
          const levelScaleMap = ModelSerializer.recordToMap(calibration.levelScale);

          // Apply manual scale overrides if present (they override computed factors)
          if (calibration.manualLevelScale) {
            for (const [manualArea, manualScale] of Object.entries(calibration.manualLevelScale)) {
              levelScaleMap.set(manualArea, manualScale);
            }
          }

          const calibrationFactors = {
            levelScale: levelScaleMap,
            shapeCorrection: ModelSerializer.recordToMap(calibration.shapeCorrection)
          };

          const calibrated = calibrator.applyCalibration(
            area,
            predictedTotal,
            predictedShape,
            calibrationFactors
          );

          hourlyForecast = combiner.combine(area, calibrated.calibratedTotal, calibrated.calibratedShape);
        }

        // Amplitude check
        const amplitudeCheck = amplitudeMonitor.checkAmplitude(area, predictedShape);
        if (amplitudeCheck.correctedShape && this.config.amplitudeCheckMode === 'correct') {
          // Re-combine with corrected shape
          hourlyForecast = combiner.combine(area, predictedTotal, amplitudeCheck.correctedShape);
        }

        // Add to forecasts (one row per hour)
        for (let h = 0; h < 24; h++) {
          const hour = h.toString().padStart(2, '0');
          const datetime = `${dateStr}T${hour}:00:00`;

          let existingRow = forecasts.find(f => f.datetime === datetime);
          if (!existingRow) {
            existingRow = { datetime, values: {} };
            forecasts.push(existingRow);
          }

          existingRow.values[area] = hourlyForecast[h];
        }
      }

      currentDate = currentDate.plus({ days: 1 });
    }

    return forecasts;
  }

  /**
   * Compute lag features for a specific day from recent actuals
   * recentActuals format: Area → date → dailyTotal
   */
  private computeLagFeaturesForDay(
    area: string,
    dateStr: string,
    recentActuals: Record<string, Record<string, number>>
  ): {
    totalYesterday: number;
    totalLastWeek: number;
    totalRolling7d: number;
    totalRolling30d: number;
    trendWeek: number;
  } {
    const areaActuals = recentActuals[area] || {};
    const currentDate = DateTime.fromISO(dateStr);

    // Get default daily total based on area
    const defaultDailyTotals: Record<string, number> = {
      'CLUZ': 200000, 'CVIS': 35000, 'CMIN': 40000,
      '01NLUZ': 25000, '02METRO': 80000, '03SLUZ': 45000,
      '04LEYTE': 6000, '05CEBU': 12000, '06NEGROS': 8000, '07BOHOL': 3000, '08PANAY': 7000,
      '09NWMIN': 6000, '10LANAO': 4000, '11NCMIN': 8000, '12NEMIN': 5000, '13SEMIN': 12000, '14SWMIN': 5000
    };
    const defaultTotal = defaultDailyTotals[area] ?? 50000;

    // Find yesterday's total
    const yesterdayStr = currentDate.minus({ days: 1 }).toISODate()!;
    const totalYesterday = areaActuals[yesterdayStr] ?? defaultTotal;

    // Find last week's total
    const lastWeekStr = currentDate.minus({ days: 7 }).toISODate()!;
    const totalLastWeek = areaActuals[lastWeekStr] ?? totalYesterday;

    // Calculate rolling averages
    const dates = Object.keys(areaActuals);
    const last7Days: number[] = [];
    const last30Days: number[] = [];

    for (const d of dates) {
      const dateObj = DateTime.fromISO(d);
      const diff = currentDate.diff(dateObj, 'days').days;
      if (diff > 0 && diff <= 7) {
        last7Days.push(areaActuals[d]);
      }
      if (diff > 0 && diff <= 30) {
        last30Days.push(areaActuals[d]);
      }
    }

    const totalRolling7d = last7Days.length > 0
      ? last7Days.reduce((a, b) => a + b, 0) / last7Days.length
      : totalYesterday;

    const totalRolling30d = last30Days.length > 0
      ? last30Days.reduce((a, b) => a + b, 0) / last30Days.length
      : totalRolling7d;

    // Trend: (7d - 30d) / 30d
    const trendWeek = totalRolling30d > 0
      ? (totalRolling7d - totalRolling30d) / totalRolling30d
      : 0;

    return {
      totalYesterday,
      totalLastWeek,
      totalRolling7d,
      totalRolling30d,
      trendWeek
    };
  }

  /**
   * Categorize weather based on cloud cover and precipitation
   */
  private categorizeWeather(cloudCover: number, precip: number): string {
    if (precip > 5) return 'rainy';
    if (cloudCover > 80) return 'overcast';
    if (cloudCover > 50) return 'cloudy';
    if (cloudCover > 20) return 'partlyCloudy';
    return 'clear';
  }

  /**
   * Write forecast to CSV
   */
  private writeForecastCSV(
    forecasts: Array<{ datetime: string; values: Record<string, number> }>,
    outputPath: string,
    areas: string[]
  ): void {
    // Sort forecasts by datetime
    forecasts.sort((a, b) => a.datetime.localeCompare(b.datetime));

    // Create CSV header
    const header = ['DateTimeEnding', ...areas].join(',');

    // Create CSV rows
    const rows = forecasts.map(f => {
      const values = areas.map(area => f.values[area]?.toFixed(1) || '0.0');
      return [f.datetime, ...values].join(',');
    });

    const csv = [header, ...rows].join('\n');

    // Ensure output directory exists
    const dir = path.dirname(outputPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(outputPath, csv, 'utf8');
    console.log(`  Wrote ${rows.length} rows to ${outputPath}`);
  }

  /**
   * Deserialize Level Model
   */
  private deserializeLevelModel(serialized: any, config: any): LevelModel {
    const levelModel = new LevelModel(config);

    (levelModel as any).areaToIndex = new Map(serialized.areaToIndex);
    (levelModel as any).indexToArea = new Map(serialized.indexToArea);
    (levelModel as any).isStatisticalFallback = serialized.isStatisticalFallback;
    (levelModel as any).statisticalModel = serialized.statisticalModel ?
      new Map(serialized.statisticalModel) : null;
    (levelModel as any).model = serialized.xgboostModel;

    return levelModel;
  }

  /**
   * Deserialize Shape Model
   */
  private deserializeShapeModel(serialized: any): ShapeModel {
    const shapeModel = new ShapeModel(serialized.config);

    (shapeModel as any).profileLibrary.profiles = new Map(serialized.profileLibrary.profiles);

    if (serialized.shapeAdjuster.adjustmentWeights) {
      (shapeModel as any).shapeAdjuster.adjustmentWeights = new Map(serialized.shapeAdjuster.adjustmentWeights);
    }
    (shapeModel as any).shapeAdjuster.isTrained = serialized.shapeAdjuster.isTrained;

    return shapeModel;
  }
}
