import type { WorkerInitializationRenderOptions, WorkerPoolOptions } from '@pierre/diffs/react'
import DiffsWorkerUrl from '@pierre/diffs/worker/worker.js?worker&url'

/** The pool renders with its own options whenever it works, so viewers must use the same theme. */
export const PIERRE_THEME = 'pierre-dark'

export const pierreHighlighterOptions: WorkerInitializationRenderOptions = {
  theme: PIERRE_THEME,
  lineDiffType: 'word-alt',
}

// Shiki highlighting runs off the main thread. One warm worker measured faster than two (each
// worker loads its own grammars) and holds about half the memory.
export const pierrePoolOptions: WorkerPoolOptions = {
  workerFactory: () => new Worker(DiffsWorkerUrl, { type: 'module' }),
  poolSize: 1,
  // Each entry is a whole highlighted file or diff, kept on the main thread; the default of 100
  // grows the heap for files that won't be looked at again.
  totalASTLRUCacheSize: 20,
}
