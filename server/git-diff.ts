import { execFile } from 'node:child_process'
import { lstat, readFile, readlink, realpath } from 'node:fs/promises'
import path from 'node:path'
import { githubThrottle, repoFromGithubRemote, validateRepo, type GithubGate } from './prs.js'

const COMMAND_TIMEOUT_MS = 5_000
const DIFF_TIMEOUT_MS = 20_000
const COMMAND_BUFFER_BYTES = 4 * 1024 * 1024
const DIFF_BUFFER_BYTES = 32 * 1024 * 1024
const SUMMARY_CACHE_TTL_MS = 5_000
// Every pane's summary polls every 15s, and each PR lookup spends GitHub
// GraphQL budget shared with agents. A found PR changes rarely; a missing one
// is rechecked sooner so a freshly opened PR shows up within a minute.
const PULL_REQUEST_FOUND_TTL_MS = 3 * 60_000
const PULL_REQUEST_MISSING_TTL_MS = 60_000
const MAX_PULL_REQUEST_CACHE_ENTRIES = 200
const MAX_PULL_REQUEST_EVIDENCE_CHARS = 128 * 1024
const MAX_AUTO_BASE_REFS = 4_000
const MIN_DIFF_WIDTH = 60
const MAX_DIFF_WIDTH = 500
const MAX_SEARCH_QUERY_LENGTH = 200
const MAX_SEARCH_MATCH_LINES = 500
const MAX_SEARCH_PREVIEW_LENGTH = 240
const MAX_SEARCHED_UNTRACKED_CHARS = 2 * 1024 * 1024
/** Either side of a file over this many bytes is not sent to the client renderer. */
export const MAX_FILE_CONTENTS_BYTES = 1024 * 1024
const MAX_BLAME_CACHE_ENTRIES = 100
const UNCOMMITTED_SHA = '0'.repeat(40)
export const COMMIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u
const BLAME_HEADER = /^([0-9a-f]{40}|[0-9a-f]{64}) \d+ (\d+)(?: \d+)?$/u
/** git blame's answer for a worktree path HEAD doesn't have (untracked, or no commits yet). */
const BLAME_NOT_IN_HEAD = /no such path .* in HEAD|no such ref: HEAD|bad revision 'HEAD'/iu
const NUL = '\u0000'
/** git's answer for a SHA that names no object in the repository. */
export const UNKNOWN_OBJECT = /not a tree object|bad object|unable to parse object|not a valid object name|bad revision|invalid object name/iu
const REF_FORBIDDEN = /[\s~^:?*[\\]/u
const PULL_REQUEST_URL = /https?:\/\/[a-z0-9.-]+\/[a-z0-9_.-]+\/[a-z0-9_.-]+\/pull\/([1-9]\d*)/giu

export type GitExecutorOptions = {
  cwd: string
  encoding: 'utf8'
  env?: NodeJS.ProcessEnv
  maxBuffer: number
  shell: false
  timeout: number
  windowsHide: true
  /** Piped to the child's stdin (delta reads patches from stdin). */
  input?: string
  /** Non-zero exit codes treated as success (diff tools exit 1 on differences). */
  allowExitCodes?: readonly number[]
  /** Sees stderr as it arrives, e.g. to follow git's progress meter. */
  onStderr?: (text: string) => void
}

export type GitProcessExecutor = (
  file: string,
  args: readonly string[],
  options: GitExecutorOptions,
) => Promise<{ stdout: string; stderr: string }>

export type GitDiffErrorKind = 'bad-target' | 'bad-file' | 'bad-param' | 'tool-missing' | 'exec'

export type DiffEngine = 'difftastic' | 'delta'
export type DiffDisplay = 'side-by-side' | 'inline'

export type GitDiffSearchMatch = {
  file: string
  line: number
  side: 'added' | 'removed'
  preview: string
  occurrences: number
}

export type GitDiffSearchFile = {
  file: string
  matches: number
}

export type GitDiffSearchResult = {
  query: string
  matches: GitDiffSearchMatch[]
  files: GitDiffSearchFile[]
  totalMatches: number
  matchingFiles: number
  truncated: boolean
}

export type GitFileSide = {
  path: string
  contents: string
  /** Full commit SHA the contents were read from, or 'worktree' for the files on disk. */
  rev: string
}

export type GitFileContents = {
  file: string
  /** null when the file is new (added or untracked). */
  old: GitFileSide | null
  /** null when the file was deleted. */
  new: GitFileSide | null
  /** Set when a side is binary or over the size limit; both sides are then null. */
  unavailable?: 'binary' | 'too-large'
}

export type GitBlameCommit = {
  sha: string
  author: string
  /** Unix seconds. */
  authorTime: number
  summary: string
  /** True for lines not committed yet (worktree edits and untracked files). */
  uncommitted: boolean
}

export type GitBlame = {
  file: string
  rev: string
  commits: Record<string, GitBlameCommit>
  /** lines[i] is the commit SHA of 1-based line i + 1. */
  lines: string[]
}

export type WorktreeEntry = { kind: 'file' | 'symlink' | 'directory' | 'other'; size: number }

/** Filesystem reads for the working-tree side of a comparison; injectable for tests. */
export type WorktreeFiles = {
  /** Like lstat (never follows a symlink); undefined when the path doesn't exist. */
  entry(file: string): Promise<WorktreeEntry | undefined>
  readlink(file: string): Promise<string>
  realpath(file: string): Promise<string>
}

export const nodeWorktreeFiles: WorktreeFiles = {
  async entry(file) {
    try {
      const stats = await lstat(file)
      const kind = stats.isSymbolicLink() ? 'symlink' : stats.isFile() ? 'file' : stats.isDirectory() ? 'directory' : 'other'
      return { kind, size: stats.size }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') return undefined
      throw error
    }
  },
  readlink: (file) => readlink(file, 'utf8'),
  realpath: (file) => realpath(file),
}

/** One side of a comparison before its contents are read, so oversize files are never loaded. */
export type FileSource = { size: number; read: () => Promise<string> }

export function validateBlameRev(value: unknown): string {
  if (value === 'worktree' || (typeof value === 'string' && COMMIT_SHA.test(value))) return value
  throw new GitDiffError('bad-param', 'rev must be "worktree" or a full commit SHA')
}

function lineCount(contents: string): number {
  if (contents.length === 0) return 0
  const lines = contents.split('\n').length
  return contents.endsWith('\n') ? lines - 1 : lines
}

function uncommittedCommit(authorTime: number): GitBlameCommit {
  return { sha: UNCOMMITTED_SHA, author: 'You', authorTime, summary: 'Not committed yet', uncommitted: true }
}

/** Parses `git blame --porcelain`; metadata follows only the first header of each commit. */
export function parseBlamePorcelain(output: string, now: () => number = Date.now): Pick<GitBlame, 'commits' | 'lines'> {
  const commits: Record<string, GitBlameCommit> = {}
  const lines: string[] = []
  let sha: string | undefined
  let finalLine = 0
  for (const line of output.split('\n')) {
    if (line.startsWith('\t')) {
      if (sha && finalLine > 0) lines[finalLine - 1] = sha
      continue
    }
    const header = BLAME_HEADER.exec(line)
    if (header) {
      sha = header[1]
      finalLine = Number(header[2])
      if (!commits[sha]) {
        commits[sha] = /^0+$/u.test(sha)
          ? uncommittedCommit(Math.floor(now() / 1000))
          : { sha, author: '', authorTime: 0, summary: '', uncommitted: false }
      }
      continue
    }
    const commit = sha ? commits[sha] : undefined
    if (!commit || commit.uncommitted) continue
    const space = line.indexOf(' ')
    const key = space < 0 ? line : line.slice(0, space)
    const value = space < 0 ? '' : line.slice(space + 1)
    if (key === 'author') commit.author = value
    else if (key === 'author-time') commit.authorTime = Number(value) || 0
    else if (key === 'summary') commit.summary = value
  }
  return { commits, lines }
}

export function gitFailure(error: unknown, action: string): GitDiffError {
  if (error instanceof GitDiffError) return error
  if (error instanceof GitCommandFailure) {
    if (error.missingBinary) return new GitDiffError('exec', 'git is not installed on the daemon host')
    return new GitDiffError('exec', `${action} failed: ${error.stderr || error.message}`)
  }
  return new GitDiffError('exec', error instanceof Error ? error.message : `${action} failed`)
}

export class GitDiffError extends Error {
  constructor(readonly kind: GitDiffErrorKind, message: string) {
    super(message)
    this.name = 'GitDiffError'
  }
}

export type GitChangedFile = {
  path: string
  /** M(odified) A(dded) D(eleted) T(ype change) U(ntracked) */
  status: string
  additions: number | null
  deletions: number | null
  binary: boolean
}

export type GitPullRequest = {
  number: number
  title: string
  url: string
  isDraft: boolean
}

export type GitDiffSummary = {
  isRepo: boolean
  root?: string
  branch?: string
  pullRequest?: GitPullRequest
  /** Human-readable label of what the diff is against. */
  target?: string | null
  /** 'auto' = branch point detected by the daemon; 'ref' = user-chosen target. */
  targetMode?: 'auto' | 'ref'
  baseCommit?: string
  additions?: number
  deletions?: number
  files?: GitChangedFile[]
}

type ResolvedBase = {
  base: string
  head?: string
  label: string
  mode: 'auto' | 'ref'
  commit?: string
}

export class GitCommandFailure extends Error {
  constructor(message: string, readonly stderr: string, readonly missingBinary: boolean, readonly timedOut = false) {
    super(message)
    this.name = 'GitCommandFailure'
  }
}

export const defaultGitProcessExecutor: GitProcessExecutor = (file, args, options) =>
  new Promise((resolve, reject) => {
    const child = execFile(file, [...args], options, (error, stdout, stderr) => {
      if (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (typeof code === 'number' && options.allowExitCodes?.includes(code)) {
          resolve({ stdout, stderr })
          return
        }
        reject(
          new GitCommandFailure(
            error.killed ? `${file} timed out` : `${file} failed`,
            (stderr ?? '').slice(0, 4_000),
            code === 'ENOENT',
            error.killed === true,
          ),
        )
        return
      }
      resolve({ stdout, stderr })
    })
    child.stdin?.on('error', () => { /* the exit-code path reports the failure */ })
    child.stdin?.end(options.input ?? '')
  })

/** Shared by worktree diffs and remote PR patches. Always preserve syntax colors when piped. */
export async function renderDeltaPatch(
  patch: string,
  width: number,
  display: DiffDisplay = 'inline',
  execute: GitProcessExecutor = defaultGitProcessExecutor,
  cwd = process.cwd(),
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  if (!patch) return ''
  const { stdout } = await execute('delta', [
    '--paging', 'never', '--dark', '--true-color', 'always',
    '--width', String(width),
    ...(display === 'side-by-side' ? ['--side-by-side'] : []),
  ], {
    cwd, encoding: 'utf8', shell: false, windowsHide: true,
    timeout: DIFF_TIMEOUT_MS, maxBuffer: DIFF_BUFFER_BYTES,
    env: { ...environment, COLORTERM: 'truecolor' }, allowExitCodes: [1], input: patch,
  })
  return stdout
}

export function validateDiffEngine(value: unknown): DiffEngine {
  if (value === undefined || value === null || value === '') return 'difftastic'
  if (value === 'difftastic' || value === 'delta') return value
  throw new GitDiffError('bad-param', 'engine must be "difftastic" or "delta"')
}

export function validateDiffDisplay(value: unknown): DiffDisplay {
  if (value === undefined || value === null || value === '') return 'side-by-side'
  if (value === 'side-by-side' || value === 'inline') return value
  throw new GitDiffError('bad-param', 'display must be "side-by-side" or "inline"')
}

export function validateDiffWidth(value: unknown): number {
  const width = typeof value === 'string' && value !== '' ? Number(value) : Number.NaN
  if (!Number.isInteger(width)) return 180
  return Math.min(MAX_DIFF_WIDTH, Math.max(MIN_DIFF_WIDTH, width))
}

export function validateDiffSearchQuery(value: unknown): string {
  if (typeof value !== 'string') throw new GitDiffError('bad-param', 'query parameter is required')
  const query = value.trim()
  if (
    query.length === 0 ||
    query.length > MAX_SEARCH_QUERY_LENGTH ||
    query.includes(NUL) ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(query)
  ) {
    throw new GitDiffError('bad-param', `query must contain 1-${MAX_SEARCH_QUERY_LENGTH} printable characters`)
  }
  return query
}

export function validateGitTarget(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 256 ||
    value !== value.trim() ||
    value.startsWith('-') ||
    value.includes('..') ||
    REF_FORBIDDEN.test(value) ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new GitDiffError('bad-target', 'Invalid git target ref')
  }
  return value
}

