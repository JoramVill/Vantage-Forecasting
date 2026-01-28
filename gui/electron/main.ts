import { app, BrowserWindow, ipcMain, dialog } from 'electron'
import { spawn } from 'child_process'
import * as path from 'path'
import * as https from 'https'
import * as fs from 'fs'

// Use dynamic import for electron-store (ES Module)
let Store: any
async function initStore() {
  const module = await import('electron-store')
  Store = module.default
}

let store: any

let mainWindow: BrowserWindow | null = null

// Tool definitions for the LLM
const TOOLS = [
  {
    name: 'run_forecast',
    description: 'Run a demand or capacity factor forecast for a date range. Output is saved to the configured output directory.',
    input_schema: {
      type: 'object',
      properties: {
        forecast_type: {
          type: 'string',
          enum: ['demand', 'cfac'],
          description: 'Type of forecast: "demand" for load demand, "cfac" for capacity factor'
        },
        start_date: {
          type: 'string',
          description: 'Start date in YYYY-MM-DD format'
        },
        end_date: {
          type: 'string',
          description: 'End date in YYYY-MM-DD format'
        }
      },
      required: ['forecast_type', 'start_date', 'end_date']
    }
  },
  {
    name: 'check_capacity_coverage',
    description: 'Check if all renewable stations in CFAC data are in the stations database. Returns coverage report.',
    input_schema: {
      type: 'object',
      properties: {
        station_type: {
          type: 'string',
          description: 'Types to check (comma-separated): solar,wind,hydro. Defaults to all renewable types.'
        }
      }
    }
  },
  {
    name: 'run_cli_command',
    description: 'Run any iLoad CLI command. Use this for commands not covered by other tools.',
    input_schema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The CLI command and arguments (e.g., "train -d data.csv -w weather.csv")'
        }
      },
      required: ['command']
    }
  },
  {
    name: 'list_available_commands',
    description: 'List all available iLoad CLI commands and their descriptions.',
    input_schema: {
      type: 'object',
      properties: {}
    }
  }
]

// System prompt for the LLM
const SYSTEM_PROMPT = `You are an AI assistant for the iLoad Forecasting Utility, a tool for electricity demand and capacity factor forecasting for the Philippines power grid.

## Your Capabilities
You can help users with:
1. **Demand Forecasting**: Predict electricity demand using historical data and weather
2. **Capacity Factor Forecasting**: Predict output of renewable energy stations (solar, wind, hydro)
3. **Model Training**: Train XGBoost and regression models on historical data
4. **Evaluation**: Compare forecasts against actual values
5. **Scheduling**: Set up automated forecast generation
6. **Capacity Management**: Check for new stations, manage the station database

## Available Tools
You have access to tools that can run forecasting commands. Use them when the user wants to:
- Generate a forecast
- Train a model
- Evaluate forecast accuracy
- Check station coverage
- Run any CLI command

## Key Concepts
- **CFAC**: Capacity Factor - the ratio of actual output to maximum capacity (0 to 1)
- **MAPE**: Mean Absolute Percentage Error - lower is better
- **Regions**: CLUZ (Luzon), CVIS (Visayas), CMIN (Mindanao)
- **Station Types**: Solar (_S suffix), Wind (no suffix or specific names like BURGOS), Hydro (_H suffix)

## Best Practices
- The cfac forecast2 command uses optimal model selection per station type
- Solar forecasts benefit from --use-xgboost --asymmetric-loss flags
- Wind uses 4-tier MREC model by default
- Always specify date ranges in YYYY-MM-DD format

Be helpful, concise, and proactive in suggesting commands. When users describe what they want, offer to run the appropriate command.`

async function createWindow() {
  await initStore()
  store = new Store({
    encryptionKey: 'iload-forecasting-key-2024'
  })

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    icon: path.join(__dirname, '../public/icon.png')
  })

  // In development, load from Vite dev server
  if (process.env.NODE_ENV === 'development') {
    const devPort = process.env.VITE_PORT || '5173'
    mainWindow.loadURL(`http://localhost:${devPort}`)
    mainWindow.webContents.openDevTools()
  } else {
    // In production, load the built files
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

app.whenReady().then(createWindow)

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow()
  }
})

// IPC Handlers

