<script setup lang="ts">
import { ref, onMounted } from 'vue'
import ConsoleOutput from '../components/ConsoleOutput.vue'

const activeTab = ref<'run' | 'backfill' | 'status'>('run')

// Run tab
const runDate = ref('')
const runDemandOnly = ref(true)
const runDailyOnly = ref(false)
const runWeeklyOnly = ref(false)

// Backfill tab
const backfillStart = ref('')
const backfillEnd = ref('')
const backfillDailyOnly = ref(true)
const backfillDemandOnly = ref(true)

// Data source toggle
const dataSource = ref<'database' | 'csv'>('database')

// Shared settings
const demandPath = ref('Data Samples/Demand')
const cfacPath = ref('Data Samples/Capacity Factor')
const outputDir = ref('./output')
const dbPath = ref('./forecast.db')

// Status
const totalRuns = ref(0)
const evaluatedRuns = ref(0)
const avgMape = ref(0)

const isRunning = ref(false)
const consoleLines = ref<{ text: string; type?: 'normal' | 'error' | 'success' }[]>([])

// Set default dates
const today = new Date()
runDate.value = today.toISOString().split('T')[0]

const lastWeek = new Date(today)
lastWeek.setDate(lastWeek.getDate() - 7)
backfillStart.value = lastWeek.toISOString().split('T')[0]
backfillEnd.value = today.toISOString().split('T')[0]

async function selectDemandPath() {
  if (window.electronAPI) {
    const folder = await window.electronAPI.selectDirectory()
    if (folder) demandPath.value = folder
  }
}

async function selectCfacPath() {
  if (window.electronAPI) {
    const folder = await window.electronAPI.selectDirectory()
    if (folder) cfacPath.value = folder
  }
}

async function selectOutputDir() {
  if (window.electronAPI) {
    const folder = await window.electronAPI.selectDirectory()
    if (folder) outputDir.value = folder
  }
}

async function runScheduler() {
  if (isRunning.value) return

  isRunning.value = true
  consoleLines.value = []

  const args = ['scheduler', 'run', '-d', runDate.value]

  if (runDemandOnly.value) args.push('--demand-only')
  if (runDailyOnly.value) args.push('--daily')
  if (runWeeklyOnly.value) args.push('--weekly')

  if (dataSource.value === 'database') {
    args.push('--use-db')
  } else {
    args.push('--demand-path', demandPath.value)
    args.push('--cfac-path', cfacPath.value)
  }
  args.push('--output', outputDir.value)
  args.push('--db', dbPath.value)

  consoleLines.value.push({ text: `> iload ${args.join(' ')}`, type: 'normal' })

  try {
    if (window.electronAPI) {
      const result = await window.electronAPI.runCommand('iload', args)
      handleCommandResult(result)
    } else {
      consoleLines.value.push({ text: 'Electron API not available', type: 'error' })
    }
  } catch (error: any) {
    consoleLines.value.push({ text: `Error: ${error.message}`, type: 'error' })
  }

  isRunning.value = false
  loadStatus()
}

async function runBackfill() {
  if (isRunning.value) return

  isRunning.value = true
  consoleLines.value = []

  const args = ['scheduler', 'backfill', '-s', backfillStart.value, '-e', backfillEnd.value]

  if (backfillDemandOnly.value) args.push('--demand-only')
  if (backfillDailyOnly.value) args.push('--daily')

  if (dataSource.value === 'database') {
    args.push('--use-db')
  } else {
    args.push('--demand-path', demandPath.value)
    args.push('--cfac-path', cfacPath.value)
  }
  args.push('--output', outputDir.value)
  args.push('--db', dbPath.value)

  consoleLines.value.push({ text: `> iload ${args.join(' ')}`, type: 'normal' })

  try {
    if (window.electronAPI) {
      const result = await window.electronAPI.runCommand('iload', args)
      handleCommandResult(result)
    } else {
      consoleLines.value.push({ text: 'Electron API not available', type: 'error' })
    }
  } catch (error: any) {
    consoleLines.value.push({ text: `Error: ${error.message}`, type: 'error' })
  }

  isRunning.value = false
  loadStatus()
}

