import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified } from 'unified'

import { GUIDE_STEP_ID, type GuideChange, type GuideDelivered, type GuideMark, type GuideOutline, type GuideSnapshot, type GuideStep } from './guide-types.js'

export * from './guide-types.js'

export function guideRelativePath(value: unknown): string | null {
  if (typeof value !== 'string' || !/\.(md|markdown)$/i.test(value) || /[\\\0?#%]/.test(value) || value.startsWith('/') || /^[a-z][a-z\d+.-]*:/i.test(value)) return null
  const parts = value.split('/')
  if (parts.includes('..')) return null
  return parts.filter((part) => part && part !== '.').join('/') || null
}

type Node = { type: string; value?: string; children?: Node[]; checked?: boolean | null; depth?: number; position?: { start: { offset?: number } } }

const EXPLICIT_ID = /\s*\{#([A-Za-z0-9][A-Za-z0-9_-]{0,63})\}\s*$/
const CHECKPOINT_OPEN = /<checkpoint\b([^>]*)>/i
const CHECKPOINT_CLOSE = /<\/checkpoint\s*>/i
const CHECKPOINT_PAIR = /<checkpoint\b([^>]*)>([\s\S]*?)<\/checkpoint\s*>/gi

const text = (node: Node): string =>
  node.type === 'text' || node.type === 'inlineCode' ? node.value ?? '' : (node.children ?? []).map(text).join('')

const squash = (value: string) => value.replace(/\s+/g, ' ').trim()

function attribute(attributes: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i').exec(attributes)
  return match ? match[1] ?? match[2] ?? match[3] : undefined
}

function slug(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48).replace(/-+$/, '') || 'step'
}

/** Strip a trailing `{#id}` from rendered step text. */
export function stripGuideStepId(value: string): string {
  return value.replace(EXPLICIT_ID, '')
}

/**
 * Parse a guide's title and steps. Ids are explicit (`{#id}` / `id="…"`) or a
 * slug of the label plus an occurrence suffix, so ticks survive agent edits
 * that do not reword a step.
 */
export function parseGuide(markdown: string): GuideOutline {
  const tree = unified().use(remarkParse).use(remarkGfm).parse(markdown) as Node
  let title = ''
  const found: Array<Omit<GuideStep, 'id'> & { explicit?: string }> = []

  const checkpoint = (attributes: string, label: string, offset: number) => {
    const explicit = attribute(attributes, 'id')
    found.push({ explicit: explicit && GUIDE_STEP_ID.test(explicit) ? explicit : undefined, label: squash(label), checkpoint: true, sourceChecked: /(?:^|\s)done(?=[\s=/]|$)/i.test(attributes), offset })
  }

  const visit = (node: Node) => {
    if (!title && node.type === 'heading' && node.depth === 1) title = squash(text(node))
    if (node.type === 'listItem' && typeof node.checked === 'boolean') {
      const paragraph = node.children?.find((child) => child.type === 'paragraph')
      const raw = squash(paragraph ? text(paragraph) : '')
      const explicit = EXPLICIT_ID.exec(raw)?.[1]
      found.push({ explicit, label: squash(stripGuideStepId(raw)), checkpoint: false, sourceChecked: node.checked, offset: node.position?.start.offset ?? 0 })
    }
    if (node.type === 'html' && node.value) {
      for (const match of node.value.matchAll(CHECKPOINT_PAIR)) checkpoint(match[1], match[2].replace(/<[^>]*>/g, ''), (node.position?.start.offset ?? 0) + match.index)
    }
    const children = node.children ?? []
    for (let index = 0; index < children.length; index++) {
      const child = children[index]
      const open = child.type === 'html' && child.value ? CHECKPOINT_OPEN.exec(child.value) : null
      // Inline `<checkpoint>` in a paragraph splits into open tag, text, close tag.
      if (open && !CHECKPOINT_CLOSE.test(child.value!)) {
        let label = ''
        let end = index + 1
        for (; end < children.length && !(children[end].type === 'html' && CHECKPOINT_CLOSE.test(children[end].value ?? '')); end++) label += text(children[end])
        checkpoint(open[1], label, child.position?.start.offset ?? 0)
        index = end
        continue
      }
      visit(child)
    }
  }
  visit(tree)

  const used = new Set<string>()
  const steps = found.map(({ explicit, ...step }) => {
    let id = explicit && !used.has(explicit) ? explicit : slug(step.label)
    for (let n = 2; used.has(id); n++) id = `${slug(step.label).slice(0, 44)}-${n}`
    used.add(id)
    return { ...step, id }
  })
  return { title, steps }
}

/** Effective state per step plus the changes since the last delivered baseline. */
export function guideSnapshot(
  outline: GuideOutline,
  marks: Readonly<Record<string, GuideMark>>,
  delivered: Readonly<Record<string, GuideDelivered>>,
): Pick<GuideSnapshot, 'title' | 'steps' | 'changes'> {
  const steps = outline.steps.map((step) => {
    const mark = marks[step.id]
    return { ...step, checked: mark?.checked ?? step.sourceChecked, ...(mark?.note ? { note: mark.note } : {}), byUser: mark?.checked !== undefined }
  })
  const changes: GuideChange[] = []
  for (const step of steps) {
    if (!marks[step.id]) continue
    const baseline = delivered[step.id] ?? {}
    const checkedChanged = step.byUser && step.checked !== (baseline.checked ?? step.sourceChecked)
    const noteChanged = (step.note ?? '') !== (baseline.note ?? '')
    if (checkedChanged || noteChanged) changes.push({ id: step.id, label: step.label, checkpoint: step.checkpoint, checked: step.checked, ...(step.note ? { note: step.note } : {}), checkedChanged, noteChanged })
  }
  return { title: outline.title, steps, changes }
}
