// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TmuxPane, WebPane } from '../shared/protocol'
import { CommanderPeekTabs } from './CommanderPeekTabs'
import type { GitDiffApiClient } from './gitApi'
import type { PanePrSummary, PrsApiClient } from './prsApi'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

const pane = { id: '%81', targetId: 'peek-tabs-target', path: '/repo', title: 'Disk cleanup', index: 0 } as TmuxPane
const canvas = { id: 'w-canvas', anchorPaneId: '%81', dock: 'panel', url: '', title: 'Options', content: { kind: 'canvas' } } as unknown as WebPane
const pr = { repo: 'acme/widgets', number: 12, title: 'Clean up', state: 'open', isDraft: false } as PanePrSummary

async function renderTabs(webTabs: WebPane[] = [canvas]) {
  const gitApi = { summary: vi.fn(async () => ({ isRepo: true, target: 'main', files: [{ path: 'a.ts', additions: 3, deletions: 1 }] })) } as unknown as GitDiffApiClient
  const prsApi = { pane: vi.fn(async () => ({ targetId: pane.targetId, pullRequests: [pr] })) } as unknown as PrsApiClient
  const renderBuiltin = vi.fn((tab: { key: string }) => <p>Builtin {tab.key}</p>)
  const renderTab = vi.fn((tab: WebPane) => <p>Web {tab.id}</p>)
  const props = { pane, chat: <p>Agent chat</p>, gitApi, prsApi, connected: true, titles: {}, simulatorNames: {}, renderBuiltin, renderTab }
  const view = await act(async () => render(<CommanderPeekTabs {...props} webTabs={webTabs} />))
  return { ...props, view, rerender: (tabs: WebPane[]) => view.rerender(<CommanderPeekTabs {...props} webTabs={tabs} />) }
}

describe('CommanderPeekTabs', () => {
  it("lists the pane's side-panel tabs beside its chat and shows the chosen one in the chat's place", async () => {
    const { renderBuiltin, renderTab } = await renderTabs()
    expect(screen.getByRole('tablist', { name: 'Tabs for Disk cleanup' })).toBeInTheDocument()
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Chat', 'Session', 'Changes', '#12', 'Options'])
    expect(screen.getByRole('tab', { name: 'Chat' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText('Agent chat')).toBeVisible()

    fireEvent.click(screen.getByRole('tab', { name: '#12' }))
    expect(screen.getByRole('tab', { name: '#12' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText('Builtin pr:acme:widgets:12')).toBeInTheDocument()
    expect(renderBuiltin).toHaveBeenLastCalledWith(expect.objectContaining({ key: 'pr:acme:widgets:12' }), true, expect.objectContaining({ prs: expect.objectContaining({ targetId: pane.targetId }) }))
    // The chat stays mounted, hidden, so its scroll and draft survive.
    expect(screen.getByText('Agent chat').closest('[role="tabpanel"]')).toHaveClass('hidden')

    fireEvent.click(screen.getByRole('tab', { name: 'Options' }))
    expect(screen.getByText('Web w-canvas')).toBeInTheDocument()
    expect(renderTab).toHaveBeenLastCalledWith(canvas, true)

    fireEvent.click(screen.getByRole('tab', { name: 'Chat' }))
    expect(screen.queryByText('Web w-canvas')).toBeNull()
    expect(screen.getByText('Agent chat').closest('[role="tabpanel"]')).not.toHaveClass('hidden')
  })

  it('falls back to the chat when the selected tab closes', async () => {
    const { rerender } = await renderTabs()
    fireEvent.click(screen.getByRole('tab', { name: 'Options' }))
    rerender([])
    expect(screen.queryByRole('tab', { name: 'Options' })).toBeNull()
    expect(screen.getByRole('tab', { name: 'Chat' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText('Agent chat')).toBeVisible()
  })
})
