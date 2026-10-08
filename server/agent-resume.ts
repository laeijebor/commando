import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { isCommandoTargetId } from '../shared/pane-target.js'
import type { AgentResume, AgentStatus, TmuxPane } from '../shared/protocol.js'
import {
  buildResumeCommand,
  findAgentProcess,
  isResumableProvider,
  isShellCommand,
  isValidAgentSessionId,
  launchFromProcess,
  parseProcessTable,
  type ResumableProvider,
} from './agent-resume-command.js'

/** What Commando needs to bring an agent conversation back in a pane. */
export type AgentResumeRecord = {
  targetId: string
  provider: ResumableProvider
  sessionId: string
  path: string
  command: string
  /** tmux server (`pid:start_time`) the agent last ran on, or `archived`. */
  serverId: string
  /** tmux server a resume was last attempted on, so each restore is tried once. */
  attemptedServerId?: string
  updatedAt: number
}

/** The part of a record an archived session keeps. */
export type ArchivedAgent = Pick<AgentResumeRecord, 'provider' | 'sessionId' | 'path' | 'command'>

export type ResumePane = Pick<TmuxPane, 'id' | 'targetId' | 'sessionId' | 'command' | 'path' | 'processId' | 'active'>

export const ARCHIVED_SERVER_ID = 'archived'
const MAX_RECORDS = 512
const RECORD_TTL_MS = 30 * 24 * 60 * 60 * 1_000
/** A restored shell needs a moment before it reads typed input. */
const SHELL_READY_MS = 4_000
const STAGGER_MS = 2_500
const VERIFY_MS = 20_000
const RESUMED_RETENTION_MS = 5 * 60 * 1_000
/** How long to wait before reading the process table again for a pane whose agent was not found. */
const CAPTURE_RETRY_MS = 30_000

export function defaultAgentResumePath(): string {
  if (process.env.COMMANDO_AGENT_RESUME_PATH) return process.env.COMMANDO_AGENT_RESUME_PATH
  // A verification daemon on another tmux server must never resume the user's agents.
  const socket = process.env.COMMANDO_TMUX_SOCKET_PATH
    ? `path:${process.env.COMMANDO_TMUX_SOCKET_PATH}`
    : process.env.COMMANDO_TMUX_SOCKET_NAME && process.env.COMMANDO_TMUX_SOCKET_NAME !== 'default'
      ? `name:${process.env.COMMANDO_TMUX_SOCKET_NAME}` : undefined
  const suffix = socket ? `-${createHash('sha256').update(socket).digest('hex').slice(0, 16)}` : ''
  return join(homedir(), '.commando', `agent-resume${suffix}.json`)
}

function runPs(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('ps', args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 5_000 }, (error, stdout) => {
      if (error) reject(error)
      else resolve(stdout)
    })
  })
}

export const readProcessTable = (): Promise<string> => runPs(['-axwwo', 'pid=,ppid=,args='])

/** argv followed by the environment. It can hold secrets: read named variables only, never log it. */
export const readProcessEnvironment = (pid: number): Promise<string> => runPs(['-Eww', '-o', 'command=', '-p', String(pid)])

function validRecord(value: unknown): value is AgentResumeRecord {
  if (!value || typeof value !== 'object') return false
  const record = value as AgentResumeRecord
  return isCommandoTargetId(record.targetId)
    && typeof record.provider === 'string' && isResumableProvider(record.provider)
    && typeof record.sessionId === 'string' && isValidAgentSessionId(record.sessionId)
    && typeof record.path === 'string' && record.path.startsWith('/') && !record.path.includes('\0')
    && typeof record.command === 'string' && record.command.length > 0 && record.command.length <= 2_000
    && !/[\u0000-\u001f\u007f]/u.test(record.command)
    && typeof record.serverId === 'string' && record.serverId.length > 0
    && (record.attemptedServerId === undefined || typeof record.attemptedServerId === 'string')
    && Number.isFinite(record.updatedAt)
}

export function validArchivedAgent(value: unknown): value is ArchivedAgent {
  return validRecord({ ...(value as object), targetId: '00000000-0000-4000-8000-000000000000', serverId: ARCHIVED_SERVER_ID, updatedAt: 0 })
}

export type AgentResumeDeps = {
  statePath?: string
  readProcessTable?: () => Promise<string>
  readProcessEnvironment?: (pid: number) => Promise<string>
  /** The pane with this target in the latest snapshot. */
  currentPane: (targetId: string) => ResumePane | undefined
  /** Types the command and presses Enter. */
  sendCommand: (pane: ResumePane, command: string) => Promise<void>
  pathExists: (path: string) => Promise<boolean>
  onChange: (change: { type: 'upsert'; resume: AgentResume } | { type: 'remove'; targetId: string }) => void
  now?: () => number
  setTimer?: (callback: () => void, ms: number) => void
  onError?: (error: unknown) => void
}

type Job = { targetId: string; notBefore: number; active: boolean }

/**
 * Remembers which conversation each pane target runs and resumes it when tmux restores the
 * pane on a new server. An agent that exits while its tmux server lives was ended on purpose,
 * so its record is cleared; a server restart never gets that chance.
 */
