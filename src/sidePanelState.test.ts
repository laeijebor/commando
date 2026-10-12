import { describe, expect, it } from 'vitest'
import type { WebPane } from '../shared/protocol'
import { combinedPanelTabs, defaultPanelCollapsed, panelTabKey, primaryPanePr, resolveActivePanelTab, activePanelTab, effectiveFocusedPane, panelTabs } from './sidePanelState'
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

describe('built-in panel tabs', () => {
  const changed = { isRepo: true, target: 'main', additions: 4, deletions: 2, files: [{ path: 'a.ts', status: 'M', additions: 4, deletions: 2, binary: false }] }
  const pr = (number: number, state: 'open' | 'merged' | 'closed', updatedAt: string) => ({ number, state, updatedAt } as import('./prsApi').PanePrSummary)
  it('orders Session, conditional Changes and PR, then the ordered web tabs', () => {
    expect(combinedPanelTabs('%12', [tab('b', '%12', 2), tab('a')], changed, [pr(8, 'open', '')]).map(panelTabKey)).toEqual(['session', 'changes', 'pr', 'a', 'b'])
    expect(combinedPanelTabs('%12', [], null, []).map(panelTabKey)).toEqual(['session'])
    expect(combinedPanelTabs('%12', [], { ...changed, files: [] }, []).map(panelTabKey)).toEqual(['session'])
    expect(combinedPanelTabs('%12', [], { ...changed, target: null }, []).map(panelTabKey)).toEqual(['session'])
    expect(combinedPanelTabs('%12', [], { ...changed, isRepo: false }, []).map(panelTabKey)).toEqual(['session'])
  })
  it('chooses open before merged before closed, then most recently updated', () => {
    const prs = [pr(1, 'closed', '2026-10-11'), pr(2, 'merged', '2026-10-10'), pr(3, 'open', '2026-10-08'), pr(4, 'open', '2026-10-09')]
    expect(primaryPanePr(prs)?.number).toBe(4)
    expect(primaryPanePr(prs.slice(0, 2))?.number).toBe(2)
    expect(primaryPanePr([])).toBeUndefined()
  })
  it('falls forward, then backward across built-ins and web tabs, otherwise Session', () => {
    const previous = combinedPanelTabs('%12', [tab('a')], changed, [pr(1, 'open', '')])
    expect(panelTabKey(resolveActivePanelTab(previous, 'changes')!)).toBe('changes')
    expect(panelTabKey(resolveActivePanelTab(previous.filter((t) => panelTabKey(t) !== 'pr'), 'pr', previous)!)).toBe('a')
    expect(panelTabKey(resolveActivePanelTab(previous.slice(0, 2), 'pr', previous)!)).toBe('changes')
    expect(panelTabKey(resolveActivePanelTab(previous, undefined)!)).toBe('session')
    expect(panelTabKey(resolveActivePanelTab(previous, 'missing')!)).toBe('session')
    expect(panelTabKey(resolveActivePanelTab(previous.slice(0, 3), 'a', previous)!)).toBe('pr')
  })
  it('stays expanded after the first web tab, while remembered choices always win', () => {
    expect(defaultPanelCollapsed(false, null)).toBe(true)
    expect(defaultPanelCollapsed(true, null)).toBe(false)
    expect(defaultPanelCollapsed(false, 'false')).toBe(false)
    expect(defaultPanelCollapsed(true, 'true')).toBe(true)
    expect(defaultPanelCollapsed(false, 'garbage')).toBe(true)
    expect(defaultPanelCollapsed(false, null, true)).toBe(false)
    expect(defaultPanelCollapsed(false, 'true', true)).toBe(true)
    expect(defaultPanelCollapsed(true, 'true', true)).toBe(true)
    expect(defaultPanelCollapsed(false, 'false', false)).toBe(false)
  })
})
