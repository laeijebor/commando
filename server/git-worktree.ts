import { spawn } from 'node:child_process'
import { access, readdir, realpath, rename } from 'node:fs/promises'
import path from 'node:path'
import type { GitRepoInfo, TmuxCreatedWorktree } from '../shared/tmux-create.js'
import { GitCommandFailure, type GitExecutorOptions, type GitProcessExecutor } from './git-diff.js'

const COMMAND_TIMEOUT_MS = 5_000
const WORKTREE_TIMEOUT_MS = 30_000
/**
 * Checking out a large repository is slow: 40k files (700 MB) take 15 s on an idle Mac and well
 * over 30 s while builds and simulators share the disk. Killing it part-way throws all of that away.
 */
const WORKTREE_ADD_TIMEOUT_MS = 10 * 60_000
const DEFAULT_FETCH_TIMEOUT_MS = 15_000
const BUFFER_BYTES = 1024 * 1024
/** About 3 million tracked files at roughly 85 bytes each. */
const INDEX_LISTING_BYTES = 256 * 1024 * 1024
const DEFAULT_BRANCH_CANDIDATES = ['main', 'master']
const REMOTE = 'origin'
/** Conservative subset of `git check-ref-format --branch`. */
const BRANCH_NAME = /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*@\{)[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u

export type GitWorktreeErrorKind = 'bad-branch' | 'bad-path' | 'branch-checked-out' | 'branch-exists' | 'path-exists' | 'not-repo' | 'exec'

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
  /** Refuse an existing branch instead of reusing it: the name was picked for the caller, not chosen. */
  newBranchOnly?: boolean
  /** Refuse to create the branch: the caller is checking an existing one out again. */
  existingBranchOnly?: boolean
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
  /** Absolute folder new `<repo>-worktrees` folders go under; see `worktreesParentFromEnv`. */
  worktreesParent?: string
  /** Filesystem steps of worktree removal; tests replace them. */
  renamePath?: (from: string, to: string) => Promise<void>
  removeTree?: (target: string) => Promise<void>
}

/**
 * `COMMANDO_WORKTREE_ROOT`: where new worktrees go (`<root>/<repo>-worktrees/<branch>`)
 * instead of beside the main checkout. Unset or blank keeps the sibling layout.
 */
export function worktreesParentFromEnv(environment: NodeJS.ProcessEnv): string | undefined {
  const value = environment.COMMANDO_WORKTREE_ROOT?.trim()
  if (!value) return undefined
  if (!path.isAbsolute(value) || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error('COMMANDO_WORKTREE_ROOT must be an absolute path')
  }
  return path.normalize(value).replace(/\/+$/u, '') || '/'
}

/** Names a removed worktree folder while a background process deletes it. */
const DELETING_MARKER = '.commando-deleting-'

/** Delete `target` in a detached `rm -rf` that outlives the daemon; resolves when it exits. */
const defaultRemoveTree = (target: string) => new Promise<void>((resolve, reject) => {
  const child = spawn('rm', ['-rf', '--', target], { detached: true, stdio: 'ignore' })
  child.unref()
  child.once('error', reject)
  child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`rm -rf exited with ${code}`)))
})

/** Process groups of git commands still running, stopped when the daemon shuts down. */
const runningGroups = new Set<number>()

function stopGroup(pid: number): void {
  try {
    process.kill(-pid, 'SIGTERM')
  } catch {
    // Already gone.
  }
}

/**
 * Stops every git command this module started. They run detached so a timeout can stop a whole
 * checkout, which also means a daemon restart would not: a checkout left running would finish
 * into a worktree no session knows about. Stopped, git deletes its half-made folder itself.
 */
export function stopRunningGit(): void {
  for (const pid of runningGroups) stopGroup(pid)
  runningGroups.clear()
}

/**
 * Runs git in a process group of its own and stops the whole group on timeout. `git worktree add`
 * checks files out in a child `git reset --hard`, which kept writing after its parent was killed.
 */
