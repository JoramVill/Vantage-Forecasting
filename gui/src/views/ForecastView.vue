<script setup lang="ts">
import { ref, computed } from 'vue'
import DropZone from '../components/DropZone.vue'
import ConsoleOutput from '../components/ConsoleOutput.vue'

interface FileInfo {
  path: string
  name: string
  size: number
}

// Data source toggle
const dataSource = ref<'database' | 'csv'>('database')

// CSV mode
const demandFiles = ref<FileInfo[]>([])

// Database mode
const trainStartDate = ref('')
const trainEndDate = ref('')

// Forecast dates
const forecastStartDate = ref('')
const forecastEndDate = ref('')

// Options
const modelType = ref('hybrid')
const scalePercent = ref('0')
const outputFile = ref('')
const isRunning = ref(false)
const consoleLines = ref<{ text: string; type?: 'normal' | 'error' | 'success' }[]>([])

// Set default dates
const today = new Date()

// Training: last 90 days
const trainEnd = new Date(today)
trainEnd.setDate(trainEnd.getDate() - 1)  // Yesterday
const trainStart = new Date(trainEnd)
trainStart.setDate(trainStart.getDate() - 90)  // 90 days before

trainStartDate.value = trainStart.toISOString().split('T')[0]
trainEndDate.value = trainEnd.toISOString().split('T')[0]

// Forecast: next 7 days
const tomorrow = new Date(today)
tomorrow.setDate(tomorrow.getDate() + 1)
const nextWeek = new Date(today)
nextWeek.setDate(nextWeek.getDate() + 7)

forecastStartDate.value = tomorrow.toISOString().split('T')[0]
forecastEndDate.value = nextWeek.toISOString().split('T')[0]

const canRun = computed(() => {
  const hasForecastDates = forecastStartDate.value && forecastEndDate.value
  const hasOutput = outputFile.value
  const hasData = dataSource.value === 'database'
    ? (trainStartDate.value && trainEndDate.value)
    : demandFiles.value.length > 0

  return hasForecastDates && hasOutput && hasData && !isRunning.value
})

function handleDemandFiles(files: FileInfo[]) {
  demandFiles.value = files
}

function removeDemandFile(index: number) {
  demandFiles.value.splice(index, 1)
}

async function selectOutputFile() {
  if (window.electronAPI) {
    const file = await window.electronAPI.saveFile({
      defaultPath: 'DemandHr_FCast.csv',
      filters: [{ name: 'CSV Files', extensions: ['csv'] }]
    })
    if (file) {
      outputFile.value = file
    }
  }
}

async function runForecast() {
  if (!canRun.value) return

  isRunning.value = true
  consoleLines.value = []

  consoleLines.value.push({ text: '> Starting forecast generation...', type: 'normal' })

  const args = [
    'forecast',
    '-s', forecastStartDate.value,
    '-e', forecastEndDate.value,
    '-o', outputFile.value,
    '--model', modelType.value
  ]

  if (dataSource.value === 'database') {
    // Use database with training date range
    args.push('--use-db')
    // Calculate train days from date range
    const start = new Date(trainStartDate.value)
    const end = new Date(trainEndDate.value)
    const days = Math.ceil((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24))
    args.push('--train-days', String(days))
  } else {
    // Use CSV file
    args.push('-d', demandFiles.value[0].path)
  }

  if (parseFloat(scalePercent.value) !== 0) {
    args.push('--scale', scalePercent.value)
  }

  consoleLines.value.push({ text: `> iload ${args.join(' ')}`, type: 'normal' })

  try {
    if (window.electronAPI) {
      const result = await window.electronAPI.runCommand('iload', args)

      const lines = result.stdout.split('\n')
      for (const line of lines) {
        if (line.trim()) {
          const type = line.includes('Error') || line.includes('error') ? 'error'
            : line.includes('MAPE') || line.includes('complete') ? 'success'
            : 'normal'
          consoleLines.value.push({ text: line, type })
        }
      }

      if (result.stderr) {
        consoleLines.value.push({ text: result.stderr, type: 'error' })
      }

      if (result.code === 0) {
        consoleLines.value.push({ text: '\nForecast generated successfully!', type: 'success' })
      } else {
        consoleLines.value.push({ text: `\nForecast failed with code ${result.code}`, type: 'error' })
      }
    } else {
      consoleLines.value.push({ text: 'Electron API not available (running in browser)', type: 'error' })
    }
  } catch (error: any) {
    consoleLines.value.push({ text: `Error: ${error.message}`, type: 'error' })
  }

  isRunning.value = false
}
</script>

