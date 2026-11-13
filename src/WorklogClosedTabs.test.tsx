// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ClosedWebPane, SessionBrief } from '../shared/protocol'
import { PaneWorklog } from './PaneWorklog'

const now = Date.now()
const tabs: ClosedWebPane[] = [
  { id: 'w-00000001', kind: 'canvas', title: 'Checkout mocks', url: 'http://127.0.0.1:4310/redline/artifacts/a/', closedAt: now - 2 * 60 * 60_000 },
  { id: 'w-00000002', kind: 'redline', title: 'plan.html', url: 'http://127.0.0.1:4310/redline/artifacts/b/plan.html', closedAt: now - 30_000 },
]

const brief: SessionBrief = {
  paneId: '%12', sessionId: '$1', sessionName: 'commando', state: 'working', headline: 'Closing tabs', headlineSource: 'agent',
  tasks: [{ id: 'plan', content: 'Ship it', status: 'pending', priority: 'high' }], updates: [], updatedAt: 1,
}

afterEach(() => {
  cleanup()
  window.localStorage.clear()
})

describe('Closed tabs in the session worklog', () => {
  it('lists closed tabs before the plan, with kind and age, and reopens or forgets them', async () => {
    const onReopen = vi.fn(async () => undefined)
    const onForget = vi.fn(async () => undefined)
    render(<PaneWorklog brief={brief} paneLabel="Tests" fullWidth closedTabs={tabs} onReopenClosedTab={onReopen} onForgetClosedTab={onForget} />)
    const section = screen.getByRole('region', { name: 'Closed tabs for Tests' })
    const plan = screen.getByRole('region', { name: 'Plan for Tests' })
    expect(section.compareDocumentPosition(plan) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(within(section).getByText('Canvas · closed 2h ago')).toBeInTheDocument()
    expect(within(section).getByText('Redline · closed just now')).toBeInTheDocument()

    fireEvent.click(within(section).getByRole('button', { name: 'Reopen Checkout mocks' }))
    await waitFor(() => expect(onReopen).toHaveBeenCalledWith('w-00000001'))
    fireEvent.click(within(section).getByRole('button', { name: 'Forget plan.html' }))
    await waitFor(() => expect(onForget).toHaveBeenCalledWith('w-00000002'))
  })

  it('reports a failed reopen and hides without entries or callbacks', async () => {
    const onReopen = vi.fn(async () => { throw new Error('The pane that owns this tab is not open') })
    const view = render(<PaneWorklog brief={brief} paneLabel="Tests" fullWidth closedTabs={tabs} onReopenClosedTab={onReopen} onForgetClosedTab={async () => undefined} />)
    fireEvent.click(screen.getByRole('button', { name: 'Reopen plan.html' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('The pane that owns this tab is not open')
    view.rerender(<PaneWorklog brief={brief} paneLabel="Tests" fullWidth closedTabs={[]} onReopenClosedTab={onReopen} onForgetClosedTab={async () => undefined} />)
    expect(screen.queryByRole('region', { name: 'Closed tabs for Tests' })).not.toBeInTheDocument()
    view.rerender(<PaneWorklog brief={brief} paneLabel="Tests" fullWidth closedTabs={tabs} />)
    expect(screen.queryByRole('region', { name: 'Closed tabs for Tests' })).not.toBeInTheDocument()
  })

  it('collapses once the list grows long, until the user chooses', () => {
    const many = Array.from({ length: 7 }, (_, index) => ({ ...tabs[0], id: `w-0000001${index}`, title: `Page ${index}` }))
    const props = { brief, paneLabel: 'Tests', fullWidth: true, onReopenClosedTab: async () => undefined, onForgetClosedTab: async () => undefined }
    const view = render(<PaneWorklog {...props} closedTabs={many.slice(0, 2)} />)
    expect(screen.getByRole('button', { name: 'Reopen Page 1' })).toBeInTheDocument()
    view.rerender(<PaneWorklog {...props} closedTabs={many} />)
    expect(screen.queryByRole('button', { name: 'Reopen Page 0' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Expand closed tabs for Tests' }))
    expect(screen.getByRole('button', { name: 'Reopen Page 6' })).toBeInTheDocument()
    view.rerender(<PaneWorklog {...props} closedTabs={[...many, { ...tabs[0], id: 'w-00000099', title: 'Page 7' }]} />)
    expect(screen.getByRole('button', { name: 'Reopen Page 7' })).toBeInTheDocument()
  })
})
