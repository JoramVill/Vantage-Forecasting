/**
 * Build Portable Windows Distribution
 *
 * Creates a self-contained portable folder with:
 * - Electron app (unpacked)
 * - Portable Node.js for CLI
 * - CLI backend (dist + node_modules)
 * - Data files (databases, weather cache, training data)
 *
 * Usage: node scripts/build-portable.cjs [--no-data] [--zip] [--output <dir>]
 *
 * Options:
 *   --no-data      Skip copying data files (for app-only updates)
 *   --zip          Create ZIP archive after building
 *   --clean        Clean output directory before building
 *   --output <dir> Custom output directory (default: portable-build)
 */

const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');
const https = require('https');
const AdmZip = require('adm-zip');

// Configuration
const CONFIG = {
  outputDir: 'portable-build',
  appName: 'VantageForecaster',
  nodeVersion: '24.14.0', // LTS Krypton - matches Node 24.x development environment

  // Directories to copy
  dataDirs: [
    { src: 'data', dest: 'data', description: 'Databases' },
    { src: 'weather_cache', dest: 'weather_cache', description: 'Weather cache' },
    { src: 'Data Samples', dest: 'Data Samples', description: 'Training data' },
    { src: 'models', dest: 'models', description: 'Trained models' },
  ],

  // Individual files to copy
  dataFiles: [
    { src: 'forecast.db', dest: 'forecast.db', description: 'Forecast database' },
    { src: 'config.json', dest: 'config.json', description: 'Configuration', optional: true },
    // CLI expects these at cli/data/ relative to cli folder
    { src: 'src/data/stations.json', dest: 'cli/data/stations.json', description: 'Station metadata' },
    { src: 'src/data/zones.json', dest: 'cli/data/zones.json', description: 'Zone configuration' },
    { src: 'config/lstm_config.json', dest: 'cli/config/lstm_config.json', description: 'LSTM config', optional: true },
    // CLI also looks for these at src/data/ and dist/data/ relative to cwd (app root)
    { src: 'src/data/stations.json', dest: 'src/data/stations.json', description: 'Station metadata (src)' },
    { src: 'src/data/zones.json', dest: 'src/data/zones.json', description: 'Zone configuration (src)' },
    { src: 'src/data/stations.json', dest: 'dist/data/stations.json', description: 'Station metadata (dist)' },
    { src: 'src/data/zones.json', dest: 'dist/data/zones.json', description: 'Zone configuration (dist)' },
    { src: 'config/lstm_config.json', dest: 'config/lstm_config.json', description: 'LSTM config (root)', optional: true },
  ],

  // CLI files needed
  cliDirs: [
    { src: 'dist', dest: 'cli/dist', description: 'Compiled CLI' },
    { src: 'scripts', dest: 'scripts', description: 'Helper scripts' },
  ],

  // Node modules to copy (selective for smaller size)
  requiredModules: [
    '@fractal-solutions/xgboost-js',
    'adm-zip',
    'axios',
    'better-sqlite3',
    'commander',
    'csv-parse',
    'csv-stringify',
    'date-holidays',
    'luxon',
    'ml-regression-multivariate-linear',
    'ssh2-sftp-client',
    'synaptic',
    // Dependencies of above
    'bindings',
    'file-uri-to-path',
    'prebuild-install',
    'node-abi',
    'napi-build-utils',
    'detect-libc',
    'pump',
    'tar-fs',
    'tar-stream',
    'bl',
    'inherits',
    'readable-stream',
    'string_decoder',
    'safe-buffer',
    'end-of-stream',
    'once',
    'wrappy',
    'fs-constants',
    'mkdirp-classic',
    'buffer',
    'base64-js',
    'ieee754',
    'ssh2',
    'asn1',
    'bcrypt-pbkdf',
    'cpu-features',
    'nan',
  ],
};

// Parse command line arguments
const args = process.argv.slice(2);
const skipData = args.includes('--no-data');
const createZip = args.includes('--zip');
const cleanFirst = args.includes('--clean');

