import { describe, expect, it } from 'vitest'

import type { AgentStatus, CommandoSnapshot, ProviderUsage } from '../shared/protocol.js'
import { buildCompanionSnapshot, parseCompanionMessage } from './companion.js'

const snapshot: CommandoSnapshot = {
  revision: 4,
  capturedAt: 100,
  sessions: [
    { id: '$1', name: 'commando', attached: true, activeWindowId: '@1', windowIds: ['@1'] },
    { id: '$2', name: 'docs', attached: false, activeWindowId: null, windowIds: [] },
  ],
  windows: [
    { id: '@1', index: 0, sessionId: '$1', name: 'app', active: true, layout: '', paneIds: ['%1'] },
  ],
  panes: [{
    id: '%1', index: 0, windowId: '@1', sessionId: '$1', title: 'OpenCode', command: 'opencode',
    path: '/private/worktree', active: true, dead: false, width: 80, height: 24, cursorX: 0,
    cursorY: 0, alternateSavedX: 0, alternateSavedY: 0, alternateOn: false,
    cursorVisible: true, cursorShape: 'default', cursorBlinking: false, scrollRegionUpper: 0,
    scrollRegionLower: 23, wrapFlag: true, originFlag: false, insertFlag: false,
    keypadFlag: false, keypadCursorFlag: false, mouseAnyFlag: false, mouseSgrFlag: false,
    paneTabs: [],
  }],
  ports: [],
}

const status: AgentStatus = {
  paneId: '%1',
  provider: 'opencode',
  agentSessionId: 'ses_abcdefgh',
  agentSessionName: 'Ship the island',
  status: 'needs_input',
  summary: 'Choose a target',
  source: 'hook',
  confidence: 'high',
  reason: 'Question pending',
  updatedAt: 200,
  details: {
    intent: 'Add the companion',
    recentActivities: [],
    checks: [],
    requests: [{
      id: 'question-1',
      kind: 'question',
      prompt: 'Which target?',
      questions: [{
        header: 'Target',
        question: 'Which target?',
        options: [{ label: 'macOS' }],
        multiple: false,
        custom: false,
      }],
      createdAt: 190,
    }],
  },
}

const usage: ProviderUsage = {
  provider: 'claude',
  state: 'available',
  windows: [{ label: '5h', usedPercent: 25, remainingPercent: 75 }],
  updatedAt: 100,
}

describe('buildCompanionSnapshot', () => {
  it('includes every tmux session with both origin names', () => {
    const result = buildCompanionSnapshot(snapshot, [status], [usage])

    expect(result.sessions).toHaveLength(2)
    expect(result.sessions[0]).toMatchObject({
      tmuxSessionName: 'commando',
      agentSessionName: 'Ship the island',
      agentSessionId: 'ses_abcdefgh',
      status: 'needs_input',
      windowName: 'app',
      paneId: '%1',
      requests: [{ id: 'question-1' }],
    })
    expect(result.sessions[1]).toMatchObject({
      tmuxSessionName: 'docs',
      agentSessionName: 'No agent detected',
      status: 'unknown',
    })
    expect(JSON.stringify(result)).not.toContain('/private/worktree')
  })

  it('includes a bounded plain-text tail for an agent pane', () => {
    const output = `${Array.from({ length: 45 }, (_, index) => `line ${index}`).join('\n')}\n\u001b[32mcomplete\u001b[0m\r\nready\u0000`

    const result = buildCompanionSnapshot(
      snapshot,
      [status],
      [],
      (paneId) => paneId === '%1' ? output : undefined,
    )

    const lastOutput = result.sessions[0]?.lastOutput
    expect(lastOutput).toBeDefined()
    expect(lastOutput).not.toContain('\u001b')
    expect(lastOutput).not.toContain('\u0000')
    expect(lastOutput?.split('\n')).toHaveLength(40)
    expect(lastOutput?.endsWith('complete\nready')).toBe(true)
    expect(lastOutput?.length).toBeLessThanOrEqual(2_000)

    const longResult = buildCompanionSnapshot(snapshot, [status], [], () => 'x'.repeat(3_000))
    expect(longResult.sessions[0]?.lastOutput).toHaveLength(2_000)
  })

  it('falls back to a stable provider session reference when no title exists', () => {
    const result = buildCompanionSnapshot(snapshot, [{
      ...status,
      agentSessionName: undefined,
    }], [])
    expect(result.sessions[0]?.agentSessionName).toBe('OpenCode · cdefgh')
  })
})

describe('parseCompanionMessage', () => {
  it('accepts focused agent output subscriptions and rejects malformed pane ids', () => {
    expect(parseCompanionMessage({ type: 'focus_output', paneId: '%12' })).toEqual({
      type: 'focus_output',
      paneId: '%12',
    })
    expect(parseCompanionMessage({ type: 'focus_output' })).toEqual({ type: 'focus_output' })
    expect(parseCompanionMessage({ type: 'focus_output', paneId: '12' })).toBeNull()
  })
})
