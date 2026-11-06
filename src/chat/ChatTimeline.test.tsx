// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ChatItem } from '../../shared/agent-chat'
import { ChatTimeline } from './ChatTimeline'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const items: ChatItem[] = [
  { id: 'u1', turnId: 't1', status: 'completed', createdAt: 1, updatedAt: 1, kind: 'user_message', text: 'Hello' },
  { id: 'a1', turnId: 't1', status: 'completed', createdAt: 1, updatedAt: 1, kind: 'assistant_message', text: 'Hi there' },
]

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
