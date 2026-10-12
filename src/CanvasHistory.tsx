import { canvasRequest } from './canvasWrite'
import { useEffect, useRef, useState } from 'react'
import type { CanvasSnapshot } from '../shared/canvas-snapshot'

export const canvasSnapshotTime = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })

export function CanvasHistory({ apiUrl, token, selected, disabled, onSelect }: {
  apiUrl: string; token: string; selected: CanvasSnapshot | null; disabled: boolean; onSelect: (snapshot: CanvasSnapshot | null) => void
}) {
  const [snapshots, setSnapshots] = useState<CanvasSnapshot[]>([]), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(false)
  const generation = useRef(0)
  useEffect(() => { ++generation.current; setSnapshots([]); setError(''); setBusy(false); setOpen(false); return () => { ++generation.current } }, [apiUrl, token])
  const load = async () => {
    const epoch = ++generation.current
    setBusy(true); setError('')
    try {
      const response = await canvasRequest(apiUrl, token, { cache: 'no-store' }, 'Could not load history')
      const data = await response.json() as { snapshots: CanvasSnapshot[] }
      if (epoch === generation.current) setSnapshots(data.snapshots ?? [])
    } catch (reason) { if (epoch === generation.current) setError((reason as Error).message) }
    finally { if (epoch === generation.current) setBusy(false) }
  }
  const choose = (snapshot: CanvasSnapshot | null) => { onSelect(snapshot); setOpen(false) }
  return <details className="canvas-menu canvas-history" open={open}>
    <summary onClick={(event) => { event.preventDefault(); setOpen(!open); if (!open) void load() }}>History</summary>
    {open && <div className="canvas-menu-items" role="menu" aria-label="Canvas history">
      <button type="button" role="menuitemradio" aria-checked={!selected} disabled={disabled} onClick={() => choose(null)}>Live</button>
      {busy && <span role="status">Loading history…</span>}
      {error && <span role="alert">{error}</span>}
      {!busy && !error && !snapshots.length && <span>No snapshots yet</span>}
      {snapshots.map((snapshot) => <button type="button" role="menuitemradio" key={snapshot.id} aria-checked={selected?.id === snapshot.id} disabled={disabled}
        title={`${new Date(snapshot.createdAt).toLocaleString()} · ${snapshot.manifestTitle}`} onClick={() => choose(snapshot)}>
        {canvasSnapshotTime(snapshot.createdAt)} · {snapshot.comments} {snapshot.comments === 1 ? 'comment' : 'comments'}{snapshot.partial ? ' · partial' : ''}
      </button>)}
    </div>}
  </details>
}
