import type {
  AgentInteractionRequest,
  AgentProvider,
  AgentStatus,
  AgentStatusKind,
} from '../shared/protocol.js'
import type { AgentStatusChange } from './agent-status-registry.js'
import type { ExpoPushMessage, ExpoPushOutcome, ExpoPushSender } from './expo-push.js'
import type { PushDevice, PushDeviceRegistry, PushQuietHours } from './push-devices.js'

const DEFAULT_DEBOUNCE_MS = 1_000
const MAX_DEDUPE_KEYS = 500
const ANDROID_CHANNEL_ID = 'agent-events'
const MAX_BODY_LENGTH = 300

export type PushNotificationKind = 'needs_input' | 'done' | 'failed'

export type PushPaneContext = {
  sessionId: string
  sessionName: string
}

export type PushNotificationData = {
  paneId: string
  sessionId: string
  sessionName: string
  provider: AgentProvider
  kind: PushNotificationKind
  requestId?: string
  requestKind?: AgentInteractionRequest['kind']
  interactionId?: string
}

export type PushNotification = {
  kind: PushNotificationKind
  categoryId: 'needs_input' | 'permission' | 'done' | 'failed'
  title: string
  body: string
  data: PushNotificationData
  dedupeKey: string
}

export type PushNotifierOptions = {
  registry: Pick<PushDeviceRegistry, 'list'>
  sender: Pick<ExpoPushSender, 'send'>
  /** Resolves the tmux session a pane belongs to, as the snapshot sees it. */
  paneContext: (paneId: string) => PushPaneContext | null
  now?: () => number
  debounceMs?: number
  logger?: Pick<Console, 'warn'>
}

export function providerLabel(provider: AgentProvider): string {
  if (provider === 'claude') return 'Claude'
  if (provider === 'codex') return 'Codex'
  if (provider === 'opencode') return 'OpenCode'
  return 'Agent'
}

function clockMinutes(value: string): number {
  const [hours, minutes] = value.split(':')
  return Number(hours) * 60 + Number(minutes)
}

/** Minutes since local midnight for a timestamp in the given IANA time zone. */
export function localMinutes(timeZone: string, timestamp: number): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(timestamp))
  const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? '0')
  const minute = Number(parts.find((part) => part.type === 'minute')?.value ?? '0')
  return hour * 60 + minute
}

/** Quiet-hour windows may cross midnight; an empty window never silences. */
export function isWithinQuietHours(quietHours: PushQuietHours, timestamp: number): boolean {
  const start = clockMinutes(quietHours.start)
  const end = clockMinutes(quietHours.end)
  if (start === end) return false
  let current: number
  try {
    current = localMinutes(quietHours.timeZone, timestamp)
  } catch {
    return false
  }
  return start < end
    ? current >= start && current < end
    : current >= start || current < end
}

export function deviceAcceptsNotification(
  device: PushDevice,
  notification: PushNotification,
  timestamp: number,
): boolean {
  const { rules } = device
  const enabled = notification.kind === 'needs_input'
    ? rules.needsInput
    : notification.kind === 'done'
      ? rules.done
      : rules.failed
  if (!enabled) return false
  if (rules.mutedSessions.includes(notification.data.sessionName)) return false
  if (rules.quietHours && isWithinQuietHours(rules.quietHours, timestamp)) return false
  return true
}

function trim(value: string | undefined, fallback: string): string {
  const text = (value ?? '').trim()
  const chosen = text.length ? text : fallback
  return chosen.length > MAX_BODY_LENGTH ? `${chosen.slice(0, MAX_BODY_LENGTH - 1)}…` : chosen
}

function newestRequest(requests: readonly AgentInteractionRequest[]): AgentInteractionRequest | null {
  return requests.reduce<AgentInteractionRequest | null>((newest, request) => (
    !newest || request.createdAt >= newest.createdAt ? request : newest
  ), null)
}

function requestBody(request: AgentInteractionRequest): string {
  if (request.kind === 'question') {
    return trim(request.questions?.[0]?.question, request.prompt)
  }
  const prompt = trim(request.prompt, 'A permission is waiting for you')
  return request.toolName ? trim(`${request.toolName} · ${prompt}`, prompt) : prompt
}

/**
 * Turns an agent status into the notification it deserves, or null when the
 * status is not a notifiable transition.
 */
