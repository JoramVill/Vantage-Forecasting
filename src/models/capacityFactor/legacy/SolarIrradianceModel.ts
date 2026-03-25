/**
 * Physics-based solar irradiance model
 *
 * Models the relationship between solar irradiance (GHI) and power output
 * including temperature derating and system losses.
 */
export class SolarIrradianceModel {
  private GHI_STC: number = 1000;      // W/m² at Standard Test Conditions
  private tempCoeff: number = -0.003;   // -0.3% per °C above 25°C (calibrated from PH data)
  private systemLoss: number = 0.92;    // 92% (reduced losses for modern inverters)
  private NOCT: number = 43;            // Nominal Operating Cell Temperature (lower for better ventilation)
  // Visual Crossing API solar radiation accuracy varies by month:
  // - July: Accurate (ratio 1.03 vs actual CF)
  // - November: Under-reports by ~2x (ratio 2.01 vs actual CF)
  // The scale factor is a compromise; ML residual layer provides additional correction
  private irradianceScale: number = 1.4;

  constructor(params?: { tempCoeff?: number; systemLoss?: number; NOCT?: number; irradianceScale?: number }) {
    if (params?.tempCoeff !== undefined) {
      this.tempCoeff = params.tempCoeff;
    }
    if (params?.systemLoss !== undefined) {
      this.systemLoss = params.systemLoss;
    }
    if (params?.NOCT !== undefined) {
      this.NOCT = params.NOCT;
    }
    if (params?.irradianceScale !== undefined) {
      this.irradianceScale = params.irradianceScale;
    }
  }

  /**
   * Calculate capacity factor from solar irradiance and temperature
   *
   * @param solarRadiation - Global Horizontal Irradiance (GHI) in W/m²
   * @param temperature - Ambient temperature in degrees Celsius
   * @returns Capacity factor between 0 and 1
   */
  predict(solarRadiation: number, temperature: number): number {
    // No generation at night or with zero irradiance
    if (solarRadiation <= 0) {
      return 0;
    }

    // Scale up irradiance (Visual Crossing API under-reports compared to actual PH conditions)
    const scaledRadiation = solarRadiation * this.irradianceScale;

    // Calculate cell temperature based on ambient temperature and irradiance
    const cellTemp = this.calculateCellTemperature(temperature, scaledRadiation);

    // Calculate temperature derating factor
    const tempFactor = this.calculateTempFactor(cellTemp);

    // Calculate capacity factor
    const cFac = (scaledRadiation / this.GHI_STC) * tempFactor * this.systemLoss;

    // Clamp to valid range [0, 1]
    return Math.max(0, Math.min(1, cFac));
  }

  /**
   * Calculate cell temperature from ambient temperature and irradiance
   *
   * Cell temperature increases above ambient based on solar heating
   *
   * @param ambientTemp - Ambient air temperature in °C
   * @param ghi - Global Horizontal Irradiance in W/m²
   * @returns Cell temperature in °C
   */
  private calculateCellTemperature(ambientTemp: number, ghi: number): number {
    // Cell temperature rises above ambient proportional to irradiance
    // NOCT - 20 represents the temperature rise at 800 W/m²
    const cellTemp = ambientTemp + (this.NOCT - 20) * (ghi / 800);
    return cellTemp;
  }

  /**
   * Calculate temperature derating factor
   *
   * Solar panel efficiency decreases with temperature above 25°C
   *
   * @param cellTemp - Cell temperature in °C
   * @returns Temperature derating factor (multiplicative)
   */
  private calculateTempFactor(cellTemp: number): number {
    // Temperature coefficient is negative (efficiency decreases with heat)
    // Factor of 1.0 at 25°C (STC), decreases as temperature increases
    const tempFactor = 1 + this.tempCoeff * (cellTemp - 25);
    return tempFactor;
  }
}