export function validateRepoRelativePath(root: string, file: unknown): string {
  if (typeof file !== 'string' || file.length === 0 || file.includes(NUL) || path.isAbsolute(file)) {
    throw new GitDiffError('bad-file', 'Invalid file path')
  }
  const resolved = path.resolve(root, file)
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new GitDiffError('bad-file', 'File path escapes the repository')
  }
  return file
}

function splitZeroTerminated(output: string): string[] {
  return output.split(NUL).filter((entry) => entry.length > 0)
}

function countOccurrences(value: string, query: string): number {
  const haystack = value.toLowerCase()
  const needle = query.toLowerCase()
  let count = 0
  let cursor = 0
  while (cursor <= haystack.length - needle.length) {
    const match = haystack.indexOf(needle, cursor)
    if (match < 0) break
    count += 1
    cursor = match + needle.length
  }
  return count
}

function decodePatchPath(line: string, prefix: string): string | undefined {
  const raw = line.slice(4)
  if (raw === '/dev/null') return undefined
  let value = raw
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      value = JSON.parse(value) as string
    } catch {
      value = value.slice(1, -1)
    }
  }
  return value.startsWith(prefix) ? value.slice(prefix.length) : value
}

function searchPatch(
  output: string,
  query: string,
): Omit<GitDiffSearchResult, 'query'> {
  const matches: GitDiffSearchMatch[] = []
  const files = new Map<string, number>()
  let totalMatches = 0
  let truncated = false
  let oldPath: string | undefined
  let currentPath: string | undefined
  let oldLine = 0
  let newLine = 0

  const addMatch = (file: string, line: number, side: 'added' | 'removed', preview: string) => {
    const occurrences = countOccurrences(preview, query)
    if (!occurrences) return
    totalMatches += occurrences
    files.set(file, (files.get(file) ?? 0) + occurrences)
    if (matches.length < MAX_SEARCH_MATCH_LINES) {
      matches.push({
        file,
        line,
        side,
        preview: preview.slice(0, MAX_SEARCH_PREVIEW_LENGTH),
        occurrences,
      })
    } else truncated = true
  }

  for (const line of output.split('\n')) {
    if (line.startsWith('diff --git ')) {
      oldPath = undefined
      currentPath = undefined
      continue
    }
    if (line.startsWith('--- ')) {
      oldPath = decodePatchPath(line, 'a/')
      continue
    }
    if (line.startsWith('+++ ')) {
      currentPath = decodePatchPath(line, 'b/') ?? oldPath
      continue
    }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u.exec(line)
    if (hunk) {
      oldLine = Number(hunk[1])
      newLine = Number(hunk[2])
      continue
    }
    if (!currentPath) continue
    if (line.startsWith('+')) {
      addMatch(currentPath, newLine, 'added', line.slice(1))
      newLine += 1
    } else if (line.startsWith('-')) {
      addMatch(currentPath, oldLine, 'removed', line.slice(1))
      oldLine += 1
    } else if (!line.startsWith('\\')) {
      oldLine += 1
      newLine += 1
    }
  }

  return {
    matches,
    files: [...files].map(([file, matchCount]) => ({ file, matches: matchCount })),
    totalMatches,
    matchingFiles: files.size,
    truncated,
  }
}

