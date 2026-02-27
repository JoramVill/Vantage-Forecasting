/**
 * SFTP Push Service for Vantage-Gateway
 *
 * Uploads forecast CSV files to the central gateway server via SFTP.
 * Files are automatically routed to the correct directory based on filename patterns.
 *
 * Configuration (in priority order):
 * 1. Environment variables: VANTAGE_GATEWAY_HOST, VANTAGE_GATEWAY_PASSWORD, etc.
 * 2. Config file: config.json in project root
 * 3. Built-in defaults
 *
 * Enable auto-push globally via:
 * - Environment: VANTAGE_GATEWAY_ENABLED=true
 * - Config file: { "gateway": { "enabled": true } }
 */

import SftpClient from 'ssh2-sftp-client';
import * as fs from 'fs';
import * as path from 'path';

export interface PushResult {
  success: boolean;
  localPath: string;
  remotePath: string;
  error?: string;
  bytesTransferred?: number;
}

export interface GatewayTestResult {
  connected: boolean;
  directories: {
    path: string;
    accessible: boolean;
    error?: string;
  }[];
  error?: string;
}

export interface GatewayConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  enabled: boolean;
}

export type ForecastCategory =
  | 'day-ahead-demand'
  | 'day-ahead-mhcf'
  | 'week-ahead-demand'
  | 'week-ahead-mhcf'
  | 'historical-scenarios-weekly'
  | 'historical-scenarios-monthly'
  | 'historical-databases';

interface ConfigFile {
  gateway?: {
    host?: string;
    port?: number;
    username?: string;
    password?: string;
    enabled?: boolean;
  };
}

/**
 * Load gateway config from config.json if it exists
 */
