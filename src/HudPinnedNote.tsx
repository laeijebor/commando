import { Eye, NotebookPen, Pencil, Pin, PinOff } from 'lucide-react'
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

import type { PinnedNote } from './pinnedNote'

const PINNED_NOTE_HEIGHT_STORAGE_KEY = 'commando.hud.pinned-note-height'
const DEFAULT_PINNED_NOTE_HEIGHT = 260
const MIN_PINNED_NOTE_HEIGHT = 160
const HUD_SPACE_OUTSIDE_PINNED_NOTE = 250

function storedPinnedNoteHeight(): number {
  try {
    const stored = Number.parseInt(window.localStorage.getItem(PINNED_NOTE_HEIGHT_STORAGE_KEY) ?? '', 10)
    if (!Number.isFinite(stored)) return DEFAULT_PINNED_NOTE_HEIGHT
    return Math.min(Math.max(stored, MIN_PINNED_NOTE_HEIGHT), Math.max(MIN_PINNED_NOTE_HEIGHT, window.innerHeight - HUD_SPACE_OUTSIDE_PINNED_NOTE))
  } catch {
    return DEFAULT_PINNED_NOTE_HEIGHT
  }
}

function storePinnedNoteHeight(height: number): void {
  try {
    window.localStorage.setItem(PINNED_NOTE_HEIGHT_STORAGE_KEY, String(height))
  } catch {
    // Resizing still works for the current page when browser storage is unavailable.
  }
}

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
  const [height, setHeight] = useState(storedPinnedNoteHeight)
  const sectionRef = useRef<HTMLElement>(null)
  const noteRef = useRef(note)
  const draftRef = useRef(draft)
  const savePhaseRef = useRef(savePhase)
  const heightRef = useRef(height)
  const editVersion = useRef(0)
  const saveInFlight = useRef(false)
  const resizeCleanup = useRef<(() => void) | null>(null)

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

  const maximumHeight = () => {
    const hudHeight = sectionRef.current?.closest<HTMLElement>('.agent-hud')?.clientHeight || window.innerHeight
    return Math.max(MIN_PINNED_NOTE_HEIGHT, hudHeight - HUD_SPACE_OUTSIDE_PINNED_NOTE)
  }

  const changeHeight = (next: number, persist: boolean) => {
    const clamped = Math.min(Math.max(next, MIN_PINNED_NOTE_HEIGHT), maximumHeight())
    heightRef.current = clamped
    setHeight(clamped)
    if (persist) storePinnedNoteHeight(clamped)
  }

  useEffect(() => {
    const fitToHud = () => changeHeight(heightRef.current, false)
    fitToHud()
    window.addEventListener('resize', fitToHud)
    return () => {
      window.removeEventListener('resize', fitToHud)
      resizeCleanup.current?.()
    }
  }, [])

  const beginResize = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    resizeCleanup.current?.()
    const startY = event.clientY
    const startHeight = heightRef.current
    const move = (pointerEvent: globalThis.PointerEvent) => changeHeight(startHeight + pointerEvent.clientY - startY, false)
    const stop = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
      window.removeEventListener('pointercancel', stop)
      document.body.classList.remove('is-resizing-hud-pinned-note')
      storePinnedNoteHeight(heightRef.current)
      if (resizeCleanup.current === stop) resizeCleanup.current = null
    }
    document.body.classList.add('is-resizing-hud-pinned-note')
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
    window.addEventListener('pointercancel', stop)
    resizeCleanup.current = stop
  }

  const resizeWithKeyboard = (event: KeyboardEvent<HTMLElement>) => {
    const direction = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0
    if (!direction) return
    event.preventDefault()
    changeHeight(heightRef.current + direction * (event.shiftKey ? 32 : 8), true)
  }

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
    <section ref={sectionRef} className="hud-pinned-note" style={{ height }} aria-label={`Pinned note: ${title}`}>
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
      <div
        className="hud-pinned-note-resize"
        role="separator"
        aria-label="Resize pinned note height"
        aria-orientation="horizontal"
        aria-valuemin={MIN_PINNED_NOTE_HEIGHT}
        aria-valuemax={Math.max(height, maximumHeight())}
        aria-valuenow={height}
        aria-valuetext={`${height} pixels high`}
        tabIndex={0}
        title="Drag to resize; use Up and Down arrows from the keyboard. Double-click to reset."
        onPointerDown={beginResize}
        onKeyDown={resizeWithKeyboard}
        onDoubleClick={() => changeHeight(DEFAULT_PINNED_NOTE_HEIGHT, true)}
      />
      <button type="button" className="hud-pinned-note-open" onClick={onOpen}>
        <NotebookPen aria-hidden="true" />
        Open in Notes
      </button>
    </section>
  )
}
