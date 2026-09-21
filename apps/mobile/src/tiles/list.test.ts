import type { WebPane } from '@commando/protocol'

import { SNAPSHOT } from '../testing/fixtures'
import {
  buildTileRows,
  canStream,
  describeTileUrl,
  groupTileRows,
  tileSubtitle,
  unstreamableReason,
} from './list'

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

describe('tile URLs', () => {
  it('splits a URL into where and what', () => {
    expect(describeTileUrl('http://127.0.0.1:4310/redline/x.html?v=2')).toEqual({
      host: '127.0.0.1:4310',
      path: '/redline/x.html?v=2',
    })
  })

  it('keeps a bare origin readable', () => {
    expect(describeTileUrl('https://example.com')).toEqual({ host: 'example.com', path: '/' })
    expect(tileSubtitle('https://example.com')).toBe('example.com/')
  })

  it('falls back to the raw string for something unparsable', () => {
    expect(describeTileUrl('not a url')).toEqual({ host: 'not a url', path: '' })
  })
})

describe('tile rows', () => {
  const rows = buildTileRows({
    webPanes: [
      tile({ id: 'w-00000001' }),
      tile({ id: 'w-00000002', openedBy: 'user', openerLabel: undefined, engine: 'webkit' }),
      tile({ id: 'w-00000003', sessionId: '$2', windowId: '@3', anchorPaneId: '%20', status: 'pending' }),
    ],
    feedback: { 'w-00000001': { queued: 3 } },
    snapshot: SNAPSHOT,
  })

  it('names the agent that opened the tile, and says when it was you', () => {
    expect(rows[0]?.opener).toBe('opened by claude · gizmo')
    expect(rows[1]?.opener).toBe('opened by you')
  })

  it('resolves the anchor to its window and pane', () => {
    expect(rows[0]?.anchor).toBe('island · claude')
  })

  it('carries the queued answer count from the feedback info', () => {
    expect(rows[0]?.queued).toBe(3)
    expect(rows[1]?.queued).toBe(0)
  })

  it('flags a tile that is waiting for the owner to allow its origin', () => {
    expect(rows[2]?.awaitingConfirmation).toBe(true)
    expect(rows[0]?.awaitingConfirmation).toBe(false)
  })

  it('groups tiles under their session, in the snapshot order', () => {
    const groups = groupTileRows(rows, SNAPSHOT)
    expect(groups.map((group) => group.sessionName)).toEqual(['commando', 'lavish'])
    expect(groups[0]?.rows.map((row) => row.tile.id)).toEqual(['w-00000001', 'w-00000002'])
  })

  it('keeps tiles whose session is no longer in the snapshot', () => {
    const orphan = buildTileRows({
      webPanes: [tile({ id: 'w-00000009', sessionId: '$99' })],
      feedback: {},
      snapshot: SNAPSHOT,
    })
    const groups = groupTileRows(orphan, SNAPSHOT)
    expect(groups).toHaveLength(1)
    expect(groups[0]?.sessionName).toBe('$99')
  })

  it('falls back to the anchor pane id with no snapshot to resolve against', () => {
    const [row] = buildTileRows({ webPanes: [tile({ id: 'w-00000001' })], feedback: {}, snapshot: null })
    expect(row?.anchor).toBe('%14')
  })
})

describe('what the phone can stream', () => {
  it('streams open chromium tiles only', () => {
    expect(canStream(tile({ id: 'w-1' }))).toBe(true)
    expect(canStream(tile({ id: 'w-2', engine: 'webkit' }))).toBe(false)
    expect(canStream(tile({ id: 'w-3', status: 'pending' }))).toBe(false)
  })

  it('says why, so the row can offer the fix', () => {
    expect(unstreamableReason(tile({ id: 'w-1' }))).toBeNull()
    expect(unstreamableReason(tile({ id: 'w-2', engine: 'webkit' })))
      .toBe('Webkit tiles render on the host, not here')
    expect(unstreamableReason(tile({ id: 'w-3', status: 'pending' })))
      .toBe('Waiting for you to allow this origin')
  })
})
