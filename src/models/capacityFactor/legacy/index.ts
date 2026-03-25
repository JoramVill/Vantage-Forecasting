/**
 * Legacy CFAC Models - Backward Compatibility Exports
 *
 * These models have been superseded by V2 unified models but are retained
 * for reference and backward compatibility.
 *
 * V2 Recommended Models:
 * - Wind: WindHybridModel (alias for Wind4TierHybridModel)
 * - Solar: SolarHybridModel (enhanced with hourly calibration)
 * - Profile: ProfileBasedModel
 *
 * Legacy models should NOT be used for new forecasts.
 */

// Wind legacy models
export { WindMRECModel } from './WindMRECModel.js';
export { WindEnhancedHybridModel } from './WindEnhancedHybridModel.js';
export { WindWeatherHybridModel } from './WindWeatherHybridModel.js';
export { WindHybridModel as WindHybridModelLegacy } from './WindHybridModel.js';  // Original power curve version

// Solar legacy models
export { SolarIrradianceModel } from './SolarIrradianceModel.js';
export { SolarMRECHybridModel } from './SolarMRECHybridModel.js';
export { SolarPremiumHybridModel } from './SolarPremiumHybridModel.js';
