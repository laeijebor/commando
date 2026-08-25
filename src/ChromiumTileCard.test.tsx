// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebPane, WebPanePendingNote, WebPanePendingSnapshot } from '../shared/protocol'
import { ChromiumTileCard, type PendingQueueApi } from './ChromiumTileCard'
import { resetNativeWindowBridge } from './nativeWindowBridge'

class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  static OPEN = 1
  static deferClose = false
  readonly url: string
  readyState = 0
  closeCount = 0
  private closePending = false
  readonly sent: unknown[] = []
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>()

  constructor(url: string) {
    this.url = url
    FakeWebSocket.instances.push(this)
  }

  addEventListener(type: string, handler: (event: unknown) => void): void {
    let handlers = this.listeners.get(type)
    if (!handlers) {
      handlers = new Set()
      this.listeners.set(type, handlers)
    }
    handlers.add(handler)
  }

  removeEventListener(type: string, handler: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(handler)
  }

  send(payload: string): void {
    this.sent.push(JSON.parse(payload))
  }

  close(): void {
    this.closeCount += 1
    if (this.readyState === 3) return
    this.readyState = 3
    if (FakeWebSocket.deferClose) {
      this.closePending = true
      return
    }
    this.dispatch('close', { code: 1005 })
  }

  flushClose(): void {
    if (!this.closePending) return
    this.closePending = false
    this.dispatch('close', { code: 1005 })
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN
    this.dispatch('open', {})
  }

  message(payload: unknown): void {
    this.dispatch('message', { data: JSON.stringify(payload) })
  }

  private dispatch(type: string, event: unknown): void {
    for (const handler of this.listeners.get(type) ?? []) handler(event)
  }
}

class FakeImage {
  static instances: FakeImage[] = []
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  width = 32
  height = 24
  src = ''

  constructor() {
    FakeImage.instances.push(this)
  }

  load(): void {
    this.onload?.()
  }

  fail(): void {
    this.onerror?.()
  }
}

const webPane: WebPane = {
  id: 'w-abcd1234',
  url: 'http://127.0.0.1:41300/plan',
  sessionId: '$3',
  windowId: '@2',
  anchorPaneId: '%12',
  placement: 'right',
  engine: 'chromium',
  openedBy: 'agent',
  openerLabel: 'claude · gizmo',
  status: 'open',
  createdAt: Date.now(),
}

const EMPTY_SNAPSHOT: WebPanePendingSnapshot = { notes: [], knownUpTo: 0, dropped: 0 }

function responseNote(
  id: number,
  answer = 'Pro',
  revision = 1,
  question = 'Which plan?',
): WebPanePendingNote {
  return {
    id,
    revision,
    selector: `redline:plan-${id}`,
    tag: 'redline-choice',
    rect: { x: 0, y: 0, width: 10, height: 10 },
    comment: `${question}: ${answer}`,
    response: {
      question,
      answer,
      data: { choice: answer, options: ['Starter', 'Pro', 'Team'], multiple: false },
    },
    attachments: [],
  }
}

function annotationNote(id: number, comment: string, revision = 1): WebPanePendingNote {
  return {
    id,
    revision,
    selector: `#target-${id}`,
    tag: 'button',
    rect: { x: 0, y: 0, width: 10, height: 10 },
    comment,
    attachments: [],
  }
}

function pendingSnapshot(notes: WebPanePendingNote[], revision = 1): WebPanePendingSnapshot {
  return { revision, notes, knownUpTo: Math.max(0, ...notes.map((note) => note.id)), dropped: 0 }
}

function tileElement(
  pendingQueue: Partial<PendingQueueApi> = {},
  keepStreamingWhenHidden = false,
  connected = true,
  reviewMode = false,
) {
  return (
    <ChromiumTileCard
      webPane={webPane}
      wsToken="t"
      reloadKey={0}
      reviewMode={reviewMode}
      pendingQueue={{
        list: async () => EMPTY_SNAPSHOT,
        add: async () => EMPTY_SNAPSHOT,
        update: async () => EMPTY_SNAPSHOT,
        upload: async () => EMPTY_SNAPSHOT,
        removeAttachment: async () => EMPTY_SNAPSHOT,
        attachmentUrl: (attachmentId) => `/attachments/${attachmentId}`,
        remove: async () => EMPTY_SNAPSHOT,
        send: async () => EMPTY_SNAPSHOT,
        dismissDropped: async () => EMPTY_SNAPSHOT,
        ...pendingQueue,
      }}
      connected={connected}
      keepStreamingWhenHidden={keepStreamingWhenHidden}
    />
  )
}

