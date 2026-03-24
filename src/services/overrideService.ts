/**
 * Override Service
 *
 * Service for managing and applying per-entity overrides during training.
 * Supports zone, region, and station type overrides for granular control.
 *
 * Reference: MODEL_WORKFLOW_VISION.md Part 1.3 - Per-Zone/Region Granular Settings
 */

import { EntityOverride, TrainingPlanOverrides } from '../types/models.js';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

// Valid zone codes (from zones.json)
const VALID_ZONES = [
  '01NLUZ', '02METRO', '03SLUZ', '04LEYTE', '05CEBU', '06NEGROS',
  '07BOHOL', '08PANAY', '09NWMIN', '10LANAO', '11NCMIN', '12NEMIN',
  '13SEMIN', '14SWMIN'
];

// Valid region codes
const VALID_REGIONS = ['CLUZ', 'CVIS', 'CMIN'];

// Valid station types
const VALID_STATION_TYPES = ['wind', 'solar', 'hydro', 'biomass', 'geothermal', 'battery'];

/**
 * Service for managing and applying per-entity overrides during training
 */
export class OverrideService {
  /**
   * Get the effective override for an entity, checking specific then defaults
   *
   * @param entityCode - The entity code (e.g., "01NLUZ", "CLUZ", "wind")
   * @param entityType - The type of entity ('zone' | 'region' | 'stationType')
   * @param overrides - The complete override configuration
   * @returns The effective override for the entity, or null if no override
   */
  getEffectiveOverride(
    entityCode: string,
    entityType: 'zone' | 'region' | 'stationType',
    overrides: TrainingPlanOverrides
  ): EntityOverride | null {
    let override: EntityOverride | null = null;

    switch (entityType) {
      case 'zone':
        override = overrides.zones[entityCode] || null;
        break;
      case 'region':
        override = overrides.regions[entityCode] || null;
        break;
      case 'stationType':
        override = overrides.stationTypes[entityCode] || null;
        break;
    }

    return override;
  }

  /**
   * Merge an override with defaults
   *
   * @param override - The entity-specific override (or null)
   * @param defaults - Default values to use when not overridden
   * @returns Merged configuration with all values defined
   */
  mergeWithDefaults(
    override: EntityOverride | null,
    defaults: {
      modelType: string;
      calibrationIterations: number;
      holdoutDays: number
    }
  ): {
    modelType: string;
    calibrationIterations: number;
    holdoutDays: number;
    scalingPercent: number;
    enabled: boolean
  } {
    if (!override) {
      return {
        ...defaults,
        scalingPercent: 0,
        enabled: true,
      };
    }

    return {
      modelType: override.modelType ?? defaults.modelType,
      calibrationIterations: override.calibrationIterations ?? defaults.calibrationIterations,
      holdoutDays: override.holdoutDays ?? defaults.holdoutDays,
      scalingPercent: override.scalingPercent ?? 0,
      enabled: override.enabled ?? true,
    };
  }

  /**
   * Apply scaling to a forecast value
   *
   * Scaling formula: value * (1 + scalingPercent / 100)
   *
   * Examples:
   * - scalingPercent = 5  → value * 1.05 (+5%)
   * - scalingPercent = -5 → value * 0.95 (-5%)
   *
   * @param value - The original forecast value
   * @param scalingPercent - The scaling percentage (e.g., 5 for +5%, -5 for -5%)
   * @returns The scaled value
   */
  applyScaling(value: number, scalingPercent: number): number {
    if (scalingPercent === 0) {
      return value;
    }
    return value * (1 + scalingPercent / 100);
  }

  /**
   * Get all zone codes that have overrides
   *
   * @param overrides - The complete override configuration
   * @returns Array of zone codes with overrides
   */
  getZonesWithOverrides(overrides: TrainingPlanOverrides): string[] {
    return Object.keys(overrides.zones);
  }

  /**
   * Get all region codes that have overrides
   *
   * @param overrides - The complete override configuration
   * @returns Array of region codes with overrides
   */
  getRegionsWithOverrides(overrides: TrainingPlanOverrides): string[] {
    return Object.keys(overrides.regions);
  }

  /**
   * Get all station type codes that have overrides
   *
   * @param overrides - The complete override configuration
   * @returns Array of station type codes with overrides
   */
  getStationTypesWithOverrides(overrides: TrainingPlanOverrides): string[] {
    return Object.keys(overrides.stationTypes);
  }

