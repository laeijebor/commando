// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WebPanePendingNote, WebPanePendingSnapshot } from '../shared/protocol'
import type { PendingQueueApi } from './pendingQueueApi'
import { TileReviewLayer, type TileReviewSurface } from './TileReviewLayer'

const EMPTY_SNAPSHOT: WebPanePendingSnapshot = { notes: [], knownUpTo: 0, dropped: 0 }

function queue(overrides: Partial<PendingQueueApi> = {}): PendingQueueApi {
  return {
    list: async () => EMPTY_SNAPSHOT,
    add: async () => EMPTY_SNAPSHOT,
    update: async () => EMPTY_SNAPSHOT,
    upload: async () => EMPTY_SNAPSHOT,
    removeAttachment: async () => EMPTY_SNAPSHOT,
    attachmentUrl: (id) => `/attachments/${id}`,
    remove: async () => EMPTY_SNAPSHOT,
    send: async () => EMPTY_SNAPSHOT,
    dismissDropped: async () => EMPTY_SNAPSHOT,
    ...overrides,
  }
}

function surface(overrides: Partial<TileReviewSurface> = {}): TileReviewSurface {
  return {
    inspect: (_x, _y, _grade, receive) => receive({ ok: false, error: 'not found' }),
    resolveSelectors: (_items, receive) => receive([]),
    subscribePending: () => () => undefined,
    ...overrides,
  }
}

function annotation(id: number, revision = 1, comment = 'Tighten this copy'): WebPanePendingNote {
  return {
    id,
    revision,
    selector: '#target',
    tag: 'button',
    rect: { x: 10, y: 12, width: 80, height: 24 },
    comment,
    attachments: [],
  }
}

afterEach(() => {
  cleanup()
  window.localStorage.clear()
})

describe('TileReviewLayer', () => {
  it('owns renderer-neutral inspect hover, click, and queueing', async () => {
    const note = annotation(1, 1, 'Needs hierarchy')
    const add = vi.fn(async () => ({ ...EMPTY_SNAPSHOT, notes: [note], knownUpTo: 1 }))
    const inspect: TileReviewSurface['inspect'] = vi.fn((_x, _y, grade, receive) => {
      receive({
        ok: true,
        selector: '#target',
        tag: 'button',
        rect: { x: 10, y: 12, width: 80, height: 24 },
        ...(grade === 'click' ? { text: 'Review me' } : {}),
      })
    })
    const container = document.createElement('div')
    const input = document.createElement('canvas')
    Object.defineProperty(container, 'getBoundingClientRect', {
      value: () => ({ x: 0, y: 0, left: 0, top: 0, right: 500, bottom: 400, width: 500, height: 400 }),
    })
    Object.defineProperty(input, 'getBoundingClientRect', {
      value: () => ({ x: 0, y: 0, left: 0, top: 0, right: 500, bottom: 400, width: 500, height: 400 }),
    })

    render(
      <TileReviewLayer
        webPaneId="w-review"
        reviewMode
        active
        containerRef={{ current: container }}
        inputRef={{ current: input }}
        pendingQueue={queue({ add })}
        surface={surface({ inspect })}
      />,
    )
    await act(async () => { await Promise.resolve() })

    fireEvent.pointerMove(input, { clientX: 30, clientY: 40 })
    expect(document.querySelector('.tile-review-highlight')).toHaveStyle({
      left: '10px',
      top: '12px',
      width: '80px',
      height: '24px',
    })

    fireEvent.pointerDown(input, { button: 0, clientX: 30, clientY: 40 })
    fireEvent.change(screen.getByRole('textbox', { name: 'Note about #target' }), {
      target: { value: 'Needs hierarchy' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Queue note' }))

    await waitFor(() => expect(add).toHaveBeenCalledWith({
      selector: '#target',
      tag: 'button',
      text: 'Review me',
      rect: { x: 10, y: 12, width: 80, height: 24 },
      comment: 'Needs hierarchy',
    }))
    expect(await screen.findByRole('button', { name: 'Review queue · 1' })).toBeInTheDocument()
  })

  it('hydrates and reconciles pushed queue snapshots through the surface contract', async () => {
    let publish: ((snapshot: WebPanePendingSnapshot) => void) | undefined
    const reviewSurface = surface({
      subscribePending: (listener) => {
        publish = listener
        return () => { publish = undefined }
      },
    })
    render(
      <TileReviewLayer
        webPaneId="w-pending"
        reviewMode={false}
        active={false}
        containerRef={{ current: document.createElement('div') }}
        inputRef={{ current: document.createElement('div') }}
        pendingQueue={queue()}
        surface={reviewSurface}
      />,
    )
    await act(async () => { await Promise.resolve() })

    act(() => publish?.({ notes: [annotation(4)], knownUpTo: 4, dropped: 0, revision: 1 }))
    expect(screen.getByRole('button', { name: 'Review queue · 1' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Review queue · 1' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Comment' }), {
      target: { value: 'Local draft' },
    })

    act(() => publish?.({
      notes: [annotation(4, 2, 'Changed elsewhere')],
      knownUpTo: 4,
      dropped: 0,
      revision: 2,
    }))
    expect(screen.getByRole('alert')).toHaveTextContent(/changed after you started editing/i)
    expect(screen.getByRole('textbox', { name: 'Comment' })).toHaveValue('Local draft')
  })
})
