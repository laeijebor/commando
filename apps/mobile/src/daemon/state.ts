import type {
  AgentStatus,
  CommandoSnapshot,
  PaneMark,
  ProviderUsage,
  ServerMessage,
  SessionBrief,
  WebPane,
  WebPaneFeedbackInfo,
} from '@commando/protocol'

export type ConnectionPhase =
  | 'idle'
  | 'connecting'
  | 'live'
  | 'reconnecting'
  | 'unauthorized'
  | 'offline'

export type HostDaemonState = {
  phase: ConnectionPhase
  detail: string
  attempt: number
  snapshot: CommandoSnapshot | null
  agentStatuses: Record<string, AgentStatus>
  briefs: Record<string, SessionBrief>
  marks: Record<string, PaneMark>
  webPanes: WebPane[]
  feedback: Record<string, WebPaneFeedbackInfo>
  usage: ProviderUsage[]
  lastError: { code: string; message: string; at: number } | null
  updatedAt: number
}

export const EMPTY_HOST_STATE: HostDaemonState = {
  phase: 'idle',
  detail: 'Not connected',
  attempt: 0,
  snapshot: null,
  agentStatuses: {},
  briefs: {},
  marks: {},
  webPanes: [],
  feedback: {},
  usage: [],
  lastError: null,
  updatedAt: 0,
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Tolerant parse: anything that is an object with a string `type` is handed to
 * the reducer, which ignores the kinds it does not know. A daemon that is
 * newer than the app must never knock the socket over.
 */
export function parseServerMessage(raw: unknown): ServerMessage | null {
  if (typeof raw !== 'string') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isRecord(parsed) || typeof parsed.type !== 'string') return null
  return parsed as ServerMessage
}

/**
 * Folds one `ServerMessage` into a host's slice. Pure, so the reduction is
 * unit-testable without a socket.
 */
export function applyServerMessage(
  state: HostDaemonState,
  message: ServerMessage,
): HostDaemonState {
  const stamped = (patch: Partial<HostDaemonState>): HostDaemonState => ({
    ...state,
    ...patch,
    updatedAt: Date.now(),
  })

  switch (message.type) {
    case 'snapshot':
      return stamped({ snapshot: message.snapshot })

    case 'agent_status':
      return stamped({
        agentStatuses: { ...state.agentStatuses, [message.status.paneId]: message.status },
      })

    case 'agent_status_snapshot':
      return stamped({
        agentStatuses: Object.fromEntries(
          message.statuses.map((status) => [status.paneId, status]),
        ),
      })

    case 'agent_status_removed': {
      if (!(message.paneId in state.agentStatuses)) return state
      const agentStatuses = { ...state.agentStatuses }
      delete agentStatuses[message.paneId]
      return stamped({ agentStatuses })
    }

    case 'session_brief':
      return stamped({ briefs: { ...state.briefs, [message.brief.paneId]: message.brief } })

    case 'session_brief_snapshot':
      return stamped({
        briefs: Object.fromEntries(message.briefs.map((brief) => [brief.paneId, brief])),
      })

    case 'pane_mark':
      return stamped({ marks: { ...state.marks, [message.mark.targetId]: message.mark } })

    case 'pane_mark_snapshot':
      return stamped({
        marks: Object.fromEntries(message.marks.map((mark) => [mark.targetId, mark])),
      })

    case 'pane_mark_removed': {
      if (!(message.targetId in state.marks)) return state
      const marks = { ...state.marks }
      delete marks[message.targetId]
      return stamped({ marks })
    }

    case 'web_panes':
      return stamped({ webPanes: message.webPanes, feedback: message.feedback ?? {} })

    case 'provider_usage':
      return stamped({ usage: message.usage })

    case 'error':
      return stamped({
        lastError: { code: message.code, message: message.message, at: Date.now() },
      })

    default:
      // pane_data, pane_reset, capabilities, workspace, agent_request_answered
      // and anything a newer daemon invents are not part of this screen's
      // state yet.
      return state
  }
}
