import { afterEach, describe, expect, test } from 'bun:test'
import type { Model } from '@earendil-works/pi-ai'
import { streamSimple } from '@earendil-works/pi-ai/compat'
import {
  billionContextConversationId, connectPiBillionContext,
  testBillionContextConnection, type BillionContextModel,
} from './pi-billion-context'

const servers: Bun.Server<undefined>[] = []
function proxy(handler: (request: Request) => Response | Promise<Response>): string {
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: handler })
  servers.push(server)
  return `http://127.0.0.1:${server.port}`
}
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true)
})

const model: BillionContextModel = {
  id: 'bili-test', api: 'openai-completions',
  baseUrl: 'https://example.invalid/v1', contextWindow: 100_000, maxTokens: 512,
}
function managementResponse(request: Request): Response | undefined {
  if (new URL(request.url).pathname.startsWith('/__bili/')) return Response.json({ ok: true })
}

describe('Pi billion-context 请求级接入', () => {
  test('Given 开关关闭 When 连接 Then 不发任何请求且兼容原协议', async () => {
    expect(await connectPiBillionContext(
      { enabled: false, proxyUrl: 'not-an-origin' }, { ...model, api: 'openai-codex-responses' }, 'session',
    )).toBeUndefined()
  })

  test('Given 同一会话重开和不同会话 When 计算标识 Then 稳定且互不混用', () => {
    expect(billionContextConversationId('session-a')).toBe('proma:session-a')
    expect(billionContextConversationId('session-a')).not.toBe(billionContextConversationId('session-b'))
    expect(() => billionContextConversationId('session\ninjected')).toThrow()
    expect(billionContextConversationId('s'.repeat(250)).length).toBe(256)
    expect(() => billionContextConversationId('s'.repeat(251))).toThrow()
  })

  test('Given 无效模型限制 When 接入 Then 在联网前拒绝', async () => {
    for (const invalid of [
      { ...model, id: 'm'.repeat(257) },
      { ...model, contextWindow: 0 },
      { ...model, maxTokens: Number.NaN },
    ]) {
      await expect(connectPiBillionContext(
        { enabled: true, proxyUrl: 'http://127.0.0.1:1' }, invalid, 'session',
      )).rejects.toThrow('有效的模型')
    }
  })

  for (const status of [200, 500]) {
    test(`Given 窗口上报未确认 HTTP ${status} When 接入 Then 拒绝而非直连`, async () => {
      let modelCalls = 0
      const origin = proxy((request) => {
        const path = new URL(request.url).pathname
        if (path === '/__bili/health') return Response.json({ ok: true })
        if (path === '/__bili/plugin/runtime-info') return Response.json({ ok: false }, { status })
        modelCalls++
        return new Response()
      })
      await expect(connectPiBillionContext({ enabled: true, proxyUrl: origin }, model, 'session'))
        .rejects.toThrow('未降级直连')
      expect(modelCalls).toBe(0)
    })
  }

  test('Given 连接准备已取消 When 接入 Then 不继续上报或请求模型', async () => {
    let calls = 0
    const origin = proxy(() => {
      calls++
      return Response.json({ ok: true })
    })
    const abort = new AbortController()
    abort.abort()
    await expect(connectPiBillionContext(
      { enabled: true, proxyUrl: origin }, model, 'session', { signal: abort.signal },
    )).rejects.toThrow()
    expect(calls).toBe(0)
  })

  test('Given 并发会话 When 转发 Then 各自携带独立标识', async () => {
    const identities: string[] = []
    const origin = proxy((request) => {
      const response = managementResponse(request)
      if (response) return response
      identities.push(request.headers.get('x-acp-session')!)
      return new Response('ok')
    })
    const connections = await Promise.all(['a', 'b'].map((id) =>
      connectPiBillionContext({ enabled: true, proxyUrl: origin }, model, id)))
    try {
      await Promise.all(connections.map(async (connection) =>
        (await connection!.fetch(`${model.baseUrl}/messages`)).text()))
      expect(identities.sort()).toEqual(['proma:a', 'proma:b'])
    } finally {
      await Promise.all(connections.map((connection) => connection?.close()))
    }
  })

  for (const api of ['openai-codex-responses', 'google-vertex', 'bedrock-converse-stream']) {
    test(`Given 未接入协议 ${api} When 启用 Then 明确拒绝而非直连`, async () => {
      await expect(connectPiBillionContext(
        { enabled: true, proxyUrl: 'http://127.0.0.1:8787' }, { ...model, api }, 'session',
      )).rejects.toThrow('暂不支持')
    })
  }

  test('Given 有健康代理 When 准备 Then 上报真实模型限制而非伪装原生插件', async () => {
    let report: unknown
    const origin = proxy(async (request) => {
      if (new URL(request.url).pathname === '/__bili/plugin/runtime-info') {
        report = await request.json()
        expect(request.headers.has('x-bili-plugin')).toBe(false)
      }
      return Response.json({ ok: true })
    })
    const connection = await connectPiBillionContext({ enabled: true, proxyUrl: origin }, model, 'session-a')
    try {
      expect(report).toEqual({
        agent: 'proma', source: 'proma', conversationId: 'proma:session-a',
        model: model.id, baseURL: model.baseUrl,
        contextWindow: 100_000, maxOutput: 512,
      })
    } finally {
      await connection?.close()
    }
  })

  for (const api of ['anthropic-messages', 'openai-completions', 'openai-responses']) {
    test(`Given ${api} 请求 When 转发 Then 保留 body 和认证且剥离错误模式标记`, async () => {
      let seen = false
      const origin = proxy(async (request) => {
        const response = managementResponse(request)
        if (response) return response
        seen = true
        expect(request.url).toBe(`${origin}/bili/https://example.invalid/v1/messages?request=1`)
        expect(request.method).toBe('POST')
        expect(request.headers.get('authorization')).toBe('Bearer offline-test-key')
        expect(request.headers.get('x-api-key')).toBe('offline-test-key')
        expect(request.headers.get('x-acp-session')).toBe('proma:session-a')
        expect(request.headers.has('x-bili-plugin')).toBe(false)
        expect(request.headers.has('x-session-affinity')).toBe(false)
        expect(await request.text()).toBe('{"messages":[{"role":"user","content":"原始请求"}]}')
        return new Response('data: unchanged\n\n', { headers: { 'content-type': 'text/event-stream' } })
      })
      const connection = await connectPiBillionContext(
        { enabled: true, proxyUrl: origin }, { ...model, api }, 'session-a',
      )
      try {
        const response = await connection!.fetch(`${model.baseUrl}/messages?request=1`, {
          method: 'POST',
          headers: {
            authorization: 'Bearer offline-test-key', 'x-api-key': 'offline-test-key',
            'X-Bili-Plugin': 'pi', 'x-bili-plugin-conversation': 'foreign-session',
            'x-session-affinity': 'foreign-session',
          },
          body: '{"messages":[{"role":"user","content":"原始请求"}]}',
        })
        expect(await response.text()).toBe('data: unchanged\n\n')
        expect(seen).toBe(true)
      } finally {
        await connection?.close()
      }
    })
  }

  test('Given 其他渠道地址 When 请求 Then 不泄露认证到代理', async () => {
    let modelRequests = 0
    const origin = proxy((request) => {
      const response = managementResponse(request)
      if (response) return response
      modelRequests++
      return new Response()
    })
    const connection = await connectPiBillionContext({ enabled: true, proxyUrl: origin }, model, 'session')
    try {
      await expect(connection!.fetch('https://foreign.invalid/messages')).rejects.toThrow('不属于')
      expect(modelRequests).toBe(0)
    } finally {
      await connection?.close()
    }
  })

  test('Given 已取消请求 When 转发 Then 保留取消信号', async () => {
    const origin = proxy((request) => managementResponse(request) ?? new Response('unexpected'))
    const connection = await connectPiBillionContext({ enabled: true, proxyUrl: origin }, model, 'session')
    try {
      const abort = new AbortController()
      abort.abort()
      await expect(connection!.fetch(`${model.baseUrl}/chat/completions`, {
        method: 'POST', body: '{}', signal: abort.signal,
      })).rejects.toThrow()
    } finally {
      await connection?.close()
    }
  })

  test('Given 代理返回 503 When 转发 Then 保留错误而非重新投到原上游', async () => {
    const origin = proxy((request) => managementResponse(request) ?? new Response('unavailable', { status: 503 }))
    const connection = await connectPiBillionContext({ enabled: true, proxyUrl: origin }, model, 'session')
    try {
      const response = await connection!.fetch(`${model.baseUrl}/messages`)
      expect(response.status).toBe(503)
      expect(await response.text()).toBe('unavailable')
    } finally {
      await connection?.close()
    }
  })

  test('Given 失效健康状态 When 接入 Then 明确失败且关闭连接', async () => {
    const origin = proxy(() => Response.json({ ok: false }))
    await expect(connectPiBillionContext({ enabled: true, proxyUrl: origin }, model, 'session'))
      .rejects.toThrow('未降级直连')
    expect((await testBillionContextConnection(origin)).success).toBe(false)
  })

  test('Given 管理接口超大响应 When 检测 Then 拒绝读取全量', async () => {
    const origin = proxy(() => new Response('x'.repeat(32 * 1024 + 1)))
    expect(await testBillionContextConnection(origin)).toEqual({
      success: false, message: 'billion-context 管理接口响应超过 32 KiB',
    })
  })

  test('Given 真实 Pi HTTP provider When 注入 fetch Then 实际模型请求经过代理并解析 SSE', async () => {
    let calls = 0
    const origin = proxy((request) => {
      const response = managementResponse(request)
      if (response) return response
      calls++
      expect(request.url).toBe(`${origin}/bili/https://example.invalid/v1/chat/completions`)
      expect(request.headers.get('x-acp-session')).toBe('proma:sdk-session')
      const chunks = [
        { id: 'offline', object: 'chat.completion.chunk', created: 0, model: model.id,
          choices: [{ index: 0, delta: { role: 'assistant', content: '代理接入成功' }, finish_reason: null }] },
        { id: 'offline', object: 'chat.completion.chunk', created: 0, model: model.id,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 8, completion_tokens: 1, total_tokens: 9 } },
      ]
      return new Response(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`, {
        headers: { 'content-type': 'text/event-stream' },
      })
    })
    const connection = await connectPiBillionContext({ enabled: true, proxyUrl: origin }, model, 'sdk-session')
    const sdkModel: Model<'openai-completions'> = {
      ...model, api: 'openai-completions', name: model.id, provider: 'openai', reasoning: false,
      input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }
    try {
      const stream = streamSimple(sdkModel, {
        messages: [{ role: 'user', content: '离线验证', timestamp: 0 }],
      }, { apiKey: 'offline-test-key', fetch: connection!.fetch, maxRetries: 0 })
      const result = await stream.result()
      expect(result.stopReason).toBe('stop')
      expect(result.content).toContainEqual({ type: 'text', text: '代理接入成功' })
      expect(calls).toBe(1)
    } finally {
      await connection?.close()
    }
  })
})
