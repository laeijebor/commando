import { describe, expect, it } from 'vitest'
import { buildTmuxLayout } from './tmux-layout.js'

describe('browser-authoritative tmux layouts', () => {
  it('builds a full, full, halves slicing tree from pane capacities', () => {
    const built = buildTmuxLayout('two-full-two-halves', [
      { paneId: '%1', cols: 84, rows: 20 },
      { paneId: '%2', cols: 82, rows: 22 },
      { paneId: '%3', cols: 40, rows: 24 },
      { paneId: '%4', cols: 40, rows: 21 },
    ], false)

    expect(built).toMatchObject({ cols: 81, rows: 65 })
    expect(built.layout).toMatch(/^[0-9a-f]{4},81x65,0,0\[/)
    expect(built.layout).toContain('81x20,0,0,1')
    expect(built.layout).toContain('81x22,0,21,2')
    expect(built.layout).toContain('{40x21,0,44,3,40x21,41,44,4}')
  })

  it('uses a vertical stack for narrow browser layouts', () => {
    const built = buildTmuxLayout('equal-grid', [
      { paneId: '%5', cols: 60, rows: 10 },
      { paneId: '%6', cols: 58, rows: 12 },
    ], true)
    expect(built).toMatchObject({ cols: 58, rows: 23 })
    expect(built.layout).toContain('58x23,0,0[')
  })

  it('stretches an incomplete final row to fill the tmux window', () => {
    const capacities = Array.from({ length: 5 }, (_, index) => ({
      paneId: `%${index + 1}`,
      cols: 40,
      rows: 20,
    }))
    const built = buildTmuxLayout('equal-grid', capacities, false)
    expect(built).toMatchObject({ cols: 81, rows: 41 })
    expect(built.layout).toContain('81x20,0,21{40x20,0,21,4,40x20,41,21,5}')
  })
})
