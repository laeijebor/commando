import { applyChatMessage, applyExternalRunsMessage, useChatStore } from './store'
import { chatState, item, session } from './testing'

describe('the chat store', () => {
  it('replaces every chat on a snapshot and upserts one on chat_state', () => {
    const first = applyChatMessage({ '%1': chatState({ paneId: '%1' }) }, { type: 'chat_snapshot', chats: [chatState()] })
    expect(Object.keys(first)).toEqual(['%7'])
    const second = applyChatMessage(first, { type: 'chat_state', chat: chatState({ paneId: '%9' }) })
    expect(Object.keys(second).sort()).toEqual(['%7', '%9'])
  })

  it('merges items by id in first-seen order', () => {
    const message = item('assistant_message', { id: 'a', text: 'Hel', status: 'running' })
    let chats = applyChatMessage({}, { type: 'chat_snapshot', chats: [chatState({ items: [item('user_message', { id: 'u', text: 'hi' }), message] })] })
    chats = applyChatMessage(chats, { type: 'chat_items', paneId: '%7', items: [{ ...message, text: 'Hello' } as typeof message, item('notice', { id: 'n', level: 'info', text: 'done' })] })
    expect(chats['%7']!.items.map((entry) => entry.id)).toEqual(['u', 'a', 'n'])
    expect(chats['%7']!.items[1]).toMatchObject({ text: 'Hello' })
  })

  it('updates the session, commands and removal, and ignores panes it never saw', () => {
    let chats = applyChatMessage({}, { type: 'chat_snapshot', chats: [chatState()] })
    chats = applyChatMessage(chats, { type: 'chat_session', paneId: '%7', session: session({ status: 'running' }), hostConnected: false })
    expect(chats['%7']).toMatchObject({ hostConnected: false, session: { status: 'running' } })
    chats = applyChatMessage(chats, { type: 'chat_commands', paneId: '%7', commands: [{ name: 'review', description: 'Review', kind: 'skill' }] })
    expect(chats['%7']!.commands).toHaveLength(1)
    const unchanged = applyChatMessage(chats, { type: 'chat_items', paneId: '%3', items: [] })
    expect(unchanged).toBe(chats)
    chats = applyChatMessage(chats, { type: 'chat_removed', paneId: '%7' })
    expect(chats).toEqual({})
  })

  it('keeps chats per host and leaves the state alone for other messages', () => {
    useChatStore.getState().ingest('a', { type: 'chat_snapshot', chats: [chatState()] })
    const before = useChatStore.getState().byHost
    useChatStore.getState().ingest('a', { type: 'provider_usage', usage: [] })
    expect(useChatStore.getState().byHost).toBe(before)
    expect(useChatStore.getState().byHost.b).toBeUndefined()
  })

  it('keeps each pane\'s external runs as the daemon last listed them', () => {
    const run = { id: 'r1', runtime: 'codex' as const, label: 'Review', state: 'running' as const, startedAt: 1, updatedAt: 2 }
    let runs = applyExternalRunsMessage({}, { type: 'chat_external_runs', paneId: '%7', runs: [run] })
    expect(runs).toEqual({ '%7': [run] })
    expect(applyExternalRunsMessage(runs, { type: 'provider_usage', usage: [] })).toBe(runs)
    runs = applyExternalRunsMessage(runs, { type: 'chat_external_runs', paneId: '%7', runs: [] })
    expect(runs).toEqual({})
    expect(applyExternalRunsMessage(runs, { type: 'chat_external_runs', paneId: '%8', runs: [] })).toBe(runs)
    runs = applyExternalRunsMessage({ '%7': [run] }, { type: 'chat_removed', paneId: '%7' })
    expect(runs).toEqual({})
    // A reconnect's snapshot drops runs the daemon no longer tracks; it re-sends the rest.
    expect(applyExternalRunsMessage({ '%7': [run] }, { type: 'chat_snapshot', chats: [] })).toEqual({})
    useChatStore.getState().ingest('h', { type: 'chat_external_runs', paneId: '%7', runs: [run] })
    expect(useChatStore.getState().externalRuns.h).toEqual({ '%7': [run] })
  })
})
