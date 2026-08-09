import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { WebSocket, type RawData } from 'ws'
import {
  inspectExpression,
  parseTileInspectResult,
  type TileInspectGrade,
  type TileInspectResult,
} from '../shared/tile-inspect.js'
import {
  MAX_RESPONSE_PAYLOAD_BYTES,
  REDLINE_BINDING_NAME,
  parseRedlinePageResponse,
  type RedlinePageResponse,
} from '../shared/redline-response.js'
import { WebPaneError } from './web-panes.js'

const LAUNCH_TIMEOUT_MS = 20_000
const CDP_CALL_TIMEOUT_MS = 15_000
const SCREENCAST_MAX_DIMENSION = 2_560
/** A fresh screencast still frameless after this long is treated as starved. */
export const SCREENCAST_FALLBACK_AFTER_MS = 2_000
/** captureScreenshot cadence while the fallback poller substitutes for the screencast. */
export const SCREENCAST_POLL_INTERVAL_MS = 700
const MAX_VIEWPORT_DIMENSION = 8_192
const PROFILE_OWNER_FILE = '.commando-browser-owner.json'
const STALE_BROWSER_EXIT_TIMEOUT_MS = 2_000

type ChromiumProfileOwner = {
  ownerPid: number
  browserPid: number
}

/**
 * Chromium-family binaries the daemon can drive, in preference order. The
 * COMMANDO_CHROMIUM_PATH env var overrides the probe; a cached
 * Chrome-for-Testing download (~/.commando/chrome-for-testing/chrome) is the
 * last resort so users without any browser below can opt in with a download.
 */
const BINARY_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
]

export function defaultChromiumProfileDir(): string {
  return process.env.COMMANDO_CHROMIUM_PROFILE_DIR ?? join(homedir(), '.commando', 'chromium-profile')
}

export function findChromiumBinary(env: NodeJS.ProcessEnv = process.env): string | null {
  const override = env.COMMANDO_CHROMIUM_PATH
  if (override) return existsSync(override) ? override : null
  const home = homedir()
  for (const candidate of [...BINARY_CANDIDATES, join(home, '.commando', 'chrome-for-testing', 'chrome')]) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

export type ChromiumLaunch = {
  port: number
  kill: () => void
  /** Resolves when the browser process exits (however it exits). */
  exited: Promise<void>
}

export type ChromiumLauncher = (profileDir: string, signal?: AbortSignal) => Promise<ChromiumLaunch>

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function readProfileOwner(profileDir: string): ChromiumProfileOwner | null {
  try {
    const value = JSON.parse(readFileSync(join(profileDir, PROFILE_OWNER_FILE), 'utf8')) as Partial<ChromiumProfileOwner>
    if (
      typeof value.ownerPid !== 'number' ||
      !Number.isSafeInteger(value.ownerPid) ||
      value.ownerPid < 1 ||
      typeof value.browserPid !== 'number' ||
      !Number.isSafeInteger(value.browserPid) ||
      value.browserPid < 1
    ) return null
    return { ownerPid: value.ownerPid, browserPid: value.browserPid }
  } catch {
    return null
  }
}

function clearProfileOwner(profileDir: string, browserPid?: number): void {
  if (browserPid !== undefined && readProfileOwner(profileDir)?.browserPid !== browserPid) return
  rmSync(join(profileDir, PROFILE_OWNER_FILE), { force: true })
}

function legacyProfileBrowserPid(profileDir: string): number | null {
  try {
    const match = /-(\d+)$/.exec(readlinkSync(join(profileDir, 'SingletonLock')))
    if (!match) return null
    const pid = Number(match[1])
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

function isBrowserForProfile(pid: number, profileDir: string): boolean {
  try {
    const command = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'command='], {
      encoding: 'utf8',
      timeout: 1_000,
    })
    return command.includes('--headless') && command.includes(`--user-data-dir=${profileDir}`)
  } catch {
    return false
  }
}

function killBrowserProcessGroup(pid: number): void {
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // The process exited between inspection and cleanup.
    }
  }
}

