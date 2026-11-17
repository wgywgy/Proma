import { createHash } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentMessage, AgentToolResult } from '@earendil-works/pi-agent-core'
import type { AgentSession } from '@earendil-works/pi-coding-agent'
import { writeTextFileAtomic } from '../safe-file'

export const TOOL_OUTPUT_MAX_BYTES = 8 * 1024
const MAX_SOURCE_LINES = 120
const MAX_LINE_BYTES = 512
// 预留摘要、文件路径及省略标记的行数，避免预览在下一轮再次触发限量。
const MAX_PREVIEW_SOURCE_LINES = 100
const HEAD_LINES = 70
const TAIL_LINES = MAX_PREVIEW_SOURCE_LINES - HEAD_LINES

type ToolContent = AgentToolResult<unknown>['content']
type BudgetAgent = Pick<AgentSession['agent'], 'afterToolCall' | 'transformContext'>

export interface ToolOutputBudget {
  limit(toolName: string, content: ToolContent): ToolContent
  limitMessage<T extends AgentMessage>(message: T): T
}

interface OutputPreview {
  bytes: number
  lines: number
  limited: boolean
  text: string
}

function utf8Head(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text)
  if (bytes.length <= maxBytes) return text
  let end = Math.max(0, maxBytes)
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--
  return bytes.subarray(0, end).toString('utf8')
}

function utf8Tail(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text)
  if (bytes.length <= maxBytes) return text
  let start = Math.max(0, bytes.length - maxBytes)
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++
  return bytes.subarray(start).toString('utf8')
}

function clipHeadAndTail(text: string, maxBytes: number, marker: string): string {
  if (Buffer.byteLength(text) <= maxBytes) return text
  const available = Math.max(0, maxBytes - Buffer.byteLength(marker))
  const headBytes = Math.floor(available * 0.65)
  return utf8Head(text, headBytes) + marker + utf8Tail(text, available - headBytes)
}

function previewOutput(text: string): OutputPreview {
  const bytes = Buffer.byteLength(text)
  const head: string[] = []
  const tail: string[] = []
  let lines = 0
  let hasLongLine = false
  let offset = 0

  // 只保留首尾样本，避免 split 为巨量日志创建与行数成正比的数组。
  while (offset <= text.length) {
    const newline = text.indexOf('\n', offset)
    const line = text.slice(offset, newline === -1 ? text.length : newline)
    const longLine = Buffer.byteLength(line) > MAX_LINE_BYTES
    hasLongLine ||= longLine
    lines++
    const sample = longLine
      ? clipHeadAndTail(line, MAX_LINE_BYTES, ' ...[长行省略]... ')
      : line
    if (lines <= HEAD_LINES) {
      head.push(sample)
    } else {
      tail.push(sample)
      if (tail.length > TAIL_LINES) tail.shift()
    }
    if (newline === -1) break
    offset = newline + 1
  }

  const samples = lines > MAX_PREVIEW_SOURCE_LINES
    ? [...head, `...[省略 ${lines - MAX_PREVIEW_SOURCE_LINES} 行]...`, ...tail]
    : [...head, ...tail]
  return {
    bytes,
    lines,
    limited: bytes > TOOL_OUTPUT_MAX_BYTES || lines > MAX_SOURCE_LINES || hasLongLine,
    text: samples.join('\n'),
  }
}

export function getToolOutputDirectory(sessionRoot: string, sessionId: string): string {
  const namespace = createHash('sha256').update(sessionId).digest('hex')
  return join(sessionRoot, 'tool-outputs', namespace)
}

export function createToolOutputBudget(outputDirectory: string): ToolOutputBudget {
  const historyCache = new WeakMap<AgentMessage, AgentMessage>()

  const limit = (toolName: string, content: ToolContent): ToolContent => {
    const text = content.filter((block) => block.type === 'text').map((block) => block.text).join('\n')
    if (!text) return content
    const preview = previewOutput(text)
    if (!preview.limited) return content

    let sourceNotice: string
    try {
      mkdirSync(outputDirectory, { recursive: true, mode: 0o700 })
      const digest = createHash('sha256').update(toolName).update('\0').update(text).digest('hex')
      const sourcePath = join(outputDirectory, `${digest}.txt`)
      // 内容寻址复用同一会话的原文；请求、resume 和 provider retry 不会重复写大文件。
      if (!existsSync(sourcePath)) writeTextFileAtomic(sourcePath, text)
      sourceNotice = `原文: ${sourcePath}\n按需用 Read 的 offset/limit 或限定关键词检索原文，不要整份重读。`
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      sourceNotice = `原文保存失败: ${utf8Head(reason, 256)}\n本次仅有预览，不要为补日志自动重跑可能有副作用的命令。`
    }

    const header = `[工具输出已限量: ${utf8Head(toolName, 120)}; 原始 ${preview.bytes} 字节 / ${preview.lines} 行]\n${sourceNotice}\n\n`
    const body = clipHeadAndTail(
      preview.text,
      Math.max(0, TOOL_OUTPUT_MAX_BYTES - Buffer.byteLength(header)),
      '\n...[字节预算省略]...\n',
    )
    const limitedText = header + body
    let inserted = false
    const limitedContent: ToolContent = []
    for (const block of content) {
      if (block.type !== 'text') {
        limitedContent.push(block)
      } else if (!inserted) {
        limitedContent.push({ type: 'text', text: limitedText })
        inserted = true
      }
    }
    return limitedContent
  }

  return {
    limit,
    limitMessage<T extends AgentMessage>(message: T): T {
      if (message.role !== 'toolResult') return message
      const cached = historyCache.get(message)
      if (cached) return cached as T
      const content = limit(message.toolName, message.content)
      const limited = content === message.content ? message : { ...message, content }
      historyCache.set(message, limited)
      return limited
    },
  }
}

export function installToolOutputBudgetHooks(agent: BudgetAgent, outputDirectory: string): void {
  const budget = createToolOutputBudget(outputDirectory)
  const previousAfterToolCall = agent.afterToolCall
  agent.afterToolCall = async (context, signal) => {
    const previousResult = await previousAfterToolCall?.(context, signal)
    const content = previousResult?.content ?? context.result.content
    const limitedContent = budget.limit(context.toolCall.name, content)
    if (limitedContent === content) return previousResult
    return { ...context.result, ...previousResult, content: limitedContent }
  }

  const previousTransformContext = agent.transformContext
  agent.transformContext = async (messages, signal) => {
    const transformed = await previousTransformContext?.(messages, signal) ?? messages
    // 仅限量 provider 请求中的旧工具消息，不改写历史 artifact 或用户/助手消息。
    return transformed.map((message) => budget.limitMessage(message))
  }
}
