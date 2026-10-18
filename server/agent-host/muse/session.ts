import {
  AGENT_HOST_PROTOCOL_VERSION,
  MAX_CHAT_IMAGES,
  MAX_QUEUED_MESSAGES,
  isChatEffort,
  isModelValue,
  type ChatAnswer,
  type ChatCommand,
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
import { RpcError, record, type RpcNotification, type RpcRequest } from '../rpc-client.js'
import type { AgentSessionSpec } from '../session.js'
import { MuseRpcClient, uuidv7, type MuseApprovalMode, type MuseInput, type MuseMethods, type MuseTransport, type MuseUserInputAnswer } from './client.js'
import { MuseItemMapper, museQuestions } from './items.js'

const string = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : []
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)

/**
 * Commando's modes as Muse approval modes. Muse has no plan mode.
 * - default, "Ask when needed": Muse's own default; tools run in its sandbox and it asks before going beyond it.
 * - acceptEdits, "Approve everything": no prompts, still inside the sandbox.
 * - bypassPermissions, "Full access": no prompts and no sandbox (`--yolo`). The sandbox is set when
 *   the host starts, so a chat is started in full access or never reaches it.
 */
export function museApprovalMode(mode: ChatSessionPermissionMode): MuseApprovalMode {
  if (mode === 'default') return 'onRequest'
  if (mode === 'acceptEdits' || mode === 'bypassPermissions') return 'allowAll'
  throw new Error(`Muse does not support permission mode ${mode}`)
}

/** The Muse TUI's flags for the same mode. */
function tuiPermissionFlags(mode: ChatSessionPermissionMode): string[] {
  if (mode === 'bypassPermissions') return ['--yolo']
  return ['--approval-mode', museApprovalMode(mode) === 'allowAll' ? 'never' : 'on-request']
}

export function museModels(value: unknown): ChatModelOption[] {
  return list(record(value).models).flatMap((value) => {
    const model = record(value)
    if (!isModelValue(model.modelId)) return []
    const tiers = [...list(model.variants), ...list(model.reasoningEffortVariants).map((variant) => record(variant).tier)]
    const efforts = [...new Set(tiers.filter(isChatEffort))]
    return [{ value: model.modelId, resolvedModel: model.modelId, displayName: string(model.displayLabel) ?? model.modelId,
      ...(string(model.description) ? { description: model.description as string } : {}), ...(efforts.length ? { efforts } : {}) }]
  })
}

/** `muse resume` in this pane, then back to the chat when the TUI exits. */
export function museTuiSwitchCommand(
  settings: { model?: string; effort?: string; permissionMode: ChatSessionPermissionMode },
  executable: string,
  launcher: string,
  sessionId: string,
  returnFlags: readonly string[],
): string {
  const tui = [
    executable,
    ...(settings.model ? ['--model', settings.model] : []),
    ...(settings.effort ? ['--reasoning-effort', settings.effort] : []),
    ...tuiPermissionFlags(settings.permissionMode),
    // The chat already loads the workspace's rules and skills; the TUI would otherwise ask first.
    '--trust-workspace',
    'resume', sessionId,
  ].map(shellQuote).join(' ')
  const back = ['exec', ...[launcher, 'muse', ...returnFlags, '--resume', sessionId, '--from-claude-code'].map(shellQuote)].join(' ')
  return `exec /bin/bash -c ${shellQuote(`set -m; ${tui}; ${back}`)}`
}

const IMAGE_TYPES: [string, (bytes: Buffer) => boolean][] = [
  ['image/png', (bytes) => bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))],
  ['image/jpeg', (bytes) => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff],
  ['image/gif', (bytes) => bytes.subarray(0, 4).toString('latin1') === 'GIF8'],
  ['image/webp', (bytes) => bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP'],
]
export function imageMediaType(bytes: Buffer): string | undefined {
  return IMAGE_TYPES.find(([, matches]) => matches(bytes))?.[0]
}

/**
 * Muse runs hooks with almost no environment, so Commando's hook reads the chat's resume
 * command from the Muse process instead; `ps` splits values on spaces, hence the base64 copy.
 */
function resumeEnv(command: string): Record<string, string> {
  return { COMMANDO_CHAT_RESUME: command, COMMANDO_CHAT_RESUME_B64: Buffer.from(command).toString('base64') }
}

type PendingRequest =
  | { kind: 'approval'; params: Record<string, unknown> }
  | { kind: 'question'; params: Record<string, unknown> }

