/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<{}, {}, any>;
  export default component;
}

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
