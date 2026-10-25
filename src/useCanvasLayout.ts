import { encodeCanvasPath } from '../shared/canvas-manifest'
import { subscribeCanvasChanges } from './webPanesApi'
import { useEffect, useLayoutEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { parseCanvasManifest, type CanvasFrame, type CanvasManifest, type CanvasManifestResult, type CanvasMove, type CanvasSection } from '../shared/canvas-manifest'
import { writeCanvasLayout, type CanvasLayoutChange } from './canvasWrite'

/** Applies a frame or note move; a moved note is fixed unless the move says otherwise. */
export const applyCanvasMove = (manifest: CanvasManifest, move: CanvasMove): CanvasManifest => ({
  ...manifest,
  frames: manifest.frames.map((f) => f.id === move.id ? { ...f, x: move.x, y: move.y } : f),
  annotations: manifest.annotations.map((n) => n.id === move.id ? { ...n, x: move.x, y: move.y, fixed: move.fixed ?? true } : n),
})

type ManifestView = {
  baseUrl: string; readOnly: boolean; frames: CanvasFrame[]; onTitle?: (title: string) => void
  onReset: () => void; setLoaded: Dispatch<SetStateAction<boolean>>
  setRevisions: Dispatch<SetStateAction<Record<string, number>>>
}

export function useCanvasLayout(artifactId: string, manifest: string, token: string, setResult: Dispatch<SetStateAction<CanvasManifestResult>>, view?: ManifestView) {
  const viewRef = useRef(view), manifestRef = useRef({ frames: view?.frames ?? [] })
  useLayoutEffect(() => { viewRef.current = view; manifestRef.current = { frames: view?.frames ?? [] } })
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
  useEffect(() => {
    view?.onReset()
    if (!view) return
    const { baseUrl, readOnly, setLoaded, setRevisions } = view
    let disposed = false
    let sequence = 0
    const abort = new AbortController()
    setLoaded(false)
    setRevisions({})
    const load = async () => {
      if (!readOnly && lock.current) { reloadAfterWrite.current = true; return }
      const request = ++sequence
      const epoch = loadEpoch.current
      try {
        const response = await fetch(baseUrl + encodeCanvasPath(manifest), { cache: 'no-store', signal: abort.signal })
        if (!response.ok) throw new Error(`${manifest}: could not load (${response.status})`)
        const parsed = parseCanvasManifest(await response.text())
        if (!disposed && request === sequence && epoch === loadEpoch.current) {
          if (!readOnly) contentHash.current = response.headers?.get('ETag')?.replaceAll('"', '') ?? ''
          const move = readOnly ? null : overlay.current
          if (move) parsed.manifest = applyCanvasMove(parsed.manifest, move)
          setResult(parsed); setLoaded(true); viewRef.current?.onTitle?.(parsed.manifest.title || 'Canvas')
        }
      } catch (error) {
        if (!disposed && request === sequence && epoch === loadEpoch.current) { setResult((current) => ({ ...current, errors: [String((error as Error).message)] })); setLoaded(true) }
      }
    }
    reload.current = load
    void load()
    const unsubscribe = subscribeCanvasChanges(({ artifactId: changedArtifact, changed }) => {
      if (readOnly || changedArtifact !== artifactId) return
      const other = changed.filter((path) => path !== manifest)
      const frames = manifestRef.current.frames
      const unknown = other.some((path) => !frames.some((frame) => frame.src === path))
      if (changed.includes(manifest) || unknown) void load()
      if (!other.length) return
      setRevisions((current) => {
        const next = { ...current }
        for (const frame of frames) if (unknown || other.includes(frame.src)) next[frame.id] = (next[frame.id] ?? 0) + 1
        return next
      })
    })
    return () => { disposed = true; abort.abort(); unsubscribe(); reload.current = async () => {} }
  }, [artifactId, manifest, view?.baseUrl])

  const preview = (move: CanvasMove | null) => {
    overlay.current = move
    if (move) setResult((result) => ({ ...result, manifest: applyCanvasMove(result.manifest, move) }))
  }
  const write = async (change: CanvasLayoutChange, after?: () => Promise<unknown>) => {
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
  return { hasPreview: () => overlay.current !== null, contentHash, loadEpoch, reload, writing: lock, reloadAfterWrite, overlay, busy, error, preview, move: (move: CanvasMove) => write({ moves: [move] }), moveNote: (move: CanvasMove) => write({ notes: [move] }),
    status: (section: CanvasSection, status: CanvasSection['status'], after: () => Promise<unknown>) => write({ statuses: [{ id: section.id, status }] }, after) }
}
