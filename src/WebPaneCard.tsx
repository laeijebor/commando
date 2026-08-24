import { useEffect, useRef, useState, type DragEvent } from 'react'
import { ExternalLink, Globe, Maximize2, MessageSquarePlus, Minimize2, PictureInPicture2, RotateCw, ShieldAlert, Wrench, X } from 'lucide-react'
import type { WebPane, WebPaneFeedbackInfo } from '../shared/protocol'
import { getNativeWebViewBridge, type NativeWebViewBridge } from './nativeWebViewBridge'
import { NativeWebViewTile } from './NativeWebViewTile'
import { ChromiumTileCard, type PendingQueueApi } from './ChromiumTileCard'
import './web-pane.css'

const ATTRIBUTION_VISIBLE_MS = 8_000
const LOAD_WATCHDOG_MS = 8_000
export const CHROMIUM_RENDERER_STORAGE_KEY = 'commando.chromium.renderer.v1'

type ChromiumRenderer = 'canvas' | 'native'

function loadChromiumRenderer(): ChromiumRenderer {
  try {
    return window.localStorage.getItem(CHROMIUM_RENDERER_STORAGE_KEY) === 'native' ? 'native' : 'canvas'
  } catch {
    return 'canvas'
  }
}

function saveChromiumRenderer(renderer: ChromiumRenderer): void {
  try {
    window.localStorage.setItem(CHROMIUM_RENDERER_STORAGE_KEY, renderer)
  } catch {
    // The in-memory choice still works when storage is unavailable.
  }
}

/** Inert fallback for callers that never wire a pending queue (tests). */
const EMPTY_PENDING_SNAPSHOT = { notes: [], knownUpTo: Number.POSITIVE_INFINITY, dropped: 0 }
const EMPTY_PENDING_QUEUE: PendingQueueApi = {
  list: async () => EMPTY_PENDING_SNAPSHOT,
  add: async () => EMPTY_PENDING_SNAPSHOT,
  update: async () => EMPTY_PENDING_SNAPSHOT,
  upload: async () => EMPTY_PENDING_SNAPSHOT,
  removeAttachment: async () => EMPTY_PENDING_SNAPSHOT,
  attachmentUrl: () => '',
  remove: async () => EMPTY_PENDING_SNAPSHOT,
  send: async () => EMPTY_PENDING_SNAPSHOT,
  dismissDropped: async () => EMPTY_PENDING_SNAPSHOT,
}

/** Localhost pages embed fine as iframes in every client, including the desktop shell. */
export function isLocalWebPaneUrl(url: string): boolean {
  try {
    const { hostname } = new URL(url)
    return (
      hostname === 'localhost' ||
      hostname.endsWith('.localhost') ||
      hostname === '127.0.0.1' ||
      hostname === '::1' ||
      hostname === '[::1]'
    )
  } catch {
    return true
  }
}

function urlParts(url: string): { host: string; path: string } {
  try {
    const parsed = new URL(url)
    const path = `${parsed.pathname}${parsed.search}`
    return { host: parsed.host, path: path === '/' ? '' : path }
  } catch {
    return { host: url, path: '' }
  }
}

function originLabel(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return url
  }
}

/**
 * A browser tile in the pane grid. Same card silhouette as a terminal pane:
 * header (URL pill + controls), body (sandboxed iframe or the pending-confirm
 * card for external origins), attribution footer.
 */
