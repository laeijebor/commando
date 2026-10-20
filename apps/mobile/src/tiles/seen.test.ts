import type { WebPane } from '@commando/protocol'
import { tileWasViewed } from './seen'
import { tileTitle } from './list'
import { tileReturnTarget } from './returnToPane'
const web: WebPane = { id: 'web', url: 'http://localhost:5273/page', sessionId: '$1', windowId: '@1', anchorPaneId: '%14', placement: 'right', engine: 'chromium', status: 'open', openedBy: 'agent', createdAt: 100, unseen: true }
it('marks chromium seen only when its focused surface has displayed a frame', () => {
  expect(tileWasViewed(web, true)).toBe(false)
  expect(tileWasViewed(web, false, true)).toBe(false)
  expect(tileWasViewed(web, true, true)).toBe(true)
  expect(tileWasViewed({ ...web, unseen: false }, true, true)).toBe(false)
})
it('marks native and WebKit cards seen when actually selected in the foreground', () => {
  expect(tileWasViewed({ ...web, engine: 'webkit' }, true)).toBe(true)
  expect(tileWasViewed({ ...web, content: { kind: 'simulator', udid: 'phone' } }, true)).toBe(true)
  expect(tileWasViewed({ ...web, engine: 'webkit' }, false)).toBe(false)
})
it('resolves titles through title, URL host and native content kind', () => {
  expect(tileTitle({ ...web, title: ' Preview ' })).toBe('Preview')
  expect(tileTitle(web)).toBe('localhost:5273')
  expect(tileTitle({ ...web, title: ' ', url: '', content: { kind: 'simulator', udid: 'phone' } })).toBe('Simulator')
  expect(tileTitle({ ...web, url: '' })).toBe('Web')
})
it('returns a browser opened from a pane to that pane rather than the chat list', () => {
  expect(tileReturnTarget('h1', '%14')).toEqual({ pathname: '/(host)/[hostId]/pane/[paneId]', params: { hostId: 'h1', paneId: '%14' } })
  expect(tileReturnTarget('h1').pathname).toBe('/(host)/[hostId]/tiles')
})
