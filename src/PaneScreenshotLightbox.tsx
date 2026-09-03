import { ChevronLeft, ChevronRight, FolderSearch, Maximize, Minimize, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { PaneScreenshotFolder } from '../shared/protocol'
import type { PaneManagementApiClient } from './paneManagementApi'
import { formatScreenshotBytes, screenshotRelativeAge } from './PaneScreenshots'
import { paneScreenshotUrl, PaneScreenshotsApiError, type PaneScreenshotListing, type PaneScreenshotsApiClient } from './paneScreenshotsApi'

export type PaneScreenshotLightboxRequest = {
  paneId: string
  folder: PaneScreenshotFolder
  file?: string
  restoreFocus: HTMLElement
}

function filenameParts(name: string): [string, string] {
  const separator = name.indexOf('-')
  return separator > 0 ? [name.slice(0, separator + 1), name.slice(separator + 1)] : ['', name]
}

export function PaneScreenshotLightbox({ request, screenshotsApi, paneManagementApi, revealInFinder = true, onClose }: {
  request: PaneScreenshotLightboxRequest
  screenshotsApi: PaneScreenshotsApiClient
  paneManagementApi: Pick<PaneManagementApiClient, 'revealPaneScreenshot'>
  revealInFinder?: boolean
  onClose: () => void
}) {
  const [listing, setListing] = useState<PaneScreenshotListing | null>(null)
  const [current, setCurrent] = useState(0)
  const [actualSize, setActualSize] = useState(false)
  const [dimensions, setDimensions] = useState('')
  const [error, setError] = useState('')
  const closeRef = useRef<HTMLButtonElement>(null)
  const screenshotsApiRef = useRef(screenshotsApi)
  screenshotsApiRef.current = screenshotsApi

  const close = useCallback(() => {
    onClose()
    window.requestAnimationFrame(() => request.restoreFocus.focus())
  }, [onClose, request.restoreFocus])

  useEffect(() => {
    let cancelled = false
    screenshotsApiRef.current.list(request.folder.id)
      .then((next) => {
        if (cancelled) return
        setListing(next)
        setCurrent(Math.max(0, request.file ? next.files.findIndex((file) => file.name === request.file) : 0))
      })
      .catch((cause) => {
        if (cancelled) return
        if (cause instanceof PaneScreenshotsApiError && cause.code === 'not_found') {
          setListing({ ...request.folder, imageCount: 0, otherCount: 0, bytes: 0, missing: true, preview: [], files: [] })
          setError('')
        } else {
          setError(cause instanceof Error ? cause.message : 'Unable to load screenshots')
        }
      })
    closeRef.current?.focus()
    return () => { cancelled = true }
  }, [request.file, request.folder.id, request.folder.updatedAt])

  const files = listing?.files ?? []
  const file = files[current]
  const move = useCallback((step: number) => {
    setCurrent((index) => files.length ? (index + step + files.length) % files.length : 0)
    setDimensions('')
  }, [files.length])

  useEffect(() => {
    const keydown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); close() }
      else if (event.key === 'ArrowLeft') { event.preventDefault(); move(-1) }
      else if (event.key === 'ArrowRight') { event.preventDefault(); move(1) }
    }
    window.addEventListener('keydown', keydown)
    return () => window.removeEventListener('keydown', keydown)
  }, [close, move])

  const filmstrip = useMemo(() => {
    if (files.length <= 4) return files.map((candidate, index) => ({ candidate, index }))
    const start = Math.min(Math.max(0, current - 1), files.length - 4)
    return files.slice(start, start + 4).map((candidate, offset) => ({ candidate, index: start + offset }))
  }, [current, files])
  const [prefix, suffix] = filenameParts(file?.name ?? request.file ?? request.folder.topic)

  return (
    <div className="pane-screenshot-lightbox-backdrop" data-native-terminal-occluder="" onMouseDown={close}>
      <div
        className="pane-screenshot-lightbox"
        role="dialog"
        aria-modal="true"
        aria-label={`Screenshot preview for ${request.folder.topic}`}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <span className="pane-screenshot-lightbox-count">{file ? current + 1 : 0} / {files.length}</span>
          <span className="pane-screenshot-lightbox-file"><em>{prefix}</em>{suffix}</span>
          <span className="pane-screenshot-lightbox-actions">
            <button type="button" onClick={() => setActualSize((value) => !value)}>
              {actualSize ? <Minimize aria-hidden="true" /> : <Maximize aria-hidden="true" />}
              {actualSize ? 'Fit to window' : 'Actual size'}
            </button>
            {revealInFinder ? (
              <button
                type="button"
                className="primary"
                disabled={!file}
                onClick={() => file && void paneManagementApi.revealPaneScreenshot(request.paneId, request.folder.id, file.name).catch((cause) => setError(cause instanceof Error ? cause.message : 'Unable to reveal file'))}
              >
                <FolderSearch aria-hidden="true" />Reveal in Finder
              </button>
            ) : null}
            <button ref={closeRef} type="button" aria-label="Close screenshot preview" onClick={close}><X aria-hidden="true" /></button>
          </span>
        </header>
        <div className={`pane-screenshot-lightbox-stage${actualSize ? ' is-actual' : ''}`}>
          {file ? (
            <>
              <button type="button" className="pane-screenshot-lightbox-nav prev" aria-label="Previous screenshot" onClick={() => move(-1)}><ChevronLeft aria-hidden="true" /></button>
              <img
                src={paneScreenshotUrl(request.folder.id, file.name, file.modifiedAt)}
                alt={file.name}
                onLoad={(event) => setDimensions(`${event.currentTarget.naturalWidth}×${event.currentTarget.naturalHeight}`)}
              />
              <button type="button" className="pane-screenshot-lightbox-nav next" aria-label="Next screenshot" onClick={() => move(1)}><ChevronRight aria-hidden="true" /></button>
            </>
          ) : <div className="pane-screenshot-lightbox-empty">{error || (listing?.missing ? 'Folder not found' : 'Loading screenshots…')}</div>}
        </div>
        <footer>
          <small title={`${request.folder.dir}/${file?.name ?? ''}`}>
            {request.folder.dir}/{file?.name ?? ''}{file ? ` · ${dimensions || '…'} · ${formatScreenshotBytes(file.size)} · ${screenshotRelativeAge(file.modifiedAt, ' ago')}` : ''}
          </small>
          <span className="pane-screenshot-lightbox-filmstrip">
            {filmstrip.map(({ candidate, index }) => (
              <button type="button" className={index === current ? 'is-current' : ''} aria-label={`View ${candidate.name}`} onClick={() => { setCurrent(index); setDimensions('') }} key={candidate.name}>
                <img src={paneScreenshotUrl(request.folder.id, candidate.name, candidate.modifiedAt)} alt="" loading="lazy" />
              </button>
            ))}
          </span>
          <span className="pane-screenshot-lightbox-keys"><kbd>←</kbd> <kbd>→</kbd> <kbd>esc</kbd></span>
        </footer>
        {error && file ? <p className="pane-screenshot-lightbox-error" role="alert">{error}</p> : null}
      </div>
    </div>
  )
}