async function waitForProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + STALE_BROWSER_EXIT_TIMEOUT_MS
  while (processIsAlive(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  if (processIsAlive(pid)) {
    throw new WebPaneError(503, `Stale Commando Chromium process ${pid} did not exit`)
  }
}

/** Reclaims a browser left holding Commando's dedicated profile after its daemon died. */
export async function reclaimStaleChromiumProfile(profileDir: string): Promise<void> {
  const owner = readProfileOwner(profileDir)
  if (owner) {
    if (
      owner.ownerPid !== process.pid &&
      processIsAlive(owner.ownerPid) &&
      processIsAlive(owner.browserPid)
    ) {
      throw new WebPaneError(503, `Chromium profile is owned by Commando daemon ${owner.ownerPid}`)
    }
    if (processIsAlive(owner.browserPid)) {
      if (!isBrowserForProfile(owner.browserPid, profileDir)) {
        throw new WebPaneError(503, `Refusing to stop unverified process ${owner.browserPid} from Chromium profile`)
      }
      killBrowserProcessGroup(owner.browserPid)
      await waitForProcessExit(owner.browserPid)
    }
    clearProfileOwner(profileDir, owner.browserPid)
    return
  }

  // Profiles from before ownership tracking still expose the browser PID in
  // Chrome's lock symlink. Verify its exact command before touching it so a
  // stale or reused PID can never terminate an unrelated process.
  const legacyPid = legacyProfileBrowserPid(profileDir)
  if (!legacyPid || !processIsAlive(legacyPid) || !isBrowserForProfile(legacyPid, profileDir)) return
  killBrowserProcessGroup(legacyPid)
  await waitForProcessExit(legacyPid)
}

/**
 * Launches the discovered Chromium headless with a dedicated profile and a
 * loopback-only DevTools port. Chrome >= 136 refuses remote debugging on a
 * default profile, so the dedicated --user-data-dir is mandatory, not just
 * hygiene. The chosen port is parsed from the "DevTools listening on" line.
 */
export const spawnChromiumLauncher: ChromiumLauncher = async (profileDir, signal) => {
  const binary = findChromiumBinary()
  if (!binary) {
    throw new WebPaneError(
      503,
      'No Chromium-family browser found. Install Google Chrome (or Chromium, Edge, Brave), ' +
        'place a Chrome-for-Testing build at ~/.commando/chrome-for-testing/chrome, ' +
        'or set COMMANDO_CHROMIUM_PATH.',
    )
  }
  await reclaimStaleChromiumProfile(profileDir)
  if (signal?.aborted) throw new WebPaneError(503, 'Chromium launch was cancelled')
  mkdirSync(profileDir, { recursive: true })
  return new Promise<ChromiumLaunch>((resolve, reject) => {
    const child = spawn(
      binary,
      [
        '--headless=new',
        '--remote-debugging-port=0',
        `--user-data-dir=${profileDir}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-networking',
        '--disable-sync',
        '--mute-audio',
        '--hide-scrollbars',
        // macOS backgrounding/occlusion can mark every headless window
        // "hidden" (observed after display lock/sleep), which stops the
        // compositor and starves Page.screencastFrame forever. These are the
        // same flags Puppeteer/Playwright pass to forbid that state.
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-background-timer-throttling',
        'about:blank',
      ],
      { stdio: ['ignore', 'ignore', 'pipe'], detached: true },
    )
    let settled = false
    let stderrTail = ''
    const browserPid = child.pid
    if (browserPid !== undefined) {
      try {
        writeFileSync(
          join(profileDir, PROFILE_OWNER_FILE),
          JSON.stringify({ ownerPid: process.pid, browserPid } satisfies ChromiumProfileOwner),
        )
      } catch (error) {
        killBrowserProcessGroup(browserPid)
        reject(new WebPaneError(
          503,
          `Could not claim Chromium profile: ${error instanceof Error ? error.message : String(error)}`,
        ))
        return
      }
    }
    const exited = new Promise<void>((resolveExit) => {
      child.once('exit', () => {
        if (browserPid !== undefined) clearProfileOwner(profileDir, browserPid)
        resolveExit()
      })
    })
    const kill = (): void => {
      if (child.pid === undefined) return
      try {
        // Negative pid kills the detached process group: browser + helpers.
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        child.kill('SIGKILL')
      }
    }
    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      stopWaiting()
      kill()
      reject(new WebPaneError(503, `Chromium did not report a DevTools port within ${LAUNCH_TIMEOUT_MS}ms`))
    }, LAUNCH_TIMEOUT_MS)
    const stopWaiting = (): void => {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', onAbort)
    }
    const onAbort = (): void => {
      if (settled) return
      settled = true
      stopWaiting()
      kill()
      reject(new WebPaneError(503, 'Chromium launch was cancelled'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
    child.once('error', (error) => {
      if (settled) return
      settled = true
      stopWaiting()
      reject(new WebPaneError(503, `Failed to launch Chromium: ${error.message}`))
    })
    child.once('exit', (code) => {
      if (settled) return
      settled = true
      stopWaiting()
      reject(
        new WebPaneError(
          503,
          `Chromium exited before reporting a DevTools port (code ${code ?? 'unknown'}): ${stderrTail.trim().slice(-300)}`,
        ),
      )
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      if (settled) return
      stderrTail = (stderrTail + chunk.toString('utf8')).slice(-4_096)
      const match = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(stderrTail)
      if (!match) return
      settled = true
      stopWaiting()
      resolve({ port: Number(match[1]), kill, exited })
    })
  })
}

type CdpEventHandler = (params: Record<string, unknown>) => void

/**
 * Minimal CDP client over one page-target websocket: request/response
 * correlation by id plus event fan-out. Deliberately not a general library —
 * only what the tile engine needs.
 */
class CdpConnection {
  private nextId = 1
  private readonly pending = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }>()
  private readonly eventHandlers = new Map<string, Set<CdpEventHandler>>()
  private readonly closeHandlers = new Set<() => void>()
  private closed = false

  private constructor(private readonly socket: WebSocket) {
    socket.on('message', (data: RawData) => this.receive(data))
    socket.on('close', () => this.handleClose())
    socket.on('error', () => this.handleClose())
  }

  static open(url: string, timeoutMs = CDP_CALL_TIMEOUT_MS): Promise<CdpConnection> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url, { maxPayload: 64 * 1024 * 1024 })
      const timeout = setTimeout(() => {
        socket.terminate()
        reject(new WebPaneError(504, `CDP connection to ${url} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      socket.once('open', () => {
        clearTimeout(timeout)
        resolve(new CdpConnection(socket))
      })
      socket.once('error', (error) => {
        clearTimeout(timeout)
        reject(new WebPaneError(503, `CDP connection failed: ${error.message}`))
      })
    })
  }

  send(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (this.closed) return Promise.reject(new WebPaneError(503, 'CDP connection is closed'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        reject(new WebPaneError(504, `CDP call ${method} timed out`))
      }, CDP_CALL_TIMEOUT_MS)
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout)
          resolve(value)
        },
        reject: (error) => {
          clearTimeout(timeout)
          reject(error)
        },
      })
      this.socket.send(JSON.stringify({ id, method, ...(params ? { params } : {}) }))
    })
  }

  /** Fire-and-forget send for hot paths (input, frame acks). */
  sendAndForget(method: string, params?: Record<string, unknown>): void {
    if (this.closed) return
    void this.send(method, params).catch(() => undefined)
  }

  on(event: string, handler: CdpEventHandler): void {
    let handlers = this.eventHandlers.get(event)
    if (!handlers) {
      handlers = new Set()
      this.eventHandlers.set(event, handlers)
    }
    handlers.add(handler)
  }

  onClose(handler: () => void): void {
    if (this.closed) {
      handler()
      return
    }
    this.closeHandlers.add(handler)
  }

  close(): void {
    if (this.closed) return
    this.socket.close()
    this.handleClose()
  }

  private receive(data: RawData): void {
    let message: Record<string, unknown>
    try {
      message = JSON.parse(data.toString()) as Record<string, unknown>
    } catch {
      return
    }
    if (typeof message.id === 'number') {
      const entry = this.pending.get(message.id)
      if (!entry) return
      this.pending.delete(message.id)
      const error = message.error as { message?: string } | undefined
      if (error) entry.reject(new WebPaneError(502, `CDP error: ${error.message ?? 'unknown'}`))
      else entry.resolve((message.result ?? {}) as Record<string, unknown>)
      return
    }
    if (typeof message.method === 'string') {
      const handlers = this.eventHandlers.get(message.method)
      if (!handlers) return
      const params = (message.params ?? {}) as Record<string, unknown>
      for (const handler of handlers) handler(params)
    }
  }

  private handleClose(): void {
    if (this.closed) return
    this.closed = true
    for (const entry of this.pending.values()) {
      entry.reject(new WebPaneError(503, 'CDP connection closed'))
    }
    this.pending.clear()
    for (const handler of this.closeHandlers) handler()
    this.closeHandlers.clear()
  }
}

