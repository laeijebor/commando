import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import {
  closeSync,
  fchmodSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  isReportBackTaskStatus,
  type ReportBackEvent,
  type ReportBackMessage,
  type ReportBackMintTokenResponse,
  type ReportBackPendingQuestion,
  type ReportBackReadMessagesResult,
  type ReportBackTaskSnapshot,
  type ReportBackTaskStatus,
  type ReportBackTokenInfo,
} from '../shared/report-back.js'

export const REPORT_BACK_TOKEN_PREFIX = 'cmrb_'
export const DEFAULT_MAX_EVENTS_PER_TASK = 200
export const DEFAULT_MAX_REPLIES_PER_TASK = 200

const MAX_TOKENS = 512
const MAX_TASKS = 512
const MAX_TASK_ID_LENGTH = 128
const MAX_LABEL_LENGTH = 120
const MAX_MESSAGE_LENGTH = 16 * 1024
const MAX_SUMMARY_LENGTH = 2_000
const MAX_TOKEN_INPUT_LENGTH = 512
const MAX_TTL_MS = 365 * 24 * 60 * 60 * 1_000
const SHA256_HEX = /^[a-f0-9]{64}$/
const TASK_ID_PATTERN = /^[a-zA-Z0-9._:@/-]+$/
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/
const NON_NEGATIVE_INT = /^\d+$/

type StoredTokenRecord = ReportBackTokenInfo & {
  tokenHash: string
}

type StoredReplyRecord = {
  seq: number
  id: string
  taskId: string
  message: string
  questionId?: string
  createdAt: number
}

type StoredTaskRecord = {
  taskId: string
  label?: string
  status: ReportBackTaskStatus
  summary?: string
  pendingQuestion?: ReportBackPendingQuestion
  events: ReportBackEvent[]
  replies: StoredReplyRecord[]
  nextReplySeq: number
  updatedAt: number
}

type PersistedReportBackState = {
  version: 1
  tokens: StoredTokenRecord[]
  tasks: StoredTaskRecord[]
}

export type MintTokenInput = {
  taskId: string
  label?: string
  ttlMs?: number
}

export type ReportBackStoreOptions = {
  statePath?: string
  now?: () => number
  maxEventsPerTask?: number
  maxRepliesPerTask?: number
}

export class ReportBackStoreError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'ReportBackStoreError'
  }
}

export function defaultReportBackStatePath(): string {
  return process.env.COMMANDO_REPORT_BACK_STATE_PATH ?? join(homedir(), '.commando', 'report-back-state.json')
}

function sha256Digest(value: string): Buffer {
  return createHash('sha256').update(value).digest()
}

function generateTaskToken(): string {
  return `${REPORT_BACK_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`
}

export function validateTaskId(value: unknown): string {
  if (typeof value !== 'string') {
    throw new ReportBackStoreError(400, 'invalid_task_id', 'taskId must be a string')
  }
  const trimmed = value.trim()
  if (
    trimmed.length === 0 ||
    trimmed.length > MAX_TASK_ID_LENGTH ||
    trimmed !== value ||
    !TASK_ID_PATTERN.test(trimmed) ||
    trimmed.includes('..')
  ) {
    throw new ReportBackStoreError(
      400,
      'invalid_task_id',
      `taskId must be 1–${MAX_TASK_ID_LENGTH} safe characters without whitespace or '..'`,
    )
  }
  return trimmed
}

export function validateLabel(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') {
    throw new ReportBackStoreError(400, 'invalid_label', 'label must be a string')
  }
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > MAX_LABEL_LENGTH || CONTROL_CHARS.test(trimmed)) {
    throw new ReportBackStoreError(
      400,
      'invalid_label',
      `label must contain 1–${MAX_LABEL_LENGTH} printable characters`,
    )
  }
  return trimmed
}

export function validateTtlMs(value: unknown): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > MAX_TTL_MS) {
    throw new ReportBackStoreError(
      400,
      'invalid_ttl',
      `ttlMs must be a positive number up to ${MAX_TTL_MS} ms`,
    )
  }
  return Math.floor(value)
}

