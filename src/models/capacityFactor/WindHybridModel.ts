import { WindPowerCurve } from './WindPowerCurve.js';
import { CFacTrainingSample, CFacWeatherFeatures } from '../../types/capacityFactor.js';
import MultivariateLinearRegression from 'ml-regression-multivariate-linear';

/**
 * Hybrid wind capacity factor model
 * Combines physics-based power curve with ML residual learning
 *
 * Architecture:
 * 1. Physics base: WindPowerCurve provides baseline prediction from wind speed
 * 2. ML residual: Linear regression learns correction factors from weather + temporal features
 * 3. Final prediction: physics_CFac + ML_residual, clamped to [0, 1]
 *
 * This approach captures both:
 * - Physics: Fundamental wind speed -> power relationship
 * - Real-world effects: Site-specific factors, wind direction, turbulence, etc.
 */
export class WindHybridModel {
  private powerCurve: WindPowerCurve;
  private residualModel: MultivariateLinearRegression | null = null;
  private stationCode: string;

  constructor(stationCode: string, powerCurveParams?: { cutIn?: number; rated?: number; cutOut?: number }) {
    this.stationCode = stationCode;
    this.powerCurve = new WindPowerCurve(powerCurveParams);
  }

  /**
   * Train the residual model
   * residual = actual_CFac - physics_CFac
   *
   * @param samples - Training samples with actual capacity factors and weather data
   * @returns Training metrics (MAPE and R² score)
   *
   * Uses recency weighting: recent samples are duplicated more times
   * to give them higher influence on the model.
   */
  async train(samples: CFacTrainingSample[]): Promise<{ mape: number; r2Score: number }> {
    if (samples.length === 0) {
      throw new Error('No training samples provided');
    }

    // Filter samples for this station
    const stationSamples = samples.filter(s => s.stationCode === this.stationCode);

    if (stationSamples.length < 10) {
      throw new Error(`Insufficient training samples for station ${this.stationCode}: ${stationSamples.length}`);
    }

    // Prepare training data
    const X: number[][] = [];
    const Y: number[][] = [];

    for (const sample of stationSamples) {
      // Calculate physics-based prediction
      // Prefer 100m wind speed for wind farms (turbine hub height)
      const windSpeed = sample.weather.windSpeed100 ?? sample.weather.windSpeed;
      const temperature = sample.weather.temperature;
      const physicsCFac = this.powerCurve.adjustForTemperature(
        this.powerCurve.predict(windSpeed),
        temperature
      );

      // Calculate residual
      const residual = sample.actualCFac - physicsCFac;

      // Extract features for residual prediction
      const features = this.extractResidualFeatures(sample, physicsCFac);

      // Convert weight to duplication count (1-5 copies based on weight 0.1-1.0)
      // weight=1.0 → 5 copies, weight=0.5 → 3 copies, weight=0.1 → 1 copy
      const weight = sample.weight ?? 1.0;
      const copies = Math.max(1, Math.round(weight * 5));

      for (let c = 0; c < copies; c++) {
        X.push([...features]);
        Y.push([residual]);
      }
    }

    // Train residual model
    this.residualModel = new MultivariateLinearRegression(X, Y);

    // Calculate training metrics
    let totalAbsError = 0;
    let totalPercentError = 0;
    let ssRes = 0;
    let ssTot = 0;
    const meanActual = stationSamples.reduce((sum, s) => sum + s.actualCFac, 0) / stationSamples.length;

    for (let i = 0; i < stationSamples.length; i++) {
      const sample = stationSamples[i];
      const predicted = this.predict(sample.weather, sample.datetime);
      const actual = sample.actualCFac;

      const error = Math.abs(predicted - actual);
      totalAbsError += error;

      // MAPE calculation (avoid division by zero)
      if (actual > 0.01) {
        totalPercentError += (error / actual) * 100;
      }

      ssRes += Math.pow(predicted - actual, 2);
      ssTot += Math.pow(actual - meanActual, 2);
    }

    const mape = totalPercentError / stationSamples.length;
    const r2Score = ssTot > 0 ? 1 - (ssRes / ssTot) : 0;

    return { mape, r2Score };
  }

