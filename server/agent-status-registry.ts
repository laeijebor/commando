import type {
  AgentActivity,
  AgentActivityKind,
  AgentCheck,
  AgentDetails,
  AgentProvider,
  AgentRecap,
  AgentStatus,
  AgentStatusKind,
} from '../shared/protocol.js'

export type AgentStatusChange =
  | { type: 'upsert'; status: AgentStatus }
  | { type: 'remove'; paneId: string }
  | null

type TaskState = {
  subject: string
  state: 'created' | 'completed'
}

type PendingRequest = {
  attention: string
}

type RegistryRecord = {
  status: AgentStatus
  providerSessionId: string | null
  processCommand: string | null
  pendingRequests: Map<string, PendingRequest>
  runningActivities: Map<string, AgentActivity>
  runningChecks: Map<string, AgentCheck>
  changedFiles: Set<string>
  tasks: Map<string, TaskState>
  turnId: string | null
  retainedCompletion: boolean
}

type InferenceSuppression = {
  provider: AgentProvider
  processCommand: string | null
}

type OpenCodeEvent = {
  type: string
  properties: Record<string, unknown>
}

const MAX_INTENT_LENGTH = 240
const MAX_ACTIVITY_LABEL_LENGTH = 240
const MAX_RECENT_ACTIVITIES = 3
const MAX_RUNNING_ACTIVITIES = 20
const MAX_TASK_ID_LENGTH = 120
const MAX_TASK_SUBJECT_LENGTH = 240
const MAX_TASKS = 100
const MAX_TODOS = 20
const MAX_PENDING_REQUESTS = 100
const MAX_FILE_PATH_LENGTH = 240
const MAX_CHANGED_FILES = 20
const MAX_CHANGE_TOTAL = 1_000_000_000
const MAX_CHECK_LABEL_LENGTH = 120
const MAX_CHECKS = 4
const MAX_ATTENTION_LENGTH = 200
const MAX_FINAL_MESSAGE_LENGTH = 2_000
const MAX_RECAP_SUMMARY_LENGTH = 180

