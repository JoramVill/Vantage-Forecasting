/**
 * IEMOP Download Service
 * Downloads generator capacity data from IEMOP (Independent Electricity Market Operator of the Philippines)
 *
 * Data sources:
 * - CAPEG: Registered Capacity - Generation (https://www.iemop.ph/market-data/registered-capacity-generation/)
 * - MNM: Market Network Model files containing genlist.csv (https://www.iemop.ph/market-reports/updates-on-the-market-network-model/)
 */

import axios, { AxiosInstance } from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import AdmZip from 'adm-zip';

// IEMOP WordPress post IDs for different data types
const IEMOP_POST_IDS = {
  CAPEG: '302634',           // Registered Capacity - Generation
  MNM_LUZON: '239395',       // Luzon MNM
  MNM_VISAYAS: '239397',     // Visayas MNM (estimated)
  MNM_MINDANAO: '239399',    // Mindanao MNM (estimated)
  MNM_UPDATES: '23769'       // Updates on the Market Network Model
};

// URLs
const IEMOP_BASE_URL = 'https://www.iemop.ph';
const IEMOP_AJAX_URL = `${IEMOP_BASE_URL}/wp-admin/admin-ajax.php`;

export interface DownloadResult {
  success: boolean;
  filePath?: string;
  error?: string;
  timestamp: Date;
}

export interface CAPEGRecord {
  resourceName: string;
  description: string;
  regionName: string;
  stationName: string;
  tradingParticipant: string;
  registeredCapacityMW?: number;
  fuelType?: string;
  dateRegistered?: string;
}

export interface GenlistRecord {
  resourceName: string;
  description: string;
  regionName: string;
  stationName: string;
  tradingParticipant: string;
}

export class IEMOPDownloadService {
  private client: AxiosInstance;
  private cacheDir: string;

