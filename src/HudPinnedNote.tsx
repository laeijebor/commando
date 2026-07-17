import { NotebookPen, Pin, PinOff } from 'lucide-react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

import type { PinnedNote } from './pinnedNote'

const markdownComponents: Components = {
  a({ node: _node, ...props }) {
    return <a {...props} target="_blank" rel="noreferrer" />
  },
  img() {
    return null
  },
}

export function HudPinnedNote({
  note,
  onOpen,
  onUnpin,
}: {
  note: PinnedNote
  onOpen: () => void
  onUnpin: () => void
}) {
  const title = note.title || 'Untitled note'

  return (
    <section className="hud-pinned-note" aria-label={`Pinned note: ${title}`}>
      <header>
        <span><Pin aria-hidden="true" /> Pinned note</span>
        <button type="button" onClick={onUnpin} aria-label={`Unpin note ${title}`} title="Unpin from HUD">
          <PinOff aria-hidden="true" />
        </button>
      </header>
      <div className="hud-pinned-note-content">
        <strong title={title}>{title}</strong>
        <small>{note.folder || 'Root'}</small>
        <div className="hud-pinned-note-markdown">
          {note.body.trim() ? (
            <ReactMarkdown components={markdownComponents} remarkPlugins={[remarkGfm]}>{note.body}</ReactMarkdown>
          ) : <p>Empty note</p>}
        </div>
      </div>
      <button type="button" className="hud-pinned-note-open" onClick={onOpen}>
        <NotebookPen aria-hidden="true" />
        Open in Notes
      </button>
    </section>
  )
}
