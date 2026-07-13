import {
  FilePlus2,
  Folder,
  FolderInput,
  FolderOpen,
  FolderPlus,
  History,
  LoaderCircle,
  Pencil,
  RefreshCw,
  Search,
  Trash2,
} from 'lucide-react'
import { type KeyboardEvent, useEffect, useRef, useState } from 'react'
import { NoteBlockEditor } from './NoteBlockEditor'
import { createNotesApi, NotesApiError, type Note, type NoteVaultSnapshot } from './notesApi'
import './notes-section.css'

type SavePhase = 'loading' | 'saved' | 'dirty' | 'saving' | 'conflict' | 'error'

type ActiveNote = {
  id: string
  title: string
  body: string
  folder: string
  persistedUpdatedAt: number
}

function activeNote(note: Note): ActiveNote {
  return {
    id: note.id,
    title: note.title,
    body: note.body,
    folder: note.folder,
    persistedUpdatedAt: note.updatedAt,
  }
}

export function NotesSection({ token }: { token: string }) {
  const api = useRef(createNotesApi(token)).current
  const [notes, setNotes] = useState<Note[]>([])
  const [folders, setFolders] = useState<string[]>([])
  const [folderFilter, setFolderFilter] = useState<string | null>(null)
  const [vaultState, setVaultState] = useState<NoteVaultSnapshot | null>(null)
  const [vaultError, setVaultError] = useState('')
  const [vaultBusy, setVaultBusy] = useState(false)
  const [active, setActive] = useState<ActiveNote | null>(null)
  const [query, setQuery] = useState('')
  const [phase, setPhase] = useState<SavePhase>('loading')
  const [error, setError] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [externalNote, setExternalNote] = useState<Note | null>(null)
  const [menu, setMenu] = useState<{ noteId: string; x: number; y: number } | null>(null)
  const activeRef = useRef<ActiveNote | null>(null)
  const vaultIdRef = useRef('')
  const phaseRef = useRef<SavePhase>('loading')
  const editVersion = useRef(0)
  const loadGeneration = useRef(0)
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

  const loadVault = async (vaultId: string) => {
    const generation = ++loadGeneration.current
    changePhase('loading')
    try {
      const snapshot = await api.list(vaultId)
      if (generation !== loadGeneration.current || vaultIdRef.current !== vaultId) return
      setNotes(snapshot.notes)
      setFolders(snapshot.folders)
      setFolderFilter(null)
      setQuery('')
      setVaultError('')
      if (snapshot.notes[0]) applyNote(snapshot.notes[0])
      else {
        changeActive(null)
        changePhase('saved')
      }
    } catch (cause) {
      if (generation !== loadGeneration.current) return
      setVaultError(cause instanceof Error ? cause.message : 'Unable to load vault')
      changeActive(null)
      changePhase('error')
    }
  }

  const applyVaultState = (next: NoteVaultSnapshot) => {
    setVaultState(next)
    vaultIdRef.current = next.activeVaultId
  }

  useEffect(() => {
    let activeRequest = true
    void api.vaults().then((next) => {
      if (!activeRequest) return
      applyVaultState(next)
      void loadVault(next.activeVaultId)
    }).catch((cause: unknown) => {
      if (!activeRequest) return
      setVaultError(cause instanceof Error ? cause.message : 'Unable to load note vaults')
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
    const vaultId = vaultIdRef.current
    if (!snapshot || !vaultId || phaseRef.current === 'conflict') return false
    const version = editVersion.current
    changePhase('saving')

    const operation = api.update(vaultId, snapshot.id, {
      title: snapshot.title,
      body: snapshot.body,
      folder: snapshot.folder,
      expectedUpdatedAt: snapshot.persistedUpdatedAt,
    }).then((updated) => {
      if (vaultIdRef.current !== vaultId) return false
      setNotes((current) => [updated, ...current.filter((note) => note.id !== updated.id)])
      const current = activeRef.current
      if (current?.id === updated.id) {
        changeActive({ ...current, persistedUpdatedAt: updated.updatedAt })
        changePhase(editVersion.current === version ? 'saved' : 'dirty')
      }
      setError('')
      return true
    }).catch(async (cause: unknown) => {
      if (vaultIdRef.current !== vaultId) return false
      if (cause instanceof NotesApiError && (cause.status === 409 || cause.status === 404)) {
        const latest = await api.get(vaultId, snapshot.id).catch(() => null)
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
    const vaultId = vaultState?.activeVaultId
    if (!vaultId) return
    const timer = window.setInterval(() => {
      void api.list(vaultId).then((snapshot) => {
        if (vaultIdRef.current !== vaultId) return
        setNotes(snapshot.notes)
        setFolders(snapshot.folders)
        const current = activeRef.current
        if (!current) return
        const latest = snapshot.notes.find((note) => note.id === current.id)
        if (!latest) {
          if (phaseRef.current === 'saved') {
            if (snapshot.notes[0]) applyNote(snapshot.notes[0])
            else changeActive(null)
          } else if (phaseRef.current === 'dirty') {
            setExternalNote(null)
            setError('This note was deleted outside Commando. Restore your local edit as a new note.')
            changePhase('conflict')
          }
          return
        }
        if (latest.updatedAt <= current.persistedUpdatedAt) return
        if (phaseRef.current === 'saved') applyNote(latest)
        else if (phaseRef.current === 'dirty') {
          setExternalNote(latest)
          setError('This note changed in Obsidian. Reload it or overwrite the external edit.')
          changePhase('conflict')
        }
      }).catch(() => undefined)
    }, 3_000)
    return () => window.clearInterval(timer)
  }, [api, vaultState?.activeVaultId])

  useEffect(() => () => {
    void (async () => {
      await saveInFlight.current
      const snapshot = activeRef.current
      const vaultId = vaultIdRef.current
      if (!snapshot || !vaultId || phaseRef.current !== 'dirty') return
      await api.update(vaultId, snapshot.id, {
        title: snapshot.title,
        body: snapshot.body,
        folder: snapshot.folder,
        expectedUpdatedAt: snapshot.persistedUpdatedAt,
      }).catch(() => undefined)
    })()
  }, [api])

  const runVaultAction = async (action: () => Promise<NoteVaultSnapshot>) => {
    if (!(await flush())) return
    setVaultBusy(true)
    setVaultError('')
    try {
      const next = await action()
      applyVaultState(next)
      await loadVault(next.activeVaultId)
    } catch (cause) {
      setVaultError(cause instanceof Error ? cause.message : 'Unable to update note vault')
    } finally {
      setVaultBusy(false)
    }
  }

  const switchVault = (id: string) => {
    if (id === vaultIdRef.current) return
    void runVaultAction(() => api.selectVault(id))
  }

  const openVault = () => {
    const currentPath = vaultState?.vaults.find((vault) => vault.id === vaultState.activeVaultId)?.path ?? ''
    const path = window.prompt('Open existing Markdown vault', currentPath)?.trim()
    if (path) void runVaultAction(() => api.openVault(path))
  }

  const createVault = () => {
    const currentPath = vaultState?.vaults.find((vault) => vault.id === vaultState.activeVaultId)?.path ?? ''
    const parent = currentPath.replace(/\/[^/]+\/?$/, '')
    const path = window.prompt('Create Markdown vault', parent ? `${parent}/new-vault` : '')?.trim()
    if (path) void runVaultAction(() => api.createVault(path))
  }

  const clearVaultHistory = () => {
    if (!window.confirm('Clear previously opened vaults? No files will be deleted.')) return
    void runVaultAction(() => api.clearVaultHistory())
  }

  const createFolder = async () => {
    const vaultId = vaultIdRef.current
    if (!vaultId) return
    const folder = window.prompt('New folder path', '')?.trim()
    if (!folder) return
    try {
      const next = await api.createFolder(vaultId, folder)
      setFolders(next)
      setFolderFilter(folder)
      setVaultError('')
    } catch (cause) {
      setVaultError(cause instanceof Error ? cause.message : 'Unable to create folder')
    }
  }

  const selectNote = async (note: Note) => {
    if (note.id === activeRef.current?.id) return
    if (!(await flush())) return
    applyNote(note)
  }

  const create = async () => {
    if (!(await flush())) return
    const vaultId = vaultIdRef.current
    if (!vaultId) return
    try {
      const note = await api.create(vaultId, {
        title: 'Untitled note',
        body: '',
        folder: folderFilter ?? '',
      })
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
    const vaultId = vaultIdRef.current
    if (!listed || !vaultId) return
    try {
      const updated = await api.update(vaultId, listed.id, {
        title,
        body: listed.body,
        folder: listed.folder,
        expectedUpdatedAt: listed.updatedAt,
      })
      setNotes((current) => [updated, ...current.filter((note) => note.id !== updated.id)])
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to rename note')
      changePhase('error')
    }
  }

  const move = async (noteId: string, folder: string) => {
    const listed = notes.find((note) => note.id === noteId)
    const selected = activeRef.current?.id === noteId ? activeRef.current : listed
    const vaultId = vaultIdRef.current
    if (!selected || !vaultId || selected.folder === folder) return
    if (activeRef.current?.id === noteId && !(await flush())) return
    const current = activeRef.current?.id === noteId ? activeRef.current : listed
    if (!current) return
    try {
      const updated = await api.update(vaultId, current.id, {
        title: current.title,
        body: current.body,
        folder,
        expectedUpdatedAt: 'updatedAt' in current ? current.updatedAt : current.persistedUpdatedAt,
      })
      setNotes((existing) => [updated, ...existing.filter((note) => note.id !== updated.id)])
      if (activeRef.current?.id === noteId) applyNote(updated)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to move note')
      changePhase('error')
    }
  }

  const remove = async (target: ActiveNote | Note | null = activeRef.current) => {
    let selected = target
    if (!selected) return
    if (selected.id === activeRef.current?.id && !(await flush())) return
    if (selected.id === activeRef.current?.id) selected = activeRef.current
    const vaultId = vaultIdRef.current
    if (!selected || !vaultId) return
    const deletingActive = selected.id === activeRef.current?.id
    const expectedUpdatedAt = 'updatedAt' in selected ? selected.updatedAt : selected.persistedUpdatedAt
    try {
      await api.delete(vaultId, selected.id, expectedUpdatedAt)
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
        const latest = await api.get(vaultId, selected.id).catch(() => null)
        setExternalNote(latest)
        setError(latest ? 'This note changed in Obsidian. Reload it before deleting.' : 'This note was already deleted outside Commando.')
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
      x: Math.max(8, Math.min(x, window.innerWidth - 228)),
      y: Math.max(8, Math.min(y, window.innerHeight - 320)),
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
    const vaultId = vaultIdRef.current
    if (!selected || !vaultId) return
    const latest = externalNote ?? await api.get(vaultId, selected.id)
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
    const vaultId = vaultIdRef.current
    if (!current || !vaultId) return
    try {
      const restored = await api.create(vaultId, { title: current.title, body: current.body, folder: current.folder })
      setNotes((existing) => [restored, ...existing.filter((note) => note.id !== current.id)])
      applyNote(restored)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to restore note')
      changePhase('error')
    }
  }

  const normalizedQuery = query.trim().toLowerCase()
  const filtered = notes.filter((note) => {
    if (normalizedQuery) return `${note.title} ${note.body} ${note.folder}`.toLowerCase().includes(normalizedQuery)
    return folderFilter === null || note.folder === folderFilter
  })
  const currentVault = vaultState?.vaults.find((vault) => vault.id === vaultState.activeVaultId)
  const menuNote = menu ? notes.find((note) => note.id === menu.noteId) : null

  return (
    <section className="notes-section">
      <aside className="notes-list">
        <header>
          <div className="notes-heading">
            <span>Markdown vault</span>
            <strong title={currentVault?.path}>{currentVault?.name ?? 'Notes'}</strong>
          </div>
          <button type="button" onClick={() => void create()} aria-label="Create note"><FilePlus2 /></button>
        </header>
        <div className="notes-vault-tools">
          <select
            aria-label="Note vault"
            value={vaultState?.activeVaultId ?? ''}
            disabled={vaultBusy || !vaultState}
            onChange={(event) => switchVault(event.target.value)}
          >
            {vaultState?.vaults.map((vault) => (
              <option value={vault.id} disabled={!vault.available} key={vault.id}>
                {vault.name}{vault.available ? '' : ' (unavailable)'}
              </option>
            ))}
          </select>
          <button type="button" onClick={openVault} disabled={vaultBusy} aria-label="Open vault" title="Open existing vault"><FolderOpen /></button>
          <button type="button" onClick={createVault} disabled={vaultBusy} aria-label="Create vault" title="Create vault"><FolderPlus /></button>
          <button type="button" onClick={clearVaultHistory} disabled={vaultBusy || (vaultState?.vaults.length ?? 0) < 2} aria-label="Clear vault history" title="Clear vault history"><History /></button>
        </div>
        {currentVault ? <div className="notes-vault-path" title={currentVault.path}>{currentVault.path}</div> : null}
        {vaultError ? <button type="button" className="notes-vault-error" onClick={() => setVaultError('')}>{vaultError}</button> : null}
        <label className="notes-search">
          <Search aria-hidden="true" />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search notes" />
        </label>
        <nav className="notes-folders" aria-label="Note folders">
          <div><span>Folders</span><button type="button" onClick={() => void createFolder()} aria-label="Create folder"><FolderPlus /></button></div>
          <button type="button" className={folderFilter === null ? 'active' : ''} onClick={() => setFolderFilter(null)}><Folder /> All notes <small>{notes.length}</small></button>
          <button type="button" className={folderFilter === '' ? 'active' : ''} onClick={() => setFolderFilter('')}><Folder /> Root <small>{notes.filter((note) => !note.folder).length}</small></button>
          {folders.map((folder) => (
            <button
              type="button"
              className={folderFilter === folder ? 'active' : ''}
              style={{ paddingLeft: 10 + folder.split('/').length * 10 }}
              onClick={() => setFolderFilter(folder)}
              title={folder}
              key={folder}
            >
              <Folder /> {folder.split('/').at(-1)} <small>{notes.filter((note) => note.folder === folder).length}</small>
            </button>
          ))}
        </nav>
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
              <span className="note-list-meta"><small>{note.folder || 'Root'}</small><time>{new Date(note.updatedAt).toLocaleString()}</time></span>
            </button>
          ))}
          {!filtered.length ? <p>{notes.length ? 'No notes in this view.' : 'Create your first note.'}</p> : null}
        </div>
      </aside>
      <div className="notes-editor">
        {active ? (
          <>
            <header>
              <span className="notes-editor-folder"><Folder />{active.folder || 'Root'}</span>
              <span className={`notes-save-state ${phase}`}>
                {phase === 'saving' || phase === 'loading' ? <LoaderCircle className="spin" /> : null}
                {phase === 'conflict' || phase === 'error'
                  ? error
                  : phase === 'dirty'
                    ? 'Unsaved Markdown'
                    : phase === 'saving'
                      ? 'Saving Markdown'
                      : phase === 'loading'
                        ? 'Loading vault'
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
              uploadImage={(file) => api.uploadImage(vaultIdRef.current, active.id, file)}
              resolveImageUrl={(url) => api.resolveImageUrl(url, vaultIdRef.current)}
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
          {(['', ...folders] as string[]).filter((folder) => folder !== menuNote?.folder).map((folder) => (
            <button type="button" role="menuitem" onClick={() => { void move(menu.noteId, folder); setMenu(null) }} key={folder || 'root'}>
              <FolderInput /> Move to {folder || 'Root'}
            </button>
          ))}
          <button type="button" className="danger" role="menuitem" onClick={() => { void deleteFromMenu(menu.noteId); setMenu(null) }}><Trash2 /> Delete note</button>
        </div>
      ) : null}
    </section>
  )
}
