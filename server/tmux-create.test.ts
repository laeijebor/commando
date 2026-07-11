import { describe, expect, it, vi } from 'vitest'
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
      kind: 'session',
      sessionId: '$4',
      sessionName: 'work',
      windowId: '@8',
      windowIndex: 2,
      windowName: 'editor',
      paneId: '%12',
      paneIndex: 1,
      panePath: '/Users/dev/project',
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
