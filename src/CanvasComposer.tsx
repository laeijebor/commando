import { useLayoutEffect, useRef, useState } from 'react'

export function CanvasComposer({ point, label, text, sent, queued, busy, onQueue, onSend, onCancel, onComment }: {
  point: { x: number; y: number }; label: string; text?: string; sent: boolean; queued: boolean; busy: boolean
  onComment: (text: string) => void
  onQueue: (text: string) => void; onSend: (text: string) => void; onCancel: () => void
}) {
  const [comment, setComment] = useState(text ?? '')
  const node = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState(point)
  useLayoutEffect(() => {
    const element = node.current, viewport = element?.parentElement
    if (!element || !viewport) return
    const place = () => setPosition({ x: Math.max(8, Math.min(point.x + 12, viewport.clientWidth - element.offsetWidth - 8)),
      y: Math.max(8, Math.min(point.y + 12, viewport.clientHeight - element.offsetHeight - 8)) })
    place()
    const observer = new ResizeObserver(place)
    observer.observe(viewport); observer.observe(element)
    return () => observer.disconnect()
  }, [point.x, point.y])
  return <div ref={node} className="canvas-composer" role="dialog" aria-label="Canvas comment" style={{ left: position.x, top: position.y }}>
    <header title={label}>{label}</header>
    {sent || queued ? <p className="canvas-comment-text">{text}</p> : <textarea autoFocus aria-label="Comment" placeholder="Leave a comment…" maxLength={4_096} value={comment} onChange={(event) => { setComment(event.target.value); onComment(event.target.value) }} />}
    {sent && <p className="canvas-reply-later">Agent replies arrive in a later update</p>}
    <footer><button type="button" disabled={busy} onClick={onCancel}>{sent || queued ? 'Close' : 'Cancel'}</button>
      {!sent && <>{!queued && <button type="button" disabled={busy || !comment.trim()} onClick={() => onQueue(comment)}>Queue</button>}
        <button type="button" disabled={busy || (!queued && !comment.trim())} onClick={() => onSend(comment)}>Send this</button></>}
    </footer>
  </div>
}
