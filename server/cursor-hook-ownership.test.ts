import { describe, expect, it, vi } from 'vitest'
import { discoverCursorAssociation, verifyCursorHookAssociation, localCursorSocketArgs, type CursorOwnershipIO } from './cursor-hook-ownership.js'

import { association } from './cursor-hook-test-fixtures.js'
function fixture(patch: { socket?: string; command?: string; foreground?: number; producerStarted?: string; parent?: number; pane?: number; executable?: string } = {}): CursorOwnershipIO {
  return {
    run: async (command, args) => command === 'tmux' ? `${patch.socket ?? '/fixture/cursor.sock'}|90|${patch.pane ?? 100}` : args[0] === '-p' ? patch.executable ?? (patch.command === 'agent' ? 'agent' : 'node') :
      `90 1 90 -1 Tue Oct 6 12:00:00 2026 tmux\n100 90 100 ${patch.foreground ?? 100} ${patch.producerStarted ?? 'Tue Oct 6 12:00:01 2026'} ${patch.command ?? 'node /fixture/cursor-agent/versions/1/index.js'}\n110 ${patch.parent ?? 100} 100 100 Tue Oct 6 12:00:02 2026 node bridge.mjs\n120 90 120 120 Tue Oct 6 12:00:00 2026 node unrelated.js`,
    socket: async (path) => ({ path, device: '1', inode: '2' }),
    executable: async (command) => command === 'node' ? '/usr/bin/node' : command === 'agent' || !command.startsWith('/') ? null : command,
  }
}

describe('Cursor native process ownership', () => {
  it('verifies socket, process births, hook ancestry and foreground group', async () => {
    expect(await discoverCursorAssociation('%1', ['-S', association.socketPath], 110, association, fixture())).toEqual(association)
    expect(await discoverCursorAssociation('%1', [], null, association, fixture())).toEqual(association)
  })
  it.each([
    { socket: '/other-server.sock' }, { foreground: 120 }, { parent: 120 }, { pane: 120 },
    { producerStarted: 'Tue Oct 6 12:00:03 2026' }, { command: 'node unrelated.js' },
    { command: 'node unrelated.js cursor-agent' }, { command: 'agent arbitrary.js' },
    { command: 'node claude.js' },
  ])('fails closed for wrong socket, background, recycled or unrelated producers: %j', async (patch) => {
    expect(await discoverCursorAssociation('%1', [], 110, association, fixture(patch))).toBeNull()
    if (patch.parent === undefined) expect(await discoverCursorAssociation('%1', [], null, association, fixture(patch))).toBeNull()
  })
  it('requires Cursor-specific runtime script evidence and supports exec symlinks', async () => {
    expect(await discoverCursorAssociation('%1', [], 110, null, fixture({ command: 'node /fixture/cursor-agent/versions/1/index.js' }))).toEqual(association)
    const io = fixture({ command: 'agent' })
    io.executable = async () => '/fixture/cursor-agent/versions/1/agent'
    expect(await discoverCursorAssociation('%1', [], 110, null, io)).toEqual(association)
  })
  it('fails closed when OS evidence is unavailable', async () => {
    const io = fixture(); io.run = async () => { throw new Error('EPERM') }
    expect(await discoverCursorAssociation('%1', [], 110, association, io)).toBeNull()
  })
  it('uses the daemon socket configuration, never the inherited producer TMUX', () => {
    expect(localCursorSocketArgs({ TMUX: '/other.sock,10,0' })).toEqual([])
    expect(localCursorSocketArgs({ COMMANDO_TMUX_SOCKET_NAME: 'test' })).toEqual(['-L', 'test'])
    expect(localCursorSocketArgs({ COMMANDO_TMUX_SOCKET_PATH: '/fixture/cursor.sock' })).toEqual(['-S', '/fixture/cursor.sock'])
    expect(localCursorSocketArgs({ COMMANDO_TMUX_SOCKET_NAME: 'test', COMMANDO_TMUX_SOCKET_PATH: '/x' })).toBeNull()
  })
})

