import { ArrowUp, ChevronRight, Folder, Home, LoaderCircle, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { NoteVaultBrowseResult } from './notesApi'

type Props = {
  mode: 'open' | 'create'
  initialPath: string
  browse(path?: string): Promise<NoteVaultBrowseResult>
  onCancel(): void
  onConfirm(path: string, name?: string): void
}

export function VaultFolderPicker({ mode, initialPath, browse, onCancel, onConfirm }: Props) {
  const [location, setLocation] = useState<NoteVaultBrowseResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [name, setName] = useState('')
  const generation = useRef(0)

  const navigate = async (path?: string) => {
    const request = ++generation.current
    setLoading(true)
    setError('')
    try {
      const next = await browse(path)
      if (request === generation.current) setLocation(next)
    } catch (cause) {
      if (request === generation.current) {
        setLocation(null)
        setError(cause instanceof Error ? cause.message : 'Unable to read directory')
      }
    } finally {
      if (request === generation.current) setLoading(false)
    }
  }

  useEffect(() => {
    void navigate(initialPath)
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      generation.current += 1
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [])

  const validName = (
    name.length > 0 &&
    name === name.trim() &&
    name !== '.' &&
    name !== '..' &&
    !name.includes('/') &&
    !name.includes('\\')
  )
  const confirm = () => {
    if (!location || loading || error || (mode === 'create' && !validName)) return
    onConfirm(location.path, mode === 'create' ? name : undefined)
  }

  return (
    <div className="vault-picker-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel() }}>
      <section className="vault-picker" role="dialog" aria-modal="true" aria-labelledby="vault-picker-title">
        <header>
          <div>
            <span>Markdown vault</span>
            <strong id="vault-picker-title">{mode === 'open' ? 'Open existing vault' : 'Create a new vault'}</strong>
          </div>
          <button type="button" onClick={onCancel} aria-label="Close folder picker"><X /></button>
        </header>
        <div className="vault-picker-toolbar">
          <button type="button" onClick={() => void navigate(location?.home)} disabled={!location || loading} aria-label="Browse home" title="Home"><Home /></button>
          <button type="button" onClick={() => void navigate(location?.parent ?? undefined)} disabled={!location?.parent || loading} aria-label="Up one folder" title="Up one folder"><ArrowUp /></button>
          <div title={location?.path}>{location?.path ?? 'Loading directory...'}</div>
        </div>
        <div className="vault-picker-list" aria-label="Directories">
          {loading ? <div className="vault-picker-status"><LoaderCircle className="spin" />Reading folders</div> : null}
          {!loading && error ? <div className="vault-picker-error" role="alert">{error}</div> : null}
          {!loading && !error && !location?.directories.length ? <div className="vault-picker-status">No subfolders</div> : null}
          {!loading && !error ? location?.directories.map((directory) => (
            <button type="button" onClick={() => void navigate(directory.path)} aria-label={`Open folder ${directory.name}`} key={directory.path}>
              <Folder /><span>{directory.name}</span><ChevronRight />
            </button>
          )) : null}
        </div>
        {mode === 'create' ? (
          <label className="vault-picker-name">
            <span>New folder name</span>
            <input
              value={name}
              maxLength={128}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter') confirm() }}
              placeholder="my-vault"
              autoFocus
            />
          </label>
        ) : null}
        <footer>
          <button type="button" onClick={onCancel}>Cancel</button>
          <button type="button" className="primary" onClick={confirm} disabled={!location || loading || Boolean(error) || (mode === 'create' && !validName)}>
            {mode === 'open' ? 'Open this folder' : 'Create vault here'}
          </button>
        </footer>
      </section>
    </div>
  )
}
