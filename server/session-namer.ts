import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { isChatProvider, isModelValue, parseChatImageRefs, type ChatImageRef } from '../shared/agent-chat.js'
import {
  DEFAULT_SESSION_NAMING,
  MAX_NAMING_TIMEOUT_SECONDS,
  MIN_NAMING_TIMEOUT_SECONDS,
  parseNamingModel,
  SESSION_NAMING_ROUTES,
  type NamingModel,
  type NamingModelStatus,
  type SessionNamingResponse,
  type SessionNamingSettings,
  type SuggestSessionNameRequest,
  type SuggestSessionNameResponse,
} from '../shared/session-naming.js'
import { autoSessionName, modelCatalogKey, type ModelCatalogs } from '../shared/tmux-create.js'
import { modelPrintEnv } from './model-print.js'
import { resolveAgentExecutable, validClaudeConfigDir } from './tmux-create.js'

export function defaultSessionNamingPath(): string {
  return process.env.COMMANDO_SESSION_NAMING_PATH ?? join(homedir(), '.commando', 'session-naming.json')
}

/** A model that can name a session; the chat's own may run on its provider's default. */
export type NamerModel = Omit<NamingModel, 'model'> & { model?: string }

/** `hard`: it won't work until something changes (login, model, CLI); `soft`: worth trying again. */
export class NamingFailure extends Error {
  constructor(readonly kind: 'hard' | 'soft', message: string) {
    super(message)
    this.name = 'NamingFailure'
  }
}

export type NameRunner = (model: NamerModel, prompt: string, imagePaths: readonly string[], signal: AbortSignal) => Promise<string>

const MAX_OUTPUT = 16_384
const HARD_FAILURE = /not logged in|log ?in|unauthori[sz]ed|\b40[13]\b|invalid api key|credit balance|model[^\n]{0,60}(not found|not exist|not supported|unsupported|unknown|invalid)|unknown model|model_not_found/iu

function run(executable: string, args: string[], env: NodeJS.ProcessEnv, cwd: string, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { env, cwd, signal, killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { if (stdout.length < MAX_OUTPUT) stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { if (stderr.length < MAX_OUTPUT) stderr += chunk })
    child.once('error', reject)
    child.once('close', (code) => {
      if (code === 0) return resolve(stdout)
      const output = `${stderr}\n${stdout}`
      const line = output.split('\n').map((text) => text.trim()).find((text) => HARD_FAILURE.test(text))
      reject(line
        ? new NamingFailure('hard', line.slice(0, 200))
        : new NamingFailure('soft', `exited with code ${code}`))
    })
  })
}

