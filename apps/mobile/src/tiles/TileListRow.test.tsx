import { act, fireEvent, render, screen } from '@testing-library/react-native'

import type { WebPane } from '@commando/protocol'

import { SNAPSHOT } from '../testing/fixtures'
import { ThemeProvider } from '../theme'
import { buildTileRows } from './list'
import { TileListRow } from './TileListRow'

function tile(overrides: Partial<WebPane> & Pick<WebPane, 'id'>): WebPane {
  return {
    url: 'http://127.0.0.1:4310/redline/artifacts/3f9c/companion.html',
    sessionId: '$1',
    windowId: '@1',
    anchorPaneId: '%14',
    placement: 'right',
    engine: 'chromium',
    openedBy: 'agent',
    openerLabel: 'claude · gizmo',
    status: 'open',
    createdAt: 1_758_196_860_000,
    ...overrides,
  }
}

type Handlers = {
  onOpen: jest.Mock
  onClose: jest.Mock
  onConfirm: jest.Mock
  onReopenAsChromium: jest.Mock
}

async function renderRow(pane: WebPane, queued = 0): Promise<Handlers> {
  const handlers: Handlers = {
    onOpen: jest.fn(),
    onClose: jest.fn(),
    onConfirm: jest.fn(),
    onReopenAsChromium: jest.fn(),
  }
  const [row] = buildTileRows({
    webPanes: [pane],
    feedback: queued ? { [pane.id]: { queued } } : {},
    snapshot: SNAPSHOT,
  })
  render(
    <ThemeProvider>
      <TileListRow busy={false} row={row!} {...handlers} />
    </ThemeProvider>,
  )
  await act(async () => undefined)
  return handlers
}

describe('a tile row', () => {
  it('shows the URL split into host and path, with the engine chip', async () => {
    await renderRow(tile({ id: 'w-00000001' }))
    expect(screen.getByText('127.0.0.1:4310')).toBeTruthy()
    expect(screen.getByText('/redline/artifacts/3f9c/companion.html')).toBeTruthy()
    expect(screen.getByText('chromium')).toBeTruthy()
  })

  it('names the opener and the pane the tile sits beside', async () => {
    await renderRow(tile({ id: 'w-00000001' }))
    expect(screen.getByText('opened by claude · gizmo · beside island · claude')).toBeTruthy()
  })

  it('counts the answers waiting for the agent', async () => {
    await renderRow(tile({ id: 'w-00000001' }), 3)
    expect(screen.getByText('3 queued')).toBeTruthy()
  })

  it('opens the stream when tapped', async () => {
    const handlers = await renderRow(tile({ id: 'w-00000001' }))
    fireEvent.press(screen.getByText('127.0.0.1:4310'))
    expect(handlers.onOpen).toHaveBeenCalled()
  })

  it('asks the owner before an external origin loads', async () => {
    const handlers = await renderRow(tile({ id: 'w-00000003', status: 'pending' }))
    expect(screen.getByText('An agent wants to open an external origin')).toBeTruthy()

    fireEvent.press(screen.getByText('Open'))
    expect(handlers.onConfirm).toHaveBeenCalledWith(false)

    fireEvent.press(screen.getByText('Always allow this origin'))
    expect(handlers.onConfirm).toHaveBeenCalledWith(true)
  })

  it('does not open a tile that is still awaiting confirmation', async () => {
    const handlers = await renderRow(tile({ id: 'w-00000003', status: 'pending' }))
    fireEvent.press(screen.getByText('127.0.0.1:4310'))
    expect(handlers.onOpen).not.toHaveBeenCalled()
  })

  it('offers to reopen a webkit tile as chromium', async () => {
    const handlers = await renderRow(tile({ id: 'w-00000002', engine: 'webkit' }))
    expect(screen.getByText('webkit')).toBeTruthy()
    fireEvent.press(screen.getByText('Reopen as chromium'))
    expect(handlers.onReopenAsChromium).toHaveBeenCalled()
  })

  it('closes the tile from the swipe action', async () => {
    const handlers = await renderRow(tile({ id: 'w-00000001' }))
    fireEvent.press(screen.getByLabelText(
      'Close the tile at 127.0.0.1:4310/redline/artifacts/3f9c/companion.html',
    ))
    expect(handlers.onClose).toHaveBeenCalled()
  })
})
