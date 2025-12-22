/**
 * Export correlation data to CSV format for visualization tools
 */

import { DatabaseService } from '../database/database.js';
import { DateTime } from 'luxon';
import { writeFileSync } from 'fs';
import { join } from 'path';

class DataExporter {
  private db: DatabaseService;

  constructor() {
    this.db = new DatabaseService();
  }

  /**
   * Export merged data to CSV
   */
  async exportToCSV(startDate: string, endDate: string, interconnector: string = 'VISLUZ1'): Promise<void> {
    console.log('Loading and merging data for export...');

    const interconnectorRecords = this.db.getInterconnectorRecords(
      startDate,
      endDate,
      interconnector
    );

    const manilaWeather = this.loadWeatherData('CLUZ', startDate, endDate);
    const cebuWeather = this.loadWeatherData('CVIS', startDate, endDate);
    const luzDemand = this.loadDemandData('CLUZ', startDate, endDate);
    const visDemand = this.loadDemandData('CVIS', startDate, endDate);

    const csvRows: string[] = [];

    // Header
    csvRows.push([
      'datetime',
      'hour',
      'day_of_week',
      'is_weekend',
      'is_congested',
      'flow_from',
      'flow_to',
      'overload_mw',
      'manila_temp',
      'manila_dew',
      'manila_solar',
      'manila_wind',
      'manila_cloudcover',
      'manila_rh',
      'cebu_temp',
      'cebu_dew',
      'cebu_solar',
      'cebu_wind',
      'cebu_cloudcover',
      'cebu_rh',
      'luz_demand',
      'vis_demand',
      'demand_diff'
    ].join(','));

    for (const record of interconnectorRecords) {
      const dt = DateTime.fromJSDate(record.timeInterval);

      const manila = this.findClosestWeather(manilaWeather, record.timeInterval);
      const cebu = this.findClosestWeather(cebuWeather, record.timeInterval);
      const luz = this.findClosestDemand(luzDemand, record.timeInterval);
      const vis = this.findClosestDemand(visDemand, record.timeInterval);

      if (!manila || !cebu || !luz || !vis) {
        continue;
      }

      const hour = dt.hour;
      const dayOfWeek = dt.weekday;
      const isWeekend = dayOfWeek >= 6 ? 1 : 0;
      const isCongested = record.congestionFlag === 'Y' ? 1 : 0;

      const manilaRH = this.calculateRelativeHumidity(manila.temp, manila.dew);
      const cebuRH = this.calculateRelativeHumidity(cebu.temp, cebu.dew);

      csvRows.push([
        dt.toISO(),
        hour,
        dayOfWeek,
        isWeekend,
        isCongested,
        record.flowFrom,
        record.flowTo,
        record.overloadMW || 0,
        manila.temp,
        manila.dew,
        manila.solarradiation,
        manila.windspeed,
        manila.cloudcover,
        manilaRH,
        cebu.temp,
        cebu.dew,
        cebu.solarradiation,
        cebu.windspeed,
        cebu.cloudcover,
        cebuRH,
        luz.demand,
        vis.demand,
        luz.demand - vis.demand
      ].join(','));
    }

    const outputPath = join(process.cwd(), 'Documents', 'visluz1_correlation_data.csv');
    writeFileSync(outputPath, csvRows.join('\n'));

    console.log(`\nExported ${csvRows.length - 1} records to: ${outputPath}`);
  }

  private loadWeatherData(region: string, startDate: string, endDate: string): Map<string, any> {
    const sql = `
      SELECT datetime, temp, dew, precip, windgust, windspeed, cloudcover, solarradiation, uvindex
      FROM weather_records
      WHERE region = ? AND datetime >= ? AND datetime <= ?
      ORDER BY datetime
    `;

    const rows = this.db['db'].prepare(sql).all(
      region,
      startDate + 'T00:00:00',
      endDate + 'T23:59:59'
    ) as any[];

    const map = new Map<string, any>();
    for (const row of rows) {
      const dt = DateTime.fromISO(row.datetime);
      const key = dt.toFormat('yyyy-MM-dd HH:mm');
      map.set(key, {
        datetime: new Date(row.datetime),
        temp: row.temp || 0,
        dew: row.dew || 0,
        precip: row.precip || 0,
        windgust: row.windgust || 0,
        windspeed: row.windspeed || 0,
        cloudcover: row.cloudcover || 0,
        solarradiation: row.solarradiation || 0,
        uvindex: row.uvindex || 0
      });
    }

    return map;
  }

  private loadDemandData(region: string, startDate: string, endDate: string): Map<string, any> {
    const records = this.db.getDemandRecords(
      startDate + 'T00:00:00',
      endDate + 'T23:59:59',
      region
    );

    const map = new Map<string, any>();
    for (const record of records) {
      const dt = DateTime.fromJSDate(record.datetime);
      const key = dt.toFormat('yyyy-MM-dd HH:mm');
      map.set(key, {
        datetime: record.datetime,
        demand: record.demand
      });
    }

    return map;
  }

  private findClosestWeather(weatherMap: Map<string, any>, datetime: Date): any | null {
    const dt = DateTime.fromJSDate(datetime);

    let key = dt.toFormat('yyyy-MM-dd HH:mm');
    if (weatherMap.has(key)) {
      return weatherMap.get(key)!;
    }

    for (let offset = -5; offset <= 5; offset += 5) {
      if (offset === 0) continue;
      key = dt.plus({ minutes: offset }).toFormat('yyyy-MM-dd HH:mm');
      if (weatherMap.has(key)) {
        return weatherMap.get(key)!;
      }
    }

    return null;
  }

  private findClosestDemand(demandMap: Map<string, any>, datetime: Date): any | null {
    const dt = DateTime.fromJSDate(datetime);

    let key = dt.toFormat('yyyy-MM-dd HH:mm');
    if (demandMap.has(key)) {
      return demandMap.get(key)!;
    }

    for (let offset = -5; offset <= 5; offset += 5) {
      if (offset === 0) continue;
      key = dt.plus({ minutes: offset }).toFormat('yyyy-MM-dd HH:mm');
      if (demandMap.has(key)) {
        return demandMap.get(key)!;
      }
    }

    return null;
  }

  private calculateRelativeHumidity(tempC: number, dewC: number): number {
    const beta = 17.62;
    const lambda = 243.12;
    const numerator = Math.exp((beta * dewC) / (lambda + dewC));
    const denominator = Math.exp((beta * tempC) / (lambda + tempC));
    return 100 * (numerator / denominator);
  }
}

async function main() {
  const exporter = new DataExporter();

  const startDate = '2025-07-01';
  const endDate = '2025-12-01';

  console.log('Exporting VISLUZ1 correlation data to CSV...');
  await exporter.exportToCSV(startDate, endDate);
  console.log('Export complete!');
}

main().catch(err => {
  console.error('Export failed:', err);
  process.exit(1);
});
