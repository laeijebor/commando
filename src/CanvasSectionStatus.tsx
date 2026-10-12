import { useEffect, useRef, useState } from 'react'
import { CANVAS_STATUSES, type CanvasSection } from '../shared/canvas-manifest'

const LABELS = { idea: 'Idea', 'in-progress': 'In progress', 'ready-for-review': 'Ready for review', 'ready-for-dev': 'Ready for dev', shipped: 'Shipped' }
export function CanvasSectionStatus({ section, disabled, onChange }: { section: CanvasSection; disabled: boolean; onChange: (status: CanvasSection['status']) => void }) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false) }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false) }
    window.addEventListener('pointerdown', outside); window.addEventListener('keydown', escape)
    return () => { window.removeEventListener('pointerdown', outside); window.removeEventListener('keydown', escape) }
  }, [open])
  return <div className="canvas-status-control" ref={root}>
    <button type="button" className={`canvas-chip canvas-status status-${section.status}`} disabled={disabled} aria-label={`${section.title} status`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>{LABELS[section.status]}</button>
    {open && <div role="menu" aria-label="Section status" className="canvas-status-menu">{CANVAS_STATUSES.map((status) => <button type="button" role="menuitemradio" aria-checked={section.status === status} key={status} onClick={() => { setOpen(false); if (status !== section.status) onChange(status) }}>{LABELS[status]}</button>)}</div>}
  </div>
}
