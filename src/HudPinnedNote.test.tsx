// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
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

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  window.localStorage.clear()
})

describe('HudPinnedNote', () => {
  it('renders Markdown and exposes open and unpin actions', () => {
    const onOpen = vi.fn()
    const onSave = vi.fn().mockResolvedValue(note)
    const onUnpin = vi.fn()
    render(<HudPinnedNote note={note} onOpen={onOpen} onSave={onSave} onUnpin={onUnpin} />)

    expect(screen.getByRole('region', { name: 'Pinned note: Release checklist' })).toBeVisible()
    expect(screen.getByText('Projects/Commando')).toBeVisible()
    expect(screen.getAllByRole('checkbox')).toHaveLength(2)
    expect(screen.getAllByRole('checkbox')[0]).toBeChecked()

    fireEvent.click(screen.getByRole('button', { name: 'Open in Notes' }))
    fireEvent.click(screen.getByRole('button', { name: 'Unpin note Release checklist' }))
    expect(onOpen).toHaveBeenCalledOnce()
    expect(onUnpin).toHaveBeenCalledOnce()
  })

  it('toggles in-place editing and autosaves the title and Markdown body', async () => {
    vi.useFakeTimers()
    const saved = {
      ...note,
      title: 'Updated checklist',
      body: '## Ready\n\n- [x] Ship it\n\n* Follow up',
      updatedAt: note.updatedAt + 1,
    }
    const onSave = vi.fn().mockResolvedValue(saved)
    render(<HudPinnedNote note={note} onOpen={vi.fn()} onSave={onSave} onUnpin={vi.fn()} />)

    expect(screen.queryByLabelText('Pinned note body')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Edit pinned note' }))
    fireEvent.change(screen.getByLabelText('Pinned note title'), { target: { value: saved.title } })
    fireEvent.change(screen.getByLabelText('Pinned note body'), { target: { value: saved.body } })
    expect(screen.getByText('Unsaved')).toBeVisible()

    await act(async () => {
      vi.advanceTimersByTime(650)
      await Promise.resolve()
    })

    expect(onSave).toHaveBeenCalledWith({ ...note, title: saved.title, body: saved.body })
    expect(screen.queryByText('Unsaved')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'View pinned note' }))
    expect(screen.getByText('Updated checklist')).toBeVisible()
    expect(screen.getByRole('heading', { name: 'Ready' })).toBeVisible()
    expect(screen.getByRole('checkbox')).toBeChecked()
  })

  it('keeps a failed edit visible and supports an explicit retry', async () => {
    const onSave = vi.fn()
      .mockRejectedValueOnce(new Error('Note changed outside Commando'))
      .mockResolvedValueOnce({ ...note, body: 'Retry me', updatedAt: note.updatedAt + 1 })
    render(<HudPinnedNote note={note} onOpen={vi.fn()} onSave={onSave} onUnpin={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Edit pinned note' }))
    fireEvent.change(screen.getByLabelText('Pinned note body'), { target: { value: 'Retry me' } })
    await act(async () => {
      fireEvent.keyDown(screen.getByLabelText('Pinned note body'), { key: 's', metaKey: true })
      await Promise.resolve()
    })

    expect(screen.getByRole('alert')).toHaveTextContent('Save failed: Note changed outside Commando')
    await act(async () => {
      fireEvent.keyDown(screen.getByLabelText('Pinned note body'), { key: 's', metaKey: true })
      await Promise.resolve()
    })
    expect(onSave).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('resizes with pointer and keyboard controls and restores the saved height', () => {
    const props = { note, onOpen: vi.fn(), onSave: vi.fn().mockResolvedValue(note), onUnpin: vi.fn() }
    const view = render(<HudPinnedNote {...props} />)
    const region = screen.getByRole('region', { name: 'Pinned note: Release checklist' })
    const handle = screen.getByRole('separator', { name: 'Resize pinned note height' })

    expect(region).toHaveStyle({ height: '260px' })
    fireEvent.keyDown(handle, { key: 'ArrowDown' })
    expect(region).toHaveStyle({ height: '268px' })
    expect(window.localStorage.getItem('commando.hud.pinned-note-height')).toBe('268')

    fireEvent.pointerDown(handle, { button: 0, clientY: 100 })
    fireEvent.pointerMove(window, { clientY: 180 })
    fireEvent.pointerUp(window)
    expect(region).toHaveStyle({ height: '348px' })
    expect(window.localStorage.getItem('commando.hud.pinned-note-height')).toBe('348')

    fireEvent.doubleClick(handle)
    expect(region).toHaveStyle({ height: '260px' })
    view.unmount()
    window.localStorage.setItem('commando.hud.pinned-note-height', '340')
    render(<HudPinnedNote {...props} />)
    expect(screen.getByRole('region', { name: 'Pinned note: Release checklist' })).toHaveStyle({ height: '340px' })
  })
})