export type ScreencastFrame = {
  /** base64 image payload. */
  data: string
  format: 'jpeg' | 'png'
  metadata: Record<string, unknown>
}

export type ScreencastSink = (frame: ScreencastFrame) => void

export type TileViewport = { width: number; height: number; deviceScaleFactor: number }

export type TileInputEvent =
  | {
      kind: 'mouse'
      type: 'mousePressed' | 'mouseReleased' | 'mouseMoved'
      x: number
      y: number
      button?: 'none' | 'left' | 'middle' | 'right'
      clickCount?: number
      modifiers?: number
    }
  | { kind: 'wheel'; x: number; y: number; deltaX: number; deltaY: number; modifiers?: number }
  | {
      kind: 'key'
      type: 'keyDown' | 'keyUp' | 'rawKeyDown' | 'char'
      key?: string
      code?: string
      text?: string
      windowsVirtualKeyCode?: number
      modifiers?: number
    }

function finiteInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
}

/** Validates a client-supplied input event down to the exact shape we forward. */
export function parseTileInputEvent(value: unknown): TileInputEvent | null {
  if (typeof value !== 'object' || value === null) return null
  const event = value as Record<string, unknown>
  const modifiers = finiteInRange(event.modifiers, 0, 15) ? Math.floor(event.modifiers) : undefined
  if (event.kind === 'mouse') {
    if (
      (event.type !== 'mousePressed' && event.type !== 'mouseReleased' && event.type !== 'mouseMoved') ||
      !finiteInRange(event.x, 0, MAX_VIEWPORT_DIMENSION) ||
      !finiteInRange(event.y, 0, MAX_VIEWPORT_DIMENSION)
    ) {
      return null
    }
    const button =
      event.button === 'left' || event.button === 'middle' || event.button === 'right' || event.button === 'none'
        ? event.button
        : undefined
    const clickCount = finiteInRange(event.clickCount, 0, 8) ? Math.floor(event.clickCount) : undefined
    return { kind: 'mouse', type: event.type, x: event.x, y: event.y, button, clickCount, modifiers }
  }
  if (event.kind === 'wheel') {
    if (
      !finiteInRange(event.x, 0, MAX_VIEWPORT_DIMENSION) ||
      !finiteInRange(event.y, 0, MAX_VIEWPORT_DIMENSION) ||
      !finiteInRange(event.deltaX, -10_000, 10_000) ||
      !finiteInRange(event.deltaY, -10_000, 10_000)
    ) {
      return null
    }
    return { kind: 'wheel', x: event.x, y: event.y, deltaX: event.deltaX, deltaY: event.deltaY, modifiers }
  }
  if (event.kind === 'key') {
    if (
      event.type !== 'keyDown' && event.type !== 'keyUp' && event.type !== 'rawKeyDown' && event.type !== 'char'
    ) {
      return null
    }
    const text = typeof event.text === 'string' && event.text.length <= 16 ? event.text : undefined
    const key = typeof event.key === 'string' && event.key.length <= 32 ? event.key : undefined
    const code = typeof event.code === 'string' && event.code.length <= 32 ? event.code : undefined
    const windowsVirtualKeyCode = finiteInRange(event.windowsVirtualKeyCode, 0, 255)
      ? Math.floor(event.windowsVirtualKeyCode)
      : undefined
    return { kind: 'key', type: event.type, key, code, text, windowsVirtualKeyCode, modifiers }
  }
  return null
}

