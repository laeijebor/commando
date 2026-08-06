import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import {
  MAX_WEB_PANES,
  MAX_WEB_PANE_URL_LENGTH,
  type WebPane,
  type WebPaneEngine,
  type WebPanePlacement,
} from '../shared/protocol.js'
import { resolveAutoPlacement } from '../shared/web-pane-placement.js'

const SESSION_ID = /^\$\d+$/
const WINDOW_ID = /^@\d+$/
const PANE_ID = /^%\d+$/
const WEB_PANE_ID = /^w-[0-9a-f]{8}$/
const MAX_ALLOWED_ORIGINS = 64
const PLACEMENTS: readonly WebPanePlacement[] = ['right', 'below', 'auto']
const ENGINES: readonly WebPaneEngine[] = ['webkit', 'chromium']

type StateFile = {
  version: 1
  allowedOrigins: string[]
  panes: WebPane[]
}

export type WebPaneUrlDecision =
  | { kind: 'invalid'; reason: string }
  | { kind: 'open'; url: string; origin: string }
  | { kind: 'confirm'; url: string; origin: string }

export class WebPaneError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

function isLocalHostname(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname === '[::1]'
  )
}

/**
 * Classifies a URL for a web pane: localhost and previously allowed origins
 * open immediately; other http(s) origins require the owner's confirmation.
 */
export function classifyWebPaneUrl(
  rawUrl: string,
  allowedOrigins: ReadonlySet<string>,
): WebPaneUrlDecision {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0) {
    return { kind: 'invalid', reason: 'url is required' }
  }
  if (rawUrl.length > MAX_WEB_PANE_URL_LENGTH) {
    return { kind: 'invalid', reason: 'url is too long' }
  }
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    return { kind: 'invalid', reason: 'url is not a valid absolute URL' }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { kind: 'invalid', reason: 'url must use http or https' }
  }
  if (parsed.username || parsed.password) {
    return { kind: 'invalid', reason: 'url must not contain credentials' }
  }
  const url = parsed.toString()
  const origin = parsed.origin
  if (isLocalHostname(parsed.hostname) || allowedOrigins.has(origin)) {
    return { kind: 'open', url, origin }
  }
  return { kind: 'confirm', url, origin }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseWebPane(value: unknown, allowedOrigins: ReadonlySet<string>): WebPane | null {
  if (!isRecord(value)) return null
  const {
    id, url, sessionId, windowId, anchorPaneId, placement, engine, openedBy, openerLabel,
    status, createdAt,
  } = value
  if (
    typeof id !== 'string' || !WEB_PANE_ID.test(id) ||
    typeof url !== 'string' ||
    typeof sessionId !== 'string' || !SESSION_ID.test(sessionId) ||
    typeof windowId !== 'string' || !WINDOW_ID.test(windowId) ||
    typeof anchorPaneId !== 'string' || !PANE_ID.test(anchorPaneId) ||
    typeof placement !== 'string' || !PLACEMENTS.includes(placement as WebPanePlacement) ||
    // Records persisted before the engine field existed default to webkit.
    (engine !== undefined && !ENGINES.includes(engine as WebPaneEngine)) ||
    (openedBy !== 'agent' && openedBy !== 'user') ||
    (openerLabel !== undefined && (typeof openerLabel !== 'string' || openerLabel.length > 128)) ||
    (status !== 'open' && status !== 'pending') ||
    typeof createdAt !== 'number' || !Number.isSafeInteger(createdAt) || createdAt < 0
  ) {
    return null
  }
  const decision = classifyWebPaneUrl(url, allowedOrigins)
  if (decision.kind === 'invalid') return null
  return {
    id,
    url: decision.url,
    sessionId,
    windowId,
    anchorPaneId,
    placement: placement as WebPanePlacement,
    engine: (engine as WebPaneEngine | undefined) ?? 'webkit',
    openedBy,
    ...(openerLabel !== undefined ? { openerLabel } : {}),
    status,
    createdAt,
  }
}