// Parse --output <dir> argument
let customOutputDir = null;
const outputIdx = args.indexOf('--output');
if (outputIdx !== -1 && args[outputIdx + 1]) {
  customOutputDir = args[outputIdx + 1];
}

// Utility functions
function log(message, type = 'info') {
  const prefix = {
    info: '\x1b[36m[INFO]\x1b[0m',
    success: '\x1b[32m[OK]\x1b[0m',
    warn: '\x1b[33m[WARN]\x1b[0m',
    error: '\x1b[31m[ERROR]\x1b[0m',
    step: '\x1b[35m[STEP]\x1b[0m',
  };
  console.log(`${prefix[type] || prefix.info} ${message}`);
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function copyDir(src, dest, description) {
  if (!fs.existsSync(src)) {
    log(`Skipping ${description} - source not found: ${src}`, 'warn');
    return false;
  }

  ensureDir(path.dirname(dest));

  // Use robocopy on Windows for faster copying
  try {
    execSync(`robocopy "${src}" "${dest}" /E /NFL /NDL /NJH /NJS /NC /NS /NP`, {
      stdio: 'pipe',
      windowsHide: true,
    });
  } catch (e) {
    // robocopy returns non-zero exit codes for success, check if dest exists
    if (!fs.existsSync(dest)) {
      // Fallback to recursive copy
      copyDirRecursive(src, dest);
    }
  }

  return true;
}

function copyDirRecursive(src, dest) {
  ensureDir(dest);
  const entries = fs.readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function copyFile(src, dest, description, optional = false) {
  if (!fs.existsSync(src)) {
    if (optional) {
      log(`Skipping optional ${description} - not found: ${src}`, 'warn');
      return false;
    }
    throw new Error(`Required file not found: ${src}`);
  }

  ensureDir(path.dirname(dest));
  fs.copyFileSync(src, dest);
  return true;
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);

    https.get(url, (response) => {
      // Handle redirects
      if (response.statusCode === 302 || response.statusCode === 301) {
        file.close();
        fs.unlinkSync(dest);
        downloadFile(response.headers.location, dest).then(resolve).catch(reject);
        return;
      }

      if (response.statusCode !== 200) {
        reject(new Error(`HTTP ${response.statusCode}`));
        return;
      }

      const total = parseInt(response.headers['content-length'], 10);
      let downloaded = 0;

      response.on('data', (chunk) => {
        downloaded += chunk.length;
        const percent = total ? Math.round((downloaded / total) * 100) : '?';
        process.stdout.write(`\r  Downloading: ${percent}%`);
      });

      response.pipe(file);

      file.on('finish', () => {
        file.close();
        console.log('');
        resolve();
      });
    }).on('error', (err) => {
      fs.unlink(dest, () => {});
      reject(err);
    });
  });
}

