/** 合并展开请求；停止服务后，旧请求结果不得进入新生命周期。 */
export function createAgentIslandQuotaRefresh(intervalMs: number, now = () => performance.now()) {
  let lastStart = -Infinity
  let pending: object | undefined

  return {
    async run<T>(load: () => Promise<T>, apply: (value: T) => void): Promise<void> {
      const startedAt = now()
      if (pending || startedAt - lastStart < intervalMs) return
      const request = {}
      pending = request
      lastStart = startedAt
      try {
        const result = await load()
        if (pending === request) apply(result)
      } finally {
        if (pending === request) pending = undefined
      }
    },
    reset(): void {
      pending = undefined
      lastStart = -Infinity
    },
  }
}