export type TileInspectRequest = { id: string; x: number; y: number; grade: TileInspectGrade }

/** Validates a client-supplied inspect request down to the exact forwarded shape. */
export function parseTileInspectRequest(value: unknown): TileInspectRequest | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  if (
    typeof record.id !== 'string' || record.id.length === 0 || record.id.length > 64 ||
    !finiteInRange(record.x, 0, MAX_VIEWPORT_DIMENSION) ||
    !finiteInRange(record.y, 0, MAX_VIEWPORT_DIMENSION) ||
    (record.grade !== 'hover' && record.grade !== 'click')
  ) {
    return null
  }
  return { id: record.id, x: record.x, y: record.y, grade: record.grade }
}

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin
  } catch {
    return false
  }
}

type TileTarget = {
  webPaneId: string
  targetId: string
  wsUrl: string
  devtoolsFrontendUrl: string
  cdp: CdpConnection
  sinks: Set<ScreencastSink>
  screencasting: boolean
  /** URL applied by the last explicit open/navigate, used to detect watchdog loops. */
  currentUrl: string
  /** True once the current screencast delivered at least one real frame. */
  gotRealFrame: boolean
  /** Armed after startScreencast; fires the captureScreenshot fallback. */
  fallbackTimer: ReturnType<typeof setTimeout> | null
  /** Active captureScreenshot polling loop (fallback mode). */
  pollTimer: ReturnType<typeof setInterval> | null
  /** Invalidates armed timers and in-flight fallback captures from older generations. */
  fallbackEpoch: number
  /** Last frame delivered to subscribers, available for replay and fallback deduplication. */
  lastFrame: ScreencastFrame | null
}

export type ChromiumEngineOptions = {
  profileDir?: string
  launcher?: ChromiumLauncher
  /** URL policy from WebPaneService — 'open' means allowed without confirmation. */
  classify: (url: string) => { kind: 'open' | 'confirm' | 'invalid' }
  /** Called when a tile's main frame navigated somewhere needing confirmation. */
  onExternalNavigation: (webPaneId: string, url: string) => void
  /** Called when a tile's CDP connection (or the whole browser) went away. */
  onTargetDown?: (webPaneId: string) => void
  /** Called when a tile page queues a component answer via the redline binding. */
  onPageResponse?: (webPaneId: string, response: RedlinePageResponse) => void
  /** Budget for browser devtools HTTP calls; a wedged browser must fail, not hang. */
  httpTimeoutMs?: number
  /** Budget for CDP websocket handshakes; same rationale. */
  connectTimeoutMs?: number
  /** How long a fresh screencast may stay frameless before the fallback kicks in. */
  screencastFallbackAfterMs?: number
  /** captureScreenshot cadence while in fallback mode. */
  screencastPollIntervalMs?: number
}

/** The engine's live browser: the process handle plus its browser-level CDP socket. */
type BrowserSession = { launch: ChromiumLaunch; cdp: CdpConnection }

/**
 * Owns the daemon-managed headless Chromium: one browser process, one page
 * target per chromium-engine tile. Lazily launches on first use; targets are
 * recreated on demand after crashes. All CDP endpoints are loopback-only.
 */
export class ChromiumEngine {
  private readonly profileDir: string
  private readonly launcher: ChromiumLauncher
  private readonly httpTimeoutMs: number
  private readonly connectTimeoutMs: number
  private readonly screencastFallbackAfterMs: number
  private readonly screencastPollIntervalMs: number
  private browser: BrowserSession | null = null
  private browserStarting: Promise<BrowserSession> | null = null
  private browserStartingAbort: AbortController | null = null
  private readonly tiles = new Map<string, TileTarget>()
  private readonly targetStarting = new Map<string, Promise<TileTarget>>()
  /** Last viewport per tile — buffered so a viewport sent before the target exists still applies. */
  private readonly viewports = new Map<string, TileViewport>()
  private disposed = false

