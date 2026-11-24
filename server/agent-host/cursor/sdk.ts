import type { AgentMessage, AgentOptions, ConversationTurn, GetAgentMessagesOptions, ListResult, ListRunsOptions, ModelListItem, Run, RunResult, SDKMessage, SDKUserMessage, SendOptions, SteerAckOutcome } from '@cursor/sdk'
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
  reload?(): Promise<void>
  close(): void
}
export interface CursorHistory {
  turns: ConversationTurn[]
  skipped: number
}
export type CursorCloudRun = CursorRun & Pick<Run, 'id' | 'status' | 'stream' | 'conversation' | 'createdAt' | 'git'>
export type CursorGitBranch = NonNullable<RunResult['git']>['branches'][number]
export interface CursorCloudHistory extends CursorHistory {
  running?: { id: string }
  git?: CursorGitBranch
}

type CloudStreamUpdate = { type: 'text-delta' | 'thinking-delta'; text: string }
  | { type: 'tool-call-started' | 'tool-call-completed'; callId: string; toolCall: { type: string; args?: unknown; result?: unknown } }
export function cloudStreamUpdates(message: SDKMessage): CloudStreamUpdate[] {
  if (message.type === 'thinking') return [{ type: 'thinking-delta', text: message.text }]
  if (message.type === 'assistant') return message.message.content.map((block): CloudStreamUpdate => block.type === 'text'
    ? { type: 'text-delta', text: block.text }
    : { type: 'tool-call-started', callId: block.id, toolCall: { type: block.name, args: block.input } })
  if (message.type !== 'tool_call') return []
  const result = record(message.result)
  const toolResult = message.status === 'error' ? { status: 'error', error: result.error ?? message.result }
    : result.status === 'success' || result.status === 'error' ? message.result : { status: 'success', value: message.result }
  return [{ type: message.status === 'running' ? 'tool-call-started' : 'tool-call-completed', callId: message.call_id,
    toolCall: { type: message.name, ...(message.args !== undefined ? { args: message.args } : {}), ...(message.status !== 'running' ? { result: toolResult } : {}) } }]
}
type HistoryRun = Pick<Run, 'createdAt' | 'conversation'> & Partial<Pick<Run, 'status'>>
/** Only the SDK operations the chat uses; tests never load the real SDK. */
export interface CursorSdk {
  authStatus(): Promise<{ status: 'logged-in' | 'logged-out'; email?: string }>
  login(options: { onLoginUrl: (url: string) => void; signal: AbortSignal }): Promise<{ email?: string }>
  listModels(): Promise<ModelListItem[]>
  create(options: AgentOptions): Promise<CursorAgent>
  resume(agentId: string, options: AgentOptions): Promise<CursorAgent>
  history(agentId: string, cwd: string): Promise<CursorHistory>
  cloudHistory(agentId: string): Promise<CursorCloudHistory>
  latestCloudRun(agentId: string): Promise<CursorCloudRun | undefined>
  getRun(runId: string, agentId: string): Promise<CursorCloudRun>
}

