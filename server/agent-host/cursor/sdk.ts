import type { AgentOptions, ConversationTurn, ListResult, ListRunsOptions, ModelListItem, Run, RunResult, SDKUserMessage, SendOptions, SteerAckOutcome } from '@cursor/sdk'

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
/** Only the SDK operations the chat uses; tests never load the real SDK. */
export interface CursorSdk {
  authStatus(): Promise<{ status: 'logged-in' | 'logged-out'; email?: string }>
  login(options: { onLoginUrl: (url: string) => void; signal: AbortSignal }): Promise<{ email?: string }>
  listModels(): Promise<ModelListItem[]>
  create(options: AgentOptions): Promise<CursorAgent>
  resume(agentId: string, options: AgentOptions): Promise<CursorAgent>
  history(agentId: string, cwd: string): Promise<ConversationTurn[]>
}

export async function cursorHistory(
  listRuns: (agentId: string, options: ListRunsOptions) => Promise<ListResult<Pick<Run, 'createdAt' | 'conversation'>>>,
  agentId: string, cwd: string, log?: (message: string) => void,
): Promise<ConversationTurn[]> {
  const runs: Pick<Run, 'createdAt' | 'conversation'>[] = []
  let cursor: string | undefined
  const seen = new Set<string>()
  do {
    const page = await listRuns(agentId, { runtime: 'local', cwd, ...(cursor ? { cursor } : {}) })
    runs.push(...page.items)
    cursor = page.nextCursor
    if (cursor && seen.has(cursor)) throw new Error('Cursor repeated a history cursor')
    if (cursor) seen.add(cursor)
  } while (cursor)
  const turns: ConversationTurn[] = []
  for (const run of runs.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))) {
    try { turns.push(...await run.conversation()) }
    catch { log?.('Could not read a Cursor run; skipping it.') }
  }
  return turns
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
    history: (agentId, cwd) => cursorHistory((id, options) => Agent.listRuns(id, options), agentId, cwd, log),
  }
}