  constructor(cacheDir: string = './iemop_cache') {
    this.cacheDir = cacheDir;
    this.ensureCacheDir();

    this.client = axios.create({
      timeout: 60000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Connection': 'keep-alive'
      }
    });
  }

  private ensureCacheDir(): void {
    if (!fs.existsSync(this.cacheDir)) {
      fs.mkdirSync(this.cacheDir, { recursive: true });
    }
  }

  /**
   * Download CAPEG (Registered Capacity - Generation) data
   * Uses WordPress AJAX API to fetch file list and download
   */
  async downloadCAPEG(verbose: boolean = false): Promise<DownloadResult> {
    try {
      if (verbose) console.log('Fetching CAPEG file list from IEMOP...');

      // Fetch file list using WordPress AJAX
      const fileList = await this.fetchFileList(IEMOP_POST_IDS.CAPEG, 'market-data/registered-capacity-generation/');

      if (!fileList || fileList.length === 0) {
        // Try direct download approach
        return await this.downloadCAPEGDirect(verbose);
      }

      // Get the latest file
      const latestFile = fileList[0]; // Assuming sorted by date desc
      if (verbose) console.log(`Found CAPEG file: ${latestFile}`);

      // Download the file
      const downloadUrl = `${IEMOP_BASE_URL}/wp-content/uploads/downloads/data/CAPEG/${latestFile}`;
      const filePath = await this.downloadFile(downloadUrl, 'CAPEG', latestFile);

      return {
        success: true,
        filePath,
        timestamp: new Date()
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      if (verbose) console.error(`Error downloading CAPEG: ${errorMsg}`);
      return {
        success: false,
        error: errorMsg,
        timestamp: new Date()
      };
    }
  }

  /**
   * Direct download approach for CAPEG using the page's download mechanism
   */
  private async downloadCAPEGDirect(verbose: boolean = false): Promise<DownloadResult> {
    try {
      if (verbose) console.log('Trying direct CAPEG download...');

      // Try to fetch the CAPEG page and extract download link
      const response = await this.client.get(`${IEMOP_BASE_URL}/market-data/registered-capacity-generation/`);
      const html = response.data;

      // Look for download links in the page
      const downloadLinkMatch = html.match(/href="([^"]*CAPEG[^"]*\.csv)"/i) ||
                                html.match(/href="([^"]*registered.*capacity[^"]*\.csv)"/i);

      if (downloadLinkMatch) {
        const downloadUrl = downloadLinkMatch[1].startsWith('http')
          ? downloadLinkMatch[1]
          : `${IEMOP_BASE_URL}${downloadLinkMatch[1]}`;

        if (verbose) console.log(`Found download link: ${downloadUrl}`);

        const filename = `CAPEG_${new Date().toISOString().split('T')[0]}.csv`;
        const filePath = await this.downloadFile(downloadUrl, 'CAPEG', filename);

        return {
          success: true,
          filePath,
          timestamp: new Date()
        };
      }

      throw new Error('Could not find CAPEG download link on page');
    } catch (error) {
      throw error;
    }
  }

  /**
   * Download MNM (Market Network Model) ZIP file containing genlist.csv
   */
  async downloadMNM(region: 'LUZON' | 'VISAYAS' | 'MINDANAO' | 'ALL' = 'ALL', verbose: boolean = false): Promise<DownloadResult> {
    try {
      if (verbose) console.log(`Fetching MNM files for region: ${region}...`);

      // Try to get the MNM updates page which lists all available files
      const mnmFiles = await this.fetchMNMFileList(verbose);

      if (!mnmFiles || mnmFiles.length === 0) {
        throw new Error('No MNM files found');
      }

      // Filter by region if specified
      const filesToDownload = region === 'ALL'
        ? mnmFiles
        : mnmFiles.filter(f => f.toUpperCase().includes(region));

      if (filesToDownload.length === 0) {
        throw new Error(`No MNM files found for region: ${region}`);
      }

      // Download the first (latest) file
      const latestFile = filesToDownload[0];
      if (verbose) console.log(`Downloading MNM file: ${latestFile}`);

      const downloadUrl = `${IEMOP_BASE_URL}/wp-content/uploads/downloads/reports/mnm/${latestFile}`;
      const filePath = await this.downloadFile(downloadUrl, 'MNM', latestFile);

      // If it's a ZIP file, extract genlist.csv
      if (latestFile.endsWith('.zip')) {
        const genlistPath = await this.extractGenlistFromZip(filePath, verbose);
        if (genlistPath) {
          return {
            success: true,
            filePath: genlistPath,
            timestamp: new Date()
          };
        }
      }

      return {
        success: true,
        filePath,
        timestamp: new Date()
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      if (verbose) console.error(`Error downloading MNM: ${errorMsg}`);
      return {
        success: false,
        error: errorMsg,
        timestamp: new Date()
      };
    }
  }

  /**
   * Fetch file list from IEMOP using WordPress AJAX API
   */
  private async fetchFileList(postId: string, refererPath: string): Promise<string[]> {
    const today = new Date();
    const startDate = new Date(today);
    startDate.setMonth(startDate.getMonth() - 1);

    const formData = new URLSearchParams({
      'action': 'display_filtered_market_data_files',
      'sort': 'desc',
      'datefilter[start]': this.formatDate(startDate),
      'datefilter[end]': this.formatDate(today),
      'page': '1',
      'post_id': postId
    });

    try {
      const response = await this.client.post(IEMOP_AJAX_URL, formData.toString(), {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'X-Requested-With': 'XMLHttpRequest',
          'Referer': `${IEMOP_BASE_URL}/${refererPath}`,
          'Origin': IEMOP_BASE_URL
        }
      });

      if (response.data && response.data.source) {
        // Decode base64-encoded file paths
        return response.data.source.map((encoded: string) => {
          const decoded = Buffer.from(encoded, 'base64').toString();
          return path.basename(decoded);
        });
      }

      return [];
    } catch (error) {
      console.error('Error fetching file list:', error);
      return [];
    }
  }

  /**
   * Fetch MNM file list from updates page
   */
  private async fetchMNMFileList(verbose: boolean = false): Promise<string[]> {
    try {
      const response = await this.client.get(`${IEMOP_BASE_URL}/market-reports/updates-on-the-market-network-model/`);
      const html = response.data;

      // Extract ZIP file links
      const zipLinks: string[] = [];
      const regex = /href="([^"]*MNM[^"]*\.zip)"/gi;
      let match;

      while ((match = regex.exec(html)) !== null) {
        const filename = path.basename(match[1]);
        if (!zipLinks.includes(filename)) {
          zipLinks.push(filename);
        }
      }

      if (verbose && zipLinks.length > 0) {
        console.log(`Found ${zipLinks.length} MNM ZIP files`);
      }

      return zipLinks;
    } catch (error) {
      console.error('Error fetching MNM file list:', error);
      return [];
    }
  }

  /**
   * Download a file from IEMOP
   */
  private async downloadFile(url: string, type: string, filename: string): Promise<string> {
    const typeDir = path.join(this.cacheDir, type);
    if (!fs.existsSync(typeDir)) {
      fs.mkdirSync(typeDir, { recursive: true });
    }

    const filePath = path.join(typeDir, filename);

    const response = await this.client.get(url, {
      responseType: 'arraybuffer'
    });

    fs.writeFileSync(filePath, response.data);
    return filePath;
  }

  /**
   * Extract genlist.csv from MNM ZIP file
   */
  private async extractGenlistFromZip(zipPath: string, verbose: boolean = false): Promise<string | null> {
    try {
      const zip = new AdmZip(zipPath);
      const entries = zip.getEntries();

      for (const entry of entries) {
        if (entry.entryName.toLowerCase().includes('genlist') &&
            entry.entryName.endsWith('.csv')) {

          const outputDir = path.dirname(zipPath);
          const outputPath = path.join(outputDir, path.basename(entry.entryName));

          fs.writeFileSync(outputPath, entry.getData());

          if (verbose) console.log(`Extracted: ${outputPath}`);
          return outputPath;
        }
      }

      if (verbose) console.log('No genlist.csv found in ZIP file');
      return null;
    } catch (error) {
      console.error('Error extracting from ZIP:', error);
      return null;
    }
  }

  /**
   * Parse genlist.csv file
   */
  parseGenlistCSV(filePath: string): GenlistRecord[] {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').filter(line => line.trim());

    const records: GenlistRecord[] = [];

    // Skip header
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (line.includes('EOF')) continue;

      // Parse CSV line (handle quoted fields with commas)
      const fields = this.parseCSVLine(line);

      if (fields.length >= 5) {
        records.push({
          resourceName: fields[0]?.trim() || '',
          description: fields[1]?.trim() || '',
          regionName: fields[2]?.trim() || '',
          stationName: fields[3]?.trim() || '',
          tradingParticipant: fields[4]?.trim() || ''
        });
      }
    }

    return records;
  }

  /**
   * Parse a CSV line handling quoted fields
   */
  private parseCSVLine(line: string): string[] {
    const result: string[] = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const char = line[i];

      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === ',' && !inQuotes) {
        result.push(current);
        current = '';
      } else {
        current += char;
      }
    }

    result.push(current);
    return result;
  }

  /**
   * Get unique stations from genlist records
   */
  getUniqueStations(records: GenlistRecord[]): Map<string, { region: string; resources: string[]; tradingParticipants: Set<string> }> {
    const stations = new Map<string, { region: string; resources: string[]; tradingParticipants: Set<string> }>();

    for (const record of records) {
      if (!record.stationName) continue;

      if (!stations.has(record.stationName)) {
        stations.set(record.stationName, {
          region: record.regionName,
          resources: [],
          tradingParticipants: new Set()
        });
      }

      const station = stations.get(record.stationName)!;
      station.resources.push(record.resourceName);
      if (record.tradingParticipant) {
        station.tradingParticipants.add(record.tradingParticipant);
      }
    }

    return stations;
  }

  /**
   * Format date for IEMOP API
   */
  private formatDate(date: Date): string {
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const year = date.getFullYear();
    return `${month}/${day}/${year} 00:00`;
  }

  /**
   * Get the path to cached genlist file
   */
  getCachedGenlistPath(): string | null {
    const mnmDir = path.join(this.cacheDir, 'MNM');
    if (!fs.existsSync(mnmDir)) return null;

    const files = fs.readdirSync(mnmDir).filter(f => f.toLowerCase().includes('genlist') && f.endsWith('.csv'));
    if (files.length === 0) return null;

    // Return the most recent one
    return path.join(mnmDir, files.sort().reverse()[0]);
  }

  /**
   * Check if cached data is stale (older than specified hours)
   */
  isCacheStale(type: 'CAPEG' | 'MNM', maxAgeHours: number = 24): boolean {
    const typeDir = path.join(this.cacheDir, type);
    if (!fs.existsSync(typeDir)) return true;

    const files = fs.readdirSync(typeDir);
    if (files.length === 0) return true;

    // Check the modification time of the newest file
    let newestMtime = 0;
    for (const file of files) {
      const filePath = path.join(typeDir, file);
      const stats = fs.statSync(filePath);
      if (stats.mtimeMs > newestMtime) {
        newestMtime = stats.mtimeMs;
      }
    }

    const ageMs = Date.now() - newestMtime;
    const ageHours = ageMs / (1000 * 60 * 60);

    return ageHours > maxAgeHours;
  }
}

// Export singleton instance
export const iemopDownloadService = new IEMOPDownloadService();
