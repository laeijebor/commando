import { asideKey, asideReportText, type ChatAsideRecord, type ChatState } from '@commando/agent-chat'
import { chatState, item } from '../chat/testing'

export function demoAsideChat(main: ChatState, record: ChatAsideRecord): ChatState {
  const paneId = asideKey(main.paneId, record.id)
  return chatState({ paneId, session: {
    aside: { ...record, parentPaneId: main.paneId },
    ...main.session, paneId, sessionId: `demo-aside-${record.id}`, hostVersion: 9, status: 'idle', title: record.title, queue: [],
  }, items: [
    item('user_message', { text: 'Check whether the layout works with the keyboard open.' }),
    item('assistant_message', { text: 'The bounded timeline keeps the composer visible. Check the chip row on iPhone and iPad.' }),
  ] })
}
export function seedAsides(chats: ChatState[], now: number): void {
  const main = chats[0]!
  const open: ChatAsideRecord = { id: 'layout01', title: 'Keyboard layout', mode: 'read-only', method: 'fork', readOnlyEnforced: true,
    forkedFrom: { sessionId: main.session.sessionId || 'demo-main' }, status: 'open', createdAt: now - 180_000 }
  const closed: ChatAsideRecord = { ...open, id: 'report01', title: 'Accessibility check', status: 'closed', closedAt: now - 30_000 }
  main.session = { ...main.session, hostVersion: 9 }
  main.asides = [open, closed]
  main.items.push(item('user_message', { text: asideReportText({ asideId: closed.id, title: closed.title,
    body: 'The layout is ready for review.\n- Keep accessible names on thread chips.\n- Check keyboard spacing on iPad.' }) }))
  chats.push(demoAsideChat(main, open))
}
