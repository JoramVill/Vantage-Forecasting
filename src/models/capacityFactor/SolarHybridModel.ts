import { SolarIrradianceModel } from './legacy/SolarIrradianceModel.js';
import { CFacTrainingSample, CFacWeatherFeatures } from '../../types/capacityFactor.js';
import MultivariateLinearRegression from 'ml-regression-multivariate-linear';

/**
 * Hybrid solar capacity factor model
 * Combines physics-based irradiance model with ML residual learning
 *
 * Architecture:
 * 1. Physics base: SolarIrradianceModel provides baseline from irradiance + temperature
 * 2. ML residual: Linear regression learns corrections from cloud cover, temporal patterns
 * 3. Final prediction: physics_CFac + ML_residual, clamped to [0, 1]
 *
 * This approach captures both:
 * - Physics: Fundamental irradiance -> power relationship with temperature derating
 * - Real-world effects: Cloud cover, soiling, seasonal variations, tracking efficiency
 */
export class SolarHybridModel {
  private irradianceModel: SolarIrradianceModel;
  private residualModel: MultivariateLinearRegression | null = null;
  private drySeasonResidualModel: MultivariateLinearRegression | null = null;  // Separate model for dry season
  private stationCode: string;
  private biasCorrection: number = 1.0;  // Scale factor to correct systematic under/over-prediction
  private drySeasonBiasCorrection: number = 1.0;  // Bias correction for dry season
  private physicsOnlyMode: boolean = false;  // If true, skip ML residual and use physics directly
  private weatherConfidenceMode: boolean = false;  // If true, scale ML residual by weather confidence
  private seasonalAdaptiveMode: boolean = false;  // If true, reduce ML weight in dry season + use dry season model

  // Philippines seasons: Dry (Nov-Apr), Wet (May-Oct)
  private static readonly DRY_SEASON_MONTHS = [11, 12, 1, 2, 3, 4];
  private static readonly WET_SEASON_MONTHS = [5, 6, 7, 8, 9, 10];

  // Per-hour correction factors to fix afternoon over-prediction
  // Indexed by hour (0-23), applies multiplicative correction
  private hourlyCorrection: Map<number, number> = new Map();
  private drySeasonHourlyCorrection: Map<number, number> = new Map();

  constructor(stationCode: string, modelParams?: { tempCoeff?: number; systemLoss?: number }) {
    this.stationCode = stationCode;
    this.irradianceModel = new SolarIrradianceModel(modelParams);

    // Initialize hourly corrections to 1.0 (no correction)
    for (let h = 0; h < 24; h++) {
      this.hourlyCorrection.set(h, 1.0);
      this.drySeasonHourlyCorrection.set(h, 1.0);
    }
  }

  /**
   * Check if a month is in dry season (Nov-Apr in Philippines)
   */
  private isDrySeason(month: number): boolean {
    return SolarHybridModel.DRY_SEASON_MONTHS.includes(month);
  }

