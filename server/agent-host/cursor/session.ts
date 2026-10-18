import type { AgentOptions, ModelListItem, ModelSelection, SDKImage } from '@cursor/sdk'
import {
  AGENT_HOST_PROTOCOL_VERSION, MAX_CHAT_IMAGES, MAX_QUEUED_MESSAGES, isChatEffort, isModelValue,
  type ChatAnswer, type ChatCommand, type ChatEffort, type ChatFileSearchResult, type ChatImageRef, type ChatItem,
  type ChatModelOption, type ChatQueueAction, type ChatQueuedMessage, type ChatSendOptions, type ChatSessionInfo,
  type ChatSessionPermissionMode, type ChatSettingsChange, type ChatSubagentTranscript, type ChatTaskAction,
} from '../../../shared/agent-chat.js'
import { WorkspaceFileIndex } from '../file-index.js'
import type { ChatProviderSession, ChatProviderSessionEvents } from '../provider.js'
import type { AgentSessionSpec } from '../session.js'
import { CursorItemMapper, record, string } from './items.js'
import { loadCursorSdk, type CursorAgent, type CursorRun, type CursorSdk } from './sdk.js'

const errorText = (error: unknown) => string(record(error).message) ?? String(error)
const EFFORT_PARAMETERS = ['effort', 'reasoning_effort', 'reasoning']
const AUTH_CODES = new Set(['UNAUTHENTICATED', 'NOT_LOGGED_IN', 'INVALID_AUTH_ID', 'AGENT_REQUIRES_LOGIN', 'AUTH_TOKEN_NOT_FOUND', 'AUTH_TOKEN_EXPIRED', 'UNAUTHORIZED', 'BAD_API_KEY', 'BAD_USER_API_KEY'])
export function cursorPermissions(mode: ChatSessionPermissionMode, prePlan?: ChatSessionPermissionMode): { sandboxOptions: { enabled: boolean }; autoReview?: boolean } {
  if (mode === 'plan') return prePlan && prePlan !== 'plan' ? cursorPermissions(prePlan) : { sandboxOptions: { enabled: true } }
  if (mode === 'bypassPermissions') return { sandboxOptions: { enabled: false } }
  if (mode === 'default') return { sandboxOptions: { enabled: true } }
  if (mode === 'auto') return { sandboxOptions: { enabled: false }, autoReview: true }
  throw new Error(`Cursor does not support permission mode ${mode}`)
}
export function cursorModels(items: ModelListItem[]): ChatModelOption[] {
  return items.flatMap((item) => {
    if (!isModelValue(item.id)) return []
    const efforts = item.parameters?.filter((parameter) => EFFORT_PARAMETERS.includes(parameter.id))
      .flatMap((parameter) => parameter.values.map(({ value }) => value === 'extra-high' ? 'xhigh' : value).filter(isChatEffort)) ?? []
    const duplicate = items.some((other) => other.id !== item.id && isModelValue(other.id) && other.displayName === item.displayName)
    return [{ value: item.id, resolvedModel: item.id, displayName: duplicate && item.id !== 'default' ? `${item.displayName} (${item.id})` : item.displayName, description: item.description, efforts: [...new Set(efforts)],
      ...(item.parameters?.some((parameter) => parameter.id === 'fast' && parameter.values.some(({ value }) => value === 'true')) ? { supportsFast: true } : {}) }]
  })
}
export function cursorModelSelection(option: ModelListItem, effort?: ChatEffort, fast?: boolean): ModelSelection {
  const params = option.parameters?.flatMap((parameter) => {
    const rawEffort = effort === 'xhigh' && !parameter.values.some(({ value }) => value === 'xhigh') ? 'extra-high' : effort
    const value = EFFORT_PARAMETERS.includes(parameter.id) ? rawEffort : parameter.id === 'fast' ? String(Boolean(fast)) : undefined
    return value !== undefined && parameter.values.some((entry) => entry.value === value) ? [{ id: parameter.id, value }] : []
  }) ?? []
  return { id: option.id, ...(params.length ? { params } : {}) }
}
export function isCursorAuthError(error: unknown): boolean {
  const value = record(error)
  return value.name === 'AuthenticationError' || AUTH_CODES.has(string(value.code)?.toUpperCase() ?? '')
    || /invalid (user )?api key|api key is required|unauthenticated/i.test(errorText(error))
    || (value.error !== undefined && isCursorAuthError(value.error))
}
export function cursorImageMime(data: Buffer): string | undefined {
  if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png'
  if (data.length >= 3 && data[0] === 255 && data[1] === 216 && data[2] === 255) return 'image/jpeg'
  if (['GIF87a', 'GIF89a'].includes(data.subarray(0, 6).toString('ascii'))) return 'image/gif'
  if (data.length >= 12 && data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
  return undefined
}

interface ActiveRun { run: CursorRun; turnId: string; text: string; images: ChatImageRef[] }
export class CursorChatSession implements ChatProviderSession {
  readonly commands: ChatCommand[] = [{ name: 'login', description: 'Log in to Cursor', argumentHint: '[cancel]', kind: 'command' }]
  private sdk?: CursorSdk
  private agent?: CursorAgent
  private readonly mapper = new CursorItemMapper()
  private readonly files: WorkspaceFileIndex
  private readonly listeners: { [K in keyof ChatProviderSessionEvents]: ChatProviderSessionEvents[K][] } = { items: [], session: [], commands: [], closed: [], restart: [] }
  private info: ChatSessionInfo
  private modelItems: ModelListItem[] = []
  private startPromise?: Promise<void>
  private loginController?: AbortController
  private loginFinishing = false
  private readonly apiKey?: string
  private historyLoaded = false
  private readyToSend = false
  private ranUnsandboxed = false
  private active?: ActiveRun
  private stale = false
  private sending = 0
  private operations = Promise.resolve()
  private queue: ChatQueuedMessage[] = []
  private queueCounter = 0
  private turnCounter = 0
  private closing = false
  private interrupting = false
  private initialSent = false

  constructor(private readonly spec: AgentSessionSpec, sdk?: CursorSdk) {
    cursorPermissions(spec.permissionMode, spec.prePlanPermissionMode)
    this.apiKey = spec.env.CURSOR_API_KEY
    this.sdk = sdk
    this.files = new WorkspaceFileIndex(spec.cwd)
    this.info = {
      paneId: spec.paneId, provider: 'cursor', cwd: spec.cwd, status: 'starting', models: [],
      hostPid: process.pid, hostVersion: AGENT_HOST_PROTOCOL_VERSION, bypassAllowed: true,
      permissionMode: spec.permissionMode, selectedModel: spec.model, effort: spec.effort, fast: spec.fast,
      prePlanPermissionMode: spec.prePlanPermissionMode, hostBuild: spec.hostBuild, resumeCommand: spec.resumeCommand,
      ...(spec.resume ? { sessionId: spec.resume } : {}),
    }
  }
  get paneId(): string { return this.spec.paneId }
  get busy(): boolean { return Boolean(this.active || this.sending || this.queue.length || this.loginController || this.info.status === 'starting') }
  get queued(): ChatQueuedMessage[] { return [...this.queue] }
  on<K extends keyof ChatProviderSessionEvents>(event: K, listener: ChatProviderSessionEvents[K]): void { this.listeners[event].push(listener) }
  private emitItems(items: ChatItem[]): void { if (!this.closing && items.length) this.listeners.items.forEach((listener) => listener(items)) }
  private update(change: Partial<ChatSessionInfo>): void { this.info = { ...this.info, ...change }; this.listeners.session.forEach((listener) => listener(this.info)) }
  snapshot(): { session: ChatSessionInfo; items: ChatItem[] } { return { session: { ...this.info }, items: this.mapper.list() } }
  setResumeCommand(command: string): void { if (this.info.resumeCommand !== command) this.update({ resumeCommand: command }) }
  private safeError(error: unknown): string {
    const message = errorText(error)
    const key = this.apiKey
    return (key ? message.split(key).join('[redacted]') : message).slice(0, 4096)
  }
  start(): Promise<void> { return this.startPromise ??= this.initialize() }
  private async initialize(): Promise<void> {
    try {
      this.sdk ??= await loadCursorSdk((message) => this.spec.log?.(this.safeError(message)))
      if (this.closing) return
      const loggedIn = this.spec.env.CURSOR_API_KEY || (await this.sdk.authStatus()).status === 'logged-in'
      if (this.closing) return
      if (!loggedIn) {
        const reason = 'Cursor needs you to log in before this chat can start.'
        this.update({ login: { state: 'required', reason }, status: 'idle' })
        this.emitItems(this.mapper.notice('info', reason))
        return
      }
      await this.ready()
      this.sendInitialPrompt()
    } catch (error) { this.startError(error) }
  }
  private startError(error: unknown): void {
    if (this.closing) return
    if (isCursorAuthError(error)) { this.authRequired(); return }
    const message = this.safeError(error)
    if (!this.agent) { this.readyToSend = false; this.startPromise = undefined }
    this.emitItems(this.mapper.notice('error', `Couldn't start Cursor: ${message}${!this.agent ? '. Sending a message retries.' : ''}`))
    this.update({ status: 'idle', error: message })
  }
  private async reloadModels(): Promise<void> {
    const items = await this.sdk!.listModels()
    if (this.closing) return
    this.modelItems = items
    const models = cursorModels(items)
    const selectedModel = models.some((model) => model.value === this.info.selectedModel) ? this.info.selectedModel
      : models.find((model) => model.value === 'default')?.value ?? models.find((model) => model.value === 'auto')?.value ?? models[0]?.value
    this.update({ models, selectedModel })
    this.applySettings({})
  }
  private model(): ModelSelection {
    const option = this.modelItems.find((model) => model.id === this.info.selectedModel)
    if (!option) throw new Error('Cursor has no available model')
    return cursorModelSelection(option, this.info.effort, this.info.fast)
  }
  private agentOptions(): AgentOptions {
    // Local runs silently refuse askQuestion; the agent should ask in plain text instead.
    return { model: this.model(), disallowedTools: ['askQuestion'], local: { cwd: this.spec.cwd, ...cursorPermissions(this.info.permissionMode as ChatSessionPermissionMode, this.info.prePlanPermissionMode) } }
  }
  private async ready(): Promise<void> {
    await this.reloadModels()
    if (this.closing) return
    const id = this.info.sessionId
    if (id) {
      const agent = await this.sdk!.resume(id, this.agentOptions())
      if (this.closing) { agent.close(); return }
      this.agent = agent
      this.update({ sessionId: agent.agentId })
    }
    this.stale = false
    if (this.spec.resume && !this.historyLoaded) {
      this.historyLoaded = true
      try {
        const history = await this.sdk!.history(this.agent!.agentId, this.spec.cwd)
        if (this.closing) return
        history.turns.forEach((turn) => this.mapper.replay(turn))
        this.emitItems(this.mapper.list())
        if (history.skipped) this.emitItems(this.mapper.notice('info', `${history.skipped} earlier Cursor turns couldn't be loaded.`))
      } catch (error) {
        if (this.closing) return
        this.emitItems(this.mapper.notice('info', `Couldn't load this chat's earlier messages: ${this.safeError(error)}`))
      }
    }
    this.readyToSend = true
    this.update({ status: 'idle', error: undefined })
    this.listeners.commands.forEach((listener) => listener(this.commands))
  }
  private sendInitialPrompt(): void {
    if (!this.closing && this.readyToSend && this.spec.initialPrompt && !this.initialSent) { this.initialSent = true; this.send(this.spec.initialPrompt) }
  }
  private authRequired(): void {
    const reason = this.spec.env.CURSOR_API_KEY
      ? 'CURSOR_API_KEY was rejected by Cursor; unset it or replace it, then log in.'
      : 'Cursor rejected the saved login (it may have expired or been revoked). Log in again.'
    this.update({ login: { state: 'required', reason }, status: 'idle', error: undefined })
    this.emitItems(this.mapper.notice('info', reason))
  }
  private async login(): Promise<void> {
    await this.start()
    if (this.closing || this.loginController) return
    const controller = new AbortController()
    this.loginController = controller
    this.update({ login: { state: 'pending' } })
    try {
      const { email } = await this.sdk!.login({ signal: controller.signal, onLoginUrl: (url) => {
        if (this.closing || controller.signal.aborted) return
        try { if (url.length > 2048 || new URL(url).protocol !== 'https:') return } catch { return }
        this.update({ login: { state: 'pending', url } })
        this.emitItems(this.mapper.notice('info', `Log in to Cursor: ${url}`))
      } })
      if (this.closing || controller.signal.aborted) return
      // Prefer the saved browser login over a rejected environment key.
      delete process.env.CURSOR_API_KEY
      if (this.spec.env !== process.env) delete this.spec.env.CURSOR_API_KEY
      this.loginFinishing = true
      this.operations = this.operations.then(async () => {
        if (this.closing || controller.signal.aborted) return
        try { if (!this.agent) await this.ready(); else await this.reloadModels() }
        catch (error) { this.startError(error); if (isCursorAuthError(error)) return }
        if (this.closing || controller.signal.aborted) return
        this.loginController = undefined
        this.update({ login: undefined })
        this.emitItems(this.mapper.notice('info', `Logged in to Cursor${email ? ` as ${email}` : ''}`))
        this.sendInitialPrompt()
      })
      await this.operations
    } catch (error) {
      if (this.closing) return
      if (controller.signal.aborted) {
        this.update({ login: { state: 'required' } })
        this.emitItems(this.mapper.notice('info', 'Cursor login cancelled.'))
      } else {
        const reason = this.safeError(error)
        this.update({ login: { state: 'required', reason } })
        this.emitItems(this.mapper.notice('error', `Couldn't log in to Cursor: ${reason}`))
      }
    } finally {
      this.loginFinishing = false
      if (this.loginController === controller) this.loginController = undefined
      if (controller.signal.aborted && !this.closing && this.info.login?.state === 'pending') {
        this.update({ login: { state: 'required' } })
        this.emitItems(this.mapper.notice('info', 'Cursor login cancelled.'))
      }
      this.flushQueue()
    }
  }
  send(text: string, images: ChatImageRef[] = [], options: ChatSendOptions = {}): void {
    const trimmed = text.trim()
    if (trimmed === '/login cancel') { this.loginController?.abort(); return }
    if (trimmed === '/login') { void this.login(); return }
    if (!trimmed && !images.length) return
    if (this.closing) return
    if ((this.info.login || this.loginController) && !this.loginFinishing) {
      // Let an already-resolved browser login schedule readiness before deciding whether to reject.
      queueMicrotask(() => {
        if (this.closing) return
        if ((this.info.login || this.loginController) && !this.loginFinishing) this.emitItems(this.mapper.notice('error', 'Log in to Cursor first (use the Log in button)'))
        else this.send(trimmed, images, options)
      })
      return
    }
    if (options.relayTo) { this.emitItems(this.mapper.notice('error', 'Cursor subagent relay is not available in this chat.')); return }
    this.sending++
    this.operations = this.operations.then(async () => {
      await this.start()
      if (this.closing) return
      if (this.info.login || this.loginController) throw new Error('Log in to Cursor first (use the Log in button)')
      if (!this.readyToSend) return
      if (options.permissionMode && this.active) throw new Error('Permission changes apply to the next turn; wait for this turn to finish')
      if (options.permissionMode) this.applySettings({ permissionMode: options.permissionMode })
      if (images.length > MAX_CHAT_IMAGES) throw new Error('Too many images')
      if (this.active) {
        const active = this.active
        if (options.delivery !== 'queue' && !images.length && active.run.steer) {
          const outcome = await active.run.steer(trimmed)
          if (this.closing) return
          if (outcome === 'complete_delivered') this.emitItems(this.mapper.expectUser(trimmed, [], true))
          else this.enqueue(trimmed, images, true)
        } else this.enqueue(trimmed, images)
        return
      }
      await this.startRun(trimmed, images)
    }).catch((error) => {
      if (this.closing) return
      if (isCursorAuthError(error)) { this.authRequired(); this.enqueue(trimmed, images, true) }
      else this.emitItems(this.mapper.notice('error', `Message not sent: ${this.safeError(error)}`))
    }).finally(() => { this.sending--; if (!this.closing && !this.active) this.update({ status: 'idle' }); this.flushQueue() })
  }
  private async startRun(text: string, images: ChatImageRef[]): Promise<void> {
    const input: SDKImage[] = []
    for (const image of images) {
      if (!this.spec.images) throw new Error('Chat images are unavailable')
      const data = await this.spec.images.read(image.id)
      const mimeType = cursorImageMime(data)
      if (!mimeType) throw new Error('Cursor supports PNG, JPEG, GIF and WebP images only')
      input.push({ data: data.toString('base64'), mimeType })
    }
    if (this.closing) return
    const agentOptions = this.agentOptions()
    const model = agentOptions.model!
    const sandboxed = agentOptions.local!.sandboxOptions!.enabled
    if (sandboxed && this.ranUnsandboxed) throw new Error("Cursor's sandbox can't turn on in this process; restart the chat (it restarts automatically when idle).")
    // Creating or resuming the agent takes a few seconds; show the turn as started meanwhile.
    this.update({ status: 'running' })
    if (this.stale || !this.agent) {
      const id = this.info.sessionId
      this.agent?.close()
      this.agent = undefined
      const agent = id ? await this.sdk!.resume(id, agentOptions) : await this.sdk!.create({ ...agentOptions, name: text.trim().slice(0, 80) })
      if (this.closing) { agent.close(); return }
      this.agent = agent
      this.stale = false
      this.update({ sessionId: agent.agentId })
    }
    const turnId = `turn-${++this.turnCounter}`
    this.mapper.begin(turnId)
    this.emitItems(this.mapper.expectUser(text, images))
    if (!sandboxed) this.ranUnsandboxed = true
    const run = await this.agent.send({ text, ...(input.length ? { images: input } : {}) }, {
      model, mode: this.info.permissionMode === 'plan' ? 'plan' : 'agent',
      onDelta: ({ update }) => { if (!this.closing) this.emitItems(this.mapper.delta(update)) },
    })
    if (this.closing) { await run.cancel().catch(() => {}); return }
    this.active = { run, turnId, text, images }
    this.update({ status: 'running', model: model.id, ...(!this.info.title && text ? { title: text.slice(0, 80) } : {}) })
    void this.wait(this.active)
  }
  private async wait(active: ActiveRun): Promise<void> {
    try {
      const result = await active.run.wait()
      if (this.closing) return
      this.emitItems(this.mapper.settle(active.turnId, result.status === 'finished' ? 'completed' : result.status === 'cancelled' ? 'interrupted' : 'failed'))
      if (result.status === 'error') {
        if (isCursorAuthError(result)) { this.authRequired(); this.enqueue(active.text, active.images, true) }
        else this.emitItems(this.mapper.notice('error', this.safeError(result.error ?? 'Cursor run failed')))
      }
    } catch (error) {
      if (this.closing) return
      this.emitItems(this.mapper.settle(active.turnId, 'failed'))
      if (isCursorAuthError(error)) { this.authRequired(); this.enqueue(active.text, active.images, true) }
      else this.emitItems(this.mapper.notice('error', this.safeError(error)))
    } finally {
      if (this.active === active) this.active = undefined
      if (!this.closing) { this.update({ status: 'idle' }); this.flushQueue() }
    }
  }
  private enqueue(text: string, images: ChatImageRef[], front = false): void {
    if (this.queue.length >= MAX_QUEUED_MESSAGES) { this.emitItems(this.mapper.notice('error', 'The message queue is full.')); return }
    const entry = { id: `cursor-queued-${++this.queueCounter}`, text, ...(images.length ? { images } : {}) }
    this.setQueue(front ? [entry, ...this.queue] : [...this.queue, entry])
  }
  private setQueue(queue: ChatQueuedMessage[]): void { this.queue = queue; this.update({ queue: queue.length ? [...queue] : undefined }) }
  private flushQueue(): void {
    if (!this.queue.length || this.active || this.sending || this.interrupting || this.closing || this.info.login || this.loginController || !this.readyToSend) return
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
  updateQueue(change: ChatQueueAction): void {
    const entry = this.queue.find((entry) => entry.id === change.id)
    if (!entry) { this.emitItems(this.mapper.notice('info', 'That queued message has already been sent.')); return }
    if (change.action === 'edit') this.setQueue(this.queue.map((value) => value === entry ? { ...value, text: change.text.trim() || value.text } : value))
    else { this.setQueue(this.queue.filter((value) => value !== entry)); if (change.action === 'steer') this.send(entry.text, entry.images, { delivery: 'steer' }) }
  }
  async interrupt(dropQueued: readonly string[] = []): Promise<void> {
    if (dropQueued.length) this.setQueue(this.queue.filter((entry) => !dropQueued.includes(entry.id)))
    this.loginController?.abort()
    this.interrupting = true
    try {
      const current = this.active
      if (current) { await current.run.cancel(); this.emitItems(this.mapper.settle(current.turnId, 'interrupted')) }
      await this.operations
      const active = this.active
      if (active && active !== current) { await active.run.cancel(); this.emitItems(this.mapper.settle(active.turnId, 'interrupted')) }
    } catch (error) { if (!this.closing) this.emitItems(this.mapper.notice('error', `Couldn't interrupt Cursor: ${this.safeError(error)}`)) }
    finally { this.interrupting = false; this.flushQueue() }
  }
  answer(_requestId: string, _answer: ChatAnswer): boolean { return false }
  async configure(change: ChatSettingsChange): Promise<void> {
    try { this.applySettings(change) } catch (error) { this.emitItems(this.mapper.notice('error', `Couldn't change Cursor settings: ${this.safeError(error)}`)) }
  }
  private applySettings(change: ChatSettingsChange): void {
    if (this.closing) throw new Error('Cursor chat is closed')
    if (change.model !== undefined && (!isModelValue(change.model) || !this.info.models?.some((model) => model.value === change.model))) throw new Error('Unknown Cursor model')
    const model = this.info.models?.find((model) => model.value === (change.model ?? this.info.selectedModel))
    if (change.effort && !model?.efforts?.includes(change.effort)) throw new Error('This Cursor model does not support that effort')
    if (change.fast && !model?.supportsFast) throw new Error('This Cursor model does not offer fast mode')
    const mode = change.permissionMode
    const prePlan = mode === 'plan' ? this.info.permissionMode === 'plan' ? this.info.prePlanPermissionMode : this.info.permissionMode as ChatSessionPermissionMode
      : mode ? undefined : this.info.prePlanPermissionMode
    if (mode) cursorPermissions(mode, prePlan)
    const permissionChanged = mode && (mode !== this.info.permissionMode || prePlan !== this.info.prePlanPermissionMode)
    if (permissionChanged) this.stale = true
    const effort = change.effort ?? (this.info.effort && model?.efforts?.includes(this.info.effort) ? this.info.effort : undefined)
    const fast = (change.fast ?? this.info.fast) && model?.supportsFast ? true : undefined
    this.update({ ...(change.model ? { selectedModel: change.model } : {}), effort, fast, ...(mode ? { permissionMode: mode, prePlanPermissionMode: prePlan } : {}) })
    if (permissionChanged && this.ranUnsandboxed && cursorPermissions(mode, prePlan).sandboxOptions.enabled) {
      this.emitItems(this.mapper.notice('info', "Restarting this chat so Cursor's sandbox can turn on."))
      this.listeners.restart.forEach((listener) => listener())
    }
  }
  searchFiles(query: string): Promise<ChatFileSearchResult> { return this.files.search(query) }
  async controlTask(_action: ChatTaskAction, _agentId: string, _toolUseId: string): Promise<void> { throw new Error('Cursor subagent controls are not available in this chat') }
  async subagentTranscript(_agentId: string): Promise<ChatSubagentTranscript> { return { items: [], error: 'Cursor subagent transcripts are not available in this chat' } }
  close(): void {
    if (this.closing) return
    this.closing = true
    this.loginController?.abort()
    void (async () => {
      if (this.active) await this.active.run.cancel().catch(() => {})
      await this.operations
      await this.startPromise
      try { this.agent?.close() } catch { /* Best effort when the SDK is already closed. */ }
      this.update({ status: 'closed' })
      this.listeners.closed.forEach((listener) => listener())
    })()
  }
}
