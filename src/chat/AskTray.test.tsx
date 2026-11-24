// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ChatItem, ChatSessionInfo, ChatState } from '../../shared/agent-chat'
import type { SessionAsk } from '../../shared/protocol'
import { AskTray } from './AskTray'
import { ChatPane } from './ChatPane'

const push: SessionAsk = {
  key: 'push-31226', question: 'Push the two small #31226 fixes as round 4?', context: 'Two one-line CodeRabbit nits.',
  why: 'Costs one more review loop.', options: ['Push as round 4', 'Leave them'], recommend: 0, link: 'https://github.com/o/r/pull/31226', askedAt: 40,
}
const decline: SessionAsk = { key: 'decline-31225', question: 'Decline the #31225 driver-tests request?', options: ['Decline', 'Add the tests'], askedAt: 41 }

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

function renderTray(props: Partial<Parameters<typeof AskTray>[0]> = {}) {
  const handlers = { onAnswer: vi.fn(), onReply: vi.fn(), onJump: vi.fn() }
  const view = render(<AskTray asks={[push, decline]} disabled={false} anchored={new Set([push.key])} {...handlers} {...props} />)
  return { ...handlers, view }
}

describe('AskTray', () => {
  it('shows nothing without open asks', () => {
    renderTray({ asks: [] })
    expect(screen.queryByTestId('ask-tray')).toBeNull()
  })

  it('collapses to the count and first question, and opens to every ask', () => {
    renderTray()
    const head = screen.getByRole('button', { name: /^Waiting on you/ })
    expect(head).toHaveAttribute('aria-expanded', 'false')
    expect(head).toHaveTextContent('2')
    expect(head).toHaveTextContent(push.question)
    fireEvent.click(head)
    expect(screen.getByRole('heading', { name: push.question })).toBeInTheDocument()
    expect(screen.getByText(push.context!)).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: decline.question })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Push as round 4 (recommended)' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Open link/ })).toHaveAttribute('href', push.link)
  })

  it('answers with an option, then shows it as sent until the ask closes', () => {
    vi.useFakeTimers()
    const { onAnswer, view } = renderTray({ openSignal: 1 })
    fireEvent.click(screen.getByRole('button', { name: 'Leave them' }))
    expect(onAnswer).toHaveBeenCalledWith(push, 'Leave them')
    expect(screen.getByRole('status')).toHaveTextContent('Sent “Leave them”')
    expect(screen.getByRole('button', { name: /^Waiting on you/ })).toHaveTextContent('1')
    // A send that never closed the ask offers its options again.
    act(() => { vi.advanceTimersByTime(15_000) })
    expect(screen.getByRole('button', { name: 'Leave them' })).toBeInTheDocument()
    view.rerender(<AskTray asks={[decline]} disabled={false} anchored={new Set()} onAnswer={onAnswer} onReply={vi.fn()} onJump={vi.fn()} openSignal={1} />)
    expect(screen.queryByRole('heading', { name: push.question })).toBeNull()
  })

  it('offers a free reply, the reasoning and a jump back to where it was asked', () => {
    const { onReply, onJump } = renderTray({ openSignal: 1 })
    fireEvent.click(screen.getAllByRole('button', { name: 'Reply…' })[0]!)
    expect(onReply).toHaveBeenCalledWith(push)
    fireEvent.click(screen.getByRole('button', { name: 'Why it matters' }))
    expect(screen.getByText(push.why!)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Jump to where I asked/ }))
    expect(onJump).toHaveBeenCalledWith(push)
    // Only asks with a place in the conversation offer the jump.
    expect(screen.getAllByRole('button', { name: /Jump to where I asked/ })).toHaveLength(1)
  })

  it("can't answer while disconnected", () => {
    renderTray({ openSignal: 1, disabled: true })
    expect(screen.getByRole('button', { name: 'Leave them' })).toBeDisabled()
  })
})

describe('asks in a chat', () => {
  const session: ChatSessionInfo = { paneId: '%5', provider: 'claude', cwd: '/work', status: 'idle', hostPid: 1, hostVersion: 3 }
  const base = { status: 'completed' as const }
  const items: ChatItem[] = [
    { ...base, id: 'u1', kind: 'user_message', text: 'Fix the PR', turnId: 't1', createdAt: 10, updatedAt: 10 },
    { ...base, id: 'a1', kind: 'assistant_message', text: 'Two comments are left.', turnId: 't1', createdAt: 50, updatedAt: 50 },
  ]
  const state: ChatState = { paneId: '%5', session, items, hostConnected: true }
  const renderChat = (onSend = vi.fn()) => {
    render(<ChatPane chat={state} asks={[push, decline]} connected focused={false} onFocus={vi.fn()} onSend={onSend} onInterrupt={vi.fn()} onAnswer={vi.fn()} onConfigure={vi.fn()} />)
    return onSend
  }

  it('marks the reply where the agent asked, and opens the tray from it', () => {
    renderChat()
    fireEvent.click(screen.getByRole('button', { name: 'Asked you 2 things: see Waiting on you' }))
    expect(screen.getByRole('button', { name: /^Waiting on you/ })).toHaveAttribute('aria-expanded', 'true')
  })

  it('sends a tapped option as an answer to its ask', () => {
    const onSend = renderChat()
    fireEvent.click(screen.getByRole('button', { name: /^Waiting on you/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Push as round 4 (recommended)' }))
    expect(onSend).toHaveBeenCalledWith(`Re: ${push.question} → Push as round 4`, undefined, { answersAsk: push.key })
  })

  it('starts a reply in the composer that answers the ask when sent', () => {
    const onSend = renderChat()
    fireEvent.click(screen.getByRole('button', { name: /^Waiting on you/ }))
    fireEvent.click(screen.getAllByRole('button', { name: 'Reply…' })[1]!)
    const input = screen.getByRole('textbox', { name: 'Message Claude' }) as HTMLTextAreaElement
    expect(input.value).toBe(`Re: ${decline.question} → `)
    fireEvent.change(input, { target: { value: `${input.value}decline, but say why` } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onSend).toHaveBeenCalledWith(`Re: ${decline.question} → decline, but say why`, [], { answersAsk: decline.key })
  })
})
