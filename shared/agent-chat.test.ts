import { describe, expect, it } from 'vitest'
import { parseChatItem, parseHostMessage } from './agent-chat.js'

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
