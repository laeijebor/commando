import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import type {
  AgentStatus,
  AgentStatusKind,
  SessionBrief,
  SessionBriefUpdate,
  SessionBriefUpdateKind,
} from '../shared/protocol.js'

type StateFile = {
  version: 1
  briefs: Record<string, SessionBrief>
}

export type SessionBriefPatch = {
  headline?: string
  recapMarkdown?: string | null
  next?: string | null
  state?: AgentStatusKind
  update?: {
    kind: SessionBriefUpdateKind
    text: string
    detail?: string
  }
}

const SESSION_ID = /^\$\d+$/
const PANE_ID = /^%\d+$/
const UPDATE_ID = /^[A-Za-z0-9:._-]{1,128}$/
const MAX_BRIEFS = 64
const MAX_UPDATES = 8
const MAX_HEADLINE = 180
const MAX_RECAP = 2_000
const MAX_NEXT = 240
const MAX_UPDATE_TEXT = 240
const MAX_UPDATE_DETAIL = 360
const UPDATE_KINDS = new Set<SessionBriefUpdateKind>(['changed', 'decision', 'check', 'blocker', 'note'])
const STATUS_KINDS = new Set<AgentStatusKind>(['working', 'needs_input', 'done', 'failed', 'stale', 'unknown'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function cleanText(value: unknown, maximum: number): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (!text || text.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) return null
  return text
}

function cleanOptionalText(value: unknown, maximum: number): string | undefined | null {
  if (value === undefined) return undefined
  if (value === null || value === '') return null
  return cleanText(value, maximum)
}

function safeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function parseUpdate(value: unknown): SessionBriefUpdate | null {
  if (!isRecord(value)) return null
  const text = cleanText(value.text, MAX_UPDATE_TEXT)
  const detail = cleanOptionalText(value.detail, MAX_UPDATE_DETAIL)
  if (
    typeof value.id !== 'string' || !UPDATE_ID.test(value.id) ||
    typeof value.paneId !== 'string' || !PANE_ID.test(value.paneId) ||
    typeof value.kind !== 'string' || !UPDATE_KINDS.has(value.kind as SessionBriefUpdateKind) ||
    text === null || detail === null ||
    (value.source !== 'hook' && value.source !== 'agent') ||
    !safeInteger(value.createdAt)
  ) return null
  return {
    id: value.id,
    paneId: value.paneId,
    kind: value.kind as SessionBriefUpdateKind,
    text,
    ...(detail ? { detail } : {}),
    source: value.source,
    createdAt: value.createdAt,
  }
}

export function parseSessionBrief(value: unknown): SessionBrief | null {
  if (!isRecord(value)) return null
  const sessionName = cleanText(value.sessionName, 128)
  const headline = cleanText(value.headline, MAX_HEADLINE)
  const recapMarkdown = cleanOptionalText(value.recapMarkdown, MAX_RECAP)
  const next = cleanOptionalText(value.next, MAX_NEXT)
  if (
    typeof value.sessionId !== 'string' || !SESSION_ID.test(value.sessionId) ||
    sessionName === null || headline === null || recapMarkdown === null || next === null ||
    (value.headlineSource !== 'hook' && value.headlineSource !== 'agent') ||
    typeof value.state !== 'string' || !STATUS_KINDS.has(value.state as AgentStatusKind) ||
    !Array.isArray(value.updates) || value.updates.length > MAX_UPDATES ||
    !safeInteger(value.updatedAt)
  ) return null
  const updates = value.updates.map(parseUpdate)
  if (updates.some((update) => update === null)) return null
  const validUpdates = updates as SessionBriefUpdate[]
  if (new Set(validUpdates.map((update) => update.id)).size !== validUpdates.length) return null
  return {
    sessionId: value.sessionId,
    sessionName,
    state: value.state as AgentStatusKind,
    headline,
    headlineSource: value.headlineSource,
    ...(recapMarkdown ? { recapMarkdown } : {}),
    updates: validUpdates,
    ...(next ? { next } : {}),
    updatedAt: value.updatedAt,
  }
}

function parseState(value: unknown): StateFile {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.briefs)) {
    throw new Error('Session brief state file has an invalid structure')
  }
  const briefs: Record<string, SessionBrief> = Object.create(null)
  for (const [sessionId, candidate] of Object.entries(value.briefs)) {
    const brief = parseSessionBrief(candidate)
    if (!brief || brief.sessionId !== sessionId) {
      throw new Error(`Session brief state contains an invalid entry for ${sessionId}`)
    }
    briefs[sessionId] = brief
  }
  return { version: 1, briefs }
}

