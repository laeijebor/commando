import { describe, expect, it } from 'vitest'
import { parseWindowLayout } from '../shared/window-layout'
import { defaultLayoutHeight } from './ResizablePaneLayout'

describe('default layout heights', () => {
  it('uses a single pane height for one row of panes', () => {
    const tree = parseWindowLayout('dbde,208x50,0,0{104x50,0,0,1,103x50,105,0,2}')!
    expect(defaultLayoutHeight(tree)).toBe(254)
  })

  it('stacks pane heights across column splits with splitter gaps', () => {
    const tree = parseWindowLayout(
      'bb62,208x50,0,0[208x25,0,0,1,208x24,0,26{104x24,0,26,2,103x24,105,26,3}]',
    )!
    expect(defaultLayoutHeight(tree)).toBe(254 + 1 + 254)
  })
})