function getDirectorySize(dir) {
  if (!fs.existsSync(dir)) return 0;

  let size = 0;
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

// Main build process
async function build() {
  const projectRoot = path.resolve(__dirname, '..');
  const outputDirName = customOutputDir || CONFIG.outputDir;
  const outputDir = path.isAbsolute(outputDirName)
    ? outputDirName
    : path.join(projectRoot, outputDirName);
  const appDir = path.join(outputDir, CONFIG.appName);

  console.log('\n========================================');
  console.log('  Vantage Forecaster Portable Builder');
  console.log('========================================\n');

  // Step 1: Clean if requested
  if (cleanFirst && fs.existsSync(outputDir)) {
    log('Cleaning output directory...', 'step');
    fs.rmSync(outputDir, { recursive: true, force: true });
  }

  ensureDir(appDir);

  // Step 2: Build CLI
  log('Building CLI (TypeScript)...', 'step');
  try {
    execSync('npm run build', { cwd: projectRoot, stdio: 'inherit' });
    log('CLI built successfully', 'success');
  } catch (e) {
    log('CLI build failed', 'error');
    process.exit(1);
  }

  // Step 3: Build Electron app
  log('Building Electron app...', 'step');
  const guiDir = path.join(projectRoot, 'gui');
  try {
    execSync('npm run build', { cwd: guiDir, stdio: 'inherit' });
    log('Electron app built successfully', 'success');
  } catch (e) {
    log('Electron build failed', 'error');
    process.exit(1);
  }

  // Step 4: Remove better-sqlite3 from gui/node_modules if present
  // (No longer needed - all database operations use helper scripts via CLI Node.js)
  log('Cleaning up native modules from Electron app...', 'step');
  const betterSqliteDest = path.join(guiDir, 'node_modules', 'better-sqlite3');
  const bindingsDest = path.join(guiDir, 'node_modules', 'bindings');
  const fileUriDest = path.join(guiDir, 'node_modules', 'file-uri-to-path');

  if (fs.existsSync(betterSqliteDest)) {
    fs.rmSync(betterSqliteDest, { recursive: true, force: true });
    log('  Removed better-sqlite3 from Electron app', 'success');
  }
  if (fs.existsSync(bindingsDest)) {
    fs.rmSync(bindingsDest, { recursive: true, force: true });
    log('  Removed bindings from Electron app', 'success');
  }
  if (fs.existsSync(fileUriDest)) {
    fs.rmSync(fileUriDest, { recursive: true, force: true });
    log('  Removed file-uri-to-path from Electron app', 'success');
  }

  // Step 5: Package Electron app (unpacked for portability)
  log('Packaging Electron app (unpacked)...', 'step');
  try {
    execSync('npx electron-builder --win --dir', { cwd: guiDir, stdio: 'inherit' });
    log('Electron packaged successfully', 'success');
  } catch (e) {
    log('Electron packaging failed', 'error');
    process.exit(1);
  }

  // Step 5: Copy Electron output
  log('Copying Electron app...', 'step');
  const electronOutput = path.join(guiDir, 'release', 'win-unpacked');
  if (fs.existsSync(electronOutput)) {
    copyDir(electronOutput, appDir, 'Electron app');
    log('Electron app copied', 'success');
  } else {
    log(`Electron output not found at ${electronOutput}`, 'error');
    process.exit(1);
  }

  // Step 6: Download portable Node.js
  log('Setting up portable Node.js...', 'step');
  const nodeDir = path.join(appDir, 'cli', 'node');
  const nodeZipUrl = `https://nodejs.org/dist/v${CONFIG.nodeVersion}/node-v${CONFIG.nodeVersion}-win-x64.zip`;
  const nodeZipPath = path.join(outputDir, 'node.zip');

  if (!fs.existsSync(path.join(nodeDir, 'node.exe'))) {
    ensureDir(nodeDir);

    if (!fs.existsSync(nodeZipPath)) {
      log(`Downloading Node.js v${CONFIG.nodeVersion}...`);
      await downloadFile(nodeZipUrl, nodeZipPath);
    }

    log('Extracting Node.js...');
    const zip = new AdmZip(nodeZipPath);
    zip.extractAllTo(outputDir, true);

    // Move from extracted folder to target
    const extractedNodeDir = path.join(outputDir, `node-v${CONFIG.nodeVersion}-win-x64`);
    if (fs.existsSync(extractedNodeDir)) {
      // Copy just node.exe and npm files we need
      fs.copyFileSync(
        path.join(extractedNodeDir, 'node.exe'),
        path.join(nodeDir, 'node.exe')
      );
      fs.rmSync(extractedNodeDir, { recursive: true, force: true });
    }

    log('Portable Node.js ready', 'success');
  } else {
    log('Portable Node.js already present', 'success');
  }

  // Step 7: Copy CLI files
  log('Copying CLI files...', 'step');
  for (const dir of CONFIG.cliDirs) {
    const src = path.join(projectRoot, dir.src);
    const dest = path.join(appDir, dir.dest);
    if (copyDir(src, dest, dir.description)) {
      log(`  ${dir.description} copied`, 'success');
    }
  }

  // Step 8: Copy node_modules (selective)
  log('Copying node_modules (this may take a while)...', 'step');
  const nodeModulesSrc = path.join(projectRoot, 'node_modules');
  const nodeModulesDest = path.join(appDir, 'cli', 'node_modules');
  ensureDir(nodeModulesDest);

  // Copy all modules (selective copy was too fragile with nested dependencies)
  copyDir(nodeModulesSrc, nodeModulesDest, 'node_modules');
  log('node_modules copied', 'success');

  // Step 9: Copy individual files
  log('Copying configuration files...', 'step');
  for (const file of CONFIG.dataFiles) {
    const src = path.join(projectRoot, file.src);
    const dest = path.join(appDir, file.dest);
    if (copyFile(src, dest, file.description, file.optional)) {
      log(`  ${file.description} copied`, 'success');
    }
  }

  // Step 10: Copy data directories (unless --no-data)
  if (!skipData) {
    log('Copying data files...', 'step');
    for (const dir of CONFIG.dataDirs) {
      const src = path.join(projectRoot, dir.src);
      const dest = path.join(appDir, dir.dest);
      if (copyDir(src, dest, dir.description)) {
        const size = formatSize(getDirectorySize(dest));
        log(`  ${dir.description} copied (${size})`, 'success');
      }
    }
  } else {
    log('Skipping data files (--no-data specified)', 'warn');
  }

  // Step 11: Create launcher script
  log('Creating launcher...', 'step');
  const launcherPath = path.join(appDir, 'Start Vantage Forecaster.bat');
  fs.writeFileSync(launcherPath, `@echo off
cd /d "%~dp0"
start "" "%~dp0Vantage Forecaster.exe"
`);
  log('Launcher created', 'success');

  // Step 12: Create portable marker and readme
  const markerPath = path.join(appDir, '.portable');
  fs.writeFileSync(markerPath, `Portable installation created: ${new Date().toISOString()}\n`);

  const readmePath = path.join(appDir, 'README.txt');
  fs.writeFileSync(readmePath, `Vantage Forecaster - Portable Edition
=====================================

Quick Start:
  Double-click "Vantage Forecaster.exe" or "Start Vantage Forecaster.bat"

Folder Structure:
  cli/          - Command-line backend (Node.js + scripts)
  data/         - Database files (iload.db, iload_zonal.db)
  weather_cache/- Cached weather data
  Data Samples/ - Training data
  models/       - Trained calibration models
  forecast.db   - Scheduler history and configuration
  config.json   - API keys and gateway configuration

Updating Data:
  To update training data or weather cache without reinstalling:
  1. Replace the relevant folder with new data
  2. Restart the application

For CLI access:
  Open Command Prompt in this folder and run:
    cli\\node\\node.exe cli\\dist\\index.js <command>

Documentation:
  See Documents/ folder or visit the project repository.
`);

  // Step 13: Calculate and report sizes
  log('Calculating final size...', 'step');
  const totalSize = getDirectorySize(appDir);

  console.log('\n========================================');
  console.log('  Build Complete!');
  console.log('========================================');
  console.log(`  Output: ${appDir}`);
  console.log(`  Size:   ${formatSize(totalSize)}`);
  console.log('========================================\n');

  // Step 14: Create ZIP if requested
  if (createZip) {
    log('Creating ZIP archive...', 'step');
    const zipPath = path.join(outputDir, `${CONFIG.appName}-portable.zip`);

    try {
      execSync(`powershell Compress-Archive -Path "${appDir}\\*" -DestinationPath "${zipPath}" -Force`, {
        stdio: 'inherit',
      });
      const zipSize = formatSize(fs.statSync(zipPath).size);
      log(`ZIP created: ${zipPath} (${zipSize})`, 'success');
    } catch (e) {
      log('ZIP creation failed, trying alternative method...', 'warn');
      const zip = new AdmZip();
      zip.addLocalFolder(appDir, CONFIG.appName);
      zip.writeZip(zipPath);
      const zipSize = formatSize(fs.statSync(zipPath).size);
      log(`ZIP created: ${zipPath} (${zipSize})`, 'success');
    }
  }
}

// Run
build().catch((err) => {
  log(err.message, 'error');
  process.exit(1);
});
