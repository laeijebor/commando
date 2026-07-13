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
  ClientMessage,
  CommandoSnapshot,
  SavedWorkspace,
  ServerMessage,
} from '../shared/protocol.js'
import { inferAgentStatus } from './agent-status.js'
import {
  MAX_CLIENT_MESSAGE_BYTES,
  parseClientMessage,
} from './client-messages.js'
import { TmuxClient } from './tmux.js'
import { normalizeCaptureLineEndings } from './tmux-control.js'
import { buildPaneSeed } from './terminal-seed.js'
import { WorkspaceStore } from './workspaces.js'
import { LinearService } from './linear.js'
import { handleLinearApi } from './linear-api.js'
import { NoteStore } from './notes.js'
import { handleNotesApi } from './notes-api.js'
import { SessionManagementApi } from './session-management-api.js'
import { PaneManagementApi } from './pane-management-api.js'
import { TmuxCreator } from './tmux-create.js'
import { handleTmuxCreateApi } from './tmux-create-api.js'
import { TmuxResizeLeaseBusyError } from './tmux-resize-lease.js'
import {
  configuredAuthDatabasePath,
  configuredAuthSecret,
  configuredOwnerEmail,
  createAuthService,
  disabledAuthBootstrap,
} from './auth.js'
import { createNetworkAccess } from './network-access.js'

const DEFAULT_PORT = 4310
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
  "img-src 'self' data:",
  "object-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
].join('; ')

type ClientState = {
  id: string
  socket: WebSocket
  subscribedPaneIds: Set<string>
  paneStreams: Map<string, PaneStreamState>
  lastStatus: Map<string, string>
  inputLimiter: RateLimiter
  inputQueue: Promise<void>
  violations: number
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

class RateLimiter {
  private tokens = 80
  private lastRefill = Date.now()

  take(cost: number): boolean {
    const now = Date.now()
    const elapsed = Math.max(0, now - this.lastRefill)
    this.tokens = Math.min(80, this.tokens + (elapsed / 1_000) * 40)
    this.lastRefill = now
    if (this.tokens < cost) return false
    this.tokens -= cost
    return true
  }
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
  ].join('\u001f')
}