  /**
   * Validate overrides (check entity codes exist, values in range)
   *
   * Validates:
   * - Entity codes are valid (warns for unknown, doesn't fail)
   * - scalingPercent is in reasonable range (-100 to +100)
   * - calibrationIterations is 0-10
   * - holdoutDays is positive
   *
   * @param overrides - The complete override configuration
   * @returns Validation result with errors/warnings
   */
  validateOverrides(overrides: TrainingPlanOverrides): {
    valid: boolean;
    errors: string[];
    warnings: string[];
  } {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Validate zones
    for (const [zoneCode, override] of Object.entries(overrides.zones)) {
      if (!VALID_ZONES.includes(zoneCode)) {
        warnings.push(`Unknown zone code: ${zoneCode} (will be ignored)`);
      }
      this.validateOverrideValues(override, zoneCode, errors);
    }

    // Validate regions
    for (const [regionCode, override] of Object.entries(overrides.regions)) {
      if (!VALID_REGIONS.includes(regionCode)) {
        warnings.push(`Unknown region code: ${regionCode} (will be ignored)`);
      }
      this.validateOverrideValues(override, regionCode, errors);
    }

    // Validate station types
    for (const [stationType, override] of Object.entries(overrides.stationTypes)) {
      if (!VALID_STATION_TYPES.includes(stationType)) {
        warnings.push(`Unknown station type: ${stationType} (will be ignored)`);
      }
      this.validateOverrideValues(override, stationType, errors);
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * Validate individual override values
   *
   * @param override - The override to validate
   * @param entityCode - The entity code (for error messages)
   * @param errors - Array to accumulate errors
   */
  private validateOverrideValues(
    override: EntityOverride,
    entityCode: string,
    errors: string[]
  ): void {
    // Validate scalingPercent
    if (override.scalingPercent !== undefined) {
      if (override.scalingPercent < -100 || override.scalingPercent > 100) {
        errors.push(
          `${entityCode}: scalingPercent must be between -100 and +100 (got ${override.scalingPercent})`
        );
      }
    }

    // Validate calibrationIterations
    if (override.calibrationIterations !== undefined) {
      if (override.calibrationIterations < 0 || override.calibrationIterations > 10) {
        errors.push(
          `${entityCode}: calibrationIterations must be between 0 and 10 (got ${override.calibrationIterations})`
        );
      }
    }

    // Validate holdoutDays
    if (override.holdoutDays !== undefined) {
      if (override.holdoutDays <= 0) {
        errors.push(
          `${entityCode}: holdoutDays must be positive (got ${override.holdoutDays})`
        );
      }
    }
  }

  /**
   * Load zone codes from zones.json (runtime validation)
   *
   * @returns Array of valid zone codes
   */
  loadValidZoneCodes(): string[] {
    try {
      const zonesPath = join(process.cwd(), 'src', 'data', 'zones.json');
      if (existsSync(zonesPath)) {
        const zonesData = JSON.parse(readFileSync(zonesPath, 'utf8'));
        if (zonesData.zones && Array.isArray(zonesData.zones)) {
          return zonesData.zones.map((z: any) => z.code);
        }
      }
    } catch (error) {
      // Fallback to hardcoded if file read fails
      console.warn('Failed to load zones.json, using hardcoded zone codes');
    }
    return VALID_ZONES;
  }

  /**
   * Create a summary of applied overrides for logging
   *
   * @param overrides - The complete override configuration
   * @returns Human-readable summary string
   */
  getOverridesSummary(overrides: TrainingPlanOverrides): string {
    const lines: string[] = [];

    const zoneCount = Object.keys(overrides.zones).length;
    const regionCount = Object.keys(overrides.regions).length;
    const stationTypeCount = Object.keys(overrides.stationTypes).length;

    if (zoneCount === 0 && regionCount === 0 && stationTypeCount === 0) {
      return 'No overrides configured (using all defaults)';
    }

    lines.push('Overrides configured:');

    if (zoneCount > 0) {
      lines.push(`  Zones: ${zoneCount}`);
      for (const [code, override] of Object.entries(overrides.zones)) {
        const parts: string[] = [];
        if (override.scalingPercent !== undefined) {
          parts.push(`${override.scalingPercent > 0 ? '+' : ''}${override.scalingPercent}% scaling`);
        }
        if (override.modelType !== undefined) {
          parts.push(`model: ${override.modelType}`);
        }
        if (override.calibrationIterations !== undefined) {
          parts.push(`${override.calibrationIterations} cal iters`);
        }
        if (override.enabled === false) {
          parts.push('DISABLED');
        }
        lines.push(`    ${code}: ${parts.join(', ')}`);
      }
    }

    if (regionCount > 0) {
      lines.push(`  Regions: ${regionCount}`);
      for (const [code, override] of Object.entries(overrides.regions)) {
        const parts: string[] = [];
        if (override.scalingPercent !== undefined) {
          parts.push(`${override.scalingPercent > 0 ? '+' : ''}${override.scalingPercent}% scaling`);
        }
        if (override.modelType !== undefined) {
          parts.push(`model: ${override.modelType}`);
        }
        if (override.calibrationIterations !== undefined) {
          parts.push(`${override.calibrationIterations} cal iters`);
        }
        if (override.enabled === false) {
          parts.push('DISABLED');
        }
        lines.push(`    ${code}: ${parts.join(', ')}`);
      }
    }

    if (stationTypeCount > 0) {
      lines.push(`  Station Types: ${stationTypeCount}`);
      for (const [code, override] of Object.entries(overrides.stationTypes)) {
        const parts: string[] = [];
        if (override.scalingPercent !== undefined) {
          parts.push(`${override.scalingPercent > 0 ? '+' : ''}${override.scalingPercent}% scaling`);
        }
        if (override.modelType !== undefined) {
          parts.push(`model: ${override.modelType}`);
        }
        if (override.calibrationIterations !== undefined) {
          parts.push(`${override.calibrationIterations} cal iters`);
        }
        if (override.enabled === false) {
          parts.push('DISABLED');
        }
        lines.push(`    ${code}: ${parts.join(', ')}`);
      }
    }

    return lines.join('\n');
  }
}

// Export singleton instance
export const overrideService = new OverrideService();
