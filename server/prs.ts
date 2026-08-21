import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import {
  isCommandoTargetId,
  parseCommandoPrMarker,
  stripCommandoPrMarkers,
  type CommandoPrMarker,
} from '../shared/pane-target.js'

const COMMAND_TIMEOUT_MS = 20_000
const COMMAND_BUFFER_BYTES = 4 * 1024 * 1024
const GIT_COMMAND_TIMEOUT_MS = 5_000
const GIT_COMMAND_BUFFER_BYTES = 64 * 1024
const LIST_CACHE_TTL_MS = 20_000
const REPOS_CACHE_TTL_MS = 5 * 60_000
const REPO_CONTEXT_CACHE_TTL_MS = 5_000
const PULL_REQUEST_PAGE_SIZE = 30
const BODY_EXCERPT_CHARS = 280
const THREAD_PAGE_SIZE = 50
const THREAD_EXCERPT_CHARS = 140
const PANE_PULL_REQUEST_PAGE_SIZE = 100

const THREADS_QUERY = `
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: ${THREAD_PAGE_SIZE}) {
        totalCount
        nodes { isResolved path comments(first: 1) { nodes { author { login } body } } }
      }
    }
  }
}`.trim()
const PANE_PULL_REQUESTS_QUERY = `
query($targetQuery: String!) {
  linked: search(query: $targetQuery, type: ISSUE, first: ${PANE_PULL_REQUEST_PAGE_SIZE}) {
    issueCount
    nodes {
      ... on PullRequest {
        number title url state isDraft body createdAt updatedAt
        repository { nameWithOwner }
      }
    }
  }
}`.trim()
const MAX_PINNED_REPOS = 30
const MAX_RECENT_REPOS = 20
const MAX_LIST_CACHE_ENTRIES = 100
const MAX_PANE_LIST_CACHE_ENTRIES = 100
const REPO_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})?\/[A-Za-z0-9._-]{1,100}$/

type JsonRecord = Record<string, unknown>

export type PrStateFilter = 'open' | 'closed' | 'all'
export type PrScope = 'mine' | 'everyone'
export type PrCheckState = 'pass' | 'fail' | 'pending'

export type PrCheckRun = { name: string; state: PrCheckState }

export type PrChecks = {
  state: PrCheckState
  runs: PrCheckRun[]
  failed: number
  pending: number
  total: number
  truncated: boolean
} | null

export type PrReview = { login: string; state: 'approved' | 'changes_requested' }

export type PrSummary = {
  number: number
  title: string
  url: string
  state: 'open' | 'merged' | 'closed'
  isDraft: boolean
  author: string | null
  bodyExcerpt: string
  additions: number
  deletions: number
  changedFiles: number
  commitCount: number
  unresolvedThreads: number
  threadsTruncated: boolean
  reviewDecision: 'approved' | 'changes_requested' | 'review_required' | null
  reviews: PrReview[]
  requestedReviewers: string[]
  conflicting: boolean
  checks: PrChecks
  createdAt: string
  updatedAt: string
  headRefName: string
  baseRefName: string
  viewerIsAuthor: boolean
  viewerReviewRequested: boolean
  commandoMarker: CommandoPrMarker | null
}

export type PrList = {
  repo: string
  filter: PrStateFilter
  viewer: string
  totalCount: number
  pullRequests: PrSummary[]
  truncated: boolean
  mineTruncated: boolean
  fetchedAt: number
}

export type PanePrSummary = {
  repo: string
  number: number
  title: string
  url: string
  state: 'open' | 'merged' | 'closed'
  isDraft: boolean
  createdAt: string
  updatedAt: string
}

export type PanePrList = {
  targetId: string
  totalCount: number
  pullRequests: PanePrSummary[]
  truncated: boolean
  fetchedAt: number
}

export type PrRepoOption = { nameWithOwner: string; pinned: boolean }

export type PrThreadExcerpt = { path: string | null; author: string | null; excerpt: string }

export type PrThreads = {
  repo: string
  number: number
  threads: PrThreadExcerpt[]
  truncated: boolean
  fetchedAt: number
}

export type PrPreferences = {
  version: 1
  pinnedRepos: string[]
  recentRepos: string[]
  lastRepo: string | null
  lastFilter: PrStateFilter
  lastScope: PrScope
}

export type GhRunner = (args: string[]) => Promise<string>
export type GitRunner = (args: string[], cwd: string) => Promise<string>

export class PrServiceError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'PrServiceError'
  }
}

const defaultRunner: GhRunner = (args) =>
  new Promise((resolve, reject) => {
    execFile(
      'gh',
      args,
      {
        timeout: COMMAND_TIMEOUT_MS,
        maxBuffer: COMMAND_BUFFER_BYTES,
        env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' },
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(classifyGhFailure(error, stderr ?? ''))
          return
        }
        resolve(stdout)
      },
    )
  })

