import { describe, expect, it } from 'vitest'
import { BOARD_ID, BOARD_ITEM_KEY, boardItemKeyForCanvas, boardItemKeyForClip, boardItemKeyForFile, boardItemKeyForGuide, boardItemKeyForPage, boardItemKeyForPr, boardItemKeyForRedline, boardItemKeyForUrl, normalizeBoardUrl } from './board.js'

describe('Board identities', () => {
  it('normalizes hosts, tracking, query order, slashes and non-route fragments', () => {
    expect(normalizeBoardUrl('https://EXAMPLE.com/a/?z=2&utm_source=x&FBCLID=y&gclid=z&a=1#section')).toBe('https://example.com/a?a=1&z=2')
    expect(normalizeBoardUrl('https://example.com/')).toBe('https://example.com/')
    expect(normalizeBoardUrl('https://EXAMPLE.com/a/#/route')).toBe('https://example.com/a#/route')
  })
  it.each(['file:///tmp/a', 'javascript:alert(1)', 'https://user:pass@example.com', 'not a url'] )('rejects unsafe/invalid URL %s', (url) => expect(() => normalizeBoardUrl(url)).toThrow())
  it('builds stable content keys from canonical inputs', () => {
    expect(boardItemKeyForCanvas('/real/dir', 'deck.html')).toBe('canvas:/real/dir#deck.html')
    expect(boardItemKeyForGuide('/real/dir', 'guide.md')).toBe('guide:/real/dir#guide.md')
    expect(boardItemKeyForPr('Owner/Repo', 42)).toBe('pr:owner/repo#42')
    expect(boardItemKeyForFile('/real/file')).toBe('file:/real/file')
    expect(boardItemKeyForClip('one')).toBe('clip:one')
    for (const key of [boardItemKeyForUrl('https://A.com/x/'), boardItemKeyForPage('https://A.com/x/'), boardItemKeyForRedline('http://localhost/redline/artifacts/abc/a.html')]) expect(BOARD_ITEM_KEY.test(key)).toBe(true)
    expect(BOARD_ITEM_KEY.test('file:/tmp/a\n')).toBe(false)
    expect(BOARD_ID.test('../../escape')).toBe(false)
  })
})
