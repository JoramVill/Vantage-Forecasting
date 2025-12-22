/**
 * Solar Station Analysis - Identify top solar stations and analyze weather data
 */

const { readFileSync, readdirSync, existsSync } = require('fs');
const { join } = require('path');
const { DateTime } = require('luxon');

// Parse CSV line handling quoted values
function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current.trim());
  return result;
}

// Load capacity factors and count records per station
function analyzeCapacityFactors() {
  const cfacDir = join(process.cwd(), 'Data Samples', 'Capacity Factor');
  const stationCounts = new Map();
  const stationAvgCF = new Map();
  const stationDaylightCF = new Map();

  const files = readdirSync(cfacDir).filter(f => f.toLowerCase().endsWith('.csv'));

  for (const file of files) {
    const content = readFileSync(join(cfacDir, file), 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());
    if (lines.length < 2) continue;

    const headers = lines[0].split(',').map(h => h.trim());

    // Find solar stations (suffix _S or known solar names)
    const solarStations = headers.filter(h =>
      h.endsWith('_S') ||
      h.includes('SOLAR') ||
      ['01CLARK', '01HERMOSA', '01LIMAY', '01CAYANGA', '06HELIOS', '06CADIZ'].includes(h)
    );

    for (const station of solarStations) {
      if (!stationCounts.has(station)) {
        stationCounts.set(station, 0);
        stationAvgCF.set(station, { sum: 0, count: 0 });
        stationDaylightCF.set(station, { sum: 0, count: 0 });
      }

      const idx = headers.indexOf(station);
      if (idx < 0) continue;

      for (let i = 1; i < lines.length; i++) {
        const values = lines[i].split(',').map(v => v.trim());
        if (values.length <= idx) continue;

        const cfac = parseFloat(values[idx]);
        if (isNaN(cfac) || cfac < 0 || cfac > 1) continue;

        // Count non-zero records (actual generation)
        if (cfac > 0) {
          stationCounts.set(station, stationCounts.get(station) + 1);
        }

        stationAvgCF.get(station).sum += cfac;
        stationAvgCF.get(station).count++;

        // Daylight hours (6am-6pm) - parse datetime
        const dt = DateTime.fromFormat(values[0], 'M/d/yyyy HH:mm');
        if (dt.isValid) {
          const hour = dt.hour;
          if (hour >= 6 && hour <= 18) {
            stationDaylightCF.get(station).sum += cfac;
            stationDaylightCF.get(station).count++;
          }
        }
      }
    }
  }

  return { stationCounts, stationAvgCF, stationDaylightCF };
}

// Load stations.json to get coordinates
function loadStationCoordinates() {
  const stationsPath = join(process.cwd(), 'src', 'data', 'stations.json');
  const content = readFileSync(stationsPath, 'utf-8');
  const data = JSON.parse(content);

  const coords = new Map();
  for (const [code, info] of Object.entries(data.stations)) {
    if (info.location && info.location.latitude && info.location.longitude) {
      coords.set(code, {
        lat: info.location.latitude,
        lon: info.location.longitude,
        name: info.name,
        type: info.type
      });
    }
  }
  return coords;
}

// Main
async function main() {
  console.log('');
  console.log('='.repeat(80));
  console.log('SOLAR STATION ANALYSIS');
  console.log('='.repeat(80));
  console.log('');

  const { stationCounts, stationAvgCF, stationDaylightCF } = analyzeCapacityFactors();
  const coords = loadStationCoordinates();

  // Sort by non-zero record count
  const sorted = [...stationCounts.entries()]
    .filter(([s, c]) => c > 100) // At least 100 non-zero records
    .sort((a, b) => b[1] - a[1]);

  console.log('Top Solar Stations by Generation Records:');
  console.log('-'.repeat(100));
  console.log('Station'.padEnd(20) + 'Gen Hrs'.padStart(10) + 'Avg CF'.padStart(10) + 'Day CF'.padStart(10) + 'Lat'.padStart(10) + 'Lon'.padStart(10) + 'Has Coords'.padStart(12));
  console.log('-'.repeat(100));

  const topStations = [];

  for (const [station, count] of sorted.slice(0, 30)) {
    const avgData = stationAvgCF.get(station);
    const dayData = stationDaylightCF.get(station);
    const avgCF = avgData.count > 0 ? (avgData.sum / avgData.count * 100).toFixed(1) + '%' : 'N/A';
    const dayCF = dayData.count > 0 ? (dayData.sum / dayData.count * 100).toFixed(1) + '%' : 'N/A';

    const coord = coords.get(station);
    const hasCoord = coord ? 'YES' : 'NO';
    const lat = coord ? coord.lat.toFixed(4) : 'N/A';
    const lon = coord ? coord.lon.toFixed(4) : 'N/A';

    console.log(
      station.padEnd(20) +
      count.toString().padStart(10) +
      avgCF.padStart(10) +
      dayCF.padStart(10) +
      lat.toString().padStart(10) +
      lon.toString().padStart(10) +
      hasCoord.padStart(12)
    );

    if (coord) {
      topStations.push({
        code: station,
        lat: coord.lat,
        lon: coord.lon,
        name: coord.name,
        genHours: count,
        avgCF: avgData.count > 0 ? avgData.sum / avgData.count : 0,
        dayCF: dayData.count > 0 ? dayData.sum / dayData.count : 0
      });
    }
  }

  console.log('-'.repeat(100));

  // Select diverse stations for per-station weather analysis
  console.log('');
  console.log('Recommended stations for per-station weather analysis:');
  console.log('(Selected for geographic diversity and data availability)');
  console.log('');

  const selectedStations = topStations.slice(0, 15).filter(s => s.lat && s.lon);

  for (const s of selectedStations) {
    console.log(`  ${s.code}: ${s.lat.toFixed(4)}, ${s.lon.toFixed(4)} (Day CF: ${(s.dayCF * 100).toFixed(1)}%)`);
  }

  // Output station list for cfac weather command
  console.log('');
  console.log('Station codes for weather fetch:');
  console.log(selectedStations.map(s => s.code).join(','));
}

main().catch(console.error);
