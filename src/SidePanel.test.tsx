// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TmuxPane, WebPane } from '../shared/protocol'
import type { GitDiffApiClient, GitDiffSummary } from './gitApi'
import type { PanePrSummary, PrsApiClient } from './prsApi'
import { SidePanel } from './SidePanel'

const tabs: WebPane[] = ['%12', '%13'].map((anchorPaneId, index) => ({
  id: `w-0000000${index}`, anchorPaneId, dock: 'panel', order: 0, activeTab: true,
  unseen: index === 1, sessionId: '$1', windowId: '@1', url: `http://localhost/${index}`,
  placement: 'right', engine: 'chromium', openedBy: 'agent', status: 'open', createdAt: index,
}))

function panel(focusedPaneId = '%12', onOpen = vi.fn(), panes = tabs, titles: Record<string, string> = {}) {
  return <SidePanel windowId="@1" tabs={panes} focusedPaneId={focusedPaneId} paneLabel={`${focusedPaneId} · claude`}
    simulatorNames={{}} titles={titles} onSelect={() => undefined} onClose={() => undefined} onOpen={onOpen}
    renderTab={(tab) => <iframe title={tab.id} src={tab.url} />}><div>Terminal grid</div></SidePanel>
}

afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); vi.useRealTimers() })

describe('SidePanel', () => {
  it('keeps tab content mounted across focus swaps and empty states at the same width', () => {
    const view = render(panel())
    const firstFrame = screen.getByTitle(tabs[0].id)
    const secondFrame = screen.getByTitle(tabs[1].id)
    const layout = view.container.querySelector('.window-panel-layout') as HTMLElement
    expect(layout.style.getPropertyValue('--side-panel-width')).toBe('50%')
    expect(firstFrame.closest('[role="tabpanel"]')).not.toHaveAttribute('hidden')
    expect(secondFrame.closest('[role="tabpanel"]')).toHaveAttribute('hidden')
    view.rerender(panel('%13'))
    expect(screen.getByTitle(tabs[0].id)).toBe(firstFrame)
    expect(screen.getByTitle(tabs[1].id)).toBe(secondFrame)
    expect(firstFrame.closest('[role="tabpanel"]')).toHaveAttribute('hidden')
    expect(secondFrame.closest('[role="tabpanel"]')).not.toHaveAttribute('hidden')
    view.rerender(panel('%14'))
    expect(screen.getByRole('button', { name: 'Add web tab' })).toBeInTheDocument()
    expect(screen.queryByText(/Add a web tab for/)).not.toBeInTheDocument()
    expect(layout.style.getPropertyValue('--side-panel-width')).toBe('50%')
    expect(screen.getByTitle(tabs[1].id)).toBe(secondFrame)
  })

  it('keeps web-tab DOM order stable when panes reorder', () => {
    const paneList = ['%12', '%13'].map((id) => ({ id, targetId: id } as TmuxPane))
    const element = (panes: TmuxPane[]) => <SidePanel windowId="@1" tabs={tabs} panes={panes} focusedPaneId="%12" paneLabel="pane" titles={{}} simulatorNames={{}} onSelect={vi.fn()} onClose={vi.fn()} onOpen={vi.fn()} renderTab={(tab) => <iframe title={tab.id} />}>{null}</SidePanel>
    const view = render(element(paneList))
    const frame = screen.getByTitle(tabs[0].id)
    const moves: MutationRecord[] = []
    const observer = new MutationObserver((records) => moves.push(...records))
    const content = view.container.querySelector('.side-panel-content')!
    observer.observe(content, { childList: true })
    view.rerender(element([...paneList].reverse()))
    moves.push(...observer.takeRecords())
    observer.disconnect()
    expect(screen.getByTitle(tabs[0].id)).toBe(frame)
    const webBodies = [...content.querySelectorAll('[role="tabpanel"]')].filter((node) => node.id.includes('w-'))
    expect(webBodies.map((node) => node.id)).toEqual(tabs.map((tab) => `panel-tab-${tab.id}`))
    expect(moves.flatMap((record) => [...record.removedNodes])).not.toContain(frame.parentElement)
  })

  it('falls back locally when Changes disappears and restores the stored selection when it returns', async () => {
    vi.useFakeTimers()
    const changed: GitDiffSummary = { isRepo: true, target: 'main', files: [{ path: 'a.ts', status: 'M', additions: 1, deletions: 0, binary: false }] }
    let summary = changed
    const gitApi = { summary: vi.fn(async () => summary) } as unknown as GitDiffApiClient
    const prsApi = { pane: vi.fn(async () => ({ targetId: 'target', pullRequests: [] })) } as unknown as PrsApiClient
    const onSelect = vi.fn()
    localStorage.setItem('commando.side-panel.collapsed.@1', 'false')
    await act(async () => { render(<SidePanel windowId="@1" tabs={[]} panes={[{ id: '%12', targetId: 'target', path: '/repo' } as TmuxPane]} connected gitApi={gitApi} prsApi={prsApi} focusedPaneId="%12" activeTabs={{ '%12': 'changes' }} paneLabel="pane" titles={{}} simulatorNames={{}} onSelect={onSelect} onClose={vi.fn()} onOpen={vi.fn()} renderTab={() => null}>{null}</SidePanel>) })
    expect(screen.getByRole('tab', { name: /Changes/ })).toHaveAttribute('aria-selected', 'true')
    summary = { isRepo: true, target: 'main', files: [] }
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000) })
    expect(screen.getByRole('tab', { name: 'Session' })).toHaveAttribute('aria-selected', 'true')
    expect(onSelect).not.toHaveBeenCalled()
    summary = changed
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000) })
    expect(screen.getByRole('tab', { name: /Changes/ })).toHaveAttribute('aria-selected', 'true')
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('keeps one PR rail icon, all linked tabs and mounted inactive bodies, with removal fallback and legacy migration', async () => {
    vi.useFakeTimers()
    const pr = (number: number, state: 'open' | 'merged' | 'closed', updatedAt: string, isDraft = false) => ({ number, state, updatedAt, isDraft, repo: 'acme/widgets', url: `https://github.com/acme/widgets/pull/${number}` } as PanePrSummary)
    let prs = [pr(1, 'closed', '2026-10-12'), pr(2, 'merged', '2026-10-12'), pr(3, 'open', '2026-10-10', true), pr(4, 'open', '2026-10-11')]
    const gitApi = { summary: vi.fn(async () => ({ isRepo: false })) } as unknown as GitDiffApiClient
    const prsApi = { pane: vi.fn(async () => ({ targetId: 'target', pullRequests: prs })) } as unknown as PrsApiClient
    const onSelect = vi.fn()
    const element = (stored: string, connected = true) => <SidePanel windowId="@1" tabs={[]} panes={[{ id: '%12', targetId: 'target', path: '/repo' } as TmuxPane]}
      connected={connected} gitApi={gitApi} prsApi={prsApi} focusedPaneId="%12" activeTabs={{ '%12': stored }} paneLabel="pane" titles={{}} simulatorNames={{}}
      onSelect={onSelect} onClose={vi.fn()} onOpen={vi.fn()} renderTab={() => null} renderBuiltin={(tab) => <input aria-label={`State of ${tab.key}`} defaultValue={tab.key} />}>{null}</SidePanel>
    let view!: ReturnType<typeof render>
    await act(async () => { view = render(element('pr')) })
    expect(screen.getAllByRole('button', { name: 'Open PRs' })).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Open PRs' }))
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ key: 'pr:4' }))
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Session', '#4', '#3', '#2', '#1'])
    expect(screen.getByRole('tab', { name: '#4 open' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.queryByRole('button', { name: /Close #/ })).not.toBeInTheDocument()
    const first = screen.getByLabelText('State of pr:4')
    fireEvent.change(first, { target: { value: 'retained' } })
    view.rerender(element('pr:3'))
    expect(first.closest('[role="tabpanel"]')).toHaveAttribute('hidden')
    expect(first).toHaveValue('retained')
    view.rerender(element('pr:4', false))
    expect(screen.getByRole('tab', { name: '#4 open' })).toBeVisible()
    view.rerender(element('pr:4'))
    prs = prs.filter((pr) => pr.number !== 4)
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
    expect(screen.queryByRole('tab', { name: '#4 open' })).not.toBeInTheDocument()
    expect(screen.getByRole('tab', { name: '#3 draft' })).toHaveAttribute('aria-selected', 'true')
    // A transient error retains the last good list and its tab state.
    vi.mocked(prsApi.pane).mockRejectedValueOnce(new Error('Disconnected'))
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
    expect(screen.getByRole('tab', { name: '#3 draft' })).toHaveAttribute('aria-selected', 'true')
    prs = []
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Session'])
    expect(screen.getByRole('tab', { name: 'Session' })).toHaveAttribute('aria-selected', 'true')
  })

  it('shows failed resume attention in the collapsed rail and expanded Session tab', () => {
    const view = render(<SidePanel windowId="@1" tabs={[]} focusedPaneId="%12" paneLabel="pane" titles={{}} simulatorNames={{}} sessionAttention={{ '%12': true }} sessionWarnings={{ '%12': true }} onSelect={vi.fn()} onClose={vi.fn()} onOpen={vi.fn()} renderTab={() => null}>{null}</SidePanel>)
    expect(screen.getByLabelText('Session resume failed')).toHaveClass('is-warning')
    fireEvent.click(screen.getByRole('button', { name: 'Open Session' }))
    expect(screen.getByRole('tab', { name: /Session/ }).querySelector('.is-warning')).toBeInTheDocument()
    expect(view.container.querySelector('.side-panel-add-menu')).not.toBeInTheDocument()
  })

  it('collapses to a rail and restores the remembered per-window width', () => {
    localStorage.setItem('commando.side-panel.width.@1', '62')
    const view = render(panel())
    const layout = view.container.querySelector('.window-panel-layout') as HTMLElement
    const frame = screen.getByTitle(tabs[0].id)
    fireEvent.keyDown(screen.getByRole('separator'), { key: 'ArrowLeft' })
    expect(localStorage.getItem('commando.side-panel.width.@1')).toBe('64')
    fireEvent.click(screen.getByRole('button', { name: 'Collapse side panel' }))
    expect(layout).toHaveClass('is-collapsed')
    expect(frame.closest('[role="tabpanel"]')).toHaveAttribute('hidden')
    fireEvent.click(screen.getByRole('button', { name: 'Expand side panel' }))
    expect(layout).not.toHaveClass('is-collapsed')
    expect(layout.style.getPropertyValue('--side-panel-width')).toBe('64%')
    expect(screen.getByTitle(tabs[0].id)).toBe(frame)
  })

  it('latches expansion after the first web tab and keeps Session after the last closes', () => {
    const view = render(panel('%12', vi.fn(), []))
    const layout = view.container.querySelector('.window-panel-layout')!
    expect(layout).toHaveClass('is-collapsed')
    view.rerender(panel())
    expect(layout).not.toHaveClass('is-collapsed')
    view.rerender(panel('%12', vi.fn(), []))
    expect(layout).not.toHaveClass('is-collapsed')
    expect(screen.getByRole('tab', { name: 'Session' })).toHaveAttribute('aria-selected', 'true')
    expect(localStorage.getItem('commando.side-panel.collapsed.@1')).toBeNull()
  })

  it.each(['true', 'false'])('honours remembered collapse %s through tab arrival, focus and removal', (choice) => {
    localStorage.setItem('commando.side-panel.collapsed.@1', choice)
    const view = render(panel('%12', vi.fn(), []))
    const layout = view.container.querySelector('.window-panel-layout')!
    view.rerender(panel('%13'))
    expect(layout.classList.contains('is-collapsed')).toBe(choice === 'true')
    view.rerender(panel('%12', vi.fn(), []))
    expect(layout.classList.contains('is-collapsed')).toBe(choice === 'true')
  })

  it('adds a browser tab through the supplied creation path anchored to the empty pane', () => {
    const onOpen = vi.fn()
    render(panel('%14', onOpen))
    fireEvent.click(screen.getByRole('button', { name: 'Add web tab' }))
    fireEvent.click(screen.getByRole('button', { name: 'Chromium' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Tab URL' }), { target: { value: 'localhost:5173' } })
    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    expect(onOpen).toHaveBeenCalledWith('http://localhost:5173', '%14', 'chromium')
  })

  it('distinguishes same-host tabs by path, retains the path end, and exposes the full URL', () => {
    const panes = ['one', 'two', 'four'].map((path, order) => ({ ...tabs[0], id: `w-${order}`, order, url: `http://127.0.0.1:4471/${path}` }))
    render(panel('%12', vi.fn(), panes))
    for (const pane of panes) {
      const path = new URL(pane.url).pathname
      const tab = screen.getByRole('tab', { name: `127.0.0.1:4471${path}` })
      expect(tab).toHaveAttribute('title', pane.url)
      expect(tab.querySelector('.side-panel-tab-label')).toHaveAttribute('dir', 'rtl')
      expect(tab.querySelector('bdi')).toHaveAttribute('dir', 'ltr')
    }
  })

  it('prefers WebPane.title over the webkit title map, then falls back to the URL', () => {
    const titled = tabs.map((tab) => ({ ...tab, title: 'Daemon title' }))
    const view = render(panel('%12', vi.fn(), titled, { [tabs[0].id]: 'Webkit title' }))
    const tab = screen.getByRole('tab', { name: 'Daemon title' })
    expect(tab.querySelector('.side-panel-tab-label')).not.toHaveAttribute('dir', 'rtl')
    view.rerender(panel('%12', vi.fn(), tabs, { [tabs[0].id]: 'Webkit title' }))
    expect(screen.getByRole('tab', { name: 'Webkit title' })).toBeInTheDocument()
    view.rerender(panel())
    expect(screen.getByRole('tab', { name: 'localhost/0' })).toBeInTheDocument()
  })

  it('prefers a known page title and still puts the full URL in the tooltip', () => {
    render(panel('%12', vi.fn(), tabs, { [tabs[0].id]: 'Deployment plan' }))
    expect(screen.getByRole('tab', { name: 'Deployment plan' })).toHaveAttribute('title', tabs[0].url)
  })

  it('starts at the rail with built-in icons when the window has no web tabs', () => {
    const view = render(panel('%12', vi.fn(), []))
    expect(screen.getByText('Terminal grid')).toBeInTheDocument()
    expect(view.container.querySelector('.window-panel-layout')).not.toBeNull()
    expect(screen.getByRole('complementary')).toBeInTheDocument()
    expect(view.container.querySelector('.window-panel-layout')).toHaveClass('is-collapsed')
    fireEvent.click(screen.getByRole('button', { name: 'Open Session' }))
    expect(screen.getByRole('tab', { name: 'Session' })).toHaveAttribute('aria-selected', 'true')
    expect(localStorage.getItem('commando.side-panel.collapsed.@1')).toBe('false')
    expect(screen.queryByRole('separator')).toBeInTheDocument()
  })
})
