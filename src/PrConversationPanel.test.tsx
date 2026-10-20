// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PrConversationPanel } from './PrConversationPanel'
import type { PrDetails, PrReviewThread } from '../shared/pr-quick-look'
import type { PrsApiClient } from './prsApi'

afterEach(cleanup)
const thread: PrReviewThread = { id: 'PRRT_123', commentId: 10, isResolved: false, viewerCanReply: true, viewerCanResolve: true, viewerCanUnresolve: true }
const details: PrDetails = { body: '', checks: [], unresolvedThreads: 1, conversation: [
  { id: '2:10', commentId: 10, kind: 'inline comment', author: 'Reviewer', body: 'Finding', url: '', createdAt: '', path: 'a.ts', thread },
  { id: '0:20', kind: 'comment', author: 'Author', body: 'General comment', url: '', createdAt: '' },
] }

function setup(patch: Partial<PrReviewThread> = {}) {
  const api = { threadAction: vi.fn().mockResolvedValue({ ok: true }) }
  const onChanged = vi.fn().mockResolvedValue(undefined)
  const value = { ...details, conversation: details.conversation.map((entry) => entry.thread ? { ...entry, thread: { ...thread, ...patch } } : entry) }
  const element = (next: PrDetails | null = value) => <PrConversationPanel details={next} unresolvedThreads={1}
    repo="acme/widgets" number={12} api={api as unknown as PrsApiClient} onChanged={onChanged} renderComment={(entry) => <p>{entry.body}</p>} />
  const view = render(element())
  return { api, onChanged, rerender: (next: PrDetails | null) => view.rerender(element(next)), value }
}

