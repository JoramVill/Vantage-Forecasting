const fs = require('fs');

// Scale factors based on January 2026 bias analysis
const SCALE_FACTORS = {
  '01NLUZ': -10,
  '02METRO': -22,
  '03SLUZ': -16,
  '04LEYTE': -28,
  '05CEBU': -8,
  '06NEGROS': 9,
  '07BOHOL': -1,
  '08PANAY': -10,
  '09NWMIN': -1,
  '10LANAO': -6,
  '11NCMIN': -11,
  '12NEMIN': -6,
  '13SEMIN': 1,
  '14SWMIN': 5
};

// Read input forecast
const inputFile = process.argv[2] || 'output/demand_zonal_2026-03-01_2026-03-31.csv';
const outputFile = process.argv[3] || 'output/demand_zonal_scaled_2026-03.csv';

console.log(`Applying per-zone scaling to: ${inputFile}`);
console.log('Scale factors:');
Object.entries(SCALE_FACTORS).forEach(([zone, scale]) => {
  const sign = scale >= 0 ? '+' : '';
  console.log(`  ${zone}: ${sign}${scale}%`);
});
console.log('');

const csv = fs.readFileSync(inputFile, 'utf-8');
const lines = csv.trim().split('\n');
const header = lines[0];
const headers = header.split(',');

// Find zone column indices
const zoneIndices = {};
headers.forEach((h, i) => {
  if (SCALE_FACTORS.hasOwnProperty(h)) {
    zoneIndices[h] = i;
  }
});

// Apply scaling
const outputLines = [header];
for (let i = 1; i < lines.length; i++) {
  const values = lines[i].split(',');

  Object.entries(zoneIndices).forEach(([zone, idx]) => {
    const original = parseFloat(values[idx]);
    const scaleFactor = 1 + (SCALE_FACTORS[zone] / 100);
    values[idx] = (original * scaleFactor).toFixed(1);
  });

  outputLines.push(values.join(','));
}

fs.writeFileSync(outputFile, outputLines.join('\n'));

console.log(`✅ Scaled forecast saved to: ${outputFile}`);
console.log(`   ${outputLines.length - 1} hourly rows processed`);

// Also create regional aggregation
const CLUZ = ['01NLUZ', '02METRO', '03SLUZ'];
const CVIS = ['04LEYTE', '05CEBU', '06NEGROS', '07BOHOL', '08PANAY'];
const CMIN = ['09NWMIN', '10LANAO', '11NCMIN', '12NEMIN', '13SEMIN', '14SWMIN'];

const regionalLines = ['DateTimeEnding,CLUZ,CVIS,CMIN'];
for (let i = 1; i < outputLines.length; i++) {
  const values = outputLines[i].split(',');
  const dt = values[0];

  const cluz = CLUZ.reduce((s, z) => s + parseFloat(values[zoneIndices[z]]), 0);
  const cvis = CVIS.reduce((s, z) => s + parseFloat(values[zoneIndices[z]]), 0);
  const cmin = CMIN.reduce((s, z) => s + parseFloat(values[zoneIndices[z]]), 0);

  regionalLines.push(`${dt},${cluz.toFixed(1)},${cvis.toFixed(1)},${cmin.toFixed(1)}`);
}

const regionalOutputFile = outputFile.replace('zonal', 'regional');
fs.writeFileSync(regionalOutputFile, regionalLines.join('\n'));
console.log(`✅ Regional forecast saved to: ${regionalOutputFile}`);