<template>
  <div>
    <div class="page-header">
      <h2>Generate Forecast</h2>
      <p>Generate demand forecast with automatic weather data fetching</p>
    </div>

    <!-- Data Source Selection -->
    <div class="card">
      <div class="card-header">
        <h3>Training Data Source</h3>
      </div>

      <div class="source-toggle">
        <button
          :class="['toggle-btn', { active: dataSource === 'database' }]"
          @click="dataSource = 'database'"
        >
          Database
        </button>
        <button
          :class="['toggle-btn', { active: dataSource === 'csv' }]"
          @click="dataSource = 'csv'"
        >
          CSV File
        </button>
      </div>

      <!-- Database Mode -->
      <div v-if="dataSource === 'database'" class="source-content">
        <p class="source-description">
          Use historical demand data from the database. Specify the training date range.
        </p>
        <div class="row">
          <div class="col">
            <div class="form-group">
              <label>Training Start Date</label>
              <input type="date" v-model="trainStartDate" class="form-control" />
            </div>
          </div>
          <div class="col">
            <div class="form-group">
              <label>Training End Date</label>
              <input type="date" v-model="trainEndDate" class="form-control" />
            </div>
          </div>
        </div>
      </div>

      <!-- CSV Mode -->
      <div v-else class="source-content">
        <p class="source-description">
          Upload a CSV file with historical demand data.
        </p>
        <DropZone
          label="Drop Demand CSV File"
          :files="demandFiles"
          @files-dropped="handleDemandFiles"
          @file-removed="removeDemandFile"
        />
      </div>
    </div>

    <div class="card">
      <div class="card-header">
        <h3>Forecast Options</h3>
      </div>

      <div class="row">
        <div class="col">
          <div class="form-group">
            <label>Forecast Start Date</label>
            <input type="date" v-model="forecastStartDate" class="form-control" />
          </div>
        </div>
        <div class="col">
          <div class="form-group">
            <label>Forecast End Date</label>
            <input type="date" v-model="forecastEndDate" class="form-control" />
          </div>
        </div>
      </div>

      <div class="row">
        <div class="col">
          <div class="form-group">
            <label>Model Type</label>
            <select v-model="modelType" class="form-control">
              <option value="hybrid">Hybrid (Recommended)</option>
              <option value="regression">Regression</option>
              <option value="xgboost">XGBoost</option>
            </select>
          </div>
        </div>
        <div class="col">
          <div class="form-group">
            <label>Scale Adjustment (%)</label>
            <input type="number" v-model="scalePercent" class="form-control" placeholder="0" step="0.5" />
            <small style="color: #64748b; font-size: 0.75rem;">
              e.g., 5 for +5%, -3 for -3%
            </small>
          </div>
        </div>
      </div>

      <div class="form-group">
        <label>Output File</label>
        <div style="display: flex; gap: 8px;">
          <input v-model="outputFile" class="form-control" placeholder="Select output file..." readonly />
          <button class="btn btn-secondary" @click="selectOutputFile">Browse</button>
        </div>
      </div>

      <button class="btn btn-primary" :disabled="!canRun" @click="runForecast">
        {{ isRunning ? 'Generating...' : 'Generate Forecast' }}
      </button>
    </div>

    <div class="card">
      <div class="card-header">
        <h3>Output</h3>
      </div>
      <ConsoleOutput :lines="consoleLines" />
    </div>
  </div>
</template>

<style scoped>
.source-toggle {
  display: flex;
  gap: 0;
  margin-bottom: 16px;
  border-radius: 8px;
  overflow: hidden;
  border: 1px solid #334155;
}

.toggle-btn {
  flex: 1;
  padding: 12px 24px;
  border: none;
  background: #1e293b;
  color: #94a3b8;
  cursor: pointer;
  font-size: 0.875rem;
  transition: all 0.2s;
}

.toggle-btn:hover {
  background: #334155;
}

.toggle-btn.active {
  background: #3b82f6;
  color: #fff;
}

.source-content {
  padding-top: 8px;
}

.source-description {
  color: #94a3b8;
  font-size: 0.875rem;
  margin-bottom: 16px;
}
</style>
