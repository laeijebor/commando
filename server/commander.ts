import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { CommanderState } from '../shared/commander.js'
import type { CommandoSnapshot } from '../shared/protocol.js'
import { defaultSessionBriefStatePath } from './session-briefs.js'
import type { TmuxCreator } from './tmux-create.js'
import { commanderToolRules } from './commander-tools.js'

export function defaultCommanderStatePath(): string { return `${defaultSessionBriefStatePath()}.commander.json` }
export function commanderInstructions(cliPath: string): string {
  return `You are Commander: the user's single interface to all their agent chats in Commando. Brief them, relay their messages, and help them decide where to look.

Tools (run with node ${JSON.stringify(cliPath)}):
- list [--json]: status of every agent chat, needs-you first.
- read %N [--turns N]: read the latest 1–10 turns of a chat.
- relay %N "message" [--steer]: relay the user's words to a chat.
- nudge %N "message": nudge a stalled agent.
- relays: list recent relay deliveries.
- cancel <id>: cancel a queued relay.

Answer status questions from list first. Use read only for the chats a question is about.
Relay the user's words verbatim with relay; the CLI adds the tag. Delivery defaults to queued until the agent's turn ends. Use --steer only when the user explicitly asks to interrupt.
You may nudge stalled agents on your own with nudge, then tell the user you did. Keep nudges short, for example: "Still there? If you're blocked, say what you need; otherwise continue."
Never answer an agent's question, make a decision for the user, or approve a permission prompt. Flag it and offer to relay the user's answer.
Messages starting with [Commando] are notices from the daemon, not the user.
Keep replies short, outcome first, and name chats by title.
`
}
type Options = {
  statePath?: string; home?: string; cliPath?: string; snapshot: () => CommandoSnapshot
  creator: Pick<TmuxCreator, 'createSession'>; refreshSnapshot: () => Promise<unknown>
  changed: (state: CommanderState) => void
}
export class Commander {
  private targetId: string | null = null
  private lastState = ''
  private operations: Promise<unknown> = Promise.resolve()
  private readonly statePath: string
  private readonly cwd: string
  constructor(private readonly options: Options) {
    this.statePath = options.statePath ?? defaultCommanderStatePath()
    this.cwd = join(options.home ?? homedir(), '.commando', 'commander')
  }
  state(): CommanderState {
    const pane = this.options.snapshot().panes.find((p) => p.targetId === this.targetId && !p.dead)
    return { targetId: this.targetId, ...(pane ? { paneId: pane.id, sessionId: pane.sessionId } : {}) }
  }
  async load(): Promise<void> {
    try {
      const value = JSON.parse(await readFile(this.statePath, 'utf8'))
      if (!value || Array.isArray(value) || (value.targetId !== null && (typeof value.targetId !== 'string' || !value.targetId))) throw new Error('Invalid Commander state')
      this.targetId = value.targetId
      if (this.targetId) await this.writeInstructions()
    } catch (error) {
      this.targetId = null
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.error(`[commando] Could not load Commander state from ${this.statePath}`, error)
    }
    this.reconcile()
  }
  reconcile(): void {
    const state = this.state(), encoded = JSON.stringify(state)
    if (encoded !== this.lastState) { this.lastState = encoded; this.options.changed(state) }
  }
  ensure(): Promise<CommanderState> { return this.serial(async () => {
    await this.options.refreshSnapshot()
    if (this.state().paneId) return this.state()
    await this.writeInstructions()
    const names = new Set(this.options.snapshot().sessions.map((s) => s.name))
    let name = 'Commander', suffix = 2
    while (names.has(name)) name = `Commander-${suffix++}`
    const result = await this.options.creator.createSession({ name, cwd: this.cwd, agent: { provider: 'claude-chat', permissionMode: 'default' } })
    await this.options.refreshSnapshot()
    const pane = this.options.snapshot().panes.find((p) => p.id === result.created.paneId)
    if (!pane) throw new Error('Commander pane was created but is not visible in the snapshot')
    await this.persist(pane.targetId)
    return this.state()
  }) }
  forget(): Promise<void> { return this.serial(() => this.persist(null)) }
  private serial<T>(action: () => Promise<T>): Promise<T> {
    const operation = this.operations.then(action)
    this.operations = operation.catch(() => {})
    return operation
  }
  private async persist(targetId: string | null): Promise<void> {
    await mkdir(dirname(this.statePath), { recursive: true, mode: 0o700 })
    const tmp = `${this.statePath}.${randomUUID()}.tmp`
    try { await writeFile(tmp, JSON.stringify({ targetId }), { mode: 0o600, flag: 'wx' }); await rename(tmp, this.statePath) }
    finally { await rm(tmp, { force: true }) }
    this.targetId = targetId
    this.reconcile()
  }
  private async writeToolPermissions(cliPath: string): Promise<void> {
    const path = join(this.cwd, '.claude', 'settings.json')
    let settings: Record<string, unknown> = {}
    try {
      const value: unknown = JSON.parse(await readFile(path, 'utf8'))
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Commander Claude settings')
      settings = value as Record<string, unknown>
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error(`[commando] Could not update Commander tool permissions in ${path}`, error)
        return
      }
    }
    const permissions = settings.permissions === undefined ? {} : settings.permissions
    if (!permissions || typeof permissions !== 'object' || Array.isArray(permissions)) {
      console.error(`[commando] Invalid Commander Claude permissions in ${path}`)
      return
    }
    const existing = permissions as Record<string, unknown>
    const allow = existing.allow === undefined ? [] : existing.allow
    if (!Array.isArray(allow) || !allow.every((rule) => typeof rule === 'string')) {
      console.error(`[commando] Invalid Commander Claude allow rules in ${path}`)
      return
    }
    const rules = commanderToolRules(cliPath)
    const merged = { ...settings, permissions: { ...existing, allow: [...allow, ...rules.filter((rule) => !allow.includes(rule))] } }
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const tmp = `${path}.${randomUUID()}.tmp`
    try { await writeFile(tmp, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600, flag: 'wx' }); await rename(tmp, path) }
    finally { await rm(tmp, { force: true }) }
  }
  private async writeInstructions(): Promise<void> {
    await mkdir(this.cwd, { recursive: true, mode: 0o700 })
    const cliPath = this.options.cliPath ?? join(this.options.home ?? homedir(), '.commando', 'hooks', 'commando-agents.mjs')
    const content = commanderInstructions(cliPath)
    await this.writeToolPermissions(cliPath)
    await Promise.all(['CLAUDE.md', 'AGENTS.md'].map((name) => writeFile(join(this.cwd, name), content, { mode: 0o600 })))
  }
}
