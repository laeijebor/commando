// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, expect, it, vi } from 'vitest'
import { createTmuxHttpApi } from '../tmuxCreateApi'
import type { SessionCreation } from '../../shared/tmux-create'
import { CursorCloudStrip } from './CursorCloudStrip'

afterEach(cleanup)
const cloud = { provider: 'cursor' as const, repoUrl: 'https://github.com/acme/app' }

it('shows cloud identity before the working branch and URLs arrive', () => {
  render(<CursorCloudStrip cwd="/local/app" cloud={cloud} />)
  expect(screen.getByRole('region', { name: 'Cursor cloud' })).toHaveTextContent('Cursor cloudacme/app')
  expect(screen.getByText('Cursor cloud')).toBeInTheDocument()
  expect(screen.getByText('acme/app')).toBeInTheDocument()
  expect(screen.queryByRole('link')).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /Check out locally/ })).not.toBeInTheDocument()
})

it('links the working branch, PR and Cursor agent and opens PRs in the panel', () => {
  const onOpenPr = vi.fn()
  const details = { ...cloud, startingRef: 'main', branch: 'cursor/fix', prUrl: `${cloud.repoUrl}/pull/42`, webUrl: 'https://cursor.com/agents/bc-test123' }
  render(<CursorCloudStrip cwd="/local/app" cloud={details} onOpenPr={onOpenPr} />)
  expect(screen.getByRole('link', { name: 'cursor/fix' })).toHaveAttribute('href', `${cloud.repoUrl}/tree/cursor/fix`)
  expect(screen.getByRole('link', { name: 'Open on cursor.com' })).toHaveAttribute('href', details.webUrl)
  const pr = screen.getByRole('link', { name: 'PR #42' })
  expect(pr).toHaveAttribute('href', details.prUrl)
  fireEvent.click(pr)
  expect(onOpenPr).toHaveBeenCalledWith('acme/app', 42, 'Description')
  fireEvent.click(pr, { ctrlKey: true })
  expect(onOpenPr).toHaveBeenCalledOnce()
})

it('keeps a normal PR link when no panel handler is supplied', () => {
  render(<CursorCloudStrip cwd="/local/app" cloud={{ ...cloud, prUrl: `${cloud.repoUrl}/pull/5` }} />)
  expect(screen.getByRole('link', { name: 'PR #5' })).toHaveAttribute('href', `${cloud.repoUrl}/pull/5`)
})

const working = { ...cloud, branch: 'cursor/fix-flaky-test-1a2b' }
const fetching: SessionCreation = { id: 'creation-1', name: 'fix-flaky-test-1a2b', cwd: '/local/app', startedAt: 1, stage: 'fetching' }
const created = { kind: 'session' as const, sessionId: '$8', sessionName: 'fix-flaky-test-1a2b', windowId: '@8', windowIndex: 0, windowName: 'shell', paneId: '%8', paneIndex: 0, panePath: '/local/app-worktrees/cursor/fix-flaky-test-1a2b' }
function checkout() {
  return { startSession: vi.fn(async () => fetching), creations: [] as SessionCreation[], onCreated: vi.fn(), dismissCreation: vi.fn(async () => {}) }
}

it('requires both the working branch and a creation callback', () => {
  const actions = checkout()
  const { rerender } = render(<CursorCloudStrip cwd="/local/app" cloud={working} />)
  expect(screen.queryByRole('button')).not.toBeInTheDocument()
  rerender(<CursorCloudStrip cwd="/local/app" cloud={cloud} checkout={actions} />)
  expect(screen.queryByRole('button')).not.toBeInTheDocument()
  rerender(<CursorCloudStrip cwd="/local/app" cloud={working} checkout={actions} />)
  expect(screen.getByRole('button', { name: 'Check out locally' })).toBeEnabled()
})

