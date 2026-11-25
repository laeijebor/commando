import { describe, expect, it } from 'vitest'
import type { BoardView } from '../shared/board'
import { boardGroupAt, boardInViewport, boardLod, boardMatches, boardPlaced, boardType, boardWorldPoint } from './BoardGeometry'

const board: BoardView = { targetId: 'target', rev: 1, groups: [{ id: 'spec', title: 'Spec', by: 'agent', x: 100, y: 100, w: 464, h: 180 }], items: [], placements: {}, links: [] }

describe('Board geometry and level of detail', () => {
  it('uses exact 20% and 60% boundaries', () => {
    expect([.1, .199, .2, .599, .6, 2].map(boardLod)).toEqual(['groups', 'groups', 'thumbnail', 'thumbnail', 'full', 'full'])
  })
  it('culls beyond one viewport margin, accounting for pan, scale, and card size', () => {
    const camera = { x: -100, y: -50, scale: .5 }, viewport = { w: 400, h: 300 }
    expect(boardInViewport({ x: 1700, y: 0, w: 200, h: 160 }, camera, viewport)).toBe(true)
    expect(boardInViewport({ x: 1801, y: 0, w: 200, h: 160 }, camera, viewport)).toBe(false)
    expect(boardInViewport({ x: -801, y: 0, w: 200, h: 160 }, camera, viewport)).toBe(false)
    expect(boardInViewport({ x: 0, y: 1301, w: 200, h: 160 }, camera, viewport)).toBe(false)
    expect(boardWorldPoint({ x: 50, y: 50 }, camera)).toEqual({ x: 300, y: 200 })
  })
  it('uses absolute placement coordinates and grows groups optimistically without overlaps', () => {
    const first = boardPlaced(board, 'a', { group: 'spec' })
    const second = boardPlaced(first, 'b', { group: 'spec' })
    const third = boardPlaced(second, 'c', { group: 'spec' })
    expect(first.placements.a).toEqual({ group: 'spec', x: 112, y: 140 })
    expect(second.placements.b).toEqual({ group: 'spec', x: 332, y: 140 })
    expect(third.placements.c).toEqual({ group: 'spec', x: 112, y: 310 })
    expect(third.groups[0].h).toBe(392)
    expect(board.placements).toEqual({})
    expect(boardPlaced(first, 'a', { x: 20, y: 30, fixed: true }).placements.a).toEqual({ x: 20, y: 30, fixed: true })
  })
  it('hit-tests overlapping groups in visual order and matches searchable metadata', () => {
    const overlapping = [...board.groups, { ...board.groups[0], id: 'front' }]
    expect(boardGroupAt(overlapping, { x: 120, y: 120 })?.id).toBe('front')
    expect(boardGroupAt(overlapping, { x: -1, y: 0 })).toBeUndefined()
    const item = { key: 'url:a', kind: 'page' as const, title: 'An artifact', caption: 'Design choice', ref: { url: 'https://example.com/docs' }, state: 'closed' as const, source: 'user' as const, addedAt: 1, updatedAt: 1 }
    expect(boardType(item)).toBe('link')
    expect(boardMatches(item, 'DESIGN')).toBe(true)
    expect(boardMatches(item, '/docs')).toBe(true)
    expect(boardMatches(item, 'unknown')).toBe(false)
  })
})
