import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'

import type {
  AgentStatus,
  AgentStatusKind,
  AgentTask,
  AgentTaskPriority,
  AgentTaskStatus,
  SessionBrief,
  SessionBriefUpdate,
  SessionBriefUpdateKind,
  PaneScreenshotFolder,
} from '../shared/protocol.js'

type StateFile = {
  version: 3
  briefs: Record<string, SessionBrief>
}

type LegacySessionBrief = Omit<SessionBrief, 'paneId'>

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
  publishedScreenshots?: PaneScreenshotFolder
}

const SESSION_ID = /^\$\d+$/
const PANE_ID = /^%\d+$/
const UPDATE_ID = /^[A-Za-z0-9:._-]{1,128}$/
const MAX_BRIEFS = 64
const MAX_UPDATES = 150
const MAX_HEADLINE = 180
const MAX_RECAP = 2_000
const MAX_NEXT = 240
const MAX_UPDATE_TEXT = 240
const MAX_UPDATE_DETAIL = 360
const UPDATE_KINDS = new Set<SessionBriefUpdateKind>(['changed', 'decision', 'check', 'blocker', 'note', 'screenshots'])
const STATUS_KINDS = new Set<AgentStatusKind>(['working', 'needs_input', 'done', 'failed', 'stale', 'unknown'])
const TASK_STATUSES = new Set<AgentTaskStatus>(['pending', 'in_progress', 'completed', 'cancelled'])
const TASK_PRIORITIES = new Set<AgentTaskPriority>(['high', 'medium', 'low'])

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

function safeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
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
    (value.screenshotFolderId !== undefined && (typeof value.screenshotFolderId !== 'string' || !/^[0-9a-f]{16}$/.test(value.screenshotFolderId))) ||
    (value.author !== undefined && value.author !== 'user') ||
    (value.source !== 'hook' && value.source !== 'agent') ||
    !safeInteger(value.createdAt)
  ) return null
  return {
    id: value.id,
    paneId: value.paneId,
    kind: value.kind as SessionBriefUpdateKind,
    text,
    ...(detail ? { detail } : {}),
    ...(typeof value.screenshotFolderId === 'string' ? { screenshotFolderId: value.screenshotFolderId } : {}),
    ...(value.author === 'user' ? { author: 'user' as const } : {}),
    source: value.source,
    createdAt: value.createdAt,
  }
}

function parseTask(value: unknown, index: number): AgentTask | null {
  if (!isRecord(value)) return null
  const content = cleanText(value.content ?? value.subject, 240)
  const id = cleanText(value.id, 120) ?? (content ? `legacy:${index}:${content}` : null)
  const rawStatus = value.status ?? value.state
  const status = rawStatus === 'created' ? 'pending' : rawStatus
  const priority = value.priority ?? 'medium'
  const createdAt = value.createdAt === undefined ? undefined : safeInteger(value.createdAt) ? value.createdAt : null
  const updatedAt = value.updatedAt === undefined ? undefined : safeInteger(value.updatedAt) ? value.updatedAt : null
  if (
    !id || !content ||
    typeof status !== 'string' || !TASK_STATUSES.has(status as AgentTaskStatus) ||
    typeof priority !== 'string' || !TASK_PRIORITIES.has(priority as AgentTaskPriority) ||
    createdAt === null || updatedAt === null
  ) return null
  return {
    id,
    content,
    status: status as AgentTaskStatus,
    priority: priority as AgentTaskPriority,
    ...(createdAt !== undefined ? { createdAt } : {}),
    ...(updatedAt !== undefined ? { updatedAt } : {}),
  }
}

function parseScreenshotFile(value: unknown): PaneScreenshotFolder['preview'][number] | null {
  if (!isRecord(value)) return null
  const name = cleanText(value.name, 512)
  if (!name || name.includes('/') || name.includes('\\') || !safeInteger(value.size) || !safeNumber(value.modifiedAt)) return null
  return { name, size: value.size, modifiedAt: value.modifiedAt }
}