function stripAnsi(value: string): string {
  return value
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001bP.*?\u001b\\/gs, '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b[@-_]/g, '')
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
  const tmux = new TmuxClient()
  const workspaces = new WorkspaceStore()
  const notes = new NoteStore()
  const linear = new LinearService()
  const tmuxCreator = new TmuxCreator()
  const clients = new Set<ClientState>()
  const paneTextTails = new Map<string, PaneTextTail>()
  let snapshot: CommandoSnapshot = {
    revision: 0,
    capturedAt: Date.now(),
    sessions: [],
    windows: [],
    panes: [],
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

  const syncRequiredSessions = (): void => {
    const sessionIds = new Set<string>()
    const subscribedPaneIds = new Set<string>()
    for (const client of clients) {
      if (client.socket.readyState !== WebSocket.OPEN) continue
      for (const paneId of client.subscribedPaneIds) {
        const pane = paneForId(paneId)
        if (pane) {
          subscribedPaneIds.add(paneId)
          sessionIds.add(pane.sessionId)
        }
      }
    }
    for (const paneId of paneTextTails.keys()) {
      if (!subscribedPaneIds.has(paneId)) paneTextTails.delete(paneId)
    }
    tmux.setRequiredSessions(sessionIds)
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
    const status = inferAgentStatus({
      paneId,
      command: pane.command,
      title: pane.title,
      content: stripAnsi(tail?.content ?? ''),
      dead: pane.dead,
      capturedAt,
      lastChangedAt: tail?.lastChangedAt ?? capturedAt,
    })
    const fingerprint = statusFingerprint(status)
    for (const client of clients) {
      if (!client.subscribedPaneIds.has(paneId)) continue
      if (client.lastStatus.get(paneId) === fingerprint) continue
      if (send(client, { type: 'agent_status', status })) {
        client.lastStatus.set(paneId, fingerprint)
      }
    }
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
    if (subscribers.length === 0) return

    const changedAt = Date.now()
    observePaneData(paneId, data, changedAt)
    for (const client of subscribers) {
      const state = client.paneStreams.get(paneId)
      if (!state) continue
      if (!state.seeding) sendPaneData(client, paneId, data)
    }
    emitAgentStatus(paneId, changedAt)
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
      .then((nextSnapshot) => {
        const previousRenderingState = new Map(
          snapshot.panes.map((pane) => [pane.id, paneRenderingFingerprint(pane)]),
        )
        snapshotRevision = nextSnapshot.revision
        snapshot = nextSnapshot
        lastTmuxError = ''

        const paneIds = new Set(snapshot.panes.map((pane) => pane.id))
        for (const paneId of paneTextTails.keys()) {
          if (!paneIds.has(paneId)) paneTextTails.delete(paneId)
        }
        for (const client of clients) {
          for (const paneId of [...client.subscribedPaneIds]) {
            if (!paneIds.has(paneId)) {
              client.subscribedPaneIds.delete(paneId)
              client.paneStreams.delete(paneId)
              client.lastStatus.delete(paneId)
              continue
            }
            const pane = paneForId(paneId)
            if (
              pane &&
              previousRenderingState.get(paneId) !== undefined &&
              previousRenderingState.get(paneId) !== paneRenderingFingerprint(pane)
            ) {
              requestPaneSeed(client, paneId)
            }
          }
        }

        syncRequiredSessions()
        broadcast({ type: 'snapshot', snapshot })
        for (const paneId of paneIds) emitAgentStatus(paneId, snapshot.capturedAt)
        return snapshot
      })
      .finally(() => {
        snapshotRefresh = null
      })
    return snapshotRefresh
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
    currentSessionIds: () => snapshot.sessions.map((session) => session.id),
    onSessionsChanged: async () => {
      await refreshSnapshot()
    },
  })
  const paneManagement = new PaneManagementApi({
    currentPaneIds: () => snapshot.panes.map((pane) => pane.id),
    beforePaneDeleted: async (paneId) => {
      const windowId = paneForId(paneId)?.windowId
      if (windowId) await tmux.releaseWindowPaneResizes(windowId)
    },
    onPanesChanged: async () => {
      await refreshSnapshot()
    },
  })

  const handleClientMessage = (client: ClientState, message: ClientMessage): void => {
    switch (message.type) {
      case 'subscribe': {
        if (message.paneIds.some((paneId) => !paneExists(paneId))) {
          violation(client, 'invalid_pane', 'Subscription references an unknown pane')
          return
        }
        const previous = client.subscribedPaneIds
        client.subscribedPaneIds = new Set(message.paneIds)
        for (const paneId of previous) {
          if (!client.subscribedPaneIds.has(paneId)) {
            client.paneStreams.delete(paneId)
            client.lastStatus.delete(paneId)
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
        return
      }
      case 'input': {
        const cost = 1 + Math.ceil(Buffer.byteLength(message.data, 'utf8') / 256)
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
      case 'apply_window_layout': {
        const window = snapshot.windows.find((candidate) => candidate.id === message.windowId)
        if (
          !window ||
          window.paneIds.length !== message.paneIds.length ||
          window.paneIds.some((paneId) => !message.paneIds.includes(paneId))
        ) {
          sendError(
            client,
            'invalid_window_layout',
            'Authoritative layout must include every current pane in the window',
            message.requestId,
          )
          return
        }
        void tmux
          .applyWindowLayout(
            client.id,
            message.windowId,
            message.paneIds,
            message.preset,
            message.stacked,
            message.capacities,
          )
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
      case 'refresh':
        void refreshSnapshot()
          .then(() => {
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

  webSocketServer.on('connection', (socket) => {
    const client: ClientState = {
      id: randomUUID(),
      socket,
      subscribedPaneIds: new Set(),
      paneStreams: new Map(),
      lastStatus: new Map(),
      inputLimiter: new RateLimiter(),
      inputQueue: Promise.resolve(),
      violations: 0,
    }
    clients.add(client)
    send(client, { type: 'snapshot', snapshot })

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
        if (await handleNotesApi(request, response, url, notes)) return
        if (await handleLinearApi(request, response, url, linear)) return
        if (await sessionManagement.handle(request, response, url)) return
        if (await paneManagement.handle(request, response, url)) return
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
        if (!url || url.pathname !== '/ws') {
          rejectUpgrade(socket, 404, 'Not Found')
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

  const encodedToken = encodeURIComponent(token)
  console.log(`[commando] development: http://127.0.0.1:5173/${auth ? '' : `#token=${encodedToken}`}`)
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
    if (structuralRefreshTimer) clearTimeout(structuralRefreshTimer)
    for (const client of clients) client.socket.terminate()
    void tmux.releaseAllPaneResizes().finally(() => {
      tmux.close()
      webSocketServer.close()
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
