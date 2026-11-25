// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BoardItemKind } from '../shared/board'
import { BoardCard, BoardStateChip } from './BoardCards'
import type { BoardEntry } from './BoardGeometry'

const item: BoardEntry = { key: 'url:a', kind: 'link', title: 'Reference', source: 'agent', state: 'open', ref: {}, addedAt: 1, updatedAt: 1 }
afterEach(cleanup)

describe('Board kind-specific cards', () => {
  it.each(['canvas', 'slides', 'guide', 'redline', 'page'] as const)('shows lifecycle chips for %s tiles', (kind) => {
    const view = render(<BoardStateChip item={{ ...item, kind }} />)
    expect(view.container).toHaveTextContent('Open')
    for (const [state, label] of [['closed', 'Closed (revive)'], ['snapshot', 'Snapshot'], ['missing', 'Gone']] as const) {
      view.rerender(<BoardStateChip item={{ ...item, kind, state }} />)
      expect(view.container).toHaveTextContent(label)
    }
  })
  it.each(['file', 'screenshot', 'video'] as const)('shows only Missing for %s files', (kind) => {
    const view = render(<BoardStateChip item={{ ...item, kind }} />)
    expect(view.container).toBeEmptyDOMElement()
    for (const state of ['closed', 'snapshot'] as const) {
      view.rerender(<BoardStateChip item={{ ...item, kind, state }} />)
      expect(view.container).toBeEmptyDOMElement()
    }
    view.rerender(<BoardStateChip item={{ ...item, kind, state: 'missing' }} />)
    expect(view.container).toHaveTextContent('Missing')
  })
  it.each(['link', 'clip', 'pr', 'diagram'] as const)('never shows lifecycle chips for %s', (kind: BoardItemKind) => {
    const view = render(<BoardStateChip item={{ ...item, kind }} />)
    for (const state of ['open', 'closed', 'snapshot', 'missing'] as const) {
      view.rerender(<BoardStateChip item={{ ...item, kind, state }} />)
      expect(view.container).toBeEmptyDOMElement()
    }
  })
  it.each(['decision', 'gotcha', 'note'] as const)('renders a %s clipping once as quoted text and provenance', (tone) => {
    const { container } = render(<BoardCard item={{ ...item, kind: 'clip', tone, title: 'Keep the oldest id', caption: 'Keep the oldest id' }} thumbUrl={() => '/unused'} onOpen={vi.fn()} />)
    expect(container.querySelector('.board-clip-text')).toHaveAttribute('data-tone', tone)
    expect(container.querySelector('blockquote')).toHaveTextContent('Keep the oldest id')
    expect(container.querySelector('cite')).toHaveTextContent(`${tone} · agent ·`)
    expect(container.textContent?.match(/Keep the oldest id/g)).toHaveLength(1)
    expect(container.querySelector('.board-preview, img, svg, .board-card-meta')).toBeNull()
  })
})
