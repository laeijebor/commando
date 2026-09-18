import type {
  AgentStatus,
  CommandoSnapshot,
  TmuxPane,
  TmuxSession,
  TmuxWindow,
  WebPane,
} from '@commando/protocol'

import { providerLabel } from '../agents/selectors'

export type PaneWindowChip = {
  id: string
  name: string
  index: number
  active: boolean
  /** A pane in this window is waiting on the owner or has failed. */
  attention: boolean
  /** Where a tap goes: the window's active pane, or its first one. */
  targetPaneId: string | undefined
}

export type PaneContext = {
  pane: TmuxPane | undefined
  window: TmuxWindow | undefined
  session: TmuxSession | undefined
  /** Nav title: the session this pane belongs to. */
  title: string
  /** Nav subtitle: window · pane · provider · branch. */
  subtitle: string
  windows: PaneWindowChip[]
  /** Tiles anchored in the same window, as the session tree groups them. */
  tiles: WebPane[]
}

/**
 * Everything the pane screen's chrome needs, resolved from the snapshot in one
 * place so the screen itself stays a layout.
 */
export function buildPaneContext(
  snapshot: CommandoSnapshot | null,
  statuses: Readonly<Record<string, AgentStatus>>,
  webPanes: readonly WebPane[],
  paneId: string | undefined,
  status?: AgentStatus,
): PaneContext {
  const pane = paneId ? snapshot?.panes.find((candidate) => candidate.id === paneId) : undefined
  const window = pane ? snapshot?.windows.find((candidate) => candidate.id === pane.windowId) : undefined
  const session = window
    ? snapshot?.sessions.find((candidate) => candidate.id === window.sessionId)
    : undefined

  const windows = session && snapshot
    ? session.windowIds
        .map((id) => snapshot.windows.find((candidate) => candidate.id === id))
        .filter((candidate): candidate is TmuxWindow => Boolean(candidate))
        .sort((left, right) => left.index - right.index)
        .map((candidate): PaneWindowChip => {
          const panes = candidate.paneIds
            .map((id) => snapshot.panes.find((entry) => entry.id === id))
            .filter((entry): entry is TmuxPane => Boolean(entry))
          const activePane = panes.find((entry) => entry.active) ?? panes[0]
          return {
            id: candidate.id,
            name: candidate.name,
            index: candidate.index,
            active: candidate.id === window?.id,
            attention: panes.some((entry) => {
              const kind = statuses[entry.id]?.status
              return kind === 'needs_input' || kind === 'failed'
            }),
            targetPaneId: activePane?.id,
          }
        })
    : []

  const provider = status ? providerLabel(status.provider) : undefined
  const subtitle = [
    window?.name,
    pane?.targetId ?? paneId,
    provider,
    pane?.repo ? `⎇ ${pane.repo.branch}` : undefined,
  ]
    .filter((part): part is string => Boolean(part))
    .join(' · ')

  return {
    pane,
    window,
    session,
    title: session?.name ?? pane?.title ?? 'Pane',
    subtitle,
    windows,
    tiles: window ? webPanes.filter((tile) => tile.windowId === window.id) : [],
  }
}

/** `https://example.com/path` → `example.com`, for a tile chip's label. */
export function tileLabel(tile: WebPane): string {
  try {
    return new URL(tile.url).host || tile.url
  } catch {
    return tile.url
  }
}
