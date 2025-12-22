/**
 * Compare forecast vs historical CF patterns by hour
 * Look for afternoon over-prediction
 */
const fs = require('fs');
const path = require('path');

// Load historical CF
const cfacDir = 'Data Samples/Capacity Factor';
const historicalHourly = {};
const historicalCounts = {};
for (let h = 0; h < 24; h++) {
  historicalHourly[h] = 0;
  historicalCounts[h] = 0;
}

const files = fs.readdirSync(cfacDir).filter(f => f.endsWith('.csv'));

// Get all station columns that are solar (ending with _S)
for (const file of files) {
  const content = fs.readFileSync(path.join(cfacDir, file), 'utf-8');
  const lines = content.split('\n').filter(l => l.trim());

  if (lines.length < 2) continue;

  const headers = lines[0].split(',').map(h => h.trim());
  const solarCols = headers.map((h, i) => ({ name: h, idx: i }))
    .filter(c => c.name.endsWith('_S'));

  if (solarCols.length === 0) continue;

  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(',');
    if (values.length < 2) continue;

    const dateStr = values[0].trim();
    const match = dateStr.match(/\d+\/\d+\/\d+\s+(\d+):/);
    if (!match) continue;

    const hour = parseInt(match[1], 10);

    for (const col of solarCols) {
      if (values.length <= col.idx) continue;
      const cfac = parseFloat(values[col.idx]);
      if (!isNaN(cfac) && cfac >= 0 && cfac <= 1) {
        historicalHourly[hour] += cfac;
        historicalCounts[hour]++;
      }
    }
  }
}

// Load most recent forecast
const outputDir = 'output';
const forecastFiles = fs.readdirSync(outputDir)
  .filter(f => f.startsWith('cfac_') && f.endsWith('.csv'))
  .sort((a, b) => {
    const statA = fs.statSync(path.join(outputDir, a));
    const statB = fs.statSync(path.join(outputDir, b));
    return statB.mtime.getTime() - statA.mtime.getTime();
  });

if (forecastFiles.length === 0) {
  console.log('No forecast files found in output/');
  process.exit(1);
}

console.log('Available forecast files (newest first):');
forecastFiles.slice(0, 5).forEach((f, i) => {
  const stat = fs.statSync(path.join(outputDir, f));
  console.log(`  ${i + 1}. ${f} (${stat.mtime.toISOString().slice(0, 19)})`);
});

// Use the most recent forecast
const forecastFile = forecastFiles[0];
console.log(`\nUsing: ${forecastFile}\n`);

const forecastHourly = {};
const forecastCounts = {};
for (let h = 0; h < 24; h++) {
  forecastHourly[h] = 0;
  forecastCounts[h] = 0;
}

const forecastContent = fs.readFileSync(path.join(outputDir, forecastFile), 'utf-8');
const forecastLines = forecastContent.split('\n').filter(l => l.trim());

if (forecastLines.length < 2) {
  console.log('Forecast file is empty');
  process.exit(1);
}

const forecastHeaders = forecastLines[0].split(',').map(h => h.trim());
const forecastSolarCols = forecastHeaders.map((h, i) => ({ name: h, idx: i }))
  .filter(c => c.name.endsWith('_S'));

console.log(`Found ${forecastSolarCols.length} solar stations in forecast`);

for (let i = 1; i < forecastLines.length; i++) {
  const values = forecastLines[i].split(',');
  if (values.length < 2) continue;

  const dateStr = values[0].trim();
  const match = dateStr.match(/\d+\/\d+\/\d+\s+(\d+):/);
  if (!match) continue;

  const hour = parseInt(match[1], 10);

  for (const col of forecastSolarCols) {
    if (values.length <= col.idx) continue;
    const cfac = parseFloat(values[col.idx]);
    if (!isNaN(cfac) && cfac >= 0 && cfac <= 1) {
      forecastHourly[hour] += cfac;
      forecastCounts[hour]++;
    }
  }
}