function parsePullRequest(output: string): GitPullRequest | undefined {
  let value: unknown
  try {
    value = JSON.parse(output)
  } catch {
    return undefined
  }
  if (typeof value !== 'object' || value === null) return undefined

  const candidate = value as Record<string, unknown>
  if (
    !Number.isInteger(candidate.number) ||
    (candidate.number as number) <= 0 ||
    typeof candidate.title !== 'string' ||
    candidate.title.trim() === '' ||
    typeof candidate.url !== 'string' ||
    typeof candidate.state !== 'string' ||
    candidate.state.toUpperCase() !== 'OPEN' ||
    typeof candidate.isDraft !== 'boolean'
  ) return undefined

  try {
    const url = new URL(candidate.url)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined
  } catch {
    return undefined
  }

  return {
    number: candidate.number as number,
    title: candidate.title.trim(),
    url: candidate.url,
    isDraft: candidate.isDraft,
  }
}

function canonicalPullRequestUrl(value: string): string | undefined {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined
    return `${url.protocol}//${url.host.toLowerCase()}${url.pathname.replace(/\/+$/u, '').toLowerCase()}`
  } catch {
    return undefined
  }
}

function latestPullRequestReference(evidence: string): { number: number; url: string } | undefined {
  let latest: { number: number; url: string } | undefined
  for (const match of evidence.slice(-MAX_PULL_REQUEST_EVIDENCE_CHARS).matchAll(PULL_REQUEST_URL)) {
    const number = Number(match[1])
    if (Number.isSafeInteger(number)) latest = { number, url: match[0] }
  }
  return latest
}

export type GitBranches = {
  isRepo: boolean
  current?: string
  branches?: string[]
}

export class GitDiffInspector {
  private readonly summaryCache = new Map<string, { at: number; result: Promise<GitDiffSummary> }>()
  private readonly branchesCache = new Map<string, { at: number; result: Promise<GitBranches> }>()
  private readonly autoBaseCache = new Map<string, { at: number; result: Promise<ResolvedBase> }>()
  private readonly pullRequestCache = new Map<string, { at: number; result: Promise<GitPullRequest | undefined> }>()
  /** Blames at a commit SHA never change; worktree blames are never cached. */
  private readonly blameCache = new Map<string, Promise<GitBlame>>()

  constructor(
    private readonly execute: GitProcessExecutor = defaultGitProcessExecutor,
    private readonly environment: NodeJS.ProcessEnv = process.env,
    private readonly now: () => number = Date.now,
    private readonly readTextFile: (file: string) => Promise<string> = (file) => readFile(file, 'utf8'),
    private readonly github?: GithubGate,
    private readonly files: WorktreeFiles = nodeWorktreeFiles,
  ) {}

  async summary(cwd: string, target?: string, head?: string, baseFallbackRepo?: string, baseFallbackBranch?: string): Promise<GitDiffSummary> {
    const key = `${cwd}${NUL}${target ?? ''}${NUL}${head ?? ''}${NUL}${baseFallbackRepo ?? ''}${NUL}${baseFallbackBranch ?? ''}`
    const cached = this.summaryCache.get(key)
    if (cached && this.now() - cached.at < SUMMARY_CACHE_TTL_MS) return cached.result
    const result = this.computeSummary(cwd, target, head, baseFallbackRepo, baseFallbackBranch)
    this.summaryCache.set(key, { at: this.now(), result })
    result.catch(() => this.summaryCache.delete(key))
    return result
  }

