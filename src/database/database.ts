import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { DateTime } from 'luxon';
import { CREATE_TABLES_SQL, SCHEMA_VERSION, REGION_MAPPING } from './schema.js';
import { DemandRecord, ParsedDemandData } from '../parsers/demandParser.js';
import { RawWeatherData } from '../types/index.js';
import {
  OutageRecord,
  OutageType,
  OutageProbabilityModel,
  GridRegion
} from '../types/outage.js';
import {
  InterconnectorRecord,
  InterconnectorStats,
  InterconnectorModelMetrics
} from '../types/interconnector.js';
import {
  MRECFactors,
  MRECCalibrationData
} from '../types/capacityFactor.js';

export interface DatabaseStats {
  demandRecords: number;
  weatherRecords: number;
  models: number;
  demandDateRange: { start: string | null; end: string | null };
  weatherDateRange: { start: string | null; end: string | null };
  regions: string[];
}

export interface StoredModel {
  id: number;
  name: string;
  modelType: string;
  createdAt: string;
  trainingStart: string;
  trainingEnd: string;
  trainingSamples: number;
  r2Score: number;
  mape: number;
  rmse: number;
  mae: number;
  coefficients: number[];
  featureNames: string[];
  isActive: boolean;
  notes: string | null;
}

export class DatabaseService {
  private db: Database.Database;
  private dbPath: string;