/** A chat on a `muse serve` host, which this pane owns for its lifetime. */
export class MuseChatSession implements ChatProviderSession {
  private commandList: ChatCommand[] | null = null
  readonly tui: ChatProviderTui
  private readonly client: MuseTransport
  private readonly mapper = new MuseItemMapper()
  private readonly files: WorkspaceFileIndex
  private readonly listeners: { [K in keyof ChatProviderSessionEvents]: ChatProviderSessionEvents[K][] } = { items: [], session: [], commands: [], closed: [] }
  private readonly readyListeners: (() => void)[] = []
  private readonly pending = new Map<string, PendingRequest>()
  /** Answered here, waiting for Muse to take the answer; a refusal shows the prompt again. */
  private readonly deciding = new Map<string, PendingRequest>()
  private info: ChatSessionInfo
  private startPromise?: Promise<void>
  private activeTurn?: string
  private readonly endedTurns = new Set<string>()
  /** Muse unloads an idle session; the next send resumes it first. */
  private unloaded = false
  private sending = 0
  private operations = Promise.resolve()
  private queue: ChatQueuedMessage[] = []
  private queueCounter = 0
  private closing = false
  private closed = false
  private interrupting = false
  /** The host runs without Muse's sandbox; fixed for the chat's lifetime. */
  private readonly fullAccess: boolean

  constructor(private readonly spec: AgentSessionSpec, client?: MuseTransport, private readonly executable = 'muse') {
    museApprovalMode(spec.permissionMode)
    this.fullAccess = spec.permissionMode === 'bypassPermissions'
    this.client = client ?? new MuseRpcClient({
      sandbox: !this.fullAccess,
      cwd: spec.cwd,
      env: { ...spec.env, ...(spec.resumeCommand ? resumeEnv(spec.resumeCommand) : {}) },
      executable,
      log: spec.log,
    })
    this.files = new WorkspaceFileIndex(spec.cwd)
    this.info = {
      paneId: spec.paneId,
      provider: 'muse',
      cwd: spec.cwd,
      status: 'starting',
      hostPid: process.pid,
      hostVersion: AGENT_HOST_PROTOCOL_VERSION,
      ...(spec.resume ? { sessionId: spec.resume } : {}),
      permissionMode: spec.permissionMode,
      // Full access needs a host started without the sandbox, so only such a chat has it.
      bypassAllowed: spec.permissionMode === 'bypassPermissions',
      ...(spec.model ? { selectedModel: spec.model } : {}),
      ...(spec.effort ? { effort: spec.effort } : {}),
      ...(spec.hostBuild ? { hostBuild: spec.hostBuild } : {}),
      ...(spec.resumeCommand ? { resumeCommand: spec.resumeCommand } : {}),
    }
    this.client.onNotification((message) => this.notification(message))
    this.client.onRequest((request) => this.serverRequest(request))
    this.client.onClose((error) => this.finish(error))
    this.tui = {
      label: 'Muse TUI',
      env: {
        ...(spec.env.XDG_CONFIG_HOME ? { XDG_CONFIG_HOME: spec.env.XDG_CONFIG_HOME } : {}),
        ...(spec.env.XDG_DATA_HOME ? { XDG_DATA_HOME: spec.env.XDG_DATA_HOME } : {}),
        ...(spec.resumeCommand ? resumeEnv(spec.resumeCommand) : {}),
      },
      onReady: (listener) => this.readyListeners.push(listener),
      requestSwitch: (action) => this.requestSwitch(action),
      command: (launcher, flags, id) => {
        if (!launcher || !id) throw new Error('Switching to the Muse TUI needs the launcher and a session id')
        return museTuiSwitchCommand({ model: this.info.selectedModel, effort: this.info.effort, permissionMode: this.info.permissionMode as ChatSessionPermissionMode }, this.executable, launcher, id, flags)
      },
      // Closing the host releases Muse's lock on the session, so the TUI can open it.
      handOver: () => { this.setQueue([]); this.close() },
      endSwitch: (notice) => this.endSwitch(notice),
    }
  }
  get paneId(): string { return this.spec.paneId }
  get commands(): ChatCommand[] | null { return this.commandList }
  get busy(): boolean { return Boolean(this.activeTurn || this.sending || this.pending.size || this.queue.length || this.info.status === 'starting') }
  get queued(): ChatQueuedMessage[] { return [...this.queue] }
  on<K extends keyof ChatProviderSessionEvents>(event: K, listener: ChatProviderSessionEvents[K]): void { this.listeners[event].push(listener) }
  private emitItems(items: ChatItem[]): void { if (items.length) this.listeners.items.forEach((listener) => listener(items)) }
  private update(change: Partial<ChatSessionInfo>): void { this.info = { ...this.info, ...change }; this.listeners.session.forEach((listener) => listener(this.info)) }
  snapshot(): { session: ChatSessionInfo; items: ChatItem[] } { return { session: { ...this.info }, items: this.mapper.list() } }
  setResumeCommand(command: string): void { Object.assign(this.tui.env, resumeEnv(command)); if (this.info.resumeCommand !== command) this.update({ resumeCommand: command }) }
  private call<M extends keyof MuseMethods & string>(method: M, params: MuseMethods[M]): Promise<Record<string, unknown>> {
    return this.client.request(method, params).then(record)
  }