  /**
   * Extract features for residual prediction
   *
   * Features include:
   * - Wind: speed (normalized), gust, direction
   * - Temperature (for validation of physics adjustment)
   * - Temporal: hour (cyclical), month
   * - Physics baseline
   * - Lag features (if available)
   *
   * @param sample - Training sample
   * @param physicsCFac - Physics-based prediction
   * @returns Feature vector for residual model
   */
  private extractResidualFeatures(sample: CFacTrainingSample, physicsCFac: number): number[] {
    const features: number[] = [];
    const weather = sample.weather;

    // Wind features (normalized) - prefer 100m data for wind farms
    const windSpeed = weather.windSpeed100 ?? weather.windSpeed;
    features.push(windSpeed / 25);  // Normalize by typical max (25 m/s)
    features.push(weather.windGust / 30);   // Normalize by typical max gust (30 m/s)

    // Wind direction (normalized and cyclical) - prefer 100m direction
    const windDir = weather.windDirection100 ?? weather.windDirection;
    if (windDir !== undefined) {
      // Convert to radians and use sin/cos for cyclical encoding
      const dirRad = (windDir * Math.PI) / 180;
      features.push(Math.sin(dirRad));
      features.push(Math.cos(dirRad));
    } else {
      features.push(0, 0);  // Missing wind direction
    }

    // Temperature (normalized)
    features.push(weather.temperature / 50);  // Normalize by typical range

    // Temporal features (cyclical encoding for hour)
    const hourRad = (sample.hour * 2 * Math.PI) / 24;
    features.push(Math.sin(hourRad));  // hourSin
    features.push(Math.cos(hourRad));  // hourCos

    // Month (normalized)
    features.push(sample.month / 12);

    // Physics baseline (normalized)
    features.push(physicsCFac);

    // Lag features (if available)
    if (sample.cfacLag1h !== undefined) {
      features.push(sample.cfacLag1h);
    } else {
      features.push(physicsCFac);  // Use physics prediction as fallback
    }

    if (sample.cfacLag24h !== undefined) {
      features.push(sample.cfacLag24h);
    } else {
      features.push(physicsCFac);  // Use physics prediction as fallback
    }

    return features;
  }

  /**
   * Predict capacity factor
   * CFac = physics_base + ML_residual, clamped to [0, 1]
   *
   * @param weather - Weather features
   * @param datetime - Datetime for temporal features
   * @returns Predicted capacity factor [0, 1]
   */
  predict(weather: CFacWeatherFeatures, datetime: Date): number {
    // Calculate physics-based prediction - prefer 100m wind speed for wind farms
    const windSpeed = weather.windSpeed100 ?? weather.windSpeed;
    const physicsCFac = this.predictPhysicsOnly(windSpeed, weather.temperature);

    // If no residual model trained, return physics-only prediction
    if (!this.residualModel) {
      return physicsCFac;
    }

    // Create a minimal training sample for feature extraction
    const hour = datetime.getHours();
    const month = datetime.getMonth() + 1;

    const tempSample: CFacTrainingSample = {
      datetime,
      stationCode: this.stationCode,
      stationType: 'wind' as any,
      actualCFac: 0,  // Not used for prediction
      weather,
      hour,
      dayOfWeek: datetime.getDay(),
      month,
      isWeekend: datetime.getDay() === 0 || datetime.getDay() === 6,
      cfacLag1h: undefined,  // Would be populated in real usage
      cfacLag24h: undefined
    };

    // Extract features for residual prediction
    const features = this.extractResidualFeatures(tempSample, physicsCFac);

    // Predict residual
    const residual = this.residualModel.predict(features)[0];

    // Combine physics + residual and clamp to [0, 1]
    const prediction = physicsCFac + residual;
    return Math.max(0, Math.min(1, prediction));
  }

  /**
   * Get physics-only prediction for comparison
   *
   * @param windSpeed - Wind speed in m/s
   * @param temperature - Temperature in degrees Celsius
   * @returns Physics-based capacity factor [0, 1]
   */
  predictPhysicsOnly(windSpeed: number, temperature: number): number {
    const baseCFac = this.powerCurve.predict(windSpeed);
    return this.powerCurve.adjustForTemperature(baseCFac, temperature);
  }

  /**
   * Check if model is ready for predictions
   *
   * @returns True if residual model is trained
   */
  isReady(): boolean {
    return this.residualModel !== null;
  }

  /**
   * Get station code
   */
  getStationCode(): string {
    return this.stationCode;
  }
}
