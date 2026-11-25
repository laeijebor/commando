// @vitest-environment jsdom

import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatState, ExternalAgentRun } from '../../shared/agent-chat'
import { ChatPane } from './ChatPane'
import { ChatTimeline } from './ChatTimeline'

vi.mock('./ChatTimeline', () => ({ ChatTimeline: vi.fn(() => null), Markdown: () => null }))
afterEach(() => { cleanup(); localStorage.clear(); vi.clearAllMocks() })

const chat: ChatState = {
  paneId: '%5', hostConnected: true,
  session: { paneId: '%5', provider: 'claude', hostPid: 20, hostVersion: 4, cwd: '/work', status: 'idle' },
  items: [{ id: 'u', kind: 'user_message', turnId: 't', text: 'Review tests', status: 'completed', createdAt: 1_000, updatedAt: 1_000 }],
}
const handlers = { connected: true, focused: false, onFocus: vi.fn(), onSend: vi.fn(), onInterrupt: vi.fn(), onAnswer: vi.fn(), onConfigure: vi.fn() }
const renderedItems = () => vi.mocked(ChatTimeline).mock.calls.at(-1)![0].items

describe('chat item identity', () => {
  it('passes the original items unchanged without external runs across session-only updates', () => {
    const view = render(<ChatPane chat={chat} {...handlers} />)
    expect(renderedItems()).toBe(chat.items)
    view.rerender(<ChatPane chat={{ ...chat, session: { ...chat.session, model: 'new-model' } }} externalRuns={[]} {...handlers} />)
    expect(renderedItems()).toBe(chat.items)
  })

  it('keeps the combined array stable when only the session changes', () => {
    const runs: ExternalAgentRun[] = [{ id: 'external-1', runtime: 'codex', label: 'Review', state: 'running', startedAt: 2_000, updatedAt: 2_000 }]
    const view = render(<ChatPane chat={chat} externalRuns={runs} {...handlers} />)
    const combined = renderedItems()
    expect(combined).not.toBe(chat.items)
    view.rerender(<ChatPane chat={{ ...chat, session: { ...chat.session, model: 'new-model' } }} externalRuns={runs} {...handlers} />)
    expect(renderedItems()).toBe(combined)
  })
})

it('keeps the resource handler stable across new tile callbacks and calls the latest callback', async () => {
  const resourceAction = vi.fn().mockResolvedValue({ ok: true, performed: 'tile', webPaneId: 'w-12345678' })
  const api = { resourceAction }
  const first = vi.fn(() => true)
  const view = render(<ChatPane chat={chat} {...handlers} paneManagementApi={api} onOpenTile={first} />)
  const action = vi.mocked(ChatTimeline).mock.calls.at(-1)![0].onResourceAction!
  const latest = vi.fn(() => true)
  for (const onOpenTile of [vi.fn(() => true), latest]) {
    view.rerender(<ChatPane chat={{ ...chat, items: [...chat.items] }} {...handlers} paneManagementApi={api} onOpenTile={onOpenTile} />)
    expect(vi.mocked(ChatTimeline).mock.calls.at(-1)![0].onResourceAction).toBe(action)
  }
  await action('/work/.redline/page.html', 'tile')
  expect(resourceAction).toHaveBeenCalledWith('%5', '/work/.redline/page.html', 'tile', undefined)
  expect(latest).toHaveBeenCalledWith('w-12345678')
  expect(first).not.toHaveBeenCalled()
})
