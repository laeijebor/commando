import { describe, expect, it } from 'vitest'
import type { WebPane } from '../shared/protocol'
import { layoutTreePanes, parseWindowLayout } from '../shared/window-layout'
import { insertWebPaneLeaves, isWebPaneLeafId } from './webPaneLayout'

const TWO_PANE_LAYOUT = 'bb62,208x50,0,0{104x50,0,0,12,103x50,105,0,13}'

function webPane(overrides: Partial<WebPane> = {}): WebPane {
  return {
    id: 'w-abcd1234',
    url: 'http://127.0.0.1:41300/plan',
    sessionId: '$1',
    windowId: '@2',
    anchorPaneId: '%12',
    placement: 'auto',
    openedBy: 'agent',
    status: 'open',
    createdAt: 0,
    ...overrides,
  }
}

describe('isWebPaneLeafId', () => {
  it('separates web pane ids from tmux pane ids', () => {
    expect(isWebPaneLeafId('w-abcd1234')).toBe(true)
    expect(isWebPaneLeafId('%12')).toBe(false)
  })
})

describe('insertWebPaneLeaves', () => {
  it('splits the anchor leaf and keeps every tmux leaf intact', () => {
    const tree = parseWindowLayout(TWO_PANE_LAYOUT)!
    const result = insertWebPaneLeaves(tree, [webPane({ placement: 'right' })])

    const leafIds = layoutTreePanes(result).map((leaf) => leaf.paneId)
    expect(leafIds).toContain('%12')
    expect(leafIds).toContain('%13')
    expect(leafIds).toContain('w-abcd1234')

    // The original tmux tree is untouched (pure insertion).
    expect(layoutTreePanes(tree).map((leaf) => leaf.paneId)).toEqual(['%12', '%13'])
  })

  it('places right as a row split and below as a column split', () => {
    const tree = parseWindowLayout(TWO_PANE_LAYOUT)!

    const right = insertWebPaneLeaves(tree, [webPane({ placement: 'right' })])
    expect(right.kind).toBe('split')
    const rightAnchorSplit = right.kind === 'split' ? right.children[0] : right
    expect(rightAnchorSplit).toMatchObject({ kind: 'split', direction: 'row' })

    const below = insertWebPaneLeaves(tree, [webPane({ placement: 'below' })])
    const belowAnchorSplit = below.kind === 'split' ? below.children[0] : below
    expect(belowAnchorSplit).toMatchObject({ kind: 'split', direction: 'column' })
  })

  it('auto placement splits wide panes to the right and tall panes below', () => {
    const wide = parseWindowLayout('bb62,208x50,0,0,12')!
    const wideResult = insertWebPaneLeaves(wide, [webPane()])
    expect(wideResult).toMatchObject({ kind: 'split', direction: 'row' })

    const tall = parseWindowLayout('bb62,80x50,0,0,12')!
    const tallResult = insertWebPaneLeaves(tall, [webPane()])
    expect(tallResult).toMatchObject({ kind: 'split', direction: 'column' })
  })

  it('sizes the wrapper as the sum of anchor + tile so measured layouts stay stable', () => {
    // Regression: if the wrapper keeps the anchor's own extent, the measured
    // layout writes the halved anchor back to tmux and the next render halves
    // it again — a runaway shrink to the minimum pane size.
    const wide = parseWindowLayout('bb62,208x50,0,0,12')!
    const right = insertWebPaneLeaves(wide, [webPane({ placement: 'right' })])
    expect(right).toMatchObject({ kind: 'split', direction: 'row', cols: 416 })
    if (right.kind !== 'split') throw new Error('expected split')
    expect(right.children[0]).toMatchObject({ kind: 'pane', paneId: '%12', cols: 208 })
    expect(right.children[1]).toMatchObject({ kind: 'pane', paneId: 'w-abcd1234', cols: 208 })

    const tall = parseWindowLayout('bb62,80x50,0,0,12')!
    const below = insertWebPaneLeaves(tall, [webPane({ placement: 'below' })])
    expect(below).toMatchObject({ kind: 'split', direction: 'column', rows: 100 })
    if (below.kind !== 'split') throw new Error('expected split')
    expect(below.children[0]).toMatchObject({ kind: 'pane', paneId: '%12', rows: 50 })
    expect(below.children[1]).toMatchObject({ kind: 'pane', paneId: 'w-abcd1234', rows: 50 })
  })

  it('docks to the right edge when the anchor pane is not in the tree', () => {
    const tree = parseWindowLayout(TWO_PANE_LAYOUT)!
    const result = insertWebPaneLeaves(tree, [webPane({ anchorPaneId: '%99' })])

    expect(result).toMatchObject({ kind: 'split', direction: 'row' })
    const leaves = layoutTreePanes(result)
    expect(leaves.map((leaf) => leaf.paneId)).toEqual(['%12', '%13', 'w-abcd1234'])
  })

  it('stacks multiple tiles anchored to the same pane', () => {
    const tree = parseWindowLayout(TWO_PANE_LAYOUT)!
    const result = insertWebPaneLeaves(tree, [
      webPane({ id: 'w-aaaa1111', placement: 'right' }),
      webPane({ id: 'w-bbbb2222', placement: 'below' }),
    ])

    const leafIds = layoutTreePanes(result).map((leaf) => leaf.paneId)
    expect(leafIds).toEqual(expect.arrayContaining(['%12', '%13', 'w-aaaa1111', 'w-bbbb2222']))
    expect(leafIds).toHaveLength(4)
  })
})
