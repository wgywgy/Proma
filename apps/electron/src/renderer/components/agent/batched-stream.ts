import { useEffect, useRef, useState } from 'react'

interface BatchedStreamOptions {
  initialContent: string
  publish: (content: string) => void
  intervalMs?: number
  schedule?: (callback: () => void, delay: number) => () => void
}

/** 固定窗口合并文本，不在每次 token 到达时重置截止时间。 */
export function createBatchedStreamController({
  initialContent,
  publish,
  intervalMs = 100,
  schedule = (callback, delay) => {
    const timer = setTimeout(callback, delay)
    return () => clearTimeout(timer)
  },
}: BatchedStreamOptions) {
  let received = initialContent
  let displayed = initialContent
  let cancelPending: (() => void) | undefined

  const emit = (): void => {
    if (displayed === received) return
    displayed = received
    publish(displayed)
  }
  const dispose = (): void => {
    cancelPending?.()
    cancelPending = undefined
  }
  return {
    update(content: string, streaming: boolean): void {
      const append = content.startsWith(received)
      received = content
      if (!streaming || !append) {
        dispose()
        emit()
        return
      }
      if (displayed === received || cancelPending) return
      cancelPending = schedule(() => {
        cancelPending = undefined
        emit()
      }, intervalMs)
    },
    dispose,
  }
}

export function useBatchedStream({ content, isStreaming }: { content: string; isStreaming: boolean }): {
  displayedContent: string
} {
  const [displayedContent, setDisplayedContent] = useState(content)
  const controller = useRef<ReturnType<typeof createBatchedStreamController> | null>(null)
  if (!controller.current) {
    controller.current = createBatchedStreamController({ initialContent: content, publish: setDisplayedContent })
  }
  useEffect(() => {
    controller.current?.update(content, isStreaming)
  }, [content, isStreaming])
  useEffect(() => () => controller.current?.dispose(), [])
  return { displayedContent }
}
