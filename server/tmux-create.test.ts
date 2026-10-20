import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { chatProfileConfigDir, defaultClaudeProfile, sessionAgentArgv, type GitRepoInfo } from '../shared/tmux-create.js'
import { GitWorktreeError, type CreateWorktreeInput, type CreateWorktreeResult } from './git-worktree.js'
import { TmuxCreator, AGENT_LAUNCH_ENV_KEYS, COMMANDO_AGENT_LAUNCHER, agentLaunchPaneCommand, listClaudeProfiles, validClaudeConfigDir, agentLaunchShellCommand, emptyPaneCommand, emptyPaneShellCommand, tmuxSocketArgsFromEnv, worktreePreparationShellCommand } from './tmux-create.js'
import { chatPlansDir } from './chat-plans-dir.js'

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
    paneStartPath: string
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
    paneStartPath: '/Users/dev/project',
    ...overrides,
  }
  return `${Object.values(fields).join(separator)}\n`
}

const runner = (response = output()) =>
  vi.fn(async (_args: readonly string[]): Promise<string> => response)

describe('TmuxCreator', () => {
  it('creates and prepares a pane worktree before launching, and marks its lineage', async () => {
    const rollback = vi.fn(async () => {})
    const worktree = { path: '/repo/worktrees/fix', branch: 'fix', base: 'main', reusedBranch: false }
    const git = { probe: vi.fn(async () => ({ isRepo: true, mainRoot: '/repo', defaultBranch: 'main' } as GitRepoInfo)), createWorktree: vi.fn(async () => ({ worktree, rollback })) }
    const run = runner(output({ panePath: worktree.path }))
    const before = vi.fn(async () => {})
    const creator = new TmuxCreator(run, ['-L', 'test'], git, async () => '/host/bin/codex', {})
    const result = await creator.createPane({ targetId: '%1', direction: 'horizontal', cwd: '/repo/src', worktree: { branch: 'fix', prepareCommand: 'npm ci\nnpm run build' }, agent: { provider: 'codex', prompt: 'Brief\nsecond line' } }, before)
    expect(result).toMatchObject({ paneId: '%12', panePath: worktree.path, worktree, agentLaunch: { provider: 'codex', state: 'initiated' } })
    expect(git.createWorktree).toHaveBeenCalledWith(expect.objectContaining({ mainRoot: '/repo', branch: 'fix', path: expect.stringContaining('fix') }))
    const args = run.mock.calls[0][0]
    expect(args.slice(args.indexOf('-c'), args.indexOf('-c') + 2)).toEqual(['-c', worktree.path])
    expect(args.at(-1)).toBe(agentLaunchPaneCommand(['/host/bin/codex', '--', 'Brief\nsecond line'], 'npm ci\nnpm run build', {}))
    expect(before.mock.invocationCallOrder[0]).toBeGreaterThan(git.createWorktree.mock.invocationCallOrder[0])
    expect(rollback).not.toHaveBeenCalled()
    await creator.setChatLineage('%12', 'parent-target', 'Fix bug')
    expect(run.mock.calls.slice(1).map(([args]) => args)).toEqual([
      ['-L', 'test', 'set-option', '-p', '-t', '%12', '@commando_opened_by', 'parent-target'],
      ['-L', 'test', 'set-option', '-p', '-t', '%12', '@commando_chat_title', 'Fix bug'],
    ])
  })

  it('rolls back a pane worktree if splitting fails; preserves it after a successful split with malformed output', async () => {
    const rollback = vi.fn(async () => {})
    const git = { probe: vi.fn(async () => ({ isRepo: true, mainRoot: '/repo' } as GitRepoInfo)), createWorktree: vi.fn(async () => ({ worktree: { path: '/repo/fix', branch: 'fix', base: 'main', reusedBranch: false }, rollback })) }
    const run = vi.fn(async (args: readonly string[]) => {
      if (args.includes('list-panes')) return '/repo\n/repo/fixture-other\n'
      throw new Error('not enough space')
    })
    const input = { targetId: '%1', direction: 'horizontal', cwd: '/repo', worktree: { branch: 'fix' } } as const
    await expect(new TmuxCreator(run, [], git).createPane(input)).rejects.toThrow('not enough space')
    expect(rollback).toHaveBeenCalledOnce()
    rollback.mockClear()
    await expect(new TmuxCreator(runner('bad output'), [], git).createPane(input)).rejects.toThrow('invalid create response')
    expect(rollback).not.toHaveBeenCalled()
  })

  it('keeps a pane worktree when an ambiguous split failure may have created a pane in it', async () => {
    const rollback = vi.fn(async () => {})
    const git = { probe: vi.fn(async () => ({ isRepo: true, mainRoot: '/repo' } as GitRepoInfo)), createWorktree: vi.fn(async () => ({ worktree: { path: '/repo/fix', branch: 'fix', base: 'main', reusedBranch: false }, rollback })) }
    const input = { targetId: '%1', direction: 'horizontal', cwd: '/repo', worktree: { branch: 'fix' } } as const
    const splitThenTimeout = vi.fn(async (args: readonly string[]) => {
      if (args.includes('list-panes')) return '/repo\n/repo/fix/src\n'
      throw new Error('tmux timed out')
    })
    await expect(new TmuxCreator(splitThenTimeout, [], git).createPane(input)).rejects.toThrow('may have been created but tmux did not report it; the worktree was kept: tmux timed out')
    const tmuxUnreachable = vi.fn(async () => { throw new Error('no server') })
    await expect(new TmuxCreator(tmuxUnreachable, [], git).createPane(input)).rejects.toThrow('the worktree was kept')
    expect(rollback).not.toHaveBeenCalled()
  })

  it('recognises a pane in a worktree given with a trailing slash or through a symlink', async () => {
    const { mkdtemp, mkdir, realpath: real, symlink, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const base = await mkdtemp(join(tmpdir(), 'pane-worktree-'))
    try {
      await mkdir(join(base, 'real', 'fix'), { recursive: true })
      await symlink(join(base, 'real'), join(base, 'link'))
      const realFix = await real(join(base, 'real', 'fix'))
      const rollback = vi.fn(async () => {})
      const run = vi.fn(async (args: readonly string[]) => {
        if (args.includes('list-panes')) return `${realFix}\n`
        throw new Error('tmux timed out')
      })
      for (const path of [`${realFix}/`, join(base, 'link', 'fix')]) {
        const git = { probe: vi.fn(async () => ({ isRepo: true, mainRoot: '/repo' } as GitRepoInfo)), createWorktree: vi.fn(async () => ({ worktree: { path, branch: 'fix', base: 'main', reusedBranch: false }, rollback })) }
        await expect(new TmuxCreator(run, [], git).createPane({ targetId: '%1', direction: 'horizontal', cwd: '/repo', worktree: { branch: 'fix' } })).rejects.toThrow('the worktree was kept')
      }
      expect(rollback).not.toHaveBeenCalled()
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  })

  it('includes pane worktree rollback failures in the error and validates preparation before mutation', async () => {
    const rollback = vi.fn(async () => { throw new Error('dirty worktree') })
    const git = { probe: vi.fn(async () => ({ isRepo: true, mainRoot: '/repo' } as GitRepoInfo)), createWorktree: vi.fn(async () => ({ worktree: { path: '/repo/fix', branch: 'fix', base: 'main', reusedBranch: false }, rollback })) }
    const run = vi.fn(async (args: readonly string[]) => {
      if (args.includes('list-panes')) return '/repo\n'
      throw new Error('split failed')
    })
    const creator = new TmuxCreator(run, [], git)
    await expect(creator.createPane({ targetId: '%1', direction: 'vertical', cwd: '/repo', worktree: null } as never)).rejects.toThrow('worktree must be an object')
    await expect(creator.createPane({ targetId: '%1', direction: 'vertical', cwd: '/repo', worktree: { branch: 'fix', prepareCommand: 'bad\0command' } })).rejects.toThrow('control')
    expect(git.createWorktree).not.toHaveBeenCalled()
    await expect(creator.createPane({ targetId: '%1', direction: 'vertical', cwd: '/repo', worktree: { branch: 'fix' } })).rejects.toThrow('split failed; worktree rollback failed: dirty worktree')
  })

  it('starts Cursor with literal argv in the newly owned PTY and scopes daemon environment to that session', async () => {
    const run = runner()
    const resolve = vi.fn(async () => '/host/bin/agent')
    const env = { PATH: '/host/bin:/bin', COMMANDO_PORT: '4410', COMMANDO_TOKEN: 'fixture-token', COMMANDO_TMUX_SOCKET_NAME: 'test-create', TMUX_PANE: '%old' }
    const creator = new TmuxCreator(run, ['-L', 'test-create'], undefined, resolve, env)
    const prompt = "--force\nLeo's $HOME `touch /tmp/should-not-exist`"
    const result = await creator.createSession({ name: 'cursor', cwd: '/tmp', agent: { provider: 'cursor', prompt } })
    expect(result.agentLaunch).toEqual({ version: 1, provider: 'cursor', mode: 'interactive-pty', state: 'initiated', paneId: '%12' })
    expect(resolve).toHaveBeenCalledWith('agent', env)
    expect(run).toHaveBeenCalledOnce()
    const args = run.mock.calls[0][0]
    expect(args).toContain('new-session')
    expect(args).not.toContain('send-keys')
    expect(args).not.toContain('TMUX_PANE=%old')
    expect(args).toContain('COMMANDO_PORT=4410')
    expect(args).toContain('COMMANDO_TOKEN=fixture-token')
    expect(args).toContain('COMMANDO_TMUX_SOCKET_NAME=test-create')
    expect(args.at(-1)).toBe(agentLaunchPaneCommand(['/host/bin/agent', 'agent', '--', prompt], undefined, env))
  })

  it('forwards only the narrow allowlist and removes omitted profile variables before exec', async () => {
    const env = Object.fromEntries(AGENT_LAUNCH_ENV_KEYS.map((key) => [key, `/daemon/${key}`]))
    delete env.CURSOR_CONFIG_DIR
    env.UNRELATED_SECRET = 'must-not-be-forwarded'
    const run = runner()
    await new TmuxCreator(run, [], undefined, async () => '/host/bin/agent', env).createSession({ name: 'cursor', agent: { provider: 'cursor' } })
    const args = run.mock.calls[0][0]
    for (const key of AGENT_LAUNCH_ENV_KEYS.filter((key) => key !== 'CURSOR_CONFIG_DIR')) expect(args).toContain(`${key}=${env[key]}`)
    expect(args.at(-1)).toContain('unset CURSOR_CONFIG_DIR')
    expect(args.join(' ')).not.toContain('UNRELATED_SECRET')
    expect(args.join(' ')).not.toContain('must-not-be-forwarded')
    expect(args.at(-1)).toMatch(/^exec /)
  })

  it('rejects a missing CLI before creating a session or a worktree', async () => {
    const run = runner()
    const git = { probe: vi.fn(), createWorktree: vi.fn() }
    const resolve = vi.fn(async () => { throw new Error('Cannot start agent: executable not found on the daemon PATH') })
    const creator = new TmuxCreator(run, [], git, resolve)
    await expect(creator.createSession({ name: 'cursor', cwd: '/tmp', agent: { provider: 'cursor' }, worktree: { branch: 'cursor' } })).rejects.toThrow('executable not found')
    expect(run).not.toHaveBeenCalled()
    expect(git.probe).not.toHaveBeenCalled()
    expect(git.createWorktree).not.toHaveBeenCalled()
  })

  it.each([null, [], 'cursor', { provider: 'cursor-editor' }, { provider: 'toString' }, { provider: 'cursor', prompt: 1 }, { provider: 'cursor', prompt: 'x\0y' }, { provider: 'cursor', prompt: 'x'.repeat(8193) }])('rejects invalid launch %j before execution', async (agent) => {
    const run = runner()
    const resolve = vi.fn()
    await expect(new TmuxCreator(run, [], undefined, resolve).createSession({ name: 'test', agent } as never)).rejects.toThrow()
    expect(run).not.toHaveBeenCalled()
    expect(resolve).not.toHaveBeenCalled()
  })

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

  it.each(['session', 'window', 'pane'] as const)(
    'uses the starting directory when a new %s has no current path yet',
    async (kind) => {
      const creator = new TmuxCreator(runner(output({ panePath: '', paneStartPath: '/tmp/new worktree' })), [])
      const created = kind === 'session'
        ? (await creator.createSession({ name: 'work' })).created
        : kind === 'window'
          ? await creator.createWindow({ sessionId: '$4' })
          : await creator.createPane({ targetId: '%12', direction: 'horizontal' })

      expect(created).toMatchObject({ kind, panePath: '/tmp/new worktree' })
    },
  )

  it('prefers the live current directory when it is available', async () => {
    const creator = new TmuxCreator(runner(output({ paneStartPath: '/tmp/original' })), [])
    await expect(creator.createSession({ name: 'work' })).resolves.toMatchObject({
      created: { panePath: '/Users/dev/project' },
    })
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
    output({ panePath: '', paneStartPath: '' }),
    output({ panePath: '', paneStartPath: 'relative' }),
    output({ panePath: '', paneStartPath: '/tmp/bad\u0000path' }),
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

describe('empty sessions', () => {
  it('starts an idle pane and marks it empty', async () => {
    const run = runner()
    const result = await new TmuxCreator(run, ['-L', 'test']).createSession({ name: 'work', cwd: '/tmp', empty: true })
    expect(result.agentLaunch).toBeUndefined()
    expect(run.mock.calls.map(([args]) => args)).toEqual([
      ['-L', 'test', 'new-session', '-d', '-P', '-F', expect.any(String), '-s', 'work', '-c', '/tmp', emptyPaneCommand()],
      ['-L', 'test', 'set-option', '-p', '-F', '-t', '%12', '@commando_empty', '#{pane_pid}'],
    ])
    expect(emptyPaneShellCommand()).toMatch(/exec tail -f \/dev\/null$/)
  })

  it('hands back a shell session instead of an orphan when the pane cannot be marked', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const run = vi.fn(async (args: readonly string[]): Promise<string> => {
      if (args.includes('set-option')) throw new Error('tmux create command timed out')
      return output()
    })
    const result = await new TmuxCreator(run, []).createSession({ name: 'work', empty: true })
    expect(result.created.paneId).toBe('%12')
    expect(run.mock.calls.at(-1)?.[0]).toEqual(['respawn-pane', '-k', '-t', '%12', 'exec "${SHELL:-/bin/sh}" -l'])
  })

  it('reports a created session whose pane could neither be marked nor turned into a shell', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const run = vi.fn(async (args: readonly string[]): Promise<string> => {
      if (args.includes('set-option') || args.includes('respawn-pane')) throw new Error('tmux create command timed out')
      return output()
    })
    await expect(new TmuxCreator(run, []).createSession({ name: 'work', empty: true })).rejects.toThrow('Session work was created')
  })

  it('rejects an empty session that also starts an agent', async () => {
    const run = runner()
    await expect(new TmuxCreator(run, []).createSession({ name: 'work', empty: true, agent: { provider: 'codex' } })).rejects.toThrow('cannot also start')
    await expect(new TmuxCreator(run, []).createSession({ name: 'work', empty: 'yes' } as never)).rejects.toThrow('boolean')
    expect(run).not.toHaveBeenCalled()
  })

  it('lets a preparing pane mark itself empty once preparation succeeds', async () => {
    const run = vi.fn(async (args: readonly string[]) => {
      if (args.includes('has-session')) throw new Error("can't find session")
      return output()
    })
    const git = {
      probe: async (): Promise<GitRepoInfo> => ({ isRepo: true, root: '/repo', mainRoot: '/repo' }),
      createWorktree: async (input: CreateWorktreeInput): Promise<CreateWorktreeResult> => ({ worktree: { path: input.path, branch: input.branch, base: '', reusedBranch: false }, rollback: async () => {} }),
    }
    const resolve = vi.fn(async () => '/opt/bin/tmux')
    await new TmuxCreator(run, [], git, resolve, {}).createSession({ name: 'work', cwd: '/repo', empty: true, worktree: { branch: 'work', prepareCommand: 'pnpm i' } })
    const script = emptyPaneShellCommand({ command: 'pnpm i', tmux: '/opt/bin/tmux' })
    expect(resolve).toHaveBeenCalledWith('tmux', {})
    expect(run.mock.calls.find(([args]) => args.includes('new-session'))?.[0].at(-1)).toBe(emptyPaneCommand({ command: 'pnpm i', tmux: '/opt/bin/tmux' }))
    expect(run.mock.calls.some(([args]) => args.includes('set-option'))).toBe(false)
    // A failed preparation leaves a shell to investigate in, not an empty launcher.
    expect(script.indexOf('pnpm i')).toBeLessThan(script.indexOf("'/opt/bin/tmux' set-option -p -t \"$TMUX_PANE\" @commando_empty \"$$\""))
    expect(script.indexOf('exec "${SHELL:-/bin/sh}" -l')).toBeLessThan(script.indexOf('set-option'))
  })
})

describe('switching a chat pane to another conversation', () => {
  it('respawns the pane in the conversation folder with a chat resuming it', async () => {
    const run = vi.fn(async (_args: readonly string[]): Promise<string> => '')
    const env = { COMMANDO_PORT: '4410' }
    const agent = { provider: 'claude-chat' as const, configDir: `${homedir()}/.claudep`, permissionMode: 'plan' as const, resume: 'abcd1234-0000' }
    await new TmuxCreator(run, ['-L', 'test'], undefined, undefined, env).respawnChatPane('%3', '/work/app', agent)
    const args = run.mock.calls[0]![0]
    expect(args.slice(0, 8)).toEqual(['-L', 'test', 'respawn-pane', '-k', '-t', '%3', '-c', '/work/app'])
    expect(args).toContain('COMMANDO_PORT=4410')
    expect(args.at(-1)).toBe(agentLaunchPaneCommand([COMMANDO_AGENT_LAUNCHER, ...sessionAgentArgv(agent).slice(1)], undefined, env))
    expect(sessionAgentArgv(agent)).toEqual(['commando-agent', 'claude', '--config-dir', `${homedir()}/.claudep`, '--permission-mode', 'plan', '--resume', 'abcd1234-0000'])
  })

  it('respawns a Cursor chat in the conversation folder with a chat resuming it', async () => {
    const run = vi.fn(async (_args: readonly string[]): Promise<string> => '')
    const env = { COMMANDO_PORT: '4410' }
    const agent = { provider: 'cursor-chat' as const, permissionMode: 'auto' as const, resume: 'agent-abcd1234-0000' }
    await new TmuxCreator(run, ['-L', 'test'], undefined, undefined, env).respawnChatPane('%3', '/work/app', agent)
    const args = run.mock.calls[0]![0]
    expect(args.slice(0, 8)).toEqual(['-L', 'test', 'respawn-pane', '-k', '-t', '%3', '-c', '/work/app'])
    expect(args).toContain('COMMANDO_PORT=4410')
    expect(args.at(-1)).toBe(agentLaunchPaneCommand([COMMANDO_AGENT_LAUNCHER, ...sessionAgentArgv(agent).slice(1)], undefined, env))
    expect(sessionAgentArgv(agent)).toEqual(['commando-agent', 'cursor', '--permission-mode', 'auto', '--resume', 'agent-abcd1234-0000'])
  })

  it('only starts chats, on a valid conversation id', async () => {
    const run = vi.fn(async (_args: readonly string[]): Promise<string> => '')
    const creator = new TmuxCreator(run, [])
    await expect(creator.respawnChatPane('%3', '/work', { provider: 'codex' })).rejects.toThrow('Only a chat')
    await expect(creator.respawnChatPane('%3', '/work', { provider: 'claude-chat', resume: '$(rm -rf)' })).rejects.toThrow('Invalid conversation id')
    await expect(creator.respawnChatPane('%3', 'relative', { provider: 'claude-chat' })).rejects.toThrow('absolute path')
    expect(run).not.toHaveBeenCalled()
  })
})

describe('launching into an empty pane', () => {
  const tmux = (marker: string, options: { respawnFails?: boolean } = {}) => vi.fn(async (args: readonly string[]): Promise<string> => {
    if (args.includes('display-message')) return `${marker} 4321\n`
    if (args.includes('respawn-pane') && options.respawnFails) throw new Error('respawn failed')
    return ''
  })

  it('clears the marker, then replaces the idle process with a login shell', async () => {
    const run = tmux('4321')
    await new TmuxCreator(run, ['-L', 'test']).launchInEmptyPane({ paneId: '%3' })
    expect(run.mock.calls.map(([args]) => args)).toEqual([
      ['-L', 'test', 'display-message', '-p', '-t', '%3', '#{@commando_empty} #{pane_pid}'],
      ['-L', 'test', 'set-option', '-p', '-u', '-t', '%3', '@commando_empty'],
      ['-L', 'test', 'respawn-pane', '-k', '-t', '%3', 'exec "${SHELL:-/bin/sh}" -l'],
    ])
  })

  it('starts an agent with the daemon environment scoped to the pane', async () => {
    const run = tmux('4321')
    const env = { COMMANDO_PORT: '4410' }
    await new TmuxCreator(run, [], undefined, async () => '/host/bin/codex', env).launchInEmptyPane({ paneId: '%3', agent: { provider: 'codex', prompt: 'Hi' } })
    const respawn = run.mock.calls.map(([args]) => args).find((args) => args.includes('respawn-pane'))!
    expect(respawn).toContain('COMMANDO_PORT=4410')
    expect(respawn.at(-1)).toBe(agentLaunchPaneCommand(['/host/bin/codex', ...sessionAgentArgv({ provider: 'codex', prompt: 'Hi' }).slice(1)], undefined, env))
  })

  it('never touches a pane that is already running something', async () => {
    const run = tmux('999')
    await expect(new TmuxCreator(run, []).launchInEmptyPane({ paneId: '%3' })).rejects.toThrow('already running')
    await expect(new TmuxCreator(tmux(''), []).launchInEmptyPane({ paneId: '%3' })).rejects.toThrow('already running')
    expect(run).toHaveBeenCalledOnce()
    await expect(new TmuxCreator(run, []).launchInEmptyPane({ paneId: '3' })).rejects.toThrow('Invalid tmux pane id')
  })

  it('refuses a second launch into a pane that is still starting', async () => {
    let release!: (value: string) => void
    const run = vi.fn(async (args: readonly string[]): Promise<string> => args.includes('display-message')
      ? new Promise<string>((resolve) => { release = resolve })
      : '')
    const creator = new TmuxCreator(run, [])
    const first = creator.launchInEmptyPane({ paneId: '%3' })
    await expect(creator.launchInEmptyPane({ paneId: '%3' })).rejects.toThrow('already starting')
    release('4321 4321\n')
    await first
    expect(run.mock.calls.filter(([args]) => args.includes('respawn-pane'))).toHaveLength(1)
  })

  it('marks the pane empty again when the launch fails', async () => {
    const run = tmux('4321', { respawnFails: true })
    await expect(new TmuxCreator(run, []).launchInEmptyPane({ paneId: '%3' })).rejects.toThrow('respawn failed')
    // The idle pid, not whatever runs now: a respawn that ran despite failing must not read as empty.
    expect(run.mock.calls.at(-1)?.[0]).toEqual(['set-option', '-p', '-t', '%3', '@commando_empty', '4321'])
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

  function worktrees(overrides: Partial<{ probe: GitRepoInfo; fail: Error; rollbackFail: Error }> = {}) {
    const rollback = vi.fn(async () => {
      if (overrides.rollbackFail) throw overrides.rollbackFail
    })
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

  it('defaults the worktree path under the configured worktree root the probe reports', async () => {
    const git = worktrees({ probe: { ...repo, worktreeRoot: '/Volumes/Dev/worktrees' } })
    const creator = new TmuxCreator(tmuxRunner(), [], git)
    await creator.createSession({ name: 'flow', cwd: MAIN, worktree: { branch: 'bot-rematch-flow' } })
    expect(git.createWorktree.mock.calls[0][0].path).toBe('/Volumes/Dev/worktrees/Save-All-worktrees/bot-rematch-flow')
    await creator.createPane({ targetId: '%1', direction: 'horizontal', cwd: MAIN, worktree: { branch: 'pane-flow' } })
    expect(git.createWorktree.mock.calls.at(-1)?.[0].path).toBe('/Volumes/Dev/worktrees/Save-All-worktrees/pane-flow')
  })

  it('runs the repository preparation command in the new pane before opening a shell', async () => {
    const git = worktrees()
    const run = tmuxRunner()
    const creator = new TmuxCreator(run, [], git)
    await creator.createSession({
      name: 'flow',
      cwd: MAIN,
      worktree: { branch: 'bot-rematch-flow', prepareCommand: 'pnpm i\npnpm build' },
    })

    const createArgs = run.mock.calls.map((call) => call[0]).find((args) => args.includes('new-session'))
    expect(createArgs?.at(-1)).toBe(worktreePreparationShellCommand('pnpm i\npnpm build'))
    expect(createArgs?.at(-1)).toContain('[commando] Preparing worktree')
    expect(createArgs?.at(-1)).toContain('exec "${SHELL:-/bin/sh}" -l')
  })

  it('prepares in the worktree before launching the agent and stops launch on preparation failure', async () => {
    const git = worktrees()
    const run = tmuxRunner()
    const creator = new TmuxCreator(run, [], git, async () => '/host/bin/agent', {})
    await creator.createSession({ name: 'flow', cwd: MAIN, worktree: { branch: 'bot-rematch-flow', prepareCommand: 'npm install\nnpm run build' }, agent: { provider: 'cursor', prompt: 'Review' } })
    const args = run.mock.calls.map(([args]) => args).find((args) => args.includes('new-session'))!
    expect(args).toContain(target)
    expect(args.at(-1)).toBe(agentLaunchPaneCommand(['/host/bin/agent', 'agent', '--', 'Review'], 'npm install\nnpm run build', {}))
    const script = agentLaunchShellCommand('npm install\nnpm run build')
    expect(script).toMatch(/exec "\$@"$/)
    expect(script).toContain('agent was not started')
    expect(script.indexOf('exec "${SHELL')).toBeLessThan(script.indexOf('"$@"'))
    expect(git.rollback).not.toHaveBeenCalled()
  })

  it('reports success and keeps the worktree when preparation starts before the current path is available', async () => {
    const git = worktrees()
    const run = tmuxRunner().mockImplementation(async (args) => {
      if (args.includes('has-session')) throw new Error("can't find session")
      return output({ panePath: '', paneStartPath: target })
    })
    const creator = new TmuxCreator(run, [], git)

    await expect(creator.createSession({
      name: 'flow',
      cwd: MAIN,
      worktree: { branch: 'bot-rematch-flow', prepareCommand: 'true' },
    })).resolves.toMatchObject({
      created: { kind: 'session', panePath: target },
      worktree: { path: target, branch: 'bot-rematch-flow' },
    })
    expect(git.rollback).not.toHaveBeenCalled()
  })

  it.each([
    ['non-string', 7],
    ['unsupported control character', 'pnpm i\u0000rm -rf /'],
    ['oversized', 'x'.repeat(8_193)],
  ])('rejects an invalid %s preparation command before touching git', async (_label, prepareCommand) => {
    const git = worktrees()
    const run = tmuxRunner()
    const creator = new TmuxCreator(run, [], git)
    await expect(creator.createSession({
      name: 'flow',
      cwd: MAIN,
      worktree: { branch: 'flow', prepareCommand } as never,
    })).rejects.toThrow(/prepare command/)
    expect(run).not.toHaveBeenCalled()
    expect(git.createWorktree).not.toHaveBeenCalled()
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

  it('keeps the worktree when tmux created the session before reporting failure', async () => {
    const git = worktrees()
    let hasSessionCalls = 0
    const run = vi.fn(async (args: readonly string[]): Promise<string> => {
      if (args.includes('has-session')) {
        hasSessionCalls += 1
        if (hasSessionCalls === 1) throw new Error("can't find session")
        return ''
      }
      throw new Error('tmux create command failed')
    })
    const creator = new TmuxCreator(run, [], git)

    await expect(
      creator.createSession({ name: 'flow', cwd: MAIN, worktree: { branch: 'bot-rematch-flow' } }),
    ).rejects.toThrow(/session flow was created but tmux did not report it.*tmux create command failed/i)
    expect(git.rollback).not.toHaveBeenCalled()
  })

  it('includes rollback failures when tmux did not create the session', async () => {
    const git = worktrees({ rollbackFail: new Error('git rollback failed') })
    const creator = new TmuxCreator(tmuxRunner({ createFails: true }), [], git)

    await expect(
      creator.createSession({ name: 'flow', cwd: MAIN, worktree: { branch: 'bot-rematch-flow' } }),
    ).rejects.toThrow(/tmux create command failed.*git rollback failed/i)
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

describe('Claude chat launches', () => {
  const home = process.env.HOME ?? '/Users/test'

  it('starts the agent host from this checkout with the profile, permission mode and opening prompt', async () => {
    const run = runner()
    const resolve = vi.fn(async () => '/never/used')
    const creator = new TmuxCreator(run, [], undefined, resolve, { PATH: '/bin' })
    const result = await creator.createSession({
      name: 'chat', cwd: '/tmp',
      agent: { provider: 'claude-chat', configDir: `${home}/.claudew`, permissionMode: 'acceptEdits', prompt: "Fix Leo's $HOME bug" },
    })
    expect(result.agentLaunch).toMatchObject({ provider: 'claude-chat', paneId: '%12' })
    expect(resolve).not.toHaveBeenCalled()
    expect(run.mock.calls[0][0].at(-1)).toBe(agentLaunchPaneCommand([
      COMMANDO_AGENT_LAUNCHER, 'claude', '--config-dir', `${home}/.claudew`, '--permission-mode', 'acceptEdits', '--prompt', "Fix Leo's $HOME bug",
    ], undefined, { PATH: '/bin' }))
  })

  it('splits a pane that starts a chat, with the daemon environment scoped to it', async () => {
    const run = runner()
    await new TmuxCreator(run, [], undefined, async () => '/never', { PATH: '/bin', COMMANDO_PORT: '4410' }).createPane({
      targetId: '%3', direction: 'horizontal', cwd: '/tmp', agent: { provider: 'claude-chat', permissionMode: 'default' },
    })
    const args = run.mock.calls[0][0]
    expect(args).toContain('split-window')
    expect(args).toContain('COMMANDO_PORT=4410')
    expect(args.at(-1)).toContain(COMMANDO_AGENT_LAUNCHER)
  })

  it("launches a chat with its stashed plan's folder ahead of the prompt", async () => {
    const run = runner()
    const dir = join(chatPlansDir(), 'f'.repeat(32))
    await new TmuxCreator(run, [], undefined, async () => '/never', { PATH: '/bin' }).createPane({
      targetId: '%3', direction: 'horizontal', cwd: '/tmp', agent: { provider: 'claude-chat', permissionMode: 'acceptEdits', readableDir: dir, prompt: 'PLEASE IMPLEMENT THE PLAN' },
    })
    const command = run.mock.calls[0][0].at(-1) as string
    // The command is shell-quoted; the folder follows its flag, and both come before the prompt.
    expect(command.indexOf('--readable-dir')).toBeGreaterThan(-1)
    expect(command.indexOf(dir)).toBeGreaterThan(command.indexOf('--readable-dir'))
    expect(command.indexOf(dir)).toBeLessThan(command.indexOf('--prompt'))
  })

  it('accepts only home-folder Claude profiles, known permission modes, and chat-only options', async () => {
    const creator = new TmuxCreator(runner(), [], undefined, async () => '/bin/claude', {})
    await expect(creator.createSession({ name: 'x', agent: { provider: 'claude-chat', configDir: '/etc/passwd' } })).rejects.toThrow(/profile/)
    await expect(creator.createSession({ name: 'x', agent: { provider: 'claude-chat', configDir: `${home}/../.claudep` } })).rejects.toThrow(/profile/)
    await expect(creator.createSession({ name: 'x', agent: { provider: 'claude-chat', permissionMode: 'yolo' as never } })).rejects.toThrow(/permission/)
    await expect(creator.createSession({ name: 'x', agent: { provider: 'claude', configDir: `${home}/.claudep` } })).rejects.toThrow(/Only Claude chat/)
    // A chat may be handed one stashed plan's folder, never the plans folder or anything else.
    await expect(creator.createSession({ name: 'x', agent: { provider: 'claude-chat', readableDir: chatPlansDir() } })).rejects.toThrow(/stashed plan folder/)
    await expect(creator.createSession({ name: 'x', agent: { provider: 'claude-chat', readableDir: home } })).rejects.toThrow(/stashed plan folder/)
    await expect(creator.createSession({ name: 'x', agent: { provider: 'claude', readableDir: join(chatPlansDir(), 'a'.repeat(32)) } })).rejects.toThrow(/Only Claude chat/)
    expect(validClaudeConfigDir(`${home}/.claudep`)).toBe(true)
    expect(validClaudeConfigDir(`${home}/projects/.claude`)).toBe(false)
  })

  it('lists used Claude profiles in the home folder', async () => {
    const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const dir = await mkdtemp(`${tmpdir()}/profiles-`)
    try {
      await mkdir(`${dir}/.claudep/projects`, { recursive: true })
      await mkdir(`${dir}/.claudew`)
      await writeFile(`${dir}/.claudew/settings.json`, '{}')
      await mkdir(`${dir}/.claude-empty`)
      await mkdir(`${dir}/.config`)
      expect(await listClaudeProfiles(dir)).toEqual([
        { name: 'claudep', configDir: `${dir}/.claudep`, lastUsedAt: expect.any(Number) },
        { name: 'claudew', configDir: `${dir}/.claudew` },
      ])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('dates a profile by its newest transcript, even when only a nested transcript changed', async () => {
    const { mkdtemp, mkdir, writeFile, rm, utimes, chmod } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const dir = await mkdtemp(`${tmpdir()}/profiles-`)
    const at = (path: string, seconds: number) => utimes(path, seconds, seconds)
    try {
      // .claudew's projects/ folder was touched last, but a .claudep session was appended to since.
      await mkdir(`${dir}/.claudep/projects/-repo`, { recursive: true })
      await writeFile(`${dir}/.claudep/projects/-repo/session.jsonl`, '{}\n')
      await writeFile(`${dir}/.claudep/projects/-repo/notes.txt`, '')
      await mkdir(`${dir}/.claudep/projects/-locked`)
      await at(`${dir}/.claudep/projects/-repo/session.jsonl`, 3_000)
      await at(`${dir}/.claudep/projects/-repo/notes.txt`, 9_000)
      await at(`${dir}/.claudep/projects/-repo`, 1_000)
      await at(`${dir}/.claudep/projects/-locked`, 1_000)
      await at(`${dir}/.claudep/projects`, 1_000)
      await chmod(`${dir}/.claudep/projects/-locked`, 0o000)
      await mkdir(`${dir}/.claudew/projects/-repo`, { recursive: true })
      await writeFile(`${dir}/.claudew/projects/-repo/session.jsonl`, '{}\n')
      await at(`${dir}/.claudew/projects/-repo/session.jsonl`, 1_500)
      await at(`${dir}/.claudew/projects/-repo`, 1_500)
      await at(`${dir}/.claudew/projects`, 2_000)

      const profiles = await listClaudeProfiles(dir)
      expect(profiles).toEqual([
        { name: 'claudep', configDir: `${dir}/.claudep`, lastUsedAt: 3_000_000 },
        { name: 'claudew', configDir: `${dir}/.claudew`, lastUsedAt: 2_000_000 },
      ])
      expect(defaultClaudeProfile(profiles)?.name).toBe('claudep')
    } finally {
      await chmod(`${dir}/.claudep/projects/-locked`, 0o755).catch(() => undefined)
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('chatProfileConfigDir', () => {
  const profiles = [
    { name: 'claudew', configDir: '/h/.claudew', lastUsedAt: 1 },
    { name: 'claudep', configDir: '/h/.claudep', lastUsedAt: 2 },
  ]

  it('keeps a remembered profile that still exists and otherwise picks the most recent', () => {
    expect(chatProfileConfigDir('/h/.claudew', profiles)).toBe('/h/.claudew')
    expect(chatProfileConfigDir('/h/.gone', profiles)).toBe('/h/.claudep')
    expect(chatProfileConfigDir(undefined, profiles)).toBe('/h/.claudep')
    expect(chatProfileConfigDir('/h/.claudew', [])).toBeUndefined()
  })
})

describe('Codex chat creation', () => {
  it('starts the Codex chat host in the owned session with the selected permissions', async () => {
    const run = runner()
    const resolve = vi.fn(async () => '/unused/codex')
    const response = await new TmuxCreator(run, [], undefined, resolve, {}).createSession({ name: 'codex-chat', cwd: '/tmp', agent: { provider: 'codex-chat', permissionMode: 'plan', prompt: 'Hello' } })
    expect(resolve).not.toHaveBeenCalled()
    expect(response.agentLaunch).toMatchObject({ provider: 'codex-chat', paneId: '%12' })
    expect(run.mock.calls[0][0].at(-1)).toBe(agentLaunchPaneCommand([COMMANDO_AGENT_LAUNCHER, 'codex', '--permission-mode', 'plan', '--prompt', 'Hello'], undefined, {}))
  })
  it('resumes Muse through its chat host when replacing a chat pane', async () => {
    const run = runner()
    await new TmuxCreator(run, [], undefined, vi.fn(), {}).respawnChatPane('%12', '/tmp', {
      provider: 'muse-chat', resume: '0199ea33-1234-7000-8000-123456789abc', permissionMode: 'default',
    })
    expect(run.mock.calls[0][0].at(-1)).toBe(agentLaunchPaneCommand([
      COMMANDO_AGENT_LAUNCHER, 'muse', '--permission-mode', 'default', '--resume', '0199ea33-1234-7000-8000-123456789abc',
    ], undefined, {}))
  })

  it('starts the Muse chat host with its permission mode and refuses Claude-only settings', async () => {
    const run = runner()
    const response = await new TmuxCreator(run, [], undefined, vi.fn(), {}).createSession({ name: 'muse-chat', cwd: '/tmp', agent: { provider: 'muse-chat', permissionMode: 'bypassPermissions', fullAccess: true, prompt: 'Hello' } })
    expect(response.agentLaunch).toMatchObject({ provider: 'muse-chat', paneId: '%12' })
    expect(run.mock.calls[0][0].at(-1)).toBe(agentLaunchPaneCommand([COMMANDO_AGENT_LAUNCHER, 'muse', '--permission-mode', 'bypassPermissions', '--yolo', '--prompt', 'Hello'], undefined, {}))
    for (const settings of [{ permissionMode: 'plan' }, { configDir: '/Users/dev/.claude' }, { permissionMode: 'default', fullAccess: true }]) {
      await expect(new TmuxCreator(runner(), []).createSession({ name: 'test', agent: { provider: 'muse-chat', ...settings } } as never)).rejects.toThrow(/Muse/)
    }
  })
  it.each([{ configDir: '/Users/dev/.claude' }, { readableDir: '/tmp' }, { permissionMode: 'acceptEdits' }])('rejects incompatible Codex launch settings %j', async (settings) => {
    const run = runner()
    await expect(new TmuxCreator(run, []).createSession({ name: 'test', agent: { provider: 'codex-chat', ...settings } } as never)).rejects.toThrow(/Codex/)
    expect(run).not.toHaveBeenCalled()
  })
})

describe('server-owned resume commands', () => {
  const command = "env CLAUDE_CONFIG_DIR='/home/me/.claudep' claude --dangerously-skip-permissions --resume abcdefgh"
  it.each(['pane', 'window', 'session', 'respawn'] as const)('runs the exact command in cwd for %s', async (kind) => {
    const run = runner()
    const creator = new TmuxCreator(run, [], undefined, undefined, {})
    if (kind === 'pane') await creator.createPane({ targetId: '%1', direction: 'horizontal', cwd: '/repo' }, undefined, command)
    if (kind === 'window') await creator.createWindow({ sessionId: '$1', cwd: '/repo' }, command)
    if (kind === 'session') await creator.createSession({ name: 'original', cwd: '/repo' }, command)
    if (kind === 'respawn') await creator.respawnChatPane('%1', '/repo', undefined, command)
    expect(run.mock.calls[0]![0]).toContain('/repo')
    expect(run.mock.calls[0]![0].at(-1)).toBe(agentLaunchPaneCommand(['/bin/sh', '-c', command], undefined, {}))
  })

  it.each(['', 'echo bad\ncommand', 'echo bad\rcommand', 'echo bad\tcommand', 'echo bad\0command', 'echo bad\u0085command', 'x'.repeat(8193)])('rejects invalid commands on every creation path', async (command) => {
    const run = runner()
    const creator = new TmuxCreator(run)
    await expect(creator.createPane({ targetId: '%1', direction: 'horizontal' }, undefined, command)).rejects.toThrow('Invalid resume command')
    await expect(creator.createWindow({ sessionId: '$1' }, command)).rejects.toThrow('Invalid resume command')
    await expect(creator.createSession({ name: 'original' }, command)).rejects.toThrow('Invalid resume command')
    await expect(creator.respawnChatPane('%1', '/repo', undefined, command)).rejects.toThrow('Invalid resume command')
    expect(run).not.toHaveBeenCalled()
  })

  it('does not take resume commands from creation input objects', async () => {
    const run = runner()
    const creator = new TmuxCreator(run)
    await creator.createWindow({ sessionId: '$1', resumeCommand: 'echo untrusted' } as never)
    expect(run.mock.calls[0]![0]).not.toContain('echo untrusted')
  })

  it('supports chat launches in a new window', async () => {
    const run = runner()
    const creator = new TmuxCreator(run, [], undefined, undefined, {})
    await creator.createWindow({ sessionId: '$1', cwd: '/repo', agent: { provider: 'codex-chat', resume: 'abcdefgh' } })
    expect(run.mock.calls[0]![0].at(-1)).toBe(agentLaunchPaneCommand([COMMANDO_AGENT_LAUNCHER, 'codex', '--permission-mode', 'default', '--resume', 'abcdefgh'], undefined, {}))
  })
})

describe('Cursor chat creation', () => {
  it.each(['bypassPermissions', 'default', 'auto', 'plan'] as const)('starts the owned chat host with %s', async (permissionMode) => {
    const run = runner()
    const resolve = vi.fn(async () => '/unused/agent')
    const response = await new TmuxCreator(run, [], undefined, resolve, {}).createSession({ name: 'cursor-chat', cwd: '/tmp', agent: { provider: 'cursor-chat', permissionMode, resume: 'agent-12345678-0000', prompt: 'Hello' } })
    expect(resolve).not.toHaveBeenCalled()
    expect(response.agentLaunch).toMatchObject({ provider: 'cursor-chat', paneId: '%12' })
    expect(run.mock.calls[0][0].at(-1)).toBe(agentLaunchPaneCommand([COMMANDO_AGENT_LAUNCHER, 'cursor', '--permission-mode', permissionMode, '--resume', 'agent-12345678-0000', '--prompt', 'Hello'], undefined, {}))
  })
  it.each([{ configDir: '/Users/dev/.claude' }, { readableDir: '/tmp' }, { permissionMode: 'acceptEdits' }, { permissionMode: 'dontAsk' }])('rejects incompatible Cursor settings %j before running tmux', async (settings) => {
    const run = runner()
    await expect(new TmuxCreator(run, []).createSession({ name: 'test', agent: { provider: 'cursor-chat', ...settings } } as never)).rejects.toThrow(/Cursor/)
    expect(run).not.toHaveBeenCalled()
  })
})
