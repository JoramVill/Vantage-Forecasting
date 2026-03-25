import { loadCfacCalibration } from '../pipeline/CfacModelSerializer.js';
import { getConfigService } from './configService.js';
import fs from 'fs';
import path from 'path';

export interface RetrainAlert {
  stationCode: string;
  stationType: 'wind' | 'solar' | 'profile';
  currentMape: number;
  threshold: number;
  recommendation: string;
  severity: 'warning' | 'critical';
}

export interface CacheStatus {
  clusterId: string;
  lastModified: Date;
  ageHours: number;
  isStale: boolean;
}

export class CfacRetrainMonitor {
  private calibrationPath: string;
  private weatherCachePath: string;
  private config: {
    mapeThresholdWind: number;
    mapeThresholdSolar: number;
    staleCacheHours: number;
  };

  constructor(calibrationPath: string, weatherCachePath: string = './weather_cache') {
    this.calibrationPath = calibrationPath;
    this.weatherCachePath = weatherCachePath;

    // Load thresholds from config
    const configService = getConfigService();
    const v2Config = configService.getV2CfacConfig?.() || {};
    const retrainConfig = v2Config.retrainMonitor || {};

    this.config = {
      mapeThresholdWind: retrainConfig.mapeThresholdWind ?? 80,
      mapeThresholdSolar: retrainConfig.mapeThresholdSolar ?? 25,
      staleCacheHours: retrainConfig.staleCacheHours ?? 24
    };
  }

  /**
   * Check all stations for retrain alerts
   */
  checkRetrainAlerts(): RetrainAlert[] {
    const alerts: RetrainAlert[] = [];

    // Load calibration metrics
    const calibration = loadCfacCalibration(this.calibrationPath);

    // Check wind stations
    for (const [stationCode, metrics] of Object.entries(calibration.metrics.wind || {})) {
      if (metrics.mape > this.config.mapeThresholdWind) {
        alerts.push({
          stationCode,
          stationType: 'wind',
          currentMape: metrics.mape,
          threshold: this.config.mapeThresholdWind,
          recommendation: `Wind station ${stationCode} MAPE ${metrics.mape.toFixed(1)}% exceeds ${this.config.mapeThresholdWind}%. Consider retraining with more recent data.`,
          severity: metrics.mape > this.config.mapeThresholdWind * 1.5 ? 'critical' : 'warning'
        });
      }
    }

    // Check solar stations
    for (const [stationCode, metrics] of Object.entries(calibration.metrics.solar || {})) {
      if (metrics.mape > this.config.mapeThresholdSolar) {
        alerts.push({
          stationCode,
          stationType: 'solar',
          currentMape: metrics.mape,
          threshold: this.config.mapeThresholdSolar,
          recommendation: `Solar station ${stationCode} MAPE ${metrics.mape.toFixed(1)}% exceeds ${this.config.mapeThresholdSolar}%. Consider retraining.`,
          severity: metrics.mape > this.config.mapeThresholdSolar * 1.5 ? 'critical' : 'warning'
        });
      }
    }

    return alerts;
  }

  /**
   * Check weather cache for stale files
   */
  checkWeatherCacheStaleness(): CacheStatus[] {
    const statuses: CacheStatus[] = [];
    const now = Date.now();

    if (!fs.existsSync(this.weatherCachePath)) {
      return statuses;
    }

    // Scan weather cache directories
    const clusters = fs.readdirSync(this.weatherCachePath, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);

    for (const clusterId of clusters) {
      const clusterPath = path.join(this.weatherCachePath, clusterId);

      // Find most recent file in cluster
      let mostRecentMtime = 0;

      const scanDir = (dirPath: string) => {
        const entries = fs.readdirSync(dirPath, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dirPath, entry.name);
          if (entry.isDirectory()) {
            scanDir(fullPath);
          } else if (entry.isFile() && entry.name.endsWith('.csv')) {
            const stat = fs.statSync(fullPath);
            if (stat.mtimeMs > mostRecentMtime) {
              mostRecentMtime = stat.mtimeMs;
            }
          }
        }
      };

      scanDir(clusterPath);

      if (mostRecentMtime > 0) {
        const ageHours = (now - mostRecentMtime) / (1000 * 60 * 60);
        statuses.push({
          clusterId,
          lastModified: new Date(mostRecentMtime),
          ageHours,
          isStale: ageHours > this.config.staleCacheHours
        });
      }
    }

    return statuses;
  }

  /**
   * Get summary report
   */
  getSummary(): {
    retrainAlerts: RetrainAlert[];
    staleCaches: CacheStatus[];
    needsAttention: boolean;
  } {
    const retrainAlerts = this.checkRetrainAlerts();
    const staleCaches = this.checkWeatherCacheStaleness().filter(s => s.isStale);

    return {
      retrainAlerts,
      staleCaches,
      needsAttention: retrainAlerts.length > 0 || staleCaches.length > 0
    };
  }
}

// Export factory function
export function createCfacRetrainMonitor(
  calibrationPath: string,
  weatherCachePath?: string
): CfacRetrainMonitor {
  return new CfacRetrainMonitor(calibrationPath, weatherCachePath);
}
