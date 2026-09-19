import type { WebPane } from '@commando/protocol'

import { NEEDS_INPUT_STATUS, SNAPSHOT } from '../testing/fixtures'
import { buildPaneContext, tileLabel } from './paneContext'

const statuses = { [NEEDS_INPUT_STATUS.paneId]: NEEDS_INPUT_STATUS }

const tile: WebPane = {
  id: 'web-1',
  url: 'http://localhost:5173/settings',
  sessionId: '$1',
  windowId: '@1',
  anchorPaneId: '%14',
  placement: 'right',
  engine: 'chromium',
  openedBy: 'agent',
  status: 'open',
  createdAt: 0,
}

describe('buildPaneContext', () => {
  it('names the session and describes the pane underneath it', () => {
    const context = buildPaneContext(SNAPSHOT, statuses, [tile], '%14', NEEDS_INPUT_STATUS)
    expect(context.title).toBe('commando')
    expect(context.subtitle).toBe('island · %14 · Claude · ⎇ feat/companion-app')
  })

  it('lists the session’s windows, marking the active one', () => {
    const context = buildPaneContext(SNAPSHOT, statuses, [], '%14', NEEDS_INPUT_STATUS)
    expect(context.windows.map((chip) => [chip.name, chip.active])).toEqual([
      ['island', true],
      ['server', false],
    ])
    expect(context.windows.map((chip) => chip.targetPaneId)).toEqual(['%14', '%15'])
  })

  it('flags a window holding a pane that needs the owner', () => {
    const context = buildPaneContext(SNAPSHOT, statuses, [], '%14', NEEDS_INPUT_STATUS)
    expect(context.windows.find((chip) => chip.id === '@1')?.attention).toBe(true)
    expect(context.windows.find((chip) => chip.id === '@2')?.attention).toBe(false)
  })

  it('keeps only the tiles anchored in this pane’s window', () => {
    const context = buildPaneContext(SNAPSHOT, statuses, [tile, { ...tile, id: 'web-2', windowId: '@2' }], '%14')
    expect(context.tiles.map((entry) => entry.id)).toEqual(['web-1'])
    expect(tileLabel(tile)).toBe('localhost:5173')
  })

  it('degrades to the pane id when the snapshot has not arrived', () => {
    const context = buildPaneContext(null, {}, [], '%14')
    expect(context.title).toBe('Pane')
    expect(context.subtitle).toBe('%14')
    expect(context.windows).toEqual([])
  })
})
