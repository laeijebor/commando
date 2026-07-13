import { describe, expect, it } from 'vitest'
import {
  filterLayoutTree,
  layoutShapeKey,
  layoutSpecFromTree,
  layoutSpecPaneIds,
  layoutTreePanes,
  parseWindowLayout,
} from './window-layout.js'

describe('parseWindowLayout', () => {
  it('parses a single pane window', () => {
    expect(parseWindowLayout('dbde,80x24,0,0,5')).toEqual({
      kind: 'pane',
      paneId: '%5',
      cols: 80,
      rows: 24,
      left: 0,
      top: 0,
    })
  })

  it('parses horizontal and vertical splits with nesting', () => {
    const tree = parseWindowLayout(
      'bb62,208x50,0,0{104x50,0,0,1,103x50,105,0[103x25,105,0,2,103x24,105,26{51x24,105,26,3,51x24,157,26,4}]}',
    )
    expect(tree).toMatchObject({
      kind: 'split',
      direction: 'row',
      cols: 208,
      rows: 50,
      children: [
        { kind: 'pane', paneId: '%1' },
        {
          kind: 'split',
          direction: 'column',
          children: [
            { kind: 'pane', paneId: '%2' },
            {
              kind: 'split',
              direction: 'row',
              children: [
                { kind: 'pane', paneId: '%3' },
                { kind: 'pane', paneId: '%4' },
              ],
            },
          ],
        },
      ],
    })
  })

  it('rejects malformed layouts', () => {
    expect(parseWindowLayout('')).toBeNull()
    expect(parseWindowLayout('80x24,0,0,5')).toBeNull()
    expect(parseWindowLayout('zzzz,80x24,0,0,5')).toBeNull()
    expect(parseWindowLayout('dbde,80x24,0,0')).toBeNull()
    expect(parseWindowLayout('dbde,80x24,0,0,5trailing')).toBeNull()
    expect(parseWindowLayout('bb62,208x50,0,0{104x50,0,0,1}')).toBeNull()
    expect(parseWindowLayout('bb62,208x50,0,0{104x50,0,0,1,103x50,105,0')).toBeNull()
    expect(parseWindowLayout('dbde,0x24,0,0,5')).toBeNull()
  })

  it('rejects trees nested beyond the depth limit', () => {
    let body = '10x10,0,0,1'
    for (let level = 0; level < 9; level += 1) {
      body = `20x20,0,0{${body},10x10,10,0,${level + 2}}`
    }
    expect(parseWindowLayout(`abcd,${body}`)).toBeNull()
  })
})

describe('layout tree helpers', () => {
  const tree = parseWindowLayout(
    'bb62,208x50,0,0{104x50,0,0,1,103x50,105,0[103x25,105,0,2,103x24,105,26,3]}',
  )!

  it('lists panes in tree order', () => {
    expect(layoutTreePanes(tree).map((pane) => pane.paneId)).toEqual(['%1', '%2', '%3'])
  })

  it('filters panes and collapses single-child splits', () => {
    const filtered = filterLayoutTree(tree, new Set(['%1', '%2']))
    expect(filtered).toMatchObject({
      kind: 'split',
      direction: 'row',
      children: [
        { kind: 'pane', paneId: '%1' },
        { kind: 'pane', paneId: '%2' },
      ],
    })
    expect(filterLayoutTree(tree, new Set(['%9']))).toBeNull()
  })

  it('builds specs with optional size overrides', () => {
    const spec = layoutSpecFromTree(tree, new Map([['%2', { cols: 90, rows: 12 }]]))
    expect(layoutSpecPaneIds(spec)).toEqual(['%1', '%2', '%3'])
    expect(spec).toMatchObject({
      kind: 'split',
      children: [
        { kind: 'pane', paneId: '%1', cols: 104, rows: 50 },
        {
          kind: 'split',
          children: [
            { kind: 'pane', paneId: '%2', cols: 90, rows: 12 },
            { kind: 'pane', paneId: '%3', cols: 103, rows: 24 },
          ],
        },
      ],
    })
  })

  it('derives a geometry-independent shape key', () => {
    expect(layoutShapeKey(tree)).toBe('{%1,[%2,%3]}')
    const resized = parseWindowLayout(
      'bb62,208x50,0,0{50x50,0,0,1,157x50,51,0[157x40,51,0,2,157x9,51,41,3]}',
    )!
    expect(layoutShapeKey(resized)).toBe(layoutShapeKey(tree))
  })
})
