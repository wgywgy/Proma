import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createToolOutputBudget,
  getToolOutputDirectory,
  installToolOutputBudgetHooks,
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

describe('工具输出不再统一限量', () => {
  test('小结果原样返回，不创建原文文件', () => {
    const directory = temporaryDirectory()
    const budget = createToolOutputBudget(directory)
    const content = [{ type: 'text' as const, text: '命中 src/refund.ts:42' }]
    expect(budget.limit('ripgrep', content)).toBe(content)
    expect(readdirSync(directory)).toEqual([])
  })

  test('124 万字符调试输出完整返回，不强制创建原文文件', () => {
    const directory = temporaryDirectory()
    const budget = createToolOutputBudget(directory)
    const text = 'frame: refund\n'.repeat(88_572)
    const content = [{ type: 'text' as const, text }]
    const result = budget.limit('debugger', content)
    expect(result).toBe(content)
    expect(result[0]).toEqual({ type: 'text', text })
    expect(budget.limit('debugger', result)).toBe(result)
    expect(readdirSync(directory)).toEqual([])
  })

  test('超长中文行完整返回，不截断中间内容', () => {
    const directory = temporaryDirectory()
    const text = 'START-' + '退款'.repeat(6_334) + '-END'
    const result = createToolOutputBudget(directory).limit('bash', [{ type: 'text', text }])
    const preview = result[0]!
    if (preview.type !== 'text') throw new Error('缺少文本预览')
    expect(preview.text).toBe(text)
    expect(preview.text).not.toContain('\uFFFD')
    expect(readdirSync(directory)).toEqual([])
  })

  test('多个文本块及图片保持原顺序、内容和引用', () => {
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
    expect(result).toBe(content)
    expect(result).toEqual(content)
    expect(result.find((block) => block.type === 'image')).toBe(image)
    expect(readdirSync(directory)).toEqual([])
  })

  test('超过旧行数上限时保留中间行和尾部错误', () => {
    const directory = temporaryDirectory()
    const text = Array.from({ length: 200 }, (_, index) => `frame ${index}`).join('\n') + '\nERROR refund'
    const result = createToolOutputBudget(directory).limit('bash', [{ type: 'text', text }])
    const preview = result[0]!
    if (preview.type !== 'text') throw new Error('缺少文本预览')
    expect(preview.text).toBe(text)
    expect(preview.text).toContain('frame 100\n')
  })

  test('超过旧字节上限的多行中文完整返回', () => {
    const directory = temporaryDirectory()
    const text = ('退款'.repeat(80) + '\n').repeat(200) + 'ERROR 最后一帧'
    const budget = createToolOutputBudget(directory)
    const result = budget.limit('debugger', [{ type: 'text', text }])
    const preview = result[0]!
    if (preview.type !== 'text') throw new Error('缺少文本预览')
    expect(preview.text).toBe(text)
    expect(preview.text).not.toContain('\uFFFD')
    expect(preview.text).toContain('ERROR 最后一帧')
    expect(budget.limit('debugger', result)).toBe(result)
  })

  test('恢复与重复请求保持完整历史消息，不生成副本或文件', () => {
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
    expect(limited).toBe(message)
    expect(message.content[0]!.text).toBe('历史\n'.repeat(5_000))
    expect(limited.isError).toBe(true)
    expect(limited.toolCallId).toBe('call-1')
    expect(limited.timestamp).toBe(123)
    expect(budget.limitMessage(message)).toBe(limited)
    budget.limit('bash', message.content)
    expect(readdirSync(directory)).toEqual([])
  })

  test('输出目录不可写也不影响完整返回，不触发落盘', () => {
    const directory = temporaryDirectory()
    const invalidDirectory = join(directory, 'not-a-directory')
    writeFileSync(invalidDirectory, 'occupied')
    const result = createToolOutputBudget(invalidDirectory).limit('bash', [
      { type: 'text', text: 'x'.repeat(38_000) },
    ])
    const preview = result[0]!
    if (preview.type !== 'text') throw new Error('缺少文本预览')
    expect(preview.text).toBe('x'.repeat(38_000))
    expect(readdirSync(directory)).toEqual(['not-a-directory'])
  })

  test('会话目录隔离且会话标识不能造成路径穿越', () => {
    const root = temporaryDirectory()
    const first = getToolOutputDirectory(root, '../one')
    const second = getToolOutputDirectory(root, '../two')
    expect(first).not.toBe(second)
    expect(first.startsWith(join(root, 'tool-outputs') + '/')).toBe(true)
    expect(first.slice(join(root, 'tool-outputs').length + 1)).toMatch(/^[a-f0-9]{64}$/)
  })

  test('没有已有 hook 时不新增结果与上下文转换 hook', () => {
    const directory = temporaryDirectory()
    type BudgetAgent = Parameters<typeof installToolOutputBudgetHooks>[0]
    const agent = {} as BudgetAgent
    installToolOutputBudgetHooks(agent, directory)
    expect(agent.afterToolCall).toBeUndefined()
    expect(agent.transformContext).toBeUndefined()
  })

  test('已有 hook 不被包装，保留完整输出、终止状态和历史消息', async () => {
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
    const previousAfterToolCall = typedAgent.afterToolCall
    const previousTransformContext = typedAgent.transformContext
    installToolOutputBudgetHooks(typedAgent, directory)
    expect(typedAgent.afterToolCall).toBe(previousAfterToolCall)
    expect(typedAgent.transformContext).toBe(previousTransformContext)
    type HookContext = Parameters<NonNullable<BudgetAgent['afterToolCall']>>[0]
    const result = await typedAgent.afterToolCall?.({
      toolCall: { name: 'bash' },
      result: { content: [{ type: 'text', text: 'unfiltered' }] },
    } as unknown as HookContext, new AbortController().signal)
    expect(result?.terminate).toBe(true)
    expect(result?.details).toBe(details)
    expect(result?.content?.[0]?.type).toBe('text')
    expect(result?.content?.[0]).toEqual({ type: 'text', text: 'new\n'.repeat(5_000) })
    const messages = await typedAgent.transformContext?.([], new AbortController().signal)
    const message = messages?.[0]
    expect(message?.role).toBe('toolResult')
    if (message?.role !== 'toolResult') throw new Error('缺少历史工具消息')
    expect(message).toBe(transformedMessage)
    expect(message.isError).toBe(true)
    expect(message.content[0]?.type).toBe('text')
    const block = message.content[0]
    if (block?.type !== 'text') throw new Error('缺少文本预览')
    expect(block.text).toBe('old\n'.repeat(5_000))
    expect(transformedMessage.content[0]!.text).toBe('old\n'.repeat(5_000))
  })
})