const defaultGitRunner: GitRunner = (args, cwd) =>
  new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      {
        cwd,
        timeout: GIT_COMMAND_TIMEOUT_MS,
        maxBuffer: GIT_COMMAND_BUFFER_BYTES,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      },
      (error, stdout) => {
        if (error) {
          reject(error)
          return
        }
        resolve(stdout)
      },
    )
  })

function classifyGhFailure(error: import('node:child_process').ExecFileException, stderr: string): PrServiceError {
  if (error.code === 'ENOENT') {
    return new PrServiceError(503, 'gh_unavailable', 'The gh CLI is not installed on the daemon host')
  }
  if (error.killed) {
    return new PrServiceError(504, 'github_timeout', 'GitHub request timed out')
  }
  if (/gh auth login|not logged in|authentication required|HTTP 401|Bad credentials/i.test(stderr)) {
    return new PrServiceError(401, 'auth_required', 'gh is not authenticated — run `gh auth login` on the daemon host')
  }
  if (/Could not resolve to a Repository/i.test(stderr)) {
    return new PrServiceError(404, 'repo_not_found', 'Repository was not found')
  }
  const detail = stderr.trim().split(/\r?\n/, 1)[0]?.slice(0, 200)
  return new PrServiceError(502, 'github_failed', detail ? `GitHub request failed: ${detail}` : 'GitHub request failed')
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function invalidUpstream(): PrServiceError {
  return new PrServiceError(502, 'github_invalid_response', 'GitHub returned an invalid response')
}

function requiredString(record: JsonRecord, key: string): string {
  const value = record[key]
  if (typeof value !== 'string') throw invalidUpstream()
  return value
}

function requiredNumber(record: JsonRecord, key: string): number {
  const value = record[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) throw invalidUpstream()
  return value
}

function requiredBoolean(record: JsonRecord, key: string): boolean {
  const value = record[key]
  if (typeof value !== 'boolean') throw invalidUpstream()
  return value
}

function objectField(record: JsonRecord, key: string): JsonRecord {
  const value = record[key]
  if (!isRecord(value)) throw invalidUpstream()
  return value
}

function optionalObject(record: JsonRecord, key: string): JsonRecord | null {
  const value = record[key]
  if (value === null || value === undefined) return null
  if (!isRecord(value)) throw invalidUpstream()
  return value
}

function nodes(record: JsonRecord, key: string): JsonRecord[] {
  const connection = objectField(record, key)
  const value = connection.nodes
  if (!Array.isArray(value)) throw invalidUpstream()
  return value.filter(isRecord)
}

function searchConnection(data: JsonRecord, key: string): { nodes: JsonRecord[]; totalCount: number; truncated: boolean } {
  const connection = objectField(data, key)
  const value = connection.nodes
  if (!Array.isArray(value)) throw invalidUpstream()
  // Non-PR search hits surface as empty objects from the inline fragment.
  const prNodes = value.filter(isRecord).filter((node) => typeof node.number === 'number')
  const issueCount = typeof connection.issueCount === 'number' ? connection.issueCount : value.length
  return { nodes: prNodes, totalCount: issueCount, truncated: issueCount > value.length }
}

export function validateRepo(value: unknown): string {
  if (typeof value !== 'string' || !REPO_PATTERN.test(value)) {
    throw new PrServiceError(400, 'invalid_request', 'repo must look like owner/name')
  }
  return value
}

function repoFromGithubPath(path: string): string | null {
  const repo = path.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '')
  return REPO_PATTERN.test(repo) ? repo : null
}

export function repoFromGithubRemote(remoteInput: string): string | null {
  const remote = remoteInput.trim()
  const scp = remote.match(/^(?:[^@/\s]+@)?github\.com:(.+)$/i)
  if (scp) return repoFromGithubPath(scp[1])
  try {
    const url = new URL(remote)
    if (!['http:', 'https:', 'ssh:', 'git:'].includes(url.protocol)) return null
    if (url.hostname.toLowerCase() !== 'github.com') return null
    return repoFromGithubPath(url.pathname)
  } catch {
    return null
  }
}

export function validatePrNumber(value: unknown): number {
  const number = typeof value === 'string' && value !== '' ? Number(value) : value
  if (typeof number !== 'number' || !Number.isInteger(number) || number <= 0) {
    throw new PrServiceError(400, 'invalid_request', 'number must be a positive integer')
  }
  return number
}

export function validateStateFilter(value: unknown): PrStateFilter {
  if (value === undefined || value === null || value === '') return 'open'
  if (value === 'open' || value === 'closed' || value === 'all') return value
  throw new PrServiceError(400, 'invalid_request', 'state must be "open", "closed", or "all"')
}