console.log('\n=== Forecast vs Historical Solar CF Comparison ===');
console.log('Hour | Historical | Forecast | Forecast/Historical | Analysis');
console.log('-'.repeat(70));

const peakHistorical = historicalHourly[12] / historicalCounts[12];
const peakForecast = forecastHourly[12] / forecastCounts[12];

for (let h = 6; h <= 18; h++) {
  const historical = historicalCounts[h] > 0 ? historicalHourly[h] / historicalCounts[h] : 0;
  const forecast = forecastCounts[h] > 0 ? forecastHourly[h] / forecastCounts[h] : 0;

  const ratio = historical > 0 ? (forecast / historical * 100).toFixed(0) : 'N/A';
  const diffPct = historical > 0 ? ((forecast - historical) / historical * 100).toFixed(0) : 'N/A';

  let analysis = '';
  if (historical > 0) {
    const diff = forecast / historical;
    if (diff > 1.2) {
      analysis = `FORECAST ${(diff * 100 - 100).toFixed(0)}% HIGHER`;
    } else if (diff < 0.8) {
      analysis = `Forecast ${(100 - diff * 100).toFixed(0)}% lower`;
    } else {
      analysis = 'OK';
    }
  }

  console.log(`H${h.toString().padStart(2)} | ${(historical * 100).toFixed(1).padStart(6)}%   | ${(forecast * 100).toFixed(1).padStart(6)}%  | ${ratio.padStart(6)}%            | ${analysis}`);
}

console.log('\n\n=== Afternoon Profile Comparison (normalized to noon) ===');
console.log('(Should decay from 100% at H12 to near 0% at H18)\n');

console.log('Hour | Historical | Forecast | Delta');
console.log('-'.repeat(45));

for (let h = 12; h <= 18; h++) {
  const historical = historicalCounts[h] > 0 ? historicalHourly[h] / historicalCounts[h] : 0;
  const forecast = forecastCounts[h] > 0 ? forecastHourly[h] / forecastCounts[h] : 0;

  const histPct = (historical / peakHistorical * 100).toFixed(0);
  const fcstPct = (forecast / peakForecast * 100).toFixed(0);
  const delta = parseInt(fcstPct) - parseInt(histPct);

  let marker = '';
  if (delta > 10) marker = ' <-- FORECAST HIGHER';
  if (delta < -10) marker = ' (forecast lower)';

  console.log(`H${h.toString().padStart(2)} | ${histPct.padStart(5)}%     | ${fcstPct.padStart(5)}%   | ${delta > 0 ? '+' : ''}${delta}%${marker}`);
}

// Check for the specific "spike" pattern
console.log('\n\n=== Late Afternoon "Spike" Detection ===');
console.log('Checking if H16 or H17 unexpectedly rises vs H15...\n');

for (let h = 15; h <= 17; h++) {
  const prevHistorical = historicalCounts[h-1] > 0 ? historicalHourly[h-1] / historicalCounts[h-1] : 0;
  const prevForecast = forecastCounts[h-1] > 0 ? forecastHourly[h-1] / forecastCounts[h-1] : 0;
  const currHistorical = historicalCounts[h] > 0 ? historicalHourly[h] / historicalCounts[h] : 0;
  const currForecast = forecastCounts[h] > 0 ? forecastHourly[h] / forecastCounts[h] : 0;

  const histChange = ((currHistorical - prevHistorical) / prevHistorical * 100).toFixed(0);
  const fcstChange = ((currForecast - prevForecast) / prevForecast * 100).toFixed(0);

  const histDecay = currHistorical < prevHistorical ? 'decay' : 'RISE';
  const fcstDecay = currForecast < prevForecast ? 'decay' : 'RISE';

  console.log(`H${h-1}→H${h}: Historical ${histChange}% (${histDecay}), Forecast ${fcstChange}% (${fcstDecay})`);

  if (fcstDecay === 'RISE' && histDecay === 'decay') {
    console.log(`   ^^^ ANOMALY: Forecast rises while historical decays!`);
  }
}