it('verifies claimed producer/socket identity and emission clock independently of the callback', async () => {
  const options = { socketArgs: ['-S', association.socketPath], io: fixture(), now: 40_000_000_000n }
  const body = { association, emittedAt: '20000000000' }
  expect(await verifyCursorHookAssociation('%1', body, options)).toEqual(association)
  for (const patch of [{ socketPath: '/other-server.sock' }, { producerPid: 120 }, { panePid: 120 }, { producerStarted: 'recycled' }]) {
    expect(await verifyCursorHookAssociation('%1', { ...body, association: { ...association, ...patch } }, options)).toBeNull()
  }
  for (const emittedAt of [undefined, 'not-a-clock', '40000000001', '1']) {
    expect(await verifyCursorHookAssociation('%1', { ...body, emittedAt }, options)).toBeNull()
  }
})
it('does not grant Cursor ownership to its bundled node runtime running an unrelated script', async () => {
  const io = fixture({ command: 'node unrelated.js' })
  io.executable = async () => '/fixture/cursor-agent/versions/1/node'
  expect(await discoverCursorAssociation('%1', [], 110, null, io)).toBeNull()
})
it('supports the installed wrapper exec -a signature and its verified Node flag', async () => {
  const alias = fixture({ command: '/fixture/.local/bin/agent --use-system-ca /fixture/cursor-agent/versions/1/index.js' })
  alias.executable = async (command) => command.endsWith('index.js') ? command : '/fixture/cursor-agent/versions/1/cursor-agent'
  expect(await discoverCursorAssociation('%1', [], 110, null, alias)).toEqual(association)
  expect(await discoverCursorAssociation('%1', [], 110, null, fixture({ command: 'node --use-system-ca /fixture/cursor-agent/versions/1/index.js' }))).toEqual(association)
  expect(await discoverCursorAssociation('%1', [], 110, null, fixture({ command: 'node unrelated.js --use-system-ca /fixture/cursor-agent/versions/1/index.js' }))).toBeNull()
})
it('parses a separator-containing socket path greedily from its numeric suffix', async () => {
  const socketPath = '/fixture/cursor|91|120.sock|15|16'
  const io = fixture({ socket: socketPath })
  const execute = io.run
  io.run = async (command, args) => {
    if (command === 'tmux') expect(args.at(-1)).toBe('#{socket_path}|#{pid}|#{pane_pid}')
    return execute(command, args)
  }
  expect(await discoverCursorAssociation('%1', [], 110, null, io)).toEqual({ ...association, socketPath })
})
it('recognizes complete executable/script paths with spaces using PID comm and verified filesystem paths', async () => {
  const root = '/fixture/Home With Spaces/cursor-agent/versions/fixture'
  const io = fixture({ command: `${root}/agent --use-system-ca ${root}/index.js`, executable: '/fixture/Node Runtime/node' })
  expect(await discoverCursorAssociation('%1', [], 110, null, io)).toEqual(association)
  const missing = { ...io, executable: async () => null }
  expect(await discoverCursorAssociation('%1', [], 110, null, missing)).toBeNull()
  const unrelated = fixture({ command: `${root}/agent --use-system-ca /fixture/Unrelated App/index.js`, executable: '/fixture/Node Runtime/node' })
  expect(await discoverCursorAssociation('%1', [], 110, null, unrelated)).toBeNull()
})
it('bounds all sequential ownership probes to one 2500ms deadline', async () => {
  vi.useFakeTimers()
  try {
    const io = fixture(); const run = io.run
    const commands: string[] = []
    io.run = async (command, args) => {
      commands.push(command)
      await new Promise((resolve) => setTimeout(resolve, 900))
      return run(command, args)
    }
    let result: unknown = 'pending'
    const validation = discoverCursorAssociation('%1', [], 110, null, io).then((value) => { result = value })
    await vi.advanceTimersByTimeAsync(2499)
    expect(result).toBe('pending')
    await vi.advanceTimersByTimeAsync(1)
    await validation
    expect(result).toBeNull()
    expect(commands).toHaveLength(3)
  } finally { vi.useRealTimers() }
})
