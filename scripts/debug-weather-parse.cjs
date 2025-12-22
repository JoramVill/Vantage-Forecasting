const fs = require('fs');
const path = require('path');

const filepath = path.join(__dirname, '..', 'weather_cache', 'SOLAR_06BACOLOD_S', '2025-07', '2025-07-01.csv');

const content = fs.readFileSync(filepath, 'utf-8');
const lines = content.split('\n').filter(l => l.trim());
const headers = lines[0].split(',');

console.log('Headers:', headers);
console.log('Headers length:', headers.length);

// Find column indices
const datetimeIdx = headers.indexOf('datetime');
const solarIdx = headers.indexOf('solarradiation');
const cloudIdx = headers.indexOf('cloudcover');

console.log('\nIndices:');
console.log('datetime:', datetimeIdx);
console.log('solarradiation:', solarIdx);
console.log('cloudcover:', cloudIdx);

// Parse a few lines
console.log('\nFirst few data rows:');
for (let i = 1; i <= 5; i++) {
  const values = lines[i].split(',');
  console.log(`Row ${i}:`, {
    datetime: values[datetimeIdx],
    solar: values[solarIdx],
    cloud: values[cloudIdx],
    valuesLength: values.length,
  });
}

// Check hour 10 (should be daytime with solar radiation)
console.log('\nRow 11 (hour 10):');
const values10 = lines[11].split(',');
console.log('Raw line:', lines[11]);
console.log('Parsed:', {
  datetime: values10[datetimeIdx],
  solar: values10[solarIdx],
  cloud: values10[cloudIdx],
});
