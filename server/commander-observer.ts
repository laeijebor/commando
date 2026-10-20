import type { ChatItem, ChatSessionInfo } from '../shared/agent-chat.js'
import type { SessionBrief, TmuxPane } from '../shared/protocol.js'
import type { AgentStatusChange } from './agent-status-registry.js'
import type { CommanderRelays } from './commander-relays.js'
import type { CommanderStalls } from './commander-stalls.js'
import type { TurnBriefs } from './turn-briefs.js'

type Options = {
  pane: (id: string) => TmuxPane | undefined
  owns: (id: string) => boolean
  items: (id: string) => ChatItem[]
  finalMessage: (id: string) => string | undefined
  sessionBrief: (id: string) => Pick<SessionBrief, 'title'> | undefined
  chatSession: (id: string) => ChatSessionInfo | undefined
  briefs: Pick<TurnBriefs, 'observe' | 'remove'>
  stalls: Pick<CommanderStalls, 'observe' | 'check'>
  relays: Pick<CommanderRelays, 'flush'>
  error: (error: unknown) => void
}

/** Share the live status feed, including restored baselines, with Commander services. */
export function createCommanderStatusObserver(options: Options): (change: AgentStatusChange, restored?: boolean) => void {
  return (change, restored = false) => {
    if (!change) return
    if (change.type === 'upsert') {
      const status = change.status, pane = options.pane(status.paneId)
      if (pane) {
        void options.stalls.observe(pane.targetId, status).catch(options.error)
        const chat = options.owns(pane.id), session = options.chatSession(pane.id)
        const final = chat ? [...options.items(pane.id)].reverse().find((item) => item.kind === 'assistant_message' && !item.parentToolUseId) : undefined
        const finalMessage = final?.kind === 'assistant_message' ? final.text : options.finalMessage(pane.id)
        options.briefs.observe({ status, targetId: pane.targetId, chat, restored, finalMessage,
          title: options.sessionBrief(pane.id)?.title ?? session?.title ?? pane.chatTitle ?? pane.title,
          configDir: session?.configDir })
      }
    } else options.briefs.remove(change.paneId)
    void options.relays.flush().catch(options.error)
    void options.stalls.check().catch(options.error)
  }
}