function loadConfigFile(): ConfigFile | null {
  const configPath = path.join(process.cwd(), 'config.json');
  if (fs.existsSync(configPath)) {
    try {
      return JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Get SFTP configuration from environment variables or config file
 */
export function getConfig(): GatewayConfig {
  const configFile = loadConfigFile();
  const gw = configFile?.gateway || {};

  return {
    host: process.env.VANTAGE_GATEWAY_HOST || gw.host || '100.115.9.94',
    port: parseInt(process.env.VANTAGE_GATEWAY_PORT || String(gw.port || 22)),
    username: process.env.VANTAGE_GATEWAY_USER || gw.username || 'vantage-upload',
    password: process.env.VANTAGE_GATEWAY_PASSWORD || gw.password || '',
    enabled: process.env.VANTAGE_GATEWAY_ENABLED === 'true' || gw.enabled === true
  };
}

/**
 * Get remote directory based on filename pattern or explicit category
 * Matches structure in Documents/vantage-gateway/GATEWAY_SETUP_COMPLETE.md
 * Note: The SFTP user is chrooted to /opt/vantage/csv_storage
 * so paths are relative to that directory
 */
export function getRemoteDirectory(filename: string, category?: ForecastCategory): string {
  // If explicit category provided
  if (category) {
    const pathMap: Record<ForecastCategory, string> = {
      'day-ahead-demand': '/day-ahead/demand',
      'day-ahead-mhcf': '/day-ahead/mhcf',
      'week-ahead-demand': '/week-ahead/demand',
      'week-ahead-mhcf': '/week-ahead/mhcf',
      'historical-scenarios-weekly': '/historical/scenarios/weekly',
      'historical-scenarios-monthly': '/historical/scenarios/monthly',
      'historical-databases': '/historical/databases'
    };
    return pathMap[category] || '/other';
  }

  // Auto-detect from filename
  const fn = filename.toUpperCase();

  // Day-Ahead patterns
  if (fn.startsWith('DA_DEM') || fn.includes('DAY_AHEAD_DEM')) {
    return '/day-ahead/demand';
  }
  if (fn.startsWith('DA_MHCF') || fn.startsWith('DA_CF') || fn.includes('DAY_AHEAD_MHCF')) {
    return '/day-ahead/mhcf';
  }

  // Week-Ahead patterns
  if (fn.startsWith('WA_DEM') || fn.includes('WEEK_AHEAD_DEM')) {
    return '/week-ahead/demand';
  }
  if (fn.startsWith('WA_MHCF') || fn.startsWith('WA_CF') || fn.includes('WEEK_AHEAD_MHCF')) {
    return '/week-ahead/mhcf';
  }

  // Legacy patterns (backward compatibility)
  // Zonal demand files (must check before regional)
  if (fn.startsWith('FC_ZDEM_') || fn.includes('ZDEM')) {
    return '/demand/zonal';
  }
  // Regional demand files
  if (fn.startsWith('FC_DEM_') || fn.includes('_DEM_')) {
    return '/demand/regional';
  }
  // Capacity factor files
  if (fn.startsWith('FC_CF_') || fn.includes('CFAC') || fn.includes('_CF_')) {
    return '/cfac';
  }

  // Historical patterns
  if (fn.includes('HIST') && fn.includes('WEEKLY')) {
    return '/historical/scenarios/weekly';
  }
  if (fn.includes('HIST') && fn.includes('MONTHLY')) {
    return '/historical/scenarios/monthly';
  }
  if (fn.endsWith('.MDB') || fn.endsWith('.ACCDB')) {
    return '/historical/databases';
  }

  // Default fallback
  return '/other';
}

/**
 * Check if gateway push is enabled globally (via env or config)
 */
export function isGatewayEnabled(): boolean {
  return getConfig().enabled;
}

/**
 * Check if the gateway has been configured (password set)
 */
export function isGatewayConfigured(): boolean {
  return getConfig().password !== '';
}

/**
 * Should push to gateway? Checks both enabled flag and explicit push request
 */
export function shouldPushToGateway(explicitPush?: boolean): boolean {
  // If explicitly requested via --push flag, always try (even if not globally enabled)
  if (explicitPush === true) return true;
  // Otherwise, use the global enabled setting
  return isGatewayEnabled();
}

/**
 * Auto-push a file if gateway is enabled. Non-blocking - logs errors but doesn't throw.
 * Use this after writing forecast files to automatically push when enabled.
 */
export async function autoPushIfEnabled(localPath: string, explicitPush?: boolean): Promise<void> {
  if (!shouldPushToGateway(explicitPush)) {
    return;
  }

  if (!isGatewayConfigured()) {
    if (explicitPush) {
      console.warn('[SFTP] Gateway push requested but password not configured');
    }
    return;
  }

  const result = await pushFileToGateway(localPath);
  if (!result.success) {
    console.warn(`[SFTP] Auto-push failed: ${result.error}`);
  }
}

/**
 * Push a single file to the gateway server
 */
export async function pushFileToGateway(localPath: string, category?: ForecastCategory): Promise<PushResult> {
  const config = getConfig();
  const sftp = new SftpClient();
  const filename = path.basename(localPath);
  const remoteDir = getRemoteDirectory(filename, category);
  const remotePath = `${remoteDir}/${filename}`;

  // Check if password is configured
  if (!config.password) {
    console.error('[SFTP] Error: Gateway password not configured');
    console.error('[SFTP] Set via: VANTAGE_GATEWAY_PASSWORD env var or config.json gateway.password');
    return {
      success: false,
      localPath,
      remotePath,
      error: 'Gateway password not configured. Set VANTAGE_GATEWAY_PASSWORD or add to config.json'
    };
  }

  // Check if local file exists
  if (!fs.existsSync(localPath)) {
    return {
      success: false,
      localPath,
      remotePath,
      error: `Local file not found: ${localPath}`
    };
  }

  try {
    console.log(`[SFTP] Connecting to ${config.host}:${config.port}...`);
    await sftp.connect({
      host: config.host,
      port: config.port,
      username: config.username,
      password: config.password,
      readyTimeout: 30000,
      retries: 2,
      retry_minTimeout: 2000
    });

    // Ensure remote directory exists
    const dirExists = await sftp.exists(remoteDir);
    if (!dirExists) {
      console.log(`[SFTP] Creating directory: ${remoteDir}`);
      await sftp.mkdir(remoteDir, true);
    }

    // Get file size for reporting
    const stats = fs.statSync(localPath);
    const fileSizeKB = (stats.size / 1024).toFixed(1);

    console.log(`[SFTP] Uploading ${filename} (${fileSizeKB} KB) to ${remotePath}...`);
    await sftp.put(localPath, remotePath);

    console.log(`[SFTP] Upload complete: ${filename}`);
    return {
      success: true,
      localPath,
      remotePath,
      bytesTransferred: stats.size
    };
  } catch (error: any) {
    console.error(`[SFTP] Upload failed: ${error.message}`);
    return {
      success: false,
      localPath,
      remotePath,
      error: error.message
    };
  } finally {
    try {
      await sftp.end();
    } catch {
      // Ignore close errors
    }
  }
}

/**
 * Push all CSV files from a directory that match forecast patterns
 */
export async function pushAllForecasts(outputDir: string): Promise<PushResult[]> {
  const results: PushResult[] = [];

  if (!fs.existsSync(outputDir)) {
    console.error(`[SFTP] Output directory not found: ${outputDir}`);
    return results;
  }

  const files = fs.readdirSync(outputDir)
    .filter(f => f.endsWith('.csv') && (
      f.startsWith('FC_') ||
      f.includes('_DEM_') ||
      f.includes('_ZDEM_') ||
      f.includes('_CF_') ||
      f.includes('CFAC')
    ));

  console.log(`[SFTP] Found ${files.length} forecast files to push`);

  for (const file of files) {
    const localPath = path.join(outputDir, file);
    const result = await pushFileToGateway(localPath);
    results.push(result);
  }

  // Summary
  const successful = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success).length;
  console.log(`[SFTP] Push complete: ${successful} succeeded, ${failed} failed`);

  return results;
}

/**
 * Test connection to the gateway and check directory access
 */
export async function testGatewayConnection(): Promise<GatewayTestResult> {
  const config = getConfig();
  const sftp = new SftpClient();

  const directories = [
    '/day-ahead/demand',
    '/day-ahead/mhcf',
    '/week-ahead/demand',
    '/week-ahead/mhcf',
    '/demand/regional',
    '/demand/zonal',
    '/cfac',
    '/other'
  ];

  const result: GatewayTestResult = {
    connected: false,
    directories: []
  };

  // Check if password is configured
  if (!config.password) {
    result.error = 'VANTAGE_GATEWAY_PASSWORD environment variable not set';
    return result;
  }

  try {
    console.log(`[SFTP] Testing connection to ${config.host}:${config.port}...`);
    await sftp.connect({
      host: config.host,
      port: config.port,
      username: config.username,
      password: config.password,
      readyTimeout: 30000
    });

    result.connected = true;
    console.log('[SFTP] Connection successful');

    // Test each directory
    for (const dir of directories) {
      try {
        const exists = await sftp.exists(dir);
        if (exists) {
          // Try to list directory to confirm read access
          await sftp.list(dir);
          result.directories.push({ path: dir, accessible: true });
        } else {
          result.directories.push({
            path: dir,
            accessible: false,
            error: 'Directory does not exist'
          });
        }
      } catch (err: any) {
        result.directories.push({
          path: dir,
          accessible: false,
          error: err.message
        });
      }
    }

    return result;
  } catch (error: any) {
    result.error = error.message;

    // Provide helpful hints for common errors
    if (error.message.includes('ECONNREFUSED')) {
      result.error += ' - Check if Tailscale is connected';
    } else if (error.message.includes('Authentication')) {
      result.error += ' - Check VANTAGE_GATEWAY_PASSWORD';
    } else if (error.message.includes('ETIMEDOUT')) {
      result.error += ' - Network timeout, check Tailscale status';
    }

    return result;
  } finally {
    try {
      await sftp.end();
    } catch {
      // Ignore close errors
    }
  }
}

/**
 * Format test results for console output
 */
export function formatTestResults(result: GatewayTestResult): string {
  const lines: string[] = [];
  const config = getConfig();

  lines.push('');
  lines.push('═══════════════════════════════════════════════════════');
  lines.push('         Vantage Gateway Connection Test');
  lines.push('═══════════════════════════════════════════════════════');
  lines.push('');
  lines.push(`Host:     ${config.host}:${config.port}`);
  lines.push(`User:     ${config.username}`);
  lines.push(`Status:   ${result.connected ? '✓ Connected' : '✗ Failed'}`);

  if (result.error) {
    lines.push(`Error:    ${result.error}`);
  }

  if (result.directories.length > 0) {
    lines.push('');
    lines.push('Remote Directories:');
    for (const dir of result.directories) {
      const status = dir.accessible ? '✓' : '✗';
      const suffix = dir.error ? ` (${dir.error})` : '';
      lines.push(`  ${status} ${dir.path}${suffix}`);
    }
  }

  lines.push('');
  lines.push('═══════════════════════════════════════════════════════');

  return lines.join('\n');
}