const defaultExecutor: GitProcessExecutor = (file, args, { cwd, env, timeout, maxBuffer }) =>
  new Promise((resolve, reject) => {
    const child = spawn(file, [...args], { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    const pid = child.pid
    if (pid) runningGroups.add(pid)
    const output = { stdout: [] as Buffer[], stderr: [] as Buffer[] }
    let bytes = 0
    let stopped: 'timeout' | 'overflow' | undefined
    const stop = (reason: 'timeout' | 'overflow') => {
      stopped ??= reason
      if (pid) stopGroup(pid)
      else child.kill('SIGTERM')
    }
    for (const stream of ['stdout', 'stderr'] as const) {
      child[stream].on('data', (chunk: Buffer) => {
        output[stream].push(chunk)
        bytes += chunk.length
        if (bytes > maxBuffer) stop('overflow')
      })
    }
    const timer = setTimeout(() => stop('timeout'), timeout)
    const text = (stream: 'stdout' | 'stderr') => Buffer.concat(output[stream]).toString('utf8')
    child.once('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer)
      if (pid) runningGroups.delete(pid)
      reject(new GitCommandFailure(`${file} failed`, '', error.code === 'ENOENT'))
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      if (pid) runningGroups.delete(pid)
      if (code === 0 && !stopped) {
        resolve({ stdout: text('stdout'), stderr: text('stderr') })
        return
      }
      const message = stopped === 'timeout' ? `${file} timed out` : stopped === 'overflow' ? `${file} output exceeded ${maxBuffer} bytes` : `${file} failed`
      reject(new GitCommandFailure(message, text('stderr').slice(0, 4_000), false, stopped === 'timeout'))
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

function parseWorktreeList(output: string): Array<{ path: string; branch?: string; head?: string; locked?: boolean }> {
  return output
    .split(/\n\s*\n/u)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const entry: { path: string; branch?: string; head?: string; locked?: boolean } = { path: '' }
      for (const line of block.split('\n')) {
        if (line.startsWith('worktree ')) entry.path = line.slice('worktree '.length)
        else if (line.startsWith('HEAD ')) entry.head = line.slice('HEAD '.length)
        else if (line.startsWith('branch ')) entry.branch = line.slice('branch '.length).replace(/^refs\/heads\//u, '')
        else if (line === 'locked' || line.startsWith('locked ')) entry.locked = true
      }
      return entry
    })
    .filter((entry) => entry.path)
}

export class GitWorktreeService {
  private readonly pathExists: (target: string) => Promise<boolean>
  private readonly fetchTimeoutMs: number
  private readonly environment: NodeJS.ProcessEnv
  private readonly worktreesParent: string | undefined
  private readonly renamePath: (from: string, to: string) => Promise<void>
  private readonly removeTree: (target: string) => Promise<void>

  constructor(
    private readonly execute: GitProcessExecutor = defaultExecutor,
    options: GitWorktreeServiceOptions = {},
  ) {
    this.pathExists = options.pathExists ?? defaultPathExists
    this.fetchTimeoutMs = options.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS
    this.environment = options.environment ?? process.env
    this.worktreesParent = options.worktreesParent
    this.renamePath = options.renamePath ?? rename
    this.removeTree = options.removeTree ?? defaultRemoveTree
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
      ...(this.worktreesParent ? { worktreesParent: this.worktreesParent } : {}),
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
    // An existing branch may use any name git accepts (`feature/c++`); only names we pick follow the conservative rule.
    const branch = input.existingBranchOnly ? await this.validateExistingBranchName(input.mainRoot, input.branch) : validateBranchName(input.branch)
    if (!path.isAbsolute(input.path)) throw new GitWorktreeError('bad-path', 'Worktree path must be absolute')
    const target = path.normalize(input.path)
    const cwd = input.mainRoot

    const branchExists = await this.refExists(cwd, `refs/heads/${branch}`)
    if (branchExists && input.newBranchOnly) throw new GitWorktreeError('branch-exists', `Branch ${branch} already exists`)
    if (!branchExists && input.existingBranchOnly) throw new GitWorktreeError('bad-branch', `Branch ${branch} no longer exists`)
    const worktrees = branchExists || await this.pathExists(target)
      ? parseWorktreeList((await this.git(cwd, ['worktree', 'list', '--porcelain'])).stdout)
      : []
    // A branch can be registered twice (a stale entry plus a forced checkout); any other path counts as checked out.
    const attached = worktrees.find((entry) => entry.branch === branch && path.normalize(entry.path) !== target)
      ?? worktrees.find((entry) => entry.branch === branch)
    if (attached && path.normalize(attached.path) === target) {
      if (await this.pathExists(target)) return { worktree: { path: target, branch, base: '', reusedBranch: true }, rollback: async () => undefined }
      if (!input.existingBranchOnly) {
        throw new GitWorktreeError('exec', `Worktree ${target} is registered but missing on disk; run git worktree prune in ${cwd}`)
      }
      // Checking it out again where it was: --force reuses only this registration, leaving any other missing worktree's alone.
      await this.worktreeAdd(cwd, ['--force', target, branch])
      return { worktree: { path: target, branch, base: '', reusedBranch: true }, rollback: () => this.remove(cwd, target) }
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
    // The branch is made first, on its own: git refuses a name another process took meanwhile, so
    // the cleanup below only ever deletes a branch this call made. (`worktree add -b` would keep the
    // branch when its checkout fails, and fail the same way when the name was taken.)
    try {
      await this.git(cwd, ['branch', '--', branch, base])
    } catch (error) {
      if (await this.refExists(cwd, `refs/heads/${branch}`)) throw new GitWorktreeError('branch-exists', `Branch ${branch} already exists`)
      throw new GitWorktreeError('exec', `Cannot create branch ${branch} from ${base}: ${failureDetail(error)}`)
    }
    try {
      await this.worktreeAdd(cwd, [target, branch])
    } catch (error) {
      // git deletes a half-made folder itself; the branch would make a retry find the name taken.
      await this.git(cwd, ['worktree', 'prune']).catch(() => undefined)
      await this.git(cwd, ['branch', '-D', '--', branch]).catch(() => undefined)
      throw error
    }
    return {
      worktree: { path: target, branch, base, reusedBranch: false, ...(warning ? { warning } : {}) },
      rollback: async () => {
        await this.remove(cwd, target)
        await this.git(cwd, ['branch', '-D', '--', branch]).catch(() => undefined)
      },
    }
  }

  /**
   * Commit everything git tracks or could track (gitignored files excepted) so
   * the worktree can be removed without losing work. Returns the identity with
   * its new head, or the same identity when there was nothing to commit.
   */
  async commitWorkInProgress(worktree: GitWorktreeIdentity, message: string): Promise<GitWorktreeIdentity> {
    if (worktree.branch === 'HEAD' || !worktree.branch) {
      throw new GitWorktreeError('exec', 'Worktree has a detached HEAD, so a work-in-progress commit would not be kept on any branch')
    }
    const status = async () => (await this.git(worktree.root, ['status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=none'])).stdout
    try {
      // Lines read `<tag> <mode> <object> <stage>\t<path>`, one per tracked file, so a large repository
      // needs far more room than other commands.
      const index = (await this.git(worktree.root, ['ls-files', '-v', '--stage', '-z'], WORKTREE_TIMEOUT_MS, INDEX_LISTING_BYTES)).stdout.split('\0')
      // A gitlink (submodule, or a nested repository someone staged) keeps only a commit id: its files and
      // objects live in the folder that removal deletes, so such a worktree is never saved this way.
      const gitlink = index.find((line) => line.split(' ')[1] === '160000')
      if (gitlink) throw new GitWorktreeError('exec', `Worktree contains a submodule or nested repository at ${gitlink.split('\t')[1]}`)
      // assume-unchanged (a lowercase tag) and skip-worktree (S) hide a file's edits from status and add. Sparse
      // checkout marks every file outside its cone S, but those are not on disk, so there is nothing to lose.
      let hidden = index.find((line) => /^[a-z] /u.test(line))
      for (const line of index) {
        if (hidden) break
        if (line.startsWith('S ') && await this.pathExists(path.join(worktree.root, line.split('\t')[1]))) hidden = line
      }
      if (hidden) throw new GitWorktreeError('exec', `Worktree has a file git is told to ignore changes to (assume-unchanged or skip-worktree) at ${hidden.split('\t')[1]}`)
      // Found on disk: started inside a tracked folder, a repository looks like ordinary files to the outer one.
      const nestedRepository = await this.nestedRepository(worktree.root)
      if (nestedRepository) throw new GitWorktreeError('exec', `Worktree contains another git repository at ${nestedRepository}`)
      const before = await status()
      if (!before.trim()) return worktree
      if (before.split('\n').some((line) => /^(?:DD|AU|UD|UA|DU|AA|UU) /u.test(line))) {
        throw new GitWorktreeError('exec', 'Worktree has unresolved merge conflicts')
      }
      await this.git(worktree.root, ['add', '--all'], WORKTREE_TIMEOUT_MS)
      // No hooks or signing: either could block or prompt with nobody watching.
      await this.git(worktree.root, ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '--no-verify', '--quiet', '-m', message], WORKTREE_TIMEOUT_MS)
      // Work inside submodules is not part of this commit; leave such a worktree in place.
      if ((await status()).trim()) throw new GitWorktreeError('exec', 'Some changes could not be committed, such as work inside a submodule')
      const head = (await this.git(worktree.root, ['rev-parse', '--verify', 'HEAD'])).stdout.trim()
      return { ...worktree, head }
    } catch (error) {
      if (error instanceof GitWorktreeError) throw error
      throw new GitWorktreeError('exec', `Could not commit work in progress: ${failureDetail(error)}`)
    }
  }

  /**
   * Remove a linked worktree without waiting for its files to be deleted.
   *
   * `git worktree remove` deletes every file (node_modules included) before it
   * unregisters the worktree, which can take minutes. Cut short, it leaves a
   * half-deleted folder that git still lists. Instead the folder is renamed
   * aside, which is instant within one directory, `git worktree prune` drops
   * the registration, and a detached process deletes the renamed folder, so a
   * daemon restart does not interrupt it.
   */
  async removeWorktree(worktree: GitWorktreeIdentity): Promise<void> {
    const root = path.normalize(worktree.root)
    const mainRoot = path.normalize(worktree.mainRoot)
    if (!path.isAbsolute(root) || !path.isAbsolute(mainRoot) || root === mainRoot) {
      throw new GitWorktreeError('bad-path', 'Refusing to remove the main repository checkout')
    }
    try {
      const registered = await this.registeredWorktree(mainRoot, root)
      if (!registered) throw new GitWorktreeError('bad-path', `${root} is not a registered git worktree`)
      const sameBranch = registered.branch === worktree.branch || (registered.branch === undefined && worktree.branch === 'HEAD')
      if (!sameBranch || registered.head !== worktree.head) {
        throw new GitWorktreeError('bad-path', `Worktree identity changed at ${root}; refusing to remove it`)
      }
      if (registered.locked) throw new GitWorktreeError('bad-path', `Worktree ${root} is locked; unlock it before deleting it`)
      await this.discard(mainRoot, root)
    } catch (error) {
      if (error instanceof GitWorktreeError) throw error
      throw new GitWorktreeError('exec', `git worktree remove failed: ${failureDetail(error)}`)
    }
  }

  /** Move `root` aside, unregister it, and delete its files in the background. */
  private async discard(mainRoot: string, root: string): Promise<void> {
    const aside = path.join(path.dirname(root), `.${path.basename(root)}${DELETING_MARKER}${Date.now()}`)
    try {
      await this.renamePath(root, aside)
    } catch (error) {
      throw new GitWorktreeError('exec', `Could not move ${root} aside for deletion: ${error instanceof Error ? error.message : 'rename failed'}`)
    }
    // Prune can exit 0 without dropping the entry (e.g. its admin dir is not
    // writable) or fail after dropping it, so trust only the worktree list.
    const pruneError = await this.git(mainRoot, ['worktree', 'prune'], WORKTREE_TIMEOUT_MS).then(() => undefined, (error: unknown) => error)
    if (await this.registeredWorktree(mainRoot, root).catch(() => true)) {
      await this.renamePath(aside, root).catch(() => undefined)
      throw pruneError ?? new GitWorktreeError('exec', `git worktree prune left ${root} registered; the folder was put back`)
    }
    void this.removeTree(aside)
      .catch((error) => console.warn(`[commando] Could not delete removed worktree folder ${aside}`, error))
  }

  /**
   * The first folder below `root` holding its own `.git`, skipping gitignored folders: their contents
   * (node_modules and the like) go with the worktree by design, and are never walked.
   */
  private async nestedRepository(root: string): Promise<string | undefined> {
    const listing = (await this.git(root, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'], WORKTREE_TIMEOUT_MS, INDEX_LISTING_BYTES)).stdout
    const ignored = new Set(listing.split('\0').filter((entry) => entry.endsWith('/')).map((entry) => path.join(root, entry.slice(0, -1))))
    const walk = async (directory: string): Promise<string | undefined> => {
      const entries = await readdir(directory, { withFileTypes: true })
      if (directory !== root && entries.some((entry) => entry.name === '.git')) return path.relative(root, directory)
      for (const entry of entries) {
        const child = path.join(directory, entry.name)
        if (!entry.isDirectory() || entry.name === '.git' || ignored.has(child)) continue
        const found = await walk(child)
        if (found) return found
      }
      return undefined
    }
    return walk(root)
  }

  private async validateExistingBranchName(cwd: string, value: unknown): Promise<string> {
    if (typeof value !== 'string' || !value || value.startsWith('-')) throw new GitWorktreeError('bad-branch', 'Branch name is not a valid git ref')
    try { await this.git(cwd, ['check-ref-format', '--branch', value]) }
    catch { throw new GitWorktreeError('bad-branch', 'Branch name is not a valid git ref') }
    return value
  }

  private async registeredWorktree(mainRoot: string, root: string) {
    return parseWorktreeList((await this.git(mainRoot, ['worktree', 'list', '--porcelain'])).stdout)
      .find((entry) => path.normalize(entry.path) === root)
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
      // --quiet keeps git's progress meter out of stderr, where it buried the real error.
      // checkout.workers=0 writes files on every core (git 2.32+; older versions ignore it).
      await this.git(cwd, ['-c', 'checkout.workers=0', 'worktree', 'add', '--quiet', ...args], WORKTREE_ADD_TIMEOUT_MS)
    } catch (error) {
      if (error instanceof GitCommandFailure && error.timedOut) {
        throw new GitWorktreeError('exec', `git worktree add was still checking out files after ${WORKTREE_ADD_TIMEOUT_MS / 60_000} minutes and was stopped`)
      }
      throw new GitWorktreeError('exec', `git worktree add failed: ${failureDetail(error)}`)
    }
  }

  /** Rollback of a worktree this service just made: `git worktree remove` would delete every file before returning. */
  private async remove(cwd: string, target: string): Promise<void> {
    await this.discard(cwd, target).catch(() => undefined)
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

  /**
   * Which of `candidates` (main checkouts) a deleted worktree at `worktreePath` on `branch` came from:
   * the one still registering that path, else the only one with the branch. Undefined when it can't tell.
   */
  async mainCheckoutFor(candidates: readonly string[], worktreePath: string, branch: string): Promise<string | undefined> {
    const target = path.normalize(worktreePath)
    const withBranch: string[] = []
    for (const candidate of candidates) {
      const root = await realpath(candidate).catch(() => undefined)
      const identity = root ? await this.repositoryIdentity(root) : undefined
      if (!root || !identity || identity.root !== identity.mainRoot || path.normalize(identity.root) !== path.normalize(root)) continue
      const registered = parseWorktreeList((await this.git(root, ['worktree', 'list', '--porcelain'])).stdout)
        .some((entry) => path.normalize(entry.path) === target)
      if (registered) return root
      if (await this.refExists(root, `refs/heads/${branch}`)) withBranch.push(root)
    }
    return withBranch.length === 1 ? withBranch[0] : undefined
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

  private git(cwd: string, args: string[], timeout = COMMAND_TIMEOUT_MS, maxBuffer = BUFFER_BYTES): Promise<{ stdout: string; stderr: string }> {
    const options: GitExecutorOptions = {
      cwd,
      encoding: 'utf8',
      env: { ...this.environment, GIT_TERMINAL_PROMPT: '0' },
      maxBuffer,
      shell: false,
      timeout,
      windowsHide: true,
    }
    return this.execute('git', args, options)
  }
}
