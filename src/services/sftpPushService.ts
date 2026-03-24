/**
 * Gateway Push Service for Vantage-Gateway
 *
 * Uploads forecast CSV files to the central gateway server.
 *
 * PHASE 2 UPDATE (Gateway v2.5.0):
 * - NEW: HTTP-based uploads with explicit geography parameter
 * - NEW: License-based JWT authentication
 * - DEPRECATED: SFTP uploads (still available as fallback)
 * - DEPRECATED: Filename-based geography detection
 *
 * Configuration (in priority order):
 * 1. Environment variables:
 *    - HTTP mode: VANTAGE_GATEWAY_URL, VANTAGE_LICENSE_ID
 *    - SFTP mode: VANTAGE_GATEWAY_HOST, VANTAGE_GATEWAY_PASSWORD, etc.
 * 2. Config file: config.json in project root
 * 3. Built-in defaults
 *
 * Enable auto-push globally via:
 * - Environment: VANTAGE_GATEWAY_ENABLED=true
 * - Config file: { "gateway": { "enabled": true } }
 *
 * @see VANTAGE_INTEGRATION_SPEC.md for HTTP upload API specification
 */

import SftpClient from 'ssh2-sftp-client';
import * as fs from 'fs';
import * as path from 'path';
import {
  GatewayHttpService,
  getGatewayHttpService,
  isHttpGatewayConfigured as checkHttpGatewayConfigured,
  type Geography,
  type HttpPushResult,
  type UploadConfig
} from './gatewayHttpService.js';

export interface PushResult {
  success: boolean;
  localPath: string;
  remotePath: string;
  error?: string;
  bytesTransferred?: number;
  /** Indicates if HTTP upload was used (vs SFTP fallback) */
  httpUpload?: boolean;
}

/**
 * Geography type for demand forecasts
 * - 'regional': 3-region format (CLUZ, CVIS, CMIN)
 * - 'zonal': 14-zone format (01NLUZ, 02METRO, etc.)
 */
export type { Geography } from './gatewayHttpService.js';

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
  /** HTTP gateway URL (for v2.5.0+ HTTP uploads) */
  httpUrl?: string;
  /** License ID for HTTP authentication */
  licenseId?: string;
  /** Prefer HTTP upload over SFTP when available */
  preferHttp?: boolean;
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
    // SFTP settings (legacy)
    host?: string;
    port?: number;
    username?: string;
    password?: string;
    enabled?: boolean;
    // HTTP settings (Gateway v2.5.0+)
    httpUrl?: string;
    licenseId?: string;
    preferHttp?: boolean;
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
 * Get gateway configuration from environment variables or config file
 */
export function getConfig(): GatewayConfig {
  const configFile = loadConfigFile();
  const gw = configFile?.gateway || {};

  return {
    // SFTP settings
    host: process.env.VANTAGE_GATEWAY_HOST || gw.host || '100.115.9.94',
    port: parseInt(process.env.VANTAGE_GATEWAY_PORT || String(gw.port || 22)),
    username: process.env.VANTAGE_GATEWAY_USER || gw.username || 'vantage-upload',
    password: process.env.VANTAGE_GATEWAY_PASSWORD || gw.password || '',
    enabled: process.env.VANTAGE_GATEWAY_ENABLED === 'true' || gw.enabled === true,
    // HTTP settings (Gateway v2.5.0+)
    httpUrl: process.env.VANTAGE_GATEWAY_URL || gw.httpUrl || 'https://vantage-gateway.taile437a5.ts.net',
    licenseId: process.env.VANTAGE_LICENSE_ID || gw.licenseId || '',
    preferHttp: process.env.VANTAGE_GATEWAY_PREFER_HTTP === 'true' || gw.preferHttp !== false
  };
}

/**
 * Detect if a filename represents zonal demand data (14 zones)
 * Zonal files use ZDEM prefix or contain 'zonal' in the name
 */
function isZonalDemandFile(filename: string): boolean {
  const fn = filename.toUpperCase();
  return fn.includes('ZDEM') || fn.includes('ZONAL');
}

/**
 * Get remote directory based on filename pattern or explicit category
 * Matches structure in Documents/vantage-gateway/GATEWAY_SETUP_COMPLETE.md
 * Note: The SFTP user is chrooted to /opt/vantage/csv_storage
 * so paths are relative to that directory
 *
 * Directory structure for demand files:
 * - /day-ahead/demand/regional  - 3-region demand files (FC_DEM_*, DA_DEM_*)
 * - /day-ahead/demand/zonal     - 14-zone demand files (FC_ZDEM_*, DA_ZDEM_*)
 * - /week-ahead/demand/regional - 7-day regional demand
 * - /week-ahead/demand/zonal    - 7-day zonal demand
 *
 * MHCF files remain unchanged (no geography split):
 * - /day-ahead/mhcf
 * - /week-ahead/mhcf
 */
