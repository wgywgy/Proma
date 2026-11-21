import { describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Type } from 'typebox'
import {
  VERSION, createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, defineTool,
} from '@earendil-works/pi-coding-agent'
import {
  InMemoryCredentialStore, PI_AI_VERSION, createAssistantMessageEventStream, getCurrentTools, type AssistantMessage,
} from '@earendil-works/pi-ai'
import { isRetryableAssistantError } from '@earendil-works/pi-ai/utils/retry'
import { createPromaManagedResourceLoaderOptions } from './pi-resource-loader-overrides'
import { BROWSER_ENABLE_TOOL_NAME, createBrowserToolPolicy } from './pi-browser-tool-policy'

function failedAssistant(errorMessage: string): AssistantMessage {
  return {
    role: 'assistant',
    content: [],
    api: 'openai-responses',
    provider: 'openai',
    model: 'upgrade-test',
    usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'error',
    errorMessage,
    timestamp: 0,
  }
}

describe('Pi 正式版升级', () => {
  test('Given 依赖已更新 When 加载 SDK Then 使用固定的正式版本', () => {
    expect(VERSION).toBe('1.5.2')
    expect(PI_AI_VERSION).toBe('1.5.2')
  })

  for (const message of [
    'stream_read_error',
    'stream ended before terminal event',
    'stream ended before a terminal response event',
    'unexpected non-whitespace character after JSON',
    'peer closed connection',
    'incomplete chunked read',
    'TypeError: Failed to fetch',
  ]) {
    test(`Given 暂时性网络错误 ${message} When 判断重试 Then 保留旧补丁能力`, () => {
      expect(isRetryableAssistantError(failedAssistant(message))).toBe(true)
    })
  }

  for (const message of ['insufficient_quota', 'billing limit reached', 'Invalid API key']) {
    test(`Given 非暂时性错误 ${message} When 判断重试 Then 不制造重复消耗`, () => {
      expect(isRetryableAssistantError(failedAssistant(message))).toBe(false)
    })
  }

  test('Given 受管会话 When 执行工具、断流重试并恢复历史 Then 不重复工具且保留完整输出', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'proma-pi-upgrade-'))
    const agentDir = join(directory, 'agent')
    mkdirSync(agentDir)
    // 哨兵只存在于测试临时目录；受管加载器不得读取这些环境式规则。
    writeFileSync(join(directory, 'AGENTS.md'), 'AMBIENT_CONTEXT_SENTINEL')
    writeFileSync(join(agentDir, 'APPEND_SYSTEM.md'), 'AMBIENT_APPEND_SENTINEL')
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
      cacheWarming: 'off',
      retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 },
    })
    const modelRuntime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      modelsStorePath: join(directory, 'models-store.json'),
      allowModelNetwork: false,
      refreshOnCreate: false,
    })
    const model = modelRuntime.getModels('openai')[0]
    if (!model) throw new Error('Pi 正式发布包缺少静态 OpenAI 模型')
    await modelRuntime.setRuntimeApiKey(model.provider, 'offline-test-key')
    const browserPolicy = createBrowserToolPolicy(['BrowserObserve'])
    const resourceLoader = new DefaultResourceLoader({
      cwd: directory,
      agentDir,
      settingsManager,
      ...createPromaManagedResourceLoaderOptions(),
      noPromptTemplates: true,
      noThemes: true,
      systemPromptOverride: () => browserPolicy.appendSystemPrompt('PROMA_MANAGED_PROMPT'),
    })
    let session: Awaited<ReturnType<typeof createAgentSession>>['session'] | undefined
    let resumed: typeof session
    let largeToolCalls = 0
    try {
      await resourceLoader.reload()
      const result = await createAgentSession({
        cwd: directory, agentDir, modelRuntime, model, settingsManager, resourceLoader,
        noTools: 'builtin',
        sessionManager: SessionManager.create(directory, join(directory, 'sessions')),
        customTools: [
          defineTool({
            name: BROWSER_ENABLE_TOOL_NAME, label: '加载浏览器', description: '测试加载入口',
            parameters: Type.Object({}),
            async execute() {
              if (!session) throw new Error('测试会话尚未就绪')
              return { content: [{ type: 'text', text: browserPolicy.enable(session) }], details: {} }
            },
          }),
          defineTool({
            name: 'BrowserObserve', label: '浏览器快照', description: '测试占位能力，不执行浏览器',
            parameters: Type.Object({}),
            async execute() { return { content: [{ type: 'text', text: 'snapshot' }], details: {} } },
          }),
          defineTool({
            name: 'LargeOutput', label: '大输出', description: '测试完整输出',
            parameters: Type.Object({}),
            async execute() {
              largeToolCalls++
              return { content: [{ type: 'text', text: 'x'.repeat(100_000) }], details: {} }
            },
          }),
        ],
      })
      session = result.session
      session.setActiveToolsByName(browserPolicy.initialActiveToolNames(session.getActiveToolNames()))
      expect(session.getActiveToolNames().sort()).toEqual([BROWSER_ENABLE_TOOL_NAME, 'LargeOutput'].sort())
      expect(session.systemPrompt).not.toContain('AMBIENT_')
      expect(settingsManager.getCacheWarmingMode()).toBe('off')

      const observed: { tools: string[]; toolText: string[] }[] = []
      // 替换最终 provider stream，真实 Agent loop 仍执行工具和持久化，但绝不请求公网模型。
      session.agent.streamFunction = (requestModel, context) => {
        observed.push({
          tools: getCurrentTools(context.messages).map((tool) => tool.name),
          toolText: context.messages.flatMap((message) => message.role === 'toolResult'
            ? message.content.filter((block) => block.type === 'text').map((block) => block.text)
            : []),
        })
        const toolName = observed.length === 1 ? BROWSER_ENABLE_TOOL_NAME : observed.length === 2 ? 'LargeOutput' : undefined
        const interrupted = observed.length === 3
        const message: AssistantMessage = {
          ...failedAssistant(interrupted ? 'stream_read_error' : ''),
          api: requestModel.api, provider: requestModel.provider, model: requestModel.id,
          stopReason: interrupted ? 'error' : toolName ? 'toolUse' : 'stop',
          errorMessage: interrupted ? 'stream_read_error' : undefined,
          content: interrupted ? [] : toolName
            ? [{ type: 'toolCall', id: `upgrade-tool-${observed.length}`, name: toolName, arguments: {} }]
            : [{ type: 'text', text: '离线回归完成' }],
        }
        const stream = createAssistantMessageEventStream()
        if (interrupted) stream.push({ type: 'error', reason: 'error', error: message })
        else stream.push({ type: 'done', reason: toolName ? 'toolUse' : 'stop', message })
        stream.end()
        return stream
      }
      await session.prompt('执行离线工具回归')
      expect(observed).toHaveLength(4)
      expect(largeToolCalls).toBe(1)
      expect(observed[0]!.tools).not.toContain('BrowserObserve')
      expect(observed[1]!.tools).toContain('BrowserObserve')
      expect(observed[1]!.tools).not.toContain(BROWSER_ENABLE_TOOL_NAME)
      expect(observed[2]!.toolText).toContain('x'.repeat(100_000))
      expect(observed[3]!.toolText).toContain('x'.repeat(100_000))
      expect(session.isStreaming).toBe(false)

      const sessionFile = session.sessionManager.getSessionFile()
      if (!sessionFile) throw new Error('离线回归未生成会话 artifact')
      session.dispose()
      resumed = (await createAgentSession({
        cwd: directory, agentDir, modelRuntime, model, settingsManager, resourceLoader,
        noTools: 'all',
        sessionManager: SessionManager.open(sessionFile),
      })).session
      expect(resumed.agent.state.messages.some((message) => message.role === 'toolResult')).toBe(true)
      expect(resumed.agent.state.messages.some((message) => message.role === 'toolResult'
        && message.content.some((block) => block.type === 'text' && block.text === 'x'.repeat(100_000)))).toBe(true)
      expect(resumed.agent.state.messages.some((message) => message.role === 'assistant'
        && message.content.some((block) => block.type === 'text' && block.text === '离线回归完成'))).toBe(true)
    } finally {
      resumed?.dispose()
      session?.dispose()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
