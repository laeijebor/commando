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

  it('does not offer writes without GitHub permission or on ordinary comments', () => {
    setup({ viewerCanReply: false, viewerCanResolve: false })
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    expect(screen.getByText('General comment')).toBeInTheDocument()
  })
})
