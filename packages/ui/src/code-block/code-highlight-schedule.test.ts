import { describe, expect, test } from 'bun:test'
import { scheduleCodeHighlight } from './code-highlight-schedule'

function harness(initiallyReady = true) {
  let now = 0
  let ready = initiallyReady
  let lastRunAt = -Infinity
  let cancel = () => {}
  const listeners = new Set<() => void>()
  const timers = new Map<() => void, number>()
  const calls: Array<{ code: string; at: number }> = []

  return {
    calls,
    update(code: string) {
      cancel()
      cancel = scheduleCodeHighlight({
        intervalMs: 80,
        lastRunAt,
        onReady: (callback) => {
          if (ready) callback()
          else listeners.add(callback)
          return () => { listeners.delete(callback) }
        },
        highlight: (at) => {
          lastRunAt = at
          calls.push({ code, at })
        },
        clock: {
          now: () => now,
          schedule: (callback, delayMs) => {
            timers.set(callback, now + delayMs)
            return () => { timers.delete(callback) }
          },
        },
      })
    },
    advanceTo(at: number) {
      now = at
      for (const [callback, deadline] of timers) {
        if (deadline > now) continue
        timers.delete(callback)
        callback()
      }
    },
    markReady() {
      ready = true
      for (const callback of listeners) callback()
      listeners.clear()
    },
    dispose() { cancel() },
  }
}

describe('流式代码高亮计算', () => {
  test('节流期间不计算，中途更新不延后期限且只计算最新输入', () => {
    const h = harness()
    h.update('a')
    h.advanceTo(10)
    h.update('ab')
    h.advanceTo(79)
    h.update('abc')
    expect(h.calls).toEqual([{ code: 'a', at: 0 }])
    h.advanceTo(80)
    expect(h.calls).toEqual([{ code: 'a', at: 0 }, { code: 'abc', at: 80 }])
    h.advanceTo(160)
    expect(h.calls).toHaveLength(2)
  })

  test('高亮器就绪前替换输入，初始化后只计算最新输入', () => {
    const h = harness(false)
    h.update('old')
    h.update('new')
    expect(h.calls).toEqual([])
    h.markReady()
    expect(h.calls).toEqual([{ code: 'new', at: 0 }])
  })

  test('卸载时取消尾部计算，已完成的高亮不重复', () => {
    const h = harness()
    h.update('a')
    h.advanceTo(10)
    h.update('ab')
    h.dispose()
    h.advanceTo(80)
    expect(h.calls).toEqual([{ code: 'a', at: 0 }])
  })
})
