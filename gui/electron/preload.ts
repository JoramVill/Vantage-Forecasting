import { contextBridge, ipcRenderer } from 'electron'

export interface AllSettings {
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

export interface ChatResponse {
  content: string
  toolCalls?: Array<{
    name: string
    input: Record<string, unknown>
    output?: string
    status: 'pending' | 'running' | 'completed' | 'failed'
  }>
  error?: string
}

contextBridge.exposeInMainWorld('electronAPI', {
  // Existing methods
  runCommand: (command: string, args: string[]) =>
    ipcRenderer.invoke('run-command', command, args),

  selectFile: (options?: { filters?: { name: string; extensions: string[] }[] }) =>
    ipcRenderer.invoke('select-file', options),

  selectDirectory: () =>
    ipcRenderer.invoke('select-directory'),

  saveFile: (options?: { defaultPath?: string; filters?: { name: string; extensions: string[] }[] }) =>
    ipcRenderer.invoke('save-file', options),

  getAppPath: () =>
    ipcRenderer.invoke('get-app-path'),

  // Settings methods
  loadSettings: (): Promise<AllSettings> =>
    ipcRenderer.invoke('load-settings'),

  saveSettings: (settings: AllSettings): Promise<boolean> =>
    ipcRenderer.invoke('save-settings', settings),

  // Chat methods
  sendChatMessage: (message: string, history: Array<{ role: string; content: string }>): Promise<ChatResponse> =>
    ipcRenderer.invoke('send-chat-message', message, history)
})

// Type declaration for window.electronAPI
declare global {
  interface Window {
    electronAPI: {
      runCommand: (command: string, args: string[]) => Promise<{ stdout: string; stderr: string; code: number }>
      selectFile: (options?: { filters?: { name: string; extensions: string[] }[] }) => Promise<string | null>
      selectDirectory: () => Promise<string | null>
      saveFile: (options?: { defaultPath?: string; filters?: { name: string; extensions: string[] }[] }) => Promise<string | null>
      getAppPath: () => Promise<string>
      loadSettings: () => Promise<AllSettings>
      saveSettings: (settings: AllSettings) => Promise<boolean>
      sendChatMessage: (message: string, history: Array<{ role: string; content: string }>) => Promise<ChatResponse>
    }
  }
}
