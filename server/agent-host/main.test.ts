import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatSessionInfo } from '../../shared/agent-chat.js'

const state = vi.hoisted(() => ({
  busy: false,
  promptListeners: new Map<string, () => void>(),
  interrupt: vi.fn(),
  close: vi.fn(),
  remove: vi.fn(),
  stop: vi.fn(),
  info: { paneId: '%77', provider: 'cursor', cwd: '/workspace', status: 'idle', hostPid: 1, hostVersion: 1, sessionId: 'agent-123', permissionMode: 'default' } as ChatSessionInfo,
  listeners: new Map<string, ((info: ChatSessionInfo) => void)[]>(),
  execFile: vi.fn(),
  hostNotice: vi.fn(),
}))
vi.mock('node:child_process', async (original) => ({ ...await original<typeof import('node:child_process')>(), execFile: state.execFile }))
vi.mock('node:readline', () => ({ createInterface: () => ({ on: (event: string, listener: () => void) => state.promptListeners.set(event, listener) }) }))
vi.mock('./build.js', () => ({ agentHostBuild: async () => 'test-build' }))
vi.mock('../chat-images.js', () => ({ ChatImageStore: class {} }))
vi.mock('./host.js', () => ({ AgentHost: class { add() {} start() {} remove = state.remove; stop = state.stop } }))
vi.mock('./factory.js', () => ({ createChatProviderSession: vi.fn(async () => ({
  get busy() { return state.busy },
  on: (event: string, listener: (info: ChatSessionInfo) => void) => state.listeners.set(event, [...state.listeners.get(event) ?? [], listener]),
  snapshot: () => ({ session: state.info, items: [] }),
  setResumeCommand: vi.fn(),
  hostNotice: state.hostNotice,
  interrupt: state.interrupt,
  close: state.close,
  start: async () => {},
})) }))

const originalArgv = process.argv
let originalSignals: Map<'SIGTERM' | 'SIGHUP', ((signal: NodeJS.Signals) => void)[]>
beforeEach(() => {
  vi.resetModules()
  state.listeners.clear()
  state.promptListeners.clear()
  state.interrupt.mockReset()
  state.close.mockReset().mockImplementation(() => state.listeners.get('closed')?.forEach((listener) => listener(state.info)))
  state.remove.mockReset()
  state.stop.mockReset()
  state.execFile.mockReset()
  state.hostNotice.mockReset()
  state.busy = false
  state.info = { ...state.info, status: 'idle', permissionMode: 'default', sessionId: 'agent-123' }
  originalSignals = new Map((['SIGTERM', 'SIGHUP'] as const).map((signal) => [signal, process.listeners(signal)]))
  vi.stubEnv('TMUX_PANE', '%77')
  vi.stubEnv('COMMANDO_AGENT_LAUNCHER', '/c/commando-agent')
  vi.spyOn(process.stdout, 'write').mockReturnValue(true)
  process.argv = ['node', fileURLToPath(new URL('./main.ts', import.meta.url)), 'cursor', '--resume', 'agent-123', '--permission-mode', 'default']
})
afterEach(() => {
  process.argv = originalArgv
  for (const [signal, original] of originalSignals) {
    for (const listener of process.listeners(signal)) if (!original.includes(listener)) process.removeListener(signal, listener)
  }
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})
const emit = (event: string) => state.listeners.get(event)?.forEach((listener) => listener(state.info))

