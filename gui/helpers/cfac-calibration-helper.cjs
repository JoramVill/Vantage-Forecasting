/**
 * CFAC Calibration Service Helper
 *
 * Standalone script to interact with CFACCalibrationService from Electron main process.
 * Avoids ESM/CJS compatibility issues by running service methods in a separate Node process.
 */

const path = require('path');

async function main() {
  const method = process.argv[2];
  const args = process.argv.slice(3).map(arg => JSON.parse(arg));

  // Dynamically import the ESM module
  const { CFACCalibrationService } = await import('../../dist/services/cfacCalibrationService.js');

  const service = new CFACCalibrationService();

  let result;

  switch (method) {
    case 'list':
      result = service.listCalibrations();
      break;
    case 'get':
      result = service.loadCalibration(args[0]);
      break;
    case 'setActive':
      service.setActiveCalibration(args[0]);
      result = true;
      break;
    case 'delete':
      result = service.deleteCalibration(args[0]);
      break;
    default:
      throw new Error(`Unknown method: ${method}`);
  }

  // Output result as JSON
  console.log(JSON.stringify(result));
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
