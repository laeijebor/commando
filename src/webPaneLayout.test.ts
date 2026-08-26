import { describe, expect, it } from 'vitest'
import type { WebPane } from '../shared/protocol'
import { layoutTreePanes, parseWindowLayout } from '../shared/window-layout'
import {
  insertWebPaneLeaves,
  isWebPaneLeafId,
} from './webPaneLayout'

const TWO_PANE_LAYOUT = 'bb62,208x50,0,0{104x50,0,0,12,103x50,105,0,13}'
const TWO_STACKED_PANE_LAYOUT = 'bb62,104x101,0,0[104x50,0,0,12,104x50,0,51,13]'
const NESTED_SETTLED_LAYOUT = 'bb62,156x101,0,0{52x101,0,0[52x50,0,0,12,52x50,0,51,14],103x101,53,0,13}'

function webPane(overrides: Partial<WebPane> = {}): WebPane {
  return {
    id: 'w-abcd1234',
    url: 'http://127.0.0.1:41300/plan',
    sessionId: '$1',
    windowId: '@2',
    anchorPaneId: '%12',
    placement: 'auto',
    engine: 'webkit',
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
    expect(below).toMatchObject({ kind: 'split', direction: 'column' })
    if (below.kind !== 'split') throw new Error('expected promoted below split')
    expect(below.children[0]).toMatchObject({ kind: 'split', direction: 'row' })
  })

  it('auto placement splits wide panes to the right and tall panes below', () => {
    const wide = parseWindowLayout('bb62,208x50,0,0,12')!
    const wideResult = insertWebPaneLeaves(wide, [webPane()])
    expect(wideResult).toMatchObject({ kind: 'split', direction: 'row' })

    const tall = parseWindowLayout('bb62,80x50,0,0,12')!
    const tallResult = insertWebPaneLeaves(tall, [webPane()])
    expect(tallResult).toMatchObject({ kind: 'split', direction: 'column' })
  })

  it('keeps the tile inside its anchor footprint so sibling pane weights do not change', () => {
    const tree = parseWindowLayout(TWO_PANE_LAYOUT)!
    const result = insertWebPaneLeaves(tree, [webPane({ placement: 'right' })])

    expect(result).toMatchObject({ kind: 'split', direction: 'row', cols: 208 })
    if (result.kind !== 'split') throw new Error('expected root split')
    expect(result.children[0]).toMatchObject({ kind: 'split', direction: 'row', cols: 104 })
    expect(result.children[1]).toMatchObject({ kind: 'pane', paneId: '%13', cols: 103 })
    if (result.children[0]?.kind !== 'split') throw new Error('expected anchor split')
    expect(result.children[0].children[0]).toMatchObject({ paneId: '%12', cols: 52 })
    expect(result.children[0].children[1]).toMatchObject({ paneId: 'w-abcd1234', cols: 52 })

    const stackedTree = parseWindowLayout(TWO_STACKED_PANE_LAYOUT)!
    const stackedResult = insertWebPaneLeaves(stackedTree, [webPane({ placement: 'below' })])
    expect(stackedResult).toMatchObject({ kind: 'split', direction: 'column', rows: 101 })
    if (stackedResult.kind !== 'split') throw new Error('expected stacked root split')
    expect(stackedResult.children[0]).toMatchObject({ kind: 'split', direction: 'column', rows: 50 })
    expect(stackedResult.children[1]).toMatchObject({ kind: 'pane', paneId: '%13', rows: 50 })
  })

  it('reconstructs a settled tile footprint without inflating the tmux anchor grid', () => {
    const settledTree = parseWindowLayout('bb62,156x50,0,0{52x50,0,0,12,103x50,53,0,13}')!
    const result = insertWebPaneLeaves(settledTree, [webPane({
      placement: 'right',
      layoutState: 'settled',
    })])

    expect(result).toMatchObject({ kind: 'split', direction: 'row', cols: 156 })
    if (result.kind !== 'split') throw new Error('expected root split')
    expect(result.children[0]).toMatchObject({ kind: 'split', direction: 'row', cols: 104 })
    if (result.children[0]?.kind !== 'split') throw new Error('expected anchor split')
    expect(result.children[0].children).toEqual([
      expect.objectContaining({ paneId: '%12', cols: 52 }),
      expect.objectContaining({ paneId: 'w-abcd1234', cols: 52 }),
    ])
    expect(result.children[1]).toMatchObject({ paneId: '%13', cols: 103 })
  })

  it('promotes a tile split to the aligned tmux subtree so every terminal grid can fit', () => {
    const tree = parseWindowLayout(NESTED_SETTLED_LAYOUT)!
    const result = insertWebPaneLeaves(tree, [webPane({
      placement: 'right',
      layoutState: 'settled',
    })])

    expect(result).toMatchObject({ kind: 'split', direction: 'row', cols: 156 })
    if (result.kind !== 'split') throw new Error('expected root split')
    const wrapper = result.children[0]
    expect(wrapper).toMatchObject({ kind: 'split', direction: 'row', cols: 104 })
    if (wrapper?.kind !== 'split') throw new Error('expected promoted tile split')
    expect(wrapper.children[0]).toMatchObject({ kind: 'split', direction: 'column', cols: 52 })
    expect(layoutTreePanes(wrapper.children[0]).map((pane) => pane.paneId)).toEqual(['%12', '%14'])
    expect(wrapper.children[1]).toMatchObject({ paneId: 'w-abcd1234', cols: 52 })
    expect(result.children[1]).toMatchObject({ paneId: '%13', cols: 103 })
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
