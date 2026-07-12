import {
  BlockNoteSchema,
  defaultBlockSpecs,
  defaultInlineContentSpecs,
  defaultStyleSpecs,
} from '@blocknote/core'
import { BlockNoteView } from '@blocknote/ariakit'
import { useCreateBlockNote } from '@blocknote/react'
import { useEffect, useRef, useState } from 'react'
import '@blocknote/ariakit/style.css'

const markdownSchema = BlockNoteSchema.create({
  blockSpecs: {
    paragraph: defaultBlockSpecs.paragraph,
    heading: defaultBlockSpecs.heading,
    bulletListItem: defaultBlockSpecs.bulletListItem,
    numberedListItem: defaultBlockSpecs.numberedListItem,
    checkListItem: defaultBlockSpecs.checkListItem,
    quote: defaultBlockSpecs.quote,
    codeBlock: defaultBlockSpecs.codeBlock,
    divider: defaultBlockSpecs.divider,
  },
  inlineContentSpecs: defaultInlineContentSpecs,
  styleSpecs: {
    bold: defaultStyleSpecs.bold,
    italic: defaultStyleSpecs.italic,
    strike: defaultStyleSpecs.strike,
    code: defaultStyleSpecs.code,
  },
})

type NoteBlockEditorProps = {
  markdown: string
  onChange(markdown: string): void
  onSave(): void
}

function comparableMarkdown(markdown: string): string {
  return markdown.replaceAll('\r\n', '\n').replace(/\n+$/, '')
}

export function NoteBlockEditor({
  markdown,
  onChange,
  onSave,
}: NoteBlockEditorProps) {
  const applyingMarkdown = useRef(false)
  const lastEmittedMarkdown = useRef<string | null>(null)
  const [compatible, setCompatible] = useState(true)
  const editor = useCreateBlockNote({
    schema: markdownSchema,
    domAttributes: {
      editor: {
        'aria-label': 'Note body',
        'aria-multiline': 'true',
      },
    },
  })

  useEffect(() => {
    if (lastEmittedMarkdown.current === markdown) return
    applyingMarkdown.current = true
    editor.replaceBlocks(editor.document, editor.tryParseMarkdownToBlocks(markdown))
    const canonical = editor.blocksToMarkdownLossy(editor.document)
    const nextCompatible = comparableMarkdown(markdown) === comparableMarkdown(canonical)
    lastEmittedMarkdown.current = canonical
    setCompatible(nextCompatible)
    applyingMarkdown.current = false
  }, [editor, markdown])

  return (
    <div className="notes-block-editor-shell">
      {!compatible ? (
        <div className="notes-markdown-warning" role="status">
          This note contains Markdown that the block editor cannot preserve. Edit the body in Obsidian; Commando will keep it unchanged.
        </div>
      ) : null}
      <BlockNoteView
        className="notes-block-editor"
        editor={editor}
        editable={compatible}
        theme="dark"
        onChange={() => {
          if (applyingMarkdown.current || !compatible) return
          const next = editor.blocksToMarkdownLossy(editor.document)
          if (next === lastEmittedMarkdown.current) return
          lastEmittedMarkdown.current = next
          onChange(next)
        }}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
            event.preventDefault()
            onSave()
          }
        }}
      />
    </div>
  )
}
