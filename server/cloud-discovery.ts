import type { ListResult, SDKAgentInfo } from '@cursor/sdk'
import {
  cloudTaskUrl, isSafeExternalUrl, validCloudRemoteId,
  type CloudDiscoveryResponse, type CloudTaskSummary, type DiscoveredAgentProvider,
  type DiscoveredAgentStatus, type DiscoveredExternalAgent, type DiscoverySourceInfo,
} from '../shared/cloud-tasks.js'
import { isCursorAuthError } from './agent-host/cursor/session.js'
import { runCloudCli } from './cloud-cli-runner.js'
import { resolveCloudExecutable } from './cloud-connections.js'
import type { CloudCliResult, CloudCliRunner } from './cloud-provider.js'

const DEFAULT_DISCOVERY_TIMEOUT_MS = 8_000
const DEFAULT_CLI_OUTPUT_BYTES = 256 * 1024
const CURSOR_LIST_LIMIT = 30
const MAX_ID_LENGTH = 160
const MAX_TITLE_LENGTH = 256
const MAX_PATH_LENGTH = 1024
const CONTROL_CHARS = /[\x00-\x1f\x7f]/

export type DiscoveredAgentCandidate = Omit<DiscoveredExternalAgent, 'alreadyTracked'>

export interface ProviderDiscoveryResult {
  source: DiscoverySourceInfo
  agents: DiscoveredAgentCandidate[]
}

export interface CloudDiscoveryAdapter {
  readonly provider: DiscoveredAgentProvider
  discover(signal: AbortSignal): Promise<ProviderDiscoveryResult>
}

export interface TrackedChatRef {
  provider: string
  sessionId?: string
}

export interface CursorDiscoverySdk {
  authStatus(): Promise<{ status: 'logged-in' | 'logged-out'; email?: string }>
  listCloudAgents(options: { limit: number }): Promise<ListResult<SDKAgentInfo>>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function cleanText(value: unknown, maxLength = MAX_TITLE_LENGTH): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.replace(/\s+/g, ' ').trim()
  if (!trimmed || CONTROL_CHARS.test(trimmed)) return undefined
  return trimmed.slice(0, maxLength)
}

function cleanId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > MAX_ID_LENGTH || /[\s\x00-\x1f\x7f]/.test(trimmed)) return undefined
  return trimmed
}

function cleanIsoTimestamp(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    const ms = value < 1e12 ? value * 1000 : value
    const date = new Date(ms)
    return Number.isFinite(date.getTime()) ? date.toISOString() : undefined
  }
  if (typeof value === 'string' && value.length <= 64) {
    const parsed = Date.parse(value)
    if (!Number.isFinite(parsed)) return undefined
    const date = new Date(parsed)
    return Number.isFinite(date.getTime()) ? date.toISOString() : undefined
  }
  return undefined
}

function cleanSafeUrl(value: unknown): string | undefined {
  return isSafeExternalUrl(value) ? value : undefined
}

export function normalizeAgentStatus(raw: unknown): DiscoveredAgentStatus {
  if (typeof raw !== 'string') return 'unknown'
  const normalized = raw.trim().toLowerCase().replace(/[\s-]+/g, '_')
  if (['running', 'in_progress', 'active', 'working', 'pending', 'queued', 'starting'].includes(normalized)) {
    return 'running'
  }
  if (['finished', 'completed', 'complete', 'done', 'ready', 'applied', 'succeeded', 'success'].includes(normalized)) {
    return 'completed'
  }
  if (['error', 'errored', 'failed', 'fail', 'cancelled', 'canceled', 'aborted'].includes(normalized)) {
    return 'failed'
  }
  return 'unknown'
}

function isCliAuthFailure(output: string): boolean {
  return /not logged in|login required|unauthenticated|unauthorized|authentication required|please log in|sign in|missing api key|invalid api key/i.test(output)
}

function isCliUnsupportedError(output: string): boolean {
  return /unknown option|unknown command|unrecognized option|invalid option|not supported|no such command|unexpected argument/i.test(output)
}

function extractItemArray(parsed: unknown, keys: readonly string[]): unknown[] | null {
  if (Array.isArray(parsed)) return parsed
  if (!isRecord(parsed)) return null
  for (const key of keys) {
    const candidate = parsed[key]
    if (Array.isArray(candidate)) return candidate
  }
  return null
}

