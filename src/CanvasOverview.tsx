import type { CanvasThread, WebPanePendingNote } from '../shared/protocol'
import { useId, useMemo, useRef, useState } from 'react'
import type { CanvasAnnotation, CanvasFrame } from '../shared/canvas-manifest'
import { buildCanvasLabelTree, sameLabel, type CanvasLabelInstance, type CanvasLabelRef, type CanvasLabelReports } from './canvasLabels'

const threadState = (thread: CanvasThread) => thread.status === 'resolved' ? 'resolved' : thread.messages.at(-1)?.author === 'agent' ? 'replied' : 'open'

export function CanvasOverview({ frames, annotations, reports, selected, onHover, onSelect, onFrame, onNote, threads = [], queued = [], onThread, onExport, hideThreads = false }: {
  frames: CanvasFrame[]; annotations: CanvasAnnotation[]; reports: CanvasLabelReports; selected: CanvasLabelRef | null
  onHover: (label: CanvasLabelRef | null) => void; onSelect: (label: CanvasLabelInstance) => void
  hideThreads?: boolean; threads?: CanvasThread[]; queued?: WebPanePendingNote[]; onThread?: (thread: CanvasThread) => void
  onExport?: (frame: CanvasFrame, anchor: HTMLElement) => void
  onFrame: (frame: CanvasFrame) => void; onNote: (note: CanvasAnnotation) => void
}) {
  const [tab, setTab] = useState('components'), [filter, setFilter] = useState('')
  const id = useId()
  const cursors = useRef(new Map<string, number>())
  const tree = useMemo(() => buildCanvasLabelTree(frames, reports, filter), [frames, reports, filter])
  const pinCount = (instances: CanvasLabelInstance[]) => [...threads.filter((thread) => thread.status === 'open'), ...queued.flatMap((note) => note.canvas ? [note.canvas] : [])]
    .filter((pin) => instances.some((instance) => pin.frameId === instance.frameId && (pin.labelId ? pin.labelId === instance.label.id : pin.label === instance.label.name))).length
  const item = (instance: CanvasLabelInstance, grouped: boolean) => <button type="button" key={instance.key}
    className={`canvas-o-item${grouped ? ' in-group' : ''}${sameLabel(selected, instance) ? ' is-selected' : ''}`}
    aria-pressed={sameLabel(selected, instance)} onPointerEnter={() => onHover(instance)} onPointerLeave={() => onHover(null)}
    onFocus={() => onHover(instance)} onBlur={() => onHover(null)} onClick={() => onSelect(instance)}><i /><span>{instance.label.name}</span>{pinCount([instance]) > 0 && <em className="canvas-o-count" aria-label={`${pinCount([instance])} comments`}>💬 {pinCount([instance])}</em>}</button>
  const frameRow = (frame: CanvasFrame, label: string, count?: number) => <div className="canvas-o-frame-row">
    <button type="button" className="canvas-o-frame" onClick={() => onFrame(frame)}><span>{label}</span>{count !== undefined && <em className="canvas-o-count">{count}</em>}</button>
    {onExport && <button type="button" className="canvas-o-export" aria-label={`Export ${frame.title} from overview`} title={`Export ${frame.title}`} aria-haspopup="menu"
      onClick={(event) => onExport(frame, event.currentTarget.parentElement!)}>Export…</button>}
  </div>
  return <aside className="canvas-overview" aria-label="Canvas overview" onPointerLeave={() => onHover(null)}>
    <div className="canvas-overview-tabs" role="tablist" aria-label="Overview">
      {(hideThreads ? ['components'] : ['components', 'threads']).map((name) => <button type="button" key={name} role="tab" id={`${id}-${name}`} aria-controls={`${id}-panel`}
        aria-selected={tab === name} onClick={() => { setTab(name); onHover(null) }}>{name === 'components' ? 'Components' : 'Threads'}</button>)}
    </div>
    {tab === 'components' && <input className="canvas-overview-filter" aria-label="Filter labels" placeholder="Filter labels…" value={filter} onChange={(event) => { setFilter(event.target.value); onHover(null) }} />}
    <div className="canvas-overview-body" role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-${tab}`}>
      {tab === 'threads' ? threads.length ? threads.map((thread) => <button type="button" key={thread.id} className="canvas-o-thread" aria-label={`${thread.label || 'Unlabelled'} ${threadState(thread)} ${thread.messages[0]?.text.split('\n')[0] || ''}`} onClick={() => onThread?.(thread)}>
        <b>{thread.label || 'Unlabelled'}</b><em>{threadState(thread)}</em><span>{thread.messages[0]?.text.split('\n')[0]}</span>
      </button>) : <p className="canvas-overview-empty">No comments yet</p> : <>
        {!filter.trim() && <>
          <div className="canvas-o-head">Start here</div>
          {frames.filter((frame) => frame.focus).sort((a, b) => a.focus! - b.focus!).map((frame) => <div key={frame.id}>{frameRow(frame, `★ ${frame.focus} · ${frame.title}`)}</div>)}
          <div className="canvas-o-head">Notes</div>
          {annotations.map((note) => <button type="button" className="canvas-o-item" key={note.id} onClick={() => onNote(note)}><i /><span>{note.title || note.text || note.items?.[0] || note.kind}</span></button>)}
        </>}
        {tree.shared.length > 0 && <><div className="canvas-o-head">Shared</div>{tree.shared.map(({ name, instances }) => <button type="button" className="canvas-o-item" key={name}
          onPointerEnter={() => onHover(instances[0])} onPointerLeave={() => onHover(null)} onFocus={() => onHover(instances[0])} onBlur={() => onHover(null)}
          onClick={() => { const index = ((cursors.current.get(name) ?? -1) + 1) % instances.length; cursors.current.set(name, index); onSelect(instances[index]) }}>
          <i /><span>{name}</span><em className="canvas-o-count">×{instances.length}</em>{pinCount(instances) > 0 && <em className="canvas-o-count" aria-label={`${pinCount(instances)} comments`}>💬 {pinCount(instances)}</em>}</button>)}</>}
        <div className="canvas-o-head">Frames</div>
        {tree.frames.map(({ frame, count, groups }) => <div key={frame.id}>
          {frameRow(frame, `${frame.interactive ? '▶ ' : ''}${frame.title}`, count)}
          {groups.map(({ name, labels }) => <div key={name}>{name && <div className="canvas-o-group">{name}</div>}{labels.map((instance) => item(instance, !!name))}</div>)}
        </div>)}
        {filter.trim() && !tree.frames.length && <p className="canvas-overview-empty">No matching labels</p>}
      </>}
    </div>
  </aside>
}
