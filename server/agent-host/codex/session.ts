import {
  AGENT_HOST_PROTOCOL_VERSION,
  MAX_CHAT_ITEMS,
  MAX_CHAT_IMAGES,
  MAX_QUEUED_MESSAGES,
  isChatEffort,
  isModelValue,
  type ChatAnswer,
  type ChatCommand,
  type ChatContextUsage,
  type ChatFileSearchResult,
  type ChatImageRef,
  type ChatItem,
  type ChatModelOption,
  type ChatQueueAction,
  type ChatQueuedMessage,
  type ChatSendOptions,
  type ChatSessionInfo,
  type ChatSessionPermissionMode,
  type ChatSettingsChange,
  type ChatSubagentTranscript,
  type ChatSwitchAction,
  type ChatTaskAction,
} from '../../../shared/agent-chat.js'
import { shellQuote } from '../../agent-resume-command.js'
import { WorkspaceFileIndex } from '../file-index.js'
import type { ChatProviderSession, ChatProviderSessionEvents, ChatProviderTui } from '../provider.js'
import type { AgentSessionSpec } from '../session.js'
import { CodexRpcClient, type CodexTransport } from './client.js'
import { CodexItemMapper, inputQuestions } from './items.js'
import {
  list,
  parseThread,
  parsePermissions,
  record,
  requestKey,
  rpcId,
  string,
  type ApprovalPolicy,
  type CodexTurn,
  type RpcNotification,
  type RpcRequest,
  type SandboxMode,
  type SandboxPolicy,
  type UserInput,
} from './protocol.js'

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)
/**
 * Codex has no separate "ask before edits" policy. Both default and acceptEdits
 * mean on-request/workspace-write: workspace edits and sandboxed commands are
 * allowed, escalation asks. Only default is offered in the Codex picker.
 * Read-only is the plan approximation; it can still request escalation.
 */
export function codexPermissions(mode: ChatSessionPermissionMode, cwd: string): { approvalPolicy: ApprovalPolicy; sandbox: SandboxMode; sandboxPolicy: SandboxPolicy } {
  if (mode === 'bypassPermissions') return { approvalPolicy: 'never', sandbox: 'danger-full-access', sandboxPolicy: { type: 'dangerFullAccess' } }
  if (mode === 'plan') return { approvalPolicy: 'on-request', sandbox: 'read-only', sandboxPolicy: { type: 'readOnly', networkAccess: false } }
  if (mode !== 'default' && mode !== 'acceptEdits') throw new Error(`Codex does not support permission mode ${mode}`)
  return {
    approvalPolicy: 'on-request',
    sandbox: 'workspace-write',
    sandboxPolicy: {
      type: 'workspaceWrite', writableRoots: [cwd], networkAccess: false,
      excludeTmpdirEnvVar: false, excludeSlashTmp: false,
    },
  }
}
export function codexTuiSwitchCommand(
  spec: Pick<AgentSessionSpec, 'model' | 'effort' | 'permissionMode' | 'cwd'> & { serviceTier?: string },
  executable: string,
  launcher: string,
  threadId: string,
  returnFlags: readonly string[],
): string {
  const permissions = codexPermissions(spec.permissionMode, spec.cwd)
  const tui = [
    executable, 'resume', '--no-daemon',
    ...(spec.model ? ['--model', spec.model] : []),
    ...(spec.effort ? ['-c', `model_reasoning_effort=${JSON.stringify(spec.effort)}`] : []),
    ...(spec.serviceTier ? ['-c', `service_tier=${JSON.stringify(spec.serviceTier)}`] : []),
    '--ask-for-approval', permissions.approvalPolicy, '--sandbox', permissions.sandbox, threadId,
  ].map(shellQuote).join(' ')
  // The existing return flag is a backwards-compatible host flag, shared by both providers.
  const back = ['exec', ...[launcher, 'codex', ...returnFlags, '--resume', threadId, '--from-claude-code'].map(shellQuote)].join(' ')
  return `exec /bin/bash -c ${shellQuote(`set -m; ${tui}; ${back}`)}`
}
export function codexContextUsage(value: unknown): ChatContextUsage | undefined {
  const usage = record(value)
  const last = record(usage.last)
  const max = usage.modelContextWindow
  const input = last.inputTokens
  const output = last.outputTokens
  if (typeof max !== 'number' || !Number.isFinite(max) || max <= 0
    || typeof input !== 'number' || !Number.isFinite(input) || input < 0
    || typeof output !== 'number' || !Number.isFinite(output) || output < 0) return undefined
  // Totals are cumulative billing usage, not the size of the current context.
  return { usedTokens: input + output, maxTokens: max, autoCompact: true, categories: [{ name: 'Input', tokens: input }, { name: 'Output', tokens: output }] }
}
/** The service tier a model lists as "Fast" (`priority` today), which fast mode runs on. */
export function codexFastTier(value: unknown): string | undefined {
  const tiers = list(record(value).serviceTiers).map(record)
  return string(tiers.find((tier) => string(tier.id) && /^fast$/i.test(string(tier.name) ?? ''))?.id)
}
export function codexModels(value: unknown): ChatModelOption[] {
  return list(value).flatMap((value) => {
    const model = record(value)
    if (model.hidden === true || !isModelValue(model.model) || !string(model.displayName)) return []
    const efforts = list(model.supportedReasoningEfforts).flatMap((value) => {
      const effort = record(value).reasoningEffort
      return isChatEffort(effort) ? [effort] : []
    })
    return [{ value: model.model, resolvedModel: model.model, displayName: model.displayName as string, description: string(model.description), efforts,
      ...(codexFastTier(model) ? { supportsFast: true } : {}) }]
  })
}

