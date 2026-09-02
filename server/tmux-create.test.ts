import { describe, expect, it, vi } from 'vitest'
import type { GitRepoInfo } from '../shared/tmux-create.js'
import { GitWorktreeError, type CreateWorktreeInput, type CreateWorktreeResult } from './git-worktree.js'
import { TmuxCreator, tmuxSocketArgsFromEnv } from './tmux-create.js'

const separator = '\u001f'
const output = (
  overrides: Partial<{
    sessionId: string
    sessionName: string
    windowId: string
    windowIndex: string
    windowName: string
    paneId: string
    paneIndex: string
    panePath: string
  }> = {},
) => {
  const fields = {
    sessionId: '$4',
    sessionName: 'work',
    windowId: '@8',
    windowIndex: '2',
    windowName: 'editor',
    paneId: '%12',
    paneIndex: '1',
    panePath: '/Users/dev/project',
    ...overrides,
  }
  return `${Object.values(fields).join(separator)}\n`
}

const runner = (response = output()) =>
  vi.fn(async (_args: readonly string[]): Promise<string> => response)

describe('TmuxCreator', () => {
  it('creates a detached named session and returns IDs reported by tmux', async () => {
    const run = runner()
    const creator = new TmuxCreator(run, ['-L', 'commando-test'])

    await expect(
      creator.createSession({
        name: 'work',
        windowName: 'editor',
        cwd: '/Users/dev/project',
      }),
    ).resolves.toEqual({
      created: {
        kind: 'session',
        sessionId: '$4',
        sessionName: 'work',
        windowId: '@8',
        windowIndex: 2,
        windowName: 'editor',
        paneId: '%12',
        paneIndex: 1,
        panePath: '/Users/dev/project',
      },
    })
    expect(run).toHaveBeenCalledOnce()
    expect(run.mock.calls[0][0]).toEqual([
      '-L',
      'commando-test',
      'new-session',
      '-d',
      '-P',
      '-F',
      expect.stringContaining('#{session_id}'),
      '-s',
      'work',
      '-n',
      'editor',
      '-c',
      '/Users/dev/project',
    ])
  })

  it('creates a detached window using only the stable session ID target', async () => {
    const run = runner(output({ windowId: '@9', paneId: '%13' }))
    const creator = new TmuxCreator(run, [])

    await expect(
      creator.createWindow({ sessionId: '$4', name: 'tests' }),
    ).resolves.toMatchObject({ kind: 'window', windowId: '@9', paneId: '%13' })
    expect(run.mock.calls[0][0]).toEqual([
      'new-window',
      '-d',
      '-P',
      '-F',
      expect.any(String),
      '-t',
      '$4',
      '-n',
      'tests',
    ])
  })

  it.each([
    ['horizontal', '-h'],
    ['vertical', '-v'],
  ] as const)('creates a detached %s split', async (direction, flag) => {
    const run = runner(output({ paneId: '%20', paneIndex: '3' }))
    const creator = new TmuxCreator(run, ['-S', '/tmp/commando.sock'])

    await expect(
      creator.createPane({ targetId: '%12', direction, cwd: '/tmp' }),
    ).resolves.toMatchObject({ kind: 'pane', paneId: '%20', paneIndex: 3 })
    expect(run.mock.calls[0][0]).toEqual([
      '-S',
      '/tmp/commando.sock',
      'split-window',
      '-d',
      flag,
      '-P',
      '-F',
      expect.any(String),
      '-t',
      '%12',
      '-c',
      '/tmp',
    ])
  })

  it('accepts a stable window ID as a split target', async () => {
    const run = runner()
    await new TmuxCreator(run, []).createPane({
      targetId: '@8',
      direction: 'vertical',
    })
    expect(run.mock.calls[0][0]).toContain('@8')
  })

  it('places left and upper splits before the target pane', async () => {
    const run = runner()
    const beforeCreate = vi.fn()
    await new TmuxCreator(run, []).createPane({
      targetId: '%12',
      direction: 'horizontal',
      placement: 'before',
    }, beforeCreate)
    expect(beforeCreate).toHaveBeenCalledOnce()
    expect(run.mock.calls[0][0]).toEqual([
      'split-window',
      '-d',
      '-h',
      '-b',
      '-P',
      '-F',
      expect.any(String),
      '-t',
      '%12',
    ])
  })

  it.each(['', ' work', 'work ', 'bad:name', 'bad.name', 'bad\nname'])(
    'rejects invalid session name %j before execution',
    async (name) => {
      const run = runner()
      await expect(new TmuxCreator(run, []).createSession({ name })).rejects.toThrow()
      expect(run).not.toHaveBeenCalled()
    },
  )

  it('rejects invalid optional names before execution', async () => {
    const run = runner()
    const creator = new TmuxCreator(run, [])
    await expect(creator.createWindow({ sessionId: '$1', name: ' bad' })).rejects.toThrow(
      /window name/,
    )
    await expect(
      creator.createSession({ name: 'good', windowName: 'bad\u001fname' }),
    ).rejects.toThrow(/window name/)
    expect(run).not.toHaveBeenCalled()
  })

  it('rejects non-string request fields before execution', async () => {
    const run = runner()
    const creator = new TmuxCreator(run, [])
    await expect(creator.createSession({ name: 7 } as never)).rejects.toThrow(/session name/)
    await expect(
      creator.createWindow({ sessionId: '$1', cwd: false } as never),
    ).rejects.toThrow(/absolute path/)
    await expect(
      creator.createPane({ targetId: 2, direction: 'horizontal' } as never),
    ).rejects.toThrow(/window or pane id/)
    expect(run).not.toHaveBeenCalled()
  })

  it.each(['1', 'work', '$1:2', '$-1'])(
    'rejects invalid session target %j before execution',
    async (sessionId) => {
      const run = runner()
      await expect(
        new TmuxCreator(run, []).createWindow({ sessionId }),
      ).rejects.toThrow(/session id/)
      expect(run).not.toHaveBeenCalled()
    },
  )

  it.each(['12', '$1', '@1;kill-server', '%-1'])(
    'rejects invalid split target %j before execution',
    async (targetId) => {
      const run = runner()
      await expect(
        new TmuxCreator(run, []).createPane({ targetId, direction: 'horizontal' }),
      ).rejects.toThrow(/window or pane id/)
      expect(run).not.toHaveBeenCalled()
    },
  )

  it('rejects an unsupported split direction before execution', async () => {
    const run = runner()
    await expect(
      new TmuxCreator(run, []).createPane({
        targetId: '%1',
        direction: 'diagonal' as never,
      }),
    ).rejects.toThrow(/split direction/)
    expect(run).not.toHaveBeenCalled()
  })

  it('rejects an unsupported split placement before execution', async () => {
    const run = runner()
    const beforeCreate = vi.fn()
    await expect(
      new TmuxCreator(run, []).createPane({
        targetId: '%1',
        direction: 'horizontal',
        placement: 'around' as never,
      }, beforeCreate),
    ).rejects.toThrow(/split placement/)
    expect(beforeCreate).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
  })

  it.each(['relative/path', '/tmp\nnext', `/${'x'.repeat(4_096)}`])(
    'rejects invalid working directory %j before execution',
    async (cwd) => {
      const run = runner()
      await expect(
        new TmuxCreator(run, []).createSession({ name: 'work', cwd }),
      ).rejects.toThrow(/absolute path/)
      expect(run).not.toHaveBeenCalled()
    },
  )

  it.each([
    '',
    output({ sessionId: '4' }),
    output({ windowId: '8' }),
    output({ paneId: '12' }),
    output({ sessionName: '' }),
    output({ windowIndex: '' }),
    output({ windowIndex: '-1' }),
    output({ panePath: 'relative' }),
    output({ paneIndex: 'NaN' }),
    `${output()}${output()}`,
  ])('rejects malformed tmux format output', async (response) => {
    const creator = new TmuxCreator(async () => response, [])
    await expect(creator.createSession({ name: 'work' })).rejects.toThrow(
      /invalid create response/,
    )
  })

  it('does not add empty optional arguments', async () => {
    const run = runner()
    await new TmuxCreator(run, []).createSession({ name: 'work', cwd: '', windowName: '' })
    expect(run.mock.calls[0][0]).toEqual([
      'new-session',
      '-d',
      '-P',
      '-F',
      expect.any(String),
      '-s',
      'work',
    ])
  })
})

