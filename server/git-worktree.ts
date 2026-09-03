import { execFile } from 'node:child_process'
import { access } from 'node:fs/promises'
import path from 'node:path'
import type { GitRepoInfo, TmuxCreatedWorktree } from '../shared/tmux-create.js'
import { GitCommandFailure, type GitExecutorOptions, type GitProcessExecutor } from './git-diff.js'

const COMMAND_TIMEOUT_MS = 5_000
const WORKTREE_TIMEOUT_MS = 30_000
const DEFAULT_FETCH_TIMEOUT_MS = 15_000
const BUFFER_BYTES = 1024 * 1024
const DEFAULT_BRANCH_CANDIDATES = ['main', 'master']
const REMOTE = 'origin'
/** Conservative subset of `git check-ref-format --branch`. */
const BRANCH_NAME = /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*@\{)[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u

export type GitWorktreeErrorKind = 'bad-branch' | 'bad-path' | 'branch-checked-out' | 'path-exists' | 'not-repo' | 'exec'

export class GitWorktreeError extends Error {
  constructor(readonly kind: GitWorktreeErrorKind, message: string) {
    super(message)
    this.name = 'GitWorktreeError'
  }
}

export type CreateWorktreeInput = {
  mainRoot: string
  branch: string
  path: string
  defaultBranch?: string
  remote?: string
}

export type CreateWorktreeResult = {
  worktree: TmuxCreatedWorktree
  /** Undo whatever this call created (worktree, and the branch when it was new). */
  rollback: () => Promise<void>
}

export type GitWorktreeIdentity = {
  root: string
  mainRoot: string
  branch: string
  head: string
}

export type GitWorktreeServiceOptions = {
  pathExists?: (target: string) => Promise<boolean>
  fetchTimeoutMs?: number
  environment?: NodeJS.ProcessEnv
}

const defaultExecutor: GitProcessExecutor = (file, args, options) =>
  new Promise((resolve, reject) => {
    execFile(file, [...args], options, (error, stdout, stderr) => {
      if (error) {
        const code = (error as NodeJS.ErrnoException).code
        reject(new GitCommandFailure(
          error.killed ? `${file} timed out` : `${file} failed`,
          (stderr ?? '').slice(0, 4_000),
          code === 'ENOENT',
        ))
        return
      }
      resolve({ stdout, stderr })
    })
  })

async function defaultPathExists(target: string): Promise<boolean> {
  try {
    await access(target)
    return true
  } catch {
    return false
  }
}

function failureDetail(error: unknown): string {
  if (error instanceof GitCommandFailure && error.stderr) return error.stderr.trim()
  if (error && typeof error === 'object' && 'stderr' in error && typeof error.stderr === 'string' && error.stderr) {
    return error.stderr.trim()
  }
  return error instanceof Error ? error.message : 'git failed'
}

export function validateBranchName(value: unknown): string {
  if (typeof value !== 'string' || !BRANCH_NAME.test(value) || value.endsWith('.lock') || value.endsWith('.') || value.endsWith('/')) {
    throw new GitWorktreeError('bad-branch', 'Branch name is not a valid git ref')
  }
  return value
}

function parseWorktreeList(output: string): Array<{ path: string; branch?: string; head?: string }> {
  return output
    .split(/\n\s*\n/u)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const entry: { path: string; branch?: string; head?: string } = { path: '' }
      for (const line of block.split('\n')) {
        if (line.startsWith('worktree ')) entry.path = line.slice('worktree '.length)
        else if (line.startsWith('HEAD ')) entry.head = line.slice('HEAD '.length)
        else if (line.startsWith('branch ')) entry.branch = line.slice('branch '.length).replace(/^refs\/heads\//u, '')
      }
      return entry
    })
    .filter((entry) => entry.path)
}

export class GitWorktreeService {
  private readonly pathExists: (target: string) => Promise<boolean>
  private readonly fetchTimeoutMs: number
  private readonly environment: NodeJS.ProcessEnv