export class AgentResumeService {
  readonly statePath: string
  private records = new Map<string, AgentResumeRecord>()
  private readonly resumes = new Map<string, AgentResume>()
  private readonly capturing = new Set<string>()
  private readonly captureMisses = new Map<string, { key: string; at: number }>()
  private queue: Job[] = []
  private draining = false
  private lastSentAt = 0
  private writes: Promise<void> = Promise.resolve()
  private readonly now: () => number
  private readonly setTimer: (callback: () => void, ms: number) => void
  private readonly onError: (error: unknown) => void

  constructor(private readonly deps: AgentResumeDeps) {
    this.statePath = deps.statePath ?? defaultAgentResumePath()
    this.now = deps.now ?? Date.now
    this.setTimer = deps.setTimer ?? ((callback, ms) => { setTimeout(callback, ms).unref() })
    this.onError = deps.onError ?? (() => {})
  }

  async load(): Promise<void> {
    try {
      const state = JSON.parse(await readFile(this.statePath, 'utf8'))
      if (state?.version !== 1 || !Array.isArray(state.records)) throw new Error('Invalid agent resume state')
      const cutoff = this.now() - RECORD_TTL_MS
      for (const record of state.records) {
        if (validRecord(record) && record.updatedAt >= cutoff) this.records.set(record.targetId, record)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.onError(error)
    }
  }

  get(targetId: string): AgentResumeRecord | undefined {
    return this.records.get(targetId)
  }

  snapshot(): AgentResume[] {
    return [...this.resumes.values()]
  }

  /** Records the conversation a hook reported for a pane. Only reads the process table when it changed. */
  async observeHookStatus(status: AgentStatus, pane: ResumePane | undefined, serverId: string | null): Promise<void> {
    if (status.source !== 'hook' || !pane || !serverId || pane.processId === undefined) return
    if (!isResumableProvider(status.provider) || !status.agentSessionId || !isValidAgentSessionId(status.agentSessionId)) return
    const existing = this.records.get(pane.targetId)
    const resume = this.resumes.get(pane.targetId)
    if (resume && resume.state !== 'resumed' && existing?.sessionId === status.agentSessionId) {
      this.setResume({ ...resume, state: 'resumed', error: undefined })
    }
    if (existing?.sessionId === status.agentSessionId && existing.provider === status.provider
      && existing.serverId === serverId && existing.path === pane.path) return
    if (this.capturing.has(pane.targetId)) return
    const key = `${status.provider}:${status.agentSessionId}@${serverId}:${pane.processId}`
    const miss = this.captureMisses.get(pane.targetId)
    if (miss?.key === key && this.now() - miss.at < CAPTURE_RETRY_MS) return
    this.capturing.add(pane.targetId)
    try {
      const rows = parseProcessTable(await (this.deps.readProcessTable ?? readProcessTable)())
      const agent = findAgentProcess(rows, pane.processId, status.provider)
      const command = agent && buildResumeCommand(status.provider, status.agentSessionId, launchFromProcess(
        status.provider, agent.args, await (this.deps.readProcessEnvironment ?? readProcessEnvironment)(agent.pid)))
      if (!command) {
        this.captureMisses.set(pane.targetId, { key, at: this.now() })
        return
      }
      this.captureMisses.delete(pane.targetId)
      this.records.set(pane.targetId, {
        targetId: pane.targetId,
        provider: status.provider,
        sessionId: status.agentSessionId,
        path: pane.path,
        command,
        serverId,
        updatedAt: this.now(),
      })
      this.persist()
    } finally {
      this.capturing.delete(pane.targetId)
    }
  }

  /**
   * Runs after every discovery: records the agents panes are running, clears deliberate exits,
   * and queues restored panes. Status changes alone are not enough to record: a resumed agent
   * reports the same session, so the registry sees nothing new.
   */
  reconcile(panes: readonly ResumePane[], serverId: string, statusFor: (paneId: string) => AgentStatus | undefined = () => undefined): void {
    let changed = false
    const queued: Job[] = []
    for (const pane of panes) {
      const status = statusFor(pane.id)
      if (status && !isShellCommand(pane.command)) void this.observeHookStatus(status, pane, serverId).catch(this.onError)
      const record = this.records.get(pane.targetId)
      if (!record || !isShellCommand(pane.command)) continue
      if (record.serverId === serverId) {
        this.records.delete(pane.targetId)
        changed = true
      } else if (record.attemptedServerId !== serverId) {
        record.attemptedServerId = serverId
        changed = true
        queued.push({ targetId: pane.targetId, notBefore: this.now() + SHELL_READY_MS, active: pane.active })
      }
    }
    if (changed) this.persist()
    this.enqueue(queued)
  }

  /** The agents an archive should keep for these targets. */
  archivedAgents(targetIds: readonly string[]): Record<string, ArchivedAgent> {
    const agents: Record<string, ArchivedAgent> = {}
    for (const targetId of targetIds) {
      const record = this.records.get(targetId)
      if (record) agents[targetId] = { provider: record.provider, sessionId: record.sessionId, path: record.path, command: record.command }
    }
    return agents
  }

  /** Drops records whose panes were archived; the archive now holds them. */
  forgetTargets(targetIds: readonly string[]): void {
    let changed = false
    for (const targetId of targetIds) changed = this.records.delete(targetId) || changed
    if (changed) this.persist()
  }

  /** Puts archived agents back; the next discovery queues them like any restored pane. */
  restoreArchived(agents: Readonly<Record<string, ArchivedAgent>>): void {
    for (const [targetId, agent] of Object.entries(agents)) {
      if (!isCommandoTargetId(targetId) || !validArchivedAgent(agent)) continue
      this.records.set(targetId, { ...agent, targetId, serverId: ARCHIVED_SERVER_ID, updatedAt: this.now() })
    }
    this.persist()
  }

  /** Retries one failed resume, or every failed one. */
  retry(targetId?: string): number {
    const failed = [...this.resumes.values()].filter((resume) =>
      resume.state === 'failed' && (targetId === undefined || resume.targetId === targetId) && this.records.has(resume.targetId))
    this.enqueue(failed.map((resume) => ({ targetId: resume.targetId, notBefore: this.now(), active: true })))
    return failed.length
  }

  private enqueue(jobs: Job[]): void {
    if (jobs.length === 0) return
    const queuedIds = new Set(this.queue.map((job) => job.targetId))
    for (const job of jobs) {
      if (queuedIds.has(job.targetId)) continue
      const record = this.records.get(job.targetId)
      const pane = this.deps.currentPane(job.targetId)
      if (!record || !pane) continue
      this.queue.push(job)
      this.setResume({
        targetId: job.targetId,
        paneId: pane.id,
        provider: record.provider,
        command: record.command,
        state: 'queued',
        updatedAt: this.now(),
      })
    }
    // Panes the user is looking at come back first.
    this.queue.sort((left, right) => Number(right.active) - Number(left.active))
    this.drain()
  }

  private drain(): void {
    if (this.draining) return
    const job = this.queue[0]
    if (!job) return
    const wait = Math.max(job.notBefore - this.now(), this.lastSentAt + STAGGER_MS - this.now(), 0)
    this.draining = true
    this.setTimer(() => {
      this.queue.shift()
      void this.run(job).catch(this.onError).finally(() => {
        this.draining = false
        this.drain()
      })
    }, wait)
  }

  private async run(job: Job): Promise<void> {
    const record = this.records.get(job.targetId)
    const pane = this.deps.currentPane(job.targetId)
    const resume = this.resumes.get(job.targetId)
    if (!record || !resume) return
    if (!pane) return this.fail(resume, 'The pane is gone.')
    // Someone already started something here; leave it alone.
    if (!isShellCommand(pane.command)) return this.dropResume(job.targetId)
    if (!(await this.deps.pathExists(record.path))) return this.fail(resume, `The folder no longer exists: ${record.path}`)
    this.lastSentAt = this.now()
    await this.deps.sendCommand(pane, record.command)
    this.setResume({ ...resume, paneId: pane.id, state: 'resuming', error: undefined })
    this.setTimer(() => this.verify(job.targetId), VERIFY_MS)
  }

  private verify(targetId: string): void {
    const resume = this.resumes.get(targetId)
    if (resume?.state !== 'resuming') return
    const pane = this.deps.currentPane(targetId)
    if (pane && !isShellCommand(pane.command)) this.setResume({ ...resume, state: 'resumed' })
    else this.fail(resume, 'The agent did not start. Check the pane for errors.')
  }

  private fail(resume: AgentResume, error: string): void {
    this.setResume({ ...resume, state: 'failed', error })
  }

  private dropResume(targetId: string): void {
    if (this.resumes.delete(targetId)) this.deps.onChange({ type: 'remove', targetId })
  }

  private setResume(resume: AgentResume): void {
    const next = { ...resume, updatedAt: this.now() }
    if (next.error === undefined) delete next.error
    this.resumes.set(next.targetId, next)
    this.deps.onChange({ type: 'upsert', resume: next })
    if (next.state === 'resumed') {
      this.setTimer(() => {
        if (this.resumes.get(next.targetId) === next) this.dropResume(next.targetId)
      }, RESUMED_RETENTION_MS)
    }
  }

  private persist(): void {
    const records = [...this.records.values()]
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, MAX_RECORDS)
    if (records.length < this.records.size) this.records = new Map(records.map((record) => [record.targetId, record]))
    this.writes = this.writes.then(() => this.write(records)).catch(this.onError)
  }

  /** Resolves once queued writes have reached disk. */
  flush(): Promise<void> {
    return this.writes
  }

  private async write(records: AgentResumeRecord[]): Promise<void> {
    await mkdir(dirname(this.statePath), { recursive: true, mode: 0o700 })
    const temporary = `${this.statePath}.${randomUUID()}.tmp`
    const handle = await open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(`${JSON.stringify({ version: 1, records }, null, 2)}\n`)
      await handle.sync()
      await handle.close()
      await rename(temporary, this.statePath)
    } catch (error) {
      await handle.close().catch(() => undefined)
      await rm(temporary, { force: true }).catch(() => undefined)
      throw error
    }
  }
}
