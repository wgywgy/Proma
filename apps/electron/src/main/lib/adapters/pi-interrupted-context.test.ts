import { describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { AssistantMessage, Message } from '@earendil-works/pi-ai'
import { createAssistantMessageEventStream, InMemoryCredentialStore, normalizeContext } from '@earendil-works/pi-ai'
import { getModels, streamAnthropic } from '@earendil-works/pi-ai/compat'
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent'
import { createPromaManagedResourceLoaderOptions } from './pi-resource-loader-overrides'
import { preparePiInterruptedContext } from './pi-interrupted-context'

function assistant(stopReason: AssistantMessage['stopReason']): AssistantMessage {
  return {
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: 'private reasoning', thinkingSignature: 'partial-signature' },
      { type: 'text', text: '已发现退款状态转换缺少校验。' },
      { type: 'toolCall', id: 'unfinished-call', name: 'write', arguments: { path: 'refund.ts' } },
    ],
    api: 'anthropic-messages', provider: 'anthropic', model: 'test-model',
    usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason, timestamp: 0,
    ...(stopReason === 'error' ? { errorMessage: 'connection closed' } : {}),
  }
}

describe('中断回复的请求上下文', () => {
  test.each(['aborted', 'error'] as const)(
    'Given %s 回复包含正文、思考和残缺调用 When 准备续聊 Then 只保留标记为未完成的正文且不修改原文',
    (reason) => {
      const original = assistant(reason)
      const snapshot = structuredClone(original)
      const prepared = preparePiInterruptedContext([original])
      const message = prepared[0] as AssistantMessage
      expect(message.content).toHaveLength(1)
      expect(message.content[0]?.type).toBe('text')
      expect(JSON.stringify(message.content)).toContain('未完成')
      expect(JSON.stringify(message.content)).toContain('退款状态转换')
      expect(JSON.stringify(message)).not.toContain('partial-signature')
      expect(JSON.stringify(message)).not.toContain('unfinished-call')
      expect(message.stopReason).toBe('stop')
      expect(message.errorMessage).toBeUndefined()
      expect(original).toEqual(snapshot)
      expect(preparePiInterruptedContext(prepared)).toEqual(prepared)
    },
  )

  test('Given 失败回复只有思考 When 续聊 Then 不把推理伪装成用户可见结论', () => {
    const original = assistant('aborted')
    original.content = [original.content[0]!]
    expect(preparePiInterruptedContext([original])).toEqual([])
  })

  test('Given 已完成的签名思考与调用 When 多次准备请求 Then 不删除也不重复添加内容', () => {
    const original = assistant('toolUse')
    const prepared = preparePiInterruptedContext([original])
    expect(prepared[0]).toBe(original)
    expect(preparePiInterruptedContext(prepared)[0]).toBe(original)
  })

  test('Given 中断前已完成的工具结果 When 续聊 Then 保留完整工具链', () => {
    const toolResult: AgentMessage = {
      role: 'toolResult', toolCallId: 'completed-call', toolName: 'read',
      content: [{ type: 'text', text: 'refund.ts content' }], isError: false, timestamp: 0,
    }
    const completed = assistant('toolUse')
    completed.content = [{ type: 'toolCall', id: 'completed-call', name: 'read', arguments: {} }]
    const messages = preparePiInterruptedContext([completed, toolResult, assistant('aborted')])
    expect(messages[0]).toBe(completed)
    expect(messages[1]).toBe(toolResult)
    expect(messages).toHaveLength(3)
  })

  test('Given 历史含有效签名与中断思考 When 连续序列化 Anthropic 请求 Then 正文保留且签名块不重复', async () => {
    const model = getModels('anthropic')[0]
    if (!model) throw new Error('缺少静态 Anthropic 模型')
    const completed = assistant('toolUse')
    completed.model = model.id
    completed.content = [
      { type: 'thinking', thinking: 'valid reasoning', thinkingSignature: 'valid-signature' },
      { type: 'toolCall', id: 'completed-call', name: 'read', arguments: {} },
    ]
    const context = preparePiInterruptedContext([
      { role: 'user', content: '分析退款', timestamp: 0 },
      completed,
      {
        role: 'toolResult', toolCallId: 'completed-call', toolName: 'read',
        content: [{ type: 'text', text: 'source' }], isError: false, timestamp: 0,
      },
      assistant('aborted'),
      { role: 'user', content: '继续', timestamp: 0 },
    ]).filter((message): message is Message => message.role !== 'custom')
    const payloads: string[] = []
    for (let index = 0; index < 2; index++) {
      const stream = streamAnthropic(model, normalizeContext({ messages: context }), {
        apiKey: 'offline-test-key',
        onPayload(payload) {
          payloads.push(JSON.stringify(payload))
          // 在发起网络请求之前截获最终 payload。
          throw new Error('OFFLINE_PAYLOAD_CAPTURE')
        },
      })
      await stream.result()
    }
    expect(payloads).toHaveLength(2)
    expect(payloads[1]).toBe(payloads[0])
    expect(payloads[0]).toContain('退款状态转换')
    expect(payloads[0]).not.toContain('partial-signature')
    expect(payloads[0]).not.toContain('unfinished-call')
    expect(payloads[0]?.match(/valid-signature/g)).toHaveLength(1)
  })

  test.each(['aborted', 'error'] as const)(
    'Given Pi 保存了 %s 部分回复 When 重开会话并继续请求 Then 模型仍收到正文且磁盘失败终态不被改写',
    async (reason) => {
      const directory = mkdtempSync(join(tmpdir(), 'proma-interrupted-context-'))
      const agentDir = join(directory, 'agent')
      mkdirSync(agentDir)
      const settingsManager = SettingsManager.inMemory({
        compaction: { enabled: false }, cacheWarming: 'off', retry: { enabled: false },
      })
      const modelRuntime = await ModelRuntime.create({
        credentials: new InMemoryCredentialStore(), modelsPath: null,
        modelsStorePath: join(directory, 'models.json'),
        allowModelNetwork: false, refreshOnCreate: false,
      })
      const model = modelRuntime.getModels('anthropic')[0]
      if (!model) throw new Error('缺少静态 Anthropic 模型')
      await modelRuntime.setRuntimeApiKey(model.provider, 'offline-test-key')
      const resourceLoader = new DefaultResourceLoader({
        cwd: directory, agentDir, settingsManager,
        ...createPromaManagedResourceLoaderOptions(),
        noPromptTemplates: true, noThemes: true,
        systemPromptOverride: () => 'OFFLINE_TEST',
      })
      let session: Awaited<ReturnType<typeof createAgentSession>>['session'] | undefined
      let resumed: typeof session
      try {
        await resourceLoader.reload()
        session = (await createAgentSession({
          cwd: directory, agentDir, modelRuntime, model, settingsManager, resourceLoader,
          noTools: 'all', sessionManager: SessionManager.create(directory, join(directory, 'sessions')),
        })).session
        const interrupted = assistant(reason)
        interrupted.model = model.id
        session.agent.streamFunction = () => {
          const stream = createAssistantMessageEventStream()
          stream.push({ type: 'error', reason, error: interrupted })
          stream.end()
          return stream
        }
        await session.prompt('分析退款')
        const sessionFile = session.sessionManager.getSessionFile()
        if (!sessionFile) throw new Error('Pi 未保存会话')
        const originalArtifact = readFileSync(sessionFile, 'utf8')
        expect(originalArtifact).toContain('退款状态转换')
        expect(originalArtifact).toContain(`"stopReason":"${reason}"`)
        session.dispose()
        resumed = (await createAgentSession({
          cwd: directory, agentDir, modelRuntime, model, settingsManager, resourceLoader,
          noTools: 'all', sessionManager: SessionManager.open(sessionFile),
        })).session
        const previousTransform = resumed.agent.transformContext
        resumed.agent.transformContext = async (messages, signal) =>
          preparePiInterruptedContext(await previousTransform?.(messages, signal) ?? messages)
        let requestText = ''
        resumed.agent.streamFunction = (requestModel, context) => {
          requestText = JSON.stringify(context.messages)
          const stream = createAssistantMessageEventStream()
          const completed: AssistantMessage = {
            ...assistant('stop'), api: requestModel.api, provider: requestModel.provider, model: requestModel.id,
            content: [{ type: 'text', text: '继续处理' }],
          }
          stream.push({ type: 'done', reason: 'stop', message: completed })
          stream.end()
          return stream
        }
        await resumed.prompt('继续')
        expect(requestText).toContain('退款状态转换')
        expect(requestText).toContain('未完成')
        expect(requestText).not.toContain('partial-signature')
        expect(requestText).not.toContain('unfinished-call')
        expect(readFileSync(sessionFile, 'utf8').startsWith(originalArtifact)).toBe(true)
      } finally {
        resumed?.dispose()
        session?.dispose()
        rmSync(directory, { recursive: true, force: true })
      }
    },
  )
})
