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
  private readonly delivering = new Set<string>()
  private readonly inFlight = new Map<string, Promise<void>>()
  private readonly lastDelivered = new Map<string, number>()
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
        && ['queue', 'steer'].includes(r.delivery) && ['commander', 'inbox'].includes(r.origin) && ['relay', 'nudge'].includes(r.kind) && Number.isFinite(r.createdAt)
        && (r.toChat === undefined || typeof r.toChat === 'boolean'))
      this.prune()
    } catch (error) {
      this.relays = []
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.error(`[commando] Could not load Commander relays from ${this.options.statePath}`, error)
    }
  }
  start(): void { if (!this.timer) { this.timer = setInterval(() => { void this.flush().catch((e) => console.warn('[commando] Relay flush failed', e)) }, 30_000); this.timer.unref() } }
  stop(): void { clearInterval(this.timer) }
  async enqueue(input: Input): Promise<CommanderRelay> {
    const pane = this.options.pane(input.paneId)
    if (!pane || pane.dead) throw new Error('Target pane does not exist')
    const relay: CommanderRelay = { id: randomUUID(), origin: input.origin, kind: input.kind, text: input.text, delivery: input.delivery,
      toPaneId: pane.id, toTargetId: pane.targetId, toChat: this.options.owns(pane.id) || pane.chatTitle !== undefined,
      status: 'queued', createdAt: (this.options.now ?? Date.now)() }
    this.relays.push(relay)
    // Journal the queue before sending, so a normal daemon restart cannot lose it.
    try { await this.change(relay) } catch (error) { this.relays = this.relays.filter((r) => r !== relay); throw error }
    void this.flush(pane.id).catch((error) => console.error('[commando] Relay delivery failed', error))
    return relay
  }
  async cancel(id: string): Promise<CommanderRelay | undefined> {
    const relay = this.relays.find((r) => r.id === id)
    if (!relay || relay.status !== 'queued' || this.delivering.has(relay.id)) return undefined
    relay.status = 'cancelled'
    await this.change(relay)
    return relay
  }
  async cancelNudges(targetId: string): Promise<void> {
    for (const relay of this.relays.filter((r) => r.toTargetId === targetId && r.kind === 'nudge' && r.status === 'queued')) await this.cancel(relay.id)
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
    const expired = this.relays.filter((r) => r.toTargetId === targetId && r.status === 'queued' && (this.options.now ?? Date.now)() - r.createdAt >= 6 * 3_600_000)
    for (const relay of expired) { relay.status = 'failed'; relay.error = 'Not delivered within 6 hours' }
    if (expired.length) await this.finish(expired)
    const pending = this.relays.filter((r) => r.toTargetId === targetId && r.status === 'queued')
    const first = pending[0]
    if (!first) return
    await this.writes
    const pane = this.options.pane(first.toPaneId)
    if (!pane || pane.dead || pane.targetId !== targetId) {
      for (const relay of pending) { relay.status = 'failed'; relay.error = 'Target pane no longer exists or changed identity' }
      await this.finish(pending)
      return
    }
    const chat = this.options.owns(pane.id), status = this.options.status(pane.id)
    if (!chat && (pane.chatTitle !== undefined || pending.some((r) => r.toChat))) return
    const turnEnded = status?.status === 'done' || (status?.status === 'failed' && status.source === 'hook')
    const hostStatus = chat ? this.options.chatStatus(pane.id) : undefined
    if (chat && (hostStatus === undefined || hostStatus === 'closed')) return
    const idle = (turnEnded || (chat && (!status || status.status === 'unknown') && hostStatus === 'idle')) && (!chat || hostStatus === 'idle' || hostStatus === 'error')
    const lastDelivered = this.lastDelivered.get(targetId)
    if (lastDelivered !== undefined) {
      if (status && status.updatedAt > lastDelivered && (status.status === 'working' || turnEnded)) this.lastDelivered.delete(targetId)
      else return
    }
    const steers = pending.filter((r) => r.delivery === 'steer')
    for (const relay of steers) {
      if (!chat && !idle) { relay.status = 'failed'; relay.error = "can't interrupt a terminal agent mid-turn; queue it instead"; await this.change(relay) }
      else await this.deliver([relay], chat, true)
      if (relay.status === 'delivered') break
    }
    // A steer starts a new turn; leave normal queued messages for its completion.
    if (idle && !steers.some((r) => r.status === 'delivered' || r.status === 'queued')) await this.deliver(pending.filter((r) => r.delivery === 'queue'), chat, false)
  }
  private async deliver(relays: CommanderRelay[], chat: boolean, steer: boolean): Promise<void> {
    relays = relays.filter((relay) => relay.status === 'queued')
    if (!relays.length) return
    for (const relay of relays) this.delivering.add(relay.id)
    try {
      const first = relays[0]
      let error: string | undefined
      try {
        const text = relays.map((r) => r.text).join('\n\n')
        if (chat) {
          const sent = steer ? this.options.sendChat(first.toPaneId, text, first.id, { delivery: 'steer' })
            : this.options.sendChat(first.toPaneId, text, first.id)
          if (!sent) throw new Error('Chat host not connected')
        } else await this.options.sendTerminal(first.toPaneId, text)
      } catch (failure) { error = failure instanceof Error ? failure.message : 'Delivery failed' }
      if (error) {
        const pane = this.options.pane(first.toPaneId)
        if (!pane || pane.dead || pane.targetId !== first.toTargetId) error = 'Target pane no longer exists or changed identity'
        else if (!/text.*reject|reject.*text|invalid text/i.test(error)) {
          if (!/Another delivery is in progress|Chat (?:host (?:is )?not connected|is unavailable)|Agent is unavailable/i.test(error)) {
            console.warn(`[commando] Relay delivery will retry paneId=${first.toPaneId} targetId=${first.toTargetId}: ${error}`)
          }
          return
        }
      }
      // A journal failure after sending must never misreport an actual delivery as failed.
      for (const relay of relays) {
        if (error !== undefined) { relay.status = 'failed'; relay.error = error }
        else { relay.status = 'delivered'; relay.deliveredAt = (this.options.now ?? Date.now)() }
      }
      if (!error) this.lastDelivered.set(first.toTargetId, (this.options.now ?? Date.now)())
      await this.finish(relays)
    } finally { for (const relay of relays) this.delivering.delete(relay.id) }
  }

  /** Finalize the entire sent batch before touching the journal; never retry an input already handed off. */
  private async finish(relays: CommanderRelay[]): Promise<void> {
    for (const relay of relays) this.settle(relay)
    try { await this.persist() } catch (error) { console.error(`[commando] Could not save Commander relays to ${this.options.statePath}`, error) }
    for (const relay of relays) this.options.changed({ ...relay })
  }

  /** Receipts age from when a relay left the queue, not from when it was queued. */
  private settle(relay: CommanderRelay): void {
    if (relay.status !== 'queued' && relay.settledAt === undefined) relay.settledAt = (this.options.now ?? Date.now)()
  }

  private prune(): void {
    const recent = new Set(this.relays.filter((r) => r.status !== 'queued').slice(-200))
    this.relays = this.relays.filter((r) => r.status === 'queued' || recent.has(r))
  }
  private async change(relay: CommanderRelay): Promise<void> {
    this.settle(relay)
    await this.persist()
    this.options.changed({ ...relay })
  }
  private async persist(): Promise<void> {
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
  }
}
