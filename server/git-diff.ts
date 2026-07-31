import { execFile } from 'node:child_process'
import path from 'node:path'

const COMMAND_TIMEOUT_MS = 5_000
const DIFF_TIMEOUT_MS = 20_000
const COMMAND_BUFFER_BYTES = 4 * 1024 * 1024
const DIFF_BUFFER_BYTES = 32 * 1024 * 1024
const SUMMARY_CACHE_TTL_MS = 5_000
const MAX_AUTO_BASE_REFS = 4_000
const MIN_DIFF_WIDTH = 60
const MAX_DIFF_WIDTH = 500
const NUL = '\u0000'
const REF_FORBIDDEN = /[\s~^:?*[\\]/u

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
}

export type GitProcessExecutor = (
  file: string,
  args: readonly string[],
  options: GitExecutorOptions,
) => Promise<{ stdout: string; stderr: string }>

export type GitDiffErrorKind = 'bad-target' | 'bad-file' | 'bad-param' | 'tool-missing' | 'exec'

export type DiffEngine = 'difftastic' | 'delta'
export type DiffDisplay = 'side-by-side' | 'inline'

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
  label: string
  mode: 'auto' | 'ref'
  commit?: string
}

export class GitCommandFailure extends Error {
  constructor(message: string, readonly stderr: string, readonly missingBinary: boolean) {
    super(message)
    this.name = 'GitCommandFailure'
  }
}

const defaultExecutor: GitProcessExecutor = (file, args, options) =>
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
          ),
        )
        return
      }
      resolve({ stdout, stderr })
    })
    child.stdin?.on('error', () => { /* the exit-code path reports the failure */ })
    child.stdin?.end(options.input ?? '')
  })

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

function validateRepoRelativePath(root: string, file: unknown): string {
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

export type GitBranches = {
  isRepo: boolean
  current?: string
  branches?: string[]
}

export class GitDiffInspector {
  private readonly summaryCache = new Map<string, { at: number; result: Promise<GitDiffSummary> }>()
  private readonly branchesCache = new Map<string, { at: number; result: Promise<GitBranches> }>()
  private readonly autoBaseCache = new Map<string, { at: number; result: Promise<ResolvedBase> }>()

  constructor(
    private readonly execute: GitProcessExecutor = defaultExecutor,
    private readonly environment: NodeJS.ProcessEnv = process.env,
    private readonly now: () => number = Date.now,
  ) {}

  async summary(cwd: string, target?: string): Promise<GitDiffSummary> {
    const key = `${cwd}${NUL}${target ?? ''}`
    const cached = this.summaryCache.get(key)
    if (cached && this.now() - cached.at < SUMMARY_CACHE_TTL_MS) return cached.result
    const result = this.computeSummary(cwd, target)
    this.summaryCache.set(key, { at: this.now(), result })
    result.catch(() => this.summaryCache.delete(key))
    return result
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
  ): Promise<string> {
    const repo = await this.repoContext(cwd)
    if (!repo) throw new GitDiffError('exec', 'Not a git repository')
    const relative = validateRepoRelativePath(repo.root, file)
    const { base } = await this.resolveBase(repo.root, repo.branch, target)

    try {
      const untracked = await this.isUntracked(repo.root, relative)
      return engine === 'delta'
        ? await this.deltaDiff(repo.root, relative, base, width, display, untracked)
        : await this.difftasticDiff(repo.root, relative, base, width, display, untracked)
    } catch (error) {
      throw this.asDiffError(error, engine)
    }
  }

  private async difftasticDiff(
    root: string,
    relative: string,
    base: string,
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
      ['diff', '--ext-diff', base, '--', relative],
      this.options(root, DIFF_TIMEOUT_MS, DIFF_BUFFER_BYTES, { ...difftEnv, GIT_EXTERNAL_DIFF: 'difft' }),
    )
    return stdout
  }

  private async deltaDiff(
    root: string,
    relative: string,
    base: string,
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
      ['diff', base, '--', relative],
      this.options(root, DIFF_TIMEOUT_MS, DIFF_BUFFER_BYTES),
    )
    if (patch === '') return ''
    const { stdout } = await this.execute(
      'delta',
      deltaArgs,
      { ...this.options(root, DIFF_TIMEOUT_MS, DIFF_BUFFER_BYTES), allowExitCodes: [1], input: patch },
    )
    return stdout
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

  private async computeSummary(cwd: string, target?: string): Promise<GitDiffSummary> {
    const repo = await this.repoContext(cwd)
    if (!repo) return { isRepo: false }
    const resolved = await this.resolveBase(repo.root, repo.branch, target)
    const base = resolved.base

    const [numstat, nameStatus, untracked, pullRequest] = await Promise.all([
      this.git(repo.root, ['diff', '--numstat', '--no-renames', '-z', base]),
      this.git(repo.root, ['diff', '--name-status', '--no-renames', '-z', base]),
      this.git(repo.root, ['ls-files', '--others', '--exclude-standard', '-z']),
      target === undefined ? this.currentPullRequest(repo.root, repo.branch) : undefined,
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

  private async resolveBase(root: string, branch: string, target?: string): Promise<ResolvedBase> {
    if (target !== undefined) {
      const validated = validateGitTarget(target)
      if (!(await this.refExists(root, validated))) {
        throw new GitDiffError('bad-target', `Unknown git ref: ${validated}`)
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

  private async mergeBase(root: string, target: string): Promise<string> {
    try {
      const { stdout } = await this.git(root, ['merge-base', target, 'HEAD'])
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

  private async currentPullRequest(root: string, branch: string): Promise<GitPullRequest | undefined> {
    if (!branch || branch === 'HEAD') return undefined
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
    } catch {
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
