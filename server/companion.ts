import { WebSocket } from 'ws'

import type {
  AgentInteractionAnswer,
  AgentProvider,
  AgentStatus,
  AgentStatusKind,
  CommandoSnapshot,
  CompanionClientMessage,
  CompanionServerMessage,
  CompanionSession,
  CompanionSnapshot,
  ProviderUsage,
} from '../shared/protocol.js'
import type { AgentInteractionBroker } from './agent-interaction-broker.js'
import type { AgentStatusChange, AgentStatusRegistry } from './agent-status-registry.js'
import type { ProviderUsageService } from './provider-usage.js'
import { companionOutputTail } from './terminal-text.js'

const MAX_BUFFERED_BYTES = 256 * 1024
const MAX_IDEMPOTENCY_KEYS = 500

type CompanionHubOptions = {
  interactions: AgentInteractionBroker
  registry: AgentStatusRegistry
  usage: ProviderUsageService
  snapshot: () => CommandoSnapshot
  outputTail: (paneId: string) => string | undefined
  onClientCountChange: (count: number) => void
  onStatusChange: (change: AgentStatusChange) => void
}

const STATUS_PRIORITY: Record<AgentStatusKind, number> = {
  needs_input: 0,
  failed: 1,
  working: 2,
  done: 3,
  stale: 4,
  unknown: 5,
}

function providerName(provider: AgentProvider): string {
  if (provider === 'claude') return 'Claude'
  if (provider === 'codex') return 'Codex'
  if (provider === 'opencode') return 'OpenCode'
  return 'Agent'
}

function shortSessionId(value: string): string {
  return value.replace(/[^A-Za-z0-9]/g, '').slice(-6) || value.slice(-6)
}

function fallbackAgentSessionName(
  status: AgentStatus,
  paneIndex: number | undefined,
): string {
  const suffix = status.agentSessionId
    ? shortSessionId(status.agentSessionId)
    : `pane ${paneIndex ?? '?'}`
  return `${providerName(status.provider)} · ${suffix}`
}

function cloneUsage(usage: readonly ProviderUsage[]): ProviderUsage[] {
  return usage.map((provider) => ({
    ...provider,
    windows: provider.windows.map((window) => ({ ...window })),
  }))
}

