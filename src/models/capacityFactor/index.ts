/**
 * Capacity Factor Models - V2
 *
 * Physics-based and hybrid models for predicting renewable energy capacity factors
 *
 * V2 Changes (CFAC V2 Architecture):
 * - Wind: WindHybridModel (alias for Wind4TierHybridModel) is now the RECOMMENDED model
 * - Solar: SolarHybridModel with hourly calibration and asymmetric loss (default)
 * - Profile: ProfileBasedModel for hydro/geothermal/biomass/battery
 * - Legacy models moved to ./legacy/ for backward compatibility
 */

// ===== V2 RECOMMENDED MODELS =====

// Wind: 4-Tier MREC + ML Hybrid (RECOMMENDED)
export { WindHybridModel, trainAllWindHybrid } from './WindHybridModel.js';

// Solar: Physics + ML Hybrid with Hourly Calibration (RECOMMENDED)
export { SolarHybridModel } from './SolarHybridModel.js';
export type { SolarHybridModelState } from './SolarHybridModel.js';

// Profile: Hydro, Geothermal, Biomass, Battery (RECOMMENDED)
export { ProfileBasedModel } from './ProfileBasedModel.js';
export { GeothermalModel } from './GeothermalModel.js';
export { BiomassModel } from './BiomassModel.js';
export { HydroModel } from './HydroModel.js';
export { BatteryModel } from './BatteryModel.js';

// ===== SUPPORTING COMPONENTS =====

// Physics-based models (used internally by hybrids)
export { WindPowerCurve } from './WindPowerCurve.js';
export { SolarIrradianceModel } from './legacy/SolarIrradianceModel.js';  // Still used by SolarHybridModel

// XGBoost regressor for capacity factor models
export { CFacXGBoostRegressor } from './CFacXGBoostRegressor.js';
export type { XGBoostRegressorOptions } from './CFacXGBoostRegressor.js';

// Station-specific Bias Corrector
export { BiasCorrector } from './BiasCorrector.js';
export type { StationBias, BiasCorrection } from './BiasCorrector.js';

// Model router
export { ModelRouter, modelRouter } from './ModelRouter.js';

// ===== INTERNAL COMPONENTS (still used in V2) =====

// 4-Tier MREC Model (physics-based LOW/RAMP/RATED/HIGH regions)
export { Wind4TierMRECModel, calibrateAll4TierMREC, DEFAULT_WIND_THRESHOLDS } from './Wind4TierMRECModel.js';
export type { MREC4TierFactors } from './Wind4TierMRECModel.js';

// 4-Tier Hybrid Model (4-tier MREC + region-specific gustRatio features)
// This is the underlying implementation for WindHybridModel
export { Wind4TierHybridModel, trainAll4TierHybrid } from './Wind4TierHybridModel.js';
export type { Wind4TierHybridMetrics } from './Wind4TierHybridModel.js';

// MREC model (iPool-style three-tier piecewise) - Still used internally
export { WindMRECModel, calibrateAllMREC, calibrateAllMRECCFBased, calibrateAllMRECMLOptimized } from './legacy/WindMRECModel.js';
export { SolarMRECModel, calibrateAllSolarMREC } from './SolarMRECModel.js';
export type { SolarMRECFactors, SolarMRECCalibrationData } from './SolarMRECModel.js';

// MREC-ML Hybrid model (MREC base + ML residual learning) - Still used internally
export { WindMRECHybridModel, trainAllMRECHybrid } from './WindMRECHybridModel.js';
export type { MRECHybridMetrics } from './WindMRECHybridModel.js';

// Physics-Based MREC Model - Still used internally
export { WindPhysicsMRECModel, calibrateAllPhysicsMREC, WIND_PHYSICS_DEFAULTS } from './WindPhysicsMRECModel.js';
export type { PhysicsMRECFactors } from './WindPhysicsMRECModel.js';

// Physics Hybrid Model - Still used internally
export { WindPhysicsHybridModel, trainAllPhysicsHybrid } from './WindPhysicsHybridModel.js';
export type { PhysicsHybridMetrics } from './WindPhysicsHybridModel.js';

// Bias Correction Model - Still used internally
export { WindBiasCorrectionModel, calibrateAllBiasCorrection } from './WindBiasCorrectionModel.js';
export type { BiasCorrectionFactors, BiasCorrectionMetrics } from './WindBiasCorrectionModel.js';

// Wind Shear Power Law Model - Still used internally
export { WindShearModel, trainAllWindShear } from './WindShearModel.js';
export type { WindShearMetrics, WindShearConfig } from './WindShearModel.js';
export { WIND_SHEAR_PRESETS, OPTIMAL_SHEAR_CONFIGS } from './WindShearModel.js';

// Weibull Distribution-Based Model - Still used internally
export { WindWeibullModel, calibrateAllWeibull } from './WindWeibullModel.js';
export type { WeibullFactors, WeibullCalibrationData } from './WindWeibullModel.js';

// Cubic Power Curve model - Still used internally
export { WindCubicModel, calibrateAllCubic } from './WindCubicModel.js';
export type { CubicPowerCurveFactors } from './WindCubicModel.js';

// Solar Seasonal MREC - Still used internally
export { SolarSeasonalMRECModel, calibrateAllSeasonalSolarMREC, getPhilippineSeason, PhilippineSeason } from './SolarSeasonalMRECModel.js';
export type { SolarSeasonalMRECFactors, SeasonalMRECFactors, SolarSeasonalCalibrationData } from './SolarSeasonalMRECModel.js';

// ===== LEGACY MODELS (backward compatibility - DO NOT USE for new forecasts) =====
// These models have been moved to ./legacy/ but are re-exported for compatibility

export { WindMRECModel as WindMRECModelLegacy } from './legacy/WindMRECModel.js';
export { WindEnhancedHybridModel } from './legacy/WindEnhancedHybridModel.js';
export { WindWeatherHybridModel } from './legacy/WindWeatherHybridModel.js';
export { SolarMRECHybridModel } from './legacy/SolarMRECHybridModel.js';
export { SolarPremiumHybridModel } from './legacy/SolarPremiumHybridModel.js';
export type { EnhancedHybridFactors, EnhancedHybridMetrics, WindEnhancedHybridState } from './legacy/WindEnhancedHybridModel.js';
export type { SolarPremiumMetrics, SolarPremiumWeatherFeatures } from './legacy/SolarPremiumHybridModel.js';
export type { SolarMRECHybridFactors } from './legacy/SolarMRECHybridModel.js';
export type { WeatherHybridMetrics } from './legacy/WindWeatherHybridModel.js';

// Legacy training functions
export { trainAllEnhancedHybrid } from './legacy/WindEnhancedHybridModel.js';
export { trainAllWeatherHybrid } from './legacy/WindWeatherHybridModel.js';
export { calibrateAllSolarMRECHybrid } from './legacy/SolarMRECHybridModel.js';
export { trainAllSolarPremium } from './legacy/SolarPremiumHybridModel.js';
