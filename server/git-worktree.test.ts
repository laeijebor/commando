import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtemp, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GitCommandFailure, type GitExecutorOptions } from './git-diff.js'
import { GitWorktreeError, GitWorktreeService, worktreesParentFromEnv } from './git-worktree.js'

type Call = { args: string[]; cwd: string; timeout: number }

/**
 * Scripted git: each rule matches the start of the argument list and returns
 * stdout, or throws to simulate a non-zero exit.
 */
function fakeGit(rules: Array<[string[], string | Error]>) {
  const calls: Call[] = []
  const execute = vi.fn(async (file: string, args: readonly string[], options: GitExecutorOptions) => {
    expect(file).toBe('git')
    calls.push({ args: [...args], cwd: options.cwd, timeout: options.timeout })
    for (const [prefix, result] of rules) {
      if (prefix.every((value, index) => args[index] === value)) {
        if (result instanceof Error) throw result
        return { stdout: result, stderr: '' }
      }
    }
    throw new Error(`unexpected git ${args.join(' ')}`)
  })
  return { execute, calls }
}

function exit(code: number, stderr = ''): Error {
  const error = new Error('git failed') as Error & { code: number; stderr: string }
  error.code = code
  error.stderr = stderr
  return error
}

const MAIN = '/Users/dev/gizmo/Save-All'
const ADD = ['-c', 'checkout.workers=0', 'worktree', 'add', '--quiet']
const isAdd = (call: Call) => ADD.every((value, index) => call.args[index] === value)

