// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TmuxPane, WebPane } from '../shared/protocol'
import { TilesView } from './TilesView'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

const tile = (id: string, title: string, extra: Partial<WebPane> = {}): WebPane => ({
  id, title, url: `http://localhost:3000/${id}`, sessionId: '$1', windowId: '@1', anchorPaneId: '%1', placement: 'right', dock: 'panel',
  engine: 'webkit', openedBy: 'user', status: 'open', createdAt: Date.now() - 3_600_000, ...extra,
} as WebPane)
const tiles = [
  tile('w-docs', 'Docs'),
  tile('w-sim', '', { url: '', content: { kind: 'simulator', udid: 'U1' } }),
  tile('w-new', 'Unconfirmed', { status: 'pending' }),
]
const panes = [{ id: '%1', targetId: 't', index: 0, windowId: '@1', sessionId: '$1', title: '', command: 'claude', path: '/', active: true, dead: false, chatTitle: 'Fix login' } as TmuxPane]

function renderView() {
  const api = { paneViews: vi.fn(async () => ({ viewedAt: {}, viewing: [], tiles: { viewedAt: { 'w-docs': Date.now() - 2 * 3_600_000 }, viewing: ['w-sim'] } })) }
  const onOpen = vi.fn()
  const onClose = vi.fn(async () => {})
  render(<TilesView tiles={tiles} sessions={[{ id: '$1', name: 'alpha', attached: false, activeWindowId: null, windowIds: [] }]} panes={panes}
    label={(item) => item.title || 'iPhone 16'} api={api} connected onOpen={onOpen} onClose={onClose} />)
  return { api, onOpen, onClose }
}

describe('TilesView', () => {
  it('counts tiles against the limit and shows when each was last viewed', async () => {
    renderView()
    expect(screen.getByText('3 / 64')).toBeInTheDocument()
    const docs = (await screen.findByText('2h ago')).closest('tr')!
    expect(within(docs).getByText('Docs')).toBeInTheDocument()
    expect(within(docs).getByText('Fix login')).toBeInTheDocument()
    expect(within(screen.getByText('iPhone 16').closest('tr')!).getByText('On screen')).toBeInTheDocument()
    expect(within(screen.getByText('Unconfirmed').closest('tr')!).getByText('Awaiting approval')).toBeInTheDocument()
  })

  it('embeds a confirmed page live, but not an unconfirmed one or a simulator', () => {
    const { onOpen } = renderView()
    fireEvent.click(screen.getByText('Docs'))
    expect(screen.getByTitle('Preview of Docs')).toHaveAttribute('src', 'http://localhost:3000/w-docs')
    fireEvent.click(within(screen.getByRole('complementary', { name: 'Preview of Docs' })).getByRole('button', { name: /Open/ }))
    expect(onOpen).toHaveBeenCalledWith('w-docs')
    fireEvent.click(screen.getByText('Unconfirmed'))
    expect(screen.queryByTitle('Preview of Unconfirmed')).not.toBeInTheDocument()
    expect(screen.getByText(/waiting for you to allow its site/)).toBeInTheDocument()
    fireEvent.click(screen.getByText('iPhone 16'))
    expect(screen.getByText(/A simulator tile renders inside Commando/)).toBeInTheDocument()
  })

  it('closes selected tiles after one confirmation', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const { onClose } = renderView()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Docs' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select iPhone 16' }))
    fireEvent.click(screen.getByRole('button', { name: /Close 2 selected/ }))
    expect(confirm).toHaveBeenCalledWith(expect.stringMatching(/^Close 2 tiles\? 1 tile can be reopened .* 1 simulator tile cannot/))
    await waitFor(() => expect(onClose).toHaveBeenCalledWith(['w-docs', 'w-sim'], expect.any(Function)))
  })

  it('does nothing when the close is not confirmed', () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    const { onClose } = renderView()
    fireEvent.click(screen.getByRole('button', { name: 'Close tile: Docs' }))
    expect(onClose).not.toHaveBeenCalled()
  })
})