function renderTile(
  pendingQueue: Partial<PendingQueueApi> = {},
  keepStreamingWhenHidden = false,
  connected = true,
  reviewMode = false,
) {
  return render(tileElement(pendingQueue, keepStreamingWhenHidden, connected, reviewMode))
}

describe('ChromiumTileCard pending hydration', () => {
  beforeEach(() => {
    FakeWebSocket.instances = []
    FakeWebSocket.deferClose = false
    vi.stubGlobal('WebSocket', FakeWebSocket)
    window.localStorage.clear()
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    window.localStorage.clear()
  })

  const mirrored = [{
    id: 7,
    selector: '#root > button',
    tag: 'button',
    rect: { x: 0, y: 0, width: 1, height: 1 },
    comment: 'from the mirror',
  }]

  it('does not restore mirrored notes the daemon has already accounted for', async () => {
    window.localStorage.setItem(`commando.redline.pending.${webPane.id}`, JSON.stringify(mirrored))
    const add = vi.fn(async () => EMPTY_SNAPSHOT)
    // knownUpTo 7 means id 7 was issued and has since been sent or removed.
    renderTile({ list: async () => ({ notes: [], knownUpTo: 7, dropped: 0 }), add })
    await act(async () => { await Promise.resolve() })
    expect(add).not.toHaveBeenCalled()
  })

  it('restores mirrored notes the daemon has no record of ever issuing', async () => {
    window.localStorage.setItem(`commando.redline.pending.${webPane.id}`, JSON.stringify(mirrored))
    const add: PendingQueueApi['add'] = vi.fn(async () => ({ notes: mirrored, knownUpTo: 1, dropped: 0 }))
    // A watermark below the mirrored id means the journal was lost.
    renderTile({ list: async () => ({ notes: [], knownUpTo: 0, dropped: 0 }), add })
    await act(async () => { await Promise.resolve() })
    expect(add).toHaveBeenCalledTimes(1)
    expect(add).toHaveBeenCalledWith(expect.objectContaining({ comment: 'from the mirror' }))
    expect(await screen.findByText('from the mirror')).toBeInTheDocument()
  })

  it('shows a capped-answer warning pushed by the daemon', async () => {
    renderTile()
    const socket = FakeWebSocket.instances[0]
    await act(async () => {
      socket.open()
      socket.message({ type: 'pending', notes: [], knownUpTo: 51, dropped: 2 })
    })
    expect(screen.getByRole('alert')).toHaveTextContent(/2 older answers dropped/i)
  })
})

