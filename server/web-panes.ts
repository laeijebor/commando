import { createHash, randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import {
  MAX_WEB_PANES,
  MAX_WEB_PANE_URL_LENGTH,
  MAX_WEB_PANE_TITLE_LENGTH,
  MAX_TERMINAL_COLS,
  MAX_TERMINAL_ROWS,
  type ServerMessage,
  type WebPane,
  type WebPaneEngine,
  type WebPanePlacement,
} from '../shared/protocol.js'
import { canvasRelativePath } from '../shared/canvas-manifest.js'
import { guideRelativePath } from '../shared/guide.js'
import { parsePrPanelKey, prPanelKey, isLegacyPrPanelKey, isBuiltinPanelKey, neighbouringTab, nextWebPaneOrder, panelTabs, resolveAutoPlacement } from '../shared/web-pane-placement.js'

const SESSION_ID = /^\$\d+$/
const WINDOW_ID = /^@\d+$/
const PANE_ID = /^%\d+$/
const WEB_PANE_ID = /^w-[0-9a-f]{8}$/
const TMUX_SOCKET_HASH = /^[0-9a-f]{64}$/
const MAX_ALLOWED_ORIGINS = 64
const MAX_DISMISSED_PR_TABS = 200
const PLACEMENTS: readonly WebPanePlacement[] = ['right', 'below', 'auto']
const SIM_UDID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i
const ENGINES: readonly WebPaneEngine[] = ['webkit', 'chromium']
const LAYOUT_STATES = ['pending', 'settled'] as const

type PersistedWebPane = WebPane & { tmuxSocketHash?: string }

type StateFile = {
  version: 1
  allowedOrigins: string[]
  panes: PersistedWebPane[]
  activeTabs: Record<string, string>
  dismissedPrTabs: Record<string, Record<string, string>>
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

function parseAnchorSize(value: unknown): { cols: number; rows: number } | undefined | null {
  if (value === undefined) return undefined
  if (!isRecord(value)) return null
  const { cols, rows } = value
  if (
    !Number.isSafeInteger(cols) || (cols as number) < 1 || (cols as number) > MAX_TERMINAL_COLS ||
    !Number.isSafeInteger(rows) || (rows as number) < 1 || (rows as number) > MAX_TERMINAL_ROWS
  ) return null
  return { cols: cols as number, rows: rows as number }
}

function layoutSplitApplied(
  current: { cols: number; rows: number },
  original: { cols: number; rows: number },
  placement: 'right' | 'below',
): boolean {
  const currentExtent = placement === 'right' ? current.cols : current.rows
  const originalExtent = placement === 'right' ? original.cols : original.rows
  return currentExtent <= Math.max(1, Math.floor(originalExtent * 0.75))
}

export function parseWebPaneContent(value: unknown): WebPane['content'] | null {
  if (value === undefined) return undefined
  if (!isRecord(value)) return null
  if (value.kind === 'simulator' && typeof value.udid === 'string' && SIM_UDID.test(value.udid)) {
    return { kind: 'simulator', udid: value.udid.toUpperCase() }
  }
  if (value.kind === 'canvas' && typeof value.artifactId === 'string' && /^[0-9a-f]{16}$/.test(value.artifactId)) {
    const manifest = canvasRelativePath(value.manifest === undefined ? 'canvas.json' : value.manifest)
    if (manifest) return { kind: 'canvas', artifactId: value.artifactId, manifest }
  }
  if (value.kind === 'guide' && typeof value.artifactId === 'string' && /^[0-9a-f]{16}$/.test(value.artifactId)) {
    const file = guideRelativePath(value.file)
    if (file) return { kind: 'guide', artifactId: value.artifactId, file }
  }
  return null
}

function parseWebPane(value: unknown, allowedOrigins: ReadonlySet<string>): PersistedWebPane | null {
  if (!isRecord(value)) return null
  const {
    content, id, url, title, sessionId, windowId, anchorPaneId, placement, layoutState, anchorSize,
    engine, openedBy, openerLabel,
    status, createdAt, tmuxSocketHash, dock, order, unseen, openRevision,
  } = value
  const parsedAnchorSize = parseAnchorSize(anchorSize)
  if (
    typeof id !== 'string' || !WEB_PANE_ID.test(id) ||
    typeof url !== 'string' ||
    typeof sessionId !== 'string' || !SESSION_ID.test(sessionId) ||
    typeof windowId !== 'string' || !WINDOW_ID.test(windowId) ||
    typeof anchorPaneId !== 'string' || !PANE_ID.test(anchorPaneId) ||
    (dock !== undefined && dock !== 'panel' && dock !== 'split') ||
    (order !== undefined && (!Number.isSafeInteger(order) || (order as number) < 0)) ||
    (unseen !== undefined && typeof unseen !== 'boolean') ||
    (openRevision !== undefined && (!Number.isSafeInteger(openRevision) || (openRevision as number) < 0)) ||
    typeof placement !== 'string' || !PLACEMENTS.includes(placement as WebPanePlacement) ||
    (layoutState !== undefined && !LAYOUT_STATES.includes(layoutState as typeof LAYOUT_STATES[number])) ||
    parsedAnchorSize === null ||
    // Records persisted before the engine field existed default to webkit.
    (engine !== undefined && !ENGINES.includes(engine as WebPaneEngine)) ||
    (openedBy !== 'agent' && openedBy !== 'user') ||
    (openerLabel !== undefined && (typeof openerLabel !== 'string' || openerLabel.length > 128)) ||
    (status !== 'open' && status !== 'pending') ||
    typeof createdAt !== 'number' || !Number.isSafeInteger(createdAt) || createdAt < 0
  ) {
    return null
  }
  const parsedContent = parseWebPaneContent(content)
  if (parsedContent === null) return null
  const simulator = parsedContent?.kind === 'simulator'
  const panelOnly = parsedContent?.kind === 'canvas' || parsedContent?.kind === 'guide'
  const decision = simulator ? { kind: 'open' as const, url: '' } : classifyWebPaneUrl(url, allowedOrigins)
  if (decision.kind === 'invalid') return null
  return {
    id,
    url: decision.url,
    ...(typeof title === 'string' && title ? { title: title.slice(0, MAX_WEB_PANE_TITLE_LENGTH) } : {}),
    ...(parsedContent ? { content: parsedContent } : {}),
    sessionId,
    windowId,
    anchorPaneId,
    placement: placement as WebPanePlacement,
    dock: !panelOnly && dock === 'split' ? 'split' : 'panel',
    order: typeof order === 'number' ? order : -1,
    unseen: unseen === true,
    ...(typeof openRevision === 'number' ? { openRevision } : {}),
    ...(layoutState !== undefined
      ? { layoutState: layoutState as typeof LAYOUT_STATES[number] }
      : {}),
    ...(parsedAnchorSize !== undefined ? { anchorSize: parsedAnchorSize } : {}),
    engine: parsedContent ? 'webkit' : (engine as WebPaneEngine | undefined) ?? 'webkit',
    openedBy,
    ...(openerLabel !== undefined ? { openerLabel } : {}),
    status: simulator ? 'open' : status,
    createdAt,
    ...(typeof tmuxSocketHash === 'string' && TMUX_SOCKET_HASH.test(tmuxSocketHash)
      ? { tmuxSocketHash }
      : {}),
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
  const panes: PersistedWebPane[] = []
  if (Array.isArray(value.panes)) {
    for (const candidate of value.panes) {
      const pane = parseWebPane(candidate, originSet)
      if (pane && panes.length < MAX_WEB_PANES && !panes.some((existing) => existing.id === pane.id)) {
        panes.push(pane)
      }
    }
  }
  // Legacy tabs are appended in creation order, including files with mixed records.
  for (const pane of [...panes].sort((a, b) => a.createdAt - b.createdAt)) {
    if ((pane.order ?? -1) < 0) pane.order = nextWebPaneOrder(panes, pane.anchorPaneId)
    if (pane.dock === 'panel') {
      pane.layoutState = 'settled'
      delete pane.anchorSize
    }
  }
  const activeTabs: Record<string, string> = {}
  if (isRecord(value.activeTabs)) {
    for (const [anchor, key] of Object.entries(value.activeTabs)) {
      if (/^%\d+$/.test(anchor) && typeof key === 'string' && (isLegacyPrPanelKey(key) || isBuiltinPanelKey(key))) activeTabs[anchor] = key
    }
  }
  for (const pane of panes) {
    const tabs = panelTabs(panes, pane.anchorPaneId)
    const saved = isRecord(value.activeTabs) ? value.activeTabs[pane.anchorPaneId] : undefined
    if (activeTabs[pane.anchorPaneId]) continue
    const active = tabs.find((tab) => tab.id === saved) ?? tabs[0]
    if (active) activeTabs[pane.anchorPaneId] = active.id
  }
  const dismissedPrTabs: Record<string, Record<string, string>> = {}
  if (isRecord(value.dismissedPrTabs)) {
    for (const [anchor, entries] of Object.entries(value.dismissedPrTabs)) {
      if (!PANE_ID.test(anchor) || !isRecord(entries)) continue
      const valid: Record<string, string> = {}
      for (const [key, signature] of Object.entries(entries)) {
        const pr = parsePrPanelKey(key)
        if (pr && typeof signature === 'string' && signature.length <= 256) valid[prPanelKey(pr.repo, pr.number)] = signature
      }
      dismissedPrTabs[anchor] = Object.fromEntries(Object.entries(valid).slice(-MAX_DISMISSED_PR_TABS))
    }
  }
  return { version: 1, allowedOrigins, panes, activeTabs, dismissedPrTabs }
}

type WebPaneEnvironment = Record<string, string | undefined>

function legacyWebPaneStatePath(homeDirectory = homedir()): string {
  return join(homeDirectory, '.commando', 'web-panes.json')
}

function tmuxSocketIdentity(environment: WebPaneEnvironment): string {
  const socketPath = environment.COMMANDO_TMUX_SOCKET_PATH
  const socketName = environment.COMMANDO_TMUX_SOCKET_NAME
  if (socketPath && socketName) {
    throw new Error('Set only one of COMMANDO_TMUX_SOCKET_PATH or COMMANDO_TMUX_SOCKET_NAME')
  }
  if (socketPath) return `path:${socketPath}`
  if (socketName) return `name:${socketName}`
  return 'default'
}

function tmuxSocketHash(identity: string): string {
  return createHash('sha256').update(identity).digest('hex')
}

export function defaultWebPaneStatePath(
  environment: WebPaneEnvironment = process.env,
  homeDirectory = homedir(),
): string {
  if (environment.COMMANDO_WEB_PANES_PATH !== undefined) {
    return environment.COMMANDO_WEB_PANES_PATH
  }
  const legacyPath = legacyWebPaneStatePath(homeDirectory)
  const socketIdentity = tmuxSocketIdentity(environment)
  if (socketIdentity === 'default') return legacyPath
  const suffix = tmuxSocketHash(socketIdentity).slice(0, 12)
  return join(homeDirectory, '.commando', `web-panes-${suffix}.json`)
}

function defaultMigrationStatePath(
  environment: WebPaneEnvironment = process.env,
  homeDirectory = homedir(),
): string | undefined {
  if (
    environment.COMMANDO_WEB_PANES_PATH !== undefined ||
    tmuxSocketIdentity(environment) === 'default'
  ) return undefined
  return legacyWebPaneStatePath(homeDirectory)
}

export type OpenWebPaneInput = {
  content?: WebPane['content']
  url: string
  anchorPaneId: string
  sessionId: string
  windowId: string
  placement?: WebPanePlacement
  dock?: 'panel' | 'split'
  /** The anchor pane's current cell size, used to resolve 'auto' placement. */
  anchorSize?: { cols: number; rows: number }
  engine?: WebPaneEngine
  openedBy: 'agent' | 'user'
  openerLabel?: string
}

export type MoveWebPaneTarget = {
  anchorPaneId: string
  placement: 'right' | 'below'
  sessionId: string
  windowId: string
  anchorSize?: { cols: number; rows: number }
}

type PruneWindow = { id: string; sessionId: string; paneIds: readonly string[] }

/**
 * Daemon-owned registry of web panes plus the per-origin allowlist, persisted
 * per tmux socket with atomic write-then-rename.
 */
export class WebPaneService {
  readonly statePath: string
  private readonly panes = new Map<string, WebPane>()
  private activeTabs: Record<string, string> = {}
  private dismissedPrTabs: Record<string, Record<string, string>> = {}
  private readonly paneSocketHashes = new Map<string, string>()
  private readonly allowedOrigins = new Set<string>()
  private writes: Promise<void> = Promise.resolve()
  private titleWriteTimer: ReturnType<typeof setTimeout> | null = null
  private readonly now: () => number
  private readonly migrationStatePath: string | undefined
  private readonly socketHash: string

  constructor(
    statePath?: string,
    now: () => number = Date.now,
    migrationStatePath = statePath === undefined ? defaultMigrationStatePath() : undefined,
    socketIdentity = tmuxSocketIdentity(process.env),
  ) {
    this.statePath = statePath ?? defaultWebPaneStatePath()
    this.now = now
    this.migrationStatePath = migrationStatePath
    this.socketHash = tmuxSocketHash(socketIdentity)
  }

  async load(): Promise<void> {
    let content: string
    let migrated = false
    try {
      content = await readFile(this.statePath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      if (!this.migrationStatePath) return
      try {
        content = await readFile(this.migrationStatePath, 'utf8')
        migrated = true
      } catch (migrationError) {
        if ((migrationError as NodeJS.ErrnoException).code === 'ENOENT') return
        throw migrationError
      }
    }
    const raw: unknown = JSON.parse(content)
    const state = parseState(raw)
    const needsMigration = isRecord(raw) && (!isRecord(raw.activeTabs) ||
      (Array.isArray(raw.panes) && raw.panes.some((pane) => isRecord(pane) &&
        (pane.dock === undefined || pane.order === undefined || pane.unseen === undefined))))
    this.allowedOrigins.clear()
    for (const origin of state.allowedOrigins) this.allowedOrigins.add(origin)
    this.activeTabs = state.activeTabs
    this.dismissedPrTabs = state.dismissedPrTabs
    this.panes.clear()
    this.paneSocketHashes.clear()
    for (const persistedPane of state.panes) {
      const { tmuxSocketHash: persistedSocketHash, ...pane } = persistedPane
      this.panes.set(pane.id, pane)
      if (persistedSocketHash) this.paneSocketHashes.set(pane.id, persistedSocketHash)
    }
    // Copy rather than move so an isolated daemon cannot take ownership of
    // legacy panes that actually belong to another tmux socket.
    if (migrated || needsMigration) this.persist()
  }

  list(): WebPane[] {
    return [...this.panes.values()].map((pane) => ({
      ...pane, activeTab: this.activeTabs[pane.anchorPaneId] === pane.id,
    }))
  }

  get(id: string): WebPane | undefined {
    return this.panes.get(id)
  }

  /** Returns true only when a Chromium page title changes. */
  setTitle(id: string, title: string): boolean {
    const pane = this.panes.get(id)
    if (!pane || pane.engine !== 'chromium' || pane.content) return false
    const next = title.slice(0, MAX_WEB_PANE_TITLE_LENGTH) || undefined
    if (pane.title === next) return false
    const updated = { ...pane, title: next }
    if (!next) delete updated.title
    this.panes.set(id, updated)
    if (this.titleWriteTimer === null) {
      this.titleWriteTimer = setTimeout(() => {
        this.titleWriteTimer = null
        this.persist()
      }, 2_000)
      this.titleWriteTimer.unref()
    }
    return true
  }

  open(input: OpenWebPaneInput): WebPane {
    const content = parseWebPaneContent(input.content)
    if (content === null) throw new WebPaneError(400, input.content?.kind === 'canvas' ? 'Invalid canvas content' : input.content?.kind === 'guide' ? 'Invalid guide content' : 'Invalid simulator udid')
    const simulator = content?.kind === 'simulator' ? content : undefined
    const canvas = content?.kind === 'canvas' ? content : undefined
    const panelOnly = content?.kind === 'canvas' || content?.kind === 'guide'
    if (simulator) {
      const existing = [...this.panes.values()].find((pane) => pane.content?.kind === 'simulator' && pane.content.udid === simulator.udid)
      if (existing) return existing
    }
    if (canvas) {
      const existing = [...this.panes.values()].find((pane) => pane.anchorPaneId === input.anchorPaneId && pane.content?.kind === 'canvas' && pane.content.artifactId === canvas.artifactId && pane.content.manifest === canvas.manifest)
      if (existing) { this.setActiveTab(existing.id); return existing }
    }
    if (content?.kind === 'guide') {
      const existing = [...this.panes.values()].find((pane) => pane.anchorPaneId === input.anchorPaneId && pane.content?.kind === 'guide' && pane.content.artifactId === content.artifactId && pane.content.file === content.file)
      if (existing) { this.setActiveTab(existing.id); return existing }
    }
    const decision = simulator ? { kind: 'open' as const, url: '' } : classifyWebPaneUrl(input.url, this.allowedOrigins)
    if (decision.kind === 'invalid') throw new WebPaneError(400, decision.reason)
    if (!PANE_ID.test(input.anchorPaneId)) throw new WebPaneError(400, 'Invalid anchor pane id')
    if (input.dock !== undefined && input.dock !== 'panel' && input.dock !== 'split') throw new WebPaneError(400, 'Invalid dock')
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
    const engine = content ? 'webkit' : input.engine ?? 'webkit'
    if (!ENGINES.includes(engine)) throw new WebPaneError(400, 'Invalid engine')

    if (!content) {
      const existing = [...this.panes.values()].find((pane) =>
        pane.anchorPaneId === input.anchorPaneId && pane.engine === engine &&
        (this.paneSocketHashes.get(pane.id) ?? this.socketHash) === this.socketHash &&
        pane.windowId === input.windowId && pane.sessionId === input.sessionId &&
        !pane.content && pane.url === decision.url)
      if (existing) {
        if (existing.status === 'pending') return existing
        const reopened: WebPane = {
          ...existing,
          unseen: existing.dock !== 'split' && input.openedBy === 'agent',
          openRevision: (existing.openRevision ?? 0) + 1,
        }
        this.panes.set(existing.id, reopened)
        this.persist()
        return reopened
      }
    }
    if (this.panes.size >= MAX_WEB_PANES) {
      throw new WebPaneError(409, `At most ${MAX_WEB_PANES} web panes can be open`)
    }

    const pane: WebPane = {
      id: `w-${randomUUID().replaceAll('-', '').slice(0, 8)}`,
      url: decision.url,
      ...(content ? { content } : {}),
      sessionId: input.sessionId,
      windowId: input.windowId,
      anchorPaneId: input.anchorPaneId,
      placement,
      dock: panelOnly ? 'panel' : input.dock ?? 'panel',
      order: nextWebPaneOrder(this.list(), input.anchorPaneId),
      unseen: input.openedBy === 'agent',
      ...(panelOnly || input.dock !== 'split' ? { layoutState: 'settled' as const } : {}),
      ...(!panelOnly && input.dock === 'split' && input.anchorSize
        ? { layoutState: 'pending' as const, anchorSize: input.anchorSize }
        : {}),
      engine,
      openedBy: input.openedBy,
      ...(input.openerLabel !== undefined ? { openerLabel: input.openerLabel } : {}),
      status: decision.kind === 'open' ? 'open' : 'pending',
      createdAt: this.now(),
    }
    this.panes.set(pane.id, pane)
    if (pane.dock === 'panel' && !this.activeTabs[pane.anchorPaneId]) this.activeTabs[pane.anchorPaneId] = pane.id
    this.paneSocketHashes.set(pane.id, this.socketHash)
    this.persist()
    return pane
  }

  /** Puts a newly leased simulator in its leasing pane's tabs, taking the tile from any previous holder. */
  showLeasedSimulator(udid: string, anchor: Pick<OpenWebPaneInput, 'anchorPaneId' | 'sessionId' | 'windowId' | 'openerLabel'>): WebPane {
    const existing = [...this.panes.values()].find((pane) => pane.content?.kind === 'simulator' && pane.content.udid === udid.toUpperCase())
    if (existing && existing.anchorPaneId !== anchor.anchorPaneId) this.close(existing.id)
    return this.open({ ...anchor, url: '', content: { kind: 'simulator', udid }, openedBy: 'agent' })
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
    if (pane.content) throw new WebPaneError(409, pane.content.kind === 'canvas' ? 'Canvas tabs cannot navigate to a URL' : pane.content.kind === 'guide' ? 'Guide tabs cannot navigate to a URL' : 'Simulator tiles cannot navigate to a URL')
    const decision = classifyWebPaneUrl(url, this.allowedOrigins)
    if (decision.kind !== 'confirm') return pane
    const pended: WebPane = { ...pane, url: decision.url, status: 'pending' }
    if (pended.url !== pane.url) delete pended.title
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

  panelActiveTabs(): Record<string, string> {
    return { ...this.activeTabs }
  }

  panelDismissedPrTabs(): Record<string, Record<string, string>> {
    return Object.fromEntries(Object.entries(this.dismissedPrTabs).map(([anchor, entries]) => [anchor, { ...entries }]))
  }

  private dismissedPrKey(anchor: unknown, key: unknown, paneExists: (id: string) => boolean): string {
    if (typeof anchor !== 'string' || !PANE_ID.test(anchor) || !paneExists(anchor)) throw new WebPaneError(404, 'Anchor pane does not exist')
    const pr = typeof key === 'string' ? parsePrPanelKey(key) : undefined
    if (!pr) throw new WebPaneError(400, 'Invalid PR tab key')
    return prPanelKey(pr.repo, pr.number)
  }

  dismissPrTab(anchorPaneId: string, key: string, signature: string, paneExists: (id: string) => boolean, nextKey?: string): void {
    key = this.dismissedPrKey(anchorPaneId, key, paneExists)
    if (typeof signature !== 'string' || signature.length > 256) throw new WebPaneError(400, 'Invalid PR tab signature')
    if (nextKey !== undefined) {
      const pane = typeof nextKey === 'string' ? this.panes.get(nextKey) : undefined
      if (typeof nextKey !== 'string' || nextKey === key || (!isBuiltinPanelKey(nextKey) && !(pane?.dock === 'panel' && pane.anchorPaneId === anchorPaneId))) {
        throw new WebPaneError(400, 'Invalid next panel tab')
      }
    }
    const entries = { ...this.dismissedPrTabs[anchorPaneId] }
    delete entries[key]
    entries[key] = signature
    this.dismissedPrTabs[anchorPaneId] = Object.fromEntries(Object.entries(entries).slice(-MAX_DISMISSED_PR_TABS))
    const active = this.activeTabs[anchorPaneId]
    if (active === key || active === 'pr' || active === `pr:${parsePrPanelKey(key)!.number}`) this.activeTabs[anchorPaneId] = nextKey ?? 'session'
    this.persist()
  }

  restorePrTab(anchorPaneId: string, key: string, paneExists: (id: string) => boolean, select = false): void {
    key = this.dismissedPrKey(anchorPaneId, key, paneExists)
    const entries = { ...this.dismissedPrTabs[anchorPaneId] }
    delete entries[key]
    if (Object.keys(entries).length) this.dismissedPrTabs[anchorPaneId] = entries
    else delete this.dismissedPrTabs[anchorPaneId]
    if (select) this.activeTabs[anchorPaneId] = key
    this.persist()
  }

  setActiveTab(id: string, anchorPaneId?: string, paneExists: (id: string) => boolean = () => false): void {
    if (isBuiltinPanelKey(id)) {
      if (!anchorPaneId || !paneExists(anchorPaneId)) throw new WebPaneError(404, 'Anchor pane does not exist')
      this.activeTabs[anchorPaneId] = id
      this.persist()
      return
    }
    const pane = this.panes.get(id)
    if (!pane) throw new WebPaneError(404, 'Web pane does not exist')
    if (pane.dock !== 'panel' || (anchorPaneId && pane.anchorPaneId !== anchorPaneId)) throw new WebPaneError(409, 'Web pane is not a panel tab of this pane')
    this.activeTabs[pane.anchorPaneId] = id
    this.persist()
  }

  clearUnseen(id: string): void {
    const pane = this.panes.get(id)
    if (!pane) throw new WebPaneError(404, 'Web pane does not exist')
    this.panes.set(id, { ...pane, unseen: false })
    this.persist()
  }

  private releaseActiveTab(pane: WebPane): void {
    if (this.activeTabs[pane.anchorPaneId] !== pane.id) return
    const next = neighbouringTab(panelTabs(this.list(), pane.anchorPaneId), pane.id)
    if (next) this.activeTabs[pane.anchorPaneId] = next
    else this.activeTabs[pane.anchorPaneId] = 'session'
  }

  private reconcileActiveTabs(): void {
    for (const anchor of Object.keys(this.activeTabs)) {
      const tabs = panelTabs(this.list(), anchor)
      if (!isLegacyPrPanelKey(this.activeTabs[anchor]) && !isBuiltinPanelKey(this.activeTabs[anchor]) && !tabs.some((tab) => tab.id === this.activeTabs[anchor])) {
        if (tabs[0]) this.activeTabs[anchor] = tabs[0].id
        else delete this.activeTabs[anchor]
      }
    }
    for (const pane of this.panes.values()) {
      if (pane.dock === 'panel' && !this.activeTabs[pane.anchorPaneId]) this.activeTabs[pane.anchorPaneId] = pane.id
    }
  }

  close(id: string): boolean {
    const pane = this.panes.get(id)
    if (!pane) return false
    this.releaseActiveTab(pane)
    this.panes.delete(id)
    this.paneSocketHashes.delete(id)
    this.persist()
    return true
  }

  dock(id: string, dock: unknown, anchorSize?: unknown): WebPane {
    const pane = this.panes.get(id)
    if (!pane) throw new WebPaneError(404, 'Web pane does not exist')
    if (dock !== 'panel' && dock !== 'split') throw new WebPaneError(400, 'Invalid dock')
    if (dock === 'split' && (pane.content?.kind === 'canvas' || pane.content?.kind === 'guide')) throw new WebPaneError(400, pane.content.kind === 'guide' ? 'Guide tabs cannot split out' : 'Canvas tabs cannot split out')
    if ((pane.dock ?? 'panel') === dock) return pane
    const size = parseAnchorSize(anchorSize)
    if (size === null || (dock === 'split' && !size)) throw new WebPaneError(400, 'Invalid anchor size')
    if (dock === 'split') this.releaseActiveTab(pane)
    const updated: WebPane = {
      ...pane, dock,
      layoutState: dock === 'split' ? 'pending' : 'settled',
      ...(dock === 'split' && size ? { placement: resolveAutoPlacement(size), anchorSize: size } : {}),
    }
    if (dock === 'panel') {
      delete updated.anchorSize
      updated.unseen = false
      this.activeTabs[pane.anchorPaneId] = id
    }
    this.panes.set(id, updated)
    this.reconcileActiveTabs()
    this.persist()
    return updated
  }

  /**
   * Re-anchors a tile to another pane in ITS OWN window, with a concrete
   * placement chosen by the drop position. Cross-window moves are rejected
   * here — the invariant lives in the service, not in UI reachability.
   */
  move(id: string, target: MoveWebPaneTarget): WebPane {
    const pane = this.panes.get(id)
    if (!pane) throw new WebPaneError(404, 'Web pane does not exist')
    if (!PANE_ID.test(target.anchorPaneId)) throw new WebPaneError(400, 'Invalid anchor pane id')
    if (target.placement !== 'right' && target.placement !== 'below') {
      throw new WebPaneError(400, 'Move placement must be right or below')
    }
    if (target.windowId !== pane.windowId) {
      throw new WebPaneError(400, 'Web panes can only move within their window')
    }
    const reanchoring = target.anchorPaneId !== pane.anchorPaneId
    if (reanchoring) this.releaseActiveTab(pane)
    const moved: WebPane = {
      ...pane,
      anchorPaneId: target.anchorPaneId,
      order: reanchoring ? nextWebPaneOrder(this.list(), target.anchorPaneId) : pane.order,
      placement: target.placement,
      sessionId: target.sessionId,
      windowId: target.windowId,
    }
    delete moved.layoutState
    delete moved.anchorSize
    if (moved.dock === 'panel') moved.layoutState = 'settled'
    if (moved.dock === 'split' && target.anchorSize) {
      moved.layoutState = 'pending'
      moved.anchorSize = target.anchorSize
    }
    this.panes.set(id, moved)
    this.reconcileActiveTabs()
    this.persist()
    return moved
  }

  /**
   * Swaps a tile's URL through the same trust policy as open: localhost and
   * allowlisted origins stay open; an unconfirmed external origin flips the
   * tile to pending so URL editing cannot bypass the origin gate. An
   * attribution re-stamps openedBy/openerLabel to whoever triggered this
   * navigation, so the pending confirm card credits the right caller instead
   * of preserving the tile's original opener.
   */
  navigate(
    id: string,
    url: string,
    attribution?: { openedBy: 'agent' | 'user'; openerLabel?: string },
  ): WebPane {
    const pane = this.panes.get(id)
    if (!pane) throw new WebPaneError(404, 'Web pane does not exist')
    if (pane.content) throw new WebPaneError(409, pane.content.kind === 'canvas' ? 'Canvas tabs cannot navigate to a URL' : pane.content.kind === 'guide' ? 'Guide tabs cannot navigate to a URL' : 'Simulator tiles cannot navigate to a URL')
    const decision = classifyWebPaneUrl(url, this.allowedOrigins)
    if (decision.kind === 'invalid') throw new WebPaneError(400, decision.reason)
    const navigated: WebPane = {
      ...pane,
      url: decision.url,
      status: decision.kind === 'open' ? 'open' : 'pending',
      ...(attribution
        ? {
            openedBy: attribution.openedBy,
            ...(attribution.openerLabel !== undefined ? { openerLabel: attribution.openerLabel } : {}),
          }
        : {}),
    }
    if (navigated.url !== pane.url) delete navigated.title
    if (attribution && attribution.openerLabel === undefined) delete navigated.openerLabel
    this.panes.set(id, navigated)
    this.persist()
    return navigated
  }

  /** Fills placement and first-render sizing metadata on legacy records. */
  resolveLayoutMetadata(
    paneSizeFor: (paneId: string) => { cols: number; rows: number } | undefined,
  ): boolean {
    let changed = false
    for (const [id, pane] of this.panes) {
      if (pane.dock === 'panel') continue
      const size = paneSizeFor(pane.anchorPaneId)
      if (!size) continue
      const placement = pane.placement === 'auto'
        ? resolveAutoPlacement(size)
        : pane.placement
      const next: WebPane = {
        ...pane,
        placement,
        layoutState: pane.layoutState ?? 'pending',
      }
      if (next.layoutState === 'pending') next.anchorSize ??= size
      else delete next.anchorSize
      if (
        next.layoutState === 'pending' &&
        pane.layoutState === 'pending' &&
        next.anchorSize &&
        layoutSplitApplied(size, next.anchorSize, placement)
      ) {
        next.layoutState = 'settled'
        delete next.anchorSize
      }
      if (
        next.placement === pane.placement &&
        next.layoutState === pane.layoutState &&
        next.anchorSize?.cols === pane.anchorSize?.cols &&
        next.anchorSize?.rows === pane.anchorSize?.rows
      ) continue
      this.panes.set(id, next)
      changed = true
    }
    if (changed) this.persist()
    return changed
  }

  /**
   * Drops panes whose window disappeared and re-anchors panes whose anchor
   * pane died to the window's first surviving pane. Foreign-owned panes are
   * outside this daemon's authority; unstamped legacy panes stay conservative
   * when their whole session is absent. Returns true when anything changed.
   */
  prune(currentWindows: readonly PruneWindow[]): boolean {
    if (this.panes.size === 0 && Object.keys(this.activeTabs).length === 0 && Object.keys(this.dismissedPrTabs).length === 0) return false
    const totalPaneCount = currentWindows.reduce(
      (count, window) => count + window.paneIds.length,
      0,
    )
    if (totalPaneCount === 0) {
      console.warn(
        `web panes: skipped prune for degraded tmux snapshot (windows=${currentWindows.length}, panes=${totalPaneCount})`,
      )
      return false
    }
    const windowsBySession = new Map<string, Map<string, PruneWindow>>()
    for (const window of currentWindows) {
      const windows = windowsBySession.get(window.sessionId) ?? new Map<string, PruneWindow>()
      windows.set(window.id, window)
      windowsBySession.set(window.sessionId, windows)
    }
    let changed = false
    // Built-in selections have no window or socket metadata. Only a complete,
    // matching snapshot can prove their anchors disappeared.
    let canPruneActiveTabs = currentWindows.every((window) => window.paneIds.length > 0)
    for (const [id, pane] of [...this.panes].sort(([, a], [, b]) => (a.order ?? 0) - (b.order ?? 0))) {
      const paneSocketHash = this.paneSocketHashes.get(id)
      if (paneSocketHash !== undefined && paneSocketHash !== this.socketHash) {
        canPruneActiveTabs = false
        continue
      }
      const sessionWindows = windowsBySession.get(pane.sessionId)
      if (!sessionWindows) {
        if (paneSocketHash === undefined) {
          canPruneActiveTabs = false
          continue
        }
        this.panes.delete(id)
        this.paneSocketHashes.delete(id)
        changed = true
        continue
      }
      const window = sessionWindows.get(pane.windowId)
      if (!window) {
        this.panes.delete(id)
        this.paneSocketHashes.delete(id)
        changed = true
        continue
      }
      // A real tmux window always owns at least one pane. An empty list means
      // pane discovery was incomplete, so it cannot prove either the window or
      // the web pane's anchor disappeared.
      if (window.paneIds.length === 0) continue
      if (!window.paneIds.includes(pane.anchorPaneId)) {
        this.releaseActiveTab(pane)
        const reanchored: WebPane = {
          ...pane, anchorPaneId: window.paneIds[0],
          order: nextWebPaneOrder(this.list(), window.paneIds[0]),
        }
        delete reanchored.layoutState
        delete reanchored.anchorSize
        if (reanchored.dock === 'panel') reanchored.layoutState = 'settled'
        this.panes.set(id, reanchored)
        changed = true
      }
    }
    if (changed) this.reconcileActiveTabs()
    if (canPruneActiveTabs) {
      const livePaneIds = new Set(currentWindows.flatMap((window) => window.paneIds))
      for (const anchor of new Set([...Object.keys(this.activeTabs), ...Object.keys(this.dismissedPrTabs)])) {
        if (livePaneIds.has(anchor)) continue
        delete this.activeTabs[anchor]
        delete this.dismissedPrTabs[anchor]
        changed = true
      }
    }
    if (changed) this.persist()
    return changed
  }

  private persist(): void {
    if (this.titleWriteTimer !== null) {
      clearTimeout(this.titleWriteTimer)
      this.titleWriteTimer = null
    }
    const state: StateFile = {
      version: 1,
      allowedOrigins: [...this.allowedOrigins],
      activeTabs: { ...this.activeTabs },
      dismissedPrTabs: this.panelDismissedPrTabs(),
      panes: [...this.panes.values()].map((pane) => {
        const socketHash = this.paneSocketHashes.get(pane.id)
        return { ...pane, ...(socketHash ? { tmuxSocketHash: socketHash } : {}) }
      }),
    }
    this.writes = this.writes
      .then(() => this.writeState(state))
      .catch((error: unknown) => {
        console.error('[commando] failed to persist web panes', error)
      })
  }

  /** Flushes pending titles and resolves once queued state has hit disk. */
  async flush(): Promise<void> {
    if (this.titleWriteTimer !== null) this.persist()
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

export function buildWebPanesMessage(
  service: WebPaneService,
  state: Pick<Extract<ServerMessage, { type: 'web_panes' }>, 'feedback' | 'navigateRequests' | 'spotlightRequests' | 'reloads'> = {},
): Extract<ServerMessage, { type: 'web_panes' }> {
  return {
    type: 'web_panes',
    webPanes: service.list(),
    activeTabs: service.panelActiveTabs(),
    dismissedPrTabs: service.panelDismissedPrTabs(),
    ...state,
  }
}
