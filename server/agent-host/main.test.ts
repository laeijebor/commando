import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatSessionInfo } from '../../shared/agent-chat.js'

const state = vi.hoisted(() => ({
  busy: false,
  info: { paneId: '%77', provider: 'cursor', cwd: '/workspace', status: 'idle', hostPid: 1, hostVersion: 1, sessionId: 'agent-123', permissionMode: 'default' } as ChatSessionInfo,
  listeners: new Map<string, ((info: ChatSessionInfo) => void)[]>(),
  execFile: vi.fn(),
}))
vi.mock('node:child_process', async (original) => ({ ...await original<typeof import('node:child_process')>(), execFile: state.execFile }))
vi.mock('node:readline', () => ({ createInterface: () => ({ on: vi.fn() }) }))
vi.mock('./build.js', () => ({ agentHostBuild: async () => 'test-build' }))
vi.mock('../chat-images.js', () => ({ ChatImageStore: class {} }))
vi.mock('./host.js', () => ({ AgentHost: class { add() {} start() {} } }))
vi.mock('./factory.js', () => ({ createChatProviderSession: async () => ({
  get busy() { return state.busy },
  on: (event: string, listener: (info: ChatSessionInfo) => void) => state.listeners.set(event, [...state.listeners.get(event) ?? [], listener]),
  snapshot: () => ({ session: state.info, items: [] }),
  setResumeCommand: vi.fn(),
  start: async () => {},
}) }))

const originalArgv = process.argv
let originalSignals: Map<'SIGTERM' | 'SIGHUP', ((signal: NodeJS.Signals) => void)[]>
beforeEach(() => {
  vi.resetModules()
  state.listeners.clear()
  state.execFile.mockReset()
  state.busy = false
  state.info = { ...state.info, status: 'idle', permissionMode: 'default' }
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
})