  constructor(
    private readonly execute: GitProcessExecutor = defaultExecutor,
    options: GitWorktreeServiceOptions = {},
  ) {
    this.pathExists = options.pathExists ?? defaultPathExists
    this.fetchTimeoutMs = options.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS
    this.environment = options.environment ?? process.env
  }

  /** Describe the repository containing `directory`, or `{ isRepo: false }`. */
  async probe(directory: string): Promise<GitRepoInfo> {
    const identity = await this.repositoryIdentity(directory)
    if (!identity) return { isRepo: false }
    const { root, mainRoot, branch } = identity
    const defaultBranch = await this.defaultBranch(mainRoot)
    return {
      isRepo: true,
      root,
      mainRoot,
      name: path.basename(mainRoot),
      branch: branch ?? '',
      isWorktree: root !== mainRoot,
      ...(defaultBranch ? { defaultBranch, remote: REMOTE } : {}),
    }
  }

  async worktreeForDirectory(directory: string): Promise<GitWorktreeIdentity | undefined> {
    const identity = await this.repositoryIdentity(directory)
    if (!identity || identity.root === identity.mainRoot) return undefined
    try {
      const head = (await this.git(directory, ['rev-parse', '--verify', 'HEAD'])).stdout.trim()
      return head ? { ...identity, head } : undefined
    } catch {
      return undefined
    }
  }

  async createWorktree(input: CreateWorktreeInput): Promise<CreateWorktreeResult> {
    const branch = validateBranchName(input.branch)
    if (!path.isAbsolute(input.path)) throw new GitWorktreeError('bad-path', 'Worktree path must be absolute')
    const target = path.normalize(input.path)
    const cwd = input.mainRoot

    const branchExists = await this.refExists(cwd, `refs/heads/${branch}`)
    const worktrees = branchExists || await this.pathExists(target)
      ? parseWorktreeList((await this.git(cwd, ['worktree', 'list', '--porcelain'])).stdout)
      : []
    const attached = worktrees.find((entry) => entry.branch === branch)
    if (attached && path.normalize(attached.path) === target) {
      if (!await this.pathExists(target)) {
        throw new GitWorktreeError('exec', `Worktree ${target} is registered but missing on disk; run git worktree prune in ${cwd}`)
      }
      return { worktree: { path: target, branch, base: '', reusedBranch: true }, rollback: async () => undefined }
    }
    if (attached) {
      throw new GitWorktreeError('branch-checked-out', `Branch ${branch} is already checked out at ${attached.path}`)
    }
    if (await this.pathExists(target)) {
      throw new GitWorktreeError('path-exists', `${target} already exists`)
    }

    if (branchExists) {
      await this.worktreeAdd(cwd, [target, branch])
      return {
        worktree: { path: target, branch, base: '', reusedBranch: true },
        rollback: () => this.remove(cwd, target),
      }
    }

    let warning: string | undefined
    let base = 'HEAD'
    if (input.defaultBranch) {
      const remote = input.remote ?? REMOTE
      const remoteRef = `${remote}/${input.defaultBranch}`
      try {
        await this.git(cwd, ['fetch', remote, input.defaultBranch], this.fetchTimeoutMs)
        base = remoteRef
      } catch (error) {
        if (await this.refExists(cwd, `refs/remotes/${remoteRef}`)) {
          base = remoteRef
          warning = `Could not fetch ${remoteRef} (${failureDetail(error)}); branched from the local copy of ${remoteRef} instead`
        } else {
          throw new GitWorktreeError(
            'exec',
            `Cannot create branch ${branch}: refs/remotes/${remoteRef} does not exist locally and fetch ${remoteRef} failed: ${failureDetail(error)}`,
          )
        }
      }
    }
    await this.worktreeAdd(cwd, ['-b', branch, target, base])
    return {
      worktree: { path: target, branch, base, reusedBranch: false, ...(warning ? { warning } : {}) },
      rollback: async () => {
        await this.remove(cwd, target)
        await this.git(cwd, ['branch', '-D', branch]).catch(() => undefined)
      },
    }
  }

