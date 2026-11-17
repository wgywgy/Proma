import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createToolOutputBudget,
  getToolOutputDirectory,
  installToolOutputBudgetHooks,
  TOOL_OUTPUT_MAX_BYTES,
} from './pi-tool-output-budget'

const directories: string[] = []

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'proma-output-budget-'))
  directories.push(directory)
  return directory
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('工具输出限量', () => {
  test('小结果原样返回，不创建原文文件', () => {
    const directory = temporaryDirectory()
    const budget = createToolOutputBudget(directory)
    const content = [{ type: 'text' as const, text: '命中 src/refund.ts:42' }]
    expect(budget.limit('ripgrep', content)).toBe(content)
    expect(readdirSync(directory)).toEqual([])
  })

  test('124 万字符调试输出保存完整原文，仅返回 8 KiB 内预览', () => {
    const directory = temporaryDirectory()
    const budget = createToolOutputBudget(directory)
    const text = 'frame: refund\n'.repeat(88_572)
    const result = budget.limit('debugger', [{ type: 'text', text }])
    const preview = result.find((block) => block.type === 'text')
    expect(preview?.type).toBe('text')
    if (preview?.type !== 'text') throw new Error('缺少文本预览')
    expect(Buffer.byteLength(preview.text)).toBeLessThanOrEqual(TOOL_OUTPUT_MAX_BYTES)
    expect(preview.text).toContain('原文:')
    const files = readdirSync(directory)
    expect(files).toHaveLength(1)
    expect(readFileSync(join(directory, files[0]!), 'utf8')).toBe(text)
    expect(statSync(join(directory, files[0]!)).mode & 0o777).toBe(0o600)
    expect(budget.limit('debugger', result)).toBe(result)
    expect(readdirSync(directory)).toHaveLength(1)
  })

  test('head -20 仍包含超长行时，限制长行并保留首尾和完整原文', () => {
    const directory = temporaryDirectory()
    const text = 'START-' + '退款'.repeat(6_334) + '-END'
    const result = createToolOutputBudget(directory).limit('bash', [{ type: 'text', text }])
    const preview = result[0]!
    if (preview.type !== 'text') throw new Error('缺少文本预览')
    expect(Buffer.byteLength(preview.text)).toBeLessThanOrEqual(TOOL_OUTPUT_MAX_BYTES)
    expect(preview.text).toContain('START-')
    expect(preview.text).toContain('-END')
    expect(preview.text).not.toContain('\uFFFD')
    expect(readFileSync(join(directory, readdirSync(directory)[0]!), 'utf8')).toBe(text)
  })

  test('多个文本块共用总预算，图片保持不变', () => {
    const directory = temporaryDirectory()
    const image = { type: 'image' as const, mimeType: 'image/png', data: 'aGVsbG8=' }
    const firstText = 'a'.repeat(6_000)
    const secondText = 'b'.repeat(6_000)
    const content = [
      { type: 'text' as const, text: firstText },
      image,
      { type: 'text' as const, text: secondText },
    ]
    const result = createToolOutputBudget(directory).limit('mcp', content)
    const texts = result.filter((block) => block.type === 'text')
    expect(texts.reduce((bytes, block) => bytes + Buffer.byteLength(block.text), 0))
      .toBeLessThanOrEqual(TOOL_OUTPUT_MAX_BYTES)
    expect(result.find((block) => block.type === 'image')).toBe(image)
    expect(readFileSync(join(directory, readdirSync(directory)[0]!), 'utf8'))
      .toBe(firstText + '\n' + secondText)
  })

  test('很多短行也限量，尾部错误不会只因 head 预览而丢失', () => {
    const directory = temporaryDirectory()
    const text = Array.from({ length: 200 }, (_, index) => `frame ${index}`).join('\n') + '\nERROR refund'
    const result = createToolOutputBudget(directory).limit('bash', [{ type: 'text', text }])
    const preview = result[0]!
    if (preview.type !== 'text') throw new Error('缺少文本预览')
    expect(preview.text).toContain('frame 0')
    expect(preview.text).toContain('ERROR refund')
    expect(preview.text).not.toContain('frame 100\n')
  })

  test('总字节截断也不切坏 UTF-8，保留最后一行', () => {
    const directory = temporaryDirectory()
    const text = ('退款'.repeat(80) + '\n').repeat(200) + 'ERROR 最后一帧'
    const budget = createToolOutputBudget(directory)
    const result = budget.limit('debugger', [{ type: 'text', text }])
    const preview = result[0]!
    if (preview.type !== 'text') throw new Error('缺少文本预览')
    expect(Buffer.byteLength(preview.text)).toBeLessThanOrEqual(TOOL_OUTPUT_MAX_BYTES)
    expect(preview.text).not.toContain('\uFFFD')
    expect(preview.text).toContain('ERROR 最后一帧')
    expect(budget.limit('debugger', result)).toBe(result)
  })

  test('重复历史输出复用文件，恢复时不修改原消息', () => {
    const directory = temporaryDirectory()
    const budget = createToolOutputBudget(directory)
    const message = {
      role: 'toolResult' as const,
      toolName: 'bash',
      content: [{ type: 'text' as const, text: '历史\n'.repeat(5_000) }],
      toolCallId: 'call-1',
      isError: true,
      timestamp: 123,
    }
    const limited = budget.limitMessage(message)
    expect(limited).not.toBe(message)
    expect(message.content[0]!.text).toBe('历史\n'.repeat(5_000))
    expect(limited.isError).toBe(true)
    expect(limited.toolCallId).toBe('call-1')
    expect(limited.timestamp).toBe(123)
    expect(budget.limitMessage(message)).toBe(limited)
    budget.limit('bash', message.content)
    expect(readdirSync(directory)).toHaveLength(1)
  })

  test('写入失败仍限制返回体积，明确提示未保存，不要求重跑副作用命令', () => {
    const directory = temporaryDirectory()
    const invalidDirectory = join(directory, 'not-a-directory')
    writeFileSync(invalidDirectory, 'occupied')
    const result = createToolOutputBudget(invalidDirectory).limit('bash', [
      { type: 'text', text: 'x'.repeat(38_000) },
    ])
    const preview = result[0]!
    if (preview.type !== 'text') throw new Error('缺少文本预览')
    expect(Buffer.byteLength(preview.text)).toBeLessThanOrEqual(TOOL_OUTPUT_MAX_BYTES)
    expect(preview.text).toContain('原文保存失败')
    expect(preview.text).not.toContain('原文:')
  })

  test('会话目录隔离且会话标识不能造成路径穿越', () => {
    const root = temporaryDirectory()
    const first = getToolOutputDirectory(root, '../one')
    const second = getToolOutputDirectory(root, '../two')
    expect(first).not.toBe(second)
    expect(first.startsWith(join(root, 'tool-outputs') + '/')).toBe(true)
    expect(first.slice(join(root, 'tool-outputs').length + 1)).toMatch(/^[a-f0-9]{64}$/)
  })

  test('没有已有 hook 时仍保留原始工具 details 和 terminate', async () => {
    const directory = temporaryDirectory()
    type BudgetAgent = Parameters<typeof installToolOutputBudgetHooks>[0]
    type HookContext = Parameters<NonNullable<BudgetAgent['afterToolCall']>>[0]
    const agent = {} as BudgetAgent
    const details = { exitCode: 9 }
    installToolOutputBudgetHooks(agent, directory)
    const result = await agent.afterToolCall?.({
      toolCall: { name: 'bash' },
      result: {
        content: [{ type: 'text', text: 'x'.repeat(38_000) }],
        details,
        terminate: true,
      },
    } as unknown as HookContext, new AbortController().signal)
    expect(result?.details).toBe(details)
    expect(result?.terminate).toBe(true)
  })

  test('hook 在已有终止和上下文转换之后运行，保留细节与错误状态', async () => {
    const directory = temporaryDirectory()
    const details = { exitCode: 7 }
    const transformedMessage = {
      role: 'toolResult' as const,
      toolName: 'bash',
      content: [{ type: 'text' as const, text: 'old\n'.repeat(5_000) }],
      toolCallId: 'old-call',
      isError: true,
      timestamp: 123,
    }
    const agent = {
      afterToolCall: async () => ({
        content: [{ type: 'text' as const, text: 'new\n'.repeat(5_000) }],
        details,
        terminate: true,
      }),
      transformContext: async () => [transformedMessage],
    }
    type BudgetAgent = Parameters<typeof installToolOutputBudgetHooks>[0]
    const typedAgent = agent as unknown as BudgetAgent
    installToolOutputBudgetHooks(typedAgent, directory)
    type HookContext = Parameters<NonNullable<BudgetAgent['afterToolCall']>>[0]
    const result = await typedAgent.afterToolCall?.({
      toolCall: { name: 'bash' },
      result: { content: [{ type: 'text', text: 'unfiltered' }] },
    } as unknown as HookContext, new AbortController().signal)
    expect(result?.terminate).toBe(true)
    expect(result?.details).toBe(details)
    expect(result?.content?.[0]?.type).toBe('text')
    const messages = await typedAgent.transformContext?.([], new AbortController().signal)
    const message = messages?.[0]
    expect(message?.role).toBe('toolResult')
    if (message?.role !== 'toolResult') throw new Error('缺少历史工具消息')
    expect(message.isError).toBe(true)
    expect(message.content[0]?.type).toBe('text')
    const block = message.content[0]
    if (block?.type !== 'text') throw new Error('缺少文本预览')
    expect(Buffer.byteLength(block.text)).toBeLessThanOrEqual(TOOL_OUTPUT_MAX_BYTES)
    expect(transformedMessage.content[0]!.text).toBe('old\n'.repeat(5_000))
  })
})