describe('GitWorktreeService.probe', () => {
  it('reports a non-repository directory', async () => {
    const git = fakeGit([[['rev-parse'], exit(128, 'fatal: not a git repository')]])
    const service = new GitWorktreeService(git.execute)
    await expect(service.probe('/tmp/plain')).resolves.toEqual({ isRepo: false })
  })

  it('resolves the main checkout, name, branch and remote default branch', async () => {
    const git = fakeGit([
      [['rev-parse', '--path-format=absolute'], `${MAIN}\n${MAIN}/.git\nmain\n`],
      [['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], 'origin/main\n'],
    ])
    const service = new GitWorktreeService(git.execute)
    await expect(service.probe(`${MAIN}/apps/web`)).resolves.toEqual({
      isRepo: true,
      root: MAIN,
      mainRoot: MAIN,
      name: 'Save-All',
      branch: 'main',
      isWorktree: false,
      defaultBranch: 'main',
      remote: 'origin',
    })
    expect(git.calls[0].cwd).toBe(`${MAIN}/apps/web`)
  })

  it('reports the configured worktrees parent so clients preview the same default path', async () => {
    const git = fakeGit([
      [['rev-parse', '--path-format=absolute'], `${MAIN}\n${MAIN}/.git\nmain\n`],
      [['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], 'origin/main\n'],
    ])
    const service = new GitWorktreeService(git.execute, { worktreesParent: '/Volumes/Dev/worktrees' })
    await expect(service.probe(MAIN)).resolves.toMatchObject({ isRepo: true, worktreesParent: '/Volumes/Dev/worktrees' })
  })

  it('maps a linked worktree back to its main checkout', async () => {
    const worktree = '/Users/dev/gizmo/Save-All-worktrees/coins'
    const git = fakeGit([
      [['rev-parse', '--path-format=absolute'], `${worktree}\n${MAIN}/.git\nreferral-coins-reward\n`],
      [['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], 'origin/main\n'],
    ])
    const service = new GitWorktreeService(git.execute)
    await expect(service.probe(worktree)).resolves.toMatchObject({
      root: worktree,
      mainRoot: MAIN,
      name: 'Save-All',
      branch: 'referral-coins-reward',
      isWorktree: true,
    })
  })

  it('captures a linked worktree identity without fetching remote metadata', async () => {
    const worktree = '/Users/dev/gizmo/Save-All-worktrees/coins'
    const git = fakeGit([
      [['rev-parse', '--path-format=absolute'], `${worktree}\n${MAIN}/.git\nreferral-coins-reward\n`],
      [['rev-parse', '--verify', 'HEAD'], 'abc123\n'],
    ])

    await expect(new GitWorktreeService(git.execute).worktreeForDirectory(`${worktree}/apps/web`)).resolves.toEqual({
      root: worktree,
      mainRoot: MAIN,
      branch: 'referral-coins-reward',
      head: 'abc123',
    })
    expect(git.calls.some((call) => call.args[0] === 'symbolic-ref')).toBe(false)
  })

  it('falls back to origin/main, then origin/master, then no default branch', async () => {
    const withMaster = fakeGit([
      [['rev-parse', '--path-format=absolute'], `${MAIN}\n${MAIN}/.git\nmain\n`],
      [['symbolic-ref'], exit(128)],
      [['show-ref', '--verify', '--quiet', 'refs/remotes/origin/main'], exit(1)],
      [['show-ref', '--verify', '--quiet', 'refs/remotes/origin/master'], ''],
    ])
    await expect(new GitWorktreeService(withMaster.execute).probe(MAIN)).resolves.toMatchObject({
      defaultBranch: 'master',
      remote: 'origin',
    })

    const noRemote = fakeGit([
      [['rev-parse', '--path-format=absolute'], `${MAIN}\n${MAIN}/.git\nmain\n`],
      [['symbolic-ref'], exit(128)],
      [['show-ref'], exit(1)],
    ])
    const info = await new GitWorktreeService(noRemote.execute).probe(MAIN)
    expect(info.defaultBranch).toBeUndefined()
    expect(info.remote).toBeUndefined()
  })
})

describe('worktreesParentFromEnv', () => {
  it('is unset unless COMMANDO_WORKTREE_ROOT names an absolute folder', () => {
    expect(worktreesParentFromEnv({})).toBeUndefined()
    expect(worktreesParentFromEnv({ COMMANDO_WORKTREE_ROOT: '  ' })).toBeUndefined()
    expect(worktreesParentFromEnv({ COMMANDO_WORKTREE_ROOT: '/Volumes/Dev/worktrees/' })).toBe('/Volumes/Dev/worktrees')
    expect(() => worktreesParentFromEnv({ COMMANDO_WORKTREE_ROOT: 'worktrees' })).toThrow(/absolute path/)
    expect(() => worktreesParentFromEnv({ COMMANDO_WORKTREE_ROOT: '/Volumes/Dev\n' })).not.toThrow()
    expect(() => worktreesParentFromEnv({ COMMANDO_WORKTREE_ROOT: '/Volumes/De\u0001v' })).toThrow(/absolute path/)
  })
})

describe('GitWorktreeService.createWorktree', () => {
  const target = `${MAIN}-worktrees/bot-rematch-flow`

  it('fetches the default branch, creates the branch from the remote ref, and adds the worktree', async () => {
    const git = fakeGit([
      [['rev-parse', '--verify', '--quiet', 'refs/heads/bot-rematch-flow'], exit(1)],
      [['fetch', 'origin', 'main'], ''],
      [['branch', '--', 'bot-rematch-flow', 'origin/main'], ''],
      [[...ADD, target, 'bot-rematch-flow'], ''],
    ])
    const service = new GitWorktreeService(git.execute, { pathExists: async () => false })
    const result = await service.createWorktree({
      mainRoot: MAIN,
      branch: 'bot-rematch-flow',
      path: target,
      defaultBranch: 'main',
      remote: 'origin',
    })
    expect(result.worktree).toEqual({
      path: target,
      branch: 'bot-rematch-flow',
      base: 'origin/main',
      reusedBranch: false,
    })
    expect(git.calls.map((call) => call.args)).toEqual([
      ['rev-parse', '--verify', '--quiet', 'refs/heads/bot-rematch-flow'],
      ['fetch', 'origin', 'main'],
      ['branch', '--', 'bot-rematch-flow', 'origin/main'],
      [...ADD, target, 'bot-rematch-flow'],
    ])
    expect(git.calls.every((call) => call.cwd === MAIN)).toBe(true)
  })

  it('keeps going from the local remote-tracking ref with a warning when the fetch fails', async () => {
    const git = fakeGit([
      [['rev-parse', '--verify', '--quiet', 'refs/heads/bot-rematch-flow'], exit(1)],
      [['fetch', 'origin', 'main'], exit(128, 'fatal: unable to access')],
      [['show-ref', '--verify', '--quiet', 'refs/remotes/origin/main'], ''],
      [['branch', '--', 'bot-rematch-flow', 'origin/main'], ''],
      [[...ADD, target, 'bot-rematch-flow'], ''],
    ])
    const service = new GitWorktreeService(git.execute, { pathExists: async () => false })
    const result = await service.createWorktree({ mainRoot: MAIN, branch: 'bot-rematch-flow', path: target, defaultBranch: 'main', remote: 'origin' })
    expect(result.worktree.base).toBe('origin/main')
    expect(result.worktree.warning).toMatch(/fetch/i)
  })

  it('refuses to branch from HEAD when fetching the known default branch fails and no local ref exists', async () => {
    const git = fakeGit([
      [['rev-parse', '--verify', '--quiet', 'refs/heads/bot-rematch-flow'], exit(1)],
      [['fetch', 'origin', 'main'], exit(128, 'fatal: unable to access origin')],
      [['show-ref', '--verify', '--quiet', 'refs/remotes/origin/main'], exit(1)],
    ])
    const service = new GitWorktreeService(git.execute, { pathExists: async () => false })

    await expect(
      service.createWorktree({ mainRoot: MAIN, branch: 'bot-rematch-flow', path: target, defaultBranch: 'main', remote: 'origin' }),
    ).rejects.toMatchObject({
      kind: 'exec',
      message: expect.stringMatching(/refs\/remotes\/origin\/main.*fatal: unable to access origin/i),
    })
    expect(git.calls.some((call) => isAdd(call))).toBe(false)
  })

  it('branches from HEAD when there is no remote default branch', async () => {
    const git = fakeGit([
      [['rev-parse', '--verify', '--quiet', 'refs/heads/bot-rematch-flow'], exit(1)],
      [['branch', '--', 'bot-rematch-flow', 'HEAD'], ''],
      [[...ADD, target, 'bot-rematch-flow'], ''],
    ])
    const service = new GitWorktreeService(git.execute, { pathExists: async () => false })
    const result = await service.createWorktree({ mainRoot: MAIN, branch: 'bot-rematch-flow', path: target })
    expect(result.worktree.base).toBe('HEAD')
    expect(git.calls.some((call) => call.args[0] === 'fetch')).toBe(false)
  })

  it('reuses an existing branch that is not checked out anywhere', async () => {
    const git = fakeGit([
      [['rev-parse', '--verify', '--quiet', 'refs/heads/bot-rematch-flow'], 'abc123\n'],
      [['worktree', 'list', '--porcelain'], `worktree ${MAIN}\nHEAD abc\nbranch refs/heads/main\n\n`],
      [[...ADD, target, 'bot-rematch-flow'], ''],
    ])
    const service = new GitWorktreeService(git.execute, { pathExists: async () => false })
    const result = await service.createWorktree({ mainRoot: MAIN, branch: 'bot-rematch-flow', path: target, defaultBranch: 'main', remote: 'origin' })
    expect(result.worktree).toEqual({ path: target, branch: 'bot-rematch-flow', base: '', reusedBranch: true })
    expect(git.calls.some((call) => call.args[0] === 'fetch')).toBe(false)
  })

  it('refuses an existing branch when asked for a new one only, before touching any worktree', async () => {
    const git = fakeGit([[['rev-parse', '--verify', '--quiet', 'refs/heads/bot-rematch-flow'], 'abc123\n']])
    const service = new GitWorktreeService(git.execute, { pathExists: async () => false })
    await expect(service.createWorktree({ mainRoot: MAIN, branch: 'bot-rematch-flow', path: target, newBranchOnly: true })).rejects.toMatchObject({ kind: 'branch-exists' })
    expect(git.calls.map((call) => call.args[0])).toEqual(['rev-parse'])
  })

  it('refuses a branch that is checked out in another worktree', async () => {
    const git = fakeGit([
      [['rev-parse', '--verify', '--quiet', 'refs/heads/bot-rematch-flow'], 'abc123\n'],
      [['worktree', 'list', '--porcelain'], `worktree ${MAIN}\nHEAD abc\nbranch refs/heads/main\n\nworktree /elsewhere\nHEAD def\nbranch refs/heads/bot-rematch-flow\n\n`],
    ])
    const service = new GitWorktreeService(git.execute, { pathExists: async () => false })
    await expect(
      service.createWorktree({ mainRoot: MAIN, branch: 'bot-rematch-flow', path: target }),
    ).rejects.toMatchObject({ kind: 'branch-checked-out', message: expect.stringContaining('/elsewhere') })
  })

  it('refuses an existing path unless it already is the worktree for that branch', async () => {
    const occupied = fakeGit([
      [['rev-parse', '--verify', '--quiet', 'refs/heads/bot-rematch-flow'], exit(1)],
      [['worktree', 'list', '--porcelain'], `worktree ${MAIN}\nHEAD abc\nbranch refs/heads/main\n\n`],
    ])
    await expect(
      new GitWorktreeService(occupied.execute, { pathExists: async () => true })
        .createWorktree({ mainRoot: MAIN, branch: 'bot-rematch-flow', path: target }),
    ).rejects.toMatchObject({ kind: 'path-exists' })

    const same = fakeGit([
      [['rev-parse', '--verify', '--quiet', 'refs/heads/bot-rematch-flow'], 'abc123\n'],
      [['worktree', 'list', '--porcelain'], `worktree ${MAIN}\nHEAD abc\nbranch refs/heads/main\n\nworktree ${target}\nHEAD def\nbranch refs/heads/bot-rematch-flow\n\n`],
    ])
    const result = await new GitWorktreeService(same.execute, { pathExists: async () => true })
      .createWorktree({ mainRoot: MAIN, branch: 'bot-rematch-flow', path: target })
    expect(result.worktree).toEqual({ path: target, branch: 'bot-rematch-flow', base: '', reusedBranch: true })
    expect(same.calls.some((call) => isAdd(call))).toBe(false)
  })

  it('refuses a registered worktree that is missing on disk', async () => {
    const git = fakeGit([
      [['rev-parse', '--verify', '--quiet', 'refs/heads/bot-rematch-flow'], 'abc123\n'],
      [['worktree', 'list', '--porcelain'], `worktree ${MAIN}\nHEAD abc\nbranch refs/heads/main\n\nworktree ${target}\nHEAD def\nbranch refs/heads/bot-rematch-flow\n\n`],
    ])
    const service = new GitWorktreeService(git.execute, { pathExists: async () => false })

    await expect(
      service.createWorktree({ mainRoot: MAIN, branch: 'bot-rematch-flow', path: target }),
    ).rejects.toMatchObject({
      kind: 'exec',
      message: expect.stringMatching(/registered but missing on disk.*git worktree prune.*Save-All/i),
    })
  })

  it('rejects branch names git would refuse', async () => {
    const git = fakeGit([])
    const service = new GitWorktreeService(git.execute)
    await expect(service.createWorktree({ mainRoot: MAIN, branch: 'bad..name', path: target })).rejects.toBeInstanceOf(GitWorktreeError)
    await expect(service.createWorktree({ mainRoot: MAIN, branch: '-leading', path: target })).rejects.toMatchObject({ kind: 'bad-branch' })
    expect(git.execute).not.toHaveBeenCalled()
  })

  it('rollback moves the worktree aside instead of waiting for git to delete it, and deletes only a branch this call created', async () => {
    const list = `worktree ${MAIN}\nHEAD abc\nbranch refs/heads/main\n\n`
    const created = fakeGit([
      [['rev-parse', '--verify', '--quiet', 'refs/heads/bot-rematch-flow'], exit(1)],
      [['branch', '--'], ''],
      [[...ADD], ''],
      [['worktree', 'prune'], ''],
      [['worktree', 'list', '--porcelain'], list],
      [['branch', '-D', '--', 'bot-rematch-flow'], ''],
    ])
    const renamePath = vi.fn(async () => undefined)
    const removeTree = vi.fn(async () => undefined)
    const fresh = await new GitWorktreeService(created.execute, { pathExists: async () => false, renamePath, removeTree })
      .createWorktree({ mainRoot: MAIN, branch: 'bot-rematch-flow', path: target })
    await fresh.rollback()
    const aside = expect.stringMatching(/\/\.bot-rematch-flow\.commando-deleting-\d+$/u)
    expect(renamePath).toHaveBeenCalledWith(target, aside)
    expect(removeTree).toHaveBeenCalledWith(aside)
    expect(created.calls.slice(-3).map((call) => call.args)).toEqual([
      ['worktree', 'prune'],
      ['worktree', 'list', '--porcelain'],
      ['branch', '-D', '--', 'bot-rematch-flow'],
    ])

    const reused = fakeGit([
      [['rev-parse', '--verify', '--quiet', 'refs/heads/bot-rematch-flow'], 'abc\n'],
      [['worktree', 'list', '--porcelain'], list],
      [['branch', '--'], ''],
      [[...ADD], ''],
      [['worktree', 'prune'], ''],
    ])
    const existing = await new GitWorktreeService(reused.execute, { pathExists: async () => false, renamePath, removeTree })
      .createWorktree({ mainRoot: MAIN, branch: 'bot-rematch-flow', path: target })
    await existing.rollback()
    expect(reused.calls.some((call) => call.args[0] === 'branch')).toBe(false)
  })

  it('bounds the fetch with the configured timeout', async () => {
    const git = fakeGit([
      [['rev-parse', '--verify', '--quiet', 'refs/heads/bot-rematch-flow'], exit(1)],
      [['fetch'], ''],
      [['branch', '--'], ''],
      [[...ADD], ''],
    ])
    const service = new GitWorktreeService(git.execute, { pathExists: async () => false, fetchTimeoutMs: 1234 })
    await service.createWorktree({ mainRoot: MAIN, branch: 'bot-rematch-flow', path: target, defaultBranch: 'main', remote: 'origin' })
    expect(git.calls.find((call) => call.args[0] === 'fetch')?.timeout).toBe(1234)
  })

  it('gives a large checkout minutes, and says so when it runs out instead of quoting git output', async () => {
    const git = fakeGit([
      [['rev-parse', '--verify', '--quiet', 'refs/heads/bot-rematch-flow'], exit(1)],
      [['branch', '--'], ''],
      [[...ADD], new GitCommandFailure('git timed out', 'Preparing worktree (new branch)', false, true)],
      [['worktree', 'prune'], ''],
      [['branch', '-D', '--', 'bot-rematch-flow'], ''],
    ])
    const service = new GitWorktreeService(git.execute, { pathExists: async () => false })
    await expect(service.createWorktree({ mainRoot: MAIN, branch: 'bot-rematch-flow', path: target })).rejects.toMatchObject({
      kind: 'exec',
      message: 'git worktree add was still checking out files after 10 minutes and was stopped',
    })
    expect(git.calls.find(isAdd)?.timeout).toBe(10 * 60_000)
  })

  it('never deletes a branch another process made between the check and the create', async () => {
    let made = false
    const calls: string[][] = []
    const execute = vi.fn(async (_file: string, args: readonly string[]) => {
      calls.push([...args])
      if (args[0] === 'rev-parse' && !made) throw exit(1)
      if (args[0] === 'rev-parse') return { stdout: 'abc\n', stderr: '' }
      // Someone else takes the name just before this call creates it.
      made = true
      throw exit(128, "fatal: a branch named 'bot-rematch-flow' already exists")
    })
    await expect(new GitWorktreeService(execute, { pathExists: async () => false })
      .createWorktree({ mainRoot: MAIN, branch: 'bot-rematch-flow', path: target })).rejects.toMatchObject({ kind: 'branch-exists' })
    expect(calls).toEqual([
      ['rev-parse', '--verify', '--quiet', 'refs/heads/bot-rematch-flow'],
      ['branch', '--', 'bot-rematch-flow', 'HEAD'],
      ['rev-parse', '--verify', '--quiet', 'refs/heads/bot-rematch-flow'],
    ])
  })

  it('follows the checkout meter for progress, and keeps it out of the error', async () => {
    const meter = 'Preparing worktree (new branch \'bot-rematch-flow\')\nUpdating files:   2% (806/40291)\rUpdating files:  41% (16520/40291)\r'
    const execute = vi.fn(async (_file: string, args: readonly string[], options: GitExecutorOptions) => {
      if (args[0] === 'rev-parse') throw exit(1)
      if (args.includes('add')) {
        options.onStderr?.(meter)
        throw new GitCommandFailure('git failed', `${meter}fatal: unable to write new index file\n`, false)
      }
      return { stdout: '', stderr: '' }
    })
    const progress: Array<[string, number?]> = []
    await expect(new GitWorktreeService(execute, { pathExists: async () => false }).createWorktree({
      mainRoot: MAIN, branch: 'bot-rematch-flow', path: target, onProgress: (stage, percent) => progress.push(percent === undefined ? [stage] : [stage, percent]),
    })).rejects.toMatchObject({ message: 'git worktree add failed: fatal: unable to write new index file' })
    expect(progress).toEqual([['checking-out'], ['checking-out', 41]])
    expect(execute.mock.calls.find(([, args]) => args.includes('add'))?.[1]).not.toContain('--quiet')
  })

  it('deletes the branch a failed checkout left behind, so the name can be used again', async () => {
    const fresh = fakeGit([
      [['rev-parse', '--verify', '--quiet', 'refs/heads/bot-rematch-flow'], exit(1)],
      [['branch', '--'], ''],
      [[...ADD], exit(128, 'fatal: could not create leading directories')],
      [['worktree', 'prune'], ''],
      [['branch', '-D', '--', 'bot-rematch-flow'], ''],
    ])
    await expect(new GitWorktreeService(fresh.execute, { pathExists: async () => false })
      .createWorktree({ mainRoot: MAIN, branch: 'bot-rematch-flow', path: target })).rejects.toMatchObject({
      message: 'git worktree add failed: fatal: could not create leading directories',
    })
    expect(fresh.calls.slice(-2).map((call) => call.args)).toEqual([['worktree', 'prune'], ['branch', '-D', '--', 'bot-rematch-flow']])

    const reused = fakeGit([
      [['rev-parse', '--verify', '--quiet', 'refs/heads/bot-rematch-flow'], 'abc\n'],
      [['worktree', 'list', '--porcelain'], `worktree ${MAIN}\nHEAD abc\nbranch refs/heads/main\n\n`],
      [['branch', '--'], ''],
      [[...ADD], exit(128, 'fatal: disk full')],
    ])
    await expect(new GitWorktreeService(reused.execute, { pathExists: async () => false })
      .createWorktree({ mainRoot: MAIN, branch: 'bot-rematch-flow', path: target })).rejects.toMatchObject({ kind: 'exec' })
    expect(reused.calls.some((call) => call.args[0] === 'branch')).toBe(false)
  })
})

describe('GitWorktreeService remote branches', () => {
  const branch = 'cursor/fix+c++'
  const roots: string[] = []
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

  async function repository() {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'commando-remote-worktree-')))
    roots.push(root)
    const run = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
    const publisher = path.join(root, 'publisher')
    const main = path.join(root, 'local')
    const remote = path.join(root, 'remote.git')
    const target = path.join(root, 'worktrees', branch)
    run(root, 'init', '--bare', '--initial-branch=main', remote)
    run(root, 'init', '--initial-branch=main', publisher)
    const configure = (cwd: string) => {
      run(cwd, 'config', 'user.name', 'Test')
      run(cwd, 'config', 'user.email', 'test@example.com')
      run(cwd, 'config', 'commit.gpgsign', 'false')
      run(cwd, 'config', 'core.hooksPath', '/dev/null')
    }
    configure(publisher)
    writeFileSync(path.join(publisher, 'file'), 'initial')
    run(publisher, 'add', 'file')
    run(publisher, 'commit', '-qm', 'initial')
    run(publisher, 'remote', 'add', 'origin', remote)
    run(publisher, 'push', 'origin', 'main')
    run(root, 'clone', remote, main)
    configure(main)
    run(publisher, 'switch', '-c', branch)
    const push = () => {
      writeFileSync(path.join(publisher, 'file'), 'remote change')
      run(publisher, 'add', 'file')
      run(publisher, 'commit', '-qm', 'remote change')
      run(publisher, 'push', 'origin', branch)
      return run(publisher, 'rev-parse', 'HEAD')
    }
    const input = { mainRoot: main, branch, path: target, fromRemote: true as const }
    const service = new GitWorktreeService(undefined, { removeTree: async (directory) => { rmSync(directory, { recursive: true, force: true }) } })
    return { root, main, publisher, target, run, push, input, service }
  }

  it('fetches a remote-only branch and creates a tracking worktree using git branch validation', async () => {
    const { main, target, run, push, input, service } = await repository()
    const remoteHead = push()
    const onProgress = vi.fn()
    const result = await service.createWorktree({ ...input, onProgress, defaultBranch: 'main' })
    expect(result.worktree).toEqual({ path: target, branch, base: `origin/${branch}`, reusedBranch: false })
    expect(run(target, 'rev-parse', 'HEAD')).toBe(remoteHead)
    expect(run(target, 'rev-parse', '--abbrev-ref', '@{upstream}')).toBe(`origin/${branch}`)
    expect(run(main, 'branch', '--show-current')).toBe('main')
    expect(onProgress.mock.calls.map(([stage]) => stage)).toEqual(expect.arrayContaining(['fetching', 'checking-out']))
  })

  it('fast-forwards a strictly behind local branch and rollback keeps that branch', async () => {
    const { main, target, run, push, input, service } = await repository()
    run(main, 'branch', branch)
    const remoteHead = push()
    const result = await service.createWorktree(input)
    expect(result.worktree).toMatchObject({ reusedBranch: true })
    expect(result.worktree.warning).toBeUndefined()
    expect(run(target, 'rev-parse', 'HEAD')).toBe(remoteHead)
    await result.rollback()
    expect(existsSync(target)).toBe(false)
    expect(run(main, 'rev-parse', branch)).toBe(remoteHead)
    expect(run(main, 'branch', '--show-current')).toBe('main')
  })

  it.each(['diverged', 'ahead'])('keeps a local branch that is %s and warns about unpushed commits', async (state) => {
    const { main, target, run, push, input, service } = await repository()
    run(main, 'branch', branch)
    if (state === 'diverged') push()
    else run(main, 'push', 'origin', branch)
    const localHead = run(main, 'commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'local only')
    run(main, 'update-ref', `refs/heads/${branch}`, localHead)
    const result = await service.createWorktree(input)
    expect(run(target, 'rev-parse', 'HEAD')).toBe(localHead)
    expect(result.worktree.warning).toBe(`Local ${branch} has commits that aren't on GitHub; it wasn't updated.`)
  })

  it('errors when the branch is not on the remote, even with a stale remote-tracking ref', async () => {
    const { main, publisher, target, run, push, input, service } = await repository()
    push()
    run(main, 'fetch', 'origin', branch)
    run(publisher, 'push', 'origin', '--delete', branch)
    await expect(service.createWorktree(input)).rejects.toMatchObject({ message: `${branch} isn't on GitHub yet.` })
    expect(existsSync(target)).toBe(false)
    expect(run(main, 'branch', '--list', branch)).toBe('')
  })

  it('returns an existing worktree without updating its branch or touching its uncommitted files', async () => {
    const { root, main, target, run, push, input, service } = await repository()
    const existing = path.join(root, 'existing')
    run(main, 'worktree', 'add', '-b', branch, existing)
    const localHead = run(existing, 'rev-parse', 'HEAD')
    writeFileSync(path.join(existing, 'file'), 'uncommitted')
    push()
    const result = await service.createWorktree(input)
    expect(result.worktree).toMatchObject({ path: existing, branch, reusedBranch: true })
    await result.rollback()
    expect(run(existing, 'rev-parse', 'HEAD')).toBe(localHead)
    expect(readFileSync(path.join(existing, 'file'), 'utf8')).toBe('uncommitted')
    expect(existsSync(target)).toBe(false)
  })

  it('rolls back only the new worktree and tracking branch', async () => {
    const { main, target, run, push, input, service } = await repository()
    push()
    const original = run(main, 'rev-parse', 'HEAD')
    const result = await service.createWorktree(input)
    await result.rollback()
    expect(existsSync(target)).toBe(false)
    expect(run(main, 'branch', '--list', branch)).toBe('')
    expect(run(main, 'rev-parse', 'HEAD')).toBe(original)
  })

  it('removes its new branch after checkout fails, preserving other branches', async () => {
    const { main, target, run, push, input } = await repository()
    push()
    const execute = vi.fn(async (_file: string, args: readonly string[], options: GitExecutorOptions) => {
      if (args.includes('add') && args.includes('worktree')) throw new GitCommandFailure('checkout failed', 'disk full', false)
      return { stdout: run(options.cwd, ...args), stderr: '' }
    })
    await expect(new GitWorktreeService(execute).createWorktree(input)).rejects.toThrow('disk full')
    expect(run(main, 'branch', '--list', branch)).toBe('')
    expect(run(main, 'branch', '--show-current')).toBe('main')
    expect(existsSync(target)).toBe(false)
  })

  it('fetches the exact branch noninteractively with batch SSH and the configured timeout', async () => {
    const git = fakeGit([
      [['check-ref-format'], branch],
      [['fetch'], exit(128, 'Permission denied (publickey)')],
    ])
    await expect(new GitWorktreeService(git.execute, { fetchTimeoutMs: 1234 }).createWorktree({
      mainRoot: MAIN, branch, path: '/tmp/cloud', fromRemote: true, remote: 'github',
    })).rejects.toThrow('Could not fetch')
    expect(git.execute.mock.calls[1]).toEqual(['git', ['fetch', 'github', `refs/heads/${branch}:refs/remotes/github/${branch}`], expect.objectContaining({
      timeout: 1234,
      env: expect.objectContaining({ GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: expect.stringContaining('-o BatchMode=yes') }),
    })])
  })
})

describe('GitWorktreeService.removeWorktree', () => {
  const target = `${MAIN}-worktrees/bot-rematch-flow`

  const identity = { root: target, mainRoot: MAIN, branch: 'bot-rematch-flow', head: 'def' }
  const listing = (extra = '') => `worktree ${MAIN}\nHEAD abc\nbranch refs/heads/main\n\nworktree ${target}\nHEAD def\nbranch refs/heads/bot-rematch-flow\n${extra}\n`
  const aside = `${MAIN}-worktrees/.bot-rematch-flow.commando-deleting-1700`
  const mainOnly = `worktree ${MAIN}\nHEAD abc\nbranch refs/heads/main\n\n`

  function fakeFiles() {
    const renames: Array<[string, string]> = []
    const removed: string[] = []
    return {
      renames,
      removed,
      options: {
        renamePath: vi.fn(async (from: string, to: string) => { renames.push([from, to]) }),
        removeTree: vi.fn(async (folder: string) => { removed.push(folder) }),
      },
    }
  }

  afterEach(() => { vi.restoreAllMocks() })

  it('moves the worktree aside, unregisters it, then deletes its files in the background', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1700)
    const listings = [listing(), mainOnly]
    const git = fakeGit([])
    git.execute.mockImplementation(async (_file, args, options) => {
      git.calls.push({ args: [...args], cwd: options.cwd, timeout: options.timeout })
      return { stdout: args[1] === 'list' ? listings.shift() ?? '' : '', stderr: '' }
    })
    const files = fakeFiles()

    await new GitWorktreeService(git.execute, files.options).removeWorktree(identity)

    expect(files.renames).toEqual([[target, aside]])
    expect(git.calls.map((call) => call.args[1])).toEqual(['list', 'prune', 'list'])
    expect(git.calls.some((call) => call.args[1] === 'remove')).toBe(false)
    expect(files.removed).toEqual([aside])
  })

  it('puts the folder back when prune exits cleanly but leaves the worktree registered', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1700)
    const git = fakeGit([
      [['worktree', 'list', '--porcelain'], listing()],
      [['worktree', 'prune'], ''],
    ])
    const files = fakeFiles()

    await expect(new GitWorktreeService(git.execute, files.options).removeWorktree(identity))
      .rejects.toMatchObject({ kind: 'exec', message: expect.stringMatching(/left .* registered/) })
    expect(files.renames).toEqual([[target, aside], [aside, target]])
    expect(files.removed).toEqual([])
  })

  it('carries on when prune fails after git has already dropped the worktree', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1700)
    const listings = [listing(), mainOnly]
    const execute = vi.fn(async (_file: string, args: readonly string[]) => {
      if (args[1] === 'prune') throw exit(128, 'git timed out')
      return { stdout: listings.shift() ?? '', stderr: '' }
    })
    const files = fakeFiles()

    await new GitWorktreeService(execute, files.options).removeWorktree(identity)

    expect(files.renames).toEqual([[target, aside]])
    expect(files.removed).toEqual([aside])
  })

  it('refuses a locked worktree without touching it', async () => {
    const git = fakeGit([[['worktree', 'list', '--porcelain'], listing('locked\n')]])
    const files = fakeFiles()

    await expect(new GitWorktreeService(git.execute, files.options).removeWorktree(identity))
      .rejects.toMatchObject({ kind: 'bad-path', message: expect.stringMatching(/locked/i) })
    expect(files.renames).toEqual([])
  })

  it('puts the folder back when git cannot unregister it', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1700)
    const git = fakeGit([
      [['worktree', 'list', '--porcelain'], listing()],
      [['worktree', 'prune'], exit(128, 'fatal: unable to lock')],
    ])
    const files = fakeFiles()

    await expect(new GitWorktreeService(git.execute, files.options).removeWorktree(identity))
      .rejects.toMatchObject({ kind: 'exec', message: expect.stringMatching(/unable to lock/) })
    expect(files.renames).toEqual([[target, aside], [aside, target]])
    expect(files.removed).toEqual([])
  })

  it('removes a real worktree and its ignored files', async () => {
    const base = await realpath(await mkdtemp(path.join(tmpdir(), 'commando-worktree-')))
    const run = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' })
    const main = path.join(base, 'repo')
    const linked = path.join(base, 'repo-worktrees', 'feature')
    try {
      run(base, 'init', '-q', main)
      writeFileSync(path.join(main, '.gitignore'), 'node_modules\n')
      run(main, 'add', '.gitignore')
      run(main, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init')
      run(main, 'worktree', 'add', '-q', '-b', 'feature', linked)
      mkdirSync(path.join(linked, 'node_modules', 'pkg'), { recursive: true })
      writeFileSync(path.join(linked, 'node_modules', 'pkg', 'index.js'), '')
      writeFileSync(path.join(linked, 'notes.txt'), 'uncommitted')

      const head = run(linked, 'rev-parse', 'HEAD').trim()
      await new GitWorktreeService().removeWorktree({ root: linked, mainRoot: main, branch: 'feature', head })

      expect(run(main, 'worktree', 'list', '--porcelain')).not.toContain(linked)
      await vi.waitFor(() => expect(readdirSync(path.dirname(linked))).toEqual([]))
      expect(run(main, 'branch', '--list', 'feature')).toContain('feature')
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('saves uncommitted work on the branch, removes the worktree, then checks the branch out again', async () => {
    const base = await realpath(await mkdtemp(path.join(tmpdir(), 'commando-worktree-')))
    const run = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' })
    const main = path.join(base, 'repo')
    const linked = path.join(base, 'repo-worktrees', 'feature')
    const identity = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
    const service = new GitWorktreeService(undefined, { environment: { ...process.env, ...identity } })
    try {
      run(base, 'init', '-q', main)
      writeFileSync(path.join(main, '.gitignore'), 'node_modules\n')
      run(main, 'add', '.gitignore')
      run(main, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init')
      run(main, 'worktree', 'add', '-q', '-b', 'feature', linked)
      const worktree = (await service.worktreeForDirectory(linked))!
      await expect(service.commitWorkInProgress(worktree, 'wip')).resolves.toEqual(worktree)

      mkdirSync(path.join(linked, 'node_modules', 'from-git', '.git'), { recursive: true })
      writeFileSync(path.join(linked, 'node_modules', 'big.js'), '')
      writeFileSync(path.join(linked, 'notes.txt'), 'uncommitted')
      const saved = await service.commitWorkInProgress(worktree, 'wip: archived session')
      expect(saved.head).not.toBe(worktree.head)
      expect(run(linked, 'log', '-1', '--format=%s')).toBe('wip: archived session\n')
      expect(run(linked, 'show', '--name-only', '--format=', 'HEAD').trim()).toBe('notes.txt')

      await service.removeWorktree(saved)
      await vi.waitFor(() => expect(readdirSync(path.dirname(linked))).toEqual([]))
      await expect(service.createWorktree({ mainRoot: main, branch: 'gone', path: linked, existingBranchOnly: true }))
        .rejects.toMatchObject({ message: 'Branch gone no longer exists' })
      await service.createWorktree({ mainRoot: main, branch: 'feature', path: linked, existingBranchOnly: true })
      expect(readdirSync(linked).sort()).toEqual(['.git', '.gitignore', 'notes.txt'])
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('checks a branch out again where its deleted worktree was, leaving other missing worktrees registered', async () => {
    const base = await realpath(await mkdtemp(path.join(tmpdir(), 'commando-worktree-')))
    const run = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' })
    const main = path.join(base, 'repo')
    const linked = path.join(base, 'repo-worktrees', 'feature')
    const unplugged = path.join(base, 'repo-worktrees', 'other')
    const service = new GitWorktreeService()
    try {
      run(base, 'init', '-q', main)
      writeFileSync(path.join(main, 'README.md'), 'hi\n')
      run(main, 'add', 'README.md')
      run(main, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init')
      run(main, 'worktree', 'add', '-q', '-b', 'feature', linked)
      run(main, 'worktree', 'add', '-q', '-b', 'other', unplugged)
      rmSync(linked, { recursive: true, force: true })
      rmSync(unplugged, { recursive: true, force: true })
      // Without existingBranchOnly the stale registration still needs a person to prune it.
      await expect(service.createWorktree({ mainRoot: main, branch: 'feature', path: linked })).rejects.toMatchObject({ message: expect.stringMatching(/registered but missing/) })
      await service.createWorktree({ mainRoot: main, branch: 'feature', path: linked, existingBranchOnly: true })
      expect(readdirSync(linked).sort()).toEqual(['.git', 'README.md'])
      expect(run(linked, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('feature')
      expect(run(main, 'worktree', 'list', '--porcelain')).toContain(`worktree ${unplugged}\n`)

      // A branch already recovered elsewhere (with --force) is not checked out a second time.
      const recovered = path.join(base, 'recovered')
      rmSync(linked, { recursive: true, force: true })
      run(main, 'worktree', 'add', '-q', '--force', recovered, 'feature')
      await expect(service.createWorktree({ mainRoot: main, branch: 'feature', path: linked, existingBranchOnly: true }))
        .rejects.toMatchObject({ kind: 'branch-checked-out', message: `Branch feature is already checked out at ${recovered}` })
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('tells which main checkout a deleted worktree came from, or that it cannot tell', async () => {
    const base = await realpath(await mkdtemp(path.join(tmpdir(), 'commando-worktree-')))
    const run = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' })
    const repo = (name: string, ...branches: string[]) => {
      const root = path.join(base, name)
      run(base, 'init', '-q', root)
      run(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init')
      for (const branch of branches) run(root, 'branch', branch)
      return root
    }
    const service = new GitWorktreeService()
    try {
      const work = repo('work/api', 'fix')
      const oss = repo('oss/api', 'fix')
      const solo = repo('solo/api', 'only')
      const plain = path.join(base, 'plain', 'api')
      mkdirSync(plain, { recursive: true })
      const linked = path.join(base, 'trees', 'api-worktrees', 'fix')
      run(oss, 'worktree', 'add', '-q', linked, 'fix')
      rmSync(linked, { recursive: true, force: true })
      // Still registered: that repo wins even though another has the branch too.
      expect(await service.mainCheckoutFor([plain, work, oss], linked, 'fix')).toBe(oss)
      run(oss, 'worktree', 'prune')
      expect(await service.mainCheckoutFor([plain, work, oss], linked, 'fix')).toBeUndefined()
      expect(await service.mainCheckoutFor([plain, work, solo], path.join(base, 'trees', 'api-worktrees', 'only'), 'only')).toBe(solo)
      expect(await service.mainCheckoutFor([path.join(work, 'sub'), plain], linked, 'fix')).toBeUndefined()
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('refuses a work-in-progress commit that would only point at a nested repository', async () => {
    const base = await realpath(await mkdtemp(path.join(tmpdir(), 'commando-worktree-')))
    const run = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' })
    const main = path.join(base, 'repo')
    const linked = path.join(base, 'repo-worktrees', 'feature')
    try {
      run(base, 'init', '-q', main)
      run(main, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init')
      run(main, 'worktree', 'add', '-q', '-b', 'feature', linked)
      run(linked, 'init', '-q', 'vendor clone')
      const service = new GitWorktreeService()
      const worktree = (await service.worktreeForDirectory(linked))!
      await expect(service.commitWorkInProgress(worktree, 'wip')).rejects.toMatchObject({ message: 'Worktree contains another git repository at vendor clone' })
      expect(run(linked, 'rev-parse', 'HEAD').trim()).toBe(worktree.head)
      // Once staged it is a gitlink, which keeps none of its files.
      run(linked, '-c', 'user.name=t', '-c', 'user.email=t@t', '-C', 'vendor clone', 'commit', '-q', '--allow-empty', '-m', 'inner')
      execFileSync('git', ['add', 'vendor clone'], { cwd: linked, stdio: 'ignore' })
      await expect(service.commitWorkInProgress(worktree, 'wip')).rejects.toMatchObject({ message: 'Worktree contains a submodule or nested repository at vendor clone' })
      expect(run(linked, 'rev-parse', 'HEAD').trim()).toBe(worktree.head)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('refuses a work-in-progress commit when an index flag hides edits from status', async () => {
    const base = await realpath(await mkdtemp(path.join(tmpdir(), 'commando-worktree-')))
    const run = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' })
    const main = path.join(base, 'repo')
    const linked = path.join(base, 'repo-worktrees', 'feature')
    try {
      run(base, 'init', '-q', main)
      writeFileSync(path.join(main, 'config.json'), '{}')
      run(main, 'add', '.')
      run(main, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init')
      run(main, 'worktree', 'add', '-q', '-b', 'feature', linked)
      const service = new GitWorktreeService()
      const worktree = (await service.worktreeForDirectory(linked))!
      for (const flag of ['--assume-unchanged', '--skip-worktree']) {
        run(linked, 'update-index', flag, 'config.json')
        writeFileSync(path.join(linked, 'config.json'), '{"local":true}')
        expect(run(linked, 'status', '--porcelain').trim()).toBe('')
        await expect(service.commitWorkInProgress(worktree, 'wip')).rejects.toMatchObject({ message: expect.stringContaining('at config.json') })
        run(linked, 'update-index', flag.replace('--', '--no-'), 'config.json')
        run(linked, 'checkout', '--', 'config.json')
      }
      // Sparse checkout marks files outside its cone skip-worktree, but they aren't on disk to lose.
      for (const folder of ['app', 'docs']) {
        mkdirSync(path.join(linked, folder))
        writeFileSync(path.join(linked, folder, 'file.md'), '')
      }
      run(linked, 'add', '.')
      run(linked, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'folders')
      run(linked, 'sparse-checkout', 'set', 'app')
      expect(run(linked, 'ls-files', '-v')).toContain('S docs/file.md')
      const sparse = (await service.worktreeForDirectory(linked))!
      await expect(service.commitWorkInProgress(sparse, 'wip')).resolves.toEqual(sparse)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('refuses a work-in-progress commit when a repository was started inside a tracked folder', async () => {
    const base = await realpath(await mkdtemp(path.join(tmpdir(), 'commando-worktree-')))
    const run = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' })
    const main = path.join(base, 'repo')
    const linked = path.join(base, 'repo-worktrees', 'feature')
    try {
      run(base, 'init', '-q', main)
      mkdirSync(path.join(main, 'vendor'))
      writeFileSync(path.join(main, 'vendor', 'lib.js'), 'x')
      run(main, 'add', '.')
      run(main, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init')
      run(main, 'worktree', 'add', '-q', '-b', 'feature', linked)
      run(path.join(linked, 'vendor'), 'init', '-q')
      expect(run(linked, 'status', '--porcelain').trim()).toBe('')
      const service = new GitWorktreeService()
      const worktree = (await service.worktreeForDirectory(linked))!
      await expect(service.commitWorkInProgress(worktree, 'wip')).rejects.toMatchObject({ message: 'Worktree contains another git repository at vendor' })
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('checks for gitlinks in a repository too large for an ordinary git output buffer', async () => {
    const base = await realpath(await mkdtemp(path.join(tmpdir(), 'commando-worktree-')))
    const run = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' })
    const main = path.join(base, 'repo')
    const linked = path.join(base, 'repo-worktrees', 'big')
    try {
      run(base, 'init', '-q', main)
      // 30,000 index entries make `ls-files --stage` print about 3 MB.
      const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: main, input: 'x', encoding: 'utf8' }).trim()
      const entries = Array.from({ length: 30_000 }, (_, i) => `100644 ${blob} 0\tpackages/module-${Math.floor(i / 1000)}/src/component-file-${i}.ts`).join('\n')
      execFileSync('git', ['update-index', '--index-info'], { cwd: main, input: `${entries}\n` })
      run(main, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'big')
      run(main, 'worktree', 'add', '-q', '-b', 'big', linked)
      const service = new GitWorktreeService()
      const worktree = (await service.worktreeForDirectory(linked))!
      await expect(service.commitWorkInProgress(worktree, 'wip')).resolves.toEqual(worktree)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  }, 120_000)

  it('checks out an existing branch again under any name git accepts', async () => {
    const base = await realpath(await mkdtemp(path.join(tmpdir(), 'commando-worktree-')))
    const run = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' })
    const main = path.join(base, 'repo')
    const linked = path.join(base, 'repo-worktrees', 'cpp')
    const service = new GitWorktreeService()
    try {
      run(base, 'init', '-q', main)
      run(main, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init')
      run(main, 'branch', 'feature/c++')
      await service.createWorktree({ mainRoot: main, branch: 'feature/c++', path: linked, existingBranchOnly: true })
      expect(run(linked, 'branch', '--show-current').trim()).toBe('feature/c++')
      await expect(service.createWorktree({ mainRoot: main, branch: 'bad..name', path: path.join(base, 'x'), existingBranchOnly: true }))
        .rejects.toMatchObject({ kind: 'bad-branch' })
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('refuses a work-in-progress commit on a detached HEAD', async () => {
    await expect(new GitWorktreeService(fakeGit([]).execute).commitWorkInProgress({ root: '/w', mainRoot: '/m', branch: 'HEAD', head: 'abc' }, 'wip'))
      .rejects.toMatchObject({ message: expect.stringMatching(/detached HEAD/) })
  })

  it('refuses to remove the main checkout', async () => {
    const git = fakeGit([])

    await expect(new GitWorktreeService(git.execute).removeWorktree({
      root: MAIN,
      mainRoot: MAIN,
      branch: 'main',
      head: 'abc',
    })).rejects.toMatchObject({
      kind: 'bad-path',
      message: expect.stringMatching(/main repository checkout/i),
    })
    expect(git.calls).toEqual([])
  })

  it('refuses a path whose registered branch changed', async () => {
    const git = fakeGit([
      [['worktree', 'list', '--porcelain'], `worktree ${target}\nHEAD def\nbranch refs/heads/replacement\n\n`],
    ])

    await expect(new GitWorktreeService(git.execute).removeWorktree({
      root: target,
      mainRoot: MAIN,
      branch: 'bot-rematch-flow',
      head: 'def',
    })).rejects.toMatchObject({
      kind: 'bad-path',
      message: expect.stringMatching(/identity changed/i),
    })
    expect(git.calls.some((call) => call.args[1] === 'remove')).toBe(false)
  })
})