function normalizeChatProvider(provider: string): DiscoveredAgentProvider | null {
  switch (provider.trim().toLowerCase()) {
    case 'cursor':
    case 'cursor-chat':
      return 'cursor'
    case 'codex':
    case 'codex-chat':
      return 'codex'
    case 'claude':
    case 'claude-chat':
      return 'claude'
    default:
      return null
  }
}

function formatCursorRepo(repo: string | undefined): string | undefined {
  const cleaned = cleanText(repo, 256)
  if (!cleaned) return undefined
  try {
    const parsed = new URL(cleaned)
    const path = parsed.pathname.replace(/^\/+|\/+$|\.git$/g, '')
    return path || cleaned
  } catch {
    return cleaned
  }
}

function mapCursorAgent(info: SDKAgentInfo): DiscoveredAgentCandidate | null {
  if (info.archived) return null
  const id = cleanId(info.agentId)
  if (!id) return null
  const title = cleanText(info.name) ?? cleanText(info.summary) ?? id
  const cloudRepos = info.runtime === 'cloud' && Array.isArray(info.repos) ? info.repos : undefined
  const metadata = info.runtime === 'cloud' && isRecord(info.metadata) ? info.metadata : undefined
  const repo = formatCursorRepo(cloudRepos?.[0])
  const branch = cleanText(metadata?.branch)
  const prUrl = cleanSafeUrl(metadata?.prUrl ?? metadata?.pr_url)
  const url = `https://cursor.com/agents?selectedBcId=${encodeURIComponent(id)}`
  const updatedAt = cleanIsoTimestamp(info.lastModified ?? info.createdAt)
  return {
    id,
    provider: 'cursor',
    title,
    status: normalizeAgentStatus(info.status),
    ...(repo ? { repo } : {}),
    ...(branch ? { branch } : {}),
    url,
    ...(prUrl ? { prUrl } : {}),
    ...(updatedAt ? { updatedAt } : {}),
    canOpenAsChat: true,
  }
}

async function defaultLoadCursorDiscoverySdk(): Promise<CursorDiscoverySdk> {
  const { Agent, Cursor } = await import('@cursor/sdk')
  return {
    authStatus: () => Cursor.auth.status(),
    listCloudAgents: ({ limit }) => Agent.list({ runtime: 'cloud', limit }),
  }
}

export interface CursorDiscoveryAdapterOptions {
  loadSdk?: () => Promise<CursorDiscoverySdk>
  hasApiKey?: () => boolean
}

export class CursorCloudDiscoveryAdapter implements CloudDiscoveryAdapter {
  readonly provider = 'cursor' as const
  private readonly loadSdk: () => Promise<CursorDiscoverySdk>
  private readonly hasApiKey: () => boolean

  constructor(options: CursorDiscoveryAdapterOptions = {}) {
    this.loadSdk = options.loadSdk ?? defaultLoadCursorDiscoverySdk
    this.hasApiKey = options.hasApiKey ?? (() => Boolean(process.env.CURSOR_API_KEY?.trim()))
  }

  async discover(signal: AbortSignal): Promise<ProviderDiscoveryResult> {
    if (signal.aborted) {
      return { source: { provider: this.provider, status: 'error', message: 'Cursor cloud discovery timed out.' }, agents: [] }
    }
    let sdk: CursorDiscoverySdk
    try {
      sdk = await this.loadSdk()
    } catch {
      return { source: { provider: this.provider, status: 'unavailable', message: 'Cursor SDK is unavailable.' }, agents: [] }
    }
    if (signal.aborted) {
      return { source: { provider: this.provider, status: 'error', message: 'Cursor cloud discovery timed out.' }, agents: [] }
    }
    try {
      if (!this.hasApiKey()) {
        const auth = await sdk.authStatus()
        if (signal.aborted) {
          return { source: { provider: this.provider, status: 'error', message: 'Cursor cloud discovery timed out.' }, agents: [] }
        }
        if (auth.status !== 'logged-in') {
          return {
            source: { provider: this.provider, status: 'unauthenticated', message: 'Log in to Cursor to list cloud agents.' },
            agents: [],
          }
        }
      }
      const listed = await sdk.listCloudAgents({ limit: CURSOR_LIST_LIMIT })
      const items = Array.isArray(listed?.items) ? listed.items : []
      const agents = items.flatMap((item) => {
        const mapped = mapCursorAgent(item)
        return mapped ? [mapped] : []
      })
      return { source: { provider: this.provider, status: 'ok' }, agents }
    } catch (error) {
      if (isCursorAuthError(error)) {
        return {
          source: { provider: this.provider, status: 'unauthenticated', message: 'Log in to Cursor to list cloud agents.' },
          agents: [],
        }
      }
      return {
        source: { provider: this.provider, status: 'error', message: 'Unable to list Cursor cloud agents.' },
        agents: [],
      }
    }
  }
}