function parseScreenshotFolder(value: unknown): PaneScreenshotFolder | null {
  if (!isRecord(value)) return null
  const dir = cleanText(value.dir, 4_096)
  const topic = cleanText(value.topic, 4_096)
  if (
    typeof value.id !== 'string' || !/^[0-9a-f]{16}$/.test(value.id) || !dir || !isAbsolute(dir) || !topic ||
    !safeInteger(value.imageCount) || !safeInteger(value.otherCount) || !safeInteger(value.bytes) ||
    !safeInteger(value.updatedAt) || (value.missing !== undefined && value.missing !== true) ||
    (value.truncated !== undefined && value.truncated !== true) ||
    !Array.isArray(value.preview) || value.preview.length > 6
  ) return null
  const preview = value.preview.map(parseScreenshotFile)
  if (preview.some((file) => file === null)) return null
  return {
    id: value.id,
    dir,
    topic,
    imageCount: value.imageCount,
    otherCount: value.otherCount,
    bytes: value.bytes,
    updatedAt: value.updatedAt,
    ...(value.missing === true ? { missing: true } : {}),
    ...(value.truncated === true ? { truncated: true } : {}),
    preview: preview as PaneScreenshotFolder['preview'],
  }
}

function parseSessionBriefContent(value: unknown): LegacySessionBrief | null {
  if (!isRecord(value)) return null
  const sessionName = cleanText(value.sessionName, 128)
  const headline = cleanText(value.headline, MAX_HEADLINE)
  const recapMarkdown = cleanOptionalText(value.recapMarkdown, MAX_RECAP)
  const next = cleanOptionalText(value.next, MAX_NEXT)
  const taskValues = value.tasks === undefined ? [] : value.tasks
  const screenshotValues = value.screenshots === undefined ? [] : value.screenshots
  if (
    typeof value.sessionId !== 'string' || !SESSION_ID.test(value.sessionId) ||
    sessionName === null || headline === null || recapMarkdown === null || next === null ||
    (value.headlineSource !== 'hook' && value.headlineSource !== 'agent') ||
    typeof value.state !== 'string' || !STATUS_KINDS.has(value.state as AgentStatusKind) ||
    !Array.isArray(taskValues) || taskValues.length > 100 ||
    !Array.isArray(screenshotValues) || screenshotValues.length > 5 ||
    !Array.isArray(value.updates) || value.updates.length > MAX_UPDATES ||
    !safeInteger(value.updatedAt)
  ) return null
  const updates = value.updates.map(parseUpdate)
  if (updates.some((update) => update === null)) return null
  const validUpdates = updates as SessionBriefUpdate[]
  if (new Set(validUpdates.map((update) => update.id)).size !== validUpdates.length) return null
  const tasks = taskValues.map(parseTask)
  if (tasks.some((task) => task === null)) return null
  const validTasks = tasks as AgentTask[]
  if (new Set(validTasks.map((task) => task.id)).size !== validTasks.length) return null
  const screenshots = screenshotValues.map(parseScreenshotFolder)
  if (screenshots.some((folder) => folder === null)) return null
  const validScreenshots = screenshots as PaneScreenshotFolder[]
  if (new Set(validScreenshots.map((folder) => folder.id)).size !== validScreenshots.length) return null
  return {
    sessionId: value.sessionId,
    sessionName,
    state: value.state as AgentStatusKind,
    headline,
    headlineSource: value.headlineSource,
    ...(recapMarkdown ? { recapMarkdown } : {}),
    ...(validTasks.length ? { tasks: validTasks } : {}),
    ...(validScreenshots.length ? { screenshots: validScreenshots } : {}),
    updates: validUpdates,
    ...(next ? { next } : {}),
    updatedAt: value.updatedAt,
  }
}

export function parseSessionBrief(value: unknown): SessionBrief | null {
  if (!isRecord(value) || typeof value.paneId !== 'string' || !PANE_ID.test(value.paneId)) return null
  const content = parseSessionBriefContent(value)
  return content ? { paneId: value.paneId, ...content } : null
}

function migrateLegacyBrief(brief: LegacySessionBrief): SessionBrief[] {
  const updatesByPane = new Map<string, SessionBriefUpdate[]>()
  for (const update of brief.updates) {
    const updates = updatesByPane.get(update.paneId) ?? []
    updates.push(update)
    updatesByPane.set(update.paneId, updates)
  }
  const leadPaneId = brief.updates[0]?.paneId
  return [...updatesByPane].map(([paneId, updates]) => ({
    paneId,
    sessionId: brief.sessionId,
    sessionName: brief.sessionName,
    state: brief.state,
    headline: updates[0]?.text ?? brief.headline,
    headlineSource: updates[0]?.source ?? brief.headlineSource,
    ...(paneId === leadPaneId && brief.recapMarkdown ? { recapMarkdown: brief.recapMarkdown } : {}),
    updates,
    ...(paneId === leadPaneId && brief.next ? { next: brief.next } : {}),
    updatedAt: Math.max(...updates.map((update) => update.createdAt)),
  }))
}

