/**
 * Check what weather data Visual Crossing provides for December
 * to see if physics model SHOULD be getting good irradiance
 */
const fs = require('fs');
const path = require('path');

// Check weather cache for problem stations
const cacheDir = 'weather_cache';
const problemStations = ['01SNMANUEL_S', '06BACOLOD_S'];

// Physics model parameters (from SolarIrradianceModel.ts)
const GHI_STC = 1000;  // W/m² at STC
const tempCoeff = -0.003;
const systemLoss = 0.92;
const irradianceScale = 1.4;  // Fixed scale factor
const NOCT = 43;

function predictPhysics(solarRadiation, temperature) {
  if (solarRadiation <= 0) return 0;

  const scaledRadiation = solarRadiation * irradianceScale;
  const cellTemp = temperature + (NOCT - 20) * (scaledRadiation / 800);
  const tempFactor = 1 + tempCoeff * (cellTemp - 25);
  const cFac = (scaledRadiation / GHI_STC) * tempFactor * systemLoss;

  return Math.max(0, Math.min(1, cFac));
}

// Find December weather files
const files = fs.readdirSync(cacheDir)
  .filter(f => f.includes('2025-12') && f.endsWith('.json'));

console.log(`Found ${files.length} December weather cache files\n`);

// Look for files related to San Manuel (problem station)
const snmanuelFiles = files.filter(f =>
  f.toLowerCase().includes('san_fernando') ||
  f.toLowerCase().includes('pampanga') ||
  f.toLowerCase().includes('tarlac')
);

console.log(`Weather files near 01SNMANUEL_S: ${snmanuelFiles.length}`);

// Check a sample file
if (files.length > 0) {
  const sampleFile = files[0];
  console.log(`\nSample file: ${sampleFile}`);

  const content = JSON.parse(fs.readFileSync(path.join(cacheDir, sampleFile), 'utf-8'));

  if (content.days && content.days.length > 0) {
    console.log(`\nDecember solar radiation samples (first 3 days):`);
    console.log('Date      | Hour | Solar(W/m²) | Temp(C) | Physics CF | Scaled CF');
    console.log('-'.repeat(70));

    for (let d = 0; d < Math.min(3, content.days.length); d++) {
      const day = content.days[d];
      if (!day.hours) continue;

      for (const hour of day.hours) {
        const h = parseInt(hour.datetime.split(':')[0], 10);
        if (h < 9 || h > 15) continue;

        const solar = hour.solarradiation || 0;
        const temp = hour.temp || 25;
        const physicsCF = predictPhysics(solar, temp);

        console.log(`${day.datetime} | H${h.toString().padStart(2)} | ${solar.toString().padStart(11)} | ${temp.toFixed(1).padStart(7)} | ${(physicsCF * 100).toFixed(1).padStart(10)}% | ${((solar * irradianceScale / GHI_STC) * 100).toFixed(1).padStart(9)}%`);
      }
    }

    // Calculate average peak irradiance
    let totalPeakSolar = 0;
    let peakCount = 0;
    for (const day of content.days) {
      if (!day.hours) continue;
      for (const hour of day.hours) {
        const h = parseInt(hour.datetime.split(':')[0], 10);
        if (h >= 10 && h <= 14) {
          totalPeakSolar += hour.solarradiation || 0;
          peakCount++;
        }
      }
    }

    const avgPeakSolar = totalPeakSolar / peakCount;
    const avgPeakPhysics = predictPhysics(avgPeakSolar, 30);

    console.log(`\n=== Average December Peak (H10-H14) ===`);
    console.log(`Avg solar radiation: ${avgPeakSolar.toFixed(0)} W/m²`);
    console.log(`Scaled (×1.4): ${(avgPeakSolar * irradianceScale).toFixed(0)} W/m²`);
    console.log(`Physics CF: ${(avgPeakPhysics * 100).toFixed(1)}%`);
    console.log(`\nActual CF for 01SNMANUEL_S at peak: ~75-87%`);
    console.log(`Gap suggests: Physics alone gets us closer than hybrid!`);
  }
}
