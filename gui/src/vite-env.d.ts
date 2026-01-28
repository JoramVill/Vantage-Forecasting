/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<{}, {}, any>
  export default component
}

interface AllSettings {
  // LLM Settings
  provider: 'claude' | 'gemini'
  claudeApiKey: string
  geminiApiKey: string
  claudeModel: string
  geminiModel: string
  // Directory Settings
  demandDataDir: string
  cfacDataDir: string
  outputDir: string
  weatherCacheDir: string
  databasePath: string
}

interface ChatResponse {
  content: string
  toolCalls?: Array<{
    name: string
    input: Record<string, unknown>
    output?: string
    status: 'pending' | 'running' | 'completed' | 'failed'
  }>
  error?: string
}

interface Window {
  electronAPI: {
    runCommand: (command: string, args: string[]) => Promise<{ stdout: string; stderr: string; code: number }>;
    selectFile: (options?: { filters?: { name: string; extensions: string[] }[] }) => Promise<string | null>;
    selectDirectory: () => Promise<string | null>;
    saveFile: (options?: { defaultPath?: string; filters?: { name: string; extensions: string[] }[] }) => Promise<string | null>;
    getAppPath: () => Promise<string>;
    loadSettings: () => Promise<AllSettings>;
    saveSettings: (settings: AllSettings) => Promise<boolean>;
    sendChatMessage: (message: string, history: Array<{ role: string; content: string }>) => Promise<ChatResponse>;
  }
}
