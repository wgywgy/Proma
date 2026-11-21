import { describe, expect, test } from 'bun:test'
import { createProgressScrollController } from './progress-scroll'

function harness() {
  let top = 0
  let height = 1000
  let reads = 0
  let writes = 0
  let reachable = true
  let mounted = true
  let nextId = 0
  const frames = new Map<number, FrameRequestCallback>()
  const viewport = {
    get scrollHeight() { reads++; return height },
    get clientHeight() { reads++; return 100 },
    get scrollTop() { reads++; return top },
    set scrollTop(value: number) { writes++; if (reachable) top = Math.max(0, Math.min(height - 100, value)) },
  }
  const controller = createProgressScrollController({
    getViewport: () => mounted ? viewport : null,
    canResume: (metrics) => metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight <= 24,
    requestFrame: (callback) => { frames.set(++nextId, callback); return nextId },
    cancelFrame: (id) => { frames.delete(id) },
  })
  return {
    controller, frames,
    reads: () => reads,
    writes: () => writes,
    top: () => top,
    setTop: (value: number) => { top = value },
    setHeight: (value: number) => { height = value },
    blockWrites: () => { reachable = false },
    unmount: () => { mounted = false },
    tick: () => {
      const pending = [...frames.values()]
      frames.clear()
      pending.forEach((callback) => callback(0))
    },
  }
}

describe('R4 滚动测量与动画合并', () => {
  test('多个内容和 resize 事件只排一帧，事件入口不读取布局', () => {
    const h = harness()
    h.controller.request()
    h.controller.request()
    h.controller.request()
    expect(h.frames.size).toBe(1)
    expect(h.reads()).toBe(0)
    h.tick()
    expect(h.writes()).toBe(1)
    expect(h.top()).toBe(852)
  })
  test('平滑滚动到达底部后停止，不保留空转帧', () => {
    const h = harness()
    h.controller.request()
    let ticks = 0
    while (h.frames.size && ticks++ < 100) h.tick()
    expect(h.top()).toBe(900)
    expect(h.frames.size).toBe(0)
    expect(ticks).toBeLessThan(100)
  })
  test('手动上滚取消跟随，只有回到底部才恢复', () => {
    const h = harness()
    h.controller.request()
    h.controller.stop()
    expect(h.frames.size).toBe(0)
    h.controller.request()
    expect(h.frames.size).toBe(0)
    h.controller.onScroll()
    h.tick()
    expect(h.writes()).toBe(0)
    h.setTop(890)
    h.controller.onScroll()
    h.tick()
    expect(h.top()).toBeGreaterThan(890)
  })
  test('内容收缩使用新目标，夹紧而不可达的位置不能无限排帧', () => {
    const h = harness()
    h.controller.request()
    h.tick()
    h.setHeight(200)
    h.tick()
    expect(h.top()).toBe(100)
    h.blockWrites()
    h.setHeight(1000)
    h.controller.request()
    h.tick()
    expect(h.frames.size).toBe(0)
  })
  test('卸载或停止后不执行残留滚动，新运行可以恢复', () => {
    const h = harness()
    h.controller.request()
    h.controller.dispose()
    h.tick()
    expect(h.writes()).toBe(0)
    h.controller.stop()
    h.controller.resume()
    expect(h.frames.size).toBe(1)
    h.unmount()
    h.tick()
    expect(h.writes()).toBe(0)
    expect(h.frames.size).toBe(0)
  })
})