function mapCodexItem(item: unknown): DiscoveredAgentCandidate | null {
  if (!isRecord(item)) return null
  const id = cleanId(item.id ?? item.task_id ?? item.taskId)
  if (!id) return null
  const summary = isRecord(item.summary) ? undefined : cleanText(item.summary)
  const title = cleanText(item.title) ?? cleanText(item.name) ?? summary ?? cleanText(item.prompt) ?? id
  const repo = cleanText(item.repo)
    ?? cleanText(item.repository)
    ?? cleanText(item.environment_label)
    ?? cleanText(item.environment_id)
  const branch = cleanText(item.branch) ?? cleanText(item.git_branch) ?? cleanText(item.ref)
  const url = cleanSafeUrl(item.url) ?? (validCloudRemoteId('codex', id) ? cloudTaskUrl('codex', id) : undefined)
  const prUrl = cleanSafeUrl(item.pr_url) ?? cleanSafeUrl(item.prUrl) ?? cleanSafeUrl(item.pull_request_url)
  const updatedAt = cleanIsoTimestamp(item.updated_at ?? item.updatedAt ?? item.created_at ?? item.createdAt)
  return {
    id,
    provider: 'codex',
    title,
    status: normalizeAgentStatus(item.status ?? item.state),
    ...(repo ? { repo } : {}),
    ...(branch ? { branch } : {}),
    ...(url ? { url } : {}),
    ...(prUrl ? { prUrl } : {}),
    ...(updatedAt ? { updatedAt } : {}),
    canOpenAsChat: false,
  }
}

function parseCodexListJson(stdout: string): DiscoveredAgentCandidate[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return null
  }
  const items = extractItemArray(parsed, ['tasks', 'items'])
  if (!items) return null
  const mapped = items.flatMap((entry) => {
    const agent = mapCodexItem(entry)
    return agent ? [agent] : []
  })
  if (items.length > 0 && mapped.length === 0) return null
  return mapped
}

export interface CodexDiscoveryAdapterOptions {
  runner?: CloudCliRunner
  executable?: string
  timeoutMs?: number
}

export class CodexCloudDiscoveryAdapter implements CloudDiscoveryAdapter {
  readonly provider = 'codex' as const
  private readonly runner: CloudCliRunner
  private readonly executable: string
  private readonly timeoutMs: number

  constructor(options: CodexDiscoveryAdapterOptions = {}) {
    this.runner = options.runner ?? runCloudCli
    this.executable = options.executable ?? resolveCloudExecutable('codex')
    this.timeoutMs = options.timeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS
  }

  async discover(signal: AbortSignal): Promise<ProviderDiscoveryResult> {
    let result: CloudCliResult
    try {
      result = await this.runner({
        executable: this.executable,
        args: ['cloud', 'list', '--json'],
        timeoutMs: this.timeoutMs,
        maxOutputBytes: DEFAULT_CLI_OUTPUT_BYTES,
        signal,
      })
    } catch {
      return { source: { provider: this.provider, status: 'error', message: 'Unable to run Codex CLI.' }, agents: [] }
    }
    if (!result.spawned) {
      return { source: { provider: this.provider, status: 'unavailable', message: 'Codex CLI is not installed.' }, agents: [] }
    }
    if (result.timedOut) {
      return { source: { provider: this.provider, status: 'error', message: 'Codex cloud list timed out.' }, agents: [] }
    }
    if (result.exitCode !== 0 || result.signal) {
      const combined = `${result.stderr}\n${result.stdout}`
      if (isCliAuthFailure(combined)) {
        return { source: { provider: this.provider, status: 'unauthenticated', message: 'Log in to Codex to list cloud tasks.' }, agents: [] }
      }
      if (isCliUnsupportedError(combined)) {
        return { source: { provider: this.provider, status: 'unavailable', message: 'Installed Codex CLI does not support cloud listing.' }, agents: [] }
      }
      return { source: { provider: this.provider, status: 'error', message: 'Unable to list Codex cloud tasks.' }, agents: [] }
    }
    if (result.truncated) {
      return { source: { provider: this.provider, status: 'error', message: 'Codex cloud list output exceeded size limit.' }, agents: [] }
    }
    const agents = parseCodexListJson(result.stdout)
    if (!agents) {
      return { source: { provider: this.provider, status: 'error', message: 'Codex returned an unrecognized task list.' }, agents: [] }
    }
    return { source: { provider: this.provider, status: 'ok' }, agents }
  }
}

