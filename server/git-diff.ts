import { execFile } from 'node:child_process'
import path from 'node:path'

const COMMAND_TIMEOUT_MS = 5_000
const DIFF_TIMEOUT_MS = 20_000
const COMMAND_BUFFER_BYTES = 4 * 1024 * 1024
const DIFF_BUFFER_BYTES = 32 * 1024 * 1024
const SUMMARY_CACHE_TTL_MS = 5_000
const DEFAULT_TARGETS = ['main', 'master'] as const
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
}

export type GitProcessExecutor = (
  file: string,
  args: readonly string[],
  options: GitExecutorOptions,
) => Promise<{ stdout: string; stderr: string }>

export type GitDiffErrorKind = 'bad-target' | 'bad-file' | 'difft-missing' | 'exec'

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

export type GitDiffSummary = {
  isRepo: boolean
  root?: string
  branch?: string
  target?: string | null
  additions?: number
  deletions?: number
  files?: GitChangedFile[]
}

export class GitCommandFailure extends Error {
  constructor(message: string, readonly stderr: string, readonly missingBinary: boolean) {
    super(message)
    this.name = 'GitCommandFailure'
  }
}

const defaultExecutor: GitProcessExecutor = (file, args, options) =>
  new Promise((resolve, reject) => {
    execFile(file, [...args], options, (error, stdout, stderr) => {
      if (error) {
        const missingBinary = (error as NodeJS.ErrnoException).code === 'ENOENT'
        reject(
          new GitCommandFailure(
            error.killed ? `${file} timed out` : `${file} failed`,
            (stderr ?? '').slice(0, 4_000),
            missingBinary,
          ),
        )
        return
      }
      resolve({ stdout, stderr })
    })
  })

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

export type GitBranches = {
  isRepo: boolean
  current?: string
  branches?: string[]
}

export class GitDiffInspector {
  private readonly summaryCache = new Map<string, { at: number; result: Promise<GitDiffSummary> }>()
  private readonly branchesCache = new Map<string, { at: number; result: Promise<GitBranches> }>()

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
      '--format=%(refname:short)',
      '--sort=-committerdate',
      'refs/heads',
      'refs/remotes',
    ])
    const seen = new Set<string>()
    const branches: string[] = []
    for (const name of stdout.split('\n')) {
      const branch = name.trim()
      if (!branch || branch.endsWith('/HEAD') || seen.has(branch)) continue
      seen.add(branch)
      branches.push(branch)
    }
    return { isRepo: true, current: repo.branch, branches }
  }

  async fileDiff(cwd: string, file: string, target: string | undefined, width: number): Promise<string> {
    const repo = await this.repoContext(cwd)
    if (!repo) throw new GitDiffError('exec', 'Not a git repository')
    const relative = validateRepoRelativePath(repo.root, file)
    const resolvedTarget = await this.resolveTarget(repo.root, target)
    if (!resolvedTarget) throw new GitDiffError('bad-target', 'No target branch found (tried main, master)')
    const base = await this.mergeBase(repo.root, resolvedTarget)

    const difftEnv = {
      ...this.environment,
      DFT_BACKGROUND: 'dark',
      DFT_COLOR: 'always',
      DFT_WIDTH: String(width),
    }

    try {
      if (await this.isUntracked(repo.root, relative)) {
        const { stdout } = await this.execute(
          'difft',
          ['--color', 'always', '--width', String(width), '--background', 'dark', '/dev/null', path.join(repo.root, relative)],
          this.options(repo.root, DIFF_TIMEOUT_MS, DIFF_BUFFER_BYTES, difftEnv),
        )
        return stdout
      }
      const { stdout } = await this.execute(
        'git',
        ['diff', '--ext-diff', base, '--', relative],
        this.options(repo.root, DIFF_TIMEOUT_MS, DIFF_BUFFER_BYTES, { ...difftEnv, GIT_EXTERNAL_DIFF: 'difft' }),
      )
      return stdout
    } catch (error) {
      throw this.asDiffError(error)
    }
  }

  private asDiffError(error: unknown): GitDiffError {
    if (error instanceof GitDiffError) return error
    if (error instanceof GitCommandFailure) {
      if (error.missingBinary || /difft.*(not found|No such file)|external diff died/iu.test(error.stderr)) {
        return new GitDiffError(
          'difft-missing',
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
    const resolvedTarget = await this.resolveTarget(repo.root, target)
    if (!resolvedTarget) {
      return { isRepo: true, root: repo.root, branch: repo.branch, target: null, additions: 0, deletions: 0, files: [] }
    }
    const base = await this.mergeBase(repo.root, resolvedTarget)

    const [numstat, nameStatus, untracked] = await Promise.all([
      this.git(repo.root, ['diff', '--numstat', '--no-renames', '-z', base]),
      this.git(repo.root, ['diff', '--name-status', '--no-renames', '-z', base]),
      this.git(repo.root, ['ls-files', '--others', '--exclude-standard', '-z']),
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

    return { isRepo: true, root: repo.root, branch: repo.branch, target: resolvedTarget, additions, deletions, files }
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

  private async resolveTarget(root: string, target?: string): Promise<string | null> {
    if (target !== undefined) {
      const validated = validateGitTarget(target)
      if (!(await this.refExists(root, validated))) {
        throw new GitDiffError('bad-target', `Unknown git ref: ${validated}`)
      }
      return validated
    }
    for (const candidate of DEFAULT_TARGETS) {
      if (await this.refExists(root, candidate)) return candidate
    }
    return null
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