function validateNonEmptyText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string') {
    throw new ReportBackStoreError(400, `invalid_${field}`, `${field} must be a string`)
  }
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > maxLength) {
    throw new ReportBackStoreError(
      400,
      `invalid_${field}`,
      `${field} must be between 1 and ${maxLength} characters`,
    )
  }
  return trimmed
}

function validateOptionalSummary(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') {
    throw new ReportBackStoreError(400, 'invalid_summary', 'summary must be a string')
  }
  const trimmed = value.trim()
  if (trimmed.length > MAX_SUMMARY_LENGTH) {
    throw new ReportBackStoreError(
      400,
      'invalid_summary',
      `summary must be at most ${MAX_SUMMARY_LENGTH} characters`,
    )
  }
  return trimmed
}

function parseCursor(cursor: unknown): number {
  if (cursor === undefined || cursor === '') return 0
  if (typeof cursor !== 'string' || !NON_NEGATIVE_INT.test(cursor)) {
    throw new ReportBackStoreError(400, 'invalid_cursor', 'cursor must be a non-negative integer string')
  }
  const parsed = Number(cursor)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new ReportBackStoreError(400, 'invalid_cursor', 'cursor is out of range')
  }
  return parsed
}

function toPublicTokenInfo(record: StoredTokenRecord): ReportBackTokenInfo {
  return {
    tokenId: record.tokenId,
    taskId: record.taskId,
    ...(record.label !== undefined ? { label: record.label } : {}),
    createdAt: record.createdAt,
    ...(record.expiresAt !== undefined ? { expiresAt: record.expiresAt } : {}),
    ...(record.revokedAt !== undefined ? { revokedAt: record.revokedAt } : {}),
    ...(record.lastUsedAt !== undefined ? { lastUsedAt: record.lastUsedAt } : {}),
  }
}

function toTaskSnapshot(record: StoredTaskRecord): ReportBackTaskSnapshot {
  return {
    taskId: record.taskId,
    ...(record.label !== undefined ? { label: record.label } : {}),
    status: record.status,
    ...(record.summary !== undefined ? { summary: record.summary } : {}),
    ...(record.pendingQuestion ? { pendingQuestion: { ...record.pendingQuestion } } : {}),
    events: record.events.map((event) => ({ ...event })),
    updatedAt: record.updatedAt,
  }
}

function toReplyMessage(reply: StoredReplyRecord): ReportBackMessage {
  return {
    id: reply.id,
    cursor: String(reply.seq),
    taskId: reply.taskId,
    message: reply.message,
    ...(reply.questionId !== undefined ? { questionId: reply.questionId } : {}),
    createdAt: reply.createdAt,
  }
}

function isStoredTokenRecord(value: unknown): value is StoredTokenRecord {
  if (!value || typeof value !== 'object') return false
  const record = value as Partial<StoredTokenRecord>
  return (
    typeof record.tokenId === 'string' &&
    record.tokenId.length > 0 &&
    typeof record.taskId === 'string' &&
    record.taskId.length > 0 &&
    typeof record.tokenHash === 'string' &&
    SHA256_HEX.test(record.tokenHash) &&
    typeof record.createdAt === 'number' &&
    Number.isFinite(record.createdAt) &&
    (record.label === undefined || typeof record.label === 'string') &&
    (record.expiresAt === undefined || Number.isFinite(record.expiresAt)) &&
    (record.revokedAt === undefined || Number.isFinite(record.revokedAt)) &&
    (record.lastUsedAt === undefined || Number.isFinite(record.lastUsedAt))
  )
}

function isStoredTaskRecord(value: unknown): value is StoredTaskRecord {
  if (!value || typeof value !== 'object') return false
  const record = value as Partial<StoredTaskRecord>
  return (
    typeof record.taskId === 'string' &&
    record.taskId.length > 0 &&
    isReportBackTaskStatus(record.status) &&
    Array.isArray(record.events) &&
    Array.isArray(record.replies) &&
    typeof record.nextReplySeq === 'number' &&
    Number.isSafeInteger(record.nextReplySeq) &&
    record.nextReplySeq >= 1 &&
    typeof record.updatedAt === 'number' &&
    Number.isFinite(record.updatedAt)
  )
}

