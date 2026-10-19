import type { CommanderAgent, CommanderState } from '../shared/commander.js'
import type { AgentStatus } from '../shared/protocol.js'
import type { CommanderRelays } from './commander-relays.js'

type Episode = { updatedAt: number; endedAt: number; nudged: boolean; noticed: boolean; reason: string }
type Options = {
  agents: () => CommanderAgent[]; status: (id: string) => AgentStatus | undefined
  commander: () => CommanderState; relays: Pick<CommanderRelays, 'enqueue'>
  now?: () => number; env?: NodeJS.ProcessEnv
}
export class CommanderStalls {
  private readonly episodes = new Map<string, Episode>()
  private readonly started = new Map<string, number>()
  private notices: number[] = []
  private nudges: number[] = []
  private timer?: ReturnType<typeof setInterval>
  private checking = false
  constructor(private readonly options: Options) {}
  stalled(targetId: string): boolean { return this.episodes.has(targetId) }
  observe(targetId: string, status: AgentStatus): void {
    if (status.status === 'working') {
      this.started.set(targetId, Math.max(this.started.get(targetId) ?? 0, status.updatedAt))
      const episode = this.episodes.get(targetId)
      if (episode && status.updatedAt > episode.updatedAt) this.episodes.delete(targetId)
    }
  }
  start(): void { if (!this.timer) { this.timer = setInterval(() => { void this.check().catch((e) => console.warn('[commando] Stall check failed', e)) }, 60_000); this.timer.unref() } }
  stop(): void { clearInterval(this.timer) }
  /** Reserve before enqueueing: concurrent requests cannot nudge an episode twice. */
  takeNudge(targetId: string): boolean {
    const episode = this.episodes.get(targetId), now = this.now()
    this.nudges = this.nudges.filter((n) => n > now - 3_600_000)
    if (!episode || episode.nudged || this.nudges.length >= 6) return false
    episode.nudged = true; this.nudges.push(now)
    return true
  }
  private now(): number { return (this.options.now ?? Date.now)() }
  async check(): Promise<void> {
    if (this.checking) return
    this.checking = true
    try {
      const agents = this.options.agents(), live = new Set(agents.map((a) => a.targetId))
      for (const target of this.episodes.keys()) if (!live.has(target)) this.episodes.delete(target)
      for (const target of this.started.keys()) if (!live.has(target)) this.started.delete(target)
      const configured = Number((this.options.env ?? process.env).COMMANDO_COMMANDER_STALL_MINUTES ?? 30)
      const threshold = (Number.isFinite(configured) && configured > 0 ? configured : 30) * 60_000
      for (const agent of agents) {
        if (agent.targetId === this.options.commander().targetId) continue
        const status = this.options.status(agent.paneId)
        if (!status) continue
        this.observe(agent.targetId, status)
        let episode = this.episodes.get(agent.targetId)
        const freshWorking = status.status === 'working' && status.updatedAt > (episode?.updatedAt ?? Infinity)
        const newEnd = agent.brief && agent.brief.endedAt > (episode?.endedAt ?? Infinity) && agent.brief.kind !== 'stalled'
        if (episode && (freshWorking || newEnd)) { this.episodes.delete(agent.targetId); episode = undefined }
        const newerTurn = (this.started.get(agent.targetId) ?? -Infinity) > (agent.brief?.endedAt ?? -Infinity)
        const reason = status.source === 'hook' && status.status === 'failed' ? 'the agent reported a failed turn'
          : agent.brief?.kind === 'stalled' && !newerTurn ? 'its latest turn stopped before finishing'
            : status.status === 'working' && this.now() - status.updatedAt >= threshold ? `no activity for ${Math.floor(threshold / 60_000)} minutes` : undefined
        if (!episode && reason) {
          episode = { updatedAt: status.updatedAt, endedAt: agent.brief?.endedAt ?? 0, nudged: false, noticed: false, reason }
          this.episodes.set(agent.targetId, episode)
        }
        const commander = this.options.commander()
        this.notices = this.notices.filter((n) => n > this.now() - 3_600_000)
        if (!episode || episode.noticed || !commander.paneId || this.notices.length >= 6) continue
        episode.noticed = true; this.notices.push(this.now())
        await this.options.relays.enqueue({ paneId: commander.paneId, origin: 'commander', kind: 'relay', delivery: 'queue',
          text: `[Commando] ${JSON.stringify(agent.title)} (pane ${agent.paneId}, session ${agent.sessionName}) looks stalled: ${episode.reason}. Latest brief: ${agent.brief?.text ?? agent.headline}. You may nudge it with: commando-agents nudge ${agent.paneId} "<message>"` })
      }
    } finally { this.checking = false }
  }
}