async function runEvaluate() {
  if (isRunning.value) return

  isRunning.value = true
  consoleLines.value = []

  const args = ['scheduler', 'evaluate', '--db', dbPath.value, '--demand-path', demandPath.value]

  consoleLines.value.push({ text: `> iload ${args.join(' ')}`, type: 'normal' })

  try {
    if (window.electronAPI) {
      const result = await window.electronAPI.runCommand('iload', args)
      handleCommandResult(result)
    } else {
      consoleLines.value.push({ text: 'Electron API not available', type: 'error' })
    }
  } catch (error: any) {
    consoleLines.value.push({ text: `Error: ${error.message}`, type: 'error' })
  }

  isRunning.value = false
  loadStatus()
}

function handleCommandResult(result: { stdout: string; stderr: string; code: number }) {
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
    consoleLines.value.push({ text: '\nCompleted successfully!', type: 'success' })
  } else {
    consoleLines.value.push({ text: `\nFailed with code ${result.code}`, type: 'error' })
  }
}

async function loadStatus() {
  try {
    if (window.electronAPI) {
      const result = await window.electronAPI.runCommand('iload', ['scheduler', 'status', '--db', dbPath.value])

      // Parse summary from output
      const match = result.stdout.match(/Total runs:\s+(\d+)/)
      if (match) totalRuns.value = parseInt(match[1])

      const evalMatch = result.stdout.match(/Evaluated:\s+(\d+)/)
      if (evalMatch) evaluatedRuns.value = parseInt(evalMatch[1])

      const mapeMatch = result.stdout.match(/Avg MAPE:\s+([\d.]+)/)
      if (mapeMatch) avgMape.value = parseFloat(mapeMatch[1])
    }
  } catch (error) {
    console.error('Failed to load status:', error)
  }
}

onMounted(() => {
  loadStatus()
})
</script>

