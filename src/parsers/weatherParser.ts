import { parse } from 'csv-parse/sync';
import { readFileSync } from 'fs';
import { DateTime } from 'luxon';
import { RawWeatherData } from '../types/index.js';

export interface ParsedWeatherData {
  records: RawWeatherData[];
  city: string;
  startDate: Date;
  endDate: Date;
}

export function parseWeatherCsv(filePath: string): ParsedWeatherData {
  const content = readFileSync(filePath, 'utf-8');
  const records = parse(content, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true
  });

  const weatherRecords: RawWeatherData[] = [];
  let city = '';
  let minDate: Date | null = null;
  let maxDate: Date | null = null;

  for (const row of records) {
    if (!city) city = row['name'];

    const dt = DateTime.fromISO(row['datetime']);
    if (!dt.isValid) {
      console.warn(`Invalid date: ${row['datetime']}`);
      continue;
    }

    const datetime = dt.toJSDate();
    if (!minDate || datetime < minDate) minDate = datetime;
    if (!maxDate || datetime > maxDate) maxDate = datetime;

    weatherRecords.push({
      name: row['name'],
      latitude: parseFloat(row['latitude']),
      longitude: parseFloat(row['longitude']),
      datetime: row['datetime'],
      temp: parseFloat(row['temp']),
      dew: parseFloat(row['dew']),
      precip: parseFloat(row['precip']),
      windgust: parseFloat(row['windgust']),
      windspeed: parseFloat(row['windspeed']),
      cloudcover: parseFloat(row['cloudcover']),
      solarradiation: parseFloat(row['solarradiation']),
      solarenergy: parseFloat(row['solarenergy']),
      uvindex: parseFloat(row['uvindex'])
    });
  }

  return {
    records: weatherRecords,
    city,
    startDate: minDate!,
    endDate: maxDate!
  };
}
