import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { prMergeDisabledReason } from '../shared/pr-merge.js'
import { PrConflictInspector } from './pr-conflicts.js'
import { PrEntities } from '../shared/pr-entities.js'
import type { PrStateFilter, PrScope, PrCheckState, PrCheckRun, PrChecks, PrReview, PrSummary, PrList, PrStatus, PanePrSummary, PanePrList } from '../shared/pr-types.js'
export type { PrStateFilter, PrScope, PrCheckState, PrCheckRun, PrChecks, PrReview, PrSummary, PrList, PrStatus, PanePrSummary, PanePrList } from '../shared/pr-types.js'
import {
  isCommandoTargetId,
  parseCommandoPrMarker,
  stripCommandoPrMarkers,
} from '../shared/pane-target.js'

const COMMAND_TIMEOUT_MS = 20_000
const COMMAND_BUFFER_BYTES = 4 * 1024 * 1024
const GIT_COMMAND_TIMEOUT_MS = 5_000
const GIT_COMMAND_BUFFER_BYTES = 64 * 1024
const LIST_CACHE_TTL_MS = 20_000
const REPOS_CACHE_TTL_MS = 5 * 60_000
const REPO_CONTEXT_CACHE_TTL_MS = 5_000
const PULL_REQUEST_PAGE_SIZE = 30
const PULL_REQUEST_DETAIL_BATCH_SIZE = 5
const BODY_EXCERPT_CHARS = 280
const THREAD_PAGE_SIZE = 50
const THREAD_EXCERPT_CHARS = 140
const PANE_PULL_REQUEST_PAGE_SIZE = 100
// Polling shares the gh user's GraphQL budget with agents and scripts, so it
// stops early to leave them headroom and backs off when GitHub pushes back.
const LOW_RATE_LIMIT_POINTS = 500
const RATE_LIMIT_BACKOFF_MS = 60_000
const MAX_RATE_LIMIT_BACKOFF_MS = 15 * 60_000
const RATE_LIMIT_FIELD = 'rateLimit { remaining resetAt }'

const PR_STATUS_FIELDS = `
  additions deletions reviewDecision mergeable
  reviewThreads(first: 50) { totalCount nodes { isResolved comments { totalCount } } }
  commits(last: 1) { totalCount nodes { commit { statusCheckRollup {
    state
    contexts(first: 50) {
      totalCount
      nodes { __typename ... on CheckRun { name status conclusion } ... on StatusContext { context state } }
    }
  } } } }
`

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
const REVIEW_THREAD_FIELDS = 'id isResolved viewerCanReply viewerCanResolve viewerCanUnresolve comments(first: 1) { nodes { databaseId } }'
const REVIEW_THREADS_QUERY = `query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes { ${REVIEW_THREAD_FIELDS} }
      }
    }
  }
}`
const PANE_PULL_REQUESTS_QUERY = `
query($targetQuery: String!) {
  viewer { login }
  ${RATE_LIMIT_FIELD}
  linked: search(query: $targetQuery, type: ISSUE, first: ${PANE_PULL_REQUEST_PAGE_SIZE}) {
    issueCount
    nodes {
      ... on PullRequest {
        number title url state isDraft body createdAt updatedAt
        author { login }
        changedFiles headRefName baseRefName headRefOid baseRefOid mergeStateStatus
        reviewRequests(first: 20) { nodes { requestedReviewer { __typename ... on User { login } } } }
        latestReviews(first: 10) { nodes { author { login } state } }
        ${PR_STATUS_FIELDS}
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
    readonly retryAt?: number,
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
  if (/rate limit|abuse detection|HTTP 429/i.test(stderr)) {
    return new PrServiceError(429, 'rate_limited', 'GitHub rate limit reached')
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

function rateLimited(retryAt: number): PrServiceError {
  const time = new Date(retryAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return new PrServiceError(429, 'rate_limited', `GitHub rate limit is low — PR sync resumes at ${time}`, retryAt)
}

function invalidUpstream(): PrServiceError {
  return new PrServiceError(502, 'github_invalid_response', 'GitHub returned an invalid response')
}

function parseGhObject(output: string): JsonRecord {
  let value: unknown
  try { value = JSON.parse(output) } catch { throw invalidUpstream() }
  if (!isRecord(value)) throw invalidUpstream()
  return value
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
function pullRequestQuery(filter: PrStateFilter, scope: PrScope): string {
  return `