function cloneBrief(brief: SessionBrief): SessionBrief {
  return {
    ...brief,
    updates: brief.updates.map((update) => ({ ...update })),
  }
}

function statusPriority(status: AgentStatusKind): number {
  switch (status) {
    case 'failed': return 5
    case 'needs_input': return 4
    case 'working': return 3
    case 'done': return 2
    case 'stale': return 1
    case 'unknown': return 0
  }
}

function statusHeadline(status: AgentStatus): string {
  return status.details?.recap?.summary
    ?? status.details?.attention
    ?? status.details?.currentActivity?.label
    ?? status.details?.intent
    ?? status.summary
}

function statusUpdate(status: AgentStatus): SessionBriefUpdate {
  const recap = status.details?.recap
  const attention = status.details?.attention
  const check = status.details?.checks.find((candidate) => candidate.status === 'failed')
    ?? status.details?.checks.find((candidate) => candidate.status === 'running')
    ?? status.details?.checks[0]
  const changes = status.details?.changes
  const kind: SessionBriefUpdateKind = status.status === 'failed' || status.status === 'needs_input'
    ? 'blocker'
    : check
      ? 'check'
      : changes?.fileCount
        ? 'changed'
        : 'note'
  const text = recap?.summary
    ?? attention
    ?? (check ? `${check.label}: ${check.status}` : undefined)
    ?? status.details?.currentActivity?.label
    ?? status.details?.intent
    ?? status.summary
  const detail = changes?.fileCount
    ? `${changes.fileCount} ${changes.fileCount === 1 ? 'file' : 'files'} · +${changes.additions} −${changes.deletions}`
    : undefined
  return {
    id: `hook:${status.paneId.slice(1)}`,
    paneId: status.paneId,
    kind,
    text: text.slice(0, MAX_UPDATE_TEXT),
    ...(detail ? { detail } : {}),
    source: 'hook',
    createdAt: status.updatedAt,
  }
}

export function defaultSessionBriefStatePath(): string {
  return process.env.COMMANDO_SESSION_BRIEFS_PATH
    ?? join(homedir(), '.commando', 'session-briefs.json')
}

export class SessionBriefStore {
  readonly statePath: string
  private readonly briefs = new Map<string, SessionBrief>()
  private writes: Promise<void> = Promise.resolve()

  constructor(statePath = defaultSessionBriefStatePath()) {
    this.statePath = statePath
  }

