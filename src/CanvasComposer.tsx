import type { CanvasThread } from '../shared/protocol'
import { useLayoutEffect, useRef, useState } from 'react'

export function CanvasComposer({ point, label, text, sent, queued, busy, onQueue, onSend, onCancel, onComment, thread, onReply, onStatus }: {
  point: { x: number; y: number }; label: string; text?: string; sent: boolean; queued: boolean; busy: boolean
  thread?: CanvasThread; onReply?: (text: string) => Promise<boolean | undefined>; onStatus?: (status: 'open' | 'resolved') => void
  onComment: (text: string) => void
  onQueue: (text: string) => void; onSend: (text: string) => void; onCancel: () => void
}) {
  const [comment, setComment] = useState(text ?? '')
  const [reply, setReply] = useState('')
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
    {thread ? <>
      <div className="canvas-conversation">{thread.messages.map((message, index) => <div key={index} className={`cmd-msg ${message.author}`}>
        <b>{message.author === 'agent' ? 'Agent' : 'You'}</b><p>{message.text}</p>
      </div>)}</div>
      <textarea aria-label="Reply" placeholder="Reply…" maxLength={4_096} value={reply} onChange={(event) => setReply(event.target.value)} disabled={busy || thread.messages.length >= 200} />
      <div className="canvas-thread-actions"><button type="button" disabled={busy || !reply.trim() || thread.messages.length >= 200}
        onClick={() => { void onReply?.(reply.trim()).then((ok) => { if (ok) setReply('') }) }}>Reply</button>
        <button type="button" disabled={busy} onClick={() => onStatus?.(thread.status === 'resolved' ? 'open' : 'resolved')}>{thread.status === 'resolved' ? 'Reopen' : 'Resolve'}</button></div>
    </> : sent || queued ? <p className="canvas-comment-text">{text}</p> : <textarea autoFocus aria-label="Comment" placeholder="Leave a comment…" maxLength={4_096} value={comment} onChange={(event) => { setComment(event.target.value); onComment(event.target.value) }} />}
    <footer><button type="button" disabled={busy} onClick={onCancel}>{sent || queued ? 'Close' : 'Cancel'}</button>
      {!sent && <>{!queued && <button type="button" disabled={busy || !comment.trim()} onClick={() => onQueue(comment)}>Queue</button>}
        <button type="button" disabled={busy || (!queued && !comment.trim())} onClick={() => onSend(comment)}>Send this</button></>}
    </footer>
  </div>
}
