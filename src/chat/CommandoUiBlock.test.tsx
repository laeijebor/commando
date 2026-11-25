// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatItem } from '../../shared/agent-chat'
import { ChatTimeline, Markdown } from './ChatTimeline'
import { stableAnswerPositions } from './CommandoUiBlock'

afterEach(cleanup)
const fence = (value: unknown) => '```commando-ui\n' + (typeof value === 'string' ? value : JSON.stringify(value)) + '\n```'
const reply = (text: string, createdAt = 1, status: ChatItem['status'] = 'completed'): ChatItem => ({ id: 'a', turnId: 't', kind: 'assistant_message', status, createdAt, updatedAt: createdAt, text })
const user = (id: string, text: string, createdAt: number): ChatItem => ({ id, turnId: 't2', kind: 'user_message', status: 'completed', createdAt, updatedAt: createdAt, text })
const choice = { component: 'choice', prompt: 'Archive storage', options: ['SQLite', 'JSONL', 'Both'] }
const approve = { component: 'approve', prompt: 'Ship the migration' }

function timeline(items: ChatItem[], onUiAnswer?: (text: string) => void, queuedAnswers?: string[]) {
  return <ChatTimeline items={items} cwd="/work" working={false} {...(onUiAnswer ? { onUiAnswer } : {})} {...(queuedAnswers ? { queuedAnswers } : {})} />
}

describe('commando-ui rendering', () => {
  it('renders a block of every component', () => {
    render(<Markdown text={fence([
      choice, approve,
      { component: 'checklist', title: 'Rollout', items: [{ label: 'Build', done: true }, { label: 'Deploy' }] },
      { component: 'table', columns: ['Name', 'Qty'], rows: [['apples', 3]] },
      { component: 'stats', items: [{ label: 'Tests', value: 42, delta: '+3', tone: 'good' }] },
    ])} answerable />)
    expect(screen.getByRole('button', { name: 'SQLite' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument()
    expect(screen.getByText('Rollout')).toBeInTheDocument()
    expect(screen.getByText('1/2')).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: 'Qty' })).toBeInTheDocument()
    expect(screen.getByText('apples')).toBeInTheDocument()
    expect(screen.getByText('+3')).toHaveAttribute('data-tone', 'good')
  })

  it('shows invalid blocks as code with a muted reason', () => {
    const { container } = render(<Markdown text={fence({ component: 'carousel' })} />)
    expect(container.querySelector('pre code')).toHaveTextContent('carousel')
    expect(screen.getByText(/Invalid commando-ui block: unknown component "carousel"/)).toBeInTheDocument()
    expect(container.querySelector('[data-testid="commando-ui"]')).toBeNull()
  })

  it('renders raw html in a table cell as text', () => {
    const { container } = render(<Markdown text={fence({ component: 'table', columns: ['x'], rows: [['<img src=x onerror=alert(1)>']] })} />)
    expect(container.querySelector('img')).toBeNull()
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument()
  })

  it('shows half-written JSON as plain code, without an error, while streaming', () => {
    const partial = '{ "component": "choice", "prompt": "Pick", "options": ["a",'
    const streaming = render(<Markdown text={fence(partial)} running />)
    expect(streaming.container.querySelector('pre code')).toHaveTextContent('"prompt": "Pick"')
    expect(screen.queryByText(/Invalid commando-ui block/)).toBeNull()
    streaming.unmount()
    render(<Markdown text={fence(partial)} />)
    expect(screen.getByText(/Invalid commando-ui block/)).toBeInTheDocument()
  })

  it('disables the controls when the pane cannot send', () => {
    render(timeline([reply(fence(choice))]))
    expect(screen.getByRole('button', { name: 'SQLite' })).toBeDisabled()
  })
})

