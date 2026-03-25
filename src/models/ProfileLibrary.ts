import { DailyRecord, DailyWeather } from '../data/DailyAggregator.js';

/**
 * Weather conditions at cluster centroid
 */
export interface CentroidWeather {
  avgTemp: number;
  maxTemp: number;
  tempRange: number;
  avgCloudCover: number;
  totalPrecip: number;
}

/**
 * Archetype profile from clustering
 */
export interface ArchetypeProfile {
  shape: number[];              // 24 values summing to 1.0
  centroidWeather: CentroidWeather;
  sampleCount: number;
  peakToTroughRatio: number;    // max(shape) / min(shape)
}

/**
 * Profile library entry for a specific {area, dayType}
 */
export interface ProfileLibraryEntry {
  area: string;
  dayType: string;
  archetypes: ArchetypeProfile[];
  overallMedian: number[];      // Fallback median shape
}

/**
 * Configuration for ProfileLibrary
 */
export interface ProfileLibraryConfig {
  archetypeCount: number;       // Number of archetypes per {area, dayType}
  confidenceThreshold: number;  // Minimum samples for full confidence
  smoothingEnabled: boolean;    // Enable hierarchical smoothing
  maxIterations: number;        // Max k-means iterations
  convergenceThreshold: number; // k-means convergence threshold
}

/**
 * Parent region mapping for hierarchical smoothing
 */
const PARENT_MAPPING: Record<string, string> = {
  '01NLUZ': 'CLUZ', '02METRO': 'CLUZ', '03SLUZ': 'CLUZ',
  '04LEYTE': 'CVIS', '05CEBU': 'CVIS', '06NEGROS': 'CVIS',
  '07BOHOL': 'CVIS', '08PANAY': 'CVIS',
  '09NWMIN': 'CMIN', '10LANAO': 'CMIN', '11NCMIN': 'CMIN',
  '12NEMIN': 'CMIN', '13SEMIN': 'CMIN', '14SWMIN': 'CMIN'
};

/**
 * ProfileLibrary - Stage A of Shape Model
 *
 * Responsibilities:
 * 1. Cluster historical shapes into archetypes per {area, dayType}
 * 2. Store archetype profiles with centroid weather conditions
 * 3. Apply hierarchical smoothing for sparse areas
 * 4. Select best archetype at inference time based on weather forecast
 */
export class ProfileLibrary {
  private config: ProfileLibraryConfig;
  private library: Map<string, Map<string, ProfileLibraryEntry>>;

  static DEFAULT_CONFIG: ProfileLibraryConfig = {
    archetypeCount: 3,
    confidenceThreshold: 50,
    smoothingEnabled: true,
    maxIterations: 100,
    convergenceThreshold: 0.0001
  };

  constructor(config: Partial<ProfileLibraryConfig> = {}) {
    this.config = { ...ProfileLibrary.DEFAULT_CONFIG, ...config };
    this.library = new Map();
  }

  /**
   * Build the profile library from training data
   */
  build(dailyRecords: DailyRecord[]): void {
    console.log('Building Profile Library...');

    // Group by area and dayType
    const grouped = new Map<string, Map<string, DailyRecord[]>>();
    for (const record of dailyRecords) {
      if (!grouped.has(record.area)) {
        grouped.set(record.area, new Map());
      }
      const dayTypeMap = grouped.get(record.area)!;
      if (!dayTypeMap.has(record.calendar.dayType)) {
        dayTypeMap.set(record.calendar.dayType, []);
      }
      dayTypeMap.get(record.calendar.dayType)!.push(record);
    }

    // Build archetypes for each area+dayType
    for (const [area, dayTypeMap] of grouped) {
      if (!this.library.has(area)) {
        this.library.set(area, new Map());
      }

      for (const [dayType, records] of dayTypeMap) {
        console.log(`Building archetypes for ${area} ${dayType} (${records.length} samples)`);

        const entry = this.buildProfileEntry(area, dayType, records);
        this.library.get(area)!.set(dayType, entry);
      }
    }

    // Apply hierarchical smoothing if enabled
    if (this.config.smoothingEnabled) {
      this.applyHierarchicalSmoothing();
    }

    console.log(`Profile Library built with ${this.library.size} areas`);
  }