export function validatePaneTargetId(value: unknown): string {
  if (!isCommandoTargetId(value)) {
    throw new PrServiceError(400, 'invalid_request', 'targetId must be a Commando pane target id')
  }
  return value
}

function statesArgument(filter: PrStateFilter): string {
  if (filter === 'open') return 'states: [OPEN], '
  if (filter === 'closed') return 'states: [CLOSED, MERGED], '
  return ''
}

// The repo-wide page only holds the ${PULL_REQUEST_PAGE_SIZE} most recently
// updated PRs, so on a busy repo the viewer's own PRs fall out of it. The two
// aliased searches fetch those directly and get merged into the list.
function pullRequestQuery(filter: PrStateFilter): string {
  return `
query($owner: String!, $name: String!, $authoredQuery: String!, $reviewRequestedQuery: String!) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    pullRequests(first: ${PULL_REQUEST_PAGE_SIZE}, ${statesArgument(filter)}orderBy: {field: UPDATED_AT, direction: DESC}) {
      totalCount
      nodes { ...PrFields }
    }
  }
  authored: search(query: $authoredQuery, type: ISSUE, first: ${PULL_REQUEST_PAGE_SIZE}) {
    issueCount
    nodes { ... on PullRequest { ...PrFields } }
  }
  reviewRequested: search(query: $reviewRequestedQuery, type: ISSUE, first: ${PULL_REQUEST_PAGE_SIZE}) {
    issueCount
    nodes { ... on PullRequest { ...PrFields } }
  }
}
fragment PrFields on PullRequest {
  number title url state isDraft body
  author { login }
  additions deletions changedFiles
  reviewDecision mergeable createdAt updatedAt headRefName baseRefName
  reviewThreads(first: 50) { totalCount nodes { isResolved } }
  reviewRequests(first: 20) { nodes { requestedReviewer { __typename ... on User { login } } } }
  latestReviews(first: 10) { nodes { author { login } state } }
  commits(last: 1) { totalCount nodes { commit { statusCheckRollup {
    state
    contexts(first: 50) {
      totalCount
      nodes { __typename ... on CheckRun { name status conclusion } ... on StatusContext { context state } }
    }
  } } } }
}`.trim()
}

function searchStateQualifier(filter: PrStateFilter): string {
  if (filter === 'open') return ' is:open'
  if (filter === 'closed') return ' is:closed'
  return ''
}

function scopedSearchQuery(repo: string, qualifier: 'author' | 'review-requested', filter: PrStateFilter): string {
  return `repo:${repo} is:pr ${qualifier}:@me${searchStateQualifier(filter)}`
}

function paneTargetSearchQuery(targetId: string): string {
  return `is:pr in:body ${targetId} sort:created-desc`
}

function parsePanePullRequest(node: JsonRecord, targetId: string): PanePrSummary | null {
  const body = typeof node.body === 'string' ? node.body : ''
  if (parseCommandoPrMarker(body)?.targetId !== targetId) return null
  const repository = optionalObject(node, 'repository')
  const repo = repository && typeof repository.nameWithOwner === 'string'
    ? repository.nameWithOwner
    : null
  if (!repo || !REPO_PATTERN.test(repo)) return null
  const stateValue = requiredString(node, 'state')
  return {
    repo,
    number: requiredNumber(node, 'number'),
    title: requiredString(node, 'title'),
    url: requiredString(node, 'url'),
    state: stateValue === 'OPEN' ? 'open' : stateValue === 'MERGED' ? 'merged' : 'closed',
    isDraft: requiredBoolean(node, 'isDraft'),
    createdAt: requiredString(node, 'createdAt'),
    updatedAt: requiredString(node, 'updatedAt'),
  }
}

function checkRunState(node: JsonRecord): PrCheckRun | null {
  if (node.__typename === 'CheckRun') {
    const name = typeof node.name === 'string' ? node.name : 'check'
    if (node.status !== 'COMPLETED') return { name, state: 'pending' }
    const conclusion = node.conclusion
    if (conclusion === 'SUCCESS' || conclusion === 'NEUTRAL' || conclusion === 'SKIPPED') return { name, state: 'pass' }
    return { name, state: 'fail' }
  }
  if (node.__typename === 'StatusContext') {
    const name = typeof node.context === 'string' ? node.context : 'status'
    if (node.state === 'SUCCESS') return { name, state: 'pass' }
    if (node.state === 'PENDING' || node.state === 'EXPECTED') return { name, state: 'pending' }
    return { name, state: 'fail' }
  }
  return null
}