describe('commando-ui answers', () => {
  it('sends a single choice as a message and settles', () => {
    const onUiAnswer = vi.fn()
    render(timeline([reply(fence(choice))], onUiAnswer))
    fireEvent.click(screen.getByRole('button', { name: 'JSONL' }))
    expect(onUiAnswer).toHaveBeenCalledExactlyOnceWith('Archive storage: JSONL')
    expect(screen.getByTestId('commando-ui-settled')).toHaveTextContent('Sent · JSONL')
    expect(screen.getByRole('button', { name: 'SQLite' })).toBeDisabled()
  })

  it('collects a multiple choice and sends it with the Send button', () => {
    const onUiAnswer = vi.fn()
    render(timeline([reply(fence({ ...choice, multiple: true }))], onUiAnswer))
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Both' }))
    fireEvent.click(screen.getByRole('button', { name: 'SQLite' }))
    expect(onUiAnswer).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(onUiAnswer).toHaveBeenCalledExactlyOnceWith('Archive storage: SQLite, Both')
    expect(screen.getByTestId('commando-ui-settled')).toHaveTextContent('Sent · SQLite, Both')
  })

  it('sends approval with a note, and rejection', () => {
    const onUiAnswer = vi.fn()
    const first = render(timeline([reply(fence(approve))], onUiAnswer))
    fireEvent.change(screen.getByLabelText('Note'), { target: { value: 'after the freeze' } })
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    expect(onUiAnswer).toHaveBeenLastCalledWith('Approved: Ship the migration — note: after the freeze')
    first.unmount()
    render(timeline([reply(fence({ ...approve, rejectLabel: 'Hold' }))], onUiAnswer))
    fireEvent.click(screen.getByRole('button', { name: 'Hold' }))
    expect(onUiAnswer).toHaveBeenLastCalledWith('Rejected: Ship the migration')
  })

  it('does not let an answer approve with Enter in the note field', () => {
    const onUiAnswer = vi.fn()
    render(timeline([reply(fence(approve))], onUiAnswer))
    fireEvent.keyDown(screen.getByLabelText('Note'), { key: 'Enter' })
    expect(onUiAnswer).not.toHaveBeenCalled()
  })

  it('settles when the answer was merged into a longer queued message', () => {
    render(timeline([reply(fence(choice)), user('u', 'Archive storage: Both\n\nalso fix the tests', 20)], vi.fn()))
    expect(screen.getByTestId('commando-ui-settled')).toHaveTextContent('Sent · Both')
  })

  it('treats an answer still in the send queue as given, after a remount', () => {
    render(timeline([reply(fence(choice))], vi.fn(), ['Archive storage: JSONL']))
    expect(screen.getByTestId('commando-ui-settled')).toHaveTextContent('Sent · JSONL')
    expect(screen.getByRole('button', { name: 'Both' })).toBeDisabled()
  })

  it('orders by position when every item has the same timestamp', () => {
    const same = (item: ChatItem): ChatItem => ({ ...item, createdAt: 7, updatedAt: 7 })
    const early = render(timeline([same(user('u', 'Archive storage: Both', 7)), same(reply(fence(choice)))], vi.fn()))
    expect(screen.queryByTestId('commando-ui-settled')).toBeNull()
    early.unmount()
    render(timeline([same(reply(fence(choice))), same(user('u', 'Archive storage: Both', 7))], vi.fn()))
    expect(screen.getByTestId('commando-ui-settled')).toHaveTextContent('Sent · Both')
  })

  it('shows blocks outside an assistant reply read-only, with no controls', () => {
    const { container } = render(<Markdown text={fence(choice)} />)
    expect(container.querySelector('button')).toBeNull()
    expect(screen.getByText('Archive storage')).toBeInTheDocument()
    expect(screen.getByText('JSONL')).toBeInTheDocument()
    cleanup()
    render(<Markdown text={fence(approve)} />)
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.queryByLabelText('Note')).toBeNull()
  })

  it('shows a block as settled after a reload, from the later user message', () => {
    render(timeline([reply(fence(choice), 10), user('u', 'Archive storage: Both', 20)], vi.fn()))
    expect(screen.getByTestId('commando-ui-settled')).toHaveTextContent('Sent · Both')
    expect(screen.getByRole('button', { name: 'SQLite' })).toBeDisabled()
  })

  it('ignores an identical answer sent before the reply', () => {
    render(timeline([user('u', 'Archive storage: Both', 5), reply(fence(choice), 10)], vi.fn()))
    expect(screen.queryByTestId('commando-ui-settled')).toBeNull()
    expect(screen.getByRole('button', { name: 'SQLite' })).toBeEnabled()
  })
})

describe('answer positions', () => {
  const at = (item: ChatItem) => item
  const items = [at(user('u1', 'hi', 1)), at(reply('one', 2))]
  it('stay the same object while only streaming text and tool items change', () => {
    const first = stableAnswerPositions({ replyOrder: new Map(), userMessages: [], keys: [] }, items)
    const streamed = [...items.slice(0, 1), { ...items[1]!, text: 'one two', updatedAt: 9 } as ChatItem, { ...items[1]!, id: 'tool', kind: 'command', toolUseId: 'x', command: 'ls' } as ChatItem]
    expect(stableAnswerPositions(first, streamed)).toBe(first)
    expect(stableAnswerPositions(first, [...items, user('u2', 'more', 3)])).not.toBe(first)
  })
})
