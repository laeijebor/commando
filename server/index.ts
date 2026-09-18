import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http'
import { extname, resolve, sep } from 'node:path'
import type { Duplex } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'
import { fileURLToPath } from 'node:url'
import { WebSocket, WebSocketServer, type RawData } from 'ws'
import type {
  AgentStatus,
  CommandoSnapshot,
  PaneMark,
  SavedWorkspace,
  ServerMessage,
  SessionBrief,
} from '../shared/protocol.js'
import { layoutSpecPaneIds } from '../shared/window-layout.js'
import { inferAgentProcessStatus, inferAgentStatus } from './agent-status.js'
import {
  MAX_CLIENT_MESSAGE_BYTES,
  PaneResetGate,
  TokenBucketRateLimiter,
  parseClientMessage,
  type ParsedClientMessage,
} from './client-messages.js'
import { TmuxClient } from './tmux.js'
import { normalizeCaptureLineEndings } from './tmux-control.js'
import { buildPaneSeed } from './terminal-seed.js'
import { WorkspaceStore } from './workspaces.js'
import { WebPaneService } from './web-panes.js'
import { WebPanesApi } from './web-panes-api.js'
import { WebPaneFeedbackStore } from './web-pane-feedback.js'
import { FEEDBACK_JOURNAL_TTL_MS, FeedbackJournal } from './web-pane-feedback-journal.js'
import { WebPaneAttachmentStore } from './web-pane-attachments.js'
import { PendingNotesJournal, WebPanePendingStore } from './web-pane-pending.js'
import { RedlineApi } from './redline-api.js'
import { defaultRedlineArtifactStatePath, RedlineArtifactRegistry } from './redline-artifacts.js'
import { ChromiumEngine } from './chromium-engine.js'
import { WebTileRelay, webTilePathId } from './web-tile-relay.js'
import { LinearService } from './linear.js'
import { handleLinearApi } from './linear-api.js'
import { PrService } from './prs.js'
import { handlePrsApi } from './prs-api.js'
import { handleNotesApi } from './notes-api.js'
import { handleNoteVaultsApi } from './note-vaults-api.js'
import { NoteVaultManager } from './note-vaults.js'
import { SessionManagementApi } from './session-management-api.js'
import { PaneManagementApi } from './pane-management-api.js'
import { PortManagementApi } from './port-management-api.js'
import { runTmuxCreateCommand, tmuxSocketArgsFromEnv, TmuxCreator } from './tmux-create.js'
import { GitWorktreeService } from './git-worktree.js'
import { prepareSessionWorktreeDeletion } from './session-worktree-deletion.js'
import { PaneRepoResolver } from './pane-repos.js'
import { GitDiffApi } from './git-api.js'
import { handleTmuxCreateApi } from './tmux-create-api.js'
import { TmuxResizeLeaseBusyError } from './tmux-resize-lease.js'
import {
  configuredAuthDatabasePath,
  configuredAuthSecret,
  configuredOwnerEmail,
  createAuthService,
  disabledAuthBootstrap,
} from './auth.js'
import { createNetworkAccess, isLoopbackAddress } from './network-access.js'
import { loadOrCreateAgentHookToken } from './agent-hook-token.js'
import { AgentStatusHookApi } from './agent-status-api.js'
import { SessionBriefApi } from './session-brief-api.js'
import { PaneTargetApi } from './pane-target-api.js'
import { SessionBriefStore } from './session-briefs.js'
import {
  defaultPaneScreenshotStatePath,
  handlePaneScreenshotApi,
  handlePaneScreenshotImage,
  PaneScreenshotRegistry,
} from './pane-screenshots.js'
import { PaneMarkStore } from './pane-marks.js'
import { AgentInteractionBroker } from './agent-interaction-broker.js'
import { AgentRequestApi } from './agent-request-api.js'
import { answerAgentRequest, IdempotencyKeyMemory } from './agent-request-answers.js'
import { CompanionHub } from './companion.js'
import { captureRenderedCompanionOutput } from './companion-output.js'
import { ProviderUsageService } from './provider-usage.js'
import { snapshotsHaveSameState } from './snapshot-state.js'
import { stripAnsi } from './terminal-text.js'
import { TmuxResurrectSaver } from './tmux-resurrect-saver.js'
import {
  AgentStatusRegistry,
  type AgentStatusChange,
} from './agent-status-registry.js'

const DEFAULT_PORT = 4310
const DEVELOPMENT_WEB_PORT = 5173
const SNAPSHOT_INTERVAL_MS = 1_000
const MAX_WS_BUFFERED_BYTES = 1024 * 1024
const MAX_LIVE_MESSAGE_BYTES = 64 * 1024
const MAX_INFERENCE_TAIL_CHARS = 32 * 1024
const STATIC_ROOT = resolve(fileURLToPath(new URL('../dist/', import.meta.url)))
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'none'",
  "connect-src 'self' ws: wss:",
  "font-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  // Web pane tiles embed localhost dev servers and confirmed https sites.
  "frame-src http://localhost:* http://127.0.0.1:* https:",
  "img-src 'self' data:",
  "object-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
].join('; ')

type ClientState = {
  id: string
  socket: WebSocket
  subscribedPaneIds: Set<string>
  statusPaneIds: Set<string>
  paneStreams: Map<string, PaneStreamState>
  lastStatus: Map<string, string>
  inputLimiter: TokenBucketRateLimiter
  paneResetGate: PaneResetGate
  inputQueue: Promise<void>
  violations: number
  releaseInteractions: (() => void) | null
  answeredRequestIds: IdempotencyKeyMemory
}

type PaneStreamState = {
  seeding: boolean
  requestedGeneration: number
  sourceCols: number
  sourceRows: number
  task: Promise<void> | null
}

type PaneTextTail = {
  decoder: StringDecoder
  content: string
  lastChangedAt: number
}

function inputRateCost(byteLength: number): number {
  return 1 + Math.ceil(byteLength / 256)
}

function configuredPort(): number {
  const value = process.env.COMMANDO_PORT
  if (value === undefined) return DEFAULT_PORT
  if (!/^\d+$/.test(value)) throw new Error('COMMANDO_PORT must be an integer')
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('COMMANDO_PORT must be between 1 and 65535')
  }
  return port
}

function authToken(): string {
  const configured = process.env.COMMANDO_TOKEN
  if (configured === undefined) return randomBytes(32).toString('base64url')
  if (
    configured.length === 0 ||
    configured.length > 1_024 ||
    /[\u0000-\u0020\u007f]/.test(configured)
  ) {
    throw new Error('COMMANDO_TOKEN must be a non-empty token without whitespace')
  }
  return configured
}

function tokenDigest(value: string): Buffer {
  return createHash('sha256').update(value).digest()
}

function matchesToken(candidate: string | null, digest: Buffer): boolean {
  if (candidate === null || candidate.length > 1_024) return false
  return timingSafeEqual(tokenDigest(candidate), digest)
}

function requestHasValidToken(
  request: IncomingMessage,
  url: URL,
  digest: Buffer,
): boolean {
  if (matchesToken(url.searchParams.get('token'), digest)) return true
  const authorization = request.headers.authorization
  if (!authorization) return false
  const match = /^Bearer\s+([^\s]+)$/i.exec(authorization)
  return matchesToken(match?.[1] ?? null, digest)
}

function requestUrl(request: IncomingMessage): URL | null {
  if (!request.url || request.url.length > 8_192) return null
  try {
    return new URL(request.url, 'http://127.0.0.1')
  } catch {
    return null
  }
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  const body = `${JSON.stringify(value)}\n`
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
    'Content-Type': 'application/json; charset=utf-8',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  })
  response.end(body)
}

function send(client: ClientState, message: ServerMessage): boolean {
  if (client.socket.readyState !== WebSocket.OPEN) return false
  const serialized = JSON.stringify(message)
  if (
    client.socket.bufferedAmount + Buffer.byteLength(serialized, 'utf8') >
    MAX_WS_BUFFERED_BYTES
  ) {
    client.socket.close(1013, 'Client is not consuming output')
    return false
  }
  client.socket.send(serialized)
  return true
}

function sendError(
  client: ClientState,
  code: string,
  message: string,
  requestId?: string,
): void {
  send(client, { type: 'error', code, message, requestId })
}

function violation(
  client: ClientState,
  code: string,
  message: string,
  requestId?: string,
): void {
  client.violations += 1
  sendError(client, code, message, requestId)
  if (client.violations >= 8) client.socket.close(1008, 'Too many invalid messages')
}

function rawDataBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data
  if (data instanceof ArrayBuffer) return Buffer.from(data)
  return Buffer.concat(data)
}