const activityKinds = new Set<AgentActivityKind>([
  'inspect',
  'edit',
  'command',
  'check',
  'delegate',
  'task',
  'other',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function boundedText(value: unknown, maximum: number): string | null {
  if (typeof value !== 'string') return null
  const text = value
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return text ? text.slice(0, maximum) : null
}

function stringProperty(
  value: Record<string, unknown>,
  property: string,
  maximum = 200,
): string | null {
  return boundedText(value[property], maximum)
}

function parseOpenCodeEvent(value: unknown): OpenCodeEvent | null {
  if (!isRecord(value) || typeof value.type !== 'string' || !isRecord(value.properties)) {
    return null
  }
  const type = boundedText(value.type, 100)
  return type ? { type, properties: value.properties } : null
}

function openCodeSessionId(properties: Record<string, unknown>): string | null {
  const direct = stringProperty(properties, 'sessionID')
  if (direct) return direct

  const info = properties.info
  return isRecord(info) ? stringProperty(info, 'id') : null
}

function emptyDetails(intent?: string | null): AgentDetails {
  const details: AgentDetails = {
    recentActivities: [],
    checks: [],
  }
  if (intent) details.intent = intent
  return details
}

function cloneDetails(details: AgentDetails): AgentDetails {
  const clone: AgentDetails = {
    recentActivities: details.recentActivities.map((activity) => ({ ...activity })),
    checks: details.checks.map((check) => ({ ...check })),
  }
  if (details.intent !== undefined) clone.intent = details.intent
  if (details.currentActivity) clone.currentActivity = { ...details.currentActivity }
  if (details.progress) clone.progress = { ...details.progress }
  if (details.changes) clone.changes = { ...details.changes }
  if (details.attention !== undefined) clone.attention = details.attention
  if (details.recap) clone.recap = { ...details.recap }
  return clone
}

function cloneStatus(status: AgentStatus): AgentStatus {
  const clone = { ...status }
  if (status.details) clone.details = cloneDetails(status.details)
  return clone
}

function statusWithoutDetails(status: AgentStatus): AgentStatus {
  const clone = { ...status }
  delete clone.details
  return clone
}

function sameStatus(left: AgentStatus, right: AgentStatus): boolean {
  return left.paneId === right.paneId &&
    left.provider === right.provider &&
    left.status === right.status &&
    left.summary === right.summary &&
    left.source === right.source &&
    left.confidence === right.confidence &&
    left.reason === right.reason &&
    JSON.stringify(left.details) === JSON.stringify(right.details)
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

function attachDetails(status: AgentStatus, details: AgentDetails): AgentStatus {
  const summary = status.status === 'needs_input' && details.attention
    ? boundedText(`${status.provider === 'claude' ? 'Claude' : 'OpenCode'} needs input: ${details.attention}`, MAX_ACTIVITY_LABEL_LENGTH)
    : (status.status === 'needs_input' || status.status === 'done' || status.status === 'failed') && details.recap
      ? details.recap.summary
      : status.status === 'working' && details.currentActivity
        ? details.currentActivity.label
        : status.status === 'working' && details.intent
          ? details.intent
          : null
  return {
    ...status,
    summary: summary ?? status.summary,
    details,
  }
}

function parseActivity(
  value: unknown,
  updatedAt: number,
  state: AgentActivity['state'],
): AgentActivity | null {
  if (!isRecord(value)) return null
  const label = boundedText(value.label, MAX_ACTIVITY_LABEL_LENGTH)
  const kind = value.kind
  const payloadState = value.state
  if (
    !label ||
    typeof kind !== 'string' ||
    !activityKinds.has(kind as AgentActivityKind) ||
    (payloadState !== 'running' && payloadState !== 'completed' && payloadState !== 'failed')
  ) {
    return null
  }
  return {
    label,
    kind: kind as AgentActivityKind,
    state,
    updatedAt,
  }
}

function startActivity(
  details: AgentDetails,
  runningActivities: Map<string, AgentActivity>,
  value: unknown,
  activityIdValue: unknown,
  updatedAt: number,
): boolean {
  const activity = parseActivity(value, updatedAt, 'running')
  if (!activity) return false
  const activityId = boundedText(activityIdValue, 200) ?? '__legacy__'
  if (!runningActivities.has(activityId) && runningActivities.size >= MAX_RUNNING_ACTIVITIES) {
    const oldestActivityId = runningActivities.keys().next().value
    if (oldestActivityId !== undefined) runningActivities.delete(oldestActivityId)
  }
  runningActivities.delete(activityId)
  runningActivities.set(activityId, activity)
  details.currentActivity = { ...activity }
  return true
}

function completeActivity(
  details: AgentDetails,
  runningActivities: Map<string, AgentActivity>,
  value: unknown,
  activityIdValue: unknown,
  updatedAt: number,
  failed: boolean,
): 'completed' | 'failed' | null {
  const payloadState = isRecord(value) ? value.state : null
  const state = failed || payloadState === 'failed' ? 'failed' : 'completed'
  const activityId = boundedText(activityIdValue, 200) ?? '__legacy__'
  const runningActivity = runningActivities.get(activityId)
  const activity = parseActivity(value, updatedAt, state) ?? (runningActivity
    ? { ...runningActivity, state, updatedAt }
    : null)
  runningActivities.delete(activityId)
  const nextCurrent = [...runningActivities.values()].at(-1)
  if (nextCurrent) details.currentActivity = { ...nextCurrent }
  else delete details.currentActivity
  if (!activity) return null
  details.recentActivities = [activity, ...details.recentActivities]
    .slice(0, MAX_RECENT_ACTIVITIES)
  return state
}

function updateCheck(
  details: AgentDetails,
  runningChecks: Map<string, AgentCheck>,
  value: unknown,
  activityIdValue: unknown,
  updatedAt: number,
): void {
  if (!isRecord(value)) return
  const label = boundedText(value.label, MAX_CHECK_LABEL_LENGTH)
  const status = value.status
  if (
    !label ||
    (status !== 'running' && status !== 'passed' && status !== 'failed')
  ) return
  const check: AgentCheck = { label, status, updatedAt }
  const checkId = boundedText(activityIdValue, 200) ?? `__legacy__:${label}`
  if (status === 'running') {
    if (!runningChecks.has(checkId) && runningChecks.size >= MAX_RUNNING_ACTIVITIES) {
      const oldestCheckId = runningChecks.keys().next().value
      if (oldestCheckId !== undefined) runningChecks.delete(oldestCheckId)
    }
    runningChecks.delete(checkId)
    runningChecks.set(checkId, check)
  } else {
    runningChecks.delete(checkId)
  }
  const displayedCheck = status === 'running'
    ? check
    : [...runningChecks.values()].reverse().find((candidate) => candidate.label === label) ?? check
  details.checks = [
    displayedCheck,
    ...details.checks.filter((candidate) => candidate.label !== label),
  ].slice(0, MAX_CHECKS)
}

function clearRunningChecks(
  details: AgentDetails,
  runningChecks: Map<string, AgentCheck>,
): void {
  runningChecks.clear()
  details.checks = details.checks.filter((check) => check.status !== 'running')
}

function addChangedFile(
  details: AgentDetails,
  changedFiles: Set<string>,
  value: unknown,
): void {
  const filePath = boundedText(value, MAX_FILE_PATH_LENGTH)
  if (!filePath) return
  if (changedFiles.size < MAX_CHANGED_FILES) changedFiles.add(filePath)
  const changes = details.changes ?? { fileCount: 0, additions: 0, deletions: 0 }
  changes.fileCount = changedFiles.size
  details.changes = changes
}

function boundedCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  return Math.min(MAX_CHANGE_TOTAL, Math.max(0, Math.trunc(value)))
}

function updateDiff(
  details: AgentDetails,
  changedFiles: Set<string>,
  value: unknown,
): void {
  if (!Array.isArray(value)) return
  let additions = 0
  let deletions = 0
  for (const candidate of value.slice(0, MAX_CHANGED_FILES)) {
    if (!isRecord(candidate)) continue
    const filePath = boundedText(candidate.file, MAX_FILE_PATH_LENGTH)
    if (filePath && changedFiles.size < MAX_CHANGED_FILES) changedFiles.add(filePath)
    additions = Math.min(MAX_CHANGE_TOTAL, additions + boundedCount(candidate.additions))
    deletions = Math.min(MAX_CHANGE_TOTAL, deletions + boundedCount(candidate.deletions))
  }
  details.changes = { fileCount: changedFiles.size, additions, deletions }
}

function updateProgress(tasks: Map<string, TaskState>, details: AgentDetails): void {
  let completed = 0
  let active: string | undefined
  for (const task of tasks.values()) {
    if (task.state === 'completed') completed += 1
    else active = task.subject
  }
  details.progress = { completed, total: tasks.size }
  if (active) details.progress.active = active
}

function updateClaudeTask(
  tasks: Map<string, TaskState>,
  details: AgentDetails,
  value: unknown,
): void {
  if (!isRecord(value)) return
  const id = boundedText(value.id, MAX_TASK_ID_LENGTH)
  const subject = boundedText(value.subject, MAX_TASK_SUBJECT_LENGTH)
  const state = value.state
  if (!id || !subject || (state !== 'created' && state !== 'completed')) return
  if (!tasks.has(id) && tasks.size >= MAX_TASKS) {
    const oldestTaskId = tasks.keys().next().value
    if (oldestTaskId !== undefined) tasks.delete(oldestTaskId)
  }
  tasks.delete(id)
  tasks.set(id, { subject, state })
  updateProgress(tasks, details)
}

function updateTodos(
  tasks: Map<string, TaskState>,
  details: AgentDetails,
  value: unknown,
): void {
  if (!Array.isArray(value)) return
  tasks.clear()
  let active: string | undefined
  let completed = 0
  for (const [index, candidate] of value.slice(0, MAX_TODOS).entries()) {
    if (!isRecord(candidate)) continue
    const subject = boundedText(candidate.content, MAX_TASK_SUBJECT_LENGTH)
    const status = boundedText(candidate.status, 40)
    boundedText(candidate.priority, 40)
    if (!subject || !status) continue
    if (status === 'cancelled' || status === 'canceled') continue
    const state = status === 'completed' ? 'completed' : 'created'
    tasks.set(String(index), { subject, state })
    if (state === 'completed') completed += 1
    if (status === 'in_progress' && active === undefined) active = subject
  }
  details.progress = { completed, total: tasks.size }
  if (active) details.progress.active = active
}

function attentionFallback(provider: Exclude<AgentProvider, 'unknown'>): string {
  return provider === 'claude' ? 'Claude needs input' : 'OpenCode needs input'
}

function setAttention(
  details: AgentDetails,
  value: unknown,
  provider: Exclude<AgentProvider, 'unknown'>,
): string {
  const attention = boundedText(value, MAX_ATTENTION_LENGTH) ?? attentionFallback(provider)
  details.attention = attention
  return attention
}

function syncAttention(
  details: AgentDetails,
  pendingRequests: Map<string, PendingRequest>,
): void {
  const latest = [...pendingRequests.values()].at(-1)
  if (latest) details.attention = latest.attention
  else delete details.attention
}

function addPendingRequest(
  requests: Map<string, PendingRequest>,
  kind: 'permission' | 'question',
  requestId: string,
  attention: string,
): void {
  const key = `${kind}:${requestId}`
  if (!requests.has(key) && requests.size >= MAX_PENDING_REQUESTS) {
    const oldestRequestId = requests.keys().next().value
    if (oldestRequestId !== undefined) requests.delete(oldestRequestId)
  }
  requests.delete(key)
  requests.set(key, { attention })
}

function messageLines(value: unknown): string[] {
  if (typeof value !== 'string') return []
  return value.slice(0, MAX_FINAL_MESSAGE_LENGTH)
    .split(/\r?\n/)
    .map((line) => boundedText(line, MAX_RECAP_SUMMARY_LENGTH))
    .filter((line): line is string => line !== null)
}

function explicitRecap(lines: string[]): Pick<AgentRecap, 'outcome' | 'summary'> | null {
  const line = lines.at(-1)
  if (!line) return null
  const match = /^(\u{1F7E2}|\u{1F7E1}|\u{1F534})\s*(.*)$/u.exec(line)
  if (!match) return null
  const outcomes: Record<string, AgentRecap['outcome']> = {
    '\u{1F7E2}': 'done',
    '\u{1F7E1}': 'follow_up',
    '\u{1F534}': 'blocked',
  }
  const summary = boundedText(match[2], MAX_RECAP_SUMMARY_LENGTH)
  const outcome = outcomes[match[1]]
  return summary && outcome ? { outcome, summary } : null
}

function recapFallback(
  provider: Exclude<AgentProvider, 'unknown'>,
  outcome: AgentRecap['outcome'],
): string {
  const name = provider === 'claude' ? 'Claude' : 'OpenCode'
  if (outcome === 'failed') return `${name} stopped with an error`
  if (outcome === 'blocked') return `${name} is waiting for input`
  if (outcome === 'follow_up') return `${name} has follow-up work`
  return `${name} completed the turn`
}

function createRecap(
  provider: Exclude<AgentProvider, 'unknown'>,
  status: AgentStatusKind,
  details: AgentDetails,
  pending: boolean,
  finalMessage: unknown,
  backgroundTasks: unknown,
  error: unknown,
  completedAt: number,
): AgentRecap {
  const lines = messageLines(finalMessage)
  const explicit = explicitRecap(lines)
  const errorText = boundedText(error, MAX_RECAP_SUMMARY_LENGTH)
  const incompleteProgress = details.progress !== undefined &&
    details.progress.completed < details.progress.total
  let outcome: AgentRecap['outcome']
  if (status === 'failed' || errorText) outcome = 'failed'
  else if (pending || details.attention) outcome = 'blocked'
  else if (explicit) outcome = explicit.outcome
  else if (boundedCount(backgroundTasks) > 0 || incompleteProgress) outcome = 'follow_up'
  else outcome = 'done'

  const summary = outcome === 'failed'
    ? errorText ?? explicit?.summary ?? lines[0] ?? recapFallback(provider, outcome)
    : outcome === 'blocked'
      ? details.attention ?? explicit?.summary ?? lines[0] ?? recapFallback(provider, outcome)
      : explicit?.summary ?? lines[0] ?? recapFallback(provider, outcome)
  return {
    outcome,
    summary: summary.slice(0, MAX_RECAP_SUMMARY_LENGTH),
    completedAt,
  }
}

function setRecap(details: AgentDetails, recap: AgentRecap): void {
  const previous = details.recap
  details.recap = previous &&
    previous.outcome === recap.outcome &&
    previous.summary === recap.summary
    ? previous
    : recap
}

function hasRetainableRecap(record: RegistryRecord): boolean {
  const recap = record.status.details?.recap
  return Boolean(recap && (
    record.status.status === 'done' ||
    record.status.status === 'failed' ||
    (record.status.status === 'needs_input' && recap.outcome === 'blocked')
  ))
}

export class AgentStatusRegistry {
  private readonly records = new Map<string, RegistryRecord>()
  private readonly inferenceSuppressions = new Map<string, InferenceSuppression>()

  get(paneId: string): AgentStatus | undefined {
    const status = this.records.get(paneId)?.status
    return status ? cloneStatus(status) : undefined
  }

  values(): AgentStatus[] {
    return [...this.records.values()].map(({ status }) => cloneStatus(status))
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
    const reconcilesOpenCodeCompletion = previous?.status.source === 'hook' &&
      previous.status.provider === 'opencode' &&
      previous.status.status === 'working' &&
      status.provider === 'opencode' &&
      status.status === 'done' &&
      status.source === 'heuristic' &&
      status.confidence === 'high'
    if (
      previous?.status.source === 'hook' &&
      !reconcilesOpenCodeCompletion &&
      !(previous.retainedCompletion && status.provider !== 'unknown' && status.provider !== previous.status.provider)
    ) return null

    if (previous && reconcilesOpenCodeCompletion) {
      const details = cloneDetails(previous.status.details ?? emptyDetails())
      const runningChecks = new Map(previous.runningChecks)
      delete details.currentActivity
      clearRunningChecks(details, runningChecks)
      setRecap(details, createRecap(
        'opencode',
        'done',
        details,
        false,
        undefined,
        0,
        undefined,
        status.updatedAt,
      ))
      return this.upsert({
        ...previous,
        status: attachDetails({
          ...previous.status,
          status: 'done',
          summary: status.summary,
          confidence: status.confidence,
          reason: status.reason,
          updatedAt: status.updatedAt,
        }, details),
        runningActivities: new Map(),
        runningChecks,
      })
    }

    if (status.provider === 'unknown' && status.status === 'unknown') {
      return previous ? this.remove(status.paneId) : null
    }

    return this.upsert({
      status: statusWithoutDetails(status),
      providerSessionId: null,
      processCommand: null,
      pendingRequests: new Map(),
      runningActivities: new Map(),
      runningChecks: new Map(),
      changedFiles: new Set(),
      tasks: new Map(),
      turnId: null,
      retainedCompletion: false,
    })
  }

  applyClaudeHook(
    paneId: string,
    payload: unknown,
    updatedAt = Date.now(),
    processCommand: string | null = null,
  ): AgentStatusChange {
    if (!isRecord(payload)) return null
    const eventName = stringProperty(payload, 'hook_event_name', 80)
    const sessionId = stringProperty(payload, 'session_id')
    if (!eventName || !sessionId) return null

    if (eventName === 'SessionEnd') {
      return this.removeProviderSession(paneId, 'claude', sessionId)
    }
    const previous = this.records.get(paneId)
    const sameSession = previous?.status.provider === 'claude' &&
      previous.providerSessionId === sessionId
    if (
      eventName === 'SessionStart' &&
      stringProperty(payload, 'source', 80) === 'compact' &&
      sameSession
    ) return null
    const startsProviderWork = eventName === 'SessionStart' || eventName === 'UserPromptSubmit'
    if (!this.acceptHookProcess(paneId, 'claude', processCommand, startsProviderWork)) return null

    let status: AgentStatusKind | null = null
    if (eventName === 'SessionStart') status = 'unknown'
    else if (
      eventName === 'UserPromptSubmit' ||
      eventName === 'TaskCreated' ||
      eventName === 'TaskCompleted' ||
      eventName === 'SubagentStart' ||
      eventName === 'SubagentStop'
    ) status = 'working'
    else if (eventName === 'PermissionRequest') status = 'needs_input'
    else if (
      eventName === 'PostToolUse' ||
      eventName === 'PostToolUseFailure' ||
      eventName === 'PermissionDenied' ||
      eventName === 'ElicitationResult'
    ) status = 'working'
    else if (eventName === 'PreToolUse') {
      const toolName = stringProperty(payload, 'tool_name', 80)
      status = toolName === 'AskUserQuestion' || toolName === 'PermissionRequest'
        ? 'needs_input'
        : 'working'
    } else if (eventName === 'Notification') {
      const notificationType = stringProperty(payload, 'notification_type', 80)
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
    const intent = boundedText(payload.intent, MAX_INTENT_LENGTH)
    const promptId = boundedText(payload.prompt_id, 200)
    const nextTurnId = eventName === 'UserPromptSubmit'
      ? JSON.stringify([promptId, intent])
      : null
    const startsNewTurn = eventName === 'UserPromptSubmit'
    const resetDetails = !sameSession || previous.retainedCompletion ||
      eventName === 'SessionStart' || startsNewTurn
    const details = resetDetails
      ? emptyDetails(eventName === 'UserPromptSubmit' ? intent : null)
      : cloneDetails(previous.status.details ?? emptyDetails())
    const tasks = resetDetails ? new Map<string, TaskState>() : new Map(previous.tasks)
    const pendingRequests = resetDetails
      ? new Map<string, PendingRequest>()
      : new Map(previous.pendingRequests)
    const runningActivities = resetDetails
      ? new Map<string, AgentActivity>()
      : new Map(previous.runningActivities)
    const runningChecks = resetDetails
      ? new Map<string, AgentCheck>()
      : new Map(previous.runningChecks)
    const changedFiles = resetDetails
      ? new Set<string>()
      : new Set(previous.changedFiles)

    if (eventName === 'UserPromptSubmit' && intent) details.intent = intent
    if (eventName === 'PreToolUse' || eventName === 'SubagentStart') {
      startActivity(details, runningActivities, payload.activity, payload.activityId, updatedAt)
    } else if (
      eventName === 'PostToolUse' ||
      eventName === 'PostToolUseFailure' ||
      eventName === 'SubagentStop'
    ) {
      const activityState = completeActivity(
        details,
        runningActivities,
        payload.activity,
        payload.activityId,
        updatedAt,
        eventName === 'PostToolUseFailure',
      )
      if (activityState === 'completed') {
        syncAttention(details, pendingRequests)
      }
    }
    updateCheck(details, runningChecks, payload.check, payload.activityId, updatedAt)
    addChangedFile(details, changedFiles, payload.filePath)
    updateClaudeTask(tasks, details, payload.task)

    const notificationType = stringProperty(payload, 'notification_type', 80)
    if (
      eventName === 'PermissionRequest' ||
      (eventName === 'PreToolUse' && status === 'needs_input') ||
      (eventName === 'Notification' && status === 'needs_input')
    ) {
      setAttention(details, payload.attention, 'claude')
    } else if (
      eventName === 'PermissionDenied' ||
      eventName === 'ElicitationResult' ||
      (eventName === 'Notification' && (
        notificationType === 'elicitation_complete' ||
        notificationType === 'elicitation_response'
      ))
    ) {
      syncAttention(details, pendingRequests)
    }

    if (eventName === 'Notification' && notificationType === 'idle_prompt') {
      runningActivities.clear()
      clearRunningChecks(details, runningChecks)
      delete details.currentActivity
    }
    if (eventName === 'Stop' || eventName === 'StopFailure') {
      runningActivities.clear()
      clearRunningChecks(details, runningChecks)
      delete details.currentActivity
      const recap = createRecap(
        'claude',
        status,
        details,
        pendingRequests.size > 0,
        payload.finalMessage,
        payload.backgroundTasks,
        payload.error,
        updatedAt,
      )
      setRecap(details, recap)
      if (recap.outcome === 'blocked') status = 'needs_input'
    }

    return this.upsert({
      status: attachDetails(hookStatus(paneId, 'claude', status, updatedAt), details),
      providerSessionId: sessionId,
      processCommand: status === 'unknown'
        ? null
        : sameSession ? (previous?.processCommand ?? processCommand) : processCommand,
      pendingRequests,
      runningActivities,
      runningChecks,
      changedFiles,
      tasks,
      turnId: eventName === 'UserPromptSubmit'
        ? nextTurnId
        : sameSession ? previous.turnId : null,
      retainedCompletion: false,
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
    const startsProviderWork = event.type === 'commando.turn.started'
    if (!this.acceptHookProcess(paneId, 'opencode', processCommand, startsProviderWork)) return null

    const previous = this.records.get(paneId)
    const sameSession = previous?.status.provider === 'opencode' &&
      previous.providerSessionId === sessionId
    const startsNewTurn = event.type === 'commando.turn.started'
    const resetDetails = !sameSession || previous.retainedCompletion || startsNewTurn
    const intent = boundedText(event.properties.intent, MAX_INTENT_LENGTH)
    const details = resetDetails
      ? emptyDetails(startsNewTurn ? intent : null)
      : cloneDetails(previous.status.details ?? emptyDetails())
    const tasks = resetDetails ? new Map<string, TaskState>() : new Map(previous.tasks)
    const pendingRequests = resetDetails
      ? new Map<string, PendingRequest>()
      : new Map(previous.pendingRequests)
    const runningActivities = resetDetails
      ? new Map<string, AgentActivity>()
      : new Map(previous.runningActivities)
    const runningChecks = resetDetails
      ? new Map<string, AgentCheck>()
      : new Map(previous.runningChecks)
    const changedFiles = resetDetails
      ? new Set<string>()
      : new Set(previous.changedFiles)

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
      const attention = setAttention(details, event.properties.attention, 'opencode')
      addPendingRequest(pendingRequests, 'permission', requestId, attention)
      status = 'needs_input'
    } else if (event.type === 'question.asked') {
      const requestId = stringProperty(event.properties, 'id')
      if (!requestId) return null
      const attention = setAttention(details, event.properties.attention, 'opencode')
      addPendingRequest(pendingRequests, 'question', requestId, attention)
      status = 'needs_input'
    } else if (
      event.type === 'permission.replied' ||
      event.type === 'question.replied' ||
      event.type === 'question.rejected'
    ) {
      if (previous?.status.source === 'hook' && !sameSession) return null
      const requestId = stringProperty(event.properties, 'requestID')
      if (!requestId) return null
      if (event.type === 'permission.replied') pendingRequests.delete(`permission:${requestId}`)
      else pendingRequests.delete(`question:${requestId}`)
      syncAttention(details, pendingRequests)
      status = pendingRequests.size > 0
        ? 'needs_input'
        : 'working'
    } else if (event.type === 'session.error') {
      status = 'failed'
    } else if (
      event.type === 'commando.turn.started' ||
      event.type === 'commando.activity.started' ||
      event.type === 'commando.activity.completed' ||
      event.type === 'todo.updated' ||
      event.type === 'file.edited' ||
      event.type === 'session.diff'
    ) {
      status = 'working'
    }

    if (!status) return null
    if (event.type === 'commando.turn.started' && intent) details.intent = intent
    if (event.type === 'commando.activity.started') {
      startActivity(
        details,
        runningActivities,
        event.properties.activity,
        event.properties.activityId,
        updatedAt,
      )
    } else if (event.type === 'commando.activity.completed') {
      const activityState = completeActivity(
        details,
        runningActivities,
        event.properties.activity,
        event.properties.activityId,
        updatedAt,
        false,
      )
      if (activityState === 'completed') {
        syncAttention(details, pendingRequests)
      }
    }
    updateCheck(
      details,
      runningChecks,
      event.properties.check,
      event.properties.activityId,
      updatedAt,
    )
    addChangedFile(details, changedFiles, event.properties.filePath)
    if (event.type === 'todo.updated' || event.type === 'session.idle' || event.type === 'session.status') {
      updateTodos(tasks, details, event.properties.todos)
    }
    if (event.type === 'session.diff' || event.type === 'session.idle' || event.type === 'session.status') {
      updateDiff(details, changedFiles, event.properties.diff)
    }

    if (
      status === 'working' &&
      pendingRequests.size > 0
    ) status = 'needs_input'

    const isIdle = event.type === 'session.idle' ||
      (event.type === 'session.status' && isRecord(event.properties.status) && event.properties.status.type === 'idle')
    if (event.type === 'session.error') {
      runningActivities.clear()
      clearRunningChecks(details, runningChecks)
      delete details.currentActivity
      setRecap(details, createRecap(
        'opencode',
        'failed',
        details,
        pendingRequests.size > 0,
        event.properties.finalMessage,
        0,
        event.properties.error,
        updatedAt,
      ))
    } else if (isIdle) {
      runningActivities.clear()
      clearRunningChecks(details, runningChecks)
      delete details.currentActivity
      if (sameSession && previous.status.status === 'failed' && previous.status.details?.recap) {
        details.recap = { ...previous.status.details.recap }
        status = 'failed'
      } else {
        const recap = createRecap(
          'opencode',
          status,
          details,
          pendingRequests.size > 0,
          event.properties.finalMessage,
          0,
          event.properties.error,
          updatedAt,
        )
        setRecap(details, recap)
        if (recap.outcome === 'blocked') status = 'needs_input'
      }
    } else if (
      event.type === 'session.status' &&
      status === 'working' &&
      sameSession &&
      previous.status.status === 'failed'
    ) {
      delete details.recap
    }

    return this.upsert({
      status: attachDetails(hookStatus(paneId, 'opencode', status, updatedAt), details),
      providerSessionId: sessionId,
      processCommand: sameSession ? (previous?.processCommand ?? processCommand) : processCommand,
      pendingRequests,
      runningActivities,
      runningChecks,
      changedFiles,
      tasks,
      turnId: startsNewTurn
        ? `${intent ?? 'turn'}:${updatedAt}`
        : sameSession ? previous.turnId : null,
      retainedCompletion: false,
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
    if (
      provider === 'claude' &&
      hasRetainableRecap(record)
    ) {
      const previousCommand = record.processCommand
      const suppression = this.inferenceSuppressions.get(paneId)
      record.processCommand = null
      record.retainedCompletion = true
      this.inferenceSuppressions.set(paneId, {
        provider,
        processCommand: previousCommand ?? (suppression?.provider === provider
          ? suppression.processCommand
          : null),
      })
      return null
    }
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
    if (hasRetainableRecap(record)) {
      const previousCommand = record.processCommand
      record.processCommand = null
      record.retainedCompletion = true
      this.inferenceSuppressions.set(paneId, {
        provider: record.status.provider,
        processCommand: previousCommand,
      })
      return null
    }
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
    startsProviderWork = false,
  ): boolean {
    const suppression = this.inferenceSuppressions.get(paneId)
    if (
      !startsProviderWork &&
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
    const stored = { ...record, status: cloneStatus(record.status) }
    this.records.set(record.status.paneId, stored)
    return { type: 'upsert', status: cloneStatus(stored.status) }
  }
}