export class CodexChatSession implements ChatProviderSession {
  readonly commands: ChatCommand[] = []
  readonly tui: ChatProviderTui
  private readonly client: CodexTransport
  private readonly mapper: CodexItemMapper
  private readonly files: WorkspaceFileIndex
  private readonly listeners: { [K in keyof ChatProviderSessionEvents]: ChatProviderSessionEvents[K][] } = { items: [], session: [], commands: [], closed: [] }
  private readonly readyListeners: (() => void)[] = []
  private readonly pending = new Map<string, RpcRequest>()
  /** Each fast-capable model's fast service tier. */
  private readonly fastTiers = new Map<string, string>()
  private info: ChatSessionInfo
  private startPromise?: Promise<void>
  private activeTurn?: string
  private readonly endedTurns = new Set<string>()
  private sending = 0
  private operations = Promise.resolve()
  private queue: ChatQueuedMessage[] = []
  private queueCounter = 0
  private closing = false
  private closed = false
  private interrupting = false

  constructor(private readonly spec: AgentSessionSpec, client?: CodexTransport, executable = 'codex') {
    codexPermissions(spec.permissionMode, spec.cwd)
    this.client = client ?? new CodexRpcClient({ cwd: spec.cwd, env: { ...spec.env, ...(spec.resumeCommand ? { COMMANDO_CHAT_RESUME: spec.resumeCommand } : {}) }, executable, log: spec.log })
    this.mapper = new CodexItemMapper(Date.now, (path) => {
      const image = spec.images?.stagedImage(path)
      return image ? { id: image.id } : undefined
    })
    this.files = new WorkspaceFileIndex(spec.cwd)
    this.info = {
      paneId: spec.paneId,
      provider: 'codex',
      cwd: spec.cwd,
      status: 'starting',
      hostPid: process.pid,
      hostVersion: AGENT_HOST_PROTOCOL_VERSION,
      ...(spec.resume ? { sessionId: spec.resume } : {}),
      permissionMode: spec.permissionMode === 'acceptEdits' ? 'default' : spec.permissionMode,
      bypassAllowed: spec.bypassAllowed || spec.permissionMode === 'bypassPermissions',
      ...(spec.model ? { selectedModel: spec.model } : {}),
      ...(spec.effort ? { effort: spec.effort } : {}),
      ...(spec.fast ? { fast: true } : {}),
      ...(spec.prePlanPermissionMode ? { prePlanPermissionMode: spec.prePlanPermissionMode } : {}),
      ...(spec.hostBuild ? { hostBuild: spec.hostBuild } : {}),
      ...(spec.resumeCommand ? { resumeCommand: spec.resumeCommand } : {}),
    }
    this.client.onNotification((message) => this.notification(message))
    this.client.onRequest((request) => this.serverRequest(request))
    this.client.onClose((error) => this.finish(error))
    this.tui = {
      label: 'Codex TUI',
      env: {
        ...(spec.env.CODEX_HOME ? { CODEX_HOME: spec.env.CODEX_HOME } : {}),
        ...(spec.resumeCommand ? { COMMANDO_CHAT_RESUME: spec.resumeCommand } : {}),
      },
      onReady: (listener) => this.readyListeners.push(listener),
      requestSwitch: (action) => this.requestSwitch(action),
      command: (launcher, flags, id) => {
        if (!launcher || !id) throw new Error('Switching to Codex TUI needs the launcher and a thread id')
        return codexTuiSwitchCommand({
          cwd: spec.cwd, model: this.info.selectedModel, effort: this.info.effort, serviceTier: this.serviceTier(),
          permissionMode: this.info.permissionMode as ChatSessionPermissionMode,
        }, executable, launcher, id, flags)
      },
      handOver: () => { this.setQueue([]); this.close() },
      endSwitch: (notice) => this.endSwitch(notice),
    }
  }
  get paneId(): string { return this.spec.paneId }
  get busy(): boolean { return Boolean(this.activeTurn || this.sending || this.pending.size || this.queue.length || this.info.status === 'starting') }
  get queued(): ChatQueuedMessage[] { return [...this.queue] }
  on<K extends keyof ChatProviderSessionEvents>(event: K, listener: ChatProviderSessionEvents[K]): void { this.listeners[event].push(listener) }
  private emitItems(items: ChatItem[]): void { if (items.length) this.listeners.items.forEach((listener) => listener(items)) }
  private update(change: Partial<ChatSessionInfo>): void { this.info = { ...this.info, ...change }; this.listeners.session.forEach((listener) => listener(this.info)) }
  snapshot(): { session: ChatSessionInfo; items: ChatItem[] } { return { session: { ...this.info }, items: this.mapper.list() } }
  setResumeCommand(command: string): void { this.tui.env.COMMANDO_CHAT_RESUME = command; if (this.info.resumeCommand !== command) this.update({ resumeCommand: command }) }
  start(): Promise<void> { return this.startPromise ??= this.initialize() }
  private async initialize(): Promise<void> {
    try {
      await this.client.start()
      const models: ChatModelOption[] = []
      let cursor: string | undefined
      const cursors = new Set<string>()
      do {
        const result = record(await this.client.request('model/list', { ...(cursor ? { cursor } : {}), limit: 100 }))
        models.push(...codexModels(result.data))
        for (const model of list(result.data)) {
          const tier = codexFastTier(model)
          if (tier && isModelValue(record(model).model)) this.fastTiers.set(record(model).model as string, tier)
        }
        cursor = string(result.nextCursor)
        if (cursor && cursors.has(cursor)) throw new Error('Codex repeated a model cursor')
        if (cursor) cursors.add(cursor)
      } while (cursor)
      this.update({ models })
      const { sandbox, approvalPolicy } = codexPermissions(this.info.permissionMode as ChatSessionPermissionMode, this.spec.cwd)
      const settings = { cwd: this.spec.cwd, sandbox, approvalPolicy, approvalsReviewer: 'user' as const, ...(this.info.selectedModel ? { model: this.info.selectedModel } : {}) }
      const response = record(await (this.spec.resume ? this.client.request('thread/resume', { threadId: this.spec.resume, ...settings }) : this.client.request('thread/start', settings)))
      const thread = parseThread(response.thread)
      if (this.closing) return
      this.update({ sessionId: thread.id, model: string(response.model), selectedModel: this.info.selectedModel ?? string(response.model),
        ...(isChatEffort(response.reasoningEffort) && !this.info.effort ? { effort: response.reasoningEffort } : {}),
        title: thread.name || thread.preview || undefined })
      if (this.spec.resume) {
        if (thread.historyMode === 'paginated') {
          let cursor: string | undefined
          const seen = new Set<string>()
          const history: CodexTurn[] = []
          // Count with a separate mapper so reverse-order traversal cannot change
          // the session mapper's notice ids or current turn.
          const counter = new CodexItemMapper()
          let itemCount = 0
          do {
            const page = record(await this.client.request('thread/turns/list', { threadId: thread.id, ...(cursor ? { cursor } : {}), limit: 100, sortDirection: 'desc', itemsView: 'full' }))
            if (this.closing) return
            const turns = parseThread({ id: thread.id, turns: page.data }).turns
            for (const turn of turns) {
              history.push(turn)
              counter.replay(turn)
              itemCount = counter.list().length
              if (itemCount >= MAX_CHAT_ITEMS) break
            }
            cursor = string(page.nextCursor)
            if (cursor && seen.has(cursor)) throw new Error('Codex repeated a history cursor')
            if (cursor) seen.add(cursor)
          } while (cursor && itemCount < MAX_CHAT_ITEMS && !this.closing)
          if (this.closing) return
          this.emitItems(history.reverse().flatMap((turn) => this.mapper.replay(turn)))
        } else {
          const read = record(await this.client.request('thread/read', { threadId: thread.id, includeTurns: true }))
          const history = parseThread(read.thread)
          this.emitItems(history.turns.flatMap((turn) => this.mapper.replay(turn)))
          if (history.name) this.update({ title: history.name })
        }
      }
      if (this.closing) return
      this.listeners.commands.forEach((listener) => listener([]))
      this.update({ status: this.activeTurn ? 'running' : 'idle' })
      if (this.spec.returnedFromClaudeCode) this.emitItems(this.mapper.notice('info', 'Returned from Codex TUI'))
      this.switchReady()
      if (this.spec.initialPrompt) this.send(this.spec.initialPrompt)
    } catch (error) {
      if (!this.closing) { this.emitItems(this.mapper.notice('error', `Couldn't start Codex: ${errorText(error)}`)); this.update({ status: 'error', error: errorText(error) }) }
      this.close()
    }
  }
  send(text: string, images: ChatImageRef[] = [], options: ChatSendOptions = {}): void {
    const trimmed = text.trim()
    if (!trimmed && !images.length) return
    if (this.closing || this.info.claudeCodeSwitch) { this.emitItems(this.mapper.notice('error', 'The chat is closed or switching to Codex TUI; this message was not sent.')); return }
    if (options.relayTo) { this.emitItems(this.mapper.notice('error', 'Codex subagent relay is not available in this chat.')); return }
    if (options.delivery === 'queue' && (this.activeTurn || this.sending)) {
      if (this.queue.length >= MAX_QUEUED_MESSAGES) { this.emitItems(this.mapper.notice('error', 'The message queue is full.')); return }
      this.setQueue([...this.queue, { id: `codex-queued-${++this.queueCounter}`, text: trimmed, ...(images.length ? { images } : {}) }])
      return
    }
    this.sending++
    this.operations = this.operations.then(async () => {
      await this.start()
      if (this.closing) return
      const threadId = this.info.sessionId
      if (!threadId) throw new Error('Codex has no thread id')
      if (images.length > MAX_CHAT_IMAGES) throw new Error('Too many images')
      const input: UserInput[] = trimmed ? [{ type: 'text', text: trimmed, text_elements: [] }] : []
      for (const image of images) {
        if (!this.spec.images) throw new Error('Chat images are unavailable')
        input.push({ type: 'localImage', path: await this.spec.images.stage(image.id, threadId) })
      }
      const active = this.activeTurn
      if (active && options.permissionMode) throw new Error('Permission changes apply to the next turn; wait for this turn to finish')
      if (options.permissionMode) this.applySettings({ permissionMode: options.permissionMode })
      this.mapper.expectUser(trimmed, images, Boolean(active))
      try {
        if (active) {
          try {
            await this.client.request('turn/steer', { threadId, expectedTurnId: active, input })
          } catch (error) {
            if (this.closing || this.activeTurn === active) throw error
            // Completion can race with steer. Keep the same text and staged images.
            this.mapper.forgetUser(trimmed)
            this.mapper.expectUser(trimmed, images, false)
            await this.startTurn(threadId, input)
          }
        } else await this.startTurn(threadId, input)
        if (!this.info.title && trimmed) this.update({ title: trimmed.slice(0, 80) })
      } catch (error) { this.mapper.forgetUser(trimmed); throw error }
    }).catch((error) => {
      if (!this.closing) { this.emitItems(this.mapper.notice('error', `Message not sent: ${errorText(error)}`)); if (!this.activeTurn) this.update({ status: 'idle' }) }
    }).finally(() => { this.sending--; this.switchReady(); this.flushQueue() })
  }
  private async startTurn(threadId: string, input: UserInput[]): Promise<void> {
    const { sandboxPolicy, approvalPolicy } = codexPermissions(this.info.permissionMode as ChatSessionPermissionMode, this.spec.cwd)
    const model = this.info.selectedModel
    const effort = this.info.effort ?? null
    this.update({ status: 'running' })
    const result = record(await this.client.request('turn/start', {
      threadId, input, approvalPolicy, approvalsReviewer: 'user', sandboxPolicy,
      // Null puts a thread that ran fast back on the standard tier.
      ...(model ? { model } : {}), effort, serviceTier: this.serviceTier() ?? null,
    }))
    const turnId = string(record(result.turn).id)
    if (!turnId) throw new Error('Codex returned a turn without an id')
    if (!this.endedTurns.has(turnId)) this.activeTurn = turnId
    this.update({ model })
  }
  updateQueue(change: ChatQueueAction): void {
    const entry = this.queue.find((entry) => entry.id === change.id)
    if (!entry) { this.emitItems(this.mapper.notice('info', 'That queued message has already been sent.')); return }
    if (change.action === 'edit') this.setQueue(this.queue.map((value) => value === entry ? { ...value, text: change.text.trim() || value.text } : value))
    else { this.setQueue(this.queue.filter((value) => value !== entry)); if (change.action === 'steer') this.send(entry.text, entry.images, { delivery: 'steer' }) }
  }
  private setQueue(queue: ChatQueuedMessage[]): void { this.queue = queue; this.update({ queue: queue.length ? [...queue] : undefined }) }
  private flushQueue(): void {
    if (!this.queue.length || this.activeTurn || this.sending || this.pending.size || this.interrupting || this.closing || this.info.claudeCodeSwitch) return
    const batch: ChatQueuedMessage[] = []
    let images = 0
    for (const entry of this.queue) {
      if (images + (entry.images?.length ?? 0) > MAX_CHAT_IMAGES) break
      images += entry.images?.length ?? 0
      batch.push(entry)
    }
    if (!batch.length) { this.emitItems(this.mapper.notice('error', 'Queued message has too many images. Remove it to continue.')); return }
    this.setQueue(this.queue.slice(batch.length))
    this.send(batch.map((entry) => entry.text).join('\n\n'), batch.flatMap((entry) => entry.images ?? []))
  }
  async interrupt(dropQueued: readonly string[] = []): Promise<void> {
    if (dropQueued.length) this.setQueue(this.queue.filter((entry) => !dropQueued.includes(entry.id)))
    this.interrupting = true
    try {
      // A turn/start may still be on its way; interrupt the turn it actually creates.
      await this.operations
      this.cancelRequests('Interrupted')
      const turnId = this.activeTurn
      if (turnId && this.info.sessionId) {
        await this.client.request('turn/interrupt', { threadId: this.info.sessionId, turnId })
        this.emitItems(this.mapper.settle(turnId, 'interrupted'))
        // turn/completed owns the transition to idle, so no queued work starts too soon.
      }
    } catch (error) { if (!this.closing) this.emitItems(this.mapper.notice('error', `Couldn't interrupt Codex: ${errorText(error)}`)) }
    finally { this.interrupting = false; this.switchReady(); this.flushQueue() }
  }
  answer(key: string, answer: ChatAnswer): boolean {
    const request = this.pending.get(key)
    if (!request) return false
    const params = record(request.params)
    const question = request.method === 'item/tool/requestUserInput'
    const dismissed = question && answer.kind === 'approval' && answer.decision === 'deny'
    if (question && answer.kind !== 'question' && !dismissed || !question && answer.kind !== 'approval') return false
    let result: unknown
    if (question) {
      const questions = inputQuestions(params.questions)
      if (answer.kind === 'question' && questions.some(({ id, question }) => !string(answer.answers[question.question] ?? answer.answers[id]))) return false
      result = { answers: Object.fromEntries(questions.map(({ id, question }) => [id, { answers: answer.kind === 'question' ? [answer.answers[question.question] ?? answer.answers[id]!] : [] }])) }
    } else if (request.method === 'item/permissions/requestApproval') {
      const permissions = parsePermissions(params.permissions) ?? {}
      result = {
        permissions: answer.kind === 'approval' && answer.decision !== 'deny' ? {
          ...(permissions.network ? { network: permissions.network } : {}),
          ...(permissions.fileSystem ? { fileSystem: permissions.fileSystem } : {}),
        } : {},
        scope: answer.kind === 'approval' && answer.decision === 'allow_always' ? 'session' : 'turn',
      }
    } else result = { decision: answer.kind === 'approval' ? answer.decision === 'allow' ? 'accept' : answer.decision === 'allow_always' ? 'acceptForSession' : 'decline' : 'decline' }
    try { this.client.respond(request.id, result) } catch { return false }
    this.pending.delete(key)
    this.emitItems(this.mapper.resolveRequest(key, dismissed ? { kind: 'cancelled', reason: 'Dismissed' } : answer))
    this.update({ status: this.pending.size ? 'waiting' : this.activeTurn ? 'running' : 'idle' })
    this.switchReady()
    return true
  }
  private serverRequest(request: RpcRequest): boolean {
    if (!['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval', 'item/tool/requestUserInput'].includes(request.method)) return false
    const params = record(request.params)
    if (this.closing || !this.info.sessionId || !string(params.threadId) || !string(params.turnId) || !string(params.itemId)) {
      this.client.reject(request.id, -32602, 'Invalid or inactive thread request')
      return true
    }
    if (request.method === 'item/tool/requestUserInput' && (!inputQuestions(params.questions).length || list(params.questions).some((value) => record(value).isSecret === true))) {
      this.client.reject(request.id, -32602, 'Empty or secret questions cannot be rendered by this chat')
      this.emitItems(this.mapper.notice('error', 'Codex requested unsupported empty or secret user input.'))
      return true
    }
    if (request.method === 'item/permissions/requestApproval' && !parsePermissions(params.permissions)) { this.client.reject(request.id, -32602, 'Invalid permissions'); return true }
    this.pending.set(requestKey(request.id), request)
    this.emitItems(this.mapper.request(request))
    this.update({ status: 'waiting' })
    return true
  }
  private cancelRequests(reason: string): void {
    for (const [key, request] of this.pending) {
      try {
        this.client.respond(request.id, request.method === 'item/tool/requestUserInput'
          ? { answers: {} }
          : request.method === 'item/permissions/requestApproval'
            ? { permissions: {}, scope: 'turn' }
            : { decision: 'cancel' })
      } catch { /* The child may already have exited. */ }
      this.emitItems(this.mapper.resolveRequest(key, { kind: 'cancelled', reason }))
    }
    this.pending.clear()
  }
  private notification(message: RpcNotification): void {
    const params = record(message.params)
    // Child threads have their own turns, but their requests still resolve in this chat.
    if (string(params.threadId) && this.info.sessionId && params.threadId !== this.info.sessionId && message.method !== 'serverRequest/resolved') return
    if (message.method === 'thread/started' && !this.info.sessionId) {
      const id = string(record(params.thread).id)
      if (id) this.update({ sessionId: id })
    }
    if (message.method === 'turn/started') {
      this.activeTurn = string(record(params.turn).id)
      this.update({ status: this.pending.size ? 'waiting' : 'running' })
    }
    if (message.method === 'thread/name/updated' && string(params.threadName)) this.update({ title: params.threadName as string })
    if (message.method === 'thread/tokenUsage/updated') {
      const usage = codexContextUsage(params.tokenUsage)
      if (usage) this.update({ contextUsage: usage })
    }
    if (message.method === 'model/rerouted' && string(params.toModel)) {
      this.update({ model: params.toModel as string })
      this.emitItems(this.mapper.notice('info', `Codex routed this turn to ${params.toModel}`))
    }
    if (message.method === 'serverRequest/resolved' && rpcId(params.requestId)) this.pending.delete(requestKey(params.requestId))
    this.emitItems(this.mapper.notification(message))
    if (message.method === 'serverRequest/resolved') this.update({ status: this.pending.size ? 'waiting' : this.activeTurn ? 'running' : 'idle' })
    if (message.method === 'turn/completed') {
      const turnId = string(record(params.turn).id)
      if (turnId) {
        this.endedTurns.add(turnId)
        if (this.endedTurns.size > 100) this.endedTurns.delete(this.endedTurns.values().next().value!)
      }
      if (!this.activeTurn || this.activeTurn === turnId) {
        this.activeTurn = undefined
        this.cancelRequests('The turn ended')
        this.update({ status: 'idle' })
        this.switchReady()
        this.flushQueue()
      }
    }
  }
  async configure(change: ChatSettingsChange): Promise<void> {
    try { this.applySettings(change) } catch (error) { this.emitItems(this.mapper.notice('error', `Couldn't change Codex settings: ${errorText(error)}`)) }
  }
  private applySettings(change: ChatSettingsChange): void {
    if (this.closing) throw new Error('Codex chat is closed')
    if (change.model !== undefined && (!isModelValue(change.model) || !this.info.models?.some((model) => model.value === change.model))) throw new Error('Unknown Codex model')
    const model = this.info.models?.find((model) => model.value === (change.model ?? this.info.selectedModel))
    if (change.effort && !model?.efforts?.includes(change.effort)) throw new Error('This Codex model does not support that effort')
    if (change.fast && !model?.supportsFast) throw new Error('This Codex model does not offer fast mode')
    if (change.permissionMode) {
      codexPermissions(change.permissionMode, this.spec.cwd)
      if (change.permissionMode === 'bypassPermissions' && !this.info.bypassAllowed) throw new Error('Full access must be allowed at launch')
    }
    const mode = change.permissionMode === 'acceptEdits' ? 'default' : change.permissionMode
    const prePlan = mode === 'plan'
      ? this.info.permissionMode === 'plan'
        ? this.info.prePlanPermissionMode
        : this.info.permissionMode as ChatSessionPermissionMode
      : mode ? undefined : this.info.prePlanPermissionMode
    const effort = change.effort ?? (this.info.effort && model?.efforts?.includes(this.info.effort) ? this.info.effort : undefined)
    const fast = (change.fast ?? this.info.fast) && model?.supportsFast ? true : undefined
    this.update({ ...(change.model ? { selectedModel: change.model } : {}), effort, fast, ...(mode ? { permissionMode: mode, prePlanPermissionMode: prePlan } : {}) })
  }
  /** The fast tier when the chat is in fast mode on a model that offers it. */
  private serviceTier(): string | undefined {
    const model = this.info.selectedModel ?? this.info.model
    return this.info.fast && model ? this.fastTiers.get(model) : undefined
  }
  searchFiles(query: string): Promise<ChatFileSearchResult> { return this.files.search(query) }
  async controlTask(_action: ChatTaskAction, _agentId: string, _toolUseId: string): Promise<void> { throw new Error('Codex subagent controls are not available in this chat') }
  async subagentTranscript(_agentId: string): Promise<ChatSubagentTranscript> { return { items: [], error: 'Codex subagent transcripts are not available in this chat' } }
  private async requestSwitch(action: ChatSwitchAction): Promise<void> {
    if (action === 'cancel') { this.endSwitch(); return }
    if (this.closing || this.info.claudeCodeSwitch === 'switching') return
    this.update({ claudeCodeSwitch: action })
    if (action === 'now') await this.interrupt()
    this.switchReady()
  }
  private endSwitch(notice?: string): void {
    this.update({ claudeCodeSwitch: undefined })
    if (notice) this.emitItems(this.mapper.notice('error', notice))
    this.flushQueue()
  }
  private switchReady(): void {
    if (!this.info.claudeCodeSwitch || this.info.claudeCodeSwitch === 'switching' || this.activeTurn || this.sending || this.pending.size || this.info.status === 'starting' || this.closing) return
    this.update({ claudeCodeSwitch: 'switching' })
    this.readyListeners.forEach((listener) => listener())
  }
  close(): void {
    if (this.closing) return
    this.closing = true
    this.cancelRequests('Chat closed')
    this.emitItems(this.mapper.settle(undefined, 'interrupted'))
    if (this.queue.length) this.emitItems(this.mapper.notice('error', `Chat closed with ${this.queue.length} unsent queued message(s).`))
    this.client.close()
  }
  private finish(error?: Error): void {
    if (this.closed) return
    const failed = Boolean(error && !this.closing)
    this.closed = true
    this.closing = true
    this.cancelRequests(failed ? 'Codex app-server exited' : 'Chat closed')
    if (failed) this.emitItems(this.mapper.notice('error', `Codex app-server stopped: ${errorText(error)}${this.queue.length ? ` (${this.queue.length} queued messages were not sent)` : ''}`))
    this.emitItems(this.mapper.settle(undefined, failed ? 'failed' : 'interrupted'))
    this.update({ status: failed || this.info.status === 'error' ? 'error' : 'closed', ...(failed ? { error: errorText(error) } : {}) })
    this.listeners.closed.forEach((listener) => listener())
  }
}