describe('provider restart requests', () => {
  it('passes cloud flags to the session spec and preserves them in the respawn command', async () => {
    process.argv = ['node', fileURLToPath(new URL('./main.ts', import.meta.url)), 'cursor', '--runtime', 'cloud', '--cloud-repo', 'https://github.com/acme/app', '--cloud-ref', 'feature/cloud', '--cloud-env', 'App Dev', '--resume', 'bc-cloud123']
    state.info = { ...state.info, sessionId: 'bc-cloud123', permissionMode: 'bypassPermissions' }
    await import('./main.js')
    await vi.waitFor(() => expect(state.listeners.has('restart')).toBe(true))
    const { createChatProviderSession } = await import('./factory.js')
    expect(createChatProviderSession).toHaveBeenCalledWith('cursor', expect.objectContaining({ cursorCloud: { repoUrl: 'https://github.com/acme/app', startingRef: 'feature/cloud', environment: 'App Dev' }, resume: 'bc-cloud123' }))
    state.info = { ...state.info, permissionMode: 'plan', prePlanPermissionMode: 'bypassPermissions' }
    emit('session')
    emit('restart')
    const command = state.execFile.mock.calls[0][1].at(-1)
    expect(command).toContain('--runtime cloud --cloud-repo https://github.com/acme/app --cloud-ref feature/cloud')
    expect(command).toContain('--permission-mode plan')
    expect(command).toContain("--cloud-env 'App Dev'")
    expect(command).toContain('--resume bc-cloud123')
  })
  it('respawns an idle Cursor chat with its current permissions and resume id', async () => {
    await import('./main.js')
    await vi.waitFor(() => expect(state.listeners.has('restart')).toBe(true))
    state.info = { ...state.info, permissionMode: 'plan', prePlanPermissionMode: 'default' }
    emit('session')
    emit('restart')
    expect(state.execFile).toHaveBeenCalledTimes(1)
    const [command, args] = state.execFile.mock.calls[0]
    expect(command).toBe('tmux')
    expect(args).toEqual(expect.arrayContaining(['respawn-pane', '-k', '-t', '%77']))
    expect(args.at(-1)).toContain('commando-agent cursor')
    expect(args.at(-1)).toContain('--permission-mode plan')
    expect(args.at(-1)).toContain('--pre-plan-permission-mode default')
    expect(args.at(-1)).toContain('--resume agent-123')
  })
  it('waits for a busy Cursor chat to become idle before respawning', async () => {
    state.busy = true
    state.info = { ...state.info, status: 'running' }
    await import('./main.js')
    await vi.waitFor(() => expect(state.listeners.has('restart')).toBe(true))
    emit('restart')
    expect(state.execFile).not.toHaveBeenCalled()
    state.info = { ...state.info, status: 'idle' }
    emit('session')
    expect(state.execFile).not.toHaveBeenCalled()
    state.busy = false
    emit('session')
    expect(state.execFile).toHaveBeenCalledTimes(1)
  })
  it('respawns once while a respawn is under way, and shows a failed one in the chat', async () => {
    await import('./main.js')
    await vi.waitFor(() => expect(state.listeners.has('restart')).toBe(true))
    emit('restart')
    emit('session')
    expect(state.execFile).toHaveBeenCalledTimes(1)
    const callback = state.execFile.mock.calls[0].at(-1) as (error: Error | null) => void
    callback(new Error('no such pane'))
    expect(state.hostNotice).toHaveBeenCalledWith('error', expect.stringContaining('Restart failed: no such pane'))
    emit('restart')
    expect(state.execFile).toHaveBeenCalledTimes(2)
  })
})


describe('terminal Ctrl-C', () => {
  it.each([false, true])('interrupts local chats and detaches cloud chats (cloud=%s)', async (cloud) => {
    if (cloud) process.argv.push('--runtime', 'cloud', '--cloud-repo', 'https://github.com/acme/app')
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    await import('./main.js')
    await vi.waitFor(() => expect(state.promptListeners.has('SIGINT')).toBe(true))
    const time = vi.spyOn(Date, 'now').mockReturnValue(10_000)
    state.promptListeners.get('SIGINT')!()
    expect(state.close).not.toHaveBeenCalled()
    expect(state.interrupt).toHaveBeenCalledTimes(cloud ? 0 : 1)
    expect(process.stdout.write).toHaveBeenCalledWith(expect.stringContaining(cloud
      ? 'Press Ctrl-C again to detach. Use Stop in the chat to cancel the cloud run.'
      : 'Interrupting… (Ctrl-C again to quit)'))
    time.mockReturnValue(10_500)
    state.promptListeners.get('SIGINT')!()
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0))
    expect(state.close).toHaveBeenCalledOnce()
    expect(state.interrupt).toHaveBeenCalledTimes(cloud ? 0 : 1)
    expect(state.remove).toHaveBeenCalledWith('%77')
    expect(state.stop).toHaveBeenCalledOnce()
  })
})