  async pullRequestFromEvidence(root: string, evidence: string): Promise<GitPullRequest | undefined> {
    const reference = latestPullRequestReference(evidence)
    if (!reference) return undefined
    return this.cachedPullRequest(`${root}${NUL}#${reference.url}`, () => this.lookUpPullRequestReference(root, reference))
  }

  private async lookUpPullRequestReference(root: string, reference: { number: number; url: string }): Promise<GitPullRequest | undefined> {
    try {
      const { stdout } = await this.execute(
        'gh',
        ['pr', 'view', String(reference.number), '--json', 'number,title,url,state,isDraft'],
        this.options(root, COMMAND_TIMEOUT_MS, COMMAND_BUFFER_BYTES, {
          ...this.environment,
          GH_PROMPT_DISABLED: '1',
        }),
      )
      const pullRequest = parsePullRequest(stdout)
      return pullRequest && canonicalPullRequestUrl(pullRequest.url) === canonicalPullRequestUrl(reference.url)
        ? pullRequest
        : undefined
    } catch (error) {
      if (this.noteGithubFailure(error)) throw error
      return undefined
    }
  }

  async branches(cwd: string): Promise<GitBranches> {
    const cached = this.branchesCache.get(cwd)
    if (cached && this.now() - cached.at < SUMMARY_CACHE_TTL_MS) return cached.result
    const result = this.computeBranches(cwd)
    this.branchesCache.set(cwd, { at: this.now(), result })
    result.catch(() => this.branchesCache.delete(cwd))
    return result
  }

  private async computeBranches(cwd: string): Promise<GitBranches> {
    const repo = await this.repoContext(cwd)
    if (!repo) return { isRepo: false }
    const { stdout } = await this.git(repo.root, [
      'for-each-ref',
      '--format=%(refname:short)%09%(symref)',
      '--sort=-committerdate',
      'refs/heads',
      'refs/remotes',
    ])
    const seen = new Set<string>()
    const branches: string[] = []
    for (const line of stdout.split('\n')) {
      const [name, symref] = line.split('\t')
      const branch = name?.trim() ?? ''
      // Symbolic refs like origin/HEAD point at another branch already listed.
      if (!branch || symref?.trim() || seen.has(branch)) continue
      seen.add(branch)
      branches.push(branch)
    }
    return { isRepo: true, current: repo.branch, branches }
  }

  async fileDiff(
    cwd: string,
    file: string,
    target: string | undefined,
    width: number,
    engine: DiffEngine = 'difftastic',
    display: DiffDisplay = 'side-by-side',
    head?: string,
    baseFallbackRepo?: string,
    baseFallbackBranch?: string,
  ): Promise<string> {
    const repo = await this.repoContext(cwd)
    if (!repo) throw new GitDiffError('exec', 'Not a git repository')
    const relative = validateRepoRelativePath(repo.root, file)
    const resolved = await this.resolveBase(repo.root, repo.branch, target, head, baseFallbackRepo, baseFallbackBranch)

    try {
      const untracked = resolved.head === undefined && await this.isUntracked(repo.root, relative)
      return engine === 'delta'
        ? await this.deltaDiff(repo.root, relative, resolved.base, resolved.head, width, display, untracked)
        : await this.difftasticDiff(repo.root, relative, resolved.base, resolved.head, width, display, untracked)
    } catch (error) {
      throw this.asDiffError(error, engine)
    }
  }

  async search(cwd: string, value: unknown, target?: string, head?: string, baseFallbackRepo?: string, baseFallbackBranch?: string): Promise<GitDiffSearchResult> {
    const query = validateDiffSearchQuery(value)
    const repo = await this.repoContext(cwd)
    if (!repo) throw new GitDiffError('exec', 'Not a git repository')
    const resolved = await this.resolveBase(repo.root, repo.branch, target, head, baseFallbackRepo, baseFallbackBranch)

    try {
      const [{ stdout }, summary] = await Promise.all([
        this.execute(
          'git',
          ['diff', '--no-color', '--no-ext-diff', '--unified=0', '--no-renames', resolved.base, ...(resolved.head ? [resolved.head] : []), '--'],
          this.options(repo.root, DIFF_TIMEOUT_MS, DIFF_BUFFER_BYTES),
        ),
        this.summary(cwd, target, head, baseFallbackRepo, baseFallbackBranch),
      ])
      const result = searchPatch(stdout, query)
      const matchingFiles = new Map(result.files.map((file) => [file.file, file.matches]))

      for (const file of summary.files ?? []) {
        if (file.status[0] !== 'U' || file.binary) continue
        let contents: string
        try {
          contents = await this.readTextFile(path.join(repo.root, file.path))
        } catch {
          continue
        }
        if (contents.includes(NUL) || contents.length > MAX_SEARCHED_UNTRACKED_CHARS) continue
        for (const [index, line] of contents.split('\n').entries()) {
          const occurrences = countOccurrences(line, query)
          if (!occurrences) continue
          result.totalMatches += occurrences
          matchingFiles.set(file.path, (matchingFiles.get(file.path) ?? 0) + occurrences)
          if (result.matches.length < MAX_SEARCH_MATCH_LINES) {
            result.matches.push({
              file: file.path,
              line: index + 1,
              side: 'added',
              preview: line.slice(0, MAX_SEARCH_PREVIEW_LENGTH),
              occurrences,
            })
          } else {
            result.truncated = true
          }
        }
      }

      return {
        query,
        ...result,
        files: [...matchingFiles].map(([file, matches]) => ({ file, matches })),
        matchingFiles: matchingFiles.size,
      }
    } catch (error) {
      if (error instanceof GitDiffError) throw error
      if (error instanceof GitCommandFailure) {
        throw new GitDiffError('exec', `git diff search failed: ${error.stderr || error.message}`)
      }
      throw new GitDiffError('exec', error instanceof Error ? error.message : 'git diff search failed')
    }
  }