  async load(): Promise<void> {
    await this.writes
    try {
      const state = parseState(JSON.parse(await readFile(this.statePath, 'utf8')) as unknown)
      this.briefs.clear()
      for (const brief of Object.values(state.briefs)
        .sort((left, right) => right.updatedAt - left.updatedAt)
        .slice(0, MAX_BRIEFS)) {
        this.briefs.set(brief.sessionId, brief)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      if (error instanceof SyntaxError) {
        throw new Error('Session brief state file contains invalid JSON', { cause: error })
      }
      throw error
    }
  }

  get(sessionId: string): SessionBrief | null {
    const brief = this.briefs.get(sessionId)
    return brief ? cloneBrief(brief) : null
  }

  values(): SessionBrief[] {
    return [...this.briefs.values()]
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .map(cloneBrief)
  }

  async syncFromStatuses(
    sessionId: string,
    sessionName: string,
    statuses: AgentStatus[],
    now = Date.now(),
  ): Promise<SessionBrief | null> {
    if (!SESSION_ID.test(sessionId)) throw new Error('Invalid tmux session id')
    const cleanSessionName = cleanText(sessionName, 128)
    if (!cleanSessionName) throw new Error('Invalid tmux session name')
    const previous = this.briefs.get(sessionId)
    const current = previous?.sessionName === cleanSessionName ? previous : undefined
    if (statuses.length === 0) {
      if (!current) return null
      const brief = { ...current, state: 'stale' as const, updatedAt: now }
      this.briefs.set(sessionId, brief)
      await this.persist()
      return cloneBrief(brief)
    }

    const ordered = [...statuses].sort((left, right) => (
      statusPriority(right.status) - statusPriority(left.status) || right.updatedAt - left.updatedAt
    ))
    const lead = ordered[0]
    const agentUpdates = current?.updates.filter((update) => update.source === 'agent') ?? []
    const updates = [...ordered.map(statusUpdate), ...agentUpdates]
      .sort((left, right) => right.createdAt - left.createdAt)
      .slice(0, MAX_UPDATES)
    const recap = current?.recapMarkdown
      ?? ordered.find((status) => status.details?.recap)?.details?.recap?.summary
    const brief: SessionBrief = {
      sessionId,
      sessionName: cleanSessionName,
      state: lead.status,
      headline: current?.headlineSource === 'agent'
        ? current.headline
        : statusHeadline(lead).slice(0, MAX_HEADLINE),
      headlineSource: current?.headlineSource === 'agent' ? 'agent' : 'hook',
      ...(recap ? { recapMarkdown: recap.slice(0, MAX_RECAP) } : {}),
      updates,
      ...(current?.next ? { next: current.next } : {}),
      updatedAt: Math.max(now, ...ordered.map((status) => status.updatedAt)),
    }
    this.briefs.set(sessionId, brief)
    this.prune()
    await this.persist()
    return cloneBrief(brief)
  }

  async applyAgentPatch(
    sessionId: string,
    sessionName: string,
    paneId: string,
    patch: SessionBriefPatch,
    now = Date.now(),
  ): Promise<SessionBrief> {
    if (!SESSION_ID.test(sessionId) || !PANE_ID.test(paneId)) throw new Error('Invalid tmux target')
    const cleanSessionName = cleanText(sessionName, 128)
    if (!cleanSessionName) throw new Error('Invalid tmux session name')
    const previous = this.briefs.get(sessionId)
    const current = previous?.sessionName === cleanSessionName ? previous : undefined
    const update = patch.update ? {
      id: `agent:${now}:${randomUUID()}`,
      paneId,
      kind: patch.update.kind,
      text: patch.update.text,
      ...(patch.update.detail ? { detail: patch.update.detail } : {}),
      source: 'agent' as const,
      createdAt: now,
    } : null
    const previousUpdates = current?.updates ?? []
    const retainedUpdates = update
      ? previousUpdates.filter((candidate) => !(
          candidate.source === 'agent' &&
          candidate.paneId === paneId &&
          candidate.kind === update.kind &&
          candidate.text === update.text
        ))
      : previousUpdates
    const headline = patch.headline
      ?? current?.headline
      ?? patch.update?.text
      ?? patch.next
      ?? 'Session update'
    const brief: SessionBrief = {
      sessionId,
      sessionName: cleanSessionName,
      state: patch.state ?? current?.state ?? 'working',
      headline,
      headlineSource: patch.headline ? 'agent' : current?.headlineSource ?? 'agent',
      ...(patch.recapMarkdown === null
        ? {}
        : patch.recapMarkdown !== undefined
          ? { recapMarkdown: patch.recapMarkdown }
          : current?.recapMarkdown
            ? { recapMarkdown: current.recapMarkdown }
            : {}),
      updates: update
        ? [update, ...retainedUpdates].slice(0, MAX_UPDATES)
        : retainedUpdates,
      ...(patch.next === null
        ? {}
        : patch.next !== undefined
          ? { next: patch.next }
          : current?.next
            ? { next: current.next }
            : {}),
      updatedAt: now,
    }
    const validated = parseSessionBrief(brief)
    if (!validated) throw new Error('Invalid session brief patch')
    this.briefs.set(sessionId, validated)
    this.prune()
    await this.persist()
    return cloneBrief(validated)
  }

  private prune(): void {
    if (this.briefs.size <= MAX_BRIEFS) return
    const retained = [...this.briefs.values()]
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, MAX_BRIEFS)
    this.briefs.clear()
    for (const brief of retained) this.briefs.set(brief.sessionId, brief)
  }

  private persist(): Promise<void> {
    const operation = this.writes.then(() => this.writeState())
    this.writes = operation.catch(() => undefined)
    return operation
  }

  private async writeState(): Promise<void> {
    const directory = dirname(this.statePath)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const temporaryPath = `${this.statePath}.${process.pid}.${randomUUID()}.tmp`
    let handle: Awaited<ReturnType<typeof open>> | null = null
    try {
      handle = await open(temporaryPath, 'wx', 0o600)
      const briefs = Object.fromEntries([...this.briefs].map(([sessionId, brief]) => [sessionId, brief]))
      await handle.writeFile(`${JSON.stringify({ version: 1, briefs }, null, 2)}\n`, 'utf8')
      await handle.sync()
      await handle.close()
      handle = null
      await rename(temporaryPath, this.statePath)
      try {
        const directoryHandle = await open(directory, 'r')
        try {
          await directoryHandle.sync()
        } finally {
          await directoryHandle.close()
        }
      } catch {
        // Directory fsync is not available on every supported filesystem.
      }
    } catch (error) {
      await handle?.close().catch(() => undefined)
      await rm(temporaryPath, { force: true }).catch(() => undefined)
      throw error
    }
  }
}