<template>
  <div>
    <div class="page-header">
      <h2>Forecast Scheduler</h2>
      <p>Generate daily and weekly forecasts automatically with evaluation</p>
    </div>

    <!-- Settings Card -->
    <div class="card">
      <div class="card-header">
        <h3>Data Source & Output</h3>
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
          CSV Files
        </button>
      </div>

      <p v-if="dataSource === 'database'" class="source-description">
        Training data will be loaded from the database automatically.
      </p>

      <div v-else class="row">
        <div class="col">
          <div class="form-group">
            <label>Demand Data Path</label>
            <div style="display: flex; gap: 8px;">
              <input v-model="demandPath" class="form-control" placeholder="Path to demand data..." />
              <button class="btn btn-secondary" @click="selectDemandPath">Browse</button>
            </div>
          </div>
        </div>
        <div class="col">
          <div class="form-group">
            <label>Capacity Factor Data Path</label>
            <div style="display: flex; gap: 8px;">
              <input v-model="cfacPath" class="form-control" placeholder="Path to cfac data..." />
              <button class="btn btn-secondary" @click="selectCfacPath">Browse</button>
            </div>
          </div>
        </div>
      </div>

      <div class="row">
        <div class="col">
          <div class="form-group">
            <label>Output Directory</label>
            <div style="display: flex; gap: 8px;">
              <input v-model="outputDir" class="form-control" placeholder="Output directory..." />
              <button class="btn btn-secondary" @click="selectOutputDir">Browse</button>
            </div>
          </div>
        </div>
        <div class="col">
          <div class="form-group">
            <label>Database Path</label>
            <input v-model="dbPath" class="form-control" placeholder="forecast.db" />
          </div>
        </div>
      </div>
    </div>

    <!-- Status Summary -->
    <div class="card">
      <div class="card-header">
        <h3>Status Summary</h3>
      </div>
      <div class="stats-row">
        <div class="stat-box">
          <div class="stat-value">{{ totalRuns }}</div>
          <div class="stat-label">Total Runs</div>
        </div>
        <div class="stat-box">
          <div class="stat-value">{{ evaluatedRuns }}</div>
          <div class="stat-label">Evaluated</div>
        </div>
        <div class="stat-box">
          <div class="stat-value">{{ avgMape.toFixed(1) }}%</div>
          <div class="stat-label">Avg MAPE</div>
        </div>
      </div>
    </div>

    <!-- Tabs -->
    <div class="tabs">
      <button
        :class="['tab', { active: activeTab === 'run' }]"
        @click="activeTab = 'run'"
      >
        Run Forecast
      </button>
      <button
        :class="['tab', { active: activeTab === 'backfill' }]"
        @click="activeTab = 'backfill'"
      >
        Backfill
      </button>
    </div>

    <!-- Run Tab -->
    <div class="card" v-if="activeTab === 'run'">
      <div class="card-header">
        <h3>Run Daily/Weekly Forecast</h3>
      </div>

      <div class="row">
        <div class="col">
          <div class="form-group">
            <label>As-of Date</label>
            <input type="date" v-model="runDate" class="form-control" />
            <small style="color: #64748b; font-size: 0.75rem;">
              Forecast will be generated for the day(s) after this date
            </small>
          </div>
        </div>
      </div>

      <div class="checkbox-group">
        <label class="checkbox-label">
          <input type="checkbox" v-model="runDemandOnly" />
          Demand Only
        </label>
        <label class="checkbox-label">
          <input type="checkbox" v-model="runDailyOnly" />
          Daily Only
        </label>
        <label class="checkbox-label">
          <input type="checkbox" v-model="runWeeklyOnly" />
          Weekly Only
        </label>
      </div>

      <div class="button-row">
        <button class="btn btn-primary" :disabled="isRunning" @click="runScheduler">
          {{ isRunning ? 'Running...' : 'Run Forecast' }}
        </button>
        <button class="btn btn-secondary" :disabled="isRunning" @click="runEvaluate">
          Evaluate Pending
        </button>
      </div>
    </div>

    <!-- Backfill Tab -->
    <div class="card" v-if="activeTab === 'backfill'">
      <div class="card-header">
        <h3>Backfill Date Range</h3>
      </div>

      <div class="row">
        <div class="col">
          <div class="form-group">
            <label>Start Date</label>
            <input type="date" v-model="backfillStart" class="form-control" />
          </div>
        </div>
        <div class="col">
          <div class="form-group">
            <label>End Date</label>
            <input type="date" v-model="backfillEnd" class="form-control" />
          </div>
        </div>
      </div>

      <div class="checkbox-group">
        <label class="checkbox-label">
          <input type="checkbox" v-model="backfillDemandOnly" />
          Demand Only
        </label>
        <label class="checkbox-label">
          <input type="checkbox" v-model="backfillDailyOnly" />
          Daily Only
        </label>
      </div>

      <button class="btn btn-primary" :disabled="isRunning" @click="runBackfill">
        {{ isRunning ? 'Running...' : 'Run Backfill' }}
      </button>
    </div>

    <!-- Console Output -->
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

.source-description {
  color: #94a3b8;
  font-size: 0.875rem;
  margin-bottom: 16px;
}

.tabs {
  display: flex;
  gap: 0;
  margin-bottom: 0;
}

.tab {
  padding: 12px 24px;
  border: 1px solid #334155;
  border-bottom: none;
  background: #1e293b;
  color: #94a3b8;
  cursor: pointer;
  border-radius: 8px 8px 0 0;
  font-size: 0.875rem;
  transition: all 0.2s;
}

.tab:hover {
  background: #334155;
}

.tab.active {
  background: #0f172a;
  color: #f8fafc;
  border-bottom-color: #0f172a;
}

.stats-row {
  display: flex;
  gap: 24px;
  justify-content: center;
}

.stat-box {
  text-align: center;
  padding: 16px 32px;
  background: #1e293b;
  border-radius: 8px;
  min-width: 120px;
}

.stat-value {
  font-size: 2rem;
  font-weight: 600;
  color: #38bdf8;
}

.stat-label {
  font-size: 0.875rem;
  color: #94a3b8;
  margin-top: 4px;
}

.checkbox-group {
  display: flex;
  gap: 24px;
  margin-bottom: 16px;
}

.checkbox-label {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  color: #e2e8f0;
}

.checkbox-label input[type="checkbox"] {
  width: 18px;
  height: 18px;
  cursor: pointer;
}

.button-row {
  display: flex;
  gap: 12px;
}
</style>