  /**
   * Both sides of one file in full, for client-side diff rendering. Paths are the same on both
   * sides (status semantics follow `git diff --no-renames`); each side's rev is an immutable SHA,
   * or 'worktree' for the files on disk when no head is given.
   */
  async fileContents(
    cwd: string,
    file: string,
    target?: string,
    head?: string,
    baseFallbackRepo?: string,
    baseFallbackBranch?: string,
  ): Promise<GitFileContents> {
    const repo = await this.repoContext(cwd)
    if (!repo) throw new GitDiffError('exec', 'Not a git repository')
    const relative = validateRepoRelativePath(repo.root, file)
    const resolved = await this.resolveBase(repo.root, repo.branch, target, head, baseFallbackRepo, baseFallbackBranch)

    try {
      const [baseSha, headSha] = await Promise.all([
        this.commitSha(repo.root, resolved.base),
        resolved.head === undefined ? undefined : this.commitSha(repo.root, resolved.head),
      ])
      const [oldSource, newSource] = await Promise.all([
        this.treeSource(repo.root, baseSha, relative),
        headSha ? this.treeSource(repo.root, headSha, relative) : this.worktreeSource(repo.root, relative),
      ])
      if (!oldSource && !newSource) throw new GitDiffError('bad-file', `File not found on either side: ${relative}`)
      const tooLarge = { file, old: null, new: null, unavailable: 'too-large' } as const
      if ((oldSource?.size ?? 0) > MAX_FILE_CONTENTS_BYTES || (newSource?.size ?? 0) > MAX_FILE_CONTENTS_BYTES) return tooLarge
      const [oldText, newText] = await Promise.all([oldSource?.read(), newSource?.read()])
      if (oldText?.includes(NUL) || newText?.includes(NUL)) return { file, old: null, new: null, unavailable: 'binary' }
      // The file on disk may have grown since it was measured.
      if (newText !== undefined && Buffer.byteLength(newText) > MAX_FILE_CONTENTS_BYTES) return tooLarge
      return {
        file,
        old: oldText === undefined ? null : { path: relative, contents: oldText, rev: baseSha },
        new: newText === undefined ? null : { path: relative, contents: newText, rev: headSha ?? 'worktree' },
      }
    } catch (error) {
      throw gitFailure(error, 'git file contents')
    }
  }

  /** Line-by-line blame at a rev from fileContents: a full commit SHA, or 'worktree'. */
  async blame(cwd: string, file: string, value: unknown): Promise<GitBlame> {
    const rev = validateBlameRev(value)
    const repo = await this.repoContext(cwd)
    if (!repo) throw new GitDiffError('exec', 'Not a git repository')
    const relative = validateRepoRelativePath(repo.root, file)
    if (rev === 'worktree') return this.computeBlame(repo.root, file, relative, rev)

    const key = `${repo.root}${NUL}${rev}${NUL}${relative}`
    const cached = this.blameCache.get(key)
    if (cached) {
      this.blameCache.delete(key)
      this.blameCache.set(key, cached)
      return cached
    }
    const result = this.computeBlame(repo.root, file, relative, rev)
    this.blameCache.set(key, result)
    if (this.blameCache.size > MAX_BLAME_CACHE_ENTRIES) this.blameCache.delete(this.blameCache.keys().next().value!)
    result.catch(() => { if (this.blameCache.get(key) === result) this.blameCache.delete(key) })
    return result
  }

  private async computeBlame(root: string, file: string, relative: string, rev: string): Promise<GitBlame> {
    try {
      const { stdout } = await this.execute(
        'git',
        ['blame', '--porcelain', ...(rev === 'worktree' ? [] : [rev]), '--', relative],
        this.options(root, DIFF_TIMEOUT_MS, DIFF_BUFFER_BYTES),
      )
      return { file, rev, ...parseBlamePorcelain(stdout, this.now) }
    } catch (error) {
      if (!(error instanceof GitCommandFailure) || error.missingBinary || error.timedOut) throw gitFailure(error, 'git blame')
      if (rev !== 'worktree') {
        if (/no such path/iu.test(error.stderr)) throw new GitDiffError('bad-file', `${relative} does not exist at ${rev}`)
        throw gitFailure(error, 'git blame')
      }
      if (!BLAME_NOT_IN_HEAD.test(error.stderr)) throw gitFailure(error, 'git blame')
      // Untracked (or no commits yet): every line on disk is uncommitted.
      const source = await this.worktreeSource(root, relative).catch((cause: unknown) => { throw gitFailure(cause, 'git blame') })
      if (!source) throw new GitDiffError('bad-file', `File not found: ${relative}`)
      if (source.size > MAX_FILE_CONTENTS_BYTES) throw new GitDiffError('bad-file', `${relative} is too large to blame`)
      const count = lineCount(await source.read())
      const commit = uncommittedCommit(Math.floor(this.now() / 1000))
      return {
        file,
        rev,
        commits: count > 0 ? { [commit.sha]: commit } : {},
        lines: Array.from({ length: count }, () => commit.sha),
      }
    }
  }

  /** The repository containing `cwd` and a validated repo-relative path in it. */
  async repoFile(cwd: string, file: unknown): Promise<{ root: string; relative: string }> {
    const repo = await this.repoContext(cwd)
    if (!repo) throw new GitDiffError('exec', 'Not a git repository')
    return { root: repo.root, relative: validateRepoRelativePath(repo.root, file) }
  }

  /**
   * A file at a rev from fileContents or blame: `'worktree'` reads the disk under the same rules as
   * fileContents (symlinks as link text, no escaping through symlinked parents), a full SHA reads
   * the committed blob. Undefined when the file doesn't exist there.
   */
  async revisionSource(root: string, relative: string, rev: string): Promise<FileSource | undefined> {
    if (rev === 'worktree') return this.worktreeSource(root, relative)
    try {
      return await this.treeSource(root, rev, relative)
    } catch (error) {
      if (error instanceof GitCommandFailure && UNKNOWN_OBJECT.test(error.stderr)) {
        throw new GitDiffError('bad-target', `Unknown commit: ${rev}`)
      }
      throw error
    }
  }

  /** The checked-out commit's SHA, or undefined when HEAD has no commits yet. */
  async headSha(root: string): Promise<string | undefined> {
    try {
      return await this.commitSha(root, 'HEAD')
    } catch (error) {
      if (error instanceof GitCommandFailure && error.missingBinary) throw gitFailure(error, 'git rev-parse')
      return undefined
    }
  }

  /** Runs git in a repository with the inspector's executor and environment. */
  runGit(
    cwd: string,
    args: readonly string[],
    options: { timeout?: number; maxBuffer?: number; allowExitCodes?: readonly number[] } = {},
  ): Promise<{ stdout: string; stderr: string }> {
    return this.execute('git', args, {
      ...this.options(cwd, options.timeout ?? COMMAND_TIMEOUT_MS, options.maxBuffer ?? COMMAND_BUFFER_BYTES),
      ...(options.allowExitCodes ? { allowExitCodes: options.allowExitCodes } : {}),
    })
  }

