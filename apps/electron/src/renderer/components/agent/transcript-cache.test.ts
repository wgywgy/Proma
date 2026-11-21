import { describe, expect, test } from 'bun:test'
import type { SDKAssistantMessage, SDKMessage, SDKUserMessage } from '@proma/shared'
import { groupIntoTurns } from '@proma/session-core'
import { createMessageGroupRenderCache, groupMessagesForRendering } from './message-group-rendering'
import { createToolMessageProjection, mergeTranscriptMessages, prepareTranscriptHistory } from './transcript-cache'

const key = (message: SDKMessage) => `${message.type}:${(message as Record<string, unknown>).uuid}`
function user(id: string, value = id): SDKUserMessage {
  return {
    type: 'user', uuid: id, session_id: 's', parent_tool_use_id: null,
    message: { role: 'user', content: [{ type: 'text', text: value }] },
  } as SDKUserMessage
}
function assistant(id: string, value = id): SDKAssistantMessage {
  return {
    type: 'assistant', uuid: id, session_id: 's', parent_tool_use_id: null,
    message: { role: 'assistant', content: [{ type: 'text', text: value }] },
  } as SDKAssistantMessage
}

describe('R3 稳定历史与活动数据缓存', () => {
  test('live 替换历史同 UUID，保持原位置；无 UUID 消息不误去重', () => {
    const first = user('u')
    const old = assistant('a', 'old')
    const noId = { type: 'result', result: 'done' } as SDKMessage
    const history = prepareTranscriptHistory([first, old, noId, noId], key)
    const next = assistant('a', 'new')
    const appended = assistant('b')
    const merged = mergeTranscriptMessages(history, [next, appended], key)
    expect(merged.messages).toEqual([first, next, noId, noId, appended])
    expect(merged.stablePrefix.length).toBe(1)
    expect(history.messages[1]).toBe(old)
  })
  test('重复 live UUID 使用最后快照，通知索引不丢失也不重复', () => {
    const notification = { type: 'system', subtype: 'task_notification', uuid: 'n' } as SDKMessage
    const history = prepareTranscriptHistory([user('u'), notification], key)
    const newer = { ...notification, usage: { total_tokens: 2 } } as SDKMessage
    const merged = mergeTranscriptMessages(history, [newer, newer, assistant('a')], key)
    expect(merged.notifications).toEqual([newer])
    expect(merged.messages.length).toBe(3)
  })
  test('纯 live 增量不重新计算持久化消息的 key', () => {
    const history = prepareTranscriptHistory([user('u'), assistant('a')], key)
    let keyCalls = 0
    mergeTranscriptMessages(history, [assistant('new')], (message) => { keyCalls++; return key(message) })
    expect(keyCalls).toBe(1)
  })
  test('稳定前缀命中后，不再逐条访问历史消息数组', () => {
    const history = prepareTranscriptHistory(Array.from({ length: 1000 }, (_, i) => i % 2 === 0 ? user(String(i)) : assistant(String(i))), key)
    const first = mergeTranscriptMessages(history, [user('active'), assistant('tail', 'a')], key)
    const warm = groupMessagesForRendering(first.messages, undefined, true, createMessageGroupRenderCache(), first.stablePrefix)
    const next = mergeTranscriptMessages(history, [first.messages[1000]!, assistant('tail', 'ab')], key)
    let historicalReads = 0
    const observed = new Proxy(next.messages, {
      get(target, property, receiver) {
        if (typeof property === 'string' && /^\d+$/.test(property) && Number(property) < 1000) historicalReads++
        return Reflect.get(target, property, receiver)
      },
    })
    const rendered = groupMessagesForRendering(observed, undefined, true, warm.cache, next.stablePrefix)
    expect(historicalReads).toBe(0)
    expect(rendered.groups).toEqual(groupIntoTurns(next.messages))
    expect(observed.length).toBe(1002)
  })
  test('历史前缀被 live 替换时必须失效，输出与完整分组一致', () => {
    const history = prepareTranscriptHistory([user('u1'), assistant('a1'), user('u2')], key)
    const first = mergeTranscriptMessages(history, [assistant('a2', 'a')], key)
    const warm = groupMessagesForRendering(first.messages, undefined, true, createMessageGroupRenderCache(), first.stablePrefix)
    const next = mergeTranscriptMessages(history, [assistant('a1', 'replaced'), assistant('a2', 'ab')], key)
    const rendered = groupMessagesForRendering(next.messages, undefined, true, warm.cache, next.stablePrefix)
    expect(rendered.groups).toEqual(groupIntoTurns(next.messages))
    expect(rendered.cache.prefixGroups).not.toBe(warm.cache.prefixGroups)
  })
  test('历史加载、切换模型、终态刷新仍与完整分组一致', () => {
    const first = [user('u'), assistant('a')]
    const warm = groupMessagesForRendering(first, 'model-a', true, createMessageGroupRenderCache())
    const refreshed = [user('older'), assistant('older-a'), ...first]
    for (const streaming of [true, false]) {
      expect(groupMessagesForRendering(refreshed, 'model-b', streaming, warm.cache).groups).toEqual(groupIntoTurns(refreshed, 'model-b'))
    }
  })
  test('正文变化不重算任务投影，工具输入变化与删除必须失效', () => {
    const project = createToolMessageProjection()
    const tool = { type: 'tool_use' as const, id: 't', name: 'TaskCreate', input: { subject: 'work' } }
    const first = assistant('a')
    first.message.content = [tool, { type: 'text', text: 'a' }]
    const snapshot = project([first])
    const delta = { ...first, message: { ...first.message, content: [tool, { type: 'text' as const, text: 'ab' }] } }
    expect(project([delta])).toBe(snapshot)
    const changed = { ...delta, message: { ...delta.message, content: [{ ...tool, input: { subject: 'changed' } }] } }
    expect(project([changed])).not.toBe(snapshot)
    expect(project([])).toEqual([])
  })
  test('子代理归属改变不能复用旧任务投影', () => {
    const project = createToolMessageProjection()
    const first = assistant('a')
    const snapshot = project([first])
    expect(project([{ ...first, parent_tool_use_id: 'agent' }])).not.toBe(snapshot)
  })
  test('运行代际与模型改变必须刷新任务投影', () => {
    const project = createToolMessageProjection()
    const first = { ...assistant('a'), _promaLiveRunGeneration: 1 }
    const snapshot = project([first])
    const nextRun = { ...first, _promaLiveRunGeneration: 2 }
    const nextSnapshot = project([nextRun])
    expect(nextSnapshot).not.toBe(snapshot)
    expect(project([{ ...nextRun, message: { ...nextRun.message, model: 'new-model' } }])).not.toBe(nextSnapshot)
  })
})
