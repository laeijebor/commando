import { describe, expect, it, vi } from 'vitest'
import type { AgentStatus } from '../shared/protocol.js'
import type { ChatHandoff } from './chat-handoffs.js'
import { returnToChat, type ChatReturnDeps } from './chat-return.js'

const handoff: ChatHandoff = { sessionId: 'abcd1234-0000', cwd: '/work', returnFlags: [], draft: { text: '', images: [] }, queue: [], carryId: 'c', createdAt: 1 }
const status = (overrides: Partial<AgentStatus> = {}): AgentStatus => ({
  paneId: '%4', provider: 'claude', agentSessionId: 'abcd1234-0000', status: 'done', summary: '', source: 'hook', confidence: 'high', reason: '', updatedAt: 1, ...overrides,
})

function deps(overrides: Partial<ChatReturnDeps> = {}) {
  let alive = true
  const signals: [number, NodeJS.Signals | 0][] = []
  const value: ChatReturnDeps = {
    panePid: async () => 100,
    paneCommand: async () => 'node',
    status: () => status(),
    handoff: () => handoff,
    chatOwnsPane: () => false,
    readProcessTable: async () => '  100     1 /bin/zsh -c /bin/claude --resume abcd1234-0000; exec /c/commando-agent claude\n  101   100 /bin/claude --resume abcd1234-0000\n',
    signal: (pid, signal) => {
      signals.push([pid, signal])
      if (signal === 'SIGTERM') alive = false
      else if (!alive) throw new Error('ESRCH')
    },
    returnCommand: () => '/c/commando-agent claude --resume abcd1234-0000 --from-claude-code',
    sendCommand: vi.fn(async () => undefined),
    sleep: async () => undefined,
    ...overrides,
  }
  return { value, signals }
}

describe('returnToChat', () => {
  it("asks an idle Claude Code to exit, and lets the pane's own command bring the chat back", async () => {
    const { value, signals } = deps()
    expect(await returnToChat(value, '%4')).toBeNull()
    expect(signals[0]).toEqual([101, 'SIGTERM'])
    expect(value.sendCommand).not.toHaveBeenCalled()
  })

  it('types the chat in when Claude Code leaves the pane at a shell', async () => {
    const { value } = deps({ paneCommand: async () => '-zsh' })
    expect(await returnToChat(value, '%4')).toBeNull()
    expect(value.sendCommand).toHaveBeenCalledWith('%4', '/c/commando-agent claude --resume abcd1234-0000 --from-claude-code')
  })

  it('never stops Claude Code mid-turn or while it asks for an answer', async () => {
    for (const kind of ['working', 'needs_input'] as const) {
      const { value, signals } = deps({ status: () => status({ status: kind }) })
      expect(await returnToChat(value, '%4')).toMatch(kind === 'working' ? /working/ : /waiting for an answer/)
      expect(signals).toEqual([])
    }
  })

  it("refuses panes that aren't Claude Code on a chat's conversation", async () => {
    expect(await returnToChat(deps({ handoff: () => undefined }).value, '%4')).toMatch(/isn't running Claude Code/)
    expect(await returnToChat(deps({ handoff: () => ({ ...handoff, returnedAt: 2 }) }).value, '%4')).toMatch(/isn't running Claude Code/)
    expect(await returnToChat(deps({ status: () => status({ provider: 'codex' }) }).value, '%4')).toMatch(/isn't running Claude Code/)
    expect(await returnToChat(deps({ chatOwnsPane: () => true }).value, '%4')).toMatch(/already shows the chat/)
  })
})