function readPersistedState(statePath: string): PersistedReportBackState | null {
  let raw: string
  try {
    raw = readFileSync(statePath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new ReportBackStoreError(503, 'storage_error', 'Cannot read report-back state')
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new ReportBackStoreError(503, 'storage_corrupt', 'Report-back state file contains invalid JSON')
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new ReportBackStoreError(503, 'storage_corrupt', 'Report-back state file has invalid root')
  }
  const candidate = parsed as Partial<PersistedReportBackState>
  if (candidate.version !== 1 || !Array.isArray(candidate.tokens) || !Array.isArray(candidate.tasks)) {
    throw new ReportBackStoreError(503, 'storage_corrupt', 'Report-back state file has invalid schema')
  }
  if (!candidate.tokens.every(isStoredTokenRecord) || !candidate.tasks.every(isStoredTaskRecord)) {
    throw new ReportBackStoreError(503, 'storage_corrupt', 'Report-back state file contains malformed records')
  }

  return {
    version: 1,
    tokens: candidate.tokens,
    tasks: candidate.tasks,
  }
}

function writePersistedStateAtomically(statePath: string, state: PersistedReportBackState): void {
  const temporary = `${statePath}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`
  let fd: number | undefined
  try {
    mkdirSync(dirname(statePath), { recursive: true, mode: 0o700 })
    fd = openSync(temporary, 'wx', 0o600)
    fchmodSync(fd, 0o600)
    writeFileSync(fd, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    renameSync(temporary, statePath)
  } catch {
    throw new ReportBackStoreError(503, 'storage_error', 'Cannot persist report-back state')
  } finally {
    if (fd !== undefined) closeSync(fd)
    try {
      unlinkSync(temporary)
    } catch {
      /* already renamed or never created */
    }
  }
}

export class ReportBackStore {
  readonly statePath: string
  private readonly now: () => number
  private readonly maxEventsPerTask: number
  private readonly maxRepliesPerTask: number
  private readonly tokens = new Map<string, StoredTokenRecord>()
  private readonly tasks = new Map<string, StoredTaskRecord>()

  constructor(options: ReportBackStoreOptions = {}) {
    this.statePath = options.statePath ?? defaultReportBackStatePath()
    this.now = options.now ?? Date.now
    this.maxEventsPerTask = options.maxEventsPerTask ?? DEFAULT_MAX_EVENTS_PER_TASK
    this.maxRepliesPerTask = options.maxRepliesPerTask ?? DEFAULT_MAX_REPLIES_PER_TASK
    this.loadExistingState()
  }

  private loadExistingState(): void {
    const persisted = readPersistedState(this.statePath)
    if (!persisted) return
    for (const token of persisted.tokens) {
      this.tokens.set(token.tokenId, token)
    }
    for (const task of persisted.tasks) {
      this.tasks.set(task.taskId, {
        ...task,
        events: task.events.slice(-this.maxEventsPerTask),
        replies: task.replies.slice(-this.maxRepliesPerTask),
      })
    }
  }

  private persist(): void {
    writePersistedStateAtomically(this.statePath, {
      version: 1,
      tokens: [...this.tokens.values()],
      tasks: [...this.tasks.values()],
    })
  }

  mintToken(input: MintTokenInput): ReportBackMintTokenResponse {
    const taskId = validateTaskId(input.taskId)
    const label = validateLabel(input.label)
    const ttlMs = validateTtlMs(input.ttlMs)
    if (this.tokens.size >= MAX_TOKENS) {
      throw new ReportBackStoreError(409, 'token_limit_reached', 'Maximum number of report-back tokens reached')
    }

    const token = generateTaskToken()
    const createdAt = this.now()
    const record: StoredTokenRecord = {
      tokenId: randomUUID(),
      taskId,
      ...(label !== undefined ? { label } : {}),
      tokenHash: sha256Digest(token).toString('hex'),
      createdAt,
      ...(ttlMs !== undefined ? { expiresAt: createdAt + ttlMs } : {}),
    }

    this.tokens.set(record.tokenId, record)
    this.persist()
    return { token, info: toPublicTokenInfo(record) }
  }

  authenticate(bearerToken: string): ReportBackTokenInfo | null {
    if (typeof bearerToken !== 'string' || bearerToken.length === 0 || bearerToken.length > MAX_TOKEN_INPUT_LENGTH) {
      return null
    }

    const candidateDigest = sha256Digest(bearerToken)
    let matched: StoredTokenRecord | null = null
    // Scan every record with timingSafeEqual so timing does not leak match position.
    for (const record of this.tokens.values()) {
      const recordDigest = Buffer.from(record.tokenHash, 'hex')
      if (timingSafeEqual(candidateDigest, recordDigest)) {
        matched = record
      }
    }

    if (!matched) return null
    const now = this.now()
    if (matched.revokedAt !== undefined) return null
    if (matched.expiresAt !== undefined && now >= matched.expiresAt) return null

    matched.lastUsedAt = now
    this.persist()
    return toPublicTokenInfo(matched)
  }

  revokeToken(tokenId: string): ReportBackTokenInfo | null {
    const record = this.tokens.get(tokenId)
    if (!record) return null
    if (record.revokedAt === undefined) {
      record.revokedAt = this.now()
      this.persist()
    }
    return toPublicTokenInfo(record)
  }

  listTokens(): ReportBackTokenInfo[] {
    return [...this.tokens.values()]
      .sort((left, right) => right.createdAt - left.createdAt)
      .map(toPublicTokenInfo)
  }

  postUpdate(
    taskIdInput: string,
    messageInput: string,
    options: { label?: string } = {},
  ): { event: ReportBackEvent; task: ReportBackTaskSnapshot } {
    const taskId = validateTaskId(taskIdInput)
    const message = validateNonEmptyText(messageInput, 'message', MAX_MESSAGE_LENGTH)
    const now = this.now()
    const task = this.ensureTask(taskId, options.label, now)
    const event: ReportBackEvent = {
      id: randomUUID(),
      taskId,
      kind: 'update',
      message,
      createdAt: now,
    }
    this.appendEvent(task, event, now)
    this.persist()
    return { event: { ...event }, task: toTaskSnapshot(task) }
  }

  askUser(
    taskIdInput: string,
    questionInput: string,
    options: { label?: string } = {},
  ): { questionId: string; event: ReportBackEvent; task: ReportBackTaskSnapshot } {
    const taskId = validateTaskId(taskIdInput)
    const question = validateNonEmptyText(questionInput, 'question', MAX_MESSAGE_LENGTH)
    const now = this.now()
    const task = this.ensureTask(taskId, options.label, now)
    const questionId = randomUUID()
    task.status = 'waiting'
    task.pendingQuestion = { id: questionId, question, createdAt: now }
    const event: ReportBackEvent = {
      id: randomUUID(),
      taskId,
      kind: 'question',
      message: question,
      status: 'waiting',
      questionId,
      createdAt: now,
    }
    this.appendEvent(task, event, now)
    this.persist()
    return { questionId, event: { ...event }, task: toTaskSnapshot(task) }
  }

  setStatus(
    taskIdInput: string,
    statusInput: unknown,
    summaryInput?: unknown,
    options: { label?: string } = {},
  ): { event: ReportBackEvent; task: ReportBackTaskSnapshot } {
    const taskId = validateTaskId(taskIdInput)
    if (!isReportBackTaskStatus(statusInput)) {
      throw new ReportBackStoreError(400, 'invalid_status', 'Invalid task status')
    }
    const summary = validateOptionalSummary(summaryInput)
    const now = this.now()
    const task = this.ensureTask(taskId, options.label, now)
    task.status = statusInput
    if (summary !== undefined) {
      if (summary.length > 0) task.summary = summary
      else delete task.summary
    }
    if (statusInput !== 'waiting') {
      delete task.pendingQuestion
    }
    const event: ReportBackEvent = {
      id: randomUUID(),
      taskId,
      kind: 'status',
      message: summary && summary.length > 0 ? summary : statusInput,
      status: statusInput,
      createdAt: now,
    }
    this.appendEvent(task, event, now)
    this.persist()
    return { event: { ...event }, task: toTaskSnapshot(task) }
  }

  postHumanReply(
    taskIdInput: string,
    messageInput: string,
  ): { reply: ReportBackMessage; event: ReportBackEvent; task: ReportBackTaskSnapshot } {
    const taskId = validateTaskId(taskIdInput)
    const message = validateNonEmptyText(messageInput, 'message', MAX_MESSAGE_LENGTH)
    const now = this.now()
    const task = this.ensureTask(taskId, this.latestLabelForTask(taskId), now)
    const questionId = task.pendingQuestion?.id
    delete task.pendingQuestion
    if (task.status === 'waiting') {
      task.status = 'running'
    }

    const seq = task.nextReplySeq++
    const replyRecord: StoredReplyRecord = {
      seq,
      id: randomUUID(),
      taskId,
      message,
      ...(questionId !== undefined ? { questionId } : {}),
      createdAt: now,
    }
    task.replies.push(replyRecord)
    if (task.replies.length > this.maxRepliesPerTask) {
      task.replies.splice(0, task.replies.length - this.maxRepliesPerTask)
    }

    const event: ReportBackEvent = {
      id: replyRecord.id,
      taskId,
      kind: 'reply',
      message,
      ...(questionId !== undefined ? { questionId } : {}),
      createdAt: now,
    }
    this.appendEvent(task, event, now)
    this.persist()
    return {
      reply: toReplyMessage(replyRecord),
      event: { ...event },
      task: toTaskSnapshot(task),
    }
  }

  readMessages(taskIdInput: string, cursorInput?: unknown): ReportBackReadMessagesResult {
    const taskId = validateTaskId(taskIdInput)
    const since = parseCursor(cursorInput)
    const task = this.tasks.get(taskId)
    if (!task) {
      return { messages: [], nextCursor: String(since) }
    }
    const messages = task.replies
      .filter((reply) => reply.seq > since)
      .map(toReplyMessage)
    const lastKnownSeq = task.nextReplySeq - 1
    const nextCursor = messages.length > 0
      ? messages[messages.length - 1].cursor
      : String(Math.max(since, lastKnownSeq))
    return { messages, nextCursor }
  }

  getTask(taskIdInput: string): ReportBackTaskSnapshot | null {
    const taskId = validateTaskId(taskIdInput)
    const task = this.tasks.get(taskId)
    return task ? toTaskSnapshot(task) : null
  }

  listTasks(): ReportBackTaskSnapshot[] {
    return [...this.tasks.values()]
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .map(toTaskSnapshot)
  }

  private ensureTask(taskId: string, label: string | undefined, now: number): StoredTaskRecord {
    const existing = this.tasks.get(taskId)
    if (existing) {
      if (existing.label === undefined && label !== undefined) {
        existing.label = label
      }
      return existing
    }
    if (this.tasks.size >= MAX_TASKS) {
      throw new ReportBackStoreError(409, 'task_limit_reached', 'Maximum number of report-back tasks reached')
    }
    const created: StoredTaskRecord = {
      taskId,
      ...(label !== undefined ? { label } : {}),
      status: 'running',
      events: [],
      replies: [],
      nextReplySeq: 1,
      updatedAt: now,
    }
    this.tasks.set(taskId, created)
    return created
  }

  private latestLabelForTask(taskId: string): string | undefined {
    let latest: StoredTokenRecord | undefined
    for (const token of this.tokens.values()) {
      if (token.taskId === taskId && token.label !== undefined) {
        if (!latest || token.createdAt > latest.createdAt) {
          latest = token
        }
      }
    }
    return latest?.label
  }

  private appendEvent(task: StoredTaskRecord, event: ReportBackEvent, now: number): void {
    task.events.push(event)
    if (task.events.length > this.maxEventsPerTask) {
      task.events.splice(0, task.events.length - this.maxEventsPerTask)
    }
    task.updatedAt = now
  }
}
