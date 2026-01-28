<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useSettingsStore } from '../stores/settingsStore'

const settingsStore = useSettingsStore()

const isSaving = ref(false)
const saveMessage = ref('')
const showClaudeKey = ref(false)
const showGeminiKey = ref(false)

const claudeModels = [
  { value: 'claude-sonnet-4-20250514', label: 'Claude Sonnet 4 (Recommended)' },
  { value: 'claude-3-5-sonnet-20241022', label: 'Claude 3.5 Sonnet' },
  { value: 'claude-3-haiku-20240307', label: 'Claude 3 Haiku (Fast)' }
]

const geminiModels = [
  { value: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash (Recommended)' },
  { value: 'gemini-1.5-pro', label: 'Gemini 1.5 Pro' },
  { value: 'gemini-1.5-flash', label: 'Gemini 1.5 Flash' }
]

onMounted(async () => {
  await settingsStore.loadSettings()
})

async function saveSettings() {
  isSaving.value = true
  saveMessage.value = ''

  try {
    await settingsStore.saveSettings()
    saveMessage.value = 'Settings saved successfully!'
    setTimeout(() => { saveMessage.value = '' }, 3000)
  } catch (error: any) {
    saveMessage.value = `Error: ${error.message}`
  } finally {
    isSaving.value = false
  }
}

async function selectDemandDataDir() {
  const dir = await window.electronAPI.selectDirectory()
  if (dir) settingsStore.setDemandDataDir(dir)
}

async function selectCfacDataDir() {
  const dir = await window.electronAPI.selectDirectory()
  if (dir) settingsStore.setCfacDataDir(dir)
}

async function selectOutputDir() {
  const dir = await window.electronAPI.selectDirectory()
  if (dir) settingsStore.setOutputDir(dir)
}

async function selectWeatherCacheDir() {
  const dir = await window.electronAPI.selectDirectory()
  if (dir) settingsStore.setWeatherCacheDir(dir)
}

async function selectDatabasePath() {
  const file = await window.electronAPI.saveFile({
    defaultPath: 'forecasting.db',
    filters: [{ name: 'SQLite Database', extensions: ['db', 'sqlite'] }]
  })
  if (file) settingsStore.setDatabasePath(file)
}
</script>

<template>
  <div class="settings-view">
    <div class="page-header">
      <h2>Settings</h2>
      <p>Configure data directories and LLM API keys</p>
    </div>

    <!-- Data Directories Card -->
    <div class="card">
      <div class="card-header">
        <h3>Data Directories</h3>
        <p class="card-desc">Configure where your data files are located</p>
      </div>

      <div class="form-group">
        <label>Demand Data Directory</label>
        <div class="path-input">
          <input
            type="text"
            class="form-control"
            :value="settingsStore.demandDataDir"
            @input="settingsStore.setDemandDataDir(($event.target as HTMLInputElement).value)"
            placeholder="e.g., C:\Data\Demand or Data Samples/Demand"
          />
          <button class="btn btn-secondary" @click="selectDemandDataDir">Browse</button>
        </div>
        <div class="form-help">Folder containing historical demand CSV files</div>
      </div>

      <div class="form-group">
        <label>Capacity Factor Data Directory</label>
        <div class="path-input">
          <input
            type="text"
            class="form-control"
            :value="settingsStore.cfacDataDir"
            @input="settingsStore.setCfacDataDir(($event.target as HTMLInputElement).value)"
            placeholder="e.g., C:\Data\CFAC or Data Samples/Capacity Factor"
          />
          <button class="btn btn-secondary" @click="selectCfacDataDir">Browse</button>
        </div>
        <div class="form-help">Folder containing capacity factor CSV files (MRHCFac_*.csv)</div>
      </div>

      <div class="form-group">
        <label>Output Directory</label>
        <div class="path-input">
          <input
            type="text"
            class="form-control"
            :value="settingsStore.outputDir"
            @input="settingsStore.setOutputDir(($event.target as HTMLInputElement).value)"
            placeholder="e.g., C:\Output or ./output"
          />
          <button class="btn btn-secondary" @click="selectOutputDir">Browse</button>
        </div>
        <div class="form-help">Where forecast outputs will be saved</div>
      </div>

      <div class="form-group">
        <label>Weather Cache Directory</label>
        <div class="path-input">
          <input
            type="text"
            class="form-control"
            :value="settingsStore.weatherCacheDir"
            @input="settingsStore.setWeatherCacheDir(($event.target as HTMLInputElement).value)"
            placeholder="e.g., ./weather_cache"
          />
          <button class="btn btn-secondary" @click="selectWeatherCacheDir">Browse</button>
        </div>
        <div class="form-help">Where weather data will be cached (reduces API calls)</div>
      </div>

      <div class="form-group">
        <label>Database Path</label>
        <div class="path-input">
          <input
            type="text"
            class="form-control"
            :value="settingsStore.databasePath"
            @input="settingsStore.setDatabasePath(($event.target as HTMLInputElement).value)"
            placeholder="e.g., ./forecasting.db"
          />
          <button class="btn btn-secondary" @click="selectDatabasePath">Browse</button>
        </div>
        <div class="form-help">SQLite database for storing models and history</div>
      </div>
    </div>

    <!-- LLM Provider Card -->
    <div class="card">
      <div class="card-header">
        <h3>AI Assistant (LLM Provider)</h3>
        <p class="card-desc">Choose your preferred AI provider for the chat assistant</p>
      </div>

      <div class="provider-selector">
        <label class="provider-option" :class="{ active: settingsStore.provider === 'claude' }">
          <input
            type="radio"
            value="claude"
            v-model="settingsStore.provider"
            @change="settingsStore.setProvider('claude')"
          />
          <div class="provider-content">
            <div class="provider-name">Claude (Anthropic)</div>
            <div class="provider-desc">Recommended for best tool-calling performance</div>
          </div>
        </label>

        <label class="provider-option" :class="{ active: settingsStore.provider === 'gemini' }">
          <input
            type="radio"
            value="gemini"
            v-model="settingsStore.provider"
            @change="settingsStore.setProvider('gemini')"
          />
          <div class="provider-content">
            <div class="provider-name">Gemini (Google)</div>
            <div class="provider-desc">Good alternative with multimodal capabilities</div>
          </div>
        </label>
      </div>
    </div>

    <!-- Claude Settings Card -->
    <div class="card">
      <div class="card-header">
        <h3>Claude API Settings</h3>
      </div>

      <div class="form-group">
        <label>API Key</label>
        <div class="api-key-input">
          <input
            :type="showClaudeKey ? 'text' : 'password'"
            class="form-control"
            :value="settingsStore.claudeApiKey"
            @input="settingsStore.setClaudeApiKey(($event.target as HTMLInputElement).value)"
            placeholder="sk-ant-api03-..."
          />
          <button
            class="btn btn-secondary toggle-btn"
            @click="showClaudeKey = !showClaudeKey"
          >
            {{ showClaudeKey ? 'Hide' : 'Show' }}
          </button>
        </div>
        <div class="form-help">
          Get your API key from <a href="https://console.anthropic.com/settings/keys" target="_blank">console.anthropic.com</a>
        </div>
      </div>

      <div class="form-group">
        <label>Model</label>
        <select
          class="form-control"
          :value="settingsStore.claudeModel"
          @change="settingsStore.setClaudeModel(($event.target as HTMLSelectElement).value)"
        >
          <option v-for="model in claudeModels" :key="model.value" :value="model.value">
            {{ model.label }}
          </option>
        </select>
      </div>
    </div>

    <!-- Gemini Settings Card -->
    <div class="card">
      <div class="card-header">
        <h3>Gemini API Settings</h3>
      </div>

      <div class="form-group">
        <label>API Key</label>
        <div class="api-key-input">
          <input
            :type="showGeminiKey ? 'text' : 'password'"
            class="form-control"
            :value="settingsStore.geminiApiKey"
            @input="settingsStore.setGeminiApiKey(($event.target as HTMLInputElement).value)"
            placeholder="AIza..."
          />
          <button
            class="btn btn-secondary toggle-btn"
            @click="showGeminiKey = !showGeminiKey"
          >
            {{ showGeminiKey ? 'Hide' : 'Show' }}
          </button>
        </div>
        <div class="form-help">
          Get your API key from <a href="https://aistudio.google.com/app/apikey" target="_blank">aistudio.google.com</a>
        </div>
      </div>

      <div class="form-group">
        <label>Model</label>
        <select
          class="form-control"
          :value="settingsStore.geminiModel"
          @change="settingsStore.setGeminiModel(($event.target as HTMLSelectElement).value)"
        >
          <option v-for="model in geminiModels" :key="model.value" :value="model.value">
            {{ model.label }}
          </option>
        </select>
      </div>
    </div>

    <div class="actions">
      <button
        class="btn btn-primary"
        @click="saveSettings"
        :disabled="isSaving"
      >
        {{ isSaving ? 'Saving...' : 'Save Settings' }}
      </button>
      <span v-if="saveMessage" :class="['save-message', saveMessage.includes('Error') ? 'error' : 'success']">
        {{ saveMessage }}
      </span>
    </div>
  </div>
</template>

<style scoped>
.settings-view {
  max-width: 800px;
}

.card-desc {
  color: var(--text-muted);
  font-size: 0.875rem;
  margin-top: 4px;
}

.path-input {
  display: flex;
  gap: 8px;
}

.path-input .form-control {
  flex: 1;
  font-family: monospace;
  font-size: 0.85rem;
}

.provider-selector {
  display: flex;
  gap: 16px;
}

.provider-option {
  flex: 1;
  display: flex;
  align-items: flex-start;
  padding: 16px;
  border: 2px solid var(--border-color);
  border-radius: 12px;
  cursor: pointer;
  transition: all 0.2s;
}

.provider-option:hover {
  border-color: var(--primary-color);
  background: #f8fafc;
}

.provider-option.active {
  border-color: var(--primary-color);
  background: #eff6ff;
}

.provider-option input {
  margin-right: 12px;
  margin-top: 4px;
}

.provider-name {
  font-weight: 600;
  margin-bottom: 4px;
}

.provider-desc {
  font-size: 0.875rem;
  color: var(--text-muted);
}

.api-key-input {
  display: flex;
  gap: 8px;
}

.api-key-input .form-control {
  flex: 1;
  font-family: monospace;
}

.toggle-btn {
  flex-shrink: 0;
  min-width: 80px;
}

.form-help {
  margin-top: 6px;
  font-size: 0.8rem;
  color: var(--text-muted);
}

.form-help a {
  color: var(--primary-color);
  text-decoration: none;
}

.form-help a:hover {
  text-decoration: underline;
}

.actions {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-top: 24px;
}

.save-message {
  font-size: 0.875rem;
}

.save-message.success {
  color: var(--success-color);
}

.save-message.error {
  color: var(--danger-color);
}
</style>