  /**
   * Train the residual model
   * residual = actual_CFac - physics_CFac
   *
   * @param samples - Training samples with actual capacity factors and weather data
   * @param asymmetricLoss - If true (default), penalize under-predictions more heavily using quantile loss
   * @param solarAlpha - Asymmetry parameter (0.5-0.8). Default 0.65 = penalize under-prediction ~1.9x more
   * @returns Training metrics (MAPE and R² score)
   *
   * Uses recency weighting: recent samples are duplicated more times
   * to give them higher influence on the model.
   *
   * V2 Change: Asymmetric loss is now DEFAULT for solar (was opt-in in V1)
   */
  async train(samples: CFacTrainingSample[], asymmetricLoss: boolean = true, solarAlpha: number = 0.65): Promise<{ mape: number; r2Score: number }> {
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
      const solarRadiation = sample.weather.solarRadiation;
      const temperature = sample.weather.temperature;
      const physicsCFac = this.irradianceModel.predict(solarRadiation, temperature);

      // Calculate residual
      const residual = sample.actualCFac - physicsCFac;

      // Extract features for residual prediction
      const features = this.extractResidualFeatures(sample, physicsCFac);

      // Convert weight to duplication count (1-5 copies based on weight 0.1-1.0)
      // weight=1.0 → 5 copies, weight=0.5 → 3 copies, weight=0.1 → 1 copy
      const weight = sample.weight ?? 1.0;
      const copies = Math.max(1, Math.round(weight * 5));

      for (let c = 0; c < copies; c++) {
        // V2 Quantile Loss Implementation
        // Instead of simple duplication, calculate duplication count based on quantile α
        // α = 0.65 (default): under-predictions get 1.86x weight vs over-predictions
        // Formula: weight_under = α / (1 - α), weight_over = 1.0

        if (asymmetricLoss && sample.actualCFac > 0.1) {
          const isUnderPrediction = residual > 0;

          if (isUnderPrediction) {
            // Under-prediction: duplicate more times
            const underWeight = solarAlpha / (1 - solarAlpha); // α=0.65 → 1.86x
            const underCopies = Math.max(1, Math.round(underWeight));
            for (let u = 0; u < underCopies; u++) {
              X.push([...features]);
              Y.push([residual]);
            }
          } else {
            // Over-prediction: standard weight
            X.push([...features]);
            Y.push([residual]);
          }
        } else {
          // No asymmetric loss: standard copy
          X.push([...features]);
          Y.push([residual]);
        }
      }
    }

    // Train residual model
    this.residualModel = new MultivariateLinearRegression(X, Y);

    // Calculate training metrics and bias correction
    let totalAbsError = 0;
    let totalPercentError = 0;
    let ssRes = 0;
    let ssTot = 0;
    let totalPredicted = 0;
    let totalActual = 0;
    let daylightCount = 0;
    const meanActual = stationSamples.reduce((sum, s) => sum + s.actualCFac, 0) / stationSamples.length;

    for (let i = 0; i < stationSamples.length; i++) {
      const sample = stationSamples[i];
      const predicted = this.predictRaw(sample.weather, sample.datetime);  // Use raw (uncorrected) prediction
      const actual = sample.actualCFac;

      const error = Math.abs(predicted - actual);
      totalAbsError += error;

      // MAPE calculation (avoid division by zero)
      // For solar, only calculate MAPE during daylight hours (actual > 0.01)
      if (actual > 0.05) {
        totalPercentError += (error / actual) * 100;
        totalPredicted += predicted;
        totalActual += actual;
        daylightCount++;
      }

      ssRes += Math.pow(predicted - actual, 2);
      ssTot += Math.pow(actual - meanActual, 2);
    }

    // Calculate bias correction from training data
    // If predictions systematically under-predict, biasCorrection > 1.0
    if (daylightCount > 10 && totalPredicted > 0) {
      this.biasCorrection = totalActual / totalPredicted;
      // Clamp to reasonable range [0.8, 1.5] to prevent extreme corrections
      this.biasCorrection = Math.max(0.8, Math.min(1.5, this.biasCorrection));
    }

    // Learn hourly correction factors from training data
    // This replaces hardcoded sunset tapers with data-driven corrections
    this.learnHourlyCorrections(stationSamples);

    // Train separate dry season model if we have enough dry season data
    this.trainDrySeasonModel(stationSamples, asymmetricLoss);

    const mape = totalPercentError / stationSamples.length;
    const r2Score = ssTot > 0 ? 1 - (ssRes / ssTot) : 0;

