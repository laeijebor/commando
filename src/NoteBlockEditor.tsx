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
    image: defaultBlockSpecs.image,
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
  uploadImage(file: File): Promise<string>
  resolveImageUrl(url: string): string
}

export function comparableMarkdown(markdown: string): string {
  const comparable: string[] = []
  let fence: { marker: string; length: number } | null = null
  let previousWasBlank = false

  for (const line of markdown.replaceAll('\r\n', '\n').split('\n')) {
    if (fence) {
      comparable.push(line)
      const closing = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line)
      if (closing && closing[1][0] === fence.marker && closing[1].length >= fence.length) fence = null
      continue
    }

    const opening = /^ {0,3}(`{3,}|~{3,})/.exec(line)
    if (opening) {
      comparable.push(line)
      fence = { marker: opening[1][0], length: opening[1].length }
      previousWasBlank = false
      continue
    }

    const normalized = /^[ \t]*$/.test(line)
      ? ''
      : line.endsWith(' ') && !line.endsWith('  ')
        ? line.slice(0, -1)
        : line
    if (normalized) {
      comparable.push(normalized)
      previousWasBlank = false
    } else if (!previousWasBlank && comparable.length) {
      comparable.push('')
      previousWasBlank = true
    }
  }

  while (comparable.at(-1) === '') comparable.pop()
  return comparable.join('\n')
}

export function NoteBlockEditor({
  markdown,
  onChange,
  onSave,
  uploadImage,
  resolveImageUrl,
}: NoteBlockEditorProps) {
  const applyingMarkdown = useRef(false)
  const lastEmittedMarkdown = useRef<string | null>(null)
  const uploadImageRef = useRef(uploadImage)
  const resolveImageUrlRef = useRef(resolveImageUrl)
  const [compatible, setCompatible] = useState(true)
  const [uploadError, setUploadError] = useState('')
  uploadImageRef.current = uploadImage
  resolveImageUrlRef.current = resolveImageUrl
  const editor = useCreateBlockNote({
    schema: markdownSchema,
    uploadFile: async (file) => {
      setUploadError('')
      try {
        return await uploadImageRef.current(file)
      } catch (cause) {
        setUploadError(cause instanceof Error ? cause.message : 'Unable to upload image')
        throw cause
      }
    },
    resolveFileUrl: async (url) => resolveImageUrlRef.current(url),
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
      {uploadError ? <div className="notes-image-error" role="alert">{uploadError}</div> : null}
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
