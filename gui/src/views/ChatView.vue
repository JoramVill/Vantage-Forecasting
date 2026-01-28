<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted } from 'vue'
import { useChatStore } from '../stores/chatStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useRouter } from 'vue-router'

const router = useRouter()
const chatStore = useChatStore()
const settingsStore = useSettingsStore()

const inputMessage = ref('')
const messagesContainer = ref<HTMLElement | null>(null)

const canSend = computed(() => {
  return inputMessage.value.trim().length > 0 && !chatStore.isProcessing
})

onMounted(async () => {
  await settingsStore.loadSettings()
})

async function sendMessage() {
  if (!canSend.value) return

  const message = inputMessage.value.trim()
  inputMessage.value = ''

  await chatStore.sendMessage(message)
  scrollToBottom()
}

function handleKeyDown(event: KeyboardEvent) {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    sendMessage()
  }
}

function scrollToBottom() {
  nextTick(() => {
    if (messagesContainer.value) {
      messagesContainer.value.scrollTop = messagesContainer.value.scrollHeight
    }
  })
}

function goToSettings() {
  router.push('/settings')
}

function clearChat() {
  chatStore.clearMessages()
}

function formatMessage(content: string): string {
  // Simple markdown-like formatting
  return content
    // Bold
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    // Inline code
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    // Code blocks
    .replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code class="language-$1">$2</code></pre>')
    // Line breaks
    .replace(/\n/g, '<br>')
}

// Watch for new messages to auto-scroll
watch(
  () => chatStore.messages.length,
  () => scrollToBottom()
)
</script>

<template>
  <div class="chat-view">
    <div class="chat-header">
      <div class="header-left">
        <h2>AI Assistant</h2>
        <span class="provider-badge" v-if="settingsStore.hasValidApiKey">
          {{ settingsStore.provider === 'claude' ? 'Claude' : 'Gemini' }}
        </span>
      </div>
      <div class="header-actions">
        <button class="btn btn-secondary" @click="clearChat" v-if="chatStore.hasMessages">
          Clear Chat
        </button>
        <button class="btn btn-secondary" @click="goToSettings">
          Settings
        </button>
      </div>
    </div>

    <!-- API Key Warning -->
    <div v-if="!settingsStore.hasValidApiKey" class="api-warning card">
      <div class="warning-content">
        <span class="warning-icon">&#9888;</span>
        <div>
          <strong>API Key Required</strong>
          <p>Please configure your API key in Settings to use the AI assistant.</p>
        </div>
        <button class="btn btn-primary" @click="goToSettings">Go to Settings</button>
      </div>
    </div>

    <!-- Chat Messages -->
    <div class="messages-container" ref="messagesContainer" v-else>
      <!-- Welcome Message -->
      <div v-if="!chatStore.hasMessages" class="welcome-message">
        <h3>Welcome to iLoad Forecasting Assistant</h3>
        <p>I can help you with:</p>
        <ul>
          <li><strong>Demand Forecasting</strong> - Generate electricity demand predictions</li>
          <li><strong>Capacity Factor Forecasting</strong> - Predict solar, wind, and hydro output</li>
          <li><strong>Model Training</strong> - Train and evaluate forecasting models</li>
          <li><strong>Station Management</strong> - Check coverage and add new stations</li>
        </ul>
        <div class="example-prompts">
          <p>Try asking:</p>
          <button class="example-btn" @click="inputMessage = 'Run a capacity factor forecast for December 2025'">
            Run a capacity factor forecast for December 2025
          </button>
          <button class="example-btn" @click="inputMessage = 'Check if all renewable stations are in the database'">
            Check if all renewable stations are in the database
          </button>
          <button class="example-btn" @click="inputMessage = 'What commands are available?'">
            What commands are available?
          </button>
        </div>
      </div>

      <!-- Chat Messages -->
      <div
        v-for="message in chatStore.messages"
        :key="message.id"
        :class="['message', message.role]"
      >
        <div class="message-avatar">
          {{ message.role === 'user' ? 'You' : 'AI' }}
        </div>
        <div class="message-content">
          <div class="message-text" v-html="formatMessage(message.content)"></div>

          <!-- Tool Calls -->
          <div v-if="message.toolCalls && message.toolCalls.length > 0" class="tool-calls">
            <div v-for="(tool, idx) in message.toolCalls" :key="idx" class="tool-call">
              <div class="tool-header">
                <span class="tool-icon">&#9881;</span>
                <span class="tool-name">{{ tool.name }}</span>
                <span :class="['tool-status', tool.status]">{{ tool.status }}</span>
              </div>
              <div v-if="tool.output" class="tool-output">
                <pre>{{ tool.output }}</pre>
              </div>
            </div>
          </div>

          <!-- Streaming indicator -->
          <div v-if="message.isStreaming" class="typing-indicator">
            <span></span><span></span><span></span>
          </div>

          <div class="message-time">
            {{ new Date(message.timestamp).toLocaleTimeString() }}
          </div>
        </div>
      </div>

      <!-- Processing indicator -->
      <div v-if="chatStore.isProcessing && !chatStore.messages.some(m => m.isStreaming)" class="message assistant">
        <div class="message-avatar">AI</div>
        <div class="message-content">
          <div class="typing-indicator">
            <span></span><span></span><span></span>
          </div>
        </div>
      </div>
    </div>

    <!-- Error Display -->
    <div v-if="chatStore.error" class="error-banner">
      {{ chatStore.error }}
    </div>

    <!-- Input Area -->
    <div class="input-area" v-if="settingsStore.hasValidApiKey">
      <textarea
        v-model="inputMessage"
        class="message-input"
        placeholder="Ask me anything about forecasting..."
        @keydown="handleKeyDown"
        :disabled="chatStore.isProcessing"
        rows="1"
      ></textarea>
      <button
        class="btn btn-primary send-btn"
        @click="sendMessage"
        :disabled="!canSend"
      >
        {{ chatStore.isProcessing ? 'Thinking...' : 'Send' }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.chat-view {
  display: flex;
  flex-direction: column;
  height: calc(100vh - 48px);
  max-height: calc(100vh - 48px);
}

.chat-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding-bottom: 16px;
  border-bottom: 1px solid var(--border-color);
  margin-bottom: 16px;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 12px;
}