function parseChecks(commit: JsonRecord | null): PrChecks {
  if (!commit) return null
  const rollup = optionalObject(commit, 'statusCheckRollup')
  if (!rollup) return null
  const contexts = objectField(rollup, 'contexts')
  const contextNodes = nodes(rollup, 'contexts')
  const totalCount = typeof contexts.totalCount === 'number' ? contexts.totalCount : contextNodes.length

  // Duplicate context names are rerun attempts; a passing attempt wins, then pending.
  const byName = new Map<string, PrCheckState>()
  for (const node of contextNodes) {
    const run = checkRunState(node)
    if (!run) continue
    const existing = byName.get(run.name)
    if (existing === 'pass') continue
    if (existing === 'pending' && run.state === 'fail') continue
    byName.set(run.name, run.state)
  }
  const runs = [...byName.entries()].map(([name, state]) => ({ name, state }))
  const failed = runs.filter((run) => run.state === 'fail').length
  const pending = runs.filter((run) => run.state === 'pending').length

  const rollupState = rollup.state
  const state: PrCheckState =
    rollupState === 'SUCCESS' ? 'pass'
    : rollupState === 'FAILURE' || rollupState === 'ERROR' ? 'fail'
    : rollupState === 'PENDING' ? 'pending'
    : failed > 0 ? 'fail' : pending > 0 ? 'pending' : 'pass'

  return { state, runs, failed, pending, total: runs.length, truncated: totalCount > contextNodes.length }
}

function parseReviewDecision(value: unknown): PrSummary['reviewDecision'] {
  if (value === 'APPROVED') return 'approved'
  if (value === 'CHANGES_REQUESTED') return 'changes_requested'
  if (value === 'REVIEW_REQUIRED') return 'review_required'
  return null
}

function parsePullRequest(node: JsonRecord, viewer: string): PrSummary {
  const stateValue = requiredString(node, 'state')
  const state = stateValue === 'OPEN' ? 'open' : stateValue === 'MERGED' ? 'merged' : 'closed'
  const author = optionalObject(node, 'author')
  const authorLogin = author && typeof author.login === 'string' ? author.login : null

  const threads = objectField(node, 'reviewThreads')
  const threadNodes = nodes(node, 'reviewThreads')
  const threadTotal = typeof threads.totalCount === 'number' ? threads.totalCount : threadNodes.length
  const unresolvedThreads = threadNodes.filter((thread) => thread.isResolved === false).length

  const reviewRequestNodes = nodes(node, 'reviewRequests')
  const viewerReviewRequested = reviewRequestNodes.some((request) => {
    const reviewer = optionalObject(request, 'requestedReviewer')
    return reviewer?.__typename === 'User' && reviewer.login === viewer
  })

  const reviews: PrReview[] = []
  for (const review of nodes(node, 'latestReviews')) {
    const reviewAuthor = optionalObject(review, 'author')
    const login = reviewAuthor && typeof reviewAuthor.login === 'string' ? reviewAuthor.login : null
    if (!login) continue
    if (review.state === 'APPROVED') reviews.push({ login, state: 'approved' })
    else if (review.state === 'CHANGES_REQUESTED') reviews.push({ login, state: 'changes_requested' })
  }
  const requestedReviewers = reviewRequestNodes.flatMap((request) => {
    const reviewer = optionalObject(request, 'requestedReviewer')
    return reviewer?.__typename === 'User' && typeof reviewer.login === 'string' ? [reviewer.login] : []
  })

  const commitsConnection = objectField(node, 'commits')
  const commitNodes = nodes(node, 'commits')
  const commit = commitNodes[0] ? optionalObject(commitNodes[0], 'commit') : null
  const body = typeof node.body === 'string' ? node.body : ''

  return {
    number: requiredNumber(node, 'number'),
    title: requiredString(node, 'title'),
    url: requiredString(node, 'url'),
    state,
    isDraft: requiredBoolean(node, 'isDraft'),
    author: authorLogin,
    bodyExcerpt: stripCommandoPrMarkers(body).trim().slice(0, BODY_EXCERPT_CHARS),
    additions: requiredNumber(node, 'additions'),
    deletions: requiredNumber(node, 'deletions'),
    changedFiles: requiredNumber(node, 'changedFiles'),
    commitCount: typeof commitsConnection.totalCount === 'number' ? commitsConnection.totalCount : 0,
    unresolvedThreads,
    threadsTruncated: threadTotal > threadNodes.length,
    reviewDecision: parseReviewDecision(node.reviewDecision),
    reviews,
    requestedReviewers,
    conflicting: node.mergeable === 'CONFLICTING',
    checks: parseChecks(commit),
    createdAt: typeof node.createdAt === 'string' ? node.createdAt : '',
    updatedAt: requiredString(node, 'updatedAt'),
    headRefName: requiredString(node, 'headRefName'),
    baseRefName: typeof node.baseRefName === 'string' ? node.baseRefName : '',
    viewerIsAuthor: authorLogin !== null && authorLogin === viewer,
    viewerReviewRequested,
    commandoMarker: parseCommandoPrMarker(body),
  }
}

