import type { AgentMessage, AgentOptions, ConversationTurn, GetAgentMessagesOptions, ListResult, ListRunsOptions, ModelListItem, Run, RunResult, SDKUserMessage, SendOptions, SteerAckOutcome } from '@cursor/sdk'
import { MAX_CHAT_ITEMS } from '../../../shared/agent-chat.js'
import { CursorItemMapper, record, string } from './items.js'

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
  // Local run conversations omit the prompt that opened each run, but the agent's messages
  // keep every prompt in order: one per run, plus one per steer. Steered turns keep their own
  // text, so each run takes its steers plus one prompt from the newest end, checked against
  // those texts. A steer can fold the opening turn into the steered one, leaving the opening
  // prompt to stand on its own. Anything that doesn't line up stops the backfill.
  let prompts: (string | undefined)[] | undefined
  if (listMessages) {
    try {
      const indexed: { index: number; text?: string }[] = []
      for (let offset = 0; ; offset += 100) {
        const messages = await listMessages(agentId, { runtime: 'local', cwd, limit: 100, offset })
        for (const entry of messages) {
          const index = entry.uuid.startsWith(`${agentId}:`) ? entry.uuid.slice(agentId.length + 1) : ''
          if (entry.type !== 'user' || !/^\d+$/.test(index) || !Number.isSafeInteger(Number(index))) continue
          indexed.push({ index: Number(index), text: string(record(messageTurn(entry.message).userMessage).text) })
        }
        if (messages.length < 100) break
      }
      prompts = indexed.sort((a, b) => a.index - b.index).map((entry) => entry.text)
    } catch (error) {
      log?.(`Couldn't load Cursor user messages: ${string(record(error).message) ?? String(error)}`)
    }
  }
  const ordered = runs.map((run, index) => ({ run, index })).sort((a, b) => (b.run.createdAt ?? 0) - (a.run.createdAt ?? 0) || b.index - a.index)
  for (const { run } of ordered) {
    let conversation: ConversationTurn[]
    try { conversation = await run.conversation() }
    catch (error) {
      skipped++
      // An unreadable run has an unknown number of steers, so older prompts can't be placed.
      prompts = undefined
      log?.(`Couldn't load a Cursor run: ${string(record(error).message) ?? String(error)}`)
      continue
    }
    const runTurns = [...conversation]
    // A shell turn's place among the messages is unknown, so it also ends the backfill.
    if (runTurns.some((turn) => turn.type !== 'agentConversationTurn')) prompts = undefined
    if (prompts) {
      const steers = runTurns.flatMap((turn) => turn.type === 'agentConversationTurn' && turn.turn.userMessage ? [turn.turn.userMessage.text] : [])
      const taken = prompts.length > steers.length ? prompts.splice(-(steers.length + 1)) : []
      if (!taken.length || taken.slice(1).some((text, index) => text !== steers[index])) prompts = undefined
      else if (taken[0] !== undefined) {
        const first = runTurns[0]
        if (first?.type === 'agentConversationTurn' && !first.turn.userMessage) runTurns[0] = { ...first, turn: { ...first.turn, userMessage: { text: taken[0] } } }
        else runTurns.unshift({ type: 'agentConversationTurn', turn: { userMessage: { text: taken[0] }, steps: [] } })
      }
    }
    for (let position = runTurns.length - 1; position >= 0 && counter.list().length < MAX_CHAT_ITEMS; position--) {
      turns.push(runTurns[position])
      counter.replay(runTurns[position])
    }
    if (counter.list().length >= MAX_CHAT_ITEMS) break
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