.header-left h2 {
  margin: 0;
}

.provider-badge {
  background: var(--primary-color);
  color: white;
  padding: 4px 12px;
  border-radius: 20px;
  font-size: 0.75rem;
  font-weight: 500;
}

.header-actions {
  display: flex;
  gap: 8px;
}

.api-warning {
  background: #fef3c7;
  border: 1px solid #f59e0b;
}

.warning-content {
  display: flex;
  align-items: center;
  gap: 16px;
}

.warning-icon {
  font-size: 24px;
  color: #f59e0b;
}

.warning-content p {
  margin: 4px 0 0 0;
  color: var(--text-muted);
}

.messages-container {
  flex: 1;
  overflow-y: auto;
  padding: 16px 0;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.welcome-message {
  background: var(--card-bg);
  padding: 32px;
  border-radius: 12px;
  box-shadow: 0 1px 3px rgba(0,0,0,0.1);
}

.welcome-message h3 {
  margin-bottom: 16px;
  color: var(--primary-color);
}

.welcome-message ul {
  margin: 16px 0;
  padding-left: 24px;
}

.welcome-message li {
  margin-bottom: 8px;
}

.example-prompts {
  margin-top: 24px;
  padding-top: 16px;
  border-top: 1px solid var(--border-color);
}

.example-prompts p {
  color: var(--text-muted);
  margin-bottom: 12px;
}

.example-btn {
  display: block;
  width: 100%;
  text-align: left;
  padding: 12px 16px;
  margin-bottom: 8px;
  background: #f8fafc;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.2s;
  font-size: 0.9rem;
}

.example-btn:hover {
  background: #eff6ff;
  border-color: var(--primary-color);
}

.message {
  display: flex;
  gap: 12px;
  max-width: 85%;
}

.message.user {
  align-self: flex-end;
  flex-direction: row-reverse;
}

.message-avatar {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.75rem;
  font-weight: 600;
  flex-shrink: 0;
}

.message.user .message-avatar {
  background: var(--primary-color);
  color: white;
}

.message.assistant .message-avatar {
  background: #e2e8f0;
  color: var(--text-color);
}

.message-content {
  background: var(--card-bg);
  padding: 12px 16px;
  border-radius: 12px;
  box-shadow: 0 1px 3px rgba(0,0,0,0.1);
}

.message.user .message-content {
  background: var(--primary-color);
  color: white;
}

.message-text {
  line-height: 1.6;
}

.message-text :deep(code) {
  background: rgba(0,0,0,0.1);
  padding: 2px 6px;
  border-radius: 4px;
  font-family: 'Consolas', monospace;
  font-size: 0.875em;
}

.message-text :deep(pre) {
  background: #1e293b;
  color: #e2e8f0;
  padding: 12px;
  border-radius: 8px;
  overflow-x: auto;
  margin: 8px 0;
}

.message-text :deep(pre code) {
  background: none;
  padding: 0;
}

.message.user .message-text :deep(code) {
  background: rgba(255,255,255,0.2);
}

.message-time {
  font-size: 0.7rem;
  color: var(--text-muted);
  margin-top: 8px;
}

.message.user .message-time {
  color: rgba(255,255,255,0.7);
}

.tool-calls {
  margin-top: 12px;
  border-top: 1px solid var(--border-color);
  padding-top: 12px;
}

.tool-call {
  background: #f8fafc;
  border-radius: 8px;
  padding: 12px;
  margin-bottom: 8px;
}

.tool-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.tool-icon {
  color: var(--primary-color);
}

.tool-name {
  font-weight: 600;
  font-family: monospace;
}

.tool-status {
  font-size: 0.75rem;
  padding: 2px 8px;
  border-radius: 10px;
}

.tool-status.pending {
  background: #fef3c7;
  color: #92400e;
}

.tool-status.running {
  background: #dbeafe;
  color: #1e40af;
}

.tool-status.completed {
  background: #dcfce7;
  color: #166534;
}

.tool-status.failed {
  background: #fef2f2;
  color: #991b1b;
}

.tool-output {
  margin-top: 8px;
}

.tool-output pre {
  background: #1e293b;
  color: #e2e8f0;
  padding: 12px;
  border-radius: 8px;
  overflow-x: auto;
  font-size: 0.8rem;
  max-height: 200px;
  overflow-y: auto;
  margin: 0;
}

.typing-indicator {
  display: flex;
  gap: 4px;
  padding: 8px 0;
}

.typing-indicator span {
  width: 8px;
  height: 8px;
  background: var(--text-muted);
  border-radius: 50%;
  animation: bounce 1.4s infinite ease-in-out both;
}

.typing-indicator span:nth-child(1) { animation-delay: -0.32s; }
.typing-indicator span:nth-child(2) { animation-delay: -0.16s; }

@keyframes bounce {
  0%, 80%, 100% { transform: scale(0); }
  40% { transform: scale(1); }
}

.error-banner {
  background: #fef2f2;
  color: #991b1b;
  padding: 12px 16px;
  border-radius: 8px;
  margin-bottom: 16px;
}

.input-area {
  display: flex;
  gap: 12px;
  padding-top: 16px;
  border-top: 1px solid var(--border-color);
}

.message-input {
  flex: 1;
  padding: 12px 16px;
  border: 1px solid var(--border-color);
  border-radius: 12px;
  font-size: 0.95rem;
  resize: none;
  min-height: 48px;
  max-height: 150px;
  font-family: inherit;
}

.message-input:focus {
  outline: none;
  border-color: var(--primary-color);
  box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.1);
}

.send-btn {
  height: 48px;
  min-width: 100px;
}
</style>
