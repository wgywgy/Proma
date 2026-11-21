import type { SDKAssistantMessage, SDKContentBlock, SDKMessage } from '@proma/shared'

export interface TranscriptHistory {
  messages: SDKMessage[]
  uuidIndexes: Map<string, number>
  notificationIndexes: number[]
}

export interface StableMessagePrefix {
  source: SDKMessage[]
  length: number
}

function hasUuid(message: SDKMessage): boolean {
  const uuid = (message as Record<string, unknown>).uuid
  return typeof uuid === 'string' && uuid.length > 0
}

function stampStableKey(message: SDKMessage, getKey: (message: SDKMessage) => string): string {
  const key = getKey(message)
  const record = message as Record<string, unknown>
  // 已标记且未变化时不重写：对老世代消息对象的属性写入会触发 GC 写屏障，
  // 在数百条历史 × 高频 partial 下形成持续开销。
  if (record._promaStableKey !== key) record._promaStableKey = key
  return key
}

function isTaskNotification(message: SDKMessage): boolean {
  return message.type === 'system' && message.subtype === 'task_notification'
}

/** 持久化数组变化时才去重和建索引，token 更新不重新访问历史消息。 */
export function prepareTranscriptHistory(messages: SDKMessage[], getKey: (message: SDKMessage) => string): TranscriptHistory {
  const result: SDKMessage[] = []
  const uuidIndexes = new Map<string, number>()
  for (const message of messages) {
    const key = stampStableKey(message, getKey)
    const index = hasUuid(message) ? uuidIndexes.get(key) : undefined
    if (index != null) {
      result[index] = message
    } else {
      if (hasUuid(message)) uuidIndexes.set(key, result.length)
      result.push(message)
    }
  }
  const notificationIndexes: number[] = []
  result.forEach((message, index) => {
    if (isTaskNotification(message)) notificationIndexes.push(index)
  })
  return { messages: result, uuidIndexes, notificationIndexes }
}

export function mergeTranscriptMessages(history: TranscriptHistory, live: SDKMessage[], getKey: (message: SDKMessage) => string): {
  messages: SDKMessage[]
  notifications: SDKMessage[]
  stablePrefix: StableMessagePrefix
} {
  const messages = history.messages.slice()
  const liveIndexes = new Map<string, number>()
  const notificationIndexes = new Set(history.notificationIndexes)
  let unchangedLength = history.messages.length
  for (const message of live) {
    const key = stampStableKey(message, getKey)
    const index = hasUuid(message) ? history.uuidIndexes.get(key) ?? liveIndexes.get(key) : undefined
    if (index != null) {
      if (messages[index] !== message) unchangedLength = Math.min(unchangedLength, index)
      messages[index] = message
      if (isTaskNotification(message)) notificationIndexes.add(index)
      else notificationIndexes.delete(index)
    } else {
      if (hasUuid(message)) liveIndexes.set(key, messages.length)
      if (isTaskNotification(message)) notificationIndexes.add(messages.length)
      messages.push(message)
    }
  }
  return {
    messages,
    notifications: [...notificationIndexes].sort((a, b) => a - b).map((index) => messages[index]!),
    stablePrefix: { source: history.messages, length: unchangedLength },
  }
}

interface ToolProjectionEntry {
  source: SDKMessage
  blocks: SDKContentBlock[]
  projected: SDKMessage
}

/** 只投影工具块：正文和思考增量不会让任务聚合缓存失效。 */
export function createToolMessageProjection() {
  let entries: ToolProjectionEntry[] = []
  let projected: SDKMessage[] = []
  return (messages: SDKMessage[]): SDKMessage[] => {
    let changed = messages.length !== entries.length
    const nextEntries = messages.map((message, index): ToolProjectionEntry => {
      const previous = entries[index]
      if (previous?.source === message) return previous
      if (message.type !== 'assistant') {
        changed = true
        return { source: message, blocks: [], projected: message }
      }
      const assistantMessage = message as SDKAssistantMessage
      const blocks = assistantMessage.message.content.filter((block) => block.type === 'tool_use')
      const previousAssistant = previous?.source.type === 'assistant' ? previous.source as SDKAssistantMessage : undefined
      const previousRecord = previousAssistant as unknown as Record<string, unknown> | undefined
      const record = message as unknown as Record<string, unknown>
      const sameMetadata = previousAssistant
        && previousAssistant.uuid === assistantMessage.uuid
        && previousAssistant.session_id === assistantMessage.session_id
        && previousAssistant.parent_tool_use_id === assistantMessage.parent_tool_use_id
        && previousAssistant.isReplay === assistantMessage.isReplay
        && previousAssistant._channelModelId === assistantMessage._channelModelId
        && previousAssistant.message.model === assistantMessage.message.model
        && previousRecord?._createdAt === record._createdAt
        && previousRecord?._promaLiveRunStartedAt === record._promaLiveRunStartedAt
        && previousRecord?._promaLiveRunGeneration === record._promaLiveRunGeneration
      if (
        previous && sameMetadata
        && previous.blocks.length === blocks.length
        && previous.blocks.every((block, i) => block === blocks[i])
      ) return { ...previous, source: message }
      changed = true
      const assistant: SDKAssistantMessage = { ...assistantMessage, message: { ...assistantMessage.message, content: blocks } }
      return { source: message, blocks, projected: assistant }
    })
    entries = nextEntries
    if (changed) projected = nextEntries.map((entry) => entry.projected)
    return projected
  }
}
