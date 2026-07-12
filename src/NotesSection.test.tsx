// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Note } from './notesApi'
import { NotesSection } from './NotesSection'

vi.mock('./NoteBlockEditor', () => ({
  NoteBlockEditor: ({
    markdown,
    onChange,
    onSave,
  }: {
    markdown: string
    onChange(markdown: string): void
    onSave(): void
  }) => (
    <>
      <textarea aria-label="Note body" value={markdown} onChange={(event) => onChange(event.target.value)} />
      <button type="button" onClick={onSave}>Save body</button>
    </>
  ),
}))

const original: Note = {
  id: '71cf1432-e39e-4ac1-a1d8-51185f94dbce',
  title: 'Vault note',
  body: '# Original',
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_100_000,
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('NotesSection', () => {
  it('saves Markdown with an optimistic-concurrency timestamp', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input)
      if (url === '/api/notes' && !init?.method) return Response.json({ notes: [original] })
      if (url.endsWith(original.id) && init?.method === 'PUT') {
        const update = JSON.parse(String(init.body)) as Record<string, unknown>
        expect(update).toMatchObject({
          title: original.title,
          body: '## Edited',
          expectedUpdatedAt: original.updatedAt,
        })
        return Response.json({ note: { ...original, ...update, updatedAt: original.updatedAt + 1 } })
      }
      return Response.json({ error: 'Unexpected request' }, { status: 500 })
    })

    render(<NotesSection token="test-token" />)
    const body = await screen.findByLabelText('Note body')
    fireEvent.change(body, { target: { value: '## Edited' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save body' }))

    await waitFor(() => expect(screen.getByText('Saved to vault')).toBeVisible())
    expect(fetcher).toHaveBeenCalledWith(
      `/api/notes/${original.id}`,
      expect.objectContaining({ method: 'PUT' }),
    )
  })

  it('offers an explicit reload when an external edit conflicts', async () => {
    const external = { ...original, body: 'Edited in Obsidian', updatedAt: original.updatedAt + 5_000 }
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input)
      if (url === '/api/notes' && !init?.method) return Response.json({ notes: [original] })
      if (url.endsWith(original.id) && init?.method === 'PUT') {
        return Response.json({ error: 'Note changed outside Commando' }, { status: 409 })
      }
      if (url.endsWith(original.id) && !init?.method) return Response.json({ note: external })
      return Response.json({ error: 'Unexpected request' }, { status: 500 })
    })

    render(<NotesSection token="test-token" />)
    const body = await screen.findByLabelText('Note body')
    fireEvent.change(body, { target: { value: 'Local edit' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save body' }))

    await screen.findByText(/changed in Obsidian/)
    fireEvent.click(screen.getByRole('button', { name: /Reload/ }))
    await waitFor(() => expect(screen.getByLabelText('Note body')).toHaveValue('Edited in Obsidian'))
  })

  it('flushes the newest edit after an in-flight save when the section unmounts', async () => {
    let finishFirstSave: (() => void) | undefined
    let updateCount = 0
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input)
      if (url === '/api/notes' && !init?.method) return Response.json({ notes: [original] })
      if (url.endsWith(original.id) && init?.method === 'PUT') {
        updateCount += 1
        const update = JSON.parse(String(init.body)) as { body: string; expectedUpdatedAt: number }
        if (updateCount === 1) {
          expect(update.body).toBe('First edit')
          await new Promise<void>((resolve) => { finishFirstSave = resolve })
          return Response.json({ note: { ...original, ...update, updatedAt: original.updatedAt + 1 } })
        }
        expect(update).toMatchObject({
          body: 'Newest edit',
          expectedUpdatedAt: original.updatedAt + 1,
        })
        return Response.json({ note: { ...original, ...update, updatedAt: original.updatedAt + 2 } })
      }
      return Response.json({ error: 'Unexpected request' }, { status: 500 })
    })

    const view = render(<NotesSection token="test-token" />)
    const body = await screen.findByLabelText('Note body')
    fireEvent.change(body, { target: { value: 'First edit' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save body' }))
    await waitFor(() => expect(updateCount).toBe(1))
    fireEvent.change(body, { target: { value: 'Newest edit' } })
    view.unmount()
    finishFirstSave?.()

    await waitFor(() => expect(updateCount).toBe(2))
    expect(fetcher).toHaveBeenCalledTimes(3)
  })

  it('renames the note targeted by the context menu', async () => {
    const other = { ...original, id: 'other-note', title: 'Other note', updatedAt: original.updatedAt + 1 }
    const prompt = vi.spyOn(window, 'prompt').mockReturnValue('Renamed note')
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input)
      if (url === '/api/notes' && !init?.method) return Response.json({ notes: [original, other] })
      if (url.endsWith(other.id) && init?.method === 'PUT') {
        const update = JSON.parse(String(init.body)) as Record<string, unknown>
        expect(update).toMatchObject({
          title: 'Renamed note',
          body: original.body,
          expectedUpdatedAt: other.updatedAt,
        })
        return Response.json({ note: { ...other, ...update, updatedAt: other.updatedAt + 1 } })
      }
      return Response.json({ error: 'Unexpected request' }, { status: 500 })
    })

    render(<NotesSection token="test-token" />)
    const note = await screen.findByRole('button', { name: /Other note/ })
    fireEvent.contextMenu(note, { clientX: 120, clientY: 160 })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }))

    await screen.findByRole('button', { name: /Renamed note/ })
    expect(prompt).toHaveBeenCalledWith('Rename note', 'Other note')
    expect(fetcher).toHaveBeenCalledWith(
      `/api/notes/${other.id}`,
      expect.objectContaining({ method: 'PUT' }),
    )
    expect(screen.getByLabelText('Note title')).toHaveValue(original.title)
  })

  it('deletes the note targeted by the context menu', async () => {
    const other = { ...original, id: 'other-note', title: 'Other note', updatedAt: original.updatedAt + 1 }
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input)
      if (url === '/api/notes' && !init?.method) return Response.json({ notes: [original, other] })
      if (url.endsWith(other.id) && init?.method === 'DELETE') {
        expect(new Headers(init.headers).get('If-Match')).toBe(`"${other.updatedAt}"`)
        return new Response(null, { status: 204 })
      }
      return Response.json({ error: 'Unexpected request' }, { status: 500 })
    })

    render(<NotesSection token="test-token" />)
    const note = await screen.findByRole('button', { name: /Other note/ })
    fireEvent.contextMenu(note, { clientX: 120, clientY: 160 })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete note' }))

    await waitFor(() => expect(screen.queryByRole('button', { name: /Other note/ })).not.toBeInTheDocument())
    expect(confirm).toHaveBeenCalledWith('Delete note “Other note”?')
    expect(fetcher).toHaveBeenCalledWith(
      `/api/notes/${other.id}`,
      expect.objectContaining({ method: 'DELETE' }),
    )
    expect(screen.getByLabelText('Note title')).toHaveValue(original.title)
  })
})
