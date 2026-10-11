import { describe, expect, it } from 'vitest'
import type { WebPane } from '../shared/protocol'
import { activePanelTab, effectiveFocusedPane, panelTabs } from './sidePanelState'
import { neighbouringTab, nextWebPaneOrder } from '../shared/web-pane-placement'

function tab(id: string, anchorPaneId = '%12', order = 0): WebPane {
  return { id, anchorPaneId, order, dock: 'panel', unseen: false, url: 'http://localhost/',
    sessionId: '$1', windowId: '@1', placement: 'right', engine: 'webkit', openedBy: 'user', status: 'open', createdAt: order }
}

describe('panel tab sets', () => {
  it('selects only panel tabs of the focused pane in order', () => {
    const tabs = [tab('second', '%12', 4), tab('other', '%13'), tab('first'), { ...tab('split'), dock: 'split' as const }]
    expect(panelTabs(tabs, '%12').map((pane) => pane.id)).toEqual(['first', 'second'])
    expect(panelTabs(tabs, '%14')).toEqual([])
    expect(activePanelTab(panelTabs(tabs, '%14'))).toBeUndefined()
    expect(activePanelTab([{ ...tab('first'), activeTab: false }, { ...tab('second'), activeTab: true }])?.id).toBe('second')
  })
  it('appends after the maximum order of its own anchor', () => {
    expect(nextWebPaneOrder([], '%12')).toBe(0)
    expect(nextWebPaneOrder([tab('a', '%12', 5), tab('b', '%13', 99)], '%12')).toBe(6)
  })
  it('falls forward, then backward when the selected tab disappears', () => {
    const tabs = [tab('a'), tab('b', '%12', 1), tab('c', '%12', 2)]
    expect(neighbouringTab(tabs, 'b')).toBe('c')
    expect(neighbouringTab(tabs, 'c')).toBe('b')
    expect(neighbouringTab([tabs[0]], 'a')).toBeUndefined()
  })
})

describe('effective pane focus', () => {
  const panes = ['%12', '%13', '%14']
  it('derives focus without consuming tmux snapshot transitions', () => {
    expect(effectiveFocusedPane).toHaveLength(3)
    expect(effectiveFocusedPane('%14', panes, '%12')).toBe('%14')
    expect(effectiveFocusedPane('%14', panes, '%13')).toBe('%14')
    expect(effectiveFocusedPane('%13', panes, '%13')).toBe('%13')
  })
  it('falls back to tmux, then the first surviving pane', () => {
    expect(effectiveFocusedPane(null, panes, '%13')).toBe('%13')
    expect(effectiveFocusedPane('%99', panes, undefined)).toBe('%12')
    expect(effectiveFocusedPane(null, [], undefined)).toBeUndefined()
  })
})