  constructor(private readonly options: ChromiumEngineOptions) {
    this.profileDir = options.profileDir ?? defaultChromiumProfileDir()
    this.launcher = options.launcher ?? spawnChromiumLauncher
    this.httpTimeoutMs = options.httpTimeoutMs ?? CDP_CALL_TIMEOUT_MS
    this.connectTimeoutMs = options.connectTimeoutMs ?? CDP_CALL_TIMEOUT_MS
    this.screencastFallbackAfterMs = options.screencastFallbackAfterMs ?? SCREENCAST_FALLBACK_AFTER_MS
    this.screencastPollIntervalMs = options.screencastPollIntervalMs ?? SCREENCAST_POLL_INTERVAL_MS
  }

  hasTile(webPaneId: string): boolean {
    return this.tiles.has(webPaneId)
  }

  async cdpInfo(webPaneId: string, url: string): Promise<{ target: string; devtoolsFrontendUrl: string }> {
    const tile = await this.ensureTarget(webPaneId, url)
    return { target: tile.wsUrl, devtoolsFrontendUrl: tile.devtoolsFrontendUrl }
  }

  async navigate(webPaneId: string, url: string): Promise<void> {
    const tile = await this.ensureTarget(webPaneId, url)
    tile.currentUrl = url
    await tile.cdp.send('Page.navigate', { url })
  }

  async reload(webPaneId: string, url: string): Promise<void> {
    const tile = await this.ensureTarget(webPaneId, url)
    await tile.cdp.send('Page.reload')
  }

  /**
   * Adds a screencast subscriber for a tile, starting the target and the
   * screencast as needed. Returns an unsubscribe function; the screencast
   * stops when the last subscriber leaves.
   */
  async subscribeScreencast(webPaneId: string, url: string, sink: ScreencastSink): Promise<() => void> {
    const tile = await this.ensureTarget(webPaneId, url)
    tile.sinks.add(sink)
    if (tile.lastFrame) sink(tile.lastFrame)
    if (!tile.screencasting) {
      tile.screencasting = true
      try {
        await tile.cdp.send('Page.startScreencast', {
          format: 'png',
          maxWidth: SCREENCAST_MAX_DIMENSION,
          maxHeight: SCREENCAST_MAX_DIMENSION,
          everyNthFrame: 1,
        })
      } catch (error) {
        // A failed start must not wedge the tile: leaving the flag set would
        // make every later subscriber skip the start and hang frameless.
        tile.screencasting = false
        tile.sinks.delete(sink)
        throw error
      }
      this.armScreencastFallback(tile)
    }
    return () => {
      tile.sinks.delete(sink)
      if (tile.sinks.size === 0 && tile.screencasting) {
        tile.screencasting = false
        tile.cdp.sendAndForget('Page.stopScreencast')
        this.stopScreencastFallback(tile)
      }
    }
  }

  /**
   * Chrome only screencasts pages it considers visible. macOS can background
   * the whole headless browser (display lock/sleep), leaving every window
   * "hidden" and the screencast frameless with no error — while
   * Page.captureScreenshot still composites on demand. So: if a fresh
   * screencast delivers nothing within the deadline, poll screenshots into
   * the sinks until real frames show up.
   */
  private armScreencastFallback(tile: TileTarget): void {
    const epoch = ++tile.fallbackEpoch
    tile.gotRealFrame = false
    if (tile.fallbackTimer) clearTimeout(tile.fallbackTimer)
    if (tile.pollTimer) {
      clearInterval(tile.pollTimer)
      tile.pollTimer = null
    }
    const fallbackTimer = setTimeout(() => {
      if (tile.fallbackEpoch !== epoch) return
      tile.fallbackTimer = null
      if (!tile.screencasting || tile.sinks.size === 0 || tile.gotRealFrame || tile.pollTimer) return
      console.warn(`chromium tile ${tile.webPaneId}: screencast frameless, falling back to screenshot polling`)
      let pollBusy = false
      let consecutiveFailures = 0
      let pollTimer: ReturnType<typeof setInterval> | null = null
      const tick = (): void => {
        if (tile.fallbackEpoch !== epoch || pollBusy) return
        pollBusy = true
        const viewport = this.viewports.get(tile.webPaneId)
        const params = viewport
          ? {
              format: 'png',
              clip: {
                x: 0,
                y: 0,
                width: viewport.width,
                height: viewport.height,
                scale: Math.min(1, SCREENCAST_MAX_DIMENSION / Math.max(viewport.width, viewport.height)),
              },
            }
          : { format: 'png' }
        tile.cdp
          .send('Page.captureScreenshot', params)
          .then((result) => {
            if (tile.fallbackEpoch !== epoch) return
            consecutiveFailures = 0
            const data = (result as { data?: unknown }).data
            if (typeof data !== 'string' || data === tile.lastFrame?.data) return
            // A real frame may have raced in while the screenshot was taken;
            // it wins, and the poller is already stopped.
            if (tile.gotRealFrame) return
            const frame: ScreencastFrame = { data, format: 'png', metadata: {} }
            tile.lastFrame = frame
            for (const sink of tile.sinks) sink(frame)
          })
          .catch(() => {
            if (tile.fallbackEpoch !== epoch) return
            consecutiveFailures += 1
            if (consecutiveFailures < 5) return
            if (pollTimer) clearInterval(pollTimer)
            if (tile.pollTimer === pollTimer) tile.pollTimer = null
            console.warn(`giving up on screenshot fallback for ${tile.webPaneId}`)
          })
          .finally(() => {
            if (tile.fallbackEpoch !== epoch) return
            pollBusy = false
          })
      }
      // Chrome 151 can deadlock captureScreenshot behind a starved active
      // screencast. Stop it first, then use on-demand captures on this target.
      void tile.cdp.send('Page.stopScreencast').then(() => {
        if (
          tile.fallbackEpoch !== epoch ||
          !tile.screencasting ||
          tile.sinks.size === 0 ||
          tile.gotRealFrame
        ) return
        tick()
        pollTimer = setInterval(tick, this.screencastPollIntervalMs)
        tile.pollTimer = pollTimer
      }).catch(() => {
        if (tile.fallbackEpoch === epoch) {
          console.warn(`could not stop starved screencast for ${tile.webPaneId}`)
        }
      })
    }, this.screencastFallbackAfterMs)
    tile.fallbackTimer = fallbackTimer
  }

