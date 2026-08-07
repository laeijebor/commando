// @vitest-environment jsdom
/// <reference lib="dom" />
import { describe, expect, it, vi } from 'vitest'
import { inspectExpression, inspectPageAt, parseTileInspectResult } from './tile-inspect.js'

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