  start(): Promise<void> { return this.startPromise ??= this.initialize() }
  private async initialize(): Promise<void> {
    try {
      await this.client.start()
      this.update({ models: museModels(await this.call('model/list', {}).catch(() => ({}))) })
      await this.openSession()
      if (this.closing) return
      void this.loadCommands()
      this.update({ status: this.activeTurn ? 'running' : 'idle' })
      if (this.spec.returnedFromClaudeCode) this.emitItems(this.mapper.notice('info', 'Returned from the Muse TUI'))
      this.switchReady()
      if (this.spec.initialPrompt) this.send(this.spec.initialPrompt)
    } catch (error) {
      if (!this.closing) { this.emitItems(this.mapper.notice('error', `Couldn't start Muse: ${this.describe(error)}`)); this.update({ status: 'error', error: this.describe(error) }) }
      this.close()
    }
  }
  private describe(error: unknown): string {
    if (error instanceof RpcError && error.data?.kind === 'sessionInUse') return 'this conversation is open somewhere else (another chat or the Muse TUI). Close it there first.'
    return errorText(error)
  }
  /** Starts the conversation, or resumes it and replays its history. */
  private async openSession(): Promise<void> {
    const resume = this.info.sessionId
    const response = resume
      ? await this.call('session/resume', { commandId: uuidv7(), sessionId: resume, history: 'auto' })
      : await this.call('session/start', { commandId: uuidv7(), workspaceRoot: this.spec.cwd, approvalMode: museApprovalMode(this.info.permissionMode as ChatSessionPermissionMode),
        ...(this.info.selectedModel ? { modelId: this.info.selectedModel } : {}) })
    if (this.closing) return
    const session = record(response.session)
    const sessionId = string(session.sessionId)
    if (!sessionId) throw new Error('Muse returned a session without an id')
    this.unloaded = false
    const title = museTitle(session)
    this.update({ sessionId, ...(string(session.modelId) ? { model: session.modelId as string } : {}), ...(title ? { title } : {}) })
    if (resume) {
      // A resumed session re-applies this chat's picks, which may differ from how it last ran.
      const mode = museApprovalMode(this.info.permissionMode as ChatSessionPermissionMode)
      if (record(session.approvalMode).mode !== mode) await this.call('session/setApprovalMode', { sessionId, commandId: uuidv7(), mode })
      if (this.info.selectedModel && this.info.selectedModel !== session.modelId) await this.call('session/setModel', { sessionId, commandId: uuidv7(), model: { modelId: this.info.selectedModel } })
    }
    if (this.info.effort) await this.call('session/setReasoningEffort', { sessionId, commandId: uuidv7(), reasoningEffort: this.info.effort })
    if (resume && !this.replayed) this.replay(record(response.history))
  }
  private replayed = false
  private replay(history: Record<string, unknown>): void {
    this.replayed = true
    const state = record(record(history.snapshot).state)
    const items = list(history.items).length ? list(history.items) : list(state.items)
    const replayed = items.flatMap((item) => this.mapper.item(item))
    const todos = list(record(state.todoList).items)
    this.emitItems([...replayed, ...(todos.length ? this.mapper.todos(todos) : []), ...this.mapper.settle(undefined, 'interrupted')])
  }
  private async loadCommands(): Promise<void> {
    const sessionId = this.info.sessionId
    if (!sessionId) return
    try {
      const result = await this.call('skill/list', { sessionId })
      this.commandList = list(result.skills).flatMap((value) => {
        const skill = record(value)
        const name = string(skill.selector)
        if (!name || /\s/.test(name)) return []
        return [{ name, description: (string(skill.description) ?? string(skill.displayName) ?? '').slice(0, 500), kind: 'skill' as const,
          ...(string(skill.argumentHint) ? { argumentHint: skill.argumentHint as string } : {}) }]
      })
      this.listeners.commands.forEach((listener) => listener(this.commandList!))
    } catch (error) {
      if (!this.closing) this.spec.log?.(`Couldn't list Muse skills: ${errorText(error)}`)
    }
  }

