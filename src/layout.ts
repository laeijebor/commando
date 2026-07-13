import type {
  CommandoSnapshot,
  LayoutSpec,
  SavedGroup,
} from '../shared/protocol'

export type GroupLayoutPreset =
  | 'equal-grid'
  | 'full-then-halves'
  | 'two-full-two-halves'
  | 'lead-and-stack'

function chunks<T>(values: T[], size: number): T[][] {
  const result: T[][] = []
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size))
  return result
}

const pane = (paneId: string): LayoutSpec => ({ kind: 'pane', paneId, cols: 80, rows: 24 })
const split = (direction: 'row' | 'column', children: LayoutSpec[]): LayoutSpec =>
  children.length === 1 ? children[0] : { kind: 'split', direction, children }

/**
 * Builds the split tree a preset button applies to the window's panes right
 * now. Leaf sizes are equal weights; the daemon rescales them to the window.
 */
export function presetLayoutSpec(preset: GroupLayoutPreset, paneIds: string[]): LayoutSpec | null {
  if (paneIds.length === 0) return null
  const panes = paneIds.map(pane)
  if (panes.length === 1) return panes[0]

  switch (preset) {
    case 'equal-grid':
      if (panes.length <= 3) return split('row', panes)
      if (panes.length === 4) {
        return split('column', [split('row', panes.slice(0, 2)), split('row', panes.slice(2))])
      }
      return split('column', chunks(panes, 3).map((row) => split('row', row)))
    case 'full-then-halves':
      return split('column', [panes[0], ...chunks(panes.slice(1), 2).map((row) => split('row', row))])
    case 'two-full-two-halves':
      return split('column', [panes[0], panes[1], ...chunks(panes.slice(2), 2).map((row) => split('row', row))])
    case 'lead-and-stack':
      if (panes.length === 2) return split('row', panes)
      if (panes.length === 3) return split('row', [panes[0], split('column', panes.slice(1))])
      return split('column', [
        split('row', [panes[0], split('column', panes.slice(1, 3))]),
        ...chunks(panes.slice(3), 3).map((row) => split('row', row)),
      ])
  }
}

export function moveItem<T>(items: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= items.length || to >= items.length) {
    return items
  }

  const next = [...items]
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)
  return next
}

export function defaultGroupsForSession(
  snapshot: CommandoSnapshot,
  sessionId: string,
): SavedGroup[] {
  const session = snapshot.sessions.find((candidate) => candidate.id === sessionId)
  if (!session) return []

  const windows = new Map(snapshot.windows.map((window) => [window.id, window]))

  return session.windowIds.flatMap((windowId) => {
    const window = windows.get(windowId)
    if (!window) return []

    return [
      {
        id: `window-${window.id.replace(/[^A-Za-z0-9._-]/g, '')}`,
        name: window.name || `Window ${window.index}`,
        sessionId,
        windowId: window.id,
        paneIds: [...window.paneIds],
      },
    ]
  })
}

export function reconcileGroupsForSession(
  snapshot: CommandoSnapshot,
  sessionId: string,
  savedGroups: SavedGroup[],
): SavedGroup[] {
  const defaults = defaultGroupsForSession(snapshot, sessionId)
  const savedByWindow = new Map(savedGroups.map((group) => [group.windowId, group]))

  return defaults.map((fallback) => {
    const saved = savedByWindow.get(fallback.windowId)
    if (!saved) return fallback

    const currentPaneIds = new Set(fallback.paneIds)
    const retainedPaneIds = saved.paneIds.filter((paneId) => currentPaneIds.has(paneId))
    const retainedSet = new Set(retainedPaneIds)
    const newPaneIds = fallback.paneIds.filter((paneId) => !retainedSet.has(paneId))

    return {
      ...saved,
      sessionId,
      windowId: fallback.windowId,
      paneIds: [...retainedPaneIds, ...newPaneIds],
    }
  })
}
