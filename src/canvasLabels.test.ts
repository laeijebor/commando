import { describe, expect, it } from 'vitest'
import { buildCanvasLabelTree, readCanvasLabels, resolveCanvasLabel, type CanvasLabel } from './canvasLabels'
import type { CanvasFrame } from '../shared/canvas-manifest'

const frame = (id: string): CanvasFrame => ({ id, title: id, src: `${id}.html`, x: 0, y: 0, w: 390, h: 844 })
const label = (name: string, group?: string, id?: string): CanvasLabel => ({ name, group, id, rect: { x: 1, y: 2, w: 30, h: 40 } })
describe('canvas label tree', () => {
  const frames = [frame('a'), frame('b'), frame('c')]
  const reports = { a: [label('Row', 'Accounts', 'row'), label('Header'), label('Row', 'Accounts'), label('Footer', 'Navigation')], b: [label('Row'), label('Search')], c: [] }
  it('keeps frame, first-seen group and label order, including empty frames', () => {
    const tree = buildCanvasLabelTree(frames, reports)
    expect(tree.frames.map(({ frame, count }) => [frame.id, count])).toEqual([['a', 4], ['b', 2], ['c', 0]])
    expect(tree.frames[0].groups.map(({ name, labels }) => [name, labels.map((i) => i.label.name)])).toEqual([['Accounts', ['Row', 'Row']], ['', ['Header']], ['Navigation', ['Footer']]])
    expect(tree.shared.map(({ name, instances }) => [name, instances.length])).toEqual([['Row', 3]])
    expect(buildCanvasLabelTree([frames[0]], reports).shared).toEqual([])
  })
  it('handles frame IDs that match object prototype properties before labels arrive', () => {
    expect(buildCanvasLabelTree([frame('constructor'), frame('__proto__')], {}).frames.map((f) => f.count)).toEqual([0, 0])
    expect(resolveCanvasLabel({ frameId: 'constructor', key: 'index:0' }, {})).toBeUndefined()
  })
  it('filters label names case-insensitively and drops empty groups/frames', () => {
    const tree = buildCanvasLabelTree(frames, reports, '  heaD  ')
    expect(tree.frames.map(({ frame }) => frame.id)).toEqual(['a'])
    expect(tree.frames[0].groups.map((group) => group.name)).toEqual([''])
    expect(tree.shared).toEqual([])
    expect(buildCanvasLabelTree(frames, reports, 'Accounts').frames).toEqual([])
  })
  it('resolves stable IDs after rename and reordering', () => {
    expect(resolveCanvasLabel({ frameId: 'a', key: 'id:row' }, { a: [label('Other'), label('Renamed', undefined, 'row')] })?.name).toBe('Renamed')
    expect(resolveCanvasLabel({ frameId: 'a', key: 'index:1' }, reports)?.name).toBe('Header')
    expect(resolveCanvasLabel({ frameId: 'gone', key: 'id:row' }, reports)).toBeUndefined()
  })
  it('rejects malformed messages, non-finite or negative dimensions and non-string metadata', () => {
    expect(readCanvasLabels(reports.a)).toEqual(reports.a)
    for (const value of [null, {}, [null], [{ ...label('x'), group: 2 }], [{ ...label('x'), rect: { x: Infinity, y: 0, w: 1, h: 1 } }], [{ ...label('x'), rect: { x: 0, y: 0, w: -1, h: 1 } }]]) expect(readCanvasLabels(value)).toBeNull()
  })
})