function mapClaudeItem(item: unknown): DiscoveredAgentCandidate | null {
  if (!isRecord(item)) return null
  const id = cleanId(item.id ?? item.session_id ?? item.sessionId ?? item.agent_id ?? item.agentId)
  if (!id) return null
  const title = cleanText(item.title)
    ?? cleanText(item.name)
    ?? cleanText(item.summary)
    ?? cleanText(item.description)
    ?? cleanText(item.prompt)
    ?? id
  const repo = cleanText(item.repo) ?? cleanText(item.repository)
  const branch = cleanText(item.branch) ?? cleanText(item.git_branch)
  const cwd = cleanText(item.cwd ?? item.working_directory ?? item.workingDirectory, MAX_PATH_LENGTH)
  const url = cleanSafeUrl(item.url) ?? (validCloudRemoteId('claude', id) ? cloudTaskUrl('claude', id) : undefined)
  const prUrl = cleanSafeUrl(item.pr_url) ?? cleanSafeUrl(item.prUrl)
  const updatedAt = cleanIsoTimestamp(
    item.updated_at ?? item.updatedAt ?? item.last_active_at ?? item.lastActiveAt ?? item.created_at ?? item.createdAt,
  )
  return {
    id,
    provider: 'claude',
    title,
    status: normalizeAgentStatus(item.status ?? item.state),
    ...(repo ? { repo } : {}),
    ...(branch ? { branch } : {}),
    ...(cwd ? { cwd } : {}),
    ...(url ? { url } : {}),
    ...(prUrl ? { prUrl } : {}),
    ...(updatedAt ? { updatedAt } : {}),
    canOpenAsChat: false,
  }
}

function parseClaudeAgentsJson(stdout: string): DiscoveredAgentCandidate[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return null
  }
  const items = extractItemArray(parsed, ['agents', 'sessions', 'tasks', 'items'])
  if (!items) return null
  const mapped = items.flatMap((entry) => {
    const agent = mapClaudeItem(entry)
    return agent ? [agent] : []
  })
  if (items.length > 0 && mapped.length === 0) return null
  return mapped
}

export interface ClaudeDiscoveryAdapterOptions {
  runner?: CloudCliRunner
  executable?: string
  configDir?: string | null
  timeoutMs?: number
}

export class ClaudeAgentsDiscoveryAdapter implements CloudDiscoveryAdapter {
  readonly provider = 'claude' as const
  private readonly runner: CloudCliRunner
  private readonly executable: string
  private readonly configDir: string | null | undefined
  private readonly timeoutMs: number

  constructor(options: ClaudeDiscoveryAdapterOptions = {}) {
    this.runner = options.runner ?? runCloudCli
    this.executable = options.executable ?? resolveCloudExecutable('claude')
    this.configDir = options.configDir
    this.timeoutMs = options.timeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS
  }

  async discover(signal: AbortSignal): Promise<ProviderDiscoveryResult> {
    let result: CloudCliResult
    try {
      result = await this.runner({
        executable: this.executable,
        args: ['agents', '--json'],
        timeoutMs: this.timeoutMs,
        maxOutputBytes: DEFAULT_CLI_OUTPUT_BYTES,
        signal,
        claudeConfigDir: this.configDir,
      })
    } catch {
      return { source: { provider: this.provider, status: 'unavailable', message: 'Claude CLI is unavailable.' }, agents: [] }
    }
    if (!result.spawned) {
      return { source: { provider: this.provider, status: 'unavailable', message: 'Claude CLI is not installed.' }, agents: [] }
    }
    if (result.timedOut) {
      return { source: { provider: this.provider, status: 'error', message: 'Claude agents discovery timed out.' }, agents: [] }
    }
    if (result.exitCode !== 0 || result.signal) {
      const combined = `${result.stderr}\n${result.stdout}`
      if (isCliAuthFailure(combined)) {
        return { source: { provider: this.provider, status: 'unauthenticated', message: 'Log in to Claude to list background agents.' }, agents: [] }
      }
      return { source: { provider: this.provider, status: 'unavailable', message: 'Installed Claude CLI does not support agent listing.' }, agents: [] }
    }
    if (result.truncated) {
      return { source: { provider: this.provider, status: 'error', message: 'Claude agents output exceeded size limit.' }, agents: [] }
    }
    const agents = parseClaudeAgentsJson(result.stdout)
    if (!agents) {
      return { source: { provider: this.provider, status: 'error', message: 'Claude returned an unrecognized agent list.' }, agents: [] }
    }
    return { source: { provider: this.provider, status: 'ok' }, agents }
  }
}

