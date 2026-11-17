import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * HighwayAPI 的 gpt-6.1-sol 在 Chat Completions 中要求函数工具与推理互斥。
 * 在最终请求 hook 中明确关闭推理，兼容默认档位、历史会话及代理转发。
 */
export function withHighwayChatToolCompatibility(payload: unknown, baseUrl: string | undefined): unknown {
  if (!baseUrl || !isRecord(payload) || payload.model !== 'gpt-6.1-sol') return payload
  let url: URL
  try {
    url = new URL(baseUrl)
  } catch {
    return payload
  }
  if (url.hostname !== 'api.highwayapi.ai') return payload
  const tools = payload.tools
  if (!Array.isArray(tools) || !tools.some((tool: unknown) => isRecord(tool) && tool.type === 'function')) {
    return payload
  }
  if (payload.reasoning_effort === 'none') return payload
  return { ...payload, reasoning_effort: 'none' }
}

/** 只注册到 Chat Completions，避免把 reasoning_effort 注入 Responses 请求。 */
export function createOpenAIChatToolCompatibilityExtension(
  baseUrl: string | undefined,
): (pi: ExtensionAPI) => void {
  return (pi) => {
    pi.on('before_provider_request', (event) => {
      const updatedPayload = withHighwayChatToolCompatibility(event.payload, baseUrl)
      return updatedPayload === event.payload ? undefined : updatedPayload
    })
  }
}
