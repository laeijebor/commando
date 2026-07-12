import type {
  CommandoSnapshot,
  GroupLayoutPreset,
  SavedGroup,
} from '../shared/protocol'

export type PanePlacement = {
  columnSpan: number
  rowSpan: number
}

export function getPanePlacement(
  preset: GroupLayoutPreset,
  index: number,
  paneCount: number,
  fillIncompleteRows = false,
): PanePlacement {
  if (paneCount <= 1) return { columnSpan: 12, rowSpan: 1 }

  switch (preset) {
    case 'full-then-halves':
      if (fillIncompleteRows && paneCount % 2 === 0 && index === paneCount - 1) {
        return { columnSpan: 12, rowSpan: 1 }
      }
      return { columnSpan: index === 0 ? 12 : 6, rowSpan: 1 }
    case 'two-full-two-halves':
      if (fillIncompleteRows && paneCount % 2 !== 0 && index === paneCount - 1) {
        return { columnSpan: 12, rowSpan: 1 }
      }
      return { columnSpan: index < 2 ? 12 : 6, rowSpan: 1 }
    case 'lead-and-stack':
      if (fillIncompleteRows && paneCount > 3 && index >= 3) {
        const trailingCount = paneCount - 3
        const remainder = trailingCount % 3
        const trailingIndex = index - 3
        if (remainder > 0 && trailingIndex >= trailingCount - remainder) {
          return { columnSpan: 12 / remainder, rowSpan: 1 }
        }
      }
      return index === 0
        ? { columnSpan: paneCount > 2 ? 8 : 7, rowSpan: paneCount > 2 ? 2 : 1 }
        : { columnSpan: paneCount > 2 ? 4 : 5, rowSpan: 1 }
    case 'equal-grid':
      if (paneCount === 2 || paneCount === 4) return { columnSpan: 6, rowSpan: 1 }
      if (paneCount === 3 || paneCount >= 5) {
        if (fillIncompleteRows && paneCount >= 5) {
          const remainder = paneCount % 3
          if (remainder > 0 && index >= paneCount - remainder) {
            return { columnSpan: 12 / remainder, rowSpan: 1 }
          }
        }
        return { columnSpan: 4, rowSpan: 1 }
      }
      return { columnSpan: 12, rowSpan: 1 }
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
        layout: 'equal-grid' as const,
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
