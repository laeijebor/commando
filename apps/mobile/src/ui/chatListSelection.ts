import { buildAgentRows } from '../agents/selectors'
import type { HostDaemonState } from '../daemon/state'
import type { ListChat } from './chatRowMetadata'

/** Native chats answer inline; brokered terminal requests use the existing Answer screen. */
export function chatListDestination(state: HostDaemonState, chats: Record<string, ListChat>, paneId: string) {
  if (!chats[paneId] && state.agentStatuses[paneId]?.details?.requests?.length) {
    const row = buildAgentRows({ snapshot: state.snapshot, statuses: state.agentStatuses, briefs: state.briefs }).find((entry) => entry.paneId === paneId)
    if (row) return { kind: 'answer' as const, row }
  }
  return { kind: 'pane' as const, paneId }
}
