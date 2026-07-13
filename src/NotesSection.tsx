import { FilePlus2, LoaderCircle, Pencil, RefreshCw, Search, Trash2 } from 'lucide-react'
import { type KeyboardEvent, useEffect, useRef, useState } from 'react'
import { NoteBlockEditor } from './NoteBlockEditor'
import { createNotesApi, NotesApiError, type Note } from './notesApi'
import './notes-section.css'

type SavePhase = 'loading' | 'saved' | 'dirty' | 'saving' | 'conflict' | 'error'

type ActiveNote = {
  id: string
  title: string
  body: string
  persistedUpdatedAt: number
}

function activeNote(note: Note): ActiveNote {
  return {
    id: note.id,
    title: note.title,
    body: note.body,
    persistedUpdatedAt: note.updatedAt,
  }
}

export function NotesSection({ token }: { token: string }) {
  const api = useRef(createNotesApi(token)).current
  const [notes, setNotes] = useState<Note[]>([])
  const [active, setActive] = useState<ActiveNote | null>(null)
  const [query, setQuery] = useState('')
  const [phase, setPhase] = useState<SavePhase>('loading')
  const [error, setError] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [externalNote, setExternalNote] = useState<Note | null>(null)
  const [menu, setMenu] = useState<{ noteId: string; x: number; y: number } | null>(null)
  const activeRef = useRef<ActiveNote | null>(null)
  const phaseRef = useRef<SavePhase>('loading')
  const editVersion = useRef(0)
  const saveInFlight = useRef<Promise<boolean> | null>(null)

  const changePhase = (next: SavePhase) => {
    phaseRef.current = next
    setPhase(next)
  }

  const changeActive = (next: ActiveNote | null) => {
    activeRef.current = next
    setActive(next)
  }

  const applyNote = (note: Note) => {
    editVersion.current += 1
    changeActive(activeNote(note))
    changePhase('saved')
    setError('')
    setExternalNote(null)
    setConfirmDelete(false)
  }

  useEffect(() => {
    let activeRequest = true
    api.list().then((next) => {
      if (!activeRequest) return
      setNotes(next)
      if (next[0]) applyNote(next[0])
      else changePhase('saved')
    }).catch((cause: unknown) => {
      if (!activeRequest) return
      setError(cause instanceof Error ? cause.message : 'Unable to load notes')
      changePhase('error')
    })
    return () => { activeRequest = false }
  }, [api])

  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }
    window.addEventListener('pointerdown', close)
    window.addEventListener('keydown', closeOnEscape)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('pointerdown', close)
      window.removeEventListener('keydown', closeOnEscape)
      window.removeEventListener('blur', close)
    }
  }, [menu])

  const save = async (): Promise<boolean> => {
    if (saveInFlight.current) return saveInFlight.current
    const snapshot = activeRef.current
    if (!snapshot || phaseRef.current === 'conflict') return false
    const version = editVersion.current
    changePhase('saving')

    const operation = api.update(snapshot.id, {
      title: snapshot.title,
      body: snapshot.body,
      expectedUpdatedAt: snapshot.persistedUpdatedAt,
    }).then((updated) => {
      setNotes((current) => [updated, ...current.filter((note) => note.id !== updated.id)])
      const current = activeRef.current
      if (current?.id === updated.id) {
        changeActive({ ...current, persistedUpdatedAt: updated.updatedAt })
        changePhase(editVersion.current === version ? 'saved' : 'dirty')
      }
      setError('')
      return true
    }).catch(async (cause: unknown) => {
      if (cause instanceof NotesApiError && (cause.status === 409 || cause.status === 404)) {
        const latest = await api.get(snapshot.id).catch(() => null)
        if (latest) setExternalNote(latest)
        setError(latest
          ? 'This note changed in Obsidian. Reload it or overwrite the external edit.'
          : 'This note was deleted outside Commando. Restore your local edit as a new note.')
        changePhase('conflict')
      } else {
        setError(cause instanceof Error ? cause.message : 'Unable to save note')
        changePhase('error')
      }
      return false
    }).finally(() => {
      saveInFlight.current = null
    })

    saveInFlight.current = operation
    return operation
  }

  const flush = async (): Promise<boolean> => {
    while (phaseRef.current === 'dirty' || phaseRef.current === 'saving') {
      if (!(await save())) return false
    }
    return phaseRef.current === 'saved'
  }

  useEffect(() => {
    if (phase !== 'dirty' || !active) return
    const timer = window.setTimeout(() => { void save() }, 650)
    return () => window.clearTimeout(timer)
  }, [active?.body, active?.title, phase])

  useEffect(() => {
    const timer = window.setInterval(() => {
      void api.list().then((next) => {
        setNotes(next)
        const current = activeRef.current
        if (!current) return
        const latest = next.find((note) => note.id === current.id)
        if (!latest) {
          if (phaseRef.current === 'saved') {
            if (next[0]) applyNote(next[0])
            else changeActive(null)
          } else if (phaseRef.current === 'dirty') {
            setExternalNote(null)
            setError('This note was deleted outside Commando. Restore your local edit as a new note.')
            changePhase('conflict')
          }
          return
        }
        if (latest.updatedAt <= current.persistedUpdatedAt) return

        if (phaseRef.current === 'saved') {
          applyNote(latest)
        } else if (phaseRef.current === 'dirty') {
          setExternalNote(latest)
          setError('This note changed in Obsidian. Reload it or overwrite the external edit.')
          changePhase('conflict')
        }
      }).catch(() => undefined)
    }, 3_000)
    return () => window.clearInterval(timer)
  }, [api])

  useEffect(() => () => {
    void (async () => {
      await saveInFlight.current
      const snapshot = activeRef.current
      if (!snapshot || phaseRef.current !== 'dirty') return
      await api.update(snapshot.id, {
        title: snapshot.title,
        body: snapshot.body,
        expectedUpdatedAt: snapshot.persistedUpdatedAt,
      }).catch(() => undefined)
    })()
  }, [api])

  const selectNote = async (note: Note) => {
    if (note.id === activeRef.current?.id) return
    if (!(await flush())) return
    applyNote(note)
  }

  const create = async () => {
    if (!(await flush())) return
    try {
      const note = await api.create({ title: 'Untitled note', body: '' })
      setNotes((current) => [note, ...current])
      applyNote(note)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to create note')
      changePhase('error')
    }
  }

  const rename = async (noteId: string) => {
    const listed = notes.find((note) => note.id === noteId)
    const selected = activeRef.current?.id === noteId ? activeRef.current : listed
    if (!selected) return
    const title = window.prompt('Rename note', selected.title)?.trim()
    if (!title || title === selected.title) return

    if (activeRef.current?.id === noteId) {
      if (!(await flush())) return
      const current = activeRef.current
      if (!current) return
      editVersion.current += 1
      changeActive({ ...current, title })
      changePhase('dirty')
      await save()
      return
    }

    try {
      const updated = await api.update(listed!.id, {
        title,
        body: listed!.body,
        expectedUpdatedAt: listed!.updatedAt,
      })
      setNotes((current) => [updated, ...current.filter((note) => note.id !== updated.id)])
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to rename note')
      changePhase('error')
    }
  }

  const remove = async (target: ActiveNote | Note | null = activeRef.current) => {
    let selected = target
    if (!selected) return
    if (selected.id === activeRef.current?.id && !(await flush())) return
    if (selected.id === activeRef.current?.id) selected = activeRef.current
    if (!selected) return
    const deletingActive = selected.id === activeRef.current?.id
    const expectedUpdatedAt = 'updatedAt' in selected ? selected.updatedAt : selected.persistedUpdatedAt
    try {
      await api.delete(selected.id, expectedUpdatedAt)
      const remaining = notes.filter((note) => note.id !== selected.id)
      setNotes(remaining)
      setConfirmDelete(false)
      if (deletingActive) {
        if (remaining[0]) applyNote(remaining[0])
        else {
          changeActive(null)
          changePhase('saved')
        }
      }
    } catch (cause) {
      if (cause instanceof NotesApiError && (cause.status === 409 || cause.status === 404)) {
        const latest = await api.get(selected.id).catch(() => null)
        setExternalNote(latest)
        setError(latest
          ? 'This note changed in Obsidian. Reload it before deleting.'
          : 'This note was already deleted outside Commando.')
        changePhase('conflict')
      } else {
        setError(cause instanceof Error ? cause.message : 'Unable to delete note')
        changePhase('error')
      }
    }
  }

  const deleteFromMenu = async (noteId: string) => {
    const note = activeRef.current?.id === noteId ? activeRef.current : notes.find((candidate) => candidate.id === noteId)
    if (!note || !window.confirm(`Delete note “${note.title || 'Untitled note'}”?`)) return
    await remove(note)
  }

  const openMenu = (noteId: string, x: number, y: number) => {
    setMenu({
      noteId,
      x: Math.max(8, Math.min(x, window.innerWidth - 188)),
      y: Math.max(8, Math.min(y, window.innerHeight - 82)),
    })
  }

  const menuKey = (event: KeyboardEvent<HTMLButtonElement>, noteId: string) => {
    if ((event.shiftKey && event.key === 'F10') || event.key === 'ContextMenu') {
      event.preventDefault()
      const bounds = event.currentTarget.getBoundingClientRect()
      openMenu(noteId, bounds.left + 28, bounds.bottom)
    }
  }

  const reloadExternal = async () => {
    const selected = activeRef.current
    if (!selected) return
    const latest = externalNote ?? await api.get(selected.id)
    setNotes((current) => [latest, ...current.filter((note) => note.id !== latest.id)])
    applyNote(latest)
  }

  const overwriteExternal = async () => {
    const current = activeRef.current
    if (!current || !externalNote) return
    changeActive({ ...current, persistedUpdatedAt: externalNote.updatedAt })
    changePhase('dirty')
    setExternalNote(null)
    await save()
  }

  const restoreDeleted = async () => {
    const current = activeRef.current
    if (!current) return
    try {
      const restored = await api.create({ title: current.title, body: current.body })
      setNotes((existing) => [restored, ...existing.filter((note) => note.id !== current.id)])
      applyNote(restored)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to restore note')
      changePhase('error')
    }
  }

  const filtered = notes.filter((note) =>
    `${note.title} ${note.body}`.toLowerCase().includes(query.trim().toLowerCase()),
  )

  return (
    <section className="notes-section">
      <aside className="notes-list">
        <header>
          <div><span>Markdown vault</span><strong>Notes</strong></div>
          <button type="button" onClick={() => void create()} aria-label="Create note"><FilePlus2 /></button>
        </header>
        <label className="notes-search">
          <Search aria-hidden="true" />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search notes" />
        </label>
        <div className="notes-items">
          {filtered.map((note) => (
            <button
              type="button"
              className={note.id === active?.id ? 'active' : ''}
              onClick={() => { void selectNote(note) }}
              onContextMenu={(event) => {
                event.preventDefault()
                openMenu(note.id, event.clientX, event.clientY)
              }}
              onKeyDown={(event) => menuKey(event, note.id)}
              key={note.id}
            >
              <strong>{note.title || 'Untitled note'}</strong>
              <span>{note.body.trim().slice(0, 90) || 'Empty note'}</span>
              <time>{new Date(note.updatedAt).toLocaleString()}</time>
            </button>
          ))}
          {!filtered.length ? <p>{notes.length ? 'No matching notes.' : 'Create your first note.'}</p> : null}
        </div>
      </aside>
      <div className="notes-editor">
        {active ? (
          <>
            <header>
              <span className={`notes-save-state ${phase}`}>
                {phase === 'saving' ? <LoaderCircle className="spin" /> : null}
                {phase === 'conflict' || phase === 'error'
                  ? error
                  : phase === 'dirty'
                    ? 'Unsaved Markdown'
                    : phase === 'saving'
                      ? 'Saving Markdown'
                      : 'Saved to vault'}
              </span>
              {phase === 'conflict' ? (
                <span className="notes-conflict-actions">
                  {externalNote ? (
                    <>
                      <button type="button" onClick={() => void reloadExternal()}><RefreshCw />Reload</button>
                      <button type="button" onClick={() => void overwriteExternal()}>Overwrite</button>
                    </>
                  ) : (
                    <button type="button" onClick={() => void restoreDeleted()}><RefreshCw />Restore</button>
                  )}
                </span>
              ) : confirmDelete ? (
                <span className="notes-delete-confirm">
                  <span>Delete this note?</span>
                  <button type="button" onClick={() => void remove()}>Delete</button>
                  <button type="button" onClick={() => setConfirmDelete(false)}>Cancel</button>
                </span>
              ) : (
                <button type="button" className="notes-delete" onClick={() => setConfirmDelete(true)} aria-label="Delete note"><Trash2 /></button>
              )}
            </header>
            <input
              className="notes-title"
              value={active.title}
              maxLength={200}
              onChange={(event) => {
                const next = { ...activeRef.current!, title: event.target.value }
                editVersion.current += 1
                changeActive(next)
                changePhase('dirty')
              }}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
                  event.preventDefault()
                  void save()
                }
              }}
              aria-label="Note title"
            />
            <NoteBlockEditor
              markdown={active.body}
              uploadImage={(file) => api.uploadImage(active.id, file)}
              resolveImageUrl={api.resolveImageUrl}
              onChange={(body) => {
                const current = activeRef.current
                if (!current || current.body === body) return
                editVersion.current += 1
                changeActive({ ...current, body })
                changePhase('dirty')
              }}
              onSave={() => { void save() }}
            />
          </>
        ) : (
          <div className="notes-empty"><FilePlus2 /><strong>No note selected</strong><button type="button" onClick={() => void create()}>Create note</button></div>
        )}
      </div>
      {menu ? (
        <div
          className="notes-context-menu"
          style={{ left: menu.x, top: menu.y }}
          role="menu"
          onPointerDown={(event) => event.stopPropagation()}
        >
          <button type="button" role="menuitem" onClick={() => { void rename(menu.noteId); setMenu(null) }}><Pencil /> Rename</button>
          <button type="button" className="danger" role="menuitem" onClick={() => { void deleteFromMenu(menu.noteId); setMenu(null) }}><Trash2 /> Delete note</button>
        </div>
      ) : null}
    </section>
  )
}