  private async commitSha(root: string, rev: string): Promise<string> {
    const { stdout } = await this.git(root, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`])
    const sha = stdout.trim()
    if (!COMMIT_SHA.test(sha)) throw new GitDiffError('bad-target', `Unknown git ref: ${rev}`)
    return sha
  }

  /** The file as committed at a SHA; undefined when it doesn't exist there (or is a directory). */
  private async treeSource(root: string, sha: string, relative: string): Promise<FileSource | undefined> {
    const { stdout } = await this.git(root, ['ls-tree', '-l', '-z', sha, '--', relative])
    for (const entry of splitZeroTerminated(stdout)) {
      const tab = entry.indexOf('\t')
      if (tab < 0 || entry.slice(tab + 1) !== relative) continue
      const [, type, object, size] = entry.slice(0, tab).split(/ +/u)
      if (type === 'commit') {
        const contents = `Subproject commit ${object}\n`
        return { size: contents.length, read: async () => contents }
      }
      if (type !== 'blob') return undefined
      return {
        size: Number(size),
        read: async () => (await this.execute('git', ['cat-file', 'blob', object],
          this.options(root, DIFF_TIMEOUT_MS, MAX_FILE_CONTENTS_BYTES + 1))).stdout,
      }
    }
    return undefined
  }

  /**
   * The file on disk, read as git would: a symlink is its target text, never followed, and a
   * path whose parent directories lead outside the repository is refused.
   */
  private async worktreeSource(root: string, relative: string): Promise<FileSource | undefined> {
    const absolute = path.join(root, relative)
    let parent: string
    try {
      parent = await this.files.realpath(path.dirname(absolute))
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR') return undefined
      throw error
    }
    const realRoot = await this.files.realpath(root)
    if (parent !== realRoot && !parent.startsWith(`${realRoot}${path.sep}`)) {
      throw new GitDiffError('bad-file', 'File path escapes the repository')
    }
    const entry = await this.files.entry(absolute)
    if (!entry) return undefined
    if (entry.kind === 'file') return { size: entry.size, read: () => this.readTextFile(absolute) }
    if (entry.kind === 'symlink') {
      const target = await this.files.readlink(absolute)
      return { size: Buffer.byteLength(target), read: async () => target }
    }
    if (entry.kind === 'directory') {
      const state = await this.submoduleState(path.join(parent, path.basename(absolute)))
      if (!state) return undefined
      const contents = `Subproject commit ${state}\n`
      return { size: contents.length, read: async () => contents }
    }
    return undefined
  }

  /**
   * The checked-out commit of a submodule directory, suffixed `-dirty` when it has local changes
   * (as `git diff` prints it), or undefined for a plain directory.
   */
  private async submoduleState(directory: string): Promise<string | undefined> {
    let sha: string | undefined
    try {
      const { stdout } = await this.git(directory, ['rev-parse', '--show-toplevel', 'HEAD'])
      const [top, head] = stdout.split('\n').map((line) => line.trim())
      if (top !== directory || !head || !COMMIT_SHA.test(head)) return undefined
      sha = head
    } catch {
      return undefined
    }
    try {
      // Untracked files don't make git diff print -dirty, so they are left out here too.
      const { stdout: status } = await this.git(directory, ['status', '--porcelain', '--untracked-files=no'])
      return status.trim() ? `${sha}-dirty` : sha
    } catch {
      return sha
    }
  }

  private async difftasticDiff(
    root: string,
    relative: string,
    base: string,
    head: string | undefined,
    width: number,
    display: DiffDisplay,
    untracked: boolean,
  ): Promise<string> {
    const difftEnv = {
      ...this.environment,
      DFT_BACKGROUND: 'dark',
      DFT_COLOR: 'always',
      DFT_DISPLAY: display,
      DFT_WIDTH: String(width),
    }
    if (untracked) {
      const { stdout } = await this.execute(
        'difft',
        [
          '--color', 'always',
          '--width', String(width),
          '--display', display,
          '--background', 'dark',
          '/dev/null',
          path.join(root, relative),
        ],
        this.options(root, DIFF_TIMEOUT_MS, DIFF_BUFFER_BYTES, difftEnv),
      )
      return stdout
    }
    const { stdout } = await this.execute(
      'git',
      ['diff', '--ext-diff', base, ...(head ? [head] : []), '--', relative],
      this.options(root, DIFF_TIMEOUT_MS, DIFF_BUFFER_BYTES, { ...difftEnv, GIT_EXTERNAL_DIFF: 'difft' }),
    )
    return stdout
  }

  private async deltaDiff(
    root: string,
    relative: string,
    base: string,
    head: string | undefined,
    width: number,
    display: DiffDisplay,
    untracked: boolean,
  ): Promise<string> {
    const deltaArgs = [
      '--paging', 'never',
      '--dark',
      '--width', String(width),
      ...(display === 'side-by-side' ? ['--side-by-side'] : []),
    ]
    if (untracked) {
      // Direct file comparison; delta follows diff exit-code semantics (1 = differences).
      const { stdout } = await this.execute(
        'delta',
        [...deltaArgs, '/dev/null', path.join(root, relative)],
        { ...this.options(root, DIFF_TIMEOUT_MS, DIFF_BUFFER_BYTES), allowExitCodes: [1] },
      )
      return stdout
    }
    const { stdout: patch } = await this.execute(
      'git',
      ['diff', base, ...(head ? [head] : []), '--', relative],
      this.options(root, DIFF_TIMEOUT_MS, DIFF_BUFFER_BYTES),
    )
    return renderDeltaPatch(patch, width, display, this.execute, root, this.environment)
  }

  private asDiffError(error: unknown, engine: DiffEngine): GitDiffError {
    if (error instanceof GitDiffError) return error
    if (error instanceof GitCommandFailure) {
      if (error.missingBinary || /difft.*(not found|No such file)|external diff died/iu.test(error.stderr)) {
        return engine === 'delta'
          ? new GitDiffError(
            'tool-missing',
            'delta is not installed or not on the daemon PATH. Install it, e.g. `brew install git-delta`.',
          )
          : new GitDiffError(
            'tool-missing',
            'difftastic (difft) is not installed or not on the daemon PATH. Install it, e.g. `brew install difftastic`.',
          )
      }
      return new GitDiffError('exec', `git diff failed: ${error.stderr || error.message}`)
    }
    return new GitDiffError('exec', error instanceof Error ? error.message : 'git diff failed')
  }

  private async computeSummary(cwd: string, target?: string, head?: string, baseFallbackRepo?: string, baseFallbackBranch?: string): Promise<GitDiffSummary> {
    const repo = await this.repoContext(cwd)
    if (!repo) return { isRepo: false }
    const resolved = await this.resolveBase(repo.root, repo.branch, target, head, baseFallbackRepo, baseFallbackBranch)
    const base = resolved.base
    const comparisonHead = resolved.head ? [resolved.head] : []

    const [numstat, nameStatus, untracked, pullRequest] = await Promise.all([
      this.git(repo.root, ['diff', '--numstat', '--no-renames', '-z', base, ...comparisonHead]),
      this.git(repo.root, ['diff', '--name-status', '--no-renames', '-z', base, ...comparisonHead]),
      resolved.head === undefined
        ? this.git(repo.root, ['ls-files', '--others', '--exclude-standard', '-z'])
        : Promise.resolve({ stdout: '', stderr: '' }),
      target === undefined && head === undefined ? this.currentPullRequest(repo.root, repo.branch) : undefined,
    ])

    const statuses = new Map<string, string>()
    const statusEntries = splitZeroTerminated(nameStatus.stdout)
    for (let index = 0; index + 1 < statusEntries.length; index += 2) {
      statuses.set(statusEntries[index + 1], statusEntries[index])
    }

    const files: GitChangedFile[] = []
    let additions = 0
    let deletions = 0
    for (const entry of splitZeroTerminated(numstat.stdout)) {
      const [added, deleted, ...pathParts] = entry.split('\t')
      const filePath = pathParts.join('\t')
      if (!filePath) continue
      const binary = added === '-'
      const fileAdditions = binary ? null : Number(added)
      const fileDeletions = binary ? null : Number(deleted)
      additions += fileAdditions ?? 0
      deletions += fileDeletions ?? 0
      files.push({
        path: filePath,
        status: statuses.get(filePath) ?? 'M',
        additions: fileAdditions,
        deletions: fileDeletions,
        binary,
      })
    }
    for (const filePath of splitZeroTerminated(untracked.stdout)) {
      files.push({ path: filePath, status: 'U', additions: null, deletions: null, binary: false })
    }
    files.sort((left, right) => left.path.localeCompare(right.path))

    return {
      isRepo: true,
      root: repo.root,
      branch: repo.branch,
      ...(pullRequest ? { pullRequest } : {}),
      target: resolved.label,
      targetMode: resolved.mode,
      baseCommit: resolved.commit,
      additions,
      deletions,
      files,
    }
  }

  private async repoContext(cwd: string): Promise<{ root: string; branch: string } | null> {
    try {
      const { stdout } = await this.git(cwd, ['rev-parse', '--show-toplevel', '--abbrev-ref', 'HEAD'])
      const lines = stdout.split('\n').map((line) => line.trim()).filter((line) => line.length > 0)
      const [root, branch] = lines
      if (!root) return null
      return { root, branch: branch ?? '' }
    } catch (error) {
      if (error instanceof GitCommandFailure && error.missingBinary) {
        throw new GitDiffError('exec', 'git is not installed on the daemon host')
      }
      return null
    }
  }

  private async resolveBase(root: string, branch: string, target?: string, head?: string, baseFallbackRepo?: string, baseFallbackBranch?: string): Promise<ResolvedBase> {
    if (baseFallbackRepo !== undefined || baseFallbackBranch !== undefined) {
      if (target === undefined || head === undefined) {
        throw new GitDiffError('bad-target', 'A base fallback requires an explicit base and head comparison')
      }
      try { validateRepo(baseFallbackRepo) } catch {
        throw new GitDiffError('bad-target', 'Invalid PR base fallback repository')
      }
      validateGitTarget(baseFallbackBranch)
    }
    if (head !== undefined && target === undefined) {
      throw new GitDiffError('bad-target', 'A base target is required when a head ref is provided')
    }
    if (target !== undefined) {
      let validated = validateGitTarget(target)
      let usedFallback = false
      if (!(await this.refExists(root, validated))) {
        const fallback = baseFallbackRepo !== undefined && baseFallbackBranch !== undefined
          ? await this.baseFallbackRef(root, baseFallbackRepo, baseFallbackBranch) : undefined
        if (fallback === undefined) {
          throw new GitDiffError('bad-target', `Unknown git ref: ${validated}`)
        }
        validated = fallback
        usedFallback = true
      }
      if (head !== undefined) {
        const validatedHead = validateGitTarget(head)
        if (!(await this.refExists(root, validatedHead))) {
          throw new GitDiffError('bad-target', `Unknown git ref: ${validatedHead}`)
        }
        // A PR comparison needs a real common ancestor: diffing two tips directly (e.g. in a
        // shallow clone) would attribute base-branch changes to the PR.
        const base = await this.commonAncestor(root, validated, validatedHead)
        if (base === undefined) {
          throw new GitDiffError('bad-target', usedFallback
            ? "The PR's base commit isn't in this repo and no common ancestor with its branch is available"
            : 'No common ancestor between the PR base and head is available in this repo')
        }
        if (usedFallback) {
          const { stdout } = await this.git(root, ['rev-parse', '--verify', '--quiet', `${validatedHead}^{commit}`])
          if (base === stdout.trim()) {
            throw new GitDiffError('bad-target', "The PR's base commit isn't in this repo and its branch already contains the PR")
          }
        }
        return {
          base,
          head: validatedHead,
          label: `${validated.replace(/^refs\/remotes\//, '')}…${validatedHead}`,
          mode: 'ref',
          commit: base,
        }
      }
      const base = await this.mergeBase(root, validated)
      return { base, label: validated, mode: 'ref', commit: base }
    }
    const cached = this.autoBaseCache.get(root)
    if (cached && this.now() - cached.at < SUMMARY_CACHE_TTL_MS) return cached.result
    const result = this.computeAutoBase(root, branch)
    this.autoBaseCache.set(root, { at: this.now(), result })
    result.catch(() => this.autoBaseCache.delete(root))
    return result
  }

