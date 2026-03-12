/**
 * Gateway HTTP Service for Vantage-Gateway v2.5.0
 *
 * Implements HTTP-based forecast file uploads with explicit geography routing.
 * This replaces the filename-based SFTP approach with a more reliable method
 * where geography is passed explicitly from the forecast generation context.
 *
 * @see VANTAGE_INTEGRATION_SPEC.md for full API specification
 */

import axios, { AxiosError, AxiosInstance } from 'axios';
import FormData from 'form-data';
import * as fs from 'fs';
import * as path from 'path';

// ============================================================================
// Type Definitions (from VANTAGE_INTEGRATION_SPEC.md)
// ============================================================================

export type ForecastType = 'day-ahead' | 'week-ahead';
export type ForecastCategory = 'demand' | 'mhcf';
export type Geography = 'regional' | 'zonal';

/**
 * Upload request configuration
 */
export interface UploadConfig {
  type: ForecastType;
  category: ForecastCategory;
  geography?: Geography;  // Only for demand files
  forecastDate?: string;  // YYYY-MM-DD format, optional override
}

/**
 * Successful upload response
 */
export interface UploadResponse {
  message: string;
  file: {
    type: ForecastType;
    category: ForecastCategory;
    filename: string;
    geography: Geography | null;
    path: string;
    size: number;
    date: string;
    startDate: string;
    endDate: string | null;
  };
}

/**
 * Error response from gateway
 */
export interface GatewayErrorResponse {
  error: string;
  message?: string;
  detail?: string;
  code?: string;
  validValues?: string[];
  validTypes?: string[];
  validCategories?: string[];
  declaredGeography?: string;
}

/**
 * Authentication request
 */
export interface AuthRequest {
  licenseId: string;
  clientName?: string;
}

/**
 * Authentication response
 */
export interface AuthResponse {
  token: string;
  clientName: string;
  tier: string;
  expiresIn: string;
  licenseExpiresAt: string | null;
}

/**
 * Push result for a single file
 */
export interface HttpPushResult {
  success: boolean;
  localPath: string;
  remotePath?: string;
  size?: number;
  error?: string;
  errorCode?: string;
  retryable?: boolean;
}

/**
 * Gateway HTTP configuration
 */
export interface GatewayHttpConfig {
  /** Gateway base URL (e.g., https://vantage-gateway.taile437a5.ts.net) */
  baseUrl: string;
  /** License ID for authentication */
  licenseId: string;
  /** Request timeout in milliseconds (default: 30000) */
  timeout?: number;
  /** Maximum retry attempts for transient errors (default: 3) */
  maxRetries?: number;
}

// ============================================================================
// Error Codes (non-retryable validation errors)
// ============================================================================

const NON_RETRYABLE_ERRORS = new Set([
  'INVALID_TYPE',
  'INVALID_CATEGORY',
  'INVALID_GEOGRAPHY',
  'GEOGRAPHY_NOT_APPLICABLE',
  'NO_FILE_UPLOADED',
  'CONTENT_GEOGRAPHY_MISMATCH',
  'CANNOT_DETERMINE_DATE',
  'INVALID_DATE_FORMAT',
  'INVALID_FILE_TYPE'
]);

// ============================================================================
// Gateway HTTP Service Implementation
// ============================================================================

/**
 * Gateway HTTP Service
 *
 * Provides HTTP-based forecast file uploads to Vantage Gateway v2.5.0.
 * Uses JWT token authentication with automatic refresh.
 *
 * Example usage:
 * ```typescript
 * const gateway = new GatewayHttpService({
 *   baseUrl: 'https://vantage-gateway.taile437a5.ts.net',
 *   licenseId: process.env.VANTAGE_LICENSE_ID!
 * });
 *
 * const result = await gateway.pushForecast(
 *   './output/da_demand_2026-03-15.csv',
 *   {
 *     type: 'day-ahead',
 *     category: 'demand',
 *     geography: 'regional'  // Explicit geography - no filename parsing needed!
 *   }
 * );
 * ```
 */
