// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { comparableMarkdown, NoteBlockEditor } from './NoteBlockEditor'

const affectedMarkdown = `## Sessions

* [ ] Support creating / closing panes & windows
* [ ] Support reordering the groups in the session tree
* [x] Significantly wasted space in the chrome



# Notes

* [ ] Support organising notes into folders
* [ ] Support choosing which "vault" (markdown directory) to use. 
  * [ ] Persist the previously chosen directories with the option to clear history.
  * [ ] Open the most recently used directory by default. 
  * [ ] Support creating new ones`

afterEach(cleanup)

describe('NoteBlockEditor Markdown compatibility', () => {
  it('allows insignificant blank lines and single trailing spaces to be normalized', async () => {
    render(
      <NoteBlockEditor
        markdown={affectedMarkdown}
        onChange={vi.fn()}
        onSave={vi.fn()}
        uploadImage={vi.fn()}
        resolveImageUrl={(url) => url}
      />,
    )

    await waitFor(() => expect(screen.queryByText(/cannot preserve/)).not.toBeInTheDocument())
    expect(screen.getByLabelText('Note body')).toHaveAttribute('contenteditable', 'true')
  })

  it('keeps unsupported tables read-only', async () => {
    render(
      <NoteBlockEditor
        markdown={'| Project | Status |\n| --- | --- |\n| Commando | Safe |'}
        onChange={vi.fn()}
        onSave={vi.fn()}
        uploadImage={vi.fn()}
        resolveImageUrl={(url) => url}
      />,
    )

    expect(await screen.findByText(/cannot preserve/)).toBeVisible()
    expect(screen.getByLabelText('Note body')).toHaveAttribute('contenteditable', 'false')
  })

  it('does not ignore hard breaks or whitespace inside fenced code', () => {
    expect(comparableMarkdown('first line  \nsecond line')).not.toBe(
      comparableMarkdown('first line\nsecond line'),
    )
    expect(comparableMarkdown('```txt\na\n\n\nb\n```')).not.toBe(
      comparableMarkdown('```txt\na\n\nb\n```'),
    )
  })
})