export function buildCompanionSnapshot(
  snapshot: CommandoSnapshot,
  statuses: readonly AgentStatus[],
  usage: readonly ProviderUsage[],
  outputTail: (paneId: string) => string | undefined = () => undefined,
  requestPending: (paneId: string, requestId: string) => boolean = () => true,
): CompanionSnapshot {
  const panes = new Map(snapshot.panes.map((pane) => [pane.id, pane]))
  const windows = new Map(snapshot.windows.map((window) => [window.id, window]))
  const statusesBySession = new Map<string, AgentStatus[]>()
  for (const status of statuses) {
    const pane = panes.get(status.paneId)
    if (!pane) continue
    const sessionStatuses = statusesBySession.get(pane.sessionId) ?? []
    sessionStatuses.push(status)
    statusesBySession.set(pane.sessionId, sessionStatuses)
  }

  const sessions = snapshot.sessions.flatMap<CompanionSession>((session) => {
    const sessionStatuses = statusesBySession.get(session.id) ?? []
    if (!sessionStatuses.length) {
      return [{
        id: session.id,
        tmuxSessionId: session.id,
        tmuxSessionName: session.name,
        agentSessionName: 'No agent detected',
        provider: 'unknown',
        status: 'unknown',
        summary: session.attached ? 'Tmux session attached' : 'Tmux session idle',
        requests: [],
        updatedAt: snapshot.capturedAt,
      }]
    }
    return sessionStatuses.map((status) => {
      const pane = panes.get(status.paneId)
      const details = status.details
      const lastOutput = pane ? companionOutputTail(outputTail(pane.id)) : undefined
      return {
        id: `${session.id}:${status.paneId}`,
        tmuxSessionId: session.id,
        tmuxSessionName: session.name,
        ...(status.agentSessionId ? { agentSessionId: status.agentSessionId } : {}),
        agentSessionName: status.agentSessionName ?? fallbackAgentSessionName(status, pane?.index),
        provider: status.provider,
        status: status.status,
        summary: status.summary,
        ...(lastOutput ? { lastOutput } : {}),
        ...(details?.intent ? { intent: details.intent } : {}),
        ...(details?.currentActivity ? { activity: { ...details.currentActivity } } : {}),
        requests: pane
          ? details?.requests?.filter((request) => requestPending(pane.id, request.id)).map((request) => ({
              ...request,
              questions: request.questions?.map((question) => ({
                ...question,
                options: question.options.map((option) => ({ ...option })),
              })),
            })) ?? []
          : [],
        ...(pane ? {
          windowName: windows.get(pane.windowId)?.name,
          paneId: pane.id,
          paneIndex: pane.index,
        } : {}),
        updatedAt: status.updatedAt,
      }
    })
  })
  sessions.sort((left, right) => (
    STATUS_PRIORITY[left.status] - STATUS_PRIORITY[right.status] ||
    right.updatedAt - left.updatedAt ||
    left.tmuxSessionName.localeCompare(right.tmuxSessionName)
  ))
  return {
    revision: snapshot.revision,
    capturedAt: snapshot.capturedAt,
    sessions,
    usage: cloneUsage(usage),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseAnswer(value: unknown): AgentInteractionAnswer | null {
  if (!isRecord(value)) return null
  const action = value.action
  if (
    action !== 'allow_once' &&
    action !== 'allow_always' &&
    action !== 'deny' &&
    action !== 'answer' &&
    action !== 'reject'
  ) return null
  if (value.answers !== undefined) {
    if (
      !Array.isArray(value.answers) ||
      value.answers.length > 8 ||
      !value.answers.every((answer) => (
        Array.isArray(answer) &&
        answer.length <= 12 &&
        answer.every((item) => typeof item === 'string' && item.length > 0 && item.length <= 300)
      ))
    ) return null
    return { action, answers: value.answers as string[][] }
  }
  return { action }
}

export function parseCompanionMessage(value: unknown): CompanionClientMessage | null {
  if (!isRecord(value) || typeof value.type !== 'string') return null
  if (value.type === 'focus_output') {
    if (value.paneId === undefined || value.paneId === null) return { type: 'focus_output' }
    return typeof value.paneId === 'string' && /^%\d+$/.test(value.paneId)
      ? { type: 'focus_output', paneId: value.paneId }
      : null
  }
  if (value.type === 'refresh_usage') {
    return typeof value.requestId === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value.requestId)
      ? { type: 'refresh_usage', requestId: value.requestId }
      : null
  }
  if (value.type !== 'answer_agent_request') return null
  const answer = parseAnswer(value.answer)
  if (
    typeof value.paneId !== 'string' || !/^%\d+$/.test(value.paneId) ||
    typeof value.requestId !== 'string' || value.requestId.length > 200 ||
    typeof value.requestIdempotencyKey !== 'string' ||
    !/^[A-Za-z0-9._:-]{1,128}$/.test(value.requestIdempotencyKey) ||
    !answer
  ) return null
  return {
    type: 'answer_agent_request',
    paneId: value.paneId,
    requestId: value.requestId,
    answer,
    requestIdempotencyKey: value.requestIdempotencyKey,
  }
}

export class CompanionHub {
  private readonly clients = new Set<WebSocket>()
  private readonly idempotencyKeys = new Set<string>()
  private readonly focusedPaneIds = new Map<WebSocket, string>()

  constructor(private readonly options: CompanionHubOptions) {}

  connect(socket: WebSocket): void {
    this.clients.add(socket)
    this.options.interactions.setConsumerCount(this.clients.size)
    this.options.onClientCountChange(this.clients.size)
    if (this.clients.size === 1) {
      this.options.usage.start(() => this.publish())
    }
    this.sendSnapshot(socket)

    socket.on('message', (data, isBinary) => {
      if (isBinary) {
        this.sendError(socket, 'invalid_message', 'Binary messages are not supported')
        return
      }
      let value: unknown
      try {
        value = JSON.parse(data.toString()) as unknown
      } catch {
        this.sendError(socket, 'invalid_json', 'Message is not valid JSON')
        return
      }
      const message = parseCompanionMessage(value)
      if (!message) {
        this.sendError(socket, 'invalid_message', 'Unsupported companion message')
        return
      }
      if (message.type === 'focus_output') {
        if (message.paneId && !this.options.registry.get(message.paneId)) {
          this.sendError(socket, 'invalid_pane', 'Focused output references an unavailable agent pane')
          return
        }
        if (message.paneId) this.focusedPaneIds.set(socket, message.paneId)
        else this.focusedPaneIds.delete(socket)
        this.sendSnapshot(socket)
        return
      }
      if (message.type === 'refresh_usage') {
        void this.options.usage.refresh().catch(() => {
          this.sendError(socket, 'usage_refresh_failed', 'Unable to refresh usage', message.requestId)
        })
        return
      }
      if (this.idempotencyKeys.has(message.requestIdempotencyKey)) {
        this.sendSnapshot(socket)
        return
      }
      if (!this.options.interactions.answer(message.paneId, message.requestId, message.answer)) {
        this.sendError(
          socket,
          'request_unavailable',
          'The agent request is no longer pending',
          message.requestIdempotencyKey,
        )
        this.sendSnapshot(socket)
        return
      }
      this.rememberIdempotencyKey(message.requestIdempotencyKey)
      this.options.onStatusChange(this.options.registry.resolveInteractionRequest(
        message.paneId,
        message.requestId,
      ))
      this.publish()
    })

    const disconnect = (): void => {
      if (!this.clients.delete(socket)) return
      this.focusedPaneIds.delete(socket)
      this.options.interactions.setConsumerCount(this.clients.size)
      this.options.onClientCountChange(this.clients.size)
      if (this.clients.size === 0) this.options.usage.stop()
    }
    socket.on('close', disconnect)
    socket.on('error', disconnect)
  }

  publish(): void {
    for (const client of this.clients) this.sendSnapshot(client)
  }

  close(): void {
    for (const client of this.clients) client.terminate()
    this.clients.clear()
    this.focusedPaneIds.clear()
    this.options.interactions.setConsumerCount(0)
    this.options.onClientCountChange(0)
    this.options.usage.stop()
  }

  private sendSnapshot(socket: WebSocket): void {
    const focusedPaneId = this.focusedPaneIds.get(socket)
    this.send(socket, {
      type: 'companion_snapshot',
      snapshot: buildCompanionSnapshot(
        this.options.snapshot(),
        this.options.registry.values(),
        this.options.usage.values(),
        (paneId) => paneId === focusedPaneId
          ? this.options.outputTail(paneId)
          : undefined,
        (paneId, requestId) => this.options.interactions.hasPending(paneId, requestId),
      ),
    })
  }

  private sendError(
    socket: WebSocket,
    code: string,
    message: string,
    requestId?: string,
  ): void {
    this.send(socket, { type: 'companion_error', code, message, requestId })
  }

  private send(socket: WebSocket, message: CompanionServerMessage): void {
    if (socket.readyState !== WebSocket.OPEN) return
    const serialized = JSON.stringify(message)
    if (socket.bufferedAmount + Buffer.byteLength(serialized) > MAX_BUFFERED_BYTES) {
      socket.close(1013, 'Companion is not consuming updates')
      return
    }
    socket.send(serialized)
  }

  private rememberIdempotencyKey(key: string): void {
    this.idempotencyKeys.add(key)
    if (this.idempotencyKeys.size <= MAX_IDEMPOTENCY_KEYS) return
    const oldest = this.idempotencyKeys.values().next().value
    if (oldest !== undefined) this.idempotencyKeys.delete(oldest)
  }
}
