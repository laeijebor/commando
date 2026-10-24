import type { WebPanePendingNote } from '@commando/protocol'

import {
  encodeNativeTileCommand,
  NATIVE_TILE_MESSAGE_SOURCE,
  NATIVE_TILE_PAGE_SCRIPT,
  parseNativeTileMessage,
  pinsForPage,
} from './bridge'

const PAGE = 'http://studio:4310/redline/artifacts/0123456789abcdef/plan.html'
const message = (body: Record<string, unknown>) => JSON.stringify({ source: NATIVE_TILE_MESSAGE_SOURCE, url: PAGE, ...body })

describe('parseNativeTileMessage', () => {
  it('reads an open-question inventory through the shared parser', () => {
    const snapshot = {
      type: 'questions',
      version: 1,
      questions: [{ question: 'Which plan?', kind: 'choice', options: ['Starter', 'Pro'], selector: '#plan', queueKey: 'plan' }],
    }
    expect(parseNativeTileMessage(message({ type: 'redline', payload: JSON.stringify(snapshot) }), PAGE)).toEqual({
      type: 'questions',
      url: PAGE,
      snapshot: {
        type: 'questions',
        version: 1,
        questions: [{ question: 'Which plan?', kind: 'choice', options: ['Starter', 'Pro'], multiple: false, selector: '#plan', queueKey: 'plan' }],
      },
    })
  })

  it('reads a queued answer and drops what the shared parser drops', () => {
    const response = { question: 'Which plan?', answer: 'Pro', queueKey: 'plan', rect: { x: 'no' } }
    expect(parseNativeTileMessage(message({ type: 'redline', payload: JSON.stringify(response) }), PAGE)).toEqual({
      type: 'response',
      url: PAGE,
      response: { question: 'Which plan?', answer: 'Pro', queueKey: 'plan' },
    })
  })

  it('trusts the WebView’s URL over the one the page claims', () => {
    const parsed = parseNativeTileMessage(
      JSON.stringify({ source: NATIVE_TILE_MESSAGE_SOURCE, url: 'https://evil.example/', type: 'ready' }),
      PAGE,
    )
    expect(parsed).toEqual({ type: 'ready', url: PAGE })
  })

  it('rejects foreign, malformed and oversized messages', () => {
    expect(parseNativeTileMessage(JSON.stringify({ source: 'other', type: 'ready' }), PAGE)).toBeNull()
    expect(parseNativeTileMessage('not json', PAGE)).toBeNull()
    expect(parseNativeTileMessage(message({ type: 'redline', payload: '{"question":"","answer":"x"}' }), PAGE)).toBeNull()
    expect(parseNativeTileMessage(message({ type: 'redline', payload: 'x'.repeat(400 * 1024) }), PAGE)).toBeNull()
    expect(parseNativeTileMessage(message({ type: 'ready' }), 'file:///etc/hosts')).toBeNull()
    expect(parseNativeTileMessage(message({ type: 'pin', noteId: -1 }), PAGE)).toBeNull()
    expect(parseNativeTileMessage(message({ type: 'unknown' }), PAGE)).toBeNull()
  })

  it('validates an inspected element and bounds its text', () => {
    const parsed = parseNativeTileMessage(message({
      type: 'inspect',
      result: { ok: true, selector: '#hero > h1', tag: 'h1', rect: { x: 1, y: 2, width: 3, height: 4 }, text: 'x'.repeat(900) },
    }), PAGE)
    expect(parsed).toMatchObject({ type: 'inspect', result: { selector: '#hero > h1', tag: 'h1' } })
    expect(parsed?.type === 'inspect' && parsed.result.text?.length).toBe(512)
    expect(parseNativeTileMessage(message({ type: 'inspect', result: { ok: true, selector: '', tag: 'h1', rect: {} } }), PAGE)).toBeNull()
  })

  it('reads a pin tap', () => {
    expect(parseNativeTileMessage(message({ type: 'pin', noteId: 7 }), PAGE)).toEqual({ type: 'pin', url: PAGE, noteId: 7 })
  })
})

describe('encodeNativeTileCommand', () => {
  it('passes page-derived values as JSON, never as script', () => {
    const script = encodeNativeTileCommand({ type: 'reveal', selector: '");alert(1);("' })
    expect(script).toContain('t.reveal("\\");alert(1);(\\"")')
    expect(script.endsWith('true;')).toBe(true)
  })

  it('no-ops before the page script has installed itself', () => {
    const calls: unknown[] = []
    const window: Record<string, unknown> = {}
    // eslint-disable-next-line no-new-func
    new Function('window', encodeNativeTileCommand({ type: 'setReview', enabled: true }))(window)
    window.__commandoMobileTile = { setReview: (value: unknown) => calls.push(value) }
    // eslint-disable-next-line no-new-func
    new Function('window', encodeNativeTileCommand({ type: 'setReview', enabled: true }))(window)
    expect(calls).toEqual([true])
  })
})

describe('NATIVE_TILE_PAGE_SCRIPT', () => {
  it('is valid script that installs the binding the redline SDK calls', () => {
    // eslint-disable-next-line no-new-func
    expect(() => new Function(NATIVE_TILE_PAGE_SCRIPT)).not.toThrow()
    expect(NATIVE_TILE_PAGE_SCRIPT).toContain("'__commandoRedlineQueue'")
    expect(NATIVE_TILE_PAGE_SCRIPT).toContain("'commando:redline-pending'")
  })
})

describe('pinsForPage', () => {
  const note = (id: number, extra: Partial<WebPanePendingNote>): WebPanePendingNote => ({
    id,
    selector: '#a',
    tag: 'div',
    rect: { x: 0, y: 0, width: 1, height: 1 },
    comment: 'c',
    ...extra,
  })

  it('pins notes for this page (ignoring query and hash), skipping pseudo selectors and other pages', () => {
    const canonical = 'http://127.0.0.1:4310/redline/artifacts/0123456789abcdef/plan.html'
    const pins = pinsForPage([
      note(1, { pageUrl: `${canonical}?v=3` }),
      note(2, { pageUrl: 'http://127.0.0.1:4310/redline/artifacts/0123456789abcdef/other.html' }),
      note(3, { selector: 'redline:plan', pageUrl: canonical }),
      note(4, { selector: '#b', response: { question: 'q', answer: 'a' } }),
    ], canonical, 4)
    expect(pins).toEqual([
      { noteId: 1, selector: '#a', label: '1', kind: 'annotation' },
      { noteId: 4, selector: '#b', label: '4', kind: 'response', selected: true },
    ])
  })
})
