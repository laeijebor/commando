import { Eye, NotebookPen, Pencil, Pin, PinOff } from 'lucide-react'
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
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
  onSave,
  onUnpin,
}: {
  note: PinnedNote
  onOpen: () => void
  onSave: (note: PinnedNote) => Promise<PinnedNote>
  onUnpin: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(() => ({ title: note.title, body: note.body }))
  const [savePhase, setSavePhase] = useState<'saved' | 'dirty' | 'saving' | 'error'>('saved')
  const [saveError, setSaveError] = useState('')
  const noteRef = useRef(note)
  const draftRef = useRef(draft)
  const savePhaseRef = useRef(savePhase)
  const editVersion = useRef(0)
  const saveInFlight = useRef(false)

  const changeSavePhase = (next: typeof savePhase) => {
    savePhaseRef.current = next
    setSavePhase(next)
  }

  useEffect(() => {
    const previous = noteRef.current
    const changedIdentity = previous.vaultId !== note.vaultId || previous.id !== note.id
    const hasLocalChanges = savePhaseRef.current !== 'saved'
    const changedExternally = !changedIdentity && note.updatedAt !== previous.updatedAt

    if (changedExternally && hasLocalChanges) {
      if (note.title !== draftRef.current.title || note.body !== draftRef.current.body) {
        setSaveError('This note changed elsewhere. Open it in Notes to resolve the conflict.')
        changeSavePhase('error')
        return
      }
    }

    noteRef.current = note
    if (changedIdentity || !hasLocalChanges) {
      const nextDraft = { title: note.title, body: note.body }
      draftRef.current = nextDraft
      setDraft(nextDraft)
      setSaveError('')
      changeSavePhase('saved')
    }
  }, [note])

  const changeDraft = (next: typeof draft) => {
    draftRef.current = next
    editVersion.current += 1
    setDraft(next)
    setSaveError('')
    changeSavePhase('dirty')
  }

  const save = async () => {
    if (saveInFlight.current || savePhaseRef.current === 'saved') return
    saveInFlight.current = true
    const source = noteRef.current
    const snapshot = draftRef.current
    const version = editVersion.current
    changeSavePhase('saving')
    try {
      const saved = await onSave({ ...source, ...snapshot })
      if (noteRef.current.vaultId !== source.vaultId || noteRef.current.id !== source.id) return
      noteRef.current = saved
      setSaveError('')
      changeSavePhase(editVersion.current === version ? 'saved' : 'dirty')
    } catch (cause) {
      setSaveError(cause instanceof Error ? cause.message : 'Unable to save pinned note')
      changeSavePhase('error')
    } finally {
      saveInFlight.current = false
    }
  }

  useEffect(() => {
    if (savePhase !== 'dirty') return
    const timer = window.setTimeout(() => { void save() }, 650)
    return () => window.clearTimeout(timer)
  }, [draft.body, draft.title, savePhase])

  const saveWithShortcut = (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
      event.preventDefault()
      void save()
    }
  }

  const title = draft.title || 'Untitled note'
  const saveStatus = savePhase === 'saving'
    ? 'Saving...'
    : savePhase === 'dirty'
      ? 'Unsaved'
      : savePhase === 'error'
        ? `Save failed: ${saveError}`
        : ''

  return (
    <section className="hud-pinned-note" aria-label={`Pinned note: ${title}`}>
      <header>
        <span className="hud-pinned-note-label"><Pin aria-hidden="true" /> Pinned note</span>
        <div className="hud-pinned-note-actions">
          <button
            type="button"
            onClick={() => setEditing((current) => !current)}
            aria-label={editing ? 'View pinned note' : 'Edit pinned note'}
            aria-pressed={editing}
            title={editing ? 'Switch to view only' : 'Edit in place'}
          >
            {editing ? <Eye aria-hidden="true" /> : <Pencil aria-hidden="true" />}
          </button>
          <button type="button" onClick={onUnpin} disabled={savePhase === 'saving'} aria-label={`Unpin note ${title}`} title="Unpin from HUD">
            <PinOff aria-hidden="true" />
          </button>
        </div>
      </header>
      <div className={`hud-pinned-note-content${editing ? ' editing' : ''}`}>
        {editing ? (
          <>
            <input
              className="hud-pinned-note-title-input"
              value={draft.title}
              maxLength={200}
              onChange={(event) => changeDraft({ ...draftRef.current, title: event.target.value })}
              onKeyDown={saveWithShortcut}
              aria-label="Pinned note title"
            />
            <div className="hud-pinned-note-meta">
              <small>{note.folder || 'Root'}</small>
              {saveStatus ? <span className={savePhase === 'error' ? 'error' : ''} role={savePhase === 'error' ? 'alert' : 'status'} title={saveStatus}>{saveStatus}</span> : null}
            </div>
            <textarea
              className="hud-pinned-note-body-input"
              value={draft.body}
              onChange={(event) => changeDraft({ ...draftRef.current, body: event.target.value })}
              onKeyDown={saveWithShortcut}
              aria-label="Pinned note body"
            />
          </>
        ) : (
          <>
            <strong title={title}>{title}</strong>
            <div className="hud-pinned-note-meta">
              <small>{note.folder || 'Root'}</small>
              {saveStatus ? <span className={savePhase === 'error' ? 'error' : ''} role={savePhase === 'error' ? 'alert' : 'status'} title={saveStatus}>{saveStatus}</span> : null}
            </div>
            <div className="hud-pinned-note-markdown">
              {draft.body.trim() ? (
                <ReactMarkdown components={markdownComponents} remarkPlugins={[remarkGfm]}>{draft.body}</ReactMarkdown>
              ) : <p>Empty note</p>}
            </div>
          </>
        )}
      </div>
      <button type="button" className="hud-pinned-note-open" onClick={onOpen}>
        <NotebookPen aria-hidden="true" />
        Open in Notes
      </button>
    </section>
  )
}
