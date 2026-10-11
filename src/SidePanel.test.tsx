// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WebPane } from '../shared/protocol'
import { SidePanel } from './SidePanel'

const tabs: WebPane[] = ['%12', '%13'].map((anchorPaneId, index) => ({
  id: `w-0000000${index}`, anchorPaneId, dock: 'panel', order: 0, activeTab: true,
  unseen: index === 1, sessionId: '$1', windowId: '@1', url: `http://localhost/${index}`,
  placement: 'right', engine: 'webkit', openedBy: 'agent', status: 'open', createdAt: index,
}))

function panel(focusedPaneId = '%12', onOpen = vi.fn(), panes = tabs, titles: Record<string, string> = {}) {
  return <SidePanel windowId="@1" tabs={panes} focusedPaneId={focusedPaneId} paneLabel={`${focusedPaneId} · claude`}
    simulatorNames={{}} titles={titles} onSelect={() => undefined} onClose={() => undefined} onOpen={onOpen}
    renderTab={(tab) => <iframe title={tab.id} src={tab.url} />}><div>Terminal grid</div></SidePanel>
}

afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks() })

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
    expect(screen.getByText('No tabs for %14 · claude')).toBeInTheDocument()
    expect(layout.style.getPropertyValue('--side-panel-width')).toBe('50%')
    expect(screen.getByTitle(tabs[1].id)).toBe(secondFrame)
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

  it('adds a browser tab through the supplied creation path anchored to the empty pane', () => {
    const onOpen = vi.fn()
    render(panel('%14', onOpen))
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

  it('prefers a known page title and still puts the full URL in the tooltip', () => {
    render(panel('%12', vi.fn(), tabs, { [tabs[0].id]: 'Deployment plan' }))
    expect(screen.getByRole('tab', { name: 'Deployment plan' })).toHaveAttribute('title', tabs[0].url)
  })

  it('renders only the grid when the window has no panel tabs', () => {
    const view = render(panel('%12', vi.fn(), []))
    expect(screen.getByText('Terminal grid')).toBeInTheDocument()
    expect(view.container.querySelector('.window-panel-layout')).not.toBeNull()
    expect(screen.queryByRole('complementary')).toBeNull()
    expect(screen.queryByRole('separator')).toBeNull()
  })
})
