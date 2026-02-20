import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  // Run CLI command
  runCommand: (args: string[]) =>
    ipcRenderer.invoke('run-command', args),

  // Select directory
  selectDirectory: () =>
    ipcRenderer.invoke('select-directory'),

  // Select file
  selectFile: (filters?: { name: string; extensions: string[] }[]) =>
    ipcRenderer.invoke('select-file', filters),

  // Save file dialog
  saveFile: (defaultName?: string) =>
    ipcRenderer.invoke('save-file', defaultName),

  // Get app path
  getAppPath: () =>
    ipcRenderer.invoke('get-app-path'),

  // Load settings
  loadSettings: () =>
    ipcRenderer.invoke('load-settings'),

  // Save settings
  saveSettings: (settings: Record<string, any>) =>
    ipcRenderer.invoke('save-settings', settings),

  // Listen for real-time command output
  onCommandOutput: (callback: (data: { type: string; data: string }) => void) => {
    ipcRenderer.on('command-output', (_event, data) => callback(data));
  },

  // Remove command output listener
  removeCommandOutputListener: () => {
    ipcRenderer.removeAllListeners('command-output');
  },

  // Check data format (zonal vs regional)
  checkDataFormat: (dirPath: string, dataType: 'demand' | 'database') =>
    ipcRenderer.invoke('check-data-format', dirPath, dataType),

  // Check weather directory structure
  checkWeatherDirectory: (dirPath: string) =>
    ipcRenderer.invoke('check-weather-directory', dirPath),

  // Get database info (date ranges, record counts)
  getDatabaseInfo: (dbPath: string) =>
    ipcRenderer.invoke('get-database-info', dbPath),

  // Import data to database
  importToDatabase: (options: { dbPath: string; dataType: 'demand' | 'cfac' | 'weather'; sourcePath: string }) =>
    ipcRenderer.invoke('import-to-database', options),
});

// Type declaration for window.electronAPI
declare global {
  interface Window {
    electronAPI: {
      runCommand: (args: string[]) => Promise<{ stdout: string; stderr: string; code: number; error?: string }>;
      selectDirectory: () => Promise<string | null>;
      selectFile: (filters?: { name: string; extensions: string[] }[]) => Promise<string | null>;
      saveFile: (defaultName?: string) => Promise<string | null>;
      getAppPath: () => Promise<string>;
      loadSettings: () => Promise<Record<string, any>>;
      saveSettings: (settings: Record<string, any>) => Promise<boolean>;
      onCommandOutput: (callback: (data: { type: string; data: string }) => void) => void;
      removeCommandOutputListener: () => void;
      checkDataFormat: (dirPath: string, dataType: 'demand' | 'database') => Promise<{
        format: 'zonal' | 'regional' | 'mixed' | 'unknown' | 'error';
        message: string;
        columns?: string[];
      }>;
      checkWeatherDirectory: (dirPath: string) => Promise<{
        valid: boolean;
        message: string;
        hasCombined?: boolean;
        hasCityFolders?: boolean;
        windStations?: number;
        solarStations?: number;
        csvFileCount?: number;
        dateRange?: { start: string; end: string };
        folders?: string[];
      }>;
      getDatabaseInfo: (dbPath: string) => Promise<{
        success: boolean;
        message: string;
        rawOutput?: string;
        demand?: { records: number; range?: string | { start: string; end: string } | null; regions?: string[] } | null;
        cfac?: { records: number; range?: string | null } | null;
        weather?: { records: number; range?: string | null } | null;
      }>;
      importToDatabase: (options: { dbPath: string; dataType: 'demand' | 'cfac' | 'weather'; sourcePath: string }) => Promise<{
        success: boolean;
        message: string;
        stdout?: string;
        stderr?: string;
      }>;
    };
  }
}
