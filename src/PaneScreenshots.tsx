import { ChevronDown, ChevronRight, Folder, FolderOpen } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'

import type { PaneScreenshotFolder } from '../shared/protocol'
import type { PaneManagementApiClient } from './paneManagementApi'
import { paneScreenshotUrl, type PaneScreenshotsApiClient } from './paneScreenshotsApi'

export type OpenPaneScreenshot = (
  folder: PaneScreenshotFolder,
  file: string | undefined,
  restoreFocus: HTMLElement,
) => void

export function formatScreenshotBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`
  if (bytes < 1_024 * 1_024) return `${Math.round(bytes / 1_024)} KB`
  return `${(bytes / (1_024 * 1_024)).toFixed(bytes < 10 * 1_024 * 1_024 ? 1 : 0)} MB`
}

export function screenshotRelativeAge(timestamp: number, suffix = ''): string {
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1_000))
  const value = seconds < 60
    ? 'now'
    : seconds < 3_600
      ? `${Math.floor(seconds / 60)}m`
      : seconds < 172_800
        ? `${Math.floor(seconds / 3_600)}h`
        : `${Math.floor(seconds / 86_400)}d`
  return value === 'now' && suffix ? 'just now' : `${value}${suffix}`
}

function folderPrefix(dir: string, topic: string): string {
  const suffix = `/${topic}`
  const parent = dir.endsWith(suffix) ? dir.slice(0, -suffix.length) : dir
  return `${parent.split('/').filter(Boolean).at(-1) ?? 'folder'}/`
}

export function PaneScreenshots({
  paneId,
  folders,
  collapsed,
  seenAt,
  screenshotsApi,
  paneManagementApi,
  onCollapsedChange,
  onSeen,
  onOpen,
}: {
  paneId: string
  folders: PaneScreenshotFolder[]
  collapsed: boolean
  seenAt: number
  screenshotsApi: PaneScreenshotsApiClient
  paneManagementApi: Pick<PaneManagementApiClient, 'revealPaneScreenshot'>
  onCollapsedChange: (collapsed: boolean) => void
  onSeen: (timestamp: number) => void
  onOpen: OpenPaneScreenshot
}) {
  const [selectedId, setSelectedId] = useState(folders[0]?.id ?? '')
  const [listings, setListings] = useState<Record<string, PaneScreenshotFolder>>({})
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set())
  const [error, setError] = useState('')
  const [displaySeenAt, setDisplaySeenAt] = useState(seenAt)
  const wasCollapsed = useRef(collapsed)
  const screenshotsApiRef = useRef(screenshotsApi)
  screenshotsApiRef.current = screenshotsApi
  const visibleFolders = useMemo(() => folders
    .filter((folder) => !dismissed.has(folder.id))
    .map((folder) => listings[folder.id] ?? folder), [dismissed, folders, listings])
  const selected = visibleFolders.find((folder) => folder.id === selectedId) ?? visibleFolders[0]

  useEffect(() => {
    if (!visibleFolders.some((folder) => folder.id === selectedId)) setSelectedId(visibleFolders[0]?.id ?? '')
  }, [selectedId, visibleFolders])

  useEffect(() => {
    if (wasCollapsed.current && !collapsed) setDisplaySeenAt(seenAt)
    wasCollapsed.current = collapsed
  }, [collapsed, seenAt])

  useEffect(() => {
    if (!collapsed) onSeen(Date.now())
  }, [collapsed, onSeen])

  useEffect(() => {
    if (collapsed || !selected) return
    let cancelled = false
    screenshotsApiRef.current.list(selected.id)
      .then((listing) => {
        if (!cancelled) setListings((current) => ({ ...current, [listing.id]: listing }))
      })
      .catch((cause) => { if (!cancelled) setError(cause instanceof Error ? cause.message : 'Unable to refresh screenshots') })
    return () => { cancelled = true }
  }, [collapsed, selected?.id])

  if (!selected) return null
  const preview = selected.preview.slice(0, 5)
  const revealFolder = () => {
    setError('')
    void paneManagementApi.revealPaneScreenshot(paneId, selected.id).catch((cause) => {
      setError(cause instanceof Error ? cause.message : 'Unable to open screenshot folder')
    })
  }
  const open = (event: MouseEvent<HTMLElement>, file?: string) => onOpen(selected, file, event.currentTarget)

  return (
    <section className="pane-worklog-screenshots" aria-label={`Screenshots for pane ${paneId}`}>
      <header className="pane-worklog-screenshots-header">
        <strong>Screenshots</strong>
        <span>
          <button type="button" onClick={revealFolder} aria-label={`Reveal ${selected.topic} in Finder`} title="Reveal folder in Finder">
            <FolderOpen aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => onCollapsedChange(!collapsed)}
            aria-expanded={!collapsed}
            aria-label={`${collapsed ? 'Expand' : 'Collapse'} screenshots`}
            title={`${collapsed ? 'Expand' : 'Collapse'} screenshots`}
          >
            {collapsed ? <ChevronRight aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
          </button>
        </span>
      </header>
      <button type="button" className="pane-worklog-screenshot-folder is-active" onClick={() => onCollapsedChange(false)}>
        <Folder aria-hidden="true" />
        <span><em>{folderPrefix(selected.dir, selected.topic)}</em>{selected.topic}</span>
        <b>{selected.imageCount}</b>
        <small>{screenshotRelativeAge(selected.updatedAt)}</small>
      </button>
      {!collapsed ? (
        <>
          {selected.missing ? (
            <div className="pane-worklog-screenshot-empty">
              <strong>Folder not found</strong>
              <span>Last seen {screenshotRelativeAge(selected.updatedAt, ' ago')} · worktree removed?</span>
              <button type="button" onClick={() => setDismissed((current) => new Set(current).add(selected.id))}>Dismiss</button>
            </div>
          ) : (
            <>
              <div className="pane-worklog-screenshot-grid">
                {preview.map((file) => (
                  <button
                    type="button"
                    className={file.modifiedAt > displaySeenAt ? 'is-new' : ''}
                    title={file.name}
                    aria-label={`Open screenshot ${file.name}`}
                    onClick={(event) => open(event, file.name)}
                    key={file.name}
                  >
                    <img src={paneScreenshotUrl(selected.id, file.name)} alt="" loading="lazy" />
                  </button>
                ))}
                {selected.imageCount > 5 ? (
                  <button type="button" className="is-more" onClick={(event) => open(event)}>
                    <span>+{selected.imageCount - 5}<b>Show all</b></span>
                  </button>
                ) : null}
              </div>
              <footer className="pane-worklog-screenshot-footer">
                <small>{selected.imageCount} images · {selected.otherCount} other {selected.otherCount === 1 ? 'file' : 'files'} · {formatScreenshotBytes(selected.bytes)}</small>
                <button type="button" onClick={(event) => open(event)}>Open folder ›</button>
              </footer>
            </>
          )}
          {visibleFolders.filter((folder) => folder.id !== selected.id).map((folder) => (
            <button
              type="button"
              className="pane-worklog-screenshot-folder"
              onClick={() => setSelectedId(folder.id)}
              key={folder.id}
            >
              <Folder aria-hidden="true" />
              <span><em>{folderPrefix(folder.dir, folder.topic)}</em>{folder.topic}</span>
              <b>{folder.imageCount}</b>
              <small>{screenshotRelativeAge(folder.updatedAt)}</small>
            </button>
          ))}
          {error ? <p className="pane-worklog-screenshot-error" role="alert">{error}</p> : null}
        </>
      ) : null}
    </section>
  )
}
