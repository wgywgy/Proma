import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Type } from 'typebox'
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, defineTool } from '@earendil-works/pi-coding-agent'
import { InMemoryCredentialStore } from '@earendil-works/pi-ai'
import type { Model } from '@earendil-works/pi-ai'
import { streamSimple } from '@earendil-works/pi-ai/compat'
import { inferContextWindow, isCodexFastModeSupportedModel, resolveReasoningProfile } from '@proma/shared'
import { createOpenAIChatToolCompatibilityExtension, withHighwayChatToolCompatibility } from './pi-openai-chat-tool-compat'
import { createPromaManagedResourceLoaderOptions } from './pi-resource-loader-overrides'

const baseUrl = 'https://api.highwayapi.ai/openai'
const tools = [{
  type: 'function',
  function: { name: 'read_file', parameters: { type: 'object', properties: {} } },
}]

describe('HighwayAPI gpt-6.1-sol Agent 兼容', () => {
  test.each(['openai-completions', 'openai-responses'] as const)(
    'Given gpt-6.1-sol When 解析 %s 推理能力 Then 关闭档位明确对应 none',
    (transport) => {
      const profile = resolveReasoningProfile({ modelId: 'gpt-6.1-sol', transport })
      expect(profile?.levels).toContain('off')
      expect(profile?.encodings[transport]?.effortMap?.off).toBe('none')
      expect(isCodexFastModeSupportedModel('gpt-6.1-sol')).toBe(false)
      expect(inferContextWindow('gpt-6.1-sol')).not.toBe(inferContextWindow('gpt-6-sol'))
    },
  )

  test.each(['gpt-6.1-sol-preview', 'gpt-6.10-sol', 'other/gpt-6.1-sol'])(
    'Given 相近模型 %s When 识别 Then 不套用已验证推理能力',
    (modelId) => {
      expect(resolveReasoningProfile({ modelId, transport: 'openai-completions' })).toBeUndefined()
    },
  )

  test('Given 非 OpenAI 协议 When 识别 Then 不添加推理能力', () => {
    expect(resolveReasoningProfile({ modelId: 'gpt-6.1-sol', transport: 'anthropic-messages' })).toBeUndefined()
  })

  test.each([undefined, 'off', 'low', 'medium', 'high', 'max'])(
    'Given 工具与推理 %s When 请求最终发送 Then 强制 none 且不改原对象或工具',
    (effort) => {
      const payload = { model: 'gpt-6.1-sol', tools, reasoning_effort: effort, stream: true }
      const patched = withHighwayChatToolCompatibility(payload, baseUrl)
      expect(patched).toEqual({ ...payload, reasoning_effort: 'none' })
      expect(payload.reasoning_effort).toBe(effort)
      expect((patched as Record<string, unknown>).tools).toBe(tools)
    },
  )

  test.each([undefined, 'invalid-url', 'https://other.example/openai', 'https://api.highwayapi.ai.attacker.example/openai'])(
    'Given 非目标地址 %s When 请求工具 Then 保留原参数',
    (url) => {
      const payload = { model: 'gpt-6.1-sol', tools, reasoning_effort: 'high' }
      expect(withHighwayChatToolCompatibility(payload, url)).toBe(payload)
    },
  )

  test('Given 其他模型或纯聊天 When 修正 Then 不关闭其推理', () => {
    for (const payload of [
      { model: 'gpt-6-sol', tools, reasoning_effort: 'high' },
      { model: 'gpt-6.1-sol', reasoning_effort: 'high' },
      { model: 'gpt-6.1-sol', tools: [], reasoning_effort: 'high' },
      { model: 'gpt-6.1-sol', tools: [{ type: 'web_search' }], reasoning_effort: 'high' },
      { model: 'gpt-6.1-sol', tools: [null, 'invalid'], reasoning_effort: 'high' },
    ]) {
      expect(withHighwayChatToolCompatibility(payload, baseUrl)).toBe(payload)
    }
  })

  test('Given 无效 payload 或已关闭推理 When 修正 Then 原样返回', () => {
    for (const payload of [undefined, null, [], 'invalid', { model: 'gpt-6.1-sol', tools, reasoning_effort: 'none' }]) {
      expect(withHighwayChatToolCompatibility(payload, baseUrl)).toBe(payload)
    }
  })

  test('Given Pi SDK 高思考工具请求 When 离线捕获 HTTP Then 发送正确模型和 none 并解析回复', async () => {
    const profile = resolveReasoningProfile({ modelId: 'gpt-6.1-sol', transport: 'openai-completions' })
    const encoding = profile?.encodings['openai-completions']
    if (encoding?.kind !== 'openai-reasoning-effort') throw new Error('缺少模型推理映射')
    const model: Model<'openai-completions'> = {
      id: 'gpt-6.1-sol', name: 'gpt-6.1-sol', provider: 'openai', api: 'openai-completions',
      baseUrl, reasoning: true, thinkingLevelMap: encoding.effortMap,
      compat: { supportsReasoningEffort: true },
      input: ['text'], contextWindow: 64_000, maxTokens: 512,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }
    let calls = 0
    const result = await streamSimple(model, {
      messages: [{ role: 'user', content: '你好', timestamp: 0 }],
      tools: [{ name: 'read_file', description: '读取文件', parameters: { type: 'object', properties: {} } }],
    }, {
      apiKey: 'offline-test-key', reasoning: 'high', maxRetries: 0,
      onPayload: (payload) => withHighwayChatToolCompatibility(payload, baseUrl),
      fetch: Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init)
        calls++
        expect(request.url).toBe(`${baseUrl}/chat/completions`)
        const body = await request.json() as Record<string, unknown>
        expect(body.model).toBe('gpt-6.1-sol')
        expect(body.reasoning_effort).toBe('none')
        expect(body.tools).toEqual(tools.map((tool) => ({
          ...tool, function: { ...tool.function, description: '读取文件' },
        })))
        const chunk = {
          id: 'offline', object: 'chat.completion.chunk', created: 0, model: model.id,
          choices: [{ index: 0, delta: { role: 'assistant', content: '兼容验证成功' }, finish_reason: 'stop' }],
        }
        return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
          headers: { 'content-type': 'text/event-stream' },
        })
      }, { preconnect: () => {} }),
    }).result()
    expect(calls).toBe(1)
    expect(result.stopReason).toBe('stop')
    expect(result.content).toContainEqual({ type: 'text', text: '兼容验证成功' })
  })

  test('Given 真实 Pi Agent 和请求扩展 When 执行工具并续接 Then 两轮 HTTP 都明确发送 none', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'proma-highway-agent-'))
    const agentDir = join(directory, 'agent')
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: 'off' })
    const modelRuntime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(), modelsPath: null,
      modelsStorePath: join(directory, 'models-store.json'), allowModelNetwork: false, refreshOnCreate: false,
    })
    await modelRuntime.setRuntimeApiKey('openai', 'offline-test-key')
    const model: Model<'openai-completions'> = {
      id: 'gpt-6.1-sol', name: 'gpt-6.1-sol', provider: 'openai', api: 'openai-completions',
      baseUrl, reasoning: true, compat: { supportsReasoningEffort: true },
      input: ['text'], contextWindow: 64_000, maxTokens: 512,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }
    const resourceLoader = new DefaultResourceLoader({
      cwd: directory, agentDir, settingsManager, ...createPromaManagedResourceLoaderOptions(),
      noPromptTemplates: true, noThemes: true, systemPromptOverride: () => '离线工具验证',
      extensionFactories: [createOpenAIChatToolCompatibilityExtension(baseUrl)],
    })
    let session: Awaited<ReturnType<typeof createAgentSession>>['session'] | undefined
    let calls = 0
    let executions = 0
    try {
      await resourceLoader.reload()
      session = (await createAgentSession({
        cwd: directory, agentDir, modelRuntime, model, settingsManager, resourceLoader,
        thinkingLevel: 'high', noTools: 'builtin',
        sessionManager: SessionManager.create(directory, join(directory, 'sessions')),
        customTools: [defineTool({
          name: 'read_file', label: '离线读取', description: '返回测试内容，不访问用户文件',
          parameters: Type.Object({}),
          async execute() {
            executions++
            return { content: [{ type: 'text', text: 'offline-tool-result' }], details: {} }
          },
        })],
      })).session
      // 保留真实 Agent loop、扩展 hook 和 SDK，只替换最终 fetch，禁止访问公网。
      session.agent.streamFunction = (requestModel, context, options) => streamSimple(requestModel, context, {
        ...options, apiKey: 'offline-test-key', maxRetries: 0,
        fetch: Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
          const request = new Request(input, init)
          const body = await request.json() as Record<string, unknown>
          calls++
          expect(request.url).toBe(`${baseUrl}/chat/completions`)
          expect(body.model).toBe('gpt-6.1-sol')
          expect(body.reasoning_effort).toBe('none')
          expect(body.tools).toBeArray()
          if (calls === 2) {
            expect(body.messages).toContainEqual({
              role: 'tool', tool_call_id: 'offline-tool', content: 'offline-tool-result',
            })
          }
          const chunk = {
            id: `offline-${calls}`, object: 'chat.completion.chunk', created: 0, model: model.id,
            choices: [{
              index: 0,
              delta: calls === 1
                ? { role: 'assistant', tool_calls: [{ index: 0, id: 'offline-tool', type: 'function', function: { name: 'read_file', arguments: '{}' } }] }
                : { role: 'assistant', content: '工具续接验证成功' },
              finish_reason: calls === 1 ? 'tool_calls' : 'stop',
            }],
          }
          return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
            headers: { 'content-type': 'text/event-stream' },
          })
        }, { preconnect: () => {} }),
      })
      await session.prompt('执行离线工具验证')
      expect(calls).toBe(2)
      expect(executions).toBe(1)
      expect(session.agent.state.messages.some((message) => message.role === 'assistant'
        && message.content.some((block) => block.type === 'text' && block.text === '工具续接验证成功'))).toBe(true)
    } finally {
      session?.dispose()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
