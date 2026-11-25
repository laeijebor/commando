import { expect, it } from 'vitest'
import { openConversationPanes } from './ConversationPicker'
import type { ChatState } from '../shared/agent-chat'

it('excludes aside sessions from open-conversation pane enumerations', () => {
  const chat: ChatState = { paneId: '%1', hostConnected: true, items: [], session: { paneId: '%1', sessionId: 'main', provider: 'claude', status: 'idle', cwd: '/', hostPid: 1, hostVersion: 9 } }
  const result = openConversationPanes({ '%1': chat, '%1~abcdefgh': { ...chat, paneId: '%1~abcdefgh', session: { ...chat.session, paneId: '%1~abcdefgh', sessionId: 'aside' } } }, [], (id) => id)
  expect([...result.values()]).toEqual([{ paneId: '%1', label: '%1' }])
})
