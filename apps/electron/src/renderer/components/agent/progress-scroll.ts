interface ProgressViewport {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}

interface ProgressScrollOptions {
  getViewport: () => ProgressViewport | null
  canResume: (viewport: ProgressViewport) => boolean
  requestFrame?: (callback: FrameRequestCallback) => number
  cancelFrame?: (id: number) => void
}

/** 帧内统一测量和写入，事件入口只排队，不同步读取布局。 */
export function createProgressScrollController({
  getViewport,
  canResume,
  requestFrame = (callback) => requestAnimationFrame(callback),
  cancelFrame = (id) => cancelAnimationFrame(id),
}: ProgressScrollOptions) {
  let following = true
  let frame: number | null = null
  let checkResume = false

  const cancel = (): void => {
    if (frame !== null) cancelFrame(frame)
    frame = null
    checkResume = false
  }
  const advance = (): void => {
    frame = null
    const viewport = getViewport()
    if (!viewport) return
    const metrics = {
      scrollHeight: viewport.scrollHeight,
      clientHeight: viewport.clientHeight,
      scrollTop: viewport.scrollTop,
    }
    if (!following) {
      if (!checkResume || !canResume(metrics)) {
        checkResume = false
        return
      }
      following = true
    }
    checkResume = false
    // 每帧使用当前尺寸，内容收缩时不能追逐已不可达的旧目标。
    const target = Math.max(0, metrics.scrollHeight - metrics.clientHeight)
    const distance = target - metrics.scrollTop
    if (Math.abs(distance) <= 1) {
      if (metrics.scrollTop !== target) viewport.scrollTop = target
      return
    }
    // 内容突增时快速追近，正常增量则保持低成本的连续插值。
    viewport.scrollTop = distance > 72 ? target - 48 : metrics.scrollTop + distance * 0.32
    // 浏览器可能夹紧位置；写入无进展时停止，不能无限排 rAF。
    if (Math.abs(viewport.scrollTop - metrics.scrollTop) <= 0.01) return
    frame = requestFrame(advance)
  }
  const enqueue = (): void => {
    if (frame === null) frame = requestFrame(advance)
  }
  return {
    request(): void {
      if (following) enqueue()
    },
    resume(): void {
      following = true
      enqueue()
    },
    stop(): void {
      following = false
      cancel()
    },
    onScroll(): void {
      if (following) return
      checkResume = true
      enqueue()
    },
    dispose: cancel,
  }
}
