import { parse, stringify } from 'yaml'
import type { Note } from './notes.js'

const FRONTMATTER_FENCE = '---'
const NOTE_FILE_SUFFIX = '.md'

type NoteFrontmatter = {
  commando_id?: unknown
  title?: unknown
  created?: unknown
  updated?: unknown
}

function timestamp(value: unknown): number | null {
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value
  if (typeof value !== 'string') return null
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? null : parsed
}

/** Parses only Commando-owned Markdown and leaves unrelated vault files alone. */
export function parseNoteMarkdown(content: string): unknown | null {
  const normalized = content.replaceAll('\r\n', '\n')
  if (!normalized.startsWith(`${FRONTMATTER_FENCE}\n`)) return null

  const closingFence = normalized.indexOf(`\n${FRONTMATTER_FENCE}\n`, FRONTMATTER_FENCE.length + 1)
  if (closingFence < 0) return null

  const frontmatterSource = normalized.slice(FRONTMATTER_FENCE.length + 1, closingFence)
  if (!/^commando_id\s*:/m.test(frontmatterSource)) return null
  const frontmatter = parse(frontmatterSource) as NoteFrontmatter | null
  if (!frontmatter || typeof frontmatter !== 'object' || !('commando_id' in frontmatter)) return null

  return {
    id: frontmatter.commando_id,
    title: frontmatter.title,
    body: normalized.slice(closingFence + FRONTMATTER_FENCE.length + 2),
    createdAt: timestamp(frontmatter.created),
    updatedAt: timestamp(frontmatter.updated),
  }
}

export function serializeNoteMarkdown(note: Note): string {
  const frontmatter = stringify(
    {
      commando_id: note.id,
      title: note.title,
      created: new Date(note.createdAt).toISOString(),
      updated: new Date(note.updatedAt).toISOString(),
    },
    { lineWidth: 0 },
  )
  return `${FRONTMATTER_FENCE}\n${frontmatter}${FRONTMATTER_FENCE}\n${note.body}`
}

export function isMarkdownNoteFile(name: string): boolean {
  return !name.startsWith('.') && name.endsWith(NOTE_FILE_SUFFIX)
}

export function noteFileName(note: Pick<Note, 'id' | 'title'>): string {
  const slug = note.title
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'untitled-note'
  return `${slug}--${note.id}${NOTE_FILE_SUFFIX}`
}
