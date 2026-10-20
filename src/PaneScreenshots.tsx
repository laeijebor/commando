import { ChevronDown, ChevronRight, Folder, FolderOpen } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'

import type { PaneScreenshotFolder } from '../shared/protocol'
import type { PaneManagementApiClient } from './paneManagementApi'
import { paneScreenshotUrl, PaneScreenshotsApiError, type PaneScreenshotsApiClient } from './paneScreenshotsApi'

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

// Narrower than 1:2.5 (beyond any phone screen) means a full-page capture; its tile shows the top instead of a sliver.
const MIN_TILE_RATIO = 0.4

// The tile takes the image's own aspect ratio once it loads, so it is shown whole rather than cropped.
function ScreenshotTile({ src, name, isNew, onOpen }: {
  src: string
  name: string
  isNew: boolean
  onOpen: (event: MouseEvent<HTMLElement>) => void
}) {
  const [ratio, setRatio] = useState<number>()
  const isTall = ratio !== undefined && ratio < MIN_TILE_RATIO
  return (
    <button
      type="button"
      className={[isNew ? 'is-new' : '', isTall ? 'is-tall' : ''].filter(Boolean).join(' ')}
      style={ratio === undefined ? undefined : { aspectRatio: Math.max(ratio, MIN_TILE_RATIO) }}
      title={name}
      aria-label={`Open screenshot ${name}`}
      onClick={onOpen}
    >
      <img
        src={src}
        alt=""
        loading="lazy"
        onLoad={(event) => {
          const { naturalWidth, naturalHeight } = event.currentTarget
          if (naturalWidth && naturalHeight) setRatio(naturalWidth / naturalHeight)
        }}
      />
    </button>
  )
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
  revealInFinder = true,
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
  revealInFinder?: boolean
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
    .map((folder) => {
      const listing = listings[folder.id]
      return listing && listing.updatedAt >= folder.updatedAt ? listing : folder
    }), [dismissed, folders, listings])
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
    setError('')
    screenshotsApiRef.current.list(selected.id)
      .then((listing) => {
        if (!cancelled) setListings((current) => {
          const cached = current[listing.id]
          return cached && cached.updatedAt > listing.updatedAt ? current : { ...current, [listing.id]: listing }
        })
      })
      .catch((cause) => {
        if (cancelled) return
        if (cause instanceof PaneScreenshotsApiError && cause.code === 'not_found') {
          setListings((current) => ({ ...current, [selected.id]: { ...selected, missing: true, preview: [] } }))
          setError('')
        } else {
          setError(cause instanceof Error ? cause.message : 'Unable to refresh screenshots')
        }
      })
    return () => { cancelled = true }
  }, [collapsed, selected?.id, selected?.updatedAt])

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
          {revealInFinder ? (
            <button type="button" onClick={revealFolder} aria-label={`Reveal ${selected.topic} in Finder`} title="Reveal folder in Finder">
              <FolderOpen aria-hidden="true" />
            </button>
          ) : null}
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
                  <ScreenshotTile
                    src={paneScreenshotUrl(selected.id, file.name, file.modifiedAt)}
                    name={file.name}
                    isNew={file.modifiedAt > displaySeenAt}
                    onOpen={(event) => open(event, file.name)}
                    key={file.name}
                  />
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