function parsePreferences(value: unknown): PrPreferences {
  if (!isRecord(value) || value.version !== 1) throw new Error('PR preferences file has an invalid structure')
  const pinned = value.pinnedRepos
  if (!Array.isArray(pinned) || pinned.length > MAX_PINNED_REPOS || !pinned.every((repo) => typeof repo === 'string' && REPO_PATTERN.test(repo))) {
    throw new Error('PR preferences file has an invalid pinned repo list')
  }
  const lastRepo = value.lastRepo
  if (lastRepo !== null && (typeof lastRepo !== 'string' || !REPO_PATTERN.test(lastRepo))) {
    throw new Error('PR preferences file has an invalid last repo')
  }
  const recent = value.recentRepos ?? []
  if (!Array.isArray(recent) || recent.length > MAX_RECENT_REPOS || !recent.every((repo) => typeof repo === 'string' && REPO_PATTERN.test(repo))) {
    throw new Error('PR preferences file has an invalid recent repo list')
  }
  const lastFilter = value.lastFilter
  if (lastFilter !== 'open' && lastFilter !== 'closed' && lastFilter !== 'all') {
    throw new Error('PR preferences file has an invalid last filter')
  }
  const lastScope = value.lastScope
  if (lastScope !== 'mine' && lastScope !== 'everyone') {
    throw new Error('PR preferences file has an invalid last scope')
  }
  return {
    version: 1,
    pinnedRepos: [...pinned] as string[],
    recentRepos: [...recent] as string[],
    lastRepo,
    lastFilter,
    lastScope,
  }
}

function defaultPreferences(): PrPreferences {
  return { version: 1, pinnedRepos: [], recentRepos: [], lastRepo: null, lastFilter: 'open', lastScope: 'mine' }
}

export function defaultPrPreferencesPath(): string {
  return process.env.COMMANDO_PRS_PREFS_PATH ?? join(homedir(), '.commando', 'prs.json')
}

export class PrPreferencesStore {
  readonly path: string
  private writes: Promise<void> = Promise.resolve()

  constructor(path = defaultPrPreferencesPath()) {
    this.path = path
  }

  async read(): Promise<PrPreferences> {
    await this.writes
    return this.load()
  }

  update(input: unknown): Promise<PrPreferences> {
    let result: PrPreferences | undefined
    const operation = this.writes.then(async () => {
      const patch = this.validatePatch(input)
      const current = await this.load()
      result = { ...current, ...patch }
      if (patch.lastRepo) {
        const selectedKey = patch.lastRepo.toLowerCase()
        result.recentRepos = [
          patch.lastRepo,
          ...current.recentRepos.filter((repo) => repo.toLowerCase() !== selectedKey),
        ].slice(0, MAX_RECENT_REPOS)
      }
      await this.write(result)
    })
    this.writes = operation.then(() => undefined, () => undefined)
    return operation.then(() => result as PrPreferences)
  }

  private validatePatch(input: unknown): Partial<PrPreferences> {
    if (!isRecord(input)) throw new PrServiceError(400, 'invalid_request', 'Preferences must be an object')
    const patch: Partial<PrPreferences> = {}
    if ('pinnedRepos' in input) {
      const pinned = input.pinnedRepos
      if (!Array.isArray(pinned) || pinned.length > MAX_PINNED_REPOS) {
        throw new PrServiceError(400, 'invalid_request', `pinnedRepos must be a list of at most ${MAX_PINNED_REPOS} repos`)
      }
      patch.pinnedRepos = [...new Set(pinned.map((repo) => validateRepo(repo)))]
    }
    if ('lastRepo' in input) {
      patch.lastRepo = input.lastRepo === null ? null : validateRepo(input.lastRepo)
    }
    if ('lastFilter' in input) patch.lastFilter = validateStateFilter(input.lastFilter)
    if ('lastScope' in input) {
      if (input.lastScope !== 'mine' && input.lastScope !== 'everyone') {
        throw new PrServiceError(400, 'invalid_request', 'lastScope must be "mine" or "everyone"')
      }
      patch.lastScope = input.lastScope
    }
    return patch
  }

  private async load(): Promise<PrPreferences> {
    try {
      const metadata = await lstat(this.path)
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw new Error('PR preferences path must be a regular file')
      }
      return parsePreferences(JSON.parse(await readFile(this.path, 'utf8')) as unknown)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return defaultPreferences()
      throw error
    }
  }

  private async write(preferences: PrPreferences): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    const temporary = `${this.path}.${process.pid}.tmp`
    await writeFile(temporary, `${JSON.stringify(preferences, null, 2)}\n`, { mode: 0o600 })
    await rename(temporary, this.path)
  }
}

type CacheEntry<T> = { at: number; promise: Promise<T> }
type SwrCacheEntry<T> = { at: number; value: T | null; refresh: Promise<T> | null }

