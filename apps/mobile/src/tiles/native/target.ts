import type { WebPane } from '@commando/protocol'

/**
 * Which tiles the phone can load itself, in a react-native-webview, instead of
 * streaming the daemon's Chromium screencast.
 *
 * The tile's `url` is written for the Mac: an artifact the daemon serves is
 * `http://127.0.0.1:4310/redline/artifacts/<id>/page.html`, which on a phone
 * names the phone. Those `/redline/` paths are unauthenticated static files on
 * the daemon (`server/redline-api.ts`), so the phone loads the same path from
 * the daemon address it already talks to. Answers still go to the daemon under
 * the tile's own (canonical) URL, so the desktop and the phone share one queue
 * and one set of sent answers.
 */
export type NativeTileSource =
  | {
      kind: 'page'
      /** What the WebView loads. */
      url: string
      /** Origin the daemon and the desktop key pages by (the tile URL's). */
      canonicalOrigin: string
      /** Origin the phone reaches the same page at. */
      phoneOrigin: string
      /** Served by the daemon itself: open natively without asking. */
      daemonServed: boolean
    }
  | {
      kind: 'canvas'
      artifactId: string
      manifest: string
      /** `<canonical origin>/redline/artifacts/<id>/` — what answers are keyed under. */
      canonicalBase: string
      /** The same folder at the daemon address the phone uses. */
      phoneBase: string
      canonicalOrigin: string
      phoneOrigin: string
    }
  | { kind: 'none'; reason: string }

export type TileMode = 'native' | 'stream'

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1', '0.0.0.0'])
const ARTIFACT_ID = /^[0-9a-f]{16}$/

function parseHttpUrl(raw: string): URL | null {
  try {
    const url = new URL(raw)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null
  } catch {
    return null
  }
}

export function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname.toLowerCase())
}

function originOf(raw: string): string | null {
  const url = parseHttpUrl(raw)
  return url ? url.origin : null
}

function isDaemonPath(pathname: string): boolean {
  return pathname === '/redline' || pathname.startsWith('/redline/')
}

/**
 * Host-independent eligibility: what `nativeTileSource` would accept for any
 * daemon address. Lists and pane tabs use it to decide whether a tile opens.
 */
export function canLoadNatively(tile: WebPane): boolean {
  if (tile.status !== 'open') return false
  if (tile.content) return tile.content.kind === 'canvas'
  const url = parseHttpUrl(tile.url)
  if (!url) return false
  return !isLoopbackHostname(url.hostname) || isDaemonPath(url.pathname)
}

export function nativeTileSource(tile: WebPane, hostBaseUrl: string): NativeTileSource {
  if (tile.status !== 'open') return { kind: 'none', reason: 'This page is waiting for your confirmation.' }
  const phoneOrigin = originOf(hostBaseUrl)
  if (!phoneOrigin) return { kind: 'none', reason: 'The daemon address is not an http(s) URL.' }

  if (tile.content) {
    if (tile.content.kind !== 'canvas') {
      return { kind: 'none', reason: `A ${tile.content.kind} renders natively on the Mac only.` }
    }
    const { artifactId, manifest } = tile.content
    if (!ARTIFACT_ID.test(artifactId)) return { kind: 'none', reason: 'The canvas artifact id is not valid.' }
    const canonicalOrigin = originOf(tile.url) ?? phoneOrigin
    const folder = `/redline/artifacts/${artifactId}/`
    return {
      kind: 'canvas',
      artifactId,
      manifest,
      canonicalBase: `${canonicalOrigin}${folder}`,
      phoneBase: `${phoneOrigin}${folder}`,
      canonicalOrigin,
      phoneOrigin,
    }
  }

  const url = parseHttpUrl(tile.url)
  if (!url) return { kind: 'none', reason: 'Only http and https pages load on the phone.' }
  if (isLoopbackHostname(url.hostname)) {
    if (!isDaemonPath(url.pathname)) {
      return {
        kind: 'none',
        reason: 'This page is served from the Mac’s localhost, which the phone cannot reach.',
      }
    }
    return {
      kind: 'page',
      url: `${phoneOrigin}${url.pathname}${url.search}${url.hash}`,
      canonicalOrigin: url.origin,
      phoneOrigin,
      daemonServed: true,
    }
  }
  return {
    kind: 'page',
    url: url.toString(),
    canonicalOrigin: url.origin,
    phoneOrigin: url.origin,
    daemonServed: url.origin === phoneOrigin && isDaemonPath(url.pathname),
  }
}

/**
 * The mode a tile opens in. Daemon-served pages and canvases load natively.
 * A public page on a chromium tile streams by default, because the host's
 * Chromium carries its logins and cookies; the header toggle still offers the
 * native view. A webkit tile has no stream, so whatever loads natively does.
 */
export function initialTileMode(tile: WebPane, source: NativeTileSource): TileMode {
  if (source.kind === 'none') return 'stream'
  if (tile.engine !== 'chromium' || tile.content) return 'native'
  return source.kind === 'canvas' || source.daemonServed ? 'native' : 'stream'
}

/** Chromium tiles keep their screencast as the fallback and the toggle's other side. */
export function canStreamTile(tile: WebPane): boolean {
  return !tile.content && tile.engine === 'chromium' && tile.status === 'open'
}

/**
 * Maps a URL the phone's WebView reports back to the tile's canonical origin,
 * so queued answers and sent answers match what the desktop keys them under.
 */
export function toCanonicalUrl(
  source: { canonicalOrigin: string; phoneOrigin: string },
  pageUrl: string,
): string {
  const url = parseHttpUrl(pageUrl)
  if (!url || source.canonicalOrigin === source.phoneOrigin || url.origin !== source.phoneOrigin) return pageUrl
  return `${source.canonicalOrigin}${url.pathname}${url.search}${url.hash}`
}

/** The inverse, for a canonical URL the phone has to load (a canvas frame, a revealed page). */
export function toPhoneUrl(
  source: { canonicalOrigin: string; phoneOrigin: string },
  canonicalUrl: string,
): string {
  const url = parseHttpUrl(canonicalUrl)
  if (!url || source.canonicalOrigin === source.phoneOrigin || url.origin !== source.canonicalOrigin) return canonicalUrl
  return `${source.phoneOrigin}${url.pathname}${url.search}${url.hash}`
}

/** True when a WebView-reported URL is on the origin the tile was opened for. */
export function isExpectedOrigin(expectedOrigin: string, reportedUrl: string): boolean {
  return originOf(reportedUrl) === expectedOrigin
}
