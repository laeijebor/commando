// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebPane, WebPanePendingNote, WebPanePendingSnapshot } from '../shared/protocol'
import { ChromiumTileCard, type PendingQueueApi } from './ChromiumTileCard'

class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  static OPEN = 1
  readonly url: string
  readyState = 0
  closeCount = 0
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

  send(): void {}

  close(): void {
    this.closeCount += 1
    if (this.readyState === 3) return
    this.readyState = 3
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
) {
  return (
    <ChromiumTileCard
      webPane={webPane}
      wsToken="t"
      reloadKey={0}
      reviewMode={false}
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
) {
  return render(tileElement(pendingQueue, keepStreamingWhenHidden, connected))
}

describe('ChromiumTileCard pending hydration', () => {
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

    await waitFor(() => expect(send).toHaveBeenCalledWith([1]))
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

    await waitFor(() => expect(send).toHaveBeenCalledWith([1, 2]))
    expect(update).toHaveBeenCalledTimes(2)
    expect(update.mock.invocationCallOrder[1]).toBeLessThan(send.mock.invocationCallOrder[0])
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
