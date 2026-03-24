/**
 * CFAC Calibration Types
 *
 * Type definitions for CFAC calibration state management.
 * Calibration state captures the learned scale factors, MREC coefficients,
 * and bias corrections from a CFAC training run.
 */

/**
 * MREC coefficients for a single wind station
 */
export interface MRECCoefficients {
  stationCode: string;
  vL: number;          // Low wind speed threshold
  vH: number;          // High wind speed threshold
  tL: number;          // Low region transition
  tH: number;          // High region transition
  calibrated: boolean;
}

/**
 * CFAC Calibration State - serializable state of a trained CFAC model
 */
export interface CFACCalibrationState {
  id: string;
  createdAt: string;
  trainingPeriod: {
    start: string;
    end: string;
  };
  config: {
    useXgboost: boolean;
    asymmetricLoss: boolean;
    biasCorrection: boolean;
    autoCalibrateDays: number;
    excludeOutages: boolean;
  };
  globalFactors: {
    windBias: number;
    solarBias: number;
    otherBias: number;
  };
  solarHourlyScale: Record<number, number>;  // Hour 0-23 -> scale factor
  windMRECFactors: Record<string, MRECCoefficients>;  // stationCode -> coefficients
  stationScales: {
    wind: Record<string, number>;
    solar: Record<string, number>;
    other: Record<string, number>;
  };
  trainingMetrics: {
    windMAPE: number;
    solarMAPE: number;
    stationCount: number;
    trainingRecords: number;
  };
}

/**
 * Summary for listing calibrations
 */
export interface CalibrationSummary {
  id: string;
  createdAt: string;
  trainingStart: string;
  trainingEnd: string;
  windMAPE: number;
  solarMAPE: number;
  stationCount: number;
  isActive: boolean;
}