function parseState(value: unknown): StateFile {
  if (!isRecord(value) || (value.version !== 1 && value.version !== 2 && value.version !== 3) || !isRecord(value.briefs)) {
    throw new Error('Session brief state file has an invalid structure')
  }
  const briefs: Record<string, SessionBrief> = Object.create(null)
  if (value.version === 1) {
    for (const [sessionId, candidate] of Object.entries(value.briefs)) {
      const brief = parseSessionBriefContent(candidate)
      if (!brief || brief.sessionId !== sessionId) {
        throw new Error(`Session brief state contains an invalid entry for ${sessionId}`)
      }
      for (const migrated of migrateLegacyBrief(brief)) briefs[migrated.paneId] = migrated
    }
  } else {
    for (const [paneId, candidate] of Object.entries(value.briefs)) {
      const brief = parseSessionBrief(candidate)
      if (!brief || brief.paneId !== paneId) {
        throw new Error(`Session brief state contains an invalid entry for ${paneId}`)
      }
      briefs[paneId] = brief
    }
  }
  return { version: 3, briefs }
}

function cloneBrief(brief: SessionBrief): SessionBrief {
  return {
    ...brief,
    ...(brief.tasks ? { tasks: brief.tasks.map((task) => ({ ...task })) } : {}),
    ...(brief.screenshots ? { screenshots: brief.screenshots.map((folder) => ({ ...folder, preview: folder.preview.map((file) => ({ ...file })) })) } : {}),
    updates: brief.updates.map((update) => ({ ...update })),
  }
}

function statusHeadline(status: AgentStatus): string {
  return status.details?.recap?.summary
    ?? status.details?.attention
    ?? status.details?.currentActivity?.label
    ?? status.details?.intent
    ?? status.summary
}

function statusUpdate(status: AgentStatus): SessionBriefUpdate | null {
  const recap = status.details?.recap
  const attention = status.details?.attention
  const check = status.details?.checks.find((candidate) => candidate.status === 'failed')
    ?? status.details?.checks.find((candidate) => candidate.status === 'running')
    ?? status.details?.checks[0]
  const changes = status.details?.changes
  const activity = status.details?.currentActivity
  const meaningfulActivity = activity && (
    activity.kind === 'edit' ||
    activity.kind === 'check' ||
    activity.kind === 'delegate' ||
    activity.kind === 'task'
  ) ? activity : undefined
  const kind: SessionBriefUpdateKind = status.status === 'failed' || status.status === 'needs_input'
    ? 'blocker'
    : check
      ? 'check'
      : meaningfulActivity?.kind === 'edit' || changes?.fileCount
        ? 'changed'
        : 'note'
  const text = recap?.summary
    ?? attention
    ?? (check ? `${check.label}: ${check.status}` : undefined)
    ?? meaningfulActivity?.label
    ?? status.details?.intent
  if (!text) return null
  const author = !recap && !attention && !check && !meaningfulActivity && status.details?.intent
    ? 'user' as const
    : undefined
  const detail = changes?.fileCount
    ? `${changes.fileCount} ${changes.fileCount === 1 ? 'file' : 'files'} · +${changes.additions} −${changes.deletions}`
    : undefined
  return {
    id: `hook:${status.paneId.slice(1)}:${status.updatedAt}:${randomUUID()}`,
    paneId: status.paneId,
    kind,
    text: text.slice(0, MAX_UPDATE_TEXT),
    ...(detail ? { detail } : {}),
    ...(author ? { author } : {}),
    source: 'hook',
    createdAt: status.updatedAt,
  }
}