export function buildNotification(
  status: AgentStatus,
  previous: AgentStatusKind | undefined,
  context: PushPaneContext,
): PushNotification | null {
  const base = {
    paneId: status.paneId,
    sessionId: context.sessionId,
    sessionName: context.sessionName,
    provider: status.provider,
  }
  const label = providerLabel(status.provider)
  if (status.status === 'needs_input') {
    const request = newestRequest(status.details?.requests ?? [])
    if (!request) return null
    return {
      kind: 'needs_input',
      categoryId: request.kind === 'permission' ? 'permission' : 'needs_input',
      title: `${label} needs input · ${context.sessionName}`,
      body: requestBody(request),
      data: {
        ...base,
        kind: 'needs_input',
        requestId: request.id,
        requestKind: request.kind,
        interactionId: request.id,
      },
      dedupeKey: `needs_input:${status.paneId}:${request.id}`,
    }
  }
  if (status.status === 'done') {
    if (previous === 'done') return null
    const completedAt = status.details?.recap?.completedAt ?? status.updatedAt
    return {
      kind: 'done',
      categoryId: 'done',
      title: `${label} finished · ${context.sessionName}`,
      body: trim(status.details?.recap?.summary, trim(status.summary, 'Work finished')),
      data: { ...base, kind: 'done' },
      dedupeKey: `done:${status.paneId}:${completedAt}`,
    }
  }
  if (status.status === 'failed') {
    if (previous === 'failed') return null
    const completedAt = status.details?.recap?.completedAt ?? status.updatedAt
    return {
      kind: 'failed',
      categoryId: 'failed',
      title: `${label} failed · ${context.sessionName}`,
      body: trim(
        status.details?.attention ?? status.details?.recap?.summary,
        trim(status.summary, 'The agent stopped with an error'),
      ),
      data: { ...base, kind: 'failed' },
      dedupeKey: `failed:${status.paneId}:${completedAt}`,
    }
  }
  return null
}

function toMessage(device: PushDevice, notification: PushNotification): ExpoPushMessage {
  return {
    to: device.expoPushToken,
    title: notification.title,
    body: notification.body,
    data: { ...notification.data },
    categoryId: notification.categoryId,
    ...(device.platform === 'android' ? { channelId: ANDROID_CHANNEL_ID } : {}),
  }
}

/**
 * Watches agent status changes and pushes the ones the owner asked for.
 * Bursts on the same pane are coalesced to the latest status, every
 * notification is sent at most once, and each device's rules decide whether it
 * hears about it at all.
 */
export class PushNotifier {
  private readonly lastKind = new Map<string, AgentStatusKind>()
  private readonly sentKeys = new Set<string>()
  private readonly pending = new Map<string, { status: AgentStatus; timer: NodeJS.Timeout }>()
  private readonly debounceMs: number
  private readonly now: () => number
  private readonly logger: Pick<Console, 'warn'>
  private sends: Promise<void> = Promise.resolve()

  constructor(private readonly options: PushNotifierOptions) {
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS
    this.now = options.now ?? Date.now
    this.logger = options.logger ?? console
  }

  handleStatusChange(change: AgentStatusChange): void {
    if (!change) return
    if (change.type === 'remove') {
      this.lastKind.delete(change.paneId)
      const pending = this.pending.get(change.paneId)
      if (pending) {
        clearTimeout(pending.timer)
        this.pending.delete(change.paneId)
      }
      return
    }
    const paneId = change.status.paneId
    const existing = this.pending.get(paneId)
    if (existing) clearTimeout(existing.timer)
    const timer = setTimeout(() => {
      this.pending.delete(paneId)
      this.dispatch(change.status)
    }, this.debounceMs)
    timer.unref?.()
    this.pending.set(paneId, { status: change.status, timer })
  }

  /** Sends a single notification to one device, bypassing its rules. */
  async sendTest(device: PushDevice): Promise<ExpoPushOutcome> {
    return this.options.sender.send([{
      to: device.expoPushToken,
      title: 'Commando',
      body: `Push notifications are working on ${device.name}.`,
      data: { kind: 'test', deviceId: device.id },
      categoryId: 'test',
      ...(device.platform === 'android' ? { channelId: ANDROID_CHANNEL_ID } : {}),
    }])
  }

  /** Delivers every debounced status immediately and waits for the sends. */
  async flush(): Promise<void> {
    for (const [paneId, entry] of [...this.pending]) {
      clearTimeout(entry.timer)
      this.pending.delete(paneId)
      this.dispatch(entry.status)
    }
    await this.sends
  }

  close(): void {
    for (const entry of this.pending.values()) clearTimeout(entry.timer)
    this.pending.clear()
    this.lastKind.clear()
  }

  private dispatch(status: AgentStatus): void {
    const previous = this.lastKind.get(status.paneId)
    this.lastKind.set(status.paneId, status.status)
    const context = this.options.paneContext(status.paneId)
    if (!context) return
    const notification = buildNotification(status, previous, context)
    if (!notification || this.sentKeys.has(notification.dedupeKey)) return
    const timestamp = this.now()
    const messages = this.options.registry
      .list()
      .filter((device) => deviceAcceptsNotification(device, notification, timestamp))
      .map((device) => toMessage(device, notification))
    this.rememberKey(notification.dedupeKey)
    if (!messages.length) return
    this.sends = this.sends
      .then(() => this.options.sender.send(messages))
      .then(() => undefined)
      .catch((error: unknown) => {
        this.logger.warn('[commando] failed to send a push notification', error)
      })
  }

  private rememberKey(key: string): void {
    this.sentKeys.add(key)
    if (this.sentKeys.size <= MAX_DEDUPE_KEYS) return
    const oldest = this.sentKeys.values().next().value
    if (oldest !== undefined) this.sentKeys.delete(oldest)
  }
}
