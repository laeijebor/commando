import { useId, useMemo, useRef, useState } from 'react'
import type { CanvasAnnotation, CanvasFrame } from '../shared/canvas-manifest'
import { buildCanvasLabelTree, sameLabel, type CanvasLabelInstance, type CanvasLabelRef, type CanvasLabelReports } from './canvasLabels'

export function CanvasOverview({ frames, annotations, reports, selected, onHover, onSelect, onFrame, onNote }: {
  frames: CanvasFrame[]; annotations: CanvasAnnotation[]; reports: CanvasLabelReports; selected: CanvasLabelRef | null
  onHover: (label: CanvasLabelRef | null) => void; onSelect: (label: CanvasLabelInstance) => void
  onFrame: (frame: CanvasFrame) => void; onNote: (note: CanvasAnnotation) => void
}) {
  const [tab, setTab] = useState('components'), [filter, setFilter] = useState('')
  const id = useId()
  const cursors = useRef(new Map<string, number>())
  const tree = useMemo(() => buildCanvasLabelTree(frames, reports, filter), [frames, reports, filter])
  const item = (instance: CanvasLabelInstance, grouped: boolean) => <button type="button" key={instance.key}
    className={`canvas-o-item${grouped ? ' in-group' : ''}${sameLabel(selected, instance) ? ' is-selected' : ''}`}
    aria-pressed={sameLabel(selected, instance)} onPointerEnter={() => onHover(instance)} onPointerLeave={() => onHover(null)}
    onFocus={() => onHover(instance)} onBlur={() => onHover(null)} onClick={() => onSelect(instance)}><i /><span>{instance.label.name}</span></button>
  return <aside className="canvas-overview" aria-label="Canvas overview" onPointerLeave={() => onHover(null)}>
    <div className="canvas-overview-tabs" role="tablist" aria-label="Overview">
      {['components', 'threads'].map((name) => <button type="button" key={name} role="tab" id={`${id}-${name}`} aria-controls={`${id}-panel`}
        aria-selected={tab === name} onClick={() => { setTab(name); onHover(null) }}>{name === 'components' ? 'Components' : 'Threads'}</button>)}
    </div>
    {tab === 'components' && <input className="canvas-overview-filter" aria-label="Filter labels" placeholder="Filter labels…" value={filter} onChange={(event) => { setFilter(event.target.value); onHover(null) }} />}
    <div className="canvas-overview-body" role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-${tab}`}>
      {tab === 'threads' ? <p className="canvas-overview-empty">No comments yet</p> : <>
        {!filter.trim() && <>
          <div className="canvas-o-head">Start here</div>
          {frames.filter((frame) => frame.focus).sort((a, b) => a.focus! - b.focus!).map((frame) => <button type="button" className="canvas-o-frame" key={frame.id} onClick={() => onFrame(frame)}><span>★ {frame.focus} · {frame.title}</span></button>)}
          <div className="canvas-o-head">Notes</div>
          {annotations.map((note) => <button type="button" className="canvas-o-item" key={note.id} onClick={() => onNote(note)}><i /><span>{note.title || note.text || note.items?.[0] || note.kind}</span></button>)}
        </>}
        {tree.shared.length > 0 && <><div className="canvas-o-head">Shared</div>{tree.shared.map(({ name, instances }) => <button type="button" className="canvas-o-item" key={name}
          onPointerEnter={() => onHover(instances[0])} onPointerLeave={() => onHover(null)} onFocus={() => onHover(instances[0])} onBlur={() => onHover(null)}
          onClick={() => { const index = ((cursors.current.get(name) ?? -1) + 1) % instances.length; cursors.current.set(name, index); onSelect(instances[index]) }}>
          <i /><span>{name}</span><em className="canvas-o-count">×{instances.length}</em></button>)}</>}
        <div className="canvas-o-head">Frames</div>
        {tree.frames.map(({ frame, count, groups }) => <div key={frame.id}>
          <button type="button" className="canvas-o-frame" onClick={() => onFrame(frame)}><span>{frame.interactive ? '▶ ' : ''}{frame.title}</span><em className="canvas-o-count">{count}</em></button>
          {groups.map(({ name, labels }) => <div key={name}>{name && <div className="canvas-o-group">{name}</div>}{labels.map((instance) => item(instance, !!name))}</div>)}
        </div>)}
        {filter.trim() && !tree.frames.length && <p className="canvas-overview-empty">No matching labels</p>}
      </>}
    </div>
  </aside>
}
