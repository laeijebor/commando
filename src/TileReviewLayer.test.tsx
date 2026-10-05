// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WebPanePendingNote, WebPanePendingSnapshot } from '../shared/protocol'
import type { RedlinePageQuestionSnapshot, RedlinePageResponse } from '../shared/redline-response'
import type { TileInspectResult } from '../shared/tile-inspect'
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
    subscribeQuestions: () => () => undefined,
    revealSelector: () => undefined,
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
  vi.unstubAllGlobals()
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

  it('keeps navigation clicks out of annotation cards while ordinary controls remain annotatable', async () => {
    const input = document.createElement('canvas')
    let navigation = true
    const inspect = vi.fn((_x, _y, _grade, receive) => receive({
      ok: true, selector: '#next', tag: 'button', rect: { x: 10, y: 10, width: 90, height: 30 },
      ...(navigation ? { navigation: true } : {}),
    })) as TileReviewSurface['inspect']
    render(<TileReviewLayer webPaneId="w-nav" reviewMode active
      containerRef={{ current: document.createElement('div') }} inputRef={{ current: input }}
      pendingQueue={queue()} surface={surface({ inspect })} />)
    await act(async () => { await Promise.resolve() })
    fireEvent.pointerDown(input, { button: 0, clientX: 20, clientY: 20 })
    expect(inspect).toHaveBeenCalled()
    expect(screen.queryByRole('textbox', { name: 'Note about #next' })).not.toBeInTheDocument()
    navigation = false
    fireEvent.pointerDown(input, { button: 0, clientX: 20, clientY: 20 })
    expect(screen.getByRole('textbox', { name: 'Note about #next' })).toBeInTheDocument()
  })

  it('measures the persistent summary, reserves the viewport, and cleans up layout observers', async () => {
    const callbacks: ResizeObserverCallback[] = []
    const disconnect = vi.fn()
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: ResizeObserverCallback) { callbacks.push(callback) }
      observe() {}
      disconnect = disconnect
    })
    const container = document.createElement('div')
    let tileHeight = 600
    vi.spyOn(container, 'getBoundingClientRect').mockImplementation(() => ({ height: tileHeight } as DOMRect))
    const { unmount } = render(<TileReviewLayer webPaneId="w-layout" reviewMode={false} active={false}
      containerRef={{ current: container }} inputRef={{ current: document.createElement('div') }}
      pendingQueue={queue({ list: async () => ({ notes: [annotation(1)], knownUpTo: 1, dropped: 0 }) })}
      surface={surface()} />)
    const toggle = await screen.findByRole('button', { name: 'Review queue · 1' })
    const strip = screen.getByTestId('pending-queue-strip')
    vi.spyOn(strip, 'getBoundingClientRect').mockReturnValue({ height: 72 } as DOMRect)
    callbacks.at(-1)!([], {} as ResizeObserver)
    expect(container.style.getPropertyValue('--tile-review-strip-height')).toBe('72px')
    expect(container).toHaveAttribute('data-review-summary')
    fireEvent.click(toggle)
    expect(container).toHaveAttribute('data-review-drawer-open')
    expect(strip).toBeInTheDocument()
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getAllByRole('button', { name: /^Send all$/ })).toHaveLength(1)
    tileHeight = 280
    callbacks.at(-1)!([], {} as ResizeObserver)
    expect(container).toHaveAttribute('data-review-short-tile')
    unmount()
    expect(disconnect).toHaveBeenCalled()
    expect(container).not.toHaveAttribute('data-review-summary')
    expect(container.style.getPropertyValue('--tile-review-strip-height')).toBe('')
    vi.unstubAllGlobals()
  })

  it('drops a late click result after review deactivation and teardown', async () => {
    let receiveClick: ((result: TileInspectResult) => void) | undefined
    const input = document.createElement('div')
    const container = document.createElement('div')
    Object.defineProperty(input, 'getBoundingClientRect', {
      value: () => ({ x: 0, y: 0, left: 0, top: 0, right: 500, bottom: 400, width: 500, height: 400 }),
    })
    Object.defineProperty(container, 'getBoundingClientRect', {
      value: () => ({ x: 0, y: 0, left: 0, top: 0, right: 500, bottom: 400, width: 500, height: 400 }),
    })
    const reviewSurface = surface({
      inspect: (_x, _y, grade, receive) => {
        if (grade === 'click') receiveClick = receive
      },
    })
    const props = {
      webPaneId: 'w-stale-click',
      containerRef: { current: container },
      inputRef: { current: input },
      pendingQueue: queue(),
      surface: reviewSurface,
    }
    const view = render(<TileReviewLayer {...props} reviewMode active />)
    await act(async () => { await Promise.resolve() })
    fireEvent.pointerDown(input, { button: 0, clientX: 20, clientY: 24 })

    view.rerender(<TileReviewLayer {...props} reviewMode={false} active={false} />)
    act(() => receiveClick?.({
      ok: true,
      selector: '#stale',
      tag: 'button',
      rect: { x: 10, y: 12, width: 80, height: 24 },
    }))
    view.rerender(<TileReviewLayer {...props} reviewMode active />)

    expect(screen.queryByRole('textbox', { name: 'Note about #stale' })).not.toBeInTheDocument()
  })

  it('hydrates and reconciles pushed queue snapshots through the surface contract', async () => {
    let publish: ((snapshot: WebPanePendingSnapshot) => void) | undefined
    const update = vi.fn(async () => ({ notes: [annotation(4, 3, 'Local draft')], knownUpTo: 4, dropped: 0, revision: 3 }))
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
        pendingQueue={queue({ update })}
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
    // The owner's typed text is never discarded: it rebases onto the new revision.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Comment' })).toHaveValue('Local draft')
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(update).toHaveBeenCalledWith(4, 2, { answer: 'Local draft' }))
  })

  it('requeues a dirty draft when its note vanishes from a newer snapshot', async () => {
    let publish: ((snapshot: WebPanePendingSnapshot) => void) | undefined
    const add = vi.fn(async () => ({ notes: [annotation(5, 1, 'Local draft')], knownUpTo: 5, dropped: 0, revision: 3 }))
    render(
      <TileReviewLayer
        webPaneId="w-vanish"
        pageUrl="https://example.com/review"
        reviewMode={false}
        active={false}
        containerRef={{ current: document.createElement('div') }}
        inputRef={{ current: document.createElement('div') }}
        pendingQueue={queue({ add })}
        surface={surface({ subscribePending: (listener) => { publish = listener; return () => undefined } })}
      />,
    )
    await act(async () => { await Promise.resolve() })
    act(() => publish?.({ notes: [annotation(4)], knownUpTo: 4, dropped: 0, revision: 1 }))
    fireEvent.click(screen.getByRole('button', { name: 'Review queue · 1' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Comment' }), { target: { value: 'Local draft' } })

    // Sent or removed from another view: the note is gone, the typed text must not be.
    act(() => publish?.({ notes: [], knownUpTo: 4, dropped: 0, revision: 2 }))
    await waitFor(() => expect(add).toHaveBeenCalledWith(expect.objectContaining({
      selector: '#target',
      comment: 'Local draft',
      pageUrl: 'https://example.com/review',
    })))
    // The queue emptied for a moment (drawer collapses), then holds the requeued note.
    expect(await screen.findByRole('button', { name: 'Review queue · 1' })).toBeInTheDocument()
  })

  it('does not resurrect a dirty draft the owner removed on purpose', async () => {
    const add = vi.fn(async () => EMPTY_SNAPSHOT)
    const remove = vi.fn(async () => ({ notes: [], knownUpTo: 4, dropped: 0, revision: 2 }))
    render(
      <TileReviewLayer
        webPaneId="w-remove"
        reviewMode={false}
        active={false}
        containerRef={{ current: document.createElement('div') }}
        inputRef={{ current: document.createElement('div') }}
        pendingQueue={queue({ list: async () => ({ notes: [annotation(4)], knownUpTo: 4, dropped: 0, revision: 1 }), add, remove })}
        surface={surface()}
      />,
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Review queue · 1' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Comment' }), { target: { value: 'Changed my mind' } })
    fireEvent.click(screen.getByRole('button', { name: 'Remove from queue' }))
    await waitFor(() => expect(remove).toHaveBeenCalledWith(4))
    await act(async () => { await Promise.resolve() })
    expect(add).not.toHaveBeenCalled()
  })

  it('reports a draft that could not be saved before Send all instead of silently sending nothing', async () => {
    const update = vi.fn(async () => { throw new Error('disk full') })
    const send = vi.fn(async () => EMPTY_SNAPSHOT)
    render(
      <TileReviewLayer
        webPaneId="w-savefail"
        reviewMode={false}
        active={false}
        containerRef={{ current: document.createElement('div') }}
        inputRef={{ current: document.createElement('div') }}
        pendingQueue={queue({ list: async () => ({ notes: [annotation(4)], knownUpTo: 4, dropped: 0, revision: 1 }), update, send })}
        surface={surface()}
      />,
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Review queue · 1' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Comment' }), { target: { value: 'Local draft' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send all' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/disk full/))
    expect(send).not.toHaveBeenCalled()
    expect(screen.getByRole('textbox', { name: 'Comment' })).toHaveValue('Local draft')
  })

  it('refreshes and retries a save at the daemon revision when the note was stale', async () => {
    const stale = Object.assign(new Error('Pending note revision is stale'), { status: 409 })
    const update = vi.fn()
      .mockRejectedValueOnce(stale)
      .mockResolvedValueOnce({ notes: [annotation(4, 3, 'Local draft')], knownUpTo: 4, dropped: 0, revision: 3 })
    const list = vi.fn()
      .mockResolvedValueOnce({ notes: [annotation(4)], knownUpTo: 4, dropped: 0, revision: 1 })
      .mockResolvedValueOnce({ notes: [annotation(4, 2, 'Changed elsewhere')], knownUpTo: 4, dropped: 0, revision: 2 })
    render(
      <TileReviewLayer
        webPaneId="w-retry"
        reviewMode={false}
        active={false}
        containerRef={{ current: document.createElement('div') }}
        inputRef={{ current: document.createElement('div') }}
        pendingQueue={queue({ list, update })}
        surface={surface()}
      />,
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Review queue · 1' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Comment' }), { target: { value: 'Local draft' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    await waitFor(() => expect(update).toHaveBeenCalledTimes(2))
    expect(update).toHaveBeenNthCalledWith(1, 4, 1, { answer: 'Local draft' })
    expect(update).toHaveBeenNthCalledWith(2, 4, 2, { answer: 'Local draft' })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('occludes native surfaces only for opaque review UI, not highlight hit targets', async () => {
    let publish: ((snapshot: WebPanePendingSnapshot) => void) | undefined
    const inspect: TileReviewSurface['inspect'] = vi.fn((_x, _y, grade, receive) => {
      receive(grade === 'click'
        ? {
            ok: true,
            selector: '#target',
            tag: 'button',
            rect: { x: 10, y: 12, width: 80, height: 24 },
          }
        : { ok: false, error: 'not found' })
    })
    const input = document.createElement('div')
    Object.defineProperty(input, 'getBoundingClientRect', {
      value: () => ({ x: 0, y: 0, left: 0, top: 0, right: 500, bottom: 400, width: 500, height: 400 }),
    })
    render(
      <TileReviewLayer
        webPaneId="w-native"
        reviewMode
        active
        containerRef={{ current: input }}
        inputRef={{ current: input }}
        pendingQueue={queue()}
        surface={surface({
          inspect,
          resolveSelectors: (_items, receive) => receive([{
            noteId: 1,
            rect: { x: 10, y: 12, width: 80, height: 24 },
          }]),
          subscribePending: (listener) => {
            publish = listener
            return () => { publish = undefined }
          },
        })}
      />,
    )
    await act(async () => { await Promise.resolve() })

    act(() => publish?.({
      revision: 1,
      notes: [{
        ...annotation(1),
        attachments: [{ id: 'image-1', name: 'capture.png', size: 12, contentType: 'image/png' }],
      }],
      knownUpTo: 1,
      dropped: 0,
    }))

    const hitTarget = await screen.findByRole('button', { name: /Edit queued annotation/ })
    expect(hitTarget).not.toHaveAttribute('data-native-terminal-occluder')
    fireEvent.click(hitTarget)
    expect(screen.getByRole('dialog', { name: 'Edit queued annotation' }))
      .toHaveAttribute('data-native-terminal-occluder', '')

    fireEvent.pointerDown(input, { button: 0, clientX: 20, clientY: 24 })
    expect(screen.getByRole('textbox', { name: 'Note about #target' }).closest('.tile-review-card'))
      .toHaveAttribute('data-native-terminal-occluder', '')

    fireEvent.click(screen.getByRole('button', { name: 'Review queue · 1' }))
    expect(screen.getByTestId('pending-queue-drawer'))
      .toHaveAttribute('data-native-terminal-occluder', '')
    fireEvent.click(screen.getByRole('button', { name: 'Preview capture.png' }))
    expect(screen.getByRole('dialog', { name: 'Preview capture.png' }))
      .toHaveAttribute('data-native-terminal-occluder', '')
  })

  it('lists all open questions, filters unanswered ones, answers, and reveals context', async () => {
    let publishQuestions: ((pageUrl: string, snapshot: RedlinePageQuestionSnapshot) => void) | undefined
    let publishPending: ((snapshot: WebPanePendingSnapshot) => void) | undefined
    const revealSelector = vi.fn()
    const answered: WebPanePendingNote = {
      id: 1,
      revision: 1,
      pageUrl: 'https://example.com/review',
      selector: '#plan',
      tag: 'redline-choice',
      rect: { x: 0, y: 0, width: 0, height: 0 },
      comment: 'Which plan?: Pro',
      queueKey: 'plan',
      response: { question: 'Which plan?', answer: 'Pro' },
      attachments: [],
    }
    const newlyAnswered: WebPanePendingNote = {
      ...answered,
      id: 2,
      selector: '#launch',
      queueKey: 'launch',
      comment: 'Ready to launch?: approve',
      response: { question: 'Ready to launch?', answer: 'approve', data: { verdict: 'approve' } },
    }
    const addResponse = vi.fn(async () => ({
      revision: 2,
      notes: [answered, newlyAnswered],
      knownUpTo: 2,
      dropped: 0,
    }))
    render(
      <TileReviewLayer
        webPaneId="w-questions"
        pageUrl="https://example.com/review"
        reviewMode={false}
        active={false}
        containerRef={{ current: document.createElement('div') }}
        inputRef={{ current: document.createElement('div') }}
        pendingQueue={queue({ addResponse })}
        surface={surface({
          subscribePending: (listener) => {
            publishPending = listener
            return () => { publishPending = undefined }
          },
          subscribeQuestions: (listener) => {
            publishQuestions = listener
            return () => { publishQuestions = undefined }
          },
          revealSelector,
        })}
      />,
    )
    await act(async () => { await Promise.resolve() })

    act(() => {
      publishQuestions?.('https://example.com/review', {
        type: 'questions',
        version: 1,
        questions: [
          {
            question: 'Which plan?',
            queueKey: 'plan',
            selector: '#plan',
            kind: 'choice',
            options: ['Starter', 'Pro'],
            multiple: false,
          },
          {
            question: 'Ready to launch?',
            queueKey: 'launch',
            selector: '#launch',
            kind: 'approve',
            options: ['approve', 'reject', 'needs-changes'],
          },
        ],
      })
      publishPending?.({ revision: 1, notes: [answered], knownUpTo: 1, dropped: 0 })
    })

    fireEvent.click(screen.getByRole('button', { name: 'Answer queue · 2' }))
    const dialog = screen.getByRole('dialog', { name: 'Answer queue' })
    await waitFor(() => expect(dialog).toHaveFocus())
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Answer queue · 2' })).toHaveFocus())
    fireEvent.click(screen.getByRole('button', { name: 'Answer queue · 2' }))
    expect(screen.getByRole('navigation', { name: 'Open questions and queued review items' })).toBeInTheDocument()
    expect(screen.getAllByText('Which plan?')).not.toHaveLength(0)
    expect(screen.getByText('Ready to launch?')).toBeInTheDocument()
    expect(screen.getByText(/1 unanswered · 1 answered/)).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Answer' })).toHaveValue('Pro')

    fireEvent.click(screen.getByRole('button', { name: 'Unanswered · 1' }))
    expect(screen.queryByText('Which plan?')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Ready to launch\?/ }))
    expect(revealSelector).toHaveBeenCalledWith('#launch')
    fireEvent.change(screen.getByRole('combobox', { name: 'Answer' }), {
      target: { value: 'approve' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Queue answer' }))

    await waitFor(() => expect(addResponse).toHaveBeenCalledWith(
      'https://example.com/review',
      expect.objectContaining({
        question: 'Ready to launch?',
        answer: 'approve',
        queueKey: 'launch',
        selector: '#launch',
        data: { verdict: 'approve' },
      }),
    ))
    await waitFor(() => expect(screen.getByText('No unanswered questions.')).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: 'Queue answer' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Unanswered · 0' })).toHaveFocus()
  })

  it('shows sent answers as answered, read-only until the owner changes one', async () => {
    let publishQuestions: ((pageUrl: string, snapshot: RedlinePageQuestionSnapshot) => void) | undefined
    let publishPending: ((snapshot: WebPanePendingSnapshot) => void) | undefined
    const planShape = { question: 'Which plan?', kind: 'choice' as const, options: ['Starter', 'Pro'], multiple: false }
    const sentSnapshot: WebPanePendingSnapshot = {
      revision: 3,
      notes: [],
      knownUpTo: 2,
      dropped: 0,
      sent: {
        page: 'https://example.com/review',
        answers: [
          {
            queueKey: 'plan',
            selector: '#plan',
            shape: planShape,
            response: { question: 'Which plan?', answer: 'Pro', note: 'cheaper', data: { choice: 'Pro' } },
            sentAt: Date.now() - 5 * 60_000,
          },
          {
            queueKey: 'launch',
            selector: '#launch',
            shape: { question: 'Ready to launch? (old wording)', kind: 'text' },
            response: { question: 'Ready to launch? (old wording)', answer: 'yes' },
            sentAt: Date.now(),
          },
        ],
      },
    }
    const addResponse = vi.fn(async (_pageUrl: string, _response: RedlinePageResponse) => sentSnapshot)
    render(
      <TileReviewLayer
        webPaneId="w-sent"
        pageUrl="https://example.com/review?v=2"
        reviewMode={false}
        active={false}
        containerRef={{ current: document.createElement('div') }}
        inputRef={{ current: document.createElement('div') }}
        pendingQueue={queue({ addResponse })}
        surface={surface({
          subscribePending: (listener) => {
            publishPending = listener
            return () => { publishPending = undefined }
          },
          subscribeQuestions: (listener) => {
            publishQuestions = listener
            return () => { publishQuestions = undefined }
          },
        })}
      />,
    )
    await act(async () => { await Promise.resolve() })
    act(() => {
      publishQuestions?.('https://example.com/review?v=2', {
        type: 'questions',
        version: 1,
        questions: [
          { ...planShape, queueKey: 'plan', selector: '#plan' },
          { question: 'Ready to launch?', queueKey: 'launch', selector: '#launch', kind: 'text' },
        ],
      })
      publishPending?.(sentSnapshot)
    })

    fireEvent.click(screen.getByRole('button', { name: 'Answer queue · 2' }))
    // The reworded launch question is a re-ask, so only the plan counts as answered.
    expect(screen.getByText(/1 unanswered · 1 answered/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Which plan\?/ }))
    const detail = screen.getByRole('button', { name: 'Change answer' }).closest('.tile-review-drawer-detail') as HTMLElement
    expect(detail).toHaveTextContent('Sent')
    expect(detail).toHaveTextContent('Pro')
    expect(detail).toHaveTextContent('cheaper')
    expect(detail).toHaveTextContent('Sent · 5m ago')
    expect(screen.queryByRole('combobox', { name: 'Answer' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Unanswered · 1' }))
    expect(screen.queryByRole('button', { name: /Which plan\?/ })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'All' }))
    fireEvent.click(screen.getByRole('button', { name: /Which plan\?/ }))

    fireEvent.click(screen.getByRole('button', { name: 'Change answer' }))
    expect(screen.getByText('Changing sent answer')).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Answer' })).toHaveValue('Pro')
    fireEvent.change(screen.getByRole('combobox', { name: 'Answer' }), { target: { value: 'Starter' } })
    fireEvent.click(screen.getByRole('button', { name: 'Queue answer' }))
    await waitFor(() => expect(addResponse).toHaveBeenCalledWith(
      'https://example.com/review?v=2',
      expect.objectContaining({ answer: 'Starter', queueKey: 'plan', shape: planShape }),
    ))
  })

  it('keeps answers and typed drafts when the page only changes its hash', async () => {
    let publishQuestions: ((pageUrl: string, snapshot: RedlinePageQuestionSnapshot) => void) | undefined
    let publishPending: ((snapshot: WebPanePendingSnapshot) => void) | undefined
    const queuedPlan: WebPanePendingNote = {
      id: 1,
      revision: 1,
      pageUrl: 'https://example.com/review',
      selector: '#plan',
      tag: 'redline-choice',
      rect: { x: 0, y: 0, width: 0, height: 0 },
      comment: 'Which plan?: Pro',
      queueKey: 'plan',
      response: { question: 'Which plan?', answer: 'Pro' },
      attachments: [],
    }
    const questions: RedlinePageQuestionSnapshot = {
      type: 'questions',
      version: 1,
      questions: [
        { question: 'Which plan?', queueKey: 'plan', selector: '#plan', kind: 'choice', options: ['Starter', 'Pro'], multiple: false },
        { question: 'Project name?', queueKey: 'name', selector: '#name', kind: 'text' },
      ],
    }
    render(
      <TileReviewLayer
        webPaneId="w-hash"
        pageUrl="https://example.com/review"
        reviewMode={false}
        active={false}
        containerRef={{ current: document.createElement('div') }}
        inputRef={{ current: document.createElement('div') }}
        pendingQueue={queue({ addResponse: async () => EMPTY_SNAPSHOT })}
        surface={surface({
          subscribePending: (listener) => { publishPending = listener; return () => undefined },
          subscribeQuestions: (listener) => { publishQuestions = listener; return () => undefined },
        })}
      />,
    )
    await act(async () => { await Promise.resolve() })
    act(() => {
      publishQuestions?.('https://example.com/review#reach', questions)
      publishPending?.({ revision: 1, notes: [queuedPlan], knownUpTo: 1, dropped: 0 })
    })
    fireEvent.click(screen.getByRole('button', { name: 'Answer queue · 2' }))
    expect(screen.getByText(/1 unanswered · 1 answered/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Project name\?/ }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Answer' }), { target: { value: 'Half-typed' } })

    act(() => publishQuestions?.('https://example.com/review#composer', questions))
    expect(screen.getByText(/1 unanswered · 1 answered/)).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Answer' })).toHaveValue('Half-typed')
  })

  it('clears question drafts when the page inventory moves to a new document', async () => {
    let publishQuestions: ((pageUrl: string, snapshot: RedlinePageQuestionSnapshot) => void) | undefined
    render(
      <TileReviewLayer
        webPaneId="w-question-navigation"
        pageUrl="https://example.com/first"
        reviewMode={false}
        active={false}
        containerRef={{ current: document.createElement('div') }}
        inputRef={{ current: document.createElement('div') }}
        pendingQueue={queue({ addResponse: vi.fn() })}
        surface={surface({
          subscribeQuestions: (listener) => {
            publishQuestions = listener
            return () => { publishQuestions = undefined }
          },
        })}
      />,
    )
    await act(async () => { await Promise.resolve() })
    const snapshot: RedlinePageQuestionSnapshot = {
      type: 'questions',
      version: 1,
      questions: [{ question: 'Name it', queueKey: 'name', selector: '#name', kind: 'text' }],
    }
    act(() => publishQuestions?.('https://example.com/first', snapshot))
    fireEvent.click(screen.getByRole('button', { name: 'Answer queue · 1' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Answer' }), {
      target: { value: 'First-page draft' },
    })

    act(() => publishQuestions?.('https://example.com/second', snapshot))

    expect(screen.getByRole('textbox', { name: 'Answer' })).toHaveValue('')

    fireEvent.change(screen.getByRole('textbox', { name: 'Answer' }), {
      target: { value: 'Incompatible draft' },
    })
    act(() => publishQuestions?.('https://example.com/second', {
      type: 'questions',
      version: 1,
      questions: [{ question: 'Rate it', queueKey: 'name', selector: '#name', kind: 'rating', max: 3 }],
    }))
    expect(screen.getAllByRole('radio')).toHaveLength(3)
    expect(screen.getAllByRole('radio').every((radio) => !(radio as HTMLInputElement).checked)).toBe(true)
  })

  it('revision-updates a keyless answered question and refreshes its structured metadata', async () => {
    let publishQuestions: ((pageUrl: string, snapshot: RedlinePageQuestionSnapshot) => void) | undefined
    let publishPending: ((snapshot: WebPanePendingSnapshot) => void) | undefined
    const answered: WebPanePendingNote = {
      id: 1,
      revision: 1,
      pageUrl: 'https://example.com/review',
      selector: '#plan',
      tag: 'redline-choice',
      rect: { x: 0, y: 0, width: 0, height: 0 },
      comment: 'Which plan?: Pro',
      response: { question: 'Which plan?', answer: 'Pro' },
      attachments: [],
    }
    const update = vi.fn(async () => ({
      revision: 2,
      notes: [{
        ...answered,
        revision: 2,
        comment: 'Which plan?: Starter',
        response: {
          question: 'Which plan?',
          answer: 'Starter',
          data: { choice: 'Starter', options: ['Starter', 'Pro'], multiple: false },
        },
      }],
      knownUpTo: 1,
      dropped: 0,
    }))
    render(
      <TileReviewLayer
        webPaneId="w-structured-answer"
        pageUrl="https://example.com/review"
        reviewMode={false}
        active={false}
        containerRef={{ current: document.createElement('div') }}
        inputRef={{ current: document.createElement('div') }}
        pendingQueue={queue({ update })}
        surface={surface({
          subscribePending: (listener) => {
            publishPending = listener
            return () => { publishPending = undefined }
          },
          subscribeQuestions: (listener) => {
            publishQuestions = listener
            return () => { publishQuestions = undefined }
          },
        })}
      />,
    )
    await act(async () => { await Promise.resolve() })
    act(() => {
      publishQuestions?.('https://example.com/review', {
        type: 'questions',
        version: 1,
          questions: [{
            question: 'Which plan?',
            selector: '#plan',
          kind: 'choice',
          options: ['Starter', 'Pro'],
          multiple: false,
        }],
      })
      publishPending?.({ revision: 1, notes: [answered], knownUpTo: 1, dropped: 0 })
    })
    fireEvent.click(screen.getByRole('button', { name: 'Answer queue · 1' }))
    fireEvent.change(screen.getByRole('combobox', { name: 'Answer' }), {
      target: { value: 'Starter' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    await waitFor(() => expect(update).toHaveBeenCalledWith(1, 1, {
      response: expect.objectContaining({
        question: 'Which plan?',
        answer: 'Starter',
        selector: '#plan',
        data: { choice: 'Starter', options: ['Starter', 'Pro'], multiple: false },
      }),
    }))
    expect(update).toHaveBeenCalledOnce()
  })

  it('preserves comma-containing option labels in multi-select answers', async () => {
    let publishQuestions: ((pageUrl: string, snapshot: RedlinePageQuestionSnapshot) => void) | undefined
    const addResponse = vi.fn(async (_pageUrl: string, _response: RedlinePageResponse) => EMPTY_SNAPSHOT)
    const longOptionA = 'A'.repeat(1_024)
    const longOptionB = 'B'.repeat(1_024)
    render(
      <TileReviewLayer
        webPaneId="w-comma-options"
        pageUrl="https://example.com/review"
        reviewMode={false}
        active={false}
        containerRef={{ current: document.createElement('div') }}
        inputRef={{ current: document.createElement('div') }}
        pendingQueue={queue({ addResponse })}
        surface={surface({
          subscribeQuestions: (listener) => {
            publishQuestions = listener
            return () => { publishQuestions = undefined }
          },
        })}
      />,
    )
    await act(async () => { await Promise.resolve() })
    act(() => publishQuestions?.('https://example.com/review', {
      type: 'questions',
      version: 1,
      questions: [{
        question: 'Which signals?',
        queueKey: 'signals',
        selector: '#signals',
        kind: 'choice',
        options: ['Pulse, Crest', longOptionA, longOptionB],
        multiple: true,
      }],
    }))

    fireEvent.click(screen.getByRole('button', { name: 'Answer queue · 1' }))
    const commaOption = screen.getByRole('checkbox', { name: 'Pulse, Crest' })
    fireEvent.click(commaOption)
    fireEvent.click(screen.getByRole('checkbox', { name: longOptionA }))
    fireEvent.click(screen.getByRole('checkbox', { name: longOptionB }))
    expect(commaOption).toBeChecked()
    fireEvent.click(screen.getByRole('button', { name: 'Queue answer' }))

    await waitFor(() => expect(addResponse).toHaveBeenCalledOnce())
    const [, response] = addResponse.mock.calls[0]
    expect(response.answer).toHaveLength(1_024)
    expect(response.answer).toMatch(/\.\.\.$/)
    expect(response.data).toEqual({
      choice: ['Pulse, Crest', longOptionA, longOptionB],
      options: ['Pulse, Crest', longOptionA, longOptionB],
      multiple: true,
    })
    await waitFor(() => expect(document.querySelector('.tile-review-drawer-detail')).toHaveFocus())
  })

  it('preserves a skipped multi-select answer while editing its note', async () => {
    let publishQuestions: ((pageUrl: string, snapshot: RedlinePageQuestionSnapshot) => void) | undefined
    let publishPending: ((snapshot: WebPanePendingSnapshot) => void) | undefined
    const answered: WebPanePendingNote = {
      id: 1,
      revision: 4,
      pageUrl: 'https://example.com/review',
      selector: '#signals',
      tag: 'redline-choice',
      rect: { x: 0, y: 0, width: 0, height: 0 },
      comment: 'Which signals?: (none - see note)',
      response: {
        question: 'Which signals?',
        answer: '(none - see note)',
        data: { options: ['Pulse, Crest', 'Orbit'], multiple: true },
      },
      attachments: [],
    }
    const update = vi.fn(async () => ({
      revision: 5,
      notes: [{
        ...answered,
        revision: 5,
        response: {
          ...answered.response!,
          note: 'Skipped intentionally',
          data: {
            choice: [],
            multiple: true,
          },
        },
      }],
      knownUpTo: 1,
      dropped: 0,
    }))
    render(
      <TileReviewLayer
        webPaneId="w-skipped-multi"
        pageUrl="https://example.com/review"
        reviewMode={false}
        active={false}
        containerRef={{ current: document.createElement('div') }}
        inputRef={{ current: document.createElement('div') }}
        pendingQueue={queue({ update })}
        surface={surface({
          subscribePending: (listener) => {
            publishPending = listener
            return () => { publishPending = undefined }
          },
          subscribeQuestions: (listener) => {
            publishQuestions = listener
            return () => { publishQuestions = undefined }
          },
        })}
      />,
    )
    await act(async () => { await Promise.resolve() })
    act(() => {
      publishQuestions?.('https://example.com/review', {
        type: 'questions',
        version: 1,
        questions: [{
          question: 'Which signals?',
          selector: '#signals',
          kind: 'choice',
          options: ['Pulse, Crest', 'Orbit'],
          multiple: true,
        }],
      })
      publishPending?.({ revision: 4, notes: [answered], knownUpTo: 1, dropped: 0 })
    })

    fireEvent.click(screen.getByRole('button', { name: 'Answer queue · 1' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Optional note' }), {
      target: { value: 'Skipped intentionally' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    await waitFor(() => expect(update).toHaveBeenCalledWith(1, 4, {
      response: expect.objectContaining({
        answer: '(none - see note)',
        note: 'Skipped intentionally',
        data: {
          choice: [],
          options: ['Pulse, Crest', 'Orbit'],
          multiple: true,
        },
      }),
    }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send this' })).toBeEnabled())
  })

  it('edits compacted choice-only metadata without splitting comma labels', async () => {
    let publishPending: ((snapshot: WebPanePendingSnapshot) => void) | undefined
    const longOption = 'L'.repeat(1_024)
    const choices = ['Pulse, Crest', longOption]
    const displayAnswer = `${choices.join(', ').slice(0, 1_021)}...`
    const answered: WebPanePendingNote = {
      id: 1,
      revision: 2,
      pageUrl: 'https://example.com/review',
      selector: '#signals',
      tag: 'redline-choice',
      rect: { x: 0, y: 0, width: 0, height: 0 },
      comment: `Which signals?: ${displayAnswer}`,
      response: {
        question: 'Which signals?',
        answer: displayAnswer,
        data: { choice: choices, multiple: true },
      },
      attachments: [],
    }
    const update = vi.fn(async () => ({
      revision: 3,
      notes: [{ ...answered, revision: 3 }],
      knownUpTo: 1,
      dropped: 0,
    }))
    render(
      <TileReviewLayer
        webPaneId="w-compact-choice"
        pageUrl="https://example.com/review"
        reviewMode={false}
        active={false}
        containerRef={{ current: document.createElement('div') }}
        inputRef={{ current: document.createElement('div') }}
        pendingQueue={queue({ update })}
        surface={surface({
          subscribePending: (listener) => {
            publishPending = listener
            return () => { publishPending = undefined }
          },
        })}
      />,
    )
    await act(async () => { await Promise.resolve() })
    act(() => publishPending?.({ revision: 2, notes: [answered], knownUpTo: 1, dropped: 0 }))

    fireEvent.click(screen.getByRole('button', { name: 'Review queue · 1' }))
    expect(screen.getByRole('checkbox', { name: 'Pulse, Crest' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: longOption })).toBeChecked()
    fireEvent.change(screen.getByRole('textbox', { name: 'Optional note' }), {
      target: { value: 'Keep the comma label' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    await waitFor(() => expect(update).toHaveBeenCalledWith(1, 2, {
      response: expect.objectContaining({
        answer: displayAnswer,
        note: 'Keep the comma label',
        data: { choice: choices, multiple: true },
      }),
    }))
  })

  it('serializes question submissions while one answer is queueing', async () => {
    let publishQuestions: ((pageUrl: string, snapshot: RedlinePageQuestionSnapshot) => void) | undefined
    let resolveFirst: ((snapshot: WebPanePendingSnapshot) => void) | undefined
    const addResponse = vi.fn(() => new Promise<WebPanePendingSnapshot>((resolve) => {
      resolveFirst = resolve
    }))
    render(
      <TileReviewLayer
        webPaneId="w-question-concurrency"
        pageUrl="https://example.com/review"
        reviewMode={false}
        active={false}
        containerRef={{ current: document.createElement('div') }}
        inputRef={{ current: document.createElement('div') }}
        pendingQueue={queue({ addResponse })}
        surface={surface({
          subscribeQuestions: (listener) => {
            publishQuestions = listener
            return () => { publishQuestions = undefined }
          },
        })}
      />,
    )
    await act(async () => { await Promise.resolve() })
    act(() => publishQuestions?.('https://example.com/review', {
      type: 'questions',
      version: 1,
      questions: [
        { question: 'First?', queueKey: 'first', selector: '#first', kind: 'text' },
        { question: 'Second?', queueKey: 'second', selector: '#second', kind: 'text' },
      ],
    }))
    fireEvent.click(screen.getByRole('button', { name: 'Answer queue · 2' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Answer' }), { target: { value: 'One' } })
    fireEvent.click(screen.getByRole('button', { name: 'Queue answer' }))
    fireEvent.click(screen.getByRole('button', { name: /Second\?/ }))

    expect(screen.getByRole('textbox', { name: 'Answer' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Queueing…' })).toBeDisabled()
    expect(addResponse).toHaveBeenCalledOnce()

    await act(async () => resolveFirst?.(EMPTY_SNAPSHOT))
  })
})