export class GatewayHttpService {
  private config: Required<GatewayHttpConfig>;
  private token: string | null = null;
  private tokenExpiry: Date | null = null;
  private client: AxiosInstance;

  constructor(config: GatewayHttpConfig) {
    this.config = {
      timeout: 30000,
      maxRetries: 3,
      ...config
    };

    // Create axios client with default config
    this.client = axios.create({
      baseURL: this.config.baseUrl,
      timeout: this.config.timeout,
      maxContentLength: 10 * 1024 * 1024, // 10MB
      maxBodyLength: 10 * 1024 * 1024
    });
  }

  /**
   * Authenticate with the gateway and obtain a JWT token
   */
  async authenticate(): Promise<AuthResponse> {
    try {
      const response = await this.client.post<AuthResponse>('/auth/license', {
        licenseId: this.config.licenseId,
        clientName: 'Vantage Forecaster'
      });

      this.token = response.data.token;
      // Token valid for 24 hours, refresh at 23 hours for safety margin
      this.tokenExpiry = new Date(Date.now() + 23 * 60 * 60 * 1000);

      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const axiosError = error as AxiosError<GatewayErrorResponse>;
        const errorData = axiosError.response?.data;
        throw new Error(
          `Authentication failed: ${errorData?.error || error.message}`
        );
      }
      throw error;
    }
  }

  /**
   * Check if the current token is valid and not expired
   */
  isTokenValid(): boolean {
    return (
      this.token !== null &&
      this.tokenExpiry !== null &&
      new Date() < this.tokenExpiry
    );
  }

  /**
   * Ensure we have a valid token, refreshing if necessary
   */
  private async ensureAuth(): Promise<string> {
    if (!this.isTokenValid()) {
      await this.authenticate();
    }
    return this.token!;
  }

  /**
   * Push a forecast file to the gateway using HTTP upload
   *
   * This method uses the new explicit geography parameter from Gateway v2.5.0,
   * eliminating the need for filename pattern matching.
   *
   * @param filePath - Path to the local forecast file
   * @param config - Upload configuration with type, category, and optional geography
   * @returns Push result with success status and remote path
   */
  async pushForecast(
    filePath: string,
    config: UploadConfig
  ): Promise<HttpPushResult> {
    // Validate file exists
    if (!fs.existsSync(filePath)) {
      return {
        success: false,
        localPath: filePath,
        error: `Local file not found: ${filePath}`,
        retryable: false
      };
    }

    // Validate geography is only used with demand category
    if (config.geography && config.category !== 'demand') {
      return {
        success: false,
        localPath: filePath,
        error: 'Geography parameter only applies to demand category',
        errorCode: 'GEOGRAPHY_NOT_APPLICABLE',
        retryable: false
      };
    }

    let lastError: string | undefined;
    let lastErrorCode: string | undefined;

    for (let attempt = 1; attempt <= this.config.maxRetries; attempt++) {
      try {
        const token = await this.ensureAuth();

        // Build URL with geography parameter if applicable
        const url = new URL(
          `/forecasts/upload/${config.type}/${config.category}`,
          this.config.baseUrl
        );
        if (config.geography && config.category === 'demand') {
          url.searchParams.set('geography', config.geography);
        }

        // Create form data
        const form = new FormData();
        form.append('file', fs.createReadStream(filePath));

        // Add optional forecast date if provided
        if (config.forecastDate) {
          form.append('forecastDate', config.forecastDate);
        }

        // Upload file
        const response = await this.client.post<UploadResponse>(
          url.pathname + url.search,
          form,
          {
            headers: {
              ...form.getHeaders(),
              Authorization: `Bearer ${token}`
            }
          }
        );

        return {
          success: true,
          localPath: filePath,
          remotePath: response.data.file.path,
          size: response.data.file.size
        };
      } catch (error) {
        if (axios.isAxiosError(error)) {
          const axiosError = error as AxiosError<GatewayErrorResponse>;
          const errorData = axiosError.response?.data;
          const errorCode = errorData?.code;

          // Handle token expiry - re-auth and retry
          if (
            axiosError.response?.status === 401 &&
            errorCode === 'TOKEN_EXPIRED'
          ) {
            this.token = null;
            // Retry will happen in next loop iteration
            lastError = 'Token expired, re-authenticating...';
            lastErrorCode = errorCode;
            continue;
          }

          // Don't retry validation errors
          if (errorCode && NON_RETRYABLE_ERRORS.has(errorCode)) {
            return {
              success: false,
              localPath: filePath,
              error: errorData?.error || error.message,
              errorCode,
              retryable: false
            };
          }

          lastError = errorData?.error || error.message;
          lastErrorCode = errorCode;
        } else {
          lastError = error instanceof Error ? error.message : 'Unknown error';
        }

        // Exponential backoff for network errors (only if not last attempt)
        if (attempt < this.config.maxRetries) {
          await this.delay(1000 * Math.pow(2, attempt));
        }
      }
    }

    return {
      success: false,
      localPath: filePath,
      error: `Failed after ${this.config.maxRetries} attempts: ${lastError}`,
      errorCode: lastErrorCode,
      retryable: true
    };
  }

  /**
   * Push multiple forecast files to the gateway
   *
   * @param files - Array of file configurations to push
   * @returns Map of file paths to push results
   */
  async pushMultiple(
    files: Array<{
      path: string;
      type: ForecastType;
      category: ForecastCategory;
      geography?: Geography;
    }>
  ): Promise<Map<string, HttpPushResult>> {
    const results = new Map<string, HttpPushResult>();

    for (const file of files) {
      const result = await this.pushForecast(file.path, {
        type: file.type,
        category: file.category,
        geography: file.geography
      });
      results.set(file.path, result);
    }

    return results;
  }

  /**
   * Test connection to the gateway
   *
   * @returns True if authentication succeeds
   */
  async testConnection(): Promise<{
    connected: boolean;
    clientName?: string;
    tier?: string;
    error?: string;
  }> {
    try {
      const authResponse = await this.authenticate();
      return {
        connected: true,
        clientName: authResponse.clientName,
        tier: authResponse.tier
      };
    } catch (error) {
      return {
        connected: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  /**
   * Get the current configuration
   */
  getConfig(): Readonly<Required<GatewayHttpConfig>> {
    return { ...this.config };
  }

  /**
   * Helper: delay for exponential backoff
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// ============================================================================
// Singleton Instance and Factory Functions
// ============================================================================

let defaultInstance: GatewayHttpService | null = null;

/**
 * Get or create the default GatewayHttpService instance
 *
 * Configuration priority:
 * 1. VANTAGE_GATEWAY_URL environment variable (for base URL)
 * 2. VANTAGE_LICENSE_ID environment variable (for license ID)
 * 3. config.json gateway settings (legacy fallback)
 */
export function getGatewayHttpService(
  config?: GatewayHttpConfig
): GatewayHttpService {
  if (config) {
    return new GatewayHttpService(config);
  }

  if (!defaultInstance) {
    const baseUrl =
      process.env.VANTAGE_GATEWAY_URL ||
      'https://vantage-gateway.taile437a5.ts.net';
    const licenseId = process.env.VANTAGE_LICENSE_ID || '';

    if (!licenseId) {
      throw new Error(
        'VANTAGE_LICENSE_ID environment variable not set. ' +
          'Set this to your Vantage license ID to enable HTTP gateway uploads.'
      );
    }

    defaultInstance = new GatewayHttpService({
      baseUrl,
      licenseId
    });
  }

  return defaultInstance;
}

/**
 * Check if HTTP gateway is configured (license ID is set)
 */
export function isHttpGatewayConfigured(): boolean {
  return !!process.env.VANTAGE_LICENSE_ID;
}

/**
 * Clear the cached default instance (useful for testing)
 */
export function clearGatewayHttpServiceInstance(): void {
  defaultInstance = null;
}