  /**
   * Build profile entry for specific area+dayType
   */
  private buildProfileEntry(
    area: string,
    dayType: string,
    records: DailyRecord[]
  ): ProfileLibraryEntry {
    // Extract shapes and weather
    const shapes = records.map(r => r.shape);
    const weatherData = records.map(r => r.dailyWeather);

    // Compute overall median shape
    const overallMedian = this.computeMedianShape(shapes);

    // Cluster into archetypes
    const archetypes = this.clusterShapes(shapes, weatherData, this.config.archetypeCount);

    return {
      area,
      dayType,
      archetypes,
      overallMedian
    };
  }

  /**
   * Cluster shapes into archetypes using k-means
   */
  private clusterShapes(
    shapes: number[][],
    weatherData: DailyWeather[],
    k: number
  ): ArchetypeProfile[] {
    if (shapes.length < k) {
      // Not enough samples for k clusters, return single archetype
      k = 1;
    }

    // Initialize centroids randomly
    let centroids = this.initializeCentroids(shapes, k);

    // K-means iterations
    for (let iter = 0; iter < this.config.maxIterations; iter++) {
      // Assign each shape to nearest centroid
      const assignments = shapes.map(shape =>
        this.findNearestCentroid(shape, centroids)
      );

      // Update centroids
      const newCentroids = this.updateCentroids(shapes, assignments, k);

      // Check convergence
      const maxChange = this.maxCentroidChange(centroids, newCentroids);
      centroids = newCentroids;

      if (maxChange < this.config.convergenceThreshold) {
        console.log(`  Converged after ${iter + 1} iterations`);
        break;
      }
    }

    // Build archetype profiles
    const archetypes: ArchetypeProfile[] = [];
    for (let i = 0; i < k; i++) {
      const clusterIndices = shapes
        .map((_, idx) => idx)
        .filter((_, idx) => this.findNearestCentroid(shapes[idx], centroids) === i);

      if (clusterIndices.length === 0) continue;

      const clusterShapes = clusterIndices.map(idx => shapes[idx]);
      const clusterWeather = clusterIndices.map(idx => weatherData[idx]);

      // Compute centroid weather
      const centroidWeather = this.computeCentroidWeather(clusterWeather);

      // Compute peak-to-trough ratio
      const shape = centroids[i];
      const peakToTroughRatio = Math.max(...shape) / Math.min(...shape);

      archetypes.push({
        shape: centroids[i],
        centroidWeather,
        sampleCount: clusterIndices.length,
        peakToTroughRatio
      });
    }

    return archetypes;
  }

  /**
   * Initialize k-means centroids using k-means++ algorithm
   */
  private initializeCentroids(shapes: number[][], k: number): number[][] {
    const centroids: number[][] = [];

    // Pick first centroid randomly
    const firstIdx = Math.floor(Math.random() * shapes.length);
    centroids.push([...shapes[firstIdx]]);

    // Pick remaining centroids using k-means++
    for (let i = 1; i < k; i++) {
      const distances = shapes.map(shape => {
        const nearestDist = Math.min(
          ...centroids.map(c => this.euclideanDistance(shape, c))
        );
        return nearestDist * nearestDist;
      });

      // Weighted random selection
      const totalDist = distances.reduce((sum, d) => sum + d, 0);
      let rand = Math.random() * totalDist;

      let selectedIdx = 0;
      for (let j = 0; j < distances.length; j++) {
        rand -= distances[j];
        if (rand <= 0) {
          selectedIdx = j;
          break;
        }
      }

      centroids.push([...shapes[selectedIdx]]);
    }

    return centroids;
  }

  /**
   * Find nearest centroid for a shape
   */
  private findNearestCentroid(shape: number[], centroids: number[][]): number {
    let minDist = Infinity;
    let minIdx = 0;

    for (let i = 0; i < centroids.length; i++) {
      const dist = this.euclideanDistance(shape, centroids[i]);
      if (dist < minDist) {
        minDist = dist;
        minIdx = i;
      }
    }

    return minIdx;
  }

