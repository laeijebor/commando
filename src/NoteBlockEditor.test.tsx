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
  it('allows semantically equivalent Markdown to be canonicalized', async () => {
    render(
      <NoteBlockEditor
        markdown={`Paragraph before a list
- [x] Hyphen task marker

- [ ] Blank line within the list

${affectedMarkdown}`}
        onChange={vi.fn()}
        onSave={vi.fn()}
        uploadImage={vi.fn()}
        resolveImageUrl={(url) => url}
      />,
    )

    await waitFor(() => expect(screen.queryByText(/cannot preserve/)).not.toBeInTheDocument())
    expect(screen.getByLabelText('Note body')).toHaveAttribute('contenteditable', 'true')
  })

  it('compares Markdown structure rather than source formatting', () => {
    expect(comparableMarkdown('- [x] Verify')).toBe(comparableMarkdown('* [x] Verify'))
    expect(comparableMarkdown('Paragraph\n* [ ] Verify')).toBe(
      comparableMarkdown('Paragraph\n\n* [ ] Verify'),
    )
    expect(comparableMarkdown('* [x] First\n\n* [ ] Second')).toBe(
      comparableMarkdown('* [x] First\n* [ ] Second'),
    )
    expect(comparableMarkdown('Live\nLive ops\nBelts')).toBe(
      comparableMarkdown('Live\\\nLive ops\\\nBelts'),
    )
    expect(comparableMarkdown('- First\n\n* Second')).toBe(
      comparableMarkdown('* First\n* Second'),
    )
  })

  it('keeps soft-wrapped vault notes editable', async () => {
    render(
      <NoteBlockEditor
        markdown={`- [x] Social tab bar fix
- [ ] Bots

Live
Live ops
Belts
Consistent share mechanism`}
        onChange={vi.fn()}
        onSave={vi.fn()}
        uploadImage={vi.fn()}
        resolveImageUrl={(url) => url}
      />,
    )

    await waitFor(() => expect(screen.queryByText(/cannot preserve/)).not.toBeInTheDocument())
    expect(screen.getByLabelText('Note body')).toHaveAttribute('contenteditable', 'true')
  })

  it('keeps blank-separated unordered lists with different markers editable', async () => {
    render(
      <NoteBlockEditor
        markdown={'- [ ] Task one\n- Note two\n\n* Live power ups\n* Live battles'}
        onChange={vi.fn()}
        onSave={vi.fn()}
        uploadImage={vi.fn()}
        resolveImageUrl={(url) => url}
      />,
    )

    await waitFor(() => expect(screen.queryByText(/cannot preserve/)).not.toBeInTheDocument())
    expect(screen.getByLabelText('Note body')).toHaveAttribute('contenteditable', 'true')
  })

  it('keeps GFM tables editable', async () => {
    render(
      <NoteBlockEditor
        markdown={'| Project | Status |\n| --- | --- |\n| Commando | Safe |'}
        onChange={vi.fn()}
        onSave={vi.fn()}
        uploadImage={vi.fn()}
        resolveImageUrl={(url) => url}
      />,
    )

    await waitFor(() => expect(screen.queryByText(/cannot preserve/)).not.toBeInTheDocument())
    expect(screen.getByLabelText('Note body')).toHaveAttribute('contenteditable', 'true')
  })

  it('keeps genuinely lossy raw HTML read-only', async () => {
    render(
      <NoteBlockEditor
        markdown={'Keep <u>underlining</u>'}
        onChange={vi.fn()}
        onSave={vi.fn()}
        uploadImage={vi.fn()}
        resolveImageUrl={(url) => url}
      />,
    )

    expect(await screen.findByText(/cannot preserve/)).toBeVisible()
    expect(screen.getByLabelText('Note body')).toHaveAttribute('contenteditable', 'false')
  })

  it('does not ignore whitespace inside fenced code', () => {
    expect(comparableMarkdown('```txt\na\n\n\nb\n```')).not.toBe(
      comparableMarkdown('```txt\na\n\nb\n```'),
    )
  })
})