function statusFingerprint(status: AgentStatus): string {
  return [
    status.provider,
    status.status,
    status.summary,
    status.source,
    status.confidence,
    JSON.stringify(status.details ?? null),
  ].join('\u001f')
}

function paneRenderingFingerprint(pane: CommandoSnapshot['panes'][number]): string {
  return JSON.stringify([
    pane.width,
    pane.height,
    pane.alternateOn,
    pane.cursorVisible,
    pane.cursorShape,
    pane.cursorBlinking,
    pane.scrollRegionUpper,
    pane.scrollRegionLower,
    pane.wrapFlag,
    pane.originFlag,
    pane.insertFlag,
    pane.keypadFlag,
    pane.keypadCursorFlag,
    pane.mouseAnyFlag,
    pane.mouseSgrFlag,
    pane.paneTabs,
  ])
}

function workspaceTargetError(
  workspace: SavedWorkspace,
  snapshot: CommandoSnapshot,
): string | null {
  if (!snapshot.sessions.some((session) => session.id === workspace.sessionId)) {
    return 'Workspace session does not exist'
  }

  const windows = new Map(snapshot.windows.map((window) => [window.id, window]))
  const panes = new Map(snapshot.panes.map((pane) => [pane.id, pane]))
  for (const group of workspace.groups) {
    const window = windows.get(group.windowId)
    if (!window || window.sessionId !== workspace.sessionId) {
      return `Workspace group ${group.id} references an invalid window`
    }
    for (const paneId of group.paneIds) {
      const pane = panes.get(paneId)
      if (
        !pane ||
        pane.sessionId !== workspace.sessionId ||
        pane.windowId !== group.windowId
      ) {
        return `Workspace group ${group.id} references an invalid pane`
      }
    }
  }
  return null
}

function contentType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case '.css':
      return 'text/css; charset=utf-8'
    case '.html':
      return 'text/html; charset=utf-8'
    case '.js':
    case '.mjs':
      return 'text/javascript; charset=utf-8'
    case '.json':
      return 'application/json; charset=utf-8'
    case '.svg':
      return 'image/svg+xml'
    case '.png':
      return 'image/png'
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    case '.webp':
      return 'image/webp'
    case '.ico':
      return 'image/x-icon'
    case '.woff':
      return 'font/woff'
    case '.woff2':
      return 'font/woff2'
    default:
      return 'application/octet-stream'
  }
}

async function regularFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

async function serveProductionAsset(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
): Promise<void> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD' })
    response.end()
    return
  }

  let pathname: string
  try {
    pathname = decodeURIComponent(url.pathname)
  } catch {
    response.writeHead(400)
    response.end('Bad Request')
    return
  }

  if (pathname.includes('\0')) {
    response.writeHead(400)
    response.end('Bad Request')
    return
  }

  const requestedPath = resolve(STATIC_ROOT, pathname.replace(/^\/+/, ''))
  if (requestedPath !== STATIC_ROOT && !requestedPath.startsWith(`${STATIC_ROOT}${sep}`)) {
    response.writeHead(403)
    response.end('Forbidden')
    return
  }

  const path = (await regularFile(requestedPath))
    ? requestedPath
    : resolve(STATIC_ROOT, 'index.html')
  if (!(await regularFile(path))) {
    response.writeHead(404)
    response.end('Not Found')
    return
  }

  const metadata = await stat(path)
  response.writeHead(200, {
    'Cache-Control': path.endsWith('index.html')
      ? 'no-cache'
      : 'public, max-age=31536000, immutable',
    'Content-Length': metadata.size,
    'Content-Type': contentType(path),
    'Content-Security-Policy': CONTENT_SECURITY_POLICY,
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  })
  if (request.method === 'HEAD') {
    response.end()
    return
  }
  createReadStream(path).on('error', () => response.destroy()).pipe(response)
}

