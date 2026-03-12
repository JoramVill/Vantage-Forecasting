/**
 * Model Cache Service
 *
 * Caches trained ML models to avoid redundant training.
 * Uses hash-based invalidation to detect training data changes.
 */

import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, unlinkSync } from 'fs';
import { join } from 'path';

interface CacheEntry {
  hash: string;
  modelType: string;
  createdAt: string;
  trainingDataPath: string;
  parameters: Record<string, any>;
}

interface CacheManifest {
  entries: Record<string, CacheEntry>;  // hash -> entry
  version: string;
}

export class ModelCacheService {
  private cacheDir: string;
  private manifestPath: string;
  private manifest: CacheManifest;
  private maxCacheAgeDays: number;

  constructor(cacheDir: string = './model_cache', maxCacheAgeDays: number = 7) {
    this.cacheDir = cacheDir;
    this.manifestPath = join(cacheDir, 'manifest.json');
    this.maxCacheAgeDays = maxCacheAgeDays;

    // Ensure cache directory exists
    if (!existsSync(cacheDir)) {
      mkdirSync(cacheDir, { recursive: true });
    }

    // Load or create manifest
    this.manifest = this.loadManifest();
  }

  private loadManifest(): CacheManifest {
    if (existsSync(this.manifestPath)) {
      try {
        const content = readFileSync(this.manifestPath, 'utf-8');
        return JSON.parse(content);
      } catch {
        return { entries: {}, version: '1.0' };
      }
    }
    return { entries: {}, version: '1.0' };
  }

  private saveManifest(): void {
    writeFileSync(this.manifestPath, JSON.stringify(this.manifest, null, 2));
  }

  /**
   * Generate hash from training data files
   */
  hashTrainingData(dataPath: string, modelParams?: Record<string, any>): string {
    const hash = createHash('sha256');

    // Hash file contents or directory contents
    if (existsSync(dataPath)) {
      const stat = statSync(dataPath);
      if (stat.isDirectory()) {
        // Hash all CSV files in directory
        const files = readdirSync(dataPath).filter(f => f.endsWith('.csv')).sort();
        for (const file of files) {
          const filePath = join(dataPath, file);
          const content = readFileSync(filePath);
          hash.update(content);
        }
      } else {
        // Single file
        const content = readFileSync(dataPath);
        hash.update(content);
      }
    }

    // Include model parameters in hash
    if (modelParams) {
      hash.update(JSON.stringify(modelParams));
    }

    return hash.digest('hex').substring(0, 16);  // First 16 chars
  }

  /**
   * Check if valid cache exists for given hash
   */
  hasValidCache(hash: string): boolean {
    const entry = this.manifest.entries[hash];
    if (!entry) return false;

    // Check if cache file exists
    const modelPath = join(this.cacheDir, `${hash}.json`);
    if (!existsSync(modelPath)) {
      delete this.manifest.entries[hash];
      this.saveManifest();
      return false;
    }

    // Check age
    const created = new Date(entry.createdAt);
    const ageMs = Date.now() - created.getTime();
    const ageDays = ageMs / (1000 * 60 * 60 * 24);

    if (ageDays > this.maxCacheAgeDays) {
      // Expired
      this.invalidateCache(hash);
      return false;
    }

    return true;
  }

  /**
   * Save model data to cache
   */
  saveModel(
    hash: string,
    modelType: string,
    modelData: any,
    trainingDataPath: string,
    parameters?: Record<string, any>
  ): string {
    const modelPath = join(this.cacheDir, `${hash}.json`);

    // Save model data
    writeFileSync(modelPath, JSON.stringify(modelData, null, 2));

    // Update manifest
    this.manifest.entries[hash] = {
      hash,
      modelType,
      createdAt: new Date().toISOString(),
      trainingDataPath,
      parameters: parameters || {}
    };
    this.saveManifest();

    return modelPath;
  }

  /**
   * Load model from cache
   */
  loadModel(hash: string): any | null {
    if (!this.hasValidCache(hash)) return null;

    const modelPath = join(this.cacheDir, `${hash}.json`);
    try {
      const content = readFileSync(modelPath, 'utf-8');
      return JSON.parse(content);
    } catch {
      this.invalidateCache(hash);
      return null;
    }
  }

  /**
   * Invalidate specific cache entry
   */
  invalidateCache(hash: string): void {
    const modelPath = join(this.cacheDir, `${hash}.json`);
    if (existsSync(modelPath)) {
      unlinkSync(modelPath);
    }
    delete this.manifest.entries[hash];
    this.saveManifest();
  }

  /**
   * Clear all cache
   */
  clearAll(): void {
    for (const hash of Object.keys(this.manifest.entries)) {
      const modelPath = join(this.cacheDir, `${hash}.json`);
      if (existsSync(modelPath)) {
        unlinkSync(modelPath);
      }
    }
    this.manifest = { entries: {}, version: '1.0' };
    this.saveManifest();
  }

  /**
   * Get cache statistics
   */
  getStats(): { entries: number; totalSizeKB: number; oldestAge: number } {
    let totalSize = 0;
    let oldestAge = 0;

    for (const entry of Object.values(this.manifest.entries)) {
      const modelPath = join(this.cacheDir, `${entry.hash}.json`);
      if (existsSync(modelPath)) {
        totalSize += statSync(modelPath).size;
      }
      const age = (Date.now() - new Date(entry.createdAt).getTime()) / (1000 * 60 * 60);
      if (age > oldestAge) oldestAge = age;
    }

    return {
      entries: Object.keys(this.manifest.entries).length,
      totalSizeKB: Math.round(totalSize / 1024),
      oldestAge: Math.round(oldestAge)
    };
  }
}

// Singleton instance
let instance: ModelCacheService | null = null;

export function getModelCache(cacheDir?: string): ModelCacheService {
  if (!instance) {
    instance = new ModelCacheService(cacheDir);
  }
  return instance;
}
