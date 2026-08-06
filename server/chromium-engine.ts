import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { WebSocket, type RawData } from 'ws'
import { WebPaneError } from './web-panes.js'

const LAUNCH_TIMEOUT_MS = 20_000
const CDP_CALL_TIMEOUT_MS = 15_000
const SCREENCAST_MAX_DIMENSION = 2_560
const MAX_VIEWPORT_DIMENSION = 8_192

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

export type ChromiumLauncher = (profileDir: string) => Promise<ChromiumLaunch>

/**
 * Launches the discovered Chromium headless with a dedicated profile and a
 * loopback-only DevTools port. Chrome >= 136 refuses remote debugging on a
 * default profile, so the dedicated --user-data-dir is mandatory, not just
 * hygiene. The chosen port is parsed from the "DevTools listening on" line.
 */
export const spawnChromiumLauncher: ChromiumLauncher = (profileDir) => {
  const binary = findChromiumBinary()
  if (!binary) {
    throw new WebPaneError(
      503,
      'No Chromium-family browser found. Install Google Chrome (or Chromium, Edge, Brave), ' +
        'place a Chrome-for-Testing build at ~/.commando/chrome-for-testing/chrome, ' +
        'or set COMMANDO_CHROMIUM_PATH.',
    )
  }
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
        'about:blank',
      ],
      { stdio: ['ignore', 'ignore', 'pipe'], detached: true },
    )
    let settled = false
    let stderrTail = ''
    const exited = new Promise<void>((resolveExit) => {
      child.once('exit', () => resolveExit())
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
      kill()
      reject(new WebPaneError(503, `Chromium did not report a DevTools port within ${LAUNCH_TIMEOUT_MS}ms`))
    }, LAUNCH_TIMEOUT_MS)
    child.once('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      reject(new WebPaneError(503, `Failed to launch Chromium: ${error.message}`))
    })
    child.once('exit', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
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
      clearTimeout(timeout)
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

  static open(url: string): Promise<CdpConnection> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url, { maxPayload: 64 * 1024 * 1024 })
      socket.once('open', () => resolve(new CdpConnection(socket)))
      socket.once('error', (error) => reject(new WebPaneError(503, `CDP connection failed: ${error.message}`)))
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
}

/**
 * Owns the daemon-managed headless Chromium: one browser process, one page
 * target per chromium-engine tile. Lazily launches on first use; targets are
 * recreated on demand after crashes. All CDP endpoints are loopback-only.
 */
export class ChromiumEngine {
  private readonly profileDir: string
  private readonly launcher: ChromiumLauncher
  private browser: ChromiumLaunch | null = null
  private browserStarting: Promise<ChromiumLaunch> | null = null
  private readonly tiles = new Map<string, TileTarget>()
  private readonly targetStarting = new Map<string, Promise<TileTarget>>()
  private disposed = false

  constructor(private readonly options: ChromiumEngineOptions) {
    this.profileDir = options.profileDir ?? defaultChromiumProfileDir()
    this.launcher = options.launcher ?? spawnChromiumLauncher
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
    if (!tile.screencasting) {
      tile.screencasting = true
      await tile.cdp.send('Page.startScreencast', {
        format: 'png',
        maxWidth: SCREENCAST_MAX_DIMENSION,
        maxHeight: SCREENCAST_MAX_DIMENSION,
        everyNthFrame: 1,
      })
    }
    return () => {
      tile.sinks.delete(sink)
      if (tile.sinks.size === 0 && tile.screencasting) {
        tile.screencasting = false
        tile.cdp.sendAndForget('Page.stopScreencast')
      }
    }
  }

