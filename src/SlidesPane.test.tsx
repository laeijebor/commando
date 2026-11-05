// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SlidesPane } from './SlidesPane'
import { publishCanvasChange, publishCanvasSpotlights } from './webPanesApi'
import type { WebPanePendingSnapshot } from '../shared/protocol'

const artifactId = '0123456789abcdef'
let html: string, calls: { url: string; body?: Record<string, unknown> }[], snapshot: WebPanePendingSnapshot
beforeEach(() => {
  html = `<title>Example deck</title><link id="theme" href="themes/ink.css"><main class="deck">
    <section class="slide" id="opening" data-title="Opening"><aside class="notes">Opening notes</aside></section>
    <section class="slide" id="evidence" data-title="Evidence"><aside class="notes">Evidence notes</aside><aside class="ask" data-key="ship" data-options='["Yes","No"]'>Ship it?</aside></section>
    <section class="slide" id="end" data-title="End"></section></main>`
  calls = []; snapshot = { notes: [], revision: 0, knownUpTo: 0, dropped: 0 }
  localStorage.clear(); publishCanvasSpotlights({})
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600)
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/deck.html') && !url.includes('/pending')) return { ok: true, text: async () => html, headers: new Headers() }
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined
    calls.push({ url, body })
    if (url.includes('/deck-themes')) return { ok: true, json: async () => ({ themes: ['ink', 'paper'], default: 'ink' }) }
    if (url.endsWith('/threads')) return { ok: true, json: async () => ({ threads: [] }) }
    if (url.endsWith('/snapshots')) return { ok: true, json: async () => ({ snapshots: [{ id: '11111111-1111-1111-1111-111111111111', createdAt: 10, comments: 1, manifestTitle: 'Example deck', partial: false }] }) }
    if (url.endsWith('/pending/response')) snapshot = { ...snapshot, revision: 1, knownUpTo: 1, notes: [{ id: 1, revision: 1, selector: '[data-canvas-note="ask-ship"]', tag: 'aside', rect: { x: 0, y: 0, width: 0, height: 0 }, comment: 'Yes', pageUrl: body!.pageUrl as string, response: body!.response as never }] }
    return { ok: true, json: async () => structuredClone(snapshot) }
  }))
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
const mount = () => render(<SlidesPane artifactId={artifactId} manifest="deck.html" webPaneId="w-12345678" token="owner" />)
describe('SlidesPane', () => {
  it('renders native slides, navigates with keys and filmstrip, and shows notes on request', async () => {
    const { container } = mount()
    const iframe = await screen.findByTitle('Opening')
    expect(iframe.getAttribute('data-src')).toContain('canvas-frame=opening#opening')
    expect((iframe as HTMLIFrameElement).style.width).toBe('1280px')
    expect(screen.getByLabelText('Slide counter')).toHaveTextContent('1 / 3')
    fireEvent.keyDown(screen.getByLabelText('Slides'), { key: 'ArrowRight' })
    await screen.findByTitle('Evidence'); expect(screen.getByText('Ship it?')).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('Notes')); expect(screen.getByText('Evidence notes')).toBeInTheDocument()
    fireEvent.keyDown(screen.getByLabelText('Slides'), { key: 'End' }); await screen.findByTitle('End')
    expect(screen.queryByText('Ship it?')).not.toBeInTheDocument()
    fireEvent.keyDown(screen.getByLabelText('Slides'), { key: 'Home' }); await screen.findByTitle('Opening')
    fireEvent.click(screen.getByRole('button', { name: 'Slide 2: Evidence' })); await screen.findByTitle('Evidence')
    expect(container.querySelectorAll('.slides-filmstrip iframe')).toHaveLength(3)
    expect(container.querySelector('.slides-filmstrip iframe')?.getAttribute('src')).not.toContain('canvas-frame')
    fireEvent.click(screen.getByLabelText('Grid view')); expect(screen.getByLabelText('Slide grid')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Slide 1: Opening' })); await screen.findByTitle('Opening')
    expect(screen.queryByLabelText('Slide grid')).not.toBeInTheDocument()
  })
  it('previews and remembers theme URLs on stage and thumbnails, and queues brand feedback', async () => {
    const { container, unmount } = mount(); await screen.findByTitle('Opening')
    fireEvent.click(screen.getByLabelText('Theme')); fireEvent.click(await screen.findByRole('menuitemradio', { name: 'paper' }))
    expect(screen.getByTitle('Opening').getAttribute('data-src')).toContain('theme=paper')
    expect(container.querySelector('.slides-filmstrip iframe')?.getAttribute('src')).toContain('theme=paper')
    fireEvent.click(screen.getByLabelText('Theme')); fireEvent.change(screen.getByLabelText('Brand source'), { target: { value: 'https://brand.example' } })
    fireEvent.keyDown(screen.getByLabelText('Brand source'), { key: 'End' }); expect(screen.getByTitle('Opening')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Queue request'))
    await waitFor(() => expect(calls.some((call) => (call.body?.note as { comment?: string })?.comment === 'Make a brand theme for this deck from: https://brand.example')).toBe(true))
    unmount(); mount(); expect((await screen.findByTitle('Opening')).getAttribute('data-src')).toContain('theme=paper')
  })
  it('drops a remembered theme that no longer exists and falls back to the deck default', async () => {
    const key = `commando:slides-theme:${artifactId}:deck.html`
    localStorage.setItem(key, 'retired-theme')
    html = html.replace('themes/ink.css', 'themes/paper.css')
    const { container } = mount()
    await waitFor(() => expect(screen.getByTitle('Opening').getAttribute('data-src')).toContain('theme=paper'))
    expect(container.querySelector('.slides-filmstrip iframe')?.getAttribute('src')).toContain('theme=paper')
    await waitFor(() => expect(localStorage.getItem(key)).toBeNull())
    fireEvent.click(screen.getByLabelText('Theme'))
    expect(await screen.findByRole('menuitemradio', { name: 'paper (default)' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.queryByRole('menuitemradio', { name: 'retired-theme' })).not.toBeInTheDocument()
  })
  it('queues slide questions through the canvas answer queue without navigating while typing', async () => {
    mount(); await screen.findByTitle('Opening')
    fireEvent.click(screen.getByRole('button', { name: 'Slide 2: Evidence' }))
    fireEvent.click(screen.getByRole('radio', { name: 'Yes' }))
    await waitFor(() => expect(calls.some((call) => call.url.endsWith('/pending/response'))).toBe(true))
    const call = calls.find((call) => call.url.endsWith('/pending/response'))!
    expect(call.body).toMatchObject({ pageUrl: `http://localhost:3000/redline/artifacts/${artifactId}/deck.html`, response: { question: 'Ship it?', answer: 'Yes', queueKey: 'ship', selector: '[data-canvas-note="ask-ship"]' } })
    fireEvent.click(screen.getByText('+ Add note')); const note = screen.getByLabelText('Note (optional)')
    fireEvent.keyDown(note, { key: 'ArrowRight' }); expect(screen.getByTitle('Evidence')).toBeInTheDocument()
  })
  it('requests the current slide PNG through the CLI export endpoint', async () => {
    mount(); await screen.findByTitle('Opening')
    fireEvent.click(screen.getByRole('button', { name: 'Slide 2: Evidence' }))
    const originalFetch = fetch
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
      if (!url.endsWith('/deck-export')) return originalFetch(url, init)
      calls.push({ url, body: JSON.parse(String(init?.body)) })
      // Keep the error in the menu so the request can be inspected without downloading a browser blob.
      return Promise.resolve({ ok: false, json: async () => ({ error: 'Test export unavailable' }) })
    }))
    fireEvent.click(screen.getByLabelText('Export'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'PNG · current slide' }))
    await screen.findByText('Test export unavailable')
    expect(calls.find((call) => call.url.endsWith('/deck-export'))).toMatchObject({
      url: `/api/redline/artifacts/${artifactId}/deck-export`,
      body: { deck: 'deck.html', format: 'png', theme: 'ink', slide: 'evidence' },
    })
    expect(calls.some((call) => call.url.includes('/canvas/frames/'))).toBe(false)
  })
  it('reloads assets and deck changes while preserving a surviving slide id', async () => {
    mount(); await screen.findByTitle('Opening'); fireEvent.click(screen.getByRole('button', { name: 'Slide 2: Evidence' }))
    act(() => publishCanvasChange({ artifactId, changed: ['themes/paper.css'] }))
    await waitFor(() => expect(screen.getByTitle('Evidence').getAttribute('data-src')).toContain('canvas-reload=1'))
    html = html.replace('Evidence notes', 'Updated evidence notes')
    act(() => publishCanvasChange({ artifactId, changed: ['deck.html'] }))
    await waitFor(() => expect(screen.getByTitle('Evidence').getAttribute('data-src')).toContain('canvas-reload=2'))
    fireEvent.click(screen.getByLabelText('Notes')); await screen.findByText('Updated evidence notes')
  })
  it('shows history as read-only and restores live', async () => {
    mount(); await screen.findByTitle('Opening'); fireEvent.click(screen.getByLabelText('History'))
    fireEvent.click(await screen.findByRole('menuitemradio', { name: /1 comment/ }))
    await waitFor(() => expect(screen.getByTitle('Opening').getAttribute('data-src')).toContain('/canvas-snapshots/'))
    expect(screen.getByLabelText('Comment tool')).toBeDisabled(); expect(screen.getByLabelText('Export')).toBeDisabled()
    fireEvent.click(screen.getByText('Back to live'))
    await waitFor(() => expect(screen.getByTitle('Opening').getAttribute('data-src')).toContain('/artifacts/'))
  })
  it('hit-tests native slide points and renders only the current slide pin', async () => {
    const { container } = mount(); const iframe = await screen.findByTitle('Opening') as HTMLIFrameElement
    fireEvent.click(screen.getByLabelText('Comment tool'))
    const post = vi.spyOn(iframe.contentWindow!, 'postMessage')
    // 800px stage, 112px navigation gutter => 688/1280 scale.
    fireEvent.click(container.querySelector('.slides-screen')!, { clientX: 53.75, clientY: 26.875 })
    const request = post.mock.calls.find((call) => call[0].type === 'hit-test')![0]
    expect(request).toMatchObject({ x: 100, y: 50 })
    act(() => window.dispatchEvent(new MessageEvent('message', { source: iframe.contentWindow, data: { source: 'commando-canvas-frame', frameId: 'opening', type: 'hit', requestId: request.requestId, selector: '#heading', tag: 'h1', label: 'Heading', rect: { x: 80, y: 40, w: 100, h: 40 } } })))
    await screen.findByRole('dialog', { name: 'Canvas comment' })
    expect(container.querySelector('.canvas-pin')).toHaveStyle({ left: '109.75px', top: '133.375px' })
    fireEvent.click(screen.getByRole('button', { name: 'Slide 2: Evidence' }))
    expect(container.querySelector('.canvas-pin')).not.toBeInTheDocument()
  })
  it('accepts spotlights from Grid and highlights the visible label on the requested slide', async () => {
    const { container } = mount(); await screen.findByTitle('Opening')
    fireEvent.click(screen.getByLabelText('Grid view'))
    act(() => publishCanvasSpotlights({ 'w-12345678': { id: 'sr-12345678', label: 'Chart', frame: 'evidence', requestedAt: 10 } }))
    fireEvent.click(await screen.findByText('Show me')); const iframe = await screen.findByTitle('Evidence') as HTMLIFrameElement
    act(() => window.dispatchEvent(new MessageEvent('message', { source: iframe.contentWindow, data: { source: 'commando-canvas-frame', frameId: 'evidence', type: 'labels', labels: [{ name: 'Chart', rect: { x: 0, y: 0, w: 0, h: 0 } }, { name: 'Chart', rect: { x: 100, y: 200, w: 400, h: 200 } }] } })))
    await waitFor(() => expect(container.querySelector('.canvas-highlight')).toBeInTheDocument())
    expect(container.querySelector('.canvas-highlight')).toHaveStyle({ width: '221px' })
  })
  it('presents with fullscreen and space navigation, then restores the tile on exit', async () => {
    mount(); await screen.findByTitle('Opening')
    const pane = screen.getByLabelText('Slides'), fullscreen = vi.fn(async () => {
      Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: pane })
      document.dispatchEvent(new Event('fullscreenchange'))
    })
    Object.defineProperty(pane, 'requestFullscreen', { configurable: true, value: fullscreen })
    fireEvent.click(screen.getByLabelText('Present'))
    await waitFor(() => expect(pane).toHaveClass('is-presenting'))
    fireEvent.keyDown(pane, { key: ' ' }); await screen.findByTitle('Evidence')
    act(() => { Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: null }); document.dispatchEvent(new Event('fullscreenchange')) })
    expect(pane).not.toHaveClass('is-presenting'); expect(fullscreen).toHaveBeenCalledOnce()
  })

  it('reuses one stage iframe across slides so WebKit at a non-100% zoom keeps painting it', async () => {
    mount()
    const first = await screen.findByTitle('Opening')
    fireEvent.click(screen.getByLabelText('Next slide'))
    const second = await screen.findByTitle('Evidence')
    expect(second).toBe(first)
    expect(second.getAttribute('data-src')).toContain('canvas-frame=evidence#evidence')
  })
  it('presents as a full-window overlay when the Fullscreen API is missing, and Escape exits', async () => {
    const original = HTMLElement.prototype.requestFullscreen
    // WKWebView without element fullscreen has no requestFullscreen at all.
    Object.defineProperty(HTMLElement.prototype, 'requestFullscreen', { configurable: true, value: undefined })
    try {
      mount(); await screen.findByTitle('Opening')
      fireEvent.click(screen.getByLabelText('Present'))
      const pane = screen.getByLabelText('Slides')
      expect(pane).toHaveClass('is-presenting')
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
      fireEvent.keyDown(pane, { key: 'ArrowRight' }); await screen.findByTitle('Evidence')
      fireEvent.keyDown(pane, { key: 'Escape' })
      expect(pane).not.toHaveClass('is-presenting')
    } finally {
      Object.defineProperty(HTMLElement.prototype, 'requestFullscreen', { configurable: true, value: original })
    }
  })
})