// Run CLI command
ipcMain.handle('run-command', async (_event, command: string, args: string[]) => {
  return new Promise((resolve) => {
    // Get the path to the CLI
    const cliPath = path.join(app.getAppPath(), '..', 'dist', 'index.js')
    const nodeArgs = [cliPath, ...args]

    const child = spawn('node', nodeArgs, {
      cwd: path.join(app.getAppPath(), '..'),
      shell: false,
      windowsHide: true
    })

    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (data) => {
      stdout += data.toString()
    })

    child.stderr.on('data', (data) => {
      stderr += data.toString()
    })

    child.on('close', (code) => {
      resolve({ stdout, stderr, code: code ?? 0 })
    })

    child.on('error', (error) => {
      resolve({ stdout, stderr: error.message, code: 1 })
    })
  })
})

// Select file
ipcMain.handle('select-file', async (_event, options?: { filters?: { name: string; extensions: string[] }[] }) => {
  const result = await dialog.showOpenDialog(mainWindow!, {
    properties: ['openFile'],
    filters: options?.filters || [{ name: 'All Files', extensions: ['*'] }]
  })
  return result.canceled ? null : result.filePaths[0]
})

// Select directory
ipcMain.handle('select-directory', async () => {
  const result = await dialog.showOpenDialog(mainWindow!, {
    properties: ['openDirectory']
  })
  return result.canceled ? null : result.filePaths[0]
})

// Save file dialog
ipcMain.handle('save-file', async (_event, options?: { defaultPath?: string; filters?: { name: string; extensions: string[] }[] }) => {
  const result = await dialog.showSaveDialog(mainWindow!, {
    defaultPath: options?.defaultPath,
    filters: options?.filters || [{ name: 'All Files', extensions: ['*'] }]
  })
  return result.canceled ? null : result.filePath
})

// Get app path
ipcMain.handle('get-app-path', () => {
  return app.getAppPath()
})

// Settings management
ipcMain.handle('load-settings', () => {
  return {
    // LLM settings
    provider: store.get('provider', 'claude'),
    claudeApiKey: store.get('claudeApiKey', ''),
    geminiApiKey: store.get('geminiApiKey', ''),
    claudeModel: store.get('claudeModel', 'claude-sonnet-4-20250514'),
    geminiModel: store.get('geminiModel', 'gemini-2.0-flash'),
    // Directory settings
    demandDataDir: store.get('demandDataDir', ''),
    cfacDataDir: store.get('cfacDataDir', ''),
    outputDir: store.get('outputDir', ''),
    weatherCacheDir: store.get('weatherCacheDir', ''),
    databasePath: store.get('databasePath', '')
  }
})

ipcMain.handle('save-settings', (_event, settings: any) => {
  // LLM settings
  store.set('provider', settings.provider)
  store.set('claudeApiKey', settings.claudeApiKey)
  store.set('geminiApiKey', settings.geminiApiKey)
  store.set('claudeModel', settings.claudeModel)
  store.set('geminiModel', settings.geminiModel)
  // Directory settings
  store.set('demandDataDir', settings.demandDataDir)
  store.set('cfacDataDir', settings.cfacDataDir)
  store.set('outputDir', settings.outputDir)
  store.set('weatherCacheDir', settings.weatherCacheDir)
  store.set('databasePath', settings.databasePath)
  return true
})

// Helper to get configured paths with fallbacks
function getConfiguredPaths() {
  return {
    demandDataDir: store.get('demandDataDir', '') || 'Data Samples/Demand',
    cfacDataDir: store.get('cfacDataDir', '') || 'Data Samples/Capacity Factor',
    outputDir: store.get('outputDir', '') || 'output',
    weatherCacheDir: store.get('weatherCacheDir', '') || './weather_cache',
    databasePath: store.get('databasePath', '') || './forecasting.db'
  }
}

