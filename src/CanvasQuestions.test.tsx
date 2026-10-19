// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebPanePendingNote, WebPanePendingSnapshot } from '../shared/protocol'
import { CanvasPane } from './CanvasPane'
import { publishCanvasPendingChanged } from './webPanesApi'

const id = 'w-questions', artifactId = '0123456789abcdef'
const page = new URL(`/redline/artifacts/${artifactId}/canvas.json`, location.href).href
const manifest = {
  title: 'Board', frames: [{ id: 'settings', title: 'Settings', src: 'Settings.html', x: 0, y: 0, w: 390, h: 844 }],
  annotations: [
    { id: 'q-recipe', kind: 'question', title: 'Your call', text: 'Should archived copies fail?', options: ['Fail with error', 'Allow'], x: 500, y: 0 },
    { id: 'q-name', kind: 'question', title: 'Naming', text: 'Better name?', x: 500, y: 300 },
    { id: 'q-done', kind: 'question', title: 'Mixing', text: 'Mix?', answer: 'Off', x: 500, y: 600 },
    { id: 'design', kind: 'design', text: 'Just a note', x: 900, y: 0 },
  ],
}
let snapshot: WebPanePendingSnapshot, calls: Array<{ url: string; body?: Record<string, unknown> }>
beforeEach(() => {
  localStorage.clear()
  snapshot = { revision: 1, notes: [], knownUpTo: 0, dropped: 0 }; calls = []
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600)
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/canvas.json')) return { ok: true, text: async () => JSON.stringify(manifest), headers: new Headers({ ETag: `"${'a'.repeat(64)}"` }) }
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined
    calls.push({ url, body })
    if (url.endsWith('/threads')) return { ok: true, json: async () => ({ threads: [] }) }
    if (url.endsWith('/pending/response')) {
      const response = body!.response as NonNullable<WebPanePendingNote['response']> & { queueKey: string; selector: string }
      const kept = snapshot.notes.filter((note) => note.queueKey !== response.queueKey)
      const added: WebPanePendingNote = { id: snapshot.knownUpTo + 1, revision: 1, selector: response.selector, tag: 'redline', rect: { x: 0, y: 0, width: 0, height: 0 },
        comment: response.answer, pageUrl: body!.pageUrl as string, response, queueKey: response.queueKey }
      snapshot = { ...snapshot, revision: snapshot.revision! + 1, knownUpTo: added.id, notes: [...kept, added] }
    }
    return { ok: true, json: async () => structuredClone(snapshot) }
  }))
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

const mount = async () => {
  const view = render(<CanvasPane webPaneId={id} token="owner" artifactId={artifactId} manifest="canvas.json" />)
  await screen.findByTitle('Settings')
  return view
}
const note = (container: HTMLElement, noteId: string) => container.querySelector<HTMLElement>(`[data-canvas-note="${noteId}"]`)!

describe('canvas question answers', () => {
  it('asserts the manifest as the answer page so sent answers come back', async () => {
    await mount()
    await waitFor(() => expect(calls.find((call) => call.url.endsWith('/pending/page'))?.body).toEqual({ url: page }))
  })

  it('queues a picked choice straight away with the question shape', async () => {
    const { container } = await mount()
    fireEvent.click(within(note(container, 'q-recipe')).getByRole('radio', { name: 'Allow' }))
    await within(note(container, 'q-recipe')).findByText('Queued ✓')
    const request = calls.find((call) => call.url.endsWith('/pending/response'))!
    expect(request.body).toEqual({ pageUrl: page, response: expect.objectContaining({
      question: 'Should archived copies fail?', answer: 'Allow', queueKey: 'q-recipe', selector: '[data-canvas-note="q-recipe"]',
      shape: { question: 'Should archived copies fail?', kind: 'choice', options: ['Fail with error', 'Allow'], multiple: false } }) })
    expect(request.body).not.toHaveProperty('canvas')
    expect(within(note(container, 'q-recipe')).getByRole('radio', { name: 'Allow' })).toHaveAttribute('aria-checked', 'true')
    expect(await screen.findByRole('button', { name: /Answer queue · 2/ })).toBeInTheDocument()
  })

  it('queues a text answer with an optional note only when asked', async () => {
    const { container } = await mount()
    const card = within(note(container, 'q-name'))
    fireEvent.change(card.getByRole('textbox', { name: 'Answer: Better name?' }), { target: { value: 'Meal plans' } })
    expect(calls.some((call) => call.url.endsWith('/pending/response'))).toBe(false)
    fireEvent.click(card.getByRole('button', { name: '+ Add note' }))
    fireEvent.change(card.getByRole('textbox', { name: 'Note (optional)' }), { target: { value: 'Matches the app' } })
    fireEvent.click(card.getByRole('button', { name: 'Queue answer' }))
    await card.findByText('Queued ✓')
    expect(calls.find((call) => call.url.endsWith('/pending/response'))!.body!.response).toMatchObject({ answer: 'Meal plans', note: 'Matches the app', queueKey: 'q-name' })
    fireEvent.change(card.getByRole('textbox', { name: 'Answer: Better name?' }), { target: { value: 'Meal planner' } })
    expect(card.getByText('Changed since queued')).toBeInTheDocument()
    expect(card.getByRole('button', { name: 'Update answer' })).toBeEnabled()
  })

  it('shows sent and agent-recorded answers as settled, and Change reopens the controls', async () => {
    snapshot = { ...snapshot, sent: { page, answers: [{ queueKey: 'q-done', selector: '[data-canvas-note="q-done"]', sentAt: Date.now(),
      shape: { question: 'Mix?', kind: 'text' }, response: { question: 'Mix?', answer: 'Off' } }, { queueKey: 'q-recipe', selector: '[data-canvas-note="q-recipe"]', sentAt: Date.now(),
      shape: { question: 'Should archived copies fail?', kind: 'choice', options: ['Fail with error', 'Allow'], multiple: false },
      response: { question: 'Should archived copies fail?', answer: 'Fail with error' } }] } }
    const { container } = await mount()
    const card = within(note(container, 'q-recipe'))
    expect(await card.findByText('Fail with error')).toBeInTheDocument()
    expect(card.getByText(/Sent · just now/)).toBeInTheDocument()
    fireEvent.click(card.getByRole('button', { name: 'Change' }))
    expect(card.getByRole('radio', { name: 'Fail with error' })).toHaveAttribute('aria-checked', 'true')
    expect(within(note(container, 'q-done')).getByText('Off')).toBeInTheDocument()
    expect(within(note(container, 'q-done')).queryByText(/Sent/)).not.toBeInTheDocument()
    expect(within(note(container, 'q-done')).getByRole('button', { name: 'Reopen' })).toBeInTheDocument()
    expect(within(note(container, 'design')).queryByRole('textbox')).not.toBeInTheDocument()
  })

  it('lists question notes with their state in the Questions tab', async () => {
    await mount()
    fireEvent.click(screen.getByRole('tab', { name: /Questions/ }))
    expect(screen.getByRole('button', { name: /Your call Open/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Mixing Answered/ })).toBeInTheDocument()
    snapshot = { ...snapshot, revision: 5, knownUpTo: 1, notes: [{ id: 1, revision: 1, selector: '[data-canvas-note="q-name"]', tag: 'redline', rect: { x: 0, y: 0, width: 0, height: 0 },
      comment: 'Meal plans', pageUrl: page, queueKey: 'q-name', response: { question: 'Better name?', answer: 'Meal plans' } }] }
    act(() => publishCanvasPendingChanged(id))
    expect(await screen.findByRole('button', { name: /Naming Queued/ })).toBeInTheDocument()
  })
})
