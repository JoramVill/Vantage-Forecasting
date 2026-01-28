import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

export type LLMProvider = 'claude' | 'gemini'

export interface LLMSettings {
  provider: LLMProvider
  claudeApiKey: string
  geminiApiKey: string
  claudeModel: string
  geminiModel: string
}

export interface DirectorySettings {
  demandDataDir: string
  cfacDataDir: string
  outputDir: string
  weatherCacheDir: string
  databasePath: string
}

export interface AllSettings extends LLMSettings, DirectorySettings {}

export const useSettingsStore = defineStore('settings', () => {
  // LLM State
  const provider = ref<LLMProvider>('claude')
  const claudeApiKey = ref('')
  const geminiApiKey = ref('')
  const claudeModel = ref('claude-sonnet-4-20250514')
  const geminiModel = ref('gemini-2.0-flash')

  // Directory State
  const demandDataDir = ref('')
  const cfacDataDir = ref('')
  const outputDir = ref('')
  const weatherCacheDir = ref('')
  const databasePath = ref('')

  const isLoading = ref(false)

  // Computed
  const hasValidApiKey = computed(() => {
    if (provider.value === 'claude') {
      return claudeApiKey.value.trim().startsWith('sk-')
    } else {
      return geminiApiKey.value.trim().length > 0
    }
  })

  const currentApiKey = computed(() => {
    return provider.value === 'claude' ? claudeApiKey.value : geminiApiKey.value
  })

  const currentModel = computed(() => {
    return provider.value === 'claude' ? claudeModel.value : geminiModel.value
  })

  const hasDirectoriesConfigured = computed(() => {
    return demandDataDir.value.trim().length > 0 || cfacDataDir.value.trim().length > 0
  })

  // Actions
  async function loadSettings() {
    isLoading.value = true
    try {
      const settings = await window.electronAPI.loadSettings()
      if (settings) {
        // LLM settings
        provider.value = settings.provider || 'claude'
        claudeApiKey.value = settings.claudeApiKey || ''
        geminiApiKey.value = settings.geminiApiKey || ''
        claudeModel.value = settings.claudeModel || 'claude-sonnet-4-20250514'
        geminiModel.value = settings.geminiModel || 'gemini-2.0-flash'

        // Directory settings
        demandDataDir.value = settings.demandDataDir || ''
        cfacDataDir.value = settings.cfacDataDir || ''
        outputDir.value = settings.outputDir || ''
        weatherCacheDir.value = settings.weatherCacheDir || ''
        databasePath.value = settings.databasePath || ''
      }
    } catch (error) {
      console.error('Failed to load settings:', error)
    } finally {
      isLoading.value = false
    }
  }

  async function saveSettings() {
    isLoading.value = true
    try {
      await window.electronAPI.saveSettings({
        // LLM settings
        provider: provider.value,
        claudeApiKey: claudeApiKey.value,
        geminiApiKey: geminiApiKey.value,
        claudeModel: claudeModel.value,
        geminiModel: geminiModel.value,
        // Directory settings
        demandDataDir: demandDataDir.value,
        cfacDataDir: cfacDataDir.value,
        outputDir: outputDir.value,
        weatherCacheDir: weatherCacheDir.value,
        databasePath: databasePath.value
      })
    } catch (error) {
      console.error('Failed to save settings:', error)
      throw error
    } finally {
      isLoading.value = false
    }
  }

  function setProvider(newProvider: LLMProvider) {
    provider.value = newProvider
  }

  function setClaudeApiKey(key: string) {
    claudeApiKey.value = key
  }

  function setGeminiApiKey(key: string) {
    geminiApiKey.value = key
  }

  function setClaudeModel(model: string) {
    claudeModel.value = model
  }

  function setGeminiModel(model: string) {
    geminiModel.value = model
  }

  function setDemandDataDir(path: string) {
    demandDataDir.value = path
  }

  function setCfacDataDir(path: string) {
    cfacDataDir.value = path
  }

  function setOutputDir(path: string) {
    outputDir.value = path
  }

  function setWeatherCacheDir(path: string) {
    weatherCacheDir.value = path
  }

  function setDatabasePath(path: string) {
    databasePath.value = path
  }

  return {
    // LLM State
    provider,
    claudeApiKey,
    geminiApiKey,
    claudeModel,
    geminiModel,
    // Directory State
    demandDataDir,
    cfacDataDir,
    outputDir,
    weatherCacheDir,
    databasePath,
    // General
    isLoading,
    // Computed
    hasValidApiKey,
    currentApiKey,
    currentModel,
    hasDirectoriesConfigured,
    // Actions
    loadSettings,
    saveSettings,
    setProvider,
    setClaudeApiKey,
    setGeminiApiKey,
    setClaudeModel,
    setGeminiModel,
    setDemandDataDir,
    setCfacDataDir,
    setOutputDir,
    setWeatherCacheDir,
    setDatabasePath
  }
})
