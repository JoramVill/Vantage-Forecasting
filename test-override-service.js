/**
 * Test script for Override Service
 *
 * Verifies that per-entity override functionality works correctly
 */

import { overrideService } from './dist/services/overrideService.js';

console.log('Testing Override Service\n');
console.log('='.repeat(60));

// Test 1: Basic override retrieval
console.log('\nTest 1: Basic override retrieval');
const testOverrides = {
  zones: {
    '01NLUZ': { scalingPercent: 5, calibrationIterations: 3 },
    '02METRO': { scalingPercent: -2, enabled: true }
  },
  regions: {
    'CLUZ': { calibrationIterations: 5 }
  },
  stationTypes: {
    'wind': { modelType: '4tier' },
    'solar': { modelType: 'hybrid', calibrationIterations: 3 }
  }
};

const override1 = overrideService.getEffectiveOverride('01NLUZ', 'zone', testOverrides);
console.log('01NLUZ override:', override1);

const override2 = overrideService.getEffectiveOverride('03SLUZ', 'zone', testOverrides);
console.log('03SLUZ override (should be null):', override2);

// Test 2: Merging with defaults
console.log('\nTest 2: Merging with defaults');
const defaults = {
  modelType: 'hybrid',
  calibrationIterations: 0,
  holdoutDays: 14
};

const merged1 = overrideService.mergeWithDefaults(override1, defaults);
console.log('Merged 01NLUZ:', merged1);

const merged2 = overrideService.mergeWithDefaults(override2, defaults);
console.log('Merged 03SLUZ (no override):', merged2);

// Test 3: Scaling application
console.log('\nTest 3: Scaling application');
const baseValue = 1000;
console.log(`Base value: ${baseValue} MW`);
console.log(`+5% scaling: ${overrideService.applyScaling(baseValue, 5)} MW`);
console.log(`-5% scaling: ${overrideService.applyScaling(baseValue, -5)} MW`);
console.log(`0% scaling: ${overrideService.applyScaling(baseValue, 0)} MW`);

// Test 4: Validation
console.log('\nTest 4: Override validation');
const validationResult = overrideService.validateOverrides(testOverrides);
console.log('Valid:', validationResult.valid);
console.log('Errors:', validationResult.errors);
console.log('Warnings:', validationResult.warnings);

// Test 5: Invalid overrides
console.log('\nTest 5: Invalid override validation');
const invalidOverrides = {
  zones: {
    'INVALID_ZONE': { scalingPercent: 150 }, // Over 100%
    '01NLUZ': { calibrationIterations: 15 }  // Over 10
  },
  regions: {},
  stationTypes: {}
};

const invalidResult = overrideService.validateOverrides(invalidOverrides);
console.log('Valid:', invalidResult.valid);
console.log('Errors:', invalidResult.errors);
console.log('Warnings:', invalidResult.warnings);

// Test 6: Summary generation
console.log('\nTest 6: Overrides summary');
console.log(overrideService.getOverridesSummary(testOverrides));

console.log('\n' + '='.repeat(60));
console.log('All tests completed!');