function taskTransitionUpdates(
  previous: AgentTask[] | undefined,
  current: AgentTask[] | undefined,
  status: AgentStatus,
): SessionBriefUpdate[] {
  if (!previous?.length || !current?.length) return []
  const previousById = new Map(previous.map((task) => [task.id, task]))
  return current.flatMap((task) => {
    const before = previousById.get(task.id)
    if (!before || before.status === task.status) return []
    const prefix = task.status === 'completed'
      ? 'Task completed'
      : task.status === 'in_progress'
        ? 'Task started'
        : task.status === 'cancelled'
          ? 'Task cancelled'
          : 'Task queued'
    return [{
      id: `hook:${status.paneId.slice(1)}:${status.updatedAt}:${randomUUID()}`,
      paneId: status.paneId,
      kind: task.status === 'completed' ? 'check' as const : 'note' as const,
      text: `${prefix}: ${task.content}`.slice(0, MAX_UPDATE_TEXT),
      source: 'hook' as const,
      createdAt: status.updatedAt,
    }]
  })
}

function sameUpdateMeaning(left: SessionBriefUpdate, right: SessionBriefUpdate): boolean {
  if (left.source !== right.source || left.author !== right.author || left.text !== right.text) return false
  // Lifecycle state can promote the same semantic event from note to changed,
  // blocker, or check as more metadata arrives. Keep the newest projection.
  return left.source === 'hook' || (left.kind === right.kind && left.detail === right.detail)
}

function appendUpdate(
  updates: SessionBriefUpdate[],
  update: SessionBriefUpdate,
): SessionBriefUpdate[] {
  const retained = update.source === 'hook'
    ? updates.filter((candidate) => !sameUpdateMeaning(candidate, update))
    : updates
  return [...retained, update]
    .sort((left, right) => right.createdAt - left.createdAt)
    .slice(0, MAX_UPDATES)
}

