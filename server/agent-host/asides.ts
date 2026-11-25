import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  asideKey, parseChatAsideRecords,
  type ChatAsideAction, type ChatAsideInfo, type ChatAsideRecord, type ChatAsideResult, type ChatForkPoint,
} from '../../shared/agent-chat.js'
import { asideBrief, asideEnv } from './aside-brief.js'
import { createChatProviderSession } from './factory.js'
import type { ChatProviderSession } from './provider.js'
import type { AgentSessionSpec } from './session.js'

export class AsideStore {
  constructor(private readonly directory = process.env.COMMANDO_ASIDES_DIR ?? join(homedir(), '.commando', 'asides')) {}
  private path(sessionId: string): string { return join(this.directory, `${encodeURIComponent(sessionId)}.json`) }
  async load(sessionId: string): Promise<ChatAsideRecord[]> {
    let raw: string
    try { raw = await readFile(this.path(sessionId), 'utf8') }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
    const value: unknown = JSON.parse(raw)
    const records = typeof value === 'object' && value !== null && 'version' in value && value.version === 1 && 'asides' in value
      ? parseChatAsideRecords(value.asides) : null
    if (!records) throw new Error('Invalid saved aside records')
    return records
  }
  async save(sessionId: string, asides: ChatAsideRecord[]): Promise<void> {
    await mkdir(this.directory, { recursive: true })
    const path = this.path(sessionId)
    const temporary = `${path}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, JSON.stringify({ version: 1, asides }), { mode: 0o600, flag: 'wx' })
      await rename(temporary, path)
    } finally { await rm(temporary, { force: true }) }
  }
  async quarantine(sessionId: string): Promise<void> {
    const path = this.path(sessionId)
    try { await rename(path, `${path}.bad-${Date.now()}`) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
}

type AsideHost = {
  add(session: ChatProviderSession): void
  remove(key: string): void
  changed(asides: ChatAsideRecord[]): void
  activity?(): void
  log(error: unknown): void
}

/** One serial lifecycle per main conversation; provider turns still run in parallel. */
export class ChatAsides {
  private records: ChatAsideRecord[] = []
  private mainId?: string
  private sessions = new Map<string, ChatProviderSession>()
  private operations: Promise<unknown> = Promise.resolve()
  private stopped = false
  private loadError?: Error
  private readonly loggedLoadErrors = new Set<string>()
  private pendingOperations = 0

  constructor(
    private readonly main: ChatProviderSession,
    private readonly spec: AgentSessionSpec,
    private readonly host: AsideHost,
    private readonly store = new AsideStore(),
    private readonly create = createChatProviderSession,
  ) {}

  list(): ChatAsideRecord[] { return structuredClone(this.records) }
  get busy(): boolean { return this.pendingOperations > 0 || [...this.sessions.values()].some((session) => session.busy) }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    this.pendingOperations++
    const result = this.operations.then(operation).finally(() => {
      this.pendingOperations--
      this.host.activity?.()
    })
    this.operations = result.catch((error: unknown) => this.host.log(error))
    return result
  }
  sync(): Promise<void> { return this.serial(() => this.loadConversation()) }
  publish(): void { this.host.changed(this.list()) }
  stop(): void {
    this.stopped = true
    this.closeSessions()
  }
  private closeSessions(): void {
    for (const [id, session] of this.sessions) {
      this.sessions.delete(id)
      this.host.remove(asideKey(this.main.paneId, id))
      session.close()
    }
  }
  private async loadConversation(): Promise<void> {
    if (this.stopped) return
    const id = this.main.snapshot().session.sessionId
    if (id === this.mainId) return
    this.closeSessions()
    this.mainId = id
    this.records = []
    this.loadError = undefined
    this.publish()
    if (!id) return
    try { this.records = await this.store.load(id) }
    catch (error) {
      this.loadError = error instanceof Error ? error : new Error(String(error))
      if (!this.loggedLoadErrors.has(id)) {
        this.loggedLoadErrors.add(id)
        this.host.log(this.loadError)
      }
      return
    }
    if (this.stopped) return
    if (this.main.snapshot().session.sessionId !== id) return this.loadConversation()
    for (const record of this.records) {
      if (record.status !== 'open') continue
      try {
        if (!record.sessionId) throw new Error(`Aside ${record.title} has no saved session yet`)
        await this.start(record, { resume: record.sessionId })
      } catch (error) {
        record.status = 'closed'
        record.closedAt = Date.now()
        this.host.log(error)
      }
    }
    if (this.records.length) await this.save()
    else this.publish()
  }
  private async save(): Promise<void> {
    if (this.stopped) return
    if (this.mainId) await this.store.save(this.mainId, this.records)
    this.publish()
  }
  private forkPoint(): ChatForkPoint {
    const info = this.main.snapshot().session
    const point = this.main.forkPoint ? this.main.forkPoint() : info.sessionId ? { sessionId: info.sessionId } : null
    if (!point) throw new Error('This chat has no saved conversation yet')
    return point
  }
  private room(): void {
    if (this.sessions.size >= 5) throw new Error('A chat can have at most 5 open asides')
  }
  private info(record: ChatAsideRecord): ChatAsideInfo {
    const { id, title, mode, method, readOnlyEnforced, forkedFrom, createdAt } = record
    return { parentPaneId: this.main.paneId, id, title, mode, method, readOnlyEnforced, forkedFrom, createdAt }
  }
  private async start(record: ChatAsideRecord, options: { resume?: string; fork?: ChatForkPoint; text?: string; images?: AgentSessionSpec['initialImages'] }): Promise<void> {
    this.room()
    const main = this.main.snapshot().session
    const context = this.main.snapshot().items
    const readOnly = record.mode === 'read-only'
    const permissionMode = readOnly ? 'default' : main.permissionMode ?? this.spec.permissionMode
    const spec: AgentSessionSpec = {
      ...this.spec,
      paneId: asideKey(this.main.paneId, record.id),
      env: asideEnv(this.spec.env, record.id),
      resume: options.resume, fork: options.fork,
      aside: this.info(record), readOnly,
      permissionMode: permissionMode as AgentSessionSpec['permissionMode'],
      model: main.selectedModel ?? this.spec.model, effort: main.effort, fast: main.fast,
      bypassAllowed: !readOnly && main.bypassAllowed,
      fullAccess: !readOnly && this.spec.fullAccess,
      prePlanPermissionMode: undefined, resumeCommand: undefined, returnedFromClaudeCode: undefined,
      initialPrompt: undefined, initialImages: undefined,
    }
    const session = await this.create(main.provider, spec)
    if (this.stopped || main.sessionId !== this.main.snapshot().session.sessionId) { session.close(); throw new Error('The main conversation changed') }
    this.sessions.set(record.id, session)
    const mainId = this.mainId
    session.on('session', (info) => {
      if (!info.sessionId || this.sessions.get(record.id) !== session || mainId !== this.mainId || this.stopped) return
      if (record.sessionId === info.sessionId) return
      record.sessionId = info.sessionId
      void this.serial(() => this.save())
    })
    session.on('restart', () => {
      void this.act({ action: 'mode', asideId: record.id, mode: record.mode }).then((result) => { if (!result.ok) this.host.log(result.error) })
    })
    session.on('closed', () => {
      if (this.sessions.get(record.id) !== session) return
      this.sessions.delete(record.id)
      this.host.remove(session.paneId)
      // Keep the record open so its tab can offer Reopen after a crash.
      this.publish()
      this.host.activity?.()
    })
    this.host.add(session)
    try {
      await session.start()
      if (this.stopped || main.sessionId !== this.main.snapshot().session.sessionId) throw new Error('The main conversation changed')
      const state = session.snapshot().session
      if (state.status === 'error' || state.status === 'closed') throw new Error(state.error ?? 'The aside could not start')
      if (state.sessionId) record.sessionId = state.sessionId
      if (options.text !== undefined || options.fork && record.method === 'brief') {
        const text = options.text ?? record.title
        const prompt = !options.resume && record.method === 'brief'
          ? `${asideBrief(context, record.mode)}\n---\n${text}` : text
        session.send(prompt, options.images)
      }
    } catch (error) {
      if (this.sessions.get(record.id) === session) {
        this.sessions.delete(record.id)
        this.host.remove(session.paneId)
      }
      session.close()
      throw error
    }
  }
  private async end(record: ChatAsideRecord): Promise<void> {
    const session = this.sessions.get(record.id)
    if (!session) return
    // Remove ownership before interrupting, so late events cannot resurrect this session.
    this.sessions.delete(record.id)
    try { await session.interrupt(session.queued.map((message) => message.id)) }
    catch (error) { this.host.log(error) }
    finally {
      record.sessionId = session.snapshot().session.sessionId ?? record.sessionId
      this.host.remove(session.paneId)
      session.close()
    }
  }
  act(action: ChatAsideAction): Promise<ChatAsideResult> {
    return this.serial(async () => {
      try {
        if (this.stopped) throw new Error('The main chat is closed')
        await this.loadConversation()
        if (action.action === 'open') {
          if (this.loadError && this.mainId) {
            await this.store.quarantine(this.mainId)
            this.loadError = undefined
          }
          this.room()
          const point = this.forkPoint()
          const provider = this.main.snapshot().session.provider
          let id: string
          do { id = randomBytes(4).toString('hex') } while (this.records.some((record) => record.id === id))
          const record: ChatAsideRecord = {
            id, title: action.text.trim().split('\n')[0]?.slice(0, 60) || 'Aside', mode: action.mode ?? 'read-only',
            method: provider === 'cursor' || provider === 'muse' ? 'brief' : 'fork',
            readOnlyEnforced: provider !== 'cursor',
            forkedFrom: point, status: 'open', createdAt: Date.now(),
          }
          this.records.push(record)
          try {
            await this.save()
            await this.start(record, { ...(record.method === 'fork' ? { fork: point } : {}), text: action.text, images: action.images })
            await this.save()
          } catch (error) {
            await this.end(record)
            this.records = this.records.filter((entry) => entry !== record)
            await this.save()
            throw error
          }
          return { ok: true, asideId: id }
        }
        const record = this.records.find((entry) => entry.id === action.asideId)
        if (!record) throw new Error('No such aside')
        if (action.action === 'close') {
          await this.end(record)
          record.status = 'closed'
          record.closedAt = Date.now()
        } else {
          if (record.status === 'closed' && action.action === 'mode') {
            record.mode = action.mode
          } else {
            if (!this.sessions.has(record.id)) this.room()
            const point = action.action === 'refork' ? this.forkPoint() : undefined
            if (!point && !record.sessionId) throw new Error('This aside has no saved conversation yet; refork it to start again')
            if (action.action === 'reopen' && this.sessions.has(record.id)) return { ok: true, asideId: record.id }
            await this.end(record)
            if (action.action === 'mode') record.mode = action.mode
            if (point) { record.forkedFrom = point; delete record.sessionId }
            record.status = 'open'
            delete record.closedAt
            try {
              await this.start(record, point ? { fork: record.method === 'fork' ? point : undefined, ...(record.method === 'brief' ? { text: record.title } : {}) } : { resume: record.sessionId })
            } catch (error) { record.status = 'closed'; record.closedAt = Date.now(); await this.save(); throw error }
          }
        }
        await this.save()
        return { ok: true, asideId: record.id }
      } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
    })
  }
}