  async setViewport(webPaneId: string, viewport: TileViewport): Promise<void> {
    const tile = this.tiles.get(webPaneId)
    if (!tile) return
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
    await tile.cdp.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor,
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
      ...(event.windowsVirtualKeyCode !== undefined
        ? {
            windowsVirtualKeyCode: event.windowsVirtualKeyCode,
            nativeVirtualKeyCode: event.windowsVirtualKeyCode,
          }
        : {}),
      modifiers: event.modifiers ?? 0,
    })
  }

  /** Closes the target of a removed tile; safe to call for unknown ids. */
  closeTile(webPaneId: string): void {
    const tile = this.tiles.get(webPaneId)
    if (!tile) return
    this.tiles.delete(webPaneId)
    tile.cdp.close()
    const browser = this.browser
    if (browser) {
      void this.browserHttp(browser.port, `/json/close/${tile.targetId}`).catch(() => undefined)
    }
  }

  /** Drops targets whose tiles no longer exist or switched engines. */
  syncTiles(livePaneIds: ReadonlySet<string>): void {
    for (const webPaneId of [...this.tiles.keys()]) {
      if (!livePaneIds.has(webPaneId)) this.closeTile(webPaneId)
    }
  }

  dispose(): void {
    this.disposed = true
    for (const webPaneId of [...this.tiles.keys()]) this.closeTile(webPaneId)
    this.browser?.kill()
    this.browser = null
  }

  private async ensureBrowser(): Promise<ChromiumLaunch> {
    if (this.disposed) throw new WebPaneError(503, 'Chromium engine is shut down')
    if (this.browser) return this.browser
    if (!this.browserStarting) {
      this.browserStarting = Promise.resolve(this.launcher(this.profileDir)).then((launch) => {
        this.browser = launch
        void launch.exited.then(() => this.handleBrowserExit(launch))
        return launch
      })
      this.browserStarting.catch(() => undefined).finally(() => {
        this.browserStarting = null
      })
    }
    return this.browserStarting
  }

  private handleBrowserExit(launch: ChromiumLaunch): void {
    if (this.browser !== launch) return
    this.browser = null
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
    const created = (await this.browserHttp(
      browser.port,
      `/json/new?${encodeURIComponent(url)}`,
      'PUT',
    )) as { id?: string; webSocketDebuggerUrl?: string; devtoolsFrontendUrl?: string }
    if (!created.id || !created.webSocketDebuggerUrl) {
      throw new WebPaneError(502, 'Chromium did not return a debuggable target')
    }
    const cdp = await CdpConnection.open(created.webSocketDebuggerUrl)
    const devtoolsFrontendUrl = created.devtoolsFrontendUrl?.startsWith('/')
      ? `http://127.0.0.1:${browser.port}${created.devtoolsFrontendUrl}`
      : created.devtoolsFrontendUrl ?? `http://127.0.0.1:${browser.port}/`
    const tile: TileTarget = {
      webPaneId,
      targetId: created.id,
      wsUrl: created.webSocketDebuggerUrl,
      devtoolsFrontendUrl,
      cdp,
      sinks: new Set(),
      screencasting: false,
      currentUrl: url,
    }
    cdp.on('Page.screencastFrame', (params) => {
      const sessionId = params.sessionId
      if (typeof sessionId === 'number') {
        cdp.sendAndForget('Page.screencastFrameAck', { sessionId })
      }
      const data = params.data
      if (typeof data !== 'string') return
      const frame: ScreencastFrame = {
        data,
        format: 'png',
        metadata: (params.metadata ?? {}) as Record<string, unknown>,
      }
      for (const sink of tile.sinks) sink(frame)
    })
    cdp.on('Page.frameNavigated', (params) => {
      const frame = params.frame as { parentId?: string; url?: string } | undefined
      if (!frame || frame.parentId || typeof frame.url !== 'string') return
      this.handleMainFrameNavigation(tile, frame.url)
    })
    cdp.onClose(() => {
      if (this.tiles.get(webPaneId) !== tile) return
      this.tiles.delete(webPaneId)
      this.options.onTargetDown?.(webPaneId)
    })
    await cdp.send('Page.enable')
    this.tiles.set(webPaneId, tile)
    return tile
  }

  /**
   * The navigation watchdog: a main-frame navigation to a URL that would
   * require confirmation blanks the target and re-pends the tile, keeping the
   * trust policy intact even when an attached agent drives the page.
   */
  private handleMainFrameNavigation(tile: TileTarget, url: string): void {
    if (url === 'about:blank' || url === tile.currentUrl) return
    if (url.startsWith('chrome-error://') || url.startsWith('devtools://')) return
    const decision = this.options.classify(url)
    if (decision.kind === 'open') {
      tile.currentUrl = url
      return
    }
    tile.currentUrl = 'about:blank'
    tile.cdp.sendAndForget('Page.navigate', { url: 'about:blank' })
    this.options.onExternalNavigation(tile.webPaneId, url)
  }

  private async browserHttp(port: number, path: string, method: 'GET' | 'PUT' = 'GET'): Promise<unknown> {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method })
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
