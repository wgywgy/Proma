import { describe, expect, test } from 'bun:test'
import { createBatchedStreamController } from './batched-stream'

function harness(initialContent = '') {
  const published: string[] = []
  const pending = new Set<() => void>()
  let scheduled = 0
  const controller = createBatchedStreamController({
    initialContent,
    publish: (content) => published.push(content),
    schedule: (callback, delay) => {
      expect(delay).toBe(100)
      scheduled++
      pending.add(callback)
      return () => { pending.delete(callback) }
    },
  })
  return {
    controller, published, pending,
    scheduled: () => scheduled,
    tick: () => { const callbacks = [...pending]; pending.clear(); callbacks.forEach((callback) => callback()) },
  }
}

describe('R2 流式 Markdown 固定窗口更新', () => {
  test('同一窗口的多个增量只安排一次更新，并显示最新完整 Unicode 文本', () => {
    const h = harness()
    h.controller.update('中', true)
    h.controller.update('中文', true)
    h.controller.update('中文👨‍👩‍👧‍👦', true)
    expect(h.scheduled()).toBe(1)
    expect(h.published).toEqual([])
    h.tick()
    expect(h.published).toEqual(['中文👨‍👩‍👧‍👦'])
    expect(h.pending.size).toBe(0)
  })
  test('持续输出不能因反复延后定时器而饿死显示', () => {
    const h = harness()
    h.controller.update('a', true)
    h.controller.update('ab', true)
    h.tick()
    h.controller.update('abc', true)
    h.tick()
    expect(h.published).toEqual(['ab', 'abc'])
    expect(h.scheduled()).toBe(2)
  })
  test('结束立即显示终态并取消排队更新', () => {
    const h = harness()
    h.controller.update('part', true)
    h.controller.update('part-final', false)
    expect(h.published).toEqual(['part-final'])
    expect(h.pending.size).toBe(0)
    h.tick()
    expect(h.published).toEqual(['part-final'])
  })
  test('重置不能把上一轮排队文本带入新输出', () => {
    const h = harness()
    h.controller.update('old', true)
    h.controller.update('new', true)
    expect(h.published).toEqual(['new'])
    expect(h.pending.size).toBe(0)
    h.controller.update('new-more', true)
    h.tick()
    expect(h.published).toEqual(['new', 'new-more'])
  })
  test('卸载取消任务，重复内容不产生空转', () => {
    const h = harness('history')
    h.controller.update('history', true)
    expect(h.scheduled()).toBe(0)
    h.controller.update('history-more', true)
    h.controller.dispose()
    h.tick()
    expect(h.published).toEqual([])
  })
})
