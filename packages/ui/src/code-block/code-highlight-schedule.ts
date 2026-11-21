interface HighlightClock {
  now: () => number
  schedule: (callback: () => void, delayMs: number) => () => void
}

const defaultClock: HighlightClock = {
  now: () => performance.now(),
  schedule: (callback, delayMs) => {
    const timer = setTimeout(callback, delayMs)
    return () => clearTimeout(timer)
  },
}

/** 在距上次计算的固定期限执行，连续输入不会把期限不断推后。 */
export function scheduleCodeHighlight({
  onReady,
  lastRunAt,
  intervalMs,
  highlight,
  clock = defaultClock,
}: {
  onReady: (callback: () => void) => () => void
  lastRunAt: number
  intervalMs: number
  highlight: (now: number) => void
  clock?: HighlightClock
}): () => void {
  let cancelTimer: (() => void) | undefined
  const unsubscribe = onReady(() => {
    const now = clock.now()
    const remaining = intervalMs - (now - lastRunAt)
    if (remaining <= 0) {
      highlight(now)
    } else {
      cancelTimer = clock.schedule(() => highlight(clock.now()), Math.ceil(remaining))
    }
  })
  return () => {
    unsubscribe()
    cancelTimer?.()
  }
}
