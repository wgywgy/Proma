import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { AssistantMessage, TextContent } from '@earendil-works/pi-ai'

/**
 * Pi 会过滤 aborted/error 回复。仅为后续请求保留可见正文，避免重新发送
 * 残缺工具调用、签名或 reasoning item；不修改磁盘历史和原始失败终态。
 */
export function preparePiInterruptedContext(messages: AgentMessage[]): AgentMessage[] {
  return messages.flatMap((message): AgentMessage[] => {
    if (message.role !== 'assistant' || (message.stopReason !== 'aborted' && message.stopReason !== 'error')) {
      return [message]
    }
    const text = message.content
      .filter((block): block is TextContent => block.type === 'text')
      .map((block) => block.text)
      .filter((value) => value.trim().length > 0)
      .join('\n\n')
    if (!text) return []

    // 使用新的纯文本内容，不携带 textSignature、responseId 等 provider 回放元数据。
    const preserved: AssistantMessage = {
      role: 'assistant',
      content: [{
        type: 'text',
        text: `[历史回复因${message.stopReason === 'aborted' ? '中断' : '失败'}而未完成；以下仅为已生成的部分正文，不代表任务或工具执行成功。]\n${text}`,
      }],
      api: message.api,
      provider: message.provider,
      model: message.model,
      usage: message.usage,
      stopReason: 'stop',
      timestamp: message.timestamp,
    }
    return [preserved]
  })
}
