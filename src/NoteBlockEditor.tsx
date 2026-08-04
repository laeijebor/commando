import {
  BlockNoteSchema,
  defaultBlockSpecs,
  defaultInlineContentSpecs,
  defaultStyleSpecs,
} from '@blocknote/core'
import { BlockNoteView } from '@blocknote/ariakit'
import { useCreateBlockNote } from '@blocknote/react'
import { useEffect, useRef, useState } from 'react'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
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

const markdownParser = unified().use(remarkParse).use(remarkGfm)

export function comparableMarkdown(markdown: string): string {
  return JSON.stringify(markdownParser.parse(markdown), (key, value) => (
    key === 'position' || key === 'spread' ? undefined : value
  ))
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