  async removeWorktree(worktree: GitWorktreeIdentity): Promise<void> {
    const root = path.normalize(worktree.root)
    const mainRoot = path.normalize(worktree.mainRoot)
    if (!path.isAbsolute(root) || !path.isAbsolute(mainRoot) || root === mainRoot) {
      throw new GitWorktreeError('bad-path', 'Refusing to remove the main repository checkout')
    }
    try {
      const registered = parseWorktreeList((await this.git(mainRoot, ['worktree', 'list', '--porcelain'])).stdout)
        .find((entry) => path.normalize(entry.path) === root)
      if (!registered) throw new GitWorktreeError('bad-path', `${root} is not a registered git worktree`)
      const sameBranch = registered.branch === worktree.branch || (registered.branch === undefined && worktree.branch === 'HEAD')
      if (!sameBranch || registered.head !== worktree.head) {
        throw new GitWorktreeError('bad-path', `Worktree identity changed at ${root}; refusing to remove it`)
      }
      await this.git(mainRoot, ['worktree', 'remove', '--force', root], WORKTREE_TIMEOUT_MS)
    } catch (error) {
      if (error instanceof GitWorktreeError) throw error
      throw new GitWorktreeError('exec', `git worktree remove failed: ${failureDetail(error)}`)
    }
  }

  private async repositoryIdentity(directory: string): Promise<Omit<GitWorktreeIdentity, 'head'> | undefined> {
    let stdout: string
    try {
      stdout = (await this.git(directory, [
        'rev-parse',
        '--path-format=absolute',
        '--show-toplevel',
        '--git-common-dir',
        '--abbrev-ref',
        'HEAD',
      ])).stdout
    } catch {
      return undefined
    }
    const [root, commonDir, branch = ''] = stdout.split(/\r?\n/u)
    if (!root || !commonDir) return undefined
    return {
      root,
      mainRoot: path.basename(commonDir) === '.git' ? path.dirname(commonDir) : root,
      branch,
    }
  }

  private async worktreeAdd(cwd: string, args: string[]): Promise<void> {
    try {
      await this.git(cwd, ['worktree', 'add', ...args], WORKTREE_TIMEOUT_MS)
    } catch (error) {
      throw new GitWorktreeError('exec', `git worktree add failed: ${failureDetail(error)}`)
    }
  }

  private async remove(cwd: string, target: string): Promise<void> {
    await this.git(cwd, ['worktree', 'remove', '--force', target], WORKTREE_TIMEOUT_MS).catch(() => undefined)
  }

  private async defaultBranch(cwd: string): Promise<string | undefined> {
    try {
      const { stdout } = await this.git(cwd, ['symbolic-ref', '--short', `refs/remotes/${REMOTE}/HEAD`])
      const ref = stdout.trim()
      if (ref.startsWith(`${REMOTE}/`)) return ref.slice(REMOTE.length + 1)
    } catch {
      // No origin/HEAD recorded (fresh clone via some tools); try the usual names.
    }
    for (const candidate of DEFAULT_BRANCH_CANDIDATES) {
      if (await this.refExists(cwd, `refs/remotes/${REMOTE}/${candidate}`)) return candidate
    }
    return undefined
  }

  private async refExists(cwd: string, ref: string): Promise<boolean> {
    try {
      const verb = ref.startsWith('refs/heads/') ? ['rev-parse', '--verify', '--quiet', ref] : ['show-ref', '--verify', '--quiet', ref]
      await this.git(cwd, verb)
      return true
    } catch {
      return false
    }
  }

  private git(cwd: string, args: string[], timeout = COMMAND_TIMEOUT_MS): Promise<{ stdout: string; stderr: string }> {
    const options: GitExecutorOptions = {
      cwd,
      encoding: 'utf8',
      env: { ...this.environment, GIT_TERMINAL_PROMPT: '0' },
      maxBuffer: BUFFER_BYTES,
      shell: false,
      timeout,
      windowsHide: true,
    }
    return this.execute('git', args, options)
  }
}
