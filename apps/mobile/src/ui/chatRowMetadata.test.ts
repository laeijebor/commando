import { chatState, item, session } from '../chat/testing'
import { createChatRowSelector } from './chatRowMetadata'
it('keeps metadata references stable across streaming text and changes them at turn completion', () => {
  const select = createChatRowSelector('h1')
  const message = item('assistant_message', { id: 'reply', status: 'running', text: 'Hello' })
  const a = chatState({ session: session({ status: 'running' }), items: [message] })
  const initial = select({ byHost: { h1: { '%7': a } } })
  const b = { ...a, items: [{ ...message, text: 'Hello there', updatedAt: 2000 }] }
  expect(select({ byHost: { h1: { '%7': b } } })).toBe(initial)
  const done = { ...b, items: [{ ...message, status: 'completed' as const, text: 'Hello there', updatedAt: 3000 }] }
  const result = select({ byHost: { h1: { '%7': done } } })
  expect(result).not.toBe(initial)
  expect(result['%7']?.updatedAt).toBe(3000)
})
it('invalidates metadata when a question or provider changes', () => {
  const select = createChatRowSelector('h1')
  const a = chatState()
  const initial = select({ byHost: { h1: { '%7': a } } })
  const request = item('request', { status: 'running', requestId: 'q1', requestKind: 'question', toolName: 'AskUserQuestion', title: 'Ship?', questions: [{ question: 'Ship?', options: [], multiSelect: false }] })
  const b = { ...a, items: [request] }
  const pending = select({ byHost: { h1: { '%7': b } } })
  expect(pending).not.toBe(initial)
  expect(pending['%7']?.pending).toBe(true)
  expect(select({ byHost: { h1: { '%7': { ...b, session: session({ provider: 'codex' }) } } } })['%7']?.session.provider).toBe('codex')
})
