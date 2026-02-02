// Script to scale down forecast values by 9%
const fs = require('fs');
const path = require('path');

const inputFile = process.argv[2] || 'output/demand_jan_2026.csv';
const outputFile = process.argv[3] || 'output/demand_jan_2026_scaled.csv';
const scaleFactor = 0.91; // 9% reduction

console.log(`Reading forecast from: ${inputFile}`);
const content = fs.readFileSync(inputFile, 'utf-8');
const lines = content.split('\n');

const outputLines = [];
outputLines.push(lines[0]); // Keep header as-is

for (let i = 1; i < lines.length; i++) {
  const line = lines[i].trim();
  if (!line) continue; // Skip empty lines

  const parts = line.split(',');
  if (parts.length < 4) continue;

  const dateTime = parts[0];
  const cluz = parseFloat(parts[1]) * scaleFactor;
  const cvis = parseFloat(parts[2]) * scaleFactor;
  const cmin = parseFloat(parts[3]) * scaleFactor;

  outputLines.push(`${dateTime},${cluz.toFixed(1)},${cvis.toFixed(1)},${cmin.toFixed(1)}`);
}

const outputContent = outputLines.join('\n');
fs.writeFileSync(outputFile, outputContent);

console.log(`✅ Scaled forecast written to: ${outputFile}`);
console.log(`   Scale factor applied: ${scaleFactor} (9% reduction)`);
console.log(`   Total rows: ${outputLines.length - 1}`);