  send(text: string, images: ChatImageRef[] = [], options: ChatSendOptions = {}): void {
    const trimmed = text.trim()
    if (!trimmed && !images.length) return
    if (this.closing || this.info.claudeCodeSwitch) { this.emitItems(this.mapper.notice('error', 'The chat is closed or switching to the Muse TUI; this message was not sent.')); return }
    if (options.relayTo) { this.emitItems(this.mapper.notice('error', 'Muse subagent relay is not available in this chat.')); return }
    if (options.delivery === 'queue' && (this.activeTurn || this.sending)) {
      if (this.queue.length >= MAX_QUEUED_MESSAGES) { this.emitItems(this.mapper.notice('error', 'The message queue is full.')); return }
      this.setQueue([...this.queue, { id: `muse-queued-${++this.queueCounter}`, text: trimmed, ...(images.length ? { images } : {}) }])
      return
    }
    this.sending++
    this.operations = this.operations.then(async () => {
      await this.start()
      if (this.closing) return
      if (this.unloaded) await this.openSession()
      const sessionId = this.info.sessionId
      if (!sessionId) throw new Error('Muse has no session id')
      if (images.length > MAX_CHAT_IMAGES) throw new Error('Too many images')
      if (options.permissionMode) {
        if (this.activeTurn) throw new Error('Permission changes apply to the next turn; wait for this turn to finish')
        await this.applySettings({ permissionMode: options.permissionMode })
      }
      const input = await this.input(trimmed, images)
      const steer = Boolean(this.activeTurn)
      const commandId = uuidv7()
      this.mapper.expectUser(trimmed, images)
      try {
        if (!steer) this.update({ status: 'running' })
        const result = await this.call('turn/start', { sessionId, commandId, input, ifBusy: 'steer', ...(images.length && trimmed ? { displayText: trimmed } : {}) })
        const turnId = string(result.turnId)
        if (turnId && result.disposition !== 'steered' && !this.endedTurns.has(turnId)) { this.activeTurn = turnId; this.mapper.setTurn(turnId) }
        if (!this.info.title && trimmed) this.update({ title: trimmed.slice(0, 80) })
      } catch (error) { this.mapper.forgetUser(trimmed); throw error }
    }).catch((error) => {
      if (!this.closing) { this.emitItems(this.mapper.notice('error', `Message not sent: ${this.describe(error)}`)); if (!this.activeTurn) this.update({ status: 'idle' }) }
    }).finally(() => { this.sending--; this.switchReady(); this.flushQueue() })
  }
  /** A leading `/skill` runs that skill with the rest of the message as its arguments. */
  private async input(text: string, images: ChatImageRef[]): Promise<MuseInput[]> {
    const command = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text)
    const skill = command && this.commandList?.some((entry) => entry.name === command[1]) ? command : null
    const input: MuseInput[] = skill
      ? [{ type: 'skill', selector: skill[1]!, ...(skill[2]?.trim() ? { arguments: skill[2].trim() } : {}) }]
      : text ? [{ type: 'text', text }] : []
    for (const image of images) {
      if (!this.spec.images) throw new Error('Chat images are unavailable')
      const bytes = await this.spec.images.read(image.id)
      const mediaType = imageMediaType(bytes)
      if (!mediaType) throw new Error(`${image.name ?? 'An image'} is not a PNG, JPEG, GIF or WebP image`)
      input.push({ type: 'image', mediaType, base64Data: bytes.toString('base64') })
    }
    return input
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
      const turnId = this.activeTurn
      const sessionId = this.info.sessionId
      if (turnId && sessionId) {
        await this.call('turn/interrupt', { sessionId, commandId: uuidv7(), turnId }).catch((error: unknown) => {
          // The turn finished on its own before the interrupt reached it.
          if (!(error instanceof RpcError && (error.data?.reason === 'already_terminal' || error.data?.reason === 'missing_run'))) throw error
        })
        // turn/completed owns the transition to idle, so no queued work starts too soon.
      }
    } catch (error) { if (!this.closing) this.emitItems(this.mapper.notice('error', `Couldn't interrupt Muse: ${errorText(error)}`)) }
    finally { this.interrupting = false; this.switchReady(); this.flushQueue() }
  }

  answer(key: string, answer: ChatAnswer): boolean {
    const request = this.pending.get(key)
    const sessionId = this.info.sessionId
    if (!request || !sessionId) return false
    const params = request.params
    let decide: Promise<unknown>
    if (request.kind === 'approval') {
      if (answer.kind !== 'approval') return false
      const choice = museChoice(params.availableChoices, answer.decision)
      if (!choice) return false
      decide = this.call('approval/decide', { sessionId, commandId: uuidv7(), approvalId: params.approvalId as string, choiceId: choice, requirementId: params.currentRequirementId })
    } else if (answer.kind === 'approval' && answer.decision === 'deny') {
      decide = this.call('userInput/cancel', { sessionId, commandId: uuidv7(), userInputId: params.userInputId as string })
    } else {
      if (answer.kind !== 'question') return false
      const answers = museAnswers(params.questions, answer.answers)
      if (!answers) return false
      decide = this.call('userInput/answer', { sessionId, commandId: uuidv7(), userInputId: params.userInputId as string, answers })
    }
    this.pending.delete(key)
    this.deciding.set(key, request)
    this.emitItems(this.mapper.resolveRequest(key, request.kind === 'question' && answer.kind === 'approval' ? { kind: 'cancelled', reason: 'Dismissed' } : answer))
    this.update({ status: this.pending.size ? 'waiting' : this.activeTurn ? 'running' : 'idle' })
    decide.then(() => { this.deciding.delete(key) }, (error: unknown) => {
      // Muse still waits for a decision unless the request settled meanwhile, so ask again.
      const current = this.deciding.get(key)
      this.deciding.delete(key)
      if (this.closing) return
      this.emitItems(this.mapper.notice('error', `Muse didn't take that answer: ${errorText(error)}`))
      if (current) this.show(key, current)
    })
    this.switchReady()
    return true
  }
  private serverRequest(request: RpcRequest): boolean {
    if (request.method !== 'approval/request' && request.method !== 'userInput/request') return false
    // The reply only says the prompt is shown; the decision is a separate call.
    this.client.respond(request.id, {})
    this.ask(request.method === 'approval/request' ? 'approval' : 'question', record(request.params))
    return true
  }
  private ask(kind: PendingRequest['kind'], params: Record<string, unknown>): void {
    if (this.closing || params.sessionId !== this.info.sessionId) return
    const id = string(kind === 'approval' ? params.approvalId : params.userInputId)
    if (!id) return
    const key = `${kind}:${id}`
    // The same prompt also arrives as a view notification.
    if (this.pending.has(key)) return
    if (this.pending.has(key) || this.deciding.has(key)) return
    if (kind === 'question' && !museQuestions(params.questions).length) return
    // A question shown here waits for the person; this stops Muse's own answer countdown.
    if (kind === 'question') this.client.notify?.('userInput/engaged', { sessionId: this.info.sessionId, userInputId: id })
    this.show(key, { kind, params })
  }
  private show(key: string, request: PendingRequest): void {
    this.pending.set(key, request)
    this.emitItems(request.kind === 'approval' ? this.mapper.approval(key, request.params) : this.mapper.question(key, request.params))
    this.update({ status: 'waiting' })
  }
  /** An open approval changed its choices or the requirement being decided. */
  private approvalUpdated(params: Record<string, unknown>): void {
    const key = `approval:${string(params.approvalId)}`
    for (const requests of [this.pending, this.deciding]) {
      const request = requests.get(key)
      if (!request) continue
      const merged = { ...request.params, ...Object.fromEntries(['availableChoices', 'currentRequirementId', 'subject'].filter((name) => params[name] !== undefined).map((name) => [name, params[name]])) }
      requests.set(key, { kind: 'approval', params: merged })
      if (requests === this.pending) this.emitItems(this.mapper.approval(key, merged))
    }
  }
  private settled(key: string, reason: string): void {
    this.deciding.delete(key)
    if (!this.pending.delete(key)) return
    this.emitItems(this.mapper.resolveRequest(key, { kind: 'cancelled', reason }))
    this.update({ status: this.pending.size ? 'waiting' : this.activeTurn ? 'running' : 'idle' })
  }
  private notification({ method, params: raw }: RpcNotification): void {
    const params = record(raw)
    if (string(params.sessionId) && params.sessionId !== this.info.sessionId) return
    switch (method) {
      case 'turn/started': {
        const turnId = string(params.turnId)
        if (turnId) { this.activeTurn = turnId; this.mapper.setTurn(turnId) }
        this.update({ status: this.pending.size ? 'waiting' : 'running' })
        return
      }
      case 'item/started': case 'item/updated': case 'item/completed': this.emitItems(this.mapper.item(params.item)); return
      case 'item/delta': this.emitItems(this.mapper.delta(params)); return
      case 'session/todoListChanged': this.emitItems(this.mapper.todos(params.items)); return
      case 'session/contextUsage': {
        const used = params.usedTokens
        const max = params.windowTokens
        if (typeof used === 'number' && typeof max === 'number' && max > 0) this.update({ contextUsage: { usedTokens: used, maxTokens: max, autoCompact: true, categories: [] } })
        return
      }
      case 'session/modelChanged': if (string(params.modelId)) this.update({ model: params.modelId as string }); return
      case 'session/nameChanged': if (params.nameOrigin === 'custom' && string(params.name)) this.update({ title: params.name as string }); return
      case 'session/closed': if (params.reason === 'idle') this.unloaded = true; return
      case 'skill/changed': void this.loadCommands(); return
      case 'approval/requested': this.ask('approval', params); return
      case 'userInput/requested': this.ask('question', params); return
      case 'approval/updated': this.approvalUpdated(params); return
      case 'approval/resolved': this.settled(`approval:${string(params.approvalId)}`, 'Resolved in Muse'); return
      case 'userInput/settled': this.settled(`question:${string(params.userInputId)}`, params.outcome === 'timedOut' ? 'Muse stopped waiting for an answer' : 'Resolved in Muse'); return
      case 'turn/completed': this.turnCompleted(params); return
    }
  }
  private turnCompleted(params: Record<string, unknown>): void {
    const turnId = string(params.turnId)
    if (turnId) {
      this.endedTurns.add(turnId)
      if (this.endedTurns.size > 100) this.endedTurns.delete(this.endedTurns.values().next().value!)
    }
    const terminal = params.terminal
    this.emitItems([
      ...this.mapper.settle(turnId, terminal === 'completed' ? 'completed' : terminal === 'cancelled' ? 'interrupted' : 'failed'),
      ...(terminal !== 'completed' && terminal !== 'cancelled' ? this.mapper.notice('error', `Muse stopped: ${string(record(params.error).message) ?? string(params.reason) ?? terminal ?? 'unknown reason'}`, turnId) : []),
    ])
    if (this.activeTurn && this.activeTurn !== turnId) return
    this.activeTurn = undefined
    for (const key of [...this.pending.keys()]) this.settled(key, 'The turn ended')
    this.deciding.clear()
    this.update({ status: 'idle' })
    this.switchReady()
    this.flushQueue()
  }

  async configure(change: ChatSettingsChange): Promise<void> {
    try { await this.applySettings(change) } catch (error) { this.emitItems(this.mapper.notice('error', `Couldn't change Muse settings: ${errorText(error)}`)) }
  }
  private async applySettings(change: ChatSettingsChange): Promise<void> {
    if (this.closing) throw new Error('Muse chat is closed')
    if (change.model !== undefined && (!isModelValue(change.model) || !this.info.models?.some((model) => model.value === change.model))) throw new Error('Unknown Muse model')
    const model = this.info.models?.find((model) => model.value === (change.model ?? this.info.selectedModel))
    if (change.effort && model?.efforts && !model.efforts.includes(change.effort)) throw new Error('This Muse model does not support that effort')
    if (change.fast) throw new Error('Muse has no fast mode')
    const mode = change.permissionMode
    if (mode) {
      museApprovalMode(mode)
      if (mode === 'bypassPermissions' && !this.fullAccess) throw new Error('Full access turns off Muse\'s sandbox, so it has to be chosen when the chat starts')
      if (mode !== 'bypassPermissions' && this.fullAccess) throw new Error('This chat runs without Muse\'s sandbox, so it stays in full access; start a new chat for a sandboxed one')
    }
    const sessionId = this.info.sessionId
    // Until Muse has the session loaded, the picks wait for openSession, which applies them.
    if (sessionId && this.info.status !== 'starting' && !this.unloaded) {
      if (change.model) await this.call('session/setModel', { sessionId, commandId: uuidv7(), model: { modelId: change.model } })
      if (change.effort) await this.call('session/setReasoningEffort', { sessionId, commandId: uuidv7(), reasoningEffort: change.effort })
      if (mode) await this.call('session/setApprovalMode', { sessionId, commandId: uuidv7(), mode: museApprovalMode(mode) })
    }
    this.update({ ...(change.model ? { selectedModel: change.model } : {}), ...(change.effort ? { effort: change.effort } : {}), ...(mode ? { permissionMode: mode } : {}) })
  }
  searchFiles(query: string): Promise<ChatFileSearchResult> { return this.files.search(query) }
  async controlTask(_action: ChatTaskAction, _agentId: string, _toolUseId: string): Promise<void> { throw new Error('Muse subagent controls are not available in this chat') }
  async subagentTranscript(_agentId: string): Promise<ChatSubagentTranscript> { return { items: [], error: 'Muse subagent transcripts are not available in this chat' } }
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
    for (const key of [...this.pending.keys()]) this.emitItems(this.mapper.resolveRequest(key, { kind: 'cancelled', reason: 'Chat closed' }))
    this.pending.clear()
    this.deciding.clear()
    this.emitItems(this.mapper.settle(undefined, 'interrupted'))
    if (this.queue.length) this.emitItems(this.mapper.notice('error', `Chat closed with ${this.queue.length} unsent queued message(s).`))
    this.client.close()
  }
  private finish(error?: Error): void {
    if (this.closed) return
    const failed = Boolean(error && !this.closing)
    this.closed = true
    this.closing = true
    for (const key of [...this.pending.keys()]) this.emitItems(this.mapper.resolveRequest(key, { kind: 'cancelled', reason: failed ? 'Muse exited' : 'Chat closed' }))
    this.pending.clear()
    this.deciding.clear()
    if (failed) this.emitItems(this.mapper.notice('error', `Muse stopped: ${errorText(error)}${this.queue.length ? ` (${this.queue.length} queued messages were not sent)` : ''}`))
    this.emitItems(this.mapper.settle(undefined, failed ? 'failed' : 'interrupted'))
    this.update({ status: failed || this.info.status === 'error' ? 'error' : 'closed', ...(failed ? { error: errorText(error) } : {}) })
    this.listeners.closed.forEach((listener) => listener())
  }
}