  private stopScreencastFallback(tile: TileTarget): void {
    tile.fallbackEpoch += 1
    if (tile.fallbackTimer) {
      clearTimeout(tile.fallbackTimer)
      tile.fallbackTimer = null
    }
    if (tile.pollTimer) {
      clearInterval(tile.pollTimer)
      tile.pollTimer = null
    }
  }

  async setViewport(webPaneId: string, viewport: TileViewport): Promise<void> {
    const width = Math.floor(viewport.width)
    const height = Math.floor(viewport.height)
    const deviceScaleFactor = viewport.deviceScaleFactor
    if (
      !finiteInRange(width, 1, MAX_VIEWPORT_DIMENSION) ||
      !finiteInRange(height, 1, MAX_VIEWPORT_DIMENSION) ||
      !finiteInRange(deviceScaleFactor, 0.5, 4)
    ) {
      return
    }
    const normalized = { width, height, deviceScaleFactor }
    this.viewports.set(webPaneId, normalized)
    const tile = this.tiles.get(webPaneId)
    if (!tile) return
    await this.applyViewport(tile, normalized)
  }

  private applyViewport(tile: TileTarget, viewport: TileViewport): Promise<unknown> {
    return tile.cdp.send('Emulation.setDeviceMetricsOverride', {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: viewport.deviceScaleFactor,
      mobile: false,
    })
  }