    return { mape, r2Score };
  }

  /**
   * Train a separate ML model for dry season (Nov-Apr)
   * This model learns patterns specific to dry season conditions
   */
  private trainDrySeasonModel(samples: CFacTrainingSample[], asymmetricLoss: boolean): void {
    // Filter for dry season samples only
    const drySamples = samples.filter(s => this.isDrySeason(s.month));

    // Need at least 50 samples to train a meaningful model
    if (drySamples.length < 50) {
      console.log(`  [${this.stationCode}] Insufficient dry season samples (${drySamples.length}), using main model`);
      return;
    }

    console.log(`  [${this.stationCode}] Training dry season model with ${drySamples.length} samples`);

    // Prepare training data
    const X: number[][] = [];
    const Y: number[][] = [];

    for (const sample of drySamples) {
      const solarRadiation = sample.weather.solarRadiation;
      const temperature = sample.weather.temperature;
      const physicsCFac = this.irradianceModel.predict(solarRadiation, temperature);
      const residual = sample.actualCFac - physicsCFac;
      const features = this.extractResidualFeatures(sample, physicsCFac);

      const weight = sample.weight ?? 1.0;
      const copies = Math.max(1, Math.round(weight * 5));

      for (let c = 0; c < copies; c++) {
        X.push([...features]);
        Y.push([residual]);

        if (asymmetricLoss && residual > 0 && sample.actualCFac > 0.1) {
          X.push([...features]);
          Y.push([residual]);
        }
      }
    }

    // Train dry season residual model
    this.drySeasonResidualModel = new MultivariateLinearRegression(X, Y);

    // Calculate dry season bias correction
    let totalPredicted = 0;
    let totalActual = 0;
    let daylightCount = 0;

    for (const sample of drySamples) {
      const predicted = this.predictRawWithModel(sample.weather, sample.datetime, this.drySeasonResidualModel);
      const actual = sample.actualCFac;

      if (actual > 0.05) {
        totalPredicted += predicted;
        totalActual += actual;
        daylightCount++;
      }
    }

    if (daylightCount > 10 && totalPredicted > 0) {
      this.drySeasonBiasCorrection = totalActual / totalPredicted;
      this.drySeasonBiasCorrection = Math.max(0.8, Math.min(1.5, this.drySeasonBiasCorrection));
    }

    // Learn dry season hourly corrections
    this.learnDrySeasonHourlyCorrections(drySamples);
  }

  /**
   * Learn hourly corrections specifically for dry season
   */
  private learnDrySeasonHourlyCorrections(samples: CFacTrainingSample[]): void {
    const hourlyActual: Map<number, number[]> = new Map();
    const hourlyPredicted: Map<number, number[]> = new Map();

    for (let h = 0; h < 24; h++) {
      hourlyActual.set(h, []);
      hourlyPredicted.set(h, []);
    }

    for (const sample of samples) {
      const hour = sample.hour;
      const rawPredicted = this.predictRawWithModel(sample.weather, sample.datetime, this.drySeasonResidualModel);
      const biasCorrectedPredicted = rawPredicted * this.drySeasonBiasCorrection;
      const actual = sample.actualCFac;

      if (biasCorrectedPredicted > 0.01 && actual >= 0) {
        hourlyActual.get(hour)!.push(actual);
        hourlyPredicted.get(hour)!.push(biasCorrectedPredicted);
      }
    }

    for (let h = 0; h < 24; h++) {
      const actuals = hourlyActual.get(h)!;
      const predicteds = hourlyPredicted.get(h)!;

      if (actuals.length >= 5) {
        const ratios = actuals.map((a, i) => a / predicteds[i]);
        ratios.sort((a, b) => a - b);
        const medianRatio = ratios[Math.floor(ratios.length / 2)];
        const correction = Math.max(0.5, Math.min(1.5, medianRatio));
        this.drySeasonHourlyCorrection.set(h, correction);
      }
    }
  }

  /**
   * Predict using a specific residual model (for training dry season model)
   */
  private predictRawWithModel(weather: CFacWeatherFeatures, datetime: Date, model: MultivariateLinearRegression | null): number {
    const hour = datetime.getHours();
    // Allow 5 AM to 7 PM for seasonal variation
    if (hour < 5 || hour > 19 || weather.solarRadiation <= 0) {
      return 0;
    }

    const physicsCFac = this.irradianceModel.predict(weather.solarRadiation, weather.temperature);

    if (!model) {
      return physicsCFac;
    }

    const month = datetime.getMonth() + 1;
    const tempSample: CFacTrainingSample = {
      datetime,
      stationCode: this.stationCode,
      stationType: 'solar' as any,
      actualCFac: 0,
      weather,
      hour,
      dayOfWeek: datetime.getDay(),
      month,
      isWeekend: datetime.getDay() === 0 || datetime.getDay() === 6
    };

    const features = this.extractResidualFeatures(tempSample, physicsCFac);
    const residual = model.predict(features)[0];

    const prediction = physicsCFac + residual;
    return Math.max(0, Math.min(1, prediction));
  }

  /**
   * Learn hourly correction factors from training data
   * For each hour, calculates the ratio of actual vs bias-corrected predicted CF
   * This provides data-driven corrections for sunrise/sunset asymmetry
   *
   * IMPORTANT: Uses bias-corrected predictions to avoid double-correction
   *
   * @param samples - Training samples for this station
   */
  private learnHourlyCorrections(samples: CFacTrainingSample[]): void {
    // Group samples by hour and calculate actual vs predicted ratios
    const hourlyActual: Map<number, number[]> = new Map();
    const hourlyPredicted: Map<number, number[]> = new Map();

    for (let h = 0; h < 24; h++) {
      hourlyActual.set(h, []);
      hourlyPredicted.set(h, []);
    }

    for (const sample of samples) {
      const hour = sample.hour;
      // Use bias-corrected prediction to avoid double-correction
      const rawPredicted = this.predictRaw(sample.weather, sample.datetime);
      const biasCorrectedPredicted = rawPredicted * this.biasCorrection;
      const actual = sample.actualCFac;

      // Only use samples with meaningful values (avoid division issues)
      if (biasCorrectedPredicted > 0.01 && actual >= 0) {
        hourlyActual.get(hour)!.push(actual);
        hourlyPredicted.get(hour)!.push(biasCorrectedPredicted);
      }
    }

    // Calculate correction factor for each hour
    for (let h = 0; h < 24; h++) {
      const actuals = hourlyActual.get(h)!;
      const predicteds = hourlyPredicted.get(h)!;

      if (actuals.length >= 5) {
        // Use median ratio to be robust against outliers
        const ratios = actuals.map((a, i) => a / predicteds[i]);
        ratios.sort((a, b) => a - b);
        const medianRatio = ratios[Math.floor(ratios.length / 2)];

        // Clamp to reasonable range [0.5, 1.5] to prevent extreme corrections
        // More conservative range since bias is already applied
        const correction = Math.max(0.5, Math.min(1.5, medianRatio));
        this.hourlyCorrection.set(h, correction);
      } else {
        // Not enough data for this hour, use default (1.0)
        this.hourlyCorrection.set(h, 1.0);
      }
    }
  }

  /**
   * Extract features for residual prediction
   *
   * Features include:
   * - Solar radiation (normalized)
   * - Cloud cover (normalized)
   * - Temperature (for validation of physics adjustment)
   * - Temporal: hour (cyclical), month
   * - Physics baseline
   * - Clear sky index (if calculable)
   *
   * @param sample - Training sample
   * @param physicsCFac - Physics-based prediction
   * @returns Feature vector for residual model
   */
  private extractResidualFeatures(sample: CFacTrainingSample, physicsCFac: number): number[] {
    const features: number[] = [];
    const weather = sample.weather;

    // Solar radiation (normalized)
    features.push(weather.solarRadiation / 1000);  // Normalize by STC (1000 W/m²)

    // Cloud cover (normalized)
    features.push(weather.cloudCover / 100);  // Convert percentage to [0, 1]

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

    // Clear sky index (if calculable)
    // This represents how much of the theoretical clear-sky radiation is available
    const clearSkyIndex = this.calculateClearSkyIndex(
      weather.solarRadiation,
      sample.datetime,
      sample.hour
    );
    features.push(clearSkyIndex);

    return features;
  }

  /**
   * Calculate clear sky index
   *
   * Estimates the ratio of actual irradiance to theoretical clear-sky irradiance
   * Simplified calculation based on hour of day and season
   *
   * @param actualRadiation - Actual solar radiation in W/m²
   * @param datetime - Date for seasonal calculation
   * @param hour - Hour of day
   * @returns Clear sky index [0, 1]
   */
  private calculateClearSkyIndex(actualRadiation: number, datetime: Date, hour: number): number {
    // Night time - return 0 (allow 5 AM to 7 PM for seasonal variation)
    if (hour < 5 || hour > 19) {
      return 0;
    }

    // Calculate theoretical clear-sky radiation based on hour and season
    // Simplified model: peak at solar noon (12pm), varies by season
    const dayOfYear = this.getDayOfYear(datetime);

    // Solar declination (simplified)
    const declination = 23.45 * Math.sin((2 * Math.PI * (dayOfYear - 81)) / 365);

    // Hour angle (degrees from solar noon)
    const hourAngle = (hour - 12) * 15;

    // Elevation angle (simplified, assuming latitude ~10-15° for Philippines)
    const latitude = 12;  // Approximate Philippines latitude
    const elevationAngle = Math.asin(
      Math.sin(latitude * Math.PI / 180) * Math.sin(declination * Math.PI / 180) +
      Math.cos(latitude * Math.PI / 180) * Math.cos(declination * Math.PI / 180) *
      Math.cos(hourAngle * Math.PI / 180)
    );

    // Clear-sky irradiance (simplified)
    const clearSkyRadiation = elevationAngle > 0
      ? 1000 * Math.sin(elevationAngle)  // Peak of 1000 W/m² at zenith
      : 0;

    // Clear sky index
    if (clearSkyRadiation > 10) {  // Avoid division by very small numbers
      return Math.min(1, actualRadiation / clearSkyRadiation);
    }

    return 0;
  }

  /**
   * Get day of year (1-366)
   */
  private getDayOfYear(date: Date): number {
    const start = new Date(date.getFullYear(), 0, 0);
    const diff = date.getTime() - start.getTime();
    const oneDay = 1000 * 60 * 60 * 24;
    return Math.floor(diff / oneDay);
  }

  /**
   * Predict capacity factor (with bias and hourly corrections)
   * CFac = (physics_base + ML_residual) * biasCorrection * hourlyCorrection, clamped to [0, 1]
   *
   * In seasonal adaptive mode:
   * - Dry season (Nov-Apr): Uses dry season model if available, otherwise reduces ML residual weight
   * - Wet season (May-Oct): Uses standard model
   *
   * @param weather - Weather features
   * @param datetime - Datetime for temporal features
   * @returns Predicted capacity factor [0, 1]
   */
  predict(
    weather: CFacWeatherFeatures,
    datetime: Date,
    weatherSequence?: CFacWeatherFeatures[],
    hours?: number[],
    months?: number[]
  ): number {
    const month = datetime.getMonth() + 1;
    const hour = datetime.getHours();

    // Seasonal adaptive mode: use dry season model/corrections in dry season
    if (this.seasonalAdaptiveMode && this.isDrySeason(month)) {
      return this.predictDrySeason(weather, datetime, weatherSequence, hours, months);
    }

    const rawPrediction = this.predictRaw(weather, datetime);

    // Apply bias correction
    let correctedPrediction = rawPrediction * this.biasCorrection;

    // Apply learned hourly correction (data-driven, not hardcoded)
    const hourlyFactor = this.hourlyCorrection.get(hour) ?? 1.0;
    correctedPrediction *= hourlyFactor;

    return Math.max(0, Math.min(1, correctedPrediction));
  }

  /**
   * Predict for dry season - now uses same path as default prediction
   *
   * IMPORTANT: The separate dry season model approach was removed because it
   * caused severe over-forecasting for some stations (e.g., 01LIMAY showed +296%
   * error). The dry season model had different bias corrections that didn't
   * match station-specific performance.
   *
   * Now seasonal adaptive mode uses the exact same prediction as default mode.
   * The --solar-seasonal flag is kept for backwards compatibility but has no effect.
   */
  private predictDrySeason(
    weather: CFacWeatherFeatures,
    datetime: Date,
    weatherSequence?: CFacWeatherFeatures[],
    hours?: number[],
    months?: number[]
  ): number {
    // Use exactly the same prediction path as default mode
    // This ensures station-specific calibrations are preserved
    const hour = datetime.getHours();
    const rawPrediction = this.predictRaw(weather, datetime);

    // Apply bias correction
    let correctedPrediction = rawPrediction * this.biasCorrection;

    // Apply learned hourly correction (data-driven, not hardcoded)
    const hourlyFactor = this.hourlyCorrection.get(hour) ?? 1.0;
    correctedPrediction *= hourlyFactor;

    return Math.max(0, Math.min(1, correctedPrediction));
  }

  /**
   * Predict capacity factor without bias correction (used during training)
   * CFac = physics_base + ML_residual, clamped to [0, 1]
   * If physicsOnlyMode is enabled, skips ML residual and returns physics directly.
   *
   * @param weather - Weather features
   * @param datetime - Datetime for temporal features
   * @returns Raw predicted capacity factor [0, 1]
   */
  predictRaw(weather: CFacWeatherFeatures, datetime: Date): number {
    // Handle night time explicitly
    // Allow daylight hours 5 AM to 7 PM for seasonal variation in sunrise/sunset
    const hour = datetime.getHours();
    if (hour < 5 || hour > 19 || weather.solarRadiation <= 0) {
      return 0;  // No solar generation at night
    }

    // Calculate physics-based prediction
    const physicsCFac = this.predictPhysicsOnly(weather.solarRadiation, weather.temperature);

    // Physics-only mode: Skip ML residual, trust weather data directly
    // Use this when forecasting outside of training season (e.g., December with wet season training)
    if (this.physicsOnlyMode) {
      return physicsCFac;
    }

    // If no residual model trained, return physics-only prediction
    if (!this.residualModel) {
      return physicsCFac;
    }

    // Create a minimal training sample for feature extraction
    const month = datetime.getMonth() + 1;

    const tempSample: CFacTrainingSample = {
      datetime,
      stationCode: this.stationCode,
      stationType: 'solar' as any,
      actualCFac: 0,  // Not used for prediction
      weather,
      hour,
      dayOfWeek: datetime.getDay(),
      month,
      isWeekend: datetime.getDay() === 0 || datetime.getDay() === 6
    };

    // Extract features for residual prediction
    const features = this.extractResidualFeatures(tempSample, physicsCFac);

    // Predict residual
    let residual = this.residualModel.predict(features)[0];

    // Weather confidence mode: Scale ML residual based on weather confidence
    // When irradiance is high and cloud cover is low, trust physics more (reduce residual weight)
    // This helps when forecasting outside training season (e.g., December with wet season training)
    if (this.weatherConfidenceMode) {
      const weatherConfidence = this.calculateWeatherConfidence(weather);
      // Scale residual: high confidence (clear sky) → less residual, low confidence → full residual
      // If residual is negative (ML says physics is too high), reduce that correction when weather is confident
      residual = residual * (1 - weatherConfidence);
    }

    // Combine physics + residual and clamp to [0, 1]
    const prediction = physicsCFac + residual;
    return Math.max(0, Math.min(1, prediction));
  }

  /**
   * Calculate weather confidence score [0, 1]
   * High confidence when:
   * - Solar radiation is high (clear sky)
   * - Cloud cover is low
   * - Radiation matches expected for time of day
   *
   * @param weather - Weather features
   * @returns Confidence score [0, 1] where 1 = very confident, trust physics
   */
  private calculateWeatherConfidence(weather: CFacWeatherFeatures): number {
    const solarRadiation = weather.solarRadiation;
    const cloudCover = weather.cloudCover;

    // Factor 1: Solar radiation level (normalized to peak ~1000 W/m²)
    // High irradiance → high confidence (clear sky measurement)
    const irradianceFactor = Math.min(1, solarRadiation / 800);  // Saturates at 800 W/m²

    // Factor 2: Low cloud cover → high confidence
    // Cloud cover 0% → confidence 1.0, cloud cover 100% → confidence 0.0
    const cloudFactor = 1 - (cloudCover / 100);

    // Factor 3: Consistency check - high irradiance should have low clouds
    // If irradiance is high but clouds are high, something is inconsistent → lower confidence
    const consistencyFactor = irradianceFactor > 0.5 && cloudFactor < 0.5 ? 0.5 : 1.0;

    // Combine factors: require both high irradiance AND low clouds for high confidence
    // Using geometric mean gives both factors equal weight
    const confidence = Math.sqrt(irradianceFactor * cloudFactor) * consistencyFactor;

    return Math.max(0, Math.min(1, confidence));
  }

  /**
   * Get physics-only prediction for comparison
   *
   * @param solarRadiation - Solar radiation in W/m²
   * @param temperature - Temperature in degrees Celsius
   * @returns Physics-based capacity factor [0, 1]
   */
  predictPhysicsOnly(solarRadiation: number, temperature: number): number {
    return this.irradianceModel.predict(solarRadiation, temperature);
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

  /**
   * Get current bias correction factor
   * @returns Bias correction factor (1.0 = no correction)
   */
  getBiasCorrection(): number {
    return this.biasCorrection;
  }

  /**
   * Set bias correction factor manually
   * @param factor - Bias correction factor (1.0 = no correction, >1 = scale up, <1 = scale down)
   */
  setBiasCorrection(factor: number): void {
    this.biasCorrection = Math.max(0.5, Math.min(2.0, factor));
  }

  /**
   * Get learned hourly correction factors
   * @returns Map of hour (0-23) to correction factor
   */
  getHourlyCorrections(): Map<number, number> {
    return new Map(this.hourlyCorrection);
  }

  /**
   * Get hourly correction summary for a specific range
   * @param startHour - Start hour (default 6)
   * @param endHour - End hour (default 17)
   * @returns Object with hour -> correction factor
   */
  getHourlyCorrectionSummary(startHour: number = 6, endHour: number = 17): Record<number, number> {
    const summary: Record<number, number> = {};
    for (let h = startHour; h <= endHour; h++) {
      summary[h] = this.hourlyCorrection.get(h) ?? 1.0;
    }
    return summary;
  }

  /**
   * Enable or disable physics-only mode
   * When enabled, the ML residual is skipped and only the physics model is used.
   * This is useful when forecasting outside of training season (e.g., December with wet season training)
   * where the ML residual learned patterns that don't apply.
   *
   * @param enabled - True to enable physics-only mode
   */
  setPhysicsOnlyMode(enabled: boolean): void {
    this.physicsOnlyMode = enabled;
  }

  /**
   * Check if physics-only mode is enabled
   * @returns True if physics-only mode is enabled
   */
  isPhysicsOnlyMode(): boolean {
    return this.physicsOnlyMode;
  }

  /**
   * Enable or disable weather-confidence mode
   * When enabled, the ML residual is scaled by weather confidence.
   * High irradiance + low cloud cover = high confidence = less ML residual.
   * This is useful when forecasting outside of training season where the ML residual
   * learned patterns that may not apply but weather data is reliable.
   *
   * @param enabled - True to enable weather-confidence mode
   */
  setWeatherConfidenceMode(enabled: boolean): void {
    this.weatherConfidenceMode = enabled;
  }

  /**
   * Check if weather-confidence mode is enabled
   * @returns True if weather-confidence mode is enabled
   */
  isWeatherConfidenceMode(): boolean {
    return this.weatherConfidenceMode;
  }

  /**
   * Enable or disable seasonal adaptive mode
   * When enabled, the model automatically adapts to seasons:
   * - Dry season (Nov-Apr): Uses dry season model if available, or reduces ML residual weight
   * - Wet season (May-Oct): Uses standard hybrid model
   *
   * This mode is best when you have training data from both seasons, or when forecasting
   * dry season with a model trained primarily on wet season data.
   *
   * @param enabled - True to enable seasonal adaptive mode
   */
  setSeasonalAdaptiveMode(enabled: boolean): void {
    this.seasonalAdaptiveMode = enabled;
  }

  /**
   * Check if seasonal adaptive mode is enabled
   * @returns True if seasonal adaptive mode is enabled
   */
  isSeasonalAdaptiveMode(): boolean {
    return this.seasonalAdaptiveMode;
  }

  /**
   * Check if dry season model is available
   * @returns True if a separate dry season model was trained
   */
  hasDrySeasonModel(): boolean {
    return this.drySeasonResidualModel !== null;
  }

  /**
   * Get dry season bias correction factor
   * @returns Dry season bias correction factor (1.0 = no correction)
   */
  getDrySeasonBiasCorrection(): number {
    return this.drySeasonBiasCorrection;
  }

  /**
   * Serialize model state to JSON-compatible object
   * Returns an object that can be saved to model store
   */
  toJSON(): SolarHybridModelState {
    return {
      version: 1,
      stationCode: this.stationCode,
      biasCorrection: this.biasCorrection,
      drySeasonBiasCorrection: this.drySeasonBiasCorrection,
      physicsOnlyMode: this.physicsOnlyMode,
      weatherConfidenceMode: this.weatherConfidenceMode,
      seasonalAdaptiveMode: this.seasonalAdaptiveMode,
      hourlyCorrection: Array.from(this.hourlyCorrection.entries()),
      drySeasonHourlyCorrection: Array.from(this.drySeasonHourlyCorrection.entries()),
      residualModel: this.residualModel ? {
        weights: (this.residualModel as any).weights,
        inputs: (this.residualModel as any).inputs,
        outputs: (this.residualModel as any).outputs,
      } : null,
      drySeasonResidualModel: this.drySeasonResidualModel ? {
        weights: (this.drySeasonResidualModel as any).weights,
        inputs: (this.drySeasonResidualModel as any).inputs,
        outputs: (this.drySeasonResidualModel as any).outputs,
      } : null,
      irradianceModelParams: {
        tempCoeff: (this.irradianceModel as any).tempCoeff,
        systemLoss: (this.irradianceModel as any).systemLoss,
      },
    };
  }

  /**
   * Restore model state from serialized data
   * Static factory method for creating a new model from saved state
   */
  static fromJSON(state: SolarHybridModelState): SolarHybridModel {
    const model = new SolarHybridModel(state.stationCode, state.irradianceModelParams);

    // Restore bias corrections
    model.biasCorrection = state.biasCorrection;
    model.drySeasonBiasCorrection = state.drySeasonBiasCorrection;

    // Restore mode flags
    model.physicsOnlyMode = state.physicsOnlyMode;
    model.weatherConfidenceMode = state.weatherConfidenceMode;
    model.seasonalAdaptiveMode = state.seasonalAdaptiveMode;

    // Restore hourly corrections
    model.hourlyCorrection = new Map(state.hourlyCorrection);
    model.drySeasonHourlyCorrection = new Map(state.drySeasonHourlyCorrection);

    // Restore residual model
    if (state.residualModel) {
      const mockX = [[0]];
      const mockY = [[0]];
      model.residualModel = new MultivariateLinearRegression(mockX, mockY);
      (model.residualModel as any).weights = state.residualModel.weights;
      (model.residualModel as any).inputs = state.residualModel.inputs;
      (model.residualModel as any).outputs = state.residualModel.outputs;
    }

    // Restore dry season residual model
    if (state.drySeasonResidualModel) {
      const mockX = [[0]];
      const mockY = [[0]];
      model.drySeasonResidualModel = new MultivariateLinearRegression(mockX, mockY);
      (model.drySeasonResidualModel as any).weights = state.drySeasonResidualModel.weights;
      (model.drySeasonResidualModel as any).inputs = state.drySeasonResidualModel.inputs;
      (model.drySeasonResidualModel as any).outputs = state.drySeasonResidualModel.outputs;
    }

    return model;
  }
}

/**
 * Serialized state for SolarHybridModel
 */
export interface SolarHybridModelState {
  version: number;
  stationCode: string;
  biasCorrection: number;
  drySeasonBiasCorrection: number;
  physicsOnlyMode: boolean;
  weatherConfidenceMode: boolean;
  seasonalAdaptiveMode: boolean;
  hourlyCorrection: Array<[number, number]>;
  drySeasonHourlyCorrection: Array<[number, number]>;
  residualModel: {
    weights: number[][];
    inputs: number;
    outputs: number;
  } | null;
  drySeasonResidualModel: {
    weights: number[][];
    inputs: number;
    outputs: number;
  } | null;
  irradianceModelParams: {
    tempCoeff: number;
    systemLoss: number;
  };
}