/** A name the person gave the session, else its first prompt; Muse's generated names read as noise. */
export function museTitle(session: Record<string, unknown>): string | undefined {
  return (session.nameOrigin === 'custom' ? string(session.name) : undefined) ?? string(session.title) ?? string(session.firstUserPrompt)?.slice(0, 80)
}

/** The offered choice that matches the chat's decision; Muse only takes ids it offered. */
export function museChoice(value: unknown, decision: 'allow' | 'allow_always' | 'deny'): string | undefined {
  const choices = list(value).map(record)
  const wanted = decision === 'allow' ? ['approved'] : decision === 'allow_always' ? ['approvedForSession', 'approvedPolicyAmendment', 'approved'] : ['denied', 'abort']
  for (const kind of wanted) {
    const choice = choices.find((choice) => choice.decision === kind && string(choice.choiceId))
    if (choice) return choice.choiceId as string
  }
  return undefined
}

/** The chat's answers (keyed by question text) as Muse answers; undefined if one is missing. */
export function museAnswers(questions: unknown, answers: Record<string, string>): MuseUserInputAnswer[] | undefined {
  const parsed = museQuestions(questions)
  const result: MuseUserInputAnswer[] = []
  for (const { id, question } of parsed) {
    const value = answers[question.question] ?? answers[id]
    if (!value) return undefined
    const labels = question.options.map((option) => option.label)
    if (question.multiSelect) {
      const picked = value.split(', ').filter((label) => labels.includes(label))
      result.push(picked.length ? { questionId: id, selectedLabels: picked } : { questionId: id, freeText: value })
    } else result.push(labels.includes(value) ? { questionId: id, selectedLabel: value } : { questionId: id, freeText: value })
  }
  return result
}
