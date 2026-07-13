import { describe, expect, it } from 'vitest'
import type { LayoutSpec } from '../shared/protocol.js'
import { parseWindowLayout } from '../shared/window-layout.js'
import { buildScaledTmuxLayout, buildTmuxLayout } from './tmux-layout.js'

const pane = (paneId: string, cols: number, rows: number): LayoutSpec => ({
  kind: 'pane',
  paneId,
  cols,
  rows,
})
const row = (...children: LayoutSpec[]): LayoutSpec => ({
  kind: 'split',
  direction: 'row',
  children,
})
const column = (...children: LayoutSpec[]): LayoutSpec => ({
  kind: 'split',
  direction: 'column',
  children,
})

describe('browser-authoritative tmux layouts', () => {
  it('builds a slicing tree from exact pane capacities', () => {
    const built = buildTmuxLayout(
      column(
        pane('%1', 84, 20),
        pane('%2', 82, 22),
        row(pane('%3', 40, 24), pane('%4', 40, 21)),
      ),
    )

    expect(built).toMatchObject({ cols: 81, rows: 65 })
    expect(built.layout).toMatch(/^[0-9a-f]{4},81x65,0,0\[/)
    expect(built.layout).toContain('81x20,0,0,1')
    expect(built.layout).toContain('81x22,0,21,2')
    expect(built.layout).toContain('{40x21,0,44,3,40x21,41,44,4}')
  })

  it('round-trips through the shared window layout parser', () => {
    const built = buildTmuxLayout(
      row(pane('%1', 100, 50), column(pane('%2', 103, 25), pane('%3', 103, 24))),
    )
    const parsed = parseWindowLayout(built.layout)
    expect(parsed).toMatchObject({
      kind: 'split',
      direction: 'row',
      children: [
        { kind: 'pane', paneId: '%1' },
        {
          kind: 'split',
          direction: 'column',
          children: [
            { kind: 'pane', paneId: '%2' },
            { kind: 'pane', paneId: '%3' },
          ],
        },
      ],
    })
  })

  it('rejects capacities that cannot slice into a window', () => {
    expect(() =>
      buildTmuxLayout(row(pane('%1', 1, 10), pane('%2', 1, 10))),
    ).toThrow(/tmux layout/)
  })
})

describe('scaled one-shot tmux layouts', () => {
  it('scales leaf weights proportionally to the current window size', () => {
    const built = buildScaledTmuxLayout(
      row(pane('%1', 1, 1), pane('%2', 1, 1), pane('%3', 2, 1)),
      201,
      50,
    )
    expect(built).toMatchObject({ cols: 201, rows: 50 })
    const parsed = parseWindowLayout(built.layout)
    expect(parsed).toMatchObject({
      kind: 'split',
      children: [
        { cols: 50, rows: 50 },
        { cols: 50, rows: 50 },
        { cols: 99, rows: 50 },
      ],
    })
  })

  it('keeps nested splits proportional and exactly tiled', () => {
    const built = buildScaledTmuxLayout(
      column(pane('%1', 10, 30), row(pane('%2', 5, 10), pane('%3', 5, 10))),
      120,
      40,
    )
    const parsed = parseWindowLayout(built.layout)
    expect(parsed).toMatchObject({
      kind: 'split',
      direction: 'column',
      cols: 120,
      rows: 40,
      children: [
        { kind: 'pane', paneId: '%1', cols: 120, rows: 30 },
        {
          kind: 'split',
          direction: 'row',
          rows: 9,
          children: [
            { kind: 'pane', paneId: '%2' },
            { kind: 'pane', paneId: '%3' },
          ],
        },
      ],
    })
  })

  it('rejects windows smaller than the layout minimum', () => {
    const spec = column(pane('%1', 1, 1), pane('%2', 1, 1), pane('%3', 1, 1))
    expect(() => buildScaledTmuxLayout(spec, 80, 3)).toThrow(/too small/)
  })
})
