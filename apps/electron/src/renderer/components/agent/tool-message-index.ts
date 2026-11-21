import type { SDKContentBlock, SDKMessage, SDKSystemMessage, SDKToolResultBlock, SDKToolUseBlock, SDKUserMessage } from '@proma/shared'

export interface ToolResultData {
  result?: string
  isError?: boolean
}

export interface SubAgentMeta {
  durationMs: number
  totalTokens: number
  toolUses: number
}

export interface ToolMessageIndex {
  results: Map<string, ToolResultData>
  subAgents: Map<string, SubAgentMeta | null>
}

const arrayIndexes = new WeakMap<SDKMessage[], ToolMessageIndex>()
const messageResults = new WeakMap<SDKMessage, Map<string, ToolResultData>>()
const messageMetadata = new WeakMap<SDKMessage, SubAgentMeta | null>()

function readResults(message: SDKUserMessage): Map<string, ToolResultData> {
  const cached = messageResults.get(message)
  if (cached) return cached
  const results = new Map<string, ToolResultData>()
  const blocks = message.message?.content
  if (Array.isArray(blocks)) {
    for (const block of blocks) {
      if (block.type !== 'tool_result') continue
      const resultBlock = block as SDKToolResultBlock
      if (results.has(resultBlock.tool_use_id)) continue
      const result = typeof resultBlock.content === 'string'
        ? resultBlock.content
        : Array.isArray(resultBlock.content)
          ? (resultBlock.content as Array<{ type: string; text?: string }>)
            .filter((part) => part.type === 'text' && typeof part.text === 'string')
            .map((part) => part.text)
            .join('\n')
          : undefined
      results.set(resultBlock.tool_use_id, { result, isError: resultBlock.is_error })
    }
  }
  messageResults.set(message, results)
  return results
}

/** 同一不可变消息数组只建一次索引，消息替换时才重新提取结果。 */
export function getToolMessageIndex(messages: SDKMessage[]): ToolMessageIndex {
  const cached = arrayIndexes.get(messages)
  if (cached) return cached
  const index: ToolMessageIndex = { results: new Map(), subAgents: new Map() }
  for (const message of messages) {
    if (message.type === 'user') {
      for (const [id, result] of readResults(message as SDKUserMessage)) {
        // 与原来的顺序查找一致：重复 ID 保留首条结果。
        if (!index.results.has(id)) index.results.set(id, result)
      }
    } else if (message.type === 'system' && message.subtype === 'task_notification') {
      const system = message as SDKSystemMessage
      const id = system.tool_use_id
      if (!id || index.subAgents.has(id)) continue
      if (!messageMetadata.has(message)) {
        const usage = system.usage
        messageMetadata.set(message, usage ? {
          durationMs: usage.duration_ms ?? 0,
          totalTokens: usage.total_tokens ?? 0,
          toolUses: usage.tool_uses ?? 0,
        } : null)
      }
      index.subAgents.set(id, messageMetadata.get(message) ?? null)
    }
  }
  arrayIndexes.set(messages, index)
  return index
}

export interface ToolRenderProps {
  block: SDKToolUseBlock
  allMessages: SDKMessage[]
  animate?: boolean
  index?: number
  dimmed?: boolean
  childBlocks?: SDKContentBlock[]
  basePath?: string
  isStreaming?: boolean
}

export function areToolRenderPropsEqual(previous: ToolRenderProps, next: ToolRenderProps): boolean {
  if (
    previous.block !== next.block
    || previous.animate !== next.animate
    || previous.index !== next.index
    || previous.dimmed !== next.dimmed
    || previous.childBlocks !== next.childBlocks
    || previous.basePath !== next.basePath
    || previous.isStreaming !== next.isStreaming
  ) return false
  // 子代理内部工具仍需接收结果到达事件；不能仅比较父工具的结果。
  if (next.childBlocks?.length && previous.allMessages !== next.allMessages) return false
  const previousIndex = getToolMessageIndex(previous.allMessages)
  const nextIndex = getToolMessageIndex(next.allMessages)
  return previousIndex.results.get(next.block.id) === nextIndex.results.get(next.block.id)
    && previousIndex.subAgents.get(next.block.id) === nextIndex.subAgents.get(next.block.id)
}
