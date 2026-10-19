import type { CommanderAgent, CommanderState } from '../shared/commander.js'
import type { AgentStatus } from '../shared/protocol.js'
import type { CommanderRelays } from './commander-relays.js'

type Episode = { updatedAt: number; endedAt: number; nudged: boolean; nudgeAt?: number; noticed: boolean; reason: string }
type Options = {
  agents: () => CommanderAgent[]; status: (id: string) => AgentStatus | undefined
  commander: () => CommanderState; relays: Pick<CommanderRelays, 'enqueue' | 'cancelNudges'>
  now?: () => number; env?: NodeJS.ProcessEnv
}
export class CommanderStalls {
  private readonly episodes = new Map<string, Episode>()
  private readonly started = new Map<string, number>()
  private notices: number[] = []
  private nudges: number[] = []
  private timer?: ReturnType<typeof setInterval>
  private checking?: Promise<void>
  private initialized = false
  constructor(private readonly options: Options) {}
  stalled(targetId: string): boolean { return this.episodes.has(targetId) }
  async observe(targetId: string, status: AgentStatus): Promise<void> {
    if (status.status === 'working') {
      this.started.set(targetId, Math.max(this.started.get(targetId) ?? 0, status.updatedAt))
      const episode = this.episodes.get(targetId)
      if (episode && status.updatedAt > episode.updatedAt) await this.clear(targetId)
    }
  }
  private async clear(targetId: string): Promise<void> {
    this.episodes.delete(targetId)
    await this.options.relays.cancelNudges(targetId)
  }
  start(): void { if (!this.timer) { this.timer = setInterval(() => { void this.check().catch((e) => console.warn('[commando] Stall check failed', e)) }, 60_000); this.timer.unref() } }
  stop(): void { clearInterval(this.timer) }
  /** Reserve before enqueueing: concurrent requests cannot nudge an episode twice. */
  takeNudge(targetId: string): boolean {
    const episode = this.episodes.get(targetId), now = this.now()
    this.nudges = this.nudges.filter((n) => n > now - 3_600_000)
    if (!episode || episode.nudged || this.nudges.length >= 6) return false
    episode.nudged = true; episode.nudgeAt = now; this.nudges.push(now)
    return true
  }
  releaseNudge(targetId: string): void {
    const episode = this.episodes.get(targetId)
    if (!episode?.nudged) return
    const index = this.nudges.indexOf(episode.nudgeAt!)
    if (index !== -1) this.nudges.splice(index, 1)
    episode.nudged = false; delete episode.nudgeAt
  }
  private now(): number { return (this.options.now ?? Date.now)() }
  check(): Promise<void> {
    if (!this.checking) this.checking = this.runCheck().finally(() => { this.checking = undefined })
    return this.checking
  }
  private async runCheck(): Promise<void> {
    const baseline = !this.initialized
    this.initialized = true
    const agents = this.options.agents(), live = new Set(agents.map((a) => a.targetId))
    for (const target of this.episodes.keys()) if (!live.has(target)) this.episodes.delete(target)
    for (const target of this.started.keys()) if (!live.has(target)) this.started.delete(target)
    const configured = Number((this.options.env ?? process.env).COMMANDO_COMMANDER_STALL_MINUTES ?? 30)
    const threshold = (Number.isFinite(configured) && configured > 0 ? configured : 30) * 60_000
    for (const agent of agents) {
      try {
        if (agent.targetId === this.options.commander().targetId) continue
        const status = this.options.status(agent.paneId)
        if (!status) continue
        await this.observe(agent.targetId, status)
        let episode = this.episodes.get(agent.targetId)
        const freshWorking = status.status === 'working' && status.updatedAt > (episode?.updatedAt ?? Infinity)
        const newEnd = agent.brief && agent.brief.endedAt > (episode?.endedAt ?? Infinity) && agent.brief.kind !== 'stalled'
        if (episode && (freshWorking || newEnd)) { await this.clear(agent.targetId); episode = undefined }
        const newerTurn = (this.started.get(agent.targetId) ?? -Infinity) > (agent.brief?.endedAt ?? -Infinity)
        const reason = status.source === 'hook' && status.status === 'failed' ? 'the agent reported a failed turn'
          : agent.brief?.kind === 'stalled' && !newerTurn ? 'its latest turn stopped before finishing'
            : status.status === 'working' && this.now() - status.updatedAt >= threshold ? `no activity for ${Math.floor(threshold / 60_000)} minutes` : undefined
        if (!episode && reason) {
          episode = { updatedAt: status.updatedAt, endedAt: agent.brief?.endedAt ?? 0, nudged: false, noticed: baseline, reason }
          this.episodes.set(agent.targetId, episode)
        }
        const commander = this.options.commander()
        this.notices = this.notices.filter((n) => n > this.now() - 3_600_000)
        if (!episode || episode.noticed || !commander.paneId || this.notices.length >= 6) continue
        await this.options.relays.enqueue({ paneId: commander.paneId, origin: 'commander', kind: 'relay', delivery: 'queue',
          text: `[Commando] ${JSON.stringify(agent.title)} (pane ${agent.paneId}, session ${agent.sessionName}) looks stalled: ${episode.reason}. Latest brief: ${agent.brief?.text ?? agent.headline}. You may nudge it with: commando-agents nudge ${agent.paneId} "<message>"` })
        episode.noticed = true; this.notices.push(this.now())
      } catch (error) { console.error(`[commando] Stall check failed for paneId=${agent.paneId} targetId=${agent.targetId}`, error) }
    }
  }
}
