import type { CommanderRelay, CommanderState, TurnBrief } from '../shared/commander'
import type { ServerMessage } from '../shared/protocol'

export type CommanderClientState = {
  turnBriefs: Record<string, TurnBrief>
  relays: Record<string, CommanderRelay>
  commanderState: CommanderState
}
export const initialCommanderClientState: CommanderClientState = {
  turnBriefs: {}, relays: {}, commanderState: { targetId: null },
}
export type CommanderMessage = Extract<ServerMessage, { type: 'turn_brief' | 'turn_brief_snapshot' | 'commander_relay' | 'commander_relay_snapshot' | 'commander_state' }>

/** Snapshots replace reconnect state; relay updates replace by id (never back to queued) before bounding history. */
export function reduceCommanderMessage(state: CommanderClientState, message: CommanderMessage): CommanderClientState {
  switch (message.type) {
    case 'turn_brief': return { ...state, turnBriefs: { ...state.turnBriefs, [message.brief.targetId]: message.brief } }
    case 'turn_brief_snapshot': return { ...state, turnBriefs: Object.fromEntries(message.briefs.map((brief) => [brief.targetId, brief])) }
    case 'commander_state': return { ...state, commanderState: message.state }
    case 'commander_relay':
    case 'commander_relay_snapshot': {
      const previous = message.type === 'commander_relay' ? state.relays[message.relay.id] : undefined
      // A late HTTP response still says "queued"; it must not undo a final status the socket already sent.
      if (previous && previous.status !== 'queued' && message.type === 'commander_relay' && message.relay.status === 'queued') return state
      const byId = message.type === 'commander_relay'
        ? { ...state.relays, [message.relay.id]: message.relay }
        : Object.fromEntries(message.relays.map((relay) => [relay.id, relay]))
      const latest = Object.values(byId).sort((a, b) => b.createdAt - a.createdAt).slice(0, 200)
      return { ...state, relays: Object.fromEntries(latest.map((relay) => [relay.id, relay])) }
    }
  }
}