export class PrService {
  private readonly runner: GhRunner
  private readonly gitRunner: GitRunner
  private readonly preferences: PrPreferencesStore
  private readonly listTtlMs: number
  private readonly reposTtlMs: number
  private readonly repoContextTtlMs: number
  private readonly now: () => number
  private readonly listCache = new Map<string, SwrCacheEntry<PrList>>()
  private readonly paneListCache = new Map<string, CacheEntry<PanePrList>>()
  private readonly threadsCache = new Map<string, CacheEntry<PrThreads>>()
  private readonly repoContextCache = new Map<string, CacheEntry<string | null>>()
  private suggestionsCache: CacheEntry<string[]> | null = null

  constructor(options?: {
    runner?: GhRunner
    gitRunner?: GitRunner
    preferencesPath?: string
    listTtlMs?: number
    reposTtlMs?: number
    repoContextTtlMs?: number
    now?: () => number
  }) {
    this.runner = options?.runner ?? defaultRunner
    this.gitRunner = options?.gitRunner ?? defaultGitRunner
    this.preferences = new PrPreferencesStore(options?.preferencesPath)
    this.listTtlMs = options?.listTtlMs ?? LIST_CACHE_TTL_MS
    this.reposTtlMs = options?.reposTtlMs ?? REPOS_CACHE_TTL_MS
    this.repoContextTtlMs = options?.repoContextTtlMs ?? REPO_CONTEXT_CACHE_TTL_MS
    this.now = options?.now ?? Date.now
  }

  async listPullRequests(
    repoInput: unknown,
    filterInput: unknown,
    options?: { refresh?: boolean },
  ): Promise<PrList> {
    const repo = validateRepo(repoInput)
    const filter = validateStateFilter(filterInput)
    const key = `${repo}::${filter}`
    const cached = this.listCache.get(key)
    if (cached?.value) {
      if (options?.refresh) {
        return cached.refresh ?? this.refreshPullRequests(key, repo, filter, cached)
      }
      if (this.now() - cached.at >= this.listTtlMs && !cached.refresh) {
        void this.refreshPullRequests(key, repo, filter, cached).catch(() => undefined)
      }
      return cached.value
    }
    if (cached?.refresh) return cached.refresh
    const entry: SwrCacheEntry<PrList> = { at: 0, value: null, refresh: null }
    this.listCache.set(key, entry)
    return this.refreshPullRequests(key, repo, filter, entry)
  }

  async listPanePullRequests(targetIdInput: unknown): Promise<PanePrList> {
    const targetId = validatePaneTargetId(targetIdInput)
    const cached = this.paneListCache.get(targetId)
    if (cached && this.now() - cached.at < this.listTtlMs) return cached.promise
    const promise = this.fetchPanePullRequests(targetId)
    const entry = { at: this.now(), promise }
    this.paneListCache.set(targetId, entry)
    if (this.paneListCache.size > MAX_PANE_LIST_CACHE_ENTRIES) {
      const oldest = [...this.paneListCache.entries()]
        .filter(([key]) => key !== targetId)
        .sort((left, right) => left[1].at - right[1].at)
      for (const [key] of oldest) {
        if (this.paneListCache.size <= MAX_PANE_LIST_CACHE_ENTRIES) break
        this.paneListCache.delete(key)
      }
    }
    promise.catch(() => {
      if (this.paneListCache.get(targetId) === entry) this.paneListCache.delete(targetId)
    })
    return promise
  }

  private async fetchPanePullRequests(targetId: string): Promise<PanePrList> {
    const output = await this.runner([
      'api', 'graphql',
      '-f', `query=${PANE_PULL_REQUESTS_QUERY}`,
      '-f', `targetQuery=${paneTargetSearchQuery(targetId)}`,
    ])
    let payload: unknown
    try {
      payload = JSON.parse(output)
    } catch {
      throw invalidUpstream()
    }
    if (!isRecord(payload)) throw invalidUpstream()
    if (Array.isArray(payload.errors) && payload.errors.length > 0) {
      throw new PrServiceError(502, 'github_failed', 'GitHub returned errors for the pane pull request query')
    }
    const linked = searchConnection(objectField(payload, 'data'), 'linked')
    const pullRequests = linked.nodes
      .map((node) => parsePanePullRequest(node, targetId))
      .filter((pullRequest): pullRequest is PanePrSummary => pullRequest !== null)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    return {
      targetId,
      totalCount: linked.totalCount,
      pullRequests,
      truncated: linked.truncated,
      fetchedAt: this.now(),
    }
  }

