// @vitest-environment jsdom
/// <reference lib="dom" />
import { describe, expect, it, vi } from 'vitest'
import {
  inspectExpression,
  inspectPageAt,
  parseTileInspectResult,
  parseTileSelectorAnchors,
  resolvePageSelectors,
  selectorResolveExpression,
} from './tile-inspect.js'

function mount(html: string): void {
  document.body.innerHTML = html
}

function atPoint(element: Element | null) {
  // jsdom has no layout, so hit-testing is mocked; we test selector building.
  // jsdom does not implement elementFromPoint at all (not even a stub), so
  // vi.spyOn has nothing to wrap unless we define it first.
  if (!('elementFromPoint' in document)) {
    ;(document as unknown as { elementFromPoint: () => Element | null }).elementFromPoint = () => null
  }
  vi.spyOn(document, 'elementFromPoint').mockReturnValue(element)
}

describe('inspectPageAt', () => {
  it('reports failure when nothing is at the point', () => {
    atPoint(null)
    expect(inspectPageAt(document, 10, 10, 'hover')).toEqual({
      ok: false,
      error: 'No element at this point',
    })
  })

  it('prefers an id anchor and stops climbing there', () => {
    mount('<div id="root"><section><button>Go</button></section></div>')
    atPoint(document.querySelector('button'))
    const result = inspectPageAt(document, 10, 10, 'hover')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.selector).toBe('#root > section > button')
  })

  it('anchors on data-testid when there is no id', () => {
    mount('<div><ul data-testid="pr-list"><li></li><li class="hit"></li></ul></div>')
    atPoint(document.querySelector('li.hit'))
    const result = inspectPageAt(document, 10, 10, 'hover')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.selector).toBe('ul[data-testid="pr-list"] > li:nth-of-type(2)')
  })

  it('falls back to an nth-of-type path from body', () => {
    mount('<article></article><article><p></p><p class="hit"></p></article>')
    atPoint(document.querySelector('p.hit'))
    const result = inspectPageAt(document, 10, 10, 'hover')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.selector).toBe('body > article:nth-of-type(2) > p:nth-of-type(2)')
  })

  it('hover omits text and snippet; click includes both, truncated', () => {
    mount(`<div id="a"><span>${'x'.repeat(4000)}</span></div>`)
    atPoint(document.querySelector('span'))
    const hover = inspectPageAt(document, 1, 1, 'hover')
    if (hover.ok) {
      expect(hover.text).toBeUndefined()
      expect(hover.snippet).toBeUndefined()
    }
    const click = inspectPageAt(document, 1, 1, 'click')
    expect(click.ok).toBe(true)
    if (click.ok) {
      expect(click.text?.length).toBe(512)
      expect(click.snippet?.length).toBe(2048)
      expect(click.tag).toBe('span')
    }
  })

  it('escapes ids that are not plain identifiers', () => {
    mount('<div id="a:b"><i>x</i></div>')
    atPoint(document.querySelector('i'))
    const result = inspectPageAt(document, 1, 1, 'hover')
    if (result.ok) expect(document.querySelector(result.selector)).toBe(document.querySelector('i'))
  })
})

describe('inspectExpression', () => {
  it('stringifies to a self-contained expression that still works', () => {
    mount('<div id="root"><button>Go</button></div>')
    atPoint(document.querySelector('button'))
    // Eval the FULL emitted expression exactly as the page would, not just
    // the bare function — this also exercises the __name shim wrapper.
    // eslint-disable-next-line no-eval
    const result = (0, eval)(inspectExpression(3, 4, 'hover')) as ReturnType<typeof inspectPageAt>
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.selector).toBe('#root > button')
    // And the expression embeds the arguments.
    expect(inspectExpression(3, 4, 'click')).toContain('(document, 3, 4, "click")')
    // Pin the __name shim itself: tsx's esbuild keepNames injects __name(...)
    // calls into the stringified probe, but vitest runs with keepNames off,
    // so nothing here would fail if the shim were deleted — without this
    // assertion the suite would stay green while the daemon breaks live.
    expect(inspectExpression(1, 1, 'hover')).toContain('var __name')
  })

  it('shims __name so the expression still evaluates when esbuild keepNames renames helpers', () => {
    // tsx (which runs the daemon) transpiles inspectPageAt with esbuild's
    // `keepNames` on, wrapping inner named functions like
    // `const escapeCss = (v) => ...` in `__name(fn, "escapeCss")` calls.
    // `__name` doesn't exist when the resulting string is evaluated
    // standalone in the page. Simulate that transformed shape directly
    // (independent of inspectPageAt's own source) to prove the shim
    // protects against it regardless of which runtime produced the string.
    mount('<div id="root"><button>Go</button></div>')
    atPoint(document.querySelector('button'))
    const transformedProbeBody = [
      'function fakeProbe(doc, x, y, grade) {',
      '  var target = doc.elementFromPoint(x, y);',
      '  var identity = __name(function (v) { return v; }, "identity");',
      '  if (!target) return { ok: false, error: "No element at this point" };',
      '  return { ok: true, selector: identity("#root > button"), tag: "button", rect: { x: 0, y: 0, width: 0, height: 0 } };',
      '}',
    ].join('\n')
    const expression = `(() => { var __name = (fn) => fn; return (${transformedProbeBody})(document, 3, 4, "hover"); })()`
    // eslint-disable-next-line no-eval
    const result = (0, eval)(expression)
    expect(result).toEqual({
      ok: true,
      selector: '#root > button',
      tag: 'button',
      rect: { x: 0, y: 0, width: 0, height: 0 },
    })
  })
})

