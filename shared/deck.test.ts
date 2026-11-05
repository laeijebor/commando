import { describe, expect, it } from 'vitest'
import { decodeDeckText, parseCanvasSource, parseDeck } from './deck.js'

const wrap = (slides: string, head = '') => `<title>A &amp; B</title>${head}<main class='deck'>${slides}</main>`
describe('deck parser', () => {
  it('handles comments, attribute order, both quotes, nested sections, entities, notes and non-slide sections', () => {
    const result = parseDeck(wrap(`<!-- <section class="slide" id="bad"> -->
      <section id='opening' data-title='Hello &quot;world&quot;' class='title slide'>
        <section><h2>Nested heading</h2></section><aside class='notes'>Use <em>care</em> &amp; attention &#x1f44b;.</aside>
        <aside data-multiple data-options='["A &amp; B","C"]' data-key='lead' class='ask' data-answer='C'>Choose <b>one</b> &lt; two?</aside>
      </section><section><h1>Not a slide</h1></section><section class="slide"><h2>Second &mdash; slide</h2></section>`), 'deck.html')
    expect(result.errors).toEqual([])
    expect(result.warnings).toContain('slide 2: missing id; using slide-2')
    expect(result.deck).toMatchObject({ title: 'A & B', size: '16:9', width: 1280, height: 720, theme: 'ink', slides: [
      { id: 'opening', title: 'Hello "world"', notes: 'Use care & attention 👋.' }, { id: 'slide-2', title: 'Second — slide', notes: '' },
    ] })
    expect(result.manifest.frames[1]).toEqual({ id: 'slide-2', title: 'Second — slide', src: 'deck.html', slide: 'slide-2', x: 1400, y: 0, w: 1280, h: 720, focus: 2, interactive: false })
    expect(result.manifest.annotations[0]).toMatchObject({ id: 'ask-lead', key: 'lead', text: 'Choose one < two?', options: ['A & B', 'C'], answer: 'C', multiple: true, target: { frame: 'opening' }, y: 760 })
  })
  it('supports A4, metadata title, theme, fallback title/key and ignores script/style slide text', () => {
    const parsed = parseDeck(wrap(`<section class="slide" id="s"><aside class="ask">Proceed?</aside></section>`, `<meta content="a4" name="deck:size"><meta content="Meta &gt; title" name="deck:title"><link href="themes/paper.css" id="theme"><script>"<main class='deck'><section class='slide'>"</script>`), 'nested/onepager.html')
    expect(parsed.deck).toMatchObject({ title: 'Meta > title', size: 'a4', width: 794, height: 1123, theme: 'paper', slides: [{ id: 's', title: 'Slide 1', notes: '' }] })
    expect(parsed.manifest.annotations[0].key).toBe('s-ask-1')
  })
  it.each(['not JSON', '[]', '["ok",2]', JSON.stringify(['x'.repeat(257)]), JSON.stringify(Array(51).fill('x'))])('reports invalid options %s', (value) => {
    const result = parseDeck(wrap(`<section class="slide" id="s"><aside class="ask" data-options='${value}'>Choose?</aside></section>`), 'deck.html')
    expect(result.errors.join()).toContain('data-options'); expect(result.manifest.annotations).toEqual([])
  })
  it('validates ids, duplicate keys, text bounds, missing main and fallback collisions', () => {
    const result = parseDeck(wrap(`<section class="slide" id="s"><aside class="ask" data-key="q">Q?</aside><aside class="ask" data-key="q">Again?</aside><aside class="ask" data-key="bad key">Bad?</aside><aside class="ask">${'a'.repeat(257)}</aside></section><section class="slide" id="s"></section><section class="slide" id="bad.id"></section>`), 'deck.html')
    expect(result.errors).toHaveLength(5); expect(result.manifest.frames).toHaveLength(1); expect(result.manifest.annotations).toHaveLength(1)
    expect(parseDeck('<section class="slide"></section>', 'deck.html').errors.join()).toContain('missing <main')
    expect(parseDeck(wrap('<section class="slide" id="slide-2"></section><section class="slide"></section>'), 'deck.html').errors.join()).toContain('duplicate id')
  })
  it('decodes common and numeric entities once, tolerating unknown entities', () => {
    expect(decodeDeckText('&amp;lt; &apos; &#65; &#x42; &nbsp;&bogus; &#99999999;')).toBe('&lt; \' A B  &bogus; &#99999999;')
  })
  it('routes JSON canvases unchanged and warns about unsupported size and repeated notes', () => {
    expect(parseCanvasSource('{"title":"Board","frames":[]}', 'canvas.json')).toEqual({ manifest: { title: 'Board', frames: [], sections: [], pages: [], annotations: [] }, errors: [] })
    const parsed = parseDeck(wrap('<section class="slide" id="s"><aside class="notes">one</aside><aside class="notes">two</aside></section>', '<meta name="deck:size" content="letter">'), 'deck.html')
    expect(parsed.warnings).toHaveLength(2); expect(parsed.deck.slides[0].notes).toBe('one')
  })
})
