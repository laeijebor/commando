import type { TmuxSession } from '../shared/protocol.js'

type SessionSnapshot = {
  serverId: string | null
  sessions: readonly Pick<TmuxSession, 'id' | 'name'>[]
}

type SessionRename = {
  sessionId: string
  previousName: string
  name: string
}

export function detectSessionRenames(previous: SessionSnapshot, next: SessionSnapshot): SessionRename[] {
  // Session ids can be reused after a restart; only compare known, matching servers.
  if (!previous.serverId || !next.serverId || previous.serverId !== next.serverId) return []

  const previousNames = new Map(previous.sessions.map((session) => [session.id, session.name]))
  const renames: SessionRename[] = []
  for (const session of next.sessions) {
    const previousName = previousNames.get(session.id)
    if (previousName !== undefined && previousName !== session.name) {
      renames.push({ sessionId: session.id, previousName, name: session.name })
    }
  }
  return renames
}