// Execute a tool
async function executeTool(toolName: string, toolInput: any): Promise<string> {
  const cliPath = path.join(app.getAppPath(), '..', 'dist', 'index.js')
  const cwd = path.join(app.getAppPath(), '..')
  const paths = getConfiguredPaths()

  // Check if directories are configured
  const checkPaths = () => {
    const missing: string[] = []
    if (!paths.demandDataDir || paths.demandDataDir === 'Data Samples/Demand') {
      // Check if default path exists
      if (!fs.existsSync(path.join(cwd, 'Data Samples/Demand'))) {
        missing.push('Demand Data Directory')
      }
    }
    if (!paths.cfacDataDir || paths.cfacDataDir === 'Data Samples/Capacity Factor') {
      if (!fs.existsSync(path.join(cwd, 'Data Samples/Capacity Factor'))) {
        missing.push('Capacity Factor Data Directory')
      }
    }
    return missing
  }

  return new Promise((resolve) => {
    let args: string[] = []

    switch (toolName) {
      case 'run_forecast':
        // Check if required directories exist
        const missingPaths = checkPaths()
        if (missingPaths.length > 0) {
          resolve(`Error: Please configure the following in Settings:\n- ${missingPaths.join('\n- ')}\n\nGo to Settings to set up your data directories.`)
          return
        }

        if (toolInput.forecast_type === 'demand') {
          // Always use configured output dir to avoid path issues
          // Normalize path to handle any encoding/slash issues
          const outputDir = path.normalize(paths.outputDir)
          const outputPath = path.join(outputDir, `demand_${toolInput.start_date}_${toolInput.end_date}.csv`)
          args = [
            'forecast',
            '-d', paths.demandDataDir,
            '-s', toolInput.start_date,
            '-e', toolInput.end_date,
            '-o', outputPath,
            '--model', 'hybrid'
          ]
          if (paths.weatherCacheDir) {
            args.push('--cache', paths.weatherCacheDir)
          }
        } else {
          // Always use configured output dir to avoid path issues
          // Normalize path to handle any encoding/slash issues
          const outputDir = path.normalize(paths.outputDir)
          const outputPath = path.join(outputDir, `cfac_${toolInput.start_date}_${toolInput.end_date}.csv`)
          args = [
            'cfac', 'forecast2',
            '-t', paths.cfacDataDir,
            '-s', toolInput.start_date,
            '-e', toolInput.end_date,
            '-o', outputPath,
            '--use-xgboost',
            '--asymmetric-loss'
          ]
          if (paths.weatherCacheDir) {
            args.push('--cache', paths.weatherCacheDir)
          }
        }
        break

      case 'check_capacity_coverage':
        args = [
          'capacity', 'cfac-check',
          '-t', paths.cfacDataDir
        ]
        if (toolInput.station_type) {
          args.push('--type', toolInput.station_type)
        }
        break

      case 'run_cli_command':
        args = toolInput.command.split(/\s+/)
        break

      case 'list_available_commands':
        args = ['--help']
        break

      default:
        resolve(`Unknown tool: ${toolName}`)
        return
    }

    // Don't use shell: true as it causes paths with spaces to be split incorrectly
    // Instead, pass arguments as an array which Node.js handles correctly
    const child = spawn('node', [cliPath, ...args], {
      cwd,
      shell: false,
      windowsHide: true
    })
    let output = ''

    child.stdout.on('data', (data) => { output += data.toString() })
    child.stderr.on('data', (data) => { output += data.toString() })

    child.on('close', (code) => {
      resolve(output || `Command completed with code ${code}`)
    })

    child.on('error', (error) => {
      resolve(`Error: ${error.message}`)
    })
  })
}

// Make HTTPS request helper
function httpsRequest(options: https.RequestOptions, body?: string): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => resolve({ statusCode: res.statusCode || 0, body: data }))
    })
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

// Send message to Claude API
async function sendToClaude(
  apiKey: string,
  model: string,
  userMessage: string,
  history: Array<{ role: string; content: string }>
): Promise<{ content: string; toolCalls?: any[]; error?: string }> {
  try {
    const messages = [
      ...history.map(m => ({ role: m.role, content: m.content })),
      { role: 'user', content: userMessage }
    ]

    const requestBody = JSON.stringify({
      model: model,
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      messages: messages
    })

    const response = await httpsRequest({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      }
    }, requestBody)

    if (response.statusCode !== 200) {
      const errorData = JSON.parse(response.body)
      return { content: '', error: errorData.error?.message || `API error: ${response.statusCode}` }
    }

    const data = JSON.parse(response.body)
    let textContent = ''
    const toolCalls: any[] = []

    // Process response content blocks
    for (const block of data.content || []) {
      if (block.type === 'text') {
        textContent += block.text
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          name: block.name,
          input: block.input,
          status: 'pending'
        })
      }
    }

    // Execute tool calls if any
    if (toolCalls.length > 0) {
      let toolResults = ''
      for (const tool of toolCalls) {
        tool.status = 'running'
        const result = await executeTool(tool.name, tool.input)
        tool.output = result
        tool.status = 'completed'
        toolResults += `\n\n**Tool: ${tool.name}**\n\`\`\`\n${result}\n\`\`\``
      }

      // Get follow-up response from Claude with tool results
      const toolResultMessages = [
        ...messages,
        { role: 'assistant', content: data.content },
        {
          role: 'user',
          content: toolCalls.map(t => ({
            type: 'tool_result',
            tool_use_id: data.content.find((c: any) => c.type === 'tool_use' && c.name === t.name)?.id,
            content: t.output
          }))
        }
      ]

      const followUpBody = JSON.stringify({
        model: model,
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        messages: toolResultMessages
      })

      const followUpResponse = await httpsRequest({
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01'
        }
      }, followUpBody)

      if (followUpResponse.statusCode === 200) {
        const followUpData = JSON.parse(followUpResponse.body)
        for (const block of followUpData.content || []) {
          if (block.type === 'text') {
            textContent = block.text
          }
        }
      }
    }

    return { content: textContent, toolCalls: toolCalls.length > 0 ? toolCalls : undefined }

  } catch (error: any) {
    return { content: '', error: error.message }
  }
}

