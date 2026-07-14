// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
  folder: '',
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_100_000,
}

const vaultState = {
  activeVaultId: 'vault-1',
  vaults: [{ id: 'vault-1', name: 'default', path: '/tmp/default', lastOpenedAt: 1, available: true }],
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('NotesSection', () => {
  it('saves Markdown with an optimistic-concurrency timestamp', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input)
      if (url === '/api/note-vaults' && !init?.method) return Response.json(vaultState)
      if (url === '/api/notes?vault=vault-1' && !init?.method) return Response.json({ notes: [original], folders: [] })
      if (url.includes(`/api/notes/${original.id}?vault=vault-1`) && init?.method === 'PUT') {
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
      `/api/notes/${original.id}?vault=vault-1`,
      expect.objectContaining({ method: 'PUT' }),
    )
  })

  it('offers an explicit reload when an external edit conflicts', async () => {
    const external = { ...original, body: 'Edited in Obsidian', updatedAt: original.updatedAt + 5_000 }
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input)
      if (url === '/api/note-vaults' && !init?.method) return Response.json(vaultState)
      if (url === '/api/notes?vault=vault-1' && !init?.method) return Response.json({ notes: [original], folders: [] })
      if (url.includes(`/api/notes/${original.id}?vault=vault-1`) && init?.method === 'PUT') {
        return Response.json({ error: 'Note changed outside Commando' }, { status: 409 })
      }
      if (url.includes(`/api/notes/${original.id}?vault=vault-1`) && !init?.method) return Response.json({ note: external })
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
      if (url === '/api/note-vaults' && !init?.method) return Response.json(vaultState)
      if (url === '/api/notes?vault=vault-1' && !init?.method) return Response.json({ notes: [original], folders: [] })
      if (url.includes(`/api/notes/${original.id}?vault=vault-1`) && init?.method === 'PUT') {
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
    expect(fetcher).toHaveBeenCalledTimes(4)
  })

  it('renames the note targeted by the context menu', async () => {
    const other = { ...original, id: 'other-note', title: 'Other note', updatedAt: original.updatedAt + 1 }
    const prompt = vi.spyOn(window, 'prompt').mockReturnValue('Renamed note')
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input)
      if (url === '/api/note-vaults' && !init?.method) return Response.json(vaultState)
      if (url === '/api/notes?vault=vault-1' && !init?.method) return Response.json({ notes: [original, other], folders: [] })
      if (url.includes(`/api/notes/${other.id}?vault=vault-1`) && init?.method === 'PUT') {
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
      `/api/notes/${other.id}?vault=vault-1`,
      expect.objectContaining({ method: 'PUT' }),
    )
    expect(screen.getByLabelText('Note title')).toHaveValue(original.title)
  })

  it('deletes the note targeted by the context menu', async () => {
    const other = { ...original, id: 'other-note', title: 'Other note', updatedAt: original.updatedAt + 1 }
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input)
      if (url === '/api/note-vaults' && !init?.method) return Response.json(vaultState)
      if (url === '/api/notes?vault=vault-1' && !init?.method) return Response.json({ notes: [original, other], folders: [] })
      if (url.includes(`/api/notes/${other.id}?vault=vault-1`) && init?.method === 'DELETE') {
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
      `/api/notes/${other.id}?vault=vault-1`,
      expect.objectContaining({ method: 'DELETE' }),
    )
    expect(screen.getByLabelText('Note title')).toHaveValue(original.title)
  })

  it('creates folders and creates notes in the selected folder', async () => {
    const prompt = vi.spyOn(window, 'prompt').mockReturnValue('Projects/Commando')
    const created = { ...original, id: 'created-note', title: 'Untitled note', folder: 'Projects/Commando', updatedAt: original.updatedAt + 1 }
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input)
      if (url === '/api/note-vaults' && !init?.method) return Response.json(vaultState)
      if (url === '/api/notes?vault=vault-1' && !init?.method) return Response.json({ notes: [original], folders: [] })
      if (url === '/api/notes/folders?vault=vault-1' && init?.method === 'POST') {
        expect(JSON.parse(String(init.body))).toEqual({ folder: 'Projects/Commando' })
        return Response.json({ folders: ['Projects', 'Projects/Commando'] }, { status: 201 })
      }
      if (url === '/api/notes?vault=vault-1' && init?.method === 'POST') {
        expect(JSON.parse(String(init.body))).toMatchObject({ folder: 'Projects/Commando' })
        return Response.json({ note: created }, { status: 201 })
      }
      return Response.json({ error: 'Unexpected request' }, { status: 500 })
    })

    render(<NotesSection token="test-token" />)
    await screen.findByLabelText('Note body')
    fireEvent.click(screen.getByLabelText('Create folder'))
    const folder = await screen.findByRole('button', { name: /Commando/ })
    expect(folder).toHaveClass('active')
    fireEvent.click(screen.getByLabelText('Create note'))

    await waitFor(() => expect(screen.getByLabelText('Note title')).toHaveValue('Untitled note'))
    expect(screen.getAllByText('Projects/Commando')).not.toHaveLength(0)
    expect(prompt).toHaveBeenCalledWith('New folder path', '')
  })

  it('switches to a persisted vault and loads its notes', async () => {
    const otherVault = { id: 'vault-2', name: 'work', path: '/tmp/work', lastOpenedAt: 2, available: true }
    const nextVaultState = { activeVaultId: 'vault-2', vaults: [otherVault, ...vaultState.vaults] }
    const otherNote = { ...original, id: 'work-note', title: 'Work note', folder: 'Projects' }
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input)
      if (url === '/api/note-vaults' && !init?.method) return Response.json({ ...vaultState, vaults: [...vaultState.vaults, otherVault] })
      if (url === '/api/notes?vault=vault-1' && !init?.method) return Response.json({ notes: [original], folders: [] })
      if (url === '/api/note-vaults/active' && init?.method === 'PUT') {
        expect(JSON.parse(String(init.body))).toEqual({ id: 'vault-2' })
        return Response.json(nextVaultState)
      }
      if (url === '/api/notes?vault=vault-2' && !init?.method) return Response.json({ notes: [otherNote], folders: ['Projects'] })
      return Response.json({ error: 'Unexpected request' }, { status: 500 })
    })

    render(<NotesSection token="test-token" />)
    await screen.findByLabelText('Note body')
    fireEvent.change(screen.getByLabelText('Note vault'), { target: { value: 'vault-2' } })

    await waitFor(() => expect(screen.getByLabelText('Note title')).toHaveValue('Work note'))
    expect(screen.getByLabelText('Note vault')).toHaveValue('vault-2')
    expect(screen.getByTitle('Projects')).toBeVisible()
  })

  it('opens a browsed vault without asking for a filesystem path', async () => {
    const otherVault = { id: 'vault-2', name: 'work', path: '/tmp/default/work', lastOpenedAt: 2, available: true }
    const nextVaultState = { activeVaultId: 'vault-2', vaults: [otherVault, ...vaultState.vaults] }
    const otherNote = { ...original, id: 'work-note', title: 'Work note' }
    const prompt = vi.spyOn(window, 'prompt')
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input)
      if (url === '/api/note-vaults' && !init?.method) return Response.json(vaultState)
      if (url === '/api/notes?vault=vault-1' && !init?.method) return Response.json({ notes: [original], folders: [] })
      if (url === '/api/note-vaults/browse?path=%2Ftmp%2Fdefault' && !init?.method) {
        return Response.json({ path: '/tmp/default', parent: '/tmp', home: '/tmp', directories: [{ name: 'work', path: otherVault.path }] })
      }
      if (url === `/api/note-vaults/browse?path=${encodeURIComponent(otherVault.path)}` && !init?.method) {
        return Response.json({ path: otherVault.path, parent: '/tmp/default', home: '/tmp', directories: [] })
      }
      if (url === '/api/note-vaults/open' && init?.method === 'POST') {
        expect(JSON.parse(String(init.body))).toEqual({ path: otherVault.path })
        return Response.json(nextVaultState)
      }
      if (url === '/api/notes?vault=vault-2' && !init?.method) return Response.json({ notes: [otherNote], folders: [] })
      return Response.json({ error: 'Unexpected request' }, { status: 500 })
    })

    render(<NotesSection token="test-token" />)
    await screen.findByLabelText('Note body')
    fireEvent.click(screen.getByLabelText('Open vault'))
    fireEvent.click(await screen.findByRole('button', { name: 'Open folder work' }))
    await screen.findByText(otherVault.path)
    fireEvent.click(screen.getByRole('button', { name: 'Open this folder' }))

    await waitFor(() => expect(screen.getByLabelText('Note title')).toHaveValue('Work note'))
    expect(fetcher).toHaveBeenCalledWith('/api/note-vaults/open', expect.objectContaining({ method: 'POST' }))
    expect(prompt).not.toHaveBeenCalled()
  })

  it('can leave a vault that fails to load', async () => {
    const otherVault = { id: 'vault-2', name: 'healthy', path: '/tmp/healthy', lastOpenedAt: 2, available: true }
    const bothVaults = { activeVaultId: 'vault-1', vaults: [...vaultState.vaults, otherVault] }
    const healthyState = { activeVaultId: 'vault-2', vaults: [otherVault, ...vaultState.vaults] }
    const healthyNote = { ...original, id: 'healthy-note', title: 'Healthy note' }
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input)
      if (url === '/api/note-vaults' && !init?.method) return Response.json(bothVaults)
      if (url === '/api/notes?vault=vault-1' && !init?.method) return Response.json({ error: 'Corrupt vault' }, { status: 500 })
      if (url === '/api/note-vaults/active' && init?.method === 'PUT') return Response.json(healthyState)
      if (url === '/api/notes?vault=vault-2' && !init?.method) return Response.json({ notes: [healthyNote], folders: [] })
      return Response.json({ error: 'Unexpected request' }, { status: 500 })
    })

    render(<NotesSection token="test-token" />)
    await screen.findByText('Corrupt vault')
    fireEvent.change(screen.getByLabelText('Note vault'), { target: { value: 'vault-2' } })

    await waitFor(() => expect(screen.getByLabelText('Note title')).toHaveValue('Healthy note'))
    expect(screen.queryByText('Corrupt vault')).not.toBeInTheDocument()
  })

  it('does not treat a continuously edited draft as an external conflict', async () => {
    vi.useFakeTimers()
    try {
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        const url = String(input)
        if (url === '/api/note-vaults' && !init?.method) return Response.json(vaultState)
        if (url === '/api/notes?vault=vault-1' && !init?.method) return Response.json({ notes: [original], folders: [] })
        return Response.json({ error: 'Unexpected request' }, { status: 500 })
      })

      render(<NotesSection token="test-token" />)
      await act(async () => undefined)
      const body = screen.getByLabelText('Note body')
      for (let index = 0; index < 6; index += 1) {
        fireEvent.change(body, { target: { value: `Local draft ${index}` } })
        await act(async () => { vi.advanceTimersByTime(500) })
      }
      await act(async () => undefined)

      expect(screen.queryByText(/changed in Obsidian/)).not.toBeInTheDocument()
      expect(body).toHaveValue('Local draft 5')
    } finally {
      vi.useRealTimers()
    }
  })
})
