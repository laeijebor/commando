import { describe, expect, it } from 'vitest'
import { buildPaneLayout } from './ResizablePaneLayout'

describe('resizable pane layout topology', () => {
  it('places equal-grid panes side by side with width splitters', () => {
    expect(buildPaneLayout('equal-grid', 3)).toMatchObject({
      kind: 'split',
      direction: 'row',
      children: [
        { kind: 'pane', index: 0 },
        { kind: 'pane', index: 1 },
        { kind: 'pane', index: 2 },
      ],
    })
  })

  it('stacks two full panes and a final row with height splitters', () => {
    expect(buildPaneLayout('two-full-two-halves', 4)).toMatchObject({
      kind: 'split',
      direction: 'column',
      children: [
        { kind: 'pane', index: 0 },
        { kind: 'pane', index: 1 },
        {
          kind: 'split',
          direction: 'row',
          children: [{ kind: 'pane', index: 2 }, { kind: 'pane', index: 3 }],
        },
      ],
    })
  })
})