export function getRemoteDirectory(filename: string, category?: ForecastCategory): string {
  // If explicit category provided
  if (category) {
    // For demand categories, check if file is zonal to append geography subdirectory
    const isZonal = isZonalDemandFile(filename);
    const geography = isZonal ? '/zonal' : '/regional';

    const pathMap: Record<ForecastCategory, string> = {
      'day-ahead-demand': `/day-ahead/demand${geography}`,
      'day-ahead-mhcf': '/day-ahead/mhcf',  // MHCF never has geography split
      'week-ahead-demand': `/week-ahead/demand${geography}`,
      'week-ahead-mhcf': '/week-ahead/mhcf',  // MHCF never has geography split
      'historical-scenarios-weekly': '/historical/scenarios/weekly',
      'historical-scenarios-monthly': '/historical/scenarios/monthly',
      'historical-databases': '/historical/databases'
    };
    return pathMap[category] || '/other';
  }

  // Auto-detect from filename
  const fn = filename.toUpperCase();
  const isZonal = isZonalDemandFile(filename);
  const geography = isZonal ? '/zonal' : '/regional';

  // Day-Ahead demand patterns - route to geography subdirectory
  // Zonal: DA_ZDEM_*, FC_ZDEM_*, *_ZDEM_*
  // Regional: DA_DEM_*, FC_DEM_*, DA_DEMAND_*
  if (fn.startsWith('DA_ZDEM') || fn.startsWith('FC_ZDEM') || (fn.includes('DAY_AHEAD') && fn.includes('ZDEM'))) {
    return '/day-ahead/demand/zonal';
  }
  if (fn.startsWith('DA_DEMAND') || fn.startsWith('DA_DEM') || fn.startsWith('FC_DEM') || fn.includes('DAY_AHEAD_DEM')) {
    return '/day-ahead/demand/regional';
  }

  // Week-Ahead demand patterns - route to geography subdirectory
  // Zonal: WA_ZDEM_*, FC_ZDEM_* with week-ahead dates
  // Regional: WA_DEM_*, WA_DEMAND_*
  if (fn.startsWith('WA_ZDEM') || (fn.includes('WEEK_AHEAD') && fn.includes('ZDEM'))) {
    return '/week-ahead/demand/zonal';
  }
  if (fn.startsWith('WA_DEMAND') || fn.startsWith('WA_DEM') || fn.includes('WEEK_AHEAD_DEM')) {
    return '/week-ahead/demand/regional';
  }

  // Day-Ahead MHCF patterns (no geography split)
  if (fn.startsWith('DA_MHCF') || fn.startsWith('DA_CF') || fn.includes('DAY_AHEAD_MHCF')) {
    return '/day-ahead/mhcf';
  }

  // Week-Ahead MHCF patterns (no geography split)
  if (fn.startsWith('WA_MHCF') || fn.startsWith('WA_CF') || fn.includes('WEEK_AHEAD_MHCF')) {
    return '/week-ahead/mhcf';
  }

  // Legacy patterns (backward compatibility)
  // Zonal demand files (must check before regional)
  if (fn.startsWith('FC_ZDEM_') || fn.includes('ZDEM')) {
    return '/day-ahead/demand/zonal';  // Default to day-ahead for legacy zonal
  }
  // Regional demand files
  if (fn.startsWith('FC_DEM_') || fn.includes('_DEM_')) {
    return '/day-ahead/demand/regional';  // Default to day-ahead for legacy regional
  }
  // Capacity factor files
  if (fn.startsWith('FC_CF_') || fn.includes('CFAC') || fn.includes('_CF_')) {
    return '/day-ahead/mhcf';  // Default to day-ahead for legacy CFAC
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
 * Check if the gateway has been configured for HTTP uploads (license ID set)
 */
export function isHttpGatewayConfigured(): boolean {
  const config = getConfig();
  return !!(config.licenseId && config.httpUrl);
}

/**
 * Check if the gateway has been configured (password set for SFTP, or license for HTTP)
 */
export function isGatewayConfigured(): boolean {
  const config = getConfig();
  // HTTP gateway takes precedence if license is configured
  if (config.licenseId && config.preferHttp !== false) {
    return true;
  }
  // Fall back to SFTP check
  return config.password !== '';
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
 *
 * @param localPath - Path to the local file to push
 * @param explicitPush - If true, force push even if not globally enabled
 * @param geography - Optional explicit geography for demand files ('regional' or 'zonal')
 */
export async function autoPushIfEnabled(
  localPath: string,
  explicitPush?: boolean,
  geography?: Geography
): Promise<void> {
  if (!shouldPushToGateway(explicitPush)) {
    return;
  }

  if (!isGatewayConfigured()) {
    if (explicitPush) {
      console.warn('[Gateway] Push requested but gateway not configured');
    }
    return;
  }

  const filename = path.basename(localPath);
  console.log(`\n📤 [Gateway] Auto-pushing ${filename}...`);

  const result = await pushFileToGateway(localPath, undefined, geography);
  if (result.success) {
    console.log(`   ✅ [Gateway] Push complete: ${result.remotePath}`);
  } else {
    console.warn(`   ❌ [Gateway] Auto-push failed: ${result.error}`);
  }
}

/**
 * Push a single file to the gateway server using HTTP (preferred) or SFTP (fallback)
 *
 * PHASE 2 UPDATE: This function now supports explicit geography parameter for
 * the HTTP upload endpoint (Gateway v2.5.0+). Geography is no longer inferred
 * from filename patterns when using HTTP upload.
 *
 * @param localPath - Path to the local file to push
 * @param category - Optional forecast category (used for SFTP fallback routing)
 * @param geography - Optional explicit geography for demand files ('regional' or 'zonal')
 */
export async function pushFileToGateway(
  localPath: string,
  category?: ForecastCategory,
  geography?: Geography
): Promise<PushResult> {
  const config = getConfig();
  const filename = path.basename(localPath);

  // Check if local file exists
  if (!fs.existsSync(localPath)) {
    return {
      success: false,
      localPath,
      remotePath: '',
      error: `Local file not found: ${localPath}`
    };
  }

  // Try HTTP upload first if configured and preferred
  if (config.licenseId && config.preferHttp !== false) {
    const httpResult = await pushFileViaHttp(localPath, category, geography);
    if (httpResult.success) {
      return httpResult;
    }
    // Log HTTP failure and fall through to SFTP if available
    console.warn(`[Gateway] HTTP upload failed: ${httpResult.error}`);
    if (config.password) {
      console.log('[Gateway] Falling back to SFTP upload...');
    } else {
      // No SFTP fallback available
      return httpResult;
    }
  }

  // SFTP fallback (or primary if HTTP not configured)
  return pushFileViaSftp(localPath, category);
}

/**
 * Push a file via HTTP upload (Gateway v2.5.0+ API)
 *
 * Uses the new explicit geography parameter, eliminating filename-based routing.
 *
 * @param localPath - Path to the local file
 * @param category - Forecast category (for API endpoint routing)
 * @param geography - Explicit geography for demand files
 */
async function pushFileViaHttp(
  localPath: string,
  category?: ForecastCategory,
  geography?: Geography
): Promise<PushResult> {
  const config = getConfig();
  const filename = path.basename(localPath);

  try {
    const gateway = new GatewayHttpService({
      baseUrl: config.httpUrl || 'https://vantage-gateway.taile437a5.ts.net',
      licenseId: config.licenseId || ''
    });

    // Determine upload config from category or filename
    const uploadConfig = resolveUploadConfig(filename, category, geography);

    console.log(`[Gateway/HTTP] Uploading ${filename} to ${uploadConfig.type}/${uploadConfig.category}` +
      (uploadConfig.geography ? `?geography=${uploadConfig.geography}` : '') + '...');

    const result = await gateway.pushForecast(localPath, uploadConfig);

    if (result.success) {
      console.log(`[Gateway/HTTP] Upload complete: ${result.remotePath}`);
      return {
        success: true,
        localPath,
        remotePath: result.remotePath || '',
        bytesTransferred: result.size,
        httpUpload: true
      };
    }

    return {
      success: false,
      localPath,
      remotePath: '',
      error: result.error,
      httpUpload: true
    };
  } catch (error: any) {
    return {
      success: false,
      localPath,
      remotePath: '',
      error: error.message,
      httpUpload: true
    };
  }
}

/**
 * Resolve upload configuration from category/filename
 * Maps ForecastCategory to HTTP API parameters
 */
function resolveUploadConfig(
  filename: string,
  category?: ForecastCategory,
  geography?: Geography
): UploadConfig {
  const fn = filename.toUpperCase();

  // If explicit category provided, use it
  if (category) {
    const typeMap: Record<string, 'day-ahead' | 'week-ahead'> = {
      'day-ahead-demand': 'day-ahead',
      'day-ahead-mhcf': 'day-ahead',
      'week-ahead-demand': 'week-ahead',
      'week-ahead-mhcf': 'week-ahead',
      'historical-scenarios-weekly': 'week-ahead',
      'historical-scenarios-monthly': 'week-ahead',
      'historical-databases': 'day-ahead'
    };
    const catMap: Record<string, 'demand' | 'mhcf'> = {
      'day-ahead-demand': 'demand',
      'day-ahead-mhcf': 'mhcf',
      'week-ahead-demand': 'demand',
      'week-ahead-mhcf': 'mhcf',
      'historical-scenarios-weekly': 'mhcf',
      'historical-scenarios-monthly': 'mhcf',
      'historical-databases': 'mhcf'
    };

    const uploadCat = catMap[category] || 'demand';

    // Use explicit geography if provided, otherwise infer for demand files
    let resolvedGeography = geography;
    if (!resolvedGeography && uploadCat === 'demand') {
      resolvedGeography = isZonalDemandFile(filename) ? 'zonal' : 'regional';
    }

    return {
      type: typeMap[category] || 'day-ahead',
      category: uploadCat,
      geography: uploadCat === 'demand' ? resolvedGeography : undefined
    };
  }

  // Auto-detect from filename (legacy behavior for backwards compatibility)
  let type: 'day-ahead' | 'week-ahead' = 'day-ahead';
  let cat: 'demand' | 'mhcf' = 'demand';

  // Detect horizon
  if (fn.startsWith('WA_') || fn.includes('WEEK_AHEAD') || fn.includes('WEEKLY')) {
    type = 'week-ahead';
  }

  // Detect category
  if (fn.includes('MHCF') || fn.includes('_CF_') || fn.includes('CFAC')) {
    cat = 'mhcf';
  }

  // Resolve geography (only for demand)
  let resolvedGeography = geography;
  if (!resolvedGeography && cat === 'demand') {
    resolvedGeography = isZonalDemandFile(filename) ? 'zonal' : 'regional';
  }

  return {
    type,
    category: cat,
    geography: cat === 'demand' ? resolvedGeography : undefined
  };
}

/**
 * Push a file via SFTP (legacy method, used as fallback)
 */
async function pushFileViaSftp(
  localPath: string,
  category?: ForecastCategory
): Promise<PushResult> {
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
      bytesTransferred: stats.size,
      httpUpload: false
    };
  } catch (error: any) {
    console.error(`[SFTP] Upload failed: ${error.message}`);
    return {
      success: false,
      localPath,
      remotePath,
      error: error.message,
      httpUpload: false
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
 *
 * @param outputDir - Directory containing forecast files to push
 * @param defaultGeography - Default geography to use for demand files if not detected from filename
 */
export async function pushAllForecasts(
  outputDir: string,
  defaultGeography?: Geography
): Promise<PushResult[]> {
  const results: PushResult[] = [];

  if (!fs.existsSync(outputDir)) {
    console.error(`[Gateway] Output directory not found: ${outputDir}`);
    return results;
  }

  const files = fs.readdirSync(outputDir)
    .filter(f => f.endsWith('.csv') && (
      f.startsWith('FC_') ||
      f.startsWith('DA_') ||
      f.startsWith('WA_') ||
      f.includes('_DEM_') ||
      f.includes('_ZDEM_') ||
      f.includes('_CF_') ||
      f.includes('CFAC') ||
      f.includes('MHCF')
    ));

  console.log(`[Gateway] Found ${files.length} forecast files to push`);

  for (const file of files) {
    const localPath = path.join(outputDir, file);
    // Use filename-based detection if explicit geography not provided
    const geography = defaultGeography || (isZonalDemandFile(file) ? 'zonal' : 'regional');
    const result = await pushFileToGateway(localPath, undefined, geography);
    results.push(result);
  }

  // Summary
  const successful = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success).length;
  const httpCount = results.filter(r => r.httpUpload).length;
  console.log(`[Gateway] Push complete: ${successful} succeeded, ${failed} failed` +
    (httpCount > 0 ? ` (${httpCount} via HTTP)` : ''));

  return results;
}

/**
 * Extended test result including HTTP gateway status
 */
export interface GatewayTestResultExtended extends GatewayTestResult {
  httpEnabled: boolean;
  httpConnected?: boolean;
  httpClientName?: string;
  httpTier?: string;
  httpError?: string;
}

/**
 * Test connection to the gateway (both HTTP and SFTP)
 *
 * Tests HTTP gateway first if configured, then SFTP as fallback.
 */
export async function testGatewayConnection(): Promise<GatewayTestResultExtended> {
  const config = getConfig();

  const result: GatewayTestResultExtended = {
    connected: false,
    directories: [],
    httpEnabled: !!(config.licenseId && config.httpUrl)
  };

  // Test HTTP gateway first if configured
  if (config.licenseId && config.httpUrl) {
    console.log(`[Gateway/HTTP] Testing connection to ${config.httpUrl}...`);
    try {
      const gateway = new GatewayHttpService({
        baseUrl: config.httpUrl,
        licenseId: config.licenseId
      });

      const httpTest = await gateway.testConnection();
      result.httpConnected = httpTest.connected;
      result.httpClientName = httpTest.clientName;
      result.httpTier = httpTest.tier;
      result.httpError = httpTest.error;

      if (httpTest.connected) {
        console.log(`[Gateway/HTTP] Connection successful (${httpTest.clientName}, ${httpTest.tier} tier)`);
        result.connected = true;
      } else {
        console.warn(`[Gateway/HTTP] Connection failed: ${httpTest.error}`);
      }
    } catch (error: any) {
      result.httpError = error.message;
      console.warn(`[Gateway/HTTP] Connection error: ${error.message}`);
    }
  }

  // Test SFTP connection if configured (even if HTTP worked, for completeness)
  const directories = [
    '/day-ahead/demand/regional',
    '/day-ahead/demand/zonal',
    '/day-ahead/mhcf',
    '/week-ahead/demand/regional',
    '/week-ahead/demand/zonal',
    '/week-ahead/mhcf',
    '/historical/scenarios/weekly',
    '/historical/scenarios/monthly',
    '/other'
  ];

  // Check if SFTP password is configured
  if (!config.password) {
    if (!result.connected) {
      result.error = 'Gateway not configured. Set VANTAGE_LICENSE_ID (HTTP) or VANTAGE_GATEWAY_PASSWORD (SFTP)';
    }
    return result;
  }

  const sftp = new SftpClient();

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
    // Only set error if HTTP also failed
    if (!result.httpConnected) {
      result.error = error.message;

      // Provide helpful hints for common errors
      if (error.message.includes('ECONNREFUSED')) {
        result.error += ' - Check if Tailscale is connected';
      } else if (error.message.includes('Authentication')) {
        result.error += ' - Check VANTAGE_GATEWAY_PASSWORD';
      } else if (error.message.includes('ETIMEDOUT')) {
        result.error += ' - Network timeout, check Tailscale status';
      }
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
export function formatTestResults(result: GatewayTestResult | GatewayTestResultExtended): string {
  const lines: string[] = [];
  const config = getConfig();

  lines.push('');
  lines.push('═══════════════════════════════════════════════════════');
  lines.push('         Vantage Gateway Connection Test');
  lines.push('═══════════════════════════════════════════════════════');
  lines.push('');

  // HTTP Gateway status (if extended result)
  const extResult = result as GatewayTestResultExtended;
  if (extResult.httpEnabled !== undefined) {
    lines.push('HTTP Gateway (v2.5.0+):');
    lines.push(`  URL:      ${config.httpUrl || 'not configured'}`);
    lines.push(`  License:  ${config.licenseId ? '********' + config.licenseId.slice(-4) : 'not configured'}`);
    lines.push(`  Status:   ${extResult.httpConnected ? '✓ Connected' : '✗ Failed'}`);
    if (extResult.httpConnected) {
      lines.push(`  Client:   ${extResult.httpClientName} (${extResult.httpTier} tier)`);
    } else if (extResult.httpError) {
      lines.push(`  Error:    ${extResult.httpError}`);
    }
    lines.push('');
  }

  // SFTP Gateway status
  lines.push('SFTP Gateway (legacy):');
  lines.push(`  Host:     ${config.host}:${config.port}`);
  lines.push(`  User:     ${config.username}`);
  lines.push(`  Status:   ${result.directories.length > 0 ? '✓ Connected' : (config.password ? '✗ Failed' : '○ Not configured')}`);

  if (result.error) {
    lines.push(`  Error:    ${result.error}`);
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
