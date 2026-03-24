/**
 * Test CFAC Calibration Service
 *
 * Simple test to verify the CFACCalibrationService works correctly.
 */

import { CFACCalibrationService } from '../src/services/cfacCalibrationService.js';
import { CFACCalibrationState } from '../src/types/cfacCalibration.js';

async function testCalibrationService() {
  console.log('Testing CFAC Calibration Service...\n');

  const service = new CFACCalibrationService();

  // Create test calibration state
  const testCalibration: CFACCalibrationState = {
    id: '',  // Will be auto-generated
    createdAt: '',  // Will be auto-generated
    trainingPeriod: {
      start: '2026-02-01',
      end: '2026-03-18',
    },
    config: {
      useXgboost: false,
      asymmetricLoss: true,
      biasCorrection: true,
      autoCalibrateDays: 14,
      excludeOutages: true,
    },
    globalFactors: {
      windBias: 0.92,
      solarBias: 1.05,
      otherBias: 1.0,
    },
    solarHourlyScale: {
      6: 0.85,
      7: 0.92,
      8: 0.98,
      9: 1.02,
      10: 1.05,
      11: 1.03,
      12: 1.00,
      13: 0.98,
      14: 0.95,
      15: 0.90,
      16: 0.85,
      17: 0.75,
      18: 0.60,
    },
    windMRECFactors: {
      '01BURGOS': {
        stationCode: '01BURGOS',
        vL: 3.5,
        vH: 12.0,
        tL: 0.15,
        tH: 0.85,
        calibrated: true,
      },
      '01PAGUDPUD': {
        stationCode: '01PAGUDPUD',
        vL: 4.0,
        vH: 14.0,
        tL: 0.12,
        tH: 0.80,
        calibrated: true,
      },
    },
    stationScales: {
      wind: {
        '01BURGOS': 1.08,
        '01PAGUDPUD': 0.95,
      },
      solar: {
        '01CLARK_S': 1.12,
        '01CURIMAO': 0.98,
      },
      other: {},
    },
    trainingMetrics: {
      windMAPE: 48.2,
      solarMAPE: 18.5,
      stationCount: 52,
      trainingRecords: 185000,
    },
  };

  try {
    // Test 1: Save calibration
    console.log('Test 1: Save calibration');
    const id = await service.saveCalibration(testCalibration);
    console.log(`✓ Saved calibration: ${id}\n`);

    // Test 2: Load calibration
    console.log('Test 2: Load calibration');
    const loaded = await service.loadCalibration(id);
    if (!loaded) {
      throw new Error('Failed to load calibration');
    }
    console.log(`✓ Loaded calibration: ${loaded.id}`);
    console.log(`  Wind MAPE: ${loaded.trainingMetrics.windMAPE}%`);
    console.log(`  Solar MAPE: ${loaded.trainingMetrics.solarMAPE}%\n`);

    // Test 3: List calibrations
    console.log('Test 3: List calibrations');
    const list = await service.listCalibrations();
    console.log(`✓ Found ${list.length} calibration(s)`);
    for (const cal of list) {
      console.log(`  - ${cal.id} (${cal.trainingStart} to ${cal.trainingEnd})`);
      console.log(`    Wind: ${cal.windMAPE}% | Solar: ${cal.solarMAPE}% | ${cal.stationCount} stations`);
    }
    console.log('');

    // Test 4: Set active calibration
    console.log('Test 4: Set active calibration');
    await service.setActiveCalibration(id);
    console.log(`✓ Set active calibration: ${id}\n`);

    // Test 5: Get active calibration
    console.log('Test 5: Get active calibration');
    const active = await service.getActiveCalibration();
    if (!active) {
      throw new Error('Failed to get active calibration');
    }
    console.log(`✓ Active calibration: ${active.id}`);
    console.log(`  Training period: ${active.trainingPeriod.start} to ${active.trainingPeriod.end}\n`);

    // Test 6: Delete calibration
    console.log('Test 6: Delete calibration');
    const deleted = await service.deleteCalibration(id);
    if (!deleted) {
      throw new Error('Failed to delete calibration');
    }
    console.log(`✓ Deleted calibration: ${id}\n`);

    // Verify deletion
    console.log('Test 7: Verify deletion');
    const deletedCal = await service.loadCalibration(id);
    if (deletedCal !== null) {
      throw new Error('Calibration still exists after deletion');
    }
    console.log(`✓ Confirmed calibration was deleted\n`);

    console.log('All tests passed! ✓');
  } catch (error) {
    console.error('Test failed:', error);
    process.exit(1);
  }
}

testCalibrationService();
