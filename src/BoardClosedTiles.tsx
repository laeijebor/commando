import { useState } from 'react'
import { boardKindLabel } from './BoardCards'
import type { BoardEntry } from './BoardGeometry'

/** All closed tiles remain actionable even when the full Board cannot fit. */
export function BoardClosedTiles({ items, disabled, onReopen, onForget }: {
  items: BoardEntry[]; disabled: boolean
  onReopen: (item: BoardEntry) => Promise<unknown>
  onForget: (item: BoardEntry) => Promise<unknown>
}) {
  const [expanded, setExpanded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  if (!items.length) return null
  const run = async (item: BoardEntry, action: typeof onReopen) => {
    setBusy(true); setError('')
    try { await action(item) }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not update closed tile') }
    finally { setBusy(false) }
  }
  return <section className="board-closed-tiles" aria-label="Recently closed">
    <button type="button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>Recently closed <small>({items.length})</small></button>
    {expanded && <ul>{items.map((item) => <li key={item.key}>
      <span><strong>{item.title}</strong><small>{boardKindLabel(item)}</small></span>
      <button type="button" disabled={disabled || busy} aria-label={`Reopen ${item.title}`} onClick={() => { void run(item, onReopen) }}>Reopen</button>
      <button type="button" disabled={disabled || busy} aria-label={`Forget ${item.title}`} onClick={() => { void run(item, onForget) }}>Forget</button>
    </li>)}</ul>}
    {error && <p role="alert">{error}</p>}
  </section>
}
