export const SESSION_HISTORY_LIMIT = 50

export type SessionVisit = { sessionId: string; name: string; at: number }
export type SessionHistory = { entries: SessionVisit[]; index: number }
export const emptyHistory = (): SessionHistory => ({ entries: [], index: -1 })

export function recordVisit(history: SessionHistory, visit: SessionVisit): SessionHistory {
  if (history.entries[history.index]?.sessionId === visit.sessionId) return history
  const entries = [...history.entries.slice(0, history.index + 1), visit].slice(-SESSION_HISTORY_LIMIT)
  return { entries, index: entries.length - 1 }
}

export function stepTarget(history: SessionHistory, direction: -1 | 1, isLive: (id: string) => boolean): number | null {
  const currentSessionId = history.entries[history.index]?.sessionId
  for (let index = history.index + direction; index >= 0 && index < history.entries.length; index += direction) {
    const sessionId = history.entries[index].sessionId
    if (sessionId !== currentSessionId && isLive(sessionId)) return index
  }
  return null
}

export function goTo(history: SessionHistory, index: number): SessionHistory {
  return Number.isInteger(index) && index >= 0 && index < history.entries.length && index !== history.index
    ? { ...history, index }
    : history
}

export function serialiseHistory(history: SessionHistory): string {
  return JSON.stringify(history)
}

export function parseHistory(raw: string | null): SessionHistory {
  try {
    const value = JSON.parse(raw ?? '') as SessionHistory
    if (!value || !Array.isArray(value.entries) || !Number.isInteger(value.index)) return emptyHistory()
    if (value.entries.length === 0) return emptyHistory()
    if (value.index < 0 || value.index >= value.entries.length || value.entries.some((entry) => (
      !entry || typeof entry.sessionId !== 'string' || !entry.sessionId || typeof entry.name !== 'string' ||
      typeof entry.at !== 'number' || !Number.isFinite(entry.at) || entry.at < 0
    ))) return emptyHistory()
    // Normalize consecutive duplicates without losing the persisted position.
    const entries: SessionVisit[] = []
    let index = 0
    value.entries.forEach((entry, oldIndex) => {
      if (entries.at(-1)?.sessionId === entry.sessionId) entries[entries.length - 1] = entry
      else entries.push({ sessionId: entry.sessionId, name: entry.name, at: entry.at })
      if (oldIndex === value.index) index = entries.length - 1
    })
    const start = Math.max(0, entries.length - SESSION_HISTORY_LIMIT)
    return { entries: entries.slice(start), index: Math.max(0, index - start) }
  } catch {
    return emptyHistory()
  }
}