// Send message to Gemini API
async function sendToGemini(
  apiKey: string,
  model: string,
  userMessage: string,
  history: Array<{ role: string; content: string }>
): Promise<{ content: string; toolCalls?: any[]; error?: string }> {
  try {
    // Convert history to Gemini format
    const contents = history.map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }]
    }))

    // Add current message
    contents.push({
      role: 'user',
      parts: [{ text: userMessage }]
    })

    // Convert tools to Gemini format
    const geminiTools = [{
      function_declarations: TOOLS.map(t => ({
        name: t.name,
        description: t.description,
        parameters: t.input_schema
      }))
    }]

    const requestBody = JSON.stringify({
      contents: contents,
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      tools: geminiTools,
      generationConfig: {
        maxOutputTokens: 4096,
        temperature: 0.7
      }
    })

    const response = await httpsRequest({
      hostname: 'generativelanguage.googleapis.com',
      path: `/v1beta/models/${model}:generateContent?key=${apiKey}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      }
    }, requestBody)

    if (response.statusCode !== 200) {
      const errorData = JSON.parse(response.body)
      return { content: '', error: errorData.error?.message || `API error: ${response.statusCode}` }
    }

    const data = JSON.parse(response.body)
    const candidate = data.candidates?.[0]
    if (!candidate) {
      return { content: '', error: 'No response from Gemini' }
    }

    let textContent = ''
    const toolCalls: any[] = []

    for (const part of candidate.content?.parts || []) {
      if (part.text) {
        textContent += part.text
      } else if (part.functionCall) {
        toolCalls.push({
          name: part.functionCall.name,
          input: part.functionCall.args,
          status: 'pending'
        })
      }
    }

    // Execute tool calls if any
    if (toolCalls.length > 0) {
      const functionResponses = []
      for (const tool of toolCalls) {
        tool.status = 'running'
        const result = await executeTool(tool.name, tool.input)
        tool.output = result
        tool.status = 'completed'
        functionResponses.push({
          name: tool.name,
          response: { result: result }
        })
      }

      // Get follow-up response with function results
      const followUpContents = [
        ...contents,
        candidate.content,
        {
          role: 'user',
          parts: functionResponses.map(fr => ({
            functionResponse: fr
          }))
        }
      ]

      const followUpBody = JSON.stringify({
        contents: followUpContents,
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        generationConfig: {
          maxOutputTokens: 4096,
          temperature: 0.7
        }
      })

      const followUpResponse = await httpsRequest({
        hostname: 'generativelanguage.googleapis.com',
        path: `/v1beta/models/${model}:generateContent?key=${apiKey}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        }
      }, followUpBody)

      if (followUpResponse.statusCode === 200) {
        const followUpData = JSON.parse(followUpResponse.body)
        const followUpCandidate = followUpData.candidates?.[0]
        if (followUpCandidate) {
          textContent = ''
          for (const part of followUpCandidate.content?.parts || []) {
            if (part.text) {
              textContent += part.text
            }
          }
        }
      }
    }

    return { content: textContent, toolCalls: toolCalls.length > 0 ? toolCalls : undefined }

  } catch (error: any) {
    return { content: '', error: error.message }
  }
}

// Chat message handler
ipcMain.handle('send-chat-message', async (_event, message: string, history: Array<{ role: string; content: string }>) => {
  const provider = store.get('provider', 'claude')
  const apiKey = provider === 'claude' ? store.get('claudeApiKey', '') : store.get('geminiApiKey', '')
  const model = provider === 'claude' ? store.get('claudeModel', 'claude-sonnet-4-20250514') : store.get('geminiModel', 'gemini-2.0-flash')

  if (!apiKey) {
    return { content: '', error: 'No API key configured. Please go to Settings to add your API key.' }
  }

  if (provider === 'claude') {
    return await sendToClaude(apiKey, model, message, history)
  } else {
    return await sendToGemini(apiKey, model, message, history)
  }
})