  dispatchInput(webPaneId: string, event: TileInputEvent): void {
    const tile = this.tiles.get(webPaneId)
    if (!tile) return
    if (event.kind === 'mouse') {
      tile.cdp.sendAndForget('Input.dispatchMouseEvent', {
        type: event.type,
        x: event.x,
        y: event.y,
        button: event.button ?? 'none',
        clickCount: event.clickCount ?? 0,
        modifiers: event.modifiers ?? 0,
        pointerType: 'mouse',
      })
      return
    }
    if (event.kind === 'wheel') {
      tile.cdp.sendAndForget('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x: event.x,
        y: event.y,
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        modifiers: event.modifiers ?? 0,
        pointerType: 'mouse',
      })
      return
    }
    tile.cdp.sendAndForget('Input.dispatchKeyEvent', {
      type: event.type,
      ...(event.key !== undefined ? { key: event.key } : {}),
      ...(event.code !== undefined ? { code: event.code } : {}),
      ...(event.text !== undefined ? { text: event.text } : {}),
      // windowsVirtualKeyCode drives the renderer's editing behavior. Never
      // mirror it into nativeVirtualKeyCode: that field is a PLATFORM keycode
      // (on macOS a Mac keycode, where e.g. 65 is keypad-'.'), and feeding it
      // Windows codes reproducibly hangs the headless renderer mid-sequence.
      ...(event.windowsVirtualKeyCode !== undefined
        ? { windowsVirtualKeyCode: event.windowsVirtualKeyCode }
        : {}),
      modifiers: event.modifiers ?? 0,
    })
  }

  /**
   * Resolves the element under a viewport point with one transient
   * Runtime.evaluate — nothing is installed in the page. Page-level failures
   * come back as { ok: false } so the relay can answer the client either way.
   */
  async inspectAt(
    webPaneId: string,
    x: number,
    y: number,
    grade: TileInspectGrade,
  ): Promise<TileInspectResult> {
    const tile = this.tiles.get(webPaneId)
    if (!tile) return { ok: false, error: 'Tile has no live chromium target' }
    let evaluated: { result?: { value?: unknown }; exceptionDetails?: unknown }
    try {
      evaluated = (await tile.cdp.send('Runtime.evaluate', {
        expression: inspectExpression(x, y, grade),
        returnByValue: true,
      })) as typeof evaluated
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'Inspect failed' }
    }
    if (evaluated.exceptionDetails) return { ok: false, error: 'Page threw while inspecting' }
    return (
      parseTileInspectResult(evaluated.result?.value) ??
      { ok: false, error: 'Page returned an invalid inspect result' }
    )
  }

  /** Closes the target of a removed tile; safe to call for unknown ids. */
  closeTile(webPaneId: string): void {
    this.viewports.delete(webPaneId)
    const tile = this.tiles.get(webPaneId)
    if (!tile) return
    this.tiles.delete(webPaneId)
    this.stopScreencastFallback(tile)
    tile.cdp.close()
    this.browser?.cdp.sendAndForget('Target.closeTarget', { targetId: tile.targetId })
  }

  /** Drops targets whose tiles no longer exist or switched engines. */
  syncTiles(livePaneIds: ReadonlySet<string>): void {
    for (const webPaneId of [...this.tiles.keys()]) {
      if (!livePaneIds.has(webPaneId)) this.closeTile(webPaneId)
    }
  }

  dispose(): void {
    this.disposed = true
    this.browserStartingAbort?.abort()
    this.browserStartingAbort = null
    for (const webPaneId of [...this.tiles.keys()]) this.closeTile(webPaneId)
    this.browser?.cdp.close()
    this.browser?.launch.kill()
    this.browser = null
  }

  private async ensureBrowser(): Promise<BrowserSession> {
    if (this.disposed) throw new WebPaneError(503, 'Chromium engine is shut down')
    if (this.browser) return this.browser
    if (!this.browserStarting) {
      const abortController = new AbortController()
      this.browserStartingAbort = abortController
      const starting = this.startBrowser(abortController.signal).then((session) => {
        if (this.disposed || abortController.signal.aborted) {
          session.cdp.close()
          session.launch.kill()
          throw new WebPaneError(503, 'Chromium engine is shut down')
        }
        this.browser = session
        void session.launch.exited.then(() => this.handleBrowserExit(session))
        return session
      })
      this.browserStarting = starting
      starting.catch(() => undefined).finally(() => {
        if (this.browserStarting === starting) this.browserStarting = null
        if (this.browserStartingAbort === abortController) this.browserStartingAbort = null
      })
    }
    return this.browserStarting
  }

  private async startBrowser(signal: AbortSignal): Promise<BrowserSession> {
    const launch = await this.launcher(this.profileDir, signal)
    const abortLaunch = (): void => launch.kill()
    signal.addEventListener('abort', abortLaunch, { once: true })
    try {
      const version = (await this.browserHttp(launch.port, '/json/version')) as {
        webSocketDebuggerUrl?: string
      }
      if (!version.webSocketDebuggerUrl) {
        throw new WebPaneError(502, 'Chromium did not report a browser DevTools endpoint')
      }
      const cdp = await CdpConnection.open(version.webSocketDebuggerUrl, this.connectTimeoutMs)
      const session: BrowserSession = { launch, cdp }
      if (signal.aborted) throw new WebPaneError(503, 'Chromium launch was cancelled')
      // A dead browser socket means no more target management: kill the
      // process so the exit path runs and the next tile relaunches cleanly.
      cdp.onClose(() => {
        if (this.browser === session) launch.kill()
      })
      return session
    } catch (error) {
      launch.kill()
      throw error
    } finally {
      signal.removeEventListener('abort', abortLaunch)
    }
  }

  private handleBrowserExit(session: BrowserSession): void {
    if (this.browser !== session) return
    this.browser = null
    session.cdp.close()
    for (const [webPaneId, tile] of [...this.tiles]) {
      this.tiles.delete(webPaneId)
      tile.cdp.close()
      this.options.onTargetDown?.(webPaneId)
    }
  }

  private async ensureTarget(webPaneId: string, url: string): Promise<TileTarget> {
    const existing = this.tiles.get(webPaneId)
    if (existing) return existing
    const starting = this.targetStarting.get(webPaneId)
    if (starting) return starting
    const promise = this.createTarget(webPaneId, url)
    this.targetStarting.set(webPaneId, promise)
    try {
      return await promise
    } finally {
      this.targetStarting.delete(webPaneId)
    }
  }

  private async createTarget(webPaneId: string, url: string): Promise<TileTarget> {
    const browser = await this.ensureBrowser()
    // One window per tile, never a tab: in a shared window only the active
    // tab's compositor runs, so every backgrounded tile's screencast would
    // freeze silently (visibilityState "hidden", zero frames).
    // Chrome 151 can ignore the requested URL when newWindow is true and
    // leave the target at about:blank. Attach first, then navigate explicitly
    // so the initial paint and navigation watchdog are never missed.
    const created = await browser.cdp.send('Target.createTarget', { url: 'about:blank', newWindow: true })
    const targetId = typeof created.targetId === 'string' ? created.targetId : null
    if (!targetId) {
      throw new WebPaneError(502, 'Chromium did not return a debuggable target')
    }
    const wsUrl = `ws://127.0.0.1:${browser.launch.port}/devtools/page/${targetId}`
    const cdp = await CdpConnection.open(wsUrl, this.connectTimeoutMs)
    // Chrome reports an appspot-hosted frontend URL; use the browser's own
    // locally-served copy instead so the DevTools tile stays a localhost page.
    const devtoolsFrontendUrl =
      `http://127.0.0.1:${browser.launch.port}/devtools/inspector.html` +
      `?ws=${wsUrl.replace(/^ws:\/\//, '')}`
    const tile: TileTarget = {
      webPaneId,
      targetId,
      wsUrl,
      devtoolsFrontendUrl,
      cdp,
      sinks: new Set(),
      screencasting: false,
      currentUrl: url,
      gotRealFrame: false,
      fallbackTimer: null,
      pollTimer: null,
      fallbackEpoch: 0,
      lastFrame: null,
    }
    cdp.on('Page.screencastFrame', (params) => {
      const sessionId = params.sessionId
      if (typeof sessionId === 'number') {
        cdp.sendAndForget('Page.screencastFrameAck', { sessionId })
      }
      const data = params.data
      if (typeof data !== 'string') return
      tile.gotRealFrame = true
      this.stopScreencastFallback(tile)
      const frame: ScreencastFrame = {
        data,
        format: 'png',
        metadata: (params.metadata ?? {}) as Record<string, unknown>,
      }
      tile.lastFrame = frame
      for (const sink of tile.sinks) sink(frame)
    })
    cdp.on('Page.screencastVisibilityChanged', (params) => {
      if (params.visible === false && tile.screencasting && tile.sinks.size > 0) {
        this.armScreencastFallback(tile)
      }
    })
    cdp.on('Page.frameNavigated', (params) => {
      const frame = params.frame as { parentId?: string; url?: string } | undefined
      if (!frame || frame.parentId || typeof frame.url !== 'string') return
      this.handleMainFrameNavigation(tile, frame.url)
    })
    cdp.onClose(() => {
      this.stopScreencastFallback(tile)
      if (this.tiles.get(webPaneId) !== tile) return
      this.tiles.delete(webPaneId)
      this.options.onTargetDown?.(webPaneId)
    })
    await cdp.send('Page.enable')
    // The redline queue binding: page components call
    // window.__commandoRedlineQueue(json) and the payload surfaces here as
    // Runtime.bindingCalled. Installed unconditionally — inert unless a page
    // uses it — and validated as untrusted input before leaving the engine.
    await cdp.send('Runtime.enable')
    await cdp.send('Runtime.addBinding', { name: REDLINE_BINDING_NAME })
    cdp.on('Runtime.bindingCalled', (params) => {
      if (params.name !== REDLINE_BINDING_NAME) return
      const payload = params.payload
      if (typeof payload !== 'string' || payload.length > MAX_RESPONSE_PAYLOAD_BYTES) {
        console.warn(`redline: dropped oversized page-response envelope for ${webPaneId}`)
        return
      }
      let value: unknown
      try {
        value = JSON.parse(payload)
      } catch {
        console.warn(`redline: dropped page-response payload with malformed JSON for ${webPaneId}`)
        return
      }
      const response = parseRedlinePageResponse(value)
      if (!response) {
        console.warn(`redline: dropped page-response payload that failed validation for ${webPaneId}`)
        return
      }
      this.options.onPageResponse?.(webPaneId, response)
    })
    const bufferedViewport = this.viewports.get(webPaneId)
    if (bufferedViewport) {
      await this.applyViewport(tile, bufferedViewport).catch(() => undefined)
    }
    this.tiles.set(webPaneId, tile)
    await cdp.send('Page.navigate', { url })
    return tile
  }

  /**
   * The navigation watchdog: a main-frame navigation to a URL that would
   * require confirmation blanks the target and re-pends the tile, keeping the
   * trust policy intact even when an attached agent drives the page.
   */
  private handleMainFrameNavigation(tile: TileTarget, url: string): void {
    if (tile.screencasting && tile.sinks.size > 0) this.armScreencastFallback(tile)
    if (url === 'about:blank' || url === tile.currentUrl) return
    if (url.startsWith('chrome-error://') || url.startsWith('devtools://')) return
    const decision = this.options.classify(url)
    // Staying on the origin the owner already confirmed for this tile is
    // fine even when the origin was not "always"-allowlisted.
    if (decision.kind === 'open' || sameOrigin(url, tile.currentUrl)) {
      tile.currentUrl = url
      return
    }
    tile.currentUrl = 'about:blank'
    tile.cdp.sendAndForget('Page.navigate', { url: 'about:blank' })
    this.options.onExternalNavigation(tile.webPaneId, url)
  }

  private async browserHttp(port: number, path: string): Promise<unknown> {
    let response: Response
    try {
      response = await fetch(`http://127.0.0.1:${port}${path}`, {
        signal: AbortSignal.timeout(this.httpTimeoutMs),
      })
    } catch (error) {
      const name = error instanceof Error ? error.name : ''
      const causeName = (error as { cause?: { name?: string } }).cause?.name ?? ''
      if (name === 'TimeoutError' || name === 'AbortError' || causeName === 'TimeoutError') {
        throw new WebPaneError(504, `Chromium devtools endpoint ${path} timed out after ${this.httpTimeoutMs}ms`)
      }
      throw new WebPaneError(
        502,
        `Chromium devtools endpoint ${path} failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    if (!response.ok) {
      throw new WebPaneError(502, `Chromium devtools endpoint ${path} responded ${response.status}`)
    }
    const text = await response.text()
    try {
      return JSON.parse(text) as unknown
    } catch {
      return text
    }
  }
}
