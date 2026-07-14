// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NoteVaultBrowseResult } from './notesApi'
import { VaultFolderPicker } from './VaultFolderPicker'

afterEach(cleanup)

const root: NoteVaultBrowseResult = {
  path: '/Users/test',
  parent: '/Users',
  home: '/Users/test',
  directories: [{ name: 'Documents', path: '/Users/test/Documents' }],
}

describe('VaultFolderPicker', () => {
  it('navigates daemon directories and opens the current folder', async () => {
    const child = { ...root, path: '/Users/test/Documents', parent: root.path, directories: [] }
    const browse = vi.fn(async (path?: string) => path === child.path ? child : root)
    const confirm = vi.fn()
    render(<VaultFolderPicker mode="open" initialPath={root.path} browse={browse} onCancel={vi.fn()} onConfirm={confirm} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Open folder Documents' }))
    await screen.findByText(child.path)
    fireEvent.click(screen.getByRole('button', { name: 'Open this folder' }))

    expect(confirm).toHaveBeenCalledWith(child.path, undefined)
  })

  it('creates a named vault inside the browsed folder', async () => {
    const confirm = vi.fn()
    render(<VaultFolderPicker mode="create" initialPath={root.path} browse={async () => root} onCancel={vi.fn()} onConfirm={confirm} />)
    await screen.findByText(root.path)
    const create = screen.getByRole('button', { name: 'Create vault here' })
    expect(create).toBeDisabled()

    fireEvent.change(screen.getByLabelText('New folder name'), { target: { value: 'work' } })
    await waitFor(() => expect(create).toBeEnabled())
    fireEvent.click(create)

    expect(confirm).toHaveBeenCalledWith(root.path, 'work')
  })

  it('does not confirm the previous directory after navigation fails', async () => {
    const browse = vi.fn(async (path?: string) => {
      if (path === root.directories[0].path) throw new Error('Permission denied')
      return root
    })
    const confirm = vi.fn()
    render(<VaultFolderPicker mode="open" initialPath={root.path} browse={browse} onCancel={vi.fn()} onConfirm={confirm} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Open folder Documents' }))
    await screen.findByRole('alert')

    expect(screen.getByRole('button', { name: 'Open this folder' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Open this folder' }))
    expect(confirm).not.toHaveBeenCalled()
  })
})
