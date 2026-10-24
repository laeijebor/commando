import type { WebPane } from '@commando/protocol'

import { canOpenOnPhone } from '../list'
import {
  canLoadNatively,
  initialTileMode,
  nativeTileSource,
  toCanonicalUrl,
  toPhoneUrl,
} from './target'

const PHONE = 'http://studio.tail-1a2b.ts.net:4310'

function tile(overrides: Partial<WebPane> = {}): WebPane {
  return {
    id: 'w-1',
    url: 'http://127.0.0.1:4310/redline/artifacts/0123456789abcdef/plan.html?v=2#q',
    sessionId: '$1',
    windowId: '@1',
    anchorPaneId: '%1',
    placement: 'right',
    engine: 'chromium',
    openedBy: 'agent',
    status: 'open',
    createdAt: 0,
    ...overrides,
  }
}

describe('nativeTileSource', () => {
  it('loads a daemon artifact from the phone’s daemon address, keeping the tile URL canonical', () => {
    expect(nativeTileSource(tile(), PHONE)).toEqual({
      kind: 'page',
      url: `${PHONE}/redline/artifacts/0123456789abcdef/plan.html?v=2#q`,
      canonicalOrigin: 'http://127.0.0.1:4310',
      phoneOrigin: PHONE,
      daemonServed: true,
    })
  })

  it('treats localhost and ::1 like 127.0.0.1', () => {
    const source = nativeTileSource(tile({ url: 'http://localhost:4310/redline/sdk.js' }), PHONE)
    expect(source).toMatchObject({ kind: 'page', url: `${PHONE}/redline/sdk.js`, canonicalOrigin: 'http://localhost:4310' })
    expect(nativeTileSource(tile({ url: 'http://[::1]:4310/redline/x.html' }), PHONE)).toMatchObject({ kind: 'page' })
  })

  it('refuses a dev server on the Mac’s localhost', () => {
    const source = nativeTileSource(tile({ url: 'http://localhost:5173/settings' }), PHONE)
    expect(source.kind).toBe('none')
  })

  it('loads a public page as it is, without calling it daemon-served', () => {
    expect(nativeTileSource(tile({ url: 'https://example.com/docs' }), PHONE)).toEqual({
      kind: 'page',
      url: 'https://example.com/docs',
      canonicalOrigin: 'https://example.com',
      phoneOrigin: 'https://example.com',
      daemonServed: false,
    })
  })

  it('recognises an artifact already addressed at the phone’s daemon', () => {
    expect(nativeTileSource(tile({ url: `${PHONE}/redline/artifacts/0123456789abcdef/a.html` }), PHONE))
      .toMatchObject({ kind: 'page', daemonServed: true })
  })

  it('maps a canvas tab to its artifact folder on both origins', () => {
    const canvas = tile({
      engine: 'webkit',
      url: 'http://127.0.0.1:4310/redline/artifacts/0123456789abcdef/',
      content: { kind: 'canvas', artifactId: '0123456789abcdef', manifest: 'board.json' },
    })
    expect(nativeTileSource(canvas, PHONE)).toEqual({
      kind: 'canvas',
      artifactId: '0123456789abcdef',
      manifest: 'board.json',
      canonicalBase: 'http://127.0.0.1:4310/redline/artifacts/0123456789abcdef/',
      phoneBase: `${PHONE}/redline/artifacts/0123456789abcdef/`,
      canonicalOrigin: 'http://127.0.0.1:4310',
      phoneOrigin: PHONE,
    })
  })

  it('leaves guides, simulators and unconfirmed pages alone', () => {
    expect(nativeTileSource(tile({ content: { kind: 'guide', artifactId: '0123456789abcdef', file: 'g.md' } }), PHONE).kind).toBe('none')
    expect(nativeTileSource(tile({ content: { kind: 'simulator', udid: 'X' } }), PHONE).kind).toBe('none')
    expect(nativeTileSource(tile({ status: 'pending', url: 'https://example.com' }), PHONE).kind).toBe('none')
    expect(nativeTileSource(tile({ url: 'file:///etc/hosts' }), PHONE).kind).toBe('none')
  })
})

describe('initialTileMode', () => {
  it('opens daemon pages and canvases natively, and streams public chromium pages', () => {
    expect(initialTileMode(tile(), nativeTileSource(tile(), PHONE))).toBe('native')
    const external = tile({ url: 'https://example.com' })
    expect(initialTileMode(external, nativeTileSource(external, PHONE))).toBe('stream')
    const webkit = tile({ url: 'https://example.com', engine: 'webkit' })
    expect(initialTileMode(webkit, nativeTileSource(webkit, PHONE))).toBe('native')
    const dev = tile({ url: 'http://localhost:5173/' })
    expect(initialTileMode(dev, nativeTileSource(dev, PHONE))).toBe('stream')
  })
})

describe('canLoadNatively / canOpenOnPhone', () => {
  it('opens webkit artifacts and canvases but not webkit dev servers or guides', () => {
    expect(canLoadNatively(tile({ engine: 'webkit' }))).toBe(true)
    expect(canOpenOnPhone(tile({ engine: 'webkit', url: 'http://localhost:5173/' }))).toBe(false)
    expect(canOpenOnPhone(tile({ engine: 'webkit', content: { kind: 'canvas', artifactId: '0123456789abcdef', manifest: 'canvas.json' } }))).toBe(true)
    expect(canOpenOnPhone(tile({ engine: 'webkit', content: { kind: 'guide', artifactId: '0123456789abcdef', file: 'g.md' } }))).toBe(false)
    // A chromium dev server still streams.
    expect(canOpenOnPhone(tile({ url: 'http://localhost:5173/' }))).toBe(true)
  })
})

describe('URL mapping', () => {
  const source = { canonicalOrigin: 'http://127.0.0.1:4310', phoneOrigin: PHONE }

  it('maps the phone’s page back to the canonical origin and forth again', () => {
    const phone = `${PHONE}/redline/artifacts/0123456789abcdef/b.html?x=1#h`
    const canonical = 'http://127.0.0.1:4310/redline/artifacts/0123456789abcdef/b.html?x=1#h'
    expect(toCanonicalUrl(source, phone)).toBe(canonical)
    expect(toPhoneUrl(source, canonical)).toBe(phone)
  })

  it('leaves other origins untouched', () => {
    expect(toCanonicalUrl(source, 'https://example.com/a')).toBe('https://example.com/a')
    expect(toPhoneUrl(source, 'https://example.com/a')).toBe('https://example.com/a')
  })
})