  private refreshPullRequests(
    key: string,
    repo: string,
    filter: PrStateFilter,
    entry: SwrCacheEntry<PrList>,
  ): Promise<PrList> {
    const refresh = this.fetchPullRequests(repo, filter)
    entry.refresh = refresh
    void refresh.then(
      (value) => {
        if (this.listCache.get(key) !== entry) return
        entry.value = value
        entry.at = this.now()
        entry.refresh = null
        this.trimListCache()
      },
      () => {
        if (this.listCache.get(key) !== entry) return
        entry.refresh = null
        if (!entry.value) this.listCache.delete(key)
      },
    )
    return refresh
  }

  private trimListCache(): void {
    if (this.listCache.size <= MAX_LIST_CACHE_ENTRIES) return
    const oldest = [...this.listCache.entries()]
      .filter(([, entry]) => !entry.refresh)
      .sort((left, right) => left[1].at - right[1].at)
    for (const [key] of oldest) {
      if (this.listCache.size <= MAX_LIST_CACHE_ENTRIES) break
      this.listCache.delete(key)
    }
  }

  private async fetchPullRequests(repo: string, filter: PrStateFilter): Promise<PrList> {
    const [owner, name] = repo.split('/', 2) as [string, string]
    const output = await this.runner([
      'api', 'graphql',
      '-f', `query=${pullRequestQuery(filter)}`,
      '-f', `owner=${owner}`,
      '-f', `name=${name}`,
      '-f', `authoredQuery=${scopedSearchQuery(repo, 'author', filter)}`,
      '-f', `reviewRequestedQuery=${scopedSearchQuery(repo, 'review-requested', filter)}`,
    ])
    let payload: unknown
    try {
      payload = JSON.parse(output)
    } catch {
      throw invalidUpstream()
    }
    if (!isRecord(payload)) throw invalidUpstream()
    if (Array.isArray(payload.errors) && payload.errors.length > 0) {
      const notFound = payload.errors.some((error) => isRecord(error) && error.type === 'NOT_FOUND')
      if (notFound) throw new PrServiceError(404, 'repo_not_found', `Repository ${repo} was not found`)
      throw new PrServiceError(502, 'github_failed', 'GitHub returned errors for the pull request query')
    }
    const data = objectField(payload, 'data')
    const viewer = requiredString(objectField(data, 'viewer'), 'login')
    const repository = optionalObject(data, 'repository')
    if (!repository) throw new PrServiceError(404, 'repo_not_found', `Repository ${repo} was not found`)
    const connection = objectField(repository, 'pullRequests')
    const totalCount = requiredNumber(connection, 'totalCount')
    const authored = searchConnection(data, 'authored')
    const reviewRequested = searchConnection(data, 'reviewRequested')
    const byNumber = new Map<number, PrSummary>()
    for (const node of [...nodes(repository, 'pullRequests'), ...authored.nodes, ...reviewRequested.nodes]) {
      const pullRequest = parsePullRequest(node, viewer)
      if (!byNumber.has(pullRequest.number)) byNumber.set(pullRequest.number, pullRequest)
    }
    const pullRequests = [...byNumber.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    return {
      repo,
      filter,
      viewer,
      totalCount,
      pullRequests,
      truncated: totalCount > pullRequests.length,
      mineTruncated: authored.truncated || reviewRequested.truncated,
      fetchedAt: this.now(),
    }
  }

  async listUnresolvedThreads(repoInput: unknown, numberInput: unknown): Promise<PrThreads> {
    const repo = validateRepo(repoInput)
    const number = validatePrNumber(numberInput)
    const key = `${repo}#${number}`
    const cached = this.threadsCache.get(key)
    if (cached && this.now() - cached.at < this.listTtlMs) return cached.promise
    const promise = this.fetchUnresolvedThreads(repo, number)
    const entry = { at: this.now(), promise }
    this.threadsCache.set(key, entry)
    promise.catch(() => {
      if (this.threadsCache.get(key) === entry) this.threadsCache.delete(key)
    })
    return promise
  }

  private async fetchUnresolvedThreads(repo: string, number: number): Promise<PrThreads> {
    const [owner, name] = repo.split('/', 2) as [string, string]
    const output = await this.runner([
      'api', 'graphql',
      '-f', `query=${THREADS_QUERY}`,
      '-f', `owner=${owner}`,
      '-f', `name=${name}`,
      '-F', `number=${number}`,
    ])
    let payload: unknown
    try {
      payload = JSON.parse(output)
    } catch {
      throw invalidUpstream()
    }
    if (!isRecord(payload)) throw invalidUpstream()
    const data = objectField(payload, 'data')
    const repository = optionalObject(data, 'repository')
    const pullRequest = repository ? optionalObject(repository, 'pullRequest') : null
    if (!pullRequest) throw new PrServiceError(404, 'pr_not_found', `Pull request ${repo}#${number} was not found`)
    const connection = objectField(pullRequest, 'reviewThreads')
    const threadNodes = nodes(pullRequest, 'reviewThreads')
    const totalCount = typeof connection.totalCount === 'number' ? connection.totalCount : threadNodes.length
    const threads: PrThreadExcerpt[] = []
    for (const thread of threadNodes) {
      if (thread.isResolved !== false) continue
      const comment = nodes(thread, 'comments')[0] ?? null
      const commentAuthor = comment ? optionalObject(comment, 'author') : null
      const body = comment && typeof comment.body === 'string' ? comment.body : ''
      threads.push({
        path: typeof thread.path === 'string' ? thread.path : null,
        author: commentAuthor && typeof commentAuthor.login === 'string' ? commentAuthor.login : null,
        excerpt: body.replace(/\s+/g, ' ').trim().slice(0, THREAD_EXCERPT_CHARS),
      })
    }
    return {
      repo,
      number,
      threads,
      truncated: totalCount > threadNodes.length,
      fetchedAt: this.now(),
    }
  }

  async listRepos(): Promise<PrRepoOption[]> {
    const preferences = await this.preferences.read()
    const pinned = preferences.pinnedRepos
    const recent = preferences.lastRepo
      ? [preferences.lastRepo, ...preferences.recentRepos]
      : preferences.recentRepos
    let suggested: string[] = []
    try {
      suggested = await this.suggestedRepos()
    } catch {
      // Suggestions are best-effort; auth problems surface on the PR list call instead.
    }
    // GitHub repo names are case-insensitive; search returns canonical casing while
    // pins keep whatever the user typed, so dedupe on the lowercased name.
    const seen = new Set(pinned.map((nameWithOwner) => nameWithOwner.toLowerCase()))
    const options: PrRepoOption[] = pinned.map((nameWithOwner) => ({ nameWithOwner, pinned: true }))
    for (const nameWithOwner of [...recent, ...suggested]) {
      const key = nameWithOwner.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      options.push({ nameWithOwner, pinned: false })
    }
    return options
  }

  repoForPath(pathInput: unknown): Promise<string | null> {
    if (typeof pathInput !== 'string' || !pathInput.startsWith('/')) return Promise.resolve(null)
    const cached = this.repoContextCache.get(pathInput)
    if (cached && this.now() - cached.at < this.repoContextTtlMs) return cached.promise
    const promise = this.resolveRepoForPath(pathInput)
    const entry = { at: this.now(), promise }
    this.repoContextCache.set(pathInput, entry)
    promise.catch(() => {
      if (this.repoContextCache.get(pathInput) === entry) this.repoContextCache.delete(pathInput)
    })
    return promise
  }

  private async resolveRepoForPath(path: string): Promise<string | null> {
    try {
      const root = (await this.gitRunner(['rev-parse', '--show-toplevel'], path)).trim()
      if (!root.startsWith('/')) return null
      const branch = (await this.gitRunner(['rev-parse', '--abbrev-ref', 'HEAD'], root)).trim()
      if (!branch || branch === 'HEAD') return null
      const remote = (await this.gitRunner([
        'for-each-ref',
        '--format=%(upstream:remotename)',
        `refs/heads/${branch}`,
      ], root)).trim()
      if (!remote || remote === '.') return null
      const remoteUrl = await this.gitRunner(['remote', 'get-url', remote], root)
      return repoFromGithubRemote(remoteUrl)
    } catch {
      return null
    }
  }

  private suggestedRepos(): Promise<string[]> {
    if (this.suggestionsCache && this.now() - this.suggestionsCache.at < this.reposTtlMs) {
      return this.suggestionsCache.promise
    }
    const promise = this.fetchSuggestedRepos()
    const entry = { at: this.now(), promise }
    this.suggestionsCache = entry
    promise.catch(() => {
      if (this.suggestionsCache === entry) this.suggestionsCache = null
    })
    return promise
  }

  private async fetchSuggestedRepos(): Promise<string[]> {
    const output = await this.runner([
      'search', 'prs', '--author=@me', '--sort=updated', '--order=desc', '--limit', '50', '--json', 'repository',
    ])
    let payload: unknown
    try {
      payload = JSON.parse(output)
    } catch {
      throw invalidUpstream()
    }
    if (!Array.isArray(payload)) throw invalidUpstream()
    const repos: string[] = []
    for (const entry of payload) {
      if (!isRecord(entry)) continue
      const repository = optionalObject(entry, 'repository')
      const nameWithOwner = repository && typeof repository.nameWithOwner === 'string' ? repository.nameWithOwner : null
      if (nameWithOwner && REPO_PATTERN.test(nameWithOwner) && !repos.includes(nameWithOwner)) {
        repos.push(nameWithOwner)
      }
    }
    return repos
  }

  getPreferences(): Promise<PrPreferences> {
    return this.preferences.read()
  }

  updatePreferences(input: unknown): Promise<PrPreferences> {
    return this.preferences.update(input)
  }
}
