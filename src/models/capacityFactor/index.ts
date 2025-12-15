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

// MREC model (iPool-style three-tier piecewise)
export { WindMRECModel, calibrateAllMREC } from './WindMRECModel.js';
export { SolarMRECModel, calibrateAllSolarMREC } from './SolarMRECModel.js';
export type { SolarMRECFactors, SolarMRECCalibrationData } from './SolarMRECModel.js';

// MREC-ML Hybrid model (MREC base + ML residual learning)
export { WindMRECHybridModel, trainAllMRECHybrid } from './WindMRECHybridModel.js';
export type { MRECHybridMetrics } from './WindMRECHybridModel.js';

// Weather-Only MREC Hybrid (avoids temporal overfitting)
export { WindWeatherHybridModel, trainAllWeatherHybrid } from './WindWeatherHybridModel.js';
export type { WeatherHybridMetrics } from './WindWeatherHybridModel.js';

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
export type { EnhancedHybridFactors, EnhancedHybridMetrics } from './WindEnhancedHybridModel.js';

// Solar Premium Hybrid (uses UV, humidity, visibility, conditions)
export { SolarPremiumHybridModel, trainAllSolarPremium } from './SolarPremiumHybridModel.js';
export type { SolarPremiumMetrics, SolarPremiumWeatherFeatures } from './SolarPremiumHybridModel.js';

// Profile-based models (stable generation types)
export { ProfileBasedModel } from './ProfileBasedModel.js';
export { GeothermalModel } from './GeothermalModel.js';
export { BiomassModel } from './BiomassModel.js';
export { HydroModel } from './HydroModel.js';
export { BatteryModel } from './BatteryModel.js';

// Model router
export { ModelRouter, modelRouter } from './ModelRouter.js';