describe('review thread controls', () => {
  it('posts exactly once, clears a sent draft, and distinguishes a failed refresh from a failed write', async () => {
    const { api, onChanged } = setup()
    let finish!: () => void
    api.threadAction.mockImplementationOnce(() => new Promise((resolve) => { finish = () => resolve({ ok: true }) }))
    onChanged.mockRejectedValueOnce(new Error('Offline'))
    fireEvent.click(screen.getByRole('button', { name: 'Reply' }))
    const draft = screen.getByRole('textbox', { name: /Reply to Reviewer/ })
    expect(draft).toHaveFocus()
    expect(screen.getByRole('button', { name: 'Send reply' })).toBeDisabled()
    fireEvent.change(draft, { target: { value: '**Fixed**\n\nThanks!' } })
    fireEvent.submit(draft.closest('form')!)
    fireEvent.submit(draft.closest('form')!)
    expect(api.threadAction).toHaveBeenCalledExactlyOnceWith('acme/widgets', 12, thread.id, 'reply', '**Fixed**\n\nThanks!')
    expect(screen.getByRole('button', { name: 'Sending…' })).toBeDisabled()
    await act(async () => finish())
    expect(await screen.findByRole('alert')).toHaveTextContent('Saved on GitHub, but refresh failed: Offline')
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(screen.getByText('Reply sent.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Refresh conversation' }))
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
    expect(api.threadAction).toHaveBeenCalledTimes(1)
    expect(onChanged).toHaveBeenCalledTimes(2)
  })

  it('retains a failed reply and allows an explicit retry', async () => {
    const { api, onChanged } = setup()
    api.threadAction.mockRejectedValueOnce(new Error('GitHub denied the reply'))
    fireEvent.click(screen.getByRole('button', { name: 'Reply' }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Keep my draft' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send reply' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('GitHub denied the reply')
    expect(screen.getByRole('textbox')).toHaveValue('Keep my draft')
    expect(onChanged).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Send reply' }))
    await screen.findByText('Reply sent.')
    expect(api.threadAction).toHaveBeenCalledTimes(2)
  })

  it('keeps drafts through polling reloads and tab changes', () => {
    const { rerender, value } = setup()
    fireEvent.click(screen.getByRole('button', { name: 'Reply' }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Draft during refresh' } })
    rerender(null)
    expect(screen.getByRole('status')).toHaveTextContent('Loading conversation')
    rerender({ ...value })
    expect(screen.getByRole('textbox')).toHaveValue('Draft during refresh')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    fireEvent.click(screen.getByRole('button', { name: 'Reply' }))
    expect(screen.getByRole('textbox')).toHaveValue('Draft during refresh')
  })

  it.each([['Resolve', 'resolve', false], ['Reopen', 'reopen', true]] as const)('allows %s and refreshes after saving', async (label, action, isResolved) => {
    const { api, onChanged } = setup({ isResolved })
    expect(screen.getAllByRole('button', { name: label })).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: label }))
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1))
    expect(api.threadAction).toHaveBeenCalledExactlyOnceWith('acme/widgets', 12, thread.id, action, undefined)
  })

  it('shows resolves immediately and lets several threads be resolved back to back with one trailing refresh', async () => {
    const threads = ['A', 'B', 'C'].map((id, index) => ({ ...thread, id: `PRRT_${id}`, commentId: index + 1 }))
    const value: PrDetails = { body: '', checks: [], unresolvedThreads: 3, conversation: threads.map((item, index) => (
      { id: `2:${index + 1}`, commentId: index + 1, kind: 'inline comment', author: `Reviewer ${item.id}`, body: `Finding ${item.id}`, url: '', createdAt: '', path: 'a.ts', thread: item }
    )) }
    const writes: Array<() => void> = []
    const api = { threadAction: vi.fn().mockImplementation(() => new Promise((resolve) => { writes.push(() => resolve({ ok: true })) })) }
    const refreshes: Array<() => void> = []
    const onChanged = vi.fn().mockImplementation(() => new Promise<void>((resolve) => { refreshes.push(resolve) }))
    const element = (next: PrDetails) => <PrConversationPanel details={next} unresolvedThreads={3} repo="acme/widgets" number={12}
      api={api as unknown as PrsApiClient} onChanged={onChanged} renderComment={(entry) => <p>{entry.body}</p>} />
    const view = render(element(value))
    const heading = () => screen.getByRole('heading', { name: /Conversation/ })

    for (const button of screen.getAllByRole('button', { name: 'Resolve' })) fireEvent.click(button)
    expect(screen.getAllByText('✓ Resolved')).toHaveLength(3)
    expect(screen.getAllByRole('button', { name: 'Resolving…' })).toHaveLength(3)
    expect(heading()).toHaveTextContent('0 unresolved threads')
    expect(api.threadAction).toHaveBeenCalledTimes(3)

    await act(async () => writes.forEach((finish) => finish()))
    expect(screen.getAllByRole('button', { name: 'Reopen' })).toHaveLength(3)
    // One refresh is running; the other two writes share a single queued follow-up.
    expect(onChanged).toHaveBeenCalledTimes(1)
    await act(async () => refreshes[0]())
    expect(onChanged).toHaveBeenCalledTimes(2)
    view.rerender(element({ ...value, unresolvedThreads: 0, conversation: value.conversation.map((entry) => ({ ...entry, thread: { ...entry.thread!, isResolved: true } })) }))
    await act(async () => refreshes[1]())
    expect(onChanged).toHaveBeenCalledTimes(2)
    expect(screen.getAllByText('✓ Resolved')).toHaveLength(3)
    expect(heading()).toHaveTextContent('0 unresolved threads')
  })

  it('rolls back an optimistic resolve when GitHub rejects it', async () => {
    const { api, onChanged } = setup()
    let fail!: (error: Error) => void
    api.threadAction.mockImplementationOnce(() => new Promise((_, reject) => { fail = reject }))
    fireEvent.click(screen.getByRole('button', { name: 'Resolve' }))
    expect(screen.getByText('✓ Resolved')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /Conversation/ })).toHaveTextContent('0 unresolved threads')
    await act(async () => fail(new Error('Not allowed')))
    expect(screen.getByText('Open thread')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('Not allowed')
    expect(screen.getByRole('heading', { name: /Conversation/ })).toHaveTextContent('1 unresolved thread')
    expect(screen.getByRole('button', { name: 'Resolve' })).toBeEnabled()
    expect(onChanged).not.toHaveBeenCalled()
  })

  it('does not offer writes without GitHub permission or on ordinary comments', () => {
    setup({ viewerCanReply: false, viewerCanResolve: false })
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    expect(screen.getByText('General comment')).toBeInTheDocument()
  })
})