query($owner: String!, $name: String!, $authoredQuery: String!, $reviewRequestedQuery: String!) {
  ${RATE_LIMIT_FIELD}
  viewer { login }
  repository(owner: $owner, name: $name) {
    pullRequests(first: ${PULL_REQUEST_PAGE_SIZE}, ${statesArgument(filter)}orderBy: {field: UPDATED_AT, direction: DESC}) {
      totalCount
      ${scope === 'everyone' ? 'nodes { ...PrFields }' : ''}
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
${PR_DETAIL_FRAGMENT}`.trim()
}

const PR_DETAIL_FRAGMENT = `fragment PrFields on PullRequest {
  number title url state isDraft body
  author { login }
  changedFiles
  createdAt updatedAt headRefName baseRefName headRefOid baseRefOid mergeStateStatus
  ${PR_STATUS_FIELDS}
  reviewRequests(first: 20) { nodes { requestedReviewer { __typename ... on User { login } } } }
  latestReviews(first: 10) { nodes { author { login } state } }
}`.trim()

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

function parsePanePullRequest(node: JsonRecord, targetId: string, viewer: string): PanePrSummary | null {
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
    ...(typeof node.headRefOid === 'string' ? { preview: parsePullRequest(node, viewer) } : {}),
    ...parsePrStatus(node),
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
  const truncated = totalCount > contextNodes.length

  const state: PrCheckState = failed > 0 ? 'fail' : pending > 0 ? 'pending' : 'pass'

  return { state, runs, failed, pending, total: runs.length, truncated }
}

function parseReviewDecision(value: unknown): PrSummary['reviewDecision'] {
  if (value === 'APPROVED') return 'approved'
  if (value === 'CHANGES_REQUESTED') return 'changes_requested'
  if (value === 'REVIEW_REQUIRED') return 'review_required'
  return null
}

function parsePrStatus(node: JsonRecord): PrStatus {
  const threads = objectField(node, 'reviewThreads')
  const threadNodes = nodes(node, 'reviewThreads')
  const threadTotal = typeof threads.totalCount === 'number' ? threads.totalCount : threadNodes.length
  const unresolved = threadNodes.filter((thread) => thread.isResolved === false)
  const commitNodes = nodes(node, 'commits')
  const commit = commitNodes[0] ? optionalObject(commitNodes[0], 'commit') : null
  return {
    additions: requiredNumber(node, 'additions'),
    deletions: requiredNumber(node, 'deletions'),
    unresolvedThreads: unresolved.length,
    unansweredThreads: unresolved.filter((thread) => {
      const comments = optionalObject(thread, 'comments')
      // The original comment is included; any subsequent comment is a reply.
      return typeof comments?.totalCount !== 'number' || comments.totalCount <= 1
    }).length,
    threadsTruncated: threadTotal > threadNodes.length,
    reviewDecision: parseReviewDecision(node.reviewDecision),
    conflicting: node.mergeable === 'CONFLICTING',
    checks: parseChecks(commit),
  }
}

function parsePullRequest(node: JsonRecord, viewer: string): PrSummary {
  const stateValue = requiredString(node, 'state')
  const state = stateValue === 'OPEN' ? 'open' : stateValue === 'MERGED' ? 'merged' : 'closed'
  const author = optionalObject(node, 'author')
  const authorLogin = author && typeof author.login === 'string' ? author.login : null

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
  const body = typeof node.body === 'string' ? node.body : ''

  return {
    number: requiredNumber(node, 'number'),
    title: requiredString(node, 'title'),
    url: requiredString(node, 'url'),
    state,
    isDraft: requiredBoolean(node, 'isDraft'),
    author: authorLogin,
    bodyExcerpt: stripCommandoPrMarkers(body).trim().slice(0, BODY_EXCERPT_CHARS),
    ...parsePrStatus(node),
    changedFiles: requiredNumber(node, 'changedFiles'),
    commitCount: typeof commitsConnection.totalCount === 'number' ? commitsConnection.totalCount : 0,
    reviews,
    requestedReviewers,
    mergeable: typeof node.mergeable === 'string' ? node.mergeable : 'UNKNOWN',
    mergeStateStatus: typeof node.mergeStateStatus === 'string' ? node.mergeStateStatus : 'UNKNOWN',
    createdAt: typeof node.createdAt === 'string' ? node.createdAt : '',
    updatedAt: requiredString(node, 'updatedAt'),
    headRefName: requiredString(node, 'headRefName'),
    baseRefName: typeof node.baseRefName === 'string' ? node.baseRefName : '',
    headRefOid: requiredString(node, 'headRefOid'),
    baseRefOid: requiredString(node, 'baseRefOid'),
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
  private readonly entities = new PrEntities()
  private readonly conflictInspector = new PrConflictInspector()
  private readonly merging = new Set<string>()
  private readonly runner: GhRunner
  private readonly gitRunner: GitRunner
  private readonly preferences: PrPreferencesStore
  private readonly listTtlMs: number
  private readonly reposTtlMs: number
  private readonly repoContextTtlMs: number
  private readonly now: () => number
  private readonly listCache = new Map<string, SwrCacheEntry<PrList>>()
  private readonly batchedRepos = new Set<string>()
  private readonly paneListCache = new Map<string, SwrCacheEntry<PanePrList>>()
  private readonly threadsCache = new Map<string, CacheEntry<PrThreads>>()
  private readonly repoContextCache = new Map<string, CacheEntry<string | null>>()
  private suggestionsCache: CacheEntry<string[]> | null = null
  private pausedUntil = 0
  private backoffMs = 0

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

  async mergePullRequest(repoInput: unknown, numberInput: unknown, headInput: unknown, baseInput?: unknown): Promise<{ merged: true }> {
    const repo = validateRepo(repoInput)
    const number = validatePrNumber(numberInput)
    if (typeof headInput !== 'string' || !/^[a-f0-9]{40}$/i.test(headInput)) {
      throw new PrServiceError(400, 'invalid_request', 'A valid PR head commit is required')
    }
    if (baseInput !== undefined && (typeof baseInput !== 'string' || !baseInput || baseInput.length > 1024)) throw new PrServiceError(400, 'invalid_request', 'A valid merge target is required')
    const key = `${repo.toLowerCase()}::${number}`
    if (this.merging.has(key)) throw new PrServiceError(409, 'merge_in_progress', 'This pull request is already being merged')
    this.merging.add(key)
    let merged = false
    try {
      const current = parseGhObject(await this.runner([
        'pr', 'view', String(number), '--repo', repo,
        '--json', `state,isDraft,mergeable,mergeStateStatus,headRefOid${baseInput !== undefined ? ',baseRefName' : ''}`,
      ]))
      const reason = prMergeDisabledReason({
        state: typeof current.state === 'string' ? current.state : '',
        isDraft: current.isDraft !== false,
        mergeable: typeof current.mergeable === 'string' ? current.mergeable : undefined,
        mergeStateStatus: typeof current.mergeStateStatus === 'string' ? current.mergeStateStatus : undefined,
      })
      if (reason) throw new PrServiceError(409, 'not_mergeable', reason)
      if (current.headRefOid !== headInput) throw new PrServiceError(409, 'head_changed', 'The PR has new commits. Resync and try again.')
      if (baseInput !== undefined && current.baseRefName !== baseInput) throw new PrServiceError(409, 'target_changed', 'The PR merge target changed. Resync and review the new target before merging.')
      const settings = parseGhObject(await this.runner(['api', `repos/${repo}`]))
      const method = settings.allow_merge_commit === true ? 'merge'
        : settings.allow_squash_merge === true ? 'squash'
        : settings.allow_rebase_merge === true ? 'rebase' : null
      if (!method) throw new PrServiceError(409, 'not_mergeable', 'No merge method is enabled for this repository')
      const result = parseGhObject(await this.runner([
        'api', '--method', 'PUT', `repos/${repo}/pulls/${number}/merge`,
        '-f', `sha=${headInput}`, '-f', `merge_method=${method}`,
      ]))
      if (result.merged !== true) throw new PrServiceError(409, 'merge_failed', typeof result.message === 'string' ? result.message : 'GitHub did not merge this pull request')
      merged = true
      return { merged: true }
    } finally {
      this.merging.delete(key)
      this.entities.invalidate(repo)
      if (merged) this.entities.markMerged(repo, number, this.now())
      // A failed/ambiguous write can still have changed GitHub state.
      for (const cacheKey of this.listCache.keys()) {
        if (cacheKey.toLowerCase().startsWith(`${repo.toLowerCase()}::`)) this.listCache.delete(cacheKey)
      }
      this.paneListCache.clear()
    }
  }

  // Every polled GitHub read goes through here; user actions such as merge do not.
  private async ghRead(args: string[]): Promise<string> {
    if (this.now() < this.pausedUntil) throw rateLimited(this.pausedUntil)
    let output: string
    try {
      output = await this.runner(args)
    } catch (error) {
      if (error instanceof PrServiceError && error.code === 'rate_limited') throw this.backOff()
      throw error
    }
    let payload: unknown
    try {
      payload = JSON.parse(output)
    } catch {
      return output
    }
    if (!isRecord(payload)) return output
    if (Array.isArray(payload.errors) && payload.errors.some((error) => isRecord(error) && error.type === 'RATE_LIMITED')) {
      throw this.backOff()
    }
    this.backoffMs = 0
    const rateLimit = isRecord(payload.data) && isRecord(payload.data.rateLimit) ? payload.data.rateLimit : null
    if (rateLimit && typeof rateLimit.remaining === 'number' && rateLimit.remaining < LOW_RATE_LIMIT_POINTS) {
      const resetAt = typeof rateLimit.resetAt === 'string' ? Date.parse(rateLimit.resetAt) : NaN
      if (Number.isFinite(resetAt)) this.pausedUntil = Math.max(this.pausedUntil, resetAt)
    }
    return output
  }

  private backOff(): PrServiceError {
    this.backoffMs = Math.min(Math.max(this.backoffMs * 2, RATE_LIMIT_BACKOFF_MS), MAX_RATE_LIMIT_BACKOFF_MS)
    this.pausedUntil = Math.max(this.pausedUntil, this.now() + this.backoffMs)
    return rateLimited(this.pausedUntil)
  }

  async listPullRequests(
    repoInput: unknown,
    filterInput: unknown,
    options?: { refresh?: boolean; scope?: PrScope },
  ): Promise<PrList> {
    const repo = validateRepo(repoInput)
    const filter = validateStateFilter(filterInput)
    const scope = options?.scope ?? 'everyone'
    if (scope !== 'mine' && scope !== 'everyone') throw new PrServiceError(400, 'invalid_request', 'scope must be "mine" or "everyone"')
    const key = `${repo.toLowerCase()}::${filter}::${scope}`
    const cached = this.listCache.get(key)
    if (cached?.value) {
      if (options?.refresh) {
        return this.entities.repo(await (cached.refresh ?? this.refreshPullRequests(key, repo, filter, scope, cached)))
      }
      if (this.now() - cached.at >= this.listTtlMs && !cached.refresh) {
        void this.refreshPullRequests(key, repo, filter, scope, cached).catch(() => undefined)
      }
      return this.entities.repo(cached.value)
    }
    if (cached?.refresh) return this.entities.repo(await cached.refresh)
    const entry: SwrCacheEntry<PrList> = { at: 0, value: null, refresh: null }
    this.listCache.set(key, entry)
    return this.entities.repo(await this.refreshPullRequests(key, repo, filter, scope, entry))
  }

  async listPanePullRequests(targetIdInput: unknown, options: { refresh?: boolean } = {}): Promise<PanePrList> {
    const targetId = validatePaneTargetId(targetIdInput)
    const cached = this.paneListCache.get(targetId)
    if (cached?.refresh) return this.entities.pane(await cached.refresh)
    if (!options.refresh && cached?.value && this.now() - cached.at < this.listTtlMs) return this.entities.pane(cached.value)
    const promise = this.fetchPanePullRequests(targetId)
    const entry: SwrCacheEntry<PanePrList> = { at: this.now(), value: cached?.value ?? null, refresh: promise }
    this.paneListCache.set(targetId, entry)
    this.trimPaneListCache()
    try {
      const value = await promise
      entry.value = value
      entry.at = this.now()
      return this.entities.pane(value)
    } catch (error) {
      if (this.paneListCache.get(targetId) === entry && !entry.value) this.paneListCache.delete(targetId)
      throw error
    } finally {
      entry.refresh = null
      if (this.paneListCache.get(targetId) === entry) this.trimPaneListCache()
    }
  }

  private async fetchPanePullRequests(targetId: string): Promise<PanePrList> {
    const order = this.entities.beginRead()
    const fetchedAt = this.now()
    const output = await this.ghRead([
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
    const data = objectField(payload, 'data')
    const viewer = optionalObject(data, 'viewer')
    const linked = searchConnection(data, 'linked')
    const pullRequests = linked.nodes
      .map((node) => parsePanePullRequest(node, targetId, typeof viewer?.login === 'string' ? viewer.login : ''))
      .filter((pullRequest): pullRequest is PanePrSummary => pullRequest !== null)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    const list: PanePrList = {
      targetId,
      totalCount: linked.totalCount,
      pullRequests,
      truncated: linked.truncated,
      fetchedAt,
    }
    this.entities.ingest(list, order)
    return list
  }

  private refreshPullRequests(
    key: string,
    repo: string,
    filter: PrStateFilter,
    scope: PrScope,
    entry: SwrCacheEntry<PrList>,
  ): Promise<PrList> {
    const refresh = this.fetchPullRequests(repo, filter, scope)
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
    const oldest = [...this.listCache.entries()]
      .filter(([, entry]) => !entry.refresh)
      .sort((left, right) => left[1].at - right[1].at)
    for (const [key] of oldest) {
      if (this.listCache.size <= MAX_LIST_CACHE_ENTRIES) break
      this.listCache.delete(key)
    }
    this.retainEntities()
  }

  private retainEntities(): void {
    const entries = [...this.listCache.values(), ...this.paneListCache.values()]
    if (entries.some((entry) => entry.refresh)) return
    this.entities.retain(entries
      .flatMap((entry) => entry.value ? [entry.value] : []))
  }

  private trimPaneListCache(): void {
    const oldest = [...this.paneListCache.entries()]
      .filter(([, entry]) => !entry.refresh)
      .sort((left, right) => left[1].at - right[1].at)
    for (const [key] of oldest) {
      if (this.paneListCache.size <= MAX_PANE_LIST_CACHE_ENTRIES) break
      this.paneListCache.delete(key)
    }
    this.retainEntities()
  }

  private async fetchPullRequests(repo: string, filter: PrStateFilter, scope: PrScope): Promise<PrList> {
    const order = this.entities.beginRead()
    const fetchedAt = this.now()
    const [owner, name] = repo.split('/', 2) as [string, string]
    const args = [
      'api', 'graphql',
      '-f', `query=${pullRequestQuery(filter, scope)}`,
      '-f', `owner=${owner}`,
      '-f', `name=${name}`,
      '-f', `authoredQuery=${scopedSearchQuery(repo, 'author', filter)}`,
      '-f', `reviewRequestedQuery=${scopedSearchQuery(repo, 'review-requested', filter)}`,
    ]
    let output: string
    const batchKey = `${repo.toLowerCase()}::${scope}`
    if (this.batchedRepos.has(batchKey)) {
      output = await this.fetchBatchedPullRequests(args)
    } else {
      try {
        output = await this.ghRead(args)
      } catch (error) {
        if (!(error instanceof PrServiceError)
          || !(/HTTP 50[24]/.test(error.message) || error.code === 'github_timeout')) throw error
        // GitHub can time out resolving details for busy repositories. Discover
        // the same full pages cheaply, then hydrate unique PRs in small batches.
        output = await this.fetchBatchedPullRequests(args)
        this.batchedRepos.add(batchKey)
        if (this.batchedRepos.size > MAX_LIST_CACHE_ENTRIES) this.batchedRepos.delete(this.batchedRepos.values().next().value!)
      }
    }
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
    const requestedNumbers = new Set(reviewRequested.nodes.map((node) => requiredNumber(node, 'number')))
    const byNumber = new Map<number, PrSummary>()
    for (const node of [...(scope === 'everyone' ? nodes(repository, 'pullRequests') : []), ...authored.nodes, ...reviewRequested.nodes]) {
      const pullRequest = parsePullRequest(node, viewer)
      // Search also includes team review requests, which the User-only
      // reviewRequests fragment cannot identify as belonging to the viewer.
      if (requestedNumbers.has(pullRequest.number)) pullRequest.viewerReviewRequested = true
      if (!byNumber.has(pullRequest.number)) byNumber.set(pullRequest.number, pullRequest)
    }
    const pullRequests = [...byNumber.values()].sort((a, b) => b.number - a.number)
    const list: PrList = {
      repo,
      filter,
      viewer,
      totalCount,
      pullRequests,
      truncated: totalCount > pullRequests.length,
      mineTruncated: authored.truncated || reviewRequested.truncated,
      fetchedAt,
    }
    this.entities.ingest(list, order)
    return list
  }

  private async fetchBatchedPullRequests(args: string[]): Promise<string> {
    const discoveryArgs = args.map((arg) => arg.startsWith('query=')
      ? arg.replace(PR_DETAIL_FRAGMENT, 'fragment PrFields on PullRequest { id }')
      : arg)
    const payload = parseGhObject(await this.ghRead(discoveryArgs))
    if (Array.isArray(payload.errors) && payload.errors.length > 0) return JSON.stringify(payload)
    const data = objectField(payload, 'data')
    const repository = optionalObject(data, 'repository')
    if (!repository) return JSON.stringify(payload)
    const connections = [objectField(repository, 'pullRequests'), objectField(data, 'authored'), objectField(data, 'reviewRequested')]
      .filter((connection) => connection.nodes !== undefined)
    const ids = [...new Set(connections.flatMap((connection) => {
      if (!Array.isArray(connection.nodes)) throw invalidUpstream()
      return connection.nodes.filter(isRecord).map((node) => requiredString(node, 'id'))
    }))]
    const details = new Map<string, JsonRecord>()
    // Bound concurrency as well as query size to avoid amplifying upstream load.
    let next = 0
    await Promise.all(Array.from({ length: Math.min(3, Math.ceil(ids.length / PULL_REQUEST_DETAIL_BATCH_SIZE)) }, async () => {
      while (next < ids.length) {
        const batch = ids.slice(next, next += PULL_REQUEST_DETAIL_BATCH_SIZE)
        const result = parseGhObject(await this.ghRead([
          'api', 'graphql',
          '-f', `query=query { ${RATE_LIMIT_FIELD} nodes(ids: ${JSON.stringify(batch)}) { ... on PullRequest { id ...PrFields } } }\n${PR_DETAIL_FRAGMENT}`,
        ]))
        if (Array.isArray(result.errors) && result.errors.length > 0) {
          throw new PrServiceError(502, 'github_failed', 'GitHub returned errors for the pull request detail query')
        }
        const records = objectField(result, 'data').nodes
        if (!Array.isArray(records)) throw invalidUpstream()
        for (const node of records) {
          if (!isRecord(node)) throw invalidUpstream()
          details.set(requiredString(node, 'id'), node)
        }
      }
    }))
    for (const connection of connections) {
      connection.nodes = (connection.nodes as JsonRecord[]).map((node) => {
        const detail = details.get(requiredString(node, 'id'))
        if (!detail) throw invalidUpstream()
        return detail
      })
    }
    return JSON.stringify(payload)
  }

  async pullRequestDetails(repoInput: unknown, numberInput: unknown): Promise<import('../shared/pr-quick-look.js').PrDetails> {
    const repo = validateRepo(repoInput)
    const number = validatePrNumber(numberInput)
    const root = `repos/${repo}`
    const [reviewThreads, prOutput, ...pages] = await Promise.all([
      this.pullRequestReviewThreads(repo, number),
      this.ghRead(['api', `${root}/pulls/${number}`]),
      ...[`issues/${number}/comments`, `pulls/${number}/reviews`, `pulls/${number}/comments`].map((path) =>
        this.ghRead(['api', `${root}/${path}?per_page=100`, '--paginate', '--slurp'])),
    ])
    const pr = parseGhObject(prOutput)
    const head = requiredString(objectField(pr, 'head'), 'sha')
    if (!/^[a-f0-9]{40}$/i.test(head)) throw invalidUpstream()
    const checkOutputs = await Promise.all([
      this.ghRead(['api', `${root}/commits/${head}/check-runs?per_page=100`, '--paginate', '--slurp']),
      this.ghRead(['api', `${root}/commits/${head}/statuses?per_page=100`, '--paginate', '--slurp']),
    ])
    const checkPages: unknown = JSON.parse(checkOutputs[0])
    const statusPages: unknown = JSON.parse(checkOutputs[1])
    if (!Array.isArray(checkPages) || !Array.isArray(statusPages) || !statusPages.every(Array.isArray)) throw invalidUpstream()
    const checks: import('../shared/pr-quick-look.js').PrDetails['checks'] = []
    const seen = new Set<string>()
    const runs = checkPages.flatMap((page: unknown) => {
      if (!isRecord(page) || !Array.isArray(page.check_runs)) throw invalidUpstream()
      return page.check_runs
    }).sort((a: JsonRecord, b: JsonRecord) => Number(b.id) - Number(a.id))
    for (const run of runs) {
      if (!isRecord(run)) throw invalidUpstream()
      const name = requiredString(run, 'name')
      const key = `${name}:${isRecord(run.app) ? run.app.id : ''}`
      if (seen.has(key)) continue
      seen.add(key)
      checks.push({ name, state: run.status !== 'completed' ? 'pending' : ['success', 'neutral', 'skipped'].includes(String(run.conclusion)) ? 'pass' : 'fail', url: typeof run.html_url === 'string' ? run.html_url : '' })
    }
    for (const status of statusPages.flat()) {
      if (!isRecord(status)) throw invalidUpstream()
      const name = requiredString(status, 'context')
      if (seen.has(`status:${name}`)) continue
      seen.add(`status:${name}`)
      checks.push({ name, state: status.state === 'pending' ? 'pending' : status.state === 'success' ? 'pass' : 'fail', url: typeof status.target_url === 'string' ? status.target_url : '' })
    }
    const conversation: import('../shared/pr-quick-look.js').PrConversationEntry[] = []
    pages.forEach((output, kind) => {
      const parsed: unknown = JSON.parse(output)
      if (!Array.isArray(parsed) || !parsed.every(Array.isArray)) throw invalidUpstream()
      for (const entry of parsed.flat()) {
        if (!isRecord(entry)) throw invalidUpstream()
        const user = optionalObject(entry, 'user')
        conversation.push({
          id: `${kind}:${entry.id}`,
          author: typeof user?.login === 'string' ? user.login : 'someone',
          body: typeof entry.body === 'string' ? stripCommandoPrMarkers(entry.body) : '',
          url: typeof entry.html_url === 'string' ? entry.html_url : '',
          createdAt: typeof entry.submitted_at === 'string' ? entry.submitted_at : typeof entry.created_at === 'string' ? entry.created_at : '',
          kind: kind === 1 && typeof entry.state === 'string' ? entry.state.toLowerCase().replaceAll('_', ' ') : kind === 2 ? 'inline comment' : 'comment',
          ...(typeof entry.path === 'string' ? { path: entry.path } : {}),
          ...(typeof entry.line === 'number' ? { line: entry.line } : {}),
          ...(typeof entry.in_reply_to_id === 'number' ? { replyTo: entry.in_reply_to_id } : {}),
          ...(kind === 2 && typeof entry.id === 'number' ? { commentId: entry.id } : {}),
          ...(kind === 2 && reviewThreads.has(Number(entry.id)) ? { thread: reviewThreads.get(Number(entry.id)) } : {}),
          ...(kind === 1 && typeof entry.id === 'number' ? { reviewId: entry.id }
            : kind === 2 && typeof entry.pull_request_review_id === 'number' ? { reviewId: entry.pull_request_review_id } : {}),
        })
      }
    })
    conversation.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    const base = optionalObject(pr, 'base')
    return { body: typeof pr.body === 'string' ? stripCommandoPrMarkers(pr.body) : '', conversation, checks, headOid: head,
      unresolvedThreads: [...reviewThreads.values()].filter((thread) => !thread.isResolved).length,
      ...(base && typeof base.ref === 'string' && typeof base.sha === 'string' ? { mergeTarget: { branch: base.ref, oid: base.sha } } : {}) }
  }

  private async pullRequestReviewThreads(repo: string, number: number): Promise<Map<number, import('../shared/pr-quick-look.js').PrReviewThread>> {
    const [owner, name] = repo.split('/')
    const result = new Map<number, import('../shared/pr-quick-look.js').PrReviewThread>()
    let cursor: string | undefined
    const seen = new Set<string>()
    do {
      const payload = parseGhObject(await this.ghRead([
        'api', 'graphql', '-f', `query=${REVIEW_THREADS_QUERY}`,
        '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `number=${number}`,
        ...(cursor ? ['-f', `cursor=${cursor}`] : []),
      ]))
      const data = this.graphqlData(payload)
      const repository = optionalObject(data, 'repository')
      const pr = repository && optionalObject(repository, 'pullRequest')
      if (!pr) throw new PrServiceError(404, 'pr_not_found', 'Pull request was not found')
      const connection = objectField(pr, 'reviewThreads')
      for (const node of nodes(pr, 'reviewThreads')) {
        const root = nodes(node, 'comments')[0]
        if (!root) continue
        const thread = {
          id: requiredString(node, 'id'), commentId: requiredNumber(root, 'databaseId'),
          isResolved: requiredBoolean(node, 'isResolved'), viewerCanReply: requiredBoolean(node, 'viewerCanReply'),
          viewerCanResolve: requiredBoolean(node, 'viewerCanResolve'), viewerCanUnresolve: requiredBoolean(node, 'viewerCanUnresolve'),
        }
        result.set(thread.commentId, thread)
      }
      const page = objectField(connection, 'pageInfo')
      if (!requiredBoolean(page, 'hasNextPage')) break
      cursor = requiredString(page, 'endCursor')
      if (!cursor || seen.has(cursor)) throw invalidUpstream()
      seen.add(cursor)
    } while (cursor)
    return result
  }

  private graphqlData(payload: JsonRecord): JsonRecord {
    if (Array.isArray(payload.errors) && payload.errors.length) {
      const message = payload.errors.find((error) => isRecord(error) && typeof error.message === 'string')
      throw new PrServiceError(502, 'github_failed', isRecord(message) ? String(message.message) : 'GitHub returned errors for the review thread request')
    }
    return objectField(payload, 'data')
  }

  async actOnReviewThread(repoInput: unknown, numberInput: unknown, threadInput: unknown, actionInput: unknown, bodyInput?: unknown): Promise<{ ok: true }> {
    const repo = validateRepo(repoInput)
    const number = validatePrNumber(numberInput)
    if (typeof threadInput !== 'string' || !/^[A-Za-z0-9_=-]{1,256}$/.test(threadInput)) {
      throw new PrServiceError(400, 'invalid_request', 'A valid review thread id is required')
    }
    if (actionInput !== 'reply' && actionInput !== 'resolve' && actionInput !== 'reopen') {
      throw new PrServiceError(400, 'invalid_request', 'action must be reply, resolve, or reopen')
    }
    if (actionInput === 'reply' && (typeof bodyInput !== 'string' || !bodyInput.trim() || bodyInput.length > 60_000)) {
      throw new PrServiceError(400, 'invalid_request', 'Reply must contain text and be at most 60,000 characters')
    }
    // Verify ownership and current permissions rather than trusting a client-supplied node id.
    const current = this.graphqlData(parseGhObject(await this.runner([
      'api', 'graphql', '-f', `query=query($id: ID!) { node(id: $id) { ... on PullRequestReviewThread {
        id isResolved viewerCanReply viewerCanResolve viewerCanUnresolve
        pullRequest { number repository { nameWithOwner } }
      } } }`, '-f', `id=${threadInput}`,
    ])))
    const thread = optionalObject(current, 'node')
    const pr = thread && optionalObject(thread, 'pullRequest')
    if (!thread || !pr || pr.number !== number || requiredString(objectField(pr, 'repository'), 'nameWithOwner').toLowerCase() !== repo.toLowerCase()) {
      throw new PrServiceError(404, 'thread_not_found', 'Review thread was not found on this pull request')
    }
    // Concurrent resolution/reopening is already a successful outcome.
    if (actionInput !== 'reply' && thread.isResolved === (actionInput === 'resolve')) {
      this.invalidateReviewThreadCaches(repo, number)
      return { ok: true }
    }
    const permission = actionInput === 'reply' ? 'viewerCanReply' : actionInput === 'resolve' ? 'viewerCanResolve' : 'viewerCanUnresolve'
    if (thread[permission] !== true) throw new PrServiceError(403, 'thread_action_forbidden', 'GitHub does not allow you to perform this action on this thread')
    try {
      const field = actionInput === 'reply' ? 'addPullRequestReviewThreadReply' : actionInput === 'resolve' ? 'resolveReviewThread' : 'unresolveReviewThread'
      const query = actionInput === 'reply'
        ? 'mutation($id: ID!, $body: String!) { addPullRequestReviewThreadReply(input: {pullRequestReviewThreadId: $id, body: $body}) { comment { id } } }'
        : `mutation($id: ID!) { ${field}(input: {threadId: $id}) { thread { id isResolved } } }`
      const data = this.graphqlData(parseGhObject(await this.runner([
        'api', 'graphql', '-f', `query=${query}`, '-f', `id=${threadInput}`,
        ...(actionInput === 'reply' ? ['-f', `body=${bodyInput}`] : []),
      ])))
      const mutation = objectField(data, field)
      const written = objectField(mutation, actionInput === 'reply' ? 'comment' : 'thread')
      requiredString(written, 'id')
      if (actionInput !== 'reply' && written.isResolved !== (actionInput === 'resolve')) throw invalidUpstream()
      return { ok: true }
    } finally {
      // Even a failed/ambiguous write may have changed GitHub state.
      this.invalidateReviewThreadCaches(repo, number)
    }
  }

  private invalidateReviewThreadCaches(repo: string, number: number): void {
    this.entities.invalidate(repo)
    for (const key of this.listCache.keys()) {
      if (key.toLowerCase().startsWith(`${repo.toLowerCase()}::`)) this.listCache.delete(key)
    }
    this.paneListCache.clear()
    for (const key of this.threadsCache.keys()) {
      if (key.toLowerCase() === `${repo.toLowerCase()}#${number}`) this.threadsCache.delete(key)
    }
  }

  async pullRequestConflicts(repoInput: unknown, numberInput: unknown): Promise<import('../shared/pr-quick-look.js').PrConflicts> {
    const repo = validateRepo(repoInput)
    const number = validatePrNumber(numberInput)
    const pr = parseGhObject(await this.ghRead(['api', `repos/${repo}/pulls/${number}`]))
    const base = objectField(pr, 'base')
    const head = objectField(pr, 'head')
    const refs = { baseRefName: requiredString(base, 'ref'), baseOid: requiredString(base, 'sha'), headRefName: requiredString(head, 'ref'), headOid: requiredString(head, 'sha') }
    if (pr.state !== 'open') return { ...refs, state: 'not-open', files: [], messages: [], truncated: false, fetchedAt: this.now() }
    return this.conflictInspector.inspect({ ...refs, repo, number })
  }

  async pullRequestDiff(repoInput: unknown, numberInput: unknown): Promise<import('../shared/pr-quick-look.js').PrRemoteDiff> {
    const repo = validateRepo(repoInput)
    const number = validatePrNumber(numberInput)
    const pr = parseGhObject(await this.ghRead(['api', `repos/${repo}/pulls/${number}`]))
    const head = requiredString(objectField(pr, 'head'), 'sha')
    if (!/^[a-f0-9]{40}$/i.test(head)) throw invalidUpstream()
    // GitHub's main is the remote origin/main, independent of local worktree state.
    const main = parseGhObject(await this.ghRead(['api', `repos/${repo}/commits/main`]))
    const base = requiredString(main, 'sha')
    if (!/^[a-f0-9]{40}$/i.test(base)) throw invalidUpstream()
    const comparison = parseGhObject(await this.ghRead(['api', `repos/${repo}/compare/${base}...${head}`]))
    if (!Array.isArray(comparison.files)) throw invalidUpstream()
    const files = comparison.files.map((file: unknown) => {
      if (!isRecord(file)) throw invalidUpstream()
      return {
        path: requiredString(file, 'filename'),
        status: requiredString(file, 'status'),
        additions: typeof file.additions === 'number' ? file.additions : 0,
        deletions: typeof file.deletions === 'number' ? file.deletions : 0,
        patch: typeof file.patch === 'string' ? file.patch : null,
      }
    })
    return { base, head, files, truncated: files.length >= 300 }
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
    const output = await this.ghRead([
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