export function WebPaneCard({
  webPane,
  onClose,
  onConfirm,
  wsToken = '',
  onOpenDevtools,
  feedback,
  pendingQueue,
  connected = true,
  onDragStart,
  onDragEnd,
  onNavigate,
  maximized,
  onMaximize,
  detached = false,
  detachedWindow = false,
  onPopOut,
  onFocusDetached,
  onReattach,
  keepStreamingWhenHidden = false,
}: {
  webPane: WebPane
  onClose: () => void
  onConfirm: (allowOrigin: boolean) => void
  /** Session token for the chromium tile stream (empty with cookie auth). */
  wsToken?: string
  /** Opens the tile's DevTools frontend as a sibling tile (chromium only). */
  onOpenDevtools?: () => void
  /** Review-queue state broadcast by the daemon (chromium only). */
  feedback?: WebPaneFeedbackInfo
  /** Daemon-side queue of unsent review pills (chromium only). */
  pendingQueue?: PendingQueueApi
  /** Main daemon connection state, used to restart chromium tile streams. */
  connected?: boolean
  onDragStart?: (event: DragEvent<HTMLElement>) => void
  onDragEnd?: () => void
  onNavigate?: (url: string) => void
  maximized?: boolean
  onMaximize?: () => void
  /** The pane is rendered exclusively in another AppKit window. */
  detached?: boolean
  /** This card is the content of the focused AppKit pane window. */
  detachedWindow?: boolean
  onPopOut?: () => void
  onFocusDetached?: () => void
  onReattach?: () => void
  keepStreamingWhenHidden?: boolean
}) {
  const [reloadKey, setReloadKey] = useState(0)
  const [review, setReview] = useState(false)
  const [chromiumRenderer, setChromiumRenderer] = useState<ChromiumRenderer>(loadChromiumRenderer)
  const [nativeLoaded, setNativeLoaded] = useState(false)
  const [urlDraft, setUrlDraft] = useState<string | null>(null)
  const [phase, setPhase] = useState<'loading' | 'loaded' | 'stalled'>('loading')
  const [attributionVisible, setAttributionVisible] = useState(
    () => webPane.openedBy === 'agent' && Date.now() - webPane.createdAt < ATTRIBUTION_VISIBLE_MS,
  )
  const chromium = webPane.engine === 'chromium'
  // External WebKit panes prefer the desktop shell's native WKWebView tier.
  // Chromium panes may opt into the same surface locally for the fidelity
  // experiment while retaining their daemon-side engine and CDP endpoint.
  const nativeBridge = useRef<NativeWebViewBridge | null>(
    !chromium && isLocalWebPaneUrl(webPane.url) ? null : getNativeWebViewBridge(),
  ).current
  const [tier, setTier] = useState<'undecided' | 'native' | 'iframe'>(
    nativeBridge ? 'undecided' : 'iframe',
  )
  const phaseRef = useRef(phase)
  phaseRef.current = phase

  useEffect(() => {
    if (!nativeBridge) return
    let active = true
    void nativeBridge.connect().then((negotiation) => {
      if (active) setTier(negotiation.available ? 'native' : 'iframe')
    })
    return () => {
      active = false
    }
  }, [nativeBridge])

  useEffect(() => {
    if (webPane.status !== 'open' || tier !== 'iframe' || chromium) return
    setPhase('loading')
    const watchdog = window.setTimeout(() => {
      if (phaseRef.current === 'loading') setPhase('stalled')
    }, LOAD_WATCHDOG_MS)
    return () => window.clearTimeout(watchdog)
  }, [reloadKey, tier, webPane.status, webPane.url])

  useEffect(() => {
    if (!attributionVisible) return
    const remaining = Math.max(1_000, webPane.createdAt + ATTRIBUTION_VISIBLE_MS - Date.now())
    const timer = window.setTimeout(() => setAttributionVisible(false), remaining)
    return () => window.clearTimeout(timer)
  }, [attributionVisible, webPane.createdAt])

  const { host, path } = urlParts(webPane.url)
  const opener = webPane.openerLabel ?? (webPane.openedBy === 'agent' ? 'an agent' : 'you')
  const pending = webPane.status === 'pending'
  const nativeChromium = chromium && chromiumRenderer === 'native' && tier === 'native' && nativeBridge !== null

  const setRenderer = (renderer: ChromiumRenderer) => {
    setChromiumRenderer(renderer)
    saveChromiumRenderer(renderer)
    setNativeLoaded(false)
    if (renderer === 'native') setReview(false)
  }

  useEffect(() => {
    if (nativeChromium) setNativeLoaded(false)
  }, [nativeChromium, webPane.url])

  useEffect(() => {
    if (!nativeChromium || nativeLoaded) return
    const watchdog = window.setTimeout(() => {
      setChromiumRenderer('canvas')
      saveChromiumRenderer('canvas')
    }, LOAD_WATCHDOG_MS)
    return () => window.clearTimeout(watchdog)
  }, [nativeChromium, nativeLoaded, webPane.url])

  return (
    <article className="web-pane" data-web-pane-id={webPane.id}>
      <header
        className="web-pane-head"
        draggable={onDragStart && !detached ? 'true' : 'false'}
        onDragStart={detached ? undefined : onDragStart}
        onDragEnd={onDragEnd}
        title={onDragStart && !detached ? 'Drag onto a terminal pane to move this tile' : undefined}
      >
        <Globe className="web-pane-glyph" aria-hidden="true" />
        {urlDraft !== null && onNavigate ? (
          <form
            className="web-pane-url-form"
            onSubmit={(event) => {
              event.preventDefault()
              const next = urlDraft.trim()
              if (next && next !== webPane.url) onNavigate(next)
              setUrlDraft(null)
            }}
          >
            <input
              value={urlDraft}
              aria-label="Web pane URL"
              autoFocus
              onChange={(event) => setUrlDraft(event.target.value)}
              onBlur={() => setUrlDraft(null)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault()
                  setUrlDraft(null)
                }
                if (event.key === 'Enter') {
                  event.preventDefault()
                  const next = urlDraft.trim()
                  if (next && next !== webPane.url) onNavigate(next)
                  setUrlDraft(null)
                }
              }}
            />
          </form>
        ) : onNavigate ? (
          <button
            type="button"
            className="web-pane-url is-editable"
            title="Change URL"
            aria-label="Change URL"
            onClick={() => setUrlDraft(webPane.url)}
          >
            <span className="web-pane-host">{host}</span>
            {path ? <span className="web-pane-path">{path}</span> : null}
          </button>
        ) : (
          <span className="web-pane-url" title={webPane.url}>
            <span className="web-pane-host">{host}</span>
            {path ? <span className="web-pane-path">{path}</span> : null}
          </span>
        )}
        <span className="web-pane-meta">
          <span className={`web-pane-chip${webPane.openedBy === 'agent' ? ' is-agent' : ''}`}>
            {webPane.openedBy === 'agent' ? 'web · agent' : 'web'}
          </span>
          {chromium && <span className="web-pane-chip is-chromium">chromium</span>}
          {chromium && tier === 'native' && nativeBridge && (
            <button
              type="button"
              className={`web-pane-chip is-renderer${nativeChromium ? ' is-native' : ''}`}
              onClick={() => setRenderer(nativeChromium ? 'canvas' : 'native')}
              aria-pressed={nativeChromium}
              aria-label={nativeChromium ? 'Use canvas stream renderer' : 'Use native web view renderer'}
              title={nativeChromium
                ? 'Native preview active · switch to the Chromium canvas stream'
                : 'Canvas stream active · preview the native WKWebView surface'}
            >
              {nativeChromium ? (nativeLoaded ? 'native' : 'loading') : 'canvas'}
            </button>
          )}
        </span>
        <span className="web-pane-actions">
          {chromium && !nativeChromium && !pending && !detached && (
            <button
              type="button"
              className="web-pane-button"
              onClick={() => setReview((current) => !current)}
              aria-pressed={review}
              title="Review this page"
              aria-label="Review this page"
            >
              <MessageSquarePlus aria-hidden="true" />
            </button>
          )}
          {chromium && !pending && !detached && onOpenDevtools && (
            <button
              type="button"
              className="web-pane-button"
              onClick={onOpenDevtools}
              title="Open DevTools as a tile"
              aria-label="Open DevTools as a tile"
            >
              <Wrench aria-hidden="true" />
            </button>
          )}
          {chromium && !pending && !detached && !detachedWindow && onPopOut && (
            <button
              type="button"
              className="web-pane-button"
              onClick={onPopOut}
              title="Pop out web pane"
              aria-label="Pop out web pane"
            >
              <PictureInPicture2 aria-hidden="true" />
            </button>
          )}
          {detachedWindow && onReattach && (
            <button
              type="button"
              className="web-pane-button"
              onClick={onReattach}
              title="Return web pane to workspace"
              aria-label="Return web pane to workspace"
            >
              <PictureInPicture2 aria-hidden="true" />
            </button>
          )}
          {onMaximize && !detached && (
            <button
              type="button"
              className="web-pane-button"
              onClick={onMaximize}
              title={maximized ? 'Restore web pane' : 'Maximize web pane'}
              aria-label={maximized ? 'Restore web pane' : 'Maximize web pane'}
            >
              {maximized ? <Minimize2 aria-hidden="true" /> : <Maximize2 aria-hidden="true" />}
            </button>
          )}
          {!pending && !detached && (
            <button
              type="button"
              className="web-pane-button"
              onClick={() => {
                setPhase('loading')
                if (nativeChromium) setNativeLoaded(false)
                setReloadKey((current) => current + 1)
              }}
              title="Reload page"
              aria-label="Reload page"
            >
              <RotateCw aria-hidden="true" />
            </button>
          )}
          <button
            type="button"
            className="web-pane-button"
            onClick={() => window.open(webPane.url, '_blank', 'noopener,noreferrer')}
            title="Open in browser"
            aria-label="Open in browser"
          >
            <ExternalLink aria-hidden="true" />
          </button>
          <button
            type="button"
            className="web-pane-button"
            onClick={onClose}
            title="Close web pane"
            aria-label="Close web pane"
          >
            <X aria-hidden="true" />
          </button>
        </span>
      </header>

      {detached ? (
        <div className="web-pane-body web-pane-detached" role="status">
          <PictureInPicture2 aria-hidden="true" />
          <p>This pane is open in a separate Commando window.</p>
          <div className="web-pane-confirm-actions">
            {onFocusDetached && (
              <button type="button" className="web-pane-action" onClick={onFocusDetached}>
                Show window
              </button>
            )}
            {onReattach && (
              <button type="button" className="web-pane-action is-ghost" onClick={onReattach}>
                Bring back
              </button>
            )}
          </div>
        </div>
      ) : pending ? (
        <div className="web-pane-body web-pane-confirm" role="alertdialog" aria-label="Confirm external page">
          <ShieldAlert className="web-pane-shield" aria-hidden="true" />
          <p className="web-pane-confirm-lede">
            <strong>{opener}</strong> wants to open
          </p>
          <p className="web-pane-confirm-url">{webPane.url}</p>
          <div className="web-pane-confirm-actions">
            <button type="button" className="web-pane-action" onClick={() => onConfirm(false)}>
              Open
            </button>
            <button type="button" className="web-pane-action is-ghost" onClick={() => onConfirm(true)}>
              Always allow {originLabel(webPane.url)}
            </button>
            <button type="button" className="web-pane-action is-ghost" onClick={onClose}>
              Dismiss
            </button>
          </div>
          <p className="web-pane-confirm-note">localhost pages open without asking</p>
        </div>
      ) : (
        <div className="web-pane-body">
          {nativeChromium ? (
            <NativeWebViewTile
              bridge={nativeBridge}
              webPane={webPane}
              reloadKey={reloadKey}
              onLoaded={() => setNativeLoaded(true)}
              onFallback={() => setRenderer('canvas')}
            />
          ) : chromium ? (
            <ChromiumTileCard
              webPane={webPane}
              wsToken={wsToken}
              reloadKey={reloadKey}
              reviewMode={review}
              pendingQueue={pendingQueue ?? EMPTY_PENDING_QUEUE}
              connected={connected}
              keepStreamingWhenHidden={keepStreamingWhenHidden}
            />
          ) : tier === 'native' && nativeBridge ? (
            <NativeWebViewTile
              bridge={nativeBridge}
              webPane={webPane}
              reloadKey={reloadKey}
              onFallback={() => setTier('iframe')}
            />
          ) : tier === 'iframe' ? (
            <iframe
              key={reloadKey}
              className="web-pane-frame"
              src={webPane.url}
              title={`Web pane: ${host}`}
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads allow-modals"
              referrerPolicy="no-referrer"
              onLoad={() => setPhase('loaded')}
            />
          ) : null}
          {!chromium && tier === 'iframe' && phase !== 'loaded' && (
            <div className={`web-pane-overlay${phase === 'stalled' ? ' is-stalled' : ''}`}>
              {phase === 'loading' ? (
                <span className="web-pane-overlay-note">Loading {host}…</span>
              ) : (
                <>
                  <span className="web-pane-overlay-note">
                    Still loading — the server may be down, or the site may refuse to be embedded.
                  </span>
                  <div className="web-pane-confirm-actions">
                    <button
                      type="button"
                      className="web-pane-action"
                      onClick={() => {
                        setPhase('loading')
                        setReloadKey((current) => current + 1)
                      }}
                    >
                      Retry
                    </button>
                    <button
                      type="button"
                      className="web-pane-action is-ghost"
                      onClick={() => window.open(webPane.url, '_blank', 'noopener,noreferrer')}
                    >
                      Open in browser
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
          {attributionVisible && webPane.openerLabel ? (
            <div className="web-pane-toast" role="status">
              <strong>{webPane.openerLabel}</strong> opened this beside its pane
            </div>
          ) : null}
        </div>
      )}

      <footer className="web-pane-foot">
        <span>
          opened by {opener} · beside {webPane.anchorPaneId}
          {feedback?.lastDrainCount !== undefined && feedback.lastDrainAt !== undefined
            ? ` · agent received ${feedback.lastDrainCount} note${feedback.lastDrainCount === 1 ? '' : 's'}`
              + ` at ${new Date(feedback.lastDrainAt).toLocaleTimeString()}`
            : null}
        </span>
      </footer>
    </article>
  )
}
