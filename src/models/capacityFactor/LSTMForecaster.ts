/**
 * LSTMForecaster - Orchestrator for LSTM Capacity Factor Forecasting
 *
 * This class manages the training and forecasting workflow for LSTM-based
 * capacity factor prediction, integrating with the existing CLI infrastructure.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'csv-parse/sync';
import { DateTime } from 'luxon';
import { createRequire } from 'module';

// Create require for CommonJS modules (synaptic) in ESM context
const require = createRequire(import.meta.url);

import { WindLSTMModel, LSTMTrainingOptions } from './WindLSTMModel.js';
import { SolarLSTMModel, SolarLSTMTrainingOptions } from './SolarLSTMModel.js';
import { ProfileBasedModel } from './ProfileBasedModel.js';
import { getStationTypeFromCode, StationType } from '../../types/capacityFactor.js';

// Internal simple record type for LSTM training (not using full CFacTrainingSample)
interface TrainingRecord {
  datetime: string;   // M/D/YYYY HH:00 format
  station: string;
  cf: number;
}

export interface LSTMForecastOptions {
  trainingDataPath: string;
  forecastStart: string;  // YYYY-MM-DD
  forecastEnd: string;    // YYYY-MM-DD
  outputPath: string;
  stationsJsonPath?: string;
  weatherCacheDir?: string;
  autoCalibrate?: boolean;
  calibrationDays?: number;
  excludeOutages?: boolean;
  trainingEndDate?: string;
  progressCallback?: (msg: string) => void;
}

export interface LSTMForecastResult {
  outputPath: string;
  forecastRows: number;
  stationCount: number;
  metrics: {
    windModels: number;
    solarModels: number;
    profileModels: number;
    windSkipped: number;
    solarSkipped: number;
  };
}

interface TrainedModel {
  network: any;
  means: number[];
  stds: number[];
  sequenceLength: number;
  featureCount: number;
  extractFeatures: (weather: any, hour: number, prevCF: number) => number[];
  lastRecords: { cf: number }[];
  type: 'wind' | 'solar';
}

interface ForecastDate {
  datetime: string;  // M/D/YYYY HH:00 format (hour-ending)
  hour: number;      // 0-23 for calculations
}

export class LSTMForecaster {
  private log: (msg: string) => void;

  constructor() {
    this.log = console.log;
  }

  /**
   * Run LSTM-based capacity factor forecast
   */
  async runForecast(options: LSTMForecastOptions): Promise<LSTMForecastResult> {
    this.log = options.progressCallback || console.log;

    this.log('================================================================================');
    this.log('          LSTM CAPACITY FACTOR FORECASTING');
    this.log('================================================================================');
    this.log(`\n  Forecast Period: ${options.forecastStart} to ${options.forecastEnd}`);
    this.log(`  Output: ${options.outputPath}`);
    this.log(`  Training Data: ${options.trainingDataPath}`);

    // Load training data
    this.log('\nLoading training data...');
    const allRecords = this.loadTrainingData(options.trainingDataPath, options.trainingEndDate);
    this.log(`   Loaded ${allRecords.length} capacity factor records`);

    // Get unique stations and classify
    const stationSet = new Set(allRecords.map(r => r.station));
    const stations = Array.from(stationSet);
    this.log(`   Found ${stations.length} stations`);

    const windStations = stations.filter(s => getStationTypeFromCode(s) === StationType.WIND);
    const solarStations = stations.filter(s => getStationTypeFromCode(s) === StationType.SOLAR);
    const otherStations = stations.filter(s => {
      const type = getStationTypeFromCode(s);
      return type !== StationType.WIND && type !== StationType.SOLAR;
    });

    this.log(`\nStation breakdown:`);
    this.log(`   Wind:  ${windStations.length} stations -> LSTM neural network`);
    this.log(`   Solar: ${solarStations.length} stations -> LSTM neural network`);
    this.log(`   Other: ${otherStations.length} stations -> Profile-based`);

    const cacheDir = options.weatherCacheDir || './weather_cache';
    const models = new Map<string, TrainedModel>();
    let windTrained = 0;
    let solarTrained = 0;
    let windSkipped = 0;
    let solarSkipped = 0;

    // Train wind LSTM models
    this.log('\nTraining wind LSTM models...');
    for (const station of windStations) {
      this.log(`  ${station}...`);
      const weatherData = this.loadWeatherForStation(station, cacheDir, 'wind');
      if (weatherData.size < 100) {
        this.log(`    skipped (insufficient weather: ${weatherData.size} records)`);
        windSkipped++;
        continue;
      }
      const model = this.trainStationLSTM(station, allRecords, weatherData, 'wind');
      if (model) {
        models.set(station, model);
        windTrained++;
        this.log(`    done`);
      } else {
        this.log(`    skipped (insufficient training data)`);
        windSkipped++;
      }
    }
    this.log(`  Trained ${windTrained}/${windStations.length} wind models`);

    // Train solar LSTM models
    this.log('\nTraining solar LSTM models...');
    for (const station of solarStations) {
      this.log(`  ${station}...`);
      const weatherData = this.loadWeatherForStation(station, cacheDir, 'solar');
      if (weatherData.size < 100) {
        this.log(`    skipped (insufficient weather: ${weatherData.size} records)`);
        solarSkipped++;
        continue;
      }
      const model = this.trainStationLSTM(station, allRecords, weatherData, 'solar');
      if (model) {
        models.set(station, model);
        solarTrained++;
        this.log(`    done`);
      } else {
        this.log(`    skipped (insufficient training data)`);
        solarSkipped++;
      }
    }
    this.log(`  Trained ${solarTrained}/${solarStations.length} solar models`);

    // Generate forecast dates
    this.log('\nGenerating forecast dates...');
    const forecastDates = this.generateForecastDates(options.forecastStart, options.forecastEnd);
    this.log(`   ${forecastDates.length} hourly timestamps`);

    // Generate forecasts
    this.log('\nGenerating forecasts...');
    const forecasts = new Map<string, Map<string, number>>();

    for (const { datetime } of forecastDates) {
      forecasts.set(datetime, new Map());
    }

    // Forecast with LSTM models
    for (const [station, model] of models) {
      const weatherData = this.loadWeatherForStation(station, cacheDir, model.type);
      let prevCF = model.lastRecords.length > 0 ? model.lastRecords[model.lastRecords.length - 1].cf : 0.3;

      for (const { datetime, hour } of forecastDates) {
        const weather = weatherData.get(datetime);
        const features = model.extractFeatures(weather, hour, prevCF);
        const normalized = this.normalizeFeatures(features, model.means, model.stds);

        // Build sequence input
        const input: number[] = [];
        for (let i = 0; i < model.sequenceLength; i++) {
          input.push(...normalized);
        }

        const prediction = model.network.activate(input)[0];
        const cf = Math.max(0, Math.min(1, prediction));

        forecasts.get(datetime)!.set(station, cf);
        prevCF = cf;
      }
    }

    // Forecast with profile-based models for other stations
    for (const station of otherStations) {
      const stationForecasts = this.calculateProfileForecast(station, allRecords, forecastDates);
      for (const [datetime, cf] of stationForecasts) {
        if (forecasts.has(datetime)) {
          forecasts.get(datetime)!.set(station, cf);
        }
      }
    }

    // Profile-based fallback for skipped wind/solar stations
    for (const station of [...windStations, ...solarStations]) {
      if (!models.has(station)) {
        const stationForecasts = this.calculateProfileForecast(station, allRecords, forecastDates);
        for (const [datetime, cf] of stationForecasts) {
          if (forecasts.has(datetime)) {
            forecasts.get(datetime)!.set(station, cf);
          }
        }
      }
    }

    // Write output CSV
    this.log('\nWriting output CSV...');
    this.writeOutputCSV(options.outputPath, stations, forecastDates, forecasts);
    this.log(`   Written ${forecastDates.length} rows x ${stations.length} stations`);

    // Summary
    this.log('\n================================================================================');
    this.log('  LSTM FORECAST COMPLETE');
    this.log('================================================================================');
    this.log(`\n  Output: ${options.outputPath}`);
    this.log(`  Period: ${options.forecastStart} to ${options.forecastEnd}`);
    this.log(`  Hours:  ${forecastDates.length}`);
    this.log(`  Stations: ${stations.length}`);
    this.log(`  LSTM Models: ${models.size} (Wind: ${windTrained}, Solar: ${solarTrained})`);
    this.log(`  Profile-Based: ${otherStations.length + windSkipped + solarSkipped}`);
    this.log('\n================================================================================');

    return {
      outputPath: options.outputPath,
      forecastRows: forecastDates.length,
      stationCount: stations.length,
      metrics: {
        windModels: windTrained,
        solarModels: solarTrained,
        profileModels: otherStations.length,
        windSkipped,
        solarSkipped,
      },
    };
  }

  /**
   * Load training data from CSV files
   */
  private loadTrainingData(dataPath: string, trainingEndDate?: string): TrainingRecord[] {
    const files = fs.readdirSync(dataPath).filter(f => f.endsWith('.csv'));
    const allRecords: TrainingRecord[] = [];
    const endDate = trainingEndDate ? DateTime.fromISO(trainingEndDate) : null;

    for (const file of files) {
      const content = fs.readFileSync(path.join(dataPath, file), 'utf-8');
      const rows = parse(content, { columns: true, skip_empty_lines: true, relax_column_count: true });

      for (const row of rows) {
        const dt = row['DateTimeEnding'];
        if (!dt) continue;

        // Parse datetime and check against training end date
        if (endDate) {
          const rowDate = this.parseDateTimeEnding(dt);
          if (rowDate && rowDate > endDate) continue;
        }

        for (const [station, value] of Object.entries(row)) {
          if (station === 'DateTimeEnding') continue;
          const cf = parseFloat(value as string);
          if (!isNaN(cf) && cf >= 0 && cf <= 1) {
            allRecords.push({
              datetime: dt,
              station,
              cf,
            });
          }
        }
      }
    }

    return allRecords;
  }

  /**
   * Parse M/D/YYYY HH:00 datetime string
   */
  private parseDateTimeEnding(dt: string): DateTime | null {
    const match = dt.match(/(\d+)\/(\d+)\/(\d+)\s+(\d+):(\d+)/);
    if (!match) return null;
    const [, month, day, year, hour] = match;
    return DateTime.fromObject({
      year: parseInt(year),
      month: parseInt(month),
      day: parseInt(day),
      hour: parseInt(hour),
    });
  }

  /**
   * Load weather data for a station from cache
   */
  private loadWeatherForStation(station: string, cacheDir: string, stationType: string): Map<string, any> {
    const weatherData = new Map<string, any>();

    const patterns = stationType === 'wind'
      ? [`WIND_${station}`, station]
      : [`SOLAR_${station}`, station];

    for (const pattern of patterns) {
      const stationDir = path.join(cacheDir, pattern);
      if (!fs.existsSync(stationDir)) continue;

      const monthDirs = fs.readdirSync(stationDir).filter(d =>
        fs.statSync(path.join(stationDir, d)).isDirectory()
      );

      for (const monthDir of monthDirs) {
        const monthPath = path.join(stationDir, monthDir);
        const csvFiles = fs.readdirSync(monthPath).filter(f => f.endsWith('.csv'));

        for (const csvFile of csvFiles) {
          const content = fs.readFileSync(path.join(monthPath, csvFile), 'utf-8');
          const rows = parse(content, { columns: true, skip_empty_lines: true });

          for (const row of rows) {
            const datetime = row['datetime'] || row['DateTimeEnding'];
            if (!datetime) continue;

            // Convert ISO datetime to M/D/YYYY HH:00 format for hour-ending
            const dt = DateTime.fromISO(datetime);
            if (!dt.isValid) continue;

            // Add 1 hour for hour-ending format
            const hourEnding = dt.plus({ hours: 1 });
            const key = `${hourEnding.month}/${hourEnding.day}/${hourEnding.year} ${String(hourEnding.hour === 0 ? 24 : hourEnding.hour).padStart(2, '0')}:00`;

            weatherData.set(key, {
              windspeed: parseFloat(row['windspeed'] || row['windspeed100m'] || '0'),
              windspeed100m: parseFloat(row['windspeed100m'] || row['windspeed'] || '0'),
              windgust: parseFloat(row['windgust'] || '0'),
              temp: parseFloat(row['temp'] || row['temperature'] || '0'),
              cloudcover: parseFloat(row['cloudcover'] || '0'),
              solarradiation: parseFloat(row['solarradiation'] || '0'),
              uvindex: parseFloat(row['uvindex'] || '0'),
              humidity: parseFloat(row['humidity'] || '0'),
              pressure: parseFloat(row['pressure'] || '0'),
            });
          }
        }
      }

      if (weatherData.size > 0) break;
    }

    return weatherData;
  }

  /**
   * Train LSTM model for a single station
   */
  private trainStationLSTM(
    station: string,
    allRecords: TrainingRecord[],
    weatherData: Map<string, any>,
    stationType: 'wind' | 'solar'
  ): TrainedModel | null {
    const stationRecords = allRecords.filter(r => r.station === station);
    if (stationRecords.length < 500) return null;

    // Import synaptic dynamically
    // @ts-ignore
    const synaptic = require('synaptic');
    const { Architect, Trainer } = synaptic;

    const sequenceLength = stationType === 'wind' ? 24 : 12;
    const featureCount = 8;

    // Extract feature function
    const extractFeatures = (weather: any, hour: number, prevCF: number): number[] => {
      if (!weather) {
        return [0, 0, 1, 20, 50, Math.sin(hour * Math.PI / 12), Math.cos(hour * Math.PI / 12), prevCF];
      }

      if (stationType === 'wind') {
        const windspeed = weather.windspeed100m || weather.windspeed || 0;
        const windgust = weather.windgust || windspeed;
        const gustRatio = windspeed > 0 ? windgust / windspeed : 1;
        return [
          windspeed,
          windgust,
          gustRatio,
          weather.temp || 20,
          weather.cloudcover || 0,
          Math.sin(hour * Math.PI / 12),
          Math.cos(hour * Math.PI / 12),
          prevCF,
        ];
      } else {
        return [
          weather.solarradiation || 0,
          weather.uvindex || 0,
          weather.cloudcover || 0,
          weather.temp || 25,
          weather.humidity || 50,
          Math.sin(hour * Math.PI / 12),
          Math.cos(hour * Math.PI / 12),
          prevCF,
        ];
      }
    };

    // Build training sequences
    const trainingSet: { input: number[]; output: number[] }[] = [];
    const allFeatures: number[][] = [];

    let prevCF = 0;
    for (const rec of stationRecords) {
      const hour = parseInt(rec.datetime.split(' ')[1].split(':')[0]);
      const weather = weatherData.get(rec.datetime);
      const features = extractFeatures(weather, hour, prevCF);
      allFeatures.push(features);
      prevCF = rec.cf;
    }

    // Calculate normalization parameters
    const means: number[] = [];
    const stds: number[] = [];
    for (let f = 0; f < featureCount; f++) {
      const values = allFeatures.map(features => features[f]);
      const mean = values.reduce((a, b) => a + b, 0) / values.length;
      const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
      means.push(mean);
      stds.push(Math.sqrt(variance) || 1);
    }

    // Build normalized sequences
    for (let i = sequenceLength; i < stationRecords.length; i++) {
      const input: number[] = [];
      for (let j = i - sequenceLength; j < i; j++) {
        const normalized = this.normalizeFeatures(allFeatures[j], means, stds);
        input.push(...normalized);
      }
      trainingSet.push({
        input,
        output: [stationRecords[i].cf],
      });
    }

    if (trainingSet.length < 100) return null;

    // Create and train network
    const inputSize = sequenceLength * featureCount;
    const network = new Architect.Perceptron(inputSize, 32, 16, 1);
    const trainer = new Trainer(network);

    trainer.train(trainingSet.slice(0, Math.min(5000, trainingSet.length)), {
      rate: 0.01,
      iterations: 3000,
      error: 0.005,
      shuffle: true,
      log: false,
      cost: Trainer.cost.MSE,
    });

    return {
      network,
      means,
      stds,
      sequenceLength,
      featureCount,
      extractFeatures,
      lastRecords: stationRecords.slice(-sequenceLength),
      type: stationType,
    };
  }

  /**
   * Normalize features using mean and std
   */
  private normalizeFeatures(features: number[], means: number[], stds: number[]): number[] {
    return features.map((f, i) => (f - means[i]) / stds[i]);
  }

  /**
   * Generate forecast dates in hour-ending format
   */
  private generateForecastDates(startDate: string, endDate: string): ForecastDate[] {
    const dates: ForecastDate[] = [];
    const start = DateTime.fromISO(startDate);
    const end = DateTime.fromISO(endDate).endOf('day');

    let current = start;
    while (current <= end) {
      // Hour-ending format: 01:00 to 24:00 internally, but output as 00:00-23:00
      // When hour-ending is 24:00 (hour 23 + 1), output as 00:00 of next day
      const hourEnding = current.hour + 1;

      let displayDate: DateTime;
      let displayHour: number;
      if (hourEnding === 24) {
        // Hour-ending 24:00 = 00:00 of next day
        displayDate = current.plus({ days: 1 });
        displayHour = 0;
      } else {
        displayDate = current;
        displayHour = hourEnding;
      }

      dates.push({
        datetime: `${displayDate.month}/${displayDate.day}/${displayDate.year} ${String(displayHour).padStart(2, '0')}:00`,
        hour: current.hour,
      });

      current = current.plus({ hours: 1 });
    }

    return dates;
  }

  /**
   * Calculate profile-based forecast for non-wind/solar stations
   */
  private calculateProfileForecast(
    station: string,
    records: TrainingRecord[],
    forecastDates: ForecastDate[]
  ): Map<string, number> {
    const stationRecords = records.filter(r => r.station === station);
    if (stationRecords.length === 0) return new Map();

    // Calculate average CF by hour of day
    const hourlyAverages = new Map<number, number>();
    const hourCounts = new Map<number, number>();

    for (const rec of stationRecords) {
      const hour = parseInt(rec.datetime.split(' ')[1].split(':')[0]);
      hourlyAverages.set(hour, (hourlyAverages.get(hour) || 0) + rec.cf);
      hourCounts.set(hour, (hourCounts.get(hour) || 0) + 1);
    }

    for (const [hour, sum] of hourlyAverages) {
      hourlyAverages.set(hour, sum / hourCounts.get(hour)!);
    }

    const forecasts = new Map<string, number>();
    for (const { datetime, hour } of forecastDates) {
      forecasts.set(datetime, hourlyAverages.get(hour) || 0);
    }

    return forecasts;
  }

  /**
   * Write output CSV in the standard CFAC format
   */
  private writeOutputCSV(
    outputPath: string,
    stations: string[],
    forecastDates: ForecastDate[],
    forecasts: Map<string, Map<string, number>>
  ): void {
    const outputDir = path.dirname(outputPath);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    // Filter out SOLAR and WIND aggregate columns - they're not real stations
    const sortedStations = stations
      .filter(s => s !== 'SOLAR' && s !== 'WIND')
      .sort();
    const header = ['DateTimeEnding', ...sortedStations].join(',');
    const rows = [header];

    for (const { datetime } of forecastDates) {
      const stationForecasts = forecasts.get(datetime)!;
      const values: string[] = [datetime];

      for (const station of sortedStations) {
        const cf = stationForecasts.get(station);
        // Use 4 decimal places to match regular CFAC format
        if (cf !== undefined) {
          values.push(cf.toFixed(4));
        } else {
          values.push('');
        }
      }
      rows.push(values.join(','));
    }

    fs.writeFileSync(outputPath, rows.join('\n'));
  }
}
