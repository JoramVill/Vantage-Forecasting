import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: Date
  toolCalls?: ToolCall[]
  isStreaming?: boolean
}

export interface ToolCall {
  name: string
  input: Record<string, unknown>
  output?: string
  status: 'pending' | 'running' | 'completed' | 'failed'
}

export const useChatStore = defineStore('chat', () => {
  // State
  const messages = ref<ChatMessage[]>([])
  const isProcessing = ref(false)
  const error = ref<string | null>(null)
  const currentStreamingContent = ref('')

  // Computed
  const hasMessages = computed(() => messages.value.length > 0)

  const conversationHistory = computed(() => {
    return messages.value.map(msg => ({
      role: msg.role,
      content: msg.content
    }))
  })

  // Actions
  function addMessage(message: Omit<ChatMessage, 'id' | 'timestamp'>) {
    const newMessage: ChatMessage = {
      ...message,
      id: crypto.randomUUID(),
      timestamp: new Date()
    }
    messages.value.push(newMessage)
    return newMessage.id
  }

  function updateMessage(id: string, updates: Partial<ChatMessage>) {
    const index = messages.value.findIndex(m => m.id === id)
    if (index !== -1) {
      messages.value[index] = { ...messages.value[index], ...updates }
    }
  }

  function appendToMessage(id: string, content: string) {
    const index = messages.value.findIndex(m => m.id === id)
    if (index !== -1) {
      messages.value[index].content += content
    }
  }

  function clearMessages() {
    messages.value = []
    error.value = null
  }

  function setError(errorMessage: string | null) {
    error.value = errorMessage
  }

  function setProcessing(processing: boolean) {
    isProcessing.value = processing
  }

  async function sendMessage(userMessage: string) {
    if (!userMessage.trim() || isProcessing.value) return

    error.value = null

    // Add user message
    addMessage({
      role: 'user',
      content: userMessage.trim()
    })

    // Add placeholder for assistant response
    const assistantMessageId = addMessage({
      role: 'assistant',
      content: '',
      isStreaming: true
    })

    isProcessing.value = true

    try {
      // Get conversation history for context (last 20 messages)
      const history = messages.value
        .slice(-21, -1) // Exclude the empty assistant message we just added
        .map(m => ({ role: m.role, content: m.content }))

      // Call LLM via IPC
      const response = await window.electronAPI.sendChatMessage(userMessage, history)

      if (response.error) {
        throw new Error(response.error)
      }

      // Update assistant message with response
      updateMessage(assistantMessageId, {
        content: response.content,
        toolCalls: response.toolCalls,
        isStreaming: false
      })

    } catch (err: any) {
      error.value = err.message || 'Failed to get response'
      // Remove the empty assistant message
      messages.value = messages.value.filter(m => m.id !== assistantMessageId)
    } finally {
      isProcessing.value = false
    }
  }

  return {
    // State
    messages,
    isProcessing,
    error,
    currentStreamingContent,
    // Computed
    hasMessages,
    conversationHistory,
    // Actions
    addMessage,
    updateMessage,
    appendToMessage,
    clearMessages,
    setError,
    setProcessing,
    sendMessage
  }
})
