import { describe, expect, it, vi } from 'vitest'
import type { GitExecutorOptions } from './git-diff.js'
import { GitWorktreeError, GitWorktreeService } from './git-worktree.js'

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

describe('GitWorktreeService.createWorktree', () => {
  const target = `${MAIN}-worktrees/bot-rematch-flow`

  it('fetches the default branch, creates the branch from the remote ref, and adds the worktree', async () => {
    const git = fakeGit([
      [['rev-parse', '--verify', '--quiet', 'refs/heads/bot-rematch-flow'], exit(1)],
      [['fetch', 'origin', 'main'], ''],
      [['worktree', 'add', '-b', 'bot-rematch-flow', target, 'origin/main'], ''],
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
      ['worktree', 'add', '-b', 'bot-rematch-flow', target, 'origin/main'],
    ])
    expect(git.calls.every((call) => call.cwd === MAIN)).toBe(true)
  })

  it('keeps going from the local remote-tracking ref with a warning when the fetch fails', async () => {
    const git = fakeGit([
      [['rev-parse', '--verify', '--quiet', 'refs/heads/bot-rematch-flow'], exit(1)],
      [['fetch', 'origin', 'main'], exit(128, 'fatal: unable to access')],
      [['show-ref', '--verify', '--quiet', 'refs/remotes/origin/main'], ''],
      [['worktree', 'add', '-b', 'bot-rematch-flow', target, 'origin/main'], ''],
    ])
    const service = new GitWorktreeService(git.execute, { pathExists: async () => false })
    const result = await service.createWorktree({ mainRoot: MAIN, branch: 'bot-rematch-flow', path: target, defaultBranch: 'main', remote: 'origin' })
    expect(result.worktree.base).toBe('origin/main')
    expect(result.worktree.warning).toMatch(/fetch/i)
  })

  it('branches from HEAD when there is no remote default branch', async () => {
    const git = fakeGit([
      [['rev-parse', '--verify', '--quiet', 'refs/heads/bot-rematch-flow'], exit(1)],
      [['worktree', 'add', '-b', 'bot-rematch-flow', target, 'HEAD'], ''],
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
      [['worktree', 'add', target, 'bot-rematch-flow'], ''],
    ])
    const service = new GitWorktreeService(git.execute, { pathExists: async () => false })
    const result = await service.createWorktree({ mainRoot: MAIN, branch: 'bot-rematch-flow', path: target, defaultBranch: 'main', remote: 'origin' })
    expect(result.worktree).toEqual({ path: target, branch: 'bot-rematch-flow', base: '', reusedBranch: true })
    expect(git.calls.some((call) => call.args[0] === 'fetch')).toBe(false)
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
    expect(same.calls.some((call) => call.args[0] === 'worktree' && call.args[1] === 'add')).toBe(false)
  })

  it('rejects branch names git would refuse', async () => {
    const git = fakeGit([])
    const service = new GitWorktreeService(git.execute)
    await expect(service.createWorktree({ mainRoot: MAIN, branch: 'bad..name', path: target })).rejects.toBeInstanceOf(GitWorktreeError)
    await expect(service.createWorktree({ mainRoot: MAIN, branch: '-leading', path: target })).rejects.toMatchObject({ kind: 'bad-branch' })
    expect(git.execute).not.toHaveBeenCalled()
  })

  it('rollback removes the worktree and deletes only a branch this call created', async () => {
    const created = fakeGit([
      [['rev-parse', '--verify', '--quiet', 'refs/heads/bot-rematch-flow'], exit(1)],
      [['worktree', 'add'], ''],
      [['worktree', 'remove', '--force', target], ''],
      [['branch', '-D', 'bot-rematch-flow'], ''],
    ])
    const fresh = await new GitWorktreeService(created.execute, { pathExists: async () => false })
      .createWorktree({ mainRoot: MAIN, branch: 'bot-rematch-flow', path: target })
    await fresh.rollback()
    expect(created.calls.slice(-2).map((call) => call.args)).toEqual([
      ['worktree', 'remove', '--force', target],
      ['branch', '-D', 'bot-rematch-flow'],
    ])

    const reused = fakeGit([
      [['rev-parse', '--verify', '--quiet', 'refs/heads/bot-rematch-flow'], 'abc\n'],
      [['worktree', 'list', '--porcelain'], `worktree ${MAIN}\nHEAD abc\nbranch refs/heads/main\n\n`],
      [['worktree', 'add'], ''],
      [['worktree', 'remove', '--force', target], ''],
    ])
    const existing = await new GitWorktreeService(reused.execute, { pathExists: async () => false })
      .createWorktree({ mainRoot: MAIN, branch: 'bot-rematch-flow', path: target })
    await existing.rollback()
    expect(reused.calls.some((call) => call.args[0] === 'branch')).toBe(false)
  })

  it('bounds the fetch with the configured timeout', async () => {
    const git = fakeGit([
      [['rev-parse', '--verify', '--quiet', 'refs/heads/bot-rematch-flow'], exit(1)],
      [['fetch'], ''],
      [['worktree', 'add'], ''],
    ])
    const service = new GitWorktreeService(git.execute, { pathExists: async () => false, fetchTimeoutMs: 1234 })
    await service.createWorktree({ mainRoot: MAIN, branch: 'bot-rematch-flow', path: target, defaultBranch: 'main', remote: 'origin' })
    expect(git.calls.find((call) => call.args[0] === 'fetch')?.timeout).toBe(1234)
  })
})
