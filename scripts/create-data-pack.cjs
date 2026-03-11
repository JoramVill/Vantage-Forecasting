/**
 * Create Data Pack for Vantage Forecaster
 *
 * Creates a data-only update package that can be extracted over
 * an existing portable installation to update data files.
 *
 * Usage: node scripts/create-data-pack.cjs [options]
 *
 * Options:
 *   --type <all|weather|training|databases>  Type of data to package (default: all)
 *   --output <dir>                           Output directory (default: ./data-packs)
 *   --name <string>                          Custom name for the pack
 *
 * Examples:
 *   node scripts/create-data-pack.cjs                      # Full data pack
 *   node scripts/create-data-pack.cjs --type weather       # Weather cache only
 *   node scripts/create-data-pack.cjs --type training      # Training data only
 *   node scripts/create-data-pack.cjs --type databases     # Database files only
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const AdmZip = require('adm-zip');

// Configuration
const DATA_CONFIGS = {
  weather: {
    name: 'weather-cache',
    description: 'Weather Cache',
    paths: [
      { src: 'weather_cache', dest: 'weather_cache' }
    ]
  },
  training: {
    name: 'training-data',
    description: 'Training Data',
    paths: [
      { src: 'Data Samples', dest: 'Data Samples' }
    ]
  },
  databases: {
    name: 'databases',
    description: 'Databases',
    paths: [
      { src: 'data', dest: 'data' },
      { src: 'forecast.db', dest: 'forecast.db', file: true }
    ]
  },
  models: {
    name: 'models',
    description: 'Trained Models',
    paths: [
      { src: 'models', dest: 'models' }
    ]
  },
  all: {
    name: 'full-data',
    description: 'All Data',
    paths: [
      { src: 'weather_cache', dest: 'weather_cache' },
      { src: 'Data Samples', dest: 'Data Samples' },
      { src: 'data', dest: 'data' },
      { src: 'models', dest: 'models' },
      { src: 'forecast.db', dest: 'forecast.db', file: true }
    ]
  }
};

// Parse arguments
const args = process.argv.slice(2);
let packType = 'all';
let outputDir = './data-packs';
let customName = null;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--type' && args[i + 1]) {
    packType = args[++i];
  } else if (args[i] === '--output' && args[i + 1]) {
    outputDir = args[++i];
  } else if (args[i] === '--name' && args[i + 1]) {
    customName = args[++i];
  }
}

// Validate pack type
if (!DATA_CONFIGS[packType]) {
  console.error(`Invalid pack type: ${packType}`);
  console.error(`Valid types: ${Object.keys(DATA_CONFIGS).join(', ')}`);
  process.exit(1);
}

// Utility functions
function log(message, type = 'info') {
  const prefix = {
    info: '\x1b[36m[INFO]\x1b[0m',
    success: '\x1b[32m[OK]\x1b[0m',
    warn: '\x1b[33m[WARN]\x1b[0m',
    error: '\x1b[31m[ERROR]\x1b[0m',
  };
  console.log(`${prefix[type] || prefix.info} ${message}`);
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function getDirectorySize(dir) {
  if (!fs.existsSync(dir)) return 0;

  let size = 0;
  const stat = fs.statSync(dir);

  if (stat.isFile()) {
    return stat.size;
  }

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      size += getDirectorySize(fullPath);
    } else {
      size += fs.statSync(fullPath).size;
    }
  }

  return size;
}

function formatSize(bytes) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (bytes >= 1024 && i < units.length - 1) {
    bytes /= 1024;
    i++;
  }
  return `${bytes.toFixed(1)} ${units[i]}`;
}

function copyDir(src, dest) {
  ensureDir(dest);
  const entries = fs.readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

// Main
async function main() {
  const projectRoot = path.resolve(__dirname, '..');
  const config = DATA_CONFIGS[packType];

  const dateStr = new Date().toISOString().split('T')[0];
  const packName = customName || `${config.name}-${dateStr}`;
  const fullOutputDir = path.resolve(projectRoot, outputDir);
  const tempDir = path.join(fullOutputDir, `temp-${packName}`);
  const zipPath = path.join(fullOutputDir, `${packName}.zip`);

  console.log('\n========================================');
  console.log(`  Creating ${config.description} Pack`);
  console.log('========================================\n');

  ensureDir(fullOutputDir);

  // Clean temp directory
  if (fs.existsSync(tempDir)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  ensureDir(tempDir);

  // Copy files
  let totalSize = 0;
  for (const p of config.paths) {
    const src = path.join(projectRoot, p.src);
    const dest = path.join(tempDir, p.dest);

    if (!fs.existsSync(src)) {
      log(`Skipping ${p.src} - not found`, 'warn');
      continue;
    }

    if (p.file) {
      ensureDir(path.dirname(dest));
      fs.copyFileSync(src, dest);
      const size = fs.statSync(src).size;
      totalSize += size;
      log(`Copied ${p.src} (${formatSize(size)})`, 'success');
    } else {
      copyDir(src, dest);
      const size = getDirectorySize(dest);
      totalSize += size;
      log(`Copied ${p.src} (${formatSize(size)})`, 'success');
    }
  }

  // Create update instructions
  const instructionsPath = path.join(tempDir, 'UPDATE_INSTRUCTIONS.txt');
  fs.writeFileSync(instructionsPath, `Vantage Forecaster - ${config.description} Update
${'='.repeat(50)}

Created: ${new Date().toISOString()}
Pack Type: ${packType}
Total Size: ${formatSize(totalSize)}

Installation Instructions:
--------------------------
1. Close Vantage Forecaster if it's running
2. Extract this ZIP file
3. Copy the contents to your Vantage Forecaster folder
   (overwrite existing files when prompted)
4. Restart Vantage Forecaster

Contents:
---------
${config.paths.map(p => `  ${p.dest}`).join('\n')}

Notes:
------
- This update will overwrite existing data files
- Your settings (config.json) will NOT be affected
- For weather cache updates, the app will use new cached data
  for historical dates and fetch fresh data for new dates
`);

  // Create ZIP
  log('Creating ZIP archive...', 'info');

  try {
    // Try PowerShell first (faster for large files)
    execSync(`powershell Compress-Archive -Path "${tempDir}\\*" -DestinationPath "${zipPath}" -Force`, {
      stdio: 'pipe',
    });
  } catch (e) {
    // Fallback to AdmZip
    const zip = new AdmZip();
    zip.addLocalFolder(tempDir);
    zip.writeZip(zipPath);
  }

  // Clean up temp
  fs.rmSync(tempDir, { recursive: true, force: true });

  const zipSize = fs.statSync(zipPath).size;

  console.log('\n========================================');
  console.log('  Data Pack Created!');
  console.log('========================================');
  console.log(`  File: ${zipPath}`);
  console.log(`  Uncompressed: ${formatSize(totalSize)}`);
  console.log(`  Compressed:   ${formatSize(zipSize)}`);
  console.log(`  Ratio:        ${((zipSize / totalSize) * 100).toFixed(1)}%`);
  console.log('========================================\n');
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
