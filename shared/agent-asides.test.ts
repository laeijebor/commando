import { describe, expect, it } from 'vitest'
import { asideKey, parseAsideKey, isPaneId, isChatKey, hostTakesAsides, parseChatAsideAction, parseChatAsideRecords, parseChatSessionInfo, parseDaemonMessage, parseHostMessage, type ChatAsideRecord } from './agent-chat.js'
import { parseClientMessage } from '../server/client-messages.js'

const record: ChatAsideRecord = { id: 'abcd1234', title: 'Why?', mode: 'read-only', method: 'fork', readOnlyEnforced: true, forkedFrom: { sessionId: 'main', at: 'turn' }, createdAt: 1, status: 'open' }
const { status: _status, ...aside } = record
const info = { paneId: '%4~abcd1234', provider: 'claude', cwd: '/w', status: 'idle', hostPid: 1, hostVersion: 9, aside: { ...aside, parentPaneId: '%4' } }
describe('aside protocol', () => {
  it('validates chat keys separately from real tmux pane ids', () => {
    expect(asideKey('%4', 'abcd1234')).toBe('%4~abcd1234')
    expect(parseAsideKey('%4~abcd1234')).toEqual({ paneId: '%4', asideId: 'abcd1234' })
    expect(isPaneId('%4~abcd1234')).toBe(false)
    expect(isChatKey('%4~abcd1234')).toBe(true)
    for (const key of ['%4~abcd123', '%4~ABCD1234', '%4~abcd1234~aaaa1111', 'abcd1234', '%4']) expect(parseAsideKey(key)).toBeNull()
    expect(hostTakesAsides({ hostVersion: 8 })).toBe(false)
    expect(hostTakesAsides({ hostVersion: 9 })).toBe(true)
  })
  it('strictly validates records and session metadata', () => {
    expect(parseChatAsideRecords([record])).toEqual([record])
    for (const change of [{ mode: 'unsafe' }, { createdAt: NaN }, { method: 'copy' }, { forkedFrom: {} }, { sessionId: '' }, { readOnlyEnforced: 'yes' }, { title: 'x'.repeat(61) }, { closedAt: 0 }]) expect(parseChatAsideRecords([{ ...record, ...change }])).toBeNull()
    expect(parseChatAsideRecords([record, record])).toBeNull()
    expect(parseChatSessionInfo(info)?.aside).toEqual(info.aside)
    expect(parseChatSessionInfo({ ...info, aside: undefined })).toBeNull()
    expect(parseChatSessionInfo({ ...info, aside: { ...info.aside, parentPaneId: '%9' } })).toBeNull()
  })
  it('validates every lifecycle action and result in each direction', () => {
    const actions = [{ action: 'open', text: 'Why?' }, { action: 'close', asideId: record.id }, { action: 'reopen', asideId: record.id }, { action: 'refork', asideId: record.id }, { action: 'mode', asideId: record.id, mode: 'inherit' }]
    for (const action of actions) {
      expect(parseChatAsideAction(action)).toEqual(action)
      expect(parseDaemonMessage({ type: 'aside', paneId: '%4', action, requestId: 'r' })).not.toBeNull()
      expect(parseClientMessage({ type: 'chat_aside', paneId: '%4', action, requestId: 'r' }).ok).toBe(true)
      expect(parseDaemonMessage({ type: 'aside', paneId: info.paneId, action, requestId: 'r' })).toBeNull()
    }
    for (const action of [{ action: 'open', text: '' }, { action: 'open', text: 'x', mode: 'wrong' }, { action: 'open', text: 'x', images: [{}] }, { action: 'close', asideId: '../abc' }, { action: 'mode', asideId: record.id }, { action: 'delete', asideId: record.id }]) expect(parseChatAsideAction(action)).toBeNull()
    expect(parseHostMessage({ type: 'asides', paneId: '%4', asides: [record] })).not.toBeNull()
    expect(parseHostMessage({ type: 'aside_result', paneId: '%4', requestId: 'r', ok: true, asideId: record.id })).not.toBeNull()
    expect(parseHostMessage({ type: 'aside_result', paneId: '%4', requestId: 'r', ok: 'yes' })).toBeNull()
  })
  it('accepts aside keys for all composer and query routes while keeping terminal operations pane-only', () => {
    const routes = [
      { type: 'send', text: 'Hello' }, { type: 'queue', action: 'edit', id: 'q', text: 'new' }, { type: 'interrupt' },
      { type: 'answer', chatRequestId: 'ask', answer: { kind: 'approval', decision: 'deny' } },
      { type: 'configure', settings: { model: 'sonnet' } }, { type: 'file_search', query: 'abc' },
      { type: 'subagent_transcript', agentId: 'abc123' }, { type: 'mcp', request: { action: 'status' } },
    ]
    for (const route of routes) {
      expect(parseDaemonMessage({ ...route, paneId: info.paneId, requestId: 'r' })).not.toBeNull()
      expect(parseClientMessage({ ...route, type: `chat_${route.type}`, paneId: info.paneId, requestId: 'r' }).ok).toBe(true)
    }
    expect(parseClientMessage({ type: 'chat_switch', paneId: info.paneId, requestId: 'r', action: 'now' }).ok).toBe(false)
    expect(parseHostMessage({ type: 'session_snapshot', session: info, items: [] })).not.toBeNull()
    expect(parseHostMessage({ type: 'items', paneId: info.paneId, items: [] })).not.toBeNull()
    expect(parseHostMessage({ type: 'commands', paneId: info.paneId, commands: [] })).not.toBeNull()
    expect(parseHostMessage({ type: 'session_closed', paneId: info.paneId })).not.toBeNull()
  })
})
