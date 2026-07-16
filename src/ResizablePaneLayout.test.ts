// @vitest-environment jsdom

import { cleanup, render } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { parseWindowLayout } from '../shared/window-layout'
import { defaultLayoutHeight, ResizablePaneLayout } from './ResizablePaneLayout'

afterEach(cleanup)

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

describe('split weights', () => {
  it('keeps browser proportions stable across tmux geometry echoes', () => {
    const initial = parseWindowLayout(
      '0ed1,160x80,0,0{80x80,0,0,1,79x80,81,0[79x40,81,0,2,79x19,81,41,3,79x19,81,61,4]}',
    )!
    const echoed = parseWindowLayout(
      '895b,154x59,0,0{77x59,0,0,1,76x59,78,0[76x31,78,0,2,76x13,78,32,3,76x13,78,46,4]}',
    )!
    const panes = new Map([
      ['%1', createElement('div')],
      ['%2', createElement('div')],
      ['%3', createElement('div')],
      ['%4', createElement('div')],
    ])
    const view = render(createElement(ResizablePaneLayout, {
      layoutKey: 'same-shape',
      tree: initial,
      panes,
    }))
    const columnWeights = () => [...view.container.querySelectorAll(
      '[data-split-path="root.1"] > .pane-split-child',
    )].map((child) => (child as HTMLElement).style.flexGrow)

    expect(columnWeights()).toEqual(['40', '19', '19'])

    view.rerender(createElement(ResizablePaneLayout, {
      layoutKey: 'same-shape',
      tree: echoed,
      panes,
    }))
    expect(columnWeights()).toEqual(['40', '19', '19'])

    view.rerender(createElement(ResizablePaneLayout, {
      layoutKey: 'new-layout',
      tree: echoed,
      panes,
    }))
    expect(columnWeights()).toEqual(['31', '13', '13'])
  })
})