describe('tmux socket arguments', () => {
  it('matches the daemon socket name and absolute path conventions', () => {
    expect(tmuxSocketArgsFromEnv({ COMMANDO_TMUX_SOCKET_NAME: 'commando.test-1' })).toEqual([
      '-L',
      'commando.test-1',
    ])
    expect(
      tmuxSocketArgsFromEnv({ COMMANDO_TMUX_SOCKET_PATH: '/tmp/commando.sock' }),
    ).toEqual(['-S', '/tmp/commando.sock'])
    expect(tmuxSocketArgsFromEnv({})).toEqual([])
  })

  it('rejects conflicting or unsafe socket configuration', () => {
    expect(() =>
      tmuxSocketArgsFromEnv({
        COMMANDO_TMUX_SOCKET_NAME: 'commando',
        COMMANDO_TMUX_SOCKET_PATH: '/tmp/commando.sock',
      }),
    ).toThrow(/only one/)
    expect(() => tmuxSocketArgsFromEnv({ COMMANDO_TMUX_SOCKET_PATH: 'relative' })).toThrow(
      /absolute path/,
    )
    expect(() =>
      tmuxSocketArgsFromEnv({ COMMANDO_TMUX_SOCKET_NAME: 'bad;name' }),
    ).toThrow(/unsupported characters/)
  })
})

