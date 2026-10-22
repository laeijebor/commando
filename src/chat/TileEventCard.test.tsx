// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ChatItem } from '../../shared/agent-chat'
import { tileEventMarker, withTileEvents, type ChatTileEvent } from '../../shared/chat-tile-events'
import { ChatTimeline } from './ChatTimeline'
import { TileEventCard } from './TileEventCard'

afterEach(cleanup)

const sent: ChatTileEvent = {
  id: 'te-1', kind: 'sent', paneId: '%1', webPaneId: 'w-1', source: 'redline', title: 'Notification settings', fileName: 'settings.html', at: 0,
  status: 'collected', collectedAt: 60_000,
  items: [
    { kind: 'answer', question: 'Which default?', answer: 'Digest daily', note: 'Only on weekdays' },
    { kind: 'comment', target: 'button “Save”', comment: 'Make it sticky', attachments: 2 },
  ],
}

describe('TileEventCard', () => {
  it('shows a one-line summary and expands to the answers', () => {
    const onOpenTile = vi.fn(() => true)
    render(<TileEventCard event={sent} onOpenTile={onOpenTile} />)
    const toggle = screen.getByRole('button', { name: /Redline on Notification settings/ })
    expect(toggle).toHaveTextContent('1 answer, 1 comment')
    expect(toggle).toHaveTextContent('Collected')
    expect(screen.queryByText('Digest daily')).not.toBeInTheDocument()
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('Digest daily')).toBeInTheDocument()
    expect(screen.getByText('Only on weekdays')).toBeInTheDocument()
    expect(screen.getByText('Make it sticky')).toBeInTheDocument()
    expect(screen.getByText('2 images attached')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Open tile' }))
    expect(onOpenTile).toHaveBeenCalledWith('w-1')
  })

  it('shows an opened canvas with its file name when there is no title', () => {
    render(<TileEventCard event={{ id: 'te-2', kind: 'opened', paneId: '%1', webPaneId: 'w-2', source: 'canvas', fileName: 'dashboard.canvas.json', at: 0 }} />)
    expect(screen.getByTestId('tile-event-card')).toHaveTextContent('Canvas opened · dashboard.canvas.json')
    expect(screen.queryByRole('button', { name: 'Open canvas' })).not.toBeInTheDocument()
  })
})

describe('ChatTimeline with tile events', () => {
  it('shows a pushed prompt as its card, not the raw text', () => {
    const pushed: ChatItem = { id: 'u1', kind: 'user_message', text: `Redline feedback on "Notification settings" (2 note(s))\n${tileEventMarker(['te-1'])}`, turnId: 't1', status: 'completed', createdAt: 1, updatedAt: 1 }
    render(<ChatTimeline items={withTileEvents([pushed], [sent])} cwd="/tmp" working={false} />)
    expect(screen.getByTestId('tile-event-card')).toHaveTextContent('Redline on Notification settings')
    expect(screen.queryByText(/commando-tile-event/)).not.toBeInTheDocument()
  })
})
