// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TmuxPane, TmuxSession, TmuxWindow } from '../shared/protocol'
import { PanesView } from './PanesView'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

const pane = (id: string, sessionId: string, extra: Partial<TmuxPane> = {}): TmuxPane => ({
  id, targetId: `t-${id}`, index: 0, windowId: `@${sessionId}`, sessionId, title: '', command: 'zsh', path: '/work',
  active: false, dead: false, ...extra,
} as TmuxPane)
const sessions: TmuxSession[] = [
  { id: '$1', name: 'alpha', attached: false, activeWindowId: null, windowIds: ['@$1'] },
  { id: '$2', name: 'beta', attached: false, activeWindowId: null, windowIds: ['@$2'] },
]
const windows: TmuxWindow[] = sessions.map((session) => ({ id: `@${session.id}`, index: 0, sessionId: session.id, name: 'w', active: true, layout: '', paneIds: [] }))
const panes = [pane('%1', '$1', { chatTitle: 'Fix login' }), pane('%2', '$1', { title: 'dev server', command: 'node' }), pane('%3', '$2', { title: 'notes' })]

function renderView(overrides: Partial<Parameters<typeof PanesView>[0]> = {}) {
  const api = {
    capturePane: vi.fn(async (paneId: string) => `screen of ${paneId}`),
    paneViews: vi.fn(async () => ({ viewedAt: { '%2': Date.now() - 2 * 3_600_000 }, viewing: ['%1'] })),
  }
  const onOpen = vi.fn()
  const onClose = vi.fn(async () => {})
  render(<PanesView sessions={sessions} windows={windows} panes={panes} agentStatuses={{}} activity={{}} auxiliarySessionIds={new Set()}
    api={api} connected onOpen={onOpen} onClose={onClose} {...overrides} />)
  return { api, onOpen, onClose }
}

describe('PanesView', () => {
  it('lists every pane with its session and when it was last viewed', async () => {
    renderView()
    expect(screen.getByText('3 panes')).toBeInTheDocument()
    const row = (await screen.findByText('2h ago')).closest('tr')!
    expect(within(row).getByText('dev server')).toBeInTheDocument()
    expect(within(row).getByText('alpha')).toBeInTheDocument()
    expect(within(screen.getByText('Fix login').closest('tr')!).getByText('On screen')).toBeInTheDocument()
    expect(within(screen.getByText('notes').closest('tr')!).getByText('Not recorded')).toBeInTheDocument()
  })

  it('previews the clicked pane and opens it in the workspace', async () => {
    const { api, onOpen } = renderView()
    fireEvent.click(screen.getByText('notes'))
    expect(await screen.findByText('screen of %3')).toBeInTheDocument()
    expect(api.capturePane).toHaveBeenCalledWith('%3')
    fireEvent.click(within(screen.getByRole('complementary', { name: 'Preview of notes' })).getByRole('button', { name: /Open/ }))
    expect(onOpen).toHaveBeenCalledWith('%3')
  })

  it("closes selected panes after one confirmation, pausing a session whose last pane goes", async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const { onClose } = renderView()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select dev server' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select notes' }))
    fireEvent.click(screen.getByRole('button', { name: /Close 2 selected/ }))
    expect(confirm).toHaveBeenCalledWith(expect.stringMatching(/^Close 1 pane, pause 1 session\?/))
    await waitFor(() => expect(onClose).toHaveBeenCalledWith({ panes: ['%2'], pauseSessions: ['$2'], deleteSessions: [], kept: [] }, expect.any(Function)))
  })

  it('does nothing when the close is not confirmed', () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    const { onClose } = renderView()
    fireEvent.click(screen.getByRole('button', { name: 'Close pane: dev server' }))
    expect(onClose).not.toHaveBeenCalled()
  })

  it('keeps "last viewed" when the parent re-renders with a new api object', async () => {
    const api = {
      capturePane: vi.fn(async () => ''),
      paneViews: vi.fn(async () => ({ viewedAt: { '%2': Date.now() - 2 * 3_600_000 }, viewing: [] })),
    }
    const props = { sessions, windows, panes, agentStatuses: {}, activity: {}, auxiliarySessionIds: new Set<string>(), connected: true, onOpen: vi.fn(), onClose: vi.fn(async () => {}) }
    const { rerender } = render(<PanesView {...props} api={api} />)
    await screen.findByText('2h ago')
    rerender(<PanesView {...props} api={{ ...api }} />)
    expect(screen.getByText('2h ago')).toBeInTheDocument()
    expect(api.paneViews).toHaveBeenCalledOnce()
  })

  it('opens the highlighted pane on Enter after arrowing to it, but not from a row button', () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    const { onOpen } = renderView()
    const firstRow = screen.getByText('Fix login').closest('tr')!
    fireEvent.click(firstRow)
    fireEvent.keyDown(firstRow, { key: 'ArrowDown' })
    const focused = document.activeElement as HTMLElement
    expect(focused.tagName).toBe('TR')
    fireEvent.keyDown(focused, { key: 'Enter' })
    expect(onOpen).toHaveBeenCalledWith(focused.dataset.paneId)
    onOpen.mockClear()
    fireEvent.keyDown(screen.getByRole('button', { name: 'Close pane: dev server' }), { key: 'Enter' })
    expect(onOpen).not.toHaveBeenCalled()
  })

  it("shows a failed capture's error instead of the previous pane's screen", async () => {
    const { api } = renderView()
    api.capturePane.mockImplementation(async (paneId: string) => {
      if (paneId === '%3') throw new Error('pane gone')
      return `screen of ${paneId}`
    })
    fireEvent.click(screen.getByText('dev server'))
    expect(await screen.findByText('screen of %2')).toBeInTheDocument()
    fireEvent.click(screen.getByText('notes'))
    expect(await screen.findByText('Could not read the pane: pane gone')).toBeInTheDocument()
    expect(screen.queryByText('screen of %2')).not.toBeInTheDocument()
  })
})
