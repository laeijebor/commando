// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { HudPinnedNote } from './HudPinnedNote'
import type { PinnedNote } from './pinnedNote'

const note: PinnedNote = {
  vaultId: 'vault-1',
  id: 'note-1',
  title: 'Release checklist',
  body: '- [x] Typecheck\n- [ ] Browser verification',
  folder: 'Projects/Commando',
  updatedAt: 1_700_000_100_000,
}

afterEach(cleanup)

describe('HudPinnedNote', () => {
  it('renders Markdown and exposes open and unpin actions', () => {
    const onOpen = vi.fn()
    const onUnpin = vi.fn()
    render(<HudPinnedNote note={note} onOpen={onOpen} onUnpin={onUnpin} />)

    expect(screen.getByRole('region', { name: 'Pinned note: Release checklist' })).toBeVisible()
    expect(screen.getByText('Projects/Commando')).toBeVisible()
    expect(screen.getAllByRole('checkbox')).toHaveLength(2)
    expect(screen.getAllByRole('checkbox')[0]).toBeChecked()

    fireEvent.click(screen.getByRole('button', { name: 'Open in Notes' }))
    fireEvent.click(screen.getByRole('button', { name: 'Unpin note Release checklist' }))
    expect(onOpen).toHaveBeenCalledOnce()
    expect(onUnpin).toHaveBeenCalledOnce()
  })
})
