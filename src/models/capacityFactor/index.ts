/**
 * Capacity Factor Models
 *
 * Physics-based and hybrid models for predicting renewable energy capacity factors
 */

// Physics-based models (weather-dependent)
export { WindPowerCurve } from './WindPowerCurve.js';
export { SolarIrradianceModel } from './SolarIrradianceModel.js';

// Hybrid models (weather + ML)
export { WindHybridModel } from './WindHybridModel.js';
export { SolarHybridModel } from './SolarHybridModel.js';
export type { SolarHybridModelState } from './SolarHybridModel.js';

// MREC model (iPool-style three-tier piecewise)
export { WindMRECModel, calibrateAllMREC, calibrateAllMRECCFBased, calibrateAllMRECMLOptimized } from './WindMRECModel.js';
export { SolarMRECModel, calibrateAllSolarMREC } from './SolarMRECModel.js';
export type { SolarMRECFactors, SolarMRECCalibrationData } from './SolarMRECModel.js';

// MREC-ML Hybrid model (MREC base + ML residual learning)
export { WindMRECHybridModel, trainAllMRECHybrid } from './WindMRECHybridModel.js';
export type { MRECHybridMetrics } from './WindMRECHybridModel.js';

// Weather-Only MREC Hybrid (avoids temporal overfitting)
export { WindWeatherHybridModel, trainAllWeatherHybrid } from './WindWeatherHybridModel.js';
export type { WeatherHybridMetrics } from './WindWeatherHybridModel.js';

// 4-Tier MREC Model (physics-based LOW/RAMP/RATED/HIGH regions)
export { Wind4TierMRECModel, calibrateAll4TierMREC, DEFAULT_WIND_THRESHOLDS } from './Wind4TierMRECModel.js';
export type { MREC4TierFactors } from './Wind4TierMRECModel.js';

// 4-Tier Hybrid Model (4-tier MREC + region-specific gustRatio features)
export { Wind4TierHybridModel, trainAll4TierHybrid } from './Wind4TierHybridModel.js';
export type { Wind4TierHybridMetrics } from './Wind4TierHybridModel.js';

// Physics-Based MREC Model (correct power curve: plateau at rated, ramp-down at high)
export { WindPhysicsMRECModel, calibrateAllPhysicsMREC, WIND_PHYSICS_DEFAULTS } from './WindPhysicsMRECModel.js';
export type { PhysicsMRECFactors } from './WindPhysicsMRECModel.js';

// Physics Hybrid Model (physics MREC + weather-only ML residual)
export { WindPhysicsHybridModel, trainAllPhysicsHybrid } from './WindPhysicsHybridModel.js';
export type { PhysicsHybridMetrics } from './WindPhysicsHybridModel.js';

// Bias Correction Model (linear scale + offset correction)
export { WindBiasCorrectionModel, calibrateAllBiasCorrection } from './WindBiasCorrectionModel.js';
export type { BiasCorrectionFactors, BiasCorrectionMetrics } from './WindBiasCorrectionModel.js';

// Wind Shear Power Law Model (hub height extrapolation)
export { WindShearModel, trainAllWindShear } from './WindShearModel.js';
export type { WindShearMetrics, WindShearConfig } from './WindShearModel.js';
export { WIND_SHEAR_PRESETS, OPTIMAL_SHEAR_CONFIGS } from './WindShearModel.js';

// Weibull Distribution-Based Model (analytical wind speed distribution)
export { WindWeibullModel, calibrateAllWeibull } from './WindWeibullModel.js';
export type { WeibullFactors, WeibullCalibrationData } from './WindWeibullModel.js';

// Cubic Power Curve model (Physics-based polynomial)
export { WindCubicModel, calibrateAllCubic } from './WindCubicModel.js';
export type { CubicPowerCurveFactors } from './WindCubicModel.js';

// Enhanced Hybrid (multiplicative correction + physics boost - no hard cutoffs)
export { WindEnhancedHybridModel, trainAllEnhancedHybrid } from './WindEnhancedHybridModel.js';
export type { EnhancedHybridFactors, EnhancedHybridMetrics, WindEnhancedHybridState } from './WindEnhancedHybridModel.js';

// Solar Premium Hybrid (uses UV, humidity, visibility, conditions)
export { SolarPremiumHybridModel, trainAllSolarPremium } from './SolarPremiumHybridModel.js';
export type { SolarPremiumMetrics, SolarPremiumWeatherFeatures } from './SolarPremiumHybridModel.js';

// Solar MREC+ML Hybrid (iPool MREC base + ML residual learning)
export { SolarMRECHybridModel, calibrateAllSolarMRECHybrid } from './SolarMRECHybridModel.js';
export type { SolarMRECHybridFactors } from './SolarMRECHybridModel.js';

// Solar Seasonal MREC (separate calibration for dry/monsoon/transition seasons)
export { SolarSeasonalMRECModel, calibrateAllSeasonalSolarMREC, getPhilippineSeason, PhilippineSeason } from './SolarSeasonalMRECModel.js';
export type { SolarSeasonalMRECFactors, SeasonalMRECFactors, SolarSeasonalCalibrationData } from './SolarSeasonalMRECModel.js';

// Station-specific Bias Corrector
export { BiasCorrector } from './BiasCorrector.js';
export type { StationBias, BiasCorrection } from './BiasCorrector.js';

// Profile-based models (stable generation types)
export { ProfileBasedModel } from './ProfileBasedModel.js';
export { GeothermalModel } from './GeothermalModel.js';
export { BiomassModel } from './BiomassModel.js';
export { HydroModel } from './HydroModel.js';
export { BatteryModel } from './BatteryModel.js';

// XGBoost regressor for capacity factor models
export { CFacXGBoostRegressor } from './CFacXGBoostRegressor.js';
export type { XGBoostRegressorOptions } from './CFacXGBoostRegressor.js';

// Model router
export { ModelRouter, modelRouter } from './ModelRouter.js';