function rejectUpgrade(socket: Duplex, status: number, reason: string): void {
  if (!socket.writable) {
    socket.destroy()
    return
  }
  const body = `${reason}\n`
  socket.end(
    `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
  )
}

async function main(): Promise<void> {
  const port = configuredPort()
  const networkAccess = createNetworkAccess(port)
  const token = authToken()
  const digest = tokenDigest(token)
  const agentHookToken = await loadOrCreateAgentHookToken()
  const companionTokenDigest = tokenDigest(agentHookToken)
  const ownerEmail = configuredOwnerEmail()
  const authBaseURL = process.env.BETTER_AUTH_URL ?? `http://127.0.0.1:${port}`
  const auth = ownerEmail
    ? await createAuthService({
        ownerEmail,
        databasePath: configuredAuthDatabasePath(),
        secret: await configuredAuthSecret(),
        baseURL: authBaseURL,
        trustedOrigins: [...new Set([...networkAccess.trustedOrigins, authBaseURL])],
      })
    : null
  const protectedPorts = process.env.NODE_ENV === 'production'
    ? [port]
    : [port, DEVELOPMENT_WEB_PORT]
  const tmux = new TmuxClient(protectedPorts)
  const resurrectSaver = new TmuxResurrectSaver({
    onError: (error) => {
      console.error('[commando] tmux Resurrect save failed', error)
    },
  })
  const workspaces = new WorkspaceStore()
  const sessionBriefs = new SessionBriefStore()
  const paneScreenshots = new PaneScreenshotRegistry({ statePath: defaultPaneScreenshotStatePath(port) })
  await sessionBriefs.load().catch((error: unknown) => {
    console.error('[commando] failed to load persisted session briefs', error)
  })
  const paneMarks = new PaneMarkStore()
  await paneMarks.load().catch((error: unknown) => {
    console.error('[commando] failed to load persisted pane marks', error)
  })
  const webPanes = new WebPaneService()
  await webPanes.load().catch((error: unknown) => {
    console.error('[commando] failed to load persisted web panes', error)
  })
  const webPaneAttachments = new WebPaneAttachmentStore()
  const feedbackJournal = new FeedbackJournal()
  const pendingJournal = new PendingNotesJournal()
  feedbackJournal.removeExpired(FEEDBACK_JOURNAL_TTL_MS)
  webPaneAttachments.cleanup(new Set([
    ...pendingJournal.referencedAttachmentIds(),
    ...feedbackJournal.referencedAttachmentIds(),
  ]))
  let webPaneFeedback: WebPaneFeedbackStore
  let webPanePending: WebPanePendingStore
  const releaseAttachment = (attachmentId: string): void => {
    if (
      webPanePending?.referencedAttachmentIds().has(attachmentId) ||
      webPaneFeedback?.referencedAttachmentIds().has(attachmentId)
    ) return
    webPaneAttachments.remove(attachmentId)
  }
  // onDrain fires only at request time, safely after publishWebPanes exists.
  webPaneFeedback = new WebPaneFeedbackStore(
    feedbackJournal,
    () => publishWebPanes(),
    Date.now,
    releaseAttachment,
  )
  webPanePending = new WebPanePendingStore(
    pendingJournal,
    releaseAttachment,
  )
  const chromiumEngine = new ChromiumEngine({
    classify: (url) => webPanes.classify(url),
    onExternalNavigation: (webPaneId, navigatedUrl) => {
      const pane = webPanes.repend(webPaneId, navigatedUrl)
      if (pane?.status === 'pending') publishWebPanes()
    },
    onTargetDown: (webPaneId) => webTileRelay.dropTile(webPaneId),
    // Page answers land in the daemon's pending store first — a tile with no
    // connected viewer (hidden tab, other session focused) must not drop them.
    onPageResponse: (webPaneId, response, pageUrl) => {
      const pane = webPanes.get(webPaneId)
      if (!pane) return
      webTileRelay.broadcastPending(
        webPaneId,
        webPanePending.addResponse(webPaneId, pageUrl, response),
      )
    },
  })
  const webTileRelay = new WebTileRelay({
    engine: chromiumEngine,
    service: webPanes,
    pendingNotes: (webPaneId) => webPanePending.snapshot(webPaneId),
  })
  /**
   * Single funnel for web-pane changes: closes engine targets and tile
   * streams that no longer correspond to an open chromium tile, then
   * broadcasts the new list.
   */
  const publishWebPanes = (): void => {
    const streamable = new Set(
      webPanes
        .list()
        .filter((pane) => pane.engine === 'chromium' && pane.status === 'open')
        .map((pane) => pane.id),
    )
    chromiumEngine.syncTiles(streamable)
    webTileRelay.dropStale(streamable)
    const liveIds = new Set(webPanes.list().map((pane) => pane.id))
    webPaneFeedback.retain(liveIds)
    webPanePending.retain(liveIds)
    broadcast({ type: 'web_panes', webPanes: webPanes.list(), feedback: webPaneFeedback.info() })
  }
  const notes = new NoteVaultManager()
  const linear = new LinearService()
  const prs = new PrService()
  const gitWorktrees = new GitWorktreeService()
  const paneRepos = new PaneRepoResolver((directory) => gitWorktrees.probe(directory))
  const tmuxCreator = new TmuxCreator(runTmuxCreateCommand, tmuxSocketArgsFromEnv(), gitWorktrees)
  const clients = new Set<ClientState>()
  const paneTextTails = new Map<string, PaneTextTail>()
  const companionOutputTails = new Map<string, string>()
  const agentStatuses = new AgentStatusRegistry()
  let companion: CompanionHub | null = null
  let companionClientCount = 0
  let companionPublishTimer: NodeJS.Timeout | undefined
  const companionOutputRefreshTimers = new Map<string, NodeJS.Timeout>()
  const companionOutputGenerations = new Map<string, number>()
  let syncingRequiredSessions = false
  let requiredSessionsResyncPending = false
  let snapshot: CommandoSnapshot = {
    revision: 0,
    capturedAt: Date.now(),
    sessions: [],
    windows: [],
    panes: [],
    ports: [],
  }
  let snapshotRefresh: Promise<CommandoSnapshot> | null = null
  let snapshotRevision = 0
  let outputRevision = 0
  let lastTmuxError = ''
  let structuralRefreshTimer: NodeJS.Timeout | undefined

  const requestIsAuthorized = async (
    request: IncomingMessage,
    url: URL,
  ): Promise<boolean> => (
    requestHasValidToken(request, url, digest) || (await auth?.hasSession(request)) === true
  )

  const broadcast = (message: ServerMessage): void => {
    for (const client of clients) send(client, message)
  }

  const publishedBriefs = new Map(sessionBriefs.values().map((brief) => [brief.paneId, brief]))
  const briefTargetIds = new Map<string, string>()

  const publishPaneMark = (mark: PaneMark): void => {
    broadcast({ type: 'pane_mark', mark })
  }

  const publishSessionBrief = (brief: SessionBrief): void => {
    const pane = snapshot.panes.find((candidate) => candidate.id === brief.paneId)
    const previousTargetId = briefTargetIds.get(brief.paneId)
    const previous = previousTargetId === undefined || previousTargetId === pane?.targetId
      ? publishedBriefs.get(brief.paneId) ?? null
      : null
    publishedBriefs.set(brief.paneId, brief)
    if (pane) {
      briefTargetIds.set(brief.paneId, pane.targetId)
      void paneMarks.observeBrief(pane.targetId, previous, brief)
        .then((mark) => { if (mark) publishPaneMark(mark) })
        .catch((error: unknown) => {
          console.error('[commando] failed to record pane mark activity', error)
        })
    }
    broadcast({ type: 'session_brief', brief })
  }

  const invalidateCompanionOutputRefresh = (paneId: string): void => {
    const timer = companionOutputRefreshTimers.get(paneId)
    if (timer) clearTimeout(timer)
    companionOutputRefreshTimers.delete(paneId)
    companionOutputGenerations.set(paneId, (companionOutputGenerations.get(paneId) ?? 0) + 1)
  }

  const sendAgentStatusChange = (client: ClientState, change: AgentStatusChange): void => {
    if (!change) return
    if (change.type === 'remove') {
      client.lastStatus.delete(change.paneId)
      send(client, { type: 'agent_status_removed', paneId: change.paneId })
      return
    }
    const fingerprint = statusFingerprint(change.status)
    if (client.lastStatus.get(change.status.paneId) === fingerprint) return
    if (send(client, { type: 'agent_status', status: change.status })) {
      client.lastStatus.set(change.status.paneId, fingerprint)
    }
  }

  const publishAgentStatusChange = (change: AgentStatusChange): void => {
    for (const client of clients) sendAgentStatusChange(client, change)
    if (change && companionClientCount > 0) {
      if (change.type === 'remove') {
        invalidateCompanionOutputRefresh(change.paneId)
        companionOutputTails.delete(change.paneId)
      } else if (
        change.status.source === 'hook' &&
        (change.status.status === 'done' || change.status.status === 'failed')
      ) {
        if (paneTextTails.has(change.status.paneId)) {
          scheduleCompanionOutputRefresh(change.status.paneId)
        } else {
          primeStatusTail(change.status.paneId)
        }
      }
      syncRequiredSessions()
      if (
        change.type === 'upsert' &&
        companionObservesLiveOutput(change.status.paneId)
      ) primeStatusTail(change.status.paneId)
    }
    if (change) companion?.publish()
    if (change) {
      const pane = paneForId(change.type === 'remove' ? change.paneId : change.status.paneId)
      const session = pane && snapshot.sessions.find((candidate) => candidate.id === pane.sessionId)
      if (pane && session) {
        const statuses = agentStatuses.values().filter((status) => (
          paneForId(status.paneId)?.sessionId === session.id
        ))
        void sessionBriefs
          .syncFromStatuses(session.id, session.name, statuses)
          .then((briefs) => {
            for (const brief of briefs) publishSessionBrief(brief)
          })
          .catch((error: unknown) => {
            console.error('[commando] failed to update session brief', error)
          })
      }
    }
  }

  const reportTmuxError = (error: unknown): void => {
    const message = error instanceof Error ? error.message : String(error)
    if (message !== lastTmuxError) {
      console.error(`[commando] tmux: ${message}`)
      lastTmuxError = message
    }
  }

  const paneForId = (paneId: string) =>
    snapshot.panes.find((pane) => pane.id === paneId)

  const paneExists = (paneId: string): boolean => paneForId(paneId) !== undefined

  const processStatusForPane = (pane: CommandoSnapshot['panes'][number]): AgentStatus => (
    inferAgentProcessStatus({
      paneId: pane.id,
      command: pane.command,
      title: pane.title,
      dead: pane.dead,
      capturedAt: snapshot.capturedAt,
    })
  )

  const syncRequiredSessions = (): void => {
    if (syncingRequiredSessions) {
      requiredSessionsResyncPending = true
      return
    }
    syncingRequiredSessions = true
    try {
      do {
        requiredSessionsResyncPending = false
        const sessionIds = new Set<string>()
        const observedPaneIds = new Set<string>()
        for (const client of clients) {
          if (client.socket.readyState !== WebSocket.OPEN) continue
          for (const paneId of [...client.subscribedPaneIds, ...client.statusPaneIds]) {
            const pane = paneForId(paneId)
            if (pane) {
              observedPaneIds.add(paneId)
              sessionIds.add(pane.sessionId)
            }
          }
        }
        for (const status of agentStatuses.values()) {
          const pane = paneForId(status.paneId)
          if (!pane) continue
          if (!companionObservesLiveOutput(pane.id)) continue
          observedPaneIds.add(pane.id)
          sessionIds.add(pane.sessionId)
        }
        for (const paneId of paneTextTails.keys()) {
          if (observedPaneIds.has(paneId)) continue
          paneTextTails.delete(paneId)
          if (agentStatuses.get(paneId)?.source !== 'hook') {
            const pane = paneForId(paneId)
            publishAgentStatusChange(
              pane
                ? agentStatuses.applyInferred(processStatusForPane(pane))
                : agentStatuses.remove(paneId),
            )
          }
        }
        tmux.setRequiredSessions(sessionIds)
      } while (requiredSessionsResyncPending)
    } finally {
      syncingRequiredSessions = false
    }
  }

  const scheduleCompanionPublish = (): void => {
    if (companionClientCount === 0 || companionPublishTimer) return
    companionPublishTimer = setTimeout(() => {
      companionPublishTimer = undefined
      companion?.publish()
    }, 250)
    companionPublishTimer.unref()
  }

  const observePaneData = (paneId: string, data: Buffer, changedAt: number): void => {
    let tail = paneTextTails.get(paneId)
    if (!tail) {
      tail = { decoder: new StringDecoder('utf8'), content: '', lastChangedAt: changedAt }
      paneTextTails.set(paneId, tail)
    }
    tail.content = `${tail.content}${tail.decoder.write(data)}`.slice(
      -MAX_INFERENCE_TAIL_CHARS,
    )
    tail.lastChangedAt = changedAt
  }

  const companionObservesLiveOutput = (paneId: string): boolean => {
    if (companionClientCount === 0) return false
    const pane = paneForId(paneId)
    const status = agentStatuses.get(paneId)
    return pane !== undefined &&
      status !== undefined &&
      status.status !== 'done' &&
      status.status !== 'failed' &&
      processStatusForPane(pane).provider !== 'unknown'
  }

  const scheduleCompanionOutputRefresh = (paneId: string): void => {
    if (companionOutputRefreshTimers.has(paneId)) return
    invalidateCompanionOutputRefresh(paneId)
    const generation = companionOutputGenerations.get(paneId) ?? 0
    const timer = setTimeout(() => {
      companionOutputRefreshTimers.delete(paneId)
      void (async () => {
        const pane = paneForId(paneId)
        const status = agentStatuses.get(paneId)
        const hasObservedOutput = Boolean(paneTextTails.get(paneId)?.content)
        if (!pane || !status || !hasObservedOutput || companionClientCount === 0) return
        const completedByHook = status.source === 'hook' &&
          (status.status === 'done' || status.status === 'failed')
        if (!companionObservesLiveOutput(paneId) && !completedByHook) return
        // Control-mode output contains every cursor rewrite and animation frame. Capture tmux's
        // rendered grid so the companion receives terminal state rather than the raw repaint stream.
        const rendered = await captureRenderedCompanionOutput(tmux, pane.sessionId, paneId)
        if (companionOutputGenerations.get(paneId) !== generation) return
        const currentPane = paneForId(paneId)
        const currentStatus = agentStatuses.get(paneId)
        if (!currentPane || !currentStatus || companionClientCount === 0) return
        const currentlyCompletedByHook = currentStatus.source === 'hook' &&
          (currentStatus.status === 'done' || currentStatus.status === 'failed')
        if (!companionObservesLiveOutput(paneId) && !currentlyCompletedByHook) return
        const currentProcess = inferAgentProcessStatus({
          paneId,
          command: rendered.command,
          title: currentPane.title,
          dead: currentPane.dead,
          capturedAt: Date.now(),
        })
        if (currentProcess.provider === 'unknown') return
        companionOutputTails.set(paneId, rendered.output)
        scheduleCompanionPublish()
      })().catch(reportTmuxError)
    }, 300)
    companionOutputRefreshTimers.set(paneId, timer)
    timer.unref()
  }

  const observePaneSeed = (
    paneId: string,
    capture: Buffer,
    buffered: Buffer,
    capturedAt: number,
  ): void => {
    const decoder = new StringDecoder('utf8')
    const previous = paneTextTails.get(paneId)
    paneTextTails.set(paneId, {
      decoder,
      content: `${decoder.write(capture)}${decoder.write(buffered)}`.slice(
        -MAX_INFERENCE_TAIL_CHARS,
      ),
      lastChangedAt:
        buffered.length > 0 ? (previous?.lastChangedAt ?? capturedAt) : capturedAt,
    })
  }

  const emitAgentStatus = (paneId: string, capturedAt = Date.now()): void => {
    const pane = paneForId(paneId)
    if (!pane) return
    const tail = paneTextTails.get(paneId)
    if (!tail) return
    const status = inferAgentStatus({
      paneId,
      command: pane.command,
      title: pane.title,
      content: stripAnsi(tail.content),
      dead: pane.dead,
      capturedAt,
      lastChangedAt: tail.lastChangedAt,
    })
    publishAgentStatusChange(agentStatuses.applyInferred(status))
  }

  const sendPaneData = (client: ClientState, paneId: string, data: Buffer): void => {
    for (let offset = 0; offset < data.length; offset += MAX_LIVE_MESSAGE_BYTES) {
      const chunk = data.subarray(offset, offset + MAX_LIVE_MESSAGE_BYTES)
      if (
        !send(client, {
          type: 'pane_data',
          paneId,
          data: chunk.toString('base64'),
          encoding: 'base64',
          revision: (outputRevision += 1),
        })
      ) {
        return
      }
    }
  }

  const handlePaneOutput = (sessionId: string, paneId: string, data: Buffer): void => {
    const pane = paneForId(paneId)
    if (!pane || pane.sessionId !== sessionId) return
    const subscribers = [...clients].filter((client) =>
      client.subscribedPaneIds.has(paneId),
    )
    const observed =
      subscribers.length > 0 ||
      [...clients].some((client) => client.statusPaneIds.has(paneId)) ||
      companionObservesLiveOutput(paneId)
    if (!observed) return

    const changedAt = Date.now()
    observePaneData(paneId, data, changedAt)
    emitAgentStatus(paneId, changedAt)
    if (companionObservesLiveOutput(paneId)) {
      scheduleCompanionOutputRefresh(paneId)
    }
    for (const client of subscribers) {
      const state = client.paneStreams.get(paneId)
      if (!state) continue
      if (!state.seeding) sendPaneData(client, paneId, data)
    }
  }

  const primingStatusTails = new Set<string>()

  const primeStatusTail = (paneId: string): void => {
    if (paneTextTails.has(paneId)) {
      emitAgentStatus(paneId)
      const status = agentStatuses.get(paneId)
      const completedByHook = status?.source === 'hook' &&
        (status.status === 'done' || status.status === 'failed')
      if (companionObservesLiveOutput(paneId) || completedByHook) {
        scheduleCompanionOutputRefresh(paneId)
      }
      return
    }
    if (primingStatusTails.has(paneId)) return
    const pane = paneForId(paneId)
    if (!pane) return
    const command = pane.command
    primingStatusTails.add(paneId)
    tmux
      .capturePane(pane.sessionId, paneId)
      .then((capture) => {
        const currentPane = paneForId(paneId)
        const observedByBrowser = [...clients].some((client) => (
          client.subscribedPaneIds.has(paneId) || client.statusPaneIds.has(paneId)
        ))
        const status = agentStatuses.get(paneId)
        const completedByHook = status?.source === 'hook' &&
          (status.status === 'done' || status.status === 'failed')
        if (
          !currentPane ||
          currentPane.command !== command ||
          (!observedByBrowser && !companionObservesLiveOutput(paneId) && !completedByHook)
        ) return
        const buffered = Buffer.from(paneTextTails.get(paneId)?.content ?? '')
        const normalizedCapture = normalizeCaptureLineEndings(capture)
        observePaneSeed(
          paneId,
          normalizedCapture,
          buffered,
          Date.now(),
        )
        if (companionObservesLiveOutput(paneId) || completedByHook) {
          companionOutputTails.set(paneId, normalizedCapture.toString('utf8'))
          scheduleCompanionOutputRefresh(paneId)
          scheduleCompanionPublish()
        }
        emitAgentStatus(paneId)
      })
      .catch(reportTmuxError)
      .finally(() => {
        primingStatusTails.delete(paneId)
      })
  }

  const requestPaneSeed = (client: ClientState, paneId: string): void => {
    let state = client.paneStreams.get(paneId)
    if (!state) {
      state = {
        seeding: true,
        requestedGeneration: 0,
        sourceCols: 0,
        sourceRows: 0,
        task: null,
      }
      client.paneStreams.set(paneId, state)
    }
    state.seeding = true
    state.requestedGeneration += 1
    if (state.task) return

    const stream = state
    stream.task = (async () => {
      for (;;) {
        if (
          client.socket.readyState !== WebSocket.OPEN ||
          !client.subscribedPaneIds.has(paneId) ||
          client.paneStreams.get(paneId) !== stream
        ) {
          return
        }

        const pane = paneForId(paneId)
        if (!pane) return
        const generation = stream.requestedGeneration
        let delivered = false
        let retry = false
        try {
          await tmux.capturePaneSeed(pane.sessionId, paneId, ({
            capture,
            normalCapture,
            terminalState,
          }) => {
            if (
              client.socket.readyState !== WebSocket.OPEN ||
              !client.subscribedPaneIds.has(paneId) ||
              client.paneStreams.get(paneId) !== stream
            ) {
              return
            }
            if (generation !== stream.requestedGeneration) {
              retry = true
              return
            }

            const currentPane = paneForId(paneId)
            if (!currentPane || currentPane.sessionId !== pane.sessionId) return
            const normalizedCapture = normalizeCaptureLineEndings(capture)
            const normalizedNormalCapture = normalCapture
              ? normalizeCaptureLineEndings(normalCapture)
              : undefined
            observePaneSeed(paneId, normalizedCapture, Buffer.alloc(0), Date.now())
            const seed = buildPaneSeed(
              normalizedCapture,
              terminalState,
              normalizedNormalCapture,
            )
            if (
              !send(client, {
                type: 'pane_reset',
                paneId,
                data: seed.toString('base64'),
                encoding: 'base64',
                cols: terminalState.width,
                rows: terminalState.height,
                terminalState,
                revision: (outputRevision += 1),
              })
            ) {
              return
            }

            stream.sourceCols = terminalState.width
            stream.sourceRows = terminalState.height
            stream.seeding = false
            emitAgentStatus(paneId)
            delivered = true
          })
        } catch (error) {
          if (client.subscribedPaneIds.has(paneId)) {
            sendError(
              client,
              'pane_seed_failed',
              error instanceof Error ? error.message : 'Pane seed failed',
            )
          }
          return
        }
        if (delivered) return
        if (retry) continue
        return
      }
    })().finally(() => {
      stream.task = null
    })
    void stream.task.catch((error: unknown) => reportTmuxError(error))
  }

  tmux.setControllerHandlers({
    onOutput: handlePaneOutput,
    onNotification: (sessionId, notification) => {
      const paneMode = /^%pane-mode-changed (%\d+)$/.exec(notification)
      if (paneMode) {
        for (const client of clients) {
          if (client.subscribedPaneIds.has(paneMode[1])) {
            requestPaneSeed(client, paneMode[1])
          }
        }
      }
      if (
        /^(?:%layout-change|%pane-mode-changed|%window-pane-changed|%window-add|%window-close|%session-window-changed|%sessions-changed)\b/.test(
          notification,
        )
      ) {
        if (structuralRefreshTimer) clearTimeout(structuralRefreshTimer)
        structuralRefreshTimer = setTimeout(() => {
          structuralRefreshTimer = undefined
          void refreshSnapshot().catch(reportTmuxError)
        }, 40)
        structuralRefreshTimer.unref()
      }
      void sessionId
    },
    onReady: (sessionId) => {
      for (const client of clients) {
        for (const paneId of client.subscribedPaneIds) {
          const pane = paneForId(paneId)
          const stream = client.paneStreams.get(paneId)
          if (pane?.sessionId === sessionId && !stream?.task) {
            requestPaneSeed(client, paneId)
          }
        }
      }
    },
    onError: (sessionId, error) => {
      for (const client of clients) {
        for (const paneId of client.subscribedPaneIds) {
          if (paneForId(paneId)?.sessionId === sessionId) {
            requestPaneSeed(client, paneId)
          }
        }
      }
      reportTmuxError(error)
    },
  })

  const refreshSnapshot = (): Promise<CommandoSnapshot> => {
    if (snapshotRefresh) return snapshotRefresh
    snapshotRefresh = tmux
      .discover(snapshotRevision + 1)
      .then(async (nextSnapshot) => {
        const repos = await paneRepos.resolve(nextSnapshot.panes.map((pane) => pane.path))
        for (const pane of nextSnapshot.panes) {
          const repo = repos.get(pane.path)
          if (repo) pane.repo = repo
        }
        const snapshotStateChanged = !snapshotsHaveSameState(snapshot, nextSnapshot)
        const previousRenderingState = new Map(
          snapshot.panes.map((pane) => [pane.id, paneRenderingFingerprint(pane)]),
        )
        const previousCommands = new Map(
          snapshot.panes.map((pane) => [pane.id, pane.command]),
        )
        snapshotRevision = nextSnapshot.revision
        snapshot = nextSnapshot
        lastTmuxError = ''

        const removedPaneMarks = await paneMarks.retainTargets(
          snapshot.panes.map((pane) => pane.targetId),
        )
        for (const targetId of removedPaneMarks) {
          broadcast({ type: 'pane_mark_removed', targetId })
        }

        const briefsRemoved = await sessionBriefs.removeMissingSessions(
          snapshot.sessions.map((session) => session.id),
        )
        if (briefsRemoved) {
          broadcast({ type: 'session_brief_snapshot', briefs: sessionBriefs.values() })
        }

        const paneIds = new Set(snapshot.panes.map((pane) => pane.id))
        for (const pane of snapshot.panes) {
          if (
            previousCommands.get(pane.id) !== undefined &&
            previousCommands.get(pane.id) !== pane.command
          ) {
            paneTextTails.delete(pane.id)
            if (agentStatuses.get(pane.id)?.source !== 'hook') {
              publishAgentStatusChange(agentStatuses.remove(pane.id))
            }
          }
          publishAgentStatusChange(agentStatuses.removeIfProcessChanged(pane.id, pane.command))
          if (!paneTextTails.has(pane.id)) {
            publishAgentStatusChange(agentStatuses.applyInferred(processStatusForPane(pane)))
          }
        }
        for (const change of agentStatuses.retainPaneIds(paneIds)) {
          publishAgentStatusChange(change)
        }
        for (const paneId of paneTextTails.keys()) {
          if (!paneIds.has(paneId)) paneTextTails.delete(paneId)
        }
        for (const client of clients) {
          for (const paneId of [...client.statusPaneIds]) {
            if (!paneIds.has(paneId)) {
              client.statusPaneIds.delete(paneId)
              client.lastStatus.delete(paneId)
            }
          }
          for (const paneId of [...client.subscribedPaneIds]) {
            if (!paneIds.has(paneId)) {
              client.subscribedPaneIds.delete(paneId)
              client.paneStreams.delete(paneId)
              client.paneResetGate.forget(paneId)
              client.lastStatus.delete(paneId)
              continue
            }
            const pane = paneForId(paneId)
            if (
              pane &&
              previousRenderingState.get(paneId) !== undefined &&
              (
                previousRenderingState.get(paneId) !== paneRenderingFingerprint(pane) ||
                previousCommands.get(paneId) !== pane.command
              )
            ) {
              requestPaneSeed(client, paneId)
            }
          }
        }

        syncRequiredSessions()
        if (snapshotStateChanged) {
          broadcast({ type: 'snapshot', snapshot })
          companion?.publish()
        }
        const webPanesPruned = webPanes.prune(snapshot.windows)
        // Legacy tiles and pending first-render splits resolve from the first
        // healthy snapshot that shows their anchor geometry.
        const webPaneLayoutMetadataResolved = webPanes.resolveLayoutMetadata((paneId) => {
          const pane = paneForId(paneId)
          return pane ? { cols: pane.width, rows: pane.height } : undefined
        })
        if (webPanesPruned || webPaneLayoutMetadataResolved) {
          publishWebPanes()
        }
        for (const paneId of paneIds) emitAgentStatus(paneId, snapshot.capturedAt)
        return snapshot
      })
      .finally(() => {
        snapshotRefresh = null
      })
    return snapshotRefresh
  }

  const refreshSnapshotFresh = async (): Promise<CommandoSnapshot> => {
    if (snapshotRefresh) await snapshotRefresh
    return refreshSnapshot()
  }

  const queueInput = (
    client: ClientState,
    paneId: string,
    requestId: string,
    action: () => Promise<void>,
  ): void => {
    client.inputQueue = client.inputQueue
      .then(async () => {
        if (client.socket.readyState !== WebSocket.OPEN) return
        if (!paneExists(paneId)) throw new Error('Pane no longer exists')
        await action()
      })
      .catch((error: unknown) => {
        sendError(
          client,
          'tmux_input_failed',
          error instanceof Error ? error.message : 'tmux input failed',
          requestId,
        )
      })
  }

  const sessionManagement = new SessionManagementApi({
    currentSessions: () => snapshot.sessions.map(({ id, name }) => ({ id, name })),
    currentWindowIds: () => snapshot.windows.map((window) => window.id),
    prepareSessionWorktreeDeletion: (sessionId) => prepareSessionWorktreeDeletion(sessionId, {
      currentPanes: async () => (await refreshSnapshotFresh()).panes,
      worktreeForDirectory: (directory) => gitWorktrees.worktreeForDirectory(directory),
      removeWorktree: (worktree) => gitWorktrees.removeWorktree(worktree),
    }),
    afterSessionDeleted: () => {
      void resurrectSaver.save().catch((error: unknown) => {
        console.error('[commando] tmux Resurrect save failed after session deletion', error)
      })
    },
    beforeWindowDeleted: async (windowId) => {
      await tmux.releaseWindowPaneResizes(windowId)
    },
    onSessionsChanged: async () => {
      await refreshSnapshot()
    },
  })
  const gitDiffApi = new GitDiffApi({
    panePath: (paneId) => paneForId(paneId)?.path,
    repoInfo: (directory) => gitWorktrees.probe(directory),
    panePullRequestEvidence: async (paneId) => {
      const status = agentStatuses.get(paneId)
      if (!status || status.provider === 'unknown') return undefined
      const evidence = [
        paneTextTails.get(paneId)?.content,
        status.details?.recap?.summary,
      ].filter((value): value is string => Boolean(value))
      return evidence.length > 0 ? evidence.join('\n') : undefined
    },
  })
  const paneManagement = new PaneManagementApi({
    currentPaneIds: () => snapshot.panes.map((pane) => pane.id),
    panePath: (paneId) => paneForId(paneId)?.path,
    paneTargetId: (paneId) => paneForId(paneId)?.targetId,
    screenshots: paneScreenshots,
    setPaneMark: (targetId, input) => paneMarks.set(targetId, input),
    acknowledgePaneMark: (targetId) => paneMarks.acknowledge(targetId),
    clearPaneMark: (targetId) => paneMarks.remove(targetId),
    onPaneMarkChanged: (change) => {
      if (change.type === 'upsert') publishPaneMark(change.mark)
      else broadcast({ type: 'pane_mark_removed', targetId: change.targetId })
    },
    beforePaneDeleted: async (paneId) => {
      const windowId = paneForId(paneId)?.windowId
      if (windowId) await tmux.releaseWindowPaneResizes(windowId)
    },
    onPanesChanged: async () => {
      await refreshSnapshot()
    },
  })
  const portManagement = new PortManagementApi({
    actions: tmux,
    currentSessionIds: () => snapshot.sessions.map((session) => session.id),
    currentPorts: () => snapshot.ports,
    onPortsChanged: async () => {
      await refreshSnapshot()
    },
  })
  const interactions = new AgentInteractionBroker()
  const providerUsage = new ProviderUsageService()
  companion = new CompanionHub({
    interactions,
    registry: agentStatuses,
    usage: providerUsage,
    snapshot: () => snapshot,
    outputTail: (paneId) => companionOutputTails.get(paneId),
    onClientCountChange: (count) => {
      companionClientCount = count
      if (count === 0 && companionPublishTimer) {
        clearTimeout(companionPublishTimer)
        companionPublishTimer = undefined
      }
      if (count === 0) {
        for (const timer of companionOutputRefreshTimers.values()) clearTimeout(timer)
        companionOutputRefreshTimers.clear()
        for (const [paneId, generation] of companionOutputGenerations) {
          companionOutputGenerations.set(paneId, generation + 1)
        }
        companionOutputTails.clear()
      }
      syncRequiredSessions()
      if (count > 0) {
        for (const status of agentStatuses.values()) {
          if (companionObservesLiveOutput(status.paneId)) primeStatusTail(status.paneId)
        }
      }
    },
    onStatusChange: publishAgentStatusChange,
  })
  interactions.setPendingChangeListener(() => companion?.publish())
  const agentRequestApi = new AgentRequestApi({
    interactions,
    registry: agentStatuses,
    onStatusChange: publishAgentStatusChange,
    onAnswered: () => companion?.publish(),
    paneExists,
  })
  const agentStatusHooks = new AgentStatusHookApi({
    token: agentHookToken,
    registry: agentStatuses,
    paneExists,
    paneCommand: (paneId) => paneForId(paneId)?.command,
    onChange: publishAgentStatusChange,
    interactions,
  })
  const sessionBriefApi = new SessionBriefApi({
    token: agentHookToken,
    store: sessionBriefs,
    screenshots: paneScreenshots,
    paneTarget: (paneId) => {
      const pane = paneForId(paneId)
      const session = pane && snapshot.sessions.find((candidate) => candidate.id === pane.sessionId)
      return pane && session ? { sessionId: session.id, sessionName: session.name } : null
    },
    onChange: publishSessionBrief,
  })
  const paneTargetApi = new PaneTargetApi({
    token: agentHookToken,
    paneTarget: (paneId) => {
      const pane = paneForId(paneId)
      return pane ? { targetId: pane.targetId } : null
    },
  })
  const webPanesApi = new WebPanesApi({
    service: webPanes,
    feedback: webPaneFeedback,
    pending: webPanePending,
    attachmentStore: webPaneAttachments,
    onPendingChanged: (webPaneId, notes) => webTileRelay.broadcastPending(webPaneId, notes),
    agentToken: agentHookToken,
    ownerAuthorized: (request, url) => requestIsAuthorized(request, url),
    paneForId: (paneId) => {
      const pane = paneForId(paneId)
      return pane
        ? {
            id: pane.id,
            sessionId: pane.sessionId,
            windowId: pane.windowId,
            width: pane.width,
            height: pane.height,
          }
        : undefined
    },
    agentLabel: (paneId) => {
      const status = agentStatuses.get(paneId)
      if (!status || status.provider === 'unknown') return undefined
      return status.agentSessionName
        ? `${status.provider} · ${status.agentSessionName}`
        : status.provider
    },
    onChange: () => publishWebPanes(),
    cdpInfo: (webPaneId) => {
      const pane = webPanes.get(webPaneId)
      if (!pane) return Promise.reject(new Error('Web pane does not exist'))
      chromiumEngine.updatePendingSnapshot(webPaneId, webPanePending.snapshot(webPaneId))
      return chromiumEngine.cdpInfo(webPaneId, pane.url)
    },
    onConfirmed: (pane) => {
      if (pane.engine !== 'chromium') return
      chromiumEngine.updatePendingSnapshot(pane.id, webPanePending.snapshot(pane.id))
      void chromiumEngine.navigate(pane.id, pane.url).catch((error: unknown) => {
        console.error('[commando] chromium tile navigation after confirm failed', error)
      })
    },
    onClosed: (webPaneId) => {
      chromiumEngine.clearPendingSnapshot(webPaneId)
      chromiumEngine.closeTile(webPaneId)
      webTileRelay.dropTile(webPaneId)
      // The pending journal deliberately survives: reopening the same URL
      // adopts the unsent pills back (they expire with the TTL sweep).
    },
  })
  const redlineArtifacts = new RedlineArtifactRegistry({ statePath: defaultRedlineArtifactStatePath(port) })
  const redlineApi = new RedlineApi({
    agentToken: agentHookToken,
    ownerAuthorized: (request, url) => requestIsAuthorized(request, url),
    artifacts: redlineArtifacts,
    baseUrl: `http://127.0.0.1:${port}`,
  })

  const handleClientMessage = (client: ClientState, message: ParsedClientMessage): void => {
    switch (message.type) {
      case 'subscribe': {
        const statusPaneIds = message.statusPaneIds ?? []
        if (
          message.paneIds.some((paneId) => !paneExists(paneId)) ||
          statusPaneIds.some((paneId) => !paneExists(paneId))
        ) {
          violation(client, 'invalid_pane', 'Subscription references an unknown pane')
          return
        }
        const previous = client.subscribedPaneIds
        const previouslyObserved = new Set([...previous, ...client.statusPaneIds])
        client.subscribedPaneIds = new Set(message.paneIds)
        client.statusPaneIds = new Set(
          statusPaneIds.filter((paneId) => !client.subscribedPaneIds.has(paneId)),
        )
        for (const paneId of previous) {
          if (!client.subscribedPaneIds.has(paneId)) {
            client.paneStreams.delete(paneId)
            client.paneResetGate.forget(paneId)
          }
        }
        const newlySubscribed = message.paneIds.filter(
          (paneId) => !previous.has(paneId),
        )
        for (const paneId of newlySubscribed) {
          client.paneStreams.set(paneId, {
            seeding: true,
            requestedGeneration: 0,
            sourceCols: 0,
            sourceRows: 0,
            task: null,
          })
        }
        syncRequiredSessions()
        for (const paneId of newlySubscribed) requestPaneSeed(client, paneId)
        for (const paneId of client.statusPaneIds) {
          if (!previouslyObserved.has(paneId)) primeStatusTail(paneId)
        }
        return
      }
      case 'input': {
        const cost = inputRateCost(Buffer.byteLength(message.data, 'utf8'))
        if (!client.inputLimiter.take(cost)) {
          sendError(client, 'rate_limited', 'Input rate limit exceeded', message.requestId)
          return
        }
        const pane = paneForId(message.paneId)
        if (!pane) {
          sendError(client, 'invalid_pane', 'Pane does not exist', message.requestId)
          return
        }
        queueInput(client, message.paneId, message.requestId, () =>
          tmux.sendText(pane.sessionId, message.paneId, message.data),
        )
        return
      }
      case 'input_bytes': {
        const cost = inputRateCost(message.bytes.length)
        if (!client.inputLimiter.take(cost)) {
          sendError(client, 'rate_limited', 'Input rate limit exceeded', message.requestId)
          return
        }
        const pane = paneForId(message.paneId)
        if (!pane) {
          sendError(client, 'invalid_pane', 'Pane does not exist', message.requestId)
          return
        }
        queueInput(client, message.paneId, message.requestId, () =>
          tmux.sendBytes(pane.sessionId, message.paneId, message.bytes),
        )
        return
      }
      case 'paste': {
        const pane = paneForId(message.paneId)
        if (!pane) {
          sendError(client, 'invalid_pane', 'Pane does not exist', message.requestId)
          return
        }
        queueInput(client, message.paneId, message.requestId, () =>
          tmux.pasteText(message.paneId, message.data),
        )
        return
      }
      case 'key':
        if (!client.inputLimiter.take(1)) {
          sendError(client, 'rate_limited', 'Input rate limit exceeded', message.requestId)
          return
        }
        const pane = paneForId(message.paneId)
        if (!pane) {
          sendError(client, 'invalid_pane', 'Pane does not exist', message.requestId)
          return
        }
        queueInput(client, message.paneId, message.requestId, () =>
          tmux.sendKey(pane.sessionId, message.paneId, message.key),
        )
        return
      case 'request_pane_reset': {
        const pane = paneForId(message.paneId)
        if (!pane || !client.subscribedPaneIds.has(message.paneId)) {
          sendError(
            client,
            'invalid_pane',
            'Pane reset references an unavailable pane',
            message.requestId,
          )
          return
        }
        const decision = client.paneResetGate.decide(
          message.paneId,
          Boolean(client.paneStreams.get(message.paneId)?.task),
        )
        if (decision === 'coalesce') return
        if (decision === 'rate_limited') {
          sendError(
            client,
            'rate_limited',
            'Pane reset rate limit exceeded',
            message.requestId,
          )
          return
        }
        requestPaneSeed(client, message.paneId)
        return
      }
      case 'resize_pane': {
        const pane = paneForId(message.paneId)
        if (!pane || !client.subscribedPaneIds.has(message.paneId)) {
          sendError(client, 'invalid_pane', 'Resize references an unavailable pane', message.requestId)
          return
        }
        void tmux
          .resizePane(client.id, message.paneId, message.cols, message.rows)
          .then((changed) => changed ? refreshSnapshot() : undefined)
          .catch((error: unknown) => {
            sendError(
              client,
              error instanceof TmuxResizeLeaseBusyError
                ? 'resize_window_busy'
                : 'tmux_resize_failed',
              error instanceof Error ? error.message : 'tmux resize failed',
              message.requestId,
            )
          })
        return
      }
      case 'release_resize':
        void tmux
          .releasePaneResize(client.id, message.paneId)
          .then((changed) => changed ? refreshSnapshot() : undefined)
          .catch((error: unknown) => {
            sendError(
              client,
              'tmux_resize_release_failed',
              error instanceof Error ? error.message : 'tmux resize release failed',
              message.requestId,
            )
          })
        return
      case 'apply_window_layout':
      case 'set_window_layout': {
        const window = snapshot.windows.find((candidate) => candidate.id === message.windowId)
        const specPaneIds = layoutSpecPaneIds(message.spec)
        if (
          !window ||
          window.paneIds.length !== specPaneIds.length ||
          window.paneIds.some((paneId) => !specPaneIds.includes(paneId))
        ) {
          sendError(
            client,
            'invalid_window_layout',
            'Window layout must include every current pane in the window',
            message.requestId,
          )
          return
        }
        void (message.type === 'apply_window_layout'
          ? tmux.applyWindowLayout(client.id, message.windowId, message.spec)
          : tmux.setWindowLayout(message.windowId, message.spec))
          .then((changed) => changed ? refreshSnapshot() : undefined)
          .catch((error: unknown) => {
            sendError(
              client,
              error instanceof TmuxResizeLeaseBusyError
                ? 'resize_window_busy'
                : 'tmux_layout_failed',
              error instanceof Error ? error.message : 'tmux layout failed',
              message.requestId,
            )
          })
        return
      }
      case 'release_all_resizes':
        void tmux
          .releasePaneResize(client.id)
          .then((changed) => changed ? refreshSnapshot() : undefined)
          .catch((error: unknown) => {
            sendError(
              client,
              'tmux_resize_release_failed',
              error instanceof Error ? error.message : 'tmux resize release failed',
              message.requestId,
            )
          })
        return
      case 'refresh': {
        const previousSnapshot = snapshot
        void refreshSnapshot()
          .then((currentSnapshot) => {
            if (snapshotsHaveSameState(previousSnapshot, currentSnapshot)) {
              send(client, { type: 'snapshot', snapshot: currentSnapshot })
            }
            for (const paneId of client.subscribedPaneIds) {
              requestPaneSeed(client, paneId)
            }
          })
          .catch((error: unknown) => {
            reportTmuxError(error)
            sendError(
              client,
              'refresh_failed',
              error instanceof Error ? error.message : 'Snapshot refresh failed',
              message.requestId,
            )
          })
        return
      }
      case 'load_workspace':
        void workspaces
          .load(message.sessionId)
          .then((workspace) =>
            send(client, {
              type: 'workspace',
              sessionId: message.sessionId,
              workspace,
              requestId: message.requestId,
              reason: 'load',
            }),
          )
          .catch((error: unknown) =>
            sendError(
              client,
              'workspace_load_failed',
              error instanceof Error ? error.message : 'Workspace load failed',
            ),
          )
        return
      case 'watch_interactions': {
        if (message.enabled) {
          client.releaseInteractions ??= interactions.registerConsumer()
        } else {
          client.releaseInteractions?.()
          client.releaseInteractions = null
        }
        return
      }
      case 'answer_agent_request': {
        if (!paneExists(message.paneId)) {
          sendError(client, 'invalid_pane', 'Pane does not exist', message.requestId)
          return
        }
        if (client.answeredRequestIds.has(message.requestId)) {
          send(client, {
            type: 'agent_request_answered',
            paneId: message.paneId,
            interactionId: message.interactionId,
            changed: false,
            requestId: message.requestId,
          })
          return
        }
        const outcome = answerAgentRequest(
          {
            interactions,
            registry: agentStatuses,
            onStatusChange: publishAgentStatusChange,
            onAnswered: () => companion?.publish(),
          },
          message.paneId,
          message.interactionId,
          message.answer,
        )
        if (!outcome.ok) {
          sendError(client, outcome.code, outcome.message, message.requestId)
          return
        }
        client.answeredRequestIds.remember(message.requestId)
        send(client, {
          type: 'agent_request_answered',
          paneId: message.paneId,
          interactionId: message.interactionId,
          changed: outcome.changed,
          requestId: message.requestId,
        })
        return
      }
      case 'save_workspace': {
        const canonicalWorkspace = {
          ...message.workspace,
          updatedAt: Date.now(),
        }
        const targetError = workspaceTargetError(canonicalWorkspace, snapshot)
        if (targetError) {
          sendError(client, 'invalid_workspace', targetError, message.requestId)
          return
        }
        void workspaces
          .save(canonicalWorkspace)
          .then(() =>
            send(client, {
              type: 'workspace',
              sessionId: canonicalWorkspace.sessionId,
              workspace: canonicalWorkspace,
              requestId: message.requestId,
              reason: 'save',
            }),
          )
          .catch((error: unknown) =>
            sendError(
              client,
              'workspace_save_failed',
              error instanceof Error ? error.message : 'Workspace save failed',
              message.requestId,
            ),
          )
      }
    }
  }

  const webSocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_CLIENT_MESSAGE_BYTES,
    perMessageDeflate: false,
  })
  const companionWebSocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: 64 * 1024,
    perMessageDeflate: false,
  })

  companionWebSocketServer.on('connection', (socket) => companion?.connect(socket))

  webSocketServer.on('connection', (socket) => {
    const client: ClientState = {
      id: randomUUID(),
      socket,
      subscribedPaneIds: new Set(),
      statusPaneIds: new Set(),
      paneStreams: new Map(),
      lastStatus: new Map(),
      inputLimiter: new TokenBucketRateLimiter(),
      paneResetGate: new PaneResetGate(),
      inputQueue: Promise.resolve(),
      violations: 0,
      releaseInteractions: null,
      answeredRequestIds: new IdempotencyKeyMemory(),
    }
    clients.add(client)
    send(client, { type: 'capabilities', capabilities: { revealInFinder: process.platform === 'darwin' } })
    send(client, { type: 'snapshot', snapshot })
    send(client, { type: 'web_panes', webPanes: webPanes.list(), feedback: webPaneFeedback.info() })
    send(client, { type: 'session_brief_snapshot', briefs: sessionBriefs.values() })
    send(client, { type: 'pane_mark_snapshot', marks: paneMarks.values() })
    const replayStatuses = agentStatuses.values()
    if (send(client, { type: 'agent_status_snapshot', statuses: replayStatuses })) {
      for (const status of replayStatuses) {
        client.lastStatus.set(status.paneId, statusFingerprint(status))
      }
    }

    socket.on('message', (data, isBinary) => {
      if (isBinary) {
        violation(client, 'invalid_message', 'Binary messages are not supported')
        return
      }
      const buffer = rawDataBuffer(data)
      if (buffer.byteLength > MAX_CLIENT_MESSAGE_BYTES) {
        client.socket.close(1009, 'Message too large')
        return
      }

      let value: unknown
      try {
        value = JSON.parse(buffer.toString('utf8')) as unknown
      } catch {
        violation(client, 'invalid_json', 'Message is not valid JSON')
        return
      }

      const parsed = parseClientMessage(value)
      if (!parsed.ok) {
        violation(client, 'invalid_message', parsed.error, parsed.requestId)
        return
      }
      handleClientMessage(client, parsed.message)
    })
    const removeClient = (): void => {
      if (!clients.delete(client)) return
      client.releaseInteractions?.()
      client.releaseInteractions = null
      syncRequiredSessions()
      void tmux
        .releasePaneResize(client.id)
        .then((changed) => changed ? refreshSnapshot() : undefined)
        .catch(reportTmuxError)
    }
    socket.on('close', removeClient)
    socket.on('error', removeClient)
  })

  const requestListener = (request: IncomingMessage, response: ServerResponse): void => {
    void (async () => {
      if (!networkAccess.validRequest(request)) {
        writeJson(response, 403, { error: 'Invalid host or origin' })
        return
      }

      const url = requestUrl(request)
      if (!url) {
        writeJson(response, 400, { error: 'Invalid request URL' })
        return
      }

      if (url.pathname === '/api/auth/bootstrap') {
        if (request.method !== 'GET') {
          response.writeHead(405, { Allow: 'GET' })
          response.end()
          return
        }
        writeJson(response, 200, auth?.bootstrap() ?? disabledAuthBootstrap())
        return
      }

      if (url.pathname.startsWith('/api/auth/')) {
        if (!auth) {
          writeJson(response, 404, { error: 'Email authentication is not configured' })
          return
        }
        await auth.handle(request, response)
        return
      }

      if (await agentStatusHooks.handle(request, response, url)) return
      if (await sessionBriefApi.handle(request, response, url)) return
      if (paneTargetApi.handle(request, response, url)) return
      if (await webPanesApi.handle(request, response, url)) return
      if (await redlineApi.handle(request, response, url)) return
      if (await handlePaneScreenshotImage(request, response, url, paneScreenshots)) return

      if (url.pathname === '/api/health' || url.pathname === '/api/snapshot') {
        if (request.method !== 'GET') {
          response.writeHead(405, { Allow: 'GET' })
          response.end()
          return
        }
        if (!(await requestIsAuthorized(request, url))) {
          response.setHeader('WWW-Authenticate', 'Bearer realm="commando"')
          writeJson(response, 401, { error: 'Unauthorized' })
          return
        }

        if (url.pathname === '/api/health') {
          writeJson(response, 200, {
            ok: true,
            uptimeSeconds: Math.floor(process.uptime()),
            snapshotRevision: snapshot.revision,
            capturedAt: snapshot.capturedAt,
            sessions: snapshot.sessions.length,
            clients: clients.size,
          })
          return
        }
        writeJson(response, 200, snapshot)
        return
      }

      if (url.pathname.startsWith('/api/')) {
        if (!(await requestIsAuthorized(request, url))) {
          response.setHeader('WWW-Authenticate', 'Bearer realm="commando"')
          writeJson(response, 401, { error: 'Unauthorized' })
          return
        }
        if (await handleNoteVaultsApi(request, response, url, notes)) return
        if (await handleNotesApi(request, response, url, notes)) return
        if (await handleLinearApi(request, response, url, linear)) return
        if (await handlePrsApi(request, response, url, prs, {
          panePath: (paneId) => paneForId(paneId)?.path,
          paneTargetId: (paneId) => paneForId(paneId)?.targetId,
        })) return
        if (await handlePaneScreenshotApi(request, response, url, paneScreenshots)) return
        if (await sessionManagement.handle(request, response, url)) return
        if (await paneManagement.handle(request, response, url)) return
        if (await agentRequestApi.handle(request, response, url)) return
        if (await portManagement.handle(request, response, url)) return
        if (await gitDiffApi.handle(request, response, url)) return
        if (await handleTmuxCreateApi(
          request,
          response,
          url,
          tmuxCreator,
          async (targetId) => {
            const windowId = targetId.startsWith('@') ? targetId : paneForId(targetId)?.windowId
            if (windowId) await tmux.releaseWindowPaneResizes(windowId)
          },
          async () => {
            await refreshSnapshot()
          },
        )) return
        writeJson(response, 404, { error: 'Not found' })
        return
      }

      if (url.pathname === '/ws') {
        writeJson(response, 404, { error: 'Not found' })
        return
      }

      if (process.env.NODE_ENV === 'production') {
        await serveProductionAsset(request, response, url)
        return
      }
      writeJson(response, 404, { error: 'Not found' })
    })().catch((error: unknown) => {
      console.error('[commando] HTTP request failed', error)
      if (!response.headersSent) writeJson(response, 500, { error: 'Internal error' })
      else response.destroy()
    })
  }

  const httpServers = networkAccess.listeners.map((listener) => {
    const server = createServer(requestListener)
    server.on('upgrade', (request, socket, head) => {
      void (async () => {
        if (!networkAccess.validRequest(request)) {
          rejectUpgrade(socket, 403, 'Forbidden')
          return
        }
        const url = requestUrl(request)
        const webTileId = url ? webTilePathId(url.pathname) : null
        if (!url || (url.pathname !== '/ws' && url.pathname !== '/companion/ws' && !webTileId)) {
          rejectUpgrade(socket, 404, 'Not Found')
          return
        }
        if (webTileId) {
          if (!(await requestIsAuthorized(request, url))) {
            rejectUpgrade(socket, 401, 'Unauthorized')
            return
          }
          webTileRelay.handleUpgrade(request, socket, head, webTileId)
          return
        }
        if (url.pathname === '/companion/ws') {
          if (!isLoopbackAddress(request.socket.remoteAddress)) {
            rejectUpgrade(socket, 403, 'Forbidden')
            return
          }
          if (!requestHasValidToken(request, url, companionTokenDigest)) {
            rejectUpgrade(socket, 401, 'Unauthorized')
            return
          }
          companionWebSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
            companionWebSocketServer.emit('connection', webSocket, request)
          })
          return
        }
        if (!(await requestIsAuthorized(request, url))) {
          rejectUpgrade(socket, 401, 'Unauthorized')
          return
        }
        webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
          webSocketServer.emit('connection', webSocket, request)
        })
      })().catch((error: unknown) => {
        console.error('[commando] WebSocket upgrade failed', error)
        rejectUpgrade(socket, 500, 'Internal Server Error')
      })
    })
    return { listener, server }
  })

  await refreshSnapshot().catch(reportTmuxError)

  await Promise.all(httpServers.map(({ listener, server }) => new Promise<void>((resolveListen, rejectListen) => {
    const onError = (error: Error): void => rejectListen(error)
    server.once('error', onError)
    server.listen(port, listener, () => {
      server.off('error', onError)
      resolveListen()
    })
  })))

  const snapshotTimer = setInterval(() => {
    void refreshSnapshot().catch(reportTmuxError)
  }, SNAPSHOT_INTERVAL_MS)
  resurrectSaver.start()

  const encodedToken = encodeURIComponent(token)
  console.log(`[commando] development: http://127.0.0.1:${DEVELOPMENT_WEB_PORT}/${auth ? '' : `#token=${encodedToken}`}`)
  for (const { listener } of httpServers) {
    const host = listener.includes(':') ? `[${listener}]` : listener
    console.log(`[commando] browser:     http://${host}:${port}/${auth ? '' : `#token=${encodedToken}`}`)
  }
  if (auth) {
    console.log(`[commando] owner auth:  ${ownerEmail}`)
    console.log(`[commando] token URL:   http://127.0.0.1:${port}/#token=${encodedToken}`)
  }

  let shuttingDown = false
  const shutdown = (): void => {
    if (shuttingDown) return
    shuttingDown = true
    clearInterval(snapshotTimer)
    resurrectSaver.stop()
    if (structuralRefreshTimer) clearTimeout(structuralRefreshTimer)
    for (const client of clients) client.socket.terminate()
    companion?.close()
    webTileRelay.close()
    chromiumEngine.dispose()
    void tmux.releaseAllPaneResizes().finally(() => {
      tmux.close()
      webSocketServer.close()
      companionWebSocketServer.close()
      void Promise.all(httpServers.map(({ server }) => new Promise<void>((resolveClose) => {
        server.close(() => resolveClose())
      }))).finally(() => auth?.close())
    })
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
}

void main().catch((error: unknown) => {
  console.error('[commando] startup failed', error)
  process.exitCode = 1
})
