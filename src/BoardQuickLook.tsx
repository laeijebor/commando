import { useEffect, useRef, useState } from 'react'
import { Copy, ExternalLink, FolderSearch, Pin, Trash2, X } from 'lucide-react'
import { isBoardFile, isBoardTile, type BoardEntry } from './BoardGeometry'
import { BoardClipText, BoardPreview, BoardStateChip, boardKindLabel, type BoardThumbUrl } from './BoardCards'

export function boardPrimaryLabel(item: BoardEntry): string | null {
  if (item.kind === 'clip') return null
  if (item.kind === 'pr') return 'Open PR'
  if (isBoardTile(item) && item.state === 'missing') return 'Gone'
  if (isBoardTile(item) && item.state === 'snapshot') return 'Open snapshot'
  if (item.kind === 'link' || item.kind === 'page') return 'Open link'
  return isBoardTile(item) ? 'Reopen in a tile' : 'Open'
}

export function BoardQuickLook({ item, thumbUrl, revealInFinder, pending, boardError, onClose, onRevive, onReveal, onPin, onRemove }: {
  item: BoardEntry; thumbUrl: BoardThumbUrl; revealInFinder: boolean; pending: boolean; boardError?: string
  onClose: () => void; onRevive: () => Promise<void>; onReveal: () => Promise<void>; onPin: () => Promise<void>; onRemove: () => Promise<void>
}) {
  const panel = useRef<HTMLDivElement>(null)
  const close = useRef<HTMLButtonElement>(null)
  const [error, setError] = useState('')
  const [working, setWorking] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [copied, setCopied] = useState(false)
  const run = async (operation: () => Promise<void>) => {
    if (working || pending) return
    setWorking(true); setError('')
    try { await operation() } catch (cause) { setError(cause instanceof Error ? cause.message : 'Board action failed') }
    finally { setWorking(false) }
  }
  useEffect(() => {
    close.current?.focus()
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose() }
      if (event.key === 'Tab') {
        const nodes = [...panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], [tabindex="0"]') ?? []]
        const first = nodes[0], last = nodes.at(-1)
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
      }
    }
    window.addEventListener('keydown', keydown, true)
    return () => window.removeEventListener('keydown', keydown, true)
  }, [onClose])
  const source = item.ref.path || item.ref.url
  const busy = pending || working
  const primaryLabel = boardPrimaryLabel(item)
  return <div className="board-quick-look" role="dialog" aria-modal="true" aria-label={`Quick look: ${item.title}`} ref={panel} data-native-terminal-occluder="">
    <div className="board-quick-stage">
      <header><button ref={close} type="button" onClick={onClose}><X size={14} /> Close quick look</button><strong>{item.kind === 'clip' ? 'Clipping' : item.title}</strong></header>
      {item.kind === 'clip' ? <BoardClipText item={item} large /> : <BoardPreview item={item} thumbUrl={thumbUrl} large />}
    </div>
    <aside className="board-quick-info">
      <h2>{item.kind === 'clip' ? 'Clipping' : item.title}</h2>
      <p>{boardKindLabel(item)} <BoardStateChip item={item} /></p>
      <div className="board-quick-actions">
        {primaryLabel && <button className="board-primary" type="button" disabled={busy || item.state === 'missing' || (isBoardFile(item) && !revealInFinder)}
          title={isBoardFile(item) && !revealInFinder ? 'File reveal is unavailable on this host' : undefined} onClick={() => void run(onRevive)}><ExternalLink size={15} />{primaryLabel}</button>}
        {item.ref.path && revealInFinder && <button type="button" disabled={busy} onClick={() => void run(onReveal)}><FolderSearch size={15} /> Reveal in Finder</button>}
        {source && <button type="button" disabled={busy} onClick={() => void run(async () => { await navigator.clipboard.writeText(source); setCopied(true) })}><Copy size={15} />{copied ? 'Copied' : item.ref.path ? 'Copy path' : 'Copy URL'}</button>}
        <button type="button" disabled={busy} onClick={() => void run(onPin)}><Pin size={15} />{item.pinned ? 'Unpin' : 'Pin'}</button>
        <button type="button" disabled={busy} onClick={() => setConfirmRemove(true)}><Trash2 size={15} />Remove from board</button>
      </div>
      {confirmRemove && <div className="board-remove-confirm"><p>Remove “{item.title}” from this board?</p><small>The source file or tile is kept.</small><div>
        <button type="button" disabled={busy} onClick={() => void run(onRemove)}>Confirm removal</button><button type="button" disabled={busy} onClick={() => setConfirmRemove(false)}>Cancel</button></div></div>}
      {(error || boardError) && <p role="alert" className="board-error">{error || boardError}</p>}
      <dl>
        <dt>Origin</dt><dd>{new Date(item.origin?.at ?? item.addedAt).toLocaleString()}</dd>
        <dt>Made by</dt><dd>{item.source === 'user' ? 'You' : item.source === 'agent' ? 'Agent' : 'Captured automatically'}</dd>
        {item.origin?.agentSession && <><dt>Conversation</dt><dd>{item.origin.agentSession.provider} · {item.origin.agentSession.id}</dd></>}
        {item.origin?.prompt && <><dt>Ask</dt><dd>{item.origin.prompt}</dd></>}
        {source && <><dt>Source</dt><dd>{source}</dd></>}
        {item.caption && item.kind !== 'clip' && <><dt>Caption</dt><dd>{item.caption}</dd></>}
        {item.preview?.description && <><dt>Preview</dt><dd>{item.preview.description}</dd></>}
      </dl>
    </aside>
  </div>
}
