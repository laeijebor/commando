import { FilePlus2, LoaderCircle, Search, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { createNotesApi, type Note } from './notesApi'
import './notes-section.css'

export function NotesSection({ token }: { token: string }) {
  const api = useRef(createNotesApi(token)).current
  const [notes, setNotes] = useState<Note[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [query, setQuery] = useState('')
  const [phase, setPhase] = useState<'loading' | 'saved' | 'dirty' | 'saving' | 'error'>('loading')
  const [error, setError] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const saveVersion = useRef(0)

  const selectNote = (note: Note) => {
    setSelectedId(note.id)
    setTitle(note.title)
    setBody(note.body)
    setPhase('saved')
    setConfirmDelete(false)
  }

  useEffect(() => {
    let active = true
    api.list().then((next) => {
      if (!active) return
      setNotes(next)
      if (next[0]) selectNote(next[0])
      else setPhase('saved')
    }).catch((cause: unknown) => {
      if (!active) return
      setError(cause instanceof Error ? cause.message : 'Unable to load notes')
      setPhase('error')
    })
    return () => { active = false }
  }, [api])

  const save = async () => {
    if (!selectedId) return
    const version = ++saveVersion.current
    setPhase('saving')
    try {
      const updated = await api.update(selectedId, { title, body })
      if (version !== saveVersion.current) return
      setNotes((current) => [updated, ...current.filter((note) => note.id !== updated.id)])
      setPhase('saved')
      setError('')
    } catch (cause) {
      if (version !== saveVersion.current) return
      setError(cause instanceof Error ? cause.message : 'Unable to save note')
      setPhase('error')
    }
  }

  useEffect(() => {
    if (phase !== 'dirty' || !selectedId) return
    const timer = window.setTimeout(() => { void save() }, 650)
    return () => window.clearTimeout(timer)
  }, [body, phase, selectedId, title])

  const create = async () => {
    try {
      const note = await api.create({ title: 'Untitled note', body: '' })
      setNotes((current) => [note, ...current])
      selectNote(note)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to create note')
      setPhase('error')
    }
  }

  const remove = async () => {
    if (!selectedId) return
    try {
      await api.delete(selectedId)
      const remaining = notes.filter((note) => note.id !== selectedId)
      setNotes(remaining)
      setConfirmDelete(false)
      if (remaining[0]) selectNote(remaining[0])
      else {
        setSelectedId(null)
        setTitle('')
        setBody('')
        setPhase('saved')
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to delete note')
      setPhase('error')
    }
  }

  const filtered = notes.filter((note) =>
    `${note.title} ${note.body}`.toLowerCase().includes(query.trim().toLowerCase()),
  )

  return (
    <section className="notes-section">
      <aside className="notes-list">
        <header>
          <div><span>Local notebook</span><strong>Notes</strong></div>
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
              className={note.id === selectedId ? 'active' : ''}
              onClick={() => selectNote(note)}
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
        {selectedId ? (
          <>
            <header>
              <span className={`notes-save-state ${phase}`}>
                {phase === 'saving' ? <LoaderCircle className="spin" /> : null}
                {phase === 'dirty' ? 'Unsaved' : phase === 'error' ? error : phase === 'saving' ? 'Saving' : 'Saved locally'}
              </span>
              {confirmDelete ? (
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
              value={title}
              maxLength={200}
              onChange={(event) => { setTitle(event.target.value); setPhase('dirty') }}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
                  event.preventDefault()
                  void save()
                }
              }}
              aria-label="Note title"
            />
            <textarea
              value={body}
              onChange={(event) => { setBody(event.target.value); setPhase('dirty') }}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
                  event.preventDefault()
                  void save()
                }
              }}
              placeholder="Write without leaving your cockpit..."
              aria-label="Note body"
            />
          </>
        ) : (
          <div className="notes-empty"><FilePlus2 /><strong>No note selected</strong><button type="button" onClick={() => void create()}>Create note</button></div>
        )}
      </div>
    </section>
  )
}