export async function cursorCloudHistory(
  listRuns: (agentId: string, options: ListRunsOptions) => Promise<ListResult<CursorCloudRun>>,
  agentId: string, log?: (message: string) => void,
): Promise<CursorCloudHistory> {
  const runs: CursorCloudRun[] = []
  let cursor: string | undefined
  const seen = new Set<string>()
  do {
    const page = await listRuns(agentId, { runtime: 'cloud', limit: 100, ...(cursor ? { cursor } : {}) })
    runs.push(...page.items)
    cursor = page.nextCursor
    if (cursor && seen.has(cursor)) throw new Error('Cursor repeated a history cursor')
    if (cursor) seen.add(cursor)
  } while (cursor)
  const ordered = runs.map((run, index) => ({ run, index })).sort((a, b) => (b.run.createdAt ?? 0) - (a.run.createdAt ?? 0) || b.index - a.index).map(({ run }) => run)
  const git = ordered.find((run) => run.git?.branches.length)?.git?.branches[0]
  const running = ordered[0]?.status === 'running' ? { id: ordered[0].id } : undefined
  const turns: ConversationTurn[] = []
  const counter = new CursorItemMapper()
  let skipped = 0
  // Running conversations block until completion; reattach through stream() instead.
  const finished = ordered.filter((run) => run.status !== 'running')
  history: for (let offset = 0; offset < finished.length; offset += 4) {
    const batch = await Promise.allSettled(finished.slice(offset, offset + 4).map((run) => run.conversation()))
    // Consume in newest-first order regardless of completion order. Only prefetch one batch.
    for (const result of batch) {
      if (result.status === 'rejected') {
        skipped++
        log?.(`Couldn't load a Cursor run: ${string(record(result.reason).message) ?? String(result.reason)}`)
        continue
      }
      const conversation = result.value
      for (let position = conversation.length - 1; position >= 0 && counter.list().length < MAX_CHAT_ITEMS; position--) {
        turns.push(conversation[position])
        counter.replay(conversation[position])
      }
      if (counter.list().length >= MAX_CHAT_ITEMS) break history
    }
  }
  return { turns: turns.reverse(), skipped, ...(running ? { running } : {}), ...(git ? { git } : {}) }
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
  // those texts and the opening turn's step count (a cancelled run may have saved fewer steps
  // than its message). A steer can fold the opening turn into the steered one, leaving the
  // opening prompt step-less and on its own. Anything that doesn't line up stops the backfill.
  let prompts: { text?: string; steps: number }[] | undefined
  if (listMessages) {
    try {
      // One call: the local store rebuilds the whole conversation for every page it serves.
      const indexed = (await listMessages(agentId, { runtime: 'local', cwd })).flatMap((entry) => {
        const index = entry.uuid.startsWith(`${agentId}:`) ? entry.uuid.slice(agentId.length + 1) : ''
        if (entry.type !== 'user' || !/^\d+$/.test(index) || !Number.isSafeInteger(Number(index))) return []
        const turn = messageTurn(entry.message)
        return [{ index: Number(index), text: string(record(turn.userMessage).text), steps: list(turn.steps).length }]
      })
      prompts = indexed.sort((a, b) => a.index - b.index).map(({ text, steps }) => ({ text, steps }))
    } catch (error) {
      log?.(`Couldn't load Cursor user messages: ${string(record(error).message) ?? String(error)}`)
    }
  }
  const stopBackfill = (reason: string) => { if (prompts) log?.(`Cursor history prompts stop here: ${reason}`); prompts = undefined }
  const ordered = runs.map((run, index) => ({ run, index })).sort((a, b) => (b.run.createdAt ?? 0) - (a.run.createdAt ?? 0) || b.index - a.index)
  for (const { run } of ordered) {
    let conversation: ConversationTurn[]
    try { conversation = await run.conversation() }
    catch (error) {
      skipped++
      // An unreadable run has an unknown number of steers, so older prompts can't be placed.
      stopBackfill('a run could not be read')
      log?.(`Couldn't load a Cursor run: ${string(record(error).message) ?? String(error)}`)
      continue
    }
    const runTurns = [...conversation]
    // A shell turn's place among the messages is unknown, so it also ends the backfill.
    if (runTurns.some((turn) => turn.type !== 'agentConversationTurn')) stopBackfill('a shell turn')
    if (prompts) {
      const steers = runTurns.flatMap((turn) => turn.type === 'agentConversationTurn' && turn.turn.userMessage ? [turn.turn.userMessage.text] : [])
      const taken = prompts.length > steers.length ? prompts.splice(-(steers.length + 1)) : []
      const first = runTurns[0]
      const opening = first?.type === 'agentConversationTurn' && !first.turn.userMessage ? first : undefined
      const steps = opening?.turn.steps.length ?? 0
      if (!taken.length || taken.slice(1).some(({ text }, index) => text !== steers[index])) stopBackfill('steers do not match their messages')
      else if (run.status === 'finished' ? taken[0].steps !== steps : taken[0].steps < steps) stopBackfill('a run does not match its prompt')
      else if (taken[0].text !== undefined) {
        if (opening) runTurns[0] = { ...opening, turn: { ...opening.turn, userMessage: { text: taken[0].text } } }
        else runTurns.unshift({ type: 'agentConversationTurn', turn: { userMessage: { text: taken[0].text }, steps: [] } })
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
    cloudHistory: (agentId) => cursorCloudHistory((id, options) => Agent.listRuns(id, options), agentId, log),
    // Cloud run lists are newest first. This lookup never reads conversations or older pages.
    latestCloudRun: async (agentId) => (await Agent.listRuns(agentId, { runtime: 'cloud', limit: 1 })).items[0],
    getRun: (runId, agentId) => Agent.getRun(runId, { runtime: 'cloud', agentId }),
  }
}
