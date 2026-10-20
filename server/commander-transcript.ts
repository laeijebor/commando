import { open } from 'node:fs/promises'
import type { ChatItem } from '../shared/agent-chat.js'
import { ClaudeItemMapper } from './agent-host/claude-items.js'
import { completedCommand } from './external-agents/codex-rollout.js'
import { record, textContent } from './external-agents/progress.js'

/** Starting window for a transcript tail; it grows until the current turn's prompt is in it. */
const TAIL_BYTES = 4 * 1024 * 1024
/** Large request/result entries can push one turn past many megabytes; stop here. */
const MAX_TAIL_BYTES = 32 * 1024 * 1024

/** JSON lines from the end of a file, dropping a first line the slice cut in half. */
export async function tailJsonLines(path: string, bytes = TAIL_BYTES): Promise<{ lines: Record<string, unknown>[]; whole: boolean }> {
  const file = await open(path, 'r')
  try {
    const size = (await file.stat()).size, start = Math.max(0, size - bytes)
    const buffer = Buffer.alloc(size - start)
    const { bytesRead } = await file.read(buffer, 0, buffer.length, start)
    const lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n')
    if (start) lines.shift()
    return { whole: start === 0, lines: lines.flatMap((line) => {
      try { return [record(JSON.parse(line))] } catch { return [] }
    }) }
  } finally { await file.close() }
}

const isMessage = (line: Record<string, unknown>) => (line.type === 'user' || line.type === 'assistant') && !line.isSidechain
/** Harness messages logged as user turns (background task results, slash command output). */
const INJECTED = /^\s*<(?:task-notification|local-command-|command-name|command-message|system-reminder)/
/** A prompt the user typed, as opposed to tool results or injected context. */
const isPrompt = (line: Record<string, unknown>) => {
  if (line.type !== 'user' || line.isMeta || line.isSidechain) return false
  const content = record(line.message).content
  const text = typeof content === 'string' ? content : Array.isArray(content) ? textContent(content.filter((part) => record(part).type === 'text')) : ''
  return Boolean(text.trim()) && !INJECTED.test(text)
}

/**
 * The current conversation branch, oldest first: follows `parentUuid` back
 * from the newest message, so a rewound branch isn't shown as current.
 * `complete` is false when a parent fell outside the lines read.
 */
function currentChain(lines: readonly Record<string, unknown>[]): { chain: Record<string, unknown>[]; complete: boolean } {
  // Attachments and other entries sit in the parent chain too.
  const linked = lines.filter((line) => typeof line.uuid === 'string')
  const byId = new Map(linked.map((line) => [line.uuid as string, line]))
  const chain: Record<string, unknown>[] = []
  let line = [...linked].reverse().find(isMessage)
  while (line && chain.length < linked.length) {
    chain.push(line)
    if (line.parentUuid === null || line.parentUuid === undefined) return { chain: chain.reverse(), complete: true }
    line = byId.get(String(line.parentUuid))
  }
  return { chain: chain.reverse(), complete: !line && chain.length === 0 }
}

/** A terminal Claude Code transcript's current branch as chat items. */
export function claudeTranscriptItems(lines: readonly Record<string, unknown>[], now = Date.now): ChatItem[] {
  const messages = currentChain(lines).chain.filter((line) => isMessage(line) && !line.isMeta)
    .map((line) => ({ type: line.type as string, message: line.message, parent_tool_use_id: null }))
  return new ClaudeItemMapper(now).replay(messages)
}

/** Reads further back until the newest turn's prompt (or the conversation's start) is in the window. */
export async function claudeTranscriptFileItems(path: string, now = Date.now): Promise<ChatItem[]> {
  for (let bytes = TAIL_BYTES; ; bytes *= 2) {
    const { lines, whole } = await tailJsonLines(path, bytes)
    const { chain, complete } = currentChain(lines)
    if (whole || complete || chain.some(isPrompt) || bytes >= MAX_TAIL_BYTES) return claudeTranscriptItems(lines, now)
  }
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
