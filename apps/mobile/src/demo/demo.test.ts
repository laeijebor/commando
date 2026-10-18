import { pendingRequests } from '@commando/chat-timeline'
import { DemoDaemonClient } from './client'
import { demoMessages, demoIdentities } from './seed'
import { demoHost, isDemoHost, autoDemoEnabled } from './flags'
import { demoResponse } from './http'
import { useDaemonStore } from '../daemon/store'
import { useChatStore } from '../chat/store'
import { useSessionPreferences } from '../ui/sessionPreferences'
import { buildChatGroups } from '../ui/chatListModel'

beforeEach(() => {
  jest.useFakeTimers()
  useDaemonStore.setState({ byHost: {} })
  useChatStore.setState({ byHost: {} })
})
afterEach(() => jest.useRealTimers())
it('seeds the real reducers with four repos, eight sessions, mixed providers and pane attachments', () => {
  const client = new DemoDaemonClient({ host: demoHost() })
  client.start()
  const state = useDaemonStore.getState().byHost[client.hostId]!
  const chats = useChatStore.getState().byHost[client.hostId]!
  expect(state.phase).toBe('live')
  expect(state.snapshot?.sessions).toHaveLength(8)
  expect(buildChatGroups(state, chats)).toHaveLength(4)
  expect(new Set(Object.values(chats).map((chat) => chat.session.provider))).toEqual(new Set(['claude', 'codex', 'cursor', 'muse']))
  expect(state.webPanes.map((tile) => tile.content?.kind ?? 'browser')).toEqual(['browser', 'simulator', 'canvas', 'guide'])
  expect(state.briefs['%demo0']?.tasks?.length).toBeGreaterThan(0)
  expect(pendingRequests(chats['%demo0']!.items)).toHaveLength(1)
  const attentions = buildChatGroups(state, chats).flatMap((group) => group.sessions.map((row) => row.indicator?.attention))
  expect(attentions.filter((value) => value === 'working')).toHaveLength(2)
  expect(attentions.filter((value) => value === 'review')).toHaveLength(1)
  expect(Object.values(state.agentStatuses).some((status) => status.status === 'failed')).toBe(true)
  client.stop()
})
it('appends the user immediately and updates one assistant item like a stream after about a second', () => {
  const client = new DemoDaemonClient({ host: demoHost() })
  client.start()
  const listener = jest.fn()
  client.subscribe(listener)
  client.send({ type: 'chat_send', paneId: '%demo3', text: 'Use the spacious layout' })
  const chat = () => useChatStore.getState().byHost[client.hostId]!['%demo3']!
  expect(chat().items.at(-1)).toMatchObject({ kind: 'user_message', text: 'Use the spacious layout' })
  jest.advanceTimersByTime(250)
  const firstText = chat().items.at(-1)
  jest.advanceTimersByTime(450)
  expect(chat().items.at(-1)).not.toEqual(firstText)
  const replyId = chat().items.at(-1)!.id
  expect(chat().items.at(-1)).toMatchObject({ kind: 'assistant_message', status: 'running' })
  jest.advanceTimersByTime(900)
  expect(chat().items.at(-1)).toMatchObject({ id: replyId, status: 'completed' })
  expect(chat().session.status).toBe('idle')
  expect(listener).toHaveBeenCalled()
  client.stop()
})
it('cancels pending replies when the demo disconnects', () => {
  const client = new DemoDaemonClient({ host: demoHost() })
  client.start()
  client.send({ type: 'chat_send', paneId: '%demo3', text: 'Hello' })
  client.stop()
  const before = useChatStore.getState().byHost[client.hostId]
  jest.advanceTimersByTime(2000)
  expect(useChatStore.getState().byHost[client.hostId]).toBe(before)
  expect(client.send({ type: 'chat_send', paneId: '%demo3', text: 'Offline' })).toBeNull()
})
it('serves authenticated metadata locally and rejects unsupported demo actions locally', async () => {
  expect((await demoResponse('/api/health', {}).json()).sessions).toBe(8)
  expect((await demoResponse('/api/session-management/preferences', {}).json()).preferences.sessionIdentities['remote-chat']).toBeTruthy()
  expect((await demoResponse('/api/git/summary?paneId=%demo0', {}).json()).additions).toBe(18)
  expect((await demoResponse('/api/prs/pane?paneId=%demo0', {}).json()).list.pullRequests[0].number).toBe(257)
  expect(demoResponse('/api/tmux/sessions', { method: 'POST' }).status).toBe(409)
})
it('is unreachable when the production build disables __DEV__ even with the environment flag', () => {
  const previous = __DEV__
  const flag = process.env.EXPO_PUBLIC_COMMANDO_DEMO
  try {
    Object.assign(globalThis, { __DEV__: false })
    process.env.EXPO_PUBLIC_COMMANDO_DEMO = '1'
    expect(isDemoHost(demoHost())).toBe(false)
    expect(autoDemoEnabled()).toBe(false)
    expect(() => demoMessages()).toThrow('development')
    expect(() => new DemoDaemonClient({ host: demoHost() })).toThrow('development')
  } finally {
    Object.assign(globalThis, { __DEV__: previous })
    if (flag === undefined) delete process.env.EXPO_PUBLIC_COMMANDO_DEMO
    else process.env.EXPO_PUBLIC_COMMANDO_DEMO = flag
  }
})

it('uses distinct demo animals and recent PR dates', async () => {
  const identities = Object.values(demoIdentities())
  expect(new Set(identities.map((identity) => identity.glyph)).size).toBe(identities.length)
  const body = await demoResponse('/api/prs/pane?paneId=%demo0', {}).json()
  expect(Date.now() - Date.parse(body.list.pullRequests[0].updatedAt)).toBe(120_000)
})
it('broadcasts authoritative seen state and clears a viewed web tab through the fake API', async () => {
  const client = new DemoDaemonClient({ host: demoHost() })
  client.start()
  client.send({ type: 'mark_panes_seen', paneIds: ['%demo0'] })
  expect(useSessionPreferences.getState().seen[client.hostId]?.['%demo0']).toBe(Date.now())
  const tile = useDaemonStore.getState().byHost[client.hostId]!.webPanes.find((entry) => entry.unseen)!
  demoResponse(`/api/web-panes/${tile.id}/seen`, { method: 'POST' })
  expect(useDaemonStore.getState().byHost[client.hostId]!.webPanes.find((entry) => entry.id === tile.id)?.unseen).toBe(false)
  client.stop()
})