async function runAdapterWithTimeout(adapter: CloudDiscoveryAdapter, timeoutMs: number): Promise<ProviderDiscoveryResult> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      adapter.discover(controller.signal),
      new Promise<ProviderDiscoveryResult>((resolve) => {
        timer = setTimeout(() => {
          controller.abort()
          resolve({
            source: { provider: adapter.provider, status: 'error', message: `Discovery timed out for ${adapter.provider}.` },
            agents: [],
          })
        }, timeoutMs)
        timer.unref()
      }),
    ])
  } catch {
    return {
      source: { provider: adapter.provider, status: 'error', message: `Discovery failed for ${adapter.provider}.` },
      agents: [],
    }
  } finally {
    clearTimeout(timer)
  }
}

function collectTrackedKeys(
  listTrackedTasks: () => readonly CloudTaskSummary[],
  listOpenChats: () => readonly TrackedChatRef[],
): Set<string> {
  const keys = new Set<string>()
  try {
    for (const task of listTrackedTasks()) {
      if (task.providerTaskId) keys.add(`${task.provider}:${task.providerTaskId}`)
    }
  } catch {
    // Best-effort tracking lookup must never fail discovery.
  }
  try {
    for (const chat of listOpenChats()) {
      const provider = normalizeChatProvider(chat.provider)
      if (provider && chat.sessionId) keys.add(`${provider}:${chat.sessionId}`)
    }
  } catch {
    // Best-effort open-chat lookup must never fail discovery.
  }
  return keys
}

function compareDiscoveredAgents(a: DiscoveredExternalAgent, b: DiscoveredExternalAgent): number {
  const aTime = a.updatedAt ? Date.parse(a.updatedAt) : Number.NEGATIVE_INFINITY
  const bTime = b.updatedAt ? Date.parse(b.updatedAt) : Number.NEGATIVE_INFINITY
  if (aTime !== bTime) return bTime - aTime
  return 0
}

export interface CloudDiscoveryServiceOptions {
  adapters?: readonly CloudDiscoveryAdapter[]
  listTrackedTasks?: () => readonly CloudTaskSummary[]
  listOpenChats?: () => readonly TrackedChatRef[]
  timeoutMs?: number
  now?: () => number
}

export class CloudDiscoveryService {
  private readonly adapters: readonly CloudDiscoveryAdapter[]
  private readonly listTrackedTasks: () => readonly CloudTaskSummary[]
  private readonly listOpenChats: () => readonly TrackedChatRef[]
  private readonly timeoutMs: number
  private readonly now: () => number

  constructor(options: CloudDiscoveryServiceOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS
    this.adapters = options.adapters ?? [
      new CursorCloudDiscoveryAdapter(),
      new CodexCloudDiscoveryAdapter({ timeoutMs: this.timeoutMs }),
      new ClaudeAgentsDiscoveryAdapter({ timeoutMs: this.timeoutMs }),
    ]
    this.listTrackedTasks = options.listTrackedTasks ?? (() => [])
    this.listOpenChats = options.listOpenChats ?? (() => [])
    this.now = options.now ?? Date.now
  }

  async discover(): Promise<CloudDiscoveryResponse> {
    const results = await Promise.all(
      this.adapters.map((adapter) => runAdapterWithTimeout(adapter, this.timeoutMs)),
    )
    const tracked = collectTrackedKeys(this.listTrackedTasks, this.listOpenChats)
    const seen = new Set<string>()
    const agents: DiscoveredExternalAgent[] = []
    const sources: DiscoverySourceInfo[] = []

    for (const result of results) {
      sources.push(result.source)
      for (const candidate of result.agents) {
        const key = `${candidate.provider}:${candidate.id}`
        if (seen.has(key)) continue
        seen.add(key)
        agents.push({ ...candidate, alreadyTracked: tracked.has(key) })
      }
    }

    agents.sort(compareDiscoveredAgents)
    return {
      agents,
      sources,
      discoveredAt: new Date(this.now()).toISOString(),
    }
  }
}
