import { publishCanvasChange } from './webPanesApi'
// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CanvasThread, WebPanePendingNote, WebPanePendingSnapshot } from '../shared/protocol'
import { MAX_RESPONSE_PAYLOAD_BYTES } from '../shared/redline-response'
import { CanvasPane } from './CanvasPane'
import { parseCanvasManifest } from '../shared/canvas-manifest'
import { publishCanvasSpotlights, publishCanvasPendingChanged, publishCanvasThreadsChanged, publishCanvasRefresh } from './webPanesApi'

const id = 'w-12345678', artifactId = '0123456789abcdef'
const manifest = { title: 'Board', frames: [{ id: 'settings', title: 'Settings', src: 'Settings.html', x: 100, y: 50, w: 390, h: 844, focus: 1, interactive: true },
  { id: 'accounts', title: 'Accounts', src: 'Accounts.html', x: 800, y: 50, w: 390, h: 844 }],
  sections: [{ id: 'regroup', title: 'Accounts section', frames: ['settings'], ticket: 'APP-1', status: 'ready-for-dev' }] }
const context = { frameId: 'settings', point: { x: 25, y: 35 }, label: 'Row', labelId: 'row', frameTitle: 'Settings', section: 'Accounts section', ticket: 'APP-1', status: 'ready-for-dev', focus: 1, interactive: true }
const rect = { x: 10, y: 20, w: 100, h: 40 }
let snapshot: WebPanePendingSnapshot, threads: CanvasThread[], calls: Array<{ url: string; body?: Record<string, unknown>; init?: RequestInit }>, failSend: boolean, failStatus: boolean
const queuedNote = (noteId = 1): WebPanePendingNote => ({ id: noteId, revision: 1, selector: '#row', tag: 'button', text: 'Row', rect: { x: 10, y: 20, width: 100, height: 40 }, comment: 'Fix row', canvas: context, pageUrl: `http://localhost/redline/artifacts/${artifactId}/Settings.html?canvas-frame=settings` })
const thread = (): CanvasThread => ({ id: 'ct-one', webPaneId: id, frameId: 'settings', point: context.point, label: 'Row', labelId: 'row', selector: '#row', status: 'open', createdAt: 10, messages: [{ author: 'user', text: 'Fix row\nMore detail', at: 10 }] })
beforeEach(() => {
  publishCanvasSpotlights({}); localStorage.clear()
  snapshot = { revision: 0, notes: [], knownUpTo: 0, dropped: 0 }; threads = []; calls = []; failSend = false; failStatus = false
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('matchMedia', () => ({ matches: true }))
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600)
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(270)
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(165)
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/canvas.json')) return { ok: true, text: async () => JSON.stringify(manifest), headers: new Headers({ ETag: `"${'a'.repeat(64)}"` }) }
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined
    calls.push({ url, body, init })
    if (url.endsWith('/canvas/sections')) {
      if (failStatus) return { ok: false, status: 409, json: async () => ({ error: 'Canvas changed on disk; reloaded. Try again.' }) }
      const status = (body!.statuses as Array<{ status: string }>)[0].status
      return { ok: true, json: async () => ({ ...parseCanvasManifest({ ...manifest, sections: [{ ...manifest.sections[0], status }] }), contentHash: 'b'.repeat(64) }) }
    }
    if (url.endsWith('/threads')) return { ok: true, json: async () => ({ threads }) }
    if (url.endsWith('/replies')) {
      const target = threads.find((thread) => url.includes(thread.id))!
      target.messages.push({ author: 'user', text: body!.text as string, at: 20 }); target.status = 'open'
    } else if (url.endsWith('/status')) {
      threads.find((thread) => url.includes(thread.id))!.status = body!.status as 'open' | 'resolved'
    } else if (url.endsWith('/pending/send')) {
      if (failSend) return { ok: false, status: 409, json: async () => ({ error: 'Pending queue revision is stale' }) }
      const items = body!.items as Array<{ id: number; revision: number }> | undefined
      const wanted = items ? snapshot.notes.filter((note) => items.some((item) => item.id === note.id)) : snapshot.notes
      for (const note of wanted) if (note.canvas) threads.push({ ...thread(), id: `ct-${note.id}`, messages: [{ author: 'user', text: note.comment, at: 10 }] })
      snapshot = { ...snapshot, revision: (snapshot.revision ?? 0) + 1, notes: snapshot.notes.filter((note) => !wanted.includes(note)) }
    } else if (url.endsWith('/pending') && init?.method === 'POST') {
      const added = { ...(body!.note as WebPanePendingNote), id: snapshot.knownUpTo + 1, revision: 1 }
      snapshot = { ...snapshot, notes: [...snapshot.notes, added], knownUpTo: added.id, revision: (snapshot.revision ?? 0) + 1 }
    } else if (url.endsWith('/pending/response')) {
      const response = body!.response as { question: string; answer: string; queueKey: string }
      const added = { ...queuedNote(snapshot.knownUpTo + 1), canvas: body!.canvas as WebPanePendingNote['canvas'], pageUrl: body!.pageUrl as string, response, queueKey: response.queueKey }
      snapshot = { ...snapshot, notes: [...snapshot.notes, added], knownUpTo: added.id, revision: (snapshot.revision ?? 0) + 1 }
    }
    return { ok: true, json: async () => structuredClone(snapshot) }
  }))
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
const mount = () => render(<CanvasPane webPaneId={id} token="owner" artifactId={artifactId} manifest="canvas.json" />)
function message(iframe: HTMLIFrameElement, type: string, extras: Record<string, unknown>, source: MessageEventSource | null = iframe.contentWindow) {
  act(() => window.dispatchEvent(new MessageEvent('message', { source, data: { source: 'commando-canvas-frame', frameId: iframe.title === 'Accounts' ? 'accounts' : 'settings', type, ...extras } })))
}
function clickPoint(container: HTMLElement, point = context.point) {
  const world = container.querySelector('.canvas-world') as HTMLElement
  const [, x, y, scale] = /translate\(([-.\d]+)px, ([-.\d]+)px\) scale\(([-.\d]+)\)/.exec(world.style.transform)!
  fireEvent.click(container.querySelector('.canvas-viewport')!, { clientX: Number(x) + (100 + point.x) * Number(scale), clientY: Number(y) + (50 + point.y) * Number(scale) })
}
async function draftPin(container: HTMLElement) {
  const iframe = await screen.findByTitle('Settings') as HTMLIFrameElement
  fireEvent.click(screen.getByRole('button', { name: 'Comment tool' }))
  const post = vi.spyOn(iframe.contentWindow!, 'postMessage')
  clickPoint(container)
  const request = [...post.mock.calls].reverse().find((call) => call[0].type === 'hit-test')![0]
  message(iframe, 'hit', { requestId: request.requestId, selector: '#row', tag: 'button', text: 'Row', rect, label: 'Row', labelId: 'row' })
  await screen.findByRole('dialog', { name: 'Canvas comment' })
  return { iframe, post, request }
}
describe('canvas comments', () => {
  it('hides pending/sent pins and threads and drops programmatic SDK queues while viewing history', async () => {
    const history = { id: '11111111-1111-1111-1111-111111111111', createdAt: 10, comments: 3, partial: false, manifestTitle: 'Board' }
    const originalFetch = fetch
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => url.endsWith('/snapshots') ? Promise.resolve({ ok: true, json: async () => ({ snapshots: [history] }) }) : originalFetch(url, init)))
    threads = [thread()]; snapshot = { ...snapshot, notes: [queuedNote()], knownUpTo: 1 }
    const { container } = mount()
    await screen.findByTitle('Settings')
    await waitFor(() => expect(container.querySelectorAll('.canvas-pin')).toHaveLength(2))
    fireEvent.click(screen.getByLabelText('History')); fireEvent.click(await screen.findByRole('menuitemradio', { name: /3 comments/ }))
    await screen.findByText(/Viewing snapshot from/)
    await waitFor(() => expect(screen.getByTitle('Settings').getAttribute('src')).toContain('/canvas-snapshots/'))
    expect(container.querySelector('.canvas-pin')).not.toBeInTheDocument(); expect(screen.queryByRole('tab', { name: 'Threads' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Send all' })).not.toBeInTheDocument()
    const iframe = screen.getByTitle('Settings') as HTMLIFrameElement
    const post = vi.spyOn(iframe.contentWindow!, 'postMessage')
    message(iframe, 'labels', { labels: [{ name: 'Row', id: 'row', rect }] })
    expect(post.mock.calls.find((call) => call[0].type === 'redline-pending')![0].snapshot.controls).toEqual([])
    const payload = JSON.stringify({ type: 'response', question: 'Ship?', answer: 'Yes', queueKey: 'ship', selector: '#row', tag: 'button', text: 'Row', rect: { x: 10, y: 20, width: 100, height: 40 } })
    message(iframe, 'redline-queue', { payload })
    expect(calls.filter((call) => call.url.endsWith('/pending/response'))).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: 'Back to live' }))
    await waitFor(() => expect(container.querySelectorAll('.canvas-pin')).toHaveLength(2))
  })

  it('writes a section status and queues then sends its exact feedback/context without sending other queued notes', async () => {
    snapshot = { ...snapshot, knownUpTo: 1, revision: 1, notes: [queuedNote()] }
    mount(); await screen.findByTitle('Settings')
    const chip = screen.getByRole('button', { name: 'Accounts section status' })
    fireEvent.click(chip)
    expect(screen.getAllByRole('menuitemradio')).toHaveLength(5)
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Ready for review' }))
    expect(screen.getByRole('button', { name: 'Comment tool' })).toBeDisabled()
    await waitFor(() => expect(calls.some((call) => call.url.endsWith('/pending/send'))).toBe(true))
    const write = calls.find((call) => call.url.endsWith('/canvas/sections'))!
    expect(write.init?.method).toBe('PATCH')
    expect(write.body).toEqual({ manifest: 'canvas.json', expectedHash: 'a'.repeat(64), statuses: [{ id: 'regroup', status: 'ready-for-review' }] })
    const added = calls.find((call) => call.url.endsWith('/pending') && call.init?.method === 'POST')!
    expect(added.body!.note).toMatchObject({ comment: 'Section "Accounts section" status changed from ready-for-dev to ready-for-review',
      canvas: { frameId: 'settings', section: 'Accounts section', ticket: 'APP-1', status: 'ready-for-review', point: { x: 0, y: 0 } } })
    expect(calls.find((call) => call.url.endsWith('/pending/send'))!.body).toMatchObject({ items: [{ id: 2, revision: 1 }], expectedQueueRevision: 2 })
    expect(snapshot.notes.map((n) => n.id)).toEqual([1])
    expect(chip).toHaveTextContent('Ready for review'); expect(chip).toHaveAttribute('aria-expanded', 'false')
    expect(threads.at(-1)?.messages[0].text).toContain('status changed')
  })
  it('does not queue feedback for a stale status write, and retains a note if delivery fails', async () => {
    failStatus = true
    const view = mount(); await screen.findByTitle('Settings')
    fireEvent.click(screen.getByRole('button', { name: 'Accounts section status' }))
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Shipped' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Canvas changed on disk')
    expect(calls.some((call) => call.url.endsWith('/pending') && call.init?.method === 'POST')).toBe(false)
    expect(screen.getByRole('button', { name: 'Accounts section status' })).toHaveTextContent('Ready for dev')
    view.unmount(); failStatus = false; failSend = true; calls = []
    mount(); await screen.findByTitle('Settings')
    fireEvent.click(screen.getByRole('button', { name: 'Accounts section status' }))
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Shipped' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Pending queue revision is stale')
    expect(snapshot.notes).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Accounts section status' })).toHaveTextContent('Shipped')
    expect(screen.getByText('1 queued')).toBeInTheDocument()
  })
  it('comments on an entered frame through the parent hit-test overlay', async () => {
    const { container } = mount(), frame = await screen.findByTitle('Settings')
    fireEvent.doubleClick(frame.closest('.canvas-frame')!)
    expect(frame.closest('.canvas-frame')).toHaveClass('is-live')
    await draftPin(container)
    expect(frame.closest('.canvas-frame')).not.toHaveClass('is-live')
    expect(screen.getByRole('dialog', { name: 'Canvas comment' })).toBeInTheDocument()
  })
  it('hit-tests camera-correct frame CSS coordinates, ignores background and foreign replies, renders constant-size pins and exits with Esc', async () => {
    const { container } = mount(), iframe = await screen.findByTitle('Settings') as HTMLIFrameElement
    const post = vi.spyOn(iframe.contentWindow!, 'postMessage')
    fireEvent.click(screen.getByRole('button', { name: 'Comment tool' }))
    expect(screen.getByRole('button', { name: 'Comment tool' })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(container.querySelector('.canvas-viewport')!, { clientX: -1000, clientY: -1000 })
    expect(post.mock.calls.some((call) => call[0].type === 'hit-test')).toBe(false)
    fireEvent.wheel(container.querySelector('.canvas-viewport')!, { deltaY: -15, ctrlKey: true, clientX: 10, clientY: 20 })
    clickPoint(container)
    const request = post.mock.calls.filter((call) => call[0].type === 'hit-test').at(-1)![0]
    expect(request.x).toBeCloseTo(25); expect(request.y).toBeCloseTo(35)
    message(iframe, 'hit', { requestId: request.requestId, selector: '#row', rect }, window)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    message(iframe, 'hit', { requestId: request.requestId, selector: '#row', rect, label: 'Row', labelId: 'row' })
    await screen.findByRole('dialog')
    const pin = container.querySelector('.canvas-pin') as HTMLElement
    expect(pin).toHaveClass('is-draft')
    expect(pin.style.transform).toBe('')
    const position = pin.style.left
    fireEvent.wheel(container.querySelector('.canvas-viewport')!, { deltaX: 40, deltaY: 20 })
    expect(pin.style.left).not.toBe(position)
    fireEvent.keyDown(container.querySelector('.canvas-pane')!, { key: 'Escape' })
    expect(screen.getByRole('button', { name: 'Comment tool' })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(container.querySelector('.canvas-pin.is-draft')).not.toBeInTheDocument()
  })
  it('queues the hit/manifest context and Send all sends the whole queue from the answer queue strip', async () => {
    snapshot = { ...snapshot, revision: 1, knownUpTo: 1, notes: [{ ...queuedNote(), canvas: undefined, comment: 'Unrelated tile note' }] }
    const { container } = mount()
    await draftPin(container)
    fireEvent.change(screen.getByRole('textbox', { name: 'Comment' }), { target: { value: '  Fix row  ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Queue' }))
    await screen.findByText('2 queued')
    const queued = calls.find((call) => call.url.endsWith('/pending') && call.init?.method === 'POST')!
    expect(queued.init?.headers).toMatchObject({ Authorization: 'Bearer owner' })
    expect(queued.body!.note).toMatchObject({ selector: '#row', tag: 'button', text: 'Row', rect: { x: 10, y: 20, width: 100, height: 40 }, comment: 'Fix row', canvas: { ...context, point: { x: expect.closeTo(25), y: expect.closeTo(35) } } })
    expect((queued.body!.note as { pageUrl: string }).pageUrl).toContain('/Settings.html?canvas-frame=settings')
    message(screen.getByTitle('Settings') as HTMLIFrameElement, 'labels', { labels: [{ name: 'Row', id: 'row', rect }] })
    expect(screen.getByLabelText('1 comments')).toHaveTextContent('💬 1')
    fireEvent.click(screen.getByRole('button', { name: 'Send all' }))
    // The daemon pushes pending and thread changes after a send.
    await waitFor(() => expect(snapshot.notes).toEqual([]))
    act(() => { publishCanvasPendingChanged(id); publishCanvasThreadsChanged(id) })
    await waitFor(() => expect(container.querySelector('.canvas-pin.is-sent')).toBeInTheDocument())
    expect(calls.find((call) => call.url.endsWith('/pending/send'))!.body).toEqual({})
    expect(snapshot.notes).toEqual([])
  })
  it('Send this queues a new note then targets only that note, and queued pins can send individually after reload', async () => {
    snapshot = { ...snapshot, revision: 1, knownUpTo: 1, notes: [queuedNote()] }
    const { container } = mount()
    await draftPin(container)
    fireEvent.change(screen.getByRole('textbox', { name: 'Comment' }), { target: { value: 'Second note' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send this' }))
    await waitFor(() => expect(container.querySelector('.canvas-pin.is-sent')).toBeInTheDocument())
    expect(calls.find((call) => call.url.endsWith('/pending/send'))!.body).toEqual({ items: [{ id: 2, revision: 1 }], expectedQueueRevision: 2 })
    expect(snapshot.notes.map((note) => note.id)).toEqual([1])
    cleanup(); mount()
    fireEvent.click(await screen.findByRole('button', { name: /queued comment.*Row/ }))
    expect(screen.getByRole('dialog')).toHaveTextContent('Fix row')
    fireEvent.click(screen.getByRole('button', { name: 'Send this' }))
    await waitFor(() => expect(snapshot.notes).toEqual([]))
    expect(calls.filter((call) => call.url.endsWith('/pending/send')).at(-1)!.body).toEqual({ items: [{ id: 1, revision: 1 }], expectedQueueRevision: 3 })
  })
  it('renders thread rows and label badges; selecting a thread flies to and opens the conversation', async () => {
    threads = [thread()]; snapshot = { ...snapshot, revision: 1, knownUpTo: 1, notes: [queuedNote()] }
    const { container } = mount(), iframe = await screen.findByTitle('Settings') as HTMLIFrameElement
    message(iframe, 'labels', { labels: [{ name: 'Renamed row', id: 'row', rect }] })
    await waitFor(() => expect(screen.getByLabelText('2 comments')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('tab', { name: 'Threads' }))
    const row = screen.getByRole('button', { name: 'Row open Fix row' })
    expect(row).not.toHaveTextContent('More detail')
    const previous = (container.querySelector('.canvas-world') as HTMLElement).style.transform
    fireEvent.click(row)
    expect((container.querySelector('.canvas-world') as HTMLElement).style.transform).not.toBe(previous)
    expect(screen.getByRole('dialog')).toHaveTextContent('More detail')
    expect(screen.getByRole('textbox', { name: 'Reply' })).toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: 'Comment' })).not.toBeInTheDocument()
  })
  it('shows agent messages and replied/resolved rows; replies, resolves and reopens from the popover', async () => {
    threads = [{ ...thread(), messages: [...thread().messages, { author: 'agent', text: 'Updated it', at: 12 }] }]
    const { container } = mount()
    await screen.findByTitle('Settings')
    fireEvent.click(screen.getByRole('tab', { name: 'Threads' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Row replied Fix row' }))
    expect(screen.getByText('Updated it').closest('.cmd-msg')).toHaveClass('agent')
    fireEvent.change(screen.getByRole('textbox', { name: 'Reply' }), { target: { value: 'Another detail' } })
    fireEvent.click(screen.getByRole('button', { name: 'Reply' }))
    await screen.findByText('Another detail')
    expect(screen.getByRole('textbox', { name: 'Reply' })).toHaveValue('')
    expect(calls.find((call) => call.url.endsWith('/replies'))!.body).toEqual({ text: 'Another detail', author: 'user' })
    fireEvent.click(screen.getByRole('button', { name: 'Resolve' }))
    await screen.findByRole('button', { name: 'Reopen' })
    expect(container.querySelector('.canvas-pin.is-resolved')).toHaveTextContent('✓')
    expect(screen.getByRole('button', { name: 'Row resolved Fix row' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Reopen' }))
    await screen.findByRole('button', { name: 'Resolve' })
    expect(container.querySelector('.canvas-pin.is-sent')).toBeInTheDocument()
    expect(calls.filter((call) => call.url.endsWith('/status')).map((call) => call.body)).toEqual([{ status: 'resolved' }, { status: 'open' }])
  })
  it('accepts spotlight, flies to the stable label id and highlights it; supports frame targets', async () => {
    const { container } = mount(), iframe = await screen.findByTitle('Settings') as HTMLIFrameElement
    message(iframe, 'labels', { labels: [{ name: 'Renamed row', id: 'row', rect }] })
    act(() => publishCanvasSpotlights({ [id]: { id: 'sr-12345678', requestedAt: 1, requestedBy: 'claude', label: 'Row', labelId: 'row', frame: 'settings', message: 'Updated it' } }))
    expect(screen.getByRole('alertdialog')).toHaveTextContent('claude wants to show you Row — Updated it')
    const previous = (container.querySelector('.canvas-world') as HTMLElement).style.transform
    fireEvent.click(screen.getByRole('button', { name: 'Show me' }))
    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
      expect(container.querySelector('.canvas-highlight:not(.is-hover)')).toBeInTheDocument()
      expect((container.querySelector('.canvas-world') as HTMLElement).style.transform).not.toBe(previous)
    })
    expect(screen.getByRole('button', { name: 'Renamed row' })).toHaveAttribute('aria-pressed', 'true')
    act(() => publishCanvasSpotlights({ [id]: { id: 'sr-87654321', requestedAt: 2, frame: 'accounts' } }))
    fireEvent.click(screen.getByRole('button', { name: 'Show me' }))
    await waitFor(() => expect(container.querySelector('.canvas-frame.is-spotlight iframe')).toHaveAttribute('title', 'Accounts'))
    expect(calls.filter((call) => call.url.includes('/spotlight-requests/')).map((call) => call.body)).toEqual([{ decision: 'accept' }, { decision: 'accept' }])
  })
  it('spotlight shows the frame until its label report arrives, then selects the label', async () => {
    const { container } = mount(), iframe = await screen.findByTitle('Settings') as HTMLIFrameElement
    act(() => publishCanvasSpotlights({ [id]: { id: 'sr-12345678', requestedAt: 1, frame: 'settings', label: 'Row' } }))
    fireEvent.click(screen.getByRole('button', { name: 'Show me' }))
    await waitFor(() => expect(container.querySelector('.canvas-frame.is-spotlight iframe')).toHaveAttribute('title', 'Settings'))
    message(iframe, 'labels', { labels: [{ name: 'Row', id: 'row', rect }] })
    await waitFor(() => expect(container.querySelector('.canvas-highlight')).toHaveTextContent('Row'))
    expect(container.querySelector('.canvas-frame.is-spotlight')).not.toBeInTheDocument()
  })
  it('refreshes pending/threads on daemon pushes and rejects stale sends without auto-retry', async () => {
    mount(); await screen.findByTitle('Settings')
    snapshot = { ...snapshot, notes: [queuedNote()], revision: 4, knownUpTo: 1 }
    act(() => publishCanvasPendingChanged(id))
    await screen.findByText('1 queued')
    failSend = true
    fireEvent.click(screen.getByRole('button', { name: 'Send all' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Pending queue revision is stale')
    expect(snapshot.notes).toHaveLength(1)
    threads = [thread()]
    act(() => publishCanvasThreadsChanged(id))
    fireEvent.click(screen.getByRole('tab', { name: 'Threads' }))
    await screen.findByRole('button', { name: 'Row open Fix row' })
  })
  it('validates SDK envelopes and forwards pending replacements scoped to each frame page URL', async () => {
    const { container } = mount(), iframe = await screen.findByTitle('Settings') as HTMLIFrameElement
    const accounts = screen.getByTitle('Accounts') as HTMLIFrameElement
    const post = vi.spyOn(iframe.contentWindow!, 'postMessage'), other = vi.spyOn(accounts.contentWindow!, 'postMessage')
    const payload = JSON.stringify({ question: 'Ship?', answer: 'Yes', queueKey: 'ship', rect: { x: 10, y: 20, width: 20, height: 30 } })
    for (const bad of ['{', '{}', 'x'.repeat(MAX_RESPONSE_PAYLOAD_BYTES + 1), '€'.repeat(MAX_RESPONSE_PAYLOAD_BYTES / 2), { question: 'Ship?', answer: 'Yes' }, JSON.stringify({ type: 'questions', version: 1, questions: [] })]) message(iframe, 'redline-queue', { payload: bad })
    message(iframe, 'redline-queue', { payload }, window)
    expect(calls.filter((call) => call.url.endsWith('/pending/response'))).toHaveLength(0)
    message(iframe, 'redline-queue', { payload })
    await screen.findByText('1 queued')
    const relay = calls.find((call) => call.url.endsWith('/pending/response'))!
    expect(relay.body).toMatchObject({ pageUrl: expect.stringContaining('/Settings.html?canvas-frame=settings'), response: { question: 'Ship?', answer: 'Yes' }, canvas: { frameId: 'settings', point: { x: 10, y: 20 }, frameTitle: 'Settings' } })
    await waitFor(() => expect(post.mock.calls.some((call) => call[0].type === 'redline-pending' && call[0].snapshot.controls.length === 1)).toBe(true))
    expect(other.mock.calls.filter((call) => call[0].type === 'redline-pending').at(-1)![0].snapshot.controls).toEqual([])
    expect(container.querySelector('.canvas-pin.is-queued')).toBeInTheDocument()
    // A frame load/label report receives the buffered snapshot too.
    post.mockClear()
    message(iframe, 'labels', { labels: [] })
    expect(post.mock.calls.some((call) => call[0].type === 'redline-pending' && call[0].snapshot.controls[0].queueKey === 'ship')).toBe(true)
  })
  it('preserves unsent draft text when reopened and refreshes on daemon reconnection', async () => {
    const { container } = mount()
    await draftPin(container)
    fireEvent.change(screen.getByRole('textbox', { name: 'Comment' }), { target: { value: 'Keep this draft' } })
    snapshot = { ...snapshot, notes: [queuedNote()], revision: 1, knownUpTo: 1 }
    act(() => publishCanvasRefresh())
    fireEvent.click(await screen.findByRole('button', { name: /queued comment/ }))
    expect(screen.getByRole('dialog')).toHaveTextContent('Fix row')
    fireEvent.click(screen.getByRole('button', { name: /draft comment/ }))
    expect(screen.getByRole('textbox', { name: 'Comment' })).toHaveValue('Keep this draft')
  })
  it('clamps the composer to the viewport and ignores hit replies after Escape', async () => {
    const { container } = mount(), iframe = await screen.findByTitle('Settings') as HTMLIFrameElement
    fireEvent.click(screen.getByRole('button', { name: 'Comment tool' }))
    const post = vi.spyOn(iframe.contentWindow!, 'postMessage')
    clickPoint(container)
    const request = post.mock.calls.filter((call) => call[0].type === 'hit-test').at(-1)![0]
    fireEvent.keyDown(container.querySelector('.canvas-pane')!, { key: 'Escape' })
    message(iframe, 'hit', { requestId: request.requestId, selector: '#row', rect })
    await act(async () => {})
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await draftPin(container)
    const dialog = screen.getByRole('dialog')
    fireEvent.wheel(container.querySelector('.canvas-viewport')!, { deltaX: -1000, deltaY: -1000 })
    expect(parseFloat(dialog.style.left)).toBeLessThanOrEqual(800 - 270 - 8)
    expect(parseFloat(dialog.style.top)).toBeLessThanOrEqual(600 - 165 - 8)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})

it('keeps a hit request alive through a manifest refresh with the same frame source', async () => {
  const { container } = mount(), iframe = await screen.findByTitle('Settings') as HTMLIFrameElement
  fireEvent.click(screen.getByRole('button', { name: 'Comment tool' }))
  const post = vi.spyOn(iframe.contentWindow!, 'postMessage')
  clickPoint(container)
  const request = post.mock.calls.filter((call) => call[0].type === 'hit-test').at(-1)![0]
  const fetcher = vi.mocked(fetch)
  const loads = fetcher.mock.calls.filter(([url]) => String(url).endsWith('canvas.json')).length
  act(() => publishCanvasChange({ artifactId, changed: ['canvas.json'] }))
  await waitFor(() => expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith('canvas.json')).length).toBe(loads + 1))
  await act(async () => {})
  message(iframe, 'hit', { requestId: request.requestId, selector: '#row', rect, label: 'Row' })
  expect(await screen.findByRole('dialog')).toBeInTheDocument()
})
