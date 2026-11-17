import { Agent, fetch as undiciFetch } from 'undici'
import type { RequestInit as UndiciRequestInit } from 'undici'
import type { FetchFunction } from '@earendil-works/pi-ai'
import type { BillionContextConnectionResult, BillionContextSettings } from '@proma/shared'
import { normalizeBillionContextOrigin } from '../billion-context-settings-service'
import { closePiRequestProxyDispatcher } from './pi-request-proxy'

const MANAGEMENT_TIMEOUT_MS = 3_000
const MANAGEMENT_MAX_BYTES = 32 * 1024
const SUPPORTED_APIS = new Set(['anthropic-messages', 'openai-completions', 'openai-responses'])
// 仅使用普通代理协议；原生插件标记会让代理等待客户端执行 ACP 工具。
const IDENTITY_HEADERS = [
  'x-bili-plugin', 'x-bili-plugin-conversation', 'x-claude-code-session-id',
  'x-grok-session-id', 'x-grok-conv-id', 'x-mavis-session-id', 'agent-session-id',
  'x-opencode-session-id', 'x-session-affinity',
]

export interface BillionContextModel {
  id: string
  api: string
  baseUrl: string
  contextWindow: number
  maxTokens: number
}

export interface BillionContextConnection {
  fetch: FetchFunction
  close: () => Promise<void>
}

interface ManagementRequestOptions {
  method?: string
  headers?: Record<string, string>
  body?: string
  signal?: AbortSignal
}

export function billionContextConversationId(sessionId: string): string {
  if (!sessionId || sessionId.length > 250 || /[^\x21-\x7e]/.test(sessionId)) {
    throw new Error('billion-context 需要有效的 Pi 会话标识')
  }
  return `proma:${sessionId}`
}

async function managementRequest(
  dispatcher: Agent,
  origin: string,
  path: string,
  init: ManagementRequestOptions = {},
): Promise<unknown> {
  const response = await undiciFetch(`${origin}${path}`, {
    ...init,
    dispatcher,
    redirect: 'error',
    signal: init.signal
      ? AbortSignal.any([init.signal, AbortSignal.timeout(MANAGEMENT_TIMEOUT_MS)])
      : AbortSignal.timeout(MANAGEMENT_TIMEOUT_MS),
  })
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(`billion-context 管理接口返回 HTTP ${response.status}`)
  }
  const reader = response.body?.getReader()
  if (!reader) throw new Error('billion-context 管理接口返回空响应')
  const decoder = new TextDecoder()
  let text = ''
  let bytes = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > MANAGEMENT_MAX_BYTES) {
        await reader.cancel()
        throw new Error('billion-context 管理接口响应超过 32 KiB')
      }
      text += decoder.decode(chunk.value, { stream: true })
    }
    return JSON.parse(text + decoder.decode()) as unknown
  } finally {
    reader.releaseLock()
  }
}

async function assertHealthy(dispatcher: Agent, origin: string, signal?: AbortSignal): Promise<void> {
  const health = await managementRequest(dispatcher, origin, '/__bili/health', { signal })
  if (!health || typeof health !== 'object' || !('ok' in health) || health.ok !== true) {
    throw new Error('该地址未返回 billion-context 的有效健康状态')
  }
}

/** 显式检测不改变配置，也不启动代理。 */
export async function testBillionContextConnection(proxyUrl: string): Promise<BillionContextConnectionResult> {
  const dispatcher = new Agent()
  try {
    await assertHealthy(dispatcher, normalizeBillionContextOrigin(proxyUrl))
    return { success: true, message: 'billion-context 本地代理可用；这不代表已经发生压缩' }
  } catch (error) {
    return {
      success: false,
      message: error instanceof Error ? error.message : 'billion-context 连通性检测失败',
    }
  } finally {
    await closePiRequestProxyDispatcher(dispatcher)
  }
}

/**
 * 只重路由 Pi provider 的 HTTP 请求，不安装全局 fetch 或原生 Pi 插件。
 * 直连 dispatcher 确保本地 bili 不会被再次送进 Proma 的全局网络代理。
 */
export async function connectPiBillionContext(
  settings: BillionContextSettings,
  model: BillionContextModel,
  sessionId: string,
  options: { signal?: AbortSignal; httpIdleTimeoutMs?: number } = {},
): Promise<BillionContextConnection | undefined> {
  if (!settings.enabled) return undefined
  if (!SUPPORTED_APIS.has(model.api)) {
    throw new Error(`billion-context 首批暂不支持 ${model.api}，请关闭该开关或选择 HTTP API Key 渠道`)
  }
  const origin = normalizeBillionContextOrigin(settings.proxyUrl)
  const upstream = new URL(model.baseUrl)
  if (!['http:', 'https:'].includes(upstream.protocol) || upstream.username || upstream.password
    || upstream.origin === origin || upstream.pathname.includes('/bili/')) {
    throw new Error('billion-context 上游地址无效或已经经过代理，请保留渠道原始 Base URL')
  }
  if (!model.id || model.id.length > 256
    || ![model.contextWindow, model.maxTokens].every((value) => Number.isFinite(value) && value > 0)) {
    throw new Error('billion-context 需要有效的模型上下文窗口及输出上限')
  }
  const conversationId = billionContextConversationId(sessionId)
  const configuredTimeoutMs = options.httpIdleTimeoutMs ?? 300_000
  const timeoutMs = Number.isFinite(configuredTimeoutMs) && configuredTimeoutMs >= 0 ? configuredTimeoutMs : 300_000
  const dispatcher = new Agent({ headersTimeout: timeoutMs, bodyTimeout: timeoutMs })
  try {
    await assertHealthy(dispatcher, origin, options.signal)
    const report = await managementRequest(dispatcher, origin, '/__bili/plugin/runtime-info', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: options.signal,
      body: JSON.stringify({
        agent: 'proma', source: 'proma', conversationId,
        model: model.id, contextWindow: model.contextWindow, maxOutput: model.maxTokens,
        baseURL: model.baseUrl,
      }),
    })
    if (!report || typeof report !== 'object' || !('ok' in report) || report.ok !== true) {
      throw new Error('billion-context 未确认模型窗口和会话标识')
    }
    const routedFetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init)
      const url = new URL(request.url)
      if (url.origin !== upstream.origin) {
        throw new Error('billion-context 拒绝转发不属于当前模型渠道的请求')
      }
      const headers = new Headers(request.headers)
      for (const name of IDENTITY_HEADERS) headers.delete(name)
      headers.set('x-acp-session', conversationId)
      return await undiciFetch(`${origin}/bili/${url.href}`, {
        dispatcher, headers, redirect: 'error', method: request.method,
        signal: request.signal,
        // DOM 与 undici 的流类型声明不同；运行时原样转交，不把请求体读入内存。
        body: request.body as UndiciRequestInit['body'],
        duplex: 'half',
      }) as unknown as Response
    }) as FetchFunction
    return { fetch: routedFetch, close: () => closePiRequestProxyDispatcher(dispatcher) }
  } catch (error) {
    await closePiRequestProxyDispatcher(dispatcher)
    if (options.signal?.aborted) throw error
    throw new Error('billion-context 接入失败，请检查本地代理；未降级直连', { cause: error })
  }
}
