// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CanvasAnnotation } from '../shared/canvas-manifest'
import type { WebPanePendingNote, WebPanePendingSnapshot } from '../shared/protocol'
import { useCanvasReviewAdapter } from './useCanvasReviewAdapter'

const page = 'http://localhost/deck.html'
const note: CanvasAnnotation = { id: 'ask-ship', kind: 'question', key: 'ship', text: 'Ship?', x: 0, y: 0 }
const pending: WebPanePendingNote = { id: 1, selector: '#heading', tag: 'h1', rect: { x: 0, y: 0, width: 20, height: 10 }, comment: 'Update', canvas: { frameId: 'slide', point: { x: 0, y: 0 } } }
const empty: WebPanePendingSnapshot = { notes: [], knownUpTo: 0, dropped: 0 }
const comments = { snapshot: empty, questionSent: undefined as WebPanePendingSnapshot['sent'], queued: [pending] }
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
describe('canvas review adapter', () => {
  it('uses shared note selectors and current annotations, giving notes precedence over pending items', () => {
    const reveal = vi.fn()
    const { result, rerender } = renderHook(({ annotation }) => useCanvasReviewAdapter('w-one', '', page, [annotation], { ...comments, queued: [...comments.queued, { ...pending, selector: '[data-canvas-note="ask-ship"]' }] }, reveal), { initialProps: { annotation: note } })
    const surface = result.current.surface
    act(() => surface.revealSelector('[data-canvas-note="ask-ship"]'))
    expect(reveal).toHaveBeenLastCalledWith(note, undefined)
    const updated = { ...note, text: 'Ship now?' }
    rerender({ annotation: updated })
    expect(result.current.surface).toBe(surface)
    act(() => surface.revealSelector('[data-canvas-note="ask-ship"]'))
    expect(reveal).toHaveBeenLastCalledWith(updated, undefined)
    act(() => surface.revealSelector('#heading'))
    expect(reveal).toHaveBeenLastCalledWith(undefined, pending)
    act(() => surface.revealSelector('div [data-canvas-note="ask-ship"]'))
    expect(reveal).toHaveBeenLastCalledWith(undefined, undefined)
  })
  it('publishes questions and pending changes, skips the initial empty queue, and unsubscribes', () => {
    const receivePending = vi.fn(), receiveQuestions = vi.fn(), reveal = vi.fn()
    const { result, rerender } = renderHook(({ snapshot, answerable }) => useCanvasReviewAdapter('w-one', '', page, [note], { ...comments, snapshot }, reveal, answerable), { initialProps: { snapshot: empty, answerable: true } })
    let unpending!: () => void, unquestion!: () => void
    act(() => { unpending = result.current.surface.subscribePending(receivePending); unquestion = result.current.surface.subscribeQuestions(receiveQuestions) })
    expect(receivePending).not.toHaveBeenCalled()
    expect(receiveQuestions).toHaveBeenLastCalledWith(page, expect.objectContaining({ questions: [expect.objectContaining({ question: 'Ship?', selector: '[data-canvas-note="ask-ship"]' })] }))
    rerender({ snapshot: { ...empty, revision: 1, notes: [pending] }, answerable: false })
    expect(receivePending).toHaveBeenLastCalledWith(expect.objectContaining({ revision: 1, notes: [pending] }))
    expect(receiveQuestions).toHaveBeenLastCalledWith(page, expect.objectContaining({ questions: [] }))
    unpending(); unquestion(); receivePending.mockClear(); receiveQuestions.mockClear()
    rerender({ snapshot: { ...empty, revision: 2 }, answerable: true })
    expect(receivePending).not.toHaveBeenCalled(); expect(receiveQuestions).not.toHaveBeenCalled()
  })
  it('restamps mutations with the latest manifest receipts while leaving list responses untouched', async () => {
    const frameSent = { page: 'http://localhost/frame.html', answers: [] }
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ ...empty, sent: frameSent }) })))
    const { result, rerender } = renderHook(({ sent }) => useCanvasReviewAdapter('w-one', 'owner', page, [note], { ...comments, questionSent: sent }, () => {}), { initialProps: { sent: { page, answers: [] } } })
    const queue = result.current.queue!
    expect((await queue.list()).sent).toEqual(frameSent)
    rerender({ sent: { page: 'http://localhost/other-deck.html', answers: [] } })
    expect(result.current.queue).toBe(queue)
    expect((await queue.remove(1)).sent).toEqual({ page: 'http://localhost/other-deck.html', answers: [] })
  })
})
