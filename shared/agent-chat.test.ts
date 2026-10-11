import { describe, expect, it } from 'vitest'
import { parseChatItem, parseChatSessionInfo, parseChatSettingsChange, parseDaemonMessage, parseHostMessage } from './agent-chat.js'

const base = { id: 'a', turnId: 't', status: 'completed', createdAt: 1, updatedAt: 1 }

describe('parseChatItem', () => {
  it('copies only known fields and normalises nested request and todo data', () => {
    expect(parseChatItem({ ...base, kind: 'assistant_message', text: 'hi', extra: 'dropped' })).toEqual({ ...base, kind: 'assistant_message', text: 'hi' })
    expect(parseChatItem({
      ...base, kind: 'request', requestId: 'r', requestKind: 'question', toolName: 'AskUserQuestion', title: 'Q',
      questions: [{ question: 'Which?', options: [{ label: 'A' }, { label: 7 }, 'junk'], multiSelect: 'yes' }, null],
      answer: { kind: 'question', answers: { 'Which?': 'A' } },
    })).toEqual({
      ...base, kind: 'request', requestId: 'r', requestKind: 'question', toolName: 'AskUserQuestion', title: 'Q',
      questions: [{ question: 'Which?', options: [{ label: 'A' }], multiSelect: false }],
      answer: { kind: 'question', answers: { 'Which?': 'A' } },
    })
    expect(parseChatItem({ ...base, kind: 'todo_list', todos: [{ content: 'x', status: 'odd' }, 5] })).toEqual({ ...base, kind: 'todo_list', todos: [{ content: 'x', status: 'pending' }] })
  })

  it('rejects malformed items', () => {
    expect(parseChatItem({ ...base, kind: 'file_change', toolUseId: 'u', toolName: 'Edit', path: 'a', additions: 'many', deletions: 0 })).toBeNull()
    expect(parseChatItem({ ...base, kind: 'mystery' })).toBeNull()
    expect(parseChatItem({ ...base, status: 'weird', kind: 'notice', level: 'info', text: 'x' })).toBeNull()
  })

  it('keeps the newest items of an oversized snapshot instead of refusing it', () => {
    const items = Array.from({ length: 5200 }, (_, index) => ({ ...base, id: `i${index}`, kind: 'notice', level: 'info', text: 'x' }))
    const message = parseHostMessage({ type: 'session_snapshot', session: { paneId: '%1', provider: 'claude', cwd: '/w', status: 'idle', hostPid: 1, hostVersion: 1 }, items })
    expect(message?.type === 'session_snapshot' && message.items.length).toBe(5000)
  })
})

const session = { paneId: '%1', provider: 'claude', cwd: '/w', status: 'idle', hostPid: 1, hostVersion: 1 }

describe('chat settings', () => {
  it('accepts a picker change with known values only', () => {
    expect(parseChatSettingsChange({ model: 'sonnet', effort: 'high', permissionMode: 'plan', extra: 1 })).toEqual({ model: 'sonnet', effort: 'high', permissionMode: 'plan' })
    expect(parseChatSettingsChange({ model: 'opus[1m]' })).toEqual({ model: 'opus[1m]' })
    expect(parseChatSettingsChange({})).toBeNull()
    expect(parseChatSettingsChange({ model: '$(rm -rf ~)' })).toBeNull()
    expect(parseChatSettingsChange({ model: '--settings' })).toBeNull()
    expect(parseChatSettingsChange({ effort: 'extreme' })).toBeNull()
    expect(parseChatSettingsChange({ permissionMode: 'yolo' })).toBeNull()
  })

  it('parses the configure message from the daemon', () => {
    expect(parseDaemonMessage({ type: 'configure', paneId: '%2', settings: { effort: 'low' }, requestId: 'r1' }))
      .toEqual({ type: 'configure', paneId: '%2', settings: { effort: 'low' }, requestId: 'r1' })
    expect(parseDaemonMessage({ type: 'configure', paneId: '%2', settings: {}, requestId: 'r1' })).toBeNull()
    expect(parseDaemonMessage({ type: 'configure', paneId: 'x', settings: { effort: 'low' }, requestId: 'r1' })).toBeNull()
  })

  it('carries the picker state, model list and context usage on the session', () => {
    expect(parseChatSessionInfo({
      ...session,
      selectedModel: 'sonnet', effort: 'max', bypassAllowed: true,
      models: [
        { value: 'sonnet', displayName: 'Sonnet 5.5', resolvedModel: 'claude-sonnet-5-5', efforts: ['low', 'bogus', 'high'], supportsAutoMode: true, junk: 1 },
        { value: 'bad value', displayName: 'Bad' },
        { value: 'haiku', displayName: 'Haiku 5.5', efforts: [] },
      ],
      contextUsage: { usedTokens: 84_000, maxTokens: 200_000, autoCompactThreshold: 184_000, autoCompact: true, categories: [{ name: 'Messages', tokens: 54_000 }, { name: 'x', tokens: -1 }] },
    })).toEqual({
      ...session,
      selectedModel: 'sonnet', effort: 'max', bypassAllowed: true,
      models: [
        { value: 'sonnet', displayName: 'Sonnet 5.5', resolvedModel: 'claude-sonnet-5-5', efforts: ['low', 'high'], supportsAutoMode: true },
        { value: 'haiku', displayName: 'Haiku 5.5' },
      ],
      contextUsage: { usedTokens: 84_000, maxTokens: 200_000, autoCompactThreshold: 184_000, autoCompact: true, categories: [{ name: 'Messages', tokens: 54_000 }] },
    })
  })

  it('refuses a session with an invalid effort or model and drops unusable context usage', () => {
    expect(parseChatSessionInfo({ ...session, effort: 'huge' })).toBeNull()
    expect(parseChatSessionInfo({ ...session, selectedModel: 'a b' })).toBeNull()
    expect(parseChatSessionInfo({ ...session, contextUsage: { usedTokens: 5, maxTokens: 0 } })).toEqual(session)
  })
})
