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
  processCommand: string | null
  pendingPermissionIds: Set<string>
  pendingQuestionIds: Set<string>
}

type InferenceSuppression = {
  provider: AgentProvider
  processCommand: string | null
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
  private readonly inferenceSuppressions = new Map<string, InferenceSuppression>()

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
    for (const paneId of this.inferenceSuppressions.keys()) {
      if (!retained.has(paneId)) this.inferenceSuppressions.delete(paneId)
    }
    return changes
  }

  applyInferred(status: AgentStatus): AgentStatusChange {
    const suppression = this.inferenceSuppressions.get(status.paneId)
    if (status.provider === suppression?.provider) return null
    if (status.provider !== 'unknown') this.inferenceSuppressions.delete(status.paneId)
    const previous = this.records.get(status.paneId)
    if (previous?.status.source === 'hook') return null

    if (status.provider === 'unknown' && status.status === 'unknown') {
      return previous ? this.remove(status.paneId) : null
    }

    return this.upsert({
      status: { ...status },
      providerSessionId: null,
      processCommand: null,
      pendingPermissionIds: new Set(),
      pendingQuestionIds: new Set(),
    })
  }

  applyClaudeHook(
    paneId: string,
    payload: unknown,
    updatedAt = Date.now(),
    processCommand: string | null = null,
  ): AgentStatusChange {
    if (!isRecord(payload)) return null
    const eventName = stringProperty(payload, 'hook_event_name')
    const sessionId = stringProperty(payload, 'session_id')
    if (!eventName || !sessionId) return null

    if (eventName === 'SessionEnd') {
      return this.removeProviderSession(paneId, 'claude', sessionId)
    }
    if (!this.acceptHookProcess(paneId, 'claude', processCommand)) return null

    let status: AgentStatusKind | null = null
    if (eventName === 'SessionStart') status = 'unknown'
    else if (eventName === 'UserPromptSubmit') status = 'working'
    else if (eventName === 'PermissionRequest') status = 'needs_input'
    else if (
      eventName === 'PostToolUse' ||
      eventName === 'PostToolUseFailure' ||
      eventName === 'PermissionDenied' ||
      eventName === 'ElicitationResult'
    ) status = 'working'
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
      else if (
        notificationType === 'elicitation_complete' ||
        notificationType === 'elicitation_response'
      ) status = 'working'
    } else if (eventName === 'Stop') status = 'done'
    else if (eventName === 'StopFailure') status = 'failed'

    if (!status) return null
    const previous = this.records.get(paneId)
    const sameSession = previous?.status.provider === 'claude' &&
      previous.providerSessionId === sessionId
    return this.upsert({
      status: hookStatus(paneId, 'claude', status, updatedAt),
      providerSessionId: sessionId,
      processCommand: status === 'unknown'
        ? null
        : sameSession ? (previous?.processCommand ?? processCommand) : processCommand,
      pendingPermissionIds: new Set(),
      pendingQuestionIds: new Set(),
    })
  }

  applyOpenCodeEvent(
    paneId: string,
    value: unknown,
    updatedAt = Date.now(),
    processCommand: string | null = null,
  ): AgentStatusChange {
    const event = parseOpenCodeEvent(value)
    if (!event) return null
    const sessionId = openCodeSessionId(event.properties)
    if (!sessionId) return null

    if (event.type === 'session.deleted') {
      return this.removeProviderSession(paneId, 'opencode', sessionId)
    }
    if (!this.acceptHookProcess(paneId, 'opencode', processCommand)) return null

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
      event.type === 'question.replied' ||
      event.type === 'question.rejected'
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
        processCommand: previous.processCommand,
        pendingPermissionIds,
        pendingQuestionIds,
      })
    }

    return this.upsert({
      status: hookStatus(paneId, 'opencode', status, updatedAt),
      providerSessionId: sessionId,
      processCommand: sameSession ? (previous?.processCommand ?? processCommand) : processCommand,
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
    this.inferenceSuppressions.set(paneId, {
      provider,
      processCommand: record.processCommand,
    })
    return { type: 'remove', paneId }
  }

  removeIfProcessChanged(paneId: string, processCommand: string): AgentStatusChange {
    const record = this.records.get(paneId)
    if (
      record?.status.source !== 'hook' ||
      record.processCommand === null ||
      record.processCommand === processCommand
    ) return null
    this.records.delete(paneId)
    this.inferenceSuppressions.set(paneId, {
      provider: record.status.provider,
      processCommand: record.processCommand,
    })
    return { type: 'remove', paneId }
  }

  private acceptHookProcess(
    paneId: string,
    provider: Exclude<AgentProvider, 'unknown'>,
    processCommand: string | null,
  ): boolean {
    const suppression = this.inferenceSuppressions.get(paneId)
    if (
      suppression?.provider === provider &&
      suppression.processCommand !== null &&
      suppression.processCommand !== processCommand
    ) return false
    this.inferenceSuppressions.delete(paneId)
    return true
  }

  private upsert(record: RegistryRecord): AgentStatusChange {
    const previous = this.records.get(record.status.paneId)
    if (previous && sameStatus(previous.status, record.status)) {
      this.records.set(record.status.paneId, { ...record, status: previous.status })
      return null
    }
    this.records.set(record.status.paneId, record)
    return { type: 'upsert', status: { ...record.status } }
  }
}