function parseState(value: unknown): StateFile {
  if (!isRecord(value) || value.version !== 1) {
    throw new Error('Web pane state file has an invalid structure')
  }
  const allowedOrigins: string[] = []
  if (Array.isArray(value.allowedOrigins)) {
    for (const origin of value.allowedOrigins) {
      if (typeof origin !== 'string' || allowedOrigins.length >= MAX_ALLOWED_ORIGINS) continue
      try {
        if (new URL(origin).origin === origin) allowedOrigins.push(origin)
      } catch {
        // Skip malformed persisted origins rather than failing the whole load.
      }
    }
  }
  const originSet = new Set(allowedOrigins)
  const panes: WebPane[] = []
  if (Array.isArray(value.panes)) {
    for (const candidate of value.panes) {
      const pane = parseWebPane(candidate, originSet)
      if (pane && panes.length < MAX_WEB_PANES && !panes.some((existing) => existing.id === pane.id)) {
        panes.push(pane)
      }
    }
  }
  return { version: 1, allowedOrigins, panes }
}

export function defaultWebPaneStatePath(): string {
  return process.env.COMMANDO_WEB_PANES_PATH ?? join(homedir(), '.commando', 'web-panes.json')
}

export type OpenWebPaneInput = {
  url: string
  anchorPaneId: string
  sessionId: string
  windowId: string
  placement?: WebPanePlacement
  /** The anchor pane's current cell size, used to resolve 'auto' placement. */
  anchorSize?: { cols: number; rows: number }
  engine?: WebPaneEngine
  openedBy: 'agent' | 'user'
  openerLabel?: string
}

type PruneWindow = { id: string; paneIds: readonly string[] }

/**
 * Daemon-owned registry of web panes plus the per-origin allowlist, persisted
 * to ~/.commando/web-panes.json with atomic write-then-rename.
 */
export class WebPaneService {
  readonly statePath: string
  private readonly panes = new Map<string, WebPane>()
  private readonly allowedOrigins = new Set<string>()
  private writes: Promise<void> = Promise.resolve()
  private readonly now: () => number

  constructor(statePath = defaultWebPaneStatePath(), now: () => number = Date.now) {
    this.statePath = statePath
    this.now = now
  }

