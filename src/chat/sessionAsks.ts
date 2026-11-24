import type { ChatItem } from '../../shared/agent-chat'
import type { SessionAsk, SessionBrief, TmuxPane } from '../../shared/protocol'

const NO_ASKS: readonly SessionAsk[] = []

function findLast<T>(list: readonly T[], match: (item: T) => boolean): T | undefined {
  for (let index = list.length - 1; index >= 0; index -= 1) if (match(list[index]!)) return list[index]
  return undefined
}

/** A pane's open asks; a brief left behind by an earlier pane with the same id has none for it. */
export function paneAsks(brief: SessionBrief | undefined, pane: Pick<TmuxPane, 'targetId'> | undefined): readonly SessionAsk[] {
  if (!brief?.asks?.length || (brief.targetId && pane && brief.targetId !== pane.targetId)) return NO_ASKS
  return brief.asks
}

/**
 * The reply each ask belongs to: the agent raises it during a turn and usually explains it in
 * that turn's last reply, so that's where it was asked. Keyed by ask key, valued by item id.
 */
export function askAnchors(items: readonly ChatItem[], asks: readonly SessionAsk[]): Map<string, string> {
  const anchors = new Map<string, string>()
  const main = items.filter((item) => !item.parentToolUseId)
  for (const ask of asks) {
    const turnId = findLast(main, (item) => item.createdAt <= ask.askedAt)?.turnId
    if (turnId === undefined) continue
    const reply = findLast(main, (item) => item.kind === 'assistant_message' && item.turnId === turnId)
      ?? findLast(main, (item) => item.kind === 'assistant_message' && item.createdAt <= ask.askedAt)
    if (reply) anchors.set(ask.key, reply.id)
  }
  return anchors
}

/** How many open asks each reply carries, for its inline marker. */
export function askMarkerCounts(anchors: ReadonlyMap<string, string>): Map<string, number> {
  const counts = new Map<string, number>()
  for (const itemId of anchors.values()) counts.set(itemId, (counts.get(itemId) ?? 0) + 1)
  return counts
}
