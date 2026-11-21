import { describe, expect, test } from 'bun:test'
import type { SDKMessage, SDKToolUseBlock, SDKUserMessage } from '@proma/shared'
import { areToolRenderPropsEqual, getToolMessageIndex } from './tool-message-index'

const tool: SDKToolUseBlock = { type: 'tool_use', id: 'read-1', name: 'Read', input: {} }
function result(text: string, isError = false): SDKMessage {
  return {
    type: 'user', uuid: text, session_id: 's', parent_tool_use_id: null,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: tool.id, content: text, is_error: isError }] },
  } as SDKMessage
}
function text(value: string): SDKMessage {
  return { type: 'assistant', message: { content: [{ type: 'text', text: value }] } } as SDKMessage
}

describe('R1 工具结果索引与渲染隔离', () => {
  test('纯文本增量不重建同一工具结果，也不唤醒旧工具块', () => {
    const completed = result('done')
    const previous = [completed, text('a')]
    const next = [completed, text('ab')]
    expect(getToolMessageIndex(previous).results.get(tool.id)).toBe(getToolMessageIndex(next).results.get(tool.id))
    expect(areToolRenderPropsEqual({ block: tool, allMessages: previous }, { block: tool, allMessages: next })).toBe(true)
    expect(getToolMessageIndex(next)).toBe(getToolMessageIndex(next))
  })
  test('迟到的工具结果与错误结果替换必须唤醒工具块', () => {
    const waiting = { block: tool, allMessages: [text('a')] }
    const completed = { block: tool, allMessages: [result('done')] }
    const failed = { block: tool, allMessages: [result('failed', true)] }
    expect(areToolRenderPropsEqual(waiting, completed)).toBe(false)
    expect(areToolRenderPropsEqual(completed, failed)).toBe(false)
    expect(getToolMessageIndex(failed.allMessages).results.get(tool.id)?.isError).toBe(true)
  })
  test('展开的子代理不能漏掉内部工具结果变化', () => {
    const childBlocks = [tool]
    const parent: SDKToolUseBlock = { ...tool, id: 'agent', name: 'Agent' }
    expect(areToolRenderPropsEqual(
      { block: parent, childBlocks, allMessages: [] },
      { block: parent, childBlocks, allMessages: [result('done')] },
    )).toBe(false)
  })
  test('重复 ID 保持首条结果语义，替换数组不能残留已移除结果', () => {
    expect(getToolMessageIndex([result('first'), result('second')]).results.get(tool.id)?.result).toBe('first')
    expect(getToolMessageIndex([]).results.has(tool.id)).toBe(false)
  })
  test('子代理用量到达必须打破缓存', () => {
    const notification = {
      type: 'system', subtype: 'task_notification', tool_use_id: tool.id,
      usage: { duration_ms: 50, total_tokens: 100, tool_uses: 2 },
    } as SDKMessage
    expect(areToolRenderPropsEqual(
      { block: tool, allMessages: [] },
      { block: tool, allMessages: [notification] },
    )).toBe(false)
    expect(getToolMessageIndex([notification]).subAgents.get(tool.id)?.totalTokens).toBe(100)
  })
  test('流结束、路径变化和工具输入变化不能被 memo 隐藏', () => {
    const previous = { block: tool, allMessages: [result('done')], isStreaming: true, basePath: '/first' }
    expect(areToolRenderPropsEqual(previous, { ...previous, isStreaming: false })).toBe(false)
    expect(areToolRenderPropsEqual(previous, { ...previous, basePath: '/second' })).toBe(false)
    expect(areToolRenderPropsEqual(previous, { ...previous, block: { ...tool, input: { path: '/new' } } })).toBe(false)
  })
  test('数组工具结果仅提取文本，保持换行且不泄露图片块', () => {
    const message = result('unused') as SDKUserMessage
    message.message!.content = [{
      type: 'tool_result', tool_use_id: tool.id,
      content: [{ type: 'text', text: 'first' }, { type: 'image', source: {} }, { type: 'text', text: 'second' }],
    }]
    expect(getToolMessageIndex([message]).results.get(tool.id)?.result).toBe('first\nsecond')
  })
})