  private async baseFallbackRef(root: string, repo: string, branch: string): Promise<string | undefined> {
    const remotes = await this.git(root, ['remote']).then(({ stdout }) => stdout, () => '')
    for (const remote of remotes.trim().split('\n').filter(Boolean)) {
      // A remote without a readable URL can't match; skip it rather than failing the request.
      const url = await this.git(root, ['remote', 'get-url', remote]).then(({ stdout }) => stdout, () => '')
      if (repoFromGithubRemote(url)?.toLowerCase() !== repo.toLowerCase()) continue
      // Fully qualified, so a local branch literally named `<remote>/<branch>` can't shadow it.
      const ref = validateGitTarget(`refs/remotes/${remote}/${branch}`)
      if (await this.refExists(root, ref)) return ref
    }
    return undefined
  }

  /**
   * The branch point: the newest commit reachable from any *other* branch.
   * Diffing from it shows only this branch's own commits (plus the working
   * tree), regardless of how busy the target branch's history is.
   */
  private async computeAutoBase(root: string, branch: string): Promise<ResolvedBase> {
    const uncommittedOnly: ResolvedBase = { base: 'HEAD', label: 'HEAD (uncommitted changes)', mode: 'auto' }
    const { stdout: refsOut } = await this.git(root, [
      'for-each-ref',
      '--format=%(objectname)%09%(refname:short)%09%(symref)',
      'refs/heads',
      'refs/remotes',
    ])
    const negatives = new Set<string>()
    for (const line of refsOut.split('\n')) {
      const [sha, name, symref] = line.split('\t')
      if (!sha || !name || symref?.trim()) continue
      // Skip this branch and its copies on remotes; they'd swallow its commits.
      if (name === branch || name.endsWith(`/${branch}`)) continue
      negatives.add(sha)
      if (negatives.size >= MAX_AUTO_BASE_REFS) break
    }
    if (negatives.size === 0) return uncommittedOnly

    const { stdout: revsOut } = await this.git(root, [
      'rev-list', '--boundary', '--topo-order', 'HEAD', '--not', ...negatives,
    ])
    const boundaries = revsOut
      .split('\n')
      .filter((line) => line.startsWith('-'))
      .map((line) => line.slice(1).trim())
      .filter((sha) => sha.length > 0)
      .slice(0, MAX_AUTO_BASE_REFS)
    if (boundaries.length === 0) return uncommittedOnly

    const { stdout: newestOut } = await this.git(root, [
      'rev-list', '--no-walk=sorted', '--max-count=1', ...boundaries,
    ])
    const base = newestOut.trim()
    if (!base) return uncommittedOnly

    const { stdout: nameOut } = await this.git(root, [
      'name-rev', '--name-only', '--always',
      '--refs=refs/heads/*', '--refs=refs/remotes/*',
      base,
    ])
    const named = nameOut.trim().replace(/^remotes\//u, '').replace(/[~^].*$/u, '')
    const short = base.slice(0, 7)
    const label = named && named !== base ? `${named} @ ${short}` : short
    return { base, label, mode: 'auto', commit: base }
  }

  private async refExists(root: string, ref: string): Promise<boolean> {
    try {
      await this.git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
      return true
    } catch {
      return false
    }
  }

  /** Undefined only when git reports no common ancestor (exit 1); other failures propagate. */
  private async commonAncestor(root: string, base: string, head: string): Promise<string | undefined> {
    const { stdout } = await this.execute('git', ['merge-base', base, head],
      { ...this.options(root, COMMAND_TIMEOUT_MS, COMMAND_BUFFER_BYTES), allowExitCodes: [1] })
    return stdout.trim() || undefined
  }

  private async mergeBase(root: string, target: string, head = 'HEAD'): Promise<string> {
    try {
      const { stdout } = await this.git(root, ['merge-base', target, head])
      const base = stdout.trim()
      return base || target
    } catch {
      // Detached HEAD or unrelated histories: diff directly against the target.
      return target
    }
  }

  private git(cwd: string, args: readonly string[]): Promise<{ stdout: string; stderr: string }> {
    return this.execute('git', args, this.options(cwd, COMMAND_TIMEOUT_MS, COMMAND_BUFFER_BYTES))
  }

  private currentPullRequest(root: string, branch: string): Promise<GitPullRequest | undefined> {
    if (!branch || branch === 'HEAD') return Promise.resolve(undefined)
    return this.cachedPullRequest(`${root}${NUL}${branch}`, () => this.lookUpCurrentPullRequest(root))
  }

  private cachedPullRequest(key: string, load: () => Promise<GitPullRequest | undefined>): Promise<GitPullRequest | undefined> {
    const now = this.now()
    const cached = this.pullRequestCache.get(key)
    // While PR sync is paused, keep showing the last answer rather than spend the reserve.
    if (this.github && now < this.github.pausedUntil('graphql')) return cached?.result ?? Promise.resolve(undefined)
    if (cached && now - cached.at < PULL_REQUEST_FOUND_TTL_MS) {
      // A missing PR expires sooner; an in-flight lookup is always shared.
      return cached.result.then((pullRequest) => pullRequest || now - cached.at < PULL_REQUEST_MISSING_TTL_MS
        ? pullRequest
        : this.refreshPullRequest(key, cached, load))
    }
    return this.refreshPullRequest(key, cached, load)
  }

  private refreshPullRequest(
    key: string,
    previous: { at: number; result: Promise<GitPullRequest | undefined> } | undefined,
    load: () => Promise<GitPullRequest | undefined>,
  ): Promise<GitPullRequest | undefined> {
    const current = this.pullRequestCache.get(key)
    // Concurrent callers that saw the same expired entry share one refresh.
    if (current && current !== previous) return current.result
    // A throttled lookup keeps the previous answer rather than caching "no PR".
    const entry = { at: this.now(), result: load().catch(() => previous?.result) }
    this.pullRequestCache.delete(key)
    this.pullRequestCache.set(key, entry)
    if (this.pullRequestCache.size > MAX_PULL_REQUEST_CACHE_ENTRIES) this.pullRequestCache.delete(this.pullRequestCache.keys().next().value!)
    return entry.result
  }

  /** Reports GitHub throttling to PR sync; returns whether the failure was throttling. */
  private noteGithubFailure(error: unknown): boolean {
    if (!(error instanceof GitCommandFailure) || !githubThrottle(error.stderr)) return false
    this.github?.rateLimited('graphql', error.stderr)
    return true
  }

  private async lookUpCurrentPullRequest(root: string): Promise<GitPullRequest | undefined> {
    try {
      const { stdout } = await this.execute(
        'gh',
        ['pr', 'view', '--json', 'number,title,url,state,isDraft'],
        this.options(root, COMMAND_TIMEOUT_MS, COMMAND_BUFFER_BYTES, {
          ...this.environment,
          GH_PROMPT_DISABLED: '1',
        }),
      )
      return parsePullRequest(stdout)
    } catch (error) {
      if (this.noteGithubFailure(error)) throw error
      return undefined
    }
  }

  private options(
    cwd: string,
    timeout: number,
    maxBuffer: number,
    env?: NodeJS.ProcessEnv,
  ): GitExecutorOptions {
    return {
      cwd,
      encoding: 'utf8',
      env: env ?? { ...this.environment },
      maxBuffer,
      shell: false,
      timeout,
      windowsHide: true,
    }
  }

  private async isUntracked(root: string, file: string): Promise<boolean> {
    const { stdout } = await this.git(root, ['ls-files', '--others', '--exclude-standard', '-z', '--', file])
    return splitZeroTerminated(stdout).includes(file)
  }
}
