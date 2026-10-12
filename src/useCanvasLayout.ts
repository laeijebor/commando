import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import type { CanvasManifestResult, CanvasMove, CanvasSection } from '../shared/canvas-manifest'
import { writeCanvasLayout } from './canvasWrite'

export function useCanvasLayout(artifactId: string, manifest: string, token: string, setResult: Dispatch<SetStateAction<CanvasManifestResult>>) {
  const contentHash = useRef(''), reload = useRef<() => Promise<void>>(async () => {})
  const loadEpoch = useRef(0)
  const reloadAfterWrite = useRef(false)
  const overlay = useRef<CanvasMove | null>(null)
  const lock = useRef(false), generation = useRef(0)
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  useEffect(() => {
    ++generation.current; contentHash.current = ''; overlay.current = null; lock.current = false; reloadAfterWrite.current = false; setBusy(false); setError('')
    return () => { ++generation.current }
  }, [artifactId, manifest])
  const preview = (move: CanvasMove | null) => {
    overlay.current = move
    if (move) setResult((result) => ({ ...result, manifest: { ...result.manifest, frames: result.manifest.frames.map((f) => f.id === move.id ? { ...f, ...move } : f) } }))
  }
  const write = async (change: Parameters<typeof writeCanvasLayout>[3], after?: () => Promise<unknown>) => {
    if (lock.current) return
    const lifetime = generation.current
    lock.current = true; ++loadEpoch.current; setBusy(true); setError('')
    try {
      const result = await writeCanvasLayout(artifactId, manifest, contentHash.current, change, token)
      if (lifetime !== generation.current) return
      ++loadEpoch.current; overlay.current = null; contentHash.current = result.contentHash; setResult(result)
      if (after) await after()
    } catch (reason) {
      if (lifetime !== generation.current) return
      ++loadEpoch.current; overlay.current = null; setError((reason as Error).message)
      lock.current = false
      reloadAfterWrite.current = false
      await reload.current()
    } finally {
      if (lifetime === generation.current) {
        lock.current = false
        if (reloadAfterWrite.current) { reloadAfterWrite.current = false; await reload.current() }
        if (lifetime === generation.current) setBusy(false)
      }
    }
  }
  return { contentHash, loadEpoch, reload, writing: lock, reloadAfterWrite, overlay, busy, error, preview, move: (move: CanvasMove) => write({ moves: [move] }),
    status: (section: CanvasSection, status: CanvasSection['status'], after: () => Promise<unknown>) => write({ statuses: [{ id: section.id, status }] }, after) }
}
