import { describe, expect, test } from 'bun:test'
import { createAgentIslandQuotaRefresh } from './agent-island-quota-refresh'

describe('灵动岛按需刷新额度', () => {
  test('合并并发请求，冷却期内不访问 provider', async () => {
    let now = 0
    const refresh = createAgentIslandQuotaRefresh(300, () => now)
    const pending = Promise.withResolvers<number>()
    const applied: number[] = []
    const apply = (value: number) => { applied.push(value) }
    const first = refresh.run(() => pending.promise, apply)
    const load = async () => { applied.push(-1); return 2 }

    await refresh.run(load, apply)
    pending.resolve(1)
    await first
    now = 299
    await refresh.run(load, apply)
    expect(applied).toEqual([1])
    now = 300
    await refresh.run(load, apply)
    expect(applied).toEqual([1, -1, 2])
  })

  test('重启后不应用旧生命周期的结果', async () => {
    const refresh = createAgentIslandQuotaRefresh(300, () => 0)
    const pending = Promise.withResolvers<number>()
    const applied: number[] = []
    const apply = (value: number) => { applied.push(value) }
    const first = refresh.run(() => pending.promise, apply)
    refresh.reset()
    await refresh.run(async () => 2, apply)
    pending.resolve(1)
    await first
    expect(applied).toEqual([2])
  })
})
