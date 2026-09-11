/**
 * Stream chunk coalescer (PERF-6): batches rapid per-token deltas into timed
 * flushes so downstream socket emission rate stays flat regardless of how fast
 * the model streams. Single source of truth for STREAM_BATCH_MS semantics:
 * value < 0/non-numeric falls back to 50ms; 0 disables batching (per-chunk
 * immediate flush).
 */
export function resolveStreamBatchMs(raw: string | undefined): number {
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 50
}

export interface ChunkCoalescer {
  /** Append a delta; schedules or fires a flush according to the batch window. */
  push(chunk: string): void
  /** Force-flush buffered content now (no-op if empty). */
  flush(): void
  /** True while content is buffered or a flush timer is armed. */
  readonly pending: boolean
}

export function createChunkCoalescer(
  flushFn: (content: string) => void,
  batchMs: number = resolveStreamBatchMs(process.env.STREAM_BATCH_MS),
  onIdle?: () => void
): ChunkCoalescer {
  let buffer = ''
  let timer: NodeJS.Timeout | undefined

  const clearTimer = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
  }

  const flush = (): void => {
    clearTimer()
    const out = buffer
    buffer = ''
    if (out.length > 0) flushFn(out)
    if (buffer.length === 0 && timer === undefined) onIdle?.()
  }

  const push = (chunk: string): void => {
    if (batchMs <= 0) {
      flushFn(chunk)
      return
    }
    buffer += chunk
    if (timer === undefined) {
      timer = setTimeout(() => {
        timer = undefined
        flush()
      }, batchMs)
    }
  }

  return {
    push,
    flush,
    get pending(): boolean {
      return buffer.length > 0 || timer !== undefined
    },
  }
}