  /**
   * Update centroids based on assignments
   */
  private updateCentroids(
    shapes: number[][],
    assignments: number[],
    k: number
  ): number[][] {
    const centroids: number[][] = [];

    for (let i = 0; i < k; i++) {
      const clusterShapes = shapes.filter((_, idx) => assignments[idx] === i);

      if (clusterShapes.length === 0) {
        // Empty cluster, reinitialize randomly
        const randomIdx = Math.floor(Math.random() * shapes.length);
        centroids.push([...shapes[randomIdx]]);
      } else {
        // Compute mean of cluster shapes
        const mean = new Array(24).fill(0);
        for (const shape of clusterShapes) {
          for (let h = 0; h < 24; h++) {
            mean[h] += shape[h];
          }
        }
        for (let h = 0; h < 24; h++) {
          mean[h] /= clusterShapes.length;
        }
        centroids.push(mean);
      }
    }

    return centroids;
  }

  /**
   * Compute maximum change between old and new centroids
   */
  private maxCentroidChange(old: number[][], updated: number[][]): number {
    let maxChange = 0;
    for (let i = 0; i < old.length; i++) {
      const change = this.euclideanDistance(old[i], updated[i]);
      if (change > maxChange) {
        maxChange = change;
      }
    }
    return maxChange;
  }

  /**
   * Euclidean distance between two shapes
   */
  private euclideanDistance(a: number[], b: number[]): number {
    let sum = 0;
    for (let i = 0; i < a.length; i++) {
      const diff = a[i] - b[i];
      sum += diff * diff;
    }
    return Math.sqrt(sum);
  }

  /**
   * Compute median shape from array of shapes
   */
  private computeMedianShape(shapes: number[][]): number[] {
    const median = new Array(24).fill(0);

    for (let h = 0; h < 24; h++) {
      const values = shapes.map(s => s[h]).sort((a, b) => a - b);
      median[h] = values[Math.floor(values.length / 2)];
    }

    // Renormalize to sum to 1.0
    const sum = median.reduce((s, v) => s + v, 0);
    return median.map(v => v / sum);
  }

  /**
   * Compute centroid weather from cluster samples
   */
  private computeCentroidWeather(weatherData: DailyWeather[]): CentroidWeather {
    const n = weatherData.length;
    return {
      avgTemp: weatherData.reduce((s, w) => s + w.avgTemp, 0) / n,
      maxTemp: weatherData.reduce((s, w) => s + w.maxTemp, 0) / n,
      tempRange: weatherData.reduce((s, w) => s + w.tempRange, 0) / n,
      avgCloudCover: weatherData.reduce((s, w) => s + w.avgCloudCover, 0) / n,
      totalPrecip: weatherData.reduce((s, w) => s + w.totalPrecip, 0) / n
    };
  }

  /**
   * Apply hierarchical smoothing for sparse areas
   */
  private applyHierarchicalSmoothing(): void {
    console.log('Applying hierarchical smoothing...');

    for (const [area, dayTypeMap] of this.library) {
      const parentArea = PARENT_MAPPING[area];
      if (!parentArea) continue; // No parent (regional areas)

      const parentEntry = this.library.get(parentArea);
      if (!parentEntry) continue; // Parent not found

      for (const [dayType, entry] of dayTypeMap) {
        const parentDayTypeEntry = parentEntry.get(dayType);
        if (!parentDayTypeEntry) continue;

        // Compute smoothing factor
        const totalSamples = entry.archetypes.reduce((sum, a) => sum + a.sampleCount, 0);
        const alpha = Math.min(1.0, totalSamples / this.config.confidenceThreshold);

        if (alpha < 1.0) {
          console.log(`  Smoothing ${area} ${dayType} (α=${alpha.toFixed(2)})`);

          // Blend each archetype with parent's corresponding archetype
          for (let i = 0; i < entry.archetypes.length; i++) {
            const childArchetype = entry.archetypes[i];
            const parentArchetype = parentDayTypeEntry.archetypes[i] || parentDayTypeEntry.overallMedian;

            const parentShape = Array.isArray(parentArchetype) ? parentArchetype : parentArchetype.shape;

            // Blend shapes
            const blendedShape = childArchetype.shape.map((val, h) =>
              alpha * val + (1 - alpha) * parentShape[h]
            );

            // Renormalize
            const sum = blendedShape.reduce((s, v) => s + v, 0);
            childArchetype.shape = blendedShape.map(v => v / sum);
          }
        }
      }
    }
  }

