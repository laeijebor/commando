// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TmuxPane, WebPane } from '../shared/protocol'
import type { GitDiffApiClient, GitDiffSummary } from './gitApi'
import type { PanePrSummary, PrsApiClient } from './prsApi'
import { useState } from 'react'
import { readFileSync } from 'node:fs'
import { prTabSignature } from './sidePanelState'
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

afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals() })

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
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ key: 'pr:acme:widgets:4' }))
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Session', '#4', '#3', '#2', '#1'])
    expect(screen.getByRole('tab', { name: '#4 open' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getAllByRole('button', { name: /Close PR #\d+ tab/ })).toHaveLength(4)
    expect(screen.queryByRole('button', { name: 'Close Session' })).not.toBeInTheDocument()
    const first = screen.getByLabelText('State of pr:acme:widgets:4')
    fireEvent.change(first, { target: { value: 'retained' } })
    view.rerender(element('pr:acme:widgets:3'))
    expect(first.closest('[role="tabpanel"]')).toHaveAttribute('hidden')
    expect(first).toHaveValue('retained')
    view.rerender(element('pr:acme:widgets:4', false))
    expect(screen.getByRole('tab', { name: '#4 open' })).toBeVisible()
    view.rerender(element('pr:acme:widgets:4'))
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

  it('dismisses only PR tabs, falls forward, restores from the menu and filters the rail', async () => {
    vi.useFakeTimers()
    const first = { repo: 'acme/widgets', number: 40, title: 'First', state: 'open', isDraft: false, updatedAt: 'later' } as PanePrSummary
    const second = { ...first, number: 41, title: 'Second', updatedAt: 'earlier' }
    const prsApi = { pane: vi.fn(async () => ({ targetId: 'dismiss-target', pullRequests: [first, second] })) } as unknown as PrsApiClient
    const gitApi = { summary: vi.fn(async () => ({ isRepo: true, target: 'main', files: [{ path: 'a.ts', additions: 1, deletions: 0 }] })) } as unknown as GitDiffApiClient
    const onDismissPr = vi.fn()
    const onRestorePr = vi.fn()
    const onSelect = vi.fn()
    let dismissed: Record<string, string> = {}
    const element = () => <SidePanel windowId="@1" tabs={[]} panes={[{ id: '%12', targetId: 'dismiss-target', path: '/repo' } as TmuxPane]}
      connected gitApi={gitApi} prsApi={prsApi} focusedPaneId="%12" activeTabs={{ '%12': 'pr:acme:widgets:40' }} dismissedPrTabs={{ '%12': dismissed }}
      paneLabel="pane" titles={{}} simulatorNames={{}} onSelect={onSelect} onDismissPr={onDismissPr} onRestorePr={onRestorePr}
      onClose={vi.fn()} onOpen={vi.fn()} renderTab={() => null}>{null}</SidePanel>
    localStorage.setItem('commando.side-panel.collapsed.@1', 'false')
    let view!: ReturnType<typeof render>
    await act(async () => { view = render(element()) })
    expect(screen.queryByRole('button', { name: 'Close Changes' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Close Session' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Add web tab' }))
    expect(screen.queryByRole('heading', { name: 'Closed PRs' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Add web tab' }))
    fireEvent.click(screen.getByRole('button', { name: 'Close PR #40 tab' }))
    expect(onDismissPr).toHaveBeenCalledWith(expect.objectContaining({ key: 'pr:acme:widgets:40' }), prTabSignature(first), expect.objectContaining({ key: 'pr:acme:widgets:41' }))
    dismissed = { 'pr:acme:widgets:40': prTabSignature(first) }
    view.rerender(element())
    expect(screen.queryByRole('tab', { name: '#40 open' })).not.toBeInTheDocument()
    expect(screen.getByRole('tab', { name: '#41 open' })).toHaveAttribute('aria-selected', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'Add web tab' }))
    expect(screen.getByRole('heading', { name: 'Closed PRs' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Browser' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Chromium' })).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: /#40 · First/ }))
    expect(onRestorePr).toHaveBeenCalledWith(expect.objectContaining({ key: 'pr:acme:widgets:40', anchorPaneId: '%12' }))
    fireEvent.click(screen.getByRole('button', { name: 'Collapse side panel' }))
    fireEvent.click(screen.getByRole('button', { name: 'Open PRs' }))
    expect(onSelect).toHaveBeenLastCalledWith(expect.objectContaining({ key: 'pr:acme:widgets:41' }))
    dismissed['pr:acme:widgets:41'] = prTabSignature(second)
    view.rerender(element())
    fireEvent.click(screen.getByRole('button', { name: 'Collapse side panel' }))
    expect(screen.queryByRole('button', { name: 'Open PRs' })).not.toBeInTheDocument()
    first.updatedAt = 'new activity'
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
    expect(screen.getByRole('button', { name: 'Open PRs' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Open PRs' }))
    expect(onSelect).toHaveBeenLastCalledWith(expect.objectContaining({ key: 'pr:acme:widgets:40' }))
    expect(screen.getByRole('tab', { name: '#40 open' })).toBeInTheDocument()
  })

  it.each([false, true])('settles a delayed PR reveal after membership loads (present=%s)', async (present) => {
    const requestedId = 'panel:%12:pr:acme:widgets:12'
    let finish!: (value: unknown) => void
    const prsApi = { pane: vi.fn(() => new Promise((resolve) => { finish = resolve })) } as unknown as PrsApiClient
    const gitApi = { summary: vi.fn(async () => ({ isRepo: false })) } as unknown as GitDiffApiClient
    const onUnavailable = vi.fn()
    const onVisible = vi.fn()
    function PendingPanel({ windowId }: { windowId: string }) {
      const [request, setRequest] = useState<typeof requestedId | null>(requestedId)
      return <SidePanel key={windowId} windowId={windowId} tabs={[]} panes={[{ id: '%12', targetId: 'target', path: '/repo' } as TmuxPane]}
        connected gitApi={gitApi} prsApi={prsApi} focusedPaneId="%12" activeTabs={{ '%12': 'pr:acme:widgets:12' }} paneLabel="pane" titles={{}} simulatorNames={{}}
        revealRequest={request ? { tabId: request, onVisible: () => { onVisible(); setRequest(null) }, onUnavailable: () => { onUnavailable(); setRequest(null) } } : undefined}
        onSelect={vi.fn()} onClose={vi.fn()} onOpen={vi.fn()} renderTab={() => null}>{null}</SidePanel>
    }
    const view = render(<PendingPanel windowId="@1" />)
    expect(onUnavailable).not.toHaveBeenCalled()
    await act(async () => { finish({ targetId: 'target', fetchedAt: Date.now(), pullRequests: present ? [{ number: 12, repo: 'acme/widgets', url: 'https://github.com/acme/widgets/pull/12', state: 'open', updatedAt: '' }] : [] }) })
    if (present) {
      await vi.waitFor(() => expect(onVisible).toHaveBeenCalledOnce())
      expect(onUnavailable).not.toHaveBeenCalled()
      expect(screen.getByRole('tab', { name: '#12 open' })).toHaveAttribute('aria-selected', 'true')
    } else {
      expect(onUnavailable).toHaveBeenCalledOnce()
      expect(onVisible).not.toHaveBeenCalled()
      expect(screen.getByRole('tab', { name: 'Session' })).toHaveAttribute('aria-selected', 'true')
    }
    fireEvent.click(screen.getByRole('button', { name: 'Collapse side panel' }))
    view.rerender(<PendingPanel windowId="@2" />)
    expect(view.container.querySelector('.window-panel-layout')).toHaveClass('is-collapsed')
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

describe('narrow tabs drawer', () => {
  function Drawer({ narrow = true, reveal = false, windowId = '@1', revision = 0, onSeen = vi.fn(), terminalClick = vi.fn(), terminalPointer = vi.fn() }: {
    narrow?: boolean; reveal?: boolean; windowId?: string; revision?: number
    onSeen?: (tab: WebPane) => void; terminalClick?: () => void; terminalPointer?: () => void
  }) {
    const [open, setOpen] = useState(false)
    return <SidePanel windowId={windowId} tabs={[{ ...tabs[1], openRevision: revision }]} focusedPaneId="%13" paneLabel="Agent B"
      narrowMode={narrow} drawerOpen={open} onDrawerOpen={() => setOpen(true)} onDrawerClose={() => setOpen(false)}
      revealRequest={reveal ? { tabId: tabs[1].id, onVisible: () => undefined } : undefined}
      simulatorNames={{}} titles={{}} onSelect={vi.fn()} onClose={vi.fn()} onOpen={vi.fn()} onSeen={onSeen}
      renderTab={(tab, visible) => <div data-testid={tab.id} data-visible={String(visible)} />}>
      <button data-panel-chip="%13" onClick={() => setOpen((value) => !value)}>Pane tabs</button>
      <button onClick={terminalClick} onPointerDown={terminalPointer}>Terminal input</button>
    </SidePanel>
  }

  it('opens the active tab and focuses it, closes by Escape, scrim, header and terminal tap without forwarding input', () => {
    const terminalClick = vi.fn()
    const terminalPointer = vi.fn()
    const onSeen = vi.fn()
    const view = render(<Drawer terminalClick={terminalClick} terminalPointer={terminalPointer} onSeen={onSeen} />)
    const layout = view.container.querySelector('.window-panel-layout')!
    const terminal = screen.getByRole('button', { name: 'Terminal input' })
    const chip = screen.getByRole('button', { name: 'Pane tabs' })
    const tabBody = screen.getByTestId(tabs[1].id)
    expect(layout).toHaveClass('is-narrow', 'is-collapsed')
    expect(tabBody).toHaveAttribute('data-visible', 'false')
    expect(onSeen).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Expand side panel' })).not.toBeInTheDocument()
    for (const close of ['escape', 'scrim', 'header', 'terminal', 'chip']) {
      fireEvent.click(chip)
      expect(layout).toHaveClass('is-drawer-open')
      expect(screen.getByRole('tab', { name: /localhost\/1/ })).toHaveFocus()
      expect(tabBody).toHaveAttribute('data-visible', 'true')
      if (close === 'escape') fireEvent.keyDown(window, { key: 'Escape' })
      if (close === 'scrim') fireEvent.click(view.container.querySelector('.side-panel-scrim')!)
      if (close === 'header') fireEvent.click(within(view.container.querySelector('aside')!).getByRole('button', { name: 'Close tabs drawer' }))
      if (close === 'terminal') { fireEvent.pointerDown(terminal); fireEvent.click(terminal) }
      if (close === 'chip') { chip.focus(); fireEvent.click(chip) }
      expect(layout).not.toHaveClass('is-drawer-open')
      expect(tabBody).toHaveAttribute('data-visible', 'false')
      expect(chip).toHaveFocus()
      expect(screen.getByRole('button', { name: 'Terminal input' })).toBe(terminal)
    }
    expect(terminalClick).not.toHaveBeenCalled()
    expect(terminalPointer).not.toHaveBeenCalled()
    expect(localStorage.getItem('commando.side-panel.collapsed.@1')).toBeNull()
  })

  it('layers a clickable scrim above the terminal stacking context and below the drawer', () => {
    const view = render(<Drawer />)
    fireEvent.click(screen.getByRole('button', { name: 'Pane tabs' }))
    const grid = view.container.querySelector('.window-terminal-grid')!
    const scrim = view.container.querySelector('.side-panel-scrim')!
    const drawer = view.container.querySelector('.side-panel')!
    expect(scrim.parentElement).toBe(grid.parentElement)
    expect(drawer.parentElement).toBe(grid.parentElement)
    const css = readFileSync('src/styles.css', 'utf8')
    const narrowCss = css.slice(css.indexOf('@media (max-width: 840px) {', css.indexOf('.window-panel-layout {')),
      css.indexOf('@media (max-width: 840px) and (prefers-reduced-motion: reduce)'))
    const gridRule = narrowCss.match(/\.window-panel-layout \.window-terminal-grid\s*\{([^}]+)\}/)![1]
    const scrimRule = narrowCss.match(/\.side-panel-scrim\s*\{([^}]+)\}/)![1]
    const drawerRule = narrowCss.match(/\.window-panel-layout \.side-panel\s*\{([^}]+)\}/)![1]
    const zIndex = (rule: string) => Number(rule.match(/z-index:\s*(\d+)/)![1])
    expect(gridRule).toMatch(/position:\s*relative;/)
    expect(scrimRule).toMatch(/pointer-events:\s*auto;/)
    expect(zIndex(scrimRule)).toBeGreaterThan(zIndex(gridRule))
    expect(zIndex(drawerRule)).toBeGreaterThan(zIndex(scrimRule))
    expect(drawerRule).toContain('height: min(var(--side-panel-height, 60vh), 100%)')
    expect(scrimRule).toContain('inset: 0 0 min(var(--side-panel-height, 60vh), 100%)')
    expect(narrowCss).toMatch(/\.window-panel-layout \.side-panel-rail\s*\{\s*display:\s*none;/)
  })

  it.each(['true', 'false'])('renders no narrow rail with a remembered wide collapse choice of %s', (choice) => {
    localStorage.setItem('commando.side-panel.collapsed.@1', choice)
    const view = render(<Drawer />)
    const drawer = view.container.querySelector<HTMLElement>('.side-panel')!
    expect(view.container.querySelector('.side-panel-rail')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Open Session' })).not.toBeInTheDocument()
    expect(drawer).toHaveAttribute('inert')
    expect(drawer).toHaveAttribute('aria-hidden', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'Pane tabs' }))
    expect(view.container.querySelector('.side-panel-rail')).toBeNull()
    expect(drawer).not.toHaveAttribute('inert')
    fireEvent.click(within(drawer).getByRole('button', { name: 'Close tabs drawer' }))
    expect(view.container.querySelector('.side-panel-rail')).toBeNull()
    expect(drawer).toHaveAttribute('inert')
  })

  it('keeps chip toggles and explicit Changes reveals usable through the scrim without sending terminal clicks', () => {
    const terminalClick = vi.fn()
    const view = render(<Drawer terminalClick={terminalClick} />)
    const chip = screen.getByRole('button', { name: 'Pane tabs' })
    Object.defineProperty(chip, 'getBoundingClientRect', { value: () => ({ left: 100, right: 150, top: 20, bottom: 40, width: 50, height: 20 }) })
    fireEvent.click(chip)
    fireEvent.click(view.container.querySelector('.side-panel-scrim')!, { clientX: 120, clientY: 30 })
    expect(view.container.querySelector('.window-panel-layout')).not.toHaveClass('is-drawer-open')
    fireEvent.click(chip)
    const changes = document.createElement('button')
    changes.className = 'pane-git-stats'
    const revealChanges = vi.fn()
    changes.addEventListener('click', revealChanges)
    Object.defineProperty(changes, 'getBoundingClientRect', { value: () => ({ left: 100, right: 150, top: 200, bottom: 220, width: 50, height: 20 }) })
    view.container.querySelector('.window-terminal-grid')!.append(changes)
    fireEvent.click(view.container.querySelector('.side-panel-scrim')!, { clientX: 120, clientY: 210 })
    expect(revealChanges).toHaveBeenCalledOnce()
    expect(view.container.querySelector('.window-panel-layout')).toHaveClass('is-drawer-open')
    fireEvent.click(view.container.querySelector('.side-panel-scrim')!, { clientX: 200, clientY: 150 })
    expect(view.container.querySelector('.window-panel-layout')).not.toHaveClass('is-drawer-open')
    expect(terminalClick).not.toHaveBeenCalled()
  })

  it('only reveals for an explicit request and keeps new revisions hidden and unseen while closed', () => {
    const onSeen = vi.fn()
    const view = render(<Drawer onSeen={onSeen} />)
    const terminal = screen.getByRole('button', { name: 'Terminal input' })
    view.rerender(<Drawer revision={1} onSeen={onSeen} />)
    expect(view.container.querySelector('.window-panel-layout')).not.toHaveClass('is-drawer-open')
    expect(onSeen).not.toHaveBeenCalled()
    view.rerender(<Drawer revision={1} reveal onSeen={onSeen} />)
    expect(view.container.querySelector('.window-panel-layout')).toHaveClass('is-drawer-open')
    expect(onSeen).toHaveBeenCalledWith(expect.objectContaining({ id: tabs[1].id, openRevision: 1 }))
    expect(screen.getByRole('button', { name: 'Terminal input' })).toBe(terminal)
  })

  it('remembers and clamps drawer height per window without changing wide width or collapse choice', () => {
    localStorage.setItem('commando.side-panel.height.@1', '70')
    localStorage.setItem('commando.side-panel.height.@2', '100')
    localStorage.setItem('commando.side-panel.width.@1', '62')
    localStorage.setItem('commando.side-panel.collapsed.@1', 'true')
    const view = render(<Drawer />)
    const terminal = screen.getByRole('button', { name: 'Terminal input' })
    fireEvent.click(screen.getByRole('button', { name: 'Pane tabs' }))
    const handle = screen.getByRole('separator', { name: 'Resize tabs drawer' })
    expect(handle).toHaveAttribute('aria-valuenow', '70')
    for (let i = 0; i < 8; i++) fireEvent.keyDown(handle, { key: 'ArrowUp' })
    expect(localStorage.getItem('commando.side-panel.height.@1')).toBe('90')
    for (let i = 0; i < 15; i++) fireEvent.keyDown(handle, { key: 'ArrowDown' })
    expect(localStorage.getItem('commando.side-panel.height.@1')).toBe('25')
    view.rerender(<Drawer narrow={false} />)
    expect(screen.getByRole('button', { name: 'Terminal input' })).toBe(terminal)
    expect(view.container.querySelector('.window-panel-layout')).toHaveClass('is-collapsed')
    expect(localStorage.getItem('commando.side-panel.width.@1')).toBe('62')
    expect(localStorage.getItem('commando.side-panel.collapsed.@1')).toBe('true')
    view.rerender(<Drawer key="@2" windowId="@2" />)
    fireEvent.click(screen.getByRole('button', { name: 'Pane tabs' }))
    expect(screen.getByRole('separator', { name: 'Resize tabs drawer' })).toHaveAttribute('aria-valuenow', '90')
  })

  it('resizes against window height from a captured pointer and stops on release', () => {
    vi.stubGlobal('innerHeight', 1000)
    const view = render(<Drawer />)
    fireEvent.click(screen.getByRole('button', { name: 'Pane tabs' }))
    const handle = screen.getByRole('separator', { name: 'Resize tabs drawer' })
    const capture = vi.fn()
    Object.defineProperty(handle, 'setPointerCapture', { value: capture })
    vi.spyOn(view.container.querySelector('.window-panel-layout')!, 'getBoundingClientRect').mockReturnValue({ height: 700 } as DOMRect)
    const pointer = (type: string, clientY: number) => {
      const event = new Event(type, { bubbles: true })
      Object.assign(event, { clientY, button: 0, pointerId: 7 })
      fireEvent(handle, event)
    }
    expect(view.container.querySelector<HTMLElement>('.window-panel-layout')!.style.getPropertyValue('--side-panel-height')).toBe('60vh')
    pointer('pointerdown', 600)
    expect(capture).toHaveBeenCalledWith(7)
    pointer('pointermove', 500)
    expect(handle).toHaveAttribute('aria-valuenow', '70')
    pointer('pointermove', 0)
    expect(handle).toHaveAttribute('aria-valuenow', '90')
    pointer('pointermove', 1000)
    expect(handle).toHaveAttribute('aria-valuenow', '25')
    pointer('pointerup', 1000)
    pointer('pointermove', 200)
    expect(handle).toHaveAttribute('aria-valuenow', '25')
    expect(localStorage.getItem('commando.side-panel.height.@1')).toBe('25')
  })

  it('tolerates unavailable localStorage', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('disabled') })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('disabled') })
    render(<Drawer />)
    fireEvent.click(screen.getByRole('button', { name: 'Pane tabs' }))
    expect(screen.getByRole('separator', { name: 'Resize tabs drawer' })).toHaveAttribute('aria-valuenow', '60')
  })
})