  async load(): Promise<void> {
    let content: string
    try {
      content = await readFile(this.statePath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    const state = parseState(JSON.parse(content) as unknown)
    this.allowedOrigins.clear()
    for (const origin of state.allowedOrigins) this.allowedOrigins.add(origin)
    this.panes.clear()
    for (const pane of state.panes) this.panes.set(pane.id, pane)
  }

  list(): WebPane[] {
    return [...this.panes.values()]
  }

  get(id: string): WebPane | undefined {
    return this.panes.get(id)
  }

  open(input: OpenWebPaneInput): WebPane {
    const decision = classifyWebPaneUrl(input.url, this.allowedOrigins)
    if (decision.kind === 'invalid') throw new WebPaneError(400, decision.reason)
    if (!PANE_ID.test(input.anchorPaneId)) throw new WebPaneError(400, 'Invalid anchor pane id')
    if (this.panes.size >= MAX_WEB_PANES) {
      throw new WebPaneError(409, `At most ${MAX_WEB_PANES} web panes can be open`)
    }
    const requested = input.placement ?? 'auto'
    if (!PLACEMENTS.includes(requested)) throw new WebPaneError(400, 'Invalid placement')
    // Resolve 'auto' once, from the anchor's unsplit geometry. A stored
    // 'auto' re-derived from live geometry oscillates: the applied layout
    // halves the anchor along the chosen axis, flipping the next decision.
    const placement = requested !== 'auto'
      ? requested
      : input.anchorSize
        ? resolveAutoPlacement(input.anchorSize)
        : 'right'
    const engine = input.engine ?? 'webkit'
    if (!ENGINES.includes(engine)) throw new WebPaneError(400, 'Invalid engine')

    const pane: WebPane = {
      id: `w-${randomUUID().replaceAll('-', '').slice(0, 8)}`,
      url: decision.url,
      sessionId: input.sessionId,
      windowId: input.windowId,
      anchorPaneId: input.anchorPaneId,
      placement,
      engine,
      openedBy: input.openedBy,
      ...(input.openerLabel !== undefined ? { openerLabel: input.openerLabel } : {}),
      status: decision.kind === 'open' ? 'open' : 'pending',
      createdAt: this.now(),
    }
    this.panes.set(pane.id, pane)
    this.persist()
    return pane
  }

  /** Classifies a URL against the current allowlist (for the chromium watchdog). */
  classify(url: string): WebPaneUrlDecision {
    return classifyWebPaneUrl(url, this.allowedOrigins)
  }

  /**
   * Flips an open pane back to pending after its chromium target navigated to
   * an un-allowlisted external URL. The tile shows the confirm card for the
   * navigated-to URL; confirming resumes there. No-op unless the navigation
   * actually needs confirmation (the origin may have been allowed meanwhile).
   */
  repend(id: string, url: string): WebPane | undefined {
    const pane = this.panes.get(id)
    if (!pane) return undefined
    const decision = classifyWebPaneUrl(url, this.allowedOrigins)
    if (decision.kind !== 'confirm') return pane
    const pended: WebPane = { ...pane, url: decision.url, status: 'pending' }
    this.panes.set(id, pended)
    this.persist()
    return pended
  }

  confirm(id: string, allowOrigin: boolean): WebPane {
    const pane = this.panes.get(id)
    if (!pane) throw new WebPaneError(404, 'Web pane does not exist')
    if (pane.status !== 'pending') return pane
    if (allowOrigin) {
      const decision = classifyWebPaneUrl(pane.url, this.allowedOrigins)
      if (decision.kind !== 'invalid' && this.allowedOrigins.size < MAX_ALLOWED_ORIGINS) {
        this.allowedOrigins.add(decision.origin)
      }
    }
    const confirmed: WebPane = { ...pane, status: 'open' }
    this.panes.set(id, confirmed)
    this.persist()
    return confirmed
  }

  close(id: string): boolean {
    if (!this.panes.delete(id)) return false
    this.persist()
    return true
  }

  /**
   * Rewrites any persisted 'auto' placement (from before placements were
   * resolved at open) to a concrete direction once the anchor pane's
   * geometry is available. Returns true when anything changed.
   */
  resolveAutoPlacements(
    paneSizeFor: (paneId: string) => { cols: number; rows: number } | undefined,
  ): boolean {
    let changed = false
    for (const [id, pane] of this.panes) {
      if (pane.placement !== 'auto') continue
      const size = paneSizeFor(pane.anchorPaneId)
      if (!size) continue
      this.panes.set(id, { ...pane, placement: resolveAutoPlacement(size) })
      changed = true
    }
    if (changed) this.persist()
    return changed
  }

  /**
   * Drops panes whose window disappeared and re-anchors panes whose anchor
   * pane died to the window's first surviving pane. Skips entirely-empty
   * snapshots so a daemon started before tmux is reachable does not wipe
   * persisted panes. Returns true when anything changed.
   */
  prune(currentWindows: readonly PruneWindow[]): boolean {
    if (this.panes.size === 0 || currentWindows.length === 0) return false
    const windows = new Map(currentWindows.map((window) => [window.id, window]))
    let changed = false
    for (const [id, pane] of this.panes) {
      const window = windows.get(pane.windowId)
      if (!window || window.paneIds.length === 0) {
        this.panes.delete(id)
        changed = true
        continue
      }
      if (!window.paneIds.includes(pane.anchorPaneId)) {
        this.panes.set(id, { ...pane, anchorPaneId: window.paneIds[0] })
        changed = true
      }
    }
    if (changed) this.persist()
    return changed
  }

  private persist(): void {
    const state: StateFile = {
      version: 1,
      allowedOrigins: [...this.allowedOrigins],
      panes: this.list(),
    }
    this.writes = this.writes
      .then(() => this.writeState(state))
      .catch((error: unknown) => {
        console.error('[commando] failed to persist web panes', error)
      })
  }

  /** Resolves once every persist() queued so far has hit disk. */
  async flush(): Promise<void> {
    await this.writes
  }

  private async writeState(state: StateFile): Promise<void> {
    const directory = dirname(this.statePath)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const temporaryPath = `${this.statePath}.${process.pid}.${randomUUID()}.tmp`
    let handle: Awaited<ReturnType<typeof open>> | null = null
    try {
      handle = await open(temporaryPath, 'wx', 0o600)
      await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, 'utf8')
      await handle.sync()
      await handle.close()
      handle = null
      await rename(temporaryPath, this.statePath)
    } catch (error) {
      await handle?.close().catch(() => undefined)
      await rm(temporaryPath, { force: true }).catch(() => undefined)
      throw error
    }
  }
}