  /**
   * Select best archetype for given weather forecast
   */
  selectArchetype(
    area: string,
    dayType: string,
    forecastWeather: DailyWeather
  ): number[] {
    const areaLib = this.library.get(area);
    if (!areaLib) {
      throw new Error(`No profile library for area ${area}`);
    }

    const entry = areaLib.get(dayType);
    if (!entry) {
      throw new Error(`No profile for ${area} ${dayType}`);
    }

    if (entry.archetypes.length === 0) {
      return entry.overallMedian;
    }

    // Normalize weather features for distance calculation
    const normalized = this.normalizeWeather(forecastWeather);

    // Find nearest archetype
    let minDist = Infinity;
    let selectedArchetype = entry.archetypes[0];

    for (const archetype of entry.archetypes) {
      const centroidNorm = this.normalizeWeather({
        avgTemp: archetype.centroidWeather.avgTemp,
        maxTemp: archetype.centroidWeather.maxTemp,
        minTemp: 0,
        tempRange: archetype.centroidWeather.tempRange,
        CDH: 0,
        totalPrecip: archetype.centroidWeather.totalPrecip,
        avgCloudCover: archetype.centroidWeather.avgCloudCover,
        totalSolar: 0,
        avgHeatIndex: 0
      });

      const dist = this.weatherDistance(normalized, centroidNorm);
      if (dist < minDist) {
        minDist = dist;
        selectedArchetype = archetype;
      }
    }

    return selectedArchetype.shape;
  }

  /**
   * Normalize weather features for distance calculation
   */
  private normalizeWeather(weather: DailyWeather): number[] {
    return [
      weather.avgTemp / 40,        // Normalize to ~0-1 range
      weather.maxTemp / 45,
      weather.tempRange / 15,
      weather.avgCloudCover / 100,
      weather.totalPrecip / 50
    ];
  }

  /**
   * Euclidean distance between normalized weather vectors
   */
  private weatherDistance(a: number[], b: number[]): number {
    let sum = 0;
    for (let i = 0; i < a.length; i++) {
      const diff = a[i] - b[i];
      sum += diff * diff;
    }
    return Math.sqrt(sum);
  }

  /**
   * Get overall median shape for area+dayType
   */
  getOverallMedian(area: string, dayType: string): number[] {
    const entry = this.library.get(area)?.get(dayType);
    if (!entry) {
      throw new Error(`No profile for ${area} ${dayType}`);
    }
    return entry.overallMedian;
  }

  /**
   * Serialize library for saving
   */
  serialize(): any {
    const entries: any[] = [];

    for (const [area, dayTypeMap] of this.library) {
      for (const [dayType, entry] of dayTypeMap) {
        entries.push({
          area,
          dayType,
          archetypes: entry.archetypes,
          overallMedian: entry.overallMedian
        });
      }
    }

    return {
      config: this.config,
      entries
    };
  }

  /**
   * Deserialize library from saved state
   */
  static deserialize(data: any): ProfileLibrary {
    const library = new ProfileLibrary(data.config);

    for (const entry of data.entries) {
      if (!library.library.has(entry.area)) {
        library.library.set(entry.area, new Map());
      }
      library.library.get(entry.area)!.set(entry.dayType, {
        area: entry.area,
        dayType: entry.dayType,
        archetypes: entry.archetypes,
        overallMedian: entry.overallMedian
      });
    }

    return library;
  }
}