describe('ChromiumTileCard pending queue drawer', () => {
  beforeEach(() => {
    FakeWebSocket.instances = []
    vi.stubGlobal('WebSocket', FakeWebSocket)
    window.localStorage.clear()
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    window.localStorage.clear()
  })

  it('opens and collapses the tile-contained review drawer', async () => {
    renderTile({ list: async () => pendingSnapshot([responseNote(1)]) })

    fireEvent.click(await screen.findByRole('button', { name: 'Review queue · 1' }))
    expect(screen.getByRole('dialog', { name: 'Pending review queue' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Collapse review queue' }))
    expect(screen.queryByRole('dialog', { name: 'Pending review queue' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Review queue · 1' })).toBeInTheDocument()
  })

  it('renders a response editor and saves answer and note changes at the base revision', async () => {
    const initial = responseNote(1)
    const updated = {
      ...initial,
      revision: 2,
      comment: 'Which plan?: Team\n\nNote: Need SSO',
      response: { ...initial.response!, answer: 'Team', note: 'Need SSO', data: { choice: 'Team', options: ['Starter', 'Pro', 'Team'], multiple: false } },
    }
    const update = vi.fn(async () => pendingSnapshot([updated], 2))
    renderTile({ list: async () => pendingSnapshot([initial]), update })

    fireEvent.click(await screen.findByRole('button', { name: 'Review queue · 1' }))
    expect(screen.getByRole('heading', { name: 'Which plan?' })).toBeInTheDocument()
    fireEvent.change(screen.getByRole('combobox', { name: 'Answer' }), { target: { value: 'Team' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Optional note' }), { target: { value: 'Need SSO' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    await waitFor(() => expect(update).toHaveBeenCalledWith(1, 1, { answer: 'Team', note: 'Need SSO' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled())
  })

  it('preserves a dirty draft and requires reload when a newer snapshot changes the item', async () => {
    renderTile({ list: async () => pendingSnapshot([responseNote(1)]) })
    fireEvent.click(await screen.findByRole('button', { name: 'Review queue · 1' }))
    fireEvent.change(screen.getByRole('combobox', { name: 'Answer' }), { target: { value: 'Team' } })

    act(() => {
      FakeWebSocket.instances[0].message({
        type: 'pending',
        ...pendingSnapshot([responseNote(1, 'Starter', 2)], 2),
      })
    })

    expect(screen.getByRole('alert')).toHaveTextContent(/changed after you started editing/i)
    expect(screen.getByRole('combobox', { name: 'Answer' })).toHaveValue('Team')
    expect(screen.getByRole('button', { name: 'Send this' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Reload draft' }))
    expect(screen.getByRole('combobox', { name: 'Answer' })).toHaveValue('Starter')
  })

  it('saves a dirty item before selectively sending only that item', async () => {
    const first = responseNote(1)
    const second = annotationNote(2, 'Keep me queued')
    const savedFirst = {
      ...first,
      revision: 2,
      response: { ...first.response!, answer: 'Team', data: { choice: 'Team', options: ['Starter', 'Pro', 'Team'], multiple: false } },
    }
    const update = vi.fn(async () => pendingSnapshot([savedFirst, second], 2))
    const send = vi.fn(async () => pendingSnapshot([second], 3))
    renderTile({ list: async () => pendingSnapshot([first, second]), update, send })

    fireEvent.click(await screen.findByRole('button', { name: 'Review queue · 2' }))
    fireEvent.change(screen.getByRole('combobox', { name: 'Answer' }), { target: { value: 'Team' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send this' }))

    await waitFor(() => expect(send).toHaveBeenCalledWith([{ id: 1, revision: 2 }]))
    expect(update.mock.invocationCallOrder[0]).toBeLessThan(send.mock.invocationCallOrder[0])
    expect(screen.getByRole('textbox', { name: 'Comment' })).toHaveValue('Keep me queued')
  })

  it('saves every dirty visible item before sending the captured ids', async () => {
    let notes = [responseNote(1), annotationNote(2, 'Original annotation')]
    let revision = 1
    const update = vi.fn(async (id: number, _expected: number, change: { answer?: string; note?: string }) => {
      notes = notes.map((note) => id === note.id
        ? note.response
          ? { ...note, revision: (note.revision ?? 1) + 1, response: { ...note.response, answer: change.answer ?? note.response.answer } }
          : { ...note, revision: (note.revision ?? 1) + 1, comment: change.answer ?? note.comment }
        : note)
      revision += 1
      return pendingSnapshot(notes, revision)
    })
    const send = vi.fn(async () => pendingSnapshot([], ++revision))
    renderTile({ list: async () => pendingSnapshot(notes), update, send })

    fireEvent.click(await screen.findByRole('button', { name: 'Review queue · 2' }))
    fireEvent.change(screen.getByRole('combobox', { name: 'Answer' }), { target: { value: 'Team' } })
    fireEvent.click(screen.getByRole('button', { name: /Original annotation/ }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Comment' }), { target: { value: 'Updated annotation' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send all' }))

    await waitFor(() => expect(send).toHaveBeenCalledWith([
      { id: 1, revision: 2 },
      { id: 2, revision: 2 },
    ]))
    expect(update).toHaveBeenCalledTimes(2)
    expect(update.mock.invocationCallOrder[1]).toBeLessThan(send.mock.invocationCallOrder[0])
  })

  it('sends nothing when another captured item changes during the save-all pass', async () => {
    const first = responseNote(1)
    const second = annotationNote(2, 'Original annotation')
    const update = vi.fn(async () => pendingSnapshot([
      { ...first, revision: 2, response: { ...first.response!, answer: 'Team' } },
      { ...second, revision: 2, comment: 'Changed elsewhere' },
    ], 2))
    const send = vi.fn(async () => pendingSnapshot([], 3))
    renderTile({ list: async () => pendingSnapshot([first, second]), update, send })

    fireEvent.click(await screen.findByRole('button', { name: 'Review queue · 2' }))
    fireEvent.change(screen.getByRole('combobox', { name: 'Answer' }), { target: { value: 'Team' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send all' }))

    await waitFor(() => expect(update).toHaveBeenCalled())
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/nothing was sent/i))
    expect(send).not.toHaveBeenCalled()
  })

  it('disables drawer and collapsed send-all controls during an unresolved upload', async () => {
    let resolveUpload: ((snapshot: WebPanePendingSnapshot) => void) | undefined
    const upload = vi.fn(() => new Promise<WebPanePendingSnapshot>((resolve) => {
      resolveUpload = resolve
    }))
    renderTile({ list: async () => pendingSnapshot([responseNote(1)]), upload })

    fireEvent.click(await screen.findByRole('button', { name: 'Review queue · 1' }))
    fireEvent.change(screen.getByLabelText('Add image attachment'), {
      target: { files: [new File(['png'], 'screen.png', { type: 'image/png' })] },
    })
    await waitFor(() => expect(upload).toHaveBeenCalled())
    expect(screen.getByRole('button', { name: 'Send all' })).toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: 'Collapse review queue' }))
    expect(screen.getByRole('button', { name: 'Send all' })).toBeDisabled()

    await act(async () => resolveUpload?.(pendingSnapshot([responseNote(1)], 2)))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send all' })).toBeEnabled())
  })

  it('disables send all while a save is unresolved', async () => {
    let resolveUpdate: ((snapshot: WebPanePendingSnapshot) => void) | undefined
    const update = vi.fn(() => new Promise<WebPanePendingSnapshot>((resolve) => {
      resolveUpdate = resolve
    }))
    const initial = responseNote(1)
    renderTile({ list: async () => pendingSnapshot([initial]), update })

    fireEvent.click(await screen.findByRole('button', { name: 'Review queue · 1' }))
    fireEvent.change(screen.getByRole('combobox', { name: 'Answer' }), { target: { value: 'Team' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    await waitFor(() => expect(update).toHaveBeenCalled())
    expect(screen.getByRole('button', { name: 'Send all' })).toBeDisabled()

    const saved = { ...initial, revision: 2, response: { ...initial.response!, answer: 'Team' } }
    await act(async () => resolveUpdate?.(pendingSnapshot([saved], 2)))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send all' })).toBeEnabled())
  })

  it('uploads, previews, and removes an attachment using the latest item revision', async () => {
    const initial = responseNote(1)
    const attachment = { id: 'image-1', name: 'screen.png', contentType: 'image/png', size: 12 }
    const attached = { ...initial, revision: 2, attachments: [attachment] }
    const upload = vi.fn(async () => pendingSnapshot([attached], 2))
    const removeAttachment = vi.fn(async () => pendingSnapshot([{ ...attached, revision: 3, attachments: [] }], 3))
    renderTile({
      list: async () => pendingSnapshot([initial]),
      upload,
      removeAttachment,
      attachmentUrl: (id) => `/private/${id}`,
    })

    fireEvent.click(await screen.findByRole('button', { name: 'Review queue · 1' }))
    const file = new File(['png'], 'screen.png', { type: 'image/png' })
    fireEvent.change(screen.getByLabelText('Add image attachment'), { target: { files: [file] } })
    await waitFor(() => expect(upload).toHaveBeenCalledWith(1, 1, file))

    fireEvent.click(await screen.findByRole('button', { name: 'Preview screen.png' }))
    const preview = screen.getByRole('dialog', { name: 'Preview screen.png' })
    expect(within(preview).getByRole('img', { name: 'screen.png' })).toHaveAttribute('src', '/private/image-1')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Preview screen.png' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Remove screen.png' }))
    await waitFor(() => expect(removeAttachment).toHaveBeenCalledWith(1, 2, 'image-1'))
    await waitFor(() => expect(screen.getByText('No images attached')).toBeInTheDocument())
  })

  it('selects the next valid item after removing the current selection', async () => {
    const first = annotationNote(1, 'First comment')
    const second = annotationNote(2, 'Second comment')
    const remove = vi.fn(async () => pendingSnapshot([second], 2))
    renderTile({ list: async () => pendingSnapshot([first, second]), remove })

    fireEvent.click(await screen.findByRole('button', { name: 'Review queue · 2' }))
    expect(screen.getByRole('heading', { name: '#target-1' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Remove from queue' }))

    await waitFor(() => expect(screen.getByRole('heading', { name: '#target-2' })).toBeInTheDocument())
  })

  it('collapses an emptied drawer and keeps a later queue collapsed', async () => {
    const remove = vi.fn(async () => pendingSnapshot([], 2))
    renderTile({ list: async () => pendingSnapshot([responseNote(1)]), remove })

    fireEvent.click(await screen.findByRole('button', { name: 'Review queue · 1' }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove from queue' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Pending review queue' })).not.toBeInTheDocument())

    act(() => {
      FakeWebSocket.instances[0].message({
        type: 'pending',
        ...pendingSnapshot([responseNote(2)], 3),
      })
    })

    expect(screen.getByRole('button', { name: 'Review queue · 1' })).toBeInTheDocument()
    expect(screen.queryByRole('dialog', { name: 'Pending review queue' })).not.toBeInTheDocument()
  })

  it('uses semantic list/detail regions that container queries can stack for narrow tiles', async () => {
    renderTile({ list: async () => pendingSnapshot([responseNote(1)]) })
    fireEvent.click(await screen.findByRole('button', { name: 'Review queue · 1' }))

    const drawer = screen.getByTestId('pending-queue-drawer')
    expect(drawer.querySelector('.tile-review-drawer-body')).toBeInTheDocument()
    expect(within(drawer).getByRole('navigation', { name: 'Queued review items' })).toHaveClass('tile-review-drawer-list')
    expect(drawer.querySelector('.tile-review-drawer-detail')).toBeInTheDocument()
    expect(document.querySelector('.chromium-tile')).toBeInTheDocument()
  })
})

describe('ChromiumTileCard queued selector highlights', () => {
  beforeEach(() => {
    FakeWebSocket.instances = []
    FakeImage.instances = []
    vi.stubGlobal('WebSocket', FakeWebSocket)
    vi.stubGlobal('Image', FakeImage)
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage: vi.fn(),
    } as unknown as CanvasRenderingContext2D)
    window.localStorage.clear()
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    window.localStorage.clear()
  })

  async function startReviewStream(): Promise<FakeWebSocket> {
    const socket = FakeWebSocket.instances[0]
    await act(async () => {
      socket.open()
      socket.message({ type: 'ready' })
      socket.message({ type: 'frame', data: 'QUJD' })
      FakeImage.instances.at(-1)?.load()
    })
    await waitFor(() => expect(screen.queryByText('Starting chromium stream…')).not.toBeInTheDocument())
    return socket
  }

  it('adapts canvas inspect results without intercepting its wheel relay', async () => {
    renderTile({}, false, true, true)
    const socket = await startReviewStream()
    const canvas = screen.getByLabelText(`Chromium tile: ${webPane.url}`)

    fireEvent.pointerDown(canvas, { button: 0, clientX: 15, clientY: 18 })
    const inspect = socket.sent.find((message) => (
      message as { type?: string }
    ).type === 'inspect') as { id: string }
    expect(inspect.id).toMatch(/^c-/)

    act(() => socket.message({
      type: 'inspect_result',
      id: inspect.id,
      ok: true,
      selector: '#review-me',
      tag: 'button',
      rect: { x: 10, y: 12, width: 80, height: 24 },
    }))
    expect(screen.getByRole('textbox', { name: 'Note about #review-me' })).toBeInTheDocument()

    canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: 24, cancelable: true, bubbles: true }))
    expect(socket.sent).toContainEqual(expect.objectContaining({
      type: 'input',
      event: expect.objectContaining({ kind: 'wheel', deltaY: 24 }),
    }))
  })

  it('tracks the current selector rectangle and edits the queued response in a popover', async () => {
    const initial = {
      ...responseNote(1),
      selector: '#plan',
      rect: { x: 3, y: 4, width: 30, height: 20 },
    }
    const updated = {
      ...initial,
      revision: 2,
      response: {
        ...initial.response!,
        answer: 'Team',
        data: { choice: 'Team', options: ['Starter', 'Pro', 'Team'], multiple: false },
      },
    }
    const update = vi.fn(async () => pendingSnapshot([updated], 2))
    renderTile({ list: async () => pendingSnapshot([initial]), update }, false, true, true)
    await screen.findByRole('button', { name: 'Review queue · 1' })
    const socket = await startReviewStream()

    await waitFor(() => expect(socket.sent).toContainEqual(expect.objectContaining({
      type: 'resolve_selectors',
      items: [{ noteId: 1, selector: '#plan' }],
    })))
    const request = socket.sent.find((message) => (
      message as { type?: string }
    ).type === 'resolve_selectors') as { id: string }
    act(() => socket.message({
      type: 'resolve_selectors_result',
      id: request.id,
      ok: true,
      anchors: [{ noteId: 1, rect: { x: 44, y: 55, width: 120, height: 40 } }],
    }))

    const highlight = screen.getByRole('button', { name: 'Edit queued response: Which plan?' })
    expect(highlight).toHaveStyle({ left: '44px', top: '55px', width: '120px', height: '40px' })
    fireEvent.click(highlight)

    const popover = screen.getByRole('dialog', { name: 'Edit queued response' })
    fireEvent.change(within(popover).getByRole('combobox', { name: 'Answer' }), { target: { value: 'Team' } })
    fireEvent.click(within(popover).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(update).toHaveBeenCalledWith(1, 1, { answer: 'Team', note: '' }))
  })

  it('sends an annotation from its highlighted-element popover and removes the overlay', async () => {
    const note = {
      ...annotationNote(2, 'Tighten this copy'),
      rect: { x: 8, y: 9, width: 90, height: 24 },
    }
    const send = vi.fn(async () => pendingSnapshot([], 2))
    renderTile({ list: async () => pendingSnapshot([note]), send }, false, true, true)
    await screen.findByRole('button', { name: 'Review queue · 1' })
    await startReviewStream()

    fireEvent.click(screen.getByRole('button', { name: 'Edit queued annotation: #target-2' }))
    const popover = screen.getByRole('dialog', { name: 'Edit queued annotation' })
    fireEvent.click(within(popover).getByRole('button', { name: 'Send this' }))

    await waitFor(() => expect(send).toHaveBeenCalledWith([{ id: 2, revision: 1 }]))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Edit queued annotation' })).not.toBeInTheDocument())
    expect(screen.queryByRole('button', { name: 'Edit queued annotation: #target-2' })).not.toBeInTheDocument()
  })

  it('does not highlight synthetic fallback selectors', async () => {
    renderTile({ list: async () => pendingSnapshot([responseNote(1)]) }, false, true, true)
    await screen.findByRole('button', { name: 'Review queue · 1' })
    const socket = await startReviewStream()
    expect(screen.queryByRole('button', { name: /Edit queued response/ })).not.toBeInTheDocument()
    expect(socket.sent.some((message) => (
      message as { type?: string }
    ).type === 'resolve_selectors')).toBe(false)
  })

  it('removes a capture-rectangle fallback when the selector no longer resolves', async () => {
    const note = annotationNote(3, 'Old target')
    renderTile({ list: async () => pendingSnapshot([note]) }, false, true, true)
    await screen.findByRole('button', { name: 'Review queue · 1' })
    const socket = await startReviewStream()
    const highlight = screen.getByRole('button', { name: 'Edit queued annotation: #target-3' })
    expect(highlight).toBeInTheDocument()
    const request = await waitFor(() => {
      const match = socket.sent.find((message) => (
        message as { type?: string }
      ).type === 'resolve_selectors') as { id: string } | undefined
      expect(match).toBeDefined()
      return match as { id: string }
    })

    act(() => socket.message({
      type: 'resolve_selectors_result',
      id: request.id,
      ok: true,
      anchors: [],
    }))
    expect(screen.queryByRole('button', { name: 'Edit queued annotation: #target-3' })).not.toBeInTheDocument()
  })
})

describe('ChromiumTileCard first-frame watchdog', () => {
  beforeEach(() => {
    FakeWebSocket.instances = []
    FakeImage.instances = []
    vi.stubGlobal('WebSocket', FakeWebSocket)
    vi.stubGlobal('Image', FakeImage)
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage: vi.fn(),
    } as unknown as CanvasRenderingContext2D)
    vi.useFakeTimers()
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('turns a frameless stream into a retryable error instead of spinning forever', () => {
    renderTile()
    const socket = FakeWebSocket.instances[0]
    act(() => {
      socket.open()
      socket.message({ type: 'ready' })
    })
    expect(screen.getByText('Starting chromium stream…')).toBeInTheDocument()

    act(() => {
      vi.advanceTimersByTime(12_000)
    })
    expect(screen.getByText(/no frames/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
  })

  it('does not count slow target setup against the first-frame deadline', () => {
    renderTile()
    const socket = FakeWebSocket.instances[0]
    act(() => {
      socket.open()
      vi.advanceTimersByTime(30_000)
    })
    expect(screen.getByText('Starting chromium stream…')).toBeInTheDocument()

    act(() => {
      socket.message({ type: 'ready' })
      vi.advanceTimersByTime(12_000)
    })
    expect(screen.getByText(/no frames/i)).toBeInTheDocument()
  })

  it('disarms the watchdog only after a frame decodes and is drawn', () => {
    renderTile()
    const socket = FakeWebSocket.instances[0]
    act(() => {
      socket.open()
      socket.message({ type: 'ready' })
      socket.message({ type: 'frame', data: 'QUJD' })
      FakeImage.instances[0]?.load()
    })
    act(() => {
      vi.advanceTimersByTime(30_000)
    })
    expect(screen.queryByText(/no frames/i)).not.toBeInTheDocument()
    expect(screen.queryByText('Starting chromium stream…')).not.toBeInTheDocument()
  })

  it('turns an undecodable frame into a retryable error', () => {
    renderTile()
    const socket = FakeWebSocket.instances[0]
    act(() => {
      socket.open()
      socket.message({ type: 'frame', data: 'not-a-png' })
      FakeImage.instances[0]?.fail()
    })

    expect(screen.getByText(/invalid stream frame/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
  })

  it('recreates the tile socket when the daemon reconnects', () => {
    const view = renderTile({}, false, false)
    expect(FakeWebSocket.instances).toHaveLength(0)

    view.rerender(tileElement({}, false, true))
    const firstSocket = FakeWebSocket.instances[0]
    act(() => firstSocket.open())

    view.rerender(tileElement({}, false, false))
    expect(firstSocket.closeCount).toBe(1)

    view.rerender(tileElement({}, false, true))
    expect(FakeWebSocket.instances).toHaveLength(2)
  })
})

describe('ChromiumTileCard detached visibility', () => {
  beforeEach(() => {
    FakeWebSocket.instances = []
    vi.stubGlobal('WebSocket', FakeWebSocket)
    Object.defineProperty(document, 'hidden', { configurable: true, value: false })
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    Object.defineProperty(document, 'hidden', { configurable: true, value: false })
  })

  it('keeps a detached AppKit stream open when its document becomes hidden', () => {
    renderTile({}, true)
    const socket = FakeWebSocket.instances[0]
    act(() => socket.open())

    Object.defineProperty(document, 'hidden', { configurable: true, value: true })
    act(() => document.dispatchEvent(new Event('visibilitychange')))

    expect(socket.closeCount).toBe(0)
  })

  it('still closes an ordinary workspace stream when hidden', () => {
    renderTile()
    const socket = FakeWebSocket.instances[0]
    act(() => socket.open())

    Object.defineProperty(document, 'hidden', { configurable: true, value: true })
    act(() => document.dispatchEvent(new Event('visibilitychange')))

    expect(socket.closeCount).toBe(1)
  })
})

describe('ChromiumTileCard browser selection', () => {
  beforeEach(() => {
    FakeWebSocket.instances = []
    vi.stubGlobal('WebSocket', FakeWebSocket)
    resetNativeWindowBridge()
    Object.defineProperty(window, 'webkit', { configurable: true, value: undefined })
  })

  afterEach(() => {
    cleanup()
    resetNativeWindowBridge()
    Object.defineProperty(window, 'webkit', { configurable: true, value: undefined })
    vi.unstubAllGlobals()
  })

  it('forwards held-button state throughout a captured pointer drag', () => {
    renderTile()
    const socket = FakeWebSocket.instances[0]
    act(() => socket.open())
    const canvas = screen.getByLabelText(`Chromium tile: ${webPane.url}`) as HTMLCanvasElement
    const setPointerCapture = vi.fn()
    const releasePointerCapture = vi.fn()
    Object.assign(canvas, {
      setPointerCapture,
      releasePointerCapture,
      hasPointerCapture: () => true,
    })

    fireEvent.pointerDown(canvas, { pointerId: 4, button: 0, buttons: 1, detail: 1 })
    fireEvent.pointerMove(canvas, { pointerId: 4, button: -1, buttons: 1 })
    fireEvent.pointerUp(canvas, { pointerId: 4, button: 0, buttons: 0, detail: 1 })

    const input = socket.sent.filter((message) => (
      message as { type?: string }
    ).type === 'input') as Array<{ event: { type: string; button: string; buttons: number } }>
    expect(input.map(({ event }) => [event.type, event.button, event.buttons])).toEqual([
      ['mousePressed', 'left', 1],
      ['mouseMoved', 'left', 1],
      ['mouseReleased', 'left', 0],
    ])
    expect(setPointerCapture).toHaveBeenCalledWith(4)
    expect(releasePointerCapture).toHaveBeenCalledWith(4)
  })

  it('copies the correlated remote selection on Command-C', async () => {
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    renderTile()
    const socket = FakeWebSocket.instances[0]
    act(() => socket.open())
    const canvas = screen.getByLabelText(`Chromium tile: ${webPane.url}`)

    fireEvent.keyDown(canvas, { key: 'c', code: 'KeyC', metaKey: true })
    const selectionRequest = socket.sent.find((message) => (
      message as { type?: string }
    ).type === 'selection') as { type: string; id: string }
    expect(selectionRequest.id).toMatch(/^s-/)
    expect(socket.sent).toContainEqual(expect.objectContaining({
      type: 'input',
      event: expect.objectContaining({ kind: 'key', type: 'keyDown', key: 'c' }),
    }))

    act(() => socket.message({
      type: 'selection_result',
      id: selectionRequest.id,
      ok: true,
      source: 'dom',
      text: ' exact\nselection ',
    }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(' exact\nselection '))
  })

  it('ignores stale and empty selection results', async () => {
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    renderTile()
    const socket = FakeWebSocket.instances[0]
    act(() => socket.open())
    const canvas = screen.getByLabelText(`Chromium tile: ${webPane.url}`)

    fireEvent.keyDown(canvas, { key: 'c', code: 'KeyC', metaKey: true })
    const request = socket.sent.find((message) => (message as { type?: string }).type === 'selection') as { id: string }
    act(() => {
      socket.message({ type: 'selection_result', id: 'stale', ok: true, source: 'dom', text: 'wrong' })
      socket.message({ type: 'selection_result', id: request.id, ok: true, source: 'none', text: '' })
    })
    await act(async () => { await Promise.resolve() })
    expect(writeText).not.toHaveBeenCalled()
  })

  it('invalidates a pending copy when its tile socket closes', async () => {
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    renderTile()
    const socket = FakeWebSocket.instances[0]
    act(() => socket.open())
    const canvas = screen.getByLabelText(`Chromium tile: ${webPane.url}`)
    fireEvent.keyDown(canvas, { key: 'c', code: 'KeyC', metaKey: true })
    const request = socket.sent.find((message) => (message as { type?: string }).type === 'selection') as { id: string }

    act(() => {
      socket.close()
      socket.message({ type: 'selection_result', id: request.id, ok: true, source: 'dom', text: 'stale copy' })
    })
    await act(async () => { await Promise.resolve() })
    expect(writeText).not.toHaveBeenCalled()
  })

  it('does not let a delayed old-socket close clear its replacement', () => {
    FakeWebSocket.deferClose = true
    renderTile()
    const first = FakeWebSocket.instances[0]
    act(() => first.open())

    Object.defineProperty(document, 'hidden', { configurable: true, value: true })
    act(() => document.dispatchEvent(new Event('visibilitychange')))
    Object.defineProperty(document, 'hidden', { configurable: true, value: false })
    act(() => document.dispatchEvent(new Event('visibilitychange')))
    const second = FakeWebSocket.instances[1]
    act(() => {
      second.open()
      first.flushClose()
    })

    fireEvent.keyDown(screen.getByLabelText(`Chromium tile: ${webPane.url}`), {
      key: 'a',
      code: 'KeyA',
    })
    expect(second.sent).toContainEqual(expect.objectContaining({
      type: 'input',
      event: expect.objectContaining({ kind: 'key', type: 'keyDown', key: 'a' }),
    }))
    expect(screen.queryByText('Stream closed.')).not.toBeInTheDocument()
    Object.defineProperty(document, 'hidden', { configurable: true, value: false })
  })

  it('uses the AppKit clipboard bridge and leaves Control-C to the page', async () => {
    const posted: unknown[] = []
    Object.defineProperty(window, 'webkit', {
      configurable: true,
      value: {
        messageHandlers: {
          commandoNativeWindow: { postMessage: (message: unknown) => posted.push(message) },
          commandoNativeClipboard: { postMessage: (message: unknown) => posted.push(message) },
        },
      },
    })
    resetNativeWindowBridge()
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    renderTile()
    const socket = FakeWebSocket.instances[0]
    act(() => socket.open())
    const canvas = screen.getByLabelText(`Chromium tile: ${webPane.url}`)

    fireEvent.keyDown(canvas, { key: 'c', code: 'KeyC', ctrlKey: true })
    expect(socket.sent.some((message) => (message as { type?: string }).type === 'selection')).toBe(false)
    expect(socket.sent).toContainEqual(expect.objectContaining({
      type: 'input',
      event: expect.objectContaining({ kind: 'key', type: 'keyDown', key: 'c', modifiers: 2 }),
    }))

    fireEvent.keyDown(canvas, { key: 'c', code: 'KeyC', metaKey: true })
    const request = socket.sent.find((message) => (message as { type?: string }).type === 'selection') as { id: string }
    act(() => socket.message({
      type: 'selection_result',
      id: request.id,
      ok: true,
      source: 'dom',
      text: 'native copy',
    }))
    await waitFor(() => expect(posted).toContainEqual(expect.objectContaining({
      type: 'clipboard.write-text',
      payload: { text: 'native copy' },
    })))
    expect(writeText).not.toHaveBeenCalled()
  })

  it('releases the remote button through the window when pointer capture fails', () => {
    renderTile()
    const socket = FakeWebSocket.instances[0]
    act(() => socket.open())
    const canvas = screen.getByLabelText(`Chromium tile: ${webPane.url}`) as HTMLCanvasElement
    Object.assign(canvas, {
      setPointerCapture: () => { throw new Error('capture unavailable') },
      getBoundingClientRect: () => ({ left: 10, top: 20, width: 100, height: 100 }),
    })

    fireEvent.pointerDown(canvas, { pointerId: 9, button: 0, buttons: 1, detail: 1 })
    fireEvent.pointerUp(window, { pointerId: 9, clientX: 80, clientY: 90, button: 0, buttons: 0 })

    expect(socket.sent).toContainEqual(expect.objectContaining({
      type: 'input',
      event: expect.objectContaining({
        type: 'mouseReleased',
        x: 70,
        y: 70,
        buttons: 0,
      }),
    }))
  })
})