describe('TmuxCreator worktree-backed sessions', () => {
  const MAIN = '/Users/dev/gizmo/Save-All'
  const target = `${MAIN}-worktrees/bot-rematch-flow`
  const repo: GitRepoInfo = { isRepo: true, root: MAIN, mainRoot: MAIN, name: 'Save-All', branch: 'main', isWorktree: false, defaultBranch: 'main', remote: 'origin' }

  function worktrees(overrides: Partial<{ probe: GitRepoInfo; fail: Error }> = {}) {
    const rollback = vi.fn(async () => undefined)
    const createWorktree = vi.fn(async (input: CreateWorktreeInput): Promise<CreateWorktreeResult> => {
      if (overrides.fail) throw overrides.fail
      return { worktree: { path: input.path, branch: input.branch, base: 'origin/main', reusedBranch: false }, rollback }
    })
    const probe = vi.fn(async (): Promise<GitRepoInfo> => overrides.probe ?? repo)
    return { probe, createWorktree, rollback }
  }

  /** tmux runner: `has-session` reports the name free, everything else returns the created target. */
  function tmuxRunner(options: { nameTaken?: boolean; createFails?: boolean } = {}) {
    return vi.fn(async (args: readonly string[]): Promise<string> => {
      if (args.includes('has-session')) {
        if (options.nameTaken) return ''
        throw new Error("can't find session")
      }
      if (options.createFails) throw new Error('tmux create command failed')
      return output({ panePath: target })
    })
  }

  it('creates the worktree first and starts the session inside it', async () => {
    const git = worktrees()
    const run = tmuxRunner()
    const creator = new TmuxCreator(run, [], git)
    const result = await creator.createSession({
      name: 'Bot rematch flow',
      cwd: `${MAIN}/apps`,
      worktree: { branch: 'bot-rematch-flow', path: target },
    })
    expect(result.worktree).toEqual({ path: target, branch: 'bot-rematch-flow', base: 'origin/main', reusedBranch: false })
    expect(result.created.panePath).toBe(target)
    expect(git.probe).toHaveBeenCalledWith(`${MAIN}/apps`)
    expect(git.createWorktree).toHaveBeenCalledWith({ mainRoot: MAIN, branch: 'bot-rematch-flow', path: target, defaultBranch: 'main', remote: 'origin' })
    const createArgs = run.mock.calls.map((call) => call[0]).find((args) => args.includes('new-session'))
    expect(createArgs?.slice(-2)).toEqual(['-c', target])
    expect(git.rollback).not.toHaveBeenCalled()
  })

  it('defaults the worktree path to the sibling worktrees folder', async () => {
    const git = worktrees()
    const creator = new TmuxCreator(tmuxRunner(), [], git)
    await creator.createSession({ name: 'flow', cwd: MAIN, worktree: { branch: 'bot-rematch-flow' } })
    expect(git.createWorktree.mock.calls[0][0].path).toBe(target)
  })

  it('checks the session name is free before touching git', async () => {
    const git = worktrees()
    const creator = new TmuxCreator(tmuxRunner({ nameTaken: true }), [], git)
    await expect(
      creator.createSession({ name: 'flow', cwd: MAIN, worktree: { branch: 'bot-rematch-flow' } }),
    ).rejects.toThrow(/already exists/)
    expect(git.createWorktree).not.toHaveBeenCalled()
  })

  it('refuses a worktree request for a directory that is not a repository', async () => {
    const git = worktrees({ probe: { isRepo: false } })
    const creator = new TmuxCreator(tmuxRunner(), [], git)
    await expect(
      creator.createSession({ name: 'flow', cwd: '/tmp/plain', worktree: { branch: 'flow' } }),
    ).rejects.toMatchObject({ kind: 'not-repo' })
    expect(git.createWorktree).not.toHaveBeenCalled()
  })

  it('rolls the worktree back when tmux fails afterwards', async () => {
    const git = worktrees()
    const creator = new TmuxCreator(tmuxRunner({ createFails: true }), [], git)
    await expect(
      creator.createSession({ name: 'flow', cwd: MAIN, worktree: { branch: 'bot-rematch-flow' } }),
    ).rejects.toThrow(/tmux create command failed/)
    expect(git.rollback).toHaveBeenCalledOnce()
  })

  it('passes git failures through untouched', async () => {
    const git = worktrees({ fail: new GitWorktreeError('branch-checked-out', 'Branch flow is already checked out at /elsewhere') })
    const creator = new TmuxCreator(tmuxRunner(), [], git)
    await expect(
      creator.createSession({ name: 'flow', cwd: MAIN, worktree: { branch: 'flow' } }),
    ).rejects.toMatchObject({ kind: 'branch-checked-out' })
  })

  it('requires a worktree service when a worktree is requested', async () => {
    const creator = new TmuxCreator(tmuxRunner(), [])
    await expect(
      creator.createSession({ name: 'flow', cwd: MAIN, worktree: { branch: 'flow' } }),
    ).rejects.toThrow(/worktree/i)
  })

  it('requires a working directory when a worktree is requested', async () => {
    const creator = new TmuxCreator(tmuxRunner(), [], worktrees())
    await expect(creator.createSession({ name: 'flow', worktree: { branch: 'flow' } })).rejects.toThrow(/working directory/i)
  })
})
