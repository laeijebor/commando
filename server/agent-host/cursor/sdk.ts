import type { AgentMessage, AgentOptions, ConversationTurn, GetAgentMessagesOptions, ListResult, ListRunsOptions, ModelListItem, Run, RunResult, SDKUserMessage, SendOptions, SteerAckOutcome } from '@cursor/sdk'
import { MAX_CHAT_ITEMS } from '../../../shared/agent-chat.js'
import { CursorItemMapper, list, record, string } from './items.js'

export interface CursorRun {
  wait(): Promise<RunResult>
  cancel(): Promise<void>
  steer?(text: string): Promise<SteerAckOutcome>
}
export interface CursorAgent {
  readonly agentId: string
  send(message: SDKUserMessage, options: SendOptions): Promise<CursorRun>
  close(): void
}
export interface CursorHistory {
  turns: ConversationTurn[]
  skipped: number
}
type HistoryRun = Pick<Run, 'createdAt' | 'conversation'>
/** Only the SDK operations the chat uses; tests never load the real SDK. */
export interface CursorSdk {
  authStatus(): Promise<{ status: 'logged-in' | 'logged-out'; email?: string }>
  login(options: { onLoginUrl: (url: string) => void; signal: AbortSignal }): Promise<{ email?: string }>
  listModels(): Promise<ModelListItem[]>
  create(options: AgentOptions): Promise<CursorAgent>
  resume(agentId: string, options: AgentOptions): Promise<CursorAgent>
  history(agentId: string, cwd: string): Promise<CursorHistory>
}

/** A message's turn is a protobuf oneof (`{ turn: { case, value } }`); its JSON form is `{ agentConversationTurn }`. */
function messageTurn(message: unknown): Record<string, unknown> {
  const turn = record(record(message).turn)
  return turn.case === 'agentConversationTurn' ? record(turn.value) : record(record(message).agentConversationTurn)
}

export async function cursorHistory(
  listRuns: (agentId: string, options: ListRunsOptions) => Promise<ListResult<HistoryRun>>,
  agentId: string, cwd: string, log?: (message: string) => void,
  listMessages?: (agentId: string, options: GetAgentMessagesOptions) => Promise<Pick<AgentMessage, 'type' | 'uuid' | 'message'>[]>,
): Promise<CursorHistory> {
  const runs: HistoryRun[] = []
  const turns: ConversationTurn[] = []
  const counter = new CursorItemMapper()
  let skipped = 0
  let cursor: string | undefined
  const seen = new Set<string>()
  do {
    // Local run pages are oldest first with no sort option; collect metadata before reading conversations.
    const page = await listRuns(agentId, { runtime: 'local', cwd, limit: 100, ...(cursor ? { cursor } : {}) })
    runs.push(...page.items)
    cursor = page.nextCursor
    if (cursor && seen.has(cursor)) throw new Error('Cursor repeated a history cursor')
    if (cursor) seen.add(cursor)
  } while (cursor)
  // Local run conversations omit the prompt that opened each run. The agent's messages keep
  // every prompt in order, each with the steps that answered it, so align them newest first
  // by step count: a steer can fold the opening prompt's steps into the steered turn, which
  // leaves that prompt step-less and unmatched. Any other mismatch stops the backfill.
  let prompts: { text?: string; steps: number }[] | undefined
  if (listMessages) {
    try {
      const indexed: { index: number; text?: string; steps: number }[] = []
      for (let offset = 0; ; offset += 100) {
        const messages = await listMessages(agentId, { runtime: 'local', cwd, limit: 100, offset })
        for (const entry of messages) {
          const index = entry.uuid.startsWith(`${agentId}:`) ? entry.uuid.slice(agentId.length + 1) : ''
          if (!/^\d+$/.test(index) || !Number.isSafeInteger(Number(index))) continue
          const turn = messageTurn(entry.message)
          indexed.push({ index: Number(index), text: string(record(turn.userMessage).text), steps: list(turn.steps).length })
        }
        if (messages.length < 100) break
      }
      prompts = indexed.sort((a, b) => a.index - b.index)
    } catch (error) {
      log?.(`Couldn't load Cursor user messages: ${string(record(error).message) ?? String(error)}`)
    }
  }
  const full = () => counter.list().length >= MAX_CHAT_ITEMS
  const add = (turn: ConversationTurn) => { turns.push(turn); counter.replay(turn) }
  const ordered = runs.map((run, index) => ({ run, index })).sort((a, b) => (b.run.createdAt ?? 0) - (a.run.createdAt ?? 0) || b.index - a.index)
  for (const { run } of ordered) {
    let conversation: ConversationTurn[]
    try { conversation = await run.conversation() }
    catch (error) {
      skipped++
      // An unreadable run has an unknown number of turns, so older prompts can't be placed.
      prompts = undefined
      log?.(`Couldn't load a Cursor run: ${string(record(error).message) ?? String(error)}`)
      continue
    }
    for (let position = conversation.length - 1; position >= 0 && !full(); position--) {
      const entry = conversation[position]
      // A shell turn's place among the messages is unknown, so it also ends the backfill.
      if (entry.type !== 'agentConversationTurn') prompts = undefined
      if (entry.type !== 'agentConversationTurn' || !prompts) { add(entry); continue }
      const steps = entry.turn.steps.length
      let prompt = prompts.pop()
      const folded: string[] = []
      while (prompt && prompt.steps !== steps && prompt.steps === 0) {
        if (prompt.text !== undefined) folded.push(prompt.text)
        prompt = prompts.pop()
      }
      if (!prompt || prompt.steps !== steps) { prompts = undefined; add(entry); continue }
      // Folded prompts sit between this turn and the newer one already added (the walk runs backwards).
      for (const text of folded) if (!full()) add({ type: 'agentConversationTurn', turn: { userMessage: { text }, steps: [] } })
      if (!full()) add(!entry.turn.userMessage && prompt.text !== undefined ? { ...entry, turn: { ...entry.turn, userMessage: { text: prompt.text } } } : entry)
    }
    if (full()) break
  }
  return { turns: turns.reverse(), skipped }
}

export async function loadCursorSdk(log?: (message: string) => void): Promise<CursorSdk> {
  const { Agent, Cursor } = await import('@cursor/sdk')
  return {
    authStatus: () => Cursor.auth.status(),
    login: async ({ onLoginUrl, signal }) => {
      const { email } = await Cursor.auth.login({ openBrowser: true, onLoginUrl, signal, apiKeyName: 'Commando' })
      return { email }
    },
    listModels: () => Cursor.models.list(),
    create: (options) => Agent.create(options),
    resume: (agentId, options) => Agent.resume(agentId, options),
    history: (agentId, cwd) => cursorHistory((id, options) => Agent.listRuns(id, options), agentId, cwd, log, (id, options) => Agent.messages.list(id, options)),
  }
}
