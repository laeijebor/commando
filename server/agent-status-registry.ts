import type {
  AgentProvider,
  AgentStatus,
  AgentStatusKind,
} from '../shared/protocol.js'

export type AgentStatusChange =
  | { type: 'upsert'; status: AgentStatus }
  | { type: 'remove'; paneId: string }
  | null

type RegistryRecord = {
  status: AgentStatus
  providerSessionId: string | null
  pendingPermissionIds: Set<string>
  pendingQuestionIds: Set<string>
}

type OpenCodeEvent = {
  type: string
  properties: Record<string, unknown>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringProperty(
  value: Record<string, unknown>,
  property: string,
): string | null {
  const candidate = value[property]
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : null
}

function parseOpenCodeEvent(value: unknown): OpenCodeEvent | null {
  if (!isRecord(value) || typeof value.type !== 'string' || !isRecord(value.properties)) {
    return null
  }
  return { type: value.type, properties: value.properties }
}

function openCodeSessionId(properties: Record<string, unknown>): string | null {
  const direct = stringProperty(properties, 'sessionID')
  if (direct) return direct

  const info = properties.info
  return isRecord(info) ? stringProperty(info, 'id') : null
}

function sameStatus(left: AgentStatus, right: AgentStatus): boolean {
  return left.paneId === right.paneId &&
    left.provider === right.provider &&
    left.status === right.status &&
    left.summary === right.summary &&
    left.source === right.source &&
    left.confidence === right.confidence &&
    left.reason === right.reason
}

function hookStatus(
  paneId: string,
  provider: Exclude<AgentProvider, 'unknown'>,
  status: AgentStatusKind,
  updatedAt: number,
): AgentStatus {
  const name = provider === 'claude' ? 'Claude' : 'OpenCode'
  const descriptions: Record<AgentStatusKind, { summary: string; reason: string }> = {
    working: {
      summary: `${name} is working`,
      reason: `${name} hook reports active work`,
    },
    needs_input: {
      summary: `${name} needs input`,
      reason: `${name} hook reports a pending user response`,
    },
    done: {
      summary: `${name} is idle`,
      reason: `${name} hook reports completion or idle`,
    },
    failed: {
      summary: `${name} failed`,
      reason: `${name} hook reports a failure`,
    },
    stale: {
      summary: `${name} status is stale`,
      reason: `${name} hook status has expired`,
    },
    unknown: {
      summary: `${name} session started`,
      reason: `${name} has not reported an activity state yet`,
    },
  }

  return {
    paneId,
    provider,
    status,
    ...descriptions[status],
    source: 'hook',
    confidence: status === 'unknown' ? 'low' : 'high',
    updatedAt,
  }
}

export class AgentStatusRegistry {
  private readonly records = new Map<string, RegistryRecord>()
  private readonly inferenceSuppressedPaneIds = new Set<string>()

  get(paneId: string): AgentStatus | undefined {
    const status = this.records.get(paneId)?.status
    return status ? { ...status } : undefined
  }

  values(): AgentStatus[] {
    return [...this.records.values()].map(({ status }) => ({ ...status }))
  }

  remove(paneId: string): AgentStatusChange {
    if (!this.records.delete(paneId)) return null
    return { type: 'remove', paneId }
  }

  retainPaneIds(paneIds: Iterable<string>): Exclude<AgentStatusChange, null>[] {
    const retained = new Set(paneIds)
    const changes: Exclude<AgentStatusChange, null>[] = []
    for (const paneId of this.records.keys()) {
      if (retained.has(paneId)) continue
      this.records.delete(paneId)
      changes.push({ type: 'remove', paneId })
    }
    for (const paneId of this.inferenceSuppressedPaneIds) {
      if (!retained.has(paneId)) this.inferenceSuppressedPaneIds.delete(paneId)
    }
    return changes
  }

  applyInferred(status: AgentStatus): AgentStatusChange {
    if (this.inferenceSuppressedPaneIds.has(status.paneId)) return null
    const previous = this.records.get(status.paneId)
    if (previous?.status.source === 'hook') return null

    if (status.provider === 'unknown' && status.status === 'unknown') {
      return previous ? this.remove(status.paneId) : null
    }

    return this.upsert({
      status: { ...status },
      providerSessionId: null,
      pendingPermissionIds: new Set(),
      pendingQuestionIds: new Set(),
    })
  }

  applyClaudeHook(
    paneId: string,
    payload: unknown,
    updatedAt = Date.now(),
  ): AgentStatusChange {
    if (!isRecord(payload)) return null
    const eventName = stringProperty(payload, 'hook_event_name')
    const sessionId = stringProperty(payload, 'session_id')
    if (!eventName || !sessionId) return null

    if (eventName === 'SessionEnd') {
      return this.removeProviderSession(paneId, 'claude', sessionId)
    }
    this.inferenceSuppressedPaneIds.delete(paneId)

    let status: AgentStatusKind | null = null
    if (eventName === 'SessionStart') status = 'unknown'
    else if (eventName === 'UserPromptSubmit') status = 'working'
    else if (eventName === 'PreToolUse') {
      const toolName = stringProperty(payload, 'tool_name')
      status = toolName === 'AskUserQuestion' || toolName === 'PermissionRequest'
        ? 'needs_input'
        : 'working'
    } else if (eventName === 'Notification') {
      const notificationType = stringProperty(payload, 'notification_type')
      if (
        notificationType === 'permission_prompt' ||
        notificationType === 'elicitation_dialog' ||
        notificationType === 'agent_needs_input'
      ) status = 'needs_input'
      else if (notificationType === 'idle_prompt') status = 'done'
    } else if (eventName === 'Stop') status = 'done'
    else if (eventName === 'StopFailure') status = 'failed'

    if (!status) return null
    return this.upsert({
      status: hookStatus(paneId, 'claude', status, updatedAt),
      providerSessionId: sessionId,
      pendingPermissionIds: new Set(),
      pendingQuestionIds: new Set(),
    })
  }

  applyOpenCodeEvent(
    paneId: string,
    value: unknown,
    updatedAt = Date.now(),
  ): AgentStatusChange {
    const event = parseOpenCodeEvent(value)
    if (!event) return null
    const sessionId = openCodeSessionId(event.properties)
    if (!sessionId) return null

    if (event.type === 'session.deleted') {
      return this.removeProviderSession(paneId, 'opencode', sessionId)
    }
    this.inferenceSuppressedPaneIds.delete(paneId)

    const previous = this.records.get(paneId)
    const sameSession = previous?.status.provider === 'opencode' &&
      previous.providerSessionId === sessionId
    const pendingPermissionIds = sameSession
      ? new Set(previous.pendingPermissionIds)
      : new Set<string>()
    const pendingQuestionIds = sameSession
      ? new Set(previous.pendingQuestionIds)
      : new Set<string>()

    let status: AgentStatusKind | null = null
    if (event.type === 'session.status') {
      const statusInfo = event.properties.status
      if (!isRecord(statusInfo)) return null
      if (statusInfo.type === 'busy' || statusInfo.type === 'retry') status = 'working'
      else if (statusInfo.type === 'idle') status = 'done'
      else return null
    } else if (event.type === 'session.idle') {
      status = 'done'
    } else if (event.type === 'permission.asked') {
      const requestId = stringProperty(event.properties, 'id')
      if (!requestId) return null
      pendingPermissionIds.add(requestId)
      status = 'needs_input'
    } else if (event.type === 'question.asked') {
      const requestId = stringProperty(event.properties, 'id')
      if (!requestId) return null
      pendingQuestionIds.add(requestId)
      status = 'needs_input'
    } else if (
      event.type === 'permission.replied' ||
      event.type === 'question.replied'
    ) {
      if (previous?.status.source === 'hook' && !sameSession) return null
      const requestId = stringProperty(event.properties, 'requestID')
      if (!requestId) return null
      if (event.type === 'permission.replied') pendingPermissionIds.delete(requestId)
      else pendingQuestionIds.delete(requestId)
      status = pendingPermissionIds.size > 0 || pendingQuestionIds.size > 0
        ? 'needs_input'
        : 'working'
    } else if (event.type === 'session.error') {
      status = 'failed'
    }

    if (!status) return null
    if (status === 'done' && sameSession && previous.status.status === 'failed') {
      return this.upsert({
        status: { ...previous.status, updatedAt },
        providerSessionId: sessionId,
        pendingPermissionIds,
        pendingQuestionIds,
      })
    }

    return this.upsert({
      status: hookStatus(paneId, 'opencode', status, updatedAt),
      providerSessionId: sessionId,
      pendingPermissionIds,
      pendingQuestionIds,
    })
  }

  private removeProviderSession(
    paneId: string,
    provider: Exclude<AgentProvider, 'unknown'>,
    sessionId: string,
  ): AgentStatusChange {
    const record = this.records.get(paneId)
    if (
      record?.status.provider !== provider ||
      record.providerSessionId !== sessionId
    ) return null
    this.records.delete(paneId)
    this.inferenceSuppressedPaneIds.add(paneId)
    return { type: 'remove', paneId }
  }

  private upsert(record: RegistryRecord): AgentStatusChange {
    const previous = this.records.get(record.status.paneId)
    this.records.set(record.status.paneId, record)
    return previous && sameStatus(previous.status, record.status)
      ? null
      : { type: 'upsert', status: { ...record.status } }
  }
}
