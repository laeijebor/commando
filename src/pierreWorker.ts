import type { WorkerInitializationRenderOptions, WorkerPoolOptions } from '@pierre/diffs/react'
import DiffsWorkerUrl from '@pierre/diffs/worker/worker.js?worker&url'

/** The pool renders with its own options whenever it works, so viewers must use the same theme. */
export const PIERRE_THEME = 'pierre-dark'

export const pierreHighlighterOptions: WorkerInitializationRenderOptions = {
  theme: PIERRE_THEME,
  lineDiffType: 'word-alt',
}

// Shiki highlighting runs off the main thread; two workers are plenty for one file at a time.
export const pierrePoolOptions: WorkerPoolOptions = {
  workerFactory: () => new Worker(DiffsWorkerUrl, { type: 'module' }),
  poolSize: 2,
}
