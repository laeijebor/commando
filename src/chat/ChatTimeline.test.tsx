// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ChatItem } from '../../shared/agent-chat'
import ReactMarkdown from 'react-markdown'
import { ChatTimeline } from './ChatTimeline'

vi.mock('react-markdown', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-markdown')>()
  return { ...actual, default: vi.fn(actual.default) }
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const items: ChatItem[] = [
  { id: 'u1', turnId: 't1', status: 'completed', createdAt: 1, updatedAt: 1, kind: 'user_message', text: 'Hello' },
  { id: 'a1', turnId: 't1', status: 'completed', createdAt: 1, updatedAt: 1, kind: 'assistant_message', text: 'Hi there' },
]

it('keeps Aside from here inside each message block before the next row', () => {
  const onAsideFromHere = vi.fn()
  const next: ChatItem = { id: 'u2', turnId: 't2', kind: 'user_message', text: 'Next question', status: 'completed', createdAt: 2, updatedAt: 2 }
  render(<ChatTimeline items={[...items, next]} cwd="/work" working={false} onAsideFromHere={onAsideFromHere} />)
  const userMessage = screen.getByText('Hello').closest('[data-chat-item-id]')!
  const assistantMessage = screen.getByText('Hi there').closest('[data-chat-item-id]')!
  const nextMessage = screen.getByText('Next question').closest('[data-chat-item-id]')!
  const userAction = within(userMessage as HTMLElement).getByRole('button', { name: /Aside from here/ })
  const assistantAction = within(assistantMessage as HTMLElement).getByRole('button', { name: /Aside from here/ })
  expect(userMessage).toHaveClass('items-end')
  expect(assistantMessage).toHaveClass('chat-reply')
  expect(userAction.parentElement).toBe(userMessage)
  expect(assistantAction.parentElement).toBe(assistantMessage)
  expect(assistantAction.compareDocumentPosition(nextMessage) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  fireEvent.click(userAction)
  fireEvent.click(assistantAction)
  expect(onAsideFromHere.mock.calls).toEqual([[items[0]], [items[1]]])
})

/** Gives the jsdom scroller a size: 1000px of content in a 200px window. */
function sizeScroller(element: HTMLElement, clientHeight = 200) {
  Object.defineProperty(element, 'scrollHeight', { configurable: true, value: 1000 })
  Object.defineProperty(element, 'clientHeight', { configurable: true, value: clientHeight })
}

function scrollTo(element: HTMLElement, top: number) {
  element.scrollTop = top
  fireEvent.scroll(element)
}

describe('ChatTimeline jump to latest', () => {
  it('shows the button only while scrolled up, and jumps to the end', () => {
    render(<ChatTimeline items={items} cwd="/work" working={false} />)
    const timeline = screen.getByTestId('chat-timeline')
    sizeScroller(timeline)
    expect(screen.queryByRole('button', { name: 'Jump to latest' })).toBeNull()

    act(() => scrollTo(timeline, 100))
    fireEvent.click(screen.getByRole('button', { name: 'Jump to latest' }))
    expect(timeline.scrollTop).toBe(1000)
    expect(screen.queryByRole('button', { name: 'Jump to latest' })).toBeNull()
  })

  it('ignores the scroll reset while the timeline is hidden', () => {
    render(<ChatTimeline items={items} cwd="/work" working={false} />)
    const timeline = screen.getByTestId('chat-timeline')
    sizeScroller(timeline)
    act(() => scrollTo(timeline, 800))
    sizeScroller(timeline, 0)
    act(() => scrollTo(timeline, 0))
    expect(screen.queryByRole('button', { name: 'Jump to latest' })).toBeNull()
  })

  it('restores the scroll position a WebKit reset loses while hidden', () => {
    let resized = () => {}
    vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { resized = callback } observe() {} disconnect() {} })
    render(<ChatTimeline items={items} cwd="/work" working={false} />)
    const timeline = screen.getByTestId('chat-timeline')
    sizeScroller(timeline)
    act(() => scrollTo(timeline, 300))
    sizeScroller(timeline, 0)
    resized()
    // Shown again: WebKit reports the reset scroll before the observer runs.
    sizeScroller(timeline)
    act(() => scrollTo(timeline, 0))
    resized()
    expect(timeline.scrollTop).toBe(300)
    expect(screen.getByRole('button', { name: 'Jump to latest' })).toBeInTheDocument()
  })
})

it('does not re-parse completed replies when other items or the activity clock update', () => {
  vi.useFakeTimers()
  const command: ChatItem = { id: 'cmd', turnId: 't2', status: 'running', createdAt: 1, updatedAt: 1, kind: 'command', command: 'sleep 5', toolUseId: 'tool' }
  const onResourceAction = vi.fn()
  const initial = [...items, command]
  const { rerender } = render(<ChatTimeline items={initial} cwd="/work" working onResourceAction={onResourceAction} />)
  const count = () => vi.mocked(ReactMarkdown).mock.calls.filter(([props]) => props.children === 'Hi there').length
  const before = count()
  expect(before).toBeGreaterThan(0)
  rerender(<ChatTimeline items={[...items, { ...command, output: 'progress' }]} cwd="/work" working onResourceAction={onResourceAction} />)
  expect(count()).toBe(before)
  act(() => vi.advanceTimersByTime(1000))
  expect(count()).toBe(before)
  rerender(<ChatTimeline items={initial} cwd="/other" working onResourceAction={onResourceAction} />)
  expect(count()).toBeGreaterThan(before)
})