function dedupeUpdates(updates: SessionBriefUpdate[]): SessionBriefUpdate[] {
  return [...updates]
    .sort((left, right) => right.createdAt - left.createdAt)
    .reduce((retained, update) => (
      update.source === 'hook' && retained.some((candidate) => sameUpdateMeaning(candidate, update))
        ? retained
        : [...retained, update]
    ), [] as SessionBriefUpdate[])
    .slice(0, MAX_UPDATES)
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
        this.briefs.set(brief.paneId, { ...brief, updates: dedupeUpdates(brief.updates) })
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      if (error instanceof SyntaxError) {
        throw new Error('Session brief state file contains invalid JSON', { cause: error })
      }
      throw error
    }
  }

  get(paneId: string): SessionBrief | null {
    const brief = this.briefs.get(paneId)
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
  ): Promise<SessionBrief[]> {
    if (!SESSION_ID.test(sessionId)) throw new Error('Invalid tmux session id')
    const cleanSessionName = cleanText(sessionName, 128)
    if (!cleanSessionName) throw new Error('Invalid tmux session name')
    const changed: SessionBrief[] = []
    const livePaneIds = new Set(statuses.map((status) => status.paneId))
    for (const status of statuses) {
      if (!PANE_ID.test(status.paneId)) continue
      const previous = this.briefs.get(status.paneId)
      const current = previous?.sessionId === sessionId && previous.sessionName === cleanSessionName
        ? previous
        : undefined
      const statusEvent = statusUpdate(status)
      const taskEvents = taskTransitionUpdates(current?.tasks, status.details?.tasks, status)
      const updates = [...taskEvents, ...(statusEvent ? [statusEvent] : [])]
        .reduce(appendUpdate, current?.updates ?? [])
      const recap = current?.recapMarkdown ?? status.details?.recap?.summary
      const brief: SessionBrief = {
        paneId: status.paneId,
        sessionId,
        sessionName: cleanSessionName,
        state: status.status,
        headline: current?.headlineSource === 'agent'
          ? current.headline
          : statusHeadline(status).slice(0, MAX_HEADLINE),
        headlineSource: current?.headlineSource === 'agent' ? 'agent' : 'hook',
        ...(recap ? { recapMarkdown: recap.slice(0, MAX_RECAP) } : {}),
        ...(status.details?.tasks !== undefined
          ? { tasks: status.details.tasks.map((task) => ({ ...task })) }
          : current?.tasks !== undefined
            ? { tasks: current.tasks.map((task) => ({ ...task })) }
            : {}),
        ...(current?.screenshots?.length ? { screenshots: current.screenshots.map((folder) => ({ ...folder, preview: folder.preview.map((file) => ({ ...file })) })) } : {}),
        updates,
        ...(current?.next ? { next: current.next } : {}),
        updatedAt: Math.max(now, status.updatedAt),
      }
      if (!current && !brief.tasks?.length && brief.updates.length === 0) continue
      this.briefs.set(status.paneId, brief)
      changed.push(brief)
    }
    for (const current of this.briefs.values()) {
      if (
        current.sessionId !== sessionId ||
        current.sessionName !== cleanSessionName ||
        livePaneIds.has(current.paneId) ||
        current.state === 'stale'
      ) continue
      const brief = { ...current, state: 'stale' as const, updatedAt: now }
      this.briefs.set(current.paneId, brief)
      changed.push(brief)
    }
    if (changed.length === 0) return []
    this.prune()
    await this.persist()
    return changed.map(cloneBrief)
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
    const previous = this.briefs.get(paneId)
    const current = previous?.sessionId === sessionId && previous.sessionName === cleanSessionName
      ? previous
      : undefined
    const update = patch.update ? {
      id: `agent:${now}:${randomUUID()}`,
      paneId,
      kind: patch.update.kind,
      text: patch.update.text,
      ...(patch.update.detail ? { detail: patch.update.detail } : {}),
      source: 'agent' as const,
      createdAt: now,
    } : null
    const published = patch.publishedScreenshots
    const previousPublished = published
      ? current?.screenshots?.find((folder) => folder.id === published.id)
      : undefined
    const previewFingerprint = (folder: PaneScreenshotFolder | undefined) => folder?.preview
      .map((file) => `${file.name}\0${file.modifiedAt}`)
      .join('\0')
    const screenshotUpdate: SessionBriefUpdate | null = published && (
      !previousPublished || previewFingerprint(previousPublished) !== previewFingerprint(published)
    )
      ? {
          id: `agent:${now}:${randomUUID()}`,
          paneId,
          kind: 'screenshots',
          screenshotFolderId: published.id,
          text: `Published ${published.topic} · ${published.imageCount} images`,
          detail: published.dir.startsWith(`${homedir()}/`) ? `~/${published.dir.slice(homedir().length + 1)}` : published.dir,
          source: 'agent',
          createdAt: now,
        }
      : null
    const previousUpdates = current?.updates ?? []
    const headline = patch.headline
      ?? current?.headline
      ?? patch.update?.text
      ?? screenshotUpdate?.text
      ?? patch.next
      ?? 'Session update'
    const brief: SessionBrief = {
      paneId,
      sessionId,
      sessionName: cleanSessionName,
      state: patch.state ?? current?.state ?? 'working',
      headline,
      headlineSource: patch.headline
        ? 'agent'
        : current?.headlineSource
          ?? (patch.update?.text ? 'agent' : screenshotUpdate?.text ? 'hook' : 'agent'),
      ...(patch.recapMarkdown === null
        ? {}
        : patch.recapMarkdown !== undefined
          ? { recapMarkdown: patch.recapMarkdown }
          : current?.recapMarkdown
            ? { recapMarkdown: current.recapMarkdown }
            : {}),
      ...(current?.tasks?.length ? { tasks: current.tasks.map((task) => ({ ...task })) } : {}),
      ...(published
        ? { screenshots: [published, ...(current?.screenshots ?? []).filter((folder) => folder.id !== published.id)].slice(0, 5) }
        : current?.screenshots?.length
          ? { screenshots: current.screenshots.map((folder) => ({ ...folder, preview: folder.preview.map((file) => ({ ...file })) })) }
          : {}),
      updates: [screenshotUpdate, update].filter((entry): entry is SessionBriefUpdate => entry !== null)
        .reduce(appendUpdate, previousUpdates),
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
    this.briefs.set(paneId, validated)
    this.prune()
    await this.persist()
    return cloneBrief(validated)
  }

  async removeMissingSessions(sessionIds: Iterable<string>): Promise<boolean> {
    const retained = new Set(sessionIds)
    let changed = false
    for (const [paneId, brief] of this.briefs) {
      if (retained.has(brief.sessionId)) continue
      this.briefs.delete(paneId)
      changed = true
    }
    if (changed) await this.persist()
    return changed
  }

  private prune(): void {
    if (this.briefs.size <= MAX_BRIEFS) return
    const retained = [...this.briefs.values()]
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, MAX_BRIEFS)
    this.briefs.clear()
    for (const brief of retained) this.briefs.set(brief.paneId, brief)
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
      const briefs = Object.fromEntries([...this.briefs].map(([paneId, brief]) => [paneId, brief]))
      await handle.writeFile(`${JSON.stringify({ version: 3, briefs }, null, 2)}\n`, 'utf8')
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