  constructor(dbPath?: string) {
    this.dbPath = dbPath || join(process.cwd(), 'data', 'iload.db');

    // Ensure directory exists
    const dir = dirname(this.dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.initialize();
  }

  private initialize(): void {
    this.db.exec(CREATE_TABLES_SQL);

    // Set schema version if not exists
    const stmt = this.db.prepare('INSERT OR IGNORE INTO schema_info (key, value) VALUES (?, ?)');
    stmt.run('version', String(SCHEMA_VERSION));

    // Initialize interconnector metadata
    this.initializeInterconnectorMetadata();
  }

  // ============ DEMAND RECORDS ============

  importDemandRecords(records: DemandRecord[], sourceFile?: string): { inserted: number; updated: number } {
    const insertStmt = this.db.prepare(`
      INSERT INTO demand_records (datetime, region, demand, source_file)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(datetime, location) DO UPDATE SET
        demand = excluded.demand,
        source_file = excluded.source_file,
        imported_at = CURRENT_TIMESTAMP
    `);

    let inserted = 0;
    let updated = 0;

    const transaction = this.db.transaction(() => {
      for (const record of records) {
        const dtStr = DateTime.fromJSDate(record.datetime).toISO();
        const result = insertStmt.run(dtStr, record.region, record.demand, sourceFile || null);
        if (result.changes > 0) {
          inserted++;
        }
      }
    });

    transaction();
    return { inserted, updated };
  }

  getDemandRecords(startDate?: string, endDate?: string, region?: string): DemandRecord[] {
    let sql = 'SELECT datetime, region, demand FROM demand_records WHERE 1=1';
    const params: any[] = [];

    if (startDate) {
      sql += ' AND datetime >= ?';
      params.push(startDate);
    }
    if (endDate) {
      sql += ' AND datetime <= ?';
      params.push(endDate);
    }
    if (region) {
      sql += ' AND region = ?';
      params.push(region);
    }

    sql += ' ORDER BY datetime, region';

    const rows = this.db.prepare(sql).all(...params) as any[];
    return rows.map(row => ({
      datetime: new Date(row.datetime),
      region: row.region,
      demand: row.demand
    }));
  }

  getDemandData(startDate?: string, endDate?: string): ParsedDemandData {
    const records = this.getDemandRecords(startDate, endDate);
    const regions = [...new Set(records.map(r => r.region))];

    let minDate: Date | null = null;
    let maxDate: Date | null = null;

    for (const record of records) {
      if (!minDate || record.datetime < minDate) minDate = record.datetime;
      if (!maxDate || record.datetime > maxDate) maxDate = record.datetime;
    }

    return {
      records,
      regions,
      startDate: minDate || new Date(),
      endDate: maxDate || new Date()
    };
  }

  // ============ WEATHER RECORDS ============

  importWeatherRecords(
    records: RawWeatherData[],
    location: string,
    isForecast: boolean = false,
    source?: string
  ): { inserted: number } {
    const region = REGION_MAPPING[location.toLowerCase()] || location;

    const insertStmt = this.db.prepare(`
      INSERT INTO weather_records (datetime, location, region, temp, dew, precip, windgust, windspeed, cloudcover, solarradiation, solarenergy, uvindex, is_forecast, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(datetime, location) DO UPDATE SET
        temp = excluded.temp,
        dew = excluded.dew,
        precip = excluded.precip,
        windgust = excluded.windgust,
        windspeed = excluded.windspeed,
        cloudcover = excluded.cloudcover,
        solarradiation = excluded.solarradiation,
        solarenergy = excluded.solarenergy,
        uvindex = excluded.uvindex,
        is_forecast = excluded.is_forecast,
        source = excluded.source,
        imported_at = CURRENT_TIMESTAMP
    `);

    let inserted = 0;

    const transaction = this.db.transaction(() => {
      for (const record of records) {
        insertStmt.run(
          record.datetime,
          location,
          region,
          record.temp,
          record.dew,
          record.precip,
          record.windgust,
          record.windspeed,
          record.cloudcover,
          record.solarradiation,
          record.solarenergy,
          record.uvindex,
          isForecast ? 1 : 0,
          source || null
        );
        inserted++;
      }
    });

    transaction();
    return { inserted };
  }

  getWeatherRecords(startDate?: string, endDate?: string, region?: string): RawWeatherData[] {
    let sql = 'SELECT * FROM weather_records WHERE 1=1';
    const params: any[] = [];

    if (startDate) {
      sql += ' AND datetime >= ?';
      params.push(startDate);
    }
    if (endDate) {
      sql += ' AND datetime <= ?';
      params.push(endDate);
    }
    if (region) {
      sql += ' AND region = ?';
      params.push(region);
    }

    sql += ' ORDER BY datetime, region';

    const rows = this.db.prepare(sql).all(...params) as any[];
    return rows.map(row => ({
      name: row.location,
      latitude: 0,
      longitude: 0,
      datetime: row.datetime,
      temp: row.temp,
      dew: row.dew,
      precip: row.precip,
      windgust: row.windgust,
      windspeed: row.windspeed,
      cloudcover: row.cloudcover,
      solarradiation: row.solarradiation,
      solarenergy: row.solarenergy,
      uvindex: row.uvindex
    }));
  }

  /**
   * Get list of dates that have weather data for a specific location
   * Returns dates in YYYY-MM-DD format
   * NOTE: Uses LOWER(location) match for zonal mode where multiple cities map to same region
   */
  getWeatherAvailableDates(location: string, startDate?: string, endDate?: string): Set<string> {
    let sql = `
      SELECT DISTINCT DATE(datetime) as date
      FROM weather_records
      WHERE LOWER(location) = LOWER(?)
    `;
    const params: any[] = [location];

    if (startDate) {
      sql += ' AND datetime >= ?';
      params.push(startDate);
    }
    if (endDate) {
      sql += ' AND datetime <= ?';
      // Add a day to include the end date fully
      params.push(endDate + 'T23:59:59');
    }

    const rows = this.db.prepare(sql).all(...params) as any[];
    return new Set(rows.map(row => row.date));
  }

  /**
   * Check if we have complete weather data for a specific date and location
   * Complete = 24 hourly records
   */
  hasCompleteWeatherForDate(location: string, date: string): boolean {
    const region = REGION_MAPPING[location.toLowerCase()] || location;

    const result = this.db.prepare(`
      SELECT COUNT(*) as count
      FROM weather_records
      WHERE region = ?
        AND datetime >= ?
        AND datetime < ?
    `).get(region, date + 'T00:00:00', date + 'T23:59:59') as any;

    // Consider complete if we have at least 23 hours (allowing for some gaps)
    return result.count >= 23;
  }

  /**
   * Get dates with stale forecast data that should be refreshed
   * Stale = forecast data that is older than maxAgeHours
   *
   * @param location - Location name
   * @param startDate - Start date YYYY-MM-DD
   * @param endDate - End date YYYY-MM-DD
   * @param maxAgeHours - Maximum age in hours before forecast is considered stale (default: 24)
   * @returns Array of dates that have stale forecast data
   */
  getStaleForecastDates(location: string, startDate: string, endDate: string, maxAgeHours: number = 24): string[] {
    const cutoffTime = DateTime.now().minus({ hours: maxAgeHours }).toISO();

    // Find dates where:
    // 1. Data is marked as forecast (is_forecast = 1)
    // 2. imported_at is older than cutoff time
    // NOTE: Uses LOWER(location) match for zonal mode
    const rows = this.db.prepare(`
      SELECT DISTINCT DATE(datetime) as date
      FROM weather_records
      WHERE LOWER(location) = LOWER(?)
        AND datetime >= ?
        AND datetime <= ?
        AND is_forecast = 1
        AND imported_at < ?
    `).all(location, startDate + 'T00:00:00', endDate + 'T23:59:59', cutoffTime) as any[];

    return rows.map(row => row.date);
  }

  /**
   * Get dates that need historical data to replace old forecast data
   * These are past dates that still have forecast data (which means we fetched them
   * as forecast but never got actual historical data)
   *
   * @param location - Location name
   * @param startDate - Start date YYYY-MM-DD
   * @param endDate - End date YYYY-MM-DD (should be < today for meaningful results)
   * @returns Array of past dates that have forecast data instead of historical
   */
  getDatesNeedingHistoricalData(location: string, startDate: string, endDate: string): string[] {
    const today = DateTime.now().startOf('day').toISODate();

    // Find past dates where data is still marked as forecast
    // NOTE: Uses LOWER(location) match for zonal mode
    const rows = this.db.prepare(`
      SELECT DISTINCT DATE(datetime) as date
      FROM weather_records
      WHERE LOWER(location) = LOWER(?)
        AND datetime >= ?
        AND datetime <= ?
        AND DATE(datetime) < ?
        AND is_forecast = 1
    `).all(location, startDate + 'T00:00:00', endDate + 'T23:59:59', today) as any[];

    return rows.map(row => row.date);
  }

  /**
   * Get missing dates for weather data within a range
   * Returns array of dates in YYYY-MM-DD format that need to be fetched
   *
   * Includes:
   * 1. Dates with no weather data at all
   * 2. Past dates that have forecast data (need historical replacement)
   * 3. Future dates with stale forecast data (older than maxForecastAgeHours)
   *
   * @param location - Location name
   * @param startDate - Start date YYYY-MM-DD
   * @param endDate - End date YYYY-MM-DD
   * @param maxForecastAgeHours - Max age for forecast data before refresh (default: 24)
   */
  getMissingWeatherDates(location: string, startDate: string, endDate: string, maxForecastAgeHours: number = 24): string[] {
    // NOTE: Uses location directly (not region mapping) to support zonal mode
    // Get all dates that have ANY weather data
    const existingDates = this.getWeatherAvailableDates(location, startDate, endDate);

    // Generate all dates in range
    const allDates: string[] = [];
    let current = DateTime.fromISO(startDate);
    const end = DateTime.fromISO(endDate);

    while (current <= end) {
      allDates.push(current.toISODate()!);
      current = current.plus({ days: 1 });
    }

    // Get dates that need refresh (stale forecasts or past dates with forecast data)
    const staleForecastDates = new Set(this.getStaleForecastDates(location, startDate, endDate, maxForecastAgeHours));
    const needsHistoricalDates = new Set(this.getDatesNeedingHistoricalData(location, startDate, endDate));

    // Return dates that are:
    // 1. Not in database at all, OR
    // 2. Have stale forecast data, OR
    // 3. Are past dates with forecast data (need historical)
    return allDates.filter(date => {
      if (!existingDates.has(date)) return true;  // Missing entirely
      if (staleForecastDates.has(date)) return true;  // Stale forecast
      if (needsHistoricalDates.has(date)) return true;  // Past date needs historical
      return false;
    });
  }

  /**
   * Get weather data statistics showing historical vs forecast breakdown
   */
  getWeatherDataStats(location?: string): {
    totalRecords: number;
    historicalRecords: number;
    forecastRecords: number;
    staleForecastRecords: number;
    dateRange: { start: string | null; end: string | null };
  } {
    let regionFilter = '';
    const params: any[] = [];

    if (location) {
      const region = REGION_MAPPING[location.toLowerCase()] || location;
      regionFilter = ' WHERE region = ?';
      params.push(region);
    }

    const total = (this.db.prepare(`SELECT COUNT(*) as count FROM weather_records${regionFilter}`).get(...params) as any).count;
    const historical = (this.db.prepare(`SELECT COUNT(*) as count FROM weather_records${regionFilter ? regionFilter + ' AND' : ' WHERE'} is_forecast = 0`).get(...params) as any).count;
    const forecast = (this.db.prepare(`SELECT COUNT(*) as count FROM weather_records${regionFilter ? regionFilter + ' AND' : ' WHERE'} is_forecast = 1`).get(...params) as any).count;

    const cutoffTime = DateTime.now().minus({ hours: 24 }).toISO();
    const staleForecast = (this.db.prepare(`SELECT COUNT(*) as count FROM weather_records${regionFilter ? regionFilter + ' AND' : ' WHERE'} is_forecast = 1 AND imported_at < ?`).get(...params, cutoffTime) as any).count;

    const dateRange = this.db.prepare(`SELECT MIN(datetime) as start, MAX(datetime) as end FROM weather_records${regionFilter}`).get(...params) as any;

    return {
      totalRecords: total,
      historicalRecords: historical,
      forecastRecords: forecast,
      staleForecastRecords: staleForecast,
      dateRange: { start: dateRange?.start || null, end: dateRange?.end || null }
    };
  }

  /**
   * Import weather records from raw API data (single day)
   * Handles the datetime format from Visual Crossing API
   *
   * Auto-detects if data is historical or forecast based on date:
   * - If date < today: historical data (is_forecast = 0), permanent
   * - If date >= today: forecast data (is_forecast = 1), can be replaced when stale
   *
   * Historical data is NEVER overwritten by forecast data.
   * Forecast data can be overwritten by newer forecast or historical data.
   */
  importWeatherDay(
    records: RawWeatherData[],
    location: string,
    isForecastOverride?: boolean  // Optional: force forecast flag (mainly for testing)
  ): { inserted: number; skipped: number } {
    const region = REGION_MAPPING[location.toLowerCase()] || location;
    const today = DateTime.now().startOf('day');

    // Statement for inserting new records or updating forecast records
    // Key logic: Only update if new data is historical OR existing data is forecast
    // NOTE: Uses (datetime, location) for conflict to support zonal mode with multiple cities per region
    const insertStmt = this.db.prepare(`
      INSERT INTO weather_records (datetime, location, region, temp, dew, precip, windgust, windspeed, cloudcover, solarradiation, solarenergy, uvindex, is_forecast, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(datetime, location) DO UPDATE SET
        temp = excluded.temp,
        dew = excluded.dew,
        precip = excluded.precip,
        windgust = excluded.windgust,
        windspeed = excluded.windspeed,
        cloudcover = excluded.cloudcover,
        solarradiation = excluded.solarradiation,
        solarenergy = excluded.solarenergy,
        uvindex = excluded.uvindex,
        is_forecast = excluded.is_forecast,
        source = excluded.source,
        imported_at = CURRENT_TIMESTAMP
      WHERE
        -- Only update if: new data is historical (is_forecast=0) OR existing is forecast (is_forecast=1)
        excluded.is_forecast = 0 OR weather_records.is_forecast = 1
    `);

    let inserted = 0;
    let skipped = 0;

    const transaction = this.db.transaction(() => {
      for (const record of records) {
        // Determine if this record is historical or forecast based on date
        const recordDate = DateTime.fromISO(record.datetime.split('T')[0]);
        const isHistorical = recordDate < today;
        const isForecast = isForecastOverride !== undefined ? isForecastOverride : !isHistorical;

        const result = insertStmt.run(
          record.datetime,
          location,
          region,
          record.temp,
          record.dew,
          record.precip,
          record.windgust,
          record.windspeed,
          record.cloudcover,
          record.solarradiation,
          record.solarenergy,
          record.uvindex,
          isForecast ? 1 : 0,
          'visual_crossing_api'
        );

        if (result.changes > 0) {
          inserted++;
        } else {
          skipped++;  // Historical data was protected
        }
      }
    });

    transaction();
    return { inserted, skipped };
  }

  /**
   * Get weather data for a location and date range, formatted for the weather parser
   * Returns data grouped by location with records array
   * NOTE: Uses LOWER(location) match to support zonal mode where we need city-specific data
   */
  getWeatherDataForParser(location: string, startDate: string, endDate: string): {
    city: string;
    records: RawWeatherData[];
    startDate: Date;
    endDate: Date;
  } | null {
    // Query by exact location name (case-insensitive) to support zonal mode
    // where multiple cities map to the same region code
    const rows = this.db.prepare(`
      SELECT * FROM weather_records
      WHERE LOWER(location) = LOWER(?)
        AND datetime >= ?
        AND datetime <= ?
      ORDER BY datetime
    `).all(location, startDate + 'T00:00:00', endDate + 'T23:59:59') as any[];

    if (rows.length === 0) return null;

    const records: RawWeatherData[] = rows.map(row => ({
      name: row.location,
      latitude: 0,
      longitude: 0,
      datetime: row.datetime,
      temp: row.temp,
      dew: row.dew,
      precip: row.precip,
      windgust: row.windgust,
      windspeed: row.windspeed,
      cloudcover: row.cloudcover,
      solarradiation: row.solarradiation,
      solarenergy: row.solarenergy,
      uvindex: row.uvindex
    }));

    return {
      city: rows[0].location,
      records,
      startDate: new Date(rows[0].datetime),
      endDate: new Date(rows[rows.length - 1].datetime)
    };
  }

  /**
   * Get aggregated daily weather data for a specific date and region
   * Used for outage probability forecasting
   */
  getWeatherForDateRegion(date: string, region: GridRegion): {
    temp: number;
    tempMax: number;
    tempMin: number;
    precip: number;
    windspeed: number;
    windgust: number;
    cloudcover: number;
    solarradiation: number;
  } | null {
    const row = this.db.prepare(`
      SELECT
        AVG(temp) as temp,
        MAX(temp) as temp_max,
        MIN(temp) as temp_min,
        SUM(precip) as precip,
        AVG(windspeed) as windspeed,
        MAX(windgust) as windgust,
        AVG(cloudcover) as cloudcover,
        AVG(solarradiation) as solarradiation
      FROM weather_records
      WHERE region = ?
        AND datetime >= ?
        AND datetime < ?
    `).get(region, date + 'T00:00:00', date + 'T23:59:59') as any;

    if (!row || row.temp === null) return null;

    return {
      temp: row.temp,
      tempMax: row.temp_max,
      tempMin: row.temp_min,
      precip: row.precip || 0,
      windspeed: row.windspeed || 0,
      windgust: row.windgust || 0,
      cloudcover: row.cloudcover || 0,
      solarradiation: row.solarradiation || 0
    };
  }

  // ============ MODELS ============

  saveModel(
    name: string,
    modelType: 'regression' | 'xgboost',
    trainingStart: string,
    trainingEnd: string,
    trainingSamples: number,
    r2Score: number,
    mape: number,
    rmse: number,
    mae: number,
    coefficients: number[],
    featureNames: string[],
    notes?: string
  ): number {
    // Deactivate previous models of same type
    this.db.prepare('UPDATE models SET is_active = 0 WHERE model_type = ?').run(modelType);

    const stmt = this.db.prepare(`
      INSERT INTO models (name, model_type, training_start, training_end, training_samples, r2_score, mape, rmse, mae, coefficients, feature_names, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      name,
      modelType,
      trainingStart,
      trainingEnd,
      trainingSamples,
      r2Score,
      mape,
      rmse,
      mae,
      JSON.stringify(coefficients),
      JSON.stringify(featureNames),
      notes || null
    );

    return result.lastInsertRowid as number;
  }

  getActiveModel(modelType: 'regression' | 'xgboost'): StoredModel | null {
    const row = this.db.prepare(`
      SELECT * FROM models WHERE model_type = ? AND is_active = 1 ORDER BY created_at DESC LIMIT 1
    `).get(modelType) as any;

    if (!row) return null;

    return {
      id: row.id,
      name: row.name,
      modelType: row.model_type,
      createdAt: row.created_at,
      trainingStart: row.training_start,
      trainingEnd: row.training_end,
      trainingSamples: row.training_samples,
      r2Score: row.r2_score,
      mape: row.mape,
      rmse: row.rmse,
      mae: row.mae,
      coefficients: JSON.parse(row.coefficients),
      featureNames: JSON.parse(row.feature_names),
      isActive: row.is_active === 1,
      notes: row.notes
    };
  }

  getAllModels(): StoredModel[] {
    const rows = this.db.prepare('SELECT * FROM models ORDER BY created_at DESC').all() as any[];
    return rows.map(row => ({
      id: row.id,
      name: row.name,
      modelType: row.model_type,
      createdAt: row.created_at,
      trainingStart: row.training_start,
      trainingEnd: row.training_end,
      trainingSamples: row.training_samples,
      r2Score: row.r2_score,
      mape: row.mape,
      rmse: row.rmse,
      mae: row.mae,
      coefficients: JSON.parse(row.coefficients),
      featureNames: JSON.parse(row.feature_names),
      isActive: row.is_active === 1,
      notes: row.notes
    }));
  }

  activateModel(modelId: number): void {
    const model = this.db.prepare('SELECT model_type FROM models WHERE id = ?').get(modelId) as any;
    if (!model) throw new Error(`Model ${modelId} not found`);

    this.db.prepare('UPDATE models SET is_active = 0 WHERE model_type = ?').run(model.model_type);
    this.db.prepare('UPDATE models SET is_active = 1 WHERE id = ?').run(modelId);
  }

  // ============ OUTAGE RECORDS ============

  /**
   * Import outage records into the database
   */
  importOutageRecords(records: OutageRecord[], sourceFile?: string): { inserted: number; updated: number } {
    const insertStmt = this.db.prepare(`
      INSERT INTO outage_records (
        event_id, unit_id, site_id, region, fuel_type, outage_type,
        start_time, end_time, duration_minutes, capacity_mw, capacity_lost_mw,
        severity, time_period, day_of_week, hour, month, is_weekend, source_file
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(event_id, unit_id, start_time) DO UPDATE SET
        end_time = excluded.end_time,
        duration_minutes = excluded.duration_minutes,
        capacity_mw = excluded.capacity_mw,
        capacity_lost_mw = excluded.capacity_lost_mw,
        severity = excluded.severity,
        imported_at = CURRENT_TIMESTAMP
    `);

    let inserted = 0;
    let updated = 0;

    const transaction = this.db.transaction(() => {
      for (const record of records) {
        const result = insertStmt.run(
          record.eventId,
          record.unitId,
          record.siteId,
          record.region,
          record.fuelType,
          record.outageType,
          record.startTime.toISOString(),
          record.endTime.toISOString(),
          record.durationMinutes,
          record.capacityMW,
          record.capacityLostMW,
          record.severity,
          record.timePeriod,
          record.dayOfWeek,
          record.hour,
          record.month,
          record.isWeekend ? 1 : 0,
          sourceFile || null
        );
        if (result.changes > 0) {
          inserted++;
        }
      }
    });

    transaction();
    return { inserted, updated };
  }

  /**
   * Get outage records from database
   */
  getOutageRecords(options?: {
    startDate?: string;
    endDate?: string;
    region?: GridRegion;
    outageType?: OutageType;
    unitId?: string;
  }): OutageRecord[] {
    let sql = 'SELECT * FROM outage_records WHERE 1=1';
    const params: any[] = [];

    if (options?.startDate) {
      sql += ' AND start_time >= ?';
      params.push(options.startDate);
    }
    if (options?.endDate) {
      sql += ' AND start_time <= ?';
      params.push(options.endDate);
    }
    if (options?.region) {
      sql += ' AND region = ?';
      params.push(options.region);
    }
    if (options?.outageType) {
      sql += ' AND outage_type = ?';
      params.push(options.outageType);
    }
    if (options?.unitId) {
      sql += ' AND unit_id = ?';
      params.push(options.unitId);
    }

    sql += ' ORDER BY start_time DESC';

    const rows = this.db.prepare(sql).all(...params) as any[];
    return rows.map(row => ({
      eventId: row.event_id,
      unitId: row.unit_id,
      siteId: row.site_id,
      region: row.region as GridRegion,
      fuelType: row.fuel_type,
      outageType: row.outage_type as OutageType,
      startTime: new Date(row.start_time),
      endTime: new Date(row.end_time),
      durationMinutes: row.duration_minutes,
      capacityMW: row.capacity_mw,
      capacityLostMW: row.capacity_lost_mw,
      severity: row.severity,
      timePeriod: row.time_period,
      dayOfWeek: row.day_of_week,
      hour: row.hour,
      month: row.month,
      isWeekend: row.is_weekend === 1
    }));
  }

  /**
   * Get outage statistics summary
   */
  getOutageStats(): {
    total: number;
    planned: number;
    unplanned: number;
    byRegion: Record<string, number>;
    byFuelType: Record<string, number>;
    dateRange: { start: string | null; end: string | null };
    uniqueUnits: number;
  } {
    const total = (this.db.prepare('SELECT COUNT(*) as count FROM outage_records').get() as any).count;
    const planned = (this.db.prepare("SELECT COUNT(*) as count FROM outage_records WHERE outage_type = 'planned'").get() as any).count;
    const unplanned = (this.db.prepare("SELECT COUNT(*) as count FROM outage_records WHERE outage_type = 'unplanned'").get() as any).count;

    const regionRows = this.db.prepare('SELECT region, COUNT(*) as count FROM outage_records GROUP BY region').all() as any[];
    const byRegion: Record<string, number> = {};
    for (const row of regionRows) {
      byRegion[row.region] = row.count;
    }

    const fuelRows = this.db.prepare('SELECT fuel_type, COUNT(*) as count FROM outage_records GROUP BY fuel_type').all() as any[];
    const byFuelType: Record<string, number> = {};
    for (const row of fuelRows) {
      byFuelType[row.fuel_type] = row.count;
    }

    const dateRange = this.db.prepare('SELECT MIN(start_time) as start, MAX(end_time) as end FROM outage_records').get() as any;
    const uniqueUnits = (this.db.prepare('SELECT COUNT(DISTINCT unit_id) as count FROM outage_records').get() as any).count;

    return {
      total,
      planned,
      unplanned,
      byRegion,
      byFuelType,
      dateRange: { start: dateRange.start, end: dateRange.end },
      uniqueUnits
    };
  }

  /**
   * Save an outage probability model
   */
  saveOutageModel(
    name: string,
    trainingStart: string,
    trainingEnd: string,
    totalOutages: number,
    plannedOutages: number,
    unplannedOutages: number,
    modelData: OutageProbabilityModel,
    notes?: string
  ): number {
    // Deactivate previous models
    this.db.prepare('UPDATE outage_models SET is_active = 0').run();

    const stmt = this.db.prepare(`
      INSERT INTO outage_models (name, training_start, training_end, total_outages, planned_outages, unplanned_outages, model_data, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      name,
      trainingStart,
      trainingEnd,
      totalOutages,
      plannedOutages,
      unplannedOutages,
      JSON.stringify(modelData),
      notes || null
    );

    return result.lastInsertRowid as number;
  }

  /**
   * Get the active outage probability model
   */
  getActiveOutageModel(): { id: number; name: string; modelData: OutageProbabilityModel; createdAt: string } | null {
    const row = this.db.prepare('SELECT * FROM outage_models WHERE is_active = 1 ORDER BY created_at DESC LIMIT 1').get() as any;
    if (!row) return null;

    return {
      id: row.id,
      name: row.name,
      modelData: JSON.parse(row.model_data),
      createdAt: row.created_at
    };
  }

  /**
   * Clear all outage records (for reimport)
   */
  clearOutageRecords(): void {
    this.db.exec('DELETE FROM outage_records');
  }

  /**
   * Update unit metadata from outage records
   */
  updateUnitMetadata(unitId: string, siteId: string, region: GridRegion, fuelType: string, capacityMW: number): void {
    this.db.prepare(`
      INSERT INTO unit_metadata (unit_id, site_id, region, fuel_type, capacity_mw)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(unit_id) DO UPDATE SET
        site_id = excluded.site_id,
        region = excluded.region,
        fuel_type = excluded.fuel_type,
        capacity_mw = MAX(unit_metadata.capacity_mw, excluded.capacity_mw),
        updated_at = CURRENT_TIMESTAMP
    `).run(unitId, siteId, region, fuelType, capacityMW);
  }

  /**
   * Get unit metadata
   */
  getUnitMetadata(unitId: string): { unitId: string; siteId: string; region: GridRegion; fuelType: string; capacityMW: number } | null {
    const row = this.db.prepare('SELECT * FROM unit_metadata WHERE unit_id = ?').get(unitId) as any;
    if (!row) return null;

    return {
      unitId: row.unit_id,
      siteId: row.site_id,
      region: row.region as GridRegion,
      fuelType: row.fuel_type,
      capacityMW: row.capacity_mw
    };
  }

  // ============ INTERCONNECTOR RECORDS ============

  /**
   * Import interconnector records from RTDHS data
   */
  importInterconnectorRecords(
    records: InterconnectorRecord[],
    sourceFile?: string
  ): { inserted: number; updated: number } {
    const insertStmt = this.db.prepare(`
      INSERT INTO interconnector_records
      (datetime, run_time, market_type, interconnector_name, congestion_flag, flow_from, flow_to, overload_mw, source_file)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(datetime, run_time, interconnector_name) DO UPDATE SET
        congestion_flag = excluded.congestion_flag,
        flow_from = excluded.flow_from,
        flow_to = excluded.flow_to,
        overload_mw = excluded.overload_mw,
        source_file = excluded.source_file,
        imported_at = CURRENT_TIMESTAMP
    `);

    let inserted = 0;

    const transaction = this.db.transaction(() => {
      for (const record of records) {
        const datetimeStr = DateTime.fromJSDate(record.timeInterval).toISO();
        const runTimeStr = DateTime.fromJSDate(record.runTime).toISO();

        insertStmt.run(
          datetimeStr,
          runTimeStr,
          record.marketType,
          record.hvdcName,
          record.congestionFlag,
          record.flowFrom,
          record.flowTo,
          record.overloadMW,
          sourceFile || null
        );
        inserted++;
      }
    });

    transaction();
    return { inserted, updated: 0 };
  }

  /**
   * Get interconnector records from database
   */
  getInterconnectorRecords(
    startDate?: string,
    endDate?: string,
    interconnector?: string
  ): InterconnectorRecord[] {
    let sql = 'SELECT * FROM interconnector_records WHERE 1=1';
    const params: any[] = [];

    if (startDate) {
      sql += ' AND datetime >= ?';
      params.push(startDate);
    }
    if (endDate) {
      sql += ' AND datetime <= ?';
      params.push(endDate);
    }
    if (interconnector) {
      sql += ' AND interconnector_name = ?';
      params.push(interconnector);
    }

    sql += ' ORDER BY datetime, interconnector_name';

    const rows = this.db.prepare(sql).all(...params) as any[];
    return rows.map(row => ({
      runTime: new Date(row.run_time),
      marketType: row.market_type,
      timeInterval: new Date(row.datetime),
      hvdcName: row.interconnector_name,
      congestionFlag: row.congestion_flag as 'Y' | 'N',
      flowFrom: row.flow_from,
      flowTo: row.flow_to,
      overloadMW: row.overload_mw,
      sourceFile: row.source_file
    }));
  }

  /**
   * Get interconnector statistics
   */
  getInterconnectorStats(
    interconnector?: string,
    startDate?: string,
    endDate?: string
  ): InterconnectorStats[] {
    let sql = `
      SELECT
        interconnector_name,
        COUNT(*) as total_records,
        SUM(CASE WHEN congestion_flag = 'Y' THEN 1 ELSE 0 END) as congestion_events,
        AVG(flow_from) as avg_flow_from,
        AVG(flow_to) as avg_flow_to,
        MAX(flow_from) as peak_flow_from,
        MIN(flow_to) as peak_flow_to,
        MIN(datetime) as start_date,
        MAX(datetime) as end_date
      FROM interconnector_records
      WHERE 1=1
    `;
    const params: any[] = [];

    if (startDate) {
      sql += ' AND datetime >= ?';
      params.push(startDate);
    }
    if (endDate) {
      sql += ' AND datetime <= ?';
      params.push(endDate);
    }
    if (interconnector) {
      sql += ' AND interconnector_name = ?';
      params.push(interconnector);
    }

    sql += ' GROUP BY interconnector_name';

    const rows = this.db.prepare(sql).all(...params) as any[];

    return rows.map(row => ({
      interconnector: row.interconnector_name,
      totalRecords: row.total_records,
      congestionEvents: row.congestion_events,
      congestionRate: row.total_records > 0 ? row.congestion_events / row.total_records : 0,
      avgFlowFrom: row.avg_flow_from,
      avgFlowTo: row.avg_flow_to,
      peakFlowFrom: row.peak_flow_from,
      peakFlowTo: row.peak_flow_to,
      flowVolatility: 0,  // Calculate separately if needed
      dateRange: {
        start: row.start_date,
        end: row.end_date
      }
    }));
  }

  /**
   * Save interconnector congestion prediction model
   */
  saveInterconnectorModel(
    name: string,
    trainingStart: string,
    trainingEnd: string,
    trainingSamples: number,
    metrics: InterconnectorModelMetrics,
    modelData: string,
    modelType: string = 'regression',
    trainingTimeMs?: number
  ): number {
    // Deactivate previous models of the same type
    this.db.prepare('UPDATE interconnector_models SET is_active = 0 WHERE model_type = ?').run(modelType);

    const stmt = this.db.prepare(`
      INSERT INTO interconnector_models
      (name, model_type, training_start, training_end, training_samples,
       accuracy, precision, recall, f1_score, r2_score, mape, mae, rmse,
       training_time_ms, model_data, is_active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `);

    const result = stmt.run(
      name,
      modelType,
      trainingStart,
      trainingEnd,
      trainingSamples,
      metrics.accuracy,
      metrics.precision,
      metrics.recall,
      metrics.f1Score,
      metrics.r2Score,
      metrics.mape,
      metrics.mae,
      metrics.rmse,
      trainingTimeMs || 0,
      modelData
    );

    return result.lastInsertRowid as number;
  }

  /**
   * Get the active interconnector model
   */
  getActiveInterconnectorModel(modelType?: string): any | null {
    let query = `
      SELECT * FROM interconnector_models
      WHERE is_active = 1
    `;

    if (modelType) {
      query += ` AND model_type = ?`;
    }

    query += ` ORDER BY created_at DESC LIMIT 1`;

    const row = modelType
      ? this.db.prepare(query).get(modelType) as any
      : this.db.prepare(query).get() as any;

    if (!row) return null;

    return {
      id: row.id,
      name: row.name,
      modelType: row.model_type || 'regression',
      trainingStart: row.training_start,
      trainingEnd: row.training_end,
      trainingSamples: row.training_samples,
      accuracy: row.accuracy,
      precision: row.precision,
      recall: row.recall,
      f1Score: row.f1_score,
      r2Score: row.r2_score,
      mape: row.mape,
      mae: row.mae,
      rmse: row.rmse,
      trainingTimeMs: row.training_time_ms,
      modelData: row.model_data
    };
  }

  /**
   * Get all interconnector models
   */
  getAllInterconnectorModels(): any[] {
    const rows = this.db.prepare(`
      SELECT * FROM interconnector_models
      ORDER BY created_at DESC
    `).all() as any[];

    return rows.map(row => ({
      id: row.id,
      name: row.name,
      modelType: row.model_type || 'regression',
      trainingStart: row.training_start,
      trainingEnd: row.training_end,
      trainingSamples: row.training_samples,
      accuracy: row.accuracy,
      precision: row.precision,
      recall: row.recall,
      f1Score: row.f1_score,
      r2Score: row.r2_score,
      mape: row.mape,
      mae: row.mae,
      rmse: row.rmse,
      trainingTimeMs: row.training_time_ms,
      isActive: row.is_active === 1,
      createdAt: row.created_at
    }));
  }

  /**
   * Initialize interconnector metadata (called during schema setup)
   */
  initializeInterconnectorMetadata(): void {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO interconnector_metadata (name, from_region, to_region, capacity_mw, notes)
      VALUES (?, ?, ?, ?, ?)
    `);

    stmt.run('MINVIS1', 'CMIN', 'CVIS', 450, 'Mindanao-Visayas HVDC');
    stmt.run('VISLUZ1', 'CVIS', 'CLUZ', 420, 'Visayas-Luzon HVDC');
  }

  // ============ STATS ============

  getStats(): DatabaseStats {
    const demandCount = (this.db.prepare('SELECT COUNT(*) as count FROM demand_records').get() as any).count;
    const weatherCount = (this.db.prepare('SELECT COUNT(*) as count FROM weather_records').get() as any).count;
    const modelCount = (this.db.prepare('SELECT COUNT(*) as count FROM models').get() as any).count;

    const demandRange = this.db.prepare('SELECT MIN(datetime) as start, MAX(datetime) as end FROM demand_records').get() as any;
    const weatherRange = this.db.prepare('SELECT MIN(datetime) as start, MAX(datetime) as end FROM weather_records').get() as any;

    const regions = (this.db.prepare('SELECT DISTINCT region FROM demand_records ORDER BY region').all() as any[]).map(r => r.region);

    return {
      demandRecords: demandCount,
      weatherRecords: weatherCount,
      models: modelCount,
      demandDateRange: { start: demandRange.start, end: demandRange.end },
      weatherDateRange: { start: weatherRange.start, end: weatherRange.end },
      regions
    };
  }

  // ============ UTILITIES ============

  close(): void {
    this.db.close();
  }

  getPath(): string {
    return this.dbPath;
  }

  vacuum(): void {
    this.db.exec('VACUUM');
  }

  clearAll(): void {
    this.db.exec('DELETE FROM demand_records');
    this.db.exec('DELETE FROM weather_records');
    this.db.exec('DELETE FROM models');
    this.db.exec('DELETE FROM training_runs');
    this.vacuum();
  }

  // ============ MREC FACTORS (Wind Capacity Factor) ============

  /**
   * Save or update MREC factors for a wind station
   */
  saveMRECFactors(factors: MRECFactors): void {
    const stmt = this.db.prepare(`
      INSERT INTO mrec_factors
      (station_code, station_type, mrec_h, mrec_m, mrec_l, v_h, v_l, calibrated, calibration_date, sample_count, stats)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(station_code) DO UPDATE SET
        station_type = excluded.station_type,
        mrec_h = excluded.mrec_h,
        mrec_m = excluded.mrec_m,
        mrec_l = excluded.mrec_l,
        v_h = excluded.v_h,
        v_l = excluded.v_l,
        calibrated = excluded.calibrated,
        calibration_date = excluded.calibration_date,
        sample_count = excluded.sample_count,
        stats = excluded.stats,
        updated_at = CURRENT_TIMESTAMP
    `);

    stmt.run(
      factors.stationCode,
      factors.stationType,
      factors.MRecH,
      factors.MRecM,
      factors.MRecL,
      factors.vH,
      factors.vL,
      factors.calibrated ? 1 : 0,
      factors.calibrationDate?.toISOString() || null,
      factors.sampleCount || null,
      factors.stats ? JSON.stringify(factors.stats) : null
    );
  }

  /**
   * Get MREC factors for a station
   */
  getMRECFactors(stationCode: string): MRECFactors | null {
    const row = this.db.prepare(`
      SELECT * FROM mrec_factors WHERE station_code = ?
    `).get(stationCode) as any;

    if (!row) return null;

    return {
      stationCode: row.station_code,
      stationType: row.station_type,
      MRecH: row.mrec_h,
      MRecM: row.mrec_m,
      MRecL: row.mrec_l,
      vH: row.v_h,
      vL: row.v_l,
      calibrated: row.calibrated === 1,
      calibrationDate: row.calibration_date ? new Date(row.calibration_date) : undefined,
      sampleCount: row.sample_count,
      stats: row.stats ? JSON.parse(row.stats) : undefined
    };
  }

  /**
   * Get all MREC factors
   */
  getAllMRECFactors(): MRECFactors[] {
    const rows = this.db.prepare(`
      SELECT * FROM mrec_factors ORDER BY station_code
    `).all() as any[];

    return rows.map(row => ({
      stationCode: row.station_code,
      stationType: row.station_type,
      MRecH: row.mrec_h,
      MRecM: row.mrec_m,
      MRecL: row.mrec_l,
      vH: row.v_h,
      vL: row.v_l,
      calibrated: row.calibrated === 1,
      calibrationDate: row.calibration_date ? new Date(row.calibration_date) : undefined,
      sampleCount: row.sample_count,
      stats: row.stats ? JSON.parse(row.stats) : undefined
    }));
  }

  /**
   * Get calibrated MREC factors only
   */
  getCalibratedMRECFactors(): MRECFactors[] {
    const rows = this.db.prepare(`
      SELECT * FROM mrec_factors WHERE calibrated = 1 ORDER BY station_code
    `).all() as any[];

    return rows.map(row => ({
      stationCode: row.station_code,
      stationType: row.station_type,
      MRecH: row.mrec_h,
      MRecM: row.mrec_m,
      MRecL: row.mrec_l,
      vH: row.v_h,
      vL: row.v_l,
      calibrated: true,
      calibrationDate: row.calibration_date ? new Date(row.calibration_date) : undefined,
      sampleCount: row.sample_count,
      stats: row.stats ? JSON.parse(row.stats) : undefined
    }));
  }

  /**
   * Delete MREC factors for a station
   */
  deleteMRECFactors(stationCode: string): void {
    this.db.prepare('DELETE FROM mrec_factors WHERE station_code = ?').run(stationCode);
  }

  /**
   * Clear all MREC factors
   */
  clearMRECFactors(): void {
    this.db.exec('DELETE FROM mrec_factors');
  }

  // ============ WIND CFAC HISTORY ============

  /**
   * Import wind capacity factor history for MREC calibration
   */
  importWindCFacHistory(
    data: MRECCalibrationData[],
    sourceFile?: string
  ): { inserted: number; updated: number } {
    const stmt = this.db.prepare(`
      INSERT INTO wind_cfac_history
      (datetime, station_code, capacity_factor, wind_speed, wind_speed_100, source_file)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(datetime, station_code) DO UPDATE SET
        capacity_factor = excluded.capacity_factor,
        wind_speed = excluded.wind_speed,
        wind_speed_100 = excluded.wind_speed_100,
        source_file = excluded.source_file,
        imported_at = CURRENT_TIMESTAMP
    `);

    let inserted = 0;

    const transaction = this.db.transaction(() => {
      for (const record of data) {
        const dtStr = DateTime.fromJSDate(record.datetime).toISO();
        stmt.run(
          dtStr,
          record.stationCode,
          record.capacityFactor,
          record.windSpeed,
          record.windSpeed,  // Use same value for 100m if not provided separately
          sourceFile || null
        );
        inserted++;
      }
    });

    transaction();
    return { inserted, updated: 0 };
  }

  /**
   * Get wind capacity factor history for calibration
   */
  getWindCFacHistory(
    stationCode?: string,
    startDate?: string,
    endDate?: string
  ): MRECCalibrationData[] {
    let sql = 'SELECT * FROM wind_cfac_history WHERE 1=1';
    const params: any[] = [];

    if (stationCode) {
      sql += ' AND station_code = ?';
      params.push(stationCode);
    }
    if (startDate) {
      sql += ' AND datetime >= ?';
      params.push(startDate);
    }
    if (endDate) {
      sql += ' AND datetime <= ?';
      params.push(endDate);
    }

    sql += ' ORDER BY datetime, station_code';

    const rows = this.db.prepare(sql).all(...params) as any[];
    return rows.map(row => ({
      datetime: new Date(row.datetime),
      stationCode: row.station_code,
      capacityFactor: row.capacity_factor,
      windSpeed: row.wind_speed_100 || row.wind_speed
    }));
  }

  /**
   * Get wind stations with historical data
   */
  getWindStationsWithHistory(): string[] {
    const rows = this.db.prepare(`
      SELECT DISTINCT station_code FROM wind_cfac_history ORDER BY station_code
    `).all() as any[];
    return rows.map(r => r.station_code);
  }

  /**
   * Get wind capacity factor history statistics
   */
  getWindCFacHistoryStats(): {
    totalRecords: number;
    stations: number;
    dateRange: { start: string | null; end: string | null };
    byStation: { stationCode: string; count: number; avgCF: number }[];
  } {
    const total = (this.db.prepare('SELECT COUNT(*) as count FROM wind_cfac_history').get() as any).count;
    const stations = (this.db.prepare('SELECT COUNT(DISTINCT station_code) as count FROM wind_cfac_history').get() as any).count;
    const dateRange = this.db.prepare('SELECT MIN(datetime) as start, MAX(datetime) as end FROM wind_cfac_history').get() as any;

    const byStation = this.db.prepare(`
      SELECT station_code, COUNT(*) as count, AVG(capacity_factor) as avg_cf
      FROM wind_cfac_history
      GROUP BY station_code
      ORDER BY station_code
    `).all() as any[];

    return {
      totalRecords: total,
      stations,
      dateRange: { start: dateRange?.start || null, end: dateRange?.end || null },
      byStation: byStation.map(r => ({
        stationCode: r.station_code,
        count: r.count,
        avgCF: r.avg_cf
      }))
    };
  }

  /**
   * Clear wind capacity factor history
   */
  clearWindCFacHistory(stationCode?: string): void {
    if (stationCode) {
      this.db.prepare('DELETE FROM wind_cfac_history WHERE station_code = ?').run(stationCode);
    } else {
      this.db.exec('DELETE FROM wind_cfac_history');
    }
  }

  // ============ CAPACITY FACTOR RECORDS (All station types) ============

  /**
   * Import capacity factor records from parsed CSV
   * Used for training CFAC models from database
   * Uses batch processing to handle large datasets (600k+ records)
   */
  importCfacRecords(
    records: Array<{
      datetime: Date | string;
      stationCode: string;
      capacityFactor: number;
      stationType?: string;
    }>,
    sourceFile?: string
  ): { inserted: number; updated: number } {
    let inserted = 0;
    let updated = 0;

    const insert = this.db.prepare(`
      INSERT INTO cfac_records (datetime, station_code, station_type, capacity_factor, source_file)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(datetime, station_code) DO UPDATE SET
        capacity_factor = excluded.capacity_factor,
        station_type = excluded.station_type,
        source_file = excluded.source_file
    `);

    // Process in batches to avoid stack overflow with large datasets
    const BATCH_SIZE = 10000;
    const totalBatches = Math.ceil(records.length / BATCH_SIZE);

    for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
      const start = batchIndex * BATCH_SIZE;
      const end = Math.min(start + BATCH_SIZE, records.length);
      const batch = records.slice(start, end);

      const transaction = this.db.transaction(() => {
        for (const record of batch) {
          const datetime = record.datetime instanceof Date
            ? DateTime.fromJSDate(record.datetime).toISO()
            : record.datetime;

          const result = insert.run(
            datetime,
            record.stationCode,
            record.stationType || null,
            record.capacityFactor,
            sourceFile || null
          );

          if (result.changes > 0) {
            inserted++;
          }
        }
      });

      transaction();
    }

    return { inserted, updated };
  }

  /**
   * Get capacity factor records for training/calibration
   */
  getCfacRecords(
    startDate?: string,
    endDate?: string,
    stationCode?: string,
    stationType?: string
  ): Array<{
    datetime: Date;
    stationCode: string;
    stationType: string | null;
    capacityFactor: number;
  }> {
    let sql = 'SELECT * FROM cfac_records WHERE 1=1';
    const params: any[] = [];

    if (startDate) {
      sql += ' AND datetime >= ?';
      params.push(startDate);
    }
    if (endDate) {
      sql += ' AND datetime <= ?';
      params.push(endDate);
    }
    if (stationCode) {
      sql += ' AND station_code = ?';
      params.push(stationCode);
    }
    if (stationType) {
      sql += ' AND station_type = ?';
      params.push(stationType);
    }

    sql += ' ORDER BY datetime, station_code';

    const rows = this.db.prepare(sql).all(...params) as any[];
    return rows.map(row => ({
      datetime: new Date(row.datetime),
      stationCode: row.station_code,
      stationType: row.station_type,
      capacityFactor: row.capacity_factor
    }));
  }

  /**
   * Get unique station codes from CFAC records
   */
  getCfacStations(): string[] {
    const rows = this.db.prepare(`
      SELECT DISTINCT station_code FROM cfac_records ORDER BY station_code
    `).all() as any[];
    return rows.map(r => r.station_code);
  }

  /**
   * Get CFAC records statistics
   */
  getCfacStats(): {
    totalRecords: number;
    stations: number;
    dateRange: { start: string | null; end: string | null };
    byType: { type: string; count: number }[];
  } {
    const total = (this.db.prepare('SELECT COUNT(*) as count FROM cfac_records').get() as any).count;
    const stations = (this.db.prepare('SELECT COUNT(DISTINCT station_code) as count FROM cfac_records').get() as any).count;
    const dateRange = this.db.prepare('SELECT MIN(datetime) as start, MAX(datetime) as end FROM cfac_records').get() as any;

    const byType = this.db.prepare(`
      SELECT station_type as type, COUNT(*) as count
      FROM cfac_records
      WHERE station_type IS NOT NULL
      GROUP BY station_type
      ORDER BY station_type
    `).all() as any[];

    return {
      totalRecords: total,
      stations,
      dateRange: { start: dateRange?.start || null, end: dateRange?.end || null },
      byType: byType.map(r => ({
        type: r.type || 'unknown',
        count: r.count
      }))
    };
  }

  /**
   * Clear CFAC records
   */
  clearCfacRecords(stationCode?: string, stationType?: string): void {
    if (stationCode) {
      this.db.prepare('DELETE FROM cfac_records WHERE station_code = ?').run(stationCode);
    } else if (stationType) {
      this.db.prepare('DELETE FROM cfac_records WHERE station_type = ?').run(stationType);
    } else {
      this.db.exec('DELETE FROM cfac_records');
    }
  }

  // ============ CLUSTER WEATHER (Capacity Factor) ============

  /**
   * Import cluster weather data from parsed CSV
   * Automatically routes to historical or forecast table based on date
   * Archives existing forecast data before overwriting
   *
   * @param records - Array of cluster weather records
   * @param locationId - Cluster/station ID (e.g., 'SOLAR_01BOTOLAN', 'WIND_01BURGOS')
   * @param fetchedAt - When this data was fetched (ISO string)
   * @param source - Data source identifier
   */
  importClusterWeather(
    records: Array<{
      datetime: string;
      temp?: number;
      dew?: number;
      humidity?: number;
      precip?: number;
      precipprob?: number;
      pressure?: number;
      windgust?: number;
      windspeed?: number;
      winddir?: number;
      windspeed50?: number;
      winddir50?: number;
      windspeed80?: number;
      winddir80?: number;
      windspeed100?: number;
      winddir100?: number;
      cloudcover?: number;
      visibility?: number;
      solarradiation?: number;
      solarenergy?: number;
      uvindex?: number;
      dniradiation?: number;
      difradiation?: number;
      ghiradiation?: number;
      conditions?: string;
    }>,
    locationId: string,
    fetchedAt: string,
    source: string = 'api'
  ): { historical: number; forecast: number; archived: number } {
    const today = DateTime.now().startOf('day');
    let historicalCount = 0;
    let forecastCount = 0;
    let archivedCount = 0;

    // Prepare statements
    const insertHistorical = this.db.prepare(`
      INSERT INTO cluster_weather_historical (
        location_id, datetime, temp, dew, humidity, precip, precipprob, pressure,
        windgust, windspeed, winddir, windspeed50, winddir50, windspeed80, winddir80,
        windspeed100, winddir100, cloudcover, visibility, solarradiation, solarenergy,
        uvindex, dniradiation, difradiation, ghiradiation, conditions, source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(location_id, datetime) DO NOTHING
    `);

    const selectExistingForecast = this.db.prepare(`
      SELECT * FROM cluster_weather_forecast WHERE location_id = ? AND datetime = ?
    `);

    const insertArchive = this.db.prepare(`
      INSERT INTO cluster_weather_forecast_archive (
        location_id, datetime, fetched_at, lead_time_hours,
        temp, dew, humidity, precip, precipprob, pressure,
        windgust, windspeed, winddir, windspeed50, winddir50, windspeed80, winddir80,
        windspeed100, winddir100, cloudcover, visibility, solarradiation, solarenergy,
        uvindex, dniradiation, difradiation, ghiradiation, conditions, source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const deleteForecasRecord = this.db.prepare(`
      DELETE FROM cluster_weather_forecast WHERE location_id = ? AND datetime = ?
    `);

    const insertForecast = this.db.prepare(`
      INSERT INTO cluster_weather_forecast (
        location_id, datetime, fetched_at,
        temp, dew, humidity, precip, precipprob, pressure,
        windgust, windspeed, winddir, windspeed50, winddir50, windspeed80, winddir80,
        windspeed100, winddir100, cloudcover, visibility, solarradiation, solarenergy,
        uvindex, dniradiation, difradiation, ghiradiation, conditions, source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(location_id, datetime) DO UPDATE SET
        fetched_at = excluded.fetched_at,
        temp = excluded.temp, dew = excluded.dew, humidity = excluded.humidity,
        precip = excluded.precip, precipprob = excluded.precipprob, pressure = excluded.pressure,
        windgust = excluded.windgust, windspeed = excluded.windspeed, winddir = excluded.winddir,
        windspeed50 = excluded.windspeed50, winddir50 = excluded.winddir50,
        windspeed80 = excluded.windspeed80, winddir80 = excluded.winddir80,
        windspeed100 = excluded.windspeed100, winddir100 = excluded.winddir100,
        cloudcover = excluded.cloudcover, visibility = excluded.visibility,
        solarradiation = excluded.solarradiation, solarenergy = excluded.solarenergy,
        uvindex = excluded.uvindex, dniradiation = excluded.dniradiation,
        difradiation = excluded.difradiation, ghiradiation = excluded.ghiradiation,
        conditions = excluded.conditions, source = excluded.source
    `);

    const transaction = this.db.transaction(() => {
      for (const record of records) {
        const recordDate = DateTime.fromISO(record.datetime.split('T')[0]);
        const isHistorical = recordDate < today;

        if (isHistorical) {
          // Archive any existing forecast record before replacing with historical data
          const existingForecast = selectExistingForecast.get(locationId, record.datetime) as any;
          if (existingForecast) {
            const existingFetchedAt = DateTime.fromISO(existingForecast.fetched_at);
            const targetTime = DateTime.fromISO(record.datetime);
            const leadTimeHours = Math.round(targetTime.diff(existingFetchedAt, 'hours').hours);

            insertArchive.run(
              locationId, record.datetime, existingForecast.fetched_at, leadTimeHours,
              existingForecast.temp, existingForecast.dew, existingForecast.humidity,
              existingForecast.precip, existingForecast.precipprob, existingForecast.pressure,
              existingForecast.windgust, existingForecast.windspeed, existingForecast.winddir,
              existingForecast.windspeed50, existingForecast.winddir50,
              existingForecast.windspeed80, existingForecast.winddir80,
              existingForecast.windspeed100, existingForecast.winddir100,
              existingForecast.cloudcover, existingForecast.visibility,
              existingForecast.solarradiation, existingForecast.solarenergy,
              existingForecast.uvindex, existingForecast.dniradiation,
              existingForecast.difradiation, existingForecast.ghiradiation,
              existingForecast.conditions, existingForecast.source
            );
            archivedCount++;

            // Remove the now-archived forecast record
            deleteForecasRecord.run(locationId, record.datetime);
          }

          // Historical data - insert into historical table (never overwrites)
          const result = insertHistorical.run(
            locationId, record.datetime,
            record.temp, record.dew, record.humidity, record.precip, record.precipprob, record.pressure,
            record.windgust, record.windspeed, record.winddir,
            record.windspeed50, record.winddir50, record.windspeed80, record.winddir80,
            record.windspeed100, record.winddir100,
            record.cloudcover, record.visibility, record.solarradiation, record.solarenergy,
            record.uvindex, record.dniradiation, record.difradiation, record.ghiradiation,
            record.conditions, source
          );
          if (result.changes > 0) historicalCount++;
        } else {
          // Forecast data - archive existing, then insert/update
          const existing = selectExistingForecast.get(locationId, record.datetime) as any;

          if (existing) {
            // Calculate lead time for the existing forecast before archiving
            const existingFetchedAt = DateTime.fromISO(existing.fetched_at);
            const targetTime = DateTime.fromISO(record.datetime);
            const leadTimeHours = Math.round(targetTime.diff(existingFetchedAt, 'hours').hours);

            // Archive the existing forecast
            insertArchive.run(
              locationId, record.datetime, existing.fetched_at, leadTimeHours,
              existing.temp, existing.dew, existing.humidity, existing.precip, existing.precipprob, existing.pressure,
              existing.windgust, existing.windspeed, existing.winddir,
              existing.windspeed50, existing.winddir50, existing.windspeed80, existing.winddir80,
              existing.windspeed100, existing.winddir100,
              existing.cloudcover, existing.visibility, existing.solarradiation, existing.solarenergy,
              existing.uvindex, existing.dniradiation, existing.difradiation, existing.ghiradiation,
              existing.conditions, existing.source
            );
            archivedCount++;
          }

          // Insert/update forecast
          insertForecast.run(
            locationId, record.datetime, fetchedAt,
            record.temp, record.dew, record.humidity, record.precip, record.precipprob, record.pressure,
            record.windgust, record.windspeed, record.winddir,
            record.windspeed50, record.winddir50, record.windspeed80, record.winddir80,
            record.windspeed100, record.winddir100,
            record.cloudcover, record.visibility, record.solarradiation, record.solarenergy,
            record.uvindex, record.dniradiation, record.difradiation, record.ghiradiation,
            record.conditions, source
          );
          forecastCount++;
        }
      }
    });

    transaction();
    return { historical: historicalCount, forecast: forecastCount, archived: archivedCount };
  }

  /**
   * Get cluster weather data for a location and date range
   * Automatically merges historical and forecast data
   * Historical data takes precedence over forecast for overlapping dates
   */
  getClusterWeather(
    locationId: string,
    startDate: string,
    endDate: string
  ): Array<{
    datetime: string;
    isHistorical: boolean;
    temp?: number;
    dew?: number;
    humidity?: number;
    precip?: number;
    windgust?: number;
    windspeed?: number;
    winddir?: number;
    windspeed50?: number;
    winddir50?: number;
    windspeed80?: number;
    winddir80?: number;
    windspeed100?: number;
    winddir100?: number;
    cloudcover?: number;
    visibility?: number;
    solarradiation?: number;
    solarenergy?: number;
    uvindex?: number;
    dniradiation?: number;
    difradiation?: number;
    ghiradiation?: number;
    conditions?: string;
    fetchedAt?: string;
  }> {
    // Get historical data
    const historical = this.db.prepare(`
      SELECT *, 1 as is_historical FROM cluster_weather_historical
      WHERE location_id = ? AND datetime >= ? AND datetime <= ?
    `).all(locationId, startDate + 'T00:00:00', endDate + 'T23:59:59') as any[];

    // Get forecast data
    const forecast = this.db.prepare(`
      SELECT *, 0 as is_historical FROM cluster_weather_forecast
      WHERE location_id = ? AND datetime >= ? AND datetime <= ?
    `).all(locationId, startDate + 'T00:00:00', endDate + 'T23:59:59') as any[];

    // Merge: historical takes precedence
    const historicalDatetimes = new Set(historical.map(r => r.datetime));
    const merged = [
      ...historical,
      ...forecast.filter(r => !historicalDatetimes.has(r.datetime))
    ];

    // Sort by datetime
    merged.sort((a, b) => a.datetime.localeCompare(b.datetime));

    return merged.map(r => ({
      datetime: r.datetime,
      isHistorical: r.is_historical === 1,
      temp: r.temp,
      dew: r.dew,
      humidity: r.humidity,
      precip: r.precip,
      windgust: r.windgust,
      windspeed: r.windspeed,
      winddir: r.winddir,
      windspeed50: r.windspeed50,
      winddir50: r.winddir50,
      windspeed80: r.windspeed80,
      winddir80: r.winddir80,
      windspeed100: r.windspeed100,
      winddir100: r.winddir100,
      cloudcover: r.cloudcover,
      visibility: r.visibility,
      solarradiation: r.solarradiation,
      solarenergy: r.solarenergy,
      uvindex: r.uvindex,
      dniradiation: r.dniradiation,
      difradiation: r.difradiation,
      ghiradiation: r.ghiradiation,
      conditions: r.conditions,
      fetchedAt: r.fetched_at
    }));
  }

  /**
   * Get dates that have stale forecast data (older than maxAgeHours)
   */
  getClusterStaleForecastDates(
    locationId: string,
    startDate: string,
    endDate: string,
    maxAgeHours: number = 24
  ): string[] {
    const cutoffTime = DateTime.now().minus({ hours: maxAgeHours }).toISO();

    const rows = this.db.prepare(`
      SELECT DISTINCT DATE(datetime) as date
      FROM cluster_weather_forecast
      WHERE location_id = ?
        AND datetime >= ?
        AND datetime <= ?
        AND fetched_at < ?
    `).all(locationId, startDate + 'T00:00:00', endDate + 'T23:59:59', cutoffTime) as any[];

    return rows.map(r => r.date);
  }

  /**
   * Get past dates that only have forecast data (need historical replacement)
   */
  getClusterDatesNeedingHistorical(
    locationId: string,
    startDate: string,
    endDate: string
  ): string[] {
    const today = DateTime.now().startOf('day').toISODate();

    // Find dates that:
    // 1. Are in the past (< today)
    // 2. Have forecast data but no historical data
    const rows = this.db.prepare(`
      SELECT DISTINCT DATE(f.datetime) as date
      FROM cluster_weather_forecast f
      LEFT JOIN cluster_weather_historical h
        ON f.location_id = h.location_id AND f.datetime = h.datetime
      WHERE f.location_id = ?
        AND f.datetime >= ?
        AND f.datetime <= ?
        AND DATE(f.datetime) < ?
        AND h.id IS NULL
    `).all(locationId, startDate + 'T00:00:00', endDate + 'T23:59:59', today) as any[];

    return rows.map(r => r.date);
  }

  /**
   * Get missing dates for cluster weather within a range
   * Returns dates that need to be fetched:
   * 1. No data at all
   * 2. Past dates with only forecast data (need historical)
   * 3. Future dates with stale forecast data (older than maxAgeHours)
   */
  getClusterMissingDates(
    locationId: string,
    startDate: string,
    endDate: string,
    maxForecastAgeHours: number = 24
  ): string[] {
    const today = DateTime.now().startOf('day');

    // Get dates that have ANY data (historical or forecast)
    const historicalDates = new Set(
      (this.db.prepare(`
        SELECT DISTINCT DATE(datetime) as date FROM cluster_weather_historical
        WHERE location_id = ? AND datetime >= ? AND datetime <= ?
      `).all(locationId, startDate + 'T00:00:00', endDate + 'T23:59:59') as any[]).map(r => r.date)
    );

    const forecastDates = new Set(
      (this.db.prepare(`
        SELECT DISTINCT DATE(datetime) as date FROM cluster_weather_forecast
        WHERE location_id = ? AND datetime >= ? AND datetime <= ?
      `).all(locationId, startDate + 'T00:00:00', endDate + 'T23:59:59') as any[]).map(r => r.date)
    );

    // Get stale and needs-historical dates
    const staleDates = new Set(this.getClusterStaleForecastDates(locationId, startDate, endDate, maxForecastAgeHours));
    const needsHistoricalDates = new Set(this.getClusterDatesNeedingHistorical(locationId, startDate, endDate));

    // Generate all dates in range
    const allDates: string[] = [];
    let current = DateTime.fromISO(startDate);
    const end = DateTime.fromISO(endDate);

    while (current <= end) {
      const dateStr = current.toISODate()!;
      const isPast = current < today;

      // Need to fetch if:
      // 1. No data at all (not in historical AND not in forecast)
      // 2. Past date needs historical replacement
      // 3. Future date has stale forecast
      const hasHistorical = historicalDates.has(dateStr);
      const hasForecast = forecastDates.has(dateStr);

      if (!hasHistorical && !hasForecast) {
        allDates.push(dateStr);
      } else if (isPast && needsHistoricalDates.has(dateStr)) {
        allDates.push(dateStr);
      } else if (!isPast && staleDates.has(dateStr)) {
        allDates.push(dateStr);
      }

      current = current.plus({ days: 1 });
    }

    return allDates;
  }

  /**
   * Promote forecast data to historical table for past dates
   * Called when past dates have forecast data that should become permanent
   * This copies data from forecast table to historical table
   */
  promoteClusterForecastToHistorical(locationId: string): { promoted: number; archived: number } {
    const today = DateTime.now().startOf('day').toISODate();
    let promoted = 0;
    let archived = 0;

    const selectPast = this.db.prepare(`
      SELECT * FROM cluster_weather_forecast
      WHERE location_id = ? AND DATE(datetime) < ?
    `);

    const insertHistorical = this.db.prepare(`
      INSERT INTO cluster_weather_historical (
        location_id, datetime, temp, dew, humidity, precip, precipprob, pressure,
        windgust, windspeed, winddir, windspeed50, winddir50, windspeed80, winddir80,
        windspeed100, winddir100, cloudcover, visibility, solarradiation, solarenergy,
        uvindex, dniradiation, difradiation, ghiradiation, conditions, source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(location_id, datetime) DO NOTHING
    `);

    const insertArchive = this.db.prepare(`
      INSERT INTO cluster_weather_forecast_archive (
        location_id, datetime, fetched_at, lead_time_hours,
        temp, dew, humidity, precip, precipprob, pressure,
        windgust, windspeed, winddir, windspeed50, winddir50, windspeed80, winddir80,
        windspeed100, winddir100, cloudcover, visibility, solarradiation, solarenergy,
        uvindex, dniradiation, difradiation, ghiradiation, conditions, source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const deleteForecast = this.db.prepare(`
      DELETE FROM cluster_weather_forecast
      WHERE location_id = ? AND DATE(datetime) < ?
    `);

    const transaction = this.db.transaction(() => {
      const rows = selectPast.all(locationId, today) as any[];

      for (const row of rows) {
        // Archive the forecast record before promoting
        if (row.fetched_at) {
          const fetchedAt = DateTime.fromISO(row.fetched_at);
          const targetTime = DateTime.fromISO(row.datetime);
          const leadTimeHours = Math.round(targetTime.diff(fetchedAt, 'hours').hours);

          insertArchive.run(
            locationId, row.datetime, row.fetched_at, leadTimeHours,
            row.temp, row.dew, row.humidity, row.precip, row.precipprob, row.pressure,
            row.windgust, row.windspeed, row.winddir,
            row.windspeed50, row.winddir50, row.windspeed80, row.winddir80,
            row.windspeed100, row.winddir100,
            row.cloudcover, row.visibility, row.solarradiation, row.solarenergy,
            row.uvindex, row.dniradiation, row.difradiation, row.ghiradiation,
            row.conditions, row.source
          );
          archived++;
        }

        const result = insertHistorical.run(
          row.location_id, row.datetime,
          row.temp, row.dew, row.humidity, row.precip, row.precipprob, row.pressure,
          row.windgust, row.windspeed, row.winddir,
          row.windspeed50, row.winddir50, row.windspeed80, row.winddir80,
          row.windspeed100, row.winddir100,
          row.cloudcover, row.visibility, row.solarradiation, row.solarenergy,
          row.uvindex, row.dniradiation, row.difradiation, row.ghiradiation,
          row.conditions, 'promoted_from_forecast'
        );
        if (result.changes > 0) promoted++;
      }

      // Delete promoted records from forecast table
      deleteForecast.run(locationId, today);
    });

    transaction();
    return { promoted, archived };
  }

  /**
   * Get cluster weather statistics
   */
  getClusterWeatherStats(locationId?: string): {
    historical: { records: number; locations: number; dateRange: { start: string | null; end: string | null } };
    forecast: { records: number; locations: number; staleRecords: number };
    archive: { records: number; oldestFetch: string | null };
  } {
    const locFilter = locationId ? ' WHERE location_id = ?' : '';
    const params = locationId ? [locationId] : [];

    const histStats = this.db.prepare(`
      SELECT COUNT(*) as count, COUNT(DISTINCT location_id) as locations,
             MIN(datetime) as min_dt, MAX(datetime) as max_dt
      FROM cluster_weather_historical${locFilter}
    `).get(...params) as any;

    const fcStats = this.db.prepare(`
      SELECT COUNT(*) as count, COUNT(DISTINCT location_id) as locations
      FROM cluster_weather_forecast${locFilter}
    `).get(...params) as any;

    const cutoff = DateTime.now().minus({ hours: 24 }).toISO();
    const staleCount = (this.db.prepare(`
      SELECT COUNT(*) as count FROM cluster_weather_forecast
      ${locFilter ? locFilter + ' AND' : ' WHERE'} fetched_at < ?
    `).get(...params, cutoff) as any).count;

    const archiveStats = this.db.prepare(`
      SELECT COUNT(*) as count, MIN(fetched_at) as oldest
      FROM cluster_weather_forecast_archive${locFilter}
    `).get(...params) as any;

    return {
      historical: {
        records: histStats.count,
        locations: histStats.locations,
        dateRange: { start: histStats.min_dt, end: histStats.max_dt }
      },
      forecast: {
        records: fcStats.count,
        locations: fcStats.locations,
        staleRecords: staleCount
      },
      archive: {
        records: archiveStats.count,
        oldestFetch: archiveStats.oldest
      }
    };
  }

  /**
   * Clear cluster weather data (for maintenance/testing)
   */
  clearClusterWeather(locationId?: string, tableType?: 'historical' | 'forecast' | 'archive' | 'all'): void {
    const tables = tableType === 'all' || !tableType
      ? ['cluster_weather_historical', 'cluster_weather_forecast', 'cluster_weather_forecast_archive']
      : [`cluster_weather_${tableType}`];

    for (const table of tables) {
      if (locationId) {
        this.db.prepare(`DELETE FROM ${table} WHERE location_id = ?`).run(locationId);
      } else {
        this.db.exec(`DELETE FROM ${table}`);
      }
    }
  }
}

// Singleton instance
let dbInstance: DatabaseService | null = null;

export function getDatabase(dbPath?: string): DatabaseService {
  if (!dbInstance) {
    dbInstance = new DatabaseService(dbPath);
  }
  return dbInstance;
}

export function closeDatabase(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}

// Zonal database singleton
let zonalDbInstance: DatabaseService | null = null;

export function getZonalDatabase(dbPath?: string): DatabaseService {
  if (!zonalDbInstance) {
    zonalDbInstance = new DatabaseService(dbPath || join(process.cwd(), 'data', 'iload_zonal.db'));
  }
  return zonalDbInstance;
}

export function closeZonalDatabase(): void {
  if (zonalDbInstance) {
    zonalDbInstance.close();
    zonalDbInstance = null;
  }
}
