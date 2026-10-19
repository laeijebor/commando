import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { ChatSendOptions, ChatSessionStatus } from '../shared/agent-chat.js'
import type { CommanderRelay } from '../shared/commander.js'
import type { AgentStatus, TmuxPane } from '../shared/protocol.js'

type Options = {
  statePath: string; pane: (id: string) => TmuxPane | undefined; status: (id: string) => AgentStatus | undefined
  owns: (id: string) => boolean
  chatStatus: (id: string) => ChatSessionStatus | undefined
  sendChat: (paneId: string, text: string, id: string, options?: ChatSendOptions) => boolean
  sendTerminal: (paneId: string, text: string) => Promise<void>
  changed: (relay: CommanderRelay) => void; now?: () => number
}
type Input = Pick<CommanderRelay, 'origin' | 'kind' | 'text' | 'delivery'> & { paneId: string }
export class CommanderRelays {
  private relays: CommanderRelay[] = []
  private readonly sending = new Set<string>()
  private readonly inFlight = new Map<string, Promise<void>>()
  private writes: Promise<void> = Promise.resolve()
  private timer?: ReturnType<typeof setInterval>
  constructor(private readonly options: Options) {}
  values(limit?: number): CommanderRelay[] { return this.relays.slice(limit === undefined ? 0 : -limit) }
  async load(): Promise<void> {
    try {
      const value = JSON.parse(await readFile(this.options.statePath, 'utf8'))
      if (!Array.isArray(value)) throw new Error('Invalid relay state')
      this.relays = value.filter((r) => r && typeof r.id === 'string' && typeof r.toPaneId === 'string' && typeof r.toTargetId === 'string'
        && typeof r.text === 'string' && ['queued', 'delivered', 'failed', 'cancelled'].includes(r.status)
        && ['queue', 'steer'].includes(r.delivery) && ['commander', 'inbox'].includes(r.origin) && ['relay', 'nudge'].includes(r.kind) && Number.isFinite(r.createdAt))
      this.prune()
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  start(): void { if (!this.timer) { this.timer = setInterval(() => { void this.flush().catch((e) => console.warn('[commando] Relay flush failed', e)) }, 30_000); this.timer.unref() } }
  stop(): void { clearInterval(this.timer) }
  async enqueue(input: Input): Promise<CommanderRelay> {
    const pane = this.options.pane(input.paneId)
    if (!pane || pane.dead) throw new Error('Target pane does not exist')
    const relay: CommanderRelay = { id: randomUUID(), origin: input.origin, kind: input.kind, text: input.text, delivery: input.delivery,
      toPaneId: pane.id, toTargetId: pane.targetId, status: 'queued', createdAt: (this.options.now ?? Date.now)() }
    this.relays.push(relay)
    // Journal the queue before sending, so a normal daemon restart cannot lose it.
    try { await this.change(relay) } catch (error) { this.relays = this.relays.filter((r) => r !== relay); throw error }
    await this.flush(pane.id)
    return relay
  }
  async cancel(id: string): Promise<CommanderRelay | undefined> {
    const relay = this.relays.find((r) => r.id === id)
    if (!relay || relay.status !== 'queued' || this.sending.has(relay.toTargetId)) return undefined
    relay.status = 'cancelled'
    await this.change(relay)
    return relay
  }
  async flush(paneId?: string): Promise<void> {
    const targets = new Set(this.relays.filter((r) => r.status === 'queued' && (!paneId || r.toPaneId === paneId)).map((r) => r.toTargetId))
    await Promise.all([...targets].map((target) => this.flushTarget(target)))
  }
  private flushTarget(targetId: string): Promise<void> {
    const previous = this.inFlight.get(targetId) ?? Promise.resolve()
    const operation = previous.catch(() => {}).then(() => this.processTarget(targetId))
    this.inFlight.set(targetId, operation)
    const finished = () => { if (this.inFlight.get(targetId) === operation) this.inFlight.delete(targetId) }
    void operation.then(finished, finished)
    return operation
  }
  private async processTarget(targetId: string): Promise<void> {
    this.sending.add(targetId)
    try {
      const pending = this.relays.filter((r) => r.toTargetId === targetId && r.status === 'queued')
      const first = pending[0]
      if (!first) return
      await this.writes
      const pane = this.options.pane(first.toPaneId)
      if (!pane || pane.dead || pane.targetId !== targetId) {
        for (const relay of pending) { relay.status = 'failed'; relay.error = 'Target pane no longer exists or changed identity'; await this.change(relay) }
        return
      }
      const chat = this.options.owns(pane.id), status = this.options.status(pane.id)
      const turnEnded = status?.status === 'done' || (status?.status === 'failed' && status.source === 'hook')
      const hostStatus = chat ? this.options.chatStatus(pane.id) : undefined
      const idle = turnEnded && (!chat || hostStatus === 'idle' || hostStatus === 'error')
      const steers = pending.filter((r) => r.delivery === 'steer')
      for (const relay of steers) {
        if (!chat && !idle) { relay.status = 'failed'; relay.error = "can't interrupt a terminal agent mid-turn; queue it instead"; await this.change(relay) }
        else await this.deliver([relay], chat, true)
      }
      // A steer starts a new turn; leave normal queued messages for its completion.
      if (idle && !steers.some((r) => r.status === 'delivered')) await this.deliver(pending.filter((r) => r.delivery === 'queue'), chat, false)
    } finally { this.sending.delete(targetId) }
  }
  private async deliver(relays: CommanderRelay[], chat: boolean, steer: boolean): Promise<void> {
    if (!relays.length) return
    const first = relays[0]
    let error: string | undefined
    try {
      const text = relays.map((r) => r.text).join('\n\n')
      if (chat) {
        const sent = steer ? this.options.sendChat(first.toPaneId, text, first.id, { delivery: 'steer' })
          : this.options.sendChat(first.toPaneId, text, first.id)
        if (!sent) throw new Error('Chat is unavailable')
      } else await this.options.sendTerminal(first.toPaneId, text)
    } catch (failure) { error = failure instanceof Error ? failure.message : 'Delivery failed' }
    // A journal failure after sending must never misreport an actual delivery as failed.
    for (const relay of relays) {
      if (error !== undefined) { relay.status = 'failed'; relay.error = error }
      else { relay.status = 'delivered'; relay.deliveredAt = (this.options.now ?? Date.now)() }
      await this.change(relay)
    }
  }

  private prune(): void {
    const recent = new Set(this.relays.filter((r) => r.status !== 'queued').slice(-200))
    this.relays = this.relays.filter((r) => r.status === 'queued' || recent.has(r))
  }
  private async change(relay: CommanderRelay): Promise<void> {
    this.prune()
    const value = JSON.stringify(this.relays)
    const operation = this.writes.then(async () => {
      await mkdir(dirname(this.options.statePath), { recursive: true, mode: 0o700 })
      const tmp = `${this.options.statePath}.${randomUUID()}.tmp`
      try { await writeFile(tmp, value, { mode: 0o600, flag: 'wx' }); await rename(tmp, this.options.statePath) }
      finally { await rm(tmp, { force: true }) }
    })
    this.writes = operation.catch(() => {})
    await operation
    this.options.changed({ ...relay })
  }
}
