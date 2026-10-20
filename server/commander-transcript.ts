import { open } from 'node:fs/promises'
import type { ChatItem } from '../shared/agent-chat.js'
import { ClaudeItemMapper } from './agent-host/claude-items.js'
import { completedCommand } from './external-agents/codex-rollout.js'
import { record, textContent } from './external-agents/progress.js'

/** Enough recent history to read an agent's last few turns without loading whole transcripts. */
const TAIL_BYTES = 4 * 1024 * 1024

/** JSON lines from the end of a file, dropping a first line the slice cut in half. */
export async function tailJsonLines(path: string, bytes = TAIL_BYTES): Promise<Record<string, unknown>[]> {
  const file = await open(path, 'r')
  try {
    const size = (await file.stat()).size, start = Math.max(0, size - bytes)
    const buffer = Buffer.alloc(size - start)
    const { bytesRead } = await file.read(buffer, 0, buffer.length, start)
    const lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n')
    if (start) lines.shift()
    return lines.flatMap((line) => {
      try { return [record(JSON.parse(line))] } catch { return [] }
    })
  } finally { await file.close() }
}

/**
 * A terminal Claude Code transcript as chat items. Follows `parentUuid` back
 * from the newest message, so a rewound branch isn't shown as current.
 */
export function claudeTranscriptItems(lines: readonly Record<string, unknown>[], now = Date.now): ChatItem[] {
  const message = (line: Record<string, unknown>) => (line.type === 'user' || line.type === 'assistant') && !line.isSidechain
  // Attachments and other entries sit in the parent chain too.
  const linked = lines.filter((line) => typeof line.uuid === 'string')
  const byId = new Map(linked.map((line) => [line.uuid as string, line]))
  const chain: Record<string, unknown>[] = []
  for (let line = [...linked].reverse().find(message); line && chain.length < linked.length; line = byId.get(String(line.parentUuid))) chain.push(line)
  const messages = chain.reverse().filter((line) => message(line) && !line.isMeta)
    .map((line) => ({ type: line.type as string, message: line.message, parent_tool_use_id: null }))
  return new ClaudeItemMapper(now).replay(messages)
}

/** A terminal Codex rollout's messages and commands as chat items. */
export function codexRolloutItems(lines: readonly Record<string, unknown>[]): ChatItem[] {
  const items: ChatItem[] = []
  let turn = 0, index = 0
  const base = (createdAt: number) => ({ id: `codex-${index++}`, turnId: `codex-turn-${turn}`, status: 'completed' as const, createdAt, updatedAt: createdAt })
  for (const line of lines) {
    const payload = record(line.payload), item = record(payload.item)
    if (line.type !== 'event_msg' || payload.type !== 'item_completed') continue
    const at = Date.parse(String(line.timestamp)) || 0
    if (item.type === 'UserMessage') {
      const text = textContent(item.content).trim()
      if (!text) continue
      turn += 1
      items.push({ ...base(at), kind: 'user_message', text })
    } else if (item.type === 'AgentMessage') {
      const text = textContent(item.content).trim()
      if (text) items.push({ ...base(at), kind: 'assistant_message', text })
    } else if (item.type === 'CommandExecution') {
      const command = completedCommand(item.command)
      if (command) items.push({ ...base(at), kind: 'command', toolUseId: `codex-cmd-${index}`, command })
    }
  }
  return items
}