describe('parseTileInspectResult', () => {
  it('accepts a valid success and truncates oversized page-supplied strings', () => {
    const parsed = parseTileInspectResult({
      ok: true,
      selector: 's'.repeat(5000),
      tag: 'button',
      rect: { x: 1, y: 2, width: 3, height: 4 },
      text: 't'.repeat(5000),
      snippet: 'h'.repeat(5000),
    })
    expect(parsed?.ok).toBe(true)
    if (parsed?.ok) {
      expect(parsed.selector.length).toBe(1024)
      expect(parsed.text?.length).toBe(512)
      expect(parsed.snippet?.length).toBe(2048)
    }
  })

  it('accepts a failure shape', () => {
    expect(parseTileInspectResult({ ok: false, error: 'nope' })).toEqual({ ok: false, error: 'nope' })
  })

  it('rejects malformed values', () => {
    expect(parseTileInspectResult(null)).toBeNull()
    expect(parseTileInspectResult({ ok: true })).toBeNull()
    expect(parseTileInspectResult({ ok: true, selector: 'a', tag: 'b', rect: { x: 'no' } })).toBeNull()
    expect(parseTileInspectResult({ ok: false, error: 42 })).toBeNull()
  })
})

describe('queued selector resolution', () => {
  it('resolves current non-zero rectangles and skips missing or synthetic selectors', () => {
    mount('<button id="first">First</button><button id="second">Second</button>')
    const second = document.querySelector('#second') as HTMLElement
    vi.spyOn(second, 'getBoundingClientRect').mockReturnValue({
      x: 11,
      y: 12,
      width: 80,
      height: 24,
      top: 12,
      right: 91,
      bottom: 36,
      left: 11,
      toJSON: () => ({}),
    })

    expect(resolvePageSelectors(document, [
      { noteId: 1, selector: 'redline:synthetic' },
      { noteId: 2, selector: '#missing' },
      { noteId: 3, selector: '#second' },
    ])).toEqual([{ noteId: 3, rect: { x: 11, y: 12, width: 80, height: 24 } }])
  })

  it('emits a self-contained batched expression', () => {
    mount('<div id="target">Target</div>')
    const target = document.querySelector('#target') as HTMLElement
    vi.spyOn(target, 'getBoundingClientRect').mockReturnValue({
      x: 1,
      y: 2,
      width: 3,
      height: 4,
      top: 2,
      right: 4,
      bottom: 6,
      left: 1,
      toJSON: () => ({}),
    })
    // eslint-disable-next-line no-eval
    expect((0, eval)(selectorResolveExpression([{ noteId: 7, selector: '#target' }]))).toEqual([
      { noteId: 7, rect: { x: 1, y: 2, width: 3, height: 4 } },
    ])
  })

  it('validates unique positive note ids and finite non-zero rectangles', () => {
    expect(parseTileSelectorAnchors([
      { noteId: 1, rect: { x: 1, y: 2, width: 3, height: 4 } },
    ])).toEqual([{ noteId: 1, rect: { x: 1, y: 2, width: 3, height: 4 } }])
    expect(parseTileSelectorAnchors([
      { noteId: 1, rect: { x: 1, y: 2, width: 3, height: 4 } },
      { noteId: 1, rect: { x: 5, y: 6, width: 7, height: 8 } },
    ])).toBeNull()
    expect(parseTileSelectorAnchors([
      { noteId: 2, rect: { x: 1, y: 2, width: 0, height: 4 } },
    ])).toBeNull()
  })
})
