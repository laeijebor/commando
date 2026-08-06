// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { WebPane } from '../shared/protocol'
import { WebPaneCard } from './WebPaneCard'

afterEach(() => cleanup())

const webPane: WebPane = {
  id: 'w-0badcafe',
  url: 'http://localhost:5173/plan',
  sessionId: '$1',
  windowId: '@3',
  anchorPaneId: '%12',
  placement: 'right',
  engine: 'webkit',
  openedBy: 'user',
  status: 'open',
  createdAt: Date.now(),
}

describe('WebPaneCard dragging', () => {
  it('makes the header draggable and forwards drag start/end', () => {
    const onDragStart = vi.fn()
    const onDragEnd = vi.fn()
    render(
      <WebPaneCard
        webPane={webPane}
        onClose={() => undefined}
        onConfirm={() => undefined}
        wsToken=""
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
      />,
    )

    const header = screen.getByTitle('Drag onto a terminal pane to move this tile')
    expect(header).toHaveAttribute('draggable', 'true')
    fireEvent.dragStart(header)
    expect(onDragStart).toHaveBeenCalledTimes(1)
    fireEvent.dragEnd(header)
    expect(onDragEnd).toHaveBeenCalledTimes(1)
  })

  it('is not draggable without a drag handler', () => {
    render(
      <WebPaneCard
        webPane={webPane}
        onClose={() => undefined}
        onConfirm={() => undefined}
        wsToken=""
      />,
    )
    expect(document.querySelector('.web-pane-head')).toHaveAttribute('draggable', 'false')
  })
})