it('sends a plain shell session request to the creation API and opens the returned session', async () => {
  const response: SessionCreation = { ...fetching, stage: 'done', result: { created } }
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ creation: response })))
  const actions = { ...checkout(), startSession: createTmuxHttpApi('', fetcher).startSession }
  render(<CursorCloudStrip cwd="/local/app" cloud={working} checkout={actions} />)
  fireEvent.click(screen.getByRole('button', { name: 'Check out locally' }))
  await waitFor(() => expect(actions.onCreated).toHaveBeenCalledWith(created))
  expect(fetcher).toHaveBeenCalledWith('/api/tmux/session-creations', expect.objectContaining({
    method: 'POST', body: JSON.stringify({ name: 'fix-flaky-test-1a2b', cwd: '/local/app', worktree: { branch: working.branch, fromRemote: true } }),
  }))
  expect(actions.dismissCreation).toHaveBeenCalledWith(response.id)
})

it('stays pending through the request and background checkout, then opens the completed session once', async () => {
  let resolve!: (creation: SessionCreation) => void
  const actions = { ...checkout(), startSession: vi.fn(() => new Promise<SessionCreation>((done) => { resolve = done })) }
  const { rerender } = render(<CursorCloudStrip cwd="/local/app" cloud={working} checkout={actions} />)
  fireEvent.click(screen.getByRole('button', { name: 'Check out locally' }))
  expect(screen.getByRole('button', { name: 'Checking out…' })).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: 'Checking out…' }))
  expect(actions.startSession).toHaveBeenCalledOnce()
  resolve(fetching)
  await waitFor(() => expect(actions.startSession).toHaveBeenCalledOnce())
  expect(screen.getByRole('button', { name: 'Checking out…' })).toBeDisabled()
  const complete = { ...fetching, stage: 'done' as const, result: { created } }
  rerender(<CursorCloudStrip cwd="/local/app" cloud={working} checkout={{ ...actions, creations: [complete] }} />)
  await waitFor(() => expect(actions.onCreated).toHaveBeenCalledOnce())
  expect(actions.onCreated).toHaveBeenCalledWith(created)
  expect(screen.getByRole('button', { name: 'Check out locally' })).toBeEnabled()
})

it('handles completion reported over the websocket before the start response arrives and shows warnings', async () => {
  const warning = `Local ${working.branch} has commits that aren't on GitHub; it wasn't updated.`
  const complete = { ...fetching, stage: 'done' as const, result: { created, worktree: { path: created.panePath, branch: working.branch, base: '', reusedBranch: true, warning } } }
  const actions = { ...checkout(), creations: [complete] }
  render(<CursorCloudStrip cwd="/local/app" cloud={working} checkout={actions} />)
  fireEvent.click(screen.getByRole('button', { name: 'Check out locally' }))
  await waitFor(() => expect(actions.onCreated).toHaveBeenCalledWith(created))
  expect(screen.getByRole('status')).toHaveTextContent(warning)
})

it('shows a background fetch failure inline and allows a retry', async () => {
  const actions = checkout()
  const { rerender } = render(<CursorCloudStrip cwd="/local/app" cloud={working} checkout={actions} />)
  fireEvent.click(screen.getByRole('button', { name: 'Check out locally' }))
  await waitFor(() => expect(actions.startSession).toHaveBeenCalledOnce())
  rerender(<CursorCloudStrip cwd="/local/app" cloud={working} checkout={{ ...actions, creations: [{ ...fetching, stage: 'failed', error: `${working.branch} isn't on GitHub yet.` }] }} />)
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent("isn't on GitHub yet."))
  expect(actions.onCreated).not.toHaveBeenCalled()
  expect(screen.getByRole('button', { name: 'Check out locally' })).toBeEnabled()
  fireEvent.click(screen.getByRole('button', { name: 'Check out locally' }))
  expect(actions.startSession).toHaveBeenCalledTimes(2)
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
})

it('shows request errors inline and disables checkout while disconnected', async () => {
  const actions = { ...checkout(), startSession: vi.fn().mockRejectedValue(new Error('Not connected')) }
  const { rerender } = render(<CursorCloudStrip cwd="/local/app" cloud={working} checkout={actions} disabled />)
  expect(screen.getByRole('button')).toBeDisabled()
  rerender(<CursorCloudStrip cwd="/local/app" cloud={working} checkout={actions} />)
  fireEvent.click(screen.getByRole('button', { name: 'Check out locally' }))
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Not connected'))
  expect(screen.getByRole('button', { name: 'Check out locally' })).toBeEnabled()
})