/** One-shot `codex exec` or `claude -p`, read-only, outside any repository. */
export function defaultNameRunner(env: NodeJS.ProcessEnv = process.env, resolveExecutable = resolveAgentExecutable): NameRunner {
  return async (model, prompt, imagePaths, signal) => {
    let executable: string
    try {
      executable = await resolveExecutable(model.provider, env)
    } catch {
      throw new NamingFailure('hard', `${model.provider === 'codex' ? 'Codex' : 'Claude'} isn't installed on this machine`)
    }
    const dir = await mkdtemp(join(tmpdir(), 'commando-name-'))
    try {
      if (model.provider === 'claude') {
        return await run(executable, [
          '-p', ...(model.model ? ['--model', model.model] : []), '--no-session-persistence', '--strict-mcp-config', '--tools', '', '--', prompt,
        ], modelPrintEnv(env, model.configDir), dir, signal)
      }
      const output = join(dir, 'name.txt')
      await run(executable, [
        'exec', ...(model.model ? ['-m', model.model] : []), '--ephemeral', '--skip-git-repo-check', '-s', 'read-only', '--ignore-rules', '--ignore-user-config',
        '-c', 'model_reasoning_effort=low', '-C', dir, '-o', output, ...imagePaths.flatMap((path) => ['-i', path]), '--', prompt,
      ], modelPrintEnv(env), dir, signal)
      return await readFile(output, 'utf8')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }
}

export function namingPrompt(text: string, images: number): string {
  const source = text ? (images ? 'the task and screenshots' : 'the task') : 'the attached screenshots'
  return [
    `Name this coding session in 2 to 4 lowercase words joined by hyphens, from ${source}. Reply with the name only.`,
    ...(text ? ['', 'Task:', text] : []),
  ].join('\n')
}

/** The name a model replied with: its first line without quotes or a full stop, made tmux-safe. */
export function nameFromReply(reply: string): string {
  const line = reply.split('\n').map((text) => text.trim()).find(Boolean) ?? ''
  return autoSessionName(line.replace(/^(?:name:\s*)/iu, '').replace(/[`"'*]/gu, '').replace(/\.$/u, ''))
}

type Failure = { kind: 'unavailable'; since: number; reason: string; fingerprint?: string } | { kind: 'timeouts'; count: number; until?: number }
type Stored = { settings: SessionNamingSettings; failures: Record<string, Failure>; lastNamedAt: Record<string, number> }

const TIMEOUTS_BEFORE_REST = 2
const REST_MS = 60 * 60_000
const MAX_PROMPT = 4_000

function modelKey(model: NamerModel): string {
  return `${model.provider}:${model.configDir ?? ''}:${model.model ?? ''}`
}

function parseSettings(value: unknown): SessionNamingSettings {
  const input = value && typeof value === 'object' ? value as Partial<Record<keyof SessionNamingSettings, unknown>> : {}
  const namingModel = parseNamingModel(input.namingModel, isModelValue)
  const timeout = typeof input.timeoutSeconds === 'number' && Number.isFinite(input.timeoutSeconds) ? Math.round(input.timeoutSeconds) : NaN
  return {
    mode: input.mode === 'chat-model' ? 'chat-model' : 'naming-model',
    namingModel: namingModel ?? DEFAULT_SESSION_NAMING.namingModel,
    timeoutSeconds: timeout >= MIN_NAMING_TIMEOUT_SECONDS && timeout <= MAX_NAMING_TIMEOUT_SECONDS ? timeout : DEFAULT_SESSION_NAMING.timeoutSeconds,
  }
}

export type SessionNamerOptions = {
  path?: string
  run?: NameRunner
  /** Model display names, and the list a naming model must still be in. */
  catalogs?: () => Promise<ModelCatalogs>
  /** Where an uploaded image is kept, so Codex can look at it. */
  imagePath?: (image: ChatImageRef) => string | null
  /** Changes when the provider's login does, so a remembered failure can be retried. */
  fingerprint?: (model: NamingModel) => Promise<string | undefined>
  now?: () => number
}

/** The login file whose change means a failed naming model is worth trying again. */
export async function loginFingerprint(model: NamingModel, env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  const file = model.provider === 'codex'
    ? join(env.CODEX_HOME ?? join(homedir(), '.codex'), 'auth.json')
    : join(model.configDir ?? join(homedir(), '.claude'), '.credentials.json')
  return stat(file).then((info) => String(info.mtimeMs), () => undefined)
}

/**
 * Names a new session from its opening prompt with a small, fast model
 * (GPT-6-Luna by default), falling back to the chat's own model. A model that
 * can't work on this machine is remembered and skipped, so the New session
 * modal never waits on it twice.
 */
export class SessionNamer {
  private stored: Stored | null = null
  private writes: Promise<void> = Promise.resolve()
  private readonly path: string
  private readonly run: NameRunner
  private readonly now: () => number

  constructor(private readonly options: SessionNamerOptions = {}) {
    this.path = options.path ?? defaultSessionNamingPath()
    this.run = options.run ?? defaultNameRunner()
    this.now = options.now ?? Date.now
  }

  private async read(): Promise<Stored> {
    if (this.stored) return this.stored
    let value: Record<string, unknown> = {}
    try {
      value = JSON.parse(await readFile(this.path, 'utf8')) as Record<string, unknown>
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('Unable to read session naming settings; using the defaults', error)
    }
    const failures = value.failures && typeof value.failures === 'object' ? value.failures as Record<string, Failure> : {}
    const lastNamedAt = value.lastNamedAt && typeof value.lastNamedAt === 'object' ? value.lastNamedAt as Record<string, number> : {}
    this.stored ??= { settings: parseSettings(value.settings), failures, lastNamedAt }
    return this.stored
  }

  private save(): Promise<void> {
    const snapshot = JSON.stringify(this.stored)
    this.writes = this.writes.then(async () => {
      await mkdir(dirname(this.path), { recursive: true })
      const temporary = `${this.path}.${process.pid}.tmp`
      await writeFile(temporary, snapshot, { mode: 0o600 })
      await rename(temporary, this.path)
    }).catch((error: unknown) => console.warn('Unable to save session naming settings', error))
    return this.writes
  }

  private async label(model: NamerModel): Promise<string> {
    if (!model.model) return model.provider === 'codex' ? 'Codex' : 'Claude'
    const catalogs: ModelCatalogs = await this.options.catalogs?.().catch(() => ({})) ?? {}
    const lists = [catalogs[modelCatalogKey(model.provider, model.configDir)], ...Object.entries(catalogs).filter(([key]) => key.startsWith(model.provider)).map(([, entry]) => entry)]
    return lists.flatMap((entry) => entry?.models ?? []).find((option) => option.value === model.model)?.displayName ?? model.model
  }

  /** Why the naming model can't be used right now, or null when it can. */
  private async status(model: NamingModel): Promise<NamingModelStatus> {
    const stored = await this.read()
    const key = modelKey(model)
    const failure = stored.failures[key]
    if (failure?.kind === 'unavailable') {
      const fingerprint = await this.options.fingerprint?.(model)
      // A new login is worth another try.
      if (failure.fingerprint === undefined || fingerprint === undefined || fingerprint === failure.fingerprint) {
        return { state: 'unavailable', since: failure.since, reason: failure.reason }
      }
      delete stored.failures[key]
      await this.save()
    }
    if (failure?.kind === 'timeouts' && failure.until && failure.until > this.now()) {
      return { state: 'resting', until: failure.until, reason: `${await this.label(model)} timed out twice in a row` }
    }
    if (model.provider === 'codex') {
      const listed = (await this.options.catalogs?.().catch(() => undefined))?.codex?.models
      if (listed && !listed.some((option) => option.value === model.model)) {
        return { state: 'unavailable', since: this.now(), reason: `${model.model} isn't in Codex's model list on this machine` }
      }
    }
    const lastNamedAt = stored.lastNamedAt[key]
    return { state: 'available', ...(lastNamedAt ? { lastNamedAt } : {}) }
  }

  async describe(): Promise<SessionNamingResponse> {
    const { settings } = await this.read()
    return { settings, status: await this.status(settings.namingModel), label: await this.label(settings.namingModel) }
  }

  async update(input: unknown): Promise<SessionNamingResponse> {
    const stored = await this.read()
    const change = input && typeof input === 'object' ? input as Record<string, unknown> : {}
    if (change.namingModel !== undefined) {
      const model = parseNamingModel(change.namingModel, isModelValue)
      if (!model || (model.configDir && !validClaudeConfigDir(model.configDir))) throw new Error('namingModel must be a Codex or Claude model')
    }
    if (change.mode !== undefined && change.mode !== 'naming-model' && change.mode !== 'chat-model') throw new Error('mode must be naming-model or chat-model')
    const timeout = change.timeoutSeconds
    if (timeout !== undefined && (typeof timeout !== 'number' || !Number.isInteger(timeout) || timeout < MIN_NAMING_TIMEOUT_SECONDS || timeout > MAX_NAMING_TIMEOUT_SECONDS)) {
      throw new Error(`timeoutSeconds must be a whole number from ${MIN_NAMING_TIMEOUT_SECONDS} to ${MAX_NAMING_TIMEOUT_SECONDS}`)
    }
    stored.settings = parseSettings({ ...stored.settings, ...change })
    await this.save()
    return this.describe()
  }

  /** Forget the naming model's failures so the next session tries it again. */
  async retry(): Promise<SessionNamingResponse> {
    const stored = await this.read()
    delete stored.failures[modelKey(stored.settings.namingModel)]
    await this.save()
    return this.describe()
  }

  async suggest(input: SuggestSessionNameRequest, signal: AbortSignal): Promise<SuggestSessionNameResponse> {
    const { settings } = await this.read()
    const text = (input.prompt ?? '').trim().slice(0, MAX_PROMPT)
    const imagePaths = (input.images ?? []).flatMap((image) => {
      const path = this.options.imagePath?.(image)
      return path && /\.(png|jpe?g|gif|webp)$/iu.test(path) ? [path] : []
    })
    const chat: NamerModel | null = input.chat && (input.chat.provider === 'claude' || input.chat.provider === 'codex')
      ? { provider: input.chat.provider, ...(input.chat.model && input.chat.model !== 'default' ? { model: input.chat.model } : {}), ...(input.chat.provider === 'claude' && input.chat.configDir ? { configDir: input.chat.configDir } : {}) }
      : null
    const attempts: { model: NamerModel; remember: boolean }[] = []
    if (settings.mode === 'naming-model' && (await this.status(settings.namingModel)).state === 'available') attempts.push({ model: settings.namingModel, remember: true })
    if (chat && !attempts.some((attempt) => modelKey(attempt.model) === modelKey(chat))) attempts.push({ model: chat, remember: false })

    const deadline = this.now() + settings.timeoutSeconds * 1000
    for (const { model, remember } of attempts) {
      if (signal.aborted) return { name: null }
      const images = model.provider === 'codex' ? imagePaths : []
      // Claude is asked in text only: a screenshot alone gives it nothing to go on.
      if (!text && !images.length) continue
      const remaining = deadline - this.now()
      if (remaining < 500) break
      const timeout = AbortSignal.timeout(remaining)
      try {
        const name = nameFromReply(await this.run(model, namingPrompt(text, images.length), images, AbortSignal.any([signal, timeout])))
        if (remember) await this.succeeded(model)
        if (name) return { name, by: await this.label(model) }
      } catch (error) {
        // The user skipped the wait: nothing about the model is learned from that.
        if (signal.aborted) return { name: null }
        if (remember) await this.failed(model as NamingModel, timeout.aborted ? null : error)
      }
    }
    return { name: null }
  }

  private async succeeded(model: NamerModel): Promise<void> {
    const stored = await this.read()
    const key = modelKey(model)
    delete stored.failures[key]
    stored.lastNamedAt[key] = this.now()
    await this.save()
  }

  /** A null error is a timeout: two in a row rest the model for an hour. */
  private async failed(model: NamingModel, error: unknown): Promise<void> {
    const stored = await this.read()
    const key = modelKey(model)
    if (error === null) {
      const previous = stored.failures[key]
      const count = (previous?.kind === 'timeouts' ? previous.count : 0) + 1
      stored.failures[key] = { kind: 'timeouts', count, ...(count >= TIMEOUTS_BEFORE_REST ? { until: this.now() + REST_MS } : {}) }
    } else if (error instanceof NamingFailure && error.kind === 'hard') {
      const fingerprint = await this.options.fingerprint?.(model)
      stored.failures[key] = { kind: 'unavailable', since: this.now(), reason: error.message, ...(fingerprint ? { fingerprint } : {}) }
    } else {
      console.warn(`Naming a session with ${model.model} failed`, error)
      return
    }
    await this.save()
  }
}

const MAX_BODY = 64 * 1024

function json(response: ServerResponse, status: number, value: unknown): void {
  const body = `${JSON.stringify(value)}\n`
  response.writeHead(status, { 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body), 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff' })
  response.end(body)
}

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (request.headers['content-type']?.split(';', 1)[0]?.trim() !== 'application/json') throw new Error('Content-Type must be application/json')
  const chunks: Buffer[] = []
  let length = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    length += buffer.length
    if (length > MAX_BODY) throw new Error('Request body is too large')
    chunks.push(buffer)
  }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Request body must be an object')
  return value as Record<string, unknown>
}

export function parseSuggestRequest(input: Record<string, unknown>): SuggestSessionNameRequest {
  const { prompt, images, chat } = input
  if (prompt !== undefined && typeof prompt !== 'string') throw new Error('prompt must be a string')
  const refs = images === undefined ? undefined : parseChatImageRefs(images)
  if (images !== undefined && !refs) throw new Error('images must be up to 10 uploaded images')
  let chatModel: SuggestSessionNameRequest['chat']
  if (chat !== undefined) {
    const { provider, model, configDir } = (chat && typeof chat === 'object' ? chat : {}) as Record<string, unknown>
    if (!isChatProvider(provider)) throw new Error('chat.provider must be a chat provider')
    if (model !== undefined && !isModelValue(model)) throw new Error('chat.model must be a model id')
    if (configDir !== undefined && (typeof configDir !== 'string' || !validClaudeConfigDir(configDir))) throw new Error('chat.configDir must be a Claude profile')
    chatModel = { provider, ...(typeof model === 'string' ? { model } : {}), ...(typeof configDir === 'string' ? { configDir } : {}) }
  }
  return { ...(typeof prompt === 'string' ? { prompt } : {}), ...(refs ? { images: refs } : {}), ...(chatModel ? { chat: chatModel } : {}) }
}

export async function handleSessionNamingApi(request: IncomingMessage, response: ServerResponse, url: URL, namer: SessionNamer): Promise<boolean> {
  const route = Object.values(SESSION_NAMING_ROUTES).find((path) => path === url.pathname)
  if (!route) return false
  try {
    if (route === SESSION_NAMING_ROUTES.suggest && request.method === 'POST') {
      const input = parseSuggestRequest(await body(request))
      // Skipping the wait in the modal closes the request: stop the model too.
      const cancel = new AbortController()
      response.once('close', () => { if (!response.writableFinished) cancel.abort() })
      json(response, 200, await namer.suggest(input, cancel.signal))
      return true
    }
    if (route === SESSION_NAMING_ROUTES.settings && request.method === 'GET') {
      json(response, 200, await namer.describe())
      return true
    }
    if (route === SESSION_NAMING_ROUTES.settings && request.method === 'PUT') {
      json(response, 200, await namer.update(await body(request)))
      return true
    }
    if (route === SESSION_NAMING_ROUTES.retry && request.method === 'POST') {
      json(response, 200, await namer.retry())
      return true
    }
    json(response, 405, { error: 'Method not allowed' })
  } catch (error) {
    if (!response.headersSent) json(response, 400, { error: error instanceof Error ? error.message : String(error) })
  }
  return true
}
