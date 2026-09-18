import type { AgentInteractionAnswer } from '@commando/protocol'

/**
 * The payload `server/push-notifier.ts` puts on every notification. It has no
 * host id — the daemon does not know which of the phone's hosts it is — so the
 * host is resolved from the registrations the app holds.
 */
export type PushNotificationData = {
  paneId: string
  sessionId?: string
  sessionName?: string
  provider?: string
  kind: 'needs_input' | 'done' | 'failed'
  requestId?: string
  requestKind?: 'permission' | 'question'
  interactionId?: string
}

export const PUSH_CATEGORIES = {
  needsInput: 'needs_input',
  permission: 'permission',
  done: 'done',
  failed: 'failed',
} as const

export const PUSH_ACTIONS = {
  answer: 'answer',
  openPane: 'open_pane',
  allowOnce: 'allow_once',
  deny: 'deny',
} as const

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** A push payload is untrusted JSON; anything without a pane id is ignored. */
export function parseNotificationData(raw: unknown): PushNotificationData | null {
  if (typeof raw !== 'object' || raw === null) return null
  const record = raw as Record<string, unknown>
  const paneId = optionalString(record.paneId)
  if (!paneId) return null
  const kind = record.kind
  const requestKind = record.requestKind
  return {
    paneId,
    kind: kind === 'done' || kind === 'failed' ? kind : 'needs_input',
    ...(optionalString(record.sessionId) ? { sessionId: String(record.sessionId) } : {}),
    ...(optionalString(record.sessionName) ? { sessionName: String(record.sessionName) } : {}),
    ...(optionalString(record.provider) ? { provider: String(record.provider) } : {}),
    ...(optionalString(record.requestId) ? { requestId: String(record.requestId) } : {}),
    ...(requestKind === 'permission' || requestKind === 'question' ? { requestKind } : {}),
    ...(optionalString(record.interactionId) ? { interactionId: String(record.interactionId) } : {}),
  }
}

export type NotificationRoute =
  | {
      pathname: '/(host)/[hostId]/answer/[paneId]/[interactionId]'
      params: { hostId: string; paneId: string; interactionId: string; from: 'notification' }
    }
  | { pathname: '/(host)/[hostId]/pane/[paneId]'; params: { hostId: string; paneId: string } }
  | { pathname: '/(host)/[hostId]/sessions'; params: { hostId: string } }

/**
 * Where a tapped notification lands: the answer screen when something is
 * actually pending, the pane otherwise. "Open pane" forces the pane even for a
 * pending request.
 */
export function notificationRoute(
  data: PushNotificationData,
  hostId: string | undefined,
  actionIdentifier?: string,
): NotificationRoute | null {
  if (!hostId) return null
  if (!data.paneId) return { pathname: '/(host)/[hostId]/sessions', params: { hostId } }
  const wantsPane = actionIdentifier === PUSH_ACTIONS.openPane
  if (!wantsPane && data.kind === 'needs_input' && data.interactionId) {
    return {
      pathname: '/(host)/[hostId]/answer/[paneId]/[interactionId]',
      params: {
        hostId,
        paneId: data.paneId,
        interactionId: data.interactionId,
        from: 'notification',
      },
    }
  }
  return { pathname: '/(host)/[hostId]/pane/[paneId]', params: { hostId, paneId: data.paneId } }
}

/**
 * The permission category's two background actions answer the request without
 * opening the app; every other action just navigates.
 */
export function answerForAction(actionIdentifier: string): AgentInteractionAnswer | null {
  if (actionIdentifier === PUSH_ACTIONS.allowOnce) return { action: 'allow_once' }
  if (actionIdentifier === PUSH_ACTIONS.deny) return { action: 'deny' }
  return null
}

export function actionOpensApp(actionIdentifier: string): boolean {
  return answerForAction(actionIdentifier) === null
}

export type HostResolution = {
  /** Hosts this install registered a push device with, newest first. */
  registeredHostIds: readonly string[]
  /** Hosts whose snapshot currently holds the notification's pane. */
  hostIdsWithPane?: readonly string[]
  /** The host the app is looking at, used as the last resort. */
  currentHostId?: string
}

/**
 * The daemon's payload carries no host id, so the notification is attributed to
 * the registered host that has the pane; failing that the only registered host,
 * and failing that the host the app is already on.
 */
export function resolveNotificationHostId(resolution: HostResolution): string | undefined {
  const registered = resolution.registeredHostIds
  const withPane = (resolution.hostIdsWithPane ?? []).filter((hostId) => registered.includes(hostId))
  if (withPane.length === 1) return withPane[0]
  if (withPane.length > 1) {
    return resolution.currentHostId && withPane.includes(resolution.currentHostId)
      ? resolution.currentHostId
      : withPane[0]
  }
  if (registered.length === 1) return registered[0]
  if (resolution.currentHostId && registered.includes(resolution.currentHostId)) {
    return resolution.currentHostId
  }
  return registered[0] ?? resolution.currentHostId
}
