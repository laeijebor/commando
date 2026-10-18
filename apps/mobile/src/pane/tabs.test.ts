import type { WebPane } from '@commando/protocol'
import { GIT_SUMMARY, PANE_PRS } from '../testing/fixtures'
import { paneTabs } from './tabs'
const web = (fields: Partial<WebPane> = {}): WebPane => ({ id: 'web', url: 'http://localhost:5273', sessionId: '$1', windowId: '@1', anchorPaneId: '%14', placement: 'right', engine: 'chromium', status: 'open', openedBy: 'agent', createdAt: 100, ...fields })
it('puts the body first, then worklog, changed files, ordered PRs and ordered web tabs', () => {
  const tabs = paneTabs({ paneId: '%14', chat: true, summary: GIT_SUMMARY, prs: PANE_PRS.pullRequests, webPanes: [web({ id: 'last', order: 9 }), web({ id: 'first', order: 1 })] })
  expect(tabs.slice(0, 3).map((tab) => tab.kind)).toEqual(['body', 'worklog', 'changes'])
  expect(tabs[0]?.label).toBe('Chat')
  expect(tabs.at(-2)?.id).toBe('first')
  expect(tabs.at(-1)?.id).toBe('last')
  expect(tabs.find((tab) => tab.kind === 'changes')).toMatchObject({ additions: GIT_SUMMARY.additions, deletions: GIT_SUMMARY.deletions })
})
it('uses explicit anchor membership and omits split tiles and unavailable built-ins', () => {
  const tabs = paneTabs({ paneId: '%14', chat: false, webPanes: [web({ anchorPaneId: '%15' }), web({ id: 'split', dock: 'split' })] })
  expect(tabs.map((tab) => tab.label)).toEqual(['Terminal', 'Worklog'])
})
it('classifies browser, simulator, canvas and guide tabs, preserving unseen and pending state', () => {
  const tabs = paneTabs({ paneId: '%14', chat: true, webPanes: [web(), web({ id: 'sim', content: { kind: 'simulator', udid: 'phone' } }), web({ id: 'canvas', content: { kind: 'canvas', artifactId: 'canvas', manifest: 'manifest.json' } }), web({ id: 'guide', content: { kind: 'guide', artifactId: 'guide', file: 'guide.md' }, unseen: true, status: 'pending' })] })
  expect(tabs.filter((tab) => tab.kind === 'web').map((tab) => tab.content)).toEqual(['canvas', 'guide', 'simulator', 'browser'])
  expect(tabs.find((tab) => tab.id === 'guide')).toMatchObject({ tile: { unseen: true, status: 'pending' } })
})
it('honours dismissed PR signatures and distinguishes same-number PRs from different repos', () => {
  const base = PANE_PRS.pullRequests[0]!
  const prs = [{ ...base, repo: 'owner/a', number: 7, state: 'closed' as const }, { ...base, repo: 'owner/b', number: 7, state: 'open' as const, isDraft: true }]
  const tabs = paneTabs({ paneId: '%14', chat: true, prs, webPanes: [] })
  expect(tabs.filter((tab) => tab.kind === 'pr').map((tab) => [tab.label, tab.state])).toEqual([['PR owner/b #7', 'draft'], ['PR owner/a #7', 'closed']])
  const hidden = paneTabs({ paneId: '%14', chat: true, prs, webPanes: [], dismissed: { 'pr:owner:b:7': `open|true|${base.updatedAt}` } })
  expect(hidden.filter((tab) => tab.kind === 'pr')).toHaveLength(1)
})
