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
  }

  // ============ DEMAND RECORDS ============

  importDemandRecords(records: DemandRecord[], sourceFile?: string): { inserted: number; updated: number } {
    const insertStmt = this.db.prepare(`
      INSERT INTO demand_records (datetime, region, demand, source_file)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(datetime, region) DO UPDATE SET
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
      ON CONFLICT(datetime, region) DO UPDATE SET
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
   */
  getWeatherAvailableDates(location: string, startDate?: string, endDate?: string): Set<string> {
    const region = REGION_MAPPING[location.toLowerCase()] || location;

    let sql = `
      SELECT DISTINCT DATE(datetime) as date
      FROM weather_records
      WHERE region = ?
    `;
    const params: any[] = [region];

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
    const region = REGION_MAPPING[location.toLowerCase()] || location;
    const cutoffTime = DateTime.now().minus({ hours: maxAgeHours }).toISO();

    // Find dates where:
    // 1. Data is marked as forecast (is_forecast = 1)
    // 2. imported_at is older than cutoff time
    const rows = this.db.prepare(`
      SELECT DISTINCT DATE(datetime) as date
      FROM weather_records
      WHERE region = ?
        AND datetime >= ?
        AND datetime <= ?
        AND is_forecast = 1
        AND imported_at < ?
    `).all(region, startDate + 'T00:00:00', endDate + 'T23:59:59', cutoffTime) as any[];

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
    const region = REGION_MAPPING[location.toLowerCase()] || location;
    const today = DateTime.now().startOf('day').toISODate();

    // Find past dates where data is still marked as forecast
    const rows = this.db.prepare(`
      SELECT DISTINCT DATE(datetime) as date
      FROM weather_records
      WHERE region = ?
        AND datetime >= ?
        AND datetime <= ?
        AND DATE(datetime) < ?
        AND is_forecast = 1
    `).all(region, startDate + 'T00:00:00', endDate + 'T23:59:59', today) as any[];

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
    const region = REGION_MAPPING[location.toLowerCase()] || location;
    const today = DateTime.now().startOf('day');

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
    const insertStmt = this.db.prepare(`
      INSERT INTO weather_records (datetime, location, region, temp, dew, precip, windgust, windspeed, cloudcover, solarradiation, solarenergy, uvindex, is_forecast, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(datetime, region) DO UPDATE SET
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
   */
  getWeatherDataForParser(location: string, startDate: string, endDate: string): {
    city: string;
    records: RawWeatherData[];
    startDate: Date;
    endDate: Date;
  } | null {
    const region = REGION_MAPPING[location.toLowerCase()] || location;

    const rows = this.db.prepare(`
      SELECT * FROM weather_records
      WHERE region = ?
        AND datetime >= ?
        AND datetime <= ?
      ORDER BY datetime
    `).all(region, startDate + 'T00:00:00', endDate + 'T23:59:59') as any[];

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
